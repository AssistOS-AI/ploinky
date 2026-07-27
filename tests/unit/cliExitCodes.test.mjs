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
    const ploinky = path.join(workspace, '.ploinky');
    for (const repoName of bootRepos) {
        fs.mkdirSync(path.join(ploinky, 'repos', repoName), { recursive: true });
    }
    fs.writeFileSync(path.join(ploinky, 'routing.json'), JSON.stringify({ routes: {} }));
    fs.writeFileSync(path.join(ploinky, 'agents.json'), '{}');
    fs.mkdirSync(path.join(ploinky, 'data', 'router-security'), { recursive: true });
    fs.writeFileSync(
        path.join(ploinky, 'data', 'router-security', 'policy-state.json'),
        JSON.stringify({ schema: 'router-policy', httpRoutes: [], mcpTools: [] }),
    );
    fs.mkdirSync(path.join(ploinky, 'data', 'edge-routing'), { recursive: true });
    fs.writeFileSync(path.join(ploinky, 'data', 'edge-routing', 'desired.json'), JSON.stringify({
        hosts: {},
    }));
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
    const result = runPloinky(t, ['start', 'demo', '8080']);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Agent 'demo' not found/);
});

test('one-shot start without initial configuration exits nonzero', (t) => {
    const result = runPloinky(t, ['start']);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /persisted router port is required/);
});

test('first core command initializes the complete edge source set together', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-cli-fresh-sources-'));
    for (const repoName of bootRepos) {
        fs.mkdirSync(path.join(workspace, '.ploinky', 'repos', repoName), { recursive: true });
    }
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

    const result = spawnSync(process.execPath, [cliEntry, 'list', 'agents'], {
        cwd: workspace,
        encoding: 'utf8',
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: workspace,
            PLOINKY_MASTER_KEY: '5'.repeat(64),
        },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const ploinky = path.join(workspace, '.ploinky');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ploinky, 'agents.json'), 'utf8')), {});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ploinky, 'routing.json'), 'utf8')), { routes: {} });
    assert.deepEqual(JSON.parse(fs.readFileSync(
        path.join(ploinky, 'data', 'router-security', 'policy-state.json'),
        'utf8',
    )), { schema: 'router-policy', httpRoutes: [], mcpTools: [] });
    assert.deepEqual(JSON.parse(fs.readFileSync(
        path.join(ploinky, 'data', 'edge-routing', 'desired.json'),
        'utf8',
    )), {
        hosts: {},
    });
});

test('removed component-token rotation flags fail hard', (t) => {
    for (const component of ['webchat', 'dashboard']) {
        const result = runPloinky(t, [component, '--rotate']);
        assert.notEqual(result.status, 0, `${component} unexpectedly accepted --rotate`);
        assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(`Usage: ${component}`));
    }
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

test('managed launcher delegates every command to the Box entrypoint', () => {
    const launcher = fs.readFileSync(path.join(repoRoot, 'bin', 'ploinky'), 'utf8');
    assert.match(launcher, /ploinky-box\/bin\/ploinky-box\.mjs" "\$@"/);
    assert.doesNotMatch(launcher, /skip_dependency_gate|deps_missing/);
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
