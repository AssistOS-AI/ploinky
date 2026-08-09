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
    createPrivateAuthorityRegistryClient,
    validateRouterAuthorityObservation,
} from '../../cli/sandbox/routerAuthorityAttestation.js';
import {
    AUTHORITY_ATTESTATION_TTL_MS,
    createRouterAuthorityAttestationRegistry,
} from '../../cli/server/routerAuthorityAttestationRegistry.js';
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

test('attestation brackets only live observations with registration and consumption', () => {
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
        runProbe({ registerObservation, consumeObservation }) {
            order.push('prepare');
            registerObservation();
            order.push('probe');
            consumeObservation();
            order.push('cleanup');
            return {
                external: fixture.evidence.external,
                helper: fixture.evidence.helper,
                target: { image: 'sha256:target', user: 'root' },
            };
        },
        now: () => fixture.evidence.observedAtUnixMs,
    });

    assert.deepEqual(order, ['prepare', 'register', 'probe', 'consume', 'cleanup', 'commit']);
    assert.match(result.attestationId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.evidence.generationId, fixture.evidence.generationId);
    assert.deepEqual(result.evidence.target, { image: 'sha256:target', user: 'root' });
});

test('slow helper preparation and cleanup do not consume the ten-second observation lifetime', () => {
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
    let monotonicNow = 0;
    const registry = createRouterAuthorityAttestationRegistry({ now: () => monotonicNow });
    const order = [];
    const result = attestRouterAuthority({
        intent,
        generationLease: {
            id: fixture.evidence.generationId,
            commit() { order.push('commit'); return true; },
        },
        registryClient: {
            register(nonceValue, generationValue) {
                order.push('register');
                assert.deepEqual(registry.register(nonceValue, generationValue), {
                    ok: true,
                    status: 'registered',
                });
            },
            consume(nonceValue) {
                order.push('consume');
                const consumed = registry.consume(nonceValue);
                assert.equal(consumed.ok, true);
                return consumed.records;
            },
        },
        runProbe({ nonce, registerObservation, consumeObservation }) {
            monotonicNow += AUTHORITY_ATTESTATION_TTL_MS * 3;
            order.push('prepared');
            registerObservation();
            for (const record of fixture.evidence.records) {
                assert.equal(registry.record(nonce, record), true);
            }
            monotonicNow += AUTHORITY_ATTESTATION_TTL_MS - 1;
            order.push('observed');
            consumeObservation();
            monotonicNow += AUTHORITY_ATTESTATION_TTL_MS * 3;
            order.push('cleaned');
            return {
                external: fixture.evidence.external,
                helper: fixture.evidence.helper,
                target: { image: 'sha256:target', user: 'root' },
            };
        },
        now: () => fixture.evidence.observedAtUnixMs,
    });

    assert.deepEqual(order, ['prepared', 'register', 'observed', 'consume', 'cleaned', 'commit']);
    assert.match(result.attestationId, /^sha256:[a-f0-9]{64}$/);
});

test('attestation rejects missing and repeated observation lifecycle transitions', () => {
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
    const generationLease = { id: fixture.evidence.generationId, commit: () => true };
    const registryClient = {
        register() {},
        consume() { return fixture.evidence.records; },
    };

    assert.throws(() => attestRouterAuthority({
        intent,
        generationLease,
        registryClient,
        runProbe: () => ({
            external: fixture.evidence.external,
            helper: fixture.evidence.helper,
            target: { image: 'sha256:target', user: 'root' },
        }),
    }), /did not complete its exact observation lifecycle/);
    assert.throws(() => attestRouterAuthority({
        intent,
        generationLease,
        registryClient,
        runProbe({ registerObservation }) {
            registerObservation();
            registerObservation();
        },
    }), /registration must occur exactly once/);
});

test('private registry client preserves only sanitized HTTP rejection details', () => {
    const responses = [
        { status: 409, body: '{"ok":false,"error":"AUTHORITY_ATTESTATION_INCOMPLETE"}' },
        { status: 503, body: '{"error":"secret bearer value"}' },
    ];
    const client = createPrivateAuthorityRegistryClient({
        socketPath: '/unused/test.sock',
        request() { return responses.shift(); },
    });
    assert.throws(
        () => client.consume('a'.repeat(64)),
        /authority observation consumption failed \(HTTP 409 AUTHORITY_ATTESTATION_INCOMPLETE\)/,
    );
    assert.throws(
        () => client.register('b'.repeat(64), fixtureJson('public-attestation.json').evidence.generationId),
        (error) => error.message === 'authority nonce registration failed (HTTP 503)',
    );
});
