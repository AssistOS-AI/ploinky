import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { launchCli } from '../../cli/index.js';
import { readAgentRegistrySnapshot } from '../../cli/utils/agentRegistrySnapshot.js';
import { parseLogCommandArgs } from '../../cli/commands/logCommands.js';
import { createForegroundCommandCoordinator } from '../../cli/commands/foregroundCommand.js';

const CLI_ENTRY = path.resolve(import.meta.dirname, '../../cli/index.js');
const LOG_COMMAND_ENTRY = path.resolve(import.meta.dirname, '../../cli/commands/logCommands.js');
const STATIC_LOCAL_IMPORT_PATTERN = /(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"](\.[^'"]+)['"]/g;

function staticLocalImportGraph(entry) {
    const visited = new Set();
    const pending = [entry];
    while (pending.length) {
        const current = pending.pop();
        if (visited.has(current)) continue;
        visited.add(current);
        const source = fs.readFileSync(current, 'utf8');
        for (const match of source.matchAll(STATIC_LOCAL_IMPORT_PATTERN)) {
            const resolved = path.resolve(path.dirname(current), match[1]);
            pending.push(path.extname(resolved) ? resolved : `${resolved}.js`);
        }
    }
    return visited;
}

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

function runLogsCli(logArgs, { cwd, env = {} } = {}) {
    return spawnSync(process.execPath, [CLI_ENTRY, ...logArgs], {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: '/usr/bin:/bin',
            NO_COLOR: '1',
            PLOINKY_WORKSPACE_ROOT: cwd,
            ...env,
        },
    });
}

function makeWorkspace(t, { agents } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-logs-entrypoint-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    if (agents !== undefined) {
        fs.mkdirSync(path.join(root, '.ploinky'), { recursive: true });
        fs.writeFileSync(
            path.join(root, '.ploinky', 'agents.json'),
            typeof agents === 'string' ? agents : JSON.stringify(agents),
        );
    }
    return root;
}

test('the logs grammar accepts exactly the documented forms', () => {
    const accepted = [
        [['logs', 'tail'], { subcommand: 'tail', target: 'router', startup: false }],
        [['logs', 'tail', 'router'], { subcommand: 'tail', target: 'router', startup: false }],
        [['logs', 'tail', 'webAgent'], { subcommand: 'tail', target: 'webAgent', startup: false }],
        [['logs', 'tail', 'webAgent', '--startup'], { target: 'webAgent', startup: true }],
        [['logs', 'tail', '--startup', 'webAgent'], { target: 'webAgent', startup: true }],
        [['logs', 'last'], { subcommand: 'last', target: 'router', lineCount: 200 }],
        [['logs', 'last', '5'], { subcommand: 'last', target: 'router', lineCount: 5 }],
        [['logs', 'last', '10000'], { subcommand: 'last', target: 'router', lineCount: 10000 }],
        [['logs', 'last', 'router'], { subcommand: 'last', target: 'router', lineCount: 200 }],
        [['logs', 'last', 'webAgent'], { target: 'webAgent', lineCount: 200 }],
        [['logs', 'last', '200', 'webAgent'], { target: 'webAgent', lineCount: 200 }],
        [['logs', 'last', '7', 'repo/webAgent'], { target: 'repo/webAgent', lineCount: 7 }],
        [['logs', 'last', '7', 'webAgent', '--startup'], { target: 'webAgent', startup: true }],
    ];
    for (const [argv, expected] of accepted) {
        const parsed = parseLogCommandArgs(argv);
        for (const [key, value] of Object.entries(expected)) {
            assert.equal(parsed[key], value, `${argv.join(' ')} -> ${key}`);
        }
    }

    const rejected = [
        ['logs'],
        ['logs', 'follow'],
        ['tail', 'router'],
        ['logs', 'tail', 'a', 'b'],
        ['logs', 'last', '5', 'a', 'b'],
        ['logs', 'last', '0'],
        ['logs', 'last', '-1'],
        ['logs', 'last', '1.5'],
        ['logs', 'last', '007'],
        ['logs', 'last', '10001'],
        ['logs', 'last', '5abc'],
        ['logs', 'last', ' 5'],
        ['logs', 'last', 'NaN', 'webAgent'],
        ['logs', 'last', 'webAgent', 'other'],
        ['logs', 'tail', '--unknown'],
        ['logs', 'tail', 'webAgent', '--startup', '--startup'],
        ['logs', 'tail', '--startup'],
        ['logs', 'tail', 'router', '--startup'],
        ['logs', 'last', '5', '--startup'],
    ];
    for (const argv of rejected) {
        assert.throws(
            () => parseLogCommandArgs(argv),
            (error) => error?.code === 'LOG_USAGE',
            `expected usage failure for: ${argv.join(' ')}`,
        );
    }
});

test('logs dispatches to its read-only handler without importing core initialization', async () => {
    const seen = [];
    const code = await launchCli(['logs', 'tail', 'exampleAgent'], {
        importCoreImpl: async () => {
            throw new Error('core initialization must not be imported');
        },
        importLogCommandsImpl: async () => ({
            runLogCommand: async (args) => {
                seen.push(args);
                return 7;
            },
        }),
    });
    assert.equal(code, 7);
    assert.deepEqual(seen, [['logs', 'tail', 'exampleAgent']]);
});

test('the observational logs import graph excludes mutation-capable lifecycle modules', () => {
    const graph = staticLocalImportGraph(LOG_COMMAND_ENTRY);
    const relative = Array.from(graph, (file) => path.relative(path.resolve(import.meta.dirname, '../..'), file));
    for (const forbidden of [
        'cli/main.js',
        'cli/commands/noWaitWorker.js',
        'cli/commands/workspaceUtil.js',
        'cli/commands/ploinkyboot.js',
        'cli/utils/workspace.js',
        'cli/sandbox/networkLifecycle.js',
        'cli/sandbox/docker/containerFleet.js',
        'cli/sandbox/docker/agentServiceManager.js',
        'cli/sandbox/bwrap/bwrapFleet.js',
    ]) {
        assert.equal(relative.includes(forbidden), false, `logs imported forbidden module ${forbidden}`);
    }

    const protocol = fs.readFileSync(
        path.resolve(import.meta.dirname, '../../cli/commands/noWaitProtocol.js'),
        'utf8',
    );
    assert.deepEqual(
        Array.from(protocol.matchAll(STATIC_LOCAL_IMPORT_PATTERN), (match) => match[1]),
        ['./noWaitIdentity.js', './noWaitIdentity.js'],
        'the protocol module must remain pure and dependency-minimal',
    );
});

test('the private Box stdin EOF channel cancels logs without recording an operator signal', async () => {
    const processRef = new EventEmitter();
    const coordinator = createForegroundCommandCoordinator({ processRef });
    const input = new EventEmitter();
    input.resume = () => {};
    let observedAbort = false;
    const launched = launchCli(['logs', 'tail', 'exampleAgent'], {
        env: { PLOINKY_BOX_LOG_STREAM: '1' },
        input,
        importCoreImpl: () => { throw new Error('logs must not import core'); },
        importLogCommandsImpl: async () => ({
            runLogCommand: async (_args, { signal }) => {
                await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
                observedAbort = true;
                return 0;
            },
        }),
        importForegroundImpl: async () => ({
            getForegroundCommandCoordinator: () => coordinator,
        }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    input.emit('end');
    assert.equal(await launched, 0);
    assert.equal(observedAbort, true);
    assert.equal(input.listenerCount('end'), 0);
    assert.equal(input.listenerCount('close'), 0);
});

test('logs accepts one global debug flag in either accepted placement', async () => {
    for (const argv of [['--debug', 'logs', 'last', '5', 'exampleAgent'], ['logs', '-d', 'last', '5', 'exampleAgent']]) {
        const stderr = [];
        const seen = [];
        let debugEnabled = false;
        const code = await launchCli(argv, {
            importCoreImpl: async () => {
                throw new Error('core initialization must not be imported');
            },
            importConfigImpl: async () => ({ setDebugMode: (value) => { debugEnabled = value; } }),
            importLogCommandsImpl: async () => ({
                runLogCommand: async (args) => {
                    seen.push(args);
                    return 0;
                },
            }),
            errorOutput: { write: (chunk) => stderr.push(chunk) },
        });
        assert.equal(code, 0);
        assert.equal(debugEnabled, true);
        // The debug flag is consumed exactly once and never reaches the parser.
        assert.deepEqual(seen, [['logs', 'last', '5', 'exampleAgent']]);
        // Debug notice must not contaminate stdout, which carries log bytes only.
        assert.deepEqual(stderr, ['[INFO] Debug mode enabled.\n']);
    }
});

test('logs never creates workspace state in an absent workspace', (t) => {
    const root = makeWorkspace(t);
    const before = treeHash(root);
    for (const argv of [['logs', 'last', '5'], ['logs', 'last', 'someAgent'], ['logs', 'bogus']]) {
        const result = runLogsCli(argv, { cwd: root });
        assert.notEqual(result.status, null, result.stderr);
        assert.equal(treeHash(root), before, `workspace changed after: ${argv.join(' ')}`);
    }
    assert.equal(fs.existsSync(path.join(root, '.ploinky')), false);
});

test('logs leaves an existing workspace unchanged on failure', (t) => {
    const root = makeWorkspace(t, {
        agents: {
            ploinky_example: {
                type: 'agent',
                runtime: 'podman',
                agentName: 'exampleAgent',
                repoName: 'exampleRepo',
            },
        },
    });
    const before = treeHash(root);

    const failure = runLogsCli(['logs', 'last', '0', 'exampleAgent'], { cwd: root });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /line count/);
    assert.equal(treeHash(root), before);
});

test('logs runs without the unrelated core runtime dependencies', (t) => {
    const root = makeWorkspace(t, { agents: {} });
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-logs-noroot-'));
    t.after(() => fs.rmSync(emptyRoot, { recursive: true, force: true }));

    const logs = runLogsCli(['logs', 'last', '5', 'missingAgent'], { cwd: root, env: { PLOINKY_ROOT: emptyRoot } });
    assert.equal(logs.status, 1, logs.stderr);
    assert.doesNotMatch(logs.stderr, /dependencies missing/);

    // The same absent dependency root still blocks a mutating core command, so
    // the assertion above proves the logs path skipped that gate.
    const enable = runLogsCli(['enable', 'agent', 'exampleAgent'], {
        cwd: root,
        env: { PLOINKY_ROOT: emptyRoot },
    });
    assert.equal(enable.status, 1);
    assert.match(enable.stderr, /dependencies missing/);
});

test('registry snapshot treats an absent registry as empty and fails closed otherwise', (t) => {
    const absent = makeWorkspace(t);
    assert.deepEqual(readAgentRegistrySnapshot({ workspaceRoot: absent }), {});

    const emptyDir = makeWorkspace(t);
    fs.mkdirSync(path.join(emptyDir, '.ploinky'), { recursive: true });
    assert.deepEqual(readAgentRegistrySnapshot({ workspaceRoot: emptyDir }), {});

    const populated = makeWorkspace(t, { agents: { ploinky_example: { type: 'agent' } } });
    const snapshot = readAgentRegistrySnapshot({ workspaceRoot: populated });
    assert.equal(snapshot.ploinky_example.type, 'agent');
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.ploinky_example), true);

    const corrupt = makeWorkspace(t, { agents: '{ not json' });
    assert.throws(
        () => readAgentRegistrySnapshot({ workspaceRoot: corrupt }),
        /not one valid JSON/,
    );

    const nonObject = makeWorkspace(t, { agents: '[]' });
    assert.throws(
        () => readAgentRegistrySnapshot({ workspaceRoot: nonObject }),
        /must contain one top-level object/,
    );

    const symlinked = makeWorkspace(t);
    fs.mkdirSync(path.join(symlinked, '.ploinky'), { recursive: true });
    const outside = path.join(symlinked, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify({ ploinky_foreign: { type: 'agent' } }));
    fs.symlinkSync(outside, path.join(symlinked, '.ploinky', 'agents.json'));
    assert.throws(
        () => readAgentRegistrySnapshot({ workspaceRoot: symlinked }),
        /not one regular file/,
    );

    const symlinkedDir = makeWorkspace(t);
    const realDir = path.join(symlinkedDir, 'elsewhere');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'agents.json'), '{}');
    fs.symlinkSync(realDir, path.join(symlinkedDir, '.ploinky'));
    assert.throws(
        () => readAgentRegistrySnapshot({ workspaceRoot: symlinkedDir }),
        /not one regular directory/,
    );
});

test('a corrupt registry fails the logs command without repairing it', (t) => {
    const root = makeWorkspace(t, { agents: '{ not json' });
    const before = treeHash(root);
    const result = runLogsCli(['logs', 'last', 'someAgent'], { cwd: root });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /agents registry/);
    assert.equal(result.stdout, '');
    assert.equal(treeHash(root), before);

    // An absent registry is empty state, not a failure of the registry read:
    // the reference simply resolves to no enabled agent.
    const empty = makeWorkspace(t);
    const missing = runLogsCli(['logs', 'last', 'someAgent'], { cwd: empty });
    assert.equal(missing.status, 1);
    assert.doesNotMatch(missing.stderr, /agents registry/);
    assert.match(missing.stderr, /is not one enabled agent/);
});
