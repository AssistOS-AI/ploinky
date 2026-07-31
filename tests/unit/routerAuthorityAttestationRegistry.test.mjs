import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
    AUTHORITY_ATTESTATION_BODY_MAX_BYTES,
    AUTHORITY_ATTESTATION_BODY_TIMEOUT_MS,
    AUTHORITY_ATTESTATION_MAX_PENDING,
    AUTHORITY_ATTESTATION_TTL_MS,
    createRouterAuthorityAttestationRegistry,
    handleRouterAuthorityAttestationRequest,
    recordRouterAuthorityObservation,
} from '../../cli/server/routerAuthorityAttestationRegistry.js';

function nonce(index) {
    return index.toString(16).padStart(64, '0');
}

const GENERATION_LEASE_ID = `sha256:${'a'.repeat(64)}`;

function observation(overrides = {}) {
    return {
        rawHost: '127.0.0.1:18080',
        normalizedHost: '127.0.0.1',
        effectiveListener: 'public',
        rawInterfaceClass: 'unmanaged',
        socketLocalAddress: '::ffff:192.0.2.1',
        socketRemoteAddress: '::FFFF:192.0.2.44',
        routePlanOk: false,
        routePlanStatus: 404,
        routePlanCode: 'ROUTE_NOT_FOUND',
        hostSelectionKind: 'control',
        controlMiss: true,
        generationLeaseId: 'generation-1',
        forbiddenSecret: 'must-not-be-recorded',
        ...overrides,
    };
}

function request({ method = 'GET', url = '/', body = Buffer.alloc(0) } = {}) {
    const req = Readable.from([Buffer.from(body)]);
    req.method = method;
    req.url = url;
    req.headers = {};
    return req;
}

function response() {
    return {
        statusCode: null,
        headers: null,
        body: Buffer.alloc(0),
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
        },
        end(body = Buffer.alloc(0)) {
            this.body = Buffer.from(body);
        },
        json() {
            return JSON.parse(this.body.toString('utf8'));
        },
    };
}

test('RoutingServer observes only after classification and route resolution and exposes control only on its health socket', () => {
    const source = fs.readFileSync(path.resolve(
        import.meta.dirname,
        '../../cli/server/RoutingServer.js',
    ), 'utf8');
    const requestStart = source.indexOf('async function processRequest(req, res)');
    const requestEnd = source.indexOf('\n}\n\n/**\n * Create and configure HTTP server', requestStart);
    const requestSource = source.slice(requestStart, requestEnd);
    const classify = requestSource.indexOf('const rawInterfaceClass = interfaceClassifier.classify');
    const resolve = requestSource.indexOf('const routePlan = resolveEdgeRoutePlan');
    const observe = requestSource.indexOf('recordRouterAuthorityObservation(routerAuthorityAttestationRegistry');
    const deny = requestSource.indexOf('if (!routePlan.ok && !controlMiss)');
    assert.ok(classify >= 0 && classify < resolve && resolve < observe && observe < deny);

    const healthStart = source.indexOf('async function processDetailedHealthRequest(req, res)');
    const healthEnd = source.indexOf('\n}\n\nconst server = http.createServer', healthStart);
    const healthSource = source.slice(healthStart, healthEnd);
    assert.match(healthSource, /handleRouterAuthorityAttestationRequest\(req, res/);
    assert.match(source, /healthServer\.listen\(detailedHealthSocket/);
    assert.match(source, /fs\.chmodSync\(detailedHealthSocket, 0o600\)/);
    assert.match(source, /healthServer\.requestTimeout = 3_000/);
    assert.match(source, /healthServer\.setTimeout\(3_000, \(socket\) => socket\.destroy\(\)\)/);
    assert.doesNotMatch(requestSource, /await\s+recordRouterAuthorityObservation/);
});

test('registry enforces exact nonces, sixteen pending entries, and monotonic ten-second expiry', () => {
    let now = 100;
    const registry = createRouterAuthorityAttestationRegistry({ now: () => now });

    for (const malformed of ['', 'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(64)}\n`, 42, null]) {
        assert.deepEqual(registry.register(malformed, GENERATION_LEASE_ID), { ok: false, status: 'invalid' });
    }
    assert.deepEqual(registry.register(nonce(0), 'generation-1'), { ok: false, status: 'invalid' });
    assert.equal(registry.pendingCount(), 0);

    for (let index = 0; index < AUTHORITY_ATTESTATION_MAX_PENDING; index += 1) {
        assert.deepEqual(registry.register(nonce(index), GENERATION_LEASE_ID), { ok: true, status: 'registered' });
    }
    assert.equal(registry.pendingCount(), AUTHORITY_ATTESTATION_MAX_PENDING);
    assert.deepEqual(registry.register(nonce(16), GENERATION_LEASE_ID), { ok: false, status: 'capacity' });
    assert.deepEqual(registry.register(nonce(0), GENERATION_LEASE_ID), { ok: false, status: 'exists' });

    now += AUTHORITY_ATTESTATION_TTL_MS - 1;
    assert.equal(registry.pendingCount(), AUTHORITY_ATTESTATION_MAX_PENDING);
    now += 1;
    assert.equal(registry.pendingCount(), 0);
    assert.deepEqual(registry.consume(nonce(0)), { ok: false, status: 'not-found' });
});

test('registry records exactly two restricted observations and consumes only complete records atomically', () => {
    let now = 0;
    const registry = createRouterAuthorityAttestationRegistry({ now: () => now });
    const registeredNonce = nonce(1);
    assert.equal(registry.register(registeredNonce, GENERATION_LEASE_ID).ok, true);
    assert.equal(registry.registeredGeneration(registeredNonce), GENERATION_LEASE_ID);

    assert.equal(registry.record('not-a-nonce', observation()), false);
    assert.equal(registry.record(nonce(2), observation()), false);
    assert.equal(registry.pendingCount(), 1);

    assert.equal(registry.record(registeredNonce, observation()), true);
    assert.deepEqual(registry.consume(registeredNonce), { ok: false, status: 'incomplete' });
    assert.equal(registry.pendingCount(), 1, 'incomplete reads must not consume the nonce');

    now += 1;
    assert.equal(registry.record(registeredNonce, observation({
        rawHost: 'host.containers.internal:8080',
        normalizedHost: 'host.containers.internal',
        routePlanStatus: 421,
        routePlanCode: 'UNKNOWN_HOST',
        hostSelectionKind: undefined,
        controlMiss: false,
    })), true);
    assert.equal(registry.record(registeredNonce, observation()), false, 'a third record must be inert');

    const complete = registry.consume(registeredNonce);
    assert.equal(complete.ok, true);
    assert.equal(complete.nonce, registeredNonce);
    assert.equal(complete.records.length, 2);
    assert.deepEqual(Object.keys(complete.records[0]), [
        'rawHost',
        'normalizedHost',
        'effectiveListener',
        'rawInterfaceClass',
        'socketLocalAddress',
        'socketRemoteAddress',
        'routePlanOk',
        'routePlanStatus',
        'routePlanCode',
        'hostSelectionKind',
        'controlMiss',
        'generationLeaseId',
    ]);
    assert.equal(complete.records[0].socketLocalAddress, '192.0.2.1');
    assert.equal(complete.records[0].socketRemoteAddress, '192.0.2.44');
    assert.equal(Object.hasOwn(complete.records[0], 'forbiddenSecret'), false);
    assert.equal(complete.records[1].hostSelectionKind, null);
    assert.equal(registry.pendingCount(), 0);
    assert.equal(registry.registeredGeneration(registeredNonce), null);
    assert.deepEqual(registry.consume(registeredNonce), { ok: false, status: 'not-found' });
});

test('request observation is inert for malformed and unregistered headers and contains registry failures', () => {
    const registry = createRouterAuthorityAttestationRegistry({ now: () => 0 });
    const req = {
        headers: {
            host: '127.0.0.1:18080',
            'x-ploinky-authority-probe': ['a'.repeat(64)],
        },
        socket: {
            localAddress: '192.0.2.1',
            remoteAddress: '192.0.2.44',
        },
    };
    assert.equal(recordRouterAuthorityObservation(registry, {
        req,
        normalizedHost: '127.0.0.1',
        effectiveListener: 'public',
        rawInterfaceClass: 'unmanaged',
        routePlan: { ok: false, status: 404, code: 'ROUTE_NOT_FOUND' },
        controlMiss: true,
    }), false);
    assert.equal(registry.pendingCount(), 0);

    assert.equal(recordRouterAuthorityObservation({
        record() {
            throw new Error('injected registry failure');
        },
    }, { req }), false);
});

test('private endpoint strictly registers, preserves incomplete records, consumes complete records, and bounds bodies', async () => {
    assert.equal(AUTHORITY_ATTESTATION_BODY_TIMEOUT_MS, 1_000);
    const registry = createRouterAuthorityAttestationRegistry({ now: () => 0 });
    const registeredNonce = nonce(9);
    let req = request({
        method: 'POST',
        url: '/authority-attestations',
        body: JSON.stringify({
            nonce: registeredNonce,
            generationLeaseId: GENERATION_LEASE_ID,
        }),
    });
    let res = response();
    assert.equal(await handleRouterAuthorityAttestationRequest(req, res, { registry }), true);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.json(), { ok: true, nonce: registeredNonce });
    assert.equal(res.headers['Cache-Control'], 'no-store');

    req = request({ method: 'GET', url: `/authority-attestations/${registeredNonce}` });
    res = response();
    await handleRouterAuthorityAttestationRequest(req, res, { registry });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { ok: false, error: 'AUTHORITY_ATTESTATION_INCOMPLETE' });
    assert.equal(registry.pendingCount(), 1);

    registry.record(registeredNonce, observation());
    registry.record(registeredNonce, observation({ rawHost: 'host.containers.internal:8080' }));
    req = request({ method: 'GET', url: `/authority-attestations/${registeredNonce}` });
    res = response();
    await handleRouterAuthorityAttestationRequest(req, res, { registry });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().records.length, 2);
    assert.equal(registry.pendingCount(), 0);

    req = request({
        method: 'POST',
        url: '/authority-attestations',
        body: Buffer.alloc(AUTHORITY_ATTESTATION_BODY_MAX_BYTES + 1, 0x61),
    });
    res = response();
    await handleRouterAuthorityAttestationRequest(req, res, { registry });
    assert.equal(res.statusCode, 413);
    assert.deepEqual(res.json(), { ok: false, error: 'AUTHORITY_ATTESTATION_BODY_TOO_LARGE' });

    req = new Readable({ read() {} });
    req.method = 'POST';
    req.url = '/authority-attestations';
    req.headers = {};
    res = response();
    await handleRouterAuthorityAttestationRequest(req, res, {
        registry,
        bodyTimeoutMs: 5,
    });
    assert.equal(res.statusCode, 408);
    assert.deepEqual(res.json(), { ok: false, error: 'AUTHORITY_ATTESTATION_BODY_TIMEOUT' });
    req.destroy();

    req = request({ method: 'POST', url: '/authority-attestations', body: '{"nonce":' });
    res = response();
    await handleRouterAuthorityAttestationRequest(req, res, { registry });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { ok: false, error: 'INVALID_AUTHORITY_ATTESTATION_REGISTRATION' });

    req = request({ method: 'GET', url: '/health' });
    res = response();
    assert.equal(await handleRouterAuthorityAttestationRequest(req, res, { registry }), false);
    assert.equal(res.statusCode, null);
});
