import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
    resolveWebchatLaunchOptions,
    resolveWorkspaceScopedQueryPath,
} from '../../cli/server/handlers/webchat/launchOptions.js';
import {
    resolveRequestPublicOrigin,
    serializeWebchatEnvelopeForAgent,
    shouldForwardWebchatEnvelope
} from '../../cli/server/handlers/webchat/messageEnvelope.js';
import {
    flushPendingSseEvents,
    writeOrBufferSseEvent
} from '../../cli/server/handlers/webchat/runtimeState.js';
import {
    extractManifestWebchatOptions
} from '../../cli/server/webchat/commandResolver.js';
import { PLOINKY_WORKSPACE_ROOT } from '../../cli/utils/config.js';

test('resolveWebchatLaunchOptions forwards agent-owned launch flags unchanged', () => {
    const parsedUrl = new URL(
        '/webchat?agent=achilles-cli&workspace-dir=projects/demo&feature-tags=1&forward-envelope=1&tabId=t1&sessionId=s1',
        'http://localhost'
    );
    const { cliArgs } = resolveWebchatLaunchOptions(parsedUrl);
    assert.ok(cliArgs.includes(`--dir=${path.resolve(PLOINKY_WORKSPACE_ROOT, 'projects/demo')}`));
    assert.ok(cliArgs.includes('--feature-tags=1'));
    assert.ok(cliArgs.includes('--forward-envelope=1'));
    assert.equal(cliArgs.some((arg) => arg.startsWith('--workspace-dir=')), false);
    assert.equal(cliArgs.some((arg) => arg.startsWith('--tabId=')), false);
    assert.equal(cliArgs.some((arg) => arg.startsWith('--sessionId=')), false);
});

test('manifest webchat forwardEnvelope opts an agent into WebChat envelopes', () => {
    assert.deepEqual(extractManifestWebchatOptions({ webchat: { forwardEnvelope: true } }), {
        forwardEnvelope: true
    });
    assert.equal(
        shouldForwardWebchatEnvelope(new URL('/webchat?agent=achilles-cli', 'http://localhost'), { forwardEnvelope: true }),
        true
    );
    assert.equal(
        shouldForwardWebchatEnvelope(new URL('/webchat?agent=basic', 'http://localhost'), { forwardEnvelope: false }),
        false
    );
});

test('resolveWorkspaceScopedQueryPath rejects absolute and escaping launch paths', () => {
    assert.equal(resolveWorkspaceScopedQueryPath('/tmp/outside'), '');
    assert.equal(resolveWorkspaceScopedQueryPath('../outside'), '');
});

test('serializeWebchatEnvelopeForAgent does not name a concrete downstream agent', () => {
    const text = serializeWebchatEnvelopeForAgent({
        req: { headers: { host: '127.0.0.1:8080' } },
        effectiveConfig: { agentName: '' },
        tabId: 'tab-1',
        envelope: {
            text: '@example-task hello',
            attachments: [{ filename: 'note.md', localPath: 'shared/blob-1', ignored: 'drop' }]
        }
    });
    const payload = JSON.parse(text);
    assert.equal(payload.__webchatMessage, 1);
    assert.equal(payload.text, '@example-task hello');
    assert.equal(payload.sourceTabId, 'tab-1');
    assert.deepEqual(payload.attachments, [{
        id: null,
        filename: 'note.md',
        mime: null,
        size: null,
        downloadUrl: null,
        localPath: 'shared/blob-1'
    }]);
    assert.deepEqual(payload.origin, { publicBaseUrl: 'http://127.0.0.1:8080' });
    assert.equal(payload.invocation, undefined);
    assert.doesNotMatch(text, /concreteDownstreamAgent|concrete_downstream_tool/);
});

test('serializeWebchatEnvelopeForAgent leaves history ownership to AchillesCLI', () => {
    const payload = JSON.parse(serializeWebchatEnvelopeForAgent({
        req: { headers: { host: '127.0.0.1:8080' } },
        effectiveConfig: { agentName: '' },
        tabId: 'tab-1',
        envelope: {
            text: 'Current question',
            history: [
                { role: 'user', message: 'Earlier question' },
                { role: 'assistant', message: 'Earlier answer' },
            ],
        },
    }));

    assert.equal(payload.text, 'Current question');
    assert.equal(payload.history, undefined);
    assert.doesNotMatch(JSON.stringify(payload), /Ploinky conversation context|New user message/);
});

test('serializeWebchatEnvelopeForAgent prefers forwarded public origin headers', () => {
    const text = serializeWebchatEnvelopeForAgent({
        req: {
            headers: {
                host: 'host.containers.internal:8080',
                'x-forwarded-host': 'workspace.example.test',
                'x-forwarded-proto': 'https',
            }
        },
        effectiveConfig: { agentName: '' },
        tabId: 'tab-1',
        envelope: { text: 'hello', attachments: [] }
    });
    const payload = JSON.parse(text);
    assert.deepEqual(payload.origin, { publicBaseUrl: 'https://workspace.example.test' });
});

test('resolveRequestPublicOrigin rejects malformed public origin input', () => {
    assert.equal(resolveRequestPublicOrigin({
        headers: {
            host: '127.0.0.1:8080/path',
            'x-forwarded-proto': 'javascript',
        }
    }), '');
});

test('writeOrBufferSseEvent buffers disconnected WebChat output and flushes on reconnect', () => {
    const written = [];
    const tab = { sseRes: null, pendingSseEvents: [] };
    writeOrBufferSseEvent(tab, 'data: "first"\n\n');
    writeOrBufferSseEvent(tab, 'event: close\n');
    assert.deepEqual(tab.pendingSseEvents, ['data: "first"\n\n', 'event: close\n']);

    tab.sseRes = {
        write(payload) {
            written.push(payload);
        }
    };
    flushPendingSseEvents(tab);
    assert.deepEqual(written, ['data: "first"\n\n', 'event: close\n']);
    assert.deepEqual(tab.pendingSseEvents, []);
});

test('writeOrBufferSseEvent broadcasts folder-session output to all subscribers', () => {
    const first = [];
    const second = [];
    const runtime = {
        subscribers: new Map([
            ['first', { res: { write: (payload) => first.push(payload) } }],
            ['second', { res: { write: (payload) => second.push(payload) } }]
        ])
    };
    writeOrBufferSseEvent(runtime, 'data: "shared"\n\n');
    assert.deepEqual(first, ['data: "shared"\n\n']);
    assert.deepEqual(second, ['data: "shared"\n\n']);
});
