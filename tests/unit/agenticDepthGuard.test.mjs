import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAgenticDepth, nextAgenticDepthHeaders, MAX_AGENTIC_DEPTH } from '../../cli/server/agentOpenAiDelegation.js';

test('readAgenticDepth defaults to 0 and parses header', () => {
    assert.equal(readAgenticDepth({}), 0);
    assert.equal(readAgenticDepth({ 'x-ploinky-agentic-depth': '2' }), 2);
});

test('MAX_AGENTIC_DEPTH is 3', () => {
    assert.equal(MAX_AGENTIC_DEPTH, 3);
});

test('nextAgenticDepthHeaders increments', () => {
    assert.equal(nextAgenticDepthHeaders({ 'x-ploinky-agentic-depth': '1' })['x-ploinky-agentic-depth'], '2');
    assert.equal(nextAgenticDepthHeaders({})['x-ploinky-agentic-depth'], '1');
});
