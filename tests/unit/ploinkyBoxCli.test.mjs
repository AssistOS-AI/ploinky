import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

const UPDATE_SCOPE_ROOT = fs.realpathSync.native(process.cwd());

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
        runRestartTransaction: async (argv, options) => events.push(['restart', argv, options]),
        runTargetedRestartTransaction: async (argv) => events.push(['targeted-restart', argv]),
        runUpdateTransaction: async (argv, options) => events.push(['update-transaction', argv, options]),
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

test('running verbose and debug status preserve diagnostic intent without preparing the Box', async () => {
    for (const argv of [['status', '--verbose'], ['--debug', 'status']]) {
        const events = [];
        const output = bufferStream();
        const code = await runOuterCli(argv, {
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
        assert.equal(code, 0, argv.join(' '));
        assert.equal(events.includes('prepare'), false, argv.join(' '));
        assert.deepEqual(events[0], 'status', argv.join(' '));
        assert.deepEqual(events[1][2].slice(-argv.length - 1), [
            '/opt/ploinky/bin/ploinky-local', ...argv,
        ], argv.join(' '));
    }
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
        env: {}, input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events),
    });
    assert.equal(code, 0);
    assert.deepEqual(events, [[
        'start',
        ['--debug', 'start', 'Agent', '8080'],
        {
            explicitPort: 19090,
            explicitMediaPort: 17891,
            branchPolicy: {
                branch: null,
                repoBranches: {},
                fallback: 'default',
                resetRepos: false,
            },
        },
    ]]);
});

test('restart is a supervisor transaction and branch policy is consumed at the outer boundary', async () => {
    for (const argv of [
        [
            'restart', '--branch', 'candidate', '--repo-branch=Agent=agent-candidate',
            '--branch-fallback', 'fail', '--reset-repos',
        ],
        ['restart', '--debug'],
    ]) {
        const events = [];
        const code = await runOuterCli(argv, {
            env: {}, input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
            supervisor: fakeSupervisor(events),
        });
        assert.equal(code, 0);
        if (argv.includes('--branch')) {
            assert.deepEqual(events, [[
                'restart',
                ['restart'],
                {
                    branchPolicy: {
                        branch: 'candidate',
                        repoBranches: { Agent: 'agent-candidate' },
                        fallback: 'fail',
                        resetRepos: true,
                    },
                },
            ]]);
        } else {
            assert.deepEqual(events, [[
                'restart',
                ['restart', '--debug'],
                {
                    branchPolicy: {
                        branch: null,
                        repoBranches: {},
                        fallback: 'default',
                        resetRepos: false,
                    },
                },
            ]]);
        }
    }
});

test('targeted restart preserves the existing Box generation and exact core argv', async () => {
    const events = [];
    const code = await runOuterCli([
        '--debug', 'restart', 'onlyOffice', '--branch', 'candidate', '--reset-repos',
    ], {
        env: {}, input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events),
    });
    assert.equal(code, 0);
    assert.deepEqual(events, [[
        'targeted-restart',
        ['--debug', 'restart', 'onlyOffice'],
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
    assert.deepEqual(events[0], ['host-update', {
        repositoryRoot: '/source/ploinky',
        updateScopeRoot: UPDATE_SCOPE_ROOT,
    }]);
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
    supervisor.runUpdateTransaction = async (argv, options) => {
        events.push(['update-transaction', argv, options]);
        return {
            workspacePloinky: {
                found: true,
                updated: true,
                skipped: false,
                repoPath: '/workspace/ploinky',
                pullStrategy: 'rebase-autostash',
            },
        };
    };
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
        execute() { throw new Error('the supervisor owns the full update transaction'); },
        relaunch() { throw new Error('unchanged host source must not relaunch'); },
    });
    assert.equal(code, 0);
    assert.deepEqual(events, [
        'host-update',
        'status',
        ['update-transaction', ['update'], {
            branchPolicy: {
                branch: null,
                repoBranches: {},
                fallback: 'default',
                resetRepos: false,
            },
            restartAfterUpdate: true,
            updateScopeRoot: UPDATE_SCOPE_ROOT,
        }],
    ]);
    assert.match(output.value(), /Workspace Ploinky checkout at \/workspace\/ploinky is updated/);
    assert.match(output.value(), /git pull --rebase --autostash/);
    assert.match(output.value(), /were restarted coherently/);
});

test('full update does not restart an unconfigured workspace or continue after update failure', async () => {
    const events = [];
    const output = bufferStream();
    const code = await runOuterCli([
        'update', 'all', '--branch=candidate', '--branch-fallback=fail',
    ], {
        env: {},
        input: { isTTY: false }, output, errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events, { statusState: 'absent' }),
        async updateHostSource() { return { updated: false }; },
        execute() { throw new Error('the supervisor owns the full update transaction'); },
    });
    assert.equal(code, 0);
    assert.deepEqual(events, [
        'status',
        ['update-transaction', ['update', 'all'], {
            branchPolicy: {
                branch: 'candidate',
                repoBranches: {},
                fallback: 'fail',
                resetRepos: false,
            },
            restartAfterUpdate: false,
            updateScopeRoot: UPDATE_SCOPE_ROOT,
        }],
    ]);
    assert.match(output.value(), /no configured running workspace required a restart/);

    const failedEvents = [];
    const failedSupervisor = fakeSupervisor(failedEvents, { statusState: 'absent' });
    failedSupervisor.runUpdateTransaction = async () => {
        failedEvents.push('update-failed');
        throw new Error('candidate update failed');
    };
    await assert.rejects(
        runOuterCli(['update'], {
            env: {}, input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
            supervisor: failedSupervisor,
            async updateHostSource() { return { updated: false }; },
        }),
        /candidate update failed/,
    );
    assert.deepEqual(failedEvents, ['status', 'update-failed']);
});

test('full update skips an out-of-scope host checkout and continues the remaining update', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-cli-update-scope-'));
    const scope = path.join(root, 'workspace');
    fs.mkdirSync(scope);
    const events = [];
    const output = bufferStream();
    try {
        const code = await runOuterCli(['update'], {
            env: {},
            cwd: () => scope,
            input: { isTTY: false }, output, errorOutput: bufferStream(),
            supervisor: fakeSupervisor(events, { statusState: 'absent' }),
            repositoryRoot: '/installed/ploinky',
            async updateHostSource(options) {
                events.push(['host-update', options]);
                return {
                    updated: false,
                    skipped: true,
                    repoPath: '/installed/ploinky',
                    reason: 'Ploinky checkout is outside the selected update folder',
                };
            },
        });

        assert.equal(code, 0);
        assert.deepEqual(events[0], ['host-update', {
            repositoryRoot: '/installed/ploinky',
            updateScopeRoot: fs.realpathSync.native(scope),
        }]);
        assert.equal(events[1], 'status');
        assert.equal(events[2][0], 'update-transaction');
        assert.equal(events[2][2].updateScopeRoot, fs.realpathSync.native(scope));
        assert.match(output.value(), /was not updated/);
        assert.match(output.value(), /Update complete/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('update all PATH uses PATH as the Ploinky update folder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-cli-update-path-'));
    const selected = path.join(root, 'selected');
    fs.mkdirSync(selected);
    const events = [];
    try {
        const code = await runOuterCli(['update', 'all', 'selected'], {
            env: {},
            cwd: () => root,
            input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
            supervisor: fakeSupervisor(events, { statusState: 'absent' }),
            async updateHostSource(options) {
                events.push(['host-update', options]);
                return { updated: false, skipped: true, reason: 'outside scope' };
            },
        });
        assert.equal(code, 0);
        assert.equal(events[0][1].updateScopeRoot, fs.realpathSync.native(selected));
        assert.equal(events[2][2].updateScopeRoot, fs.realpathSync.native(selected));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('update PATH uses the documented shorthand update folder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-cli-update-short-path-'));
    const events = [];
    try {
        const code = await runOuterCli(['update', root], {
            env: {},
            input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
            supervisor: fakeSupervisor(events, { statusState: 'absent' }),
            async updateHostSource(options) {
                events.push(['host-update', options]);
                return { updated: false, skipped: true, reason: 'outside scope' };
            },
        });
        assert.equal(code, 0);
        assert.equal(events[0][1].updateScopeRoot, fs.realpathSync.native(root));
        assert.equal(events[2][2].updateScopeRoot, fs.realpathSync.native(root));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
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
    assert.match(output.value(), /ploinky update \[PATH\]/);
    assert.match(output.value(), /ploinky update all \[PATH\]/);
    assert.doesNotMatch(output.value(), /--delete-volumes/);
    assert.match(output.value(), /\.ploinky\/box/);
    assert.match(output.value(), /destroy\s+Remove the outer Box without prompting/);
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
