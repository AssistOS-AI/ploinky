import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { launchCli } from '../../cli/index.js';

function treeHash(root) {
    const hash = crypto.createHash('sha256');
    function walk(directory, relative = '') {
        for (const name of fs.readdirSync(directory).sort()) {
            const target = path.join(directory, name);
            const next = path.join(relative, name);
            const stat = fs.lstatSync(target);
            hash.update(`${next}\0${stat.mode}\0`);
            if (stat.isDirectory()) walk(target, next);
            else if (stat.isFile()) hash.update(fs.readFileSync(target));
            else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(target));
        }
    }
    walk(root);
    return hash.digest('hex');
}

test('status dispatches to its read-only renderer before core initialization', async () => {
    const calls = [];
    const code = await launchCli(['status'], {
        bootstrapAgentLibImpl: async ({ readOnly }) => {
            assert.equal(readOnly, true);
            calls.push('agentlib');
        },
        statusWorkspaceImpl: async (options) => calls.push(['status', options]),
        importCoreImpl: async () => {
            throw new Error('core initialization must not be imported');
        },
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, ['agentlib', ['status', { verbose: false }]]);
});

test('verbose and debug status remain read-only and request diagnostic detail', async () => {
    for (const args of [['status', '--verbose'], ['--debug', 'status'], ['status', '-d']]) {
        const calls = [];
        const code = await launchCli(args, {
            bootstrapAgentLibImpl: async ({ readOnly }) => {
                assert.equal(readOnly, true);
                calls.push('agentlib');
            },
            statusWorkspaceImpl: async (options) => calls.push(['status', options]),
            importCoreImpl: async () => {
                throw new Error('core initialization must not be imported');
            },
        });
        assert.equal(code, 0, args.join(' '));
        assert.deepEqual(calls, ['agentlib', ['status', { verbose: true }]], args.join(' '));
    }
});

test('status rejects unsupported or repeated options before bootstrap', async () => {
    for (const args of [['status', '--json'], ['status', '--verbose', '--verbose']]) {
        let bootstrapped = false;
        await assert.rejects(
            launchCli(args, {
                bootstrapAgentLibImpl: async () => { bootstrapped = true; },
                statusWorkspaceImpl: async () => {},
            }),
            /Usage: status \[--verbose\]/,
        );
        assert.equal(bootstrapped, false, args.join(' '));
    }
});

test('status renders terminal color intent without changing workspace state', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-status-entrypoint-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const agentLib = path.join(root, 'achillesAgentLib');
    for (const directory of ['LLMAgents', 'utils', 'jwt']) {
        fs.mkdirSync(path.join(agentLib, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(agentLib, 'package.json'), '{"name":"ploinky-agent-lib"}\n');
    for (const entrypoint of [
        'LLMAgents/index.mjs',
        'utils/LLMClient.mjs',
        'jwt/jwtSign.mjs',
        'jwt/jwtVerify.mjs',
    ]) {
        fs.writeFileSync(path.join(agentLib, entrypoint), 'export {};\n');
    }
    const ploinky = path.join(root, '.ploinky');
    fs.mkdirSync(path.join(ploinky, 'repos'), { recursive: true });
    fs.writeFileSync(path.join(ploinky, 'routing.json'), '{"port":8080}\n');
    fs.writeFileSync(path.join(ploinky, 'agents.json'), JSON.stringify({
        ploinky_example: {
            type: 'agent',
            runtime: 'podman',
            agentName: 'exampleAgent',
            repoName: 'exampleRepo',
            containerImage: 'example/image:latest',
            createdAt: '2026-07-31T00:00:00.000Z',
            projectPath: '/workspace',
        },
    }));
    const invokeStatus = (environmentOverrides = {}, statusArgs = []) => {
        const environment = { ...process.env };
        delete environment.NO_COLOR;
        delete environment.PLOINKY_COLOR;
        Object.assign(environment, environmentOverrides, {
            PATH: '/usr/bin:/bin',
            PLOINKY_WORKSPACE_ROOT: root,
        });
        const before = treeHash(root);
        const result = spawnSync(process.execPath, [
            path.resolve(import.meta.dirname, '../../cli/index.js'),
            'status', ...statusArgs,
        ], {
            cwd: root,
            encoding: 'utf8',
            env: environment,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(treeHash(root), before);
        return result.stdout;
    };

    const plainOutput = invokeStatus();
    const coloredOutput = invokeStatus({ PLOINKY_COLOR: '1' });
    const noColorOutput = invokeStatus({ PLOINKY_COLOR: '1', NO_COLOR: '1' });
    const verboseOutput = invokeStatus({}, ['--verbose']);

    for (const output of [plainOutput, noColorOutput]) {
        assert.doesNotMatch(output, /\u001B\[/);
        assert.match(output, /Workspace status:/);
        assert.match(output, /Agent runtimes:/);
        assert.match(output, /ploinky_example \[stopped\] \[podman\]/);
        assert.match(output, /agent: exampleAgent  repo: exampleRepo/);
        assert.match(output, /^  - ploinky_example/m);
        assert.doesNotMatch(output, /\u2022/);
        assert.doesNotMatch(output, /AgentLib core:/);
        assert.doesNotMatch(output, /LLMAgents\/index\.mjs:/);
    }

    for (const expected of [
        '\u001B[1m\u001B[36mWorkspace status:\u001B[0m',
        '\u001B[90m\u2022\u001B[0m',
        '\u001B[36mploinky_example\u001B[0m',
        '\u001B[33m[stopped]\u001B[0m',
        '\u001B[90m[podman]\u001B[0m',
    ]) {
        assert.ok(coloredOutput.includes(expected), `missing colored status fragment ${JSON.stringify(expected)}`);
    }
    assert.match(coloredOutput, /Workspace status:/);
    assert.match(coloredOutput, /Agent runtimes:/);
    assert.match(verboseOutput, /AgentLib core:/);
    assert.match(verboseOutput, /LLMAgents\/index\.mjs:/);
});
