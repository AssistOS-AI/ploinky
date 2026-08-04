import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    assertAgentCredentialContext,
    createContainerAgentCredentialContext,
    __testables as contextTestables,
} from '../../Agent/lib/agentCredentialContext.mjs';
import { buildBwrapAgentCredential } from '../../cli/sandbox/bwrap/bwrapAgentCredential.js';

const now = Math.floor(Date.now() / 1000);
const principalId = 'agent:AchillesCLI/codexAgent';
const secret = 'a'.repeat(64);
const privateSecret = 'b'.repeat(64);
const apiKey = `${principalId}|fixture-signature`;
const apiPublicKey = Buffer.alloc(32, 4).toString('base64url');

function buildCredential(issuedAt = now - 10) {
    return buildBwrapAgentCredential({
        principalId,
        instanceId: '11111111-2222-4333-8444-555555555555',
        enableGeneration: '66666666-7777-4888-8999-aaaaaaaaaaaa',
        runtimeKey: 'codexAgent-ab12',
        routeKey: 'codexAgent',
        router: {
            physicalOrigin: 'http://127.0.0.1:8080',
            requestAuthority: '127.0.0.1:18080',
            host: '127.0.0.1',
            port: 8080,
        },
        admission: {
            runtimeKind: 'bwrap',
            manifestDigest: `sha256:${'1'.repeat(64)}`,
            capabilityDigest: `sha256:${'2'.repeat(64)}`,
            networkHash: `sha256:${'3'.repeat(64)}`,
        },
    }, {
        now: issuedAt,
        randomBytes: () => Buffer.alloc(32, 5),
        buildCredentialEnv: () => ({
            PLOINKY_AGENT_SECRET: secret,
            PLOINKY_AGENT_PRIVATE_SECRET: privateSecret,
            PLOINKY_AGENT_API_KEY: apiKey,
            PLOINKY_AGENT_API_PUBLIC_KEY: apiPublicKey,
        }),
    });
}

function contextFrom(generated) {
    return contextTestables.createBwrapContextFromRead({
        descriptor: generated.descriptor,
        publicAttestation: generated.publicAttestation,
    });
}

test('bwrap context exposes only deeply frozen public metadata and non-enumerable trusted methods', () => {
    const context = contextFrom(buildCredential());
    assert.equal(assertAgentCredentialContext(context), context);
    assert.deepEqual(Object.keys(context), ['identity', 'runtime', 'router', 'attestation', 'source']);
    assert.deepEqual(context.identity, {
        principalId,
        instanceId: '11111111-2222-4333-8444-555555555555',
        enableGeneration: '66666666-7777-4888-8999-aaaaaaaaaaaa',
    });
    assert.deepEqual(context.runtime, {
        runtimeKind: 'bwrap',
        runtimeKey: 'codexAgent-ab12',
        routeKey: 'codexAgent',
    });
    assert.equal(context.source, 'bwrap-credential-v1');
    assert.equal(Object.isFrozen(context), true);
    assert.equal(Object.isFrozen(context.identity), true);
    assert.equal(Object.isFrozen(context.runtime), true);
    assert.equal(Object.isFrozen(context.router), true);
    assert.equal(Object.isFrozen(context.attestation), true);
    assert.throws(() => { context.router.port = 9; }, TypeError);
    for (const method of [
        'assertActive',
        'getAgentSecret',
        'getPrivateAgentSecret',
        'getAgentApiKey',
        'getAgentApiPublicKey',
    ]) {
        assert.equal(typeof context[method], 'function');
        assert.equal(Object.prototype.propertyIsEnumerable.call(context, method), false);
    }
});

test('secret access stays branded and out of public enumeration and serialization', () => {
    const context = contextFrom(buildCredential());
    assert.equal(context.getAgentSecret(), secret);
    assert.equal(context.getPrivateAgentSecret(), privateSecret);
    assert.equal(context.getAgentApiKey(), apiKey);
    assert.equal(context.getAgentApiPublicKey(), apiPublicKey);
    const publicText = JSON.stringify(context);
    assert.doesNotMatch(publicText, new RegExp(secret));
    assert.doesNotMatch(publicText, new RegExp(privateSecret));
    assert.doesNotMatch(publicText, /fixture-signature/);
    assert.doesNotMatch(publicText, /"nonce"/);
    assert.deepEqual(
        Reflect.ownKeys(context).filter((key) => typeof key === 'string' && key.includes('Secret')),
        ['getAgentSecret', 'getPrivateAgentSecret'],
    );

    const forged = Object.freeze({
        identity: context.identity,
        runtime: context.runtime,
        router: context.router,
        attestation: context.attestation,
        source: context.source,
    });
    assert.throws(() => assertAgentCredentialContext(forged), /trusted AgentCredentialContext/);
    const detachedGetter = context.getAgentSecret;
    assert.throws(() => detachedGetter(), /trusted AgentCredentialContext/);
    assert.throws(() => context.getAgentSecret.call(forged), /trusted AgentCredentialContext/);
});

test('expired or not-yet-active bwrap contexts refuse every secret getter', () => {
    const expired = contextFrom(buildCredential(now - 86401));
    assert.throws(() => expired.assertActive(now), /not active/);
    assert.throws(() => expired.getAgentSecret(), /not active/);
    assert.throws(() => expired.getPrivateAgentSecret(), /not active/);
    assert.throws(() => expired.getAgentApiKey(), /not active/);
    assert.throws(() => expired.getAgentApiPublicKey(), /not active/);

    const future = contextFrom(buildCredential(now + 10));
    assert.throws(() => future.assertActive(now), /not active/);
    assert.throws(() => future.assertActive(1.5), /nonnegative Unix seconds/);
});

test('container adapter requires an explicit generated container environment and never reconstructs bwrap secrets', () => {
    assert.throws(() => createContainerAgentCredentialContext(), /explicit container environment/);
    assert.throws(
        () => createContainerAgentCredentialContext({ PLOINKY_RUNTIME: 'bwrap' }),
        /forbidden for a host sandbox runtime/,
    );
    assert.throws(
        () => createContainerAgentCredentialContext({ PLOINKY_RUNTIME: ' SEATBELT ' }),
        /forbidden for a host sandbox runtime/,
    );
    assert.throws(
        () => createContainerAgentCredentialContext({
            PLOINKY_AGENT_CREDENTIAL_FILE: '/run/ploinky-agent/credential.json',
        }),
        /forbidden for a host sandbox runtime/,
    );
});

test('container adapter preserves the signed generated-local container contract', (t) => {
    const fixtureRoot = path.resolve('tests/fixtures/router-descriptor');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-container-context-'));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const descriptorFile = path.join(tempDir, 'router-descriptor.json');
    fs.copyFileSync(path.join(fixtureRoot, 'public-envelope.json'), descriptorFile);
    fs.chmodSync(descriptorFile, 0o600);
    const env = JSON.parse(fs.readFileSync(
        path.join(fixtureRoot, 'public-environment.json'),
        'utf8',
    ));
    env.PLOINKY_ROUTER_DESCRIPTOR_FILE = descriptorFile;
    env.PLOINKY_AGENT_SECRET = secret;
    env.PLOINKY_AGENT_PRIVATE_SECRET = privateSecret;

    const context = createContainerAgentCredentialContext(env);
    assert.equal(context.source, 'container-generated-env-v1');
    assert.equal(context.runtime.runtimeKind, 'container');
    assert.equal(context.runtime.routeKey, 'achilles-cli');
    assert.equal(context.router.physicalOrigin, 'http://host.containers.internal:8080');
    assert.equal(context.router.requestAuthority, '127.0.0.1:18080');
    assert.equal(context.getAgentSecret(), secret);
    assert.equal(context.getPrivateAgentSecret(), privateSecret);
    assert.equal(context.getAgentApiKey(), env.PLOINKY_AGENT_API_KEY);

    assert.throws(
        () => createContainerAgentCredentialContext({
            ...env,
            PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY: 'manifest',
        }),
        /generated provenance/,
    );
    assert.throws(
        () => createContainerAgentCredentialContext({
            ...env,
            PLOINKY_AGENT_PRIVATE_SECRET: undefined,
        }),
        /PLOINKY_AGENT_PRIVATE_SECRET is invalid/,
    );
});
