// Structured, race-aware process identity for the detached no-wait worker.
// A PID and a plausible start timestamp are never sufficient: the observer
// requires the exact executable, exact absolute worker script, strict worker
// arguments, and one stable kernel process-start identity around the argv read.

import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import { execFileSync as execFileSyncDefault } from 'node:child_process';

import {
    NO_WAIT_IMMUTABLE_IDENTITY_FIELDS,
    parseNoWaitWorkerArgs,
} from '../commands/noWaitWorkerArgs.js';

export const DARWIN_PROCARGS_TIMEOUT_MS = 1_000;
export const DARWIN_PROCARGS_MAX_BYTES = 1024 * 1024;
const DARWIN_NATIVE_PROCARGS_SCRIPT = [
    'import ctypes,sys',
    'pid=int(sys.argv[1])',
    'libc=ctypes.CDLL(None)',
    'mib=(ctypes.c_int*3)(1,49,pid)',
    'size=ctypes.c_size_t(0)',
    'assert libc.sysctl(mib,3,None,ctypes.byref(size),None,0)==0',
    'assert 0<size.value<=1048576',
    'buf=ctypes.create_string_buffer(size.value)',
    'assert libc.sysctl(mib,3,buf,ctypes.byref(size),None,0)==0',
    'sys.stdout.buffer.write(buf.raw[:size.value])',
].join(';');

export function isProcessAlive(pid, { killImpl = (target, signal) => process.kill(target, signal) } = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        killImpl(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

function nulTerminated(buffer, offset) {
    const end = buffer.indexOf(0, offset);
    if (end < 0) return null;
    return { value: buffer.subarray(offset, end).toString('utf8'), next: end + 1 };
}

// Darwin's KERN_PROCARGS2 payload is: native int argc, executable C string,
// zero padding, then exactly argc argv C strings. Environment entries follow
// and are deliberately ignored.
export function parseDarwinKernProcArgs2(raw) {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '');
    if (buffer.length < 5 || buffer.length > DARWIN_PROCARGS_MAX_BYTES) return null;
    const argc = buffer.readInt32LE(0);
    if (!Number.isSafeInteger(argc) || argc < 1 || argc > 65_536) return null;

    const executable = nulTerminated(buffer, 4);
    if (!executable?.value) return null;
    let offset = executable.next;
    while (offset < buffer.length && buffer[offset] === 0) offset += 1;

    const argv = [];
    for (let index = 0; index < argc; index += 1) {
        const entry = nulTerminated(buffer, offset);
        if (!entry) return null;
        argv.push(entry.value);
        offset = entry.next;
    }
    return argv;
}

export function readProcessArgv(pid, {
    platform = process.platform,
    fsApi = fsDefault,
    execFileSyncImpl = execFileSyncDefault,
} = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    if (platform === 'linux') {
        try {
            const raw = fsApi.readFileSync(`/proc/${pid}/cmdline`);
            const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
            if (!buffer.length) return null;
            const argv = buffer.toString('utf8').split('\0');
            if (argv.at(-1) === '') argv.pop();
            return argv.length && argv[0] ? argv : null;
        } catch (_) {
            return null;
        }
    }
    if (platform === 'darwin') {
        try {
            const raw = execFileSyncImpl(
                '/usr/sbin/sysctl',
                ['-b', `kern.procargs2.${pid}`],
                {
                    encoding: null,
                    stdio: ['ignore', 'pipe', 'ignore'],
                    timeout: DARWIN_PROCARGS_TIMEOUT_MS,
                    maxBuffer: DARWIN_PROCARGS_MAX_BYTES,
                },
            );
            const parsed = parseDarwinKernProcArgs2(raw);
            if (parsed) return parsed;
        } catch (_) {
            // Some macOS releases do not expose the numeric KERN_PROCARGS2 MIB
            // through sysctl(8)'s name parser. Use the same native sysctl MIB
            // through the fixed system Python executable; no command text or
            // shell-rendered argv is consumed.
        }
        try {
            const raw = execFileSyncImpl(
                '/usr/bin/python3',
                ['-c', DARWIN_NATIVE_PROCARGS_SCRIPT, String(pid)],
                {
                    encoding: null,
                    stdio: ['ignore', 'pipe', 'ignore'],
                    timeout: DARWIN_PROCARGS_TIMEOUT_MS,
                    maxBuffer: DARWIN_PROCARGS_MAX_BYTES,
                },
            );
            return parseDarwinKernProcArgs2(raw);
        } catch (_) {
            return null;
        }
    }
    return null;
}

export function readProcessStartIdentity(pid, {
    platform = process.platform,
    fsApi = fsDefault,
    execFileSyncImpl = execFileSyncDefault,
} = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return '';
    if (platform === 'linux') {
        try {
            const stat = fsApi.readFileSync(`/proc/${pid}/stat`, 'utf8');
            const commandEnd = String(stat).lastIndexOf(')');
            if (commandEnd < 0) return '';
            const fields = String(stat).slice(commandEnd + 1).trim().split(/\s+/);
            const startTicks = String(fields[19] || '').trim();
            return startTicks ? `linux-proc:${startTicks}` : '';
        } catch (_) {
            return '';
        }
    }
    if (platform === 'darwin') {
        try {
            const startedAt = execFileSyncImpl(
                '/bin/ps',
                ['-p', String(pid), '-o', 'lstart='],
                {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                    timeout: 1_000,
                    maxBuffer: 64 * 1024,
                },
            ).trim().replace(/\s+/g, ' ');
            return startedAt ? `darwin-ps:${startedAt}` : '';
        } catch (_) {
            return '';
        }
    }
    return '';
}

export function processIdentityError(message, { stale = false } = {}) {
    const error = new Error(message);
    error.code = stale ? 'PROCESS_IDENTITY_STALE' : 'PROCESS_IDENTITY_UNPROVEN';
    return error;
}

export function proveWorkerProcessIdentity({
    pid,
    executablePath,
    workerScriptPath,
    runningDir,
    identity,
    isAliveImpl = isProcessAlive,
    readArgvImpl = readProcessArgv,
    readStartIdentityImpl = readProcessStartIdentity,
    pathApi = pathDefault,
} = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw processIdentityError('the published worker pid is not one positive integer');
    }
    if (!isAliveImpl(pid)) {
        throw processIdentityError(`worker process ${pid} is not running`, { stale: true });
    }

    const inspectionError = (message) => processIdentityError(message, {
        // Death during inspection is stale. A still-live process whose
        // structured identity is absent or different is foreign/unproven and
        // must never be treated as a harmless stale status.
        stale: !isAliveImpl(pid),
    });

    const before = readStartIdentityImpl(pid);
    if (!before) throw inspectionError(`worker process ${pid} exposes no stable process-start identity`);
    const argv = readArgvImpl(pid);
    if (!Array.isArray(argv) || argv.length < 2) {
        throw inspectionError(`worker process ${pid} exposes no structured argument vector`);
    }
    const after = readStartIdentityImpl(pid);
    if (!after || after !== before) {
        throw inspectionError(`worker process ${pid} changed during inspection`);
    }

    const expectedExecutable = String(executablePath || '');
    const expectedWorker = String(workerScriptPath || '');
    if (!pathApi.isAbsolute(expectedExecutable)
        || !pathApi.isAbsolute(expectedWorker)
        || argv[0] !== expectedExecutable
        || argv[1] !== expectedWorker) {
        throw processIdentityError(`worker process ${pid} does not run the expected executable and worker script`);
    }

    let parsed;
    try {
        parsed = parseNoWaitWorkerArgs(argv.slice(2), { runningDir, pathApi });
    } catch (error) {
        throw processIdentityError(`worker process ${pid} has invalid arguments: ${error.message}`);
    }
    const expected = identity || {};
    if (!NO_WAIT_IMMUTABLE_IDENTITY_FIELDS.every((field) => (
        parsed.identity[field] === expected[field]
    ))) {
        throw processIdentityError(`worker process ${pid} does not match the bound no-wait run`);
    }
    return Object.freeze({
        proof: 'structured-argv',
        processStartIdentity: before,
        argv: Object.freeze([...argv]),
    });
}
