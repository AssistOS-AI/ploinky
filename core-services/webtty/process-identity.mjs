import fs from 'node:fs';

export const WEBTTY_ALLOWED_GROUP_SIGNALS = Object.freeze(['SIGTERM', 'SIGKILL', 'SIGHUP']);

export function processIdentityError(category, { stale = false } = {}) {
    const error = new Error(`WebTTY process identity is ${stale ? 'stale' : 'unproven'}: ${category}`);
    error.code = stale ? 'WEBTTY_PROCESS_IDENTITY_STALE' : 'WEBTTY_PROCESS_IDENTITY_UNPROVEN';
    error.category = category;
    return error;
}

function positiveInteger(value, category) {
    if (!Number.isSafeInteger(value) || value <= 0) throw processIdentityError(category);
    return value;
}

export function parseLinuxProcessStat(raw, expectedPid) {
    positiveInteger(expectedPid, 'pid');
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64 * 1024) {
        throw processIdentityError('proc-stat');
    }
    const open = raw.indexOf('(');
    const close = raw.lastIndexOf(')');
    if (open <= 0 || close <= open) throw processIdentityError('proc-stat');
    const parsedPid = Number(raw.slice(0, open).trim());
    if (parsedPid !== expectedPid) throw processIdentityError('proc-pid');
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    if (fields.length < 20) throw processIdentityError('proc-stat-fields');
    const integerAt = (index, category) => {
        const value = Number(fields[index]);
        if (!Number.isSafeInteger(value)) throw processIdentityError(category);
        return value;
    };
    const startTicks = fields[19];
    if (!/^[1-9][0-9]*$/.test(startTicks || '')) throw processIdentityError('start-token');
    return Object.freeze({
        pid: expectedPid,
        state: fields[0],
        processGroupId: integerAt(2, 'process-group'),
        sessionId: integerAt(3, 'session'),
        ttyNumber: integerAt(4, 'tty'),
        foregroundProcessGroupId: integerAt(5, 'foreground-group'),
        startToken: `linux-proc:${startTicks}`,
    });
}

export function readLinuxProcessIdentity(pid, { fsApi = fs } = {}) {
    positiveInteger(pid, 'pid');
    try {
        return parseLinuxProcessStat(fsApi.readFileSync(`/proc/${pid}/stat`, 'utf8'), pid);
    } catch (error) {
        if (error?.code === 'WEBTTY_PROCESS_IDENTITY_UNPROVEN') throw error;
        throw processIdentityError('process-not-readable', { stale: error?.code === 'ENOENT' || error?.code === 'ESRCH' });
    }
}

export function readLinuxProcessArgv(pid, { fsApi = fs } = {}) {
    positiveInteger(pid, 'pid');
    try {
        const raw = fsApi.readFileSync(`/proc/${pid}/cmdline`);
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (buffer.length === 0 || buffer.length > 64 * 1024) throw processIdentityError('argv');
        const argv = buffer.toString('utf8').split('\0').filter(Boolean);
        if (argv.length < 2) throw processIdentityError('argv');
        return Object.freeze(argv);
    } catch (error) {
        if (error?.code === 'WEBTTY_PROCESS_IDENTITY_UNPROVEN') throw error;
        throw processIdentityError('argv-not-readable', { stale: error?.code === 'ENOENT' || error?.code === 'ESRCH' });
    }
}

function stableInspection(pid, inspect, { readIdentityImpl = readLinuxProcessIdentity } = {}) {
    const before = readIdentityImpl(pid);
    const inspected = inspect(before);
    const after = readIdentityImpl(pid);
    if (before.startToken !== after.startToken || before.state === 'Z' || after.state === 'Z') {
        throw processIdentityError('changed-during-inspection', { stale: after.state === 'Z' });
    }
    return { identity: after, inspected };
}

export function captureWorkerProcessIdentity({
    pid,
    executablePath,
    workerScriptPath,
    readIdentityImpl = readLinuxProcessIdentity,
    readArgvImpl = readLinuxProcessArgv,
} = {}) {
    if (typeof executablePath !== 'string' || !executablePath.startsWith('/')
        || typeof workerScriptPath !== 'string' || !workerScriptPath.startsWith('/')) {
        throw processIdentityError('worker-path');
    }
    const { identity, inspected: argv } = stableInspection(
        pid,
        () => readArgvImpl(pid),
        { readIdentityImpl },
    );
    if (argv[0] !== executablePath || argv[1] !== workerScriptPath) {
        throw processIdentityError('worker-argv');
    }
    return Object.freeze({
        pid,
        startToken: identity.startToken,
        executablePath,
        workerScriptPath,
    });
}

export function revalidateWorkerProcessIdentity(record, options = {}) {
    const current = captureWorkerProcessIdentity({ ...record, ...options });
    if (current.startToken !== record?.startToken) throw processIdentityError('worker-start-token');
    return current;
}

function requirePtyTopology(identity) {
    if (identity.state === 'Z') throw processIdentityError('pty-zombie', { stale: true });
    if (identity.ttyNumber <= 0) throw processIdentityError('pty-tty');
    if (identity.processGroupId !== identity.pid
        || identity.sessionId !== identity.pid
        || identity.foregroundProcessGroupId !== identity.pid) {
        throw processIdentityError('pty-group-topology');
    }
    return identity;
}

function requirePtySignalTopology(identity) {
    if (identity.state === 'Z') throw processIdentityError('pty-zombie', { stale: true });
    if (identity.ttyNumber <= 0) throw processIdentityError('pty-tty');
    if (identity.processGroupId !== identity.pid || identity.sessionId !== identity.pid) {
        throw processIdentityError('pty-group-topology');
    }
    return identity;
}

export function capturePtyProcessIdentity(pid, { readIdentityImpl = readLinuxProcessIdentity } = {}) {
    const { identity } = stableInspection(pid, requirePtyTopology, { readIdentityImpl });
    requirePtyTopology(identity);
    return Object.freeze({
        pid: identity.pid,
        startToken: identity.startToken,
        processGroupId: identity.processGroupId,
        sessionId: identity.sessionId,
        foregroundProcessGroupId: identity.foregroundProcessGroupId,
        ttyNumber: identity.ttyNumber,
    });
}

export function revalidatePtyProcessIdentity(record, { readIdentityImpl = readLinuxProcessIdentity } = {}) {
    const current = capturePtyProcessIdentity(record?.pid, { readIdentityImpl });
    for (const field of [
        'startToken',
        'processGroupId',
        'sessionId',
        'foregroundProcessGroupId',
        'ttyNumber',
    ]) {
        if (current[field] !== record?.[field]) throw processIdentityError(`pty-${field}`);
    }
    return current;
}

export function revalidatePtyProcessGroupIdentity(record, {
    readIdentityImpl = readLinuxProcessIdentity,
} = {}) {
    const pid = positiveInteger(record?.pid, 'pid');
    positiveInteger(record?.processGroupId, 'pty-process-group');
    positiveInteger(record?.sessionId, 'pty-session');
    positiveInteger(record?.foregroundProcessGroupId, 'pty-foreground-group');
    positiveInteger(record?.ttyNumber, 'pty-tty');
    if (typeof record?.startToken !== 'string' || !/^linux-proc:[1-9][0-9]*$/.test(record.startToken)) {
        throw processIdentityError('pty-start-token');
    }
    const { identity } = stableInspection(pid, requirePtySignalTopology, { readIdentityImpl });
    requirePtySignalTopology(identity);
    for (const [field, observed] of [
        ['startToken', identity.startToken],
        ['processGroupId', identity.processGroupId],
        ['sessionId', identity.sessionId],
        ['ttyNumber', identity.ttyNumber],
    ]) {
        if (observed !== record[field]) throw processIdentityError(`pty-${field}`);
    }
    return Object.freeze({
        pid: identity.pid,
        startToken: identity.startToken,
        processGroupId: identity.processGroupId,
        sessionId: identity.sessionId,
        foregroundProcessGroupId: identity.foregroundProcessGroupId,
        ttyNumber: identity.ttyNumber,
    });
}

export function revalidatePtyProcessLiveness(record, {
    readIdentityImpl = readLinuxProcessIdentity,
} = {}) {
    const pid = positiveInteger(record?.pid, 'pid');
    if (typeof record?.startToken !== 'string' || !/^linux-proc:[1-9][0-9]*$/.test(record.startToken)) {
        throw processIdentityError('pty-start-token');
    }
    const readComparableIdentity = () => {
        const identity = readIdentityImpl(pid);
        if (!identity || typeof identity !== 'object'
            || identity.pid !== pid
            || typeof identity.state !== 'string'
            || identity.state.length !== 1
            || typeof identity.startToken !== 'string'
            || !/^linux-proc:[1-9][0-9]*$/.test(identity.startToken)) {
            throw processIdentityError('pty-liveness');
        }
        return identity;
    };
    const before = readComparableIdentity();
    const after = readComparableIdentity();
    if (before.state === 'Z'
        || after.state === 'Z'
        || before.startToken !== record.startToken
        || after.startToken !== record.startToken) {
        throw processIdentityError('pty-exited', { stale: true });
    }
    return after;
}

export function signalVerifiedPtyProcessGroup(record, signal, {
    readIdentityImpl = readLinuxProcessIdentity,
    killImpl = (target, selectedSignal) => process.kill(target, selectedSignal),
} = {}) {
    if (!WEBTTY_ALLOWED_GROUP_SIGNALS.includes(signal)) throw processIdentityError('signal');
    // The terminal foreground group is job-control state. It legitimately
    // changes while bash waits for a foreground command, so it is observed but
    // is not part of the shell process-group identity being signaled here.
    const current = revalidatePtyProcessGroupIdentity(record, { readIdentityImpl });
    if (current.processGroupId !== current.pid) throw processIdentityError('group-leader');
    // No filesystem, logging, or asynchronous operation belongs between this
    // final identity proof and the negative-PID signal.
    killImpl(-current.processGroupId, signal);
    return Object.freeze({ signaled: true, signal, processGroupId: current.processGroupId });
}

export async function waitForPtyProcessExit(record, {
    timeoutMs = 500,
    pollMs = 10,
    readIdentityImpl = readLinuxProcessIdentity,
    delayImpl = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
    nowImpl = Date.now,
} = {}) {
    const deadline = nowImpl() + timeoutMs;
    while (nowImpl() <= deadline) {
        try {
            // PTY teardown can legitimately clear the controlling terminal
            // before /proc removes the original process. Exit polling proves
            // only that exact PID/start-token identity. Full PTY topology is
            // revalidated separately immediately before every group signal.
            revalidatePtyProcessLiveness(record, { readIdentityImpl });
        } catch (error) {
            if (error?.code === 'WEBTTY_PROCESS_IDENTITY_STALE') return true;
            throw error;
        }
        await delayImpl(pollMs);
    }
    return false;
}

const MAX_SESSION_ENTRIES = 8_192;
const MAX_PROC_BYTES = 64 * 1024;
export const PTY_SESSION_CLEANUP_MS = 1_500;
const TERM_PHASE_MS = 750;
const EMPTY_SCAN_INTERVAL_MS = 25;

function sessionIdentity(value, sessionId) {
    positiveInteger(value?.pid, 'session-pid');
    positiveInteger(value?.sessionId, 'session-id');
    if (value.sessionId !== sessionId
        || typeof value.startToken !== 'string'
        || !/^linux-proc:[1-9][0-9]*$/.test(value.startToken)
        || typeof value.state !== 'string' || !/^[RSDZTtXxKWPI]$/.test(value.state)) {
        throw processIdentityError('session-identity');
    }
    return Object.freeze({
        pid: value.pid, startToken: value.startToken, sessionId: value.sessionId,
        state: value.state,
    });
}

function sameSessionIdentity(current, expected) {
    return current.pid === expected.pid && current.startToken === expected.startToken
        && current.sessionId === expected.sessionId && current.state !== 'Z';
}

function checkDeadline(deadlineAt, nowImpl) {
    if (!Number.isFinite(deadlineAt) || nowImpl() >= deadlineAt) {
        throw processIdentityError('session-deadline');
    }
}

function readSessionSignalIdentity(pid) {
    positiveInteger(pid, 'pid');
    let descriptor;
    try {
        descriptor = fs.openSync(`/proc/${pid}/stat`, 'r');
        const buffer = Buffer.alloc(MAX_PROC_BYTES + 1);
        const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
        if (bytes > MAX_PROC_BYTES) throw processIdentityError('proc-file-limit');
        return parseLinuxProcessStat(buffer.subarray(0, bytes).toString('utf8'), pid);
    } catch (error) {
        if (error?.code?.startsWith('WEBTTY_PROCESS_IDENTITY_')) throw error;
        throw processIdentityError('process-not-readable', {
            stale: ['ENOENT', 'ESRCH'].includes(error?.code),
        });
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
}

async function beforeDeadline(operation, deadlineAt, nowImpl) {
    checkDeadline(deadlineAt, nowImpl);
    let timer;
    try {
        const result = await Promise.race([
            operation(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(processIdentityError('session-deadline')), deadlineAt - nowImpl());
            }),
        ]);
        checkDeadline(deadlineAt, nowImpl);
        return result;
    } finally {
        clearTimeout(timer);
    }
}

async function readSessionProcess(pid, { fsApi, deadlineAt, nowImpl }) {
    positiveInteger(pid, 'pid');
    let handle;
    try {
        // The operation owns even a late open, so timeout cannot leak its handle.
        return await beforeDeadline(async () => {
            handle = await fsApi.open(`/proc/${pid}/stat`, 'r');
            try {
                checkDeadline(deadlineAt, nowImpl);
                const buffer = Buffer.alloc(MAX_PROC_BYTES + 1);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                checkDeadline(deadlineAt, nowImpl);
                if (bytesRead > MAX_PROC_BYTES) throw processIdentityError('proc-file-limit');
                return parseLinuxProcessStat(buffer.subarray(0, bytesRead).toString('utf8'), pid);
            } finally {
                await handle.close();
            }
        }, deadlineAt, nowImpl);
    } catch (error) {
        if (error?.code?.startsWith('WEBTTY_PROCESS_IDENTITY_')) throw error;
        throw processIdentityError('process-not-readable', {
            stale: ['ENOENT', 'ESRCH'].includes(error?.code),
        });
    }
}

export async function capturePtySessionSnapshot(record, {
    anchors = [record],
    fsApi = fs.promises,
    deadlineAt = Date.now() + PTY_SESSION_CLEANUP_MS,
    nowImpl = Date.now,
    maxEntries = MAX_SESSION_ENTRIES,
    readIdentityImpl = (pid) => readSessionProcess(pid, { fsApi, deadlineAt, nowImpl }),
} = {}) {
    const sessionId = positiveInteger(record?.sessionId, 'session-id');
    if (!Array.isArray(anchors) || anchors.length > MAX_SESSION_ENTRIES
        || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_SESSION_ENTRIES) {
        throw processIdentityError('session-anchors');
    }
    const trusted = anchors.map((anchor) => sessionIdentity({ state: 'S', ...anchor }, sessionId));
    const read = (pid) => beforeDeadline(() => readIdentityImpl(pid), deadlineAt, nowImpl);
    let anchor;
    for (const expected of trusted) {
        try {
            const current = await read(expected.pid);
            if (sameSessionIdentity(sessionIdentity(current, current.sessionId), expected)) {
                anchor = expected;
                break;
            }
        } catch (error) {
            if (error?.code !== 'WEBTTY_PROCESS_IDENTITY_STALE') throw error;
        }
    }
    const members = [];
    const opening = fsApi.opendir('/proc');
    let directory;
    try {
        directory = await beforeDeadline(() => opening, deadlineAt, nowImpl);
    } catch (error) {
        void opening.then((late) => late.close()).catch(() => {});
        throw error;
    }
    try {
        let entries = 0;
        while (true) {
            const entry = await beforeDeadline(() => directory.read(), deadlineAt, nowImpl);
            if (!entry) break;
            if (++entries > maxEntries) throw processIdentityError('proc-scan-limit');
            if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) continue;
            const pid = positiveInteger(Number(entry.name), 'proc-pid');
            try {
                const current = await read(pid);
                const member = sessionIdentity(current, current.sessionId);
                if (member.sessionId === sessionId && member.state !== 'Z') members.push(member);
            } catch (error) {
                if (error?.code !== 'WEBTTY_PROCESS_IDENTITY_STALE') throw error;
            }
        }
    } finally {
        // Closing an outstanding directory read remains owned by this scan;
        // cleanup itself must not wait past the shared transaction deadline.
        void directory.close().catch(() => {});
    }
    if (members.length) {
        if (!anchor || !members.some((member) => sameSessionIdentity(member, anchor))) {
            throw processIdentityError('session-anchor-missing');
        }
        const after = await read(anchor.pid);
        if (!sameSessionIdentity(sessionIdentity(after, after.sessionId), anchor)) {
            throw processIdentityError('session-anchor-changed');
        }
    }
    checkDeadline(deadlineAt, nowImpl);
    return Object.freeze(members);
}

export function signalExactPtySessionSnapshot(snapshot, signal, {
    deadlineAt,
    nowImpl = Date.now,
    readIdentityImpl = readSessionSignalIdentity,
    killImpl = process.kill.bind(process),
} = {}) {
    if (!['SIGTERM', 'SIGKILL'].includes(signal) || !Array.isArray(snapshot)
        || snapshot.length > MAX_SESSION_ENTRIES) throw processIdentityError('session-signal');
    const expectedMembers = snapshot.map((member) => sessionIdentity(member, member?.sessionId));
    if (expectedMembers.some((member) => member.sessionId !== expectedMembers[0]?.sessionId)) {
        throw processIdentityError('session-snapshot');
    }
    for (const expected of expectedMembers) {
        checkDeadline(deadlineAt, nowImpl);
        let current;
        try {
            current = readIdentityImpl(expected.pid);
        } catch (error) {
            if (error?.code === 'WEBTTY_PROCESS_IDENTITY_STALE') continue;
            throw error;
        }
        current = sessionIdentity(current, current.sessionId);
        if (current.state === 'Z') continue;
        if (!sameSessionIdentity(current, expected)) throw processIdentityError('session-member-changed');
        checkDeadline(deadlineAt, nowImpl);
        // Revalidate synchronously and signal only this positive PID. No await
        // or logging may separate that identity proof from the signal.
        try { killImpl(current.pid, signal); } catch (error) {
            if (error?.code !== 'ESRCH') throw error;
        }
    }
}

export async function cleanupPtySession(record, {
    nowImpl = Date.now,
    delayImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    snapshotImpl = capturePtySessionSnapshot,
    signalImpl = signalExactPtySessionSnapshot,
} = {}) {
    const started = nowImpl();
    const deadlineAt = started + PTY_SESSION_CLEANUP_MS;
    const termDeadlineAt = started + TERM_PHASE_MS;
    let anchors = [record];
    let emptyAt = null;
    const terminated = new Set();
    while (nowImpl() < deadlineAt) {
        const snapshot = await beforeDeadline(() => snapshotImpl(record, {
            anchors, deadlineAt, nowImpl,
        }), deadlineAt, nowImpl);
        if (!Array.isArray(snapshot)) throw processIdentityError('session-snapshot');
        if (!snapshot.length) {
            if (emptyAt !== null && nowImpl() - emptyAt >= EMPTY_SCAN_INTERVAL_MS) return true;
            emptyAt ??= nowImpl();
        } else {
            emptyAt = null;
            anchors = snapshot;
            const signal = nowImpl() < termDeadlineAt ? 'SIGTERM' : 'SIGKILL';
            const targets = signal === 'SIGTERM'
                ? snapshot.filter((member) => !terminated.has(`${member.pid}:${member.startToken}`))
                : snapshot;
            // Keep the original shell alive until its other observed members
            // have received the signal, preserving continuity as long as possible.
            const ordered = [...targets].sort((a, b) => Number(a.pid === record.pid) - Number(b.pid === record.pid));
            if (ordered.length) {
                try {
                    signalImpl(ordered, signal, {
                        deadlineAt: signal === 'SIGTERM' ? termDeadlineAt : deadlineAt, nowImpl,
                    });
                } catch (error) {
                    if (signal !== 'SIGTERM'
                        || error?.code !== 'WEBTTY_PROCESS_IDENTITY_UNPROVEN'
                        || error?.category !== 'session-deadline'
                        || nowImpl() < termDeadlineAt || nowImpl() >= deadlineAt) throw error;
                    // TERM's cutoff can interrupt even a partially signaled
                    // snapshot. Re-establish ownership before KILL, retaining
                    // the original transaction deadline.
                    continue;
                }
            }
            for (const member of targets) terminated.add(`${member.pid}:${member.startToken}`);
        }
        await beforeDeadline(() => delayImpl(EMPTY_SCAN_INTERVAL_MS), deadlineAt, nowImpl);
    }
    return false;
}
