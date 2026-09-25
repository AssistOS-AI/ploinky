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
import { createMemoryUpdateHostState, createUpdateHostState } from '../../ploinky-box/update/hostState.mjs';
import { UPDATE_HANDOFF_ENV, createRelaunchHandoff } from '../../ploinky-box/update/relaunchHandoff.mjs';

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

// A real selected workspace whose path has characters a shell would reinterpret.
const WORKSPACE_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ploinky box cli ăîș $(id);'-")));
test.after(() => fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true }));

function fakeSupervisor(events, { statusState = 'absent' } = {}) {
    const identity = { instance: 'ploinky-box-workspace-123456789abc', workspaceRoot: WORKSPACE_ROOT };
    const prepared = {
        identity,
        containerId: 'a'.repeat(64),
        engine: { name: 'podman' },
        hostPort: 19090,
        mediaHostPort: 17891,
    };
    const status = {
        state: statusState,
        identity,
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
        resolveWorkspaceIdentity: () => identity,
        prepareBoxForCommand: async () => { events.push('prepare'); return prepared; },
        runStartTransaction: async (argv, options) => events.push(['start', argv, options]),
        runRestartTransaction: async (argv, options) => events.push(['restart', argv, options]),
        runTargetedRestartTransaction: async (argv) => events.push(['targeted-restart', argv]),
        runUpdateTransaction: async (argv, options) => {
            events.push(['update-transaction', argv, options]);
            return { activation: { outcome: 'not-required' } };
        },
        runStopTransaction: async () => events.push('stop'),
        runDestroyTransaction: async (id, options) => {
            events.push(['destroy', id, options]);
            return {
                action: id ? 'destroyed' : 'deleted-cache',
                containerId: id,
                deletedCache: options?.deleteCache === true,
                deletedPaths: options?.deleteCache
                    ? [`${WORKSPACE_ROOT}/.ploinky/box/dependencies`, `${WORKSPACE_ROOT}/.ploinky/box/images`]
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

test('diagnose runs only its host diagnostic runner and preserves clean JSON and failure status', async () => {
    const env = { PATH: '/diagnostic/bin' };
    const output = bufferStream();
    const errorOutput = bufferStream();
    const calls = [];
    const report = { exitCode: 3, checks: [{ id: 'podman', status: 'fail', command: 'podman info' }] };
    const code = await runOuterCli(['--debug', 'diagnose', '--json'], {
        env,
        output,
        errorOutput,
        cwd: () => '/work/selected',
        repositoryRoot: '/work/ploinky-source',
        detectInsideBox: () => false,
        supervisor: new Proxy({}, { get() { throw new Error('diagnose must never consult the supervisor'); } }),
        execute() { throw new Error('diagnose must never execute a core command'); },
        async diagnose(options) {
            calls.push(options);
            options.progress('Checking the deployment runtime');
            return report;
        },
    });
    assert.equal(code, 3);
    assert.deepEqual(JSON.parse(output.value()), report);
    assert.equal(calls.length, 1);
    const { progress, ...request } = calls[0];
    assert.equal(typeof progress, 'function');
    assert.deepEqual(request, {
        env, cwd: '/work/selected', repositoryRoot: '/work/ploinky-source',
        explicitPort: null, explicitMediaPort: null,
    });
    assert.equal(errorOutput.value(), '[diagnose] Checking the deployment runtime\n');
});

test('bare diagnose formats the report with the failing command and its next action', async () => {
    const output = bufferStream();
    const report = {
        workspace: '/work/selected',
        exitCode: 1,
        checks: [{
            id: 'podman', label: 'Podman storage', status: 'fail',
            command: { file: 'podman', args: ['info', '--format', 'json'] },
            exitCode: 125, detail: 'Storage could not be opened.', next: 'Check the storage configuration.',
        }],
    };
    const code = await runOuterCli(['diagnose'], {
        env: {}, output, errorOutput: bufferStream(), detectInsideBox: () => false,
        diagnose: async () => report,
        supervisor: new Proxy({}, { get() { throw new Error('No Box supervisor action is permitted'); } }),
    });
    assert.equal(code, 1);
    assert.match(output.value(), /\[FAIL\] Podman storage/);
    assert.match(output.value(), /Command: podman info --format json/);
    assert.match(output.value(), /Exit: 125/);
    assert.match(output.value(), /Next: Check the storage configuration\./);
});

test('diagnose receives explicitly selected deployment ports without mutation', async () => {
    const calls = [];
    const report = { exitCode: 0, checks: [] };
    const code = await runOuterCli(['--port', '18080', '--udp-port', '17882', 'diagnose', '--json'], {
        env: {},
        output: bufferStream(),
        detectInsideBox: () => false,
        supervisor: new Proxy({}, { get() { throw new Error('diagnose must not prepare a Box'); } }),
        async diagnose(options) { calls.push(options); return report; },
    });
    assert.equal(code, 0);
    assert.equal(calls[0].explicitPort, 18080);
    assert.equal(calls[0].explicitMediaPort, 17882);
});

test('diagnose inside a Box explains the host requirement without forwarding or probing', async () => {
    for (const argv of [
        ['diagnose'], ['--debug', 'diagnose', '--json'], ['--', 'diagnose'],
        ['--port', '18080', '--udp-port', '17882', 'diagnose'],
    ]) {
        const errorOutput = bufferStream();
        const code = await runOuterCli(argv, {
            errorOutput,
            detectInsideBox: () => true,
            cwd() { throw new Error('No workspace lookup is needed inside the Box'); },
            execute() { throw new Error('Do not forward diagnose into the core'); },
            diagnose() { throw new Error('Do not diagnose the wrong host boundary'); },
        });
        assert.equal(code, 1);
        assert.match(errorOutput.value(), /must run on the physical host, outside the Box/);
    }
});

test('repair dispatch preserves JSON and repair status without preparing or forwarding to the Box', async () => {
    for (const dryRun of [false, true]) {
        const env = { PATH: '/repair/bin' };
        const output = bufferStream();
        const errorOutput = bufferStream();
        const calls = [];
        const report = { exitCode: 2, dryRun, actions: [], remaining: { administrator: ['Install Podman'] } };
        const code = await runOuterCli([
            '--debug', '--port', '18080', '--udp-port', '17882', 'repair',
            ...(dryRun ? ['--dry-run'] : []), '--json',
        ], {
            env,
            output,
            errorOutput,
            cwd: () => '/work/selected',
            repositoryRoot: '/work/ploinky-source',
            detectInsideBox: () => false,
            supervisor: new Proxy({}, { get() { throw new Error('repair must not use the lifecycle supervisor'); } }),
            execute() { throw new Error('repair must not forward core or sudo commands'); },
            diagnose() { throw new Error('The repair runner owns any diagnosis'); },
            async repair(options) {
                calls.push(options);
                options.progress('Rechecking remaining issues');
                return report;
            },
        });
        assert.equal(code, 2);
        assert.deepEqual(JSON.parse(output.value()), report);
        assert.equal(calls.length, 1);
        const { progress, ...request } = calls[0];
        assert.equal(typeof progress, 'function');
        assert.deepEqual(request, {
            env, cwd: '/work/selected', repositoryRoot: '/work/ploinky-source',
            explicitPort: 18080, explicitMediaPort: 17882, dryRun,
        });
        assert.equal(errorOutput.value(), '[repair] Rechecking remaining issues\n');
    }
});

test('global repair dry-run reaches the repair planner without a lifecycle dry run', async () => {
    const calls = [];
    const code = await runOuterCli(['--dry-run', 'repair', '--json'], {
        output: bufferStream(),
        detectInsideBox: () => false,
        supervisor: new Proxy({}, { get() { throw new Error('No lifecycle plan is permitted'); } }),
        async repair(options) { calls.push(options); return { exitCode: 0, dryRun: true }; },
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dryRun, true);
});

test('bare repair renders applied user actions and remaining administrator commands', async () => {
    const output = bufferStream();
    const action = { id: 'enable-device-fuse', mode: 'manual', requiresSudo: true, required: true,
        title: 'Enable the host fuse device', instructions: 'Ask an administrator to load the missing module.',
        commands: [{ file: 'sudo', args: ['modprobe', 'fuse'] }] };
    const report = { exitCode: 1, workspace: '/work/selected', dryRun: false,
        outcomes: [{ status: 'applied', title: 'Make the saved binding private', detail: 'Group and other access removed.' }],
        after: { exitCode: 1, checks: [{ id: 'host.device.fuse', label: '/dev/fuse', status: 'fail', detail: 'Device unavailable.' }] },
        remainingActions: [action], sudoRequired: [action] };
    const code = await runOuterCli(['repair'], {
        env: {}, output, errorOutput: bufferStream(), detectInsideBox: () => false,
        supervisor: new Proxy({}, { get() { throw new Error('Repair output must not consult the supervisor'); } }),
        repair: async () => report,
    });
    assert.equal(code, 1);
    assert.match(output.value(), /APPLIED.*no sudo/);
    assert.match(output.value(), /Verification: 1 failed check/);
    assert.match(output.value(), /SUDO REQUIRED/);
    assert.match(output.value(), /Command: sudo modprobe fuse/);
});

test('repair inside a Box explains the host boundary without invoking a repair or core command', async () => {
    for (const argv of [
        ['repair'], ['repair', '--dry-run', '--json'], ['--debug', 'repair'],
        ['--dry-run', 'repair'], ['--', 'repair'],
        ['--port', '18080', '--udp-port', '17882', 'repair'],
    ]) {
        const output = bufferStream();
        const errorOutput = bufferStream();
        const code = await runOuterCli(argv, {
            output,
            errorOutput,
            detectInsideBox: () => true,
            cwd() { throw new Error('No workspace lookup is needed inside the Box'); },
            execute() { throw new Error('Do not forward repair into the core'); },
            repair() { throw new Error('Do not repair the wrong host boundary'); },
        });
        assert.equal(code, 1);
        assert.equal(output.value(), '');
        assert.match(errorOutput.value(), /ploinky repair must run on the physical host, outside the Box/);
    }
});

test('invalid repair options fail before launching its runner or any Box action', async () => {
    for (const argv of [
        ['repair', '--json', '--json'], ['--dry-run', 'repair', '--dry-run'],
        ['repair', '--sudo'], ['repair', '--port', '8080'],
    ]) {
        await assert.rejects(runOuterCli(argv, {
            output: bufferStream(), errorOutput: bufferStream(), detectInsideBox: () => false,
            supervisor: new Proxy({}, { get() { throw new Error('Invalid arguments must not consult the supervisor'); } }),
            repair() { throw new Error('Invalid arguments must not invoke repair'); },
            execute() { throw new Error('Invalid arguments must not execute commands'); },
        }), { code: 'PLOINKY_BOX_ARGUMENT_INVALID' });
    }
});

test('repair runner failures propagate without repeating a deployment hint or applying fallback repairs', async () => {
    const errorOutput = bufferStream();
    const failure = new Error('fixture repair failure');
    await assert.rejects(runOuterCli(['repair'], {
        output: bufferStream(), errorOutput, detectInsideBox: () => false,
        repair() { throw failure; },
        execute() { throw new Error('Failed repairs must not execute a fallback command'); },
    }), error => error === failure);
    assert.equal(errorOutput.value(), '');
});

test('deployment lifecycle failures suggest explicit diagnosis once without swallowing the error', async () => {
    for (const [argv, method] of [
        [['start', 'Agent'], 'runStartTransaction'],
        [['restart'], 'runRestartTransaction'],
        [['restart', 'Agent'], 'runTargetedRestartTransaction'],
        [['bind'], 'runBindTransaction'],
        [['update'], 'runUpdateTransaction'],
        [['cli'], 'prepareBoxForCommand'],
        [[], 'prepareBoxForCommand'],
    ]) {
        const failure = new Error('fixture deployment failed');
        const errorOutput = bufferStream();
        const supervisor = fakeSupervisor([]);
        supervisor[method] = async () => { throw failure; };
        await assert.rejects(runOuterCli(argv, {
            cwd: () => supervisor.resolveWorkspaceIdentity().workspaceRoot,
            env: {},
            input: {},
            output: bufferStream(),
            errorOutput,
            supervisor,
            detectInsideBox: () => false,
            updateHostSource: async () => ({ updated: false }),
            diagnose() { throw new Error('Failures must never run diagnosis automatically'); },
            repair() { throw new Error('Failures must never apply repairs automatically'); },
        }), error => error === failure);
        assert.equal(errorOutput.value(),
            'Run ploinky diagnose from this workspace for prerequisite, storage, and security-profile diagnostics.\n');
    }
});

test('a busy workspace lock does not suggest diagnosis; other lock failures still do', async () => {
    for (const [failure, hint] of [
        [{ message: 'Timed out waiting for mutation lock', workspaceTransactionStarted: false, lockBusy: true }, ''],
        [{ message: 'Lock path component is not owned by the current user', workspaceTransactionStarted: false },
            'Run ploinky diagnose from this workspace for prerequisite, storage, and security-profile diagnostics.\n'],
    ]) {
        const thrown = Object.assign(new Error(failure.message), failure);
        const errorOutput = bufferStream();
        const supervisor = fakeSupervisor([]);
        supervisor.runUpdateTransaction = async () => { throw thrown; };
        await assert.rejects(runOuterCli(['update'], {
            cwd: () => supervisor.resolveWorkspaceIdentity().workspaceRoot,
            env: {},
            input: {},
            output: bufferStream(),
            errorOutput,
            supervisor,
            detectInsideBox: () => false,
            updateHostSource: async () => ({ updated: false }),
        }), error => error === thrown);
        assert.equal(errorOutput.value(), hint, failure.message);
    }
});

test('nonzero prepared execution keeps its exit code and suggests diagnosis only on failure', async () => {
    for (const status of [0, 17]) {
        for (const argv of [['cli'], ['cli', 'Agent'], ['list', 'agents']]) {
            const errorOutput = bufferStream();
            const code = await runOuterCli(argv, {
                env: {}, input: {}, output: bufferStream(), errorOutput, cwd: () => WORKSPACE_ROOT,
                supervisor: fakeSupervisor([]), detectInsideBox: () => false,
                execute: () => status,
                diagnose() { throw new Error('Prepared commands must never run diagnosis automatically'); },
            });
            assert.equal(code, status);
            assert.equal((errorOutput.value().match(/Run ploinky diagnose/g) || []).length, status ? 1 : 0);
        }
    }
});

test('inspection, shutdown, and diagnostic failures do not suggest deployment diagnosis', async () => {
    for (const [argv, method] of [
        [['status'], 'inspectBoxStatus'],
        [['logs'], 'inspectBoxStatus'],
        [['--dry-run', 'start', 'Agent'], 'planDryRun'],
        [['stop'], 'runStopTransaction'],
        [['destroy'], 'runDestroyTransaction'],
    ]) {
        const errorOutput = bufferStream();
        const failure = new Error('fixture observation failure');
        const supervisor = fakeSupervisor([]);
        supervisor[method] = () => { throw failure; };
        await assert.rejects(runOuterCli(argv, {
            env: {}, input: {}, output: bufferStream(), errorOutput,
            supervisor, detectInsideBox: () => false,
        }), error => error === failure);
        assert.equal(errorOutput.value(), '');
    }
    const errorOutput = bufferStream();
    const failure = new Error('diagnostic runner failed');
    await assert.rejects(runOuterCli(['diagnose'], {
        output: bufferStream(), errorOutput, detectInsideBox: () => false,
        diagnose() { throw failure; },
    }), error => error === failure);
    assert.equal(errorOutput.value(), '');
});

test('updated CLI owns the single failure hint after relaunch', async () => {
    const errorOutput = bufferStream();
    const code = await runOuterCli(['update'], {
        env: {}, input: {}, output: bufferStream(), errorOutput,
        cwd: () => WORKSPACE_ROOT,
        supervisor: fakeSupervisor([]), detectInsideBox: () => false,
        updateHostState: createMemoryUpdateHostState(),
        updateHostSource: async () => ({ updated: true, before: 'a'.repeat(40), after: 'b'.repeat(40) }),
        relaunch() { errorOutput.write('Run ploinky diagnose from the updated CLI.\n'); return 23; },
    });
    assert.equal(code, 23);
    assert.equal(errorOutput.value(), 'Run ploinky diagnose from the updated CLI.\n');
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
    assert.equal(events[1][2][events[1][2].indexOf('--workdir') + 1], WORKSPACE_ROOT);
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
        cwd: () => WORKSPACE_ROOT,
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
    assert.deepEqual(events[1][2].slice(0, 6), [
        'container', 'exec',
        '--env', 'PLOINKY_ROUTER_HOST_PORT=19090',
        '--env', 'PLOINKY_MEDIA_HOST_PORT=17891',
    ]);
    const user = events[1][2].indexOf('--user');
    assert.deepEqual(events[1][2].slice(user, user + 5), [
        '--user', 'podman', '--workdir', WORKSPACE_ROOT, 'a'.repeat(64),
    ]);
    assert.equal(JSON.stringify(events[1][3]).includes('HOST_CANARY'), false);
    assert.equal(JSON.stringify(events[1][3]).includes('UNRELATED_CANARY'), false);
    // The launch scope is the selected host path itself inside the Box.
    assert.equal(execEnvAssignments(events[1][2]).includes(`PLOINKY_SKILL_SCOPE=${WORKSPACE_ROOT}`), true);
    assert.equal(execEnvAssignments(events[1][2]).includes(`PLOINKY_HOST_LAUNCH_CWD=${WORKSPACE_ROOT}`), true);
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

const DEFAULT_BRANCH_POLICY = Object.freeze({
    branch: null,
    repoBranches: {},
    fallback: 'default',
    resetRepos: false,
});

function hostUpdateRevisions(extra = {}) {
    return { updated: true, repoPath: '/source/ploinky', before: 'a'.repeat(40), after: 'b'.repeat(40), ...extra };
}

test('full update pulls the host source and relaunches with a validated handoff before touching the Box', async () => {
    const events = [];
    const output = bufferStream();
    const env = { PATH: '/bin', HOME: '/tmp' };
    const store = createMemoryUpdateHostState();
    let childEnv;
    const code = await runOuterCli(['--debug', 'update', 'all'], {
        env,
        cwd: () => WORKSPACE_ROOT,
        input: { isTTY: false }, output, errorOutput: bufferStream(),
        supervisor: fakeSupervisor(events),
        repositoryRoot: '/source/ploinky',
        updateHostState: store,
        async updateHostSource(options) {
            events.push(['host-update', options]);
            return hostUpdateRevisions();
        },
        relaunch(command, args, options) {
            events.push(['relaunch', command, args]);
            childEnv = options.env;
            // The pending record exists while the child runs.
            assert.equal(store.list('update-handoffs').length, 1);
            return 19;
        },
        execute() { throw new Error('changed host update must not execute stale in-Box code'); },
    });
    assert.equal(code, 19);
    assert.deepEqual(events[0], ['host-update', {
        repositoryRoot: '/source/ploinky',
        updateScopeRoot: WORKSPACE_ROOT,
    }]);
    assert.equal(events[1][0], 'relaunch');
    assert.equal(events[1][1], process.execPath);
    assert.deepEqual(events[1][2].slice(-3), ['--debug', 'update', 'all']);
    assert.equal(events.length, 2, 'the parent runs no Box preparation or update transaction');
    // Only an opaque id and token cross the process boundary.
    assert.deepEqual(Object.keys(childEnv).sort(), ['HOME', 'PATH', UPDATE_HANDOFF_ENV].sort());
    assert.match(childEnv[UPDATE_HANDOFF_ENV], /^[0-9a-f]{32}:[0-9a-f]{64}$/);
    // The child failed without consuming the record: the parent removes it and
    // reports the host outcome itself.
    assert.deepEqual(store.list('update-handoffs'), []);
    assert.match(output.value(), /continuing with the updated CLI/);
    assert.match(output.value(), /did not accept the relaunch handoff/);
    assert.match(output.value(), /updated CLI exited with status 19.*remains updated \(aaaaaaaaaaaa -> bbbbbbbbbbbb\)/);
});

test('a relaunched child consumes the handoff once, skips the host pull and reports the first pull', async () => {
    const store = createMemoryUpdateHostState();
    const parentEvents = [];
    const childEvents = [];
    const childOutput = bufferStream();
    const results = [];
    let childStatus;
    const argv = ['update'];
    const parentOutput = bufferStream();
    const code = await runOuterCli(argv, {
        env: { PATH: '/bin' },
        cwd: () => WORKSPACE_ROOT,
        input: { isTTY: false }, output: parentOutput, errorOutput: bufferStream(),
        supervisor: fakeSupervisor(parentEvents),
        repositoryRoot: '/source/ploinky',
        updateHostState: store,
        updateHostSource: async () => hostUpdateRevisions(),
        async relaunch(_command, args, { env }) {
            childStatus = await runOuterCli(args.slice(1), {
                env,
                cwd: () => WORKSPACE_ROOT,
                input: { isTTY: false }, output: childOutput, errorOutput: bufferStream(),
                supervisor: fakeSupervisor(childEvents),
                repositoryRoot: '/source/ploinky',
                updateHostState: store,
                handoffParentPid: process.pid,
                onUpdateResult: result => results.push(result),
                updateHostSource: async () => { throw new Error('the child must not pull the host checkout again'); },
                relaunch() { throw new Error('the child must never relaunch again'); },
            });
            return childStatus;
        },
    });
    assert.equal(code, 0);
    assert.equal(childStatus, 0);
    assert.deepEqual(parentEvents, []);
    assert.equal(childEvents.length, 1);
    assert.equal(childEvents[0][0], 'update-transaction');
    assert.match(childOutput.value(), /was updated from aaaaaaaaaaaa to bbbbbbbbbbbb before this relaunch/);
    assert.doesNotMatch(childOutput.value(), /already up to date/);
    assert.deepEqual(results[0].host, {
        outcome: 'changed', repoPath: '/source/ploinky', before: 'a'.repeat(40), after: 'b'.repeat(40), relaunched: true,
    });
    assert.deepEqual(store.list('update-handoffs'), [], 'the record was consumed exactly once');
    assert.doesNotMatch(parentOutput.value(), /did not accept the relaunch handoff/);
});

test('tampered, replayed, stale, foreign and mismatched handoffs are refused before any update work', async () => {
    const identity = { instance: 'ploinky-box-workspace-123456789abc', workspaceRoot: WORKSPACE_ROOT };
    const request = { kind: 'all', folder: null, folderPath: null };
    function pending(store, overrides = {}) {
        return createRelaunchHandoff({
            store,
            argv: ['update'],
            request,
            identity,
            scopeRoot: WORKSPACE_ROOT,
            host: hostUpdateRevisions(),
            parentPid: process.pid,
            ...overrides,
        });
    }
    function child(store, value, { argv = ['update'], parentPid = process.pid, now } = {}) {
        const events = [];
        const promise = runOuterCli(argv, {
            env: { [UPDATE_HANDOFF_ENV]: value },
            cwd: () => WORKSPACE_ROOT,
            input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
            supervisor: fakeSupervisor(events),
            updateHostState: store,
            handoffParentPid: parentPid,
            ...(now ? { handoffNow: now } : {}),
            async updateHostSource() { events.push('host-update'); return { updated: false }; },
            relaunch() { events.push('relaunch'); return 0; },
        });
        return { promise, events };
    }
    const refused = { code: 'PLOINKY_BOX_UPDATE_HANDOFF_INVALID' };
    const cases = [
        ['tampered token', store => child(store, `${pending(store).operationId}:${'0'.repeat(64)}`)],
        ['malformed value', store => { pending(store); return child(store, 'not-a-handoff'); }],
        ['stale record', store => child(store, pending(store).envValue, {
            now: () => new Date(Date.now() + 11 * 60 * 1000),
        })],
        ['foreign parent', store => child(store, pending(store).envValue, { parentPid: process.pid + 100_000 })],
        ['changed request', store => child(store, pending(store).envValue, { argv: ['update', 'repos'] })],
        ['other workspace', store => child(store, pending(store, {
            identity: { ...identity, instance: 'ploinky-box-other-123456789abc' },
        }).envValue)],
        ['other folder', store => child(store, pending(store, { scopeRoot: path.dirname(WORKSPACE_ROOT) }).envValue)],
    ];
    for (const [name, run] of cases) {
        const store = createMemoryUpdateHostState();
        const { promise, events } = run(store);
        await assert.rejects(promise, refused, name);
        assert.deepEqual(events, [], `${name}: no self-update, Box, or supervisor work`);
    }

    // Replay: the first child consumes the record; the same value is refused after.
    const store = createMemoryUpdateHostState();
    const handoff = pending(store);
    const first = child(store, handoff.envValue);
    assert.equal(await first.promise, 0);
    assert.equal(first.events.length, 1);
    const replay = child(store, handoff.envValue);
    await assert.rejects(replay.promise, refused);
    assert.deepEqual(replay.events, []);

    // A forged record without a matching token hash is refused as well.
    const forgedStore = createMemoryUpdateHostState();
    const forged = pending(forgedStore);
    const record = forgedStore.read('update-handoffs', forged.operationId);
    record.tokenHash = 'f'.repeat(64);
    forgedStore.write('update-handoffs', forged.operationId, record);
    const forgedChild = child(forgedStore, forged.envValue);
    await assert.rejects(forgedChild.promise, refused);
    assert.deepEqual(forgedChild.events, []);
});

test('durable handoff records are private host state files consumed by atomic rename', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-cli-handoff-home-'));
    try {
        const store = createUpdateHostState({ stateRoot: path.join(home, '.ploinky-box') });
        const identity = { instance: 'ploinky-box-workspace-123456789abc', workspaceRoot: WORKSPACE_ROOT };
        const handoff = createRelaunchHandoff({
            store, argv: ['update'], request: { kind: 'all', folder: null, folderPath: null }, identity,
            scopeRoot: WORKSPACE_ROOT, host: hostUpdateRevisions(), parentPid: process.pid,
        });
        const file = path.join(home, '.ploinky-box', 'update-handoffs', `${handoff.operationId}.json`);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(JSON.stringify(saved).includes(handoff.envValue.split(':')[1]), false, 'the token itself is never stored');
        const code = await runOuterCli(['update'], {
            env: { [UPDATE_HANDOFF_ENV]: handoff.envValue },
            cwd: () => WORKSPACE_ROOT,
            input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
            supervisor: fakeSupervisor([]),
            updateHostState: store,
            handoffParentPid: process.pid,
            async updateHostSource() { throw new Error('no host pull after a valid handoff'); },
        });
        assert.equal(code, 0);
        assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('full update samples activation under the transaction lock and reports its actual outcome', async () => {
    for (const [outcome, wording] of [
        ['restarted', /workspace graph was restarted and the Router health check passed/],
        ['not-required', /no configured running workspace required a restart/],
    ]) {
        const events = [];
        const supervisor = fakeSupervisor(events, { statusState: 'running-initialized' });
        supervisor.runUpdateTransaction = async (argv, { hostRecords, ...options }) => {
            assert.deepEqual(hostRecords.map(record => [record.phase, record.outcome]), [['host-ploinky', 'unchanged']]);
            events.push(['update-transaction', argv, options]);
            return {
                activation: { outcome },
                workspacePloinky: {
                    found: true,
                    updated: true,
                    skipped: false,
                    repoPath: '/home/user/workspace/ploinky',
                    pullStrategy: 'fast-forward-only',
                },
            };
        };
        const output = bufferStream();
        const code = await runOuterCli(['update'], {
            env: {},
            cwd: () => WORKSPACE_ROOT,
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
        // No status is sampled before the transaction; it decides under its lock.
        assert.deepEqual(events, [
            'host-update',
            ['update-transaction', ['update'], {
                request: { kind: 'all', folder: null, folderPath: null },
                scope: null,
                debug: false,
                branchPolicy: DEFAULT_BRANCH_POLICY,
                branchPolicyArgs: [],
                updateScopeRoot: WORKSPACE_ROOT,
            }],
        ]);
        assert.match(output.value(), /Workspace Ploinky checkout at \/home\/user\/workspace\/ploinky is updated/);
        assert.match(output.value(), /is updated \(verified fast-forward only\)/);
        assert.match(output.value(), wording);
        assert.doesNotMatch(output.value(), /restarted coherently/);
    }
});

test('update failure wording follows the transaction activation outcome', async () => {
    for (const [activation, wording] of [
        [{ outcome: 'preserved' }, /left as it was/],
        [{ outcome: 'restored' }, /reconstruction of the previous Box and graph configuration was attempted and passed/],
        [{ outcome: 'recovery-required' }, /recover it from this workspace with `ploinky stop`, then `ploinky start`/],
        [undefined, /activation outcome could not be determined/],
        // The workspace lock was never acquired: nothing in the workspace started.
        ['lock-not-acquired', /Update did not start in this workspace: its mutation lock could not be acquired/],
    ]) {
        const events = [];
        const supervisor = fakeSupervisor(events, { statusState: 'absent' });
        supervisor.runUpdateTransaction = async () => {
            events.push('update-failed');
            throw Object.assign(new Error('candidate update failed'), activation === 'lock-not-acquired'
                ? { workspaceTransactionStarted: false } : activation ? { activation } : {});
        };
        const output = bufferStream();
        await assert.rejects(
            runOuterCli(['update', 'all', '--branch=candidate', '--branch-fallback=fail'], {
                env: {}, cwd: () => WORKSPACE_ROOT,
                input: { isTTY: false }, output, errorOutput: bufferStream(),
                supervisor,
                async updateHostSource() { return { updated: false }; },
            }),
            /candidate update failed/,
        );
        assert.deepEqual(events, ['update-failed']);
        assert.match(output.value(), wording);
        assert.doesNotMatch(output.value(), /Update complete/);
    }
});

test('branch policy is consumed at the host boundary for the full form', async () => {
    const events = [];
    const supervisor = fakeSupervisor(events, { statusState: 'absent' });
    supervisor.runUpdateTransaction = async (argv, { hostRecords: _hostRecords, ...options }) => {
        events.push(['update-transaction', argv, options]);
        return { activation: { outcome: 'not-required' } };
    };
    const code = await runOuterCli(['update', 'all', '--branch=candidate', '--branch-fallback=fail'], {
        env: {}, cwd: () => WORKSPACE_ROOT,
        input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
        supervisor,
        async updateHostSource() { return { updated: false }; },
    });
    assert.equal(code, 0);
    assert.deepEqual(events, [
        ['update-transaction', ['update', 'all'], {
            request: { kind: 'all', folder: null, folderPath: null },
            scope: null,
            debug: false,
            branchPolicy: { ...DEFAULT_BRANCH_POLICY, branch: 'candidate', fallback: 'fail' },
            branchPolicyArgs: ['--branch=candidate', '--branch-fallback=fail'],
            updateScopeRoot: WORKSPACE_ROOT,
        }],
    ]);
});

test('full update skips an out-of-scope host checkout and continues the remaining update', async () => {
    const scope = fs.mkdtempSync(path.join(WORKSPACE_ROOT, 'scope-'));
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
        assert.equal(events[1][0], 'update-transaction');
        assert.equal(events[1][2].updateScopeRoot, fs.realpathSync.native(scope));
        assert.match(output.value(), /was not updated/);
        assert.match(output.value(), /Update complete/);
    } finally {
        fs.rmSync(scope, { recursive: true, force: true });
    }
});

test('folder forms resolve canonical workspace scope for relative, nested, absolute and alias spellings', async () => {
    const base = fs.mkdtempSync(path.join(WORKSPACE_ROOT, 'folders-'));
    const nested = path.join(base, 'projects', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    const alias = path.join(os.tmpdir(), `ploinky-cli-alias-${process.pid}-${Date.now()}`);
    fs.symlinkSync(nested, alias, 'dir');
    try {
        const relativeBase = path.relative(WORKSPACE_ROOT, base);
        for (const [argv, cwdPath, folderPath] of [
            [['update'], nested, nested],
            [['update', 'all'], nested, nested],
            [['update'], alias, alias],
            [['update', 'all', path.join(relativeBase, 'projects')], WORKSPACE_ROOT, path.join(base, 'projects')],
            [['update', 'nested'], path.join(base, 'projects'), nested],
            [['update', nested], '/', nested],
            [['update', 'all', alias], '/', alias],
        ]) {
            const events = [];
            const code = await runOuterCli(argv, {
                env: {},
                cwd: () => cwdPath,
                input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
                supervisor: fakeSupervisor(events, { statusState: 'absent' }),
                async updateHostSource(options) {
                    events.push(['host-update', options]);
                    return { updated: false, skipped: true, reason: 'outside scope' };
                },
            });
            assert.equal(code, 0, argv.join(' '));
            const canonical = fs.realpathSync.native(folderPath);
            assert.equal(events[0][1].updateScopeRoot, canonical, argv.join(' '));
            const [, , options] = events[1];
            assert.equal(options.request.folderPath, folderPath, argv.join(' '));
            assert.deepEqual(options.scope, {
                relative: path.relative(WORKSPACE_ROOT, canonical),
                canonicalFolder: canonical,
            }, argv.join(' '));
            assert.equal(options.updateScopeRoot, canonical);
        }
    } finally {
        fs.rmSync(alias, { force: true });
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('outside, missing and malformed update scopes are rejected before any self-update, Box or supervisor call', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-cli-update-outside-'));
    try {
        for (const [argv, code] of [
            [['update', 'all', outside], 'PLOINKY_UPDATE_SCOPE_OUTSIDE'],
            [['update', outside], 'PLOINKY_UPDATE_SCOPE_OUTSIDE'],
            [['update', 'all', path.dirname(WORKSPACE_ROOT)], 'PLOINKY_UPDATE_SCOPE_OUTSIDE'],
            [['update', 'all', path.join(WORKSPACE_ROOT, 'missing')], 'PLOINKY_BOX_ARGUMENT_INVALID'],
            [['update', 'repos', 'extra'], 'PLOINKY_BOX_ARGUMENT_INVALID'],
            [['update', 'repo'], 'PLOINKY_BOX_ARGUMENT_INVALID'],
            [['update', '--unknown'], 'PLOINKY_BOX_ARGUMENT_INVALID'],
        ]) {
            const events = [];
            const supervisor = fakeSupervisor(events);
            await assert.rejects(runOuterCli(argv, {
                env: {},
                cwd: () => WORKSPACE_ROOT,
                input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
                supervisor,
                updateHostState: createMemoryUpdateHostState(),
                async updateHostSource() { events.push('host-update'); return { updated: true }; },
                relaunch() { events.push('relaunch'); return 0; },
                execute() { events.push('execute'); return 0; },
            }), { code }, argv.join(' '));
            assert.deepEqual(events, [], argv.join(' '));
        }
    } finally {
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('repository-only and targeted update forms run inside the update transaction without a host pull', async () => {
    for (const [argv, request, branchPolicyArgs] of [
        [['update', 'repos'], { kind: 'repos' }, []],
        [['update', 'repositories', '--reset-repos'], { kind: 'repos' }, ['--reset-repos']],
        [['update', 'repo', 'demo'], { kind: 'repo', repoName: 'demo' }, []],
        [['update', 'demo'], { kind: 'repo', repoName: 'demo' }, []],
    ]) {
        const events = [];
        const supervisor = fakeSupervisor(events);
        supervisor.runUpdateTransaction = async (coreArgv, options) => {
            events.push(['update-transaction', options.request, options.branchPolicyArgs]);
            return { activation: { outcome: 'deferred' } };
        };
        const output = bufferStream();
        const code = await runOuterCli(argv, {
            env: {}, input: { isTTY: false }, output, errorOutput: bufferStream(),
            cwd: () => WORKSPACE_ROOT,
            supervisor,
            async updateHostSource() { throw new Error('targeted update must not pull host source'); },
            execute() { throw new Error('targeted update must not execute outside the transaction'); },
        });
        assert.equal(code, 0);
        assert.deepEqual(events, [['update-transaction', request, branchPolicyArgs]], argv.join(' '));
        assert.match(output.value(), /may require activation: run `ploinky restart`/);
        assert.doesNotMatch(output.value(), /was restarted and|health check passed/);
    }
});

test('TTY flags appear only for interactive commands with both terminal ends', async () => {
    assert.deepEqual(buildContainerExecArgs('a'.repeat(64), [], {
        workspaceRoot: WORKSPACE_ROOT,
        hostPort: 19090,
        mediaHostPort: 17891,
        interactive: true, inputIsTty: true, outputIsTty: true, shell: true,
    }).slice(0, 4), ['container', 'exec', '--interactive', '--tty']);
    assert.equal(buildContainerExecArgs('a'.repeat(64), [], {
        workspaceRoot: WORKSPACE_ROOT,
        hostPort: 19090,
        mediaHostPort: 17891,
        interactive: true, inputIsTty: false, outputIsTty: true,
    }).includes('--tty'), false);
    const logArgs = buildContainerExecArgs('a'.repeat(64), ['logs', 'tail'], {
        workspaceRoot: WORKSPACE_ROOT,
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
        workspaceRoot: WORKSPACE_ROOT,
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
        cwd: () => WORKSPACE_ROOT,
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

test('destroy runs input-free marker recovery when the outer Box is already absent', async () => {
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
    assert.deepEqual(events, ['status', ['destroy', null, { deleteCache: false }]]);
    assert.doesNotMatch(output.value(), /\[y\/N\]|cancelled/i);
    assert.deepEqual(events.find((event) => Array.isArray(event) && event[0] === 'destroy'),
        ['destroy', null, { deleteCache: false }]);
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
    assert.match(output.value(), /ploinky diagnose \[--json\]/);
    assert.match(output.value(), /ploinky repair \[--dry-run\] \[--json\]/);
    assert.match(output.value(), /never invokes sudo/);
    assert.match(output.value(), /start and restart do not run prerequisite diagnostics/);
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
