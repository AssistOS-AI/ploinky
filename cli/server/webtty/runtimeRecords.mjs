import crypto from 'node:crypto';
import { execFile as execFileDefault } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAgentWorkerEnvironment } from './agentWorkerEnvironment.mjs';
import {
    exactPodmanInspectAbsent,
    fixedAgentPodmanArgv,
    parseExactPodmanInspectEnvelope,
    projectExactAgentProcessTarget,
} from './agentRuntime.mjs';
import {
    isAgentTargetLocalEvidenceFailure,
    listAgentRecordedNamespaceMarkerProcesses,
    listAgentSessionMembers,
    signalExactAgentSessionSnapshot,
} from './agentProcessIdentity.mjs';
import {
    validateAgentRecoveryEvidence,
    validateAgentStartupEvidence,
} from './agentWorkerProtocol.mjs';

export const WEBTTY_RECOVERY_RECORD_SCHEMA = 'ploinky-webtty-recovery/v2';
export const DEFAULT_WEBTTY_RUNTIME_DIRECTORY = '/run/ploinky/webtty';
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_LINUX_PROC_BYTES = 64 * 1024;
const MAX_LINUX_PROC_SCAN_ENTRIES = 8_192;
const LINUX_PROC_SCAN_TIMEOUT_MS = 1_000;
const RECORD_NAME = /^[a-zA-Z0-9_-]{20,80}\.json$/;
const TEMPORARY_RECORD_NAME = /^\.([a-zA-Z0-9_-]{20,80}\.json)\.([a-f0-9]{16})$/;
const RECLAMATION_STABILITY_MS = 25;
const PODMAN = '/usr/bin/podman';
const AGENT_WORKER_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'agentTerminalWorker.mjs',
);
const AGENT_CONTAINER_ID = /^[a-f0-9]{64}$/;
const AGENT_EXEC_ID = /^[a-f0-9]{64}$/;

function agentPodmanError(category) {
    const error = new Error(`WebTTY agent Podman evidence failed: ${category}`);
    error.code = 'WEBTTY_AGENT_PODMAN_FAILURE';
    error.category = category;
    return error;
}

function runAgentPodman(args, {
    execFileImpl = execFileDefault,
    environment = buildAgentWorkerEnvironment(),
    timeoutMs = 5_000,
} = {}) {
    return new Promise((resolve, reject) => {
        execFileImpl(PODMAN, args, {
            cwd: '/tmp',
            env: environment,
            encoding: 'utf8',
            timeout: Math.min(5_000, timeoutMs),
            maxBuffer: 1024 * 1024,
            killSignal: 'SIGKILL',
            windowsHide: true,
        }, (error, stdout, stderr) => {
            if (error) {
                reject(Object.assign(agentPodmanError('command'), {
                    status: Number.isInteger(error.code) ? error.code : null,
                    signal: error.signal || null,
                    errorCode: !Number.isInteger(error.code) ? String(error.code || '') : null,
                    stdout: String(stdout || ''),
                    stderr: String(stderr || ''),
                }));
                return;
            }
            resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

export async function inspectExactAgentTargetAsync(containerId, options = {}) {
    if (!AGENT_CONTAINER_ID.test(String(containerId || ''))) throw agentPodmanError('container-id');
    let result;
    try {
        result = await runAgentPodman(['container', 'inspect', containerId], options);
    } catch (error) {
        if (exactPodmanInspectAbsent(error, containerId)) {
            return Object.freeze({ absent: true, id: containerId });
        }
        throw error;
    }
    const record = parseExactPodmanInspectEnvelope(result.stdout, containerId, agentPodmanError);
    return projectExactAgentProcessTarget(record, containerId, agentPodmanError);
}

export async function drainExactAgentExecRecordAsync(containerId, execId, options = {}) {
    if (!AGENT_EXEC_ID.test(String(execId || ''))) throw agentPodmanError('exec-id');
    const before = await inspectExactAgentTargetAsync(containerId, options);
    if (before.absent || !before.execIds.includes(execId)) return 'automatic';
    try {
        await runAgentPodman([
            'container', 'cleanup', '--stopped-only', '--rm', '--exec', execId, containerId,
        ], options);
    } catch (_) {
        const afterFailure = await inspectExactAgentTargetAsync(containerId, options);
        if (afterFailure.absent || !afterFailure.execIds.includes(execId)) return 'automatic';
        throw agentPodmanError('exec-not-drained');
    }
    const after = await inspectExactAgentTargetAsync(containerId, options);
    if (!after.absent && after.execIds.includes(execId)) throw agentPodmanError('exec-not-drained');
    return 'exact-container-cleanup';
}

function modeBits(stat) {
    return stat.mode & 0o777;
}

async function syncDirectory(directory) {
    const handle = await fs.open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
}

function safeInteger(value) {
    return Number.isSafeInteger(value) && value > 1;
}

function assertIdentity(value, label, { optional = false } = {}) {
    if (optional && value == null) return null;
    if (!value || typeof value !== 'object'
        || !safeInteger(value.pid)
        || !/^linux-proc:\d+$/.test(String(value.startToken || ''))
        || !Number.isSafeInteger(value.uid)
        || value.uid < 0) {
        throw new Error(`${label} identity is invalid`);
    }
    return {
        pid: value.pid,
        startToken: String(value.startToken),
        uid: value.uid,
        ...(safeInteger(value.pgrp) ? { pgrp: value.pgrp } : {}),
        ...(safeInteger(value.session) ? { session: value.session } : {}),
    };
}

function exactRecordObject(value, fields, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
    const actual = Object.keys(value).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length
        || actual.some((field, index) => field !== expected[index])) throw new Error(`${label} is invalid`);
}

function validateAgentTarget(value) {
    exactRecordObject(value, [
        'runtime', 'containerId', 'containerName', 'instanceId', 'enableGeneration',
    ], 'agent target');
    if (value.runtime !== 'podman'
        || !/^[a-f0-9]{64}$/.test(String(value.containerId || ''))
        || !String(value.containerName || '').trim()
        || !String(value.instanceId || '').trim()
        || !String(value.enableGeneration || '').trim()) {
        throw new Error('agent target is invalid');
    }
    return Object.freeze({
        runtime: value.runtime,
        containerId: value.containerId,
        containerName: value.containerName,
        instanceId: value.instanceId,
        enableGeneration: value.enableGeneration,
    });
}

function cloneFrozen(value) {
    if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
    if (!value || typeof value !== 'object') return value;
    return Object.freeze(Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, cloneFrozen(entry)]),
    ));
}

function validateRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('record must be an object');
    }
    const allowed = new Set([
        'schema', 'routerEpoch', 'marker', 'targetKind', 'target', 'worker', 'pty', 'agent',
        'agentStartup',
        'createdAt', 'cleanupState', 'ptyState',
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('record has unsupported fields');
    if (value.cleanupState !== undefined && value.cleanupState !== 'unproven') {
        throw new Error('record cleanup state is invalid');
    }
    if (!['worker-only', 'pty-starting', 'pty-ready'].includes(value.ptyState)) {
        throw new Error('record PTY state is invalid');
    }
    if (value.schema !== WEBTTY_RECOVERY_RECORD_SCHEMA
        || !/^[a-zA-Z0-9_-]{16,128}$/.test(String(value.routerEpoch || ''))
        || !/^[a-zA-Z0-9_-]{24,128}$/.test(String(value.marker || ''))
        || !Number.isSafeInteger(value.createdAt)
        || value.createdAt < 1) {
        throw new Error('record metadata is invalid');
    }
    if (!['box', 'agent'].includes(value.targetKind)) throw new Error('record target kind is invalid');
    const worker = assertIdentity(value.worker, 'worker');
    const pty = assertIdentity(value.pty, 'pty', { optional: true });
    let target = null;
    let agent = null;
    let agentStartup = null;
    if (value.targetKind === 'box') {
        if (value.target !== null || value.agent !== null || value.agentStartup !== null) {
            throw new Error('Box recovery fields are invalid');
        }
        if (pty && (!safeInteger(pty.pgrp) || !safeInteger(pty.session))) {
            throw new Error('pty process-group evidence is incomplete');
        }
        if ((value.ptyState === 'pty-ready') !== Boolean(pty)) {
            throw new Error('record PTY evidence does not match its state');
        }
    } else {
        if (pty !== null) throw new Error('agent recovery record contains Box PTY evidence');
        target = validateAgentTarget(value.target);
        agentStartup = value.agentStartup === null
            ? null
            : cloneFrozen(validateAgentStartupEvidence(value.agentStartup));
        agent = value.agent === null ? null : cloneFrozen(validateAgentRecoveryEvidence(value.agent));
        if ((value.ptyState === 'worker-only') !== (agentStartup === null)
            || (value.ptyState === 'pty-ready') !== Boolean(agent)
            || (agent && (agent.runtime !== target.runtime || agent.containerId !== target.containerId
                || agent.marker !== value.marker))
            || (agentStartup && (agentStartup.runtime !== target.runtime
                || agentStartup.containerId !== target.containerId
                || agentStartup.marker !== value.marker))
            || (agent && agentStartup && (agent.targetUser !== agentStartup.targetUser
                || agent.translatedCwd !== agentStartup.translatedCwd))) {
            throw new Error('agent recovery evidence does not match its target');
        }
    }
    return Object.freeze({
        schema: value.schema,
        routerEpoch: value.routerEpoch,
        marker: value.marker,
        targetKind: value.targetKind,
        target,
        worker,
        pty,
        agent,
        agentStartup,
        createdAt: value.createdAt,
        ...(value.cleanupState === 'unproven' ? { cleanupState: 'unproven' } : {}),
        ptyState: value.ptyState,
    });
}

function parseLinuxProcStat(statText, expectedPid) {
    if (typeof statText !== 'string' || statText.length === 0 || statText.length > 64 * 1024) {
        throw new Error('invalid proc stat');
    }
    const open = statText.indexOf('(');
    const close = statText.lastIndexOf(')');
    if (open <= 0 || close <= open || Number(statText.slice(0, open).trim()) !== expectedPid) {
        throw new Error('invalid proc stat');
    }
    const fields = statText.slice(close + 1).trim().split(/\s+/);
    if (fields.length < 20) throw new Error('incomplete proc stat');
    return {
        pid: expectedPid,
        state: String(fields[0] || ''),
        pgrp: Number(fields[2]),
        session: Number(fields[3]),
        rawStartToken: String(fields[19] || ''),
    };
}

function processEvidenceError(category) {
    const error = new Error(`Linux process evidence is unproven: ${category}`);
    error.code = 'WEBTTY_PROCESS_IDENTITY_UNPROVEN';
    error.category = category;
    return error;
}

async function readBoundedLinuxProcFile(filePath, encoding = null) {
    const handle = await fs.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(MAX_LINUX_PROC_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_LINUX_PROC_BYTES) throw processEvidenceError('proc-file-limit');
        const value = buffer.subarray(0, bytesRead);
        return encoding ? value.toString(encoding) : value;
    } finally {
        await handle.close();
    }
}

async function withinProcScanDeadline(operation, deadlineAt) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw processEvidenceError('proc-scan-timeout');
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(processEvidenceError('proc-scan-timeout')),
                    remaining,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function scanLinuxProc(procRoot, visit, {
    maxEntries = MAX_LINUX_PROC_SCAN_ENTRIES,
    timeoutMs = LINUX_PROC_SCAN_TIMEOUT_MS,
} = {}) {
    const deadlineAt = Date.now() + timeoutMs;
    const directory = await withinProcScanDeadline(fs.opendir(procRoot), deadlineAt);
    const iterator = directory[Symbol.asyncIterator]();
    let scannedEntries = 0;
    try {
        while (true) {
            const step = await withinProcScanDeadline(iterator.next(), deadlineAt);
            if (step.done) break;
            scannedEntries += 1;
            if (scannedEntries > maxEntries) throw processEvidenceError('proc-scan-limit');
            const entry = step.value;
            if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) continue;
            if (!safeInteger(Number(entry.name))) continue;
            await withinProcScanDeadline(visit(entry, deadlineAt), deadlineAt);
        }
    } finally {
        try { await directory.close(); } catch (error) {
            if (error?.code !== 'ERR_DIR_CLOSED') throw error;
        }
    }
}

export async function readLinuxProcessIdentity(pid, { procRoot = '/proc' } = {}) {
    if (!safeInteger(pid)) return null;
    try {
        const statPath = path.join(procRoot, String(pid), 'stat');
        const statBefore = await readBoundedLinuxProcFile(statPath, 'utf8');
        const [statusText, cmdlineBytes] = await Promise.all([
            readBoundedLinuxProcFile(path.join(procRoot, String(pid), 'status'), 'utf8'),
            readBoundedLinuxProcFile(path.join(procRoot, String(pid), 'cmdline')),
        ]);
        const statAfter = await readBoundedLinuxProcFile(statPath, 'utf8');
        const before = parseLinuxProcStat(statBefore, pid);
        const after = parseLinuxProcStat(statAfter, pid);
        const uidMatch = statusText.match(/^Uid:\s+(\d+)/m);
        const {
            state, pgrp, session, rawStartToken,
        } = after;
        const uid = Number(uidMatch?.[1]);
        if (before.rawStartToken !== rawStartToken) throw new Error('proc identity changed while reading');
        if (!/^[A-Za-z]$/.test(state) || !safeInteger(pgrp) || !safeInteger(session) || !/^\d+$/.test(rawStartToken)
            || !Number.isSafeInteger(uid) || uid < 0) throw new Error('incomplete proc identity');
        return {
            pid,
            state,
            pgrp,
            session,
            startToken: `linux-proc:${rawStartToken}`,
            uid,
            cmdline: cmdlineBytes.toString('utf8').split('\0').filter(Boolean),
        };
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null;
        throw error;
    }
}

function exactArgv(observed, expected) {
    return Array.isArray(observed)
        && observed.length === expected.length
        && observed.every((value, index) => value === expected[index]);
}

function agentStartupClientArgvCandidates(startup) {
    return ['/bin/bash', '/bin/sh'].map((shellPath) => [
        PODMAN,
        ...fixedAgentPodmanArgv(startup, shellPath),
    ]);
}

function agentStartupClientArgvMatches(observed, startup) {
    return agentStartupClientArgvCandidates(startup).some((expected) => exactArgv(observed, expected));
}

function procCmdlineBytes(argv) {
    return Buffer.from(`${argv.join('\0')}\0`, 'utf8');
}

async function readExactAgentStartupCmdlineCandidate(pid, startup, procRoot) {
    const candidates = agentStartupClientArgvCandidates(startup).map(procCmdlineBytes);
    const maximumBytes = Math.max(...candidates.map((candidate) => candidate.length));
    const filePath = path.join(procRoot, String(pid), 'cmdline');
    const handle = await fs.open(filePath, 'r');
    try {
        const observed = Buffer.alloc(maximumBytes + 1);
        const { bytesRead } = await handle.read(observed, 0, observed.length, 0);
        if (bytesRead > maximumBytes) return false;
        const exact = observed.subarray(0, bytesRead);
        return candidates.some((candidate) => candidate.equals(exact));
    } finally {
        await handle.close();
    }
}

export function agentStartupClientMatches(observed, startup, workerUid) {
    if (!observed || observed.state === 'Z' || observed.uid !== workerUid
        || observed.pgrp !== observed.pid || observed.session !== observed.pid) return false;
    return agentStartupClientArgvMatches(observed.cmdline, startup);
}

export async function listExactAgentStartupPodmanClients(startup, workerUid, {
    procRoot = '/proc',
    readCandidate = (pid) => readExactAgentStartupCmdlineCandidate(pid, startup, procRoot),
    readIdentity = (pid) => readLinuxProcessIdentity(pid, { procRoot }),
    maxEntries = MAX_LINUX_PROC_SCAN_ENTRIES,
    scanTimeoutMs = LINUX_PROC_SCAN_TIMEOUT_MS,
} = {}) {
    const clients = [];
    await scanLinuxProc(procRoot, async (entry) => {
        let candidate;
        try { candidate = await readCandidate(Number(entry.name)); } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return;
            throw error;
        }
        if (!candidate) return;
        let observed;
        try { observed = await readIdentity(Number(entry.name)); } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return;
            throw error;
        }
        if (agentStartupClientMatches(observed, startup, workerUid)) clients.push(observed);
    }, { maxEntries, timeoutMs: scanTimeoutMs });
    return Object.freeze(clients);
}

export async function listLinuxSessionMembers(sessionId, {
    procRoot = '/proc',
    maxEntries = MAX_LINUX_PROC_SCAN_ENTRIES,
    scanTimeoutMs = LINUX_PROC_SCAN_TIMEOUT_MS,
} = {}) {
    if (!safeInteger(sessionId)) throw new Error('invalid Linux session id');
    const members = [];
    await scanLinuxProc(procRoot, async (entry) => {
        const pid = Number(entry.name);
        if (!safeInteger(pid)) return;
        const statPath = path.join(procRoot, entry.name, 'stat');
        try {
            const before = parseLinuxProcStat(await readBoundedLinuxProcFile(statPath, 'utf8'), pid);
            if (before.session !== sessionId) return;
            const after = parseLinuxProcStat(await readBoundedLinuxProcFile(statPath, 'utf8'), pid);
            if (before.rawStartToken !== after.rawStartToken) {
                throw new Error('proc identity changed while enumerating session');
            }
            if (after.session === sessionId && after.state !== 'Z') {
                members.push(Object.freeze({
                    pid,
                    state: after.state,
                    pgrp: after.pgrp,
                    session: after.session,
                    startToken: `linux-proc:${after.rawStartToken}`,
                }));
            }
        } catch (error) {
            if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') throw error;
        }
    }, { maxEntries, timeoutMs: scanTimeoutMs });
    return Object.freeze(members);
}

function identityMatches(observed, expected) {
    return Boolean(observed
        && observed.pid === expected.pid
        && observed.uid === expected.uid
        && observed.startToken === expected.startToken
        && (!expected.pgrp || observed.pgrp === expected.pgrp)
        && (!expected.session || observed.session === expected.session));
}

function liveIdentityMatches(observed, expected) {
    return observed?.state !== 'Z' && identityMatches(observed, expected);
}

export function classifyAgentEvidenceFailure(error) {
    if (error?.code === 'WEBTTY_AGENT_PODMAN_FAILURE') {
        return ['exec-not-drained', 'exec-id-ambiguity'].includes(error?.category)
            ? 'target'
            : 'provider';
    }
    if (error?.code === 'WEBTTY_PROCESS_IDENTITY_UNPROVEN') return 'provider';
    if (isAgentTargetLocalEvidenceFailure(error)) return 'target';
    if (error?.code === 'WEBTTY_AGENT_PROCESS_IDENTITY_UNPROVEN') return 'provider';
    return 'provider';
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RuntimeRecordStore {
    constructor({
        directory = DEFAULT_WEBTTY_RUNTIME_DIRECTORY,
        uid = process.getuid?.() ?? 0,
        readIdentity = readLinuxProcessIdentity,
        listSessionMembers = listLinuxSessionMembers,
        inspectAgentTarget = inspectExactAgentTargetAsync,
        drainAgentExec = drainExactAgentExecRecordAsync,
        listAgentMarkers = listAgentRecordedNamespaceMarkerProcesses,
        listAgentSession = listAgentSessionMembers,
        listAgentStartupClients = listExactAgentStartupPodmanClients,
        signalAgentSession = signalExactAgentSessionSnapshot,
        signal = process.kill.bind(process),
        graceMs = 750,
        workerGraceMs = 5_000,
        delay = sleep,
    } = {}) {
        this.directory = path.resolve(directory);
        this.uid = uid;
        this.readIdentity = readIdentity;
        this.listSessionMembers = listSessionMembers;
        this.inspectAgentTarget = inspectAgentTarget;
        this.drainAgentExec = drainAgentExec;
        this.listAgentMarkers = listAgentMarkers;
        this.listAgentSession = listAgentSession;
        this.listAgentStartupClients = listAgentStartupClients;
        this.signalAgentSession = signalAgentSession;
        this.signal = signal;
        this.graceMs = graceMs;
        this.workerGraceMs = Math.max(graceMs, workerGraceMs);
        this.delay = delay;
    }

    async ensureDirectory() {
        try {
            await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
            const stat = await fs.lstat(this.directory);
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid || modeBits(stat) !== 0o700) {
                throw new Error('runtime directory ownership or mode is unsafe');
            }
        } catch (error) {
            error.code ||= 'WEBTTY_RECOVERY_DIRECTORY_UNSAFE';
            throw error;
        }
    }

    async create({ routerEpoch, marker, worker, targetKind = 'box', target = null }) {
        await this.ensureDirectory();
        const fileName = `${crypto.createHash('sha256').update(String(marker)).digest('base64url')}.json`;
        const handle = { fileName, record: null };
        await this.update(handle, {
            schema: WEBTTY_RECOVERY_RECORD_SCHEMA,
            routerEpoch,
            marker,
            targetKind,
            target,
            worker,
            pty: null,
            agent: null,
            agentStartup: null,
            ptyState: 'worker-only',
            createdAt: Date.now(),
        });
        return handle;
    }

    async update(handle, next) {
        await this.ensureDirectory();
        if (!handle || !RECORD_NAME.test(String(handle.fileName || ''))) throw new Error('invalid record handle');
        const record = validateRecord(next);
        const bytes = Buffer.from(JSON.stringify(record));
        if (bytes.length > MAX_RECORD_BYTES) throw new Error('record is too large');
        const target = path.join(this.directory, handle.fileName);
        const temporary = path.join(this.directory, `.${handle.fileName}.${crypto.randomBytes(8).toString('hex')}`);
        let opened;
        try {
            opened = await fs.open(temporary, 'wx', 0o600);
            await opened.writeFile(bytes);
            await opened.sync();
            await opened.close();
            opened = null;
            await fs.rename(temporary, target);
            handle.record = record;
            await syncDirectory(this.directory);
        } finally {
            try { await opened?.close(); } catch (_) { }
            try { await fs.unlink(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        }
        return record;
    }

    async remove(handle) {
        if (!handle || !RECORD_NAME.test(String(handle.fileName || ''))) return false;
        const target = path.join(this.directory, handle.fileName);
        try {
            const stat = await fs.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
                || stat.uid !== this.uid || modeBits(stat) !== 0o600) return false;
            await fs.unlink(target);
            await syncDirectory(this.directory);
            return true;
        } catch (error) {
            if (error?.code === 'ENOENT') return true;
            throw error;
        }
    }

    async markCleanupUnproven(handle) {
        if (!handle?.record) return false;
        await this.update(handle, {
            ...handle.record,
            cleanupState: 'unproven',
        });
        return true;
    }

    async removeTemporaryResidue(fileName) {
        if (!TEMPORARY_RECORD_NAME.test(String(fileName || ''))) return false;
        const target = path.join(this.directory, fileName);
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
            || stat.uid !== this.uid || modeBits(stat) !== 0o600
            || stat.size > MAX_RECORD_BYTES) {
            throw new Error('temporary recovery record is unsafe');
        }
        await fs.unlink(target);
        await syncDirectory(this.directory);
        return true;
    }

    async markPtyStarting(handle) {
        if (!handle?.record || handle.record.ptyState !== 'worker-only') return false;
        await this.update(handle, {
            ...handle.record,
            ptyState: 'pty-starting',
        });
        return true;
    }

    async markAgentPtyStarting(handle, startupEvidence) {
        if (!handle?.record || handle.record.targetKind !== 'agent'
            || handle.record.ptyState !== 'worker-only') return false;
        await this.update(handle, {
            ...handle.record,
            agentStartup: startupEvidence,
            ptyState: 'pty-starting',
        });
        return true;
    }

    async readEntry(fileName) {
        if (!RECORD_NAME.test(fileName)) throw new Error('unexpected recovery directory entry');
        const target = path.join(this.directory, fileName);
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
            || stat.uid !== this.uid || modeBits(stat) !== 0o600 || stat.size > MAX_RECORD_BYTES) {
            throw new Error('unsafe recovery record');
        }
        return validateRecord(JSON.parse(await fs.readFile(target, 'utf8')));
    }

    async signalVerifiedPty(record, signal) {
        const observed = await this.readIdentity(record.pty.pid);
        if (!identityMatches(observed, record.pty)
            || record.pty.pgrp !== record.pty.pid
            || observed.pgrp !== observed.pid
            || observed.session !== record.pty.session) return false;
        this.signal(-observed.pgrp, signal);
        return true;
    }

    async signalVerifiedWorker(record, signal) {
        const observed = await this.readIdentity(record.worker.pid);
        const expectedArg = record.targetKind === 'agent'
            ? '--ploinky-webtty-agent-worker=v1'
            : `--ploinky-webtty-marker=${record.marker}`;
        const exactAgentWorker = record.targetKind !== 'agent'
            || (observed?.cmdline?.length === 3
                && path.isAbsolute(observed.cmdline[0])
                && observed.cmdline[1] === AGENT_WORKER_PATH
                && observed.cmdline[2] === expectedArg);
        if (!identityMatches(observed, record.worker)
            || !observed.cmdline?.includes(expectedArg) || !exactAgentWorker) return false;
        this.signal(observed.pid, signal);
        return true;
    }

    agentClientMatches(observed, expected) {
        return Boolean(observed && observed.state !== 'Z'
            && observed.pid === expected.pid
            && observed.uid === expected.uid
            && observed.startToken === expected.startToken
            && observed.pgrp === expected.processGroupId
            && observed.session === expected.sessionId
            && expected.processGroupId === expected.pid
            && expected.sessionId === expected.pid);
    }

    async signalVerifiedAgentClient(record, selectedSignal) {
        const expected = record.agent.clientProcess;
        const observed = await this.readIdentity(expected.pid);
        if (!this.agentClientMatches(observed, expected)) return false;
        this.signal(-observed.pgrp, selectedSignal);
        return true;
    }

    async agentReclamationSnapshot(record) {
        const worker = await this.readIdentity(record.worker.pid);
        if (liveIdentityMatches(worker, record.worker)) return false;
        if (record.ptyState === 'worker-only') return true;
        const expectedClient = record.agent.clientProcess;
        const client = await this.readIdentity(expectedClient.pid);
        if (this.agentClientMatches(client, expectedClient)) return false;
        const expectedInner = record.agent.innerProcess;
        const inner = await this.readIdentity(expectedInner.boxPid);
        if (inner?.state !== 'Z'
            && inner?.pid === expectedInner.boxPid
            && inner?.startToken === expectedInner.boxStartToken) return false;
        const markers = await this.listAgentMarkers(record.agent.innerProcess, record.marker);
        if (!Array.isArray(markers)) throw new Error('agent marker evidence is invalid');
        if (markers.length !== 0) return false;
        const inspected = await this.inspectAgentTarget(record.target.containerId);
        if (inspected.absent) return true;
        if (!inspected.running) return !inspected.execIds.includes(record.agent.execId);
        let members;
        try {
            members = await this.listAgentSession(record.agent.innerProcess);
        } catch (error) {
            if (error?.code !== 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE') throw error;
            members = [];
        }
        return members.length === 0 && !inspected.execIds.includes(record.agent.execId);
    }

    async reclamationSnapshot(record) {
        if (record.ptyState === 'pty-starting') return false;
        if (record.targetKind === 'agent') return this.agentReclamationSnapshot(record);
        const worker = await this.readIdentity(record.worker.pid);
        if (liveIdentityMatches(worker, record.worker)) return false;
        if (!record.pty) return true;
        const pty = await this.readIdentity(record.pty.pid);
        if (liveIdentityMatches(pty, record.pty)) return false;
        const members = await this.listSessionMembers(record.pty.session);
        if (!Array.isArray(members)) throw new Error('session membership evidence is invalid');
        return members.length === 0;
    }

    async confirmReclaimed(recordValue, { waitForExit = false } = {}) {
        const record = validateRecord(recordValue);
        if (record.ptyState === 'pty-starting') return false;
        let reclaimed = await this.reclamationSnapshot(record);
        if (!reclaimed && waitForExit) {
            await this.delay(this.graceMs);
            reclaimed = await this.reclamationSnapshot(record);
        }
        if (!reclaimed) return false;
        await this.delay(RECLAMATION_STABILITY_MS);
        return this.reclamationSnapshot(record);
    }

    agentRecoveryFailure(record, category, scope = 'target') {
        return {
            recovered: false,
            category,
            scope,
            target: record.target,
        };
    }

    async stopExactAgentWorker(record) {
        let worker = await this.readIdentity(record.worker.pid);
        if (liveIdentityMatches(worker, record.worker)) {
            if (!(await this.signalVerifiedWorker(record, 'SIGTERM'))) return false;
            await this.delay(this.workerGraceMs);
        }
        worker = await this.readIdentity(record.worker.pid);
        if (liveIdentityMatches(worker, record.worker)) {
            if (!(await this.signalVerifiedWorker(record, 'SIGKILL'))) return false;
            await this.delay(this.graceMs);
        }
        worker = await this.readIdentity(record.worker.pid);
        return !liveIdentityMatches(worker, record.worker);
    }

    async recoverAgentWorkerOnly(fileName, record) {
        try {
            if (!(await this.stopExactAgentWorker(record))) {
                return this.agentRecoveryFailure(record, 'agent_worker_cleanup_unconfirmed', 'provider');
            }
            if (!(await this.confirmReclaimed(record, { waitForExit: true }))) {
                return this.agentRecoveryFailure(record, 'agent_worker_cleanup_unconfirmed', 'provider');
            }
            if (await this.remove({ fileName, record }) !== true) {
                return this.agentRecoveryFailure(record, 'agent_record_remove_unconfirmed', 'provider');
            }
            return { recovered: true, category: 'verified_agent_worker_reclaimed' };
        } catch (_) {
            return this.agentRecoveryFailure(record, 'agent_worker_evidence_failed', 'provider');
        }
    }

    async signalVerifiedAgentStartupClient(record, expected, selectedSignal) {
        const observed = await this.readIdentity(expected.pid);
        if (!observed || observed.startToken !== expected.startToken
            || !agentStartupClientMatches(
                observed,
                record.agentStartup,
                record.worker.uid,
            )) return false;
        this.signal(-observed.pgrp, selectedSignal);
        return true;
    }

    async reclaimAgentStartupClients(record) {
        let clients = await this.listAgentStartupClients(
            record.agentStartup,
            record.worker.uid,
        );
        if (!Array.isArray(clients)) throw new Error('agent startup client evidence is invalid');
        if (clients.length > 1) return { reclaimed: false, ownershipSeen: false };
        const ownershipSeen = clients.length === 1;
        for (const client of clients) {
            if (!(await this.signalVerifiedAgentStartupClient(record, client, 'SIGTERM'))) {
                return { reclaimed: false, ownershipSeen };
            }
        }
        if (clients.length) await this.delay(this.graceMs);
        clients = await this.listAgentStartupClients(record.agentStartup, record.worker.uid);
        for (const client of clients) {
            if (!(await this.signalVerifiedAgentStartupClient(record, client, 'SIGKILL'))) {
                return { reclaimed: false, ownershipSeen };
            }
        }
        if (clients.length) await this.delay(this.graceMs);
        const residual = await this.listAgentStartupClients(
            record.agentStartup,
            record.worker.uid,
        );
        return { reclaimed: residual.length === 0, ownershipSeen };
    }

    agentStartupMarkerAnchor(startup, wrapper) {
        const innerPid = wrapper.nspid?.at?.(-1);
        const innerProcessGroupId = wrapper.nspgid?.at?.(-1);
        const innerSessionId = wrapper.nssid?.at?.(-1);
        if (![innerPid, innerProcessGroupId, innerSessionId].every(safeInteger)
            || wrapper.pidNamespace !== startup.containerInitProcess.pidNamespace) {
            throw new Error('agent startup marker topology is invalid');
        }
        return Object.freeze({
            boxPid: wrapper.pid,
            boxStartToken: wrapper.startToken,
            boxProcessGroupId: wrapper.processGroupId,
            boxSessionId: wrapper.sessionId,
            pidNamespace: wrapper.pidNamespace,
            nspid: wrapper.nspid,
            nspgid: wrapper.nspgid,
            nssid: wrapper.nssid,
            innerPid,
            innerProcessGroupId,
            innerSessionId,
            innerUid: wrapper.innerUid,
            innerStartToken: wrapper.startToken,
            containerInitBoxPid: startup.containerInitProcess.pid,
            containerInitStartToken: startup.containerInitProcess.startToken,
        });
    }

    sameAgentStartupMarker(expected, current) {
        return ['pid', 'startToken', 'processGroupId', 'sessionId', 'pidNamespace', 'innerUid']
            .every((field) => expected?.[field] === current?.[field])
            && ['nspid', 'nspgid', 'nssid'].every((field) => (
                Array.isArray(expected?.[field])
                && Array.isArray(current?.[field])
                && expected[field].length === current[field].length
                && expected[field].every((value, index) => value === current[field][index])
            ));
    }

    async reclaimAgentStartupMarkerSession(record) {
        const startup = record.agentStartup;
        let markers = await this.listAgentMarkers(startup.containerInitProcess, record.marker);
        if (!Array.isArray(markers)) throw new Error('agent startup marker evidence is invalid');
        if (markers.length === 0) return { reclaimed: true, correlatedExecId: '' };
        if (markers.length !== 1) return { reclaimed: false, correlatedExecId: '' };
        const [wrapper] = markers;
        const anchor = this.agentStartupMarkerAnchor(startup, wrapper);
        const members = await this.listAgentSession(anchor);
        if (!Array.isArray(members) || members.length === 0) {
            return { reclaimed: false, correlatedExecId: '' };
        }
        const baseline = new Set(startup.baselineExecIds);
        const inspected = await this.inspectAgentTarget(record.target.containerId);
        if (inspected.absent || !inspected.running
            || inspected.initPid !== startup.containerInitProcess.pid
            || !Array.isArray(inspected.execIds)) {
            return { reclaimed: false, correlatedExecId: '' };
        }
        const additions = inspected.execIds.filter((id) => !baseline.has(id));
        markers = await this.listAgentMarkers(startup.containerInitProcess, record.marker);
        if (!Array.isArray(markers)
            || markers.length !== 1
            || !this.sameAgentStartupMarker(wrapper, markers[0])) {
            return { reclaimed: false, correlatedExecId: '' };
        }
        // A sole post-baseline ExecID is owned only while the exact random
        // marker-bearing wrapper is simultaneously live. A startup client by
        // itself can predate exec creation, so historical client evidence must
        // never authorize draining a later foreign same-container exec.
        const correlatedExecId = additions.length === 1 ? additions[0] : '';
        const execAmbiguous = additions.length > 1;
        await this.signalAgentSession(members, 'SIGTERM');
        await this.delay(this.graceMs);
        await this.signalAgentSession(members, 'SIGKILL');
        await this.delay(this.graceMs);
        const residual = await this.listAgentSession(anchor);
        if (!Array.isArray(residual) || residual.length !== 0) {
            return { reclaimed: false, correlatedExecId: '' };
        }
        markers = await this.listAgentMarkers(startup.containerInitProcess, record.marker);
        return {
            reclaimed: Array.isArray(markers) && markers.length === 0,
            correlatedExecId,
            execAmbiguous,
        };
    }

    async recoverAgentStarting(fileName, record) {
        try {
            if (!(await this.stopExactAgentWorker(record))) {
                return this.agentRecoveryFailure(
                    record,
                    'agent_startup_worker_cleanup_unconfirmed',
                    'provider',
                );
            }
            const startup = record.agentStartup;
            let stableSnapshots = 0;
            let sawExecResidue = false;
            let correlatedExecId = '';
            for (let attempt = 0; attempt < 4 && stableSnapshots < 2; attempt += 1) {
                const clientReclamation = await this.reclaimAgentStartupClients(record);
                if (!clientReclamation.reclaimed) {
                    return this.agentRecoveryFailure(record, 'agent_startup_client_survived');
                }
                const markerReclamation = await this.reclaimAgentStartupMarkerSession(record);
                if (!markerReclamation.reclaimed) {
                    return this.agentRecoveryFailure(record, 'agent_startup_marker_survived');
                }
                if (markerReclamation.execAmbiguous) {
                    return this.agentRecoveryFailure(record, 'agent_startup_exec_ambiguous');
                }
                correlatedExecId ||= markerReclamation.correlatedExecId;
                const baseline = new Set(startup.baselineExecIds);
                let inspected = await this.inspectAgentTarget(record.target.containerId);
                let additions = inspected.absent
                    ? []
                    : inspected.execIds.filter((id) => !baseline.has(id));
                sawExecResidue ||= additions.length > 0;
                if (additions.length > 1) {
                    return this.agentRecoveryFailure(record, 'agent_startup_exec_ambiguous');
                }
                if (additions.length === 1) {
                    if (!correlatedExecId || additions[0] !== correlatedExecId) {
                        return this.agentRecoveryFailure(record, 'agent_startup_exec_unowned');
                    }
                    await this.drainAgentExec(record.target.containerId, additions[0]);
                    inspected = await this.inspectAgentTarget(record.target.containerId);
                    additions = inspected.absent
                        ? []
                        : inspected.execIds.filter((id) => !baseline.has(id));
                }
                const clients = await this.listAgentStartupClients(startup, record.worker.uid);
                const markers = await this.listAgentMarkers(
                    startup.containerInitProcess,
                    record.marker,
                );
                if (!Array.isArray(markers)) {
                    throw new Error('agent startup marker evidence is invalid');
                }
                if (clients.length === 0 && markers.length === 0 && additions.length === 0) {
                    stableSnapshots += 1;
                } else {
                    stableSnapshots = 0;
                }
                if (stableSnapshots < 2) await this.delay(this.graceMs);
            }
            if (stableSnapshots < 2) {
                return this.agentRecoveryFailure(
                    record,
                    sawExecResidue
                        ? 'agent_startup_exec_ambiguous'
                        : 'agent_startup_cleanup_unconfirmed',
                );
            }
            if (await this.remove({ fileName, record }) !== true) {
                return this.agentRecoveryFailure(record, 'agent_record_remove_unconfirmed', 'provider');
            }
            return { recovered: true, category: 'verified_agent_startup_reclaimed' };
        } catch (error) {
            const scope = classifyAgentEvidenceFailure(error);
            return this.agentRecoveryFailure(
                record,
                scope === 'provider'
                    ? 'agent_provider_evidence_failed'
                    : 'agent_target_evidence_failed',
                scope,
            );
        }
    }

    async recoverAgentEntry(fileName, record) {
        try {
            let worker = await this.readIdentity(record.worker.pid);
            if (worker && identityMatches(worker, record.worker)) {
                if (!(await this.signalVerifiedWorker(record, 'SIGTERM'))) {
                    return this.agentRecoveryFailure(record, 'agent_worker_term_revalidation_failed', 'provider');
                }
            }
            await this.delay(this.graceMs);
            worker = await this.readIdentity(record.worker.pid);
            if (worker && identityMatches(worker, record.worker)) {
                if (!(await this.signalVerifiedWorker(record, 'SIGKILL'))) {
                    return this.agentRecoveryFailure(record, 'agent_worker_force_revalidation_failed', 'provider');
                }
            }

            const inspected = await this.inspectAgentTarget(record.target.containerId);
            if (!inspected.absent && inspected.running) {
                let members;
                try {
                    members = await this.listAgentSession(record.agent.innerProcess);
                } catch (error) {
                    if (error?.code !== 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE'
                        && error?.category !== 'session-anchor-missing') throw error;
                    members = [];
                }
                if (members.length) {
                    await this.signalAgentSession(members, 'SIGTERM');
                    await this.delay(this.graceMs);
                    // Retain the immutable pre-TERM snapshot. The recorded
                    // shell/anchor may exit before a foreground child, making
                    // a numeric-session rescan ambiguous; exact per-PID
                    // revalidation safely skips exited members and kills only
                    // surviving members from the owned snapshot.
                    await this.signalAgentSession(members, 'SIGKILL');
                    await this.delay(this.graceMs);
                    const residual = await this.listAgentSession(record.agent.innerProcess);
                    if (residual.length) {
                        return this.agentRecoveryFailure(record, 'agent_inner_session_survived');
                    }
                }
            }

            const markersAfterSession = await this.listAgentMarkers(
                record.agent.innerProcess,
                record.marker,
            );
            if (!Array.isArray(markersAfterSession) || markersAfterSession.length !== 0) {
                return this.agentRecoveryFailure(record, 'agent_inner_marker_survived');
            }

            let client = await this.readIdentity(record.agent.clientProcess.pid);
            if (this.agentClientMatches(client, record.agent.clientProcess)) {
                if (!(await this.signalVerifiedAgentClient(record, 'SIGTERM'))) {
                    return this.agentRecoveryFailure(record, 'agent_client_term_revalidation_failed');
                }
                await this.delay(this.graceMs);
                client = await this.readIdentity(record.agent.clientProcess.pid);
                if (this.agentClientMatches(client, record.agent.clientProcess)) {
                    if (!(await this.signalVerifiedAgentClient(record, 'SIGKILL'))) {
                        return this.agentRecoveryFailure(record, 'agent_client_force_revalidation_failed');
                    }
                    await this.delay(this.graceMs);
                    client = await this.readIdentity(record.agent.clientProcess.pid);
                    if (this.agentClientMatches(client, record.agent.clientProcess)) {
                        return this.agentRecoveryFailure(record, 'agent_client_survived');
                    }
                }
            }

            if (!inspected.absent && inspected.execIds.includes(record.agent.execId)) {
                await this.drainAgentExec(record.target.containerId, record.agent.execId);
            }
            if (!(await this.confirmReclaimed(record, { waitForExit: true }))) {
                return this.agentRecoveryFailure(record, 'agent_cleanup_unconfirmed');
            }
            if (await this.remove({ fileName, record }) !== true) {
                return this.agentRecoveryFailure(record, 'agent_record_remove_unconfirmed', 'provider');
            }
            return { recovered: true, category: 'verified_agent_reclaimed' };
        } catch (error) {
            const scope = classifyAgentEvidenceFailure(error);
            return this.agentRecoveryFailure(
                record,
                scope === 'provider'
                    ? 'agent_provider_evidence_failed'
                    : 'agent_target_evidence_failed',
                scope,
            );
        }
    }

    async recoverEntry(fileName, record) {
        if (record.ptyState === 'pty-starting') {
            if (record.targetKind === 'agent') {
                return this.recoverAgentStarting(fileName, record);
            }
            return {
                recovered: false,
                category: record.targetKind === 'agent' ? 'agent_startup_unproven' : 'pty_startup_unproven',
                scope: record.targetKind === 'agent' ? 'target' : 'global',
                ...(record.targetKind === 'agent' ? { target: record.target } : {}),
            };
        }
        let alreadyReclaimed;
        try {
            alreadyReclaimed = await this.confirmReclaimed(record);
        } catch (error) {
            if (record.targetKind !== 'agent') throw error;
            if (error?.category === 'session-anchor-missing') {
                // Numeric session-ID reuse is ambiguous, never owned. Continue
                // only with exact client/exec cleanup; final confirmation will
                // quarantine the target if the ambiguous processes remain.
                alreadyReclaimed = false;
            } else {
                const scope = classifyAgentEvidenceFailure(error);
                return this.agentRecoveryFailure(
                    record,
                    scope === 'provider'
                        ? 'agent_provider_evidence_failed'
                        : 'agent_target_evidence_failed',
                    scope,
                );
            }
        }
        if (alreadyReclaimed) {
            if (await this.remove({ fileName, record }) !== true) {
                return record.targetKind === 'agent'
                    ? this.agentRecoveryFailure(record, 'agent_record_remove_unconfirmed', 'provider')
                    : { recovered: false, category: 'recovery_record_remove_unconfirmed' };
            }
            return {
                recovered: true,
                category: record.cleanupState === 'unproven'
                    ? 'dead_unproven_record_removed'
                    : 'dead_record_removed',
            };
        }
        if (record.cleanupState === 'unproven' && record.targetKind === 'box') {
            return { recovered: false, category: 'cleanup_unproven' };
        }
        if (record.targetKind === 'agent' && record.ptyState === 'worker-only') {
            return this.recoverAgentWorkerOnly(fileName, record);
        }
        if (record.targetKind === 'agent') return this.recoverAgentEntry(fileName, record);
        let worker = await this.readIdentity(record.worker.pid);
        let pty = record.pty ? await this.readIdentity(record.pty.pid) : null;
        if (worker) {
            const markerArg = `--ploinky-webtty-marker=${record.marker}`;
            if (!identityMatches(worker, record.worker) || !worker.cmdline.includes(markerArg)) {
                return { recovered: false, category: 'worker_identity_ambiguous' };
            }
            try {
                if (!(await this.signalVerifiedWorker(record, 'SIGTERM'))) {
                    return { recovered: false, category: 'worker_term_revalidation_failed' };
                }
            } catch (error) { if (error?.code !== 'ESRCH') throw error; }
        }
        if (pty) {
            if (!identityMatches(pty, record.pty)
                || record.pty.pgrp !== record.pty.pid
                || pty.pgrp !== pty.pid
                || pty.session !== record.pty.session) {
                return { recovered: false, category: 'pty_identity_ambiguous' };
            }
        }
        await this.delay(this.graceMs);
        worker = await this.readIdentity(record.worker.pid);
        pty = record.pty ? await this.readIdentity(record.pty.pid) : null;
        if (worker && identityMatches(worker, record.worker)) {
            try {
                if (!(await this.signalVerifiedWorker(record, 'SIGKILL'))) {
                    return { recovered: false, category: 'worker_force_revalidation_failed' };
                }
            } catch (error) { if (error?.code !== 'ESRCH') throw error; }
        }
        if (pty && !(await this.signalVerifiedPty(record, 'SIGTERM'))) {
            return { recovered: false, category: 'pty_revalidation_failed' };
        }
        if (pty) {
            await this.delay(this.graceMs);
            if (await this.readIdentity(record.pty.pid)) {
                if (!(await this.signalVerifiedPty(record, 'SIGKILL'))) {
                    return { recovered: false, category: 'pty_force_revalidation_failed' };
                }
            }
        }
        if (!(await this.confirmReclaimed(record, { waitForExit: true }))) {
            return { recovered: false, category: 'process_cleanup_unconfirmed' };
        }
        if (await this.remove({ fileName, record }) !== true) {
            return { recovered: false, category: 'recovery_record_remove_unconfirmed' };
        }
        return { recovered: true, category: 'verified_reclaimed' };
    }

    async recoverHandle(handle) {
        if (!handle?.fileName || !handle?.record) {
            throw new Error('recovery handle is invalid');
        }
        return this.recoverEntry(handle.fileName, validateRecord(handle.record));
    }

    async recover() {
        try {
            await this.ensureDirectory();
            const entries = await fs.readdir(this.directory);
            const evidence = [];
            const quarantinedTargets = [];
            let agentAvailable = true;
            let sawAgent = false;
            for (const fileName of entries) {
                if (TEMPORARY_RECORD_NAME.test(fileName)) {
                    try {
                        await this.removeTemporaryResidue(fileName);
                        evidence.push('temporary_record_reclaimed');
                        continue;
                    } catch (_) {
                        return { ok: false, category: 'record_unprovable', evidence: [...evidence, fileName] };
                    }
                }
                let record;
                try {
                    record = await this.readEntry(fileName);
                } catch (_) {
                    return { ok: false, category: 'record_unprovable', evidence: [...evidence, fileName] };
                }
                const result = await this.recoverEntry(fileName, record);
                if (record.targetKind === 'agent') sawAgent = true;
                evidence.push(result.category);
                if (!result.recovered && record.targetKind === 'agent' && result.scope === 'target') {
                    quarantinedTargets.push({ target: result.target || record.target, category: result.category });
                    continue;
                }
                if (!result.recovered && record.targetKind === 'agent' && result.scope === 'provider') {
                    agentAvailable = false;
                    continue;
                }
                if (!result.recovered) return { ok: false, category: result.category, evidence };
            }
            return sawAgent
                ? { ok: true, evidence, agentAvailable, quarantinedTargets }
                : { ok: true, evidence };
        } catch (error) {
            return { ok: false, category: error?.code || 'recovery_failed', evidence: [] };
        }
    }
}

export default RuntimeRecordStore;
