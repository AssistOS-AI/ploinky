/**
 * Unit tests for the default OpenAI Chat Completions capability responder.
 *
 * The default responder is an inert capability/listability adapter: it produces
 * an OpenAI-compatible chat.completion object describing the agent and its
 * exposed MCP tools, without invoking any tool or performing any I/O. Real
 * conversational behavior is handled by a manifest-specific
 * `endpoints.chatCompletions` command, which lives in AgentServer and is not
 * exercised here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildDefaultOpenAiChatResponse,
    buildDefaultStreamRejection,
    STREAM_NOT_SUPPORTED_MESSAGE
} from '../../Agent/server/openAiDefaultResponder.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RESPONDER_SOURCE_PATH = path.resolve(__dirname, '../../Agent/server/openAiDefaultResponder.mjs');

function assertWellFormedCompletion(response) {
    assert.equal(response.object, 'chat.completion');
    assert.ok(typeof response.id === 'string' && response.id.startsWith('chatcmpl-'), 'id starts with chatcmpl-');
    assert.equal(typeof response.created, 'number');
    assert.ok(Array.isArray(response.choices), 'choices is an array');
    assert.equal(response.choices.length, 1);
    const choice = response.choices[0];
    assert.equal(choice.index, 0);
    assert.equal(choice.finish_reason, 'stop');
    assert.equal(choice.message.role, 'assistant');
    assert.equal(typeof choice.message.content, 'string');
    assert.deepEqual(response.usage, {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
    });
}

test('builds a well-formed OpenAI chat.completion with usage zeroed', () => {
    const response = buildDefaultOpenAiChatResponse({
        requestBody: { model: 'agent:AssistOSExplorer/llmAssistant' },
        manifest: { name: 'llmAssistant' },
        toolNames: ['parseFile', 'summarize'],
        agentId: 'agent:AssistOSExplorer/llmAssistant'
    });
    assertWellFormedCompletion(response);
});

test('model uses the request model when provided', () => {
    const response = buildDefaultOpenAiChatResponse({
        requestBody: { model: 'agent:AssistOSExplorer/llmAssistant' },
        toolNames: [],
        agentId: 'fallback-agent-id'
    });
    assert.equal(response.model, 'agent:AssistOSExplorer/llmAssistant');
});

test('model falls back to PLOINKY_AGENT_ID when request omits model', () => {
    const response = buildDefaultOpenAiChatResponse({
        requestBody: {},
        toolNames: [],
        agentId: 'agent:AssistOSExplorer/gitAgent'
    });
    assert.equal(response.model, 'agent:AssistOSExplorer/gitAgent');
});

test('assistant content mentions the agent id and lists provided tool names', () => {
    const agentId = 'agent:AssistOSExplorer/llmAssistant';
    const response = buildDefaultOpenAiChatResponse({
        requestBody: {},
        manifest: { name: 'llmAssistant' },
        toolNames: ['parseFile', 'summarize'],
        agentId
    });
    const content = response.choices[0].message.content;
    assert.ok(content.includes(agentId), 'content mentions the agent id');
    assert.ok(content.includes('parseFile'), 'content lists first tool name');
    assert.ok(content.includes('summarize'), 'content lists second tool name');
    assert.ok(/available/i.test(content), 'content states the agent is available');
});

test('content renders "none" when no tool names are provided', () => {
    const response = buildDefaultOpenAiChatResponse({
        requestBody: {},
        manifest: { name: 'emptyAgent' },
        toolNames: [],
        agentId: 'agent:Workspace/emptyAgent'
    });
    assertWellFormedCompletion(response);
    const content = response.choices[0].message.content;
    assert.ok(/none/i.test(content), 'content says tools are none');
});

test('content includes manifest-declared capabilities when no tools exist', () => {
    const response = buildDefaultOpenAiChatResponse({
        requestBody: {},
        manifest: {
            name: 'cardAgent',
            capabilities: {
                tags: ['research', 'summaries'],
                summary: 'Finds and summarizes sources.'
            }
        },
        toolNames: [],
        agentId: 'agent:Workspace/cardAgent'
    });
    const content = response.choices[0].message.content;
    assert.ok(content.includes('research'), 'content includes declared tag');
    assert.ok(content.includes('Finds and summarizes sources.'), 'content includes declared summary');
});

test('deduplicates and trims tool names, ignoring non-strings', () => {
    const response = buildDefaultOpenAiChatResponse({
        requestBody: {},
        toolNames: ['  parseFile  ', 'parseFile', '', 42, 'summarize'],
        agentId: 'agent:Workspace/dedupAgent'
    });
    const content = response.choices[0].message.content;
    // "parseFile" should appear exactly once in the comma-separated tool list.
    const occurrences = content.split('parseFile').length - 1;
    assert.equal(occurrences, 1, 'tool name appears once after dedupe');
    assert.ok(content.includes('summarize'));
});

test('falls back to a generic model name when neither request nor agentId provide one', () => {
    const response = buildDefaultOpenAiChatResponse({
        requestBody: {},
        toolNames: [],
        agentId: undefined
    });
    assert.equal(typeof response.model, 'string');
    assert.ok(response.model.length > 0, 'model name is non-empty');
});

test('is callable with no arguments and still returns a valid object', () => {
    const response = buildDefaultOpenAiChatResponse();
    assertWellFormedCompletion(response);
});

test('stream rejection helper returns an OpenAI-compatible error shape', () => {
    const rejection = buildDefaultStreamRejection();
    assert.equal(rejection.statusCode, 400);
    assert.equal(rejection.type, 'invalid_request_error');
    assert.equal(rejection.message, STREAM_NOT_SUPPORTED_MESSAGE);
    assert.ok(/stream/i.test(rejection.message), 'message references streaming');
});

test('builder is synchronous and pure (returns an object, not a Promise)', () => {
    const response = buildDefaultOpenAiChatResponse({ requestBody: {}, toolNames: [] });
    assert.equal(typeof response, 'object');
    assert.ok(!(response instanceof Promise), 'builder does not return a Promise');
});

test('responder source is inert: imports no child_process / spawn / exec', () => {
    const source = fs.readFileSync(RESPONDER_SOURCE_PATH, 'utf8');
    assert.ok(!/child_process/.test(source), 'no child_process import');
    assert.ok(!/\bspawn\b/.test(source), 'no spawn usage');
    assert.ok(!/\bexec(Sync|File)?\s*\(/.test(source), 'no exec call');
    assert.ok(!/executeShell/.test(source), 'does not call executeShell');
});
