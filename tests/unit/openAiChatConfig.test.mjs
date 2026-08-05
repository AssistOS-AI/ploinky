import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAgentServerContainerEnvironment } from '../helpers/agentServerCredentialRuntime.mjs';

const credentialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-server-config-'));
Object.assign(process.env, await createAgentServerContainerEnvironment({
    tempDir: credentialDir,
    agentPrincipal: 'agent:test/openai-config',
}));
const {
    __buildAgenticCompletion,
    __parseProviderEndpointResponse,
    __resolveProviderInvocationIdentity,
    resolveOpenAiChatKind,
    resolveOpenAiModelsKind,
    validateAgentServerManifestExecution,
} = await import(`../../Agent/server/AgentServer.mjs?credential=${Date.now()}`);

test.after(() => fs.rmSync(credentialDir, { recursive: true, force: true }));
test('absent chatCompletions → llm with null model (default)', () => {
    assert.deepEqual(resolveOpenAiChatKind({}), { kind: 'llm', model: null });
});

test('model "none" → inert', () => {
    assert.equal(resolveOpenAiChatKind({ endpoints: { chatCompletions: { model: 'none' } } }).kind, 'inert');
});

test('explicit model → llm with that model', () => {
    const r = resolveOpenAiChatKind({ endpoints: { chatCompletions: { model: 'fast' } } });
    assert.deepEqual(r, { kind: 'llm', model: 'fast' });
});

test('command spec → command kind', () => {
    const r = resolveOpenAiChatKind({ endpoints: { chatCompletions: { command: '/bin/handler', stream: true } } });
    assert.equal(r.kind, 'command');
    assert.equal(r.supportsStream, true);
    assert.ok(r.commandSpec);
});

test('provider endpoint specs admit exact modules without a shell fallback', () => {
    const providerExecution = {
        provider: 'opencode',
        mode: 'operation',
        module: '/code/openai-api/provider-endpoint.mjs',
        export: 'executeProviderEndpoint',
    };
    const providerConfig = { providerSandbox: { provider: 'opencode', readiness: true } };
    const chat = resolveOpenAiChatKind({
        endpoints: { chatCompletions: { providerExecution, supportsStream: false } },
    }, providerConfig);
    const models = resolveOpenAiModelsKind({
        endpoints: { models: { providerExecution } },
    }, providerConfig);

    assert.equal(chat.kind, 'command');
    assert.equal(chat.commandSpec.kind, 'provider-module');
    assert.deepEqual(chat.commandSpec, {
        kind: 'provider-module',
        provider: 'opencode',
        sandboxMode: 'operation',
        module: '/code/openai-api/provider-endpoint.mjs',
        exportName: 'executeProviderEndpoint',
        timeoutMs: undefined,
    });
    assert.equal(models.kind, 'command');
    assert.equal(models.commandSpec.kind, 'provider-module');
    assert.throws(
        () => resolveOpenAiModelsKind({
            endpoints: { models: { providerExecution: { ...providerExecution, mode: undefined } } },
        }, providerConfig),
        /providerExecution must be an exact/,
    );
    assert.throws(
        () => resolveOpenAiChatKind({
            endpoints: { chatCompletions: { providerExecution, supportsStream: true } },
        }, providerConfig),
        /provider chat execution does not support direct stream passthrough/,
    );
});

test('provider capability rejects manifest endpoint shell drift and marker erasure', () => {
    const providerConfig = { providerSandbox: { provider: 'codex', readiness: true } };
    for (const resolve of [resolveOpenAiChatKind, resolveOpenAiModelsKind]) {
        const endpoint = resolve === resolveOpenAiChatKind ? 'chatCompletions' : 'models';
        assert.throws(
            () => resolve({
                endpoints: { [endpoint]: { command: '/bin/sh', args: ['-lc', 'id'] } },
            }, providerConfig),
            { code: 'PLOINKY_PROVIDER_EXECUTION_INVALID' },
        );
        for (const drift of [{ args: ['id'] }, { cwd: '/tmp' }, { env: { X: '1' } }]) {
            assert.throws(
                () => resolve({ endpoints: { [endpoint]: drift } }, providerConfig),
                { code: 'PLOINKY_PROVIDER_EXECUTION_INVALID' },
            );
        }
        assert.throws(
            () => resolve({
                endpoints: {
                    [endpoint]: {
                        providerExecution: {
                            provider: 'codex', mode: 'operation', module: '/code/x.mjs', export: 'run',
                        },
                    },
                },
            }, {}),
            { code: 'PLOINKY_PROVIDER_EXECUTION_INVALID' },
        );
    }
    assert.throws(
        () => validateAgentServerManifestExecution({
            endpoints: { chatCompletions: { command: '/bin/sh', args: ['-lc', 'id'] } },
        }, providerConfig),
        { code: 'PLOINKY_PROVIDER_EXECUTION_INVALID' },
    );
});

test('provider endpoint execution gets a bounded named operation identity and exact response envelope', () => {
    assert.deepEqual(
        __resolveProviderInvocationIdentity({ taskId: 'task-1', tool: 'continue-task' }),
        { taskId: 'task-1', operation: 'continue-task' },
    );
    assert.deepEqual(
        __resolveProviderInvocationIdentity(
            { endpoint: 'openai.models' },
            () => '11111111-2222-4333-8444-555555555555',
        ),
        {
            taskId: 'operation:11111111-2222-4333-8444-555555555555',
            operation: 'openai.models',
        },
    );
    assert.throws(
        () => __resolveProviderInvocationIdentity({}, () => 'unused'),
        /named tool or endpoint/,
    );

    const response = { object: 'list', data: [{ id: 'fast' }] };
    assert.deepEqual(__parseProviderEndpointResponse({
        code: 0,
        stdout: JSON.stringify({ ok: true, response }),
    }, { kind: 'provider-module' }), response);
    assert.throws(
        () => __parseProviderEndpointResponse({
            code: 0,
            stdout: JSON.stringify({ ok: true }),
        }, { kind: 'provider-module' }),
        /exact response envelope/,
    );
});

test('__buildAgenticCompletion returns a chat.completion using injected responder', async () => {
    const completion = await __buildAgenticCompletion({
        body: { model: 'plan', messages: [{ role: 'user', content: 'hi' }] },
        manifest: { name: 'demo' },
        config: { tools: [] },
        agentId: 'agent:r/demo',
        runResponder: async ({ model }) => ({ object: 'chat.completion', model, choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
    });
    assert.equal(completion.object, 'chat.completion');
    assert.equal(completion.choices[0].message.content, 'ok');
});
