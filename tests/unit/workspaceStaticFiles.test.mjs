import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { serveWorkspaceFileRequest } from '../../cli/server/static/index.js';
import { getWorkspaceRoot } from '../../cli/server/utils/workspacePaths.js';

function createResponseRecorder() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(statusCode, headers = {}) {
            this.statusCode = statusCode;
            this.headers = headers;
            this.headersSent = true;
        },
        end(chunk = '') {
            this.body += String(chunk);
        }
    };
}

test('workspace file route returns 404 for missing in-workspace files', () => {
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-workspace-files-'));
    try {
        process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
        fs.mkdirSync(path.join(workspaceRoot, '.ploinky', 'repos', 'repo', 'agent', 'IDE-plugins', 'plugin'), {
            recursive: true
        });

        const req = {
            method: 'GET',
            url: '/workspace-files/.ploinky/repos/repo/agent/IDE-plugins/plugin/missing.html',
            headers: { host: '127.0.0.1:8080' }
        };
        const res = createResponseRecorder();

        assert.equal(serveWorkspaceFileRequest(req, res), true);
        assert.equal(res.statusCode, 404);
        assert.equal(res.body, 'Not Found');
    } finally {
        if (previousRoot === undefined) {
            delete process.env.PLOINKY_WORKSPACE_ROOT;
        } else {
            process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        }
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('workspace file route streams Markdown inline with a previewable MIME type', async () => {
    const workspaceRoot = getWorkspaceRoot();
    const previewDirectory = fs.mkdtempSync(path.join(workspaceRoot, '.ploinky-workspace-preview-'));
    try {
        const filePath = path.join(previewDirectory, 'README.md');
        fs.writeFileSync(filePath, '# Preview\n');
        const relativePath = path.relative(workspaceRoot, filePath).replace(/\\+/g, '/');
        const req = {
            method: 'GET',
            url: `/workspace-files/${relativePath}`,
            headers: { host: '127.0.0.1:8080' },
        };
        const res = new PassThrough();
        res.statusCode = null;
        res.headers = null;
        res.writeHead = (statusCode, headers = {}) => {
            res.statusCode = statusCode;
            res.headers = headers;
        };
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        const finished = new Promise((resolve, reject) => {
            res.on('finish', resolve);
            res.on('error', reject);
        });

        assert.equal(serveWorkspaceFileRequest(req, res), true);
        await finished;

        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['Content-Type'], 'text/markdown; charset=utf-8');
        assert.equal(res.headers['Content-Disposition'], 'inline');
        assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
        assert.equal(body, '# Preview\n');
    } finally {
        fs.rmSync(previewDirectory, { recursive: true, force: true });
    }
});
