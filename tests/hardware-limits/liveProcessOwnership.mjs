// Private, epoch-bound ownership for the optional local Apple acceptance action.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runBoundedProcess } from './liveProcess.mjs';

export const PROCESS_OWNER_ENV = 'PLOINKY_HWL_PROCESS_OWNER';
const MAX_FRAME = 8 * 1024 * 1024, MAX_ACTIVE = 64;
const workerPath = fileURLToPath(new URL('./liveProcessOwnedWorker.mjs', import.meta.url));
const random = () => crypto.randomBytes(16).toString('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && !value.includes('\0');
const failure = (errorCode = 'OWNERSHIP_TRANSPORT_FAILED', cancelled = false) => ({
    status: null, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false, cancelled, errorCode, settlementForced: false,
});
function checkBinding(binding) {
    if (!binding || !absolute(binding.runPath) || typeof binding.runId !== 'string' || !/^[a-f0-9]{32}$/.test(binding.runId)
        || !['provision', 'live', 'cleanup'].includes(binding.action)) throw Error('Invalid ownership binding');
    return { runPath: binding.runPath, runId: binding.runId, action: binding.action };
}
const matches = (a, b) => a?.runPath === b.runPath && a?.runId === b.runId && a?.action === b.action;
function privateDirectory(directory) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || fs.realpathSync(directory) !== directory || stat.uid !== process.getuid()
        || (stat.mode & 0o777) !== 0o700) throw Error('Invalid private ownership directory');
}
function readPrivate(file, maxBytes = 65536) {
    if (!absolute(file)) throw Error('Invalid private ownership path');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
            || stat.size < 2 || stat.size > maxBytes) throw Error('Invalid private ownership record');
        return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
}
function persist(file, value) {
    const temporary = `${file}.${random()}`;
    let fd;
    try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(temporary, file);
        const directory = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}
function frames(socket, receive, reject) {
    let buffer = Buffer.alloc(0), ended = false;
    socket.on('data', chunk => {
        if (ended) return;
        // Each side sends one bounded frame at a time; never buffer an unbounded stream.
        if (buffer.length + chunk.length > MAX_FRAME + 4) { ended = true; reject(); return; }
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
            const size = buffer.readUInt32BE(0);
            if (size < 2 || size > MAX_FRAME) { ended = true; reject(); return; }
            if (buffer.length < size + 4) return;
            const body = buffer.subarray(4, size + 4); buffer = buffer.subarray(size + 4);
            let value;
            try { value = JSON.parse(body.toString('utf8')); } catch { ended = true; reject(); return; }
            if (!value || typeof value !== 'object' || Array.isArray(value)) { ended = true; reject(); return; }
            receive(value);
            // Rejection is terminal even if another complete frame arrived in
            // the same read. Never admit a buffered command on a closed socket.
            if (socket.destroyed) { ended = true; return; }
        }
    });
    socket.on('end', () => { if (buffer.length) reject(); });
}
function send(socket, value) {
    const body = Buffer.from(JSON.stringify(value));
    if (body.length > MAX_FRAME) throw Error('Ownership frame exceeds bound');
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
    socket.write(Buffer.concat([header, body]));
}
function validateInvocation(binary, args, options) {
    if (!absolute(binary) || !absolute(options.cwd) || !Array.isArray(args)
        || args.some(value => typeof value !== 'string' || value.includes('\0'))
        || !Number.isInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 18_000_000
        || !Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 1048576
        || !(options.stdinPath === null || absolute(options.stdinPath))
        || !options.env || typeof options.env !== 'object' || Array.isArray(options.env)
        || Object.entries(options.env).some(([key, value]) => key.includes('\0') || key.includes('=') || typeof value !== 'string' || value.includes('\0')))
        throw Error('Invalid bounded ownership invocation');
}
function ps(args, deadline = Date.now() + 500) {
    const remaining = Math.min(500, deadline - Date.now());
    if (remaining < 1) throw Error('Ownership process query deadline');
    const result = spawnSync('/bin/ps', args, { encoding: 'utf8', timeout: remaining, maxBuffer: MAX_FRAME, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    if (result.error || result.signal || result.status !== 0) throw Error('Ownership process query failed');
    return result.stdout;
}
function workerIdentity(pid, identity, deadline) {
    const value = ps(['-p', String(pid), '-o', 'lstart=', '-o', 'command='], deadline).trim();
    if (!value.includes(`${workerPath} ${identity} `)) throw Error('Ownership worker identity mismatch');
    return value;
}
function inspectGroups(records, deadline = Date.now() + 500) {
    const rows = ps(['-axo', 'pid=,pgid=,stat='], deadline).trim().split('\n').filter(Boolean).map(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
        if (!match) throw Error('Unknown ownership process state');
        return { pid: Number(match[1]), pgid: Number(match[2]), state: match[3] };
    });
    return records.flatMap(record => {
        const live = rows.filter(row => row.pgid === record.pgid && !row.state.startsWith('Z'));
        if (!live.length) return [];
        let identityMatches = false;
        if (live.some(row => row.pid === record.pid) && record.workerIdentity) {
            try { identityMatches = workerIdentity(record.pid, record.identity, deadline) === record.workerIdentity; } catch {}
        }
        return [{ requestId: record.requestId, pid: record.pid, pgid: record.pgid, identityMatches, members: live.map(row => row.pid) }];
    });
}

export async function inspectOwnershipEvidence({ evidenceDirectory, binding }) {
    binding = checkBinding(binding);
    try {
        privateDirectory(evidenceDirectory);
        const registry = readPrivate(path.join(evidenceDirectory, 'ownership-registry.json'), MAX_FRAME);
        if (!matches(registry.binding, binding) || !/^[a-f0-9]{32}$/.test(registry.epoch) || !Array.isArray(registry.requests)
            || registry.requests.some(row => !Number.isSafeInteger(row.pid) || row.pid < 1 || row.pid !== row.pgid)) throw Error('Invalid registry');
        const unresolved = inspectGroups(registry.requests);
        // Recovery proves only absence of running groups, never a successful action.
        return { epoch: registry.epoch, action: binding.action, reason: registry.reason, settled: unresolved.length === 0,
            recovered: true, requests: registry.requests, unresolved };
    } catch {
        return { epoch: null, action: binding.action, reason: 'ownership-evidence-unreadable', settled: false, recovered: true, requests: [], unresolved: [{ error: 'OWNERSHIP_QUERY_FAILED' }] };
    }
}

export async function createOwnershipBroker({ binding, evidenceDirectory }) {
    binding = checkBinding(binding);
    privateDirectory(evidenceDirectory);
    // Fail before creating custody if the bounded POSIX observer is unavailable.
    inspectGroups([]);
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'hwo-')));
    fs.chmodSync(directory, 0o700);
    const epoch = random(), capability = random() + random();
    const descriptorPath = path.join(directory, 'owner.json'), socketPath = path.join(directory, 's');
    const records = new Map(), active = new Map(), sockets = new Set();
    const registryPath = path.join(evidenceDirectory, 'ownership-registry.json');
    let closed = false, reason = null, persistenceFailed = false, settledReceipt = null, closing;
    const save = () => persist(registryPath, { schema: 1, epoch, binding, reason, requests: [...records.values()] });
    const removeGate = gate => { try { fs.unlinkSync(gate); } catch (error) { if (error.code !== 'ENOENT') persistenceFailed = true; } };
    const closeAdmission = why => {
        const activeRequests = active.size;
        if (!closed) {
            closed = true; reason = String(why || 'closed').slice(0, 128);
            for (const entry of active.values()) { removeGate(entry.gate); entry.controller.abort(); }
            try { save(); } catch { persistenceFailed = true; }
        }
        return { activeRequests };
    };
    save();
    const server = net.createServer(socket => {
        if (sockets.size >= MAX_ACTIVE) { socket.destroy(); return; }
        sockets.add(socket); let entry = null, admitted = false;
        const handshake = setTimeout(() => socket.destroy(), 2000);
        const reject = () => { socket.destroy(); entry?.controller.abort(); };
        socket.on('error', reject);
        socket.on('close', () => { clearTimeout(handshake); sockets.delete(socket); entry?.controller.abort(); });
        frames(socket, message => {
            if (admitted) {
                if (message.type === 'cancel' && message.requestId === entry?.id) entry.controller.abort();
                else reject();
                return;
            }
            if (closed || message.type !== 'run' || message.epoch !== epoch || message.capability !== capability
                || !matches(message.binding, binding) || typeof message.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(message.requestId)
                || records.has(message.requestId) || active.size >= MAX_ACTIVE || records.size >= 65536) { reject(); return; }
            try { validateInvocation(message.binary, message.args, message.options); } catch { reject(); return; }
            admitted = true; clearTimeout(handshake);
            const id = message.requestId, identity = random(), gate = path.join(directory, identity);
            entry = { id, gate, controller: new AbortController() }; active.set(id, entry);
            const env = { ...message.options.env }; delete env[PROCESS_OWNER_ENV];
            const record = { epoch, requestId: id, identity, pid: null, pgid: null, workerIdentity: null, state: 'admitted', admittedAt: Date.now() };
            records.set(id, record);
            try { send(socket, { type: 'accepted', requestId: id }); } catch { reject(); }
            const spawnProcess = (_binary, _args, options) => {
                if (closed || entry.controller.signal.aborted) throw Error('Ownership admission closed');
                const child = spawn(process.execPath, [workerPath, identity, gate], {
                    cwd: options.cwd, env: { PATH: '/usr/bin:/bin' }, detached: true, shell: false,
                    stdio: [...options.stdio, 'ipc'],
                });
                record.pid = child.pid; record.pgid = child.pid; record.state = 'gated';
                try { save(); } catch { persistenceFailed = true; child.disconnect(); entry.controller.abort(); }
                child.on('message', value => {
                    if (value?.type === 'spawnError' || value?.type === 'workerError') entry.workerError = value.code;
                    if (value?.type === 'targetExit') entry.targetExit = { status: value.status, signal: value.signal };
                });
                child.once('message', ready => {
                    if (closed || entry.controller.signal.aborted) {
                        removeGate(gate); if (child.connected) child.disconnect(); return;
                    }
                    try {
                        if (ready?.type !== 'ready' || ready.identity !== identity) throw Error('Invalid worker handshake');
                        record.workerIdentity = workerIdentity(child.pid, identity);
                        record.state = 'released'; record.releasedAt = Date.now(); save();
                        // This revocable gate also covers a release already queued when admission closes.
                        fs.writeFileSync(gate, identity, { flag: 'wx', mode: 0o600 });
                        child.send({ type: 'release', identity, binary: message.binary, args: message.args, cwd: options.cwd, env }, error => {
                            if (error) { removeGate(gate); entry.controller.abort(); }
                        });
                    } catch { persistenceFailed = true; removeGate(gate); entry.controller.abort(); if (child.connected) child.disconnect(); }
                });
                return child;
            };
            runBoundedProcess(message.binary, message.args, { ...message.options, env, signal: entry.controller.signal, spawnProcess })
                .then(result => {
                    if (entry.workerError) result = { ...result, errorCode: entry.workerError, status: null, signal: null };
                    else if (entry.targetExit && !result.cancelled && !result.timedOut && !result.truncated && !result.errorCode)
                        result = { ...result, ...entry.targetExit };
                    removeGate(gate); record.state = 'terminal'; record.endedAt = Date.now();
                    record.result = { ...result }; delete record.result.stdout; delete record.result.stderr;
                    try { save(); } catch { persistenceFailed = true; result = failure('OWNERSHIP_REGISTRY_FAILED'); }
                    if (!socket.destroyed) { try { send(socket, { type: 'result', requestId: id, result }); socket.end(); } catch { reject(); } }
                }).catch(() => reject()).finally(() => active.delete(id));
        }, reject);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    fs.chmodSync(socketPath, 0o600);
    persist(descriptorPath, { schema: 1, epoch, capability, binding, socketPath });
    const settle = async ({ deadlineMs = 5000 } = {}) => {
        if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 5000) throw Error('Invalid ownership settlement bound');
        closeAdmission('settle');
        const deadline = Date.now() + deadlineMs;
        let unresolved = [];
        do {
            try { unresolved = inspectGroups([...records.values()].filter(row => row.pid), deadline); }
            catch { unresolved = [{ error: 'OWNERSHIP_QUERY_FAILED' }]; }
            if (active.size === 0 && unresolved.length === 0) break;
            if (Date.now() >= deadline) break;
            await pause(Math.min(25, Math.max(1, deadline - Date.now())));
        } while (true);
        settledReceipt = { epoch, action: binding.action, reason, settled: !persistenceFailed && active.size === 0 && unresolved.length === 0,
            requests: [...records.values()], unresolved, persistenceFailed };
        try { persist(path.join(evidenceDirectory, 'ownership-receipt.json'), settledReceipt); }
        catch { settledReceipt.settled = false; settledReceipt.persistenceFailed = true; }
        return settledReceipt;
    };
    const close = () => closing ||= (async () => {
        closeAdmission('close');
        if (!settledReceipt) await settle();
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
        if (settledReceipt.settled) fs.rmSync(directory, { recursive: true });
    })();
    return { descriptorPath, epoch, closeAdmission, settle, close };
}

export async function createOwnershipClient({ descriptorPath, runPath, runId, action }) {
    const binding = checkBinding({ runPath, runId, action });
    const descriptor = readPrivate(descriptorPath);
    privateDirectory(path.dirname(descriptorPath));
    if (descriptor.schema !== 1 || !matches(descriptor.binding, binding) || !/^[a-f0-9]{32}$/.test(descriptor.epoch)
        || !/^[a-f0-9]{64}$/.test(descriptor.capability) || !absolute(descriptor.socketPath)
        || path.dirname(descriptor.socketPath) !== path.dirname(descriptorPath)) throw Error('Invalid ownership descriptor binding');
    const sockets = new Set(); let closed = false;
    const processProvider = (binary, args, options = {}) => {
        const { signal, deadlineMs = 30000, maxBytes = 65536, stdinPath = null, cwd } = options;
        const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
        delete env[PROCESS_OWNER_ENV];
        const invocation = { cwd, env, deadlineMs, maxBytes, stdinPath };
        validateInvocation(binary, args, invocation);
        if (closed || signal?.aborted || sockets.size >= MAX_ACTIVE) return Promise.resolve(failure('OWNERSHIP_CLOSED', Boolean(signal?.aborted)));
        return new Promise(resolve => {
            const requestId = random(), socket = net.createConnection(descriptor.socketPath); sockets.add(socket);
            let finished = false, accepted = false;
            const finish = result => {
                if (finished) return; finished = true;
                clearTimeout(timer); signal?.removeEventListener('abort', abort); sockets.delete(socket); socket.destroy(); resolve(result);
            };
            let timer = setTimeout(() => finish(failure('OWNERSHIP_HANDSHAKE_TIMEOUT')), 2000);
            const abort = () => { try { send(socket, { type: 'cancel', requestId }); } catch {} };
            socket.on('connect', () => {
                try { send(socket, { type: 'run', requestId, epoch: descriptor.epoch, capability: descriptor.capability, binding, binary, args, options: invocation }); }
                catch { finish(failure('OWNERSHIP_FRAME_BOUND')); }
                if (signal?.aborted) abort();
            });
            const reject = () => finish(failure('OWNERSHIP_CONNECTION_LOST', Boolean(signal?.aborted)));
            socket.on('error', reject); socket.on('close', reject);
            frames(socket, message => {
                if (message.requestId !== requestId) { reject(); return; }
                if (message.type === 'accepted' && !accepted) {
                    accepted = true; clearTimeout(timer);
                    timer = setTimeout(() => finish(failure('OWNERSHIP_RESPONSE_TIMEOUT')), deadlineMs + 2000);
                } else if (message.type === 'result' && accepted && message.result && typeof message.result.stdout === 'string'
                    && typeof message.result.stderr === 'string' && Buffer.byteLength(message.result.stdout + message.result.stderr) <= maxBytes + 8
                    && (message.result.status === null || Number.isInteger(message.result.status))
                    && ['timedOut', 'truncated', 'cancelled', 'settlementForced'].every(key => typeof message.result[key] === 'boolean')
                    && (message.result.errorCode === null || typeof message.result.errorCode === 'string')
                    && (message.result.signal === null || typeof message.result.signal === 'string')) finish(message.result);
                else reject();
            }, reject);
            signal?.addEventListener('abort', abort, { once: true });
        });
    };
    return { processProvider, close: async () => { closed = true; for (const socket of sockets) socket.destroy(); } };
}
