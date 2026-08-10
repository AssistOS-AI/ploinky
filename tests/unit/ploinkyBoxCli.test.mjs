import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { buildContainerExecArgs } from '../../ploinky-box/command/execute.mjs';
import {
    BOX_IMAGE_OVERRIDE_ENV,
    BOX_IMAGE_REFERENCE,
    BOX_LABELS,
    resolveBoxImageReference,
} from '../../ploinky-box/constants.mjs';
import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';

function bufferStream(isTTY = false) {
    let value = '';
    return {
        isTTY,
        write(chunk) { value += String(chunk); },
        value: () => value,
    };
}

function execEnvAssignments(args) {
    const values = [];
    for (let index = 0; index < args.length - 1; index += 1) {
        if (args[index] === '--env') values.push(args[index + 1]);
    }
    return values;
}

function fakeSupervisor(events, { statusState = 'absent' } = {}) {
    const prepared = {
        containerId: 'a'.repeat(64),
        engine: { name: 'podman' },
        hostPort: 19090,
        mediaHostPort: 17891,
    };
    const status = {
        state: statusState,
        identity: { instance: 'ploinky-box-workspace-123456789abc' },
        ownership: statusState === 'running-initialized'
            ? {
                state: 'owned',
                engine: prepared.engine,
                handles: {
                    container: {
                        id: prepared.containerId,
                        labels: {
                            [BOX_LABELS.routerHostPort]: String(prepared.hostPort),
                            [BOX_LABELS.mediaHostPort]: String(prepared.mediaHostPort),
                        },
                    },
                },
            }
            : { state: statusState, handles: null },
    };
    return {
        prepareBoxForCommand: async () => { events.push('prepare'); return prepared; },
        runStartTransaction: async (argv, options) => events.push(['start', argv, options]),
        runStopTransaction: async () => events.push('stop'),
        runDestroyTransaction: async (id, options) => {
            events.push(['destroy', id, options]);
            return {
                action: id ? 'destroyed' : 'deleted-cache',
                containerId: id,
                deletedCache: options?.deleteCache === true,
                deletedPaths: options?.deleteCache
                    ? ['/workspace/.ploinky/box/dependencies', '/workspace/.ploinky/box/images']
                    : [],
            };
        },
        inspectBoxStatus: () => { events.push('status'); return status; },
        planDryRun: (options) => { events.push(['dry-run', options]); return { mutationPerformed: false }; },
    };
}

test('the Box image defaults to latest and accepts one environment override', () => {
    const overridden = 'registry.example.test/ploinky-box@sha256:' + 'a'.repeat(64);
    assert.equal(BOX_IMAGE_REFERENCE, 'docker.io/assistos/ploinky-box:latest');
    assert.equal(resolveBoxImageReference({}), BOX_IMAGE_REFERENCE);
    assert.equal(resolveBoxImageReference({ [BOX_IMAGE_OVERRIDE_ENV]: '' }), BOX_IMAGE_REFERENCE);
    assert.equal(
        resolveBoxImageReference({ [BOX_IMAGE_OVERRIDE_ENV]: overridden }),
        overridden,
    );
    assert.throws(
        () => resolveBoxImageReference({ [BOX_IMAGE_OVERRIDE_ENV]: ' invalid ref ' }),
        new RegExp(BOX_IMAGE_OVERRIDE_ENV),
    );
});

test('help, unavailable status, and stop never prepare or invoke current core', async () => {
    for (const argv of [['help'], ['status'], ['--debug', 'stop']]) {
        const events = [];
        const output = bufferStream();
        const code = await runOuterCli(argv, {
            env: {}, output, errorOutput: bufferStream(), input: { isTTY: false },
            supervisor: fakeSupervisor(events),
            execute() { events.push('execute'); return 0; },
        });
        assert.equal(code, 0);
        assert.equal(events.includes('prepare'), false);
        assert.equal(events.includes('execute'), false);
        if (argv.includes('stop')) {
            assert.deepEqual(events, ['stop']);
            assert.equal(output.value().match(/Debug mode enabled/g)?.length, 1);
        }
    }
});

test('running status uses the read-only core renderer without preparing the Box', async () => {
    const events = [];
    const output = bufferStream();
    const code = await runOuterCli(['status'], {
        env: {},
        input: { isTTY: false },
        output,
        errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events, { statusState: 'running-initialized' }),
        execute(command, args) {
            events.push(['execute', command, args]);
            return 0;
        },
    });
    assert.equal(code, 0);
    assert.equal(events.includes('prepare'), false);
    assert.deepEqual(events[0], 'status');
    assert.equal(events[1][1], 'podman');
    assert.deepEqual(events[1][2].slice(-2), [
        '/opt/ploinky/bin/ploinky-local', 'status',
    ]);
    assert.equal(output.value(), '');
});

test('running status propagates only derived terminal color intent without allocating a TTY', async () => {
    const cases = [
        {
            name: 'TTY output with color enabled',
            outputIsTty: true,
            env: {},
            expectedMarkerCount: 1,
        },
        {
            name: 'captured output',
            outputIsTty: false,
            env: {},
            expectedMarkerCount: 0,
        },
        {
            name: 'TTY output with NO_COLOR',
            outputIsTty: true,
            env: { NO_COLOR: '1' },
            expectedMarkerCount: 0,
        },
        {
            name: 'captured output with a host-supplied marker',
            outputIsTty: false,
            env: { PLOINKY_COLOR: '1' },
            expectedMarkerCount: 0,
        },
    ];

    for (const testCase of cases) {
        const events = [];
        const code = await runOuterCli(['status'], {
            env: testCase.env,
            input: { isTTY: true },
            output: bufferStream(testCase.outputIsTty),
            errorOutput: bufferStream(),
            supervisor: fakeSupervisor(events, { statusState: 'running-initialized' }),
            execute(command, args) {
                events.push(['execute', command, args]);
                return 23;
            },
        });

        assert.equal(code, 23, testCase.name);
        assert.deepEqual(events[0], 'status', testCase.name);
        assert.equal(events.includes('prepare'), false, testCase.name);
        assert.equal(events[1][1], 'podman', testCase.name);
        assert.deepEqual(events[1][2].slice(-2), [
            '/opt/ploinky/bin/ploinky-local', 'status',
        ], testCase.name);
        assert.equal(events[1][2].includes('--tty'), false, testCase.name);
        assert.equal(events[1][2].includes('--interactive'), false, testCase.name);
        assert.equal(
            execEnvAssignments(events[1][2]).filter((value) => value === 'PLOINKY_COLOR=1').length,
            testCase.expectedMarkerCount,
            testCase.name,
        );
    }
});

test('running status falls back to the Box summary when the core renderer fails', async () => {
    const events = [];
    const output = bufferStream();
    const code = await runOuterCli(['status'], {
        env: {},
        input: { isTTY: false },
        output,
        errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events, { statusState: 'running-initialized' }),
        execute() { return 17; },
    });
    assert.equal(code, 17);
    assert.match(output.value(), /Ploinky Box: running-initialized/);
});

test('the image marker bypasses outer parsing and dispatches original argv directly', async () => {
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

test('explicit start is reachable and retains normalized debug argv', async () => {
    const events = [];
    const code = await runOuterCli([
        '--debug', '--port', '19090', '--udp-port', '17891', 'start', 'Agent',
    ], {
        env: { PLOINKY_PROD: 'true' },
        input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events),
    });
    assert.equal(code, 0);
    assert.deepEqual(events, [[
        'start',
        ['--debug', 'start', 'Agent', '8080'],
        {
            explicitPort: 19090,
            explicitMediaPort: 17891,
            source: { mode: 'locked' },
        },
    ]]);
});

test('start validates source policy before packing or constructing the supervisor', async () => {
    for (const env of [
        { PLOINKY_PROD: 'TRUE' },
        { PLOINKY_PROD: 'false', PLOINKY_AGENTLIB_REF: 'feature' },
    ]) {
        let packed = false;
        await assert.rejects(() => runOuterCli(['start', 'Agent'], {
            env,
            supervisor: new Proxy({}, {
                get() { throw new Error('supervisor must remain untouched'); },
            }),
            prepareLocalAgentlib() { packed = true; },
        }), /PLOINKY_(?:PROD|AGENTLIB_REF)/);
        assert.equal(packed, false);
    }
});

test('local start packs first, passes one typed snapshot, and always cleans it', async () => {
    const snapshot = {
        sha256: 'd'.repeat(64),
        tempArchivePath: '/private/local-agentlib.tgz',
    };
    for (const failStart of [false, true]) {
        const events = [];
        const supervisor = fakeSupervisor(events);
        if (failStart) {
            supervisor.runStartTransaction = async () => {
                events.push('start-failed');
                throw new Error('start failed');
            };
        }
        const invocation = runOuterCli(['start', 'Agent'], {
            env: {},
            supervisor,
            prepareLocalAgentlib({ repositoryRoot }) {
                assert.ok(path.isAbsolute(repositoryRoot));
                events.push('pack');
                return snapshot;
            },
            cleanupLocalAgentlib(value) {
                assert.equal(value, snapshot);
                events.push('cleanup');
            },
        });
        if (failStart) await assert.rejects(() => invocation, /start failed/);
        else assert.equal(await invocation, 0);
        assert.equal(events[0], 'pack');
        assert.equal(events.at(-1), 'cleanup');
        if (!failStart) {
            assert.deepEqual(events[1], [
                'start',
                ['start', 'Agent', '8080'],
                {
                    explicitPort: null,
                    explicitMediaPort: null,
                    source: { mode: 'local', ...snapshot },
                },
            ]);
        }
    }
});

test('production start never inspects the local checkout and forwards a resolved ref', async () => {
    const events = [];
    const code = await runOuterCli(['start', 'Agent'], {
        env: { PLOINKY_PROD: 'true', PLOINKY_AGENTLIB_REF: 'feature/local-fix' },
        supervisor: fakeSupervisor(events),
        prepareLocalAgentlib() { throw new Error('production must not pack'); },
    });
    assert.equal(code, 0);
    assert.deepEqual(events[0][2].source, {
        mode: 'resolved-ref',
        requestedRef: 'feature/local-fix',
    });
});

test('help and non-start commands ignore source selectors while local dry-run never packs', async () => {
    const invalidEnv = { PLOINKY_PROD: 'invalid', PLOINKY_AGENTLIB_REF: 'ambiguous' };
    assert.equal(await runOuterCli(['help'], {
        env: invalidEnv,
        output: bufferStream(),
        supervisor: new Proxy({}, {
            get() { throw new Error('help must not construct the supervisor'); },
        }),
    }), 0);

    const stopEvents = [];
    assert.equal(await runOuterCli(['stop'], {
        env: invalidEnv,
        supervisor: fakeSupervisor(stopEvents),
    }), 0);
    assert.deepEqual(stopEvents, ['stop']);

    const dryRunEvents = [];
    assert.equal(await runOuterCli(['--dry-run', 'start', 'Agent'], {
        env: {},
        output: bufferStream(),
        supervisor: fakeSupervisor(dryRunEvents),
        prepareLocalAgentlib() { throw new Error('dry-run must not pack'); },
    }), 0);
    assert.deepEqual(dryRunEvents, [[
        'dry-run',
        { explicitPort: null, explicitMediaPort: null, sourceMode: 'local' },
    ]]);
});

test('generic forwarding prepares under the supervisor then execs the fixed target', async () => {
    const events = [];
    const env = {
        PATH: '/bin', HOME: '/tmp', PLOINKY_MASTER_KEY: 'HOST_CANARY',
        UNRELATED_CANARY: 'NOPE',
    };
    const code = await runOuterCli(['list', '--debug', 'agents'], {
        env,
        input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events),
        execute(command, args, options) { events.push(['execute', command, args, options]); return 23; },
    });
    assert.equal(code, 23);
    assert.equal(events[0], 'prepare');
    assert.equal(events[1][1], 'podman');
    assert.deepEqual(events[1][2].slice(-4), [
        '/opt/ploinky/bin/ploinky-local', 'list', '--debug', 'agents',
    ]);
    assert.deepEqual(events[1][2].slice(0, 8), [
        'container', 'exec',
        '--env', 'PLOINKY_ROUTER_HOST_PORT=19090',
        '--env', 'PLOINKY_MEDIA_HOST_PORT=17891',
        '--user', 'podman',
    ]);
    assert.equal(JSON.stringify(events[1][3]).includes('HOST_CANARY'), false);
    assert.equal(JSON.stringify(events[1][3]).includes('UNRELATED_CANARY'), false);
});

test('logs forward into an already running initialized Box without preparing it', async () => {
    const events = [];
    const env = {
        PATH: '/bin', HOME: '/tmp', PLOINKY_MASTER_KEY: 'HOST_CANARY',
        UNRELATED_CANARY: 'NOPE',
    };
    const code = await runOuterCli(['logs', '--debug', 'tail', 'someAgent'], {
        env,
        input: { isTTY: true }, output: bufferStream(true), errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events, { statusState: 'running-initialized' }),
        execute() { throw new Error('the logs route must use the streaming primitive'); },
        executeStreaming(command, args, options) {
            events.push(['stream', command, args, options]);
            return 23;
        },
    });
    // The Core exit code passes through unchanged.
    assert.equal(code, 23);
    assert.deepEqual(events.filter((event) => event === 'prepare'), []);
    assert.deepEqual(events[0], 'status');
    assert.equal(events[1][1], 'podman');
    assert.deepEqual(events[1][2].slice(-5), [
        '/opt/ploinky/bin/ploinky-local', 'logs', '--debug', 'tail', 'someAgent',
    ]);
    // A private interactive stdin pipe carries cancellation EOF; no TTY is allocated.
    assert.equal(events[1][2].includes('--tty'), false);
    assert.equal(events[1][2].includes('--interactive'), true);
    assert.ok(events[1][2].includes('PLOINKY_BOX_LOG_STREAM=1'));
    assert.equal(JSON.stringify(events[1][3]).includes('HOST_CANARY'), false);
    assert.equal(JSON.stringify(events[1][3]).includes('UNRELATED_CANARY'), false);
});

test('logs never create, prepare, or repair a Box in any other state', async () => {
    for (const statusState of [
        'absent', 'stopped', 'running-uninitialized', 'running-transient',
        'foreign', 'incompatible', 'unknown', 'unsupported',
    ]) {
        const events = [];
        const errorOutput = bufferStream();
        const code = await runOuterCli(['logs', 'last', '5'], {
            env: { PATH: '/bin', HOME: '/tmp' },
            input: { isTTY: false }, output: bufferStream(), errorOutput,
            supervisor: fakeSupervisor(events, { statusState }),
            execute() { throw new Error(`logs must not execute in state ${statusState}`); },
            executeStreaming() { throw new Error(`logs must not stream in state ${statusState}`); },
        });
        assert.equal(code, 1, statusState);
        assert.deepEqual(events, ['status'], statusState);
        assert.match(errorOutput.value(), /not running and initialized/);
        assert.match(errorOutput.value(), /never create or repair a Box/);
    }
});

test('full update pulls the host source and relaunches before touching the Box when HEAD changes', async () => {
    const events = [];
    const output = bufferStream();
    const env = { PATH: '/bin', HOME: '/tmp' };
    const code = await runOuterCli(['--debug', 'update', 'all'], {
        env,
        input: { isTTY: false }, output, errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events),
        repositoryRoot: '/source/ploinky',
        async updateHostSource(options) {
            events.push(['host-update', options]);
            return { updated: true };
        },
        relaunch(command, args, options) {
            events.push(['relaunch', command, args, options]);
            return 19;
        },
        execute() { throw new Error('changed host update must not execute stale in-Box code'); },
    });
    assert.equal(code, 19);
    assert.deepEqual(events[0], ['host-update', { repositoryRoot: '/source/ploinky' }]);
    assert.equal(events[1][0], 'relaunch');
    assert.equal(events[1][1], process.execPath);
    assert.deepEqual(events[1][2].slice(-3), ['--debug', 'update', 'all']);
    assert.deepEqual(events[1][3], { env });
    assert.equal(events.includes('prepare'), false);
    assert.match(output.value(), /continuing with the updated CLI/);
});

test('full update refreshes in-Box state then restarts an already configured workspace', async () => {
    const events = [];
    const supervisor = fakeSupervisor(events, { statusState: 'running-initialized' });
    const status = supervisor.inspectBoxStatus;
    supervisor.inspectBoxStatus = () => ({
        ...status(),
        inbox: { routingConfigured: true },
    });
    const output = bufferStream();
    const code = await runOuterCli(['update'], {
        env: {},
        input: { isTTY: false }, output, errorOutput: bufferStream(),
        supervisor,
        repositoryRoot: '/source/ploinky',
        async updateHostSource() {
            events.push('host-update');
            return { updated: false };
        },
        execute(command, args) {
            events.push(['execute', command, args]);
            return 0;
        },
        relaunch() { throw new Error('unchanged host source must not relaunch'); },
    });
    assert.equal(code, 0);
    assert.deepEqual(events.slice(0, 3), ['host-update', 'status', 'prepare']);
    const executions = events.filter((entry) => Array.isArray(entry) && entry[0] === 'execute');
    assert.deepEqual(executions.map((entry) => entry[2].slice(-2)), [
        ['/opt/ploinky/bin/ploinky-local', 'update'],
        ['/opt/ploinky/bin/ploinky-local', 'restart'],
    ]);
    assert.match(output.value(), /restarting the Router and managed agents/);
});

test('full update does not restart an unconfigured workspace or continue after update failure', async () => {
    for (const updateCode of [0, 27]) {
        const events = [];
        const output = bufferStream();
        const code = await runOuterCli(['update', 'all'], {
            env: {},
            input: { isTTY: false }, output, errorOutput: bufferStream(),
            supervisor: fakeSupervisor(events, { statusState: 'absent' }),
            async updateHostSource() { return { updated: false }; },
            execute(command, args) {
                events.push(['execute', command, args]);
                return updateCode;
            },
        });
        assert.equal(code, updateCode);
        assert.equal(events.filter((entry) => Array.isArray(entry) && entry[0] === 'execute').length, 1);
        assert.equal(output.value().includes('restarting the Router'), false);
    }
});

test('targeted update forms retain generic forwarding without a host pull', async () => {
    for (const argv of [['update', 'repos'], ['update', 'repo', 'demo']]) {
        const events = [];
        const code = await runOuterCli(argv, {
            env: {}, input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
            supervisor: fakeSupervisor(events),
            async updateHostSource() { throw new Error('targeted update must not pull host source'); },
            execute(command, args) { events.push(['execute', command, args]); return 0; },
        });
        assert.equal(code, 0);
        assert.equal(events[0], 'prepare');
        assert.deepEqual(events[1][2].slice(-argv.length), argv);
    }
});

test('TTY flags appear only for interactive commands with both terminal ends', async () => {
    assert.deepEqual(buildContainerExecArgs('a'.repeat(64), [], {
        hostPort: 19090,
        mediaHostPort: 17891,
        interactive: true, inputIsTty: true, outputIsTty: true, shell: true,
    }).slice(0, 4), ['container', 'exec', '--interactive', '--tty']);
    assert.equal(buildContainerExecArgs('a'.repeat(64), [], {
        hostPort: 19090,
        mediaHostPort: 17891,
        interactive: true, inputIsTty: false, outputIsTty: true,
    }).includes('--tty'), false);
    const logArgs = buildContainerExecArgs('a'.repeat(64), ['logs', 'tail'], {
        hostPort: 19090,
        mediaHostPort: 17891,
        logStream: true,
        inputIsTty: true,
        outputIsTty: true,
    });
    assert.deepEqual(logArgs.slice(0, 3), ['container', 'exec', '--interactive']);
    assert.equal(logArgs.includes('--tty'), false);
    assert.ok(logArgs.includes('PLOINKY_BOX_LOG_STREAM=1'));
    const colorArgs = buildContainerExecArgs('a'.repeat(64), ['status'], {
        hostPort: 19090,
        mediaHostPort: 17891,
        colorOutput: true,
    });
    assert.equal(
        execEnvAssignments(colorArgs).filter((value) => value === 'PLOINKY_COLOR=1').length,
        1,
    );
    assert.equal(colorArgs.includes('--interactive'), false);
    assert.equal(colorArgs.includes('--tty'), false);

    const events = [];
    await runOuterCli(['cli'], {
        env: {}, input: { isTTY: true }, output: bufferStream(true), errorOutput: bufferStream(true),
        supervisor: fakeSupervisor(events),
        execute(command, args) { events.push([command, args]); return 0; },
    });
    assert.equal(events[1][1].includes('--tty'), true);
    assert.equal(events[1][1].includes('/bin/bash'), true);
});

test('destroy runs without reading input after read-only inspect and before its single lock transaction', async () => {
    const events = [];
    const supervisor = fakeSupervisor(events, { statusState: 'running-initialized' });
    const unreadableInput = new Proxy({}, {
        get() { throw new Error('destroy must not read input'); },
    });
    const code = await runOuterCli(['destroy'], {
        env: {}, input: unreadableInput, output: bufferStream(), errorOutput: bufferStream(),
        supervisor,
    });
    assert.equal(code, 0);
    assert.deepEqual(events, [
        'status',
        ['destroy', 'a'.repeat(64), { deleteCache: false }],
    ]);
});

test('destroy --delete-cache runs without prompting and works without a container', async () => {
    for (const statusState of ['running-initialized', 'absent']) {
        const events = [];
        const output = bufferStream();
        const code = await runOuterCli(['destroy', '--delete-cache'], {
            env: {}, input: { isTTY: false }, output, errorOutput: bufferStream(),
            supervisor: fakeSupervisor(events, { statusState }),
        });
        assert.equal(code, 0);
        assert.deepEqual(events, [
            'status',
            ['destroy', statusState === 'running-initialized' ? 'a'.repeat(64) : null, {
                deleteCache: true,
            }],
        ]);
        assert.match(output.value(), /cache data was deleted/);
        assert.match(output.value(), /\.ploinky\/box\/dependencies/);
        assert.match(output.value(), /\.ploinky\/box\/images/);
        assert.doesNotMatch(output.value(), /named volumes/);
    }
});

test('destroy is an input-free no-op when the outer Box is already absent', async () => {
    const events = [];
    const output = bufferStream();
    const unreadableInput = new Proxy({}, {
        get() { throw new Error('destroy must not read input'); },
    });
    const code = await runOuterCli(['destroy'], {
        env: {}, input: unreadableInput, output, errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events, { statusState: 'absent' }),
    });
    assert.equal(code, 0);
    assert.deepEqual(events, ['status']);
    assert.doesNotMatch(output.value(), /\[y\/N\]|cancelled/i);
    assert.equal(events.some((event) => Array.isArray(event) && event[0] === 'destroy'), false);
});

test('public help documents non-interactive destroy and explicit cache deletion', async () => {
    const output = bufferStream();
    const code = await runOuterCli(['help'], {
        env: {}, input: { isTTY: false }, output, errorOutput: bufferStream(),
        supervisor: new Proxy({}, {
            get() { throw new Error('help must not inspect the supervisor'); },
        }),
    });
    assert.equal(code, 0);
    assert.match(output.value(), /destroy --delete-cache/);
    assert.doesNotMatch(output.value(), /--delete-volumes/);
    assert.match(output.value(), /\.ploinky\/box/);
    assert.match(output.value(), /destroy\s+Remove the outer Box without prompting/);
    assert.match(output.value(), /docker\.io\/assistos\/ploinky-box:latest/);
    assert.match(output.value(), /PLOINKY_BOX_IMAGE/);
    assert.match(output.value(), /editable node_modules\/achillesAgentLib checkout/);
    assert.match(output.value(), /PLOINKY_PROD=true/);
});

test('dry-run and invalid arguments cause no preparation or execution', async () => {
    const events = [];
    await runOuterCli(['--dry-run', '--udp-port', '17891', 'start', 'Agent', '19090'], {
        env: { PLOINKY_PROD: 'true' },
        input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events),
    });
    assert.deepEqual(events, [[
        'dry-run', {
            explicitPort: 19090,
            explicitMediaPort: 17891,
            sourceMode: 'locked',
        },
    ]]);

    await assert.rejects(() => runOuterCli(['--port', '0', 'start', 'Agent'], {
        env: {}, supervisor: fakeSupervisor(events),
    }), /range 1..65535/);
    assert.equal(events.length, 1);
});
