import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { launchCli } from '../../cli/index.js';
import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';
import { parseOuterArguments } from '../../ploinky-box/command/parse.mjs';
import { routeOuterCommand } from '../../ploinky-box/command/route.mjs';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { writeAgentLibCheckout } from '../helpers/agentlibFixture.mjs';

test('canary status uses the read-only AgentLib contract and dispatches directly', async () => {
    for (const args of [['canary', 'status'], ['canary', '-d', 'status', '--json']]) {
        const calls = [];
        const code = await launchCli(args, {
            detectInsideBox: () => true,
            bootstrapAgentLibImpl: async ({ readOnly }) => {
                assert.equal(readOnly, true);
                calls.push('read-only bootstrap');
            },
            runCanaryCommandImpl: async commandArgs => calls.push(commandArgs),
            importCoreImpl: () => assert.fail('canary status initialized core'),
        });
        assert.equal(code, 0);
        assert.deepEqual(calls, ['read-only bootstrap', args.filter(arg => arg !== '-d').slice(1)]);
    }
});

test('unmanaged ploinky-local canary status refuses before accessing credentials or initializing state', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-unmanaged-canary-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const invoke = () => {
        const result = spawnSync(process.execPath, [
            path.resolve(import.meta.dirname, '../../cli/index.js'), 'canary', 'status', '--json',
        ], {
            cwd: root, encoding: 'utf8', env: { HOME: root, TMPDIR: root, PLOINKY_WORKSPACE_ROOT: root },
        });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /canary status requires a running managed Box/);
        assert.equal(result.stdout, '');
    };
    invoke();
    assert.deepEqual(fs.readdirSync(root), []);
    writeAgentLibCheckout(path.join(root, 'achillesAgentLib'));
    fs.mkdirSync(path.join(root, '.ploinky'));
    fs.writeFileSync(path.join(root, '.ploinky', 'routing.json'), '{"port":8080}\n');
    const dir = path.join(root, '.data', 'dpu-data');
    fs.mkdirSync(dir, { recursive: true });
    const key = path.join(dir, 'master-key');
    fs.writeFileSync(key, 'a'.repeat(64) + '\n');
    fs.chmodSync(key, 0o400);
    const before = fs.statSync(key, { bigint: true });
    invoke();
    const after = fs.statSync(key, { bigint: true });
    assert.equal(after.mode, before.mode);
    assert.equal(after.ctimeNs, before.ctimeNs);
    assert.deepEqual(fs.readdirSync(root).sort(), ['.data', '.ploinky', 'achillesAgentLib']);
    assert.deepEqual(fs.readdirSync(path.join(root, '.ploinky')), ['routing.json']);
});

test('other canary subcommands still use the ordinary core dispatch', async () => {
    const calls = [];
    const args = ['canary', 'start'];
    await launchCli(args, {
        bootstrapAgentLibImpl: async ({ readOnly }) => {
            assert.equal(readOnly, undefined);
            calls.push('bootstrap');
        },
        importCoreImpl: async () => ({
            runCoreCli: async argv => {
                calls.push(argv);
                return 0;
            },
        }),
        runCanaryCommandImpl: () => assert.fail('unexpected read-only dispatch'),
    });
    assert.deepEqual(calls, ['bootstrap', args]);
});

const containerId = 'a'.repeat(64);
const workspace = process.cwd();
const hostOptions = {
    env: {}, input: { isTTY: false }, output: { write() {} }, errorOutput: { write() {} },
    cwd: () => workspace, detectInsideBox: () => false,
};

test('canary status inspects the running Box and forwards the original arguments and exit code', async () => {
    const args = ['canary', '--debug', 'status', '--json'];
    const events = [];
    const supervisor = {
        inspectBoxStatus() {
            events.push('inspect');
            return {
                state: 'running-initialized',
                identity: { workspaceRoot: workspace },
                ownership: {
                    engine: { name: 'podman' },
                    handles: { container: {
                        id: containerId,
                        labels: { [BOX_LABELS.routerHostPort]: '19090', [BOX_LABELS.mediaHostPort]: '17891' },
                    } },
                },
            };
        },
    };
    function forward(command, argv) {
        events.push([command, argv.slice(-6)]);
        return 17;
    }
    const code = await runOuterCli(args, { ...hostOptions, supervisor, execute: forward, executeStreaming: forward });
    assert.equal(code, 17);
    assert.deepEqual(events, ['inspect', ['podman', [containerId, '/opt/ploinky/bin/ploinky-local', ...args]]]);
});

test('canary status on an unavailable Box only inspects it and reports the state', async () => {
    for (const state of ['absent', 'stopped', 'running-uninitialized', 'foreign']) {
        let inspections = 0;
        let diagnostic = '';
        const code = await runOuterCli(['canary', 'status'], {
            ...hostOptions,
            errorOutput: { write(message) { diagnostic += message; } },
            supervisor: { inspectBoxStatus() { inspections++; return { state }; } },
            execute: () => assert.fail('unexpected execution'),
            executeStreaming: () => assert.fail('unexpected streaming execution'),
        });
        assert.equal(inspections, 1);
        assert.equal(code, 1);
        assert.ok(diagnostic.includes(state), diagnostic);
    }
});

test('other canary subcommands use generic host forwarding', () => {
    for (const action of ['start', 'abort', 'promote']) {
        const args = ['canary', action];
        assert.deepEqual(routeOuterCommand(parseOuterArguments(args)), { kind: 'generic', coreArgv: args });
    }
});
