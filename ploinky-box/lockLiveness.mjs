import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

// Lock-holder liveness. A lock is reclaimed only on positive evidence that its
// holder is gone: the same machine and PID namespace, and then a changed boot,
// a missing process (ESRCH) or a different process-start token for that PID.
// Every probe failure, foreign machine or foreign PID namespace is
// "undetermined", which keeps the lock busy.

const PROBE_TIMEOUT_MS = 2_000;
const PROBE_MAX_BUFFER = 64 * 1024;
// Fixed tool paths and a fixed locale and zone: `ps -o lstart` is locale- and
// zone-dependent, and a different rendering must never look like a new process.
const DARWIN_PROBE_ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', TZ: 'UTC' });
const DARWIN_IOREG = '/usr/sbin/ioreg';
const DARWIN_SYSCTL = '/usr/sbin/sysctl';
const DARWIN_PS = '/bin/ps';
// macOS has no PID namespaces; every host process shares this one.
export const DARWIN_PID_NAMESPACE = 'darwin';

const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const LINUX_MACHINE_ID = /^[0-9a-f]{32}$/;
const LINUX_PID_NAMESPACE = /^pid:\[\d+\]$/;
const DARWIN_LSTART = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

export const LIVENESS = Object.freeze({
    live: 'live',
    stale: 'stale',
    undetermined: 'undetermined',
});

/** Field 22 (starttime, clock ticks since boot) of `/proc/<pid>/stat`, read after the last `)`. */
export function parseLinuxProcStatStart(text) {
    const value = String(text ?? '');
    const commandEnd = value.lastIndexOf(')');
    if (commandEnd < 0) return null;
    const fields = value.slice(commandEnd + 1).trim().split(/\s+/);
    // fields[0] is field 3 (state), so field 22 is fields[19].
    const ticks = fields[19];
    return /^\d+$/.test(ticks ?? '') ? `linux:${ticks}` : null;
}

/** `LC_ALL=C TZ=UTC ps -o lstart= -p PID` output, or null when it does not parse. */
export function parseDarwinLstart(text) {
    const normalized = String(text ?? '').trim().replace(/\s+/g, ' ');
    const match = DARWIN_LSTART.exec(normalized);
    if (!match) return null;
    const [, , , day, hour, minute, second] = match;
    if (Number(day) < 1 || Number(day) > 31 || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 60) {
        return null;
    }
    return `darwin:${normalized}`;
}

export function parseDarwinPlatformUuid(text) {
    const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(String(text ?? ''));
    return match && UUID.test(match[1]) ? match[1].toUpperCase() : null;
}

function trimmedMatch(value, pattern) {
    const trimmed = String(value ?? '').trim();
    return pattern.test(trimmed) ? trimmed : null;
}

/**
 * The liveness probe. Every external input is injectable for tests. The
 * machine, boot and PID-namespace tokens of this process cannot change while it
 * runs, so they are read once; holder start tokens are read on every check.
 */
export function createLockLiveness({
    platform = process.platform,
    fsApi = fs,
    execFile = execFileSync,
    kill = (pid, signal) => process.kill(pid, signal),
    hostname = () => os.hostname(),
    selfPid = process.pid,
} = {}) {
    function run(file, args) {
        return execFile(file, args, {
            encoding: 'utf8',
            env: DARWIN_PROBE_ENV,
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: PROBE_TIMEOUT_MS,
            maxBuffer: PROBE_MAX_BUFFER,
        });
    }

    function probe(read) {
        try {
            return read();
        } catch {
            return null;
        }
    }

    function readMachineId() {
        if (platform === 'linux') {
            return probe(() => trimmedMatch(fsApi.readFileSync('/etc/machine-id', 'utf8'), LINUX_MACHINE_ID));
        }
        if (platform === 'darwin') {
            return probe(() => parseDarwinPlatformUuid(run(DARWIN_IOREG, ['-rd1', '-c', 'IOPlatformExpertDevice'])));
        }
        return null;
    }

    function readBootId() {
        if (platform === 'linux') {
            return probe(() => trimmedMatch(fsApi.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'), UUID));
        }
        if (platform === 'darwin') {
            return probe(() => trimmedMatch(run(DARWIN_SYSCTL, ['-n', 'kern.bootsessionuuid']), UUID));
        }
        return null;
    }

    function readPidNamespace() {
        if (platform === 'linux') {
            return probe(() => trimmedMatch(fsApi.readlinkSync('/proc/self/ns/pid'), LINUX_PID_NAMESPACE));
        }
        return platform === 'darwin' ? DARWIN_PID_NAMESPACE : null;
    }

    function processStart(pid) {
        if (!Number.isSafeInteger(pid) || pid <= 0) return null;
        if (platform === 'linux') {
            return probe(() => parseLinuxProcStatStart(fsApi.readFileSync(`/proc/${pid}/stat`, 'utf8')));
        }
        if (platform === 'darwin') {
            return probe(() => parseDarwinLstart(run(DARWIN_PS, ['-o', 'lstart=', '-p', String(pid)])));
        }
        return null;
    }

    // A successful probe of this process's own tokens is kept: they cannot
    // change while it runs. A failed probe (for example a slow ioreg past its
    // time limit) is not kept, so the next classification tries again.
    const kept = new Map();
    function keep(key, read) {
        if (kept.has(key)) return kept.get(key);
        const value = read();
        if (value) kept.set(key, value);
        return value;
    }

    function localIdentity() {
        return Object.freeze({
            hostname: keep('hostname', () => probe(() => String(hostname()))) || 'unknown',
            machineId: keep('machineId', readMachineId),
            bootId: keep('bootId', readBootId),
            pidNamespace: keep('pidNamespace', readPidNamespace),
        });
    }

    function selfFields() {
        return Object.freeze({ ...localIdentity(), pid: selfPid, processStart: keep('processStart', () => processStart(selfPid)) });
    }

    function verdict(state, reason) {
        return Object.freeze({ state, reason });
    }

    // `owner` carries the v2 owner fields; anything missing is undetermined.
    function classify(owner) {
        const here = localIdentity();
        if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
            return verdict(LIVENESS.undetermined, 'the owner record is incomplete');
        }
        if (!here.machineId || !owner.machineId) {
            return verdict(LIVENESS.undetermined, 'the machine identity is unavailable');
        }
        if (owner.machineId !== here.machineId) {
            return verdict(LIVENESS.undetermined, 'it is held on another machine');
        }
        if (!here.pidNamespace || owner.pidNamespace !== here.pidNamespace) {
            return verdict(LIVENESS.undetermined, 'it is held from another PID namespace');
        }
        if (here.bootId && owner.bootId && owner.bootId !== here.bootId) {
            return verdict(LIVENESS.stale, 'the machine has restarted since it was taken');
        }
        try {
            kill(owner.pid, 0);
        } catch (error) {
            if (error?.code === 'ESRCH') return verdict(LIVENESS.stale, 'its process no longer exists');
            // EPERM: a process with that PID exists but belongs to someone else;
            // its start token still decides whether it is the holder.
            if (error?.code !== 'EPERM') return verdict(LIVENESS.undetermined, 'the process check failed');
        }
        if (!owner.processStart) {
            return verdict(LIVENESS.undetermined, 'the holder start time was not recorded');
        }
        const current = processStart(owner.pid);
        if (!current) return verdict(LIVENESS.undetermined, 'the holder start time cannot be read');
        if (current !== owner.processStart) {
            return verdict(LIVENESS.stale, 'its PID now belongs to a different process');
        }
        return verdict(LIVENESS.live, 'its process is running');
    }

    return Object.freeze({ localIdentity, selfFields, processStart, classify });
}
