import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const cliEntry = path.join(repoRoot, 'cli', 'index.js');
const lightweightBoundaryLoader = path.join(
    repoRoot,
    'tests',
    'fixtures',
    'lightweightCliBoundaryLoader.mjs',
);
const bootRepos = ['basic', 'AchillesIDE', 'AchillesCLI', 'copilot-agents'];

function createWorkspace(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-cli-exit-'));
    for (const repoName of bootRepos) {
        fs.mkdirSync(path.join(workspace, '.ploinky', 'repos', repoName), { recursive: true });
    }
    t.after(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    return workspace;
}

function runPloinky(t, args) {
    const workspace = createWorkspace(t);
    return spawnSync(process.execPath, [cliEntry, ...args], {
        cwd: workspace,
        encoding: 'utf8',
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: workspace,
            PLOINKY_MASTER_KEY: '5'.repeat(64),
        },
    });
}

test('one-shot enable agent failure exits nonzero', (t) => {
    const result = runPloinky(t, ['enable', 'agent', 'nonexistent-agent-xyz']);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Agent 'nonexistent-agent-xyz' not found/);
});

test('one-shot start failure exits nonzero', (t) => {
    const result = runPloinky(t, ['start', 'demo', '18080']);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Agent 'demo' not found/);
});

test('one-shot start without initial configuration exits nonzero', (t) => {
    const result = runPloinky(t, ['start']);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /persisted router port is required/);
});

test('enable repo marks an installed repository as enabled', (t) => {
    const workspace = createWorkspace(t);
    const repoName = 'testRepo';
    fs.mkdirSync(path.join(workspace, '.ploinky', 'repos', repoName), { recursive: true });

    const result = spawnSync(process.execPath, [cliEntry, 'enable', 'repo', repoName], {
        cwd: workspace,
        encoding: 'utf8',
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: workspace,
            PLOINKY_MASTER_KEY: '5'.repeat(64),
        },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const enabledPath = path.join(workspace, '.ploinky', 'enabled_repos.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(enabledPath, 'utf8')), [repoName]);
});

test('direct-core bare cli fails before dependency initialization', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-empty-root-'));
    try {
        const result = spawnSync(
            process.execPath,
            [
                '--experimental-loader', lightweightBoundaryLoader,
                'cli/index.js', 'cli',
            ],
            {
                cwd: repoRoot,
                env: { ...process.env, PLOINKY_ROOT: emptyRoot },
                encoding: 'utf8',
            },
        );
        const output = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, 1);
        assert.match(output, /requires the managed Ploinky runtime/);
        assert.doesNotMatch(output, /Ploinky dependencies missing/);
        assert.doesNotMatch(output, /FORBIDDEN_CORE_MODULE/);
    } finally {
        fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
});

test('help and direct-core bare cli do not load the core command graph', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-empty-root-'));
    try {
        for (const args of [['help'], ['--help'], ['-h']]) {
            const result = spawnSync(
                process.execPath,
                [
                    '--experimental-loader', lightweightBoundaryLoader,
                    'cli/index.js', ...args,
                ],
                {
                    cwd: repoRoot,
                    env: { ...process.env, PLOINKY_ROOT: emptyRoot },
                    encoding: 'utf8',
                },
            );
            assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || ''));
        }

        const shell = spawnSync(
            process.execPath,
            [
                '--experimental-loader', lightweightBoundaryLoader,
                'cli/index.js', 'cli',
            ],
            {
                cwd: repoRoot,
                env: { ...process.env, PLOINKY_ROOT: emptyRoot },
                encoding: 'utf8',
            },
        );
        const output = (shell.stdout || '') + (shell.stderr || '');
        assert.equal(shell.status, 1);
        assert.match(output, /requires the managed Ploinky runtime/);
        assert.doesNotMatch(output, /FORBIDDEN_CORE_MODULE/);
    } finally {
        fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
});

test('managed launcher bypasses its dependency gate only for help and bare cli', () => {
    const launcher = fs.readFileSync(path.join(repoRoot, 'bin', 'ploinky'), 'utf8');
    assert.match(
        launcher,
        /case "\$\{1:-\}" in[\s\S]*help\|--help\|-h[\s\S]*cli[\s\S]*skip_dependency_gate=1/,
    );
    assert.ok(
        launcher.indexOf('skip_dependency_gate=1')
        < launcher.indexOf('deps_missing=0'),
    );
    assert.match(
        launcher,
        /cli\)[\s\S]{0,160}\[\[ "\$#" -eq 1 \]\] && skip_dependency_gate=1/,
    );
});

test('one-shot bare cli propagates the exact shell exit code', () => {
    const result = spawnSync(
        process.execPath,
        [
            '--experimental-loader', lightweightBoundaryLoader,
            'cli/index.js', 'cli',
        ],
        {
            cwd: repoRoot,
            env: {
                ...process.env,
                PLOINKY_TEST_RUNTIME_SHELL_STATUS: '7',
            },
            encoding: 'utf8',
        },
    );

    assert.equal(result.status, 7, (result.stdout || '') + (result.stderr || ''));
});
