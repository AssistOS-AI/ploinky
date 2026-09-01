import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const utilsUrl = pathToFileURL(path.join(repoRoot, 'cli', 'utils', 'utils.js')).href;
const bootstrapManifestUrl = pathToFileURL(path.join(repoRoot, 'cli', 'utils', 'runtime', 'bootstrapManifest.js')).href;
const reposUrl = pathToFileURL(path.join(repoRoot, 'cli', 'utils', 'repos.js')).href;

function writeManifest(workspace, repoName, agentName) {
    const agentDir = path.join(workspace, '.ploinky', 'repos', repoName, agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify({ container: 'node:20' }, null, 2));
}

test('bare agent lookup prefers enabled repos before inactive installed repos', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agent-lookup-'));
    try {
        writeManifest(workspace, 'AchillesIDE', 'explorer');
        writeManifest(workspace, 'fileExplorer', 'explorer');
        fs.writeFileSync(
            path.join(workspace, '.ploinky', 'enabled_repos.json'),
            JSON.stringify(['fileExplorer'], null, 2),
        );

        const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
const { findAgent } = await import(${JSON.stringify(utilsUrl)});
const found = findAgent('explorer');
process.stdout.write(JSON.stringify(found));
`], {
            cwd: workspace,
            encoding: 'utf8',
            env: {
                ...process.env,
                PLOINKY_WORKSPACE_ROOT: workspace,
            },
        });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).repo, 'fileExplorer');
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('bare agent lookup falls back to inactive installed repos when enabled repos have no match', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agent-lookup-'));
    try {
        writeManifest(workspace, 'AchillesIDE', 'explorer');
        writeManifest(workspace, 'utilities', 'shellTool');
        fs.writeFileSync(
            path.join(workspace, '.ploinky', 'enabled_repos.json'),
            JSON.stringify(['utilities'], null, 2),
        );

        const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
const { findAgent } = await import(${JSON.stringify(utilsUrl)});
const found = findAgent('explorer');
process.stdout.write(JSON.stringify(found));
`], {
            cwd: workspace,
            encoding: 'utf8',
            env: {
                ...process.env,
                PLOINKY_WORKSPACE_ROOT: workspace,
            },
        });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).repo, 'AchillesIDE');
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('bare agent lookup skips a dangling repo entry', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agent-lookup-'));
    try {
        writeManifest(workspace, 'AchillesIDE', 'explorer');
        fs.symlinkSync(
            path.join(workspace, 'missing-candidate-checkout'),
            path.join(workspace, '.ploinky', 'repos', 'candidate'),
        );

        const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
const { findAgent } = await import(${JSON.stringify(utilsUrl)});
const found = findAgent('explorer');
process.stdout.write(JSON.stringify(found));
`], {
            cwd: workspace,
            encoding: 'utf8',
            env: {
                ...process.env,
                PLOINKY_WORKSPACE_ROOT: workspace,
            },
        });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).repo, 'AchillesIDE');
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('manifest repos are enabled even when their checkouts already exist', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-manifest-repos-'));
    try {
        writeManifest(workspace, 'depRepo', 'worker');
        const staticDir = path.join(workspace, '.ploinky', 'repos', 'staticRepo', 'app');
        fs.mkdirSync(staticDir, { recursive: true });
        fs.writeFileSync(path.join(staticDir, 'manifest.json'), JSON.stringify({
            container: 'node:20',
            repos: {
                depRepo: '/already-installed',
            },
        }, null, 2));

        const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
const { applyManifestDirectives } = await import(${JSON.stringify(bootstrapManifestUrl)});
const { loadEnabledRepos } = await import(${JSON.stringify(reposUrl)});
await applyManifestDirectives('staticRepo/app');
process.stdout.write(JSON.stringify(loadEnabledRepos()));
`], {
            cwd: workspace,
            encoding: 'utf8',
            env: {
                ...process.env,
                PLOINKY_WORKSPACE_ROOT: workspace,
            },
        });

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), ['depRepo']);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
