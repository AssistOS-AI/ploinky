import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    createDiagnosticRunner, createVerifierScope, diagnoseWorkspace,
    diagnosticAdvice, formatDiagnosticReport, validateInsideReport,
} from '../../ploinky-box/diagnose.mjs';
import { probeImageBinaries, IMAGE_OBSERVATION_UNAVAILABLE } from '../../ploinky-box/contract/image.mjs';
import { probeImageAgentLib } from '../../ploinky-box/image-agentlib.mjs';

const IMAGE = 'a'.repeat(64);
const ID = 'b'.repeat(64);
const OWNER = '11111111-2222-4333-8444-555555555555';
const absent = { ok: false, status: 125, stdout: '', stderr: 'Error: no such container', error: null };

function workspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-diagnose-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('missing host prerequisites produce a report and skip every mutating runtime probe', async (t) => {
    const root = workspace(t);
    const report = await diagnoseWorkspace({ cwd: root, env: {},
        runner: { query() { assert.fail('No engine calls expected'); } },
        hostChecks: () => ({ checks: [{ id: 'missing-podman', label: 'Podman', status: 'fail', detail: 'not installed', next: 'Install Podman' }], engineUsable: false }),
        runtimeChecks: () => assert.fail('Runtime probes must be blocked'),
    });
    assert.equal(report.exitCode, 1);
    assert.equal(report.workspace, root);
    assert.equal(report.checks.find((check) => check.id === 'runtime.probes').status, 'skip');
    assert.deepEqual(fs.readdirSync(root), []);
    assert.match(formatDiagnosticReport(report), /Install Podman/);
});

test('diagnostic report preserves command exit details and redacts secrets and terminal escapes', () => {
    const commands = [];
    const runner = createDiagnosticRunner({ query: () => ({ ok: false, status: 125,
        stdout: '', stderr: '\x1b[31mAuthorization: Bearer do-not-display\npassword=hunter2\x1b[0m' }) }, commands);
    assert.throws(() => runner.run('podman', ['start', ID]), (error) => error.diagnosticCommand.exitCode === 125);
    assert.doesNotMatch(JSON.stringify(commands), /do-not-display|hunter2|\u001b/);
    const output = formatDiagnosticReport({ workspace: '\x1b[31m/tmp/test', exitCode: 1, checks: [
        { id: 'x', label: 'Container startup', status: 'fail', command: commands[0], detail: commands[0].detail, exitCode: 125, next: 'Inspect the kernel denial' },
    ] });
    assert.match(output, /podman start/);
    assert.match(output, /Exit: 125/);
    assert.match(output, /Inspect the kernel denial/);
    assert.doesNotMatch(output, /do-not-display|hunter2|\u001b/);
    assert.match(output, /Rerun ploinky diagnose/);
});

test('remediation distinguishes namespace, filesystem and port failures', () => {
    assert.match(diagnosticAdvice('pasta: cannot open network namespace /run/netns/netns-a: Permission denied'), /AppArmor/);
    assert.match(diagnosticAdvice('crun mkdir /code Operation not permitted'), /overlay/);
    assert.match(diagnosticAdvice('Physical-host TCP 127.0.0.1:8080 is already in use'), /ss -ltnu/);
    assert.match(diagnosticAdvice('newuidmap failed'), /subuid/);
    const advice = diagnosticAdvice('Error: OCI runtime error: crun: unknown version specified');
    assert.match(advice, /host\.ociRuntime\.path/);
    assert.match(advice, /--version/);
    assert.match(advice, /Upgrade the selected OCI runtime.*compatible with the installed Podman/);
    assert.doesNotMatch(advice, /AppArmor/);
});

test('a wrapped image verifier failure retains the actual crun command, stderr and recovery action', async (t) => {
    const root = workspace(t);
    const stderr = 'Error: OCI runtime error: crun: unknown version specified\n';
    let failedArgs;
    const report = await diagnoseWorkspace({ cwd: root, env: {},
        hostChecks: () => ({ checks: [], engineUsable: true }), discover: () => ({ state: 'absent' }),
        bindingStore: { read: () => null }, checkPublications: async () => {},
        runner: { query(file, args) {
            assert.equal(file, 'podman');
            if (args[0] === 'run') {
                failedArgs = args;
                return { ok: false, status: 126, stdout: '', stderr, error: null };
            }
            assert.deepEqual(args.slice(0, 2), ['container', 'inspect']);
            return absent;
        } },
        runtimeChecks: async ({ stage, runner }) => {
            const verifier = createVerifierScope(runner, OWNER);
            await stage('image.contract', 'Validate the exact Box image and bundled tools', async () => {
                try { probeImageBinaries('podman', IMAGE, verifier.runner); }
                catch (error) { throw new Error('Image validation failed', { cause: error }); }
            });
            await stage('cleanup.verifiers', 'Remove test verifiers', async () => verifier.cleanup());
        },
    });
    const check = report.checks.find((entry) => entry.id === 'image.contract');
    assert.equal(report.exitCode, 1);
    assert.equal(check.status, 'fail');
    assert.equal(check.exitCode, 126);
    assert.deepEqual(check.command, { file: 'podman', args: failedArgs });
    assert.match(check.detail, /runtime capability probe unavailable \(command-failed\)/);
    assert.match(check.detail, /crun: unknown version specified/);
    assert.match(check.next, /Upgrade the selected OCI runtime/);
    const rendered = formatDiagnosticReport(report);
    assert.match(rendered, /Command: podman run --name ploinky-diagnose-verify-/);
    assert.match(rendered, /Exit: 126/);
    assert.match(rendered, /crun: unknown version specified/);
    const cleanup = report.checks.find((entry) => entry.id === 'cleanup.verifiers');
    assert.equal(cleanup.status, 'pass');
    assert.equal(cleanup.exitCode, 125);
    assert.doesNotMatch(cleanup.detail, /crun/);
});

test('AgentLib query wrappers retain sanitized failed command evidence', async (t) => {
    const root = workspace(t);
    const report = await diagnoseWorkspace({ cwd: root, env: {},
        hostChecks: () => ({ checks: [], engineUsable: true }), discover: () => ({ state: 'absent' }),
        bindingStore: { read: () => null }, checkPublications: async () => {},
        runner: { query: () => ({ ok: false, status: 126, stdout: '',
            stderr: 'crun: unknown version specified\nAuthorization: Bearer secret-verifier-token\n', error: null }) },
        runtimeChecks: async ({ stage, runner }) => {
            await stage('image.agentlib', 'Verify the bundled AgentLib', async () => probeImageAgentLib('podman', IMAGE, runner));
        },
    });
    const check = report.checks.find((entry) => entry.id === 'image.agentlib');
    assert.equal(check.exitCode, 126);
    assert.equal(check.command.file, 'podman');
    assert.equal(check.command.args[0], 'run');
    assert.match(check.detail, /crun: unknown version specified/);
    assert.doesNotMatch(JSON.stringify(report), /secret-verifier-token/);
});

test('incidental absent resources and cleanup commands do not explain unrelated filesystem failures', async (t) => {
    const root = workspace(t);
    const cases = [
        ['image', 'inspect', 'missing-image'],
        ['container', 'inspect', ID],
        ['container', 'rm', ID],
    ];
    const report = await diagnoseWorkspace({ cwd: root, env: {},
        hostChecks: () => ({ checks: [], engineUsable: true }), discover: () => ({ state: 'absent' }),
        bindingStore: { read: () => null }, checkPublications: async () => {},
        runner: { query: () => absent },
        runtimeChecks: async ({ stage, runner }) => {
            for (const [index, args] of cases.entries()) {
                await stage(`filesystem.${index}`, 'Create diagnostic scratch', async () => {
                    runner.query('podman', args);
                    fs.mkdirSync(path.join(root, 'missing-parent', 'child'));
                });
            }
        },
    });
    for (const check of report.checks.filter((entry) => entry.id.startsWith('filesystem.'))) {
        assert.equal(check.status, 'fail');
        assert.match(check.detail, /ENOENT/);
        assert.doesNotMatch(check.detail, /no such container/);
        assert.equal(check.command, undefined);
        assert.equal(check.exitCode, undefined);
    }
});

test('a later successful command prevents borrowing an older failure for a summarized error', async (t) => {
    const root = workspace(t);
    const report = await diagnoseWorkspace({ cwd: root, env: {},
        hostChecks: () => ({ checks: [], engineUsable: true }), discover: () => ({ state: 'absent' }),
        bindingStore: { read: () => null }, checkPublications: async () => {},
        runner: { query: (_file, args) => args[0] === 'image' ? absent : { ok: true, status: 0, stdout: '{}', stderr: '' } },
        runtimeChecks: async ({ stage, runner }) => {
            await stage('image.validation', 'Inspect image result', async () => {
                runner.query('podman', ['image', 'inspect', 'missing-image']);
                runner.query('podman', ['info', '--format', 'json']);
                throw Object.assign(new Error('Image result is unavailable'), { code: IMAGE_OBSERVATION_UNAVAILABLE });
            });
        },
    });
    const check = report.checks.find((entry) => entry.id === 'image.validation');
    assert.equal(check.command, undefined);
    assert.equal(check.exitCode, undefined);
    assert.doesNotMatch(check.detail, /no such container/);
});

test('explicit command cause survives later expected-absence cleanup', async (t) => {
    const root = workspace(t);
    const report = await diagnoseWorkspace({ cwd: root, env: {},
        hostChecks: () => ({ checks: [], engineUsable: true }), discover: () => ({ state: 'absent' }),
        bindingStore: { read: () => null }, checkPublications: async () => {},
        runner: { query: (_file, args) => args[0] === 'start'
            ? { ok: false, status: 126, stdout: '', stderr: 'crun: unknown version specified', error: null }
            : absent },
        runtimeChecks: async ({ stage, runner }) => {
            await stage('container.start', 'Start test container', async () => {
                try { runner.run('podman', ['start', ID]); }
                catch (error) { throw new Error('Startup failed', { cause: error }); }
                finally { runner.query('podman', ['container', 'inspect', ID]); }
            });
        },
    });
    const check = report.checks.find((entry) => entry.id === 'container.start');
    assert.deepEqual(check.command, { file: 'podman', args: ['start', ID] });
    assert.equal(check.exitCode, 126);
    assert.match(check.detail, /crun: unknown version specified/);
    assert.doesNotMatch(check.detail, /no such container/);
});

test('empty, malformed and incomplete successful inner reports fail closed', () => {
    assert.throws(() => validateInsideReport({ checks: [], exitCode: 0 }), /empty/);
    assert.throws(() => validateInsideReport({ checks: [{ id: 'x', label: 'x', detail: '', status: 'maybe' }], exitCode: 0 }), /invalid/);
    assert.throws(() => validateInsideReport({ checks: [{ id: 'inner.x', label: 'x', detail: '', status: 'pass' }], exitCode: 0 }), /without completing/);
    const failed = { checks: [{ id: 'inner.start', label: 'Start', detail: 'permission denied', status: 'fail' }], exitCode: 1 };
    assert.equal(validateInsideReport(failed), failed);
    for (const id of ['image.pull', 'repair.binding.permissions', 'repair.machine.state']) {
        assert.throws(() => validateInsideReport({ exitCode: 1, checks: [{ id, label: 'spoofed host repair', detail: '', status: 'fail', repairEligible: true }] }), /cannot publish host or repair/);
    }
});

test('image verifier timeout cleanup uses only the labelled immutable container', () => {
    let created, removed = false;
    const native = {
        query(_file, args) {
            if (args[0] === 'run') { created = args; return { ok: false, status: 1, error: { code: 'ETIMEDOUT' } }; }
            if (removed) return absent;
            return { ok: true, status: 0, stdout: JSON.stringify([{ Id: ID, Name: created[2], Image: IMAGE,
                Config: { Labels: { 'io.assistos.ploinky.diagnose-probe': OWNER } } }]) };
        },
        run(_file, args) { assert.deepEqual(args, ['container', 'rm', '--force', '--time', '0', ID]); removed = true; },
    };
    const scope = createVerifierScope(native, OWNER);
    scope.runner.query('podman', ['run', '--rm', '--network=none', IMAGE, '/bin/true']);
    assert.ok(created.includes('--rm'));
    assert.match(created[2], /^ploinky-diagnose-verify-/);
    assert.match(scope.cleanup(), /1 image verifier/);
    assert.equal(removed, true);
});

test('verifier cleanup refuses a changed image or another owner', () => {
    let name;
    const scope = createVerifierScope({
        query(_file, args) {
            if (args[0] === 'run') { name = args[2]; return absent; }
            return { ok: true, stdout: JSON.stringify([{ Id: ID, Name: name, Image: IMAGE, Config: { Labels: {} } }]) };
        },
        run() { assert.fail('An unowned verifier must not be removed'); },
    }, OWNER);
    scope.runner.query('podman', ['run', '--rm', IMAGE, '/bin/true']);
    assert.throws(() => scope.cleanup(), /Ownership changed/);
});

test('streaming progress forwards only bounded diagnostic lines while retaining the result', async () => {
    const commands = [], progress = [];
    const runner = createDiagnosticRunner({
        async stream(_file, _args, options) {
            options.stderr.write('registry noise\n[diagnose] preparing');
            options.stderr.write(' namespace\n');
            return { ok: true, status: 0, stdout: '{}', stderr: '' };
        },
    }, commands, { progress: (value) => progress.push(value) });
    const result = await runner.stream('podman', ['exec', ID, 'node', 'inside.mjs']);
    assert.equal(result.stdout, '{}');
    assert.equal(commands.length, 1);
    assert.ok(progress.includes('preparing namespace'));
    assert.equal(progress.some((value) => value.includes('registry noise')), false);
});

test('an existing Box does not hide port conflicts or an inactive reservation', async (t) => {
    const root = workspace(t);
    for (const running of [true, false]) {
        let attempted = false;
        const report = await diagnoseWorkspace({ cwd: root, env: {}, explicitPort: 9090, explicitMediaPort: 7999,
            admitCurrentBox() {},
            hostChecks: () => ({ checks: [], engineUsable: true }),
            discover: () => ({ state: 'owned', handles: { container: {
                id: ID, labels: { 'io.assistos.ploinky-box.router-host-port': '8080', 'io.assistos.ploinky-box.media-host-port': '7882' },
                runtime: { running, environment: {} },
            } } }),
            bindingStore: { read: () => null },
            checkPublications: async (options) => {
                attempted = true;
                assert.equal(options.hostPort, 9090);
                assert.equal(options.mediaHostPort, 7999);
                assert.equal(options.existingPublication.running, running);
                assert.equal(options.existingPublication.hostPort, 8080);
                throw new Error('Physical-host TCP 127.0.0.1:9090 is already in use');
            },
            runner: { query() { assert.fail('Port conflict should precede storage inspection'); } },
            currentChecks: () => [], runtimeChecks: async () => {},
        });
        assert.equal(attempted, true);
        assert.equal(report.exitCode, 1);
        assert.equal(report.checks.find((check) => check.id === 'workspace.publication').status, 'fail');
    }
});

test('a failed inner step cannot be summarized as a passing runtime diagnosis', async (t) => {
    const root = workspace(t);
    const report = await diagnoseWorkspace({ cwd: root, env: {},
        hostChecks: () => ({ checks: [], engineUsable: true }), discover: () => ({ state: 'absent' }),
        bindingStore: { read: () => null }, checkPublications: async () => {},
        runner: { query() { assert.fail('No engine invocation is expected'); } },
        runtimeChecks: async ({ checks }) => { checks.push({ id: 'inner.agent-start', label: 'Start nested agent', status: 'fail', detail: 'Namespace denied' }); },
    });
    assert.equal(report.exitCode, 1);
    assert.equal(report.checks.find((check) => check.id === 'runtime.probes').status, 'fail');
});

test('ambiguous workspace ownership blocks all temporary deployment mutations', async (t) => {
    const root = workspace(t);
    const report = await diagnoseWorkspace({ cwd: root, env: {},
        hostChecks: () => ({ checks: [], engineUsable: true }), discover: () => ({ state: 'foreign', message: 'Ownership mismatch' }),
        runner: { query() { assert.fail('No engine invocation is expected'); } },
        runtimeChecks: () => assert.fail('No temporary containers in an unverified workspace'),
    });
    assert.equal(report.exitCode, 1);
    assert.equal(report.checks.find((check) => check.id === 'runtime.probes').status, 'skip');
});

test('a mislabeled or incompatible Box cannot receive diagnostic exec commands', async (t) => {
    const root = workspace(t);
    const report = await diagnoseWorkspace({ cwd: root, env: {},
        hostChecks: () => ({ checks: [], engineUsable: true }),
        discover: () => ({ state: 'owned', handles: { container: { id: ID, runtime: { running: true } } } }),
        admitCurrentBox() { throw new Error('Workspace mount belongs to another directory'); },
        runner: { query() { assert.fail('No exec before full container admission'); } },
        currentChecks() { assert.fail('No current workspace probe before admission'); },
        runtimeChecks() { assert.fail('No temporary workload before workspace admission'); },
    });
    assert.equal(report.exitCode, 1);
    assert.match(report.checks.find((check) => check.id === 'workspace.ownership').detail, /another directory/);
});

test('a successful absence check preserves the actual inspect command exit code', async (t) => {
    const root = workspace(t);
    const report = await diagnoseWorkspace({ cwd: root, env: {},
        hostChecks: () => ({ checks: [], engineUsable: true }), discover: () => ({ state: 'absent' }),
        bindingStore: { read: () => null }, checkPublications: async () => {},
        runner: { query: () => absent },
        runtimeChecks: async ({ stage, runner }) => {
            await stage('cleanup.expected-absence', 'Verify test container is absent', async () => {
                const result = runner.query('podman', ['container', 'inspect', ID]);
                assert.equal(result.status, 125);
                return 'Container is absent, as expected.';
            });
        },
    });
    const check = report.checks.find((entry) => entry.id === 'cleanup.expected-absence');
    assert.equal(check.status, 'pass');
    assert.equal(check.exitCode, 125);
});
