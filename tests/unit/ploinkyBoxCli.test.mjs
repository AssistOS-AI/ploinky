import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';
import { executeBoxCommand } from '../../ploinky-box/command/execute.mjs';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import {
    RELEASE_DESCRIPTOR_SCHEMA,
    REQUIRED_RELEASE_AGENTLIB_SHA,
    createReleaseDescriptor,
    serializeReleaseDescriptor,
} from '../../ploinky-box/contract/release.mjs';

const CONTAINER_ID = 'a'.repeat(64);

function releaseDescriptor(overrides = {}) {
    return createReleaseDescriptor({
        schema: RELEASE_DESCRIPTOR_SCHEMA,
        boxImageId: 'c'.repeat(64),
        boxImageDigest: `sha256:${'d'.repeat(64)}`,
        nodeImageId: 'e'.repeat(64),
        nodeImageDigest: `sha256:${'f'.repeat(64)}`,
        artifactSourceSha: '1'.repeat(40),
        controllerSourceSha: '2'.repeat(40),
        agentlibSha: REQUIRED_RELEASE_AGENTLIB_SHA,
        routerHostPort: 18080,
        mediaHostPort: 17882,
        ...overrides,
    });
}

function bufferStream(isTTY = false) {
    let value = '';
    return {
        isTTY,
        rows: isTTY ? 24 : undefined,
        columns: isTTY ? 80 : undefined,
        write(chunk) { value += String(chunk); },
        value: () => value,
    };
}

function terminalStreams() {
    const input = new EventEmitter();
    input.isTTY = true;
    input.isRaw = false;
    input.rawModes = [];
    input.setRawMode = (enabled) => {
        input.isRaw = enabled;
        input.rawModes.push(enabled);
        return input;
    };
    return {
        input,
        output: bufferStream(true),
        errorOutput: bufferStream(true),
        signals: new EventEmitter(),
    };
}

function fakeSupervisor(events, {
    statusState = 'absent',
    commandExitCode = 0,
    interactiveResult = { exitCode: 0, detached: false },
    interactiveRun = null,
} = {}) {
    const hostClient = { kind: 'structured-test-client' };
    const journal = { phase: 'committed', revision: 7 };
    const prepared = {
        containerId: CONTAINER_ID,
        engine: { name: 'podman' },
        hostClient,
        journal,
        hostPort: 19090,
    };
    const status = {
        state: statusState,
        identity: { instance: 'ploinky-box-workspace-123456789abc' },
        ownership: ['running-initialized', 'absent-retained-volumes'].includes(statusState)
            ? {
                state: 'owned',
                engine: prepared.engine,
                hostClient,
                journal,
                handles: {
                    container: statusState === 'running-initialized' ? {
                        id: CONTAINER_ID,
                        labels: { [BOX_LABELS.routerHostPort]: String(prepared.hostPort) },
                    } : null,
                    volumes: {},
                },
            }
            : { state: statusState, handles: null },
    };
    return {
        async prepareBoxForCommand(options = {}) {
            events.push(Object.keys(options).length > 0 ? ['prepare', options] : 'prepare');
            return prepared;
        },
        async runStartTransaction(argv, options) { events.push(['start', argv, options]); },
        async runStopTransaction() { events.push('stop'); },
        async runDestroyTransaction(id, options) { events.push(['destroy', id, options]); },
        async inspectBoxStatus() { events.push('status'); return status; },
        async planDryRun(options) {
            events.push(['dry-run', options]);
            return { mutationPerformed: false };
        },
        async executeCommand(selected, argv, options = {}) {
            events.push(['execute-command', selected, argv, options]);
            return commandExitCode;
        },
        async executeInteractiveCommand(selected, argv, options = {}) {
            events.push(['execute-interactive', selected, argv, options]);
            if (interactiveRun) return interactiveRun(options);
            options.onSession?.(Object.freeze({
                sessionId: 'b'.repeat(64),
                async resize() {},
            }));
            options.stdout.write('remote stdout');
            return interactiveResult;
        },
    };
}

function invocation(supervisor, overrides = {}) {
    return {
        env: {},
        input: { isTTY: false },
        output: bufferStream(),
        errorOutput: bufferStream(),
        supervisor,
        ...overrides,
    };
}

test('help, unavailable status, and stop avoid preparation and command execution', async () => {
    for (const argv of [['help'], ['status'], ['--debug', 'stop']]) {
        const events = [];
        const output = bufferStream();
        const code = await runOuterCli(argv, invocation(fakeSupervisor(events), { output }));
        assert.equal(code, 0);
        assert.equal(events.some((event) => event === 'prepare'), false);
        assert.equal(events.some((event) => Array.isArray(event)
            && event[0] === 'execute-command'), false);
        if (argv.includes('stop')) {
            assert.deepEqual(events, ['stop']);
            assert.equal(output.value().match(/Debug mode enabled/g)?.length, 1);
        }
    }
});

test('running status uses the supervisor structured command path without preparing', async () => {
    const events = [];
    const output = bufferStream();
    const code = await runOuterCli(['status'], invocation(fakeSupervisor(events, {
        statusState: 'running-initialized',
    }), { output }));

    assert.equal(code, 0);
    assert.equal(events.includes('prepare'), false);
    assert.equal(events[0], 'status');
    assert.deepEqual(events[1][2], ['/opt/ploinky/bin/ploinky-local', 'status']);
    assert.equal(events[1][1].hostClient.kind, 'structured-test-client');
    assert.equal(events[1][1].journal.phase, 'committed');
    assert.equal(output.value(), '');
});

test('running status renders the safe Box summary when the core renderer fails', async () => {
    const events = [];
    const output = bufferStream();
    const code = await runOuterCli(['status'], invocation(fakeSupervisor(events, {
        statusState: 'running-initialized',
        commandExitCode: 17,
    }), { output }));
    assert.equal(code, 17);
    assert.match(output.value(), /Ploinky Box: running-initialized/);
});

test('the image marker bypasses outer parsing and forwards original argv locally', async () => {
    const events = [];
    const argv = ['--image', 'must-be-forwarded', '--debug', 'status'];
    const env = { PATH: '/opt/ploinky/bin:/usr/local/bin:/usr/bin', BOX_VALUE: 'preserved' };
    const code = await runOuterCli(argv, {
        env,
        detectInsideBox: () => true,
        supervisor: new Proxy({}, {
            get() { throw new Error('must not access the outer supervisor'); },
        }),
        execute(command, args, options) {
            events.push([command, args, options]);
            return 17;
        },
    });
    assert.equal(code, 17);
    assert.deepEqual(events, [[
        '/opt/ploinky/bin/ploinky-local',
        argv,
        { env },
    ]]);
});

test('explicit start preserves normalized argv and the exact release descriptor', async () => {
    const descriptor = releaseDescriptor();
    const events = [];
    const code = await runOuterCli([
        '--debug',
        '--local-release-descriptor', serializeReleaseDescriptor(descriptor),
        'start', 'Agent',
    ], invocation(fakeSupervisor(events)));
    assert.equal(code, 0);
    assert.deepEqual(events, [[
        'start',
        ['--debug', 'start', 'Agent', '8080'],
        {
            explicitPort: descriptor.routerHostPort,
            releaseDescriptor: descriptor,
        },
    ]]);
});

test('outer start rejects every independent AgentLib override before mutation', async () => {
    for (const invalid of ['b'.repeat(40), 'main', 'B'.repeat(40), `${'b'.repeat(40)}\nINJECTED=1`]) {
        const events = [];
        await assert.rejects(
            runOuterCli(['start', 'Agent'], invocation(fakeSupervisor(events), {
                env: { PLOINKY_AGENTLIB_REF: invalid },
            })),
            /PLOINKY_AGENTLIB_REF.*not an outer Box override/,
        );
        assert.deepEqual(events, []);
    }
});

test('generic forwarding prepares once and delegates an exact argv to the structured path', async () => {
    const events = [];
    const code = await runOuterCli(['logs', '--debug', 'tail'], invocation(fakeSupervisor(events)));
    assert.equal(code, 0);
    assert.equal(events[0], 'prepare');
    assert.equal(events[1][0], 'execute-command');
    assert.deepEqual(events[1][2], [
        '/opt/ploinky/bin/ploinky-local', 'logs', '--debug', 'tail',
    ]);
    assert.equal(events[1][1].containerId, CONTAINER_ID);
    assert.equal(events[1][1].hostClient.kind, 'structured-test-client');
    assert.deepEqual(events[1][3], { interactive: false });
});

test('bare Ploinky, Box shell, and agent CLI function through streaming TTY sessions', async () => {
    const cases = [
        {
            argv: [],
            expectedArgv: ['/opt/ploinky/bin/ploinky-local'],
            shell: false,
        },
        { argv: ['cli'], expectedArgv: [], shell: true },
        {
            argv: ['cli', 'Agent', '--workdir', 'project', '--', '--provider-flag'],
            expectedArgv: [
                '/opt/ploinky/bin/ploinky-local', 'cli', 'Agent',
                '--workdir', 'project', '--', '--provider-flag',
            ],
            shell: false,
        },
    ];
    for (const scenario of cases) {
        const events = [];
        const terminal = terminalStreams();
        const code = await runOuterCli(scenario.argv, invocation(fakeSupervisor(events), {
            ...terminal,
            signalSource: terminal.signals,
        }));
        assert.equal(code, 0);
        assert.equal(events[0], 'prepare');
        assert.equal(events[1][0], 'execute-interactive');
        assert.deepEqual(events[1][2], scenario.expectedArgv);
        assert.equal(events[1][3].shell, scenario.shell);
        assert.equal(events[1][3].tty, true);
        assert.equal(events[1][3].rows, 24);
        assert.equal(events[1][3].columns, 80);
        assert.equal(events[1][3].detachKeys, 'ctrl-p,ctrl-q');
        assert.equal(events[1][3].stdin, terminal.input);
        assert.equal(events[1][3].stdout, terminal.output);
        assert.equal(terminal.output.value(), 'remote stdout');
        assert.deepEqual(terminal.input.rawModes, [true, false]);
        assert.equal(terminal.signals.eventNames().length, 0);
    }
});

test('interactive direct execution uses exact shell argv and streaming contract', async () => {
    const terminal = terminalStreams();
    const journal = { phase: 'committed' };
    const calls = [];
    const cancellation = new AbortController();
    const result = await executeBoxCommand({
        hostClient: {
            async execContainerInteractive(request) {
                calls.push(request);
                request.onSession(Object.freeze({ async resize() {} }));
                request.stdout.write('hello');
                return { exitCode: 17, detached: false };
            },
        },
        containerId: CONTAINER_ID,
        journal,
        argv: ['ignored'],
        hostPort: 19090,
        stdin: terminal.input,
        stdout: terminal.output,
        stderr: terminal.errorOutput,
        interactive: true,
        shell: true,
        tty: true,
        rows: 24,
        columns: 80,
        signal: cancellation.signal,
        timeoutMs: 1_234,
        inactivityTimeoutMs: 567,
        maxOutputBytes: 9_999,
        onSession() {},
    });
    assert.deepEqual(result, { exitCode: 17, detached: false });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, ['/bin/bash', '-i']);
    assert.equal(calls[0].id, CONTAINER_ID);
    assert.equal(calls[0].journal, journal);
    assert.equal(calls[0].tty, true);
    assert.deepEqual(calls[0].env, { PLOINKY_ROUTER_HOST_PORT: '19090' });
    assert.equal(calls[0].stdin, terminal.input);
    assert.equal(calls[0].signal, cancellation.signal);
    assert.equal(terminal.output.value(), 'hello');
});

test('interactive terminal admission fails before Box preparation or host transport', async () => {
    const events = [];
    await assert.rejects(runOuterCli([], invocation(fakeSupervisor(events))), (error) => (
        error?.code === 'PLOINKY_BOX_TERMINAL_UNAVAILABLE'
        && /TTY stdin\/stdout.*no host CLI fallback/.test(error.message)
    ));
    assert.deepEqual(events, []);

    const terminal = terminalStreams();
    terminal.output.rows = 0;
    await assert.rejects(runOuterCli(['cli'], invocation(fakeSupervisor(events), {
        ...terminal,
        signalSource: terminal.signals,
    })), /row count.*1\.\.65535/);
    assert.deepEqual(events, []);
});

test('SIGWINCH is debounced to the exact live session and raw mode is restored', async () => {
    const events = [];
    const terminal = terminalStreams();
    const resizes = [];
    let settle;
    const supervisor = fakeSupervisor(events, {
        interactiveRun(options) {
            options.onSession(Object.freeze({
                sessionId: 'b'.repeat(64),
                async resize(rows, columns) { resizes.push([rows, columns]); },
            }));
            return new Promise((resolve) => { settle = resolve; });
        },
    });
    const running = runOuterCli([], invocation(supervisor, {
        ...terminal,
        signalSource: terminal.signals,
        resizeDebounceMs: 0,
    }));
    await new Promise((resolve) => setImmediate(resolve));
    terminal.output.rows = 31;
    terminal.output.columns = 101;
    terminal.signals.emit('SIGWINCH');
    terminal.output.rows = 32;
    terminal.output.columns = 102;
    terminal.signals.emit('SIGWINCH');
    await new Promise((resolve) => setTimeout(resolve, 5));
    settle({ exitCode: 0, detached: false });
    assert.equal(await running, 0);
    assert.deepEqual(resizes, [[32, 102]]);
    assert.deepEqual(terminal.input.rawModes, [true, false]);
    assert.equal(terminal.signals.eventNames().length, 0);
});

test('SIGWINCH before exec-session publication is replayed to the exact live session', async () => {
    const events = [];
    const terminal = terminalStreams();
    const resizes = [];
    const supervisor = fakeSupervisor(events, {
        async interactiveRun(options) {
            terminal.output.rows = 40;
            terminal.output.columns = 120;
            terminal.signals.emit('SIGWINCH');
            await new Promise((resolve) => setTimeout(resolve, 2));
            options.onSession(Object.freeze({
                sessionId: 'b'.repeat(64),
                async resize(rows, columns) { resizes.push([rows, columns]); },
            }));
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { exitCode: 0, detached: false };
        },
    });
    const code = await runOuterCli([], invocation(supervisor, {
        ...terminal,
        signalSource: terminal.signals,
        resizeDebounceMs: 0,
    }));
    assert.equal(code, 0);
    assert.deepEqual(resizes, [[40, 120]]);
    assert.deepEqual(terminal.input.rawModes, [true, false]);
    assert.equal(terminal.signals.eventNames().length, 0);
});

test('detach is distinct from process exit and restores the terminal', async () => {
    const events = [];
    const terminal = terminalStreams();
    const code = await runOuterCli(['cli'], invocation(fakeSupervisor(events, {
        interactiveResult: { exitCode: 0, detached: true },
    }), {
        ...terminal,
        signalSource: terminal.signals,
    }));
    assert.equal(code, 0);
    assert.match(terminal.errorOutput.value(), /detached.*exit status is not available/);
    assert.deepEqual(terminal.input.rawModes, [true, false]);
});

test('local signals cancel streaming once, map exit status, and restore raw mode', async () => {
    for (const [name, expectedCode] of Object.entries({
        SIGHUP: 129,
        SIGINT: 130,
        SIGTERM: 143,
    })) {
        const events = [];
        const terminal = terminalStreams();
        let aborts = 0;
        const supervisor = fakeSupervisor(events, {
            interactiveRun(options) {
                options.onSession(Object.freeze({ async resize() {} }));
                return new Promise((resolve, reject) => {
                    options.signal.addEventListener('abort', () => {
                        aborts += 1;
                        reject(options.signal.reason);
                    }, { once: true });
                });
            },
        });
        const running = runOuterCli([], invocation(supervisor, {
            ...terminal,
            signalSource: terminal.signals,
        }));
        await new Promise((resolve) => setImmediate(resolve));
        terminal.signals.emit(name);
        assert.equal(await running, expectedCode);
        assert.equal(aborts, 1);
        assert.deepEqual(terminal.input.rawModes, [true, false]);
        assert.equal(terminal.signals.eventNames().length, 0);
    }
});

test('caller cancellation and transport errors restore terminal state without fallback', async () => {
    for (const scenario of ['caller', 'transport']) {
        const events = [];
        const terminal = terminalStreams();
        const caller = new AbortController();
        const failure = new Error(`${scenario} failed`);
        const supervisor = fakeSupervisor(events, {
            interactiveRun(options) {
                options.onSession(Object.freeze({ async resize() {} }));
                if (scenario === 'transport') throw failure;
                return new Promise((resolve, reject) => {
                    options.signal.addEventListener('abort', () => {
                        reject(options.signal.reason);
                    }, { once: true });
                });
            },
        });
        const running = runOuterCli([], invocation(supervisor, {
            ...terminal,
            signalSource: terminal.signals,
            callerSignal: caller.signal,
        }));
        if (scenario === 'caller') {
            await new Promise((resolve) => setImmediate(resolve));
            caller.abort(failure);
        }
        await assert.rejects(running, failure);
        assert.deepEqual(terminal.input.rawModes, [true, false]);
        assert.equal(terminal.signals.eventNames().length, 0);
        assert.equal(events.some((event) => event?.[0] === 'execute-command'), false);
    }
});

test('caller cancellation wins when a delegated transport races to resolve exit zero', async () => {
    const events = [];
    const terminal = terminalStreams();
    const caller = new AbortController();
    const failure = new Error('caller cancellation must win settlement');
    let observedAbort = false;
    const supervisor = fakeSupervisor(events, {
        interactiveRun(options) {
            options.onSession(Object.freeze({ async resize() {} }));
            return new Promise((resolve) => {
                options.signal.addEventListener('abort', () => {
                    observedAbort = true;
                    resolve({ exitCode: 0, detached: false });
                }, { once: true });
            });
        },
    });
    const running = runOuterCli([], invocation(supervisor, {
        ...terminal,
        signalSource: terminal.signals,
        callerSignal: caller.signal,
    }));
    await new Promise((resolve) => setImmediate(resolve));
    caller.abort(failure);
    await assert.rejects(running, failure);
    assert.equal(observedAbort, true);
    assert.deepEqual(terminal.input.rawModes, [true, false]);
    assert.equal(terminal.signals.eventNames().length, 0);
    assert.equal(events.some((event) => event?.[0] === 'execute-command'), false);
});

test('an already-aborted caller fails before Box preparation or raw-mode entry', async () => {
    const events = [];
    const terminal = terminalStreams();
    const caller = new AbortController();
    caller.abort(new Error('cancelled before invocation'));
    await assert.rejects(runOuterCli([], invocation(fakeSupervisor(events), {
        ...terminal,
        signalSource: terminal.signals,
        callerSignal: caller.signal,
    })), (error) => (
        error?.code === 'PLOINKY_BOX_INTERACTIVE_CANCELLED'
        && /cancelled before preparation/.test(error.message)
    ));
    assert.deepEqual(events, []);
    assert.deepEqual(terminal.input.rawModes, []);
    assert.equal(terminal.signals.eventNames().length, 0);
});

test('caller cancellation during preparation fails before raw mode or streaming', async () => {
    const events = [];
    const terminal = terminalStreams();
    const caller = new AbortController();
    const supervisor = fakeSupervisor(events);
    const prepare = supervisor.prepareBoxForCommand.bind(supervisor);
    let releasePreparation;
    const preparation = new Promise((resolve) => { releasePreparation = resolve; });
    supervisor.prepareBoxForCommand = async (options) => {
        await preparation;
        return prepare(options);
    };
    const running = runOuterCli([], invocation(supervisor, {
        ...terminal,
        signalSource: terminal.signals,
        callerSignal: caller.signal,
    }));
    await new Promise((resolve) => setImmediate(resolve));
    caller.abort(new Error('cancelled during preparation'));
    releasePreparation();
    await assert.rejects(running, (error) => (
        error?.code === 'PLOINKY_BOX_INTERACTIVE_CANCELLED'
        && /cancelled before streaming/.test(error.message)
    ));
    assert.deepEqual(events, ['prepare']);
    assert.deepEqual(terminal.input.rawModes, []);
    assert.equal(events.some((event) => event?.[0] === 'execute-interactive'), false);
    assert.equal(terminal.signals.eventNames().length, 0);
});

test('resize failures cancel only the session and restore raw mode', async () => {
    const events = [];
    const terminal = terminalStreams();
    const supervisor = fakeSupervisor(events, {
        interactiveRun(options) {
            options.onSession(Object.freeze({
                async resize() { throw new Error('resize transport closed'); },
            }));
            return new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => {
                    reject(options.signal.reason);
                }, { once: true });
            });
        },
    });
    const running = runOuterCli([], invocation(supervisor, {
        ...terminal,
        signalSource: terminal.signals,
        resizeDebounceMs: 0,
    }));
    await new Promise((resolve) => setImmediate(resolve));
    terminal.output.rows = 48;
    terminal.output.columns = 160;
    terminal.signals.emit('SIGWINCH');
    await assert.rejects(running, (error) => (
        error?.code === 'PLOINKY_BOX_INTERACTIVE_RESIZE_FAILED'
        && /resize transport closed/.test(error.message)
    ));
    assert.deepEqual(terminal.input.rawModes, [true, false]);
    assert.equal(terminal.signals.eventNames().length, 0);
});

test('raw-mode entry and restoration failures are fail-closed and precisely diagnosed', async () => {
    for (const failurePoint of ['entry', 'restore']) {
        const events = [];
        const terminal = terminalStreams();
        terminal.input.setRawMode = enabled => {
            terminal.input.rawModes.push(enabled);
            if ((failurePoint === 'entry' && enabled)
                || (failurePoint === 'restore' && !enabled)) {
                throw new Error(`${failurePoint} raw mode failed`);
            }
            terminal.input.isRaw = enabled;
            return terminal.input;
        };
        await assert.rejects(runOuterCli([], invocation(fakeSupervisor(events), {
            ...terminal,
            signalSource: terminal.signals,
        })), (error) => {
            if (failurePoint === 'restore') {
                return error?.code === 'PLOINKY_BOX_TERMINAL_RESTORE_FAILED';
            }
            return /entry raw mode failed/.test(error.message);
        });
        assert.deepEqual(terminal.input.rawModes, [true, false]);
        assert.equal(terminal.signals.eventNames().length, 0);
        assert.equal(
            events.some((event) => event?.[0] === 'execute-interactive'),
            failurePoint === 'restore',
        );
    }
});

test('direct command execution is bounded, exact-ID, and forwards only selected output', async () => {
    const calls = [];
    const stdout = bufferStream();
    const stderr = bufferStream();
    const journal = { phase: 'committed' };
    const result = await executeBoxCommand({
        hostClient: {
            async execContainer(request) {
                calls.push(request);
                return { exitCode: 9, stdout: 'safe stdout', stderr: 'safe stderr' };
            },
        },
        containerId: CONTAINER_ID,
        journal,
        argv: ['/opt/ploinky/bin/ploinky-local', 'logs'],
        hostPort: 19090,
        stdout,
        stderr,
        timeoutMs: 1234,
        maxOutputBytes: 5678,
    });
    assert.equal(result.exitCode, 9);
    assert.deepEqual(calls, [{
        id: CONTAINER_ID,
        argv: ['/opt/ploinky/bin/ploinky-local', 'logs'],
        user: 'podman',
        workdir: '/workspace',
        env: { PLOINKY_ROUTER_HOST_PORT: '19090' },
        input: null,
        timeoutMs: 1234,
        maxOutputBytes: 5678,
        journal,
    }]);
    assert.equal(stdout.value(), 'safe stdout');
    assert.equal(stderr.value(), 'safe stderr');

    await assert.rejects(executeBoxCommand({
        hostClient: { async execContainer() {} },
        containerId: 'short-id',
        argv: [],
    }), /full 64-hex/);
    await assert.rejects(executeBoxCommand({
        containerId: CONTAINER_ID,
        argv: [],
    }), /structured Podman host client is unavailable/i);
    for (const invalid of [
        { user: 'root' },
        { workdir: 'relative' },
        { env: { 'BAD=KEY': 'value' } },
    ]) {
        await assert.rejects(executeBoxCommand({
            hostClient: { async execContainer() {} },
            containerId: CONTAINER_ID,
            argv: [],
            ...invalid,
        }), (error) => error?.code === 'PLOINKY_BOX_HOST_CONTROL_INVALID');
    }
});

test('destroy confirmation follows awaited inspection and precedes one transaction', async () => {
    const events = [];
    const supervisor = fakeSupervisor(events, { statusState: 'running-initialized' });
    const code = await runOuterCli(['destroy'], invocation(supervisor, {
        confirmDestroy: async () => { events.push('confirm'); return true; },
    }));
    assert.equal(code, 0);
    assert.deepEqual(events, [
        'status',
        'confirm',
        ['destroy', CONTAINER_ID, { deleteVolumes: false }],
    ]);
});

test('destroy --delete-volumes skips confirmation for retained-volume-only state', async () => {
    for (const statusState of ['running-initialized', 'absent-retained-volumes']) {
        const events = [];
        const output = bufferStream();
        const code = await runOuterCli(['destroy', '--delete-volumes'], invocation(
            fakeSupervisor(events, { statusState }),
            {
                output,
                confirmDestroy: async () => { throw new Error('must not prompt'); },
            },
        ));
        assert.equal(code, 0);
        assert.deepEqual(events, [
            'status',
            ['destroy', statusState === 'running-initialized' ? CONTAINER_ID : null, {
                deleteVolumes: true,
            }],
        ]);
        assert.match(output.value(), /named volumes were deleted/);
    }
});

test('dry-run and invalid arguments perform no preparation or command execution', async () => {
    const events = [];
    await runOuterCli(['--dry-run', 'start', 'Agent', '19090'], invocation(fakeSupervisor(events)));
    assert.deepEqual(events, [['dry-run', { explicitPort: 19090 }]]);

    await assert.rejects(runOuterCli(['--port', '0', 'start', 'Agent'], {
        env: {}, supervisor: fakeSupervisor(events),
    }), /range 1..65535/);
    await assert.rejects(runOuterCli(['cli', 'futureAgent', '--help'], {
        env: {}, supervisor: fakeSupervisor(events),
    }), (error) => error?.code === 'PLOINKY_WORKDIR_REQUIRED');
    assert.equal(events.length, 1);
});

test('dry-run carries the immutable release descriptor without preparing the Box', async () => {
    const events = [];
    const descriptor = releaseDescriptor({
        boxImageId: 'd'.repeat(64),
        routerHostPort: 18081,
        mediaHostPort: 17883,
    });
    await runOuterCli([
        '--dry-run',
        '--local-release-descriptor', serializeReleaseDescriptor(descriptor),
        'start', 'Agent',
    ], invocation(fakeSupervisor(events)));
    assert.deepEqual(events, [['dry-run', {
        explicitPort: descriptor.routerHostPort,
        releaseDescriptor: descriptor,
    }]]);
});

test('public help documents explicit no-prompt volume deletion', async () => {
    const output = bufferStream();
    const code = await runOuterCli(['help'], {
        env: {}, input: { isTTY: false }, output, errorOutput: bufferStream(),
        supervisor: new Proxy({}, {
            get() { throw new Error('help must not inspect the supervisor'); },
        }),
    });
    assert.equal(code, 0);
    assert.match(output.value(), /destroy --delete-volumes/);
    assert.match(output.value(), /without prompting/);
});
