import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    buildWebchatQuery,
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

test('resolveWebchatLaunchOptions forwards agent-owned launch flags unchanged', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-webchat-envelope-'));
    try {
        fs.mkdirSync(path.join(workspaceRoot, 'projects', 'demo'), { recursive: true });
        const parsedUrl = new URL(
            '/webchat?agent=achilles-cli&workspace-dir=projects%2Fdemo&feature-tags=1&feature-tags=&workdir=provider-owned&pageInstanceId=p1&tabId=t1&sessionId=s1',
            'http://localhost'
        );
        const options = resolveWebchatLaunchOptions(parsedUrl, { workspaceRoot });
        assert.equal(options.workdir, fs.realpathSync(path.join(workspaceRoot, 'projects', 'demo')));
        assert.equal(options.workdirRelative, 'projects/demo');
        assert.equal(options.runtimeWorkdir, '/workspace/projects/demo');
        assert.deepEqual(options.cliArgs, [
            '--dir=/workspace/projects/demo',
            '--feature-tags=1',
            '--feature-tags',
            '--workdir=provider-owned',
        ]);
        assert.equal(options.cliArgs.some((arg) => arg.startsWith('--workspace-dir=')), false);
        assert.equal(options.cliArgs.some((arg) => arg.startsWith('--pageInstanceId=')), false);
        assert.equal(options.cliArgs.some((arg) => arg.startsWith('--tabId=')), false);
        assert.equal(options.cliArgs.some((arg) => arg.startsWith('--sessionId=')), false);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('WebChat workdir admission rejects ambiguous and unsafe selectors with stable codes', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-webchat-admission-'));
    try {
        fs.mkdirSync(path.join(workspaceRoot, 'valid folder'), { recursive: true });
        fs.mkdirSync(path.join(workspaceRoot, 'real', 'child'), { recursive: true });
        fs.mkdirSync(path.join(workspaceRoot, '.ploinky', 'repos', 'managed'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, 'file.txt'), 'not a directory');
        fs.symlinkSync(path.join(workspaceRoot, 'real'), path.join(workspaceRoot, 'linked'));

        const expectCode = (url, code) => {
            assert.throws(
                () => resolveWebchatLaunchOptions(new URL(url, 'http://localhost'), { workspaceRoot }),
                (error) => error?.code === code && error?.status === 400,
            );
        };
        expectCode('/webchat', 'PLOINKY_WORKDIR_REQUIRED');
        expectCode('/webchat?workspace-dir=valid%20folder&workspaceDir=real%2Fchild', 'PLOINKY_WORKDIR_INVALID');
        expectCode('/webchat?workspace-dir=.', 'PLOINKY_WORKDIR_ROOT_FORBIDDEN');
        expectCode('/webchat?workspace-dir=%2Fworkspace', 'PLOINKY_WORKDIR_ROOT_FORBIDDEN');
        expectCode('/webchat?workspace-dir=real%2F..%2Fvalid%20folder', 'PLOINKY_WORKDIR_INVALID');
        expectCode('/webchat?workspace-dir=%2Ftmp', 'PLOINKY_WORKDIR_INVALID');
        expectCode('/webchat?workspace-dir=missing', 'PLOINKY_WORKDIR_INVALID');
        expectCode('/webchat?workspace-dir=file.txt', 'PLOINKY_WORKDIR_INVALID');
        expectCode('/webchat?workspace-dir=linked%2Fchild', 'PLOINKY_WORKDIR_INVALID');
        const nulUrl = new URL('/webchat', 'http://localhost');
        nulUrl.searchParams.set('workspace-dir', 'real\0child');
        assert.throws(
            () => resolveWebchatLaunchOptions(nulUrl, { workspaceRoot }),
            (error) => error?.code === 'PLOINKY_WORKDIR_INVALID',
        );

        assert.equal(
            resolveWebchatLaunchOptions(
                new URL('/webchat?workspace-dir=valid%20folder', 'http://localhost'),
                { workspaceRoot },
            ).workdirRelative,
            'valid folder',
        );
        assert.equal(
            resolveWebchatLaunchOptions(
                new URL('/webchat?workspace-dir=.ploinky%2Frepos%2Fmanaged', 'http://localhost'),
                { workspaceRoot },
            ).workdirRelative,
            '.ploinky/repos/managed',
        );
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('page and connection identifiers do not affect the WebChat runtime query', () => {
    const parsedUrl = new URL(
        '/webchat?workspace-dir=projects%2Fdemo&agent=codex&tabId=t1&sessionId=s1&pageInstanceId=p1&model=o3',
        'http://localhost',
    );
    const query = new URLSearchParams(buildWebchatQuery(parsedUrl, 'codex'));
    assert.equal(query.get('workspace-dir'), 'projects/demo');
    assert.equal(query.get('agent'), 'codex');
    assert.equal(query.get('model'), 'o3');
    assert.equal(query.has('tabId'), false);
    assert.equal(query.has('sessionId'), false);
    assert.equal(query.has('pageInstanceId'), false);
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

test('serializeWebchatEnvelopeForAgent binds task interactions to the current page instance', () => {
    const payload = JSON.parse(serializeWebchatEnvelopeForAgent({
        req: { headers: { host: 'localhost' }, socket: {} },
        effectiveConfig: { agentName: 'achilles-cli' },
        tabId: 'tab_origin',
        pageInstanceId: 'page_origin',
        envelope: { text: '/task login task_111111111111111111111111' },
    }));
    assert.equal(payload.sourceTabId, 'tab_origin');
    assert.equal(payload.sourcePageInstanceId, 'page_origin');
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
