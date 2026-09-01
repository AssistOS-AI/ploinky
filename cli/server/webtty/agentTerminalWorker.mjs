#!/usr/bin/env node

import { execFile as execFileDefault, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadImmutableNodePty } from '../../../core-services/webtty/native-runtime.mjs';
import {
    capturePtyProcessIdentity,
    processIdentityError,
    signalVerifiedPtyProcessGroup,
    waitForPtyProcessExit,
} from '../../../core-services/webtty/process-identity.mjs';
import {
    assertExactAgentWorkerEnvironment,
    buildAgentWorkerEnvironment,
} from './agentWorkerEnvironment.mjs';
import {
    bashExecutableLookupFailed,
    exactPodmanInspectAbsent,
    fixedAgentPodmanArgv,
    fixedAgentShellWrapperArgv,
    parseExactPodmanInspectEnvelope,
    projectExactAgentProcessTarget,
} from './agentRuntime.mjs';
import {
    captureAgentInnerProcessIdentity,
    captureAgentSessionSnapshot,
    isAgentTargetLocalEvidenceFailure,
    listAgentSessionMembers,
    readAgentBoxProcessIdentity,
    signalExactAgentSessionSnapshot,
} from './agentProcessIdentity.mjs';
import {
    WEBTTY_AGENT_BACKEND,
    WEBTTY_AGENT_PROTOCOL_LIMITS,
    agentWorkerMessage,
    validateRouterToAgentWorkerMessage,
} from './agentWorkerProtocol.mjs';

const PODMAN = '/usr/bin/podman';
const STARTUP_TIMEOUT_MS = 10_000;
const TERM_GRACE_MS = 750;
const KILL_GRACE_MS = 500;
const CLEANUP_PODMAN_TIMEOUT_MS = 750;
export const AGENT_WORKER_CLEANUP_DEADLINE_MS = 5_500;
const MAX_PENDING_OUTPUT_BYTES = 128 * 1024;
const MAX_QUEUED_IPC_BYTES = 256 * 1024;
const MAX_PODMAN_OUTPUT_BYTES = 1024 * 1024;
const READINESS_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function captureExactAgentPodmanClient(pid, expectedArgs, {
    fsApi = fs,
    capturePty = capturePtyProcessIdentity,
} = {}) {
    if (!Array.isArray(expectedArgs) || expectedArgs.some((value) => typeof value !== 'string')) {
        throw processIdentityError('podman-client-expected-argv');
    }
    const before = capturePty(pid);
    const status = fsApi.readFileSync(`/proc/${pid}/status`, 'utf8');
    const command = fsApi.readFileSync(`/proc/${pid}/cmdline`);
    const after = capturePty(pid);
    if (before.startToken !== after.startToken) {
        throw processIdentityError('podman-client-changed-during-capture');
    }
    const uidValues = String(status).match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m);
    const uid = Number(uidValues?.[1]);
    if (!uidValues || !Number.isSafeInteger(uid) || uid < 0
        || uidValues.slice(1).some((value) => Number(value) !== uid)) {
        throw processIdentityError('podman-client-uid');
    }
    const argv = Buffer.from(command).toString('utf8').split('\0').filter(Boolean);
    const expected = [PODMAN, ...expectedArgs];
    if (argv.length !== expected.length || argv.some((value, index) => value !== expected[index])) {
        throw processIdentityError('podman-client-argv');
    }
    return Object.freeze({ ...after, uid });
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export { fixedAgentPodmanArgv } from './agentRuntime.mjs';

function runPodman(args, {
    environment = buildAgentWorkerEnvironment(),
    spawnSyncImpl = spawnSync,
    timeoutMs = 5_000,
} = {}) {
    const result = spawnSyncImpl(PODMAN, args, {
        cwd: '/tmp',
        env: environment,
        encoding: 'utf8',
        maxBuffer: MAX_PODMAN_OUTPUT_BYTES,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
    });
    return {
        ok: result.status === 0,
        status: Number.isInteger(result.status) ? result.status : null,
        signal: result.signal || null,
        errorCode: result.error?.code || null,
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || ''),
    };
}

function runPodmanAsync(args, {
    environment = buildAgentWorkerEnvironment(),
    execFileImpl = execFileDefault,
    timeoutMs = 5_000,
    deadlineAt = Date.now() + timeoutMs,
    signal,
} = {}) {
    const remaining = Math.min(timeoutMs, deadlineAt - Date.now());
    if (!Number.isFinite(remaining) || remaining <= 0 || signal?.aborted) {
        return Promise.reject(podmanRuntimeError('deadline'));
    }
    return new Promise((resolve) => {
        execFileImpl(PODMAN, args, {
            cwd: '/tmp',
            env: environment,
            encoding: 'utf8',
            maxBuffer: MAX_PODMAN_OUTPUT_BYTES,
            timeout: Math.max(1, Math.floor(remaining)),
            killSignal: 'SIGKILL',
            signal,
            windowsHide: true,
        }, (error, stdout, stderr) => {
            resolve({
                ok: !error,
                status: Number.isInteger(error?.code) ? error.code : 0,
                signal: error?.signal || null,
                errorCode: error && !Number.isInteger(error.code) ? String(error.code || '') : null,
                stdout: String(stdout || ''),
                stderr: String(stderr || ''),
            });
        });
    });
}

function podmanRuntimeError(category) {
    const error = new Error(`WebTTY agent Podman operation failed: ${category}`);
    error.code = 'WEBTTY_AGENT_PODMAN_FAILURE';
    error.category = category;
    return error;
}

function shellSelectionError(category = 'shell-unavailable') {
    const error = new Error(`WebTTY agent shell selection failed: ${category}`);
    error.code = 'WEBTTY_AGENT_SHELL_UNAVAILABLE';
    error.category = category;
    return error;
}

export function inspectExactAgentTarget(containerId, options = {}) {
    const result = runPodman(['container', 'inspect', containerId], options);
    if (!result.ok) {
        if (exactPodmanInspectAbsent(result, containerId)) {
            return Object.freeze({ absent: true, id: containerId });
        }
        throw podmanRuntimeError('inspect');
    }
    const record = parseExactPodmanInspectEnvelope(result.stdout, containerId, podmanRuntimeError);
    return projectExactAgentProcessTarget(record, containerId, podmanRuntimeError);
}

export async function inspectExactAgentTargetAsync(containerId, options = {}) {
    const result = await runPodmanAsync(['container', 'inspect', containerId], options);
    if (!result.ok) {
        if (exactPodmanInspectAbsent(result, containerId)) {
            return Object.freeze({ absent: true, id: containerId });
        }
        const deadlineFailure = result.signal
            || ['ABORT_ERR', 'ETIMEDOUT'].includes(result.errorCode);
        throw podmanRuntimeError(deadlineFailure ? 'deadline' : 'inspect');
    }
    const record = parseExactPodmanInspectEnvelope(result.stdout, containerId, podmanRuntimeError);
    return projectExactAgentProcessTarget(record, containerId, podmanRuntimeError);
}

export function selectExactNewExecId(before, after) {
    const initial = new Set(before);
    // Other already-owned sessions may finish and drain while this start is in
    // flight. Removal cannot create ambiguity: ownership is the sole new ID.
    // Concurrent additions remain fail-closed.
    const added = after.filter((value) => !initial.has(value));
    if (added.length !== 1) throw podmanRuntimeError('exec-id-ambiguity');
    return added[0];
}

export function drainExactAgentExecRecord(containerId, execId, options = {}) {
    const before = inspectExactAgentTarget(containerId, options);
    if (before.absent || !before.execIds.includes(execId)) return 'automatic';
    const result = runPodman([
        'container',
        'cleanup',
        '--stopped-only',
        '--rm',
        '--exec',
        execId,
        containerId,
    ], options);
    if (!result.ok) {
        const afterFailure = inspectExactAgentTarget(containerId, options);
        if (afterFailure.absent || !afterFailure.execIds.includes(execId)) return 'automatic';
        throw podmanRuntimeError('exec-not-drained');
    }
    const after = inspectExactAgentTarget(containerId, options);
    if (!after.absent && after.execIds.includes(execId)) throw podmanRuntimeError('exec-not-drained');
    return 'exact-container-cleanup';
}

export async function drainExactAgentExecRecordAsync(containerId, execId, options = {}) {
    const before = await inspectExactAgentTargetAsync(containerId, options);
    if (before.absent || !before.execIds.includes(execId)) return 'automatic';
    const result = await runPodmanAsync([
        'container',
        'cleanup',
        '--stopped-only',
        '--rm',
        '--exec',
        execId,
        containerId,
    ], options);
    if (!result.ok) {
        const afterFailure = await inspectExactAgentTargetAsync(containerId, options);
        if (afterFailure.absent || !afterFailure.execIds.includes(execId)) return 'automatic';
        throw podmanRuntimeError('exec-not-drained');
    }
    const after = await inspectExactAgentTargetAsync(containerId, options);
    if (!after.absent && after.execIds.includes(execId)) throw podmanRuntimeError('exec-not-drained');
    return 'exact-container-cleanup';
}

function outputChunks(value) {
    const chunks = [];
    let current = '';
    let bytes = 0;
    for (const character of String(value)) {
        const width = Buffer.byteLength(character);
        if (current && bytes + width > WEBTTY_AGENT_PROTOCOL_LIMITS.maxOutputBytes) {
            chunks.push(current);
            current = '';
            bytes = 0;
        }
        current += character;
        bytes += width;
    }
    if (current) chunks.push(current);
    return chunks;
}

export function agentReadinessCommand(challenge) {
    const normalizedChallenge = String(challenge || '');
    if (!READINESS_CHALLENGE.test(normalizedChallenge)) {
        const error = new Error('WebTTY agent readiness challenge is invalid');
        error.code = 'WEBTTY_AGENT_READINESS_CHALLENGE_INVALID';
        throw error;
    }
    const probe = [
        'IFS= read -r ploinky_agent_stat < /proc/$$/stat',
        'ploinky_agent_tail=${ploinky_agent_stat##*) }',
        'unset IFS',
        'set -- $ploinky_agent_tail',
        'ploinky_agent_pgrp=$3',
        'ploinky_agent_session=$4',
        'ploinky_agent_start=${20}',
        'ploinky_agent_uid=',
        "while IFS=: read -r ploinky_agent_key ploinky_agent_value; do [ \"$ploinky_agent_key\" = 'Uid' ] && { set -- $ploinky_agent_value; ploinky_agent_uid=$1; break; }; done < /proc/$$/status",
        `printf '__PLOINKY_AGENT_READY__%s|${normalizedChallenge}|%s|%s|%s|%s|%s\\n' \"$PLOINKY_WEBTTY_MARKER\" \"$$\" \"$ploinky_agent_pgrp\" \"$ploinky_agent_session\" \"$ploinky_agent_uid\" \"$ploinky_agent_start\"`,
    ].join('; ');
    // Both Bash and POSIX sh retain the interactive shell's `$$` in a
    // subshell while isolating IFS, positional parameters, and probe locals.
    return `( ${probe} )\r`;
}

export function agentFallbackReadinessCommand(challenge) {
    return `[ ! -e /bin/bash ] || exit 125; ${agentReadinessCommand(challenge)}`;
}

function targetLocalProcessIdentityFailure(error) {
    return isAgentTargetLocalEvidenceFailure(error);
}

function startupFailureCategory(error, output, ptyCreated) {
    if (error?.category === 'target-stale') return 'target-stale';
    if (error?.code === 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE') return 'target-stale';
    if (error?.code === 'WEBTTY_NATIVE_CONTRACT_MISMATCH') return 'native-runtime';
    if (error?.code === 'WEBTTY_AGENT_SHELL_UNAVAILABLE') return 'shell-unavailable';
    if (error?.code === 'WEBTTY_AGENT_STARTUP_CLEANUP_UNPROVEN') return 'cleanup-unproven';
    if (error?.code === 'WEBTTY_AGENT_READINESS_CHALLENGE_INVALID') return 'provider-evidence';
    if (error?.code === 'WEBTTY_AGENT_PODMAN_FAILURE') {
        return error?.category === 'exec-id-ambiguity' ? 'target-stale' : 'provider-evidence';
    }
    if (targetLocalProcessIdentityFailure(error)) return 'target-evidence';
    if (error?.code === 'WEBTTY_AGENT_PROCESS_IDENTITY_UNPROVEN'
        || error?.code === 'WEBTTY_PROCESS_IDENTITY_UNPROVEN') return 'provider-evidence';
    if (!ptyCreated) return 'pty-spawn';
    const bounded = String(output || '').slice(-16 * 1024);
    if (/(?:executable file not found|stat .*\/bin\/(?:ba)?sh.*no such file|\/bin\/(?:ba)?sh.*not found)/i.test(bounded)) {
        return 'shell-unavailable';
    }
    if (/(?:chdir|working directory|workdir).*(?:no such file|not found)/i.test(bounded)) {
        return 'target-stale';
    }
    return 'readiness';
}

async function waitForIdentitiesGone(snapshot, readIdentity, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        let live = false;
        for (const expected of snapshot) {
            try {
                const current = await readIdentity(expected.pid);
                if (current.startToken === expected.startToken) live = true;
            } catch (error) {
                if (error?.code !== 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE') throw error;
            }
        }
        if (!live) return true;
        await delay(20);
    }
    return false;
}

function cleanupDeadlineError() {
    return podmanRuntimeError('deadline');
}

function exactVector(observed, expected) {
    return Array.isArray(observed)
        && Array.isArray(expected)
        && observed.length === expected.length
        && observed.every((value, index) => value === expected[index]);
}

function exactArgv(observed, expected) {
    return Array.isArray(observed)
        && observed.length === expected.length
        && observed.every((value, index) => value === expected[index]);
}

function exactLiveAgentMarkerIdentity(observed, expected, marker) {
    return observed?.state !== 'Z'
        && observed?.pid === expected?.boxPid
        && observed?.startToken === expected?.boxStartToken
        && observed?.processGroupId === expected?.boxProcessGroupId
        && observed?.sessionId === expected?.boxSessionId
        && observed?.pidNamespace === expected?.pidNamespace
        && observed?.innerUid === expected?.innerUid
        && exactVector(observed?.nspid, expected?.nspid)
        && exactVector(observed?.nspgid, expected?.nspgid)
        && exactVector(observed?.nssid, expected?.nssid)
        && ['/bin/bash', '/bin/sh'].some((shellPath) => exactArgv(
            observed?.argv,
            fixedAgentShellWrapperArgv(marker, shellPath),
        ));
}

export class AgentTerminalWorker {
    constructor({
        processApi = process,
        workerEnvironment = assertExactAgentWorkerEnvironment(process.env),
        loadNodePty = loadImmutableNodePty,
        inspectTarget = (containerId) => inspectExactAgentTarget(containerId, {
            environment: workerEnvironment,
        }),
        inspectTargetCleanup = (containerId, options = {}) => inspectExactAgentTargetAsync(
            containerId,
            { environment: workerEnvironment, ...options },
        ),
        drainExecCleanup = (containerId, execId, options = {}) => drainExactAgentExecRecordAsync(
            containerId,
            execId,
            { environment: workerEnvironment, ...options },
        ),
        captureClient = captureExactAgentPodmanClient,
        captureInner = captureAgentInnerProcessIdentity,
        captureSession = captureAgentSessionSnapshot,
        listSession = listAgentSessionMembers,
        signalSession,
        readInnerIdentity = readAgentBoxProcessIdentity,
        signalClient = signalVerifiedPtyProcessGroup,
        waitClientExit = waitForPtyProcessExit,
        createReadinessChallenge = () => randomBytes(32).toString('base64url'),
        startupTimeoutMs = STARTUP_TIMEOUT_MS,
        cleanupDeadlineMs = AGENT_WORKER_CLEANUP_DEADLINE_MS,
    } = {}) {
        this.processApi = processApi;
        this.workerEnvironment = workerEnvironment;
        this.loadNodePty = loadNodePty;
        this.inspectTarget = inspectTarget;
        this.inspectTargetCleanup = inspectTargetCleanup;
        this.drainExecCleanup = drainExecCleanup;
        this.captureClient = captureClient;
        this.captureInner = captureInner;
        this.captureSession = captureSession;
        this.listSession = listSession;
        this.signalSession = signalSession || ((snapshot, signalName, cleanupContext = {}) => (
            signalExactAgentSessionSnapshot(snapshot, signalName, {
                signalImpl: (pid, exactSignal) => {
                    if (cleanupContext.signal?.aborted
                        || Date.now() >= cleanupContext.deadlineAt) {
                        throw cleanupDeadlineError();
                    }
                    process.kill(pid, exactSignal);
                },
            })
        ));
        this.readInnerIdentity = readInnerIdentity;
        this.signalClient = signalClient;
        this.waitClientExit = waitClientExit;
        this.createReadinessChallenge = createReadinessChallenge;
        this.startupTimeoutMs = startupTimeoutMs;
        this.cleanupDeadlineMs = cleanupDeadlineMs;
        this.terminalId = '';
        this.initialized = false;
        this.readySent = false;
        this.closing = false;
        this.exitSent = false;
        this.ptyExited = false;
        this.sequence = 0;
        this.queuedIpcBytes = 0;
        this.pendingOutput = '';
        this.readinessChallenge = '';
        this.pty = null;
        this.clientProcess = null;
        this.innerProcess = null;
        this.execId = '';
        this.baselineExecIds = null;
        this.spec = null;
        this.cleanupPromise = null;
        this.cleanupFinalized = false;
        this.readinessResolve = null;
        this.readinessReject = null;
        this.ptyExitEvent = null;
        this.preparedSent = false;
        this.startRequested = false;
        this.startupEvidence = null;
        this.attemptGeneration = 0;
    }

    send(type, fields = {}) {
        if (!this.terminalId || !this.processApi.connected) return false;
        const message = agentWorkerMessage(type, this.terminalId, fields);
        const bytes = Buffer.byteLength(JSON.stringify(message));
        if (bytes > WEBTTY_AGENT_PROTOCOL_LIMITS.maxWireBytes
            || this.queuedIpcBytes + bytes > MAX_QUEUED_IPC_BYTES) {
            void this.cleanup('output-limit');
            return false;
        }
        this.queuedIpcBytes += bytes;
        try {
            this.processApi.send(message, (error) => {
                this.queuedIpcBytes = Math.max(0, this.queuedIpcBytes - bytes);
                if (error && !this.closing) void this.cleanup('parent-disconnect');
            });
            return true;
        } catch (_) {
            this.queuedIpcBytes = Math.max(0, this.queuedIpcBytes - bytes);
            void this.cleanup('parent-disconnect');
            return false;
        }
    }

    sendError(category) {
        if (!this.exitSent) this.send('error', { category });
    }

    handleOutput(data) {
        if (this.closing) return;
        if (!this.readySent) {
            this.pendingOutput += String(data);
            if (Buffer.byteLength(this.pendingOutput) > MAX_PENDING_OUTPUT_BYTES) {
                this.readinessReject?.(new Error('startup output exceeded bound'));
                return;
            }
            const escapedMarker = this.spec?.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const escapedChallenge = this.readinessChallenge.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const match = escapedMarker && escapedChallenge && this.pendingOutput.match(new RegExp(
                `__PLOINKY_AGENT_READY__${escapedMarker}\\|${escapedChallenge}\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)`,
            ));
            if (match) this.readinessResolve?.(match);
            return;
        }
        for (const chunk of outputChunks(data)) {
            this.sequence += 1;
            if (!this.send('output', { sequence: this.sequence, data: chunk })) return;
        }
    }

    flushStartupOutput(readyMatch) {
        const readinessEnd = readyMatch.index + readyMatch[0].length;
        const cleaned = this.pendingOutput
            .slice(readinessEnd)
            .replace(/^(?:\r\n|\r|\n)+/, '');
        this.pendingOutput = '';
        this.readinessChallenge = '';
        for (const chunk of outputChunks(cleaned)) {
            if (!chunk) continue;
            this.sequence += 1;
            if (!this.send('output', { sequence: this.sequence, data: chunk })) return;
        }
    }

    async initialize(message) {
        this.terminalId = message.terminalId;
        validateRouterToAgentWorkerMessage(message, {
            initialized: false,
            expectedTerminalId: this.terminalId,
        });
        this.initialized = true;
        this.spec = Object.freeze({
            runtime: message.runtime,
            containerId: message.containerId,
            targetUser: message.targetUser,
            translatedCwd: message.translatedCwd,
            marker: message.marker,
            cols: message.cols,
            rows: message.rows,
        });
        try {
            const before = this.inspectTarget(message.containerId);
            if (before.absent || !before.running) throw podmanRuntimeError('target-stale');
            const containerInit = await this.readInnerIdentity(before.initPid);
            if (containerInit.pid !== before.initPid || containerInit.state === 'Z') {
                throw podmanRuntimeError('target-stale');
            }
            this.baselineExecIds = before.execIds;
            this.startupEvidence = Object.freeze({
                backend: WEBTTY_AGENT_BACKEND,
                runtime: 'podman',
                containerId: message.containerId,
                targetUser: message.targetUser,
                translatedCwd: message.translatedCwd,
                marker: message.marker,
                baselineExecIds: Object.freeze([...before.execIds]),
                containerInitProcess: Object.freeze({
                    pid: before.initPid,
                    startToken: containerInit.startToken,
                    pidNamespace: containerInit.pidNamespace,
                }),
            });
            this.preparedSent = this.send('prepared', {
                startupEvidence: this.startupEvidence,
            });
            if (!this.preparedSent) throw new Error('agent startup preparation delivery failed');
        } catch (error) {
            const category = startupFailureCategory(error, this.pendingOutput, false);
            this.sendError(category);
            await this.cleanup(category);
        }
    }

    resetAttemptState() {
        this.attemptGeneration += 1;
        this.pendingOutput = '';
        this.readinessChallenge = '';
        this.pty = null;
        this.clientProcess = null;
        this.innerProcess = null;
        this.execId = '';
        this.ptyExited = false;
        this.ptyExitEvent = null;
        this.readinessResolve = null;
        this.readinessReject = null;
    }

    async spawnAttempt(shellPath, fallback = false) {
        this.resetAttemptState();
        const generation = this.attemptGeneration;
        const nodePty = this.loadNodePty();
        const podmanArgs = fixedAgentPodmanArgv(this.spec, shellPath);
        this.pty = nodePty.spawn(PODMAN, podmanArgs, {
            name: 'xterm-256color',
            cols: this.spec.cols,
            rows: this.spec.rows,
            cwd: '/tmp',
            env: { ...this.workerEnvironment, TERM: 'xterm-256color' },
        });
        this.pty.onData((data) => {
            if (generation === this.attemptGeneration) this.handleOutput(data);
        });
        this.pty.onExit((event) => {
            if (generation === this.attemptGeneration) this.handlePtyExit(event);
        });
        // No byte may be written, and no signal may later be derived from the
        // node-pty PID, until that PID has been bound to the exact immutable
        // Podman client identity.  A failed capture leaves durable
        // pty-starting evidence for the normal recovery scanner.
        this.clientProcess = this.captureClient(this.pty.pid, podmanArgs);
        const ready = new Promise((resolve, reject) => {
            this.readinessResolve = resolve;
            this.readinessReject = reject;
        });
        let challenge;
        try {
            challenge = String(this.createReadinessChallenge() || '');
        } catch (_) {
            const error = new Error('WebTTY agent readiness challenge generation failed');
            error.code = 'WEBTTY_AGENT_READINESS_CHALLENGE_INVALID';
            throw error;
        }
        if (!READINESS_CHALLENGE.test(challenge)) {
            const error = new Error('WebTTY agent readiness challenge generation failed');
            error.code = 'WEBTTY_AGENT_READINESS_CHALLENGE_INVALID';
            throw error;
        }
        this.readinessChallenge = challenge;
        const readinessCommand = fallback
            ? agentFallbackReadinessCommand(challenge)
            : agentReadinessCommand(challenge);
        this.pty.write(readinessCommand);
        const timeout = delay(this.startupTimeoutMs).then(() => {
            throw new Error('agent shell readiness timed out');
        });
        const match = await Promise.race([ready, timeout]);
        const inner = {
            pid: Number(match[1]),
            processGroupId: Number(match[2]),
            sessionId: Number(match[3]),
            uid: Number(match[4]),
            startToken: `linux-proc:${match[5]}`,
        };
        this.innerProcess = await this.captureInner({
            containerInitBoxPid: this.startupEvidence.containerInitProcess.pid,
            inner,
            marker: this.spec.marker,
            shellPath,
        });
        const after = this.inspectTarget(this.spec.containerId);
        if (after.absent || !after.running
            || after.initPid !== this.startupEvidence.containerInitProcess.pid) {
            throw podmanRuntimeError('target-stale');
        }
        this.execId = selectExactNewExecId(this.baselineExecIds, after.execIds);
        return match;
    }

    cleanupActive(context) {
        return !this.cleanupFinalized
            && !context?.signal?.aborted
            && Date.now() < (context?.deadlineAt ?? Number.POSITIVE_INFINITY);
    }

    cleanupPodmanOptions(context) {
        return {
            deadlineAt: context.deadlineAt,
            signal: context.signal,
            timeoutMs: Math.max(1, Math.min(
                CLEANUP_PODMAN_TIMEOUT_MS,
                context.deadlineAt - Date.now(),
            )),
        };
    }

    async correlatePreReadyExec(snapshot, cleanupContext) {
        const active = () => this.cleanupActive(cleanupContext);
        if (!Array.isArray(snapshot)) throw new Error('agent session evidence is invalid');
        const markerMatches = snapshot.filter((identity) => exactLiveAgentMarkerIdentity(
            identity,
            this.innerProcess,
            this.spec.marker,
        ));
        if (markerMatches.length !== 1 || !active()) return '';
        const inspected = await this.inspectTargetCleanup(
            this.spec.containerId,
            this.cleanupPodmanOptions(cleanupContext),
        );
        if (!active()) return '';
        const expectedInit = this.startupEvidence.containerInitProcess;
        if (inspected.absent || !inspected.running || inspected.initPid !== expectedInit.pid) {
            throw podmanRuntimeError('target-stale');
        }
        if (!Array.isArray(inspected.execIds)) throw podmanRuntimeError('inspect');
        const additions = inspected.execIds.filter(
            (id) => !this.baselineExecIds.includes(id),
        );
        if (additions.length > 1) throw podmanRuntimeError('exec-id-ambiguity');
        if (additions.length !== 1) return '';
        const [currentInit, currentMarker] = await Promise.all([
            this.readInnerIdentity(expectedInit.pid),
            this.readInnerIdentity(this.innerProcess.boxPid),
        ]);
        if (!active()) return '';
        if (currentInit?.state === 'Z'
            || currentInit?.startToken !== expectedInit.startToken
            || currentInit?.pidNamespace !== expectedInit.pidNamespace
            || !exactLiveAgentMarkerIdentity(
                currentMarker,
                this.innerProcess,
                this.spec.marker,
            )) {
            throw podmanRuntimeError('target-stale');
        }
        // The immutable ExecID is accepted only while the exact random-marker
        // wrapper and exact container init are simultaneously live. Later
        // cleanup may observe a replacement exec, but can drain only this ID.
        return additions[0];
    }

    async proveAndResetPreReadyAttempt(cleanupContext = null) {
        const active = () => !cleanupContext || this.cleanupActive(cleanupContext);
        let proven = true;
        try {
            if (this.clientProcess && !this.ptyExited) {
                if (!active()) return false;
                this.signalClient(this.clientProcess, 'SIGTERM');
                if (!await this.waitClientExit(this.clientProcess, { timeoutMs: TERM_GRACE_MS })) {
                    if (!active()) return false;
                    this.signalClient(this.clientProcess, 'SIGKILL');
                    if (!await this.waitClientExit(this.clientProcess, { timeoutMs: KILL_GRACE_MS })) {
                        proven = false;
                    }
                }
                if (!active()) return false;
            } else if (!this.clientProcess && !this.ptyExited) {
                proven = false;
            }
        } catch (_) {
            proven = false;
        }
        try {
            if (!active()) return false;
            const after = cleanupContext
                ? await this.inspectTargetCleanup(
                    this.spec.containerId,
                    this.cleanupPodmanOptions(cleanupContext),
                )
                : this.inspectTarget(this.spec.containerId);
            if (!active()) return false;
            const expectedInit = this.startupEvidence.containerInitProcess;
            if (after.absent || !after.running || after.initPid !== expectedInit.pid) {
                proven = false;
            } else {
                const added = after.execIds.filter((id) => !this.baselineExecIds.includes(id));
                if (added.length) proven = false;
            }
        } catch (_) {
            proven = false;
        }
        if (!proven) return false;
        try { this.pty?.dispose?.(); } catch (_) { }
        this.resetAttemptState();
        return true;
    }

    async launch() {
        if (!this.preparedSent || this.startRequested || !this.startupEvidence) {
            this.sendError('protocol');
            await this.cleanup('protocol-error');
            return;
        }
        this.startRequested = true;
        let match;
        try {
            try {
                match = await this.spawnAttempt('/bin/bash');
            } catch (bashError) {
                const fallbackAllowed = bashExecutableLookupFailed(
                    this.pendingOutput,
                    this.ptyExitEvent,
                );
                if (!fallbackAllowed) throw bashError;
                if (!await this.proveAndResetPreReadyAttempt()) {
                    const error = new Error('Bash attempt cleanup is unproven');
                    error.code = 'WEBTTY_AGENT_STARTUP_CLEANUP_UNPROVEN';
                    throw error;
                }
                try {
                    match = await this.spawnAttempt('/bin/sh', true);
                } catch (fallbackError) {
                    if (this.ptyExitEvent?.exitCode === 125) throw shellSelectionError();
                    throw fallbackError;
                }
            }
            const recoveryEvidence = {
                backend: WEBTTY_AGENT_BACKEND,
                runtime: 'podman',
                containerId: this.spec.containerId,
                targetUser: this.spec.targetUser,
                translatedCwd: this.spec.translatedCwd,
                marker: this.spec.marker,
                execId: this.execId,
                clientProcess: this.clientProcess,
                innerProcess: this.innerProcess,
            };
            this.send('ready', { recoveryEvidence });
            this.readySent = true;
            this.flushStartupOutput(match);
        } catch (error) {
            const category = startupFailureCategory(error, this.pendingOutput, Boolean(this.pty));
            this.sendError(category);
            await this.cleanup(category);
        }
    }

    handleMessage(raw) {
        if (this.closing) return;
        let message;
        try {
            message = validateRouterToAgentWorkerMessage(raw, {
                initialized: this.initialized,
                closing: this.closing,
                expectedTerminalId: this.terminalId || undefined,
            });
        } catch (_) {
            this.sendError('protocol');
            void this.cleanup('protocol-error');
            return;
        }
        if (message.type === 'close') {
            void this.cleanup('requested');
        } else if (message.type === 'init-agent') {
            void this.initialize(message);
        } else if (message.type === 'start-agent') {
            void this.launch();
        } else if (!this.readySent || !this.pty || this.ptyExited) {
            this.sendError('protocol');
            void this.cleanup('protocol-error');
        } else if (message.type === 'input') {
            try { this.pty.write(message.data); } catch (_) {
                this.sendError('pty-io');
                void this.cleanup('worker-error');
            }
        } else if (message.type === 'resize') {
            try { this.pty.resize(message.cols, message.rows); } catch (_) {
                this.sendError('pty-io');
                void this.cleanup('worker-error');
            }
        }
    }

    handlePtyExit(event = {}) {
        this.ptyExited = true;
        this.ptyExitEvent = Object.freeze({
            exitCode: Number.isSafeInteger(event.exitCode) ? event.exitCode : null,
            signal: Number.isSafeInteger(event.signal) ? event.signal : null,
        });
        this.readinessReject?.(new Error('Podman client exited before readiness'));
        if (!this.readySent) return;
        void this.cleanup(this.closing ? 'requested' : (event.signal ? 'signal' : 'clean'));
    }

    cleanup(category) {
        if (this.cleanupPromise) return this.cleanupPromise;
        this.closing = true;
        const controller = new AbortController();
        const cleanupContext = Object.freeze({
            deadlineAt: Date.now() + this.cleanupDeadlineMs,
            signal: controller.signal,
        });
        let cleanupTimer;
        const deadline = new Promise((resolve) => {
            cleanupTimer = setTimeout(() => {
                controller.abort();
                resolve(this.finalizeCleanup(category, {
                    proven: false,
                    // A deadline consumed while acting on one exact target has
                    // no positive evidence that the shared provider is broken.
                    providerEvidenceFailed: category === 'provider-evidence',
                }));
            }, this.cleanupDeadlineMs);
        });
        this.cleanupPromise = Promise.race([
            this.performCleanup(category, cleanupContext),
            deadline,
        ]).finally(() => {
            clearTimeout(cleanupTimer);
            controller.abort();
        });
        return this.cleanupPromise;
    }

    async performCleanup(category, cleanupContext) {
        const active = () => this.cleanupActive(cleanupContext);
        let proven = true;
        let providerEvidenceFailed = category === 'provider-evidence';
        let preserveStartingEvidence = false;
        let snapshot = [];
        if (this.pty && !this.innerProcess) {
            const preReadyProven = await this.proveAndResetPreReadyAttempt(cleanupContext);
            if (!active()) return;
            if (!preReadyProven) proven = false;
        }
        if (this.pty && !this.clientProcess) proven = false;
        if (this.pty && !this.innerProcess) proven = false;
        if (this.innerProcess) {
            try {
                snapshot = await this.captureSession(this.innerProcess);
                if (!active()) return;
            } catch (error) {
                if (!active()) return;
                if (error?.code !== 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE') {
                    proven = false;
                    providerEvidenceFailed ||= error?.code === 'WEBTTY_AGENT_PROCESS_IDENTITY_UNPROVEN'
                        && !targetLocalProcessIdentityFailure(error);
                }
            }
        }
        if (this.innerProcess && !this.execId) {
            try {
                const correlatedExecId = await this.correlatePreReadyExec(
                    snapshot,
                    cleanupContext,
                );
                if (!active()) return;
                if (correlatedExecId) this.execId = correlatedExecId;
                else {
                    proven = false;
                    preserveStartingEvidence = true;
                }
            } catch (error) {
                if (!active()) return;
                proven = false;
                preserveStartingEvidence = true;
                providerEvidenceFailed ||= error?.code === 'WEBTTY_AGENT_PODMAN_FAILURE'
                    && !['target-stale', 'exec-id-ambiguity', 'deadline'].includes(error?.category);
                providerEvidenceFailed ||= error?.code === 'WEBTTY_AGENT_PROCESS_IDENTITY_UNPROVEN'
                    && !targetLocalProcessIdentityFailure(error);
            }
        }
        try {
            if (!preserveStartingEvidence && snapshot.length > 0) {
                if (!active()) return;
                await this.signalSession(snapshot, 'SIGTERM', cleanupContext);
                if (!active()) return;
                if (!await waitForIdentitiesGone(snapshot, this.readInnerIdentity, TERM_GRACE_MS)) {
                    if (!active()) return;
                    await this.signalSession(snapshot, 'SIGKILL', cleanupContext);
                    if (!active()) return;
                    if (!await waitForIdentitiesGone(snapshot, this.readInnerIdentity, KILL_GRACE_MS)) {
                        proven = false;
                    }
                    if (!active()) return;
                }
            }
        } catch (error) {
            if (!active()) return;
            proven = false;
            providerEvidenceFailed ||= error?.code === 'WEBTTY_AGENT_PROCESS_IDENTITY_UNPROVEN'
                && !targetLocalProcessIdentityFailure(error);
        }
        if (this.innerProcess && !preserveStartingEvidence) {
            try {
                let residual = await this.listSession(this.innerProcess);
                if (!active()) return;
                if (residual.length > 0) {
                    await this.signalSession(residual, 'SIGTERM', cleanupContext);
                    if (!active()) return;
                    if (!await waitForIdentitiesGone(residual, this.readInnerIdentity, TERM_GRACE_MS)) {
                        if (!active()) return;
                        await this.signalSession(residual, 'SIGKILL', cleanupContext);
                        if (!active()) return;
                        if (!await waitForIdentitiesGone(residual, this.readInnerIdentity, KILL_GRACE_MS)) {
                            proven = false;
                        }
                        if (!active()) return;
                    }
                    residual = await this.listSession(this.innerProcess);
                    if (!active()) return;
                    if (residual.length > 0) proven = false;
                }
            } catch (error) {
                if (!active()) return;
                if (error?.code !== 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE') {
                    proven = false;
                    providerEvidenceFailed ||= error?.code === 'WEBTTY_AGENT_PROCESS_IDENTITY_UNPROVEN'
                        && error?.category !== 'session-anchor-missing';
                }
            }
        }
        try {
            if (!preserveStartingEvidence && this.clientProcess && !this.ptyExited) {
                if (!active()) return;
                this.signalClient(this.clientProcess, 'SIGTERM');
                if (!await this.waitClientExit(this.clientProcess, { timeoutMs: TERM_GRACE_MS })) {
                    if (!active()) return;
                    this.signalClient(this.clientProcess, 'SIGKILL');
                    if (!await this.waitClientExit(this.clientProcess, { timeoutMs: KILL_GRACE_MS })) {
                        proven = false;
                    }
                }
                if (!active()) return;
            }
        } catch (error) {
            if (!active()) return;
            if (error?.code !== 'WEBTTY_PROCESS_IDENTITY_STALE') {
                proven = false;
                providerEvidenceFailed ||= error?.code === 'WEBTTY_PROCESS_IDENTITY_UNPROVEN';
            }
        }
        try {
            if (this.execId && active()) {
                await this.drainExecCleanup(
                    this.spec.containerId,
                    this.execId,
                    this.cleanupPodmanOptions(cleanupContext),
                );
                if (!active()) return;
            }
        } catch (error) {
            if (!active()) return;
            proven = false;
            providerEvidenceFailed ||= error?.code === 'WEBTTY_AGENT_PODMAN_FAILURE'
                && error?.category !== 'exec-not-drained'
                && error?.category !== 'exec-id-ambiguity'
                && error?.category !== 'deadline';
        }
        if (!active()) return;
        await this.finalizeCleanup(category, { proven, providerEvidenceFailed });
    }

    async finalizeCleanup(category, { proven, providerEvidenceFailed }) {
        if (this.cleanupFinalized) return;
        this.cleanupFinalized = true;
        if (!proven) this.sendError(
            providerEvidenceFailed ? 'cleanup-provider-unproven' : 'cleanup-unproven',
        );
        try { if (proven) this.pty?.dispose?.(); } catch (_) { }
        if (!this.exitSent && this.terminalId) {
            this.exitSent = true;
            this.send('exit', {
                exitCode: this.ptyExitEvent?.exitCode ?? null,
                signal: this.ptyExitEvent?.signal ?? null,
                category: ['requested', 'parent-disconnect', 'target-stale', 'protocol-error'].includes(category)
                    ? category
                    : ['clean', 'signal'].includes(category) ? category : 'worker-error',
                cleanupProven: proven,
            });
        }
        await delay(50);
        try { this.processApi.disconnect?.(); } catch (_) { }
        this.processApi.exitCode = proven && ['requested', 'clean'].includes(category) ? 0 : 1;
        const timer = setTimeout(() => this.processApi.exit?.(this.processApi.exitCode), 10);
        timer.unref?.();
    }
}

export function runAgentTerminalWorker({
    processApi = process,
    argv = processApi.argv.slice(2),
} = {}) {
    if (argv.length !== 1 || argv[0] !== '--ploinky-webtty-agent-worker=v1') {
        processApi.exitCode = 1;
        try { processApi.disconnect?.(); } catch (_) { }
        return null;
    }
    let worker;
    try { worker = new AgentTerminalWorker({ processApi }); } catch (_) {
        processApi.exitCode = 1;
        try { processApi.disconnect?.(); } catch (_) { }
        return null;
    }
    processApi.on('message', (message) => worker.handleMessage(message));
    processApi.once('disconnect', () => { void worker.cleanup('parent-disconnect'); });
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        processApi.once(signal, () => { void worker.cleanup('requested'); });
    }
    processApi.once('uncaughtException', () => {
        worker.sendError('internal');
        void worker.cleanup('worker-error');
    });
    processApi.once('unhandledRejection', () => {
        worker.sendError('internal');
        void worker.cleanup('worker-error');
    });
    return worker;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) runAgentTerminalWorker();
