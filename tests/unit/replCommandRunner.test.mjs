import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
    SIGNAL_EXIT_CODES,
    createForegroundCommandCoordinator,
} from '../../cli/commands/foregroundCommand.js';
import { createReplLifecycleController } from '../../cli/commands/replLifecycle.js';
import { runReplCommand } from '../../cli/sandbox/replCommandRunner.js';

function fakeProcess() {
    const emitter = new EventEmitter();
    return {
        on: (signal, listener) => emitter.on(signal, listener),
        removeListener: (signal, listener) => emitter.removeListener(signal, listener),
        emit: (signal) => emitter.emit(signal),
        listenerCount: (signal) => emitter.listenerCount(signal),
        totalListeners: () => emitter.eventNames()
            .reduce((total, name) => total + emitter.listenerCount(name), 0),
    };
}

function fakeReadline() {
    const prompts = [];
    return {
        prompts,
        setPrompt(value) { prompts.push(['setPrompt', value]); },
        prompt() { prompts.push(['prompt']); },
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

test('a one-shot command returns its exact code and leaves no handlers behind', async () => {
    const processRef = fakeProcess();
    const coordinator = createForegroundCommandCoordinator({ processRef });
    const outcome = await coordinator.run(async () => 23);
    assert.deepEqual(outcome, { code: 23, signal: '' });
    assert.equal(processRef.totalListeners(), 0);
    assert.equal(coordinator.isActive(), false);
});

test('a one-shot SIGINT cancels the command and resolves 130', async () => {
    const processRef = fakeProcess();
    const coordinator = createForegroundCommandCoordinator({ processRef });
    let observedAbort = false;
    const started = deferred();
    const running = coordinator.run(async ({ signal }) => {
        signal.addEventListener('abort', () => { observedAbort = true; });
        started.resolve();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        // A follower that cancels cleanly still returns 0 of its own accord.
        return 0;
    });
    await started.promise;
    assert.equal(processRef.listenerCount('SIGINT'), 1);
    processRef.emit('SIGINT');
    const outcome = await running;
    assert.equal(observedAbort, true);
    assert.deepEqual(outcome, { code: SIGNAL_EXIT_CODES.SIGINT, signal: 'SIGINT' });
    assert.equal(processRef.totalListeners(), 0);
});

test('a one-shot SIGTERM resolves 143', async () => {
    const processRef = fakeProcess();
    const coordinator = createForegroundCommandCoordinator({ processRef });
    const started = deferred();
    const running = coordinator.run(async ({ signal }) => {
        started.resolve();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        return 0;
    });
    await started.promise;
    processRef.emit('SIGTERM');
    assert.deepEqual(await running, { code: SIGNAL_EXIT_CODES.SIGTERM, signal: 'SIGTERM' });
});

test('the first owned terminal event wins a signal-versus-exit race', async () => {
    const processRef = fakeProcess();
    const coordinator = createForegroundCommandCoordinator({ processRef });
    // The command has already returned before the signal arrives, so the
    // signal never reaches an active command and the exact code survives.
    const outcome = await coordinator.run(async () => 7);
    processRef.emit('SIGINT');
    assert.deepEqual(outcome, { code: 7, signal: '' });

    // The reverse order: the signal arrives first and decides the code.
    const started = deferred();
    const running = coordinator.run(async ({ signal }) => {
        started.resolve();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        return 7;
    });
    await started.promise;
    processRef.emit('SIGINT');
    processRef.emit('SIGTERM');
    // Only the first signal is recorded.
    assert.deepEqual(await running, { code: SIGNAL_EXIT_CODES.SIGINT, signal: 'SIGINT' });
});

test('a throwing command still releases its handlers exactly once', async () => {
    const processRef = fakeProcess();
    const coordinator = createForegroundCommandCoordinator({ processRef });
    await assert.rejects(
        coordinator.run(async () => { throw new Error('follower failed'); }),
        /follower failed/,
    );
    assert.equal(processRef.totalListeners(), 0);
    assert.equal(coordinator.isActive(), false);
    // The coordinator is reusable after a failure.
    assert.deepEqual(await coordinator.run(async () => 0), { code: 0, signal: '' });
});

test('only one foreground command may be active at a time', async () => {
    const coordinator = createForegroundCommandCoordinator({ processRef: fakeProcess() });
    const started = deferred();
    const release = deferred();
    const running = coordinator.run(async () => { started.resolve(); await release.promise; return 0; });
    await started.promise;
    await assert.rejects(coordinator.run(async () => 0), /one foreground command may be active/);
    release.resolve();
    await running;
});

test('an idle coordinator ignores a delivered signal', () => {
    const coordinator = createForegroundCommandCoordinator({ processRef: fakeProcess() });
    assert.equal(coordinator.deliver('SIGINT'), false);
    assert.equal(coordinator.currentSignal(), undefined);
});

test('whenIdle resolves only after the active command finished cleaning up', async () => {
    const coordinator = createForegroundCommandCoordinator({ processRef: fakeProcess() });
    const started = deferred();
    const release = deferred();
    const order = [];
    const running = coordinator.run(async () => {
        started.resolve();
        await release.promise;
        order.push('command-cleanup');
        return 0;
    });
    await started.promise;
    const idle = coordinator.whenIdle().then(() => order.push('idle'));
    release.resolve();
    await running;
    await idle;
    assert.deepEqual(order, ['command-cleanup', 'idle']);
});

test('the REPL returns the numeric command result and re-prompts', async () => {
    const rl = fakeReadline();
    const coordinator = createForegroundCommandCoordinator({ processRef: fakeProcess() });
    const code = await runReplCommand({
        args: ['logs', 'last', '5'],
        rl,
        stdin: { isTTY: true },
        coordinator,
        handleCommandImpl: async () => 3,
        getPromptImpl: () => 'ploinky> ',
    });
    assert.equal(code, 3);
    assert.deepEqual(rl.prompts, [['setPrompt', 'ploinky> '], ['prompt']]);
});

test('a non-log REPL command never claims foreground cancellation ownership', async () => {
    const coordinator = createForegroundCommandCoordinator({ processRef: fakeProcess() });
    let activeDuringCommand = null;
    const code = await runReplCommand({
        args: ['start'],
        rl: fakeReadline(),
        stdin: { isTTY: false },
        coordinator,
        handleCommandImpl: async () => {
            activeDuringCommand = coordinator.isActive();
            return 9;
        },
        getPromptImpl: () => 'ploinky> ',
    });
    assert.equal(code, 9);
    assert.equal(activeDuringCommand, false);
    assert.equal(coordinator.deliver('SIGINT'), false);
});

test('a REPL SIGINT cancels the active command, records 130, and returns to the prompt', async () => {
    const processRef = fakeProcess();
    const coordinator = createForegroundCommandCoordinator({ processRef });
    const rl = fakeReadline();
    let exited = false;

    // The REPL owns the process handler and asks the coordinator first.
    processRef.on('SIGINT', () => {
        if (coordinator.deliver('SIGINT')) return;
        exited = true;
    });

    const started = deferred();
    const running = runReplCommand({
        args: ['logs', 'tail'],
        rl,
        stdin: { isTTY: true },
        coordinator,
        handleCommandImpl: async () => {
            started.resolve();
            await new Promise((resolve) => {
                coordinator.currentSignal().addEventListener('abort', resolve, { once: true });
            });
            return 0;
        },
        getPromptImpl: () => 'ploinky> ',
    });
    await started.promise;
    processRef.emit('SIGINT');
    const code = await running;

    assert.equal(code, SIGNAL_EXIT_CODES.SIGINT);
    assert.equal(exited, false, 'an active SIGINT must not exit the REPL');
    assert.deepEqual(rl.prompts, [['setPrompt', 'ploinky> '], ['prompt']]);
    // The coordinator installed no handlers of its own in REPL mode.
    assert.equal(processRef.listenerCount('SIGINT'), 1);
});

test('a REPL SIGTERM exits 143 only after the active command has cleaned up', async () => {
    const processRef = fakeProcess();
    const coordinator = createForegroundCommandCoordinator({ processRef });
    const order = [];
    let exitCode = null;

    processRef.on('SIGTERM', () => {
        if (coordinator.deliver('SIGTERM')) {
            coordinator.whenIdle().then(() => {
                order.push('exit');
                exitCode = SIGNAL_EXIT_CODES.SIGTERM;
            });
            return;
        }
        exitCode = SIGNAL_EXIT_CODES.SIGTERM;
    });

    const started = deferred();
    const running = runReplCommand({
        args: ['logs', 'tail'],
        rl: fakeReadline(),
        stdin: { isTTY: false },
        coordinator,
        handleCommandImpl: async () => {
            started.resolve();
            await new Promise((resolve) => {
                coordinator.currentSignal().addEventListener('abort', resolve, { once: true });
            });
            order.push('command-cleanup');
            return 0;
        },
        getPromptImpl: () => 'ploinky> ',
    });
    await started.promise;
    processRef.emit('SIGTERM');
    assert.equal(await running, SIGNAL_EXIT_CODES.SIGTERM);
    await coordinator.whenIdle();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(exitCode, SIGNAL_EXIT_CODES.SIGTERM);
    assert.deepEqual(order, ['command-cleanup', 'exit']);
});

test('an idle REPL signal falls through to the shutdown path', () => {
    const processRef = fakeProcess();
    const coordinator = createForegroundCommandCoordinator({ processRef });
    let exitCode = null;
    processRef.on('SIGINT', () => {
        if (coordinator.deliver('SIGINT')) return;
        // Intentional shutdown keeps happening, now with the signal-derived code.
        exitCode = SIGNAL_EXIT_CODES.SIGINT;
    });
    processRef.emit('SIGINT');
    assert.equal(exitCode, SIGNAL_EXIT_CODES.SIGINT);
});

test('a REPL command error is reported and surfaces as a nonzero result', async () => {
    const rl = fakeReadline();
    const errors = [];
    const code = await runReplCommand({
        args: ['broken'],
        rl,
        stdin: { isTTY: false },
        handleCommandImpl: async () => { throw new Error('command exploded'); },
        getPromptImpl: () => 'ploinky> ',
        onError: (error) => errors.push(error.message),
    });
    assert.equal(code, 1);
    assert.deepEqual(errors, ['command exploded']);
    // No prompt is written when stdin is not a TTY.
    assert.deepEqual(rl.prompts, [['setPrompt', 'ploinky> ']]);
});

test('a REPL command without a coordinator still returns a numeric result', async () => {
    const code = await runReplCommand({
        args: ['logs', 'last'],
        rl: fakeReadline(),
        stdin: { isTTY: false },
        handleCommandImpl: async () => 5,
        getPromptImpl: () => 'ploinky> ',
    });
    assert.equal(code, 5);

    const nonNumeric = await runReplCommand({
        args: ['other'],
        rl: fakeReadline(),
        stdin: { isTTY: false },
        handleCommandImpl: async () => undefined,
        getPromptImpl: () => 'ploinky> ',
    });
    assert.equal(nonNumeric, 0);
});

test('the REPL lifecycle waits for active log cleanup before SIGTERM exit', async () => {
    const foreground = createForegroundCommandCoordinator({ processRef: fakeProcess() });
    const started = deferred();
    const releaseCleanup = deferred();
    const order = [];
    const running = foreground.run(async ({ signal }) => {
        started.resolve();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        await releaseCleanup.promise;
        order.push('log-cleanup');
        return 0;
    }, { installSignalHandlers: false });
    await started.promise;

    const lifecycle = createReplLifecycleController({
        foreground,
        cleanupSessions: () => order.push('session-cleanup'),
        deregisterInput: () => order.push('deregister'),
        restoreTTY: () => order.push('restore'),
        closeReadline: () => order.push('close'),
        exitProcess: (code) => order.push(`exit:${code}`),
    });
    const shutdown = lifecycle.handleSignal('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, [], 'shutdown must wait for the active follower');
    releaseCleanup.resolve();
    assert.deepEqual(await running, { code: 143, signal: 'SIGTERM' });
    assert.equal(await shutdown, 143);
    assert.deepEqual(order, [
        'log-cleanup', 'session-cleanup', 'deregister', 'restore', 'close', 'exit:143',
    ]);
});

test('a first REPL SIGINT cannot be converted into shutdown by a racing SIGTERM', async () => {
    const foreground = createForegroundCommandCoordinator({ processRef: fakeProcess() });
    const started = deferred();
    const releaseCleanup = deferred();
    const exits = [];
    const running = foreground.run(async ({ signal }) => {
        started.resolve();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        await releaseCleanup.promise;
        return 0;
    }, { installSignalHandlers: false });
    await started.promise;
    const lifecycle = createReplLifecycleController({
        foreground,
        exitProcess: (code) => exits.push(code),
    });

    assert.equal(await lifecycle.handleSignal('SIGINT'), null);
    assert.equal(await lifecycle.handleSignal('SIGTERM'), null);
    assert.equal(lifecycle.isShuttingDown(), false);
    releaseCleanup.resolve();
    assert.deepEqual(await running, { code: 130, signal: 'SIGINT' });
    assert.deepEqual(exits, []);
});

test('exit and EOF-style shutdown cancel once and keep the selected code through close', async () => {
    const foreground = createForegroundCommandCoordinator({ processRef: fakeProcess() });
    const started = deferred();
    const order = [];
    const running = foreground.run(async ({ signal }) => {
        started.resolve();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        order.push('follower-closed');
        return 0;
    }, { installSignalHandlers: false });
    await started.promise;

    let lifecycle;
    lifecycle = createReplLifecycleController({
        foreground,
        cleanupSessions: () => order.push('sessions'),
        closeReadline: () => {
            order.push('readline-close');
            // Mirrors the real readline close event. It must reuse the first
            // shutdown instead of selecting a new exit code or cleaning twice.
            void lifecycle.shutdown(lifecycle.selectedExitCode());
        },
        exitProcess: (code) => order.push(`exit:${code}`),
    });
    const first = lifecycle.shutdown(17);
    const second = lifecycle.shutdown(0);
    assert.equal(first, second);
    await running;
    assert.equal(await first, 17);
    assert.deepEqual(order, ['follower-closed', 'sessions', 'readline-close', 'exit:17']);
});

test('idle and non-log SIGINT preserve clean REPL shutdown while SIGTERM is 143', async () => {
    for (const [signal, expected] of [['SIGINT', 0], ['SIGTERM', 143]]) {
        const foreground = createForegroundCommandCoordinator({ processRef: fakeProcess() });
        const exits = [];
        const lifecycle = createReplLifecycleController({
            foreground,
            exitProcess: (code) => exits.push(code),
        });
        assert.equal(await lifecycle.handleSignal(signal), expected);
        assert.deepEqual(exits, [expected]);
    }
});
