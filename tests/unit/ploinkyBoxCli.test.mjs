import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContainerExecArgs } from '../../ploinky-box/command/execute.mjs';
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
    };
    const status = {
        state: statusState,
        identity: { instance: 'ploinky-box-workspace-123456789abc' },
        ownership: statusState === 'running-initialized'
            ? { handles: { container: { id: prepared.containerId } } }
            : { state: statusState, handles: null },
    };
    return {
        prepareBoxForCommand: async () => { events.push('prepare'); return prepared; },
        runStartTransaction: async (argv, options) => events.push(['start', argv, options]),
        runStopTransaction: async () => events.push('stop'),
        runDestroyTransaction: async (id) => events.push(['destroy', id]),
        inspectBoxStatus: () => { events.push('status'); return status; },
        planDryRun: (options) => { events.push(['dry-run', options]); return { mutationPerformed: false }; },
    };
}

test('help is local and status/stop never prepare or invoke current core', async () => {
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
    assert.equal(JSON.stringify(events[1][3]).includes('HOST_CANARY'), false);
    assert.equal(JSON.stringify(events[1][3]).includes('UNRELATED_CANARY'), false);
});

test('TTY flags appear only for interactive commands with both terminal ends', async () => {
    assert.deepEqual(buildContainerExecArgs('a'.repeat(64), [], {
        interactive: true, inputIsTty: true, outputIsTty: true, shell: true,
    }).slice(0, 4), ['container', 'exec', '--interactive', '--tty']);
    assert.equal(buildContainerExecArgs('a'.repeat(64), [], {
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
    assert.deepEqual(events, ['status', 'confirm', ['destroy', 'a'.repeat(64)]]);
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
});
