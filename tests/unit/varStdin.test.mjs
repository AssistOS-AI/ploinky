import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { handleVarStdinCommand, isVarStdinRequest } from '../../cli/commands/envVarCommands.js';
import { buildContainerExecArgs, executeProcess } from '../../ploinky-box/command/execute.mjs';
import { parseOuterArguments } from '../../ploinky-box/command/parse.mjs';
import { routeOuterCommand } from '../../ploinky-box/command/route.mjs';
import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET = 'cf-token-value-never-on-argv';

function bufferStream(isTTY = false) {
    let value = '';
    return { isTTY, write(chunk) { value += String(chunk); }, value: () => value };
}

function route(argv) {
    return routeOuterCommand(parseOuterArguments(argv));
}

function fixture(t) {
    const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-var-stdin-')));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
    const events = [];
    const supervisor = {
        prepareBoxForCommand: async () => {
            events.push('prepare');
            return {
                identity: { instance: 'ploinky-box-workspace-123456789abc', workspaceRoot },
                containerId: 'a'.repeat(64),
                engine: { name: 'podman' },
                hostPort: 19090,
                mediaHostPort: 17882,
            };
        },
    };
    return { events, supervisor, workspaceRoot };
}

function runVar(state, input, argv = ['var', 'publication/explorer-qa-api', '--stdin']) {
    return runOuterCli(argv, {
        env: {},
        input,
        output: bufferStream(),
        errorOutput: bufferStream(),
        supervisor: state.supervisor,
        cwd: () => state.workspaceRoot,
        detectInsideBox: () => false,
        execute: (command, args, options) => {
            state.events.push(['execute', command, args, options]);
            return 0;
        },
    });
}

test('var NAME --stdin routes as a generic command that carries a stdin value', () => {
    const routed = route(['var', 'publication/explorer-qa-api', '--stdin']);
    assert.equal(routed.kind, 'generic');
    assert.equal(routed.stdinValue, true);
    assert.deepEqual([...routed.coreArgv], ['var', 'publication/explorer-qa-api', '--stdin']);
    assert.equal(route(['var', 'NAME', 'value']).stdinValue, undefined);
    assert.equal(route(['var', 'NAME', '--stdin', 'extra']).stdinValue, undefined);
    assert.equal(route(['--dry-run', 'var', 'NAME', '--stdin']).kind, 'dry-run');
    assert.equal(route(['--dry-run', 'var', 'NAME', '--stdin']).stdinValue, undefined);
    assert.equal(isVarStdinRequest(['NAME', '--stdin']), true);
    assert.equal(isVarStdinRequest(['NAME', 'value']), false);
    assert.equal(isVarStdinRequest(['NAME', '--stdin', 'extra']), false);
});

test('the secret reaches the engine on stdin, read before the Box is prepared, and never on argv', async (t) => {
    const state = fixture(t);
    let readBeforePrepare = false;
    const input = Readable.from((async function* source() {
        readBeforePrepare = !state.events.includes('prepare');
        yield Buffer.from(SECRET);
    })());
    assert.equal(await runVar(state, input), 0);
    assert.equal(readBeforePrepare, true);
    assert.equal(state.events[0], 'prepare');
    const [, command, args, options] = state.events[1];
    assert.equal(command, 'podman');
    assert.equal(args.includes('--interactive'), true);
    assert.equal(args.includes('--tty'), false);
    assert.equal(args.some((argument) => String(argument).includes(SECRET)), false);
    assert.deepEqual(args.slice(-3), ['var', 'publication/explorer-qa-api', '--stdin']);
    assert.equal(options.input.toString(), SECRET);
});

test('a terminal or oversized input is refused before any Box preparation', async (t) => {
    const state = fixture(t);
    const terminal = Readable.from([Buffer.from(SECRET)]);
    terminal.isTTY = true;
    await assert.rejects(runVar(state, terminal), /reads piped input, not a terminal/);
    await assert.rejects(runVar(state, Readable.from([Buffer.alloc((1024 * 1024) + 1)])), /accepts at most/);
    assert.deepEqual(state.events, []);
});

test('empty or non-UTF-8 input is refused before any Box preparation', async (t) => {
    const state = fixture(t);
    await assert.rejects(runVar(state, Readable.from([])), /empty value/);
    await assert.rejects(runVar(state, Readable.from([Buffer.from('\n')])), /empty value/);
    await assert.rejects(runVar(state, Readable.from([Buffer.from([0xff, 0xfe])])), /not valid UTF-8/);
    assert.deepEqual(state.events, []);
});

test('a failed input read prints no deployment diagnostic hint', async (t) => {
    const state = fixture(t);
    const errorOutput = bufferStream();
    const terminal = Readable.from([]);
    terminal.isTTY = true;
    await assert.rejects(runOuterCli(['var', 'NAME', '--stdin'], {
        env: {},
        input: terminal,
        output: bufferStream(),
        errorOutput,
        supervisor: state.supervisor,
        cwd: () => state.workspaceRoot,
        detectInsideBox: () => false,
    }), /not a terminal/);
    assert.equal(errorOutput.value(), '');
});

test('the exec arguments forward stdin without a terminal and other routes are unchanged', () => {
    const common = { workspaceRoot: '/work/space', hostPort: 19090, mediaHostPort: 17882 };
    const forwarded = buildContainerExecArgs('a'.repeat(64), ['var', 'N', '--stdin'], { ...common, forwardStdin: true });
    assert.equal(forwarded.includes('--interactive'), true);
    assert.equal(forwarded.includes('--tty'), false);
    assert.equal(buildContainerExecArgs('a'.repeat(64), ['status'], common).includes('--interactive'), false);
});

test('executeProcess uses a stdin pipe only when it was given input', () => {
    const calls = [];
    const spawnSyncImpl = (_command, _args, options) => { calls.push(options); return { status: 0 }; };
    executeProcess('podman', [], { env: {}, spawnSyncImpl });
    executeProcess('podman', [], { env: {}, input: Buffer.from(SECRET), spawnSyncImpl });
    assert.equal(calls[0].stdio, 'inherit');
    assert.equal('input' in calls[0], false);
    assert.deepEqual(calls[1].stdio, ['pipe', 'inherit', 'inherit']);
    assert.equal(calls[1].input.toString(), SECRET);
});

test('the core command rejects bad input before it changes anything', async () => {
    await assert.rejects(handleVarStdinCommand('NAME=value', Readable.from([Buffer.from(SECRET)])), /not an assignment/);
    const terminal = Readable.from([Buffer.from(SECRET)]);
    terminal.isTTY = true;
    await assert.rejects(handleVarStdinCommand('NAME', terminal), /not a terminal/);
    await assert.rejects(handleVarStdinCommand('NAME', Readable.from([])), /empty value/);
    await assert.rejects(handleVarStdinCommand('NAME', Readable.from([Buffer.from('\n')])), /empty value/);
    await assert.rejects(handleVarStdinCommand('NAME', Readable.from([Buffer.from([0xff, 0xfe])])), /not valid UTF-8/);
    await assert.rejects(
        handleVarStdinCommand('NAME', Readable.from([Buffer.alloc((1024 * 1024) + 1, 'a')])),
        /accepts at most/,
    );
});

test('the core command stores the piped value, strips one trailing newline and never prints it', (t) => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-var-core-')));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workspace, '.ploinky'));
    const env = {
        ...process.env,
        PLOINKY_MASTER_KEY: 'a'.repeat(64),
        PLOINKY_WORKSPACE_ROOT: workspace,
    };
    const commands = pathToFileURL(path.join(repoRoot, 'cli/commands/cli.js')).href;
    const secrets = pathToFileURL(path.join(repoRoot, 'cli/utils/security/secretVars.js')).href;
    const set = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const { handleCommand } = await import(${JSON.stringify(commands)});
        await handleCommand(['var', 'publication/explorer-qa-api', '--stdin']);
    `], { cwd: workspace, env, encoding: 'utf8', input: `${SECRET}\n\n` });
    assert.equal(set.status, 0, `${set.stdout}\n${set.stderr}`);
    assert.equal(set.stdout.includes(SECRET), false);
    assert.equal(set.stderr.includes(SECRET), false);
    const read = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const { parseSecrets } = await import(${JSON.stringify(secrets)});
        process.stdout.write(JSON.stringify(parseSecrets()['publication/explorer-qa-api']));
    `], { cwd: workspace, env, encoding: 'utf8' });
    assert.equal(read.status, 0, `${read.stdout}\n${read.stderr}`);
    assert.equal(JSON.parse(read.stdout), `${SECRET}\n`);
});
