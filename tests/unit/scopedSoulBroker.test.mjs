import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createContainerAgentCredentialContext } from '../../Agent/lib/agentCredentialContext.mjs';
import {
    __testables as brokerTestables,
    assertScopedSoulBrokerRegistry,
    startScopedSoulBrokerRegistry,
} from '../../Agent/lib/scopedSoulBroker.mjs';

function createContainerContext(t) {
    const fixtureRoot = path.resolve('tests/fixtures/router-descriptor');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-scoped-broker-'));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const descriptorFile = path.join(tempDir, 'router-descriptor.json');
    fs.copyFileSync(path.join(fixtureRoot, 'public-envelope.json'), descriptorFile);
    fs.chmodSync(descriptorFile, 0o600);
    const env = JSON.parse(fs.readFileSync(
        path.join(fixtureRoot, 'public-environment.json'),
        'utf8',
    ));
    env.PLOINKY_ROUTER_DESCRIPTOR_FILE = descriptorFile;
    env.PLOINKY_AGENT_HOME_KEY = 'AchillesCLI_achilles-cli';
    env.PLOINKY_ENV_SOURCE_PLOINKY_AGENT_HOME_KEY = 'generated';
    env.PLOINKY_RUNTIME = 'container';
    env.PLOINKY_ENV_SOURCE_PLOINKY_RUNTIME = 'generated';
    env.PLOINKY_AGENT_SECRET = 'a'.repeat(64);
    env.PLOINKY_AGENT_PRIVATE_SECRET = 'b'.repeat(64);
    return createContainerAgentCredentialContext(env);
}

test('scoped broker accepts the exact signed container AgentCredentialContext', async (t) => {
    const context = createContainerContext(t);
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());

    assert.equal(assertScopedSoulBrokerRegistry(registry, context), registry);
    assert.match(registry.url, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/v1$/);

    const capability = registry.prepare({
        taskId: 'container-task',
        provider: 'codex',
        audience: 'agent:AssistOSExplorer/achilles-cli/execute-task',
    });
    assert.match(capability.environment.PLOINKY_TASK_BROKER_URL, /^http:\/\/127\.0\.0\.1:/);
    assert.ok(capability.environment.PLOINKY_TASK_BROKER_KEY);
    assert.doesNotMatch(
        JSON.stringify(capability.environment),
        new RegExp(context.getAgentApiKey().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    capability.close();
});

test('scoped broker routes are provider-specific and Codex uses only Responses with its managed model', () => {
    assert.deepEqual(brokerTestables.normalizeProviderRequest({
        method: 'POST',
        url: '/v1/chat/completions',
        provider: 'opencode',
        payload: { model: 'fast' },
    }), { ok: true, upstreamPath: '/v1/chat/completions' });
    assert.deepEqual(brokerTestables.normalizeProviderRequest({
        method: 'POST',
        url: '/v1/responses',
        provider: 'codex',
        payload: { model: 'gpt-5.6-sol' },
    }), { ok: true, upstreamPath: '/v1/responses' });
    assert.deepEqual(brokerTestables.normalizeProviderRequest({
        method: 'POST',
        url: '/v1/chat/completions',
        provider: 'codex',
        payload: { model: 'gpt-5.6-sol' },
    }), { ok: false, status: 404, message: 'not found' });
    assert.deepEqual(brokerTestables.normalizeProviderRequest({
        method: 'POST',
        url: '/v1/responses',
        provider: 'codex',
        payload: { model: 'fast' },
    }), { ok: false, status: 400, message: 'model is not allowed for this provider' });
    assert.deepEqual(brokerTestables.normalizeProviderRequest({
        method: 'GET',
        url: '/v1/responses',
        provider: 'codex',
        payload: { model: 'gpt-5.6-sol' },
    }), { ok: false, status: 404, message: 'not found' });
});
