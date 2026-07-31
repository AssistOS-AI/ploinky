import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyEdgeRoutingGeneration } from '../../cli/sandbox/edgeGeneration.js';
import { ensureAuthenticated } from '../../cli/server/authHandlers/index.js';
import {
    normalizeExactHost,
    resolveEdgeRoutePlan,
} from '../../cli/server/edgeRoutePlan.js';
import {
    createRouterAuthorityAttestationRegistry,
    handleRouterAuthorityAttestationRequest,
    recordRouterAuthorityObservation,
} from '../../cli/server/routerAuthorityAttestationRegistry.js';

const VOLATILE_HEADERS = new Set([
    'connection',
    'date',
    'keep-alive',
    'transfer-encoding',
]);

function nonce(hexDigit) {
    return String(hexDigit).repeat(64);
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function createActiveExplorerGeneration(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-authority-flow-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const explorerDir = path.join(ploinkyDir, 'repos', 'fixtures', 'explorer');
    fs.mkdirSync(explorerDir, { recursive: true });
    writeJson(path.join(explorerDir, 'manifest.json'), {});
    writeJson(path.join(ploinkyDir, 'routing.json'), {
        static: { agent: 'explorer', port: 7777 },
        routes: {
            explorer: {
                repo: 'fixtures',
                agent: 'explorer',
                container: 'explorer-container',
                hostPath: explorerDir,
                hostPort: 43101,
            },
        },
    });
    writeJson(path.join(ploinkyDir, 'agents.json'), {
        'explorer-container': {
            type: 'agent',
            repoName: 'fixtures',
            agentName: 'explorer',
            runtime: 'podman',
            containerId: 'a'.repeat(64),
            instanceId: 'explorer-instance',
            enableGeneration: 'explorer-enable-generation',
            auth: { mode: 'local' },
        },
    });
    writeJson(path.join(ploinkyDir, 'data', 'edge-routing', 'desired.json'), { hosts: {} });
    writeJson(path.join(ploinkyDir, 'data', 'router-security', 'policy-state.json'), {
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    });

    const previousWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    const previousRouterHostPort = process.env.PLOINKY_ROUTER_HOST_PORT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: workspace,
        reason: 'authority-observation-flow-fixture',
    });
    t.after(() => {
        if (previousWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousWorkspaceRoot;
        if (previousRouterHostPort === undefined) delete process.env.PLOINKY_ROUTER_HOST_PORT;
        else process.env.PLOINKY_ROUTER_HOST_PORT = previousRouterHostPort;
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    return applied.selector.generation;
}

function sendJsonResponse(res, statusCode, body, extraHeaders = {}) {
    const bytes = Buffer.from(JSON.stringify(body));
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': bytes.length,
        ...extraHeaders,
    });
    res.end(bytes);
}

function createObservedRouterHandler({ registry, rawInterfaceClass }) {
    return async (req, res) => {
        const exactHost = normalizeExactHost(req.headers.host);
        if (!exactHost || !String(req.url || '').startsWith('/')) {
            sendJsonResponse(res, 400, { error: 'malformed_request_target_or_host' }, { 'Cache-Control': 'no-store' });
            return;
        }
        const requestedUrl = new URL(req.url || '/', `http://${exactHost === '::1' ? '[::1]' : exactHost}`);
        const listener = rawInterfaceClass === 'managed' ? 'managed' : 'public';
        const routePlan = resolveEdgeRoutePlan({ req, parsedUrl: requestedUrl, listener });
        const controlMiss = !routePlan.ok
            && routePlan.code === 'ROUTE_NOT_FOUND'
            && routePlan.hostSelection?.kind === 'control';
        recordRouterAuthorityObservation(registry, {
            req,
            normalizedHost: exactHost,
            effectiveListener: listener,
            rawInterfaceClass,
            routePlan,
            controlMiss,
        });
        if (!routePlan.ok && !controlMiss) {
            sendJsonResponse(
                res,
                routePlan.status || 404,
                { error: routePlan.code || 'route_denied' },
                { 'Cache-Control': 'no-store' },
            );
            return;
        }
        const authResult = await ensureAuthenticated(req, res, requestedUrl, { routePlan });
        if (!authResult.ok) return;
        throw new Error('credentialless fixture unexpectedly passed the Router authentication gate');
    };
}

async function listen(server, options) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options, () => {
            server.off('error', reject);
            resolve();
        });
    });
}

async function close(server) {
    if (!server.listening) return;
    await new Promise((resolve) => server.close(() => resolve()));
}

function request(options, body = null) {
    return new Promise((resolve, reject) => {
        const clientRequest = http.request(options, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            response.on('end', () => resolve({
                status: response.statusCode,
                rawHeaders: response.rawHeaders,
                body: Buffer.concat(chunks),
            }));
        });
        clientRequest.setTimeout(2_000, () => clientRequest.destroy(new Error('fixture request timed out')));
        clientRequest.on('error', reject);
        if (body !== null) clientRequest.end(body);
        else clientRequest.end();
    });
}

function stableHeaders(rawHeaders) {
    const pairs = [];
    for (let index = 0; index < rawHeaders.length; index += 2) {
        const name = String(rawHeaders[index]).toLowerCase();
        if (!VOLATILE_HEADERS.has(name)) pairs.push([name, String(rawHeaders[index + 1])]);
    }
    return pairs.sort(([leftName, leftValue], [rightName, rightValue]) => (
        leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    ));
}

async function privateRequest(socketPath, method, requestPath, body = null) {
    return request({
        socketPath,
        method,
        path: requestPath,
        headers: body === null ? {} : {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
    }, body);
}

test('registered observation headers are response-neutral in all four listener and Host cells', async (t) => {
    const generationLeaseId = createActiveExplorerGeneration(t);
    const registry = createRouterAuthorityAttestationRegistry();
    const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-authority-private-'));
    const socketPath = path.join(privateDir, 'router-health.sock');
    const privateServer = http.createServer(async (req, res) => {
        if (await handleRouterAuthorityAttestationRequest(req, res, { registry })) return;
        sendJsonResponse(res, 404, { error: 'not_found' }, { 'Cache-Control': 'no-store' });
    });
    await listen(privateServer, socketPath);
    fs.chmodSync(socketPath, 0o600);
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);

    const publicServer = http.createServer(createObservedRouterHandler({
        registry,
        rawInterfaceClass: 'unmanaged',
    }));
    const managedServer = http.createServer(createObservedRouterHandler({
        registry,
        rawInterfaceClass: 'managed',
    }));
    await listen(publicServer, { host: '127.0.0.1', port: 0 });
    await listen(managedServer, { host: '127.0.0.1', port: 0 });
    t.after(async () => {
        await Promise.all([close(publicServer), close(managedServer), close(privateServer)]);
        fs.rmSync(privateDir, { recursive: true, force: true });
    });

    const cells = [
        {
            key: 'public-loopback',
            server: publicServer,
            host: '127.0.0.1:18080',
            expectedStatus: 401,
            expectedBody: '{"ok":false,"error":"not_authenticated","login":"/auth/login?returnTo=%2Fhealth&agent=explorer"}',
        },
        {
            key: 'public-hci',
            server: publicServer,
            host: 'host.containers.internal:8080',
            expectedStatus: 421,
            expectedBody: '{"error":"UNKNOWN_HOST"}',
        },
        {
            key: 'managed-hci',
            server: managedServer,
            host: 'host.containers.internal:8080',
            expectedStatus: 404,
            expectedBody: '{"error":"ROUTE_SURFACE_DENIED"}',
        },
        {
            key: 'managed-loopback',
            server: managedServer,
            host: '127.0.0.1:18080',
            expectedStatus: 421,
            expectedBody: '{"error":"UNKNOWN_HOST"}',
        },
    ];

    async function cellRequest(cell, probeHeader) {
        const address = cell.server.address();
        const headers = {
            Host: cell.host,
            Accept: 'application/json',
            Connection: 'close',
            ...(probeHeader ? { 'X-Ploinky-Authority-Probe': probeHeader } : {}),
        };
        return request({
            host: '127.0.0.1',
            port: address.port,
            method: 'GET',
            path: '/health',
            headers,
        });
    }

    const results = new Map();
    const unregisteredNonce = nonce('f');
    for (const cell of cells) {
        const absent = await cellRequest(cell, null);
        const unregistered = await cellRequest(cell, unregisteredNonce);
        results.set(cell.key, { absent, unregistered });
    }
    assert.equal(registry.pendingCount(), 0, 'unregistered headers must not allocate records');

    const publicNonce = nonce('b');
    const managedNonce = nonce('c');
    for (const registeredNonce of [publicNonce, managedNonce]) {
        const registrationBody = JSON.stringify({ nonce: registeredNonce });
        const registration = await privateRequest(
            socketPath,
            'POST',
            '/authority-attestations',
            registrationBody,
        );
        assert.equal(registration.status, 201);
    }
    for (const cell of cells) {
        const registeredNonce = cell.key.startsWith('public-') ? publicNonce : managedNonce;
        results.get(cell.key).registered = await cellRequest(cell, registeredNonce);
    }

    for (const cell of cells) {
        const variants = results.get(cell.key);
        for (const [variant, response] of Object.entries(variants)) {
            assert.equal(response.status, cell.expectedStatus, `${cell.key}/${variant} status`);
            assert.equal(response.body.toString('utf8'), cell.expectedBody, `${cell.key}/${variant} body`);
        }
        assert.deepEqual(
            stableHeaders(variants.unregistered.rawHeaders),
            stableHeaders(variants.absent.rawHeaders),
            `${cell.key} unregistered stable headers`,
        );
        assert.deepEqual(
            stableHeaders(variants.registered.rawHeaders),
            stableHeaders(variants.absent.rawHeaders),
            `${cell.key} registered stable headers`,
        );
    }

    async function consume(registeredNonce) {
        const response = await privateRequest(
            socketPath,
            'GET',
            `/authority-attestations/${registeredNonce}`,
        );
        assert.equal(response.status, 200);
        return JSON.parse(response.body.toString('utf8')).records;
    }

    const publicRecords = await consume(publicNonce);
    const managedRecords = await consume(managedNonce);
    assert.deepEqual(publicRecords.map((record) => ({
        rawHost: record.rawHost,
        normalizedHost: record.normalizedHost,
        effectiveListener: record.effectiveListener,
        rawInterfaceClass: record.rawInterfaceClass,
        routePlanOk: record.routePlanOk,
        routePlanStatus: record.routePlanStatus,
        routePlanCode: record.routePlanCode,
        hostSelectionKind: record.hostSelectionKind,
        controlMiss: record.controlMiss,
        generationLeaseId: record.generationLeaseId,
    })), [
        {
            rawHost: '127.0.0.1:18080',
            normalizedHost: '127.0.0.1',
            effectiveListener: 'public',
            rawInterfaceClass: 'unmanaged',
            routePlanOk: false,
            routePlanStatus: 404,
            routePlanCode: 'ROUTE_NOT_FOUND',
            hostSelectionKind: 'control',
            controlMiss: true,
            generationLeaseId,
        },
        {
            rawHost: 'host.containers.internal:8080',
            normalizedHost: 'host.containers.internal',
            effectiveListener: 'public',
            rawInterfaceClass: 'unmanaged',
            routePlanOk: false,
            routePlanStatus: 421,
            routePlanCode: 'UNKNOWN_HOST',
            hostSelectionKind: null,
            controlMiss: false,
            generationLeaseId,
        },
    ]);
    assert.deepEqual(managedRecords.map((record) => ({
        rawHost: record.rawHost,
        normalizedHost: record.normalizedHost,
        effectiveListener: record.effectiveListener,
        rawInterfaceClass: record.rawInterfaceClass,
        routePlanOk: record.routePlanOk,
        routePlanStatus: record.routePlanStatus,
        routePlanCode: record.routePlanCode,
        hostSelectionKind: record.hostSelectionKind,
        controlMiss: record.controlMiss,
        generationLeaseId: record.generationLeaseId,
    })), [
        {
            rawHost: 'host.containers.internal:8080',
            normalizedHost: 'host.containers.internal',
            effectiveListener: 'managed',
            rawInterfaceClass: 'managed',
            routePlanOk: false,
            routePlanStatus: 404,
            routePlanCode: 'ROUTE_SURFACE_DENIED',
            hostSelectionKind: 'managed-agent',
            controlMiss: false,
            generationLeaseId,
        },
        {
            rawHost: '127.0.0.1:18080',
            normalizedHost: '127.0.0.1',
            effectiveListener: 'managed',
            rawInterfaceClass: 'managed',
            routePlanOk: false,
            routePlanStatus: 421,
            routePlanCode: 'UNKNOWN_HOST',
            hostSelectionKind: null,
            controlMiss: false,
            generationLeaseId,
        },
    ]);
    assert.equal(registry.pendingCount(), 0, 'complete GETs must consume both records atomically');
});
