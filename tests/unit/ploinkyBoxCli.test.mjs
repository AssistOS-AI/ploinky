import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContainerExecArgs } from '../../ploinky-box/command/execute.mjs';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
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
                        labels: { [BOX_LABELS.routerHostPort]: String(prepared.hostPort) },
                    } : null,
                    volumes: {},
                },
            }
            : { state: statusState, handles: null },
    };
    return {
        prepareBoxForCommand: async (options = {}) => {
            events.push(Object.keys(options).length > 0 ? ['prepare', options] : 'prepare');
            return prepared;
        },
        runStartTransaction: async (argv, options) => events.push(['start', argv, options]),
        runStopTransaction: async () => events.push('stop'),
        runDestroyTransaction: async (id, options) => events.push(['destroy', id, options]),
        inspectBoxStatus: () => { events.push('status'); return status; },
        planDryRun: (options) => { events.push(['dry-run', options]); return { mutationPerformed: false }; },
    };
}

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
    const code = await runOuterCli(['--debug', '--port', '19090', 'start', 'Agent'], {
        env: {}, input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events),
    });
    assert.equal(code, 0);
    assert.deepEqual(events, [[
        'start',
        ['--debug', 'start', 'Agent', '8080'],
        { explicitPort: 19090 },
    ]]);
});

test('outer start forwards only a validated immutable AgentLib deploy ref', async () => {
    const agentlibRef = 'b'.repeat(40);
    const events = [];
    const code = await runOuterCli(['start', 'Agent'], {
        env: { PLOINKY_AGENTLIB_REF: agentlibRef },
        input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events),
    });
    assert.equal(code, 0);
    assert.deepEqual(events, [[
        'start',
        ['start', 'Agent', '8080'],
        { explicitPort: null, agentlibRef },
    ]]);

    for (const invalid of ['', 'main', 'B'.repeat(40), `${agentlibRef}\nINJECTED=1`]) {
        if (!invalid) continue;
        const invalidEvents = [];
        await assert.rejects(
            () => runOuterCli(['start', 'Agent'], {
                env: { PLOINKY_AGENTLIB_REF: invalid },
                input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
                supervisor: fakeSupervisor(invalidEvents),
            }),
            /PLOINKY_AGENTLIB_REF.*40 lowercase hexadecimal/,
        );
        assert.deepEqual(invalidEvents, []);
    }
});

test('local immutable admission reaches start and agent CLI preparation as one coupled pair', async () => {
    const imageId = 'c'.repeat(64);
    const prefix = [
        '--local-box-image-id', imageId,
        '--local-media-port', '17882',
    ];
    const startEvents = [];
    await runOuterCli([...prefix, '--port', '18080', 'start', 'Agent'], {
        env: {}, input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
        supervisor: fakeSupervisor(startEvents),
    });
    assert.deepEqual(startEvents, [[
        'start',
        ['start', 'Agent', '8080'],
        {
            explicitPort: 18080,
            localBoxImageId: imageId,
            explicitMediaPort: 17882,
        },
    ]]);

    const cliEvents = [];
    await runOuterCli([...prefix, '--port', '18080', 'cli', 'Agent', '--workdir', '/workspace/project', '--'], {
        env: {}, input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
        supervisor: fakeSupervisor(cliEvents),
        execute() { return 0; },
    });
    assert.deepEqual(cliEvents[0], ['prepare', {
        localBoxImageId: imageId,
        explicitMediaPort: 17882,
        explicitPort: 18080,
    }]);
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
    assert.deepEqual(events[1][2].slice(0, 4), [
        'container', 'exec', '--env', 'PLOINKY_ROUTER_HOST_PORT=19090',
    ]);
    assert.equal(JSON.stringify(events[1][3]).includes('HOST_CANARY'), false);
    assert.equal(JSON.stringify(events[1][3]).includes('UNRELATED_CANARY'), false);
});

test('TTY flags appear only for interactive commands with both terminal ends', async () => {
    assert.deepEqual(buildContainerExecArgs('a'.repeat(64), [], {
        hostPort: 19090,
        interactive: true, inputIsTty: true, outputIsTty: true, shell: true,
    }).slice(0, 4), ['container', 'exec', '--interactive', '--tty']);
    assert.equal(buildContainerExecArgs('a'.repeat(64), [], {
        hostPort: 19090,
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
});

test('dry-run and invalid arguments cause no preparation or execution', async () => {
    const events = [];
    await runOuterCli(['--dry-run', 'start', 'Agent', '19090'], {
        env: {}, input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events),
    });
    assert.deepEqual(events, [['dry-run', { explicitPort: 19090 }]]);

    await assert.rejects(() => runOuterCli(['--port', '0', 'start', 'Agent'], {
        env: {}, supervisor: fakeSupervisor(events),
    }), /range 1..65535/);
    assert.equal(events.length, 1);

    await assert.rejects(() => runOuterCli(['cli', 'futureAgent', '--help'], {
        env: {}, supervisor: fakeSupervisor(events),
    }), error => error?.code === 'PLOINKY_WORKDIR_REQUIRED');
    assert.equal(events.length, 1);
});

test('dry-run carries local immutable admission without preparing the Box', async () => {
    const events = [];
    const imageId = 'd'.repeat(64);
    await runOuterCli([
        '--dry-run',
        '--local-box-image-id', imageId,
        '--local-media-port', '17883',
        '--port', '18081',
        'start', 'Agent',
    ], {
        env: {}, input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events),
    });
    assert.deepEqual(events, [['dry-run', {
        explicitPort: 18081,
        localBoxImageId: imageId,
        explicitMediaPort: 17883,
    }]]);
});
