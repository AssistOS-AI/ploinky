import assert from 'node:assert/strict';
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
        write(chunk) { value += String(chunk); },
        value: () => value,
    };
}

function fakeSupervisor(events, { statusState = 'absent', commandExitCode = 0 } = {}) {
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

test('interactive outer routes are safe fail-closed, not functional acceptance, until a direct TTY protocol exists', async () => {
    const events = [];
    await runOuterCli(['cli'], invocation(fakeSupervisor(events), {
        input: { isTTY: true },
        output: bufferStream(true),
        errorOutput: bufferStream(true),
    }));
    assert.equal(events[1][0], 'execute-command');
    assert.deepEqual(events[1][2], []);
    assert.deepEqual(events[1][3], { shell: true, interactive: true });

    await assert.rejects(executeBoxCommand({
        hostClient: {
            async execContainer() { throw new Error('must not reach direct execution'); },
        },
        containerId: CONTAINER_ID,
        journal: { phase: 'committed' },
        argv: [],
        shell: true,
        interactive: true,
    }), /streaming TTY protocol.*no host CLI fallback/);
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
