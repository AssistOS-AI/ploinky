#!/usr/bin/env node
import net from 'node:net';

import { createMemoryReplayCache } from '../lib/jwtVerify.mjs';
import { verifyRelayRequestToken, verifyRelaySessionToken } from '../lib/relayRequestAuth.mjs';
import {
    RUNTIME_RELAY_PROTOCOL_VERSION,
    RelayFrameDecoder,
    encodeRelayFrame,
} from '../lib/runtimeRelayProtocol.mjs';

const secretHex = String(process.env.PLOINKY_AGENT_SECRET || '').trim();
const secret = /^[0-9a-f]{64}$/i.test(secretHex) ? Buffer.from(secretHex, 'hex') : null;
const effectiveAgentId = String(process.env.PLOINKY_AGENT_ID || process.env.PLOINKY_AGENT_PRINCIPAL || '');
const sessionReplayCache = createMemoryReplayCache();
const requestReplayCache = createMemoryReplayCache();
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
    if (!secret || !effectiveAgentId) throw new Error('runtime agent identity is unavailable');
    if (frame.version !== RUNTIME_RELAY_PROTOCOL_VERSION) throw new Error('relay protocol version mismatch');
    if (String(frame.targetAgentId || '') !== effectiveAgentId) throw new Error('effective agent identity mismatch');
    const verified = verifyRelaySessionToken(frame.token, {
        secret,
        expectedAudience: effectiveAgentId,
        effectiveInstanceId: frame.effectiveInstanceId,
        containerId: frame.containerId,
        generationDigest: frame.generationDigest,
        relaySessionId: frame.relaySessionId,
        deniedPorts: frame.deniedPorts,
        replayCache: sessionReplayCache,
    });
    session = Object.freeze({
        targetAgentId: effectiveAgentId,
        effectiveInstanceId: String(frame.effectiveInstanceId),
        containerId: String(frame.containerId),
        generationDigest: String(frame.generationDigest),
        relaySessionId: String(frame.relaySessionId),
        deniedPorts: Object.freeze(verified.deniedPorts),
        denySetDigest: verified.denySetDigest,
    });
    send({
        type: 'READY',
        version: RUNTIME_RELAY_PROTOCOL_VERSION,
        ...session,
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
        || Object.prototype.hasOwnProperty.call(frame, 'denySetDigest')) {
        throw new Error('request frame cannot alter the trusted deny set');
    }
    const portText = String(frame.port || '');
    if (!/^[1-9][0-9]{0,4}$/.test(portText) || Number(portText) > 65535) throw new Error('invalid canonical target port');
    if (session.deniedPorts.includes(Number(portText))) throw new Error('target port is runtime-reserved');
    if (!['http1', 'websocket'].includes(frame.mode)) throw new Error('unsupported relay mode');
    if (!String(frame.path || '').startsWith('/')) throw new Error('invalid target path');
    if (!['buffered-v1', 'stream-v1', 'none-v1'].includes(frame.bodyMode)) throw new Error('invalid body mode');

    verifyRelayRequestToken(frame.token, {
        secret,
        expectedAudience: session.targetAgentId,
        effectiveInstanceId: session.effectiveInstanceId,
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
    const idleTimeoutMs = Number(frame.limits?.idleTimeoutMs || 0);
    for (const [name, value] of Object.entries({
        streamedBodyBytes,
        bufferedBodyBytes,
        requestHeaderBytes,
        responseHeaderBytes,
        connectTimeoutMs,
        idleTimeoutMs,
    })) {
        if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${name} limit`);
    }
    const requestBodyBytes = frame.bodyMode === 'stream-v1' ? streamedBodyBytes : bufferedBodyBytes;
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
    socket.setTimeout(idleTimeoutMs);
    socket.once('connect', () => {
        clearTimeout(state.connectTimer);
        send({ type: 'READY', requestId });
    });
    socket.on('data', data => {
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
    for (const state of streams.values()) state.socket.destroy();
});
process.stdin.on('error', terminate);
