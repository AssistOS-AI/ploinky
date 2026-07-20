import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { compileProxyLimits } from '../../cli/server/proxy/limits.js';
import { RelayFrameDecoder, encodeRelayFrame } from '../../cli/server/runtimeRelay/protocol.js';
import { RelayRequestMinter } from '../../cli/server/runtimeRelay/relayRequestMinter.js';
import { AGENT_SECRET, CONTAINER_ID } from './routingProxyTestFixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELAY_PATH = path.join(ROOT, 'Agent/server/RuntimeHttpRelay.mjs');
const IDENTITY = {
    targetAgentId: 'alpha-agent-id',
    effectiveInstanceId: 'alpha-instance-1',
    containerId: CONTAINER_ID,
    generationDigest: 'generation-one',
};

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function relayHarness() {
    const child = spawn(process.execPath, [RELAY_PATH], {
        cwd: ROOT,
        env: {
            ...process.env,
            PLOINKY_AGENT_ID: IDENTITY.targetAgentId,
            PLOINKY_AGENT_SECRET: AGENT_SECRET.toString('hex'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const decoder = new RelayFrameDecoder();
    const frames = [];
    const waiters = [];
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.stdout.on('data', chunk => decoder.push(chunk));
    decoder.on('frame', frame => {
        const index = waiters.findIndex(waiter => waiter.predicate(frame));
        if (index >= 0) {
            const [waiter] = waiters.splice(index, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
        } else frames.push(frame);
    });
    const next = (predicate, timeoutMs = 2000) => {
        const existing = frames.findIndex(predicate);
        if (existing >= 0) return Promise.resolve(frames.splice(existing, 1)[0]);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`relay frame timeout; stderr=${stderr}`)), timeoutMs);
            waiters.push({ predicate, resolve, timer });
        });
    };
    return {
        child,
        next,
        send: frame => child.stdin.write(encodeRelayFrame(frame)),
        close: () => {
            child.stdin.end();
            child.kill();
        },
    };
}

async function openSession(harness, deniedPorts = []) {
    const minter = new RelayRequestMinter({ resolveAgentSecret: async () => AGENT_SECRET });
    const session = await minter.mintSession({ ...IDENTITY, relaySessionId: 'relay-session', deniedPorts });
    harness.send({
        type: 'HELLO',
        version: 1,
        ...IDENTITY,
        relaySessionId: session.payload.relaySessionId,
        deniedPorts: session.payload.deniedPorts,
        denySetDigest: session.payload.denySetDigest,
        token: session.token,
    });
    await harness.next(frame => frame.type === 'READY' && !frame.requestId);
    return { minter, session };
}

test('runtime relay owns no TCP listener and proxies only selected loopback bytes', async t => {
    const source = fs.readFileSync(RELAY_PATH, 'utf8');
    assert.equal(/\blisten\s*\(|\bcreateServer\s*\(/.test(source), false);

    let received = '';
    const target = net.createServer(socket => {
        socket.once('data', data => {
            received = data.toString('utf8');
            socket.end('pong');
        });
    });
    const port = await listen(target);
    t.after(() => new Promise(resolve => target.close(resolve)));
    const harness = relayHarness();
    t.after(() => harness.close());
    const { minter, session } = await openSession(harness);
    const requestId = 'request-one';
    const request = await minter.mintRequest({
        ...IDENTITY,
        relaySessionId: session.payload.relaySessionId,
        denySetDigest: session.payload.denySetDigest,
        method: 'GET',
        port,
        path: '/',
        query: '',
        bodyMode: 'stream-v1',
        bodyHash: '',
    });
    harness.send({
        type: 'OPEN',
        requestId,
        mode: 'http1',
        method: 'GET',
        port: String(port),
        path: '/',
        query: '',
        bodyMode: 'stream-v1',
        bodyHash: '',
        headers: { authorization: 'Bearer application-token' },
        limits: compileProxyLimits(),
        token: request.token,
    });
    await harness.next(frame => frame.type === 'READY' && frame.requestId === requestId);
    harness.send({ type: 'DATA', requestId, data: Buffer.from('ping') });
    const response = await harness.next(frame => frame.type === 'DATA' && frame.requestId === requestId);
    assert.equal(response.data.toString('utf8'), 'pong');
    await harness.next(frame => frame.type === 'END' && frame.requestId === requestId);
    assert.equal(received, 'ping');
});
test('runtime relay rejects denied ports and request attempts to replace the trusted set before dial', async t => {
    let connections = 0;
    const target = net.createServer(socket => {
        connections += 1;
        socket.destroy();
    });
    const port = await listen(target);
    t.after(() => new Promise(resolve => target.close(resolve)));
    const harness = relayHarness();
    t.after(() => harness.close());
    const { minter, session } = await openSession(harness, [port]);
    const token = await minter.mintRequest({
        ...IDENTITY,
        relaySessionId: session.payload.relaySessionId,
        denySetDigest: session.payload.denySetDigest,
        method: 'GET',
        port,
        path: '/',
        query: '',
        bodyMode: 'none-v1',
        bodyHash: '',
    });
    harness.send({
        type: 'OPEN',
        requestId: 'denied',
        mode: 'http1',
        method: 'GET',
        port: String(port),
        path: '/',
        query: '',
        bodyMode: 'none-v1',
        bodyHash: '',
        limits: compileProxyLimits(),
        token: token.token,
    });
    const denied = await harness.next(frame => frame.type === 'ERROR' && frame.requestId === 'denied');
    assert.match(denied.message, /runtime-reserved/);

    harness.send({
        type: 'OPEN',
        requestId: 'tampered-set',
        mode: 'http1',
        method: 'GET',
        port: String(port),
        path: '/',
        query: '',
        bodyMode: 'none-v1',
        bodyHash: '',
        deniedPorts: [],
        limits: compileProxyLimits(),
        token: token.token,
    });
    const tampered = await harness.next(frame => frame.type === 'ERROR' && frame.requestId === 'tampered-set');
    assert.match(tampered.message, /trusted deny set/);
    assert.equal(connections, 0);
});
