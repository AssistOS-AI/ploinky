import fs from 'node:fs/promises';
import path from 'node:path';

import {
    fixedAgentInteractiveShellArgv,
    fixedAgentShellWrapperArgv,
} from './agentRuntime.mjs';

const MAX_PROC_TEXT_BYTES = 64 * 1024;
const MAX_PROC_SCAN_ENTRIES = 8_192;
const PROC_SCAN_TIMEOUT_MS = 1_000;
const AGENT_MARKER = /^[A-Za-z0-9_-]{24,128}$/;
export const AGENT_PROCESS_SIGNALS = Object.freeze(['SIGTERM', 'SIGKILL']);
const TARGET_LOCAL_EVIDENCE_CATEGORIES = new Set([
    'inner-process-ambiguity',
    'inner-topology',
    'marker-correlation',
    'session-anchor-missing',
]);

export function isAgentTargetLocalEvidenceFailure(error) {
    return error?.code === 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE'
        || (error?.code === 'WEBTTY_AGENT_PROCESS_IDENTITY_UNPROVEN'
            && TARGET_LOCAL_EVIDENCE_CATEGORIES.has(error?.category));
}

export function agentProcessIdentityError(category, { stale = false } = {}) {
    const error = new Error(`WebTTY agent process identity is ${stale ? 'stale' : 'unproven'}: ${category}`);
    error.code = stale
        ? 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE'
        : 'WEBTTY_AGENT_PROCESS_IDENTITY_UNPROVEN';
    error.category = category;
    return error;
}

function positiveInteger(value, category) {
    if (!Number.isSafeInteger(value) || value <= 1) throw agentProcessIdentityError(category);
    return value;
}

function boundedText(value, category) {
    if (typeof value !== 'string' || value.length === 0
        || Buffer.byteLength(value) > MAX_PROC_TEXT_BYTES) {
        throw agentProcessIdentityError(category);
    }
    return value;
}

async function boundedProcFile(fsApi, filePath, { encoding = null, category }) {
    let value;
    if (typeof fsApi.open === 'function') {
        const handle = await fsApi.open(filePath, 'r');
        try {
            const buffer = Buffer.alloc(MAX_PROC_TEXT_BYTES + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > MAX_PROC_TEXT_BYTES) throw agentProcessIdentityError(category);
            value = buffer.subarray(0, bytesRead);
        } finally {
            await handle.close();
        }
    } else {
        value = await fsApi.readFile(filePath);
        if (!Buffer.isBuffer(value)) value = Buffer.from(value);
        if (value.length > MAX_PROC_TEXT_BYTES) throw agentProcessIdentityError(category);
    }
    return encoding ? value.toString(encoding) : value;
}

export function parseAgentLinuxProcStat(raw, expectedPid) {
    positiveInteger(expectedPid, 'pid');
    boundedText(raw, 'proc-stat');
    const open = raw.indexOf('(');
    const close = raw.lastIndexOf(')');
    if (open <= 0 || close <= open || Number(raw.slice(0, open).trim()) !== expectedPid) {
        throw agentProcessIdentityError('proc-stat');
    }
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    if (fields.length < 20 || !/^[A-Z]$/.test(fields[0] || '')) {
        throw agentProcessIdentityError('proc-stat');
    }
    const integerAt = (index, category) => {
        const value = Number(fields[index]);
        if (!Number.isSafeInteger(value)) throw agentProcessIdentityError(category);
        return value;
    };
    if (!/^[1-9][0-9]*$/.test(fields[19] || '')) {
        throw agentProcessIdentityError('start-token');
    }
    return Object.freeze({
        pid: expectedPid,
        state: fields[0],
        parentPid: integerAt(1, 'parent-pid'),
        processGroupId: integerAt(2, 'process-group'),
        sessionId: integerAt(3, 'session'),
        startToken: `linux-proc:${fields[19]}`,
    });
}

function parseStatusVector(status, key) {
    boundedText(status, 'proc-status');
    const line = status.split('\n').find((entry) => entry.startsWith(`${key}:`));
    if (!line) throw agentProcessIdentityError(`status-${key.toLowerCase()}`);
    const values = line.slice(key.length + 1).trim().split(/\s+/).map(Number);
    if (values.length === 0 || values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
        throw agentProcessIdentityError(`status-${key.toLowerCase()}`);
    }
    return Object.freeze(values);
}

function parseInnerUid(status, uidMap) {
    boundedText(status, 'proc-status');
    boundedText(uidMap, 'uid-map');
    const uidLine = status.split('\n').find((entry) => entry.startsWith('Uid:'));
    const uidValues = uidLine?.slice(4).trim().split(/\s+/).map(Number) || [];
    if (uidValues.length !== 4 || uidValues.some((value) => (
        !Number.isSafeInteger(value) || value < 0 || value !== uidValues[0]
    ))) throw agentProcessIdentityError('status-uid');
    const outerUid = uidValues[0];
    const mappings = uidMap.trim().split('\n').filter(Boolean).map((line) => {
        const values = line.trim().split(/\s+/).map(Number);
        if (values.length !== 3 || values.some((value) => !Number.isSafeInteger(value) || value < 0)
            || values[2] < 1) throw agentProcessIdentityError('uid-map');
        return values;
    });
    const matching = mappings.filter(([, outside, length]) => (
        outerUid >= outside && outerUid < outside + length
    ));
    if (matching.length !== 1) throw agentProcessIdentityError('uid-map');
    const [[inside, outside]] = matching;
    return inside + (outerUid - outside);
}

function validatePidNamespace(value) {
    if (typeof value !== 'string' || !/^pid:\[[1-9][0-9]*\]$/.test(value)) {
        throw agentProcessIdentityError('pid-namespace');
    }
    return value;
}

export {
    agentShellMarkerArgument,
    fixedAgentInteractiveShellArgv,
    fixedAgentShellWrapperArgv,
} from './agentRuntime.mjs';

export function parseAgentLinuxProcCmdline(raw) {
    if (!Buffer.isBuffer(raw) || raw.length > MAX_PROC_TEXT_BYTES) {
        throw agentProcessIdentityError('proc-cmdline');
    }
    if (raw.length === 0) return Object.freeze([]);
    if (raw.at(-1) !== 0) throw agentProcessIdentityError('proc-cmdline');
    const argv = raw.subarray(0, -1).toString('utf8').split('\0');
    if (!Buffer.from(`${argv.join('\0')}\0`, 'utf8').equals(raw)) {
        return Object.freeze([]);
    }
    return Object.freeze(argv);
}

export async function readAgentBoxProcessIdentity(pid, {
    procRoot = '/proc',
    fsApi = fs,
} = {}) {
    positiveInteger(pid, 'pid');
    const directory = path.join(procRoot, String(pid));
    try {
        const statPath = path.join(directory, 'stat');
        const before = parseAgentLinuxProcStat(await boundedProcFile(
            fsApi, statPath, { encoding: 'utf8', category: 'proc-stat' },
        ), pid);
        const [status, pidNamespace, uidMap, cmdlineBefore] = await Promise.all([
            boundedProcFile(fsApi, path.join(directory, 'status'), {
                encoding: 'utf8', category: 'proc-status',
            }),
            fsApi.readlink(path.join(directory, 'ns/pid')),
            boundedProcFile(fsApi, path.join(directory, 'uid_map'), {
                encoding: 'utf8', category: 'uid-map',
            }),
            boundedProcFile(fsApi, path.join(directory, 'cmdline'), {
                category: 'proc-cmdline',
            }),
        ]);
        const middle = parseAgentLinuxProcStat(await boundedProcFile(
            fsApi, statPath, { encoding: 'utf8', category: 'proc-stat' },
        ), pid);
        const cmdlineAfter = await boundedProcFile(fsApi, path.join(directory, 'cmdline'), {
            category: 'proc-cmdline',
        });
        const after = parseAgentLinuxProcStat(await boundedProcFile(
            fsApi, statPath, { encoding: 'utf8', category: 'proc-stat' },
        ), pid);
        if (before.startToken !== middle.startToken
            || middle.startToken !== after.startToken
            || !cmdlineBefore.equals(cmdlineAfter)
            || after.state === 'Z') {
            throw agentProcessIdentityError('changed-during-read', { stale: true });
        }
        return Object.freeze({
            pid,
            state: after.state,
            startToken: after.startToken,
            parentPid: after.parentPid,
            processGroupId: after.processGroupId,
            sessionId: after.sessionId,
            pidNamespace: validatePidNamespace(pidNamespace),
            nspid: parseStatusVector(status, 'NSpid'),
            nspgid: parseStatusVector(status, 'NSpgid'),
            nssid: parseStatusVector(status, 'NSsid'),
            innerUid: parseInnerUid(status, uidMap),
            argv: parseAgentLinuxProcCmdline(cmdlineAfter),
        });
    } catch (error) {
        if (error?.code?.startsWith?.('WEBTTY_AGENT_PROCESS_IDENTITY_')) throw error;
        throw agentProcessIdentityError('process-not-readable', {
            stale: error?.code === 'ENOENT' || error?.code === 'ESRCH',
        });
    }
}

function exactInnerEvidence(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw agentProcessIdentityError('inner-evidence');
    }
    for (const [field, category] of [
        ['pid', 'inner-pid'],
        ['processGroupId', 'inner-process-group'],
        ['sessionId', 'inner-session'],
        ['uid', 'inner-uid'],
    ]) {
        if (!Number.isSafeInteger(value[field]) || value[field] < (field === 'uid' ? 0 : 1)) {
            throw agentProcessIdentityError(category);
        }
    }
    if (typeof value.startToken !== 'string'
        || !/^linux-proc:[1-9][0-9]*$/.test(value.startToken)) {
        throw agentProcessIdentityError('inner-start-token');
    }
    return value;
}

function exactArgv(actual, expected) {
    return Array.isArray(actual)
        && actual.length === expected.length
        && actual.every((value, index) => value === expected[index]);
}

function exactMarkerWrapperArgv(argv, marker) {
    return ['/bin/bash', '/bin/sh'].some((shellPath) => (
        exactArgv(argv, fixedAgentShellWrapperArgv(marker, shellPath))
    ));
}

async function numericProcEntries(procRoot, fsApi) {
    const deadlineAt = Date.now() + PROC_SCAN_TIMEOUT_MS;
    const pids = [];
    if (typeof fsApi.opendir === 'function') {
        const directory = await boundedProcScanCall(fsApi.opendir(procRoot), { deadlineAt });
        const iterator = directory[Symbol.asyncIterator]();
        let scanned = 0;
        try {
            while (true) {
                const step = await boundedProcScanCall(iterator.next(), { deadlineAt });
                if (step.done) break;
                scanned += 1;
                if (scanned > MAX_PROC_SCAN_ENTRIES) {
                    throw agentProcessIdentityError('proc-scan-limit');
                }
                const entry = step.value;
                if (entry.isDirectory() && /^[1-9][0-9]*$/.test(entry.name)) {
                    const pid = Number(entry.name);
                    if (pid > 1) pids.push(pid);
                }
            }
        } finally {
            try { await directory.close(); } catch (error) {
                if (error?.code !== 'ERR_DIR_CLOSED') throw error;
            }
        }
    } else {
        const entries = await boundedProcScanCall(
            fsApi.readdir(procRoot, { withFileTypes: true }), { deadlineAt },
        );
        if (entries.length > MAX_PROC_SCAN_ENTRIES) {
            throw agentProcessIdentityError('proc-scan-limit');
        }
        for (const entry of entries) {
            if (entry.isDirectory() && /^[1-9][0-9]*$/.test(entry.name)) {
                const pid = Number(entry.name);
                if (pid > 1) pids.push(pid);
            }
        }
    }
    Object.defineProperty(pids, 'deadlineAt', {
        value: deadlineAt,
    });
    return pids;
}

async function boundedProcScanCall(operation, pids) {
    const remaining = Number(pids?.deadlineAt || 0) - Date.now();
    if (remaining <= 0) throw agentProcessIdentityError('proc-scan-timeout');
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(agentProcessIdentityError('proc-scan-timeout')),
                    remaining,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function pidMatchesNamespace(pid, expectedNamespace, procRoot, fsApi, pids) {
    if (typeof fsApi.readlink !== 'function') return true;
    let observedNamespace;
    try {
        observedNamespace = validatePidNamespace(await boundedProcScanCall(
            fsApi.readlink(path.join(procRoot, String(pid), 'ns/pid')),
            pids,
        ));
    } catch (error) {
        // A process may exit after numericProcEntries() enumerates it but
        // before the cheap namespace prefilter runs. Treat only an exact
        // vanished-process error as a non-match; permission and malformed
        // namespace failures remain fail-closed.
        if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return false;
        throw error;
    }
    return observedNamespace === expectedNamespace;
}

export async function captureAgentInnerProcessIdentity({
    containerInitBoxPid,
    inner,
    marker,
    shellPath = '/bin/bash',
}, {
    procRoot = '/proc',
    fsApi = fs,
    readIdentity = readAgentBoxProcessIdentity,
} = {}) {
    positiveInteger(containerInitBoxPid, 'container-init-pid');
    exactInnerEvidence(inner);
    if (typeof marker !== 'string' || !AGENT_MARKER.test(marker)) {
        throw agentProcessIdentityError('marker');
    }
    const expectedWrapperArgv = fixedAgentShellWrapperArgv(marker, shellPath);
    const expectedInteractiveArgv = fixedAgentInteractiveShellArgv(shellPath);
    const containerInit = await readIdentity(containerInitBoxPid, { procRoot, fsApi });
    const matches = [];
    const markerMatches = [];
    const pids = await numericProcEntries(procRoot, fsApi);
    for (const pid of pids) {
        let identity;
        try {
            // A Box may share a large outer /proc.  Cheaply discard processes
            // outside the exact target PID namespace before the bounded,
            // multi-file stable identity read.  The latter still rechecks the
            // namespace, so PID reuse or namespace movement fails closed.
            if (!await pidMatchesNamespace(
                pid, containerInit.pidNamespace, procRoot, fsApi, pids,
            )) continue;
            identity = await boundedProcScanCall(readIdentity(pid, { procRoot, fsApi }), pids);
        } catch (error) {
            if (error?.code === 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE') continue;
            throw error;
        }
        if (identity.pidNamespace !== containerInit.pidNamespace) continue;
        if (exactMarkerWrapperArgv(identity.argv, marker)) markerMatches.push(identity);
        if (identity.nspid.at(-1) === inner.pid) matches.push(identity);
    }
    if (matches.length !== 1) throw agentProcessIdentityError('inner-process-ambiguity');
    const [boxProcess] = matches;
    if (boxProcess.nspgid.at(-1) !== inner.processGroupId
        || boxProcess.nssid.at(-1) !== inner.sessionId
        || boxProcess.innerUid !== inner.uid
        || boxProcess.startToken !== inner.startToken) {
        throw agentProcessIdentityError('inner-topology');
    }
    if (markerMatches.length !== 1
        || !exactArgv(markerMatches[0].argv, expectedWrapperArgv)) {
        throw agentProcessIdentityError('marker-correlation');
    }
    const [wrapper] = markerMatches;
    // The fixed outer shell remains the exec/session anchor while its inner
    // interactive child provides echo-resistant numeric readiness. The child
    // is admission evidence only: recovery is bound to the durable wrapper.
    if (wrapper.pid === boxProcess.pid
        || wrapper.nspid.at(-1) !== inner.sessionId
        || wrapper.nssid.at(-1) !== inner.sessionId
        || wrapper.innerUid !== inner.uid) {
        throw agentProcessIdentityError('marker-correlation');
    }
    if (boxProcess.parentPid !== wrapper.pid
        || !exactArgv(boxProcess.argv, expectedInteractiveArgv)) {
        throw agentProcessIdentityError('inner-topology');
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
        innerPid: wrapper.nspid.at(-1),
        innerProcessGroupId: wrapper.nspgid.at(-1),
        innerSessionId: wrapper.nssid.at(-1),
        innerUid: wrapper.innerUid,
        innerStartToken: wrapper.startToken,
        containerInitBoxPid,
        containerInitStartToken: containerInit.startToken,
    });
}

export async function revalidateAgentInnerProcessIdentity(record, {
    procRoot = '/proc',
    fsApi = fs,
    readIdentity = readAgentBoxProcessIdentity,
} = {}) {
    const currentInit = await readIdentity(record?.containerInitBoxPid, { procRoot, fsApi });
    if (currentInit.startToken !== record?.containerInitStartToken
        || currentInit.pidNamespace !== record?.pidNamespace) {
        throw agentProcessIdentityError('container-init-replaced', { stale: true });
    }
    const current = await readIdentity(record?.boxPid, { procRoot, fsApi });
    for (const [field, observed] of [
        ['boxStartToken', current.startToken],
        ['boxProcessGroupId', current.processGroupId],
        ['boxSessionId', current.sessionId],
        ['pidNamespace', current.pidNamespace],
        ['innerPid', current.nspid.at(-1)],
        ['innerProcessGroupId', current.nspgid.at(-1)],
        ['innerSessionId', current.nssid.at(-1)],
        ['innerUid', current.innerUid],
        ['innerStartToken', current.startToken],
    ]) {
        if (record?.[field] !== observed) throw agentProcessIdentityError(field, { stale: true });
    }
    return current;
}

export async function captureAgentSessionSnapshot(record, {
    procRoot = '/proc',
    fsApi = fs,
    readIdentity = readAgentBoxProcessIdentity,
} = {}) {
    const anchor = await revalidateAgentInnerProcessIdentity(record, {
        procRoot,
        fsApi,
        readIdentity,
    });
    const members = [];
    const pids = await numericProcEntries(procRoot, fsApi);
    for (const pid of pids) {
        try {
            if (!await pidMatchesNamespace(
                pid, record.pidNamespace, procRoot, fsApi, pids,
            )) continue;
            const identity = await boundedProcScanCall(readIdentity(pid, { procRoot, fsApi }), pids);
            if (identity.pidNamespace === record.pidNamespace
                && identity.nssid.at(-1) === record.innerSessionId) {
                members.push(identity);
            }
        } catch (error) {
            if (error?.code !== 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE') throw error;
        }
    }
    if (!members.some((entry) => (
        entry.pid === anchor.pid && entry.startToken === anchor.startToken
    ))) {
        throw agentProcessIdentityError('session-anchor');
    }
    return Object.freeze(members);
}

export async function listAgentSessionMembers(record, {
    procRoot = '/proc',
    fsApi = fs,
    readIdentity = readAgentBoxProcessIdentity,
} = {}) {
    const before = await readIdentity(record?.containerInitBoxPid, { procRoot, fsApi });
    if (before.startToken !== record?.containerInitStartToken
        || before.pidNamespace !== record?.pidNamespace) {
        throw agentProcessIdentityError('container-init-replaced', { stale: true });
    }
    const members = [];
    const pids = await numericProcEntries(procRoot, fsApi);
    for (const pid of pids) {
        try {
            if (!await pidMatchesNamespace(
                pid, record.pidNamespace, procRoot, fsApi, pids,
            )) continue;
            const identity = await boundedProcScanCall(readIdentity(pid, { procRoot, fsApi }), pids);
            if (identity.pidNamespace === record.pidNamespace
                && identity.nssid.at(-1) === record.innerSessionId) {
                members.push(identity);
            }
        } catch (error) {
            if (error?.code !== 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE') throw error;
        }
    }
    const after = await readIdentity(record.containerInitBoxPid, { procRoot, fsApi });
    if (after.startToken !== before.startToken || after.pidNamespace !== before.pidNamespace) {
        throw agentProcessIdentityError('container-init-changed-during-scan', { stale: true });
    }
    const anchored = members.some((entry) => (
        entry.pid === record?.boxPid
        && entry.startToken === record?.boxStartToken
        && entry.processGroupId === record?.boxProcessGroupId
        && entry.sessionId === record?.boxSessionId
        && entry.nspid.at(-1) === record?.innerPid
        && entry.nspgid.at(-1) === record?.innerProcessGroupId
        && entry.nssid.at(-1) === record?.innerSessionId
    ));
    // Inner session IDs are numeric and recyclable. A non-empty same-number
    // scan is terminal-owned only while the immutable recorded leader is
    // itself still present. Otherwise signalling could kill a replacement
    // session that happens to reuse the old ID.
    if (members.length && !anchored) {
        throw agentProcessIdentityError('session-anchor-missing');
    }
    return Object.freeze(members);
}

function recordedPidNamespace(record) {
    return validatePidNamespace(record?.pidNamespace);
}

async function scanAgentMarkerProcesses(record, marker, {
    procRoot = '/proc',
    fsApi = fs,
    readIdentity = readAgentBoxProcessIdentity,
} = {}) {
    const pidNamespace = recordedPidNamespace(record);
    const matches = [];
    const pids = await numericProcEntries(procRoot, fsApi);
    for (const pid of pids) {
        try {
            if (!await pidMatchesNamespace(
                pid, pidNamespace, procRoot, fsApi, pids,
            )) continue;
            const identity = await boundedProcScanCall(
                readIdentity(pid, { procRoot, fsApi }),
                pids,
            );
            if (identity.pidNamespace === pidNamespace
                && exactMarkerWrapperArgv(identity.argv, marker)) {
                matches.push(identity);
            }
        } catch (error) {
            if (error?.code !== 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE') throw error;
        }
    }
    return Object.freeze(matches);
}

export async function listAgentMarkerProcesses(record, marker, options = {}) {
    return scanAgentMarkerProcesses(record, marker, options);
}

export async function listAgentRecordedNamespaceMarkerProcesses(record, marker, options = {}) {
    return scanAgentMarkerProcesses(record, marker, options);
}

export async function signalExactAgentSessionSnapshot(snapshot, signal, {
    procRoot = '/proc',
    fsApi = fs,
    readIdentity = readAgentBoxProcessIdentity,
    signalImpl = process.kill.bind(process),
} = {}) {
    if (!AGENT_PROCESS_SIGNALS.includes(signal)) throw agentProcessIdentityError('signal');
    if (!Array.isArray(snapshot) || snapshot.length === 0) {
        throw agentProcessIdentityError('session-snapshot');
    }
    if (snapshot.length > MAX_PROC_SCAN_ENTRIES) {
        throw agentProcessIdentityError('proc-scan-limit');
    }
    const deadline = { deadlineAt: Date.now() + PROC_SCAN_TIMEOUT_MS };
    let signaled = 0;
    for (const expected of snapshot) {
        let current;
        try {
            current = await boundedProcScanCall(
                readIdentity(expected.pid, { procRoot, fsApi }), deadline,
            );
        } catch (error) {
            if (error?.code === 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE') continue;
            throw error;
        }
        if (current.startToken !== expected.startToken
            || current.pidNamespace !== expected.pidNamespace
            || current.nssid.at(-1) !== expected.nssid.at(-1)) {
            throw agentProcessIdentityError('session-member-changed');
        }
        // No asynchronous or logging operation belongs between this final
        // identity check and the exact positive-PID signal.
        signalImpl(current.pid, signal);
        signaled += 1;
    }
    return Object.freeze({ signal, signaled });
}
