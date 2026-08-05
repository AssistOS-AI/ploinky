import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const MAX_PID = 0x7fffffff;
const BOOT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const POSITIVE_DECIMAL_RE = /^[1-9][0-9]*$/;
const NONNEGATIVE_DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;
const DARWIN_LSTART_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12][0-9]|3[01]) [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/;

function state(name, details = {}) {
    return Object.freeze({ state: name, ...details });
}
function singleLine(value) {
    if (typeof value !== 'string' || value.includes('\0')) return '';
    const normalized = value.endsWith('\n') ? value.slice(0, -1) : value;
    return normalized && !normalized.includes('\n') && !normalized.includes('\r') ? normalized : '';
}

function readLinuxSnapshot(pid, readFile) {
    let bootId;
    try { bootId = singleLine(readFile('/proc/sys/kernel/random/boot_id', 'utf8')); } catch (_) { return state('unknown'); }
    if (!BOOT_ID_RE.test(bootId)) return state('unknown');
    let stat;
    try { stat = readFile(`/proc/${pid}/stat`, 'utf8'); } catch (error) { return state(error?.code === 'ENOENT' ? 'dead' : 'unknown'); }
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return state('unknown');
    const statFields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    if (statFields[0] === 'Z') return state('dead');
    const startTicks = statFields[19];
    if (!POSITIVE_DECIMAL_RE.test(startTicks || '')) return state('unknown');
    let status;
    try { status = readFile(`/proc/${pid}/status`, 'utf8'); } catch (error) { return state(error?.code === 'ENOENT' ? 'dead' : 'unknown'); }
    const uidLines = status.match(/^Uid:\s+\d+\s+\d+\s+\d+\s+\d+\s*$/gm) || [];
    if (uidLines.length !== 1) return state('unknown');
    const uidMatch = uidLines[0].match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/);
    if (!uidMatch) return state('unknown');
    const uidTexts = uidMatch.slice(1);
    if (uidTexts.some((uid) => !NONNEGATIVE_DECIMAL_RE.test(uid))) return state('unknown');
    const uids = uidTexts.map(Number);
    if (uids.some((uid) => !Number.isSafeInteger(uid) || uid < 0)) return state('unknown');
    return state('identified', {
        bootId,
        startTicks,
        processUid: uids[0],
        uidDiverged: uids.some((uid) => uid !== uids[0]),
        uidIdentity: uidTexts.join(':'),
    });
}

function inspectLinux(pid, readFile) {
    const first = readLinuxSnapshot(pid, readFile);
    if (first.state !== 'identified') return first;
    const second = readLinuxSnapshot(pid, readFile);
    if (second.state !== 'identified') return second;
    if (first.bootId !== second.bootId || first.startTicks !== second.startTicks
        || first.processUid !== second.processUid || first.uidIdentity !== second.uidIdentity) return state('unknown');
    if (first.uidDiverged || second.uidDiverged) return state('uid-diverged', { processUid: first.processUid });
    return state('identified', {
        processIdentity: `linux-proc:${first.bootId}:${first.startTicks}`,
        processUid: first.processUid,
    });
}

function probeDarwinProcess(pid, probeProcess) {
    try {
        probeProcess(pid, 0);
        return state('present');
    } catch (error) {
        if (error?.code === 'ESRCH') return state('dead');
        if (error?.code === 'EPERM') return state('present', { permissionDenied: true });
        return state('unknown');
    }
}

function readDarwinSnapshot(pid, execFile, probeProcess) {
    const probe = probeDarwinProcess(pid, probeProcess);
    if (probe.state !== 'present') return probe;
    let bootRaw;
    try { bootRaw = execFile('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) {
        return probeDarwinProcess(pid, probeProcess).state === 'dead'
            ? state('dead')
            : state('unknown');
    }
    const boot = String(bootRaw).trim().match(/^\{\s*sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)\s*\}(?:\s+.*)?$/);
    if (!boot || !POSITIVE_DECIMAL_RE.test(boot[1]) || !NONNEGATIVE_DECIMAL_RE.test(boot[2])) return state('unknown');
    const usec = Number(boot[2]);
    if (!Number.isSafeInteger(usec) || usec > 999999) return state('unknown');
    let psRaw;
    try {
        psRaw = execFile('ps', ['-p', String(pid), '-o', 'uid=', '-o', 'state=', '-o', 'lstart='], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch (_) {
        return probeDarwinProcess(pid, probeProcess).state === 'dead'
            ? state('dead')
            : state('unknown');
    }
    const ps = String(psRaw).trim().replace(/\s+/g, ' ').match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!ps || !NONNEGATIVE_DECIMAL_RE.test(ps[1]) || !DARWIN_LSTART_RE.test(ps[3])) return state('unknown');
    if (ps[2].startsWith('Z')) return state('dead');
    const processUid = Number(ps[1]);
    if (!Number.isSafeInteger(processUid) || processUid < 0) return state('unknown');
    return state('identified', {
        bootSeconds: boot[1], bootMicroseconds: boot[2], processUid, startedAt: ps[3],
    });
}

function inspectDarwin(pid, execFile, probeProcess) {
    const first = readDarwinSnapshot(pid, execFile, probeProcess);
    if (first.state !== 'identified') return first;
    const second = readDarwinSnapshot(pid, execFile, probeProcess);
    if (second.state !== 'identified') return second;
    if (first.bootSeconds !== second.bootSeconds || first.bootMicroseconds !== second.bootMicroseconds
        || first.processUid !== second.processUid || first.startedAt !== second.startedAt) return state('unknown');
    return state('identified', {
        processIdentity: `darwin-ps:${first.bootSeconds}:${first.bootMicroseconds}:${first.startedAt}`,
        processUid: first.processUid,
    });
}

export function normalizeProcessIdentity(value) {
    if (typeof value !== 'string') throw new TypeError('process identity must be canonical text');
    const linux = value.match(/^linux-proc:([a-f0-9-]+):(\d+)$/);
    if (linux && BOOT_ID_RE.test(linux[1]) && POSITIVE_DECIMAL_RE.test(linux[2])) return value;
    const darwin = value.match(/^darwin-ps:(\d+):(\d+):(.+)$/);
    if (darwin && POSITIVE_DECIMAL_RE.test(darwin[1]) && NONNEGATIVE_DECIMAL_RE.test(darwin[2])
        && Number(darwin[2]) <= 999999 && DARWIN_LSTART_RE.test(darwin[3])) return value;
    throw new TypeError('process identity platform or shape is invalid');
}

export function inspectProcessIdentity(pid, {
    platform = process.platform,
    fsImpl,
    readFileSyncImpl,
    execFileSyncImpl,
    probeProcessImpl = process.kill.bind(process),
} = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PID) return state('dead');
    if (platform === 'linux') {
        const readFile = readFileSyncImpl
            || (typeof fsImpl?.readFileSync === 'function' && fsImpl.readFileSync.bind(fsImpl))
            || fs.readFileSync.bind(fs);
        return inspectLinux(pid, readFile);
    }
    if (platform === 'darwin') return inspectDarwin(pid, execFileSyncImpl || execFileSync, probeProcessImpl);
    return state('unknown');
}
