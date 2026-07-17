import test from 'node:test';
import assert from 'node:assert/strict';

import {
    sanitizeWebchatReferencesForEnvelope,
    parseInputEnvelope,
    serializeWebchatEnvelopeForAgent
} from '../../cli/server/handlers/webchat/messageEnvelope.js';
import {
    serializeEnvelope,
    normalizeClientReference
} from '../../cli/server/webchat/network.js';

test('sanitizeWebchatReferencesForEnvelope drops absolute, traversal, NUL, and secret paths', () => {
    const result = sanitizeWebchatReferencesForEnvelope([
        { kind: 'workspace-path', path: '/etc/passwd' },
        { kind: 'workspace-path', path: '../outside' },
        { kind: 'workspace-path', path: 'docs/inner/../escape' },
        { kind: 'workspace-path', path: 'inside\0nul' },
        { kind: 'workspace-path', path: '.secrets' },
        { kind: 'workspace-path', path: 'sub/.secrets' },
        { kind: 'workspace-path', path: 'config.secrets' },
        { kind: 'workspace-path', path: 'notes.md', type: 'file', label: 'Notes' },
        { kind: 'unknown-kind', path: 'notes.md' },
        { kind: 'workspace-path' },
        { kind: 'workspace-path', path: '' }
    ]);
    assert.deepEqual(result, [{
        kind: 'workspace-path',
        path: 'notes.md',
        type: 'file',
        label: 'Notes'
    }]);
});

test('parseInputEnvelope keeps sanitized references and falls back when envelope is missing', () => {
    const envelope = parseInputEnvelope(JSON.stringify({
        __webchatMessage: 1,
        version: 1,
        text: 'inspect @notes.md',
        attachments: [],
        references: [
            { kind: 'workspace-path', path: '/etc/passwd' },
            { kind: 'workspace-path', path: 'notes.md', type: 'file' }
        ]
    }));
    assert.equal(envelope.text, 'inspect @notes.md');
    assert.deepEqual(envelope.references, [{ kind: 'workspace-path', path: 'notes.md', type: 'file', label: null }]);

    const fallback = parseInputEnvelope('hello there');
    assert.equal(fallback.text, 'hello there');
    assert.deepEqual(fallback.references, []);
});

test('serializeWebchatEnvelopeForAgent omits references when none survive sanitation', () => {
    const text = serializeWebchatEnvelopeForAgent({
        req: {},
        effectiveConfig: { agentName: '' },
        tabId: 'tab-1',
        envelope: {
            text: '@open-interpreter hello',
            references: [{ kind: 'workspace-path', path: '/etc/passwd' }]
        }
    });
    const payload = JSON.parse(text);
    assert.equal(payload.references, undefined);
});

test('serializeWebchatEnvelopeForAgent forwards sanitized references when present', () => {
    const text = serializeWebchatEnvelopeForAgent({
        req: {},
        effectiveConfig: { agentName: '' },
        tabId: 'tab-1',
        envelope: {
            text: 'context @notes.md',
            references: [
                { kind: 'workspace-path', path: 'notes.md', type: 'file', label: 'Notes' },
                { kind: 'workspace-path', path: '../escape' }
            ]
        }
    });
    const payload = JSON.parse(text);
    assert.deepEqual(payload.references, [
        { kind: 'workspace-path', path: 'notes.md', type: 'file', label: 'Notes' }
    ]);
});

test('client serializeEnvelope normalizes and emits references only when valid', () => {
    const text = serializeEnvelope({
        text: 'check @notes.md',
        attachments: [],
        references: [
            { kind: 'workspace-path', path: 'notes.md', type: 'file', label: 'Notes' },
            { kind: 'workspace-path', path: 'with\0nul' },
            null
        ]
    });
    const payload = JSON.parse(text);
    assert.deepEqual(payload.references, [
        { kind: 'workspace-path', path: 'notes.md', type: 'file', label: 'Notes' }
    ]);

    const emptyText = serializeEnvelope({ text: 'plain', attachments: [], references: [] });
    const emptyPayload = JSON.parse(emptyText);
    assert.equal(emptyPayload.references, undefined);
});

test('normalizeClientReference rejects malformed entries', () => {
    assert.equal(normalizeClientReference(null), null);
    assert.equal(normalizeClientReference({}), null);
    assert.equal(normalizeClientReference({ kind: 'workspace-path' }), null);
    assert.equal(normalizeClientReference({ kind: 'workspace-path', path: 'has\0nul' }), null);
    assert.deepEqual(normalizeClientReference({ kind: 'workspace-path', path: 'notes.md' }), {
        kind: 'workspace-path',
        path: 'notes.md',
        type: null,
        label: null
    });
});
