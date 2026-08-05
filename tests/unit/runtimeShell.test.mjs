import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCliCommand } from '../../cli/commands/cli.js';
import {
    isSuspended,
    registerInterface,
} from '../../cli/commands/inputState.js';
import { runReplCommand } from '../../cli/sandbox/replCommandRunner.js';
import { runOuterRuntimeShell } from '../../cli/sandbox/runtimeShell.js';

test('cli dispatches solely by argument arity', async () => {
    const calls = [];
    const shellCode = await handleCliCommand([], {
        runOuterRuntimeShellImpl: () => {
            calls.push(['outer']);
            return 7;
        },
        runAgentCliImpl: async (...args) => calls.push(['agent', ...args]),
    });
    await handleCliCommand(['explorer', '--workdir', 'project', '--', '--help'], {
        runOuterRuntimeShellImpl: () => calls.push(['wrong']),
        runAgentCliImpl: async (...args) => calls.push(['agent', ...args]),
    });
    assert.equal(shellCode, 7);
    assert.deepEqual(calls, [
        ['outer'],
        ['agent', 'explorer', ['--workdir', 'project', '--', '--help']],
    ]);
});

test('outer shell validates marker before tty and restores around bash', () => {
    const events = [];
    const lines = [];
    const code = runOuterRuntimeShell({
        env: { TOKEN: 'kept' },
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        markerPath: '/marker',
        isManagedRuntimeImpl: value => value === '/marker',
        runtimeName: 'ploinky-box-demo',
        user: 'podman',
        log: line => lines.push(line),
        prepareForExternalCommandImpl: options => {
            events.push(['suspend', options]);
            return () => events.push('restore');
        },
        spawnSyncImpl: (file, args, options) => {
            events.push({ file, args, options });
            return { status: 0 };
        },
    });

    assert.equal(code, 0);
    assert.deepEqual(lines, [
        "[ploinky] Entering outer runtime 'ploinky-box-demo'",
        '[ploinky] user=podman cwd=/workspace; exit returns to the previous prompt',
    ]);
    assert.deepEqual(events[0], ['suspend', { promptOnRestore: false }]);
    assert.deepEqual(events[1], {
        file: '/bin/bash',
        args: [],
        options: { cwd: '/workspace', stdio: 'inherit', env: { TOKEN: 'kept' } },
    });
    assert.equal(events[2], 'restore');
});

test('outer shell rejects direct core execution before checking tty', () => {
    assert.throws(
        () => runOuterRuntimeShell({
            stdin: { isTTY: false },
            stdout: { isTTY: false },
            isManagedRuntimeImpl: () => false,
        }),
        /requires the managed Ploinky runtime/,
    );
});

test('outer shell requires both interactive streams', () => {
    assert.throws(
        () => runOuterRuntimeShell({
            stdin: { isTTY: true },
            stdout: { isTTY: false },
            isManagedRuntimeImpl: () => true,
        }),
        /requires an interactive terminal/,
    );
});

test('outer shell preserves a nonzero bash exit status', () => {
    const code = runOuterRuntimeShell({
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        isManagedRuntimeImpl: () => true,
        prepareForExternalCommandImpl: () => () => {},
        spawnSyncImpl: () => ({ status: 7 }),
        log: () => {},
    });

    assert.equal(code, 7);
});

test('outer shell maps SIGTERM termination to shell exit status 143', () => {
    const code = runOuterRuntimeShell({
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        isManagedRuntimeImpl: () => true,
        prepareForExternalCommandImpl: () => () => {},
        spawnSyncImpl: () => ({ status: null, signal: 'SIGTERM' }),
        log: () => {},
    });

    assert.equal(code, 143);
});

test('repl cli gives bash the tty then restores history and exactly one prompt', async () => {
    const events = [];
    const input = {
        isTTY: true,
        isRaw: true,
        setRawMode(value) {
            events.push(['raw', value]);
            this.isRaw = value;
        },
    };
    const rl = {
        input,
        history: ['status', 'list agents'],
        pause: () => events.push('pause'),
        resume: () => events.push('resume'),
        setPrompt: value => events.push(['setPrompt', value]),
        prompt: () => events.push('prompt'),
    };
    const historyBefore = [...rl.history];
    registerInterface(rl);
    await runReplCommand({
        args: ['cli'],
        rl,
        stdin: input,
        getPromptImpl: () => 'ploinky> ',
        handleCommandImpl: args => handleCliCommand(args.slice(1), {
            runOuterRuntimeShellImpl: () => runOuterRuntimeShell({
                stdin: input,
                stdout: { isTTY: true },
                isManagedRuntimeImpl: () => true,
                runtimeName: 'ploinky-box-demo',
                user: 'podman',
                log: () => {},
                spawnSyncImpl: (file, argv, options) => {
                    assert.equal(isSuspended(), true);
                    events.push(['spawn', file, argv, options.stdio]);
                    return { status: 0 };
                },
            }),
        }),
    });
    assert.deepEqual(rl.history, historyBefore);
    assert.deepEqual(events, [
        'pause',
        ['raw', false],
        ['spawn', '/bin/bash', [], 'inherit'],
        ['raw', true],
        'resume',
        ['setPrompt', 'ploinky> '],
        'prompt',
    ]);
    registerInterface(null);
});
