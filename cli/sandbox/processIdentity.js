import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const MAX_PID = 0x7fffffff;
const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const LINUX_BOOT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CANONICAL_POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const CANONICAL_NONNEGATIVE_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const DARWIN_LSTART_PATTERN = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12][0-9]|3[01]) [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/;

function frozenState(state, details = {}) {
    return Object.freeze({ state, ...details });
}

function canonicalSingleLine(value) {
    if (typeof value !== 'string' || value.includes('\0')) return '';
    const normalized = value.endsWith('\n') ? value.slice(0, -1) : value;
    if (!normalized || normalized.includes('\n') || normalized.includes('\r')) return '';
    return normalized;
}

function parseLinuxBootId(value) {
    const bootId = canonicalSingleLine(value);
    return LINUX_BOOT_ID_PATTERN.test(bootId) ? bootId : '';
}

function parseLinuxStat(value) {
    if (typeof value !== 'string') return null;
    const commandEnd = value.lastIndexOf(')');
    if (commandEnd < 0) return null;
    const fields = value.slice(commandEnd + 1).trim().split(/\s+/);
    if (fields[0] === 'Z') return Object.freeze({ state: 'dead' });
    const startTicks = fields[19];
    if (!CANONICAL_POSITIVE_DECIMAL_PATTERN.test(startTicks || '')) return null;
    return Object.freeze({ state: 'identified', startTicks });
}

function parseLinuxStatus(value) {
    if (typeof value !== 'string') return null;
    const uidLines = value.match(/^Uid:\s+\d+\s+\d+\s+\d+\s+\d+\s*$/gm) || [];
    if (uidLines.length !== 1) return null;
    const match = uidLines[0].match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/);
    if (!match) return null;
    const uidTexts = match.slice(1);
    if (uidTexts.some((uid) => !CANONICAL_NONNEGATIVE_DECIMAL_PATTERN.test(uid))) return null;
    const processUids = uidTexts.map((uid) => Number(uid));
    if (processUids.some((uid) => !Number.isSafeInteger(uid) || uid < 0)) return null;
    return Object.freeze({
        processUid: processUids[0],
        uidDiverged: processUids.some((uid) => uid !== processUids[0]),
        uidIdentity: uidTexts.join(':'),
    });
}

function readLinuxSnapshot(pid, readFileSyncImpl) {
    let bootId;
    try {
        bootId = parseLinuxBootId(readFileSyncImpl(LINUX_BOOT_ID_PATH, 'utf8'));
    } catch (_) {
        return frozenState('unknown');
    }
    if (!bootId) return frozenState('unknown');

    let stat;
    try {
        stat = parseLinuxStat(readFileSyncImpl(`/proc/${pid}/stat`, 'utf8'));
    } catch (error) {
        return frozenState(error?.code === 'ENOENT' ? 'dead' : 'unknown');
    }
    if (stat?.state === 'dead') return frozenState('dead');
    if (!stat) return frozenState('unknown');

    let status;
    try {
        status = parseLinuxStatus(readFileSyncImpl(`/proc/${pid}/status`, 'utf8'));
    } catch (error) {
        return frozenState(error?.code === 'ENOENT' ? 'dead' : 'unknown');
    }
    if (!status) return frozenState('unknown');
    return frozenState('identified', {
        bootId,
        startTicks: stat.startTicks,
        processUid: status.processUid,
        uidDiverged: status.uidDiverged,
        uidIdentity: status.uidIdentity,
    });
}

function inspectLinuxProcessIdentity(pid, readFileSyncImpl) {
    const first = readLinuxSnapshot(pid, readFileSyncImpl);
    if (first.state !== 'identified') return first;
    const second = readLinuxSnapshot(pid, readFileSyncImpl);
    if (second.state !== 'identified') return second;
    if (first.bootId !== second.bootId
        || first.startTicks !== second.startTicks
        || first.processUid !== second.processUid
        || first.uidIdentity !== second.uidIdentity) {
        return frozenState('unknown');
    }
    if (first.uidDiverged || second.uidDiverged) {
        return frozenState('uid-diverged', { processUid: first.processUid });
    }
    return frozenState('identified', {
        processIdentity: `linux-proc:${first.bootId}:${first.startTicks}`,
        processUid: first.processUid,
    });
}

function parseDarwinBootTime(value) {
    if (typeof value !== 'string') return null;
    const match = value.trim().match(/^\{\s*sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)\s*\}(?:\s+.*)?$/);
    if (!match
        || !CANONICAL_POSITIVE_DECIMAL_PATTERN.test(match[1])
        || !CANONICAL_NONNEGATIVE_DECIMAL_PATTERN.test(match[2])) return null;
    const microseconds = Number(match[2]);
    if (!Number.isSafeInteger(microseconds) || microseconds < 0 || microseconds > 999999) {
        return null;
    }
    return Object.freeze({
        bootSeconds: match[1],
        bootMicroseconds: match[2],
    });
}

function parseDarwinPs(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/\s+/g, ' ');
    const match = normalized.match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!match || !CANONICAL_NONNEGATIVE_DECIMAL_PATTERN.test(match[1])) return null;
    if (match[2].startsWith('Z')) return Object.freeze({ state: 'dead' });
    if (!DARWIN_LSTART_PATTERN.test(match[3])) return null;
    const processUid = Number(match[1]);
    if (!Number.isSafeInteger(processUid) || processUid < 0) return null;
    return Object.freeze({
        state: 'identified',
        processUid,
        startedAt: match[3],
    });
}

function probeDarwinProcess(pid, probeProcessImpl) {
    try {
        probeProcessImpl(pid, 0);
        return frozenState('present');
    } catch (error) {
        if (error?.code === 'ESRCH') return frozenState('dead');
        if (error?.code === 'EPERM') return frozenState('present', { permissionDenied: true });
        return frozenState('unknown');
    }
}

function readDarwinSnapshot(pid, execFileSyncImpl, probeProcessImpl) {
    const probe = probeDarwinProcess(pid, probeProcessImpl);
    if (probe.state !== 'present') return probe;
    let bootTime;
    try {
        bootTime = parseDarwinBootTime(execFileSyncImpl('sysctl', ['-n', 'kern.boottime'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }));
    } catch (_) {
        return probeDarwinProcess(pid, probeProcessImpl).state === 'dead'
            ? frozenState('dead')
            : frozenState('unknown');
    }
    if (!bootTime) return frozenState('unknown');

    let psIdentity;
    try {
        psIdentity = parseDarwinPs(execFileSyncImpl('ps', [
            '-p', String(pid),
            '-o', 'uid=',
            '-o', 'state=',
            '-o', 'lstart=',
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }));
    } catch (_) {
        return probeDarwinProcess(pid, probeProcessImpl).state === 'dead'
            ? frozenState('dead')
            : frozenState('unknown');
    }
    if (psIdentity?.state === 'dead') return frozenState('dead');
    if (!psIdentity) return frozenState('unknown');
    return frozenState('identified', { ...bootTime, ...psIdentity });
}

function inspectDarwinProcessIdentity(pid, execFileSyncImpl, probeProcessImpl) {
    const first = readDarwinSnapshot(pid, execFileSyncImpl, probeProcessImpl);
    if (first.state !== 'identified') return first;
    const second = readDarwinSnapshot(pid, execFileSyncImpl, probeProcessImpl);
    if (second.state !== 'identified') return second;
    if (first.bootSeconds !== second.bootSeconds
        || first.bootMicroseconds !== second.bootMicroseconds
        || first.processUid !== second.processUid
        || first.startedAt !== second.startedAt) {
        return frozenState('unknown');
    }
    return frozenState('identified', {
        processIdentity: `darwin-ps:${first.bootSeconds}:${first.bootMicroseconds}:${first.startedAt}`,
        processUid: first.processUid,
    });
}

function normalizeProcessIdentity(value) {
    if (typeof value !== 'string') throw new TypeError('process identity must be canonical text');
    const linux = value.match(/^linux-proc:([a-f0-9-]+):(\d+)$/);
    if (linux) {
        if (!LINUX_BOOT_ID_PATTERN.test(linux[1])
            || !CANONICAL_POSITIVE_DECIMAL_PATTERN.test(linux[2])) {
            throw new TypeError('Linux process identity is not canonical');
        }
        return value;
    }
    const darwin = value.match(/^darwin-ps:(\d+):(\d+):(.+)$/);
    if (darwin) {
        const microseconds = Number(darwin[2]);
        if (!CANONICAL_POSITIVE_DECIMAL_PATTERN.test(darwin[1])
            || !CANONICAL_NONNEGATIVE_DECIMAL_PATTERN.test(darwin[2])
            || !Number.isSafeInteger(microseconds)
            || microseconds < 0
            || microseconds > 999999
            || !DARWIN_LSTART_PATTERN.test(darwin[3])) {
            throw new TypeError('Darwin process identity is not canonical');
        }
        return value;
    }
    throw new TypeError('process identity platform or shape is invalid');
}

function inspectProcessIdentity(pid, {
    platform = process.platform,
    fsImpl,
    readFileSyncImpl,
    execFileSyncImpl,
    probeProcessImpl = process.kill.bind(process),
} = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PID) return frozenState('dead');
    if (platform === 'linux') {
        const readFile = readFileSyncImpl
            || (typeof fsImpl?.readFileSync === 'function' && fsImpl.readFileSync.bind(fsImpl))
            || fs.readFileSync.bind(fs);
        return inspectLinuxProcessIdentity(pid, readFile);
    }
    if (platform === 'darwin') {
        return inspectDarwinProcessIdentity(pid, execFileSyncImpl || execFileSync, probeProcessImpl);
    }
    return frozenState('unknown');
}

export {
    inspectProcessIdentity,
    normalizeProcessIdentity,
};
