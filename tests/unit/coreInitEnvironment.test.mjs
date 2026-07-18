import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-core-init-'));
}

test('core init leaves a fresh workspace eligible for atomic edge-source bootstrap', () => {
    const workspace = tempDir();
    try {
        const script = `
import fs from 'node:fs';
const config = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'cli/services/config.js')).href)});
config.initEnvironment();
const edge = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'cli/services/edgeGeneration.js')).href)});
const result = edge.initializeFreshEdgeRoutingSources({ workspaceRoot: process.env.PLOINKY_WORKSPACE_ROOT });
const files = ['routingFile', 'agentsFile', 'policyFile', 'desiredFile']
    .map((key) => edge.resolveEdgeGenerationPaths({ workspaceRoot: process.env.PLOINKY_WORKSPACE_ROOT })[key]);
if (!result.initialized || files.some((file) => !fs.existsSync(file))) process.exit(2);
`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: workspace,
            env: {
                ...process.env,
                PLOINKY_WORKSPACE_ROOT: workspace,
                PLOINKY_MASTER_KEY: '6'.repeat(64),
            },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
