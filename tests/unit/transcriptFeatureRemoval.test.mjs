import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { handleDashboard } from '../../cli/server/handlers/dashboard.js';
import { handleWebChat } from '../../cli/server/handlers/webchat/index.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function source(relativePath) {
    return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function sourcesUnder(relativeDirectory) {
    const absoluteDirectory = path.join(projectRoot, relativeDirectory);
    return fs.readdirSync(absoluteDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
        .map((entry) => path.join(relativeDirectory, entry.name));
}

function makeRequest(url, method = 'GET') {
    const req = Readable.from([]);
    req.url = url;
    req.method = method;
    req.headers = { host: '127.0.0.1' };
    req.socket = {};
    req.user = { id: 'local:test', username: 'test', roles: ['user'] };
    return req;
}

function makeResponse() {
    let resolveEnd;
    const ended = new Promise((resolve) => { resolveEnd = resolve; });
    return {
        statusCode: 0,
        body: '',
        ended,
        setHeader() {},
        getHeader() { return undefined; },
        writeHead(statusCode) { this.statusCode = statusCode; },
        write(chunk) { this.body += String(chunk || ''); return true; },
        end(chunk = '') { this.body += String(chunk || ''); resolveEnd(); },
    };
}

test('transcript storage and conversation rating code is absent from Ploinky', () => {
    assert.equal(fs.existsSync(path.join(projectRoot, 'cli/server/utils/transcriptStore.js')), false);
    assert.equal(fs.existsSync(path.join(projectRoot, 'cli/server/utils/transcriptCrypto.js')), false);

    const checkedSources = [
        ...sourcesUnder('cli/server/handlers/webchat'),
        'cli/services/config.js',
        'cli/server/handlers/dashboard.js',
        'cli/server/webchat/index.js',
        'cli/server/webchat/messages.js',
        'cli/server/webchat/network.js',
        'cli/server/webchat/sessionStore.js',
        'cli/server/dashboard/dashboard.html',
        'cli/server/dashboard/dashboard.js',
    ].map(source).join('\n');

    assert.doesNotMatch(checkedSources, /PLOINKY_TRANSCRIPT|TRANSCRIPTS_DIR|transcriptStore|transcriptCrypto/);
    assert.doesNotMatch(checkedSources, /\/webchat\/feedback|\/api\/transcripts|\/api\/feedback/);
    assert.doesNotMatch(checkedSources, /thumb-up|thumb-down|feedback-changed|message-meta|rated turns|likes|dislikes/i);
});

test('removed WebChat and Dashboard endpoints return ordinary 404 responses', async () => {
    const appState = { sessions: new Map(), runtimes: new Map() };

    const webchatResponse = makeResponse();
    await handleWebChat(
        makeRequest('/webchat/feedback', 'POST'),
        webchatResponse,
        { agentName: 'generic-test-agent' },
        appState
    );
    await webchatResponse.ended;
    assert.equal(webchatResponse.statusCode, 404);

    for (const endpoint of ['/dashboard/api/transcripts', '/dashboard/api/feedback']) {
        const dashboardResponse = makeResponse();
        await handleDashboard(
            makeRequest(endpoint),
            dashboardResponse,
            { agentName: 'Dashboard' },
            appState
        );
        await dashboardResponse.ended;
        assert.equal(dashboardResponse.statusCode, 404);
    }
});
