import assert from 'node:assert/strict';
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
        ownership: ['running-initialized', 'absent-retained-volumes'].includes(statusState)
            ? {
                state: 'owned',
                engine: prepared.engine,
                handles: {
                    container: statusState === 'running-initialized' ? {
                        id: prepared.containerId,
                        labels: {
                            [BOX_LABELS.routerHostPort]: String(prepared.hostPort),
                            [BOX_LABELS.mediaHostPort]: String(prepared.mediaHostPort),
                        },
                    } : null,
                    volumes: {},
                },
            }
            : { state: statusState, handles: null },
    };
    return {
        prepareBoxForCommand: async () => { events.push('prepare'); return prepared; },
        runStartTransaction: async (argv, options) => events.push(['start', argv, options]),
        runStopTransaction: async () => events.push('stop'),
        runDestroyTransaction: async (id, options) => events.push(['destroy', id, options]),
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
        env: {}, input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events),
    });
    assert.equal(code, 0);
    assert.deepEqual(events, [[
        'start',
        ['--debug', 'start', 'Agent', '8080'],
        { explicitPort: 19090, explicitMediaPort: 17891 },
    ]]);
});

test('generic forwarding prepares under the supervisor then execs the fixed target', async () => {
    const events = [];
    const env = {
        PATH: '/bin', HOME: '/tmp', PLOINKY_MASTER_KEY: 'HOST_CANARY',
        UNRELATED_CANARY: 'NOPE',
    };
    const code = await runOuterCli(['logs', '--debug', 'tail'], {
        env,
        input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events),
        execute(command, args, options) { events.push(['execute', command, args, options]); return 23; },
    });
    assert.equal(code, 23);
    assert.equal(events[0], 'prepare');
    assert.equal(events[1][1], 'podman');
    assert.deepEqual(events[1][2].slice(-4), [
        '/opt/ploinky/bin/ploinky-local', 'logs', '--debug', 'tail',
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

    const events = [];
    await runOuterCli(['cli'], {
        env: {}, input: { isTTY: true }, output: bufferStream(true), errorOutput: bufferStream(true),
        supervisor: fakeSupervisor(events),
        execute(command, args) { events.push([command, args]); return 0; },
    });
    assert.equal(events[1][1].includes('--tty'), true);
    assert.equal(events[1][1].includes('/bin/bash'), true);
});

test('destroy confirmation occurs after read-only inspect and before its single lock transaction', async () => {
    const events = [];
    const supervisor = fakeSupervisor(events, { statusState: 'running-initialized' });
    const code = await runOuterCli(['destroy'], {
        env: {}, input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
        supervisor,
        confirmDestroy: async () => { events.push('confirm'); return true; },
    });
    assert.equal(code, 0);
    assert.deepEqual(events, [
        'status',
        'confirm',
        ['destroy', 'a'.repeat(64), { deleteVolumes: false }],
    ]);
});

test('destroy --delete-volumes skips confirmation and deletes retained-volume-only state', async () => {
    for (const statusState of ['running-initialized', 'absent-retained-volumes']) {
        const events = [];
        const output = bufferStream();
        const code = await runOuterCli(['destroy', '--delete-volumes'], {
            env: {}, input: { isTTY: false }, output, errorOutput: bufferStream(),
            supervisor: fakeSupervisor(events, { statusState }),
            confirmDestroy: async () => { throw new Error('must not prompt'); },
        });
        assert.equal(code, 0);
        assert.deepEqual(events, [
            'status',
            ['destroy', statusState === 'running-initialized' ? 'a'.repeat(64) : null, {
                deleteVolumes: true,
            }],
        ]);
        assert.match(output.value(), /named volumes were deleted/);
    }
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
    assert.match(output.value(), /docker\.io\/assistos\/ploinky-box:latest/);
    assert.match(output.value(), /PLOINKY_BOX_IMAGE/);
});

test('dry-run and invalid arguments cause no preparation or execution', async () => {
    const events = [];
    await runOuterCli(['--dry-run', '--udp-port', '17891', 'start', 'Agent', '19090'], {
        env: {}, input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events),
    });
    assert.deepEqual(events, [[
        'dry-run', { explicitPort: 19090, explicitMediaPort: 17891 },
    ]]);

    await assert.rejects(() => runOuterCli(['--port', '0', 'start', 'Agent'], {
        env: {}, supervisor: fakeSupervisor(events),
    }), /range 1..65535/);
    assert.equal(events.length, 1);
});
