import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MPS_TOOL_PATHS, revalidateMpsTools } from '../../../ploinky-box/lib/mpsTools.mjs';
import { MpsError } from './mpsEligibility.mjs';
import { commandFailureDetail, markApplyStep, replyExcerpt } from './applyCause.mjs';
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
// The backend's verification decision, with the reason when it refuses. The decision is always `verify`'s (a caller may
// wrap or replace it); the reason is asked only after a refusal and is best effort.
export function verifyDetail(backend, state) {
    if (backend.verify(state)) return { ok: true, reason: null };
    let reason = null;
    try { const detail = typeof backend.verifyReason === 'function' ? backend.verifyReason(state) : null; reason = detail && detail.ok === false ? detail.reason : null; } catch (_) { /* the reason is optional */ }
    return { ok: false, reason };
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
    // An integer 1..100, optionally with a zero-only fraction (`25`, `25.0`): the same integer, never another number.
    if (!/^(?:100|[1-9]\d?)(?:\.0+)?$/.test(value)) throw new MpsError(`Unsupported MPS SM default reply (reply: "${replyExcerpt(text)}")`);
    return Number(value);
}
// Only the complete explicit M/G unit form is supported. LIVE-P1 must capture
// the selected driver's exact reply; an unrecognized ABI refuses sharing.
export function parseMpsMemoryReply(text) {
    const match = /^([1-9]\d*)([MG])$/.exec(String(text || '').trim());
    if (!match) throw new MpsError(`Unsupported MPS device-memory default reply (reply: "${replyExcerpt(text)}")`);
    const bytes = Number(match[1]) * (match[2] === 'M' ? 1048576 : 1073741824);
    if (!Number.isSafeInteger(bytes)) throw new MpsError('MPS memory reply exceeds supported bounds');
    return bytes;
}
export function parseMpsServerList(text) {
    const value = String(text || '').trim();
    if (!value) return [];
    const lines = value.split('\n');
    if (lines.length > 256 || lines.some((line) => !/^[1-9]\d*$/.test(line) || !safeInteger(Number(line), 1, 2147483647))) throw new MpsError(`Unsupported MPS server-list reply (reply: "${replyExcerpt(text)}")`);
    return [...new Set(lines.map(Number))];
}
const COMMAND = /^(?:set_default_active_thread_percentage (?:[1-9]\d?|100)|get_default_active_thread_percentage|set_default_device_pinned_mem_limit 0 [1-9]\d*M|get_default_device_pinned_mem_limit 0|get_server_list|quit)$/;
export function runMpsControl(command, { env, query = spawnSync, uid = process.getuid?.(), timeoutMs = 5000 } = {}) {
    assertUid(uid);
    if (typeof command !== 'string' || !COMMAND.test(command) || command.length > 200) throw new MpsError('Unsupported MPS control command');
    const result = query(MPS_TOOL_PATHS.control, [], { input: `${command}\n`, encoding: 'utf8', env, timeout: Math.min(timeoutMs, 5000), maxBuffer: OUTPUT_BOUND, stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.status !== 0 || result.signal || result.error || result.truncated || Buffer.byteLength(String(result.stdout || '')) > OUTPUT_BOUND || Buffer.byteLength(String(result.stderr || '')) > OUTPUT_BOUND) throw new MpsError(`MPS control failed, timed out or exceeded its output bound${commandFailureDetail(result)}`);
    if (/[^\x09\x0a\x0d\x20-\x7e]/.test(String(result.stdout || ''))) throw Object.defineProperty(new MpsError(`MPS control reply is not ASCII (reply: "${replyExcerpt(result.stdout)}")`), 'reply', { value: String(result.stdout) });
    return String(result.stdout || '');
}
const READBACK_KIND = Object.freeze({ get_default_active_thread_percentage: 'sm', 'get_default_device_pinned_mem_limit 0': 'memory', get_server_list: 'servers' });
export function configureMpsDefaults(value, { control = runMpsControl, env, uid = process.getuid?.(), query, verifyServer = () => false, explainServer = () => null, onReadback = () => {} } = {}) {
    validateMpsDefault(value);
    const options = { env, uid, ...(query ? { query } : {}) };
    control(`set_default_active_thread_percentage ${value.smPercent}`, options);
    control(`set_default_device_pinned_mem_limit 0 ${value.memoryMiB}M`, options);
    // Each reply is recorded (sanitized, bounded) before it is judged, so a refused reply is on the record too.
    const smReply = control('get_default_active_thread_percentage', options); onReadback('sm', smReply);
    const sm = parseMpsSmReply(smReply);
    const memoryReply = control('get_default_device_pinned_mem_limit 0', options); onReadback('memory', memoryReply);
    const memoryBytes = parseMpsMemoryReply(memoryReply);
    if (sm !== value.smPercent || memoryBytes !== value.memoryMiB * 1048576) throw new MpsError(`MPS default readback does not match configuration (requested ${value.smPercent}% and ${value.memoryMiB}M; read ${sm}% and ${memoryBytes} bytes)`);
    const serverReply = control('get_server_list', options); onReadback('servers', serverReply);
    for (const pid of parseMpsServerList(serverReply)) if (verifyServer(pid) !== true) throw new MpsError(`MPS server process ownership is not proven (server ${pid}${explainServer(pid) ? `: ${explainServer(pid)}` : ''})`);
    return Object.freeze({ smPercent: sm, memoryMiB: value.memoryMiB });
}

function privateDirectory(target, { fsApi, uid, create = false }) {
    if (create) { try { fsApi.mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const stat = fsApi.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fsApi.realpathSync(target) !== target || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
        // The decision is unchanged; the reason names what differed (an lstat failure is its own errno, thrown above).
        const real = (() => { try { return fsApi.realpathSync(target); } catch (error) { return `unresolvable (${error.code || 'error'})`; } })();
        const problems = [stat.isSymbolicLink() && 'a symbolic link', !stat.isDirectory() && 'not a directory', real !== target && `realpath ${String(real).slice(0, 80)}`,
            stat.uid !== uid && `uid ${stat.uid} (expected ${uid})`, (stat.mode & 0o777) !== 0o700 && `mode ${(stat.mode & 0o777).toString(8)} (expected 700)`].filter(Boolean);
        throw new MpsError(`MPS directory ownership or mode is unsafe (${String(target).slice(-60)}: ${problems.join(', ')})`);
    }
}
function readBounded(target, { fsApi, maxBytes, uid, privateMode = false }) {
    const fd = fsApi.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fsApi.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.size > maxBytes || (privateMode && (stat.mode & 0o777) !== 0o600)) {
            const problems = [!stat.isFile() && 'not a regular file', stat.nlink !== 1 && `${stat.nlink} links`, stat.uid !== uid && `uid ${stat.uid} (expected ${uid})`,
                stat.size > maxBytes && `size ${stat.size} over ${maxBytes}`, privateMode && (stat.mode & 0o777) !== 0o600 && `mode ${(stat.mode & 0o777).toString(8)} (expected 600)`].filter(Boolean);
            throw new MpsError(`MPS state file is unsafe (${path.basename(String(target))}: ${problems.join(', ')})`);
        }
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

// What the proof of ownership concluded, and why: `reason` is bounded and secret-free (an errno, an uid, a mode, a
// path component), never an environment or a command line. The decision is the state, as before.
export function observeOwnedMpsDaemon(state, { fsApi = fs, procRoot = '/proc', uid = process.getuid?.() } = {}) {
    assertUid(uid);
    if (!state?.daemon || !safeInteger(state.daemon.pid, 1, 2147483647) || !/^\d+$/.test(String(state.daemon.startTime || ''))) return { state: 'unknown', reason: 'the journal names no valid daemon pid and start time' };
    const daemon = state.daemon;
    let processObserved = false;
    let reading = 'the process';
    const refuse = (verdict, reason) => ({ state: verdict, reason: String(reason).slice(0, 160) });
    try {
        reading = `${procRoot}/${daemon.pid}/stat`;
        const fields = String(fsApi.readFileSync(reading, 'utf8')).replace(/^.*\) /, '').split(' ');
        if (fields[0] === 'Z') return refuse('gone', 'the process is a zombie');
        if (fields[19] !== daemon.startTime) return refuse('gone', `the pid now has start time ${String(fields[19]).slice(0, 20)}, not ${daemon.startTime}`);
        processObserved = true;
        reading = state.pipeDirectory;
        privateDirectory(state.pipeDirectory, { fsApi, uid });
        const pipe = fsApi.lstatSync(state.pipeDirectory);
        if (!state.pipeIdentity || pipe.dev !== state.pipeIdentity.dev || pipe.ino !== state.pipeIdentity.ino) return refuse('foreign', 'the pipe directory is not the journaled one (device or inode differs)');
        reading = `${procRoot}/${daemon.pid}/status`;
        const status = String(fsApi.readFileSync(reading, 'utf8'));
        if (!new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}\\s*$`, 'm').test(status)) return refuse('foreign', `the daemon's Uid line is ${(/^Uid:\s*(.*)$/m.exec(status)?.[1] || 'missing').replace(/\s+/g, ' ').slice(0, 40)}, not ${uid}`);
        reading = `${procRoot}/${daemon.pid}/exe`;
        const binary = fsApi.statSync(reading);
        if (binary.dev !== daemon.executableDev || binary.ino !== daemon.executableIno) return refuse('foreign', 'the executable is not the journaled MPS control binary (device or inode differs)');
        reading = `${procRoot}/${daemon.pid}/cgroup`;
        const cgroup = String(fsApi.readFileSync(reading, 'utf8')).trim();
        if (cgroup !== '0::/ploinky/core') return refuse('foreign', `the daemon's cgroup is ${cgroup.slice(0, 80)}, not 0::/ploinky/core`);
        reading = `${procRoot}/${daemon.pid}/environ`;
        const env = fsApi.readFileSync(reading);
        if (env.length > 8192) return refuse('foreign', `the environment is ${env.length} bytes, over 8192`);
        if (!env.toString().split('\0').includes(`CUDA_MPS_PIPE_DIRECTORY=${state.pipeDirectory}`)) return refuse('foreign', 'the daemon environment does not name the private pipe directory');
        reading = `${path.join(state.pipeDirectory, 'nvidia-cuda-mps-control.pid')}`;
        const pidText = readBounded(reading, { fsApi, maxBytes: 64, uid });
        if (String(daemon.pid) !== pidText.trim()) return refuse('foreign', `the pid file says ${pidText.trim().slice(0, 20)}, not ${daemon.pid}`);
        return { state: 'owned', daemon };
    } catch (error) {
        return refuse(error.code === 'ENOENT' && !processObserved ? 'gone' : 'unknown', `${error.code || error.name || 'error'} while reading ${String(reading).slice(-70)}${error.code ? '' : `: ${String(error.message).slice(0, 80)}`}`);
    }
}

// Whether a pid is an owned MPS server, and why not.
export function inspectOwnedMpsServer(state, pid, { fsApi = fs, procRoot = '/proc', uid = process.getuid?.() } = {}) {
    assertUid(uid);
    if (!safeInteger(pid, 1, 2147483647) || !state?.tools?.server) return { owned: false, reason: 'no valid pid or no journaled server tool' };
    let reading = 'the process';
    try {
        reading = `${procRoot}/${pid}/status`;
        const status = String(fsApi.readFileSync(reading, 'utf8'));
        if (!new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}\\s*$`, 'm').test(status)) return { owned: false, reason: `the Uid line is ${(/^Uid:\s*(.*)$/m.exec(status)?.[1] || 'missing').replace(/\s+/g, ' ').slice(0, 40)}, not ${uid}` };
        reading = `${procRoot}/${pid}/exe`;
        const executable = fsApi.statSync(reading);
        if (executable.dev !== state.tools.server.dev || executable.ino !== state.tools.server.ino) return { owned: false, reason: 'the executable is not the journaled MPS server tool' };
        reading = `${procRoot}/${pid}/cgroup`;
        const cgroup = String(fsApi.readFileSync(reading, 'utf8')).trim();
        if (cgroup !== '0::/ploinky/core') return { owned: false, reason: `the cgroup is ${cgroup.slice(0, 80)}, not 0::/ploinky/core` };
        reading = `${procRoot}/${pid}/environ`;
        const env = fsApi.readFileSync(reading);
        if (env.length > 8192) return { owned: false, reason: `the environment is ${env.length} bytes, over 8192` };
        if (!env.toString().split('\0').includes(`CUDA_MPS_PIPE_DIRECTORY=${state.pipeDirectory}`)) return { owned: false, reason: 'the environment does not name the private pipe directory' };
        return { owned: true, reason: null };
    } catch (error) { return { owned: false, reason: `${error.code || error.name || 'error'} while reading ${String(reading).slice(-70)}` }; }
}
export function observeOwnedMpsServer(state, pid, options) { return inspectOwnedMpsServer(state, pid, options).owned; }

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
    const control = (state, command, { deadline = Infinity } = {}) => { assertUid(uid); if (now() >= deadline) throw new MpsError('MPS operation exceeded its deadline'); checkDirectories(state); { const owner = observe(state, { fsApi, uid }); if (owner.state !== 'owned') throw new MpsError(`The exact MPS daemon is not live and owned (${owner.state}${owner.reason ? `: ${owner.reason}` : ''})`); } return runMpsControl(command, { env: envFor(state), query, uid, timeoutMs: Math.max(1, Math.min(5000, deadline - now())) }); };
    const backend = {
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
            assertUid(uid); validateMpsDefault(defaults);
            // The mounted tools are revalidated against the wiring's fingerprint. A drifted or unreadable tool is a typed
            // sharing refusal with its own reason, like every other prerequisite; the plain errors of the fingerprint helper
            // carry no code and would otherwise surface as a generic Apply failure.
            try { revalidateMpsTools(tools, { fsApi, mounted: true }); } catch (error) { throw new MpsError(`The mounted MPS tools no longer match the GPU wiring: ${String(error?.message || error).slice(0, 200)}`); }
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
            if (launch.status !== 0 || launch.error || launch.signal) throw new MpsError(`MPS daemon start failed or timed out${commandFailureDetail(launch)}`);
            // The attempt's phase names where a failed readiness stopped: the PID receipt, the ownership proof or the defaults.
            let phase = 'pid receipt';
            // The last replies of the readback, sanitized and bounded, kept in the state on success and on failure: the
            // captured wire format of this driver (spec 18.8) whatever happens.
            const readback = {};
            // The last failed attempt, kept: whichever way the 30 s end (an attempt that fails after the deadline, or the
            // deadline passing during the wait), the final error names where it stopped and the reply it got.
            let last = null;
            const readinessFailure = (error, at) => { onState(state); return markApplyStep(new MpsError(`MPS daemon readiness failed at ${at}: ${String(error.message).slice(0, 200)}`), at === 'set defaults' ? 'set-defaults' : 'daemon-start'); };
            const record = (kind, text) => { readback[kind] = replyExcerpt(text); state.lastReadback = { at: now(), ...readback }; };
            do {
                try {
                    phase = 'pid receipt';
                    const pidText = readBounded(path.join(state.pipeDirectory, 'nvidia-cuda-mps-control.pid'), { fsApi, maxBytes: 64, uid }).trim();
                    if (!/^[1-9]\d*$/.test(pidText) || !safeInteger(Number(pidText), 1, 2147483647)) throw new MpsError('MPS daemon PID is invalid');
                    const fields = String(fsApi.readFileSync(`/proc/${pidText}/stat`, 'utf8')).replace(/^.*\) /, '').split(' ');
                    const executable = fsApi.statSync(`/proc/${pidText}/exe`);
                    if (executable.dev !== tools.control.dev || executable.ino !== tools.control.ino) throw new MpsError('MPS daemon executable identity changed');
                    state.daemon = { pid: Number(pidText), startTime: fields[19], executableDev: executable.dev, executableIno: executable.ino };
                    onState(state);
                    phase = 'ownership proof';
                    { const owner = observe(state, { fsApi, uid }); if (owner.state !== 'owned') throw new MpsError(`MPS daemon ownership is not proven (${owner.state}${owner.reason ? `: ${owner.reason}` : ''})`); }
                    phase = 'set defaults';
                    configureMpsDefaults(defaults, { control: (command) => {
                        try { return control(state, command, { deadline }); } catch (replyError) {
                            // A reply the transport itself refused (not ASCII) is still the daemon's reply: kept, sanitized.
                            if (typeof replyError?.reply === 'string') record(READBACK_KIND[command] || 'other', replyError.reply);
                            throw replyError;
                        }
                    }, uid, verifyServer: (pid) => observeOwnedMpsServer(state, pid, { fsApi, uid }), explainServer: (pid) => inspectOwnedMpsServer(state, pid, { fsApi, uid }).reason, onReadback: record });
                    state.status = 'ready'; return state;
                } catch (error) { last = { error, phase }; if (now() >= deadline) throw readinessFailure(error, phase); wait(100); }
            } while (now() < deadline);
            if (last) throw readinessFailure(last.error, last.phase);
            throw new MpsError('MPS daemon readiness timed out');
        },
        // Whether the daemon is the exact owned one with the saved defaults, and, when it is not, the step that failed with
        // a bounded, sanitized reason. `verify` keeps its boolean decision.
        verifyReason(state) {
            try { checkDirectories(state); } catch (error) { return { ok: false, reason: `directories: ${String(error.message).slice(0, 160)}` }; }
            const owner = observe(state, { fsApi, uid });
            if (owner.state !== 'owned') return { ok: false, reason: `ownership: ${owner.state}${owner.reason ? ` (${owner.reason})` : ''}` };
            let step = 'control';
            try {
                step = 'sm readback'; const sm = parseMpsSmReply(control(state, 'get_default_active_thread_percentage'));
                step = 'memory readback'; const memory = parseMpsMemoryReply(control(state, 'get_default_device_pinned_mem_limit 0'));
                step = 'server list'; const servers = parseMpsServerList(control(state, 'get_server_list'));
                if (sm !== state.serverDefault.smPercent) return { ok: false, reason: `sm readback ${sm}, not the saved ${state.serverDefault.smPercent}` };
                if (memory !== state.serverDefault.memoryMiB * 1048576) return { ok: false, reason: `memory readback ${memory} bytes, not the saved ${state.serverDefault.memoryMiB * 1048576}` };
                for (const pid of servers) { const server = inspectOwnedMpsServer(state, pid, { fsApi, uid }); if (!server.owned) return { ok: false, reason: `server ${pid} is not an owned MPS server (${server.reason})` }; }
                return { ok: true, reason: null };
            } catch (error) { return { ok: false, reason: `${step}: ${String(error?.message || error).slice(0, 200)}` }; }
        },
        verify(state) { return backend.verifyReason(state).ok; },
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
    return backend;
}
