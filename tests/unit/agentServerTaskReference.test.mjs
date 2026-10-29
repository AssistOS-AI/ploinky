import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { isJsonSchema } from '../../Agent/server/inputSchema.mjs';
import {
    sanitizeAuthInfoForLog,
    sanitizeContextForLog,
    sanitizePayloadForLog,
} from '../../Agent/server/logRedaction.mjs';
import { readTaskReferenceDeclaration, taskReferenceInputSchema } from '../../Agent/server/taskReferenceTool.mjs';
import { callTool, mcpPost, mcpSession, startAgentServer } from './helpers/agentServerProcess.mjs';
import { taskReferenceTool } from './helpers/taskReferenceToolScript.mjs';

// Fictional agent `agent:fixtures/unrelated` serving a task-reference tool
// whose provider is `explorer`.
const AGENT = 'agent:fixtures/unrelated';
const ORIGIN = 'AAAAAAAAAAAAAAAAAAAAAA';
const plainTool = (dir) => ({ name: 'plain', command: process.execPath, args: ['-e', 'process.stdout.write("plain")'], cwd: dir });

async function server(t, extra = {}) {
    return startAgentServer(t, {
        agentId: AGENT,
        secret: crypto.randomBytes(32),
        tools: (dir) => [taskReferenceTool(dir), plainTool(dir)],
        ...extra,
    });
}

const seen = (srv, label) => JSON.parse(fs.readFileSync(path.join(srv.tmp, `seen-${label}.json`), 'utf8'));

test('the actual listing advertises the provider annotation and a strict schema requiring originRequestId', async (t) => {
    const srv = await server(t);
    const sessionId = await mcpSession(srv.port);
    const listed = await mcpPost(srv.port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { sessionId });
    const tools = listed.json.result.tools;
    const tool = tools.find((entry) => entry.name === 'start_job');
    assert.deepEqual(tool.annotations, { ploinkyTaskReference: { version: 1, provider: 'explorer' } });
    assert.deepEqual(tool.inputSchema.required, ['originRequestId']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.properties.originRequestId, {
        type: 'string',
        description: 'Caller-generated identity of this intentional request, persisted before the first transmission.',
        minLength: 22,
        maxLength: 22,
        pattern: '^[A-Za-z0-9_-]{22}$',
    });
    assert.ok(tool.inputSchema.properties.label, 'configured properties are kept');
    assert.equal(tools.find((entry) => entry.name === 'plain').annotations, undefined, 'an ordinary tool is unannotated');
});

test('a valid admission returns reference metadata without a task id and never queues a task', async (t) => {
    const srv = await server(t);
    const sessionId = await mcpSession(srv.port);
    for (const [mode, state] of [['ok', 'accepted'], ['queued', 'queued']]) {
        const call = await callTool(srv, sessionId, 'start_job', { originRequestId: ORIGIN, label: mode, mode });
        const result = call.json.result;
        assert.equal(result.isError, undefined, call.text);
        assert.deepEqual(result.metadata, {
            agent: AGENT,
            taskRef: { version: 1, provider: 'explorer', id: 'T'.repeat(22) },
            originRequestId: ORIGIN,
            state,
        });
        assert.equal(Object.hasOwn(result.metadata, 'taskId'), false);
        assert.deepEqual(JSON.parse(result.content[0].text), {
            taskRef: { version: 1, provider: 'explorer', id: 'T'.repeat(22) }, state, originRequestId: ORIGIN,
        });
    }
    assert.equal(fs.existsSync(path.join(srv.tmp, '.tasksQueue')), false, 'no TaskQueue entry was persisted');
});

test('malformed or mismatched admission results fail the call', async (t) => {
    const srv = await server(t);
    const sessionId = await mcpSession(srv.port);
    for (const mode of ['text', 'extra', 'provider', 'origin', 'state', 'two', 'refkey', 'shortid']) {
        const call = await callTool(srv, sessionId, 'start_job', { originRequestId: ORIGIN, label: mode, mode }, { id: mode });
        const failed = call.json.error || call.json.result?.isError;
        assert.ok(failed, `${mode}: ${call.text}`);
        assert.match(call.text, /task-reference admission result rejected/, mode);
        assert.equal(call.json.result?.metadata?.taskRef, undefined, mode);
        assert.ok(fs.existsSync(path.join(srv.tmp, `seen-${mode}.json`)), `${mode}: the tool ran and its result was refused`);
    }
});

test('the strict schema refuses a missing, malformed or extra argument before the tool runs', async (t) => {
    const srv = await server(t);
    const sessionId = await mcpSession(srv.port);
    for (const [label, args] of [
        ['missing', { label: 'missing' }],
        ['short', { originRequestId: 'short', label: 'short' }],
        ['bad-char', { originRequestId: `${'A'.repeat(21)}=`, label: 'bad-char' }],
        ['extra', { originRequestId: ORIGIN, label: 'extra', unknown: 1 }],
    ]) {
        const call = await callTool(srv, sessionId, 'start_job', args, { id: label });
        assert.ok(call.json.error || call.json.result?.isError, `${label}: ${call.text}`);
        assert.equal(fs.existsSync(path.join(srv.tmp, `seen-${label}.json`)), false, `${label}: the tool never ran`);
    }
});

test('conflicting or malformed taskReference declarations are configuration errors', () => {
    const base = { name: 'x', command: 'node', taskReference: { version: 1, provider: 'explorer' } };
    for (const [label, tool, pattern] of [
        ['async', { ...base, async: true }, /cannot be combined with 'async'/],
        ['continuation', { ...base, continuationTool: 'next' }, /continuationTool/],
        ['message', { ...base, taskMessageTool: 'msg' }, /taskMessageTool/],
        ['timeout', { ...base, timeoutMs: 1000 }, /timeoutMs/],
        ['version', { ...base, taskReference: { version: 2, provider: 'explorer' } }, /version/],
        ['keys', { ...base, taskReference: { version: 1, provider: 'explorer', url: 'x' } }, /exactly/],
        ['provider', { ...base, taskReference: { version: 1, provider: '../x' } }, /route key/],
        ['null', { ...base, taskReference: null }, /exactly/],
    ]) {
        assert.throws(() => readTaskReferenceDeclaration(tool), pattern, label);
    }
    assert.equal(readTaskReferenceDeclaration({ name: 'x' }), null);
    assert.throws(() => taskReferenceInputSchema({ ...base, inputSchema: { label: 'string' } }, { isJsonSchema }), /standard JSON/);
    assert.throws(() => taskReferenceInputSchema({ ...base, inputSchema: { type: 'object', properties: { originRequestId: { type: 'string' } } } }, { isJsonSchema }), /injected/);
    assert.throws(() => taskReferenceInputSchema({ ...base, inputSchema: { type: 'object', properties: {}, additionalProperties: true } }, { isJsonSchema }), /additional/);
});

test('an AgentServer configured with a conflicting declaration refuses the tool session instead of serving it', async (t) => {
    const srv = await startAgentServer(t, {
        agentId: AGENT,
        secret: crypto.randomBytes(32),
        tools: (dir) => [taskReferenceTool(dir, { extra: { async: true } })],
    });
    const init = await mcpPost(srv.port, {
        jsonrpc: '2.0', id: 'i', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    const sessionId = init.response.headers.get('mcp-session-id');
    if (sessionId) {
        const listed = await mcpPost(srv.port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { sessionId });
        assert.equal((listed.json?.result?.tools || []).some((tool) => tool.name === 'start_job'), false, listed.text);
    }
    assert.match(srv.output(), /Invalid taskReference for tool 'start_job': it cannot be combined with 'async'/);
});

// Synthetic credential sentinels: none of them may appear in any log line.
const SENTINEL_ORIGIN = 'sentinel-origin-token-7f3a';
const SENTINEL_INVOCATION = 'sentinel-invocation-token-91c2';
const SENTINEL_DELEGATION = 'sentinel-delegation-token-44d0';

test('detailed tool logging never prints the auth-info carrier or the origin token; the tool still receives it', async (t) => {
    const srv = await server(t, { extraEnv: { PLOINKY_AGENT_TOOL_DEBUG_LOGS: '1' } });
    const sessionId = await mcpSession(srv.port);
    const authInfo = JSON.stringify({ taskRefOrigin: SENTINEL_ORIGIN, invocationToken: SENTINEL_INVOCATION });
    const call = await callTool(srv, sessionId, 'start_job', { originRequestId: ORIGIN, label: 'logged' },
        { extraHeaders: { 'x-ploinky-auth-info': authInfo } });
    assert.ok(call.json.result?.metadata?.taskRef, call.text);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const out = srv.output();
    assert.match(out, /Tool 'start_job' context:/, 'positive control: detailed logging is on');
    assert.match(out, /Tool 'start_job' payload:/);
    for (const sentinel of [SENTINEL_ORIGIN, SENTINEL_INVOCATION]) assert.equal(out.includes(sentinel), false, `${sentinel} leaked`);
    const delivered = seen(srv, 'logged');
    assert.equal(delivered.taskRefOrigin, SENTINEL_ORIGIN, 'the tool process receives the origin token');
});

test('the redaction helpers remove credentials from a parsed auth-info object and from the header map', () => {
    const authInfo = {
        user: { id: 'u1' },
        invocationToken: SENTINEL_INVOCATION,
        taskRefOrigin: SENTINEL_ORIGIN,
        delegations: { providerAdmission: { token: SENTINEL_DELEGATION, targetAgentId: 'agent:fixtures/explorer' } },
        github: { provider: 'github', accessToken: 'sentinel-gh' },
    };
    const context = {
        authInfo,
        requestInfo: { headers: { 'x-ploinky-auth-info': JSON.stringify(authInfo), authorization: `Bearer ${SENTINEL_INVOCATION}` } },
        taskRefOrigin: SENTINEL_ORIGIN,
    };
    const rendered = JSON.stringify([sanitizeAuthInfoForLog(authInfo), sanitizeContextForLog(context), sanitizePayloadForLog({ metadata: context, input: {} })]);
    for (const sentinel of [SENTINEL_ORIGIN, SENTINEL_INVOCATION, SENTINEL_DELEGATION, 'sentinel-gh']) {
        assert.equal(rendered.includes(sentinel), false, `${sentinel} leaked`);
    }
    assert.match(rendered, /"id":"u1"/, 'non-credential facts remain visible');
    // R9: a user delegation header or grant is redacted by key as well.
    const delegationRendered = JSON.stringify(sanitizeContextForLog({
        requestInfo: { headers: { 'x-ploinky-user-delegation': SENTINEL_DELEGATION } },
        userDelegation: SENTINEL_DELEGATION,
    }));
    assert.equal(delegationRendered.includes(SENTINEL_DELEGATION), false);
});
