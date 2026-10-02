import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MPS_TOOL_PATHS, revalidateMpsTools } from '../../../ploinky-box/lib/mpsTools.mjs';
import { MpsError } from './mpsEligibility.mjs';
import { AGENT_ALIAS_PATTERN, RESERVED_AGENT_REGISTRY_KEYS } from '../../utils/agentRegistryResolver.js';

export const MPS_ROOT = '/run/ploinky/mps';
export const MPS_GENERATION_LABEL = 'ploinky.mpsgeneration';
export const MPS_CLIENT_PIPE = '/run/ploinky-mps-pipe';
const OUTPUT_BOUND = 8192;
const STATE_BOUND = 64 * 1024;
const sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

function assertUid(uid) { if (uid !== 1000) throw new MpsError('MPS operations require Box uid 1000'); }
function safeInteger(value, low, high) { return Number.isSafeInteger(value) && value >= low && value <= high; }
export function validateMpsDefault(value) {
    if (!value || !safeInteger(value.smPercent, 1, 100) || !safeInteger(value.memoryMiB, 512, Number.MAX_SAFE_INTEGER / 1048576)) throw new MpsError('Invalid MPS server defaults');
    return value;
}
export function mpsClientEnvironment(share, pipeDirectory) {
    validateMpsDefault(share);
    if (typeof pipeDirectory !== 'string' || !/^\/run\/ploinky\/mps\/pipe-[a-f0-9]{32}$/.test(pipeDirectory)) throw new MpsError('Invalid private MPS pipe');
    return Object.freeze({ CUDA_MPS_PIPE_DIRECTORY: MPS_CLIENT_PIPE, CUDA_MPS_ACTIVE_THREAD_PERCENTAGE: String(share.smPercent), CUDA_MPS_PINNED_DEVICE_MEM_LIMIT: `0=${share.memoryMiB}M` });
}
export function mpsClientArgs(share, state) {
    if (state?.status !== 'ready' || !/^[A-Za-z0-9.-]{1,128}$/.test(String(state.daemonGeneration || '')) || !/^[A-Za-z0-9.-]{1,128}$/.test(String(state.configurationGeneration || ''))) throw new MpsError('MPS daemon defaults are not verified');
    const env = mpsClientEnvironment(share, state.pipeDirectory);
    return ['--volume', `${state.pipeDirectory}:${MPS_CLIENT_PIPE}:z,rw`, '--label', `${MPS_GENERATION_LABEL}=${state.daemonGeneration}:${state.configurationGeneration}`,
        ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`])];
}
export function parseMpsSmReply(text) {
    const value = String(text || '').trim();
    if (!/^[1-9]\d?$|^100$/.test(value)) throw new MpsError('Unsupported MPS SM default reply');
    return Number(value);
}
// Only the complete explicit M/G unit form is supported. LIVE-P1 must capture
// the selected driver's exact reply; an unrecognized ABI refuses sharing.
export function parseMpsMemoryReply(text) {
    const match = /^([1-9]\d*)([MG])$/.exec(String(text || '').trim());
    if (!match) throw new MpsError('Unsupported MPS device-memory default reply');
    const bytes = Number(match[1]) * (match[2] === 'M' ? 1048576 : 1073741824);
    if (!Number.isSafeInteger(bytes)) throw new MpsError('MPS memory reply exceeds supported bounds');
    return bytes;
}
export function parseMpsServerList(text) {
    const value = String(text || '').trim();
    if (!value) return [];
    const lines = value.split('\n');
    if (lines.length > 256 || lines.some((line) => !/^[1-9]\d*$/.test(line) || !safeInteger(Number(line), 1, 2147483647))) throw new MpsError('Unsupported MPS server-list reply');
    return [...new Set(lines.map(Number))];
}
const COMMAND = /^(?:set_default_active_thread_percentage (?:[1-9]\d?|100)|get_default_active_thread_percentage|set_default_device_pinned_mem_limit 0 [1-9]\d*M|get_default_device_pinned_mem_limit 0|get_server_list|quit)$/;
export function runMpsControl(command, { env, query = spawnSync, uid = process.getuid?.(), timeoutMs = 5000 } = {}) {
    assertUid(uid);
    if (typeof command !== 'string' || !COMMAND.test(command) || command.length > 200) throw new MpsError('Unsupported MPS control command');
    const result = query(MPS_TOOL_PATHS.control, [], { input: `${command}\n`, encoding: 'utf8', env, timeout: Math.min(timeoutMs, 5000), maxBuffer: OUTPUT_BOUND, stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.status !== 0 || result.signal || result.error || result.truncated || Buffer.byteLength(String(result.stdout || '')) > OUTPUT_BOUND || Buffer.byteLength(String(result.stderr || '')) > OUTPUT_BOUND) throw new MpsError('MPS control failed, timed out or exceeded its output bound');
    if (/[^\x09\x0a\x0d\x20-\x7e]/.test(String(result.stdout || ''))) throw new MpsError('MPS control reply is not ASCII');
    return String(result.stdout || '');
}
export function configureMpsDefaults(value, { control = runMpsControl, env, uid = process.getuid?.(), query, verifyServer = () => false } = {}) {
    validateMpsDefault(value);
    const options = { env, uid, ...(query ? { query } : {}) };
    control(`set_default_active_thread_percentage ${value.smPercent}`, options);
    control(`set_default_device_pinned_mem_limit 0 ${value.memoryMiB}M`, options);
    const sm = parseMpsSmReply(control('get_default_active_thread_percentage', options));
    const memoryBytes = parseMpsMemoryReply(control('get_default_device_pinned_mem_limit 0', options));
    if (sm !== value.smPercent || memoryBytes !== value.memoryMiB * 1048576) throw new MpsError('MPS default readback does not match configuration');
    for (const pid of parseMpsServerList(control('get_server_list', options))) if (verifyServer(pid) !== true) throw new MpsError('MPS server process ownership is not proven');
    return Object.freeze({ smPercent: sm, memoryMiB: value.memoryMiB });
}

function privateDirectory(target, { fsApi, uid, create = false }) {
    if (create) { try { fsApi.mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const stat = fsApi.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fsApi.realpathSync(target) !== target || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) throw new MpsError('MPS directory ownership or mode is unsafe');
}
function readBounded(target, { fsApi, maxBytes, uid, privateMode = false }) {
    const fd = fsApi.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fsApi.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.size > maxBytes || (privateMode && (stat.mode & 0o777) !== 0o600)) throw new MpsError('MPS state file is unsafe');
        const buffer = Buffer.alloc(maxBytes + 1);
        const count = fsApi.readSync(fd, buffer, 0, buffer.length, 0);
        if (count > maxBytes) throw new MpsError('MPS file exceeds its bound');
        return buffer.subarray(0, count).toString('utf8');
    } finally { fsApi.closeSync(fd); }
}
// A journaled client's alias: the registry's own spelling, or '' for the
// canonical instance. Journals written before aliases were recorded omit it.
export function isMpsClientAlias(value) {
    return value === '' || (typeof value === 'string' && Buffer.byteLength(value) <= 1024
        && AGENT_ALIAS_PATTERN.test(value) && !RESERVED_AGENT_REGISTRY_KEYS.has(value));
}
function validateMpsState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1
        || !['inactive', 'ready', 'starting', 'transitioning', 'pending'].includes(value.status)) throw new MpsError('Unsupported private MPS state');
    for (const field of ['oldClients', 'desiredClients', 'pendingClients']) {
        if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].length > 256
            || value[field].some((client) => !client || typeof client !== 'object' || typeof client.key !== 'string' || !client.key || Buffer.byteLength(client.key) > 1024
                || (Object.hasOwn(client, 'alias') && !isMpsClientAlias(client.alias))))) throw new MpsError('Invalid private MPS client cohort');
    }
    if (value.drainedClients !== undefined && (!Array.isArray(value.drainedClients) || value.drainedClients.length > 512
        || value.drainedClients.some((entry) => typeof entry !== 'string' || Buffer.byteLength(entry) > 4096))) throw new MpsError('Invalid private MPS drain receipts');
    return value;
}

export function createMpsStateStore({ root = MPS_ROOT, fsApi = fs, uid = process.getuid?.() } = {}) {
    const assert = (create = false) => { assertUid(uid); privateDirectory(root, { fsApi, uid, create }); };
    return {
        root,
        read() {
            try { assert(); return validateMpsState(JSON.parse(readBounded(path.join(root, 'state.json'), { fsApi, maxBytes: STATE_BOUND, uid, privateMode: true })));  }
            catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        },
        write(value) {
            assert(true);
            const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
            if (bytes.length > STATE_BOUND) throw new MpsError('MPS transition state exceeds its bound');
            validateMpsState(value);
            const temporary = path.join(root, `.state-${crypto.randomBytes(16).toString('hex')}`);
            const fd = fsApi.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
            try { fsApi.writeFileSync(fd, bytes); fsApi.fsyncSync(fd); } finally { fsApi.closeSync(fd); }
            try { assert(); fsApi.renameSync(temporary, path.join(root, 'state.json')); const directoryFd = fsApi.openSync(root, fs.constants.O_RDONLY); try { fsApi.fsyncSync(directoryFd); } finally { fsApi.closeSync(directoryFd); } }
            finally { try { fsApi.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
        },
    };
}

export function observeOwnedMpsDaemon(state, { fsApi = fs, procRoot = '/proc', uid = process.getuid?.() } = {}) {
    assertUid(uid);
    if (!state?.daemon || !safeInteger(state.daemon.pid, 1, 2147483647) || !/^\d+$/.test(String(state.daemon.startTime || ''))) return { state: 'unknown' };
    const daemon = state.daemon;
    let processObserved = false;
    try {
        const fields = String(fsApi.readFileSync(`${procRoot}/${daemon.pid}/stat`, 'utf8')).replace(/^.*\) /, '').split(' ');
        if (fields[0] === 'Z' || fields[19] !== daemon.startTime) return { state: 'gone' };
        processObserved = true;
        privateDirectory(state.pipeDirectory, { fsApi, uid });
        const pipe = fsApi.lstatSync(state.pipeDirectory);
        if (!state.pipeIdentity || pipe.dev !== state.pipeIdentity.dev || pipe.ino !== state.pipeIdentity.ino) return { state: 'foreign' };
        const status = String(fsApi.readFileSync(`${procRoot}/${daemon.pid}/status`, 'utf8'));
        if (!new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}\\s*$`, 'm').test(status)) return { state: 'foreign' };
        const binary = fsApi.statSync(`${procRoot}/${daemon.pid}/exe`);
        if (binary.dev !== daemon.executableDev || binary.ino !== daemon.executableIno) return { state: 'foreign' };
        const cgroup = String(fsApi.readFileSync(`${procRoot}/${daemon.pid}/cgroup`, 'utf8')).trim();
        if (cgroup !== '0::/ploinky/core') return { state: 'foreign' };
        const env = fsApi.readFileSync(`${procRoot}/${daemon.pid}/environ`);
        if (env.length > 8192 || !env.toString().split('\0').includes(`CUDA_MPS_PIPE_DIRECTORY=${state.pipeDirectory}`)) return { state: 'foreign' };
        const pidText = readBounded(path.join(state.pipeDirectory, 'nvidia-cuda-mps-control.pid'), { fsApi, maxBytes: 64, uid });
        if (String(daemon.pid) !== pidText.trim()) return { state: 'foreign' };
        return { state: 'owned', daemon };
    } catch (error) { return { state: error.code === 'ENOENT' && !processObserved ? 'gone' : 'unknown' }; }
}

export function observeOwnedMpsServer(state, pid, { fsApi = fs, procRoot = '/proc', uid = process.getuid?.() } = {}) {
    assertUid(uid);
    if (!safeInteger(pid, 1, 2147483647) || !state?.tools?.server) return false;
    try {
        const status = String(fsApi.readFileSync(`${procRoot}/${pid}/status`, 'utf8'));
        const executable = fsApi.statSync(`${procRoot}/${pid}/exe`);
        const env = fsApi.readFileSync(`${procRoot}/${pid}/environ`);
        return new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}\\s*$`, 'm').test(status)
            && executable.dev === state.tools.server.dev && executable.ino === state.tools.server.ino
            && String(fsApi.readFileSync(`${procRoot}/${pid}/cgroup`, 'utf8')).trim() === '0::/ploinky/core'
            && env.length <= 8192 && env.toString().split('\0').includes(`CUDA_MPS_PIPE_DIRECTORY=${state.pipeDirectory}`);
    } catch (_) { return false; }
}

export function recoverMpsDaemonIdentity(state, { fsApi = fs, procRoot = '/proc', uid = process.getuid?.() } = {}) {
    assertUid(uid);
    if (state?.daemon) return observeOwnedMpsDaemon(state, { fsApi, procRoot, uid });
    if (!state?.pipeDirectory) return { state: 'gone' };
    if (!state?.tools?.control) return { state: 'unknown' };
    try {
        const pidText = readBounded(path.join(state.pipeDirectory, 'nvidia-cuda-mps-control.pid'), { fsApi, maxBytes: 64, uid }).trim();
        if (!/^[1-9]\d*$/.test(pidText) || !safeInteger(Number(pidText), 1, 2147483647)) return { state: 'unknown' };
        const fields = String(fsApi.readFileSync(`${procRoot}/${pidText}/stat`, 'utf8')).replace(/^.*\) /, '').split(' ');
        const binary = fsApi.statSync(`${procRoot}/${pidText}/exe`);
        if (binary.dev !== state.tools.control.dev || binary.ino !== state.tools.control.ino) return { state: 'foreign' };
        const daemon = { pid: Number(pidText), startTime: fields[19], executableDev: binary.dev, executableIno: binary.ino };
        return observeOwnedMpsDaemon({ ...state, daemon }, { fsApi, procRoot, uid });
    } catch (error) {
        if (error.code !== 'ENOENT') return { state: 'unknown' };
        // A crash during -d can precede its PID receipt. Do not equate the
        // missing receipt with absence while an exact launcher is still live.
        try {
            const entries = fsApi.readdirSync(procRoot).filter((entry) => /^[1-9]\d*$/.test(entry));
            if (entries.length > 4096) return { state: 'unknown' };
            const absentNow = (pid) => {
                try {
                    const fields = String(fsApi.readFileSync(`${procRoot}/${pid}/stat`, 'utf8')).replace(/^.*\) /, '').split(' ');
                    return fields.length >= 20 && /^\d+$/.test(fields[19]) && fields[0] === 'Z';
                } catch (error) { return error.code === 'ENOENT'; }
            };
            for (const pid of entries) {
                let matchingExecutable = false;
                try {
                    const binary = fsApi.statSync(`${procRoot}/${pid}/exe`);
                    if (binary.dev !== state.tools.control.dev || binary.ino !== state.tools.control.ino) continue;
                    matchingExecutable = true;
                    const env = fsApi.readFileSync(`${procRoot}/${pid}/environ`);
                    if (env.length > 8192) {
                        if (absentNow(pid)) continue;
                        return { state: 'unknown' };
                    }
                    if (env.toString().split('\0').includes(`CUDA_MPS_PIPE_DIRECTORY=${state.pipeDirectory}`)) return { state: 'unknown' };
                } catch (inspectionError) {
                    // A matching executable may still use these pipes. Failure
                    // to inspect its environment never proves termination.
                    if (matchingExecutable) {
                        if (absentNow(pid)) continue;
                        return { state: 'unknown' };
                    }
                    if (!['ENOENT', 'EACCES', 'EPERM'].includes(inspectionError.code)) return { state: 'unknown' };
                }
            }
            return { state: 'gone' };
        } catch (_) { return { state: 'unknown' }; }
    }
}

export function discoverOwnedMpsDaemon({ root = MPS_ROOT, tools, fsApi = fs, uid = process.getuid?.() } = {}) {
    assertUid(uid);
    let entries;
    try { privateDirectory(root, { fsApi, uid }); entries = fsApi.readdirSync(root); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (entries.length > 512) throw new MpsError('MPS generation directories exceed the observation bound');
    let recovered = null;
    for (const entry of entries.filter((value) => /^pipe-[a-f0-9]{32}$/.test(value))) {
        const pipeDirectory = path.join(root, entry);
        privateDirectory(pipeDirectory, { fsApi, uid });
        const stat = fsApi.lstatSync(pipeDirectory);
        const candidate = { schema: 1, daemon: null, daemonGeneration: crypto.randomUUID(), configurationGeneration: crypto.randomUUID(), serverDefault: null, pipeDirectory, logDirectory: path.join(root, entry.replace(/^pipe-/, 'log-')), pipeIdentity: { dev: stat.dev, ino: stat.ino }, tools, status: 'pending', oldClients: [], pendingClients: [], lastProblem: null };
        const observed = recoverMpsDaemonIdentity(candidate, { fsApi, uid });
        if (observed.state === 'gone') continue;
        if (observed.state !== 'owned' || recovered) throw new MpsError('An unjournaled MPS generation cannot be owned unambiguously');
        privateDirectory(candidate.logDirectory, { fsApi, uid });
        const log = fsApi.lstatSync(candidate.logDirectory); candidate.logIdentity = { dev: log.dev, ino: log.ino };
        recovered = { ...candidate, daemon: observed.daemon };
    }
    return recovered;
}

export function cleanupMpsGeneration(state, { root = MPS_ROOT, fsApi = fs, uid = process.getuid?.() } = {}) {
    assertUid(uid);
    if (state?.pipeDirectory && (state.daemon ? observeOwnedMpsDaemon(state, { fsApi, uid }) : recoverMpsDaemonIdentity(state, { fsApi, uid })).state !== 'gone') throw new MpsError('MPS generation cleanup requires exact daemon termination');
    for (const [directory, identity, prefix] of [[state.pipeDirectory, state.pipeIdentity, 'pipe'], [state.logDirectory, state.logIdentity, 'log']]) {
        if (!directory) continue;
        if (path.dirname(directory) !== root || !new RegExp(`^${prefix}-[a-f0-9]{32}$`).test(path.basename(directory))) throw new MpsError('MPS cleanup path is outside its owned generation');
        try { privateDirectory(directory, { fsApi, uid }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const stat = fsApi.lstatSync(directory);
        if (!identity || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new MpsError('MPS cleanup directory identity changed');
        const entries = fsApi.readdirSync(directory);
        if (entries.length > 256) throw new MpsError('MPS cleanup entry count exceeds its bound');
        for (const name of entries) {
            const target = path.join(directory, name); const item = fsApi.lstatSync(target);
            if (item.uid !== uid || item.isSymbolicLink() || item.isDirectory() || (!item.isFile() && !item.isSocket() && !item.isFIFO())) throw new MpsError('MPS cleanup found an unowned or unsupported entry');
        }
        for (const name of entries) fsApi.unlinkSync(path.join(directory, name));
        fsApi.rmdirSync(directory);
    }
}

export function createMpsDaemonBackend({ root = MPS_ROOT, fsApi = fs, query = spawnSync, uid = process.getuid?.(), now = Date.now, wait = sleep, observe = observeOwnedMpsDaemon } = {}) {
    const envFor = (state) => ({ PATH: '/usr/local/nvidia/bin:/usr/bin:/bin', LD_LIBRARY_PATH: '/usr/local/nvidia/lib64', CUDA_VISIBLE_DEVICES: '0', CUDA_MPS_PIPE_DIRECTORY: state.pipeDirectory, CUDA_MPS_LOG_DIRECTORY: state.logDirectory });
    const checkDirectories = (state) => {
        if (path.dirname(state.pipeDirectory || '') !== root || !/^pipe-[a-f0-9]{32}$/.test(path.basename(state.pipeDirectory || '')) || path.dirname(state.logDirectory || '') !== root || !/^log-[a-f0-9]{32}$/.test(path.basename(state.logDirectory || ''))) throw new MpsError('MPS paths are outside the exact private generation');
        for (const target of [root, state.pipeDirectory, state.logDirectory]) privateDirectory(target, { fsApi, uid });
    };
    // The exact private generation paths, the pipe directory absent and the
    // log directory absent or still private: what an interrupted cleanup leaves.
    const generationDirectoriesRemoved = (state) => {
        if (path.dirname(state?.pipeDirectory || '') !== root || !/^pipe-[a-f0-9]{32}$/.test(path.basename(state?.pipeDirectory || ''))
            || path.dirname(state?.logDirectory || '') !== root || !/^log-[a-f0-9]{32}$/.test(path.basename(state?.logDirectory || ''))) return false;
        const absent = (target) => { try { fsApi.lstatSync(target); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
        try {
            privateDirectory(root, { fsApi, uid });
            if (!absent(state.pipeDirectory)) return false;
            if (!absent(state.logDirectory)) privateDirectory(state.logDirectory, { fsApi, uid });
            return true;
        } catch (_) { return false; }
    };
    const control = (state, command, { deadline = Infinity } = {}) => { assertUid(uid); if (now() >= deadline) throw new MpsError('MPS operation exceeded its deadline'); checkDirectories(state); if (observe(state, { fsApi, uid }).state !== 'owned') throw new MpsError('The exact MPS daemon is not live and owned'); return runMpsControl(command, { env: envFor(state), query, uid, timeoutMs: Math.max(1, Math.min(5000, deadline - now())) }); };
    return {
        discover: (tools) => discoverOwnedMpsDaemon({ root, tools, fsApi, uid }),
        cleanup: (state) => cleanupMpsGeneration(state, { root, fsApi, uid }),
        observe: (state) => {
            try { checkDirectories(state); } catch (_) {
                // Cleanup may have removed this exact generation before the
                // journal dropped its paths. Missing generation directories
                // are gone only after the /proc scan proves no owned daemon.
                if (!generationDirectoriesRemoved(state)) return { state: 'unknown' };
                const scan = state?.daemon ? observe(state, { fsApi, uid }) : recoverMpsDaemonIdentity(state, { fsApi, uid });
                return scan.state === 'gone' ? { state: 'gone' } : { state: 'unknown' };
            }
            return state?.daemon ? observe(state, { fsApi, uid }) : recoverMpsDaemonIdentity(state, { fsApi, uid });
        },
        control,
        start(defaults, { tools, configurationGeneration = crypto.randomUUID(), onState = () => {} } = {}) {
            assertUid(uid); validateMpsDefault(defaults); revalidateMpsTools(tools, { fsApi, mounted: true });
            if (String(fsApi.readFileSync('/proc/self/cgroup', 'utf8')).trim() !== '0::/ploinky/core') throw new MpsError('MPS daemon must inherit /ploinky/core');
            privateDirectory(root, { fsApi, uid, create: true });
            if (discoverOwnedMpsDaemon({ root, tools, fsApi, uid })) throw new MpsError('An owned MPS daemon must be drained and stopped before starting another generation');
            const suffix = crypto.randomBytes(16).toString('hex');
            const state = { schema: 1, daemonGeneration: crypto.randomUUID(), configurationGeneration, serverDefault: defaults, pipeDirectory: path.join(root, `pipe-${suffix}`), logDirectory: path.join(root, `log-${suffix}`), tools, daemon: null, status: 'starting', pendingClients: [], lastProblem: null };
            for (const directory of [state.pipeDirectory, state.logDirectory]) privateDirectory(directory, { fsApi, uid, create: true });
            const pipe = fsApi.lstatSync(state.pipeDirectory); state.pipeIdentity = { dev: pipe.dev, ino: pipe.ino };
            const log = fsApi.lstatSync(state.logDirectory); state.logIdentity = { dev: log.dev, ino: log.ino };
            onState(state);
            const deadline = now() + 30_000;
            const launch = query(MPS_TOOL_PATHS.control, ['-d'], { detached: true, stdio: 'ignore', env: envFor(state), timeout: 5000 });
            if (launch.status !== 0 || launch.error || launch.signal) throw new MpsError('MPS daemon start failed or timed out');
            do {
                try {
                    const pidText = readBounded(path.join(state.pipeDirectory, 'nvidia-cuda-mps-control.pid'), { fsApi, maxBytes: 64, uid }).trim();
                    if (!/^[1-9]\d*$/.test(pidText) || !safeInteger(Number(pidText), 1, 2147483647)) throw new MpsError('MPS daemon PID is invalid');
                    const fields = String(fsApi.readFileSync(`/proc/${pidText}/stat`, 'utf8')).replace(/^.*\) /, '').split(' ');
                    const executable = fsApi.statSync(`/proc/${pidText}/exe`);
                    if (executable.dev !== tools.control.dev || executable.ino !== tools.control.ino) throw new MpsError('MPS daemon executable identity changed');
                    state.daemon = { pid: Number(pidText), startTime: fields[19], executableDev: executable.dev, executableIno: executable.ino };
                    onState(state);
                    if (observe(state, { fsApi, uid }).state !== 'owned') throw new MpsError('MPS daemon ownership is not proven');
                    configureMpsDefaults(defaults, { control: (command) => control(state, command, { deadline }), uid, verifyServer: (pid) => observeOwnedMpsServer(state, pid, { fsApi, uid }) });
                    state.status = 'ready'; return state;
                } catch (error) { if (now() >= deadline) throw new MpsError(`MPS daemon readiness failed: ${String(error.message).slice(0, 200)}`); wait(100); }
            } while (now() < deadline);
            throw new MpsError('MPS daemon readiness timed out');
        },
        verify(state) {
            try { checkDirectories(state); } catch (_) { return false; }
            if (observe(state, { fsApi, uid }).state !== 'owned') return false;
            try { const sm = parseMpsSmReply(control(state, 'get_default_active_thread_percentage')); const memory = parseMpsMemoryReply(control(state, 'get_default_device_pinned_mem_limit 0')); const servers = parseMpsServerList(control(state, 'get_server_list')); return sm === state.serverDefault.smPercent && memory === state.serverDefault.memoryMiB * 1048576 && servers.every((pid) => observeOwnedMpsServer(state, pid, { fsApi, uid })); } catch (_) { return false; }
        },
        stop(state) {
            const observed = observe(state, { fsApi, uid });
            if (observed.state === 'gone') return;
            if (observed.state !== 'owned') throw new MpsError('Refusing to stop a foreign or unknown MPS daemon');
            const deadline = now() + 30_000;
            control(state, 'quit', { deadline });
            do {
                try {
                    const fields = String(fsApi.readFileSync(`/proc/${state.daemon.pid}/stat`, 'utf8')).replace(/^.*\) /, '').split(' ');
                    if (fields[0] === 'Z' || fields[19] !== state.daemon.startTime) return;
                } catch (error) { if (error.code === 'ENOENT') return; throw new MpsError('MPS process termination cannot be proved'); }
                wait(100);
            } while (now() < deadline);
            throw new MpsError('MPS daemon did not terminate before its deadline');
        },
    };
}
