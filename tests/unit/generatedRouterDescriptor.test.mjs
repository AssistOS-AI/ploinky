import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    canonicalJson,
    canonicalJsonBytes,
    semanticTopologyDigest,
    validateGeneratedRouterDescriptorPayload,
} from '../../cli/utils/security/generatedRouterDescriptor.js';
import {
    loadVerifiedGeneratedRouterDescriptor,
    resolveGeneratedRouterOperation,
} from '../../Agent/client/generatedRouterDescriptor.mjs';
import {
    attestRouterAuthority,
    buildRouterAuthorityTopologyIntent,
    RouterAuthorityAttestationError,
    ROUTER_AUTHORITY_EXTERNAL_PROBE_TIMEOUT,
    ROUTER_AUTHORITY_HELPER_IMAGE,
    runContainerAuthorityProbe,
    validateRouterAuthorityObservation,
} from '../../cli/sandbox/routerAuthorityAttestation.js';
import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';

const FIXTURE_ROOT = path.resolve('tests/fixtures/router-descriptor');
const vectors = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'vectors.json'), 'utf8'));
const publicEnvironment = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'public-environment.json'), 'utf8'));

function fixtureBytes(name) {
    return fs.readFileSync(path.join(FIXTURE_ROOT, name));
}

function fixtureJson(name) {
    return JSON.parse(fixtureBytes(name).toString('utf8'));
}

function generationSnapshot(fixture, agent = 'explorer') {
    return Object.freeze({
        generation: fixture.evidence.generationId,
        routing: Object.freeze({ static: Object.freeze({ agent }) }),
    });
}

function sha256(bytes) {
    return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function missingBoxFs() {
    return {
        lstatSync() {
            const error = new Error('missing');
            error.code = 'ENOENT';
            throw error;
        },
    };
}

function presentBoxFs() {
    return {
        lstatSync() {
            return { isSymbolicLink: () => false, isFile: () => true, nlink: 1 };
        },
        readFileSync() {
            return Buffer.from(BOX_MARKER_CONTENT);
        },
    };
}

const runtimeProof = Object.freeze({
    backend: 'netavark',
    engine: 'podman',
    remote: false,
    rootless: true,
});
const networkFingerprint = `sha256:${'1'.repeat(64)}`;

test('frozen descriptor fixtures are exact canonical bytes without a trailing newline', () => {
    for (const [name, expectedDigest] of Object.entries(vectors.files)) {
        const bytes = fixtureBytes(name);
        const envelope = JSON.parse(bytes.toString('utf8'));
        assert.equal(bytes.at(-1), 0x7d, `${name} must end at the canonical JSON object`);
        assert.equal(bytes.equals(canonicalJsonBytes(envelope)), true, `${name} must contain exact canonical bytes`);
        assert.equal(sha256(bytes), expectedDigest, `${name} fixture hash changed`);
        assert.equal(
            envelope.payload.semanticTopologyDigest,
            semanticTopologyDigest(envelope.payload),
            `${name} semantic topology digest changed`,
        );
    }
});

test('signed descriptor attestation IDs equal the canonical full evidence digests', () => {
    for (const name of ['public', 'managed']) {
        const attestation = fixtureJson(`${name}-attestation.json`);
        const envelope = fixtureJson(`${name}-envelope.json`);
        const evidenceDigest = sha256(canonicalJsonBytes(attestation.evidence));
        assert.equal(attestation.attestationId, evidenceDigest);
        assert.equal(envelope.payload.attestationId, evidenceDigest);
        assert.deepEqual(Object.keys(attestation.evidence).sort(), [
            'external',
            'generationId',
            'helper',
            'nonce',
            'observedAtUnixMs',
            'records',
        ]);
    }
});

test('payload validation rejects signed-shape semantic drift and uncertified streaming', () => {
    const publicEnvelope = fixtureJson('public-envelope.json');
    assert.equal(validateGeneratedRouterDescriptorPayload(publicEnvelope.payload), publicEnvelope.payload);

    const drifted = { ...publicEnvelope.payload, physicalOrigin: 'http://127.0.0.1:8080', routerHost: '127.0.0.1' };
    assert.throws(
        () => validateGeneratedRouterDescriptorPayload(drifted),
        /semanticTopologyDigest does not match/,
    );

    const streaming = fixtureJson('streaming-enabled-envelope.json');
    assert.throws(
        () => validateGeneratedRouterDescriptorPayload(streaming.payload),
        /streaming is not certified/,
    );
    assert.equal(
        validateGeneratedRouterDescriptorPayload(streaming.payload, { allowStreamingEnabled: true }),
        streaming.payload,
    );
});

test('Agent verifier accepts the frozen public descriptor and brands its exact transport tuple', (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-descriptor-'));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const descriptorFile = path.join(tempDir, 'router-descriptor.json');
    fs.writeFileSync(descriptorFile, fixtureBytes('public-envelope.json'), { mode: 0o600 });
    const env = {
        ...publicEnvironment,
        PLOINKY_ROUTER_DESCRIPTOR_FILE: descriptorFile,
    };

    const verified = loadVerifiedGeneratedRouterDescriptor({ env });
    assert.equal(verified.physicalOrigin, 'http://host.containers.internal:8080');
    assert.equal(verified.requestAuthority, '127.0.0.1:18080');
    assert.equal(Object.isFrozen(verified.payload.runtimeProof), true);
});

test('Agent verifier rejects semantic drift before reading the API key', (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-descriptor-drift-'));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const descriptorFile = path.join(tempDir, 'router-descriptor.json');
    const envelope = fixtureJson('public-envelope.json');
    envelope.payload.semanticTopologyDigest = `sha256:${'9'.repeat(64)}`;
    fs.writeFileSync(descriptorFile, canonicalJson(envelope), { mode: 0o600 });
    let apiKeyReads = 0;
    const values = {
        ...publicEnvironment,
        PLOINKY_ROUTER_DESCRIPTOR_FILE: descriptorFile,
    };
    const env = new Proxy(values, {
        get(target, property, receiver) {
            if (property === 'PLOINKY_AGENT_API_KEY') apiKeyReads += 1;
            return Reflect.get(target, property, receiver);
        },
    });

    assert.throws(
        () => loadVerifiedGeneratedRouterDescriptor({ env }),
        /semantic topology digest is invalid/,
    );
    assert.equal(apiKeyReads, 0);
});

test('valid verification and invalid operation paths never read the unused API key value', (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-descriptor-api-read-'));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const descriptorFile = path.join(tempDir, 'router-descriptor.json');
    fs.writeFileSync(descriptorFile, fixtureBytes('public-envelope.json'), { mode: 0o600 });
    let apiKeyReads = 0;
    const values = { ...publicEnvironment, PLOINKY_ROUTER_DESCRIPTOR_FILE: descriptorFile };
    const env = new Proxy(values, {
        get(target, property, receiver) {
            if (property === 'PLOINKY_AGENT_API_KEY') apiKeyReads += 1;
            return Reflect.get(target, property, receiver);
        },
    });
    const verified = loadVerifiedGeneratedRouterDescriptor({ env });
    assert.equal(apiKeyReads, 0);
    assert.throws(
        () => resolveGeneratedRouterOperation(verified, '/AssistOSExplorer/mcp?retry=1'),
        /exact absolute path/,
    );
    assert.equal(apiKeyReads, 0);
});

test('descriptor locator rejects relative and NUL paths before file or API-key access', () => {
    for (const descriptorFile of ['relative/router-descriptor.json', '/tmp/router\0descriptor.json']) {
        let fileReads = 0;
        let apiKeyReads = 0;
        const values = { ...publicEnvironment, PLOINKY_ROUTER_DESCRIPTOR_FILE: descriptorFile };
        const env = new Proxy(values, {
            get(target, property, receiver) {
                if (property === 'PLOINKY_AGENT_API_KEY') apiKeyReads += 1;
                return Reflect.get(target, property, receiver);
            },
        });
        assert.throws(
            () => loadVerifiedGeneratedRouterDescriptor({
                env,
                fsApi: new Proxy(fs, {
                    get(target, property, receiver) {
                        if (['lstatSync', 'openSync', 'readSync'].includes(property)) fileReads += 1;
                        return Reflect.get(target, property, receiver);
                    },
                }),
            }),
            /absolute non-NUL path/,
        );
        assert.equal(fileReads, 0);
        assert.equal(apiKeyReads, 0);
    }
});

test('Agent verifier rejects descriptor path swaps and growth before API-key access', (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-descriptor-race-'));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const descriptorFile = path.join(tempDir, 'router-descriptor.json');
    const replacementFile = path.join(tempDir, 'replacement.json');
    fs.writeFileSync(descriptorFile, fixtureBytes('public-envelope.json'), { mode: 0o600 });
    fs.writeFileSync(replacementFile, fixtureBytes('public-envelope.json'), { mode: 0o600 });
    const values = { ...publicEnvironment, PLOINKY_ROUTER_DESCRIPTOR_FILE: descriptorFile };
    let apiKeyReads = 0;
    const env = new Proxy(values, {
        get(target, property, receiver) {
            if (property === 'PLOINKY_AGENT_API_KEY') apiKeyReads += 1;
            return Reflect.get(target, property, receiver);
        },
    });

    const swappedFs = {
        constants: fs.constants,
        lstatSync: (...args) => fs.lstatSync(...args),
        openSync: () => fs.openSync(replacementFile, fs.constants.O_RDONLY),
        fstatSync: (...args) => fs.fstatSync(...args),
        readSync: (...args) => fs.readSync(...args),
        closeSync: (...args) => fs.closeSync(...args),
    };
    assert.throws(
        () => loadVerifiedGeneratedRouterDescriptor({ env, fsApi: swappedFs }),
        /identity changed before reading/,
    );
    assert.equal(apiKeyReads, 0);

    let appended = false;
    const growingFs = {
        constants: fs.constants,
        lstatSync: (...args) => fs.lstatSync(...args),
        openSync: (...args) => fs.openSync(...args),
        fstatSync: (...args) => fs.fstatSync(...args),
        readSync(...args) {
            const count = fs.readSync(...args);
            if (!appended) {
                fs.appendFileSync(descriptorFile, ' ');
                appended = true;
            }
            return count;
        },
        closeSync: (...args) => fs.closeSync(...args),
    };
    assert.throws(
        () => loadVerifiedGeneratedRouterDescriptor({ env, fsApi: growingFs }),
        /changed size while reading/,
    );
    assert.equal(apiKeyReads, 0);
});

test('topology selection freezes public and managed request-authority rules', () => {
    const base = {
        networkMode: 'default',
        runtimeProof,
        networkFingerprint,
        routerHostPort: 18080,
        edgeTopologyFile: '/run/ploinky/edge-topology/current.json',
        platform: 'linux',
    };
    const box = buildRouterAuthorityTopologyIntent({ ...base, fsApi: presentBoxFs() });
    assert.deepEqual(
        [box.topology, box.listenerClass, box.requestAuthority, box.publicAuthority],
        ['box-public-loopback', 'public', '127.0.0.1:18080', '127.0.0.1:18080'],
    );

    const native = buildRouterAuthorityTopologyIntent({ ...base, fsApi: missingBoxFs() });
    assert.deepEqual(
        [native.topology, native.listenerClass, native.requestAuthority, native.publicAuthority],
        ['native-linux-rootless-managed', 'managed', 'host.containers.internal:8080', '127.0.0.1:18080'],
    );

    const remote = buildRouterAuthorityTopologyIntent({
        ...base,
        runtimeProof: { ...runtimeProof, remote: true },
        fsApi: missingBoxFs(),
    });
    assert.deepEqual(
        [remote.topology, remote.listenerClass, remote.requestAuthority],
        ['remote-public-loopback', 'public', '127.0.0.1:18080'],
    );

    const macosRemote = buildRouterAuthorityTopologyIntent({
        ...base,
        runtimeProof: { ...runtimeProof, remote: true },
        platform: 'darwin',
        fsApi: missingBoxFs(),
    });
    assert.deepEqual(
        [macosRemote.topology, macosRemote.listenerClass, macosRemote.requestAuthority],
        ['macos-remote-public-loopback', 'public', '127.0.0.1:18080'],
    );

    const host = buildRouterAuthorityTopologyIntent({
        ...base,
        networkMode: 'host',
        fsApi: missingBoxFs(),
    });
    assert.deepEqual(
        [host.topology, host.listenerClass, host.physicalOrigin, host.requestAuthority],
        ['host-public-loopback', 'public', 'http://127.0.0.1:8080', '127.0.0.1:18080'],
    );
    assert.equal(buildRouterAuthorityTopologyIntent({ ...base, networkMode: 'none' }), null);
});

test('fixed public and managed attestation fixtures validate only in their exact cells', () => {
    const publicFixture = fixtureJson('public-attestation.json');
    const managedFixture = fixtureJson('managed-attestation.json');
    const publicIntent = buildRouterAuthorityTopologyIntent({
        networkMode: 'default',
        runtimeProof,
        networkFingerprint,
        routerHostPort: 18080,
        edgeTopologyFile: '/run/ploinky/edge-topology/current.json',
        platform: 'linux',
        fsApi: presentBoxFs(),
    });
    const managedIntent = buildRouterAuthorityTopologyIntent({
        networkMode: 'default',
        runtimeProof,
        networkFingerprint,
        routerHostPort: 18080,
        edgeTopologyFile: '/run/ploinky/edge-topology/current.json',
        platform: 'linux',
        fsApi: missingBoxFs(),
    });

    assert.doesNotThrow(() => validateRouterAuthorityObservation({
        intent: publicIntent,
        nonce: publicFixture.evidence.nonce,
        records: publicFixture.evidence.records,
        external: publicFixture.evidence.external,
        generationId: publicFixture.evidence.generationId,
        generationSnapshot: generationSnapshot(publicFixture),
    }));
    assert.doesNotThrow(() => validateRouterAuthorityObservation({
        intent: managedIntent,
        nonce: managedFixture.evidence.nonce,
        records: managedFixture.evidence.records,
        external: managedFixture.evidence.external,
        generationId: managedFixture.evidence.generationId,
    }));
    assert.throws(() => validateRouterAuthorityObservation({
        intent: managedIntent,
        nonce: publicFixture.evidence.nonce,
        records: publicFixture.evidence.records,
        external: publicFixture.evidence.external,
        generationId: publicFixture.evidence.generationId,
    }), /fixed topology cell/);

    for (const mutate of [
        (record) => ({ ...record, rawInterfaceClass: 'unknown' }),
        (record) => ({ ...record, socketLocalAddress: '203.0.113.9' }),
        (record) => ({ ...record, socketRemoteAddress: '127.0.0.1' }),
    ]) {
        const ambiguousRecords = publicFixture.evidence.records.map((record, index) => (
            index === 0 ? mutate(record) : record
        ));
        assert.throws(() => validateRouterAuthorityObservation({
            intent: publicIntent,
            nonce: publicFixture.evidence.nonce,
            records: ambiguousRecords,
            external: publicFixture.evidence.external,
            generationId: publicFixture.evidence.generationId,
            generationSnapshot: generationSnapshot(publicFixture),
        }), /socket\/interface evidence|socket address class/);
    }

    const nestedBoxHairpinRecords = publicFixture.evidence.records.map((record) => ({
        ...record,
        socketRemoteAddress: record.socketLocalAddress,
    }));
    assert.doesNotThrow(() => validateRouterAuthorityObservation({
        intent: publicIntent,
        nonce: publicFixture.evidence.nonce,
        records: nestedBoxHairpinRecords,
        external: publicFixture.evidence.external,
        generationId: publicFixture.evidence.generationId,
        generationSnapshot: generationSnapshot(publicFixture),
    }));
    assert.throws(() => validateRouterAuthorityObservation({
        intent: managedIntent,
        nonce: managedFixture.evidence.nonce,
        records: managedFixture.evidence.records.map((record) => ({
            ...record,
            socketRemoteAddress: record.socketLocalAddress,
        })),
        external: managedFixture.evidence.external,
        generationId: managedFixture.evidence.generationId,
    }), /socket address class/);
});

test('macOS remote attestation accepts only the exact stable AppleHV loopback proxy cell', () => {
    const fixture = fixtureJson('macos-remote-attestation.json');
    assert.equal(fixture.attestationId, sha256(canonicalJsonBytes(fixture.evidence)));
    assert.deepEqual(fixture.evidence.helper, {
        id: `sha256:${'5'.repeat(64)}`,
        image: `sha256:${'6'.repeat(64)}`,
        user: '65534:65534',
    });

    const intent = buildRouterAuthorityTopologyIntent({
        networkMode: 'default',
        runtimeProof: { ...runtimeProof, remote: true },
        networkFingerprint,
        routerHostPort: 18080,
        edgeTopologyFile: '/run/ploinky/edge-topology/current.json',
        platform: 'darwin',
        fsApi: missingBoxFs(),
    });
    const validate = ({
        nonce = fixture.evidence.nonce,
        records = fixture.evidence.records,
        external = fixture.evidence.external,
        generationId = fixture.evidence.generationId,
    } = {}) => validateRouterAuthorityObservation({ intent, nonce, records, external, generationId });

    assert.doesNotThrow(() => validate());
    for (const [name, mutate] of [
        ['raw class', (record) => ({ ...record, rawInterfaceClass: 'unmanaged' })],
        ['local alias', (record) => ({ ...record, socketLocalAddress: '127.0.0.2' })],
        ['remote alias', (record) => ({ ...record, socketRemoteAddress: '127.0.0.2' })],
        ['IPv6 loopback', (record) => ({ ...record, socketRemoteAddress: '::1' })],
    ]) {
        assert.throws(
            () => validate({ records: fixture.evidence.records.map((record, index) => index === 0 ? mutate(record) : record) }),
            /exact VM proxy cell/,
            name,
        );
    }
    assert.throws(
        () => validate({ nonce: 'not-a-nonce' }),
        /evidence is incomplete/,
    );
    assert.throws(
        () => validate({ records: fixture.evidence.records.map((record, index) => index === 0 ? { ...record, generationLeaseId: `sha256:${'f'.repeat(64)}` } : record) }),
        /generation changed/,
    );
    assert.throws(
        () => validate({ records: fixture.evidence.records.map((record, index) => index === 0 ? { ...record, rawHost: 'vm.proxy.invalid:8080' } : record) }),
        /exactly one internal observation/,
    );
    assert.throws(
        () => validate({ records: fixture.evidence.records.map((record, index) => index === 0 ? { ...record, routePlanStatus: 200 } : record) }),
        /fixed topology cell/,
    );
    assert.throws(
        () => validate({ external: fixture.evidence.external.map((record, index) => index === 0 ? { ...record, body: '{"error":"different"}' } : record) }),
        /external status\/body/,
    );
});

test('attestation registers, probes, consumes, then commits the generation before returning', () => {
    const fixture = fixtureJson('public-attestation.json');
    const intent = buildRouterAuthorityTopologyIntent({
        networkMode: 'default',
        runtimeProof,
        networkFingerprint,
        routerHostPort: 18080,
        edgeTopologyFile: '/run/ploinky/edge-topology/current.json',
        platform: 'linux',
        fsApi: presentBoxFs(),
    });
    const order = [];
    const result = attestRouterAuthority({
        intent,
        generationLease: {
            id: fixture.evidence.generationId,
            snapshot: generationSnapshot(fixture),
            commit() { order.push('commit'); return true; },
        },
        registryClient: {
            register(nonceValue, generationValue) {
                assert.match(nonceValue, /^[a-f0-9]{64}$/);
                assert.equal(generationValue, fixture.evidence.generationId);
                order.push('register');
            },
            consume() { order.push('consume'); return fixture.evidence.records; },
        },
        runProbe() {
            order.push('probe');
            return {
                external: fixture.evidence.external,
                helper: fixture.evidence.helper,
                target: { image: 'sha256:target', user: 'root' },
            };
        },
        now: () => fixture.evidence.observedAtUnixMs,
    });

    assert.deepEqual(order, ['register', 'probe', 'consume', 'commit']);
    assert.match(result.attestationId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.evidence.generationId, fixture.evidence.generationId);
    assert.deepEqual(result.evidence.target, { image: 'sha256:target', user: 'root' });
});

test('public-loopback attestation derives the encoded login owner from its immutable generation', () => {
    const fixture = fixtureJson('public-attestation.json');
    const intent = buildRouterAuthorityTopologyIntent({
        networkMode: 'default',
        runtimeProof,
        networkFingerprint,
        routerHostPort: 18080,
        edgeTopologyFile: '/run/ploinky/edge-topology/current.json',
        platform: 'linux',
        fsApi: presentBoxFs(),
    });
    const staticAgent = 'AchillesIDE/explorer';
    const external = fixture.evidence.external.map((record) => (
        record.host === intent.publicAuthority
            ? {
                ...record,
                body: '{"ok":false,"error":"not_authenticated","login":"/auth/login?returnTo=%2Fhealth&agent=AchillesIDE%2Fexplorer"}',
            }
            : record
    ));

    assert.doesNotThrow(() => attestRouterAuthority({
        intent,
        generationLease: {
            id: fixture.evidence.generationId,
            snapshot: generationSnapshot(fixture, staticAgent),
            commit() { return true; },
        },
        registryClient: {
            register() {},
            consume() { return fixture.evidence.records; },
        },
        runProbe() {
            return {
                external,
                helper: fixture.evidence.helper,
                target: { image: 'sha256:target', user: '1000:1000' },
            };
        },
    }));

    assert.throws(() => validateRouterAuthorityObservation({
        intent,
        nonce: fixture.evidence.nonce,
        records: fixture.evidence.records,
        external: external.map((record) => (
            record.host === intent.publicAuthority
                ? { ...record, body: record.body.replace('AchillesIDE%2Fexplorer', 'AchillesIDE/explorer') }
                : record
        )),
        generationId: fixture.evidence.generationId,
        generationSnapshot: generationSnapshot(fixture, staticAgent),
    }), /external status\/body/);
    assert.throws(() => validateRouterAuthorityObservation({
        intent,
        nonce: fixture.evidence.nonce,
        records: fixture.evidence.records,
        external,
        generationId: fixture.evidence.generationId,
        generationSnapshot: {
            ...generationSnapshot(fixture, staticAgent),
            generation: `sha256:${'f'.repeat(64)}`,
        },
    }), /snapshot generation changed/);
});

function externalProbeTimeoutError({
    operation = 'external-helper-probe',
    code = ROUTER_AUTHORITY_EXTERNAL_PROBE_TIMEOUT,
    timeoutMs = 15_000,
} = {}) {
    return new RouterAuthorityAttestationError(code, 'external helper probe timed out', {
        context: {
            operation,
            timeoutMs,
            timedOut: true,
        },
    });
}

function publicAttestationInputs() {
    const fixture = fixtureJson('public-attestation.json');
    const intent = buildRouterAuthorityTopologyIntent({
        networkMode: 'default',
        runtimeProof,
        networkFingerprint,
        routerHostPort: 18080,
        edgeTopologyFile: '/run/ploinky/edge-topology/current.json',
        platform: 'linux',
        fsApi: presentBoxFs(),
    });
    return { fixture, intent };
}

test('external helper timeout retries the entire fresh-nonce transaction once before one generation commit', () => {
    const { fixture, intent } = publicAttestationInputs();
    const order = [];
    const registered = [];
    let probeCalls = 0;
    let commitCalls = 0;
    const result = attestRouterAuthority({
        intent,
        generationLease: {
            id: fixture.evidence.generationId,
            snapshot: generationSnapshot(fixture),
            commit() {
                commitCalls += 1;
                order.push('commit');
                return true;
            },
        },
        registryClient: {
            register(nonce, generationId) {
                assert.equal(generationId, fixture.evidence.generationId);
                registered.push(nonce);
                order.push(`register:${nonce}`);
            },
            consume(nonce) {
                assert.equal(nonce, registered[1]);
                order.push(`consume:${nonce}`);
                return fixture.evidence.records;
            },
        },
        runProbe({ nonce }) {
            probeCalls += 1;
            order.push(`probe:${nonce}`);
            if (probeCalls === 1) throw externalProbeTimeoutError();
            return {
                external: fixture.evidence.external,
                helper: fixture.evidence.helper,
                target: { image: 'sha256:target', user: '1000:1000' },
            };
        },
        now: () => fixture.evidence.observedAtUnixMs,
    });

    assert.equal(registered.length, 2);
    assert.match(registered[0], /^[a-f0-9]{64}$/);
    assert.match(registered[1], /^[a-f0-9]{64}$/);
    assert.notEqual(registered[0], registered[1]);
    assert.deepEqual(order, [
        `register:${registered[0]}`,
        `probe:${registered[0]}`,
        `register:${registered[1]}`,
        `probe:${registered[1]}`,
        `consume:${registered[1]}`,
        'commit',
    ]);
    assert.equal(commitCalls, 1);
    assert.equal(result.evidence.nonce, registered[1]);
    assert.equal(result.evidence.generationId, fixture.evidence.generationId);
});

test('a second external helper timeout fails closed without consume or generation commit', () => {
    const { fixture, intent } = publicAttestationInputs();
    const nonces = [];
    let consumeCalls = 0;
    let commitCalls = 0;
    const secondTimeout = externalProbeTimeoutError();

    assert.throws(
        () => attestRouterAuthority({
            intent,
            generationLease: {
                id: fixture.evidence.generationId,
                snapshot: generationSnapshot(fixture),
                commit() { commitCalls += 1; return true; },
            },
            registryClient: {
                register(nonce) { nonces.push(nonce); },
                consume() { consumeCalls += 1; return fixture.evidence.records; },
            },
            runProbe() {
                if (nonces.length === 1) throw externalProbeTimeoutError();
                throw secondTimeout;
            },
        }),
        (error) => error === secondTimeout,
    );
    assert.equal(nonces.length, 2);
    assert.notEqual(nonces[0], nonces[1]);
    assert.equal(consumeCalls, 0);
    assert.equal(commitCalls, 0);
});

test('registry, validation, generation, cleanup, wrong-operation, and generic failures are never retried', () => {
    const { fixture, intent } = publicAttestationInputs();
    const invoke = ({ register, probe, consume, commit } = {}) => {
        const counts = { register: 0, probe: 0, consume: 0, commit: 0 };
        let thrown;
        try {
            attestRouterAuthority({
                intent,
                generationLease: {
                    id: fixture.evidence.generationId,
                    snapshot: generationSnapshot(fixture),
                    commit() {
                        counts.commit += 1;
                        return commit ? commit() : true;
                    },
                },
                registryClient: {
                    register(...args) {
                        counts.register += 1;
                        return register?.(...args);
                    },
                    consume(...args) {
                        counts.consume += 1;
                        return consume ? consume(...args) : fixture.evidence.records;
                    },
                },
                runProbe(...args) {
                    counts.probe += 1;
                    return probe ? probe(...args) : {
                        external: fixture.evidence.external,
                        helper: fixture.evidence.helper,
                        target: { image: 'sha256:target', user: '1000:1000' },
                    };
                },
            });
        } catch (error) {
            thrown = error;
        }
        return { counts, thrown };
    };

    const registrationFailure = externalProbeTimeoutError();
    assert.deepEqual(
        invoke({ register() { throw registrationFailure; } }),
        { counts: { register: 1, probe: 0, consume: 0, commit: 0 }, thrown: registrationFailure },
    );

    const consumptionFailure = externalProbeTimeoutError();
    assert.deepEqual(
        invoke({ consume() { throw consumptionFailure; } }),
        { counts: { register: 1, probe: 1, consume: 1, commit: 0 }, thrown: consumptionFailure },
    );

    const cleanupFailure = new RouterAuthorityAttestationError(
        'PLOINKY_ROUTER_ATTESTATION_CLEANUP',
        'cleanup failed',
        { context: { operation: 'helper-remove', timedOut: true } },
    );
    assert.deepEqual(
        invoke({ probe() { throw cleanupFailure; } }),
        { counts: { register: 1, probe: 1, consume: 0, commit: 0 }, thrown: cleanupFailure },
    );

    const wrongOperation = externalProbeTimeoutError({ operation: 'private-registry-request' });
    assert.deepEqual(
        invoke({ probe() { throw wrongOperation; } }),
        { counts: { register: 1, probe: 1, consume: 0, commit: 0 }, thrown: wrongOperation },
    );

    const wrongTimeout = externalProbeTimeoutError({ timeoutMs: 14_999 });
    assert.deepEqual(
        invoke({ probe() { throw wrongTimeout; } }),
        { counts: { register: 1, probe: 1, consume: 0, commit: 0 }, thrown: wrongTimeout },
    );

    const wrongCode = externalProbeTimeoutError({
        code: 'PLOINKY_ROUTER_ATTESTATION_HELPER_OPERATION_FAILED',
    });
    assert.deepEqual(
        invoke({ probe() { throw wrongCode; } }),
        { counts: { register: 1, probe: 1, consume: 0, commit: 0 }, thrown: wrongCode },
    );

    const genericFailure = new Error('generic probe failure');
    assert.deepEqual(
        invoke({ probe() { throw genericFailure; } }),
        { counts: { register: 1, probe: 1, consume: 0, commit: 0 }, thrown: genericFailure },
    );

    const validationFailure = invoke({
        probe() {
            return {
                external: fixture.evidence.external.map((record, index) => (
                    index === 0 ? { ...record, status: 200 } : record
                )),
                helper: fixture.evidence.helper,
                target: { image: 'sha256:target', user: '1000:1000' },
            };
        },
    });
    assert.deepEqual(validationFailure.counts, { register: 1, probe: 1, consume: 1, commit: 0 });
    assert.equal(validationFailure.thrown?.code, 'PLOINKY_ROUTER_ATTESTATION_MISMATCH');

    const generationFailure = invoke({ commit: () => false });
    assert.deepEqual(generationFailure.counts, { register: 1, probe: 1, consume: 1, commit: 1 });
    assert.equal(generationFailure.thrown?.code, 'PLOINKY_ROUTER_ATTESTATION_GENERATION');
});

test('the exact podman start-attach request timeout has immutable retry classification context', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-authority-timeout-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateFile = path.join(root, 'state.json');
    const fakePodman = path.join(root, 'podman');
    const helperId = `sha256:${'3'.repeat(64)}`;
    const helperImageId = `sha256:${'2'.repeat(64)}`;
    const targetImageId = `sha256:${'1'.repeat(64)}`;
    fs.writeFileSync(fakePodman, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const stateFile = ${JSON.stringify(stateFile)};
const helperId = ${JSON.stringify(helperId)};
const helperImageId = ${JSON.stringify(helperImageId)};
const targetImageId = ${JSON.stringify(targetImageId)};
if (args[0] === 'image' && args[1] === 'inspect' && args[3] === '{{.Id}}') {
  process.stdout.write(args[4] === ${JSON.stringify(ROUTER_AUTHORITY_HELPER_IMAGE)} ? helperImageId : targetImageId);
} else if (args[0] === 'image' && args[1] === 'inspect' && args[3] === '{{.Config.User}}') {
  process.stdout.write('1000:1000');
} else if (args[0] === 'create') {
  const label = args[args.indexOf('--label') + 1];
  fs.writeFileSync(stateFile, JSON.stringify({ nonce: label.split('=')[1], createArgs: args }));
  process.stdout.write(helperId);
} else if (args[0] === 'container' && args[1] === 'inspect') {
  const { nonce } = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  process.stdout.write(JSON.stringify({
    id: helperId, image: helperImageId, user: '65534:65534', entrypoint: ['node'],
    init: true, readonlyRootfs: true, pidsLimit: 32, memory: 67108864, nanoCpus: 250000000,
    networkMode: 'test-network', extraHosts: ['host.containers.internal:host-gateway'],
    mountCount: 0, bindCount: 0, tmpfsCount: 0, portBindingCount: 0,
    capDrop: ['ALL'], capAdd: [], securityOpt: ['no-new-privileges'], env: ['PATH=/usr/bin'],
    helperLabel: nonce, networks: { 'test-network': {} }, running: false, status: 'exited',
  }));
} else if (args[0] === 'start' && args[1] === '--attach') {
  process.stderr.write('request timed out');
  process.exitCode = 1;
} else if (args[0] === 'rm') {
  process.exitCode = 0;
} else if (args[0] === 'container' && args[1] === 'exists') {
  process.exitCode = 1;
} else {
  process.stderr.write('unexpected fake podman operation: ' + JSON.stringify(args));
  process.exitCode = 2;
}
`, { mode: 0o700 });

    const originalPath = process.env.PATH;
    process.env.PATH = `${root}${path.delimiter}${originalPath || ''}`;
    t.after(() => { process.env.PATH = originalPath; });
    const nonce = 'a'.repeat(64);
    let thrown;
    try {
        runContainerAuthorityProbe({
            runtime: 'podman',
            image: 'example.test/agent@sha256:fixture',
            nonce,
            intent: {
                physicalOrigin: 'http://host.containers.internal:8080',
                requestAuthority: 'host.containers.internal:8080',
                publicAuthority: '127.0.0.1:18080',
            },
            plan: {
                mode: 'default',
                alias: 'fixture-agent',
                attachments: [{ name: 'test-network', primary: true }],
                args: [
                    '--network', 'test-network',
                    '--network-alias', 'fixture-agent',
                    '--add-host', 'host.containers.internal:host-gateway',
                ],
            },
        });
    } catch (error) {
        thrown = error;
    }

    const { createArgs } = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(createArgs[0], 'create');
    assert.equal(createArgs.filter((arg) => arg === '--pull=never').length, 1);
    assert.ok(createArgs.indexOf('--pull=never') < createArgs.indexOf(helperImageId));
    assert.equal(thrown instanceof RouterAuthorityAttestationError, true);
    assert.equal(thrown.code, ROUTER_AUTHORITY_EXTERNAL_PROBE_TIMEOUT);
    assert.deepEqual(thrown.context, {
        operation: 'external-helper-probe',
        timeoutMs: 15_000,
        timedOut: true,
    });
    assert.equal(Object.isFrozen(thrown.context), true);
    assert.equal(Object.getOwnPropertyDescriptor(thrown, 'code')?.writable, false);
    assert.equal(Object.getOwnPropertyDescriptor(thrown, 'context')?.writable, false);
    assert.throws(() => { thrown.code = 'MUTATED'; }, TypeError);
    assert.throws(() => { thrown.context.operation = 'MUTATED'; }, TypeError);
});
