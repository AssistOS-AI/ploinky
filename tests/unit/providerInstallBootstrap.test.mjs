import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    createContainerAgentCredentialContext,
    __testables as credentialContextTestables,
} from '../../Agent/lib/agentCredentialContext.mjs';
import {
    resolveAdmittedProviderInstall,
    runProviderInstallBootstrap,
    runProviderServerBootstrap,
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

function containerCredentialContext(t) {
    const fixtureRoot = path.join(repoRoot, 'tests/fixtures/router-descriptor');
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-bootstrap-container-'));
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    const descriptorFile = path.join(temporaryRoot, 'router-descriptor.json');
    fs.copyFileSync(path.join(fixtureRoot, 'public-envelope.json'), descriptorFile);
    fs.chmodSync(descriptorFile, 0o600);
    const env = JSON.parse(fs.readFileSync(
        path.join(fixtureRoot, 'public-environment.json'),
        'utf8',
    ));
    env.PLOINKY_ROUTER_DESCRIPTOR_FILE = descriptorFile;
    env.PLOINKY_AGENT_SECRET = 'a'.repeat(64);
    env.PLOINKY_AGENT_PRIVATE_SECRET = 'b'.repeat(64);
    env.PLOINKY_AGENT_HOME_KEY = 'coding-agent_container';
    env.PLOINKY_ENV_SOURCE_PLOINKY_AGENT_HOME_KEY = 'generated';
    env.PLOINKY_RUNTIME = 'container';
    env.PLOINKY_ENV_SOURCE_PLOINKY_RUNTIME = 'generated';
    return createContainerAgentCredentialContext(env);
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
    const serverSource = fs.readFileSync(path.join(repoRoot, 'Agent/server/AgentServer.mjs'), 'utf8');
    const bootstrapSource = fs.readFileSync(
        path.join(repoRoot, 'Agent/lib/providerInstallBootstrap.mjs'),
        'utf8',
    );
    const install = bootstrapSource.indexOf('await runInstall({');
    const readiness = bootstrapSource.indexOf('await runReadiness({');
    const broker = bootstrapSource.indexOf('await ensureBroker();', readiness);
    const bootstrap = serverSource.indexOf('await runProviderServerBootstrap({');
    const queue = serverSource.indexOf('taskQueue.initialize();', bootstrap);
    const listen = serverSource.indexOf('serverHttp.listen(', queue);

    assert.ok(install >= 0, 'provider server bootstrap must invoke the admitted install bootstrap');
    assert.ok(install < readiness, 'install must complete before readiness');
    assert.ok(readiness < broker, 'readiness must complete before broker creation');
    assert.ok(bootstrap >= 0, 'AgentServer must invoke the provider server bootstrap');
    assert.ok(queue < listen, 'queue initialization must complete before listener creation');
    assert.match(serverSource, /const bootstrapAbort = new AbortController\(\);/);
    assert.match(serverSource, /process\.once\('SIGTERM', abortBootstrap\);/);
    assert.match(serverSource, /process\.once\('SIGINT', abortBootstrap\);/);
    assert.match(serverSource, /process\.removeListener\('SIGTERM', abortBootstrap\);/);
    assert.match(serverSource, /process\.removeListener\('SIGINT', abortBootstrap\);/);
});

test('provider server bootstrap preserves true/false/missing selector install parity', async (t) => {
    for (const testCase of [
        { selector: true, runtimeKind: 'bwrap', expected: ['install', 'readiness', 'broker'] },
        { selector: false, runtimeKind: 'container', expected: ['readiness', 'broker'] },
        { selector: undefined, runtimeKind: 'container', expected: ['readiness', 'broker'] },
    ]) {
        await t.test(`lite-sandbox ${String(testCase.selector)}`, async (subtest) => {
            const events = [];
            const context = testCase.runtimeKind === 'bwrap'
                ? credentialContext(Buffer.from('{}\n'))
                : containerCredentialContext(subtest);
            await runProviderServerBootstrap({
                providerConfig: { provider: 'opencode' },
                credentialContext: context,
                dependencies: {
                    async runProviderInstallBootstrap(input) {
                        assert.equal(input.credentialContext, context);
                        events.push('install');
                    },
                    async runProviderSandboxReadiness(input) {
                        assert.equal(input.credentialContext, context);
                        events.push('readiness');
                    },
                    async ensureScopedSoulBrokerRegistry() {
                        events.push('broker');
                    },
                },
            });
            assert.deepEqual(events, testCase.expected);
        });
    }
});
