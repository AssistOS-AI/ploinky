#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createRelayReplayCache } from '../lib/relayTokenVerify.mjs';
import { verifyRelayRequestToken, verifyRelaySessionToken } from '../lib/relayRequestAuth.mjs';
import {
    RelayFrameDecoder,
    encodeRelayFrame,
} from '../lib/runtimeRelayProtocol.mjs';
import {
    isUnsupportedRelaySocketIdentity,
    readRelaySocketIdentityWithRetry,
    TRANSIENT_RELAY_SOCKET_ERRORS,
} from './lib/runtimeRelaySocket.mjs';

export const RUNTIME_RELAY_SOCKET_PATH = '/run/ploinky-health-probes/runtime-relay.sock';
const RUNTIME_RELAY_READY_PREFIX = '/run/ploinky-health-probes/.runtime-relay-ready-';
const RUNTIME_RELAY_BIND_ATTEMPTS = 600;
const RUNTIME_RELAY_BIND_RETRY_MS = 50;

const relayScriptPath = fileURLToPath(import.meta.url);

function isPrivateRelaySocketMode(mode) {
    const permissions = mode & 0o777;
    // Linux filesystems honor the 0177 creation umask and expose 0600. The
    // macOS Podman/Docker shared-filesystem bridges reject chmod(EINVAL) and
    // project the same socket as 0666 inside the nested container and 0755 in
    // the owning Box. The Router separately verifies that authoritative outer
    // projection plus the exact 0700 source directory before connecting.
    return permissions === 0o600 || permissions === 0o666 || permissions === 0o755;
}

function removeStaleRelaySocket(socketPath) {
    let identity;
    try {
        identity = fs.lstatSync(socketPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    if (!identity.isSocket() || identity.isSymbolicLink()) {
        throw new Error('runtime relay socket path is occupied by an invalid filesystem object');
    }
    fs.unlinkSync(socketPath);
}

function relaySocketIdentity(socketPath) {
    const identity = fs.lstatSync(socketPath);
    if (!identity.isSocket() || identity.isSymbolicLink()
        || !isPrivateRelaySocketMode(identity.mode)) {
        throw new Error(
            `runtime relay socket permissions are invalid (${(identity.mode & 0o777).toString(8)})`,
        );
    }
    return Object.freeze({ dev: identity.dev, ino: identity.ino, uid: identity.uid });
}

function removeOwnedRelaySocket(socketPath, ownedIdentity) {
    if (!ownedIdentity) return;
    let current;
    try {
        current = fs.lstatSync(socketPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    if (current.isSocket() && !current.isSymbolicLink()
        && current.dev === ownedIdentity.dev
        && current.ino === ownedIdentity.ino
        && current.uid === ownedIdentity.uid) {
        fs.unlinkSync(socketPath);
    }
}

function requireRelayReadyPath(readyPath) {
    if (!readyPath.startsWith(RUNTIME_RELAY_READY_PREFIX)) {
        throw new Error('runtime relay readiness path is invalid');
    }
    const token = readyPath.slice(RUNTIME_RELAY_READY_PREFIX.length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)) {
        throw new Error('runtime relay readiness token is invalid');
    }
}

function removeRelayReadyMarker(readyPath) {
    let identity;
    try {
        identity = fs.lstatSync(readyPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
        throw new Error('runtime relay readiness path is occupied by an invalid filesystem object');
    }
    fs.rmdirSync(readyPath);
}

const waitForBindRetry = () => new Promise(resolve => {
    setTimeout(resolve, RUNTIME_RELAY_BIND_RETRY_MS);
});

async function serveSocketBroker(socketPath, readyPath) {
    if (socketPath !== RUNTIME_RELAY_SOCKET_PATH) {
        throw new Error('runtime relay socket path is invalid');
    }
    requireRelayReadyPath(readyPath);
    const parent = fs.lstatSync('/run/ploinky-health-probes');
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
        throw new Error('runtime relay control mount is invalid');
    }
    removeRelayReadyMarker(readyPath);
    removeStaleRelaySocket(socketPath);

    const workers = new Set();
    const sockets = new Set();
    let ownedSocketIdentity = null;
    const server = net.createServer(socket => {
        sockets.add(socket);
        const worker = spawn(process.execPath, [relayScriptPath, 'stdio'], {
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        workers.add(worker);
        socket.pipe(worker.stdin);
        worker.stdout.pipe(socket);
        worker.stderr.pipe(process.stderr, { end: false });

        socket.once('close', () => {
            sockets.delete(socket);
            if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGTERM');
        });
        worker.once('error', error => socket.destroy(error));
        worker.once('exit', () => {
            workers.delete(worker);
            if (!socket.destroyed) socket.end();
        });
    });

    const priorUmask = process.umask(0o177);
    let umaskRestored = false;
    const restoreUmask = () => {
        if (umaskRestored) return;
        umaskRestored = true;
        process.umask(priorUmask);
    };
    let startupErrorHandler;
    await new Promise((resolve, reject) => {
        const onError = error => {
            restoreUmask();
            server.off('listening', onListening);
            reject(error);
        };
        startupErrorHandler = onError;
        const onListening = async () => {
            try {
                restoreUmask();
                // A nested Podman socket can be usable while the macOS
                // shared-filesystem bridge permanently rejects lstat(2) for
                // that object with ENOTSUP. The successful bind is sufficient
                // to publish readiness in that one projection mode: the Router
                // separately validates the authoritative outer directory and
                // socket identity before every connection. Retain no cleanup
                // identity in this case, so this process can never unlink a
                // path it could not classify; the owning Router removes the
                // exact socket from the 0700 control directory before launch.
                try {
                    ownedSocketIdentity = await readRelaySocketIdentityWithRetry(
                        () => relaySocketIdentity(socketPath),
                        {
                            attempts: RUNTIME_RELAY_BIND_ATTEMPTS,
                            wait: waitForBindRetry,
                        },
                    );
                } catch (error) {
                    if (!isUnsupportedRelaySocketIdentity(error)) throw error;
                    ownedSocketIdentity = null;
                }
                fs.mkdirSync(readyPath, { mode: 0o700 });
                server.off('error', onError);
                resolve();
            } catch (error) {
                restoreUmask();
                server.off('error', onError);
                server.close(() => {
                    try { removeOwnedRelaySocket(socketPath, ownedSocketIdentity); } catch (_) {}
                    try { removeRelayReadyMarker(readyPath); } catch (_) {}
                    reject(error);
                });
            }
        };
        server.once('error', onError);
        server.once('listening', onListening);
        try {
            server.listen(socketPath);
        } catch (error) {
            restoreUmask();
            server.off('error', onError);
            server.off('listening', onListening);
            reject(error);
        }
    });
    server.off('error', startupErrorHandler);

    let stopping = false;
    const stop = () => {
        if (stopping) return;
        stopping = true;
        for (const socket of sockets) socket.destroy();
        for (const worker of workers) worker.kill('SIGTERM');
        server.close(() => {
            try { removeOwnedRelaySocket(socketPath, ownedSocketIdentity); } catch (_) {}
            try { removeRelayReadyMarker(readyPath); } catch (_) {}
        });
    };
    server.on('error', error => {
        console.error(`runtime relay broker: ${error?.message || error}`);
        process.exitCode = 125;
        stop();
    });
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    process.once('SIGHUP', stop);
    process.once('exit', () => {
        try { removeOwnedRelaySocket(socketPath, ownedSocketIdentity); } catch (_) {}
        try { removeRelayReadyMarker(readyPath); } catch (_) {}
    });
}

async function serveSocketBrokerWithRetry(socketPath, readyPath) {
    for (let attempt = 1; attempt <= RUNTIME_RELAY_BIND_ATTEMPTS; attempt += 1) {
        try {
            await serveSocketBroker(socketPath, readyPath);
            return;
        } catch (error) {
            if (!TRANSIENT_RELAY_SOCKET_ERRORS.has(error?.code)
                || attempt === RUNTIME_RELAY_BIND_ATTEMPTS) {
                throw error;
            }
            await waitForBindRetry();
        }
    }
}

const relayMode = String(process.argv[2] || '');
if (relayMode === 'serve') {
    try {
        await serveSocketBrokerWithRetry(
            String(process.argv[3] || ''),
            String(process.argv[4] || ''),
        );
    } catch (error) {
        console.error(`runtime relay broker: ${error?.message || error}`);
        process.exitCode = 125;
    }
} else if (relayMode === 'stdio') {
const effectiveAgentId = String(process.env.PLOINKY_AGENT_ID || process.env.PLOINKY_AGENT_PRINCIPAL || '');
const sessionReplayCache = createRelayReplayCache();
const requestReplayCache = createRelayReplayCache();
const streams = new Map();
let session = null;
let terminating = false;

function send(frame) {
    if (!terminating) process.stdout.write(encodeRelayFrame(frame));
}

function fail(message, requestId = '') {
    send({ type: 'ERROR', ...(requestId ? { requestId } : {}), code: 'RELAY_REJECTED', message: String(message || 'relay rejected') });
}

function terminate(error) {
    if (terminating) return;
    try { fail(error?.message || error); } catch (_) {}
    terminating = true;
    session?.verificationKey?.fill?.(0);
    for (const state of streams.values()) state.socket.destroy();
    streams.clear();
    process.exitCode = 1;
    process.stdin.destroy();
}

function requireSession() {
    if (!session) throw new Error('HELLO must be verified before request frames');
}

function handleHello(frame) {
    if (session) throw new Error('duplicate HELLO');
    if (!effectiveAgentId) throw new Error('runtime agent identity is unavailable');
    if (String(frame.targetAgentId || '') !== effectiveAgentId) throw new Error('effective agent identity mismatch');
    const verificationKeyHex = String(frame.verificationKey || '').trim();
    if (!/^[0-9a-f]{64}$/i.test(verificationKeyHex)) throw new Error('relay verification key is unavailable');
    const verificationKey = Buffer.from(verificationKeyHex, 'hex');
    const verified = verifyRelaySessionToken(frame.token, {
        secret: verificationKey,
        expectedAudience: effectiveAgentId,
        effectiveInstanceId: frame.effectiveInstanceId,
        enableGeneration: frame.enableGeneration,
        containerId: frame.containerId,
        generationDigest: frame.generationDigest,
        relaySessionId: frame.relaySessionId,
        deniedPorts: frame.deniedPorts,
        replayCache: sessionReplayCache,
    });
    session = Object.freeze({
        targetAgentId: effectiveAgentId,
        effectiveInstanceId: String(frame.effectiveInstanceId),
        enableGeneration: String(frame.enableGeneration),
        containerId: String(frame.containerId),
        generationDigest: String(frame.generationDigest),
        relaySessionId: String(frame.relaySessionId),
        deniedPorts: Object.freeze(verified.deniedPorts),
        denySetDigest: verified.denySetDigest,
        verificationKey,
    });
    send({
        type: 'READY',
        targetAgentId: session.targetAgentId,
        effectiveInstanceId: session.effectiveInstanceId,
        enableGeneration: session.enableGeneration,
        containerId: session.containerId,
        generationDigest: session.generationDigest,
        relaySessionId: session.relaySessionId,
        deniedPorts: session.deniedPorts,
        denySetDigest: session.denySetDigest,
    });
}

function finishStream(requestId, state, frame) {
    if (state.terminal) return;
    state.terminal = true;
    clearTimeout(state.connectTimer);
    streams.delete(requestId);
    send({ ...frame, requestId });
}

function handleOpen(frame) {
    requireSession();
    const requestId = String(frame.requestId || '');
    if (!requestId || streams.has(requestId)) throw new Error('invalid or duplicate request id');
    if (Object.prototype.hasOwnProperty.call(frame, 'deniedPorts')
        || Object.prototype.hasOwnProperty.call(frame, 'denySetDigest')
        || Object.prototype.hasOwnProperty.call(frame, 'verificationKey')) {
        throw new Error('request frame cannot alter the trusted deny set');
    }
    const portText = String(frame.port || '');
    if (!/^[1-9][0-9]{0,4}$/.test(portText) || Number(portText) > 65535) throw new Error('invalid canonical target port');
    if (session.deniedPorts.includes(Number(portText))) throw new Error('target port is runtime-reserved');
    if (!['http1', 'websocket'].includes(frame.mode)) throw new Error('unsupported relay mode');
    if (!String(frame.path || '').startsWith('/')) throw new Error('invalid target path');
    if (!['buffered', 'stream', 'none'].includes(frame.bodyMode)) throw new Error('invalid body mode');

    verifyRelayRequestToken(frame.token, {
        secret: session.verificationKey,
        expectedAudience: session.targetAgentId,
        effectiveInstanceId: session.effectiveInstanceId,
        enableGeneration: session.enableGeneration,
        containerId: session.containerId,
        generationDigest: session.generationDigest,
        relaySessionId: session.relaySessionId,
        denySetDigest: session.denySetDigest,
        method: String(frame.method || '').toUpperCase(),
        port: portText,
        path: String(frame.path),
        query: String(frame.query || ''),
        bodyMode: String(frame.bodyMode || ''),
        bodyHash: String(frame.bodyHash || ''),
        replayCache: requestReplayCache,
    });

    const streamedBodyBytes = Number(frame.limits?.streamedBodyBytes || 0);
    const bufferedBodyBytes = Number(frame.limits?.bufferedBodyBytes || 0);
    const requestHeaderBytes = Number(frame.limits?.requestHeaderBytes || 0);
    const responseHeaderBytes = Number(frame.limits?.responseHeaderBytes || 0);
    const connectTimeoutMs = Number(frame.limits?.connectTimeoutMs || 0);
    const headerTimeoutMs = Number(frame.limits?.headerTimeoutMs || 0);
    const idleTimeoutMs = Number(frame.limits?.idleTimeoutMs || 0);
    const webSocketHandshakeTimeoutMs = Number(frame.limits?.webSocketHandshakeTimeoutMs || 0);
    for (const [name, value] of Object.entries({
        streamedBodyBytes,
        bufferedBodyBytes,
        requestHeaderBytes,
        responseHeaderBytes,
        connectTimeoutMs,
        headerTimeoutMs,
        idleTimeoutMs,
        webSocketHandshakeTimeoutMs,
    })) {
        if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${name} limit`);
    }
    const requestBodyBytes = frame.bodyMode === 'stream' ? streamedBodyBytes : bufferedBodyBytes;
    const requestLineBytes = Buffer.byteLength(`${frame.method} ${frame.path}${frame.query ? `?${frame.query}` : ''} HTTP/1.1\r\n`);
    const requestMaxBytes = requestBodyBytes + requestHeaderBytes + requestLineBytes;
    const responseMaxBytes = streamedBodyBytes + responseHeaderBytes + 64;
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(portText) });
    const state = {
        socket,
        terminal: false,
        requestBytes: 0,
        responseBytes: 0,
        requestMaxBytes,
        responseMaxBytes,
        connectTimer: null,
    };
    streams.set(requestId, state);
    state.connectTimer = setTimeout(() => socket.destroy(new Error('target connect timeout')), connectTimeoutMs);
    state.connectTimer.unref?.();
    socket.setTimeout(frame.mode === 'websocket' ? webSocketHandshakeTimeoutMs : headerTimeoutMs);
    socket.once('connect', () => {
        clearTimeout(state.connectTimer);
        send({ type: 'READY', requestId });
    });
    socket.on('data', data => {
        socket.setTimeout(idleTimeoutMs);
        state.responseBytes += data.length;
        if (state.responseBytes > state.responseMaxBytes) {
            socket.destroy(new Error('response byte limit exceeded'));
            return;
        }
        send({ type: 'DATA', requestId, data });
    });
    socket.once('end', () => finishStream(requestId, state, { type: 'END' }));
    socket.once('timeout', () => socket.destroy(new Error('target idle timeout')));
    socket.once('error', error => finishStream(requestId, state, {
        type: 'ERROR',
        code: 'TARGET_FAILURE',
        message: error?.message || 'target failure',
    }));
    socket.once('close', () => {
        if (!state.terminal) finishStream(requestId, state, { type: 'END' });
    });
}

function handleStreamFrame(frame) {
    requireSession();
    const requestId = String(frame.requestId || '');
    const state = streams.get(requestId);
    if (!state || state.terminal) throw new Error('unknown or terminal request id');
    if (frame.type === 'DATA') {
        const data = Buffer.isBuffer(frame.data) ? frame.data : Buffer.from(frame.data || '');
        state.requestBytes += data.length;
        if (state.requestBytes > state.requestMaxBytes) {
            state.socket.destroy(new Error('request byte limit exceeded'));
            return;
        }
        state.socket.write(data);
    } else if (frame.type === 'HALF_CLOSE') {
        state.socket.end();
    } else if (frame.type === 'CANCEL') {
        state.socket.destroy();
        finishStream(requestId, state, { type: 'END', cancelled: true });
    } else {
        throw new Error(`unexpected ${frame.type} from router`);
    }
}

function handleFrame(frame) {
    if (frame.type === 'HELLO') return handleHello(frame);
    if (frame.type === 'OPEN') return handleOpen(frame);
    if (['DATA', 'HALF_CLOSE', 'CANCEL'].includes(frame.type)) return handleStreamFrame(frame);
    throw new Error(`unsupported router frame ${frame.type}`);
}

const decoder = new RelayFrameDecoder();
decoder.on('frame', frame => {
    try {
        handleFrame(frame);
    } catch (error) {
        if (frame?.requestId) fail(error?.message || error, frame.requestId);
        else terminate(error);
    }
});
decoder.on('error', terminate);
process.stdin.on('data', chunk => {
    try { decoder.push(chunk); } catch (_) {}
});
process.stdin.on('end', () => {
    try { decoder.end(); } catch (_) {}
    session?.verificationKey?.fill?.(0);
    for (const state of streams.values()) state.socket.destroy();
});
process.stdin.on('error', terminate);
} else {
    console.error('runtime relay requires an explicit serve or stdio mode');
    process.exitCode = 125;
}
