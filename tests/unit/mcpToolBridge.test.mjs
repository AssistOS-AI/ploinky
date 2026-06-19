// tests/unit/mcpToolBridge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLoopToolsFromMcp } from '../../Agent/server/mcpToolBridge.mjs';

const fakeBuildCommandSpec = (entry) => entry.command ? { command: entry.command, args: [] } : null;

test('builds one loop tool per MCP tool with a command', () => {
    const tools = buildLoopToolsFromMcp({
        tools: [
            { name: 'echo', description: 'echoes', command: '/bin/echo' },
            { name: 'broken' }, // no command → skipped
        ],
        defaultCwd: '/code',
        buildCommandSpec: fakeBuildCommandSpec,
        runTool: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
    });
    assert.deepEqual(Object.keys(tools), ['echo']);
    assert.equal(tools.echo.description, 'echoes');
});

test('handler runs the tool via runTool and returns stdout', async () => {
    let seenPayload = null;
    const tools = buildLoopToolsFromMcp({
        tools: [{ name: 'echo', description: 'd', command: '/bin/echo' }],
        defaultCwd: '/code',
        buildCommandSpec: fakeBuildCommandSpec,
        runTool: async (spec, payload) => { seenPayload = payload; return { code: 0, stdout: 'hi', stderr: '' }; },
    });
    const out = await tools.echo.handler({}, '{"text":"hi"}', {});
    assert.equal(out, 'hi');
    assert.equal(seenPayload.tool, 'echo');
    assert.deepEqual(seenPayload.input, { text: 'hi' });
});

test('handler wraps non-JSON prompt as { prompt } and surfaces tool failure text', async () => {
    const tools = buildLoopToolsFromMcp({
        tools: [{ name: 't', description: 'd', command: '/x' }],
        defaultCwd: '/code',
        buildCommandSpec: fakeBuildCommandSpec,
        runTool: async (spec, payload) => {
            assert.deepEqual(payload.input, { prompt: 'plain words' });
            return { code: 1, stdout: '', stderr: 'boom' };
        },
    });
    const out = await tools.t.handler({}, 'plain words', {});
    assert.match(out, /boom/);
});
