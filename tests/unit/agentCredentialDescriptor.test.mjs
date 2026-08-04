import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agent-credential-'));
const originalWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = tempRoot;

const producer = await import(`../../cli/sandbox/bwrap/bwrapAgentCredential.js?test=${Date.now()}`);
const descriptorModule = await import(`../../Agent/lib/agentCredentialDescriptor.mjs?test=${Date.now()}`);

const {
    BWRAP_AGENT_CREDENTIAL_FILE,
    BWRAP_AGENT_CREDENTIAL_MAX_BYTES,
    BWRAP_AGENT_CREDENTIAL_TTL_SECONDS,
    buildBwrapAgentCredential,
} = producer;
const {
    canonicalAgentCredentialJson,
    serializeAgentCredentialDescriptor,
    __testables,
} = descriptorModule;

const manifestBytes = Buffer.from('{"name":"fixture","lite-sandbox":true}\n', 'utf8');
const manifestDigest = `sha256:${crypto.createHash('sha256').update(manifestBytes).digest('hex')}`;
const issuedAt = 1_800_000_000;
const principalId = 'agent:AchillesCLI/codexAgent';

function credentialEnv(overrides = {}) {
    return {
        PLOINKY_AGENT_SECRET: 'a'.repeat(64),
        PLOINKY_AGENT_PRIVATE_SECRET: 'b'.repeat(64),
        PLOINKY_AGENT_API_KEY: `${principalId}|fixture-signature`,
        PLOINKY_AGENT_API_PUBLIC_KEY: Buffer.alloc(32, 9).toString('base64url'),
        ...overrides,
    };
}

function input(overrides = {}) {
    return {
        principalId,
        instanceId: '8d13c4e5-f0d4-4ac9-8528-19a728c15d34',
        enableGeneration: '15a52495-4b47-4f65-a4de-831d53ea86d2',
        runtimeKey: 'codexAgent-ab12',
        routeKey: 'codexAgent',
        router: {
            physicalOrigin: 'http://127.0.0.1:8080',
            requestAuthority: '127.0.0.1:49152',
            host: '127.0.0.1',
            port: 8080,
        },
        admission: {
            runtimeKind: 'bwrap',
            manifestDigest,
            capabilityDigest: `sha256:${'c'.repeat(64)}`,
            networkHash: `sha256:${'d'.repeat(64)}`,
        },
        ...overrides,
    };
}

function build(overrides = {}, dependencyOverrides = {}) {
    return buildBwrapAgentCredential(input(overrides), {
        now: issuedAt,
        randomBytes: () => Buffer.alloc(32, 7),
        buildCredentialEnv: () => credentialEnv(),
        ...dependencyOverrides,
    });
}

function generatedEnv(descriptor, overrides = {}) {
    const values = {
        PLOINKY_AGENT_ID: descriptor.principalId,
        PLOINKY_AGENT_PRINCIPAL: descriptor.principalId,
        PLOINKY_AGENT_INSTANCE_ID: descriptor.instanceId,
        PLOINKY_AGENT_ENABLE_GENERATION: descriptor.enableGeneration,
        PLOINKY_AGENT_CREDENTIAL_FILE: BWRAP_AGENT_CREDENTIAL_FILE,
    };
    for (const name of Object.keys(values)) values[`PLOINKY_ENV_SOURCE_${name}`] = 'generated';
    return { ...values, ...overrides };
}

function writeFixture(bytes, { mode = 0o400, name = `credential-${crypto.randomUUID()}.json` } = {}) {
    const credentialPath = path.join(tempRoot, name);
    fs.writeFileSync(credentialPath, bytes, { mode: 0o600 });
    fs.chmodSync(credentialPath, mode);
    const manifestPath = path.join(tempRoot, `manifest-${crypto.randomUUID()}.json`);
    fs.writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
    return { credentialPath, manifestPath };
}

function read(bytes, descriptor, overrides = {}) {
    const fixture = writeFixture(bytes, overrides.file || {});
    return __testables.readAgentCredentialDescriptorFile({
        ...fixture,
        env: generatedEnv(descriptor, overrides.env || {}),
        now: overrides.now ?? issuedAt,
        ...(overrides.expectedUid === undefined ? {} : { expectedUid: overrides.expectedUid }),
    });
}

test.after(() => {
    if (originalWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = originalWorkspaceRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('producer emits one strict bounded canonical descriptor and public-only attestation', () => {
    const generated = build();
    assert.equal(BWRAP_AGENT_CREDENTIAL_FILE, '/run/ploinky-agent/credential.json');
    assert.equal(BWRAP_AGENT_CREDENTIAL_MAX_BYTES, 4096);
    assert.equal(BWRAP_AGENT_CREDENTIAL_TTL_SECONDS, 86400);
    assert.equal(Object.keys(producer).some((name) => /write|persist/i.test(name)), false);
    assert.equal(generated.bytes.length <= 4096, true);
    assert.equal(generated.bytes.at(-1), 0x0a);
    assert.equal(generated.bytes.toString('utf8'), `${canonicalAgentCredentialJson(generated.descriptor)}\n`);
    assert.equal(generated.descriptor.expiresAt - generated.descriptor.issuedAt, 86400);
    assert.equal(generated.descriptor.nonce, Buffer.alloc(32, 7).toString('base64url'));
    assert.equal(generated.descriptor.admissionDigest, __testables.admissionDigest(generated.descriptor.admission));
    assert.equal(generated.publicAttestation.nonceDigest, __testables.nonceDigest(generated.descriptor.nonce));
    assert.equal(Object.isFrozen(generated.descriptor), true);
    assert.equal(Object.isFrozen(generated.publicAttestation), true);
    const publicJson = JSON.stringify(generated.publicAttestation);
    assert.doesNotMatch(publicJson, /fixture-signature|"credentials"|"nonce"/);
    assert.equal('PLOINKY_MASTER_KEY' in generated.descriptor.credentials, false);
    assert.equal('PLOINKY_DERIVED_MASTER_KEY' in generated.descriptor.credentials, false);
});

test('producer uses only the four mapped outputs from buildAgentCredentialEnv', () => {
    const generated = build({}, {
        buildCredentialEnv: () => credentialEnv({
            PLOINKY_MASTER_KEY: 'must-not-cross',
            PLOINKY_DERIVED_MASTER_KEY: 'must-not-cross',
            PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY: 'generated',
        }),
    });
    assert.deepEqual(Object.keys(generated.descriptor.credentials).sort(), [
        'agentSecret', 'apiKey', 'apiPublicKey', 'privateSecret',
    ]);
    assert.equal(JSON.stringify(generated).includes('must-not-cross'), false);
});

test('producer rejects invalid identity, router, admission, nonce dependency, and bounds', () => {
    assert.throws(() => build({ principalId: 'agent:bad/with space' }), /principalId/);
    assert.throws(() => build({ runtimeKey: '../escape' }), /runtimeKey/);
    assert.throws(() => build({ routeKey: '' }), /routeKey/);
    assert.throws(() => build({ legacyCredentialPath: '/tmp/credential' }), /missing or unknown fields/);
    assert.throws(() => build({ router: { ...input().router, host: 'localhost' } }), /fixed inner loopback/);
    assert.throws(() => build({ router: { ...input().router, requestAuthority: '127.0.0.1:65536' } }), /requestAuthority/);
    assert.throws(() => build({ admission: { ...input().admission, networkHash: 'd'.repeat(64) } }), /networkHash/);
    assert.throws(() => build({}, { randomBytes: () => Buffer.alloc(31) }), /exactly 32 bytes/);
    assert.throws(() => build({}, {
        buildCredentialEnv: () => credentialEnv({
            PLOINKY_AGENT_API_KEY: `${principalId}|${'x'.repeat(3900)}`,
        }),
    }), /bounded value|4096 bytes/);
});

test('reader validates canonical bytes, mode, uid, EOF bound, and exact file type', () => {
    const generated = build();
    const verified = read(generated.bytes, generated.descriptor);
    assert.deepEqual(verified.descriptor, generated.descriptor);
    assert.equal(verified.bytes.equals(generated.bytes), true);

    assert.throws(
        () => read(generated.bytes, generated.descriptor, { file: { mode: 0o600 } }),
        /0400 regular file/,
    );
    if (typeof process.getuid === 'function') {
        assert.throws(
            () => read(generated.bytes, generated.descriptor, { expectedUid: process.getuid() + 1 }),
            /current-uid 0400 regular file/,
        );
    }
    const oversized = Buffer.alloc(BWRAP_AGENT_CREDENTIAL_MAX_BYTES + 1, 0x61);
    assert.throws(() => read(oversized, generated.descriptor), /no larger than 4096 bytes/);

    const directoryPath = path.join(tempRoot, `credential-directory-${crypto.randomUUID()}`);
    fs.mkdirSync(directoryPath, { mode: 0o400 });
    const manifestPath = path.join(tempRoot, `manifest-${crypto.randomUUID()}.json`);
    fs.writeFileSync(manifestPath, manifestBytes);
    assert.throws(() => __testables.readAgentCredentialDescriptorFile({
        credentialPath: directoryPath,
        manifestPath,
        env: generatedEnv(generated.descriptor),
        now: issuedAt,
    }), /0400 regular file/);
});

test('reader opens with no-follow and rejects a credential symlink', () => {
    const generated = build();
    const target = writeFixture(generated.bytes, { name: `target-${crypto.randomUUID()}.json` });
    const link = path.join(tempRoot, `link-${crypto.randomUUID()}.json`);
    fs.symlinkSync(target.credentialPath, link);
    assert.throws(() => __testables.readAgentCredentialDescriptorFile({
        credentialPath: link,
        manifestPath: target.manifestPath,
        env: generatedEnv(generated.descriptor),
        now: issuedAt,
    }), /unavailable or unsafe/);
});

test('reader requires exact key sets and canonical JSON plus one newline', () => {
    const generated = build();
    const reordered = `${JSON.stringify(generated.descriptor)}\n`;
    assert.notEqual(reordered, generated.bytes.toString('utf8'));
    assert.throws(
        () => read(Buffer.from(reordered), generated.descriptor),
        /exact canonical JSON plus newline/,
    );
    assert.throws(
        () => read(Buffer.from(generated.bytes.toString('utf8').trimEnd()), generated.descriptor),
        /exact canonical JSON plus newline/,
    );
    const unknown = JSON.parse(JSON.stringify(generated.descriptor));
    unknown.legacy = true;
    assert.throws(
        () => read(Buffer.from(`${canonicalAgentCredentialJson(unknown)}\n`), generated.descriptor),
        /missing or unknown fields/,
    );
});

test('reader rejects inactive time, admission mutation, manifest mismatch, and env identity mismatch', () => {
    const generated = build();
    assert.throws(
        () => read(generated.bytes, generated.descriptor, { now: issuedAt - 1 }),
        /not active/,
    );
    assert.throws(
        () => read(generated.bytes, generated.descriptor, { now: generated.descriptor.expiresAt }),
        /not active/,
    );

    const changedAdmission = JSON.parse(JSON.stringify(generated.descriptor));
    changedAdmission.admission.networkHash = `sha256:${'e'.repeat(64)}`;
    const changedBytes = Buffer.from(`${canonicalAgentCredentialJson(changedAdmission)}\n`);
    assert.throws(() => read(changedBytes, changedAdmission), /admissionDigest/);

    const badManifestPath = path.join(tempRoot, `bad-manifest-${crypto.randomUUID()}.json`);
    fs.writeFileSync(badManifestPath, '{}\n');
    const credentialPath = writeFixture(generated.bytes).credentialPath;
    assert.throws(() => __testables.readAgentCredentialDescriptorFile({
        credentialPath,
        manifestPath: badManifestPath,
        env: generatedEnv(generated.descriptor),
        now: issuedAt,
    }), /manifest digest/);

    assert.throws(
        () => read(generated.bytes, generated.descriptor, {
            env: { PLOINKY_AGENT_INSTANCE_ID: 'different' },
        }),
        /does not match generated credential identity/,
    );
    assert.throws(
        () => read(generated.bytes, generated.descriptor, {
            env: { PLOINKY_ENV_SOURCE_PLOINKY_AGENT_PRINCIPAL: 'manifest' },
        }),
        /does not match generated credential identity/,
    );
    assert.throws(
        () => read(generated.bytes, generated.descriptor, {
            env: { PLOINKY_AGENT_CREDENTIAL_FILE: undefined },
        }),
        /locator does not have exact generated provenance/,
    );
});
