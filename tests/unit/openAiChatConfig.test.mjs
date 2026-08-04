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
    resolveOpenAiChatKind,
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
