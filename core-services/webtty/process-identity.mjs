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
    const current = revalidatePtyProcessIdentity(record, { readIdentityImpl });
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
