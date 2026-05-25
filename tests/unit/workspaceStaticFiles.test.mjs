import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { serveWorkspaceFileRequest } from '../../cli/server/static/index.js';

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
