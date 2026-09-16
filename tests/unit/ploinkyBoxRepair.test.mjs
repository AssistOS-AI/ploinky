import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { repairWorkspace, formatRepairReport } from '../../ploinky-box/repair.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { inspectBindingPermissions } from '../../ploinky-box/repair/bindingPermissions.mjs';
import { inspectSelectedMachine } from '../../ploinky-box/repair/automatic.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-user-repair-'));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
    const directory = path.join(home, '.ploinky-box', 'router-bindings');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const identity = buildWorkspaceIdentity(workspace);
    const target = path.join(directory, identity.instance + '.json');
    const data = JSON.stringify({ version: 1, instance: identity.instance, pathHash: identity.pathHash,
        workspaceRoot: workspace, address: '127.0.0.1', hostPort: 8080, containerPort: 8080 });
    fs.writeFileSync(target, data, { mode: 0o600 }); fs.chmodSync(target, 0o644);
    const modes = [];
    const admin = { id: 'host.device.fuse', label: '/dev/fuse', status: 'fail', detail: 'Device is unavailable.' };
    const options = { cwd: workspace, env: {}, platform: 'linux', homeDirectory: home,
        runner: { query() { assert.fail('No external command expected for binding permission repair'); } },
        diagnose: async ({ inspectionOnly }) => {
            modes.push(inspectionOnly);
            const checks = [...inspectBindingPermissions({ identity, homeDirectory: home }), admin];
            return { version: 1, workspace, platform: 'linux', inspectionOnly, exitCode: 1, checks, commands: [] };
        } };
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, home, workspace, identity, target, data, modes, options };
}

test('repair tightens only the binding record and reports administrator work after rechecking', { skip: process.getuid?.() === 0 }, async (t) => {
    const state = fixture(t);
    const report = await repairWorkspace(state.options);
    assert.deepEqual(state.modes, [true, false]);
    assert.equal(report.outcomes[0].status, 'applied');
    assert.equal(fs.statSync(state.target).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(state.target, 'utf8'), state.data);
    assert.equal(report.after.checks.find((check) => check.id === 'repair.binding.permissions').status, 'pass');
    assert.equal(report.sudoRequired.length, 1);
    assert.equal(report.exitCode, 1);
    const text = formatRepairReport(report);
    assert.match(text, /SUDO REQUIRED/);
    assert.match(text, /sudo modprobe fuse/);
    assert.match(text, /APPLIED.*no sudo/);
});

test('dry-run plans automatic actions without locks, writes, executors or full runtime probes', { skip: process.getuid?.() === 0 }, async (t) => {
    const state = fixture(t);
    const report = await repairWorkspace({ ...state.options, dryRun: true,
        lockManager: { acquire() { assert.fail('Dry run must not acquire a mutation lock'); } },
        executors: { 'secure-binding-permissions'() { assert.fail('Dry run must not apply repairs'); } },
    });
    assert.deepEqual(state.modes, [true]);
    assert.equal(report.outcomes[0].status, 'planned');
    assert.equal(fs.statSync(state.target).mode & 0o777, 0o644);
    assert.equal(fs.existsSync(path.join(state.home, '.ploinky-box', 'locks')), false);
    assert.match(formatRepairReport(report), /Preview only/);
});

test('previously writable binding data is manual even when chmod would be possible', { skip: process.getuid?.() === 0 }, async (t) => {
    const state = fixture(t); fs.chmodSync(state.target, 0o664);
    const report = await repairWorkspace({ ...state.options,
        lockManager: { acquire() { assert.fail('Unsafe binding must not enter mutation'); } } });
    assert.equal(report.outcomes.length, 0);
    assert.equal(fs.statSync(state.target).mode & 0o777, 0o664);
    assert.ok(report.remainingActions.some((action) => action.id === 'review-binding-record' && action.mode === 'manual'));
});

test('sudo repair is refused before diagnostics, locks or commands', async () => {
    const report = await repairWorkspace({ uid: 0, diagnose() { assert.fail('Root must not diagnose or repair'); },
        lockManager: { acquire() { assert.fail('No root mutation lock'); } } });
    assert.equal(report.exitCode, 1); assert.equal(report.outcomes.length, 0);
    assert.match(formatRepairReport(report), /without sudo/);
});

test('repair ignores injected actions and never executes diagnostic command prose', async (t) => {
    const state = fixture(t);
    const report = await repairWorkspace({ ...state.options, uid: 1000,
        diagnose: async () => ({ version: 1, workspace: state.workspace, platform: 'linux', exitCode: 1, commands: [],
            checks: [{ id: 'unknown.issue', label: 'Unknown', status: 'fail', detail: 'Failure', next: 'sudo rm -rf /', repairEligible: true,
                actionIds: ['secure-binding-permissions'] }],
            actions: [{ id: 'injected', mode: 'automatic', requiresSudo: false, repairId: 'secure-binding-permissions', commands: [{ file: 'sh', args: ['-c', 'untrusted'] }] }],
        }),
        executors: { 'secure-binding-permissions'() { assert.fail('Injected action was executed'); } },
        lockManager: { acquire() { assert.fail('No injected mutation lock'); } },
    });
    assert.equal(report.outcomes.length, 0);
    assert.equal(report.remainingActions.some((action) => action.mode === 'automatic'), false);
});

test('an action failure is retained and a fresh verification still lists sudo blockers', { skip: process.getuid?.() === 0 }, async (t) => {
    const state = fixture(t);
    const report = await repairWorkspace({ ...state.options,
        executors: { 'secure-binding-permissions'() { throw new Error('Changing state; password=do-not-print'); } } });
    assert.equal(report.outcomes[0].status, 'failed');
    assert.doesNotMatch(JSON.stringify(report.outcomes), /do-not-print/);
    assert.deepEqual(state.modes, [true, false]);
    assert.equal(report.sudoRequired.length, 1);
    assert.equal(report.exitCode, 1);
});

test('optional administrator inspection does not become a required sudo deployment step', async () => {
    const report = await repairWorkspace({ uid: 1000,
        diagnose: async () => ({ version: 1, platform: 'linux', workspace: '/tmp/example', exitCode: 0, commands: [], checks: [
            { id: 'host.apparmor.loaded', label: 'Loaded profiles', status: 'warn', detail: 'Not readable by this account.' },
        ] }) });
    assert.equal(report.sudoRequired.length, 0); assert.equal(report.exitCode, 0);
    assert.match(formatRepairReport(report), /No required sudo actions/);
    assert.match(formatRepairReport(report), /Optional/);
});

test('an independent image repair cannot silently tighten shared-writable control-state directories', { skip: process.getuid?.() === 0 }, async (t) => {
    const state = fixture(t);
    const control = path.join(state.home, '.ploinky-box'); fs.chmodSync(control, 0o777);
    const report = await repairWorkspace({ ...state.options,
        diagnose: async () => ({ version: 1, workspace: state.workspace, platform: 'linux', exitCode: 1, commands: [], checks: [
            ...inspectBindingPermissions({ identity: state.identity, homeDirectory: state.home }),
            { id: 'repair.image.cache', label: 'Image cache', status: 'warn', detail: 'Missing', code: 'IMAGE_CACHE_MISSING', repairEligible: true },
        ] }),
        lockManager: { acquire() { assert.fail('Unsafe directories must be detected before the lock manager can chmod them'); } },
        executors: { 'pull-box-image'() { assert.fail('No automatic repair through unsafe control state'); } },
    });
    assert.equal(report.outcomes[0].status, 'failed');
    assert.match(report.outcomes[0].detail, /unsafe or shared-writable/);
    assert.equal(fs.statSync(control).mode & 0o777, 0o777);
});

test('repair carries the assessed Machine identity across lock acquisition and refuses a newly selected Machine', { skip: process.getuid?.() === 0 }, async (t) => {
    const state = fixture(t);
    let name = 'original-machine';
    const runner = {
        query(file, args) {
            let value;
            if (args[0] === 'system') value = [{ Default: true, IsMachine: true, Name: name,
                URI: 'ssh://account@127.0.0.1:2222/run/user/1000/podman/podman.sock', Identity: '/private/machine-key' }];
            else if (args[1] === 'list') value = [{ Name: name, Running: false }];
            else if (args[1] === 'inspect') value = [{ Name: name, Rootful: false, State: 'stopped', Created: '2026-01-01T00:00:00Z' }];
            else assert.fail('Unexpected Machine query');
            return { ok: true, status: 0, stdout: JSON.stringify(value), stderr: '' };
        },
        stream() { assert.fail('The newly selected Machine must not be started'); },
    };
    const report = await repairWorkspace({ ...state.options, platform: 'darwin', runner,
        diagnose: async ({ inspectionOnly }) => ({ version: 1, workspace: state.workspace, platform: 'darwin',
            inspectionOnly, exitCode: 1, commands: [], checks: [inspectSelectedMachine({ runner, platform: 'darwin', env: {} }).check] }),
        lockManager: { async acquire(instance) {
            name = 'newly-selected-machine';
            return { assertHeld(actual) { assert.equal(actual, instance); }, release() {} };
        } },
    });
    assert.equal(report.before.checks[0].machineIdentity.name, 'original-machine');
    assert.equal(report.outcomes[0].status, 'skipped');
    assert.equal(report.after.checks[0].machineIdentity.name, 'newly-selected-machine');
    assert.doesNotMatch(JSON.stringify(report), /ssh:\/\/|machine-key/);
});

test('a failed repair lock remains actionable even when fresh deployment diagnostics pass', { skip: process.getuid?.() === 0 }, async (t) => {
    const state = fixture(t);
    const report = await repairWorkspace({ ...state.options,
        diagnose: async ({ inspectionOnly }) => ({ version: 1, platform: 'linux', workspace: state.workspace,
            exitCode: 0, checks: inspectionOnly ? inspectBindingPermissions({ identity: state.identity, homeDirectory: state.home }) : [], commands: [] }),
        lockManager: { async acquire() { throw new Error('Repair lock is still held by another process'); } },
    });
    assert.equal(report.after.exitCode, 0);
    assert.equal(report.exitCode, 1);
    assert.equal(report.repairChecks[0].id, 'repair.lock');
    assert.ok(report.remainingActions.some((action) => action.checkIds.includes('repair.lock') && action.mode === 'manual'));
    assert.match(formatRepairReport(report), /repair execution failures still need review/);
    assert.doesNotMatch(formatRepairReport(report), /Remaining actions: none/);
});

test('repair text preserves failed action and verification commands, exits and next steps', { skip: process.getuid?.() === 0 }, async (t) => {
    const state = fixture(t);
    const report = await repairWorkspace({ ...state.options,
        diagnose: async ({ inspectionOnly }) => ({ version: 1, platform: 'linux', workspace: state.workspace,
            exitCode: 1, commands: [], checks: inspectionOnly
                ? inspectBindingPermissions({ identity: state.identity, homeDirectory: state.home })
                : [{ id: 'inner.agent-start', label: 'Inner start', status: 'fail', detail: 'Operation denied',
                    command: { file: 'podman', args: ['container', 'start', 'diagnostic-container'] }, exitCode: 125,
                    next: 'Inspect the matching host audit denial.' }] }),
        executors: { 'secure-binding-permissions': async () => ({ status: 'failed', detail: 'Permission changed',
            command: { file: 'chmod', args: ['go-rwx', '--', 'binding.json'] }, exitCode: 1 }) },
    });
    const text = formatRepairReport(report);
    assert.match(text, /Command: chmod go-rwx -- binding.json/);
    assert.match(text, /Command: podman container start diagnostic-container/);
    assert.match(text, /Exit: 125/);
    assert.match(text, /Next: Inspect the matching host audit denial/);
    assert.ok(report.remainingActions.some((action) => action.checkIds.includes('repair.execution.secure-binding-permissions')));
});
