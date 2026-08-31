#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import { buildAgentWorkerEnvironment } from '../../cli/server/webtty/agentWorkerEnvironment.mjs';
import {
    WEBTTY_SHELL_PROMPT,
    bashExecutableLookupFailed,
    fixedAgentInteractiveShellArgv,
    fixedAgentPodmanArgv,
    fixedAgentShellWrapperArgv,
} from '../../cli/server/webtty/agentRuntime.mjs';
import { readinessCommands } from './webttyAgentPtyReadiness.mjs';

const require = createRequire(import.meta.url);
const nodePty = require('/usr/local/lib/ploinky/webtty/node_modules/node-pty');
const PODMAN = '/usr/bin/podman';
const WAIT_MS = 10_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_HTTP_RESPONSE_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024;
const MAX_PROC_BYTES = 64 * 1024;
const MAX_PROC_ENTRIES = 8_192;
const PODMAN_ABSENT = /(?:no such|not found|does not exist|no container with name or id)/i;
const TARGET_CONFIG_ENV_KEY = 'PLOINKY_PHASE0_TARGET_CONFIG_ENV';
const HOSTILE_BASH_ENV_PATH = '/tmp/ploinky-phase0-hostile-bash-env';
const HOSTILE_SHELL_ENV_PATH = '/tmp/ploinky-phase0-hostile-shell-env';
const FORGED_READINESS_PROBE = `( ${[
    'IFS= read -r phase0_forged_stat < /proc/$$/stat',
    'phase0_forged_tail=${phase0_forged_stat##*) }',
    "IFS=' \t'",
    'set -- $phase0_forged_tail',
    'phase0_forged_start=${20}',
    'phase0_forged_uid=',
    "while read -r phase0_forged_key phase0_forged_value phase0_forged_rest; do [ \"$phase0_forged_key\" = 'Uid:' ] && { phase0_forged_uid=$phase0_forged_value; break; }; done < /proc/$$/status",
    "printf '__PLOINKY_READY__%s|%s|%s|%s|%s|%s\\n__PLOINKY_REST_READY__%s|%s|%s|%s|%s|%s\\n' \"$PLOINKY_WEBTTY_MARKER\" \"$$\" \"$3\" \"$4\" \"$phase0_forged_uid\" \"$phase0_forged_start\" \"$PLOINKY_WEBTTY_MARKER\" \"$$\" \"$3\" \"$4\" \"$phase0_forged_uid\" \"$phase0_forged_start\"",
].join('; ')} )`;
let cliExecMode = 'persistent-session';

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sourceDigest(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runPodman(args, { ok = true, timeout = 120_000 } = {}) {
    const result = spawnSync(PODMAN, args, {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout,
        killSignal: 'SIGKILL',
        env: process.env,
    });
    const record = {
        ok: result.status === 0,
        status: Number.isInteger(result.status) ? result.status : null,
        signal: result.signal || null,
        errorCode: result.error?.code || null,
        errorMessage: result.error?.message || null,
        stdout: String(result.stdout || '').trim(),
        stderr: String(result.stderr || '').trim(),
    };
    if (ok) assert.equal(record.ok, true, `${args.join(' ')} failed: ${JSON.stringify(record)}`);
    return record;
}

function assertPodmanAbsent(record, label) {
    assert.equal(record.ok, false, `${label} unexpectedly exists`);
    assert.equal(record.signal, null, `${label} inspection was interrupted`);
    assert.equal(record.errorCode, null, `${label} inspection failed to execute`);
    assert.match(`${record.stderr}\n${record.stdout}`, PODMAN_ABSENT,
        `${label} absence was not proven: ${JSON.stringify(record)}`);
}

function podmanJson(args) {
    const result = runPodman(args);
    return JSON.parse(result.stdout);
}

async function waitFor(check, label, timeoutMs = WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        try {
            last = await check();
            if (last) return last;
        } catch (error) {
            last = error;
        }
        await delay(40);
    }
    throw new Error(`${label} timed out: ${last instanceof Error ? last.message : String(last || '')}`);
}

function parseProcStat(raw, expectedPid) {
    const close = raw.lastIndexOf(')');
    assert.ok(close > 0);
    const pid = Number(raw.slice(0, raw.indexOf('(')).trim());
    assert.equal(pid, expectedPid);
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    return {
        pid,
        state: fields[0],
        parentPid: Number(fields[1]),
        pgrp: Number(fields[2]),
        session: Number(fields[3]),
        startToken: `linux-proc:${fields[19]}`,
    };
}

function boxReadyShellProcesses(containerId, inner, shellPath) {
    const target = inspectContainer(containerId);
    assert.equal(target.State.Running, true);
    const initPid = Number(target.State.Pid);
    const initBefore = localProcessIdentity(initPid);
    const targetPidNamespace = fs.readlinkSync(`/proc/${initPid}/ns/pid`);
    const expectedArgv = fixedAgentInteractiveShellArgv(shellPath);
    const matches = [];
    for (const entry of procEntries()) {
        const pid = Number(entry);
        try {
            if (fs.readlinkSync(`/proc/${pid}/ns/pid`) !== targetPidNamespace) continue;
            const commandBefore = readBoundedProcFile(`/proc/${pid}/cmdline`)
                .toString('utf8').split('\0').filter(Boolean);
            if (commandBefore.length !== expectedArgv.length
                || commandBefore.some((value, index) => value !== expectedArgv[index])) continue;
            const identityBefore = localProcessIdentity(pid);
            const status = readBoundedProcFile(`/proc/${pid}/status`, 'utf8');
            const nspid = parseStatusVector(status, 'NSpid');
            if (nspid.at(-1) !== inner.pid) continue;
            const identityAfter = localProcessIdentity(pid);
            const commandAfter = readBoundedProcFile(`/proc/${pid}/cmdline`)
                .toString('utf8').split('\0').filter(Boolean);
            assert.equal(identityAfter.startToken, identityBefore.startToken,
                'ready shell changed during exact identity capture');
            assert.deepEqual(commandAfter, commandBefore,
                'ready shell argv changed during exact identity capture');
            matches.push({
                ...identityAfter,
                argv: commandAfter,
                pidNamespace: targetPidNamespace,
                nspid,
                nspgid: parseStatusVector(status, 'NSpgid'),
                nssid: parseStatusVector(status, 'NSsid'),
                uid: parseStatusVector(status, 'Uid'),
                innerUid: mappedInnerUid(pid, status),
            });
        } catch (error) {
            if (['ENOENT', 'ESRCH'].includes(error?.code)) continue;
            throw error;
        }
    }
    const initAfter = localProcessIdentity(initPid);
    assert.equal(initAfter.startToken, initBefore.startToken,
        'target init changed during ready-shell scan');
    assert.equal(fs.readlinkSync(`/proc/${initPid}/ns/pid`), targetPidNamespace,
        'target PID namespace changed during ready-shell scan');
    return matches;
}

function procEntries() {
    const directory = fs.opendirSync('/proc');
    const entries = [];
    let scanned = 0;
    try {
        while (true) {
            const entry = directory.readSync();
            if (!entry) break;
            scanned += 1;
            assert.ok(scanned <= MAX_PROC_ENTRIES, 'Phase 0 proc scan exceeded entry bound');
            if (entry.isDirectory() && /^[1-9][0-9]*$/.test(entry.name)) entries.push(entry.name);
        }
    } finally {
        directory.closeSync();
    }
    return entries;
}

function readBoundedProcFile(filePath, encoding = null) {
    const descriptor = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(MAX_PROC_BYTES + 1);
        const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
        assert.ok(bytes <= MAX_PROC_BYTES, `${filePath} exceeded Phase 0 proc evidence bound`);
        const value = buffer.subarray(0, bytes);
        return encoding ? value.toString(encoding) : value;
    } finally {
        fs.closeSync(descriptor);
    }
}

function localProcessIdentity(pid) {
    return parseProcStat(readBoundedProcFile(`/proc/${pid}/stat`, 'utf8'), pid);
}

function parseStatusVector(status, key) {
    const line = status.split(/\n/).find((entry) => entry.startsWith(`${key}:`));
    assert.ok(line, `${key} is required in Linux process status`);
    const values = line.slice(key.length + 1).trim().split(/\s+/).map(Number);
    assert.ok(values.length > 0 && values.every(Number.isInteger), `${key} must be numeric`);
    return values;
}

function mappedInnerUid(pid, status) {
    const uid = parseStatusVector(status, 'Uid');
    assert.equal(uid.length, 4, 'Uid status vector must contain four values');
    assert.ok(uid.every((value) => value === uid[0]),
        'effective target identity must have one stable Box-visible UID');
    const mappings = readBoundedProcFile(`/proc/${pid}/uid_map`, 'utf8')
        .trim().split('\n').filter(Boolean).map((line) => {
            const values = line.trim().split(/\s+/).map(Number);
            assert.equal(values.length, 3, 'uid_map rows must contain three values');
            assert.ok(values.every((value) => Number.isSafeInteger(value) && value >= 0));
            assert.ok(values[2] > 0, 'uid_map ranges must be non-empty');
            return values;
        });
    const matches = mappings.filter(([, outside, length]) => (
        uid[0] >= outside && uid[0] < outside + length
    ));
    assert.equal(matches.length, 1,
        'Box-visible UID must map to exactly one target UID range');
    const [[inside, outside]] = matches;
    return inside + (uid[0] - outside);
}

function boxMarkerProcesses(containerId, user, marker, shellPath = '/bin/bash') {
    assert.match(containerId, /^[a-f0-9]{64}$/);
    assert.match(user, /^(?:[0-9]+|[A-Za-z_][A-Za-z0-9_-]*)(?::(?:[0-9]+|[A-Za-z_][A-Za-z0-9_-]*))?$/);
    assert.match(marker, /^phase0-[a-z0-9-]{20,96}$/);
    const target = inspectContainer(containerId);
    if (!target.State.Running) return [];
    const initPid = Number(target.State.Pid);
    assert.ok(Number.isSafeInteger(initPid) && initPid > 1,
        'running exact target must expose a Box-visible init PID');
    const initBefore = localProcessIdentity(initPid);
    const targetPidNamespace = fs.readlinkSync(`/proc/${initPid}/ns/pid`);
    const expectedArgv = fixedAgentShellWrapperArgv(marker, shellPath);
    const matches = [];
    for (const entry of procEntries()) {
        const pid = Number(entry);
        try {
            if (fs.readlinkSync(`/proc/${pid}/ns/pid`) !== targetPidNamespace) continue;
            const commandBefore = readBoundedProcFile(`/proc/${pid}/cmdline`)
                .toString('utf8').split('\0').filter(Boolean);
            if (commandBefore.length !== expectedArgv.length
                || commandBefore.some((value, index) => value !== expectedArgv[index])) continue;
            const identityBefore = localProcessIdentity(pid);
            const status = readBoundedProcFile(`/proc/${pid}/status`, 'utf8');
            const identityAfter = localProcessIdentity(pid);
            const commandAfter = readBoundedProcFile(`/proc/${pid}/cmdline`)
                .toString('utf8').split('\0').filter(Boolean);
            assert.equal(identityAfter.startToken, identityBefore.startToken,
                'target process changed during marker evidence capture');
            assert.deepEqual(commandAfter, commandBefore,
                'target marker argv changed during marker evidence capture');
            const nspid = parseStatusVector(status, 'NSpid');
            matches.push({
                ...identityAfter,
                argv: commandAfter,
                pidNamespace: targetPidNamespace,
                nspid,
                nspgid: parseStatusVector(status, 'NSpgid'),
                nssid: parseStatusVector(status, 'NSsid'),
                uid: parseStatusVector(status, 'Uid'),
                innerUid: mappedInnerUid(pid, status),
            });
        } catch (error) {
            if (['ENOENT', 'ESRCH'].includes(error?.code)) continue;
            throw error;
        }
    }
    const initAfter = localProcessIdentity(initPid);
    assert.equal(initAfter.startToken, initBefore.startToken,
        'target init changed during marker scan');
    assert.equal(fs.readlinkSync(`/proc/${initPid}/ns/pid`), targetPidNamespace,
        'target PID namespace changed during marker scan');
    return matches;
}

function boxSessionProcesses(boxInner, innerSession) {
    assert.match(boxInner?.pidNamespace || '', /^pid:\[\d+\]$/);
    assert.ok(Number.isInteger(innerSession) && innerSession > 0);
    const matches = [];
    for (const entry of procEntries()) {
        const pid = Number(entry);
        try {
            if (fs.readlinkSync(`/proc/${pid}/ns/pid`) !== boxInner.pidNamespace) continue;
            const status = readBoundedProcFile(`/proc/${pid}/status`, 'utf8');
            const nssid = parseStatusVector(status, 'NSsid');
            if (nssid.at(-1) !== innerSession) continue;
            matches.push({ ...localProcessIdentity(pid), nssid });
        } catch (error) {
            if (['ENOENT', 'ESRCH'].includes(error?.code)) continue;
            throw error;
        }
    }
    return matches;
}

function reclaimBoxSession(containerId, user, marker, inner, boxInner, shellPath = '/bin/bash') {
    const markerMatches = boxMarkerProcesses(containerId, user, marker, shellPath);
    const diagnostic = JSON.stringify({ marker, inner, boxInner, markerMatches });
    const exactLeaders = markerMatches.filter((identity) => (
        identity.pid === boxInner.pid && identity.startToken === boxInner.startToken
    ));
    assert.equal(exactLeaders.length, 1, diagnostic);
    const [current] = exactLeaders;
    assert.equal(current.pid, boxInner.pid, diagnostic);
    assert.equal(current.startToken, boxInner.startToken, diagnostic);
    assert.equal(current.pidNamespace, boxInner.pidNamespace, diagnostic);
    assert.equal(current.nssid.at(-1), inner.session, diagnostic);
    assert.equal(current.innerUid, inner.uid, diagnostic);
    assert.ok(markerMatches.every((identity) => (
        identity.pidNamespace === boxInner.pidNamespace
        && identity.nssid.at(-1) === inner.session
    )), diagnostic);
    const anchoredSession = boxSessionProcesses(boxInner, inner.session);
    assert.ok(anchoredSession.some((identity) => (
        identity.pid === current.pid && identity.startToken === current.startToken
    )), diagnostic);
    for (const signal of ['SIGTERM', 'SIGKILL']) {
        for (const identity of anchoredSession) {
            if (!sameLocalProcess(identity)) continue;
            try { process.kill(identity.pid, signal); } catch (error) {
                if (error.code !== 'ESRCH') throw error;
            }
        }
        spawnSync('/bin/sleep', ['0.2']);
    }
}

function sameLocalProcess(identity) {
    try {
        return localProcessIdentity(identity.pid).startToken === identity.startToken;
    } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error?.code)) return false;
        throw error;
    }
}

function localProcessGroupProcesses(pgrp) {
    const matches = [];
    for (const entry of procEntries()) {
        const pid = Number(entry);
        try {
            const identity = localProcessIdentity(pid);
            if (identity.pgrp === pgrp) matches.push(identity);
        } catch (error) {
            if (['ENOENT', 'ESRCH'].includes(error?.code)) continue;
            throw error;
        }
    }
    return matches;
}

async function terminateLocalProcessGroup(leader) {
    assert.equal(leader.pid, leader.pgrp, 'service leader must own its process group');
    const initial = localProcessGroupProcesses(leader.pgrp);
    if (initial.length === 0) return;
    assert.equal(sameLocalProcess(leader), true,
        'refusing to signal a process group after its exact leader identity disappeared');
    assert.ok(initial.some((entry) => entry.pid === leader.pid
        && entry.startToken === leader.startToken));
    for (const signal of ['SIGTERM', 'SIGKILL']) {
        for (const identity of initial) {
            if (!sameLocalProcess(identity)) continue;
            try { process.kill(identity.pid, signal); } catch (error) {
                if (error.code !== 'ESRCH') throw error;
            }
        }
        try {
            await waitFor(() => localProcessGroupProcesses(leader.pgrp).length === 0,
                `process group ${leader.pgrp} ${signal} reap`, 1_000);
            return;
        } catch (_) { /* escalate below */ }
    }
    assert.deepEqual(localProcessGroupProcesses(leader.pgrp), [],
        `process group ${leader.pgrp} survived SIGKILL`);
}

function inspectContainer(containerId) {
    const records = podmanJson(['container', 'inspect', containerId]);
    assert.equal(records.length, 1);
    assert.equal(records[0].Id, containerId);
    return records[0];
}

function currentExecIds(containerId) {
    const value = inspectContainer(containerId).ExecIDs;
    return Array.isArray(value) ? value.map(String) : [];
}

function drainExactExecRecord(containerId, execId) {
    assert.match(execId, /^[a-f0-9]{64}$/);
    const before = currentExecIds(containerId);
    if (before.length === 0) return 'automatic';
    assert.deepEqual(before, [execId],
        'exact exec cleanup refuses unrelated or multiple live records');
    runPodman([
        'container', 'cleanup', '--stopped-only', '--rm', '--exec', execId, containerId,
    ]);
    assert.deepEqual(currentExecIds(containerId), [],
        'exact exec cleanup must remove only the persisted record');
    return 'exact-container-cleanup';
}

function markerProcesses(containerId, user, marker, shellPath) {
    return boxMarkerProcesses(containerId, user, marker, shellPath).map((identity) => Object.freeze({
        pid: identity.nspid.at(-1),
        state: identity.state,
        pgrp: identity.nspgid.at(-1),
        session: identity.nssid.at(-1),
        startToken: identity.startToken,
    }));
}

async function waitForTerminalOutput(session, needle, label) {
    return waitForOutputMatch(() => {
        if (session.outputError) throw session.outputError;
        return session.output;
    }, new RegExp(escapeRegExp(needle)), label);
}

async function waitForOutputMatch(readOutput, pattern, label) {
    try {
        return await waitFor(() => readOutput().match(pattern), label);
    } catch (error) {
        const output = readOutput();
        const bounded = Buffer.from(output).subarray(-MAX_DIAGNOSTIC_BYTES).toString('utf8');
        error.message += `; bounded terminal transcript: ${JSON.stringify(bounded)}`;
        throw error;
    }
}

function terminalExit(terminal) {
    return new Promise((resolve) => terminal.onExit(resolve));
}

async function cleanupFailedCliSession({
    terminal,
    exit,
    cliIdentity,
    containerId,
    user,
    marker,
    shellPath = '/bin/bash',
}) {
    const errors = [];
    try {
        terminal.write('\x03exit 125\r');
        await Promise.race([exit, delay(1_000)]);
        if (cliIdentity && sameLocalProcess(cliIdentity)) terminal.kill();
    } catch (error) {
        errors.push(`PTY close: ${error.message}`);
    }
    if (cliIdentity) {
        try {
            await Promise.race([exit, delay(500)]);
            if (sameLocalProcess(cliIdentity)) process.kill(cliIdentity.pid, 'SIGKILL');
            await waitFor(() => !sameLocalProcess(cliIdentity), 'failed CLI client reap');
        } catch (error) {
            errors.push(`client reap: ${error.message}`);
        }
    }
    try {
        const boxMarkers = boxMarkerProcesses(containerId, user, marker, shellPath);
        if (boxMarkers.length > 0) {
            const leaders = boxMarkers.filter((identity) => (
                identity.nspid.at(-1) === identity.nspgid.at(-1)
                && identity.nspid.at(-1) === identity.nssid.at(-1)
            ));
            assert.equal(leaders.length, 1, 'one marker-bearing session leader must anchor cleanup');
            const [boxInner] = leaders;
            reclaimBoxSession(containerId, user, marker, {
                pid: boxInner.nspid.at(-1),
                pgrp: boxInner.nspgid.at(-1),
                session: boxInner.nssid.at(-1),
                uid: boxInner.innerUid,
            }, boxInner, shellPath);
        }
        await waitFor(() => boxMarkerProcesses(containerId, user, marker, shellPath).length === 0,
            'failed CLI Box marker reclamation');
        const execIds = currentExecIds(containerId);
        assert.ok(execIds.length <= 1, 'failed CLI cleanup found unrelated exec records');
        if (execIds.length === 1) drainExactExecRecord(containerId, execIds[0]);
    } catch (error) {
        errors.push(`inner reclaim: ${error.message}`);
    }
    return errors;
}

async function openCliSession({
    containerId,
    user,
    marker,
    shellPath = '/bin/bash',
    proveBashAbsent = false,
}) {
    assert.match(containerId, /^[a-f0-9]{64}$/);
    assert.match(marker, /^phase0-[a-z0-9-]{20,96}$/);
    const original = inspectContainer(containerId);
    assert.equal(original.State.Running, true);
    const configuredTargetEnvironment = (original.Config?.Env || [])
        .filter((entry) => entry.startsWith(`${TARGET_CONFIG_ENV_KEY}=`));
    assert.equal(configuredTargetEnvironment.length, 1,
        'exact target must carry one Phase 0 Config.Env canary');
    const targetEnvironmentValue = configuredTargetEnvironment[0].slice(TARGET_CONFIG_ENV_KEY.length + 1);
    const configuredBashEnvironment = (original.Config?.Env || [])
        .filter((entry) => entry.startsWith('BASH_ENV='));
    assert.ok(configuredBashEnvironment.length <= 1,
        'exact target must not carry ambiguous BASH_ENV values');
    const targetBashEnvironment = configuredBashEnvironment.length === 1
        ? configuredBashEnvironment[0].slice('BASH_ENV='.length)
        : null;
    assert.match(targetEnvironmentValue, /^phase0-target-wtty-[a-z0-9-]{8,96}$/);
    assert.equal(process.env[TARGET_CONFIG_ENV_KEY], undefined,
        'target Config.Env canary must not exist in the Box/worker environment');
    const session = { output: '', outputBytes: 0, outputError: null };
    assert.match(shellPath, /^\/bin\/(?:bash|sh)$/);
    assert.equal(proveBashAbsent, shellPath === '/bin/sh');
    const productionArgv = fixedAgentPodmanArgv({
        targetUser: user,
        translatedCwd: '/tmp',
        marker,
        containerId,
    }, shellPath);
    const podmanArgv = cliExecMode === 'no-session'
        ? [...productionArgv.slice(0, 2), '--no-session', ...productionArgv.slice(2)]
        : productionArgv;
    const terminal = nodePty.spawn(PODMAN, podmanArgv, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        env: {
            HOME: '/home/podman',
            USER: 'podman',
            LOGNAME: 'podman',
            PATH: '/usr/local/bin:/usr/bin:/bin',
            TERM: 'xterm-256color',
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
        },
    });
    terminal.onData((data) => {
        session.outputBytes += Buffer.byteLength(data);
        if (session.outputBytes > MAX_OUTPUT_BYTES) {
            session.outputError ||= new Error('terminal output exceeded bound');
            try { terminal.kill(); } catch (_) { /* cleanup path proves termination */ }
            return;
        }
        session.output += String(data);
    });
    const exit = terminalExit(terminal);
    let cliIdentity = null;
    try {
        cliIdentity = await waitFor(() => {
            try { return localProcessIdentity(terminal.pid); } catch (_) { return null; }
        }, 'Box-side Podman client identity');
        const initialExecIds = cliExecMode === 'no-session'
            ? currentExecIds(containerId)
            : await waitFor(() => {
                const values = currentExecIds(containerId);
                return values.length === 1 ? values : null;
            }, 'nested exec identity');
        if (cliExecMode === 'no-session') {
            assert.deepEqual(initialExecIds, [], '--no-session must not create an exec record');
        }
        const initialMarkerProcesses = await waitFor(() => {
            const values = markerProcesses(containerId, user, marker, shellPath);
            return values.length > 0 ? values : null;
        }, 'marker-bearing inner shell');
        const initialBoxMarker = await waitFor(() => {
            const values = boxMarkerProcesses(containerId, user, marker, shellPath);
            return values.length === 1 ? values[0] : null;
        }, 'Box-visible marker-bearing inner shell');
        // The readiness capability is generated only after the PTY client and
        // exact marker-bearing wrapper exist. It therefore cannot be forged by
        // target Config.Env, shell startup hooks, argv, or terminal echo before
        // this server-side write.
        const readinessChallenge = crypto.randomBytes(32).toString('base64url');
        assert.match(readinessChallenge, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(productionArgv.some((value) => value.includes(readinessChallenge)), false);
        assert.equal((original.Config?.Env || []).some(
            (value) => String(value).includes(readinessChallenge),
        ), false);
        const readyPrefix = `__PLOINKY_READY__${marker}|${readinessChallenge}|`;
        const readiness = readinessCommands({
            readyPrefix,
            ioPrefix: `__PLOINKY_IO__${marker}|`,
            inputVariable: 'phase0_value',
        });
        if (proveBashAbsent) readiness.unshift('[ ! -e /bin/bash ] || exit 125');
        terminal.write(readiness.join('; ') + '\r');
        const readyPattern = new RegExp(
            `${escapeRegExp(readyPrefix)}(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)`,
        );
        const readyMatch = await waitForOutputMatch(() => {
            if (session.outputError) throw session.outputError;
            return session.output;
        }, readyPattern,
            'inner shell readiness');
        const inner = {
            pid: Number(readyMatch[1]),
            pgrp: Number(readyMatch[2]),
            session: Number(readyMatch[3]),
            uid: Number(readyMatch[4]),
            startToken: `linux-proc:${readyMatch[5]}`,
        };
        const forgedMatch = await waitForOutputMatch(
            () => session.output,
            new RegExp(
                `__PLOINKY_READY__${escapeRegExp(marker)}\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)`,
            ),
            'hostile startup readiness frame',
        );
        assert.deepEqual(forgedMatch.slice(1), readyMatch.slice(1),
            'the challenge-less startup frame must otherwise carry the exact admitted shell identity');
        const execIds = cliExecMode === 'no-session'
            ? currentExecIds(containerId)
            : await waitFor(() => {
                const values = currentExecIds(containerId);
                return values.length === 1 ? values : null;
            }, 'nested exec identity after readiness');
        assert.deepEqual(execIds, initialExecIds);
        const activeMarkerProcesses = markerProcesses(containerId, user, marker, shellPath);
        const activeBoxMarkers = boxMarkerProcesses(containerId, user, marker, shellPath);
        const readyShells = boxReadyShellProcesses(containerId, inner, shellPath);
        const markerDiagnostic = JSON.stringify({
            marker,
            inner,
            initialMarkerProcesses,
            activeMarkerProcesses,
            initialBoxMarker,
            activeBoxMarkers,
            readyShells,
        });
        assert.equal(activeMarkerProcesses.length, 1, markerDiagnostic);
        assert.ok(activeMarkerProcesses.every((entry) => entry.session === inner.session), markerDiagnostic);
        assert.equal(activeBoxMarkers.length, 1, markerDiagnostic);
        assert.equal(readyShells.length, 1, markerDiagnostic);
        const boxInner = activeBoxMarkers[0];
        const readyShell = readyShells[0];
        assert.equal(boxInner.startToken, initialBoxMarker.startToken, markerDiagnostic);
        assert.equal(activeMarkerProcesses[0].pid, boxInner.nspid.at(-1), markerDiagnostic);
        assert.equal(activeMarkerProcesses[0].startToken, boxInner.startToken, markerDiagnostic);
        assert.equal(boxInner.nssid.at(-1), inner.session, markerDiagnostic);
        assert.equal(boxInner.innerUid, inner.uid, markerDiagnostic);
        assert.equal(readyShell.parentPid, boxInner.pid, markerDiagnostic);
        assert.equal(readyShell.nspid.at(-1), inner.pid, markerDiagnostic);
        assert.equal(readyShell.nspgid.at(-1), inner.pgrp, markerDiagnostic);
        assert.equal(readyShell.nssid.at(-1), inner.session, markerDiagnostic);
        assert.equal(readyShell.innerUid, inner.uid, markerDiagnostic);
        assert.equal(readyShell.startToken, inner.startToken, markerDiagnostic);
        terminal.resize(101, 33);
        terminal.write(`phase0-input-${marker}\r`);
        await waitForTerminalOutput(session, `__PLOINKY_IO__${marker}|phase0-input-${marker}`,
            'terminal input round trip');
        terminal.write(
            `printf '__PLOINKY_TARGET_ENV__${marker}|%s\\n' "$${TARGET_CONFIG_ENV_KEY}"\r`,
        );
        await waitForTerminalOutput(
            session,
            `__PLOINKY_TARGET_ENV__${marker}|${targetEnvironmentValue}`,
            'target Config.Env inheritance',
        );
        if (targetBashEnvironment !== null) {
            terminal.write(`printf '__PLOINKY_BASH_ENV__${marker}|%s\\n' "$BASH_ENV"\r`);
            await waitForTerminalOutput(
                session,
                `__PLOINKY_BASH_ENV__${marker}|${targetBashEnvironment}`,
                'target BASH_ENV inheritance after privileged wrapper startup',
            );
        }
        terminal.write([
            'phase0_resize_attempt=0',
            'while phase0_size=$(stty size); test "$phase0_size" != "33 101"; do phase0_resize_attempt=$((phase0_resize_attempt + 1))',
            'test "$phase0_resize_attempt" -lt 200 || break',
            'read -r -t 0.05 -n 0 phase0_resize_pause || true',
            'done',
            `printf '__PLOINKY_SIZE__${marker}|%s\\n' "$phase0_size"`,
        ].join('; ') + '\r');
        await waitForTerminalOutput(session, `__PLOINKY_SIZE__${marker}|33 101`, 'terminal resize');
        assert.equal(inspectContainer(containerId).Id, original.Id);
        return {
            terminal,
            exit,
            session,
            cliIdentity,
            inner,
            boxInner,
            execId: execIds[0] || null,
            execMode: cliExecMode,
            originalImage: original.Image,
            targetConfigEnvironmentInherited: true,
            hostileBashEnvironmentSuppressed: targetBashEnvironment !== null,
            postSpawnReadinessChallenge: true,
            hostileStartupFrameRejected: true,
            activeMarkerProcesses,
            shellPath,
        };
    } catch (error) {
        const cleanupErrors = await cleanupFailedCliSession({
            terminal,
            exit,
            cliIdentity,
            containerId,
            user,
            marker,
            shellPath,
        });
        if (cleanupErrors.length > 0) error.message += `\nCLI failure cleanup:\n${cleanupErrors.join('\n')}`;
        throw error;
    }
}

async function auditClosedSession({
    containerId,
    user,
    marker,
    execId,
    inner,
    boxInner,
    shellPath = '/bin/bash',
}) {
    const container = inspectContainer(containerId);
    let targetMarkerProof = 'container-stopped';
    if (container.State.Running) {
        await waitFor(() => markerProcesses(containerId, user, marker, shellPath).length === 0,
            'target-side marker reclamation');
        targetMarkerProof = 'exact-target-proc-scan';
    } else {
        assert.equal(container.State.Pid, 0, 'stopped target must have no live init process');
    }
    await waitFor(() => boxMarkerProcesses(containerId, user, marker, shellPath).length === 0,
        'Box marker reclamation');
    await waitFor(() => boxSessionProcesses(boxInner, inner.session).length === 0,
        'Box-visible inner session reclamation');
    let execDrain = 'not-created';
    if (execId) execDrain = drainExactExecRecord(containerId, execId);
    else assert.deepEqual(currentExecIds(containerId), [], 'sessionless exec record must stay absent');
    return {
        markerProcesses: 0,
        targetMarkerProof,
        boxMarkerProcesses: 0,
        sessionProcesses: 0,
        execIds: 0,
        exactExecId: execId,
        execRecordDrained: execId ? true : null,
        execRecordAbsentThroughout: execId ? false : true,
        execDrain,
    };
}

async function runNormalCliSession(target) {
    const opened = await openCliSession(target);
    try {
        opened.terminal.write('exit 7\r');
        const exit = await Promise.race([
            opened.exit,
            delay(WAIT_MS).then(() => { throw new Error('normal CLI terminal exit timed out'); }),
        ]);
        assert.equal(exit.exitCode, 7);
        await waitFor(() => !sameLocalProcess(opened.cliIdentity), 'Box Podman client reap');
        const audit = await auditClosedSession({ ...target, ...opened });
        return {
            uid: opened.inner.uid,
            dimensions: [101, 33],
            io: true,
            normalExitCode: exit.exitCode,
            markerInInnerProcess: true,
            boxClient: opened.cliIdentity,
            inner: opened.inner,
            boxInner: opened.boxInner,
            execId: opened.execId,
            postSpawnReadinessChallenge: opened.postSpawnReadinessChallenge,
            hostileStartupFrameRejected: opened.hostileStartupFrameRejected,
            hostileBashEnvironmentSuppressed: opened.hostileBashEnvironmentSuppressed,
            audit,
        };
    } catch (error) {
        const cleanupErrors = await cleanupFailedCliSession({ ...target, ...opened });
        if (cleanupErrors.length > 0) error.message += `\nnormal-session cleanup:\n${cleanupErrors.join('\n')}`;
        throw error;
    }
}

async function runMissingShellAttempt({ containerId, user, marker, shellPath }) {
    assert.equal(cliExecMode, 'persistent-session');
    const baselineExecIds = currentExecIds(containerId);
    assert.deepEqual(baselineExecIds, []);
    const output = { value: '', bytes: 0 };
    const args = fixedAgentPodmanArgv({
        targetUser: user,
        translatedCwd: '/tmp',
        marker,
        containerId,
    }, shellPath);
    const terminal = nodePty.spawn(PODMAN, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        env: buildAgentWorkerEnvironment(),
    });
    terminal.onData((data) => {
        output.bytes += Buffer.byteLength(data);
        assert.ok(output.bytes <= MAX_OUTPUT_BYTES, 'missing-shell diagnostic exceeded bound');
        output.value += String(data);
    });
    const exit = await Promise.race([
        terminalExit(terminal),
        delay(WAIT_MS).then(() => { throw new Error(`${shellPath} absence did not exit`); }),
    ]);
    assert.ok([126, 127].includes(exit.exitCode), JSON.stringify({ shellPath, exit, output }));
    if (shellPath === '/bin/bash') {
        assert.equal(bashExecutableLookupFailed(output.value, exit), true, output.value);
    } else {
        assert.match(output.value, /\/bin\/sh.*(?:not found|no such file)/i);
    }
    await waitFor(() => markerProcesses(containerId, user, marker, shellPath).length === 0,
        `${shellPath} absence target-marker cleanup`);
    await waitFor(() => boxMarkerProcesses(containerId, user, marker, shellPath).length === 0,
        `${shellPath} absence Box-marker cleanup`);
    const added = currentExecIds(containerId).filter((id) => !baselineExecIds.includes(id));
    assert.ok(added.length <= 1, `${shellPath} absence created ambiguous exec records`);
    if (added.length === 1) drainExactExecRecord(containerId, added[0]);
    assert.deepEqual(currentExecIds(containerId), baselineExecIds);
    return {
        shellPath,
        exitCode: exit.exitCode,
        exactFallbackClassifier: shellPath === '/bin/bash',
        audit: {
            markerProcesses: 0,
            boxMarkerProcesses: 0,
            execIds: 0,
        },
    };
}

async function runShellSelectionMatrix({ containerId, user, markerPrefix, runId }) {
    const hiddenBash = `/bin/.phase0-hidden-bash-${runId}`;
    const hiddenSh = `/bin/.phase0-hidden-sh-${runId}`;
    let bashHidden = false;
    let shHidden = false;
    let bashAbsence;
    let fallback;
    try {
        runPodman([
            'container', 'exec', '--user', '0:0', containerId,
            '/bin/sh', '-c', 'test -x /bin/bash && test ! -e "$1" && mv /bin/bash "$1"',
            'phase0-hide-bash', hiddenBash,
        ]);
        bashHidden = true;
        bashAbsence = await runMissingShellAttempt({
            containerId,
            user,
            marker: `${markerPrefix}-bash-absent`,
            shellPath: '/bin/bash',
        });
        fallback = await runNormalCliSession({
            containerId,
            user,
            marker: `${markerPrefix}-sh-fallback`,
            shellPath: '/bin/sh',
            proveBashAbsent: true,
        });
    } finally {
        if (bashHidden) {
            runPodman([
                'container', 'exec', '--user', '0:0', containerId,
                '/bin/sh', '-c', 'test ! -e /bin/bash && mv "$1" /bin/bash',
                'phase0-restore-bash', hiddenBash,
            ]);
            bashHidden = false;
        }
    }

    let bothMissing;
    try {
        runPodman([
            'container', 'exec', '--user', '0:0', containerId,
            '/bin/sh', '-c',
            'test -x /bin/bash && test ! -e "$1" && test ! -e "$2" && mv /bin/bash "$1" && mv /bin/sh "$2"',
            'phase0-hide-shells', hiddenBash, hiddenSh,
        ]);
        bashHidden = true;
        shHidden = true;
        const bash = await runMissingShellAttempt({
            containerId,
            user,
            marker: `${markerPrefix}-both-bash`,
            shellPath: '/bin/bash',
        });
        const sh = await runMissingShellAttempt({
            containerId,
            user,
            marker: `${markerPrefix}-both-sh`,
            shellPath: '/bin/sh',
        });
        bothMissing = { shellUnavailable: true, bash, sh };
    } finally {
        if (shHidden) {
            runPodman([
                'container', 'exec', '--user', '0:0', containerId,
                hiddenSh, '-c',
                'test ! -e /bin/sh && mv "$1" /bin/sh; test ! -e /bin/bash && mv "$2" /bin/bash',
                'phase0-restore-shells', hiddenSh, hiddenBash,
            ]);
            shHidden = false;
            bashHidden = false;
        } else if (bashHidden) {
            runPodman([
                'container', 'exec', '--user', '0:0', containerId,
                '/bin/sh', '-c', 'test ! -e /bin/bash && mv "$1" /bin/bash',
                'phase0-restore-bash', hiddenBash,
            ]);
            bashHidden = false;
        }
    }
    return { bashAbsence, fallback, bothMissing };
}

async function runControlledClose(target) {
    const opened = await openCliSession(target);
    try {
        opened.terminal.kill();
        await Promise.race([
            opened.exit,
            delay(WAIT_MS).then(() => { throw new Error('controlled PTY close timed out'); }),
        ]);
        await waitFor(() => !sameLocalProcess(opened.cliIdentity), 'controlled-close Box Podman client reap');
        let autoReclaimed = false;
        try {
            await waitFor(() => markerProcesses(
                target.containerId,
                target.user,
                target.marker,
                opened.shellPath,
            ).length === 0,
                'automatic controlled-close reclamation', 1_500);
            autoReclaimed = true;
        } catch (_) {
            reclaimBoxSession(
                target.containerId,
                target.user,
                target.marker,
                opened.inner,
                opened.boxInner,
                opened.shellPath,
            );
        }
        const audit = await auditClosedSession({ ...target, ...opened });
        return {
            controlledClose: true,
            autoReclaimed,
            exactRecovery: !autoReclaimed,
            audit,
        };
    } catch (error) {
        const cleanupErrors = await cleanupFailedCliSession({ ...target, ...opened });
        if (cleanupErrors.length > 0) error.message += `\ncontrolled-close cleanup:\n${cleanupErrors.join('\n')}`;
        throw error;
    }
}

async function runClientLoss(target, { foreground = false } = {}) {
    const opened = await openCliSession(target);
    try {
        let foregroundIdentity = null;
        if (foreground) {
            const childPrefix = `__PLOINKY_CHILD__${target.marker}|`;
            opened.terminal.write([
                'set -m',
                'sleep 300 & phase0_child=$!',
                `printf '${childPrefix}%s|%s\\n' "$phase0_child" "$(awk '{print $22}' /proc/$phase0_child/stat)"`,
                'fg %1',
            ].join('; ') + '\r');
            const childPattern = new RegExp(`${escapeRegExp(childPrefix)}(\\d+)\\|(\\d+)`);
            const match = await waitFor(() => opened.session.output.match(childPattern),
                'foreground child start');
            foregroundIdentity = { pid: Number(match[1]), startToken: `linux-proc:${match[2]}` };
        }
        assert.equal(sameLocalProcess(opened.cliIdentity), true);
        process.kill(opened.cliIdentity.pid, 'SIGKILL');
        await waitFor(() => !sameLocalProcess(opened.cliIdentity), 'killed Box Podman client reap');
        let autoReclaimed = false;
        try {
            await waitFor(() => markerProcesses(
                target.containerId,
                target.user,
                target.marker,
                opened.shellPath,
            ).length === 0,
                'automatic client-loss reclamation', 1_500);
            autoReclaimed = true;
        } catch (_) {
            reclaimBoxSession(
                target.containerId,
                target.user,
                target.marker,
                opened.inner,
                opened.boxInner,
                opened.shellPath,
            );
        }
        const audit = await auditClosedSession({ ...target, ...opened });
        if (foregroundIdentity) {
            const result = runPodman([
                'container', 'exec', '--user', target.user, target.containerId,
                '/bin/bash', '-c',
                'test ! -e "/proc/$1/stat" || test "$(awk \'{print $22}\' /proc/$1/stat)" != "$2"',
                'phase0-child-audit', String(foregroundIdentity.pid),
                foregroundIdentity.startToken.slice('linux-proc:'.length),
            ], { ok: false });
            assert.equal(result.ok, true, result.stderr);
        }
        return { autoReclaimed, foregroundIdentity, exactRecovery: !autoReclaimed, audit };
    } catch (error) {
        const cleanupErrors = await cleanupFailedCliSession({ ...target, ...opened });
        if (cleanupErrors.length > 0) error.message += `\nclient-loss cleanup:\n${cleanupErrors.join('\n')}`;
        throw error;
    }
}

function createAgent({ imageId, name, root, runId }) {
    const args = [
        'container', 'create',
        '--name', name,
        '--label', `io.assistos.ploinky.phase0=${runId}`,
        '--env', `${TARGET_CONFIG_ENV_KEY}=phase0-target-${runId}`,
        '--env', `BASH_ENV=${HOSTILE_BASH_ENV_PATH}`,
        '--env', `PROMPT_COMMAND=${FORGED_READINESS_PROBE}; unset PROMPT_COMMAND`,
        '--env', `ENV=${HOSTILE_SHELL_ENV_PATH}`,
    ];
    if (root) args.push('--user', '0:0');
    args.push(
        imageId,
        '/bin/bash', '-c', [
            'umask 077',
            'printf \'%s\\n\' "$1" > "$3"',
            'printf \'%s\\n\' "$2" > "$4"',
            'chmod 0444 "$3" "$4"',
            'trap "exit 0" TERM INT',
            'while :; do sleep 300; done',
        ].join('; '),
        'phase0-agent-init',
        '[ -z "${PLOINKY_WEBTTY_MARKER:-}" ] || exit 97',
        `${FORGED_READINESS_PROBE}; unset ENV`,
        HOSTILE_BASH_ENV_PATH,
        HOSTILE_SHELL_ENV_PATH,
    );
    let id = '';
    try {
        const created = runPodman(args, { ok: false });
        if (/^[a-f0-9]{64}$/.test(created.stdout)) id = created.stdout;
        assert.equal(created.ok, true, `agent create failed: ${JSON.stringify(created)}`);
        assert.match(id, /^[a-f0-9]{64}$/);
        runPodman(['container', 'start', id]);
        assert.equal(inspectContainer(id).State.Running, true);
        return id;
    } catch (error) {
        let cleanupError = null;
        try {
            if (!id) {
                const named = runPodman(['container', 'inspect', name], { ok: false });
                if (named.ok) {
                    const records = JSON.parse(named.stdout);
                    assert.equal(records.length, 1);
                    assert.equal(records[0].Name, name);
                    assert.equal(records[0].Config?.Labels?.['io.assistos.ploinky.phase0'], runId);
                    assert.equal(records[0].Image, imageId);
                    id = records[0].Id;
                } else {
                    assertPodmanAbsent(named, `failed create candidate ${name}`);
                }
            }
            removeAgentExact(id);
        } catch (cleanupFailure) {
            cleanupError = cleanupFailure;
        }
        if (cleanupError) error.message += `\nagent create cleanup: ${cleanupError.message}`;
        throw error;
    }
}

function removeAgentExact(containerId) {
    if (!containerId) return;
    const before = runPodman(['container', 'inspect', containerId], { ok: false });
    if (!before.ok) {
        assertPodmanAbsent(before, `container ${containerId}`);
        return;
    }
    const [inspection] = JSON.parse(before.stdout);
    assert.equal(inspection.Id, containerId);
    if (inspection.State.Running) {
        runPodman(['container', 'stop', '--time', '1', containerId]);
    }
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline && currentExecIds(containerId).length > 0) {
        spawnSync('/bin/sleep', ['0.04']);
    }
    assert.deepEqual(currentExecIds(containerId), [], 'exec records must drain before exact removal');
    runPodman(['container', 'rm', containerId]);
    assertPodmanAbsent(
        runPodman(['container', 'inspect', containerId], { ok: false }),
        `container ${containerId}`,
    );
}

function runSymlinkBindInspection(imageId, runId) {
    const realSource = `/workspace/.phase0-bind-real-${runId}`;
    const symlinkSource = `/workspace/.phase0-bind-link-${runId}`;
    const name = `phase0-bind-${runId}`;
    let containerId = '';
    let realSourceCreated = false;
    let symlinkSourceCreated = false;
    try {
        fs.mkdirSync(realSource, { mode: 0o700 });
        realSourceCreated = true;
        fs.symlinkSync(realSource, symlinkSource);
        symlinkSourceCreated = true;
        const created = runPodman([
            'container', 'create',
            '--name', name,
            '--label', `io.assistos.ploinky.phase0=${runId}`,
            '--volume', `${symlinkSource}:/phase0-bind:ro`,
            imageId,
            '/bin/true',
        ], { ok: false });
        if (/^[a-f0-9]{64}$/.test(created.stdout)) containerId = created.stdout;
        assert.equal(created.ok, true, `symlink fixture create failed: ${JSON.stringify(created)}`);
        assert.match(containerId, /^[a-f0-9]{64}$/);
        const inspected = inspectContainer(containerId);
        const mount = inspected.Mounts.find((entry) => entry.Destination === '/phase0-bind');
        assert.ok(mount, 'symlink bind must be present in exact inspect');
        const inspectedSourceRealpath = fs.realpathSync(mount.Source);
        const expectedSourceRealpath = fs.realpathSync(symlinkSource);
        assert.equal(inspectedSourceRealpath, expectedSourceRealpath);
        return {
            requestedSource: symlinkSource,
            inspectedSource: mount.Source,
            expectedSourceRealpath,
            inspectedSourceRealpath,
            inspectRequiresRealpathNormalization: mount.Source !== expectedSourceRealpath,
        };
    } finally {
        try {
            if (!containerId) {
                const named = runPodman(['container', 'inspect', name], { ok: false });
                if (named.ok) {
                    const records = JSON.parse(named.stdout);
                    assert.equal(records.length, 1);
                    assert.equal(records[0].Name, name);
                    assert.equal(records[0].Config?.Labels?.['io.assistos.ploinky.phase0'], runId);
                    assert.equal(records[0].Image, imageId);
                    containerId = records[0].Id;
                } else {
                    assertPodmanAbsent(named, `failed symlink fixture ${name}`);
                }
            }
            removeAgentExact(containerId);
        } finally {
            if (symlinkSourceCreated && fs.existsSync(symlinkSource)) fs.unlinkSync(symlinkSource);
            if (realSourceCreated && fs.existsSync(realSource)) {
                fs.rmSync(realSource, { recursive: true, force: false });
            }
        }
    }
}

async function runStopRemove(imageId, runId) {
    const name = `phase0-stop-${runId}`;
    let id = '';
    const marker = `phase0-${runId}-stop-remove`;
    let opened = null;
    try {
        id = createAgent({ imageId, name, root: false, runId });
        opened = await openCliSession({ containerId: id, user: '1000:1000', marker });
        runPodman(['container', 'stop', '--time', '1', id]);
        await Promise.race([
            opened.exit,
            delay(WAIT_MS).then(() => { throw new Error('target stop did not end terminal'); }),
        ]);
        await waitFor(() => !sameLocalProcess(opened.cliIdentity), 'stop/remove Box Podman client reap');
        assert.equal(inspectContainer(id).State.Running, false);
        const audit = await auditClosedSession({
            containerId: id,
            user: '1000:1000',
            marker,
            ...opened,
        });
        runPodman(['container', 'rm', id]);
        assertPodmanAbsent(runPodman(['container', 'inspect', id], { ok: false }), `container ${id}`);
        return { exactContainerId: id, terminalExited: true, containerAbsent: true, audit };
    } catch (error) {
        if (opened) {
            const cleanupErrors = await cleanupFailedCliSession({
                containerId: id,
                user: '1000:1000',
                marker,
                ...opened,
            });
            if (cleanupErrors.length > 0) {
                error.message += `\nstop/remove cleanup:\n${cleanupErrors.join('\n')}`;
            }
        }
        throw error;
    } finally {
        removeAgentExact(id);
    }
}

async function runSameNameReplacement(imageId, runId) {
    const name = `phase0-replace-${runId}`;
    let oldId = '';
    const marker = `phase0-${runId}-same-name`;
    let replacementId = '';
    let opened = null;
    try {
        oldId = createAgent({ imageId, name, root: false, runId });
        opened = await openCliSession({ containerId: oldId, user: '1000:1000', marker });
        runPodman(['container', 'stop', '--time', '1', oldId]);
        await Promise.race([
            opened.exit,
            delay(WAIT_MS).then(() => { throw new Error('target removal did not end terminal'); }),
        ]);
        await waitFor(() => !sameLocalProcess(opened.cliIdentity), 'replacement Box Podman client reap');
        const audit = await auditClosedSession({
            containerId: oldId,
            user: '1000:1000',
            marker,
            ...opened,
        });
        runPodman(['container', 'rm', oldId]);
        assertPodmanAbsent(runPodman(['container', 'inspect', oldId], { ok: false }), `container ${oldId}`);
        replacementId = createAgent({ imageId, name, root: false, runId });
        assert.notEqual(replacementId, oldId);
        const staleExec = runPodman(['container', 'exec', oldId, '/bin/true'], { ok: false });
        assertPodmanAbsent(staleExec, `stale container ${oldId}`);
        assert.equal(markerProcesses(replacementId, '1000:1000', marker, '/bin/bash').length, 0);
        return {
            oldId,
            replacementId,
            staleExactIdRefused: true,
            replacementMarkerProcesses: 0,
            audit,
        };
    } catch (error) {
        if (opened) {
            const oldInspection = runPodman(['container', 'inspect', oldId], { ok: false });
            if (oldInspection.ok) {
                const cleanupErrors = await cleanupFailedCliSession({
                    containerId: oldId,
                    user: '1000:1000',
                    marker,
                    ...opened,
                });
                if (cleanupErrors.length > 0) {
                    error.message += `\nreplacement cleanup:\n${cleanupErrors.join('\n')}`;
                }
            }
        }
        throw error;
    } finally {
        removeAgentExact(replacementId);
        removeAgentExact(oldId);
    }
}

function readOneJsonLine(stream, prefix, timeoutMs = WAIT_MS) {
    return new Promise((resolve, reject) => {
        let output = '';
        let bytes = 0;
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stream.off('data', onData);
            stream.off('error', onError);
            stream.off('end', onEnd);
            stream.off('close', onClose);
            callback(value);
        };
        const onError = (error) => finish(reject, error);
        const onEnd = () => finish(reject, new Error(`${prefix} stream ended before a frame`));
        const onClose = () => finish(reject, new Error(`${prefix} stream closed before a frame`));
        const onData = (chunk) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > MAX_DIAGNOSTIC_BYTES) {
                finish(reject, new Error(`${prefix} exceeded ${MAX_DIAGNOSTIC_BYTES} bytes`));
                return;
            }
            output += chunk;
            const line = output.split(/\n/).find((entry) => entry.startsWith(prefix));
            if (!line) return;
            try {
                const decoded = Buffer.from(line.slice(prefix.length), 'base64url').toString('utf8');
                finish(resolve, JSON.parse(decoded));
            } catch (error) {
                finish(reject, new Error(`${prefix} contained invalid JSON: ${error.message}`));
            }
        };
        const timer = setTimeout(() => finish(
            reject,
            new Error(`${prefix} timed out: ${JSON.stringify(output.slice(-MAX_DIAGNOSTIC_BYTES))}`),
        ), timeoutMs);
        stream.setEncoding('utf8');
        stream.on('data', onData);
        stream.on('error', onError);
        stream.on('end', onEnd);
        stream.on('close', onClose);
    });
}

function captureBoundedStream(stream, label, onOverflow) {
    const state = { output: '', bytes: 0, error: null };
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        state.bytes += Buffer.byteLength(chunk);
        if (state.bytes > MAX_DIAGNOSTIC_BYTES) {
            state.error ||= new Error(`${label} exceeded ${MAX_DIAGNOSTIC_BYTES} bytes`);
            onOverflow?.(state.error);
            return;
        }
        state.output += chunk;
    });
    stream.on('error', (error) => { state.error ||= error; });
    return state;
}

async function runWorkerCrash(target, recordPath) {
    const secretCanary = `phase0-secret-${crypto.randomBytes(12).toString('hex')}`;
    const fixedEnvironment = buildAgentWorkerEnvironment({
        ...process.env,
        PHASE0_SECRET_CANARY: secretCanary,
    });
    assert.equal(Object.values(fixedEnvironment).includes(secretCanary), false);
    let worker = null;
    let workerIdentity = null;
    let workerClosed = false;
    let stderr = { output: '', bytes: 0, error: null };
    let completed = false;
    let primaryError = null;
    try {
        worker = spawn('/usr/local/bin/node', [process.argv[1], '--worker'], {
            env: {
                ...fixedEnvironment,
                PHASE0_WORKER_CONFIG: Buffer.from(JSON.stringify({
                    ...target,
                    recordPath,
                })).toString('base64url'),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        worker.once('close', () => { workerClosed = true; });
        const spawnError = new Promise((_, reject) => worker.once('error', reject));
        workerIdentity = localProcessIdentity(worker.pid);
        stderr = captureBoundedStream(worker.stderr, 'worker stderr', () => {
            if (workerIdentity && sameLocalProcess(workerIdentity)) {
                process.kill(workerIdentity.pid, 'SIGKILL');
            }
        });
        const ready = await Promise.race([
            readOneJsonLine(worker.stdout, '__PLOINKY_WORKER_READY__'),
            spawnError,
        ]);
        assert.equal(stderr.error, null, stderr.error?.message);
        assert.equal(ready.containerId, target.containerId);
        assert.equal(ready.secretCanaryAbsent, true);
        assert.deepEqual(ready.environmentKeys, [
            ...Object.keys(fixedEnvironment),
            'PHASE0_WORKER_CONFIG',
        ].sort());
        assert.equal(JSON.stringify(ready).includes(secretCanary), false);
        assert.equal(fs.existsSync(recordPath), true);
        assert.equal(fs.readFileSync(recordPath, 'utf8').includes(secretCanary), false);
        process.kill(workerIdentity.pid, 'SIGKILL');
        await waitFor(() => !sameLocalProcess(workerIdentity), 'killed worker reap');
        assert.equal(stderr.error, null, stderr.error?.message);
        assert.equal(stderr.output.includes(secretCanary), false);
        const recovery = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        assert.equal(recovery.containerId, target.containerId);
        assert.equal(recovery.marker, target.marker);
        assert.equal(inspectContainer(recovery.containerId).Id, recovery.containerId);
        let autoReclaimed = false;
        try {
        await waitFor(() => markerProcesses(
            target.containerId,
            target.user,
            target.marker,
            recovery.shellPath,
        ).length === 0,
                'worker-crash automatic reclamation', 1_500);
            autoReclaimed = true;
        } catch (_) {
            reclaimBoxSession(
                target.containerId,
                target.user,
                target.marker,
                recovery.inner,
                recovery.boxInner,
                recovery.shellPath,
            );
        }
        const audit = await auditClosedSession({ ...target, ...recovery });
        await waitFor(() => !sameLocalProcess(recovery.boxClient),
            'worker-crash Box Podman client reap');
        fs.unlinkSync(recordPath);
        assert.equal(fs.existsSync(recordPath), false);
        const recoveredSession = await runNormalCliSession({
            ...target,
            marker: `${target.marker}-recovered`,
        });
        completed = true;
        return {
            workerIdentity,
            recovery,
            environmentKeys: ready.environmentKeys,
            secretCanaryExcluded: true,
            autoReclaimed,
            exactRecovery: !autoReclaimed,
            audit,
            nextWorkerSession: recoveredSession.audit,
            recoveryRecordRemovedAfterProof: true,
        };
    } catch (error) {
        primaryError = error;
        throw error;
    } finally {
        if (!completed) {
            const cleanupErrors = [];
            try {
                if (workerIdentity && sameLocalProcess(workerIdentity)) {
                    process.kill(workerIdentity.pid, 'SIGKILL');
                }
                if (workerIdentity) {
                    await waitFor(() => !sameLocalProcess(workerIdentity), 'failed worker reap');
                } else if (worker) {
                    if (!workerClosed) worker.kill('SIGKILL');
                    await waitFor(() => workerClosed,
                        'unidentified failed worker reap');
                }
            } catch (error) {
                cleanupErrors.push(`worker: ${error.message}`);
            }
            try {
                const markers = boxMarkerProcesses(target.containerId, target.user, target.marker);
                if (markers.length > 0) {
                    const leaders = markers.filter((identity) => (
                        identity.nspid.at(-1) === identity.nspgid.at(-1)
                        && identity.nspid.at(-1) === identity.nssid.at(-1)
                    ));
                    assert.equal(leaders.length, 1,
                        'one marker-bearing worker session leader must anchor cleanup');
                    const [boxInner] = leaders;
                    reclaimBoxSession(target.containerId, target.user, target.marker, {
                        pid: boxInner.nspid.at(-1),
                        pgrp: boxInner.nspgid.at(-1),
                        session: boxInner.nssid.at(-1),
                    }, boxInner);
                }
                await waitFor(() => boxMarkerProcesses(target.containerId, target.user, target.marker).length === 0,
                    'failed worker marker reclamation');
                const execIds = currentExecIds(target.containerId);
                assert.ok(execIds.length <= 1, 'failed worker found unrelated exec records');
                if (execIds.length === 1) drainExactExecRecord(target.containerId, execIds[0]);
            } catch (error) {
                cleanupErrors.push(`session: ${error.message}`);
            }
            try {
                if (fs.existsSync(recordPath)) fs.unlinkSync(recordPath);
            } catch (error) {
                cleanupErrors.push(`record: ${error.message}`);
            }
            if (stderr.error) cleanupErrors.push(`stderr: ${stderr.error.message}`);
            if (stderr.output) cleanupErrors.push(`bounded worker stderr: ${JSON.stringify(stderr.output)}`);
            if (cleanupErrors.length > 0) {
                const detail = `worker-crash failure cleanup:\n${cleanupErrors.join('\n')}`;
                if (primaryError) primaryError.message += `\n${detail}`;
                else throw new Error(detail);
            }
        }
    }
}

function request({ socketPath, method, requestPath, body = null }) {
    return new Promise((resolve, reject) => {
        const payload = body === null ? '' : JSON.stringify(body);
        let settled = false;
        let timer = null;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            callback(value);
        };
        const req = http.request({
            socketPath,
            method,
            path: requestPath,
            headers: {
                ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
            },
        }, (res) => {
            let data = '';
            let bytes = 0;
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                bytes += Buffer.byteLength(chunk);
                if (bytes > MAX_HTTP_RESPONSE_BYTES) {
                    const error = new Error(`response exceeded ${MAX_HTTP_RESPONSE_BYTES} bytes`);
                    req.destroy(error);
                    finish(reject, error);
                    return;
                }
                data += chunk;
            });
            res.on('aborted', () => finish(reject, new Error(`${method} ${requestPath} aborted`)));
            res.on('error', (error) => finish(reject, error));
            res.on('end', () => finish(resolve, { status: res.statusCode, body: data }));
        });
        timer = setTimeout(() => {
            const error = new Error(`${method} ${requestPath} exceeded wall-clock deadline`);
            req.destroy(error);
            finish(reject, error);
        }, WAIT_MS);
        req.on('error', (error) => finish(reject, error));
        if (payload) req.write(payload);
        req.end();
    });
}

function requestUpgrade({ socketPath, requestPath, body }) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        let settled = false;
        let timer = null;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            callback(value);
        };
        const req = http.request({
            socketPath,
            method: 'POST',
            path: requestPath,
            headers: {
                connection: 'Upgrade',
                upgrade: 'tcp',
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
            },
        });
        req.on('upgrade', (res, socket, head) => (
            finish(resolve, { status: res.statusCode, socket, head })
        ));
        req.on('response', (res) => {
            let data = '';
            let bytes = 0;
            res.on('data', (chunk) => {
                bytes += Buffer.byteLength(chunk);
                if (bytes > MAX_HTTP_RESPONSE_BYTES) {
                    const error = new Error(`upgrade response exceeded ${MAX_HTTP_RESPONSE_BYTES} bytes`);
                    req.destroy(error);
                    finish(reject, error);
                    return;
                }
                data += chunk;
            });
            res.on('aborted', () => finish(reject, new Error(`upgrade ${requestPath} aborted`)));
            res.on('error', (error) => finish(reject, error));
            res.on('end', () => finish(
                reject,
                new Error(`exec start returned ${res.statusCode}: ${data}`),
            ));
        });
        timer = setTimeout(() => {
            const error = new Error(`upgrade ${requestPath} exceeded wall-clock deadline`);
            req.destroy(error);
            finish(reject, error);
        }, WAIT_MS);
        req.on('error', (error) => finish(reject, error));
        req.end(payload);
    });
}

async function runRestCandidate({ containerId, user, marker, runId }) {
    const directory = `/tmp/phase0-rest-${runId}`;
    const socketPath = path.join(directory, 'podman.sock');
    let service = null;
    let serviceIdentity = null;
    let serviceClosed = false;
    let serviceError = null;
    let attachedSocket = null;
    let execId = '';
    let inner = null;
    let boxInner = null;
    let primaryError = null;
    let directoryCreated = false;
    let admissionEvidence = null;
    try {
        fs.mkdirSync(directory, { mode: 0o700 });
        directoryCreated = true;
        service = spawn(PODMAN, ['system', 'service', '--time=0', `unix://${socketPath}`], {
            stdio: 'ignore',
            env: process.env,
            detached: true,
        });
        service.once('error', (error) => { serviceError = error; });
        service.once('close', () => { serviceClosed = true; });
        serviceIdentity = localProcessIdentity(service.pid);
        await waitFor(() => {
            if (serviceError) throw serviceError;
            return fs.existsSync(socketPath);
        }, 'Podman REST socket');
        assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
        assert.equal(fs.statSync(socketPath).mode & 0o077, 0);
        const ping = await request({ socketPath, method: 'GET', requestPath: '/_ping' });
        assert.equal(ping.status, 200);
        const version = await request({ socketPath, method: 'GET', requestPath: '/version' });
        assert.equal(version.status, 200);
        const created = await request({
            socketPath,
            method: 'POST',
            requestPath: `/v5.0.0/containers/${containerId}/exec`,
            body: {
                AttachStdin: true,
                AttachStdout: true,
                AttachStderr: true,
                Cmd: fixedAgentShellWrapperArgv(marker, '/bin/bash'),
                Env: [
                    `PLOINKY_WEBTTY_MARKER=${marker}`,
                    'TERM=xterm-256color',
                    `PS1=${WEBTTY_SHELL_PROMPT}`,
                ],
                Privileged: false,
                Tty: true,
                User: user,
                WorkingDir: '/tmp',
            },
        });
        assert.equal(created.status, 201, created.body);
        execId = JSON.parse(created.body).Id;
        assert.match(execId, /^[a-f0-9]{64}$/);
        const attached = await requestUpgrade({
            socketPath,
            requestPath: `/v5.0.0/exec/${execId}/start`,
            body: { Detach: false, Tty: true },
        });
        assert.equal(attached.status, 101);
        attachedSocket = attached.socket;
        let output = attached.head.toString('utf8');
        let outputBytes = Buffer.byteLength(attached.head);
        let outputError = null;
        let socketClosed = false;
        attached.socket.setEncoding('utf8');
        attached.socket.on('data', (chunk) => {
            outputBytes += Buffer.byteLength(chunk);
            if (outputBytes > MAX_OUTPUT_BYTES) {
                outputError ||= new Error('REST terminal output exceeded bound');
                attached.socket.destroy(outputError);
                return;
            }
            output += chunk;
        });
        attached.socket.on('error', (error) => { outputError ||= error; });
        attached.socket.on('close', () => { socketClosed = true; });
        const inspected = async (apiPath = '') => {
            const response = await request({
                socketPath,
                method: 'GET',
                requestPath: `/v5.0.0/${apiPath}exec/${execId}/json`,
            });
            assert.equal(response.status, 200, response.body);
            return JSON.parse(response.body);
        };
        const runningExec = await waitFor(async () => {
            const value = await inspected();
            assert.equal(value?.Running, true, JSON.stringify(value));
            assert.ok(Number.isInteger(value.Pid) && value.Pid > 0, JSON.stringify(value));
            return value;
        }, 'REST exact running exec identity');
        assert.equal(runningExec.ID ?? runningExec.Id, execId);
        assert.equal(runningExec.ContainerID, containerId);
        const nativeRunningExec = await inspected('libpod/');
        assert.equal(nativeRunningExec.ID ?? nativeRunningExec.Id, execId);
        assert.equal(nativeRunningExec.ContainerID, containerId);
        assert.equal(nativeRunningExec.Running, true);
        assert.equal(nativeRunningExec.Pid, runningExec.Pid);
        // Create this capability only after the exact exec is created and its
        // 101 Upgrade is attached. It was never present in Cmd or Env.
        const readinessChallenge = crypto.randomBytes(32).toString('base64url');
        assert.match(readinessChallenge, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(fixedAgentShellWrapperArgv(marker, '/bin/bash').some(
            (value) => value.includes(readinessChallenge),
        ), false);
        const readyPrefix = `__PLOINKY_REST_READY__${marker}|${readinessChallenge}|`;
        const readyPattern = new RegExp(
            `${escapeRegExp(readyPrefix)}(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)`,
        );
        attached.socket.write(readinessCommands({
            readyPrefix,
            ioPrefix: `__PLOINKY_REST_IO__${marker}|`,
            inputVariable: 'value',
        }).join('; ') + '\r');
        const readyMatch = await waitForOutputMatch(() => {
            if (outputError) throw outputError;
            if (socketClosed) throw new Error('REST terminal stream closed before readiness');
            return output;
        }, readyPattern,
            'REST attached terminal numeric readiness');
        inner = {
            pid: Number(readyMatch[1]),
            pgrp: Number(readyMatch[2]),
            session: Number(readyMatch[3]),
            uid: Number(readyMatch[4]),
            startToken: `linux-proc:${readyMatch[5]}`,
        };
        const forgedMatch = await waitForOutputMatch(
            () => output,
            new RegExp(
                `__PLOINKY_REST_READY__${escapeRegExp(marker)}\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)`,
            ),
            'REST hostile startup readiness frame',
        );
        assert.deepEqual(forgedMatch.slice(1), readyMatch.slice(1),
            'the REST challenge-less startup frame must otherwise carry the exact admitted shell identity');
        const activeMarkerProcesses = markerProcesses(containerId, user, marker, '/bin/bash');
        const activeBoxMarkers = boxMarkerProcesses(containerId, user, marker);
        const readyShells = boxReadyShellProcesses(containerId, inner, '/bin/bash');
        const markerDiagnostic = JSON.stringify({
            marker,
            inner,
            activeMarkerProcesses,
            activeBoxMarkers,
            readyShells,
        });
        assert.equal(activeMarkerProcesses.length, 1, markerDiagnostic);
        assert.ok(activeMarkerProcesses.every((entry) => entry.session === inner.session), markerDiagnostic);
        assert.equal(activeBoxMarkers.length, 1, markerDiagnostic);
        assert.equal(readyShells.length, 1, markerDiagnostic);
        [boxInner] = activeBoxMarkers;
        const [readyShell] = readyShells;
        assert.equal(boxInner.nssid.at(-1), inner.session, markerDiagnostic);
        assert.equal(boxInner.innerUid, inner.uid, markerDiagnostic);
        assert.equal(readyShell.parentPid, boxInner.pid, markerDiagnostic);
        assert.equal(readyShell.nspid.at(-1), inner.pid, markerDiagnostic);
        assert.equal(readyShell.nspgid.at(-1), inner.pgrp, markerDiagnostic);
        assert.equal(readyShell.nssid.at(-1), inner.session, markerDiagnostic);
        assert.equal(readyShell.innerUid, inner.uid, markerDiagnostic);
        assert.equal(readyShell.startToken, inner.startToken, markerDiagnostic);
        assert.equal(activeMarkerProcesses[0].pid, boxInner.nspid.at(-1), markerDiagnostic);
        assert.equal(activeMarkerProcesses[0].startToken, boxInner.startToken, markerDiagnostic);
        await waitFor(() => {
            const execIds = currentExecIds(containerId);
            return execIds.length === 1 && execIds[0] === execId;
        }, 'REST exact exec identity after readiness');
        attached.socket.write(`rest-input-${marker}\r`);
        await waitForOutputMatch(() => {
            if (outputError) throw outputError;
            return output;
        }, new RegExp(escapeRegExp(`__PLOINKY_REST_IO__${marker}|rest-input-${marker}`)),
            'REST explicit application input round trip');
        const resized = await request({
            socketPath,
            method: 'POST',
            requestPath: `/v5.0.0/libpod/exec/${execId}/resize?h=29&w=97`,
        });
        assert.ok([200, 201].includes(resized.status), resized.body);
        attached.socket.write([
            'phase0_resize_attempt=0',
            'while phase0_size=$(stty size); test "$phase0_size" != "29 97"; do phase0_resize_attempt=$((phase0_resize_attempt + 1))',
            'test "$phase0_resize_attempt" -lt 200 || break',
            'read -r -t 0.05 -n 0 phase0_resize_pause || true',
            'done',
            `printf '__PLOINKY_REST_SIZE__${marker}|%s\\n' "$phase0_size"`,
        ].join('; ') + '\r');
        await waitForOutputMatch(() => {
            if (outputError) throw outputError;
            return output;
        }, new RegExp(escapeRegExp(`__PLOINKY_REST_SIZE__${marker}|29 97`)), 'REST resize');
        const liveBeforeRemoval = await inspected('libpod/');
        assert.equal(liveBeforeRemoval.ID ?? liveBeforeRemoval.Id, execId);
        assert.equal(liveBeforeRemoval.ContainerID, containerId);
        assert.equal(liveBeforeRemoval.Running, true);
        admissionEvidence = {
            serviceIdentity,
            socketMode: fs.statSync(socketPath).mode & 0o777,
            apiVersion: JSON.parse(version.body).ApiVersion,
            execId,
            inner,
            boxInner,
            liveExecProven: true,
            postAttachReadinessChallenge: true,
            hostileStartupFrameRejected: true,
            io: true,
            dimensions: [97, 29],
        };
        attached.socket.destroy();
        await waitFor(() => socketClosed,
            'REST attach stream close before exact removal');
        attachedSocket = null;
        const afterDisconnect = await request({
            socketPath,
            method: 'GET',
            requestPath: `/v5.0.0/libpod/exec/${execId}/json`,
        });
        let removed;
        let disconnectedExec = null;
        try {
            if (afterDisconnect.status === 404) {
                removed = afterDisconnect;
            } else {
                assert.equal(afterDisconnect.status, 200, afterDisconnect.body);
                disconnectedExec = JSON.parse(afterDisconnect.body);
                assert.equal(disconnectedExec.ID ?? disconnectedExec.Id, execId);
                assert.equal(disconnectedExec.ContainerID, containerId);
                assert.equal(typeof disconnectedExec.Running, 'boolean');
                admissionEvidence.afterAttachClose = {
                    inspectStatus: afterDisconnect.status,
                    running: disconnectedExec.Running,
                };
                removed = await request({
                    socketPath,
                    method: 'POST',
                    requestPath: `/v5.0.0/libpod/exec/${execId}/remove`,
                    body: { Force: true },
                });
                assert.equal(removed.status, 200, removed.body);
            }
            if (afterDisconnect.status === 404) {
                admissionEvidence.afterAttachClose = {
                    inspectStatus: afterDisconnect.status,
                    running: false,
                };
            }
        } catch (cause) {
            const rejection = new Error(
                `REST socket-first exact-exec removal failed after I/O and resize proof: ${cause.message}`,
                { cause },
            );
            rejection.code = 'PHASE0_REST_LIVE_EXEC_REMOVAL_REJECTED';
            rejection.phase0Evidence = admissionEvidence;
            throw rejection;
        }
        await waitFor(() => boxMarkerProcesses(containerId, user, marker).length === 0,
            'REST Box marker reclamation');
        await waitFor(() => boxSessionProcesses(boxInner, inner.session).length === 0,
            'REST Box-visible exact session reclamation');
        await waitFor(() => markerProcesses(containerId, user, marker, '/bin/bash').length === 0,
            'REST target-side marker reclamation');
        await waitFor(() => currentExecIds(containerId).length === 0, 'REST exec drainage');
        const absent = await request({
            socketPath,
            method: 'GET',
            requestPath: `/v5.0.0/libpod/exec/${execId}/json`,
        });
        assert.equal(absent.status, 404, absent.body);
        assert.equal(inspectContainer(containerId).State.Running, true,
            'exact exec removal must not stop the target container');
        return {
            viabilityProbePassed: true,
            fullPhase0Admission: false,
            ...admissionEvidence,
            attachSocketClosedBeforeRemoval: true,
            terminatedByAttachClose: afterDisconnect.status === 404
                || disconnectedExec?.Running === false,
            terminatedByExactRemove: disconnectedExec?.Running === true && removed.status === 200,
            removedWhileRunning: disconnectedExec?.Running === true,
            exactExecRemovalStatus: removed.status,
            exactExecAbsentStatus: absent.status,
            audit: { markerProcesses: 0, boxMarkerProcesses: 0, execIds: 0 },
        };
    } catch (error) {
        primaryError = error;
        throw error;
    } finally {
        const cleanupErrors = [];
        if (attachedSocket && !attachedSocket.destroyed) attachedSocket.destroy();
        try {
            if (!boxInner) {
                const markers = boxMarkerProcesses(containerId, user, marker);
                if (markers.length > 0) {
                    const leaders = markers.filter((identity) => (
                        identity.nspid.at(-1) === identity.nspgid.at(-1)
                        && identity.nspid.at(-1) === identity.nssid.at(-1)
                    ));
                    assert.equal(leaders.length, 1,
                        'one marker-bearing REST session leader must anchor cleanup');
                    [boxInner] = leaders;
                    inner = {
                        pid: boxInner.nspid.at(-1),
                        pgrp: boxInner.nspgid.at(-1),
                        session: boxInner.nssid.at(-1),
                        uid: boxInner.innerUid,
                    };
                }
            }
            if (boxInner && boxMarkerProcesses(containerId, user, marker).length > 0) {
                reclaimBoxSession(containerId, user, marker, inner, boxInner);
            }
        } catch (error) {
            cleanupErrors.push(`Box session: ${error.message}`);
        }
        try {
            if (execId && currentExecIds(containerId).includes(execId)) {
                const forced = await request({
                    socketPath,
                    method: 'POST',
                    requestPath: `/v5.0.0/libpod/exec/${execId}/remove`,
                    body: { Force: true },
                });
                assert.ok([200, 404].includes(forced.status), forced.body);
            }
        } catch (error) {
            cleanupErrors.push(`exec removal: ${error.message}`);
        }
        try {
            await waitFor(() => boxMarkerProcesses(containerId, user, marker).length === 0,
                'REST final Box marker reclamation');
            if (boxInner && inner) {
                await waitFor(() => boxSessionProcesses(boxInner, inner.session).length === 0,
                    'REST final Box session reclamation');
            }
            await waitFor(() => markerProcesses(containerId, user, marker, '/bin/bash').length === 0,
                'REST final target marker reclamation');
            await waitFor(() => currentExecIds(containerId).length === 0,
                'REST final exec drainage');
        } catch (error) {
            cleanupErrors.push(`orphan audit: ${error.message}`);
        }
        try {
            if (serviceIdentity) {
                await terminateLocalProcessGroup(serviceIdentity);
            } else if (service) {
                if (!serviceClosed) service.kill('SIGKILL');
                await waitFor(() => serviceClosed, 'unidentified REST service reap');
            }
        } catch (error) {
            cleanupErrors.push(`service reap: ${error.message}`);
        }
        try {
            if (directoryCreated && fs.existsSync(directory)) {
                fs.rmSync(directory, { recursive: true, force: false });
            }
        } catch (error) {
            cleanupErrors.push(`socket root removal: ${error.message}`);
        }
        if (cleanupErrors.length > 0) {
            const detail = `REST cleanup failed:\n${cleanupErrors.join('\n')}`;
            if (primaryError) primaryError.message += `\n${detail}`;
            else throw new Error(detail);
        } else if (primaryError) {
            primaryError.cleanupProven = true;
            primaryError.cleanupAudit = {
                markerProcesses: 0,
                boxMarkerProcesses: 0,
                execIds: 0,
            };
        }
    }
}

async function probeRestCandidate(options) {
    try {
        return await runRestCandidate(options);
    } catch (error) {
        if (error.code !== 'PHASE0_REST_LIVE_EXEC_REMOVAL_REJECTED'
            || error.cleanupProven !== true
            || !error.phase0Evidence) {
            throw error;
        }
        return {
            viabilityProbePassed: false,
            fullPhase0Admission: false,
            ...error.phase0Evidence,
            removedWhileRunning: false,
            exactExecRemovalStatus: null,
            rejection: {
                code: error.code,
                reason: error.message,
            },
            cleanupProven: true,
            audit: error.cleanupAudit,
        };
    }
}

function inventory(containerImage) {
    runPodman(['image', 'pull', containerImage], { timeout: 10 * 60_000 });
    const images = podmanJson(['image', 'inspect', containerImage]);
    assert.equal(images.length, 1);
    const image = images[0];
    assert.match(image.Id, /^[a-f0-9]{64}$/);
    const expectedDigest = containerImage.slice(containerImage.indexOf('@') + 1);
    assert.match(expectedDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(image.Digest, expectedDigest);
    const podmanVersion = podmanJson(['version', '--format', 'json']);
    const podmanInfo = podmanJson(['info', '--format', 'json']);
    const generalHelp = runPodman(['help']).stdout;
    const execHelp = runPodman(['container', 'exec', '--help']).stdout;
    const cleanupHelp = runPodman(['container', 'cleanup', '--help']).stdout;
    const serviceHelp = runPodman(['system', 'service', '--help']).stdout;
    assert.match(generalHelp, /manage pods, containers and images/i);
    for (const option of ['--env', '--interactive', '--tty', '--user', '--workdir', '--no-session']) {
        assert.match(execHelp, new RegExp(escapeRegExp(option)));
    }
    assert.match(cleanupHelp, /--exec/);
    assert.match(serviceHelp, /--time/);
    return {
        podmanVersion,
        rootless: podmanInfo.host?.security?.rootless ?? podmanInfo.Host?.Security?.Rootless,
        graphRoot: podmanInfo.store?.graphRoot ?? podmanInfo.Store?.GraphRoot,
        runRoot: podmanInfo.store?.runRoot ?? podmanInfo.Store?.RunRoot,
        imageId: image.Id,
        imageDigest: image.Digest,
        repoDigests: image.RepoDigests || [],
        configuredUser: image.Config?.User || '',
        helpInventory: {
            general: true,
            execOptions: ['--env', '--interactive', '--tty', '--user', '--workdir', '--no-session'],
            exactExecCleanup: true,
            restService: true,
        },
    };
}

async function runWorkerMode() {
    const expectedEnvironmentKeys = [
        ...Object.keys(buildAgentWorkerEnvironment()),
        'PHASE0_WORKER_CONFIG',
    ].sort();
    assert.deepEqual(Object.keys(process.env).sort(), expectedEnvironmentKeys);
    assert.equal(process.env.PHASE0_SECRET_CANARY, undefined);
    const config = JSON.parse(Buffer.from(process.env.PHASE0_WORKER_CONFIG, 'base64url').toString('utf8'));
    assert.match(config.cliExecMode, /^(?:persistent-session|no-session)$/);
    cliExecMode = config.cliExecMode;
    const opened = await openCliSession(config);
    const recovery = {
        schema: 'ploinky-webtty-agent-phase0-recovery/v1',
        containerId: config.containerId,
        user: config.user,
        marker: config.marker,
        execId: opened.execId,
        inner: opened.inner,
        boxClient: opened.cliIdentity,
        boxInner: opened.boxInner,
    };
    fs.writeFileSync(config.recordPath, `${JSON.stringify(recovery)}\n`, { flag: 'wx', mode: 0o600 });
    const ready = {
        ...recovery,
        environmentKeys: expectedEnvironmentKeys,
        secretCanaryAbsent: true,
    };
    process.stdout.write(`__PLOINKY_WORKER_READY__${Buffer.from(JSON.stringify(ready)).toString('base64url')}\n`);
    setInterval(() => {}, 60_000);
}

async function runMatrix(config) {
    assert.match(config.cliExecMode, /^(?:persistent-session|no-session)$/);
    cliExecMode = config.cliExecMode;
    const runId = `wtty-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
    const runtime = inventory(config.agentImage);
    process.stderr.write(`phase0-inventory:${JSON.stringify(runtime)}\n`);
    assert.equal(runtime.rootless, true);
    assert.match(runtime.configuredUser, /^(?:1000(?::1000)?|node)$/);
    const rootName = `phase0-root-${runId}`;
    const nonRootName = `phase0-user-${runId}`;
    const shellName = `phase0-shell-${runId}`;
    let rootId = '';
    let nonRootId = '';
    let shellId = '';
    const owned = [];
    const audits = [];
    let primaryError = null;
    let stage = 'create-root-agent';
    try {
        rootId = createAgent({ imageId: runtime.imageId, name: rootName, root: true, runId });
        owned.push(rootId);
        stage = 'create-non-root-agent';
        nonRootId = createAgent({ imageId: runtime.imageId, name: nonRootName, root: false, runId });
        owned.push(nonRootId);
        stage = 'create-shell-selection-agent';
        shellId = createAgent({ imageId: runtime.imageId, name: shellName, root: true, runId });
        owned.push(shellId);
        stage = 'symlink-bind-inspection';
        process.stderr.write(`phase0-stage:${stage}\n`);
        const symlinkBind = runSymlinkBindInspection(runtime.imageId, runId);
        stage = config.firstCandidate === 'cli' ? 'root-normal' : 'rest-candidate';
        let rest = null;
        if (config.firstCandidate !== 'cli') {
            process.stderr.write(`phase0-stage:${stage}\n`);
            rest = await probeRestCandidate({
                containerId: nonRootId,
                user: '1000:1000',
                marker: `phase0-${runId}-rest`,
                runId,
            });
            audits.push(rest.audit);
            process.stderr.write(`phase0-rest-candidate-result:${JSON.stringify(rest)}\n`);
            stage = 'root-normal';
        }
        process.stderr.write(`phase0-stage:${stage}\n`);
        const root = await runNormalCliSession({
            containerId: rootId,
            user: '0:0',
            marker: `phase0-${runId}-root-normal`,
        });
        audits.push(root.audit);
        assert.equal(root.uid, 0);
        stage = 'root-controlled-close';
        process.stderr.write(`phase0-stage:${stage}\n`);
        const rootClose = await runControlledClose({
            containerId: rootId,
            user: '0:0',
            marker: `phase0-${runId}-root-close`,
        });
        audits.push(rootClose.audit);
        stage = 'non-root-normal';
        process.stderr.write(`phase0-stage:${stage}\n`);
        const nonRoot = await runNormalCliSession({
            containerId: nonRootId,
            user: '1000:1000',
            marker: `phase0-${runId}-user-normal`,
        });
        audits.push(nonRoot.audit);
        assert.equal(nonRoot.uid, 1000);
        let shellSelection = null;
        if (cliExecMode === 'persistent-session') {
            stage = 'shell-selection';
            process.stderr.write(`phase0-stage:${stage}\n`);
            shellSelection = await runShellSelectionMatrix({
                containerId: shellId,
                user: '0:0',
                markerPrefix: `phase0-${runId}-shell`,
                runId,
            });
            audits.push(
                shellSelection.bashAbsence.audit,
                shellSelection.fallback.audit,
                shellSelection.bothMissing.bash.audit,
                shellSelection.bothMissing.sh.audit,
            );
        }
        stage = 'non-root-controlled-close';
        process.stderr.write(`phase0-stage:${stage}\n`);
        const nonRootClose = await runControlledClose({
            containerId: nonRootId,
            user: '1000:1000',
            marker: `phase0-${runId}-user-close`,
        });
        audits.push(nonRootClose.audit);
        stage = 'box-client-loss';
        process.stderr.write(`phase0-stage:${stage}\n`);
        const clientLoss = await runClientLoss({
            containerId: nonRootId,
            user: '1000:1000',
            marker: `phase0-${runId}-client-loss`,
        });
        audits.push(clientLoss.audit);
        stage = 'foreground-child-client-loss';
        process.stderr.write(`phase0-stage:${stage}\n`);
        const foreground = await runClientLoss({
            containerId: rootId,
            user: '0:0',
            marker: `phase0-${runId}-foreground`,
        }, { foreground: true });
        audits.push(foreground.audit);
        stage = 'target-stop-remove';
        process.stderr.write(`phase0-stage:${stage}\n`);
        const stopRemove = await runStopRemove(runtime.imageId, runId);
        audits.push(stopRemove.audit);
        stage = 'same-name-replacement';
        process.stderr.write(`phase0-stage:${stage}\n`);
        const sameName = await runSameNameReplacement(runtime.imageId, runId);
        audits.push(sameName.audit);
        const recordPath = `/workspace/.phase0-webtty-recovery-${runId}.json`;
        stage = 'worker-crash-recovery';
        process.stderr.write(`phase0-stage:${stage}\n`);
        const workerCrash = await runWorkerCrash({
            containerId: nonRootId,
            user: '1000:1000',
            marker: `phase0-${runId}-worker-crash`,
            cliExecMode,
        }, recordPath);
        audits.push(workerCrash.audit, workerCrash.nextWorkerSession);
        if (!rest) {
            stage = 'rest-candidate';
            process.stderr.write(`phase0-stage:${stage}\n`);
            rest = await probeRestCandidate({
                containerId: nonRootId,
                user: '1000:1000',
                marker: `phase0-${runId}-rest`,
                runId,
            });
            audits.push(rest.audit);
            process.stderr.write(`phase0-rest-candidate-result:${JSON.stringify(rest)}\n`);
        }
        assert.ok(audits.every((entry) => entry.markerProcesses === 0 && entry.execIds === 0));
        stage = 'backend-selection';
        if (cliExecMode !== 'persistent-session') {
            throw Object.assign(
                new Error('the no-session CLI mode unexpectedly passed and requires an explicit backend decision'),
                { code: 'PHASE0_NO_SESSION_UNEXPECTEDLY_PASSED' },
            );
        }
        return {
            schema: 'ploinky-webtty-agent-phase0/v1',
            runId,
            harnessSources: {
                driver: sourceDigest(new URL(import.meta.url)),
                readiness: sourceDigest(new URL('./webttyAgentPtyReadiness.mjs', import.meta.url)),
                agentRuntime: sourceDigest(new URL('../../cli/server/webtty/agentRuntime.mjs', import.meta.url)),
            },
            box: {
                uid: process.getuid(),
                gid: process.getgid(),
                node: process.version,
                nodePty: require('/usr/local/lib/ploinky/webtty/node_modules/node-pty/package.json').version,
                podmanSocket: '/run/user/1000/podman/podman.sock',
            },
            runtime,
            symlinkBind,
            agents: {
                root: { containerId: rootId, configuredUser: '0:0' },
                nonRoot: { containerId: nonRootId, configuredUser: runtime.configuredUser },
            },
            cliNodePty: {
                execMode: cliExecMode,
                root,
                rootClose,
                nonRoot,
                nonRootClose,
                clientLoss,
                foreground,
                stopRemove,
                sameName,
                workerCrash,
                shellSelection,
            },
            rest,
            selectedBackend: 'controlled-podman-exec-persistent-session-under-box-node-pty',
            selectionReason: rest.viabilityProbePassed
                ? 'Persistent-session CLI passed the full identity, resize, lifecycle, replacement, crash, and reclamation matrix; the limited REST viability probe passed but was not run through the full admission matrix'
                : 'Persistent-session CLI passed the full identity, resize, lifecycle, replacement, crash, and reclamation matrix; REST was rejected because socket-first exact exec removal exceeded its bounded deadline',
            orphanAudits: audits,
        };
    } catch (error) {
        primaryError = error;
        error.message = `phase0 stage ${stage} failed: ${error.message}`;
        throw error;
    } finally {
        const cleanupErrors = [];
        for (const id of owned.reverse()) {
            try {
                removeAgentExact(id);
            } catch (error) {
                cleanupErrors.push(`${id}: ${error.message}`);
            }
        }
        try {
            const remaining = podmanJson([
                'container', 'list', '--all',
                '--filter', `label=io.assistos.ploinky.phase0=${runId}`,
                '--format', 'json',
            ]);
            assert.deepEqual(remaining, []);
        } catch (error) {
            cleanupErrors.push(`label audit: ${error.message}`);
        }
        if (cleanupErrors.length > 0) {
            const detail = `Phase 0 cleanup failed:\n${cleanupErrors.join('\n')}`;
            if (primaryError) primaryError.message += `\n${detail}`;
            else throw new Error(detail);
        }
    }
}

async function main() {
    if (process.argv[2] === '--worker') {
        await runWorkerMode();
        return;
    }
    const encoded = process.argv[2] || '';
    const config = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const result = await runMatrix(config);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invoked) {
    main().catch((error) => {
        process.stderr.write(`${error.stack || error}\n`);
        process.exitCode = 1;
    });
}

export { runMatrix };
