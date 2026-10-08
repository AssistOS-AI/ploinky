import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WEBCHAT_MODULE_PRELOADS, renderModulePreloadLinks } from '../../cli/server/handlers/webchat/modulePreload.js';

const webchatDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../cli/server/webchat');

function staticImportGraph(entry) {
    const seen = new Set();
    const pattern = /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)|import\s*['"](\.[^'"]+)['"]/g;
    const visit = (file) => {
        if (seen.has(file)) return;
        seen.add(file);
        const source = fs.readFileSync(path.join(webchatDir, file), 'utf8');
        for (const match of source.matchAll(pattern)) {
            visit(path.normalize(path.join(path.dirname(file), match[1] || match[2] || match[3])));
        }
    };
    visit(entry);
    return [...seen].sort();
}

test('the preload list is exactly the module graph imported by webchat/index.js', () => {
    const graph = staticImportGraph('index.js');
    assert.ok(graph.length > 20, 'graph walk found the WebChat modules');
    assert.deepEqual([...WEBCHAT_MODULE_PRELOADS].sort(), graph);
});

test('every module the user-facing page needs from /webchat/assets is preloaded', () => {
    for (const file of ['index.js', 'domSetup.js', 'sidePanel.js', 'messages.js', 'composer.js', 'network.js',
        'upload.js', 'composerAutocomplete.js', 'autocompleteProviders/slashCommands.js', 'autocompleteState.js',
        'composerMentionHighlights.js', 'sessions.js', 'tasks.js', 'interactionPrompt.js', 'workspaceFileIndex.js',
        'headerMenu.js', 'sessionSettings.js', 'workspaceFileLinks.js', 'fileHelpers.js', 'taskPresentation.js',
        'uploadDestinationDialog.js', 'markdown.js']) {
        assert.ok(WEBCHAT_MODULE_PRELOADS.includes(file), file);
    }
});

test('rendered links are modulepreload hints under the asset base', () => {
    const html = renderModulePreloadLinks('/webchat/assets');
    const hrefs = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"\/>/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, WEBCHAT_MODULE_PRELOADS.map((file) => `/webchat/assets/${file}`));
});

test('the served WebChat page carries the preload links before the module script', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-preload-')));
    fs.mkdirSync(path.join(root, '.ploinky'));
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    try {
        const { handleWebChat } = await import(`../../cli/server/handlers/webchat/index.js?preload=${Date.now()}`);
        const req = Readable.from([]);
        Object.assign(req, {
            url: '/webchat/', method: 'GET', headers: { host: '127.0.0.1' }, socket: {},
            user: { id: 'local:admin', username: 'admin', roles: ['user', 'admin'] },
        });
        let resolveEnd;
        const ended = new Promise((resolve) => { resolveEnd = resolve; });
        const res = {
            statusCode: 0, body: '', headers: null,
            setHeader() {}, getHeader() { return undefined; },
            writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
            write(chunk) { this.body += String(chunk || ''); return true; },
            end(chunk = '') { this.body += String(chunk || ''); resolveEnd(); },
        };
        await handleWebChat(req, res, { agentName: 'generic-test-agent' }, { sessions: new Map(), runtimes: new Map() });
        await ended;
        assert.equal(res.statusCode, 200, res.body.slice(0, 200));
        assert.equal(res.body.includes('__MODULE_PRELOADS__'), false);
        for (const file of WEBCHAT_MODULE_PRELOADS) {
            assert.ok(res.body.includes(`<link rel="modulepreload" href="/webchat/assets/${file}"/>`), file);
        }
        assert.ok(res.body.indexOf('rel="modulepreload"') < res.body.indexOf('<script type="module"'));
    } finally {
        if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
