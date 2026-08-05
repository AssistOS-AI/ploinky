import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    __testables as credentialContextTestables,
} from '../../Agent/lib/agentCredentialContext.mjs';
import {
    resolveAdmittedProviderInstall,
    runProviderInstallBootstrap,
} from '../../Agent/lib/providerInstallBootstrap.mjs';
import { buildBwrapAgentCredential } from '../../cli/sandbox/bwrap/bwrapAgentCredential.js';

function digest(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function credentialContext(manifestBytes) {
    const generated = buildBwrapAgentCredential({
        principalId: 'agent:AchillesCLI/opencodeAgent',
        instanceId: 'opencodeAgent_phase10b',
        enableGeneration: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
        runtimeKey: 'opencodeAgent_phase10b',
        routeKey: 'opencodeAgent',
        router: {
            physicalOrigin: 'http://127.0.0.1:8080',
            requestAuthority: '127.0.0.1:18080',
            host: '127.0.0.1',
            port: 8080,
        },
        admission: {
            runtimeKind: 'bwrap',
            manifestDigest: digest(manifestBytes),
            capabilityDigest: `sha256:${'2'.repeat(64)}`,
            networkHash: `sha256:${'3'.repeat(64)}`,
        },
    }, {
        now: Math.floor(Date.now() / 1000) - 10,
        randomBytes: () => Buffer.alloc(32, 7),
        buildCredentialEnv: () => ({
            PLOINKY_AGENT_SECRET: 'a'.repeat(64),
            PLOINKY_AGENT_PRIVATE_SECRET: 'b'.repeat(64),
            PLOINKY_AGENT_API_KEY: 'agent:AchillesCLI/opencodeAgent|fixture-signature',
            PLOINKY_AGENT_API_PUBLIC_KEY: Buffer.alloc(32, 8).toString('base64url'),
        }),
    });
    return credentialContextTestables.createBwrapContextFromRead({
        descriptor: generated.descriptor,
        publicAttestation: generated.publicAttestation,
    });
}

test('profile install overrides the root hook without rewriting exact hook bytes', () => {
    const hook = '  sh /code/scripts/install-opencode.sh  ';
    assert.deepEqual(resolveAdmittedProviderInstall({
        install: 'root-install',
        profiles: { default: { install: hook } },
    }), { profileName: 'default', hook });
    assert.deepEqual(resolveAdmittedProviderInstall({ install: 'root-install' }), {
        profileName: 'default',
        hook: 'root-install',
    });
    assert.deepEqual(resolveAdmittedProviderInstall({}), {
        profileName: 'default',
        hook: null,
    });
});

test('install bootstrap holds the admitted hook across HOME acquisition', async () => {
    const hook = 'sh /code/scripts/install-opencode.sh';
    const manifestBytes = Buffer.from(`${JSON.stringify({
        profiles: { default: { install: hook } },
    })}\n`);
    const context = credentialContext(manifestBytes);
    let runInput;
    const result = await runProviderInstallBootstrap({
        provider: 'opencode',
        credentialContext: context,
        manifestPath: '/fixture/manifest.json',
        timeoutMs: 1234,
        dependencyOverrides: {
            readFileSync: () => manifestBytes,
            async runProviderSandboxInstall(input) {
                runInput = input;
                assert.equal(input.installHook, hook);
                assert.equal(input.timeoutMs, 1234);
                await input.validateAfterLease();
            },
        },
    });
    assert.equal(runInput.credentialContext, context);
    assert.deepEqual(result, {
        provider: 'opencode',
        profileName: 'default',
        installed: true,
    });
});

test('install bootstrap rejects manifest or hook drift before barrier release', async () => {
    const initialHook = 'sh /code/scripts/install-opencode.sh';
    const changedHook = 'sh /code/scripts/install-attacker.sh';
    const initial = Buffer.from(`${JSON.stringify({ profiles: { default: { install: initialHook } } })}\n`);
    const changed = Buffer.from(`${JSON.stringify({ profiles: { default: { install: changedHook } } })}\n`);
    const context = credentialContext(initial);
    let reads = 0;
    await assert.rejects(
        runProviderInstallBootstrap({
            provider: 'opencode',
            credentialContext: context,
            manifestPath: '/fixture/manifest.json',
            dependencyOverrides: {
                readFileSync: () => (++reads === 1 ? initial : changed),
                async runProviderSandboxInstall(input) {
                    await input.validateAfterLease();
                },
            },
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_INSTALL_MANIFEST_MISMATCH'
            && !error.message.includes(initialHook)
            && !error.message.includes(changedHook),
    );
});

test('absent hook is an explicit no-op and malformed profiles fail closed', async () => {
    const manifestBytes = Buffer.from('{}\n');
    let calls = 0;
    const result = await runProviderInstallBootstrap({
        provider: 'opencode',
        credentialContext: credentialContext(manifestBytes),
        manifestPath: '/fixture/manifest.json',
        dependencyOverrides: {
            readFileSync: () => manifestBytes,
            runProviderSandboxInstall() { calls += 1; },
        },
    });
    assert.equal(result.installed, false);
    assert.equal(calls, 0);

    for (const manifest of [
        { profiles: {} },
        { profiles: { default: null } },
        { profiles: { default: { install: ['sh', 'install.sh'] } } },
    ]) {
        assert.throws(
            () => resolveAdmittedProviderInstall(manifest),
            (error) => error?.code === 'PLOINKY_PROVIDER_INSTALL_PROFILE_INVALID'
                || error?.code === 'PLOINKY_PROVIDER_INSTALL_HOOK_INVALID',
        );
    }
});

test('AgentServer installs inside the selected sandbox before readiness, broker, queue, and listener', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'Agent/server/AgentServer.mjs'), 'utf8');
    const install = source.indexOf('await runProviderInstallBootstrap({');
    const readiness = source.indexOf('await runProviderSandboxReadiness({');
    const broker = source.indexOf('await ensureScopedSoulBrokerRegistry();', readiness);
    const queue = source.indexOf('taskQueue.initialize();', broker);
    const listen = source.indexOf('serverHttp.listen(', queue);

    assert.ok(install >= 0, 'AgentServer must invoke the admitted install bootstrap');
    assert.ok(install < readiness, 'install must complete before readiness');
    assert.ok(readiness < broker, 'readiness must complete before broker creation');
    assert.ok(broker < queue, 'broker admission must complete before queue initialization');
    assert.ok(queue < listen, 'queue initialization must complete before listener creation');
    assert.match(source, /const bootstrapAbort = new AbortController\(\);/);
    assert.match(source, /process\.once\('SIGTERM', abortBootstrap\);/);
    assert.match(source, /process\.once\('SIGINT', abortBootstrap\);/);
    assert.match(source, /process\.removeListener\('SIGTERM', abortBootstrap\);/);
    assert.match(source, /process\.removeListener\('SIGINT', abortBootstrap\);/);
});
