import assert from 'node:assert/strict';
import test from 'node:test';

import { annotateRemediations, formatRemediationActions } from '../../ploinky-box/diagnose/remediations.mjs';

const check = (id, detail = '', extra = {}) => ({ id, status: 'fail', label: id, detail, ...extra });
const report = (checks, extra = {}) => ({ version: 1, platform: 'linux', exitCode: 1, checks, ...extra });
const annotate = (checks, extra) => annotateRemediations(report(checks), extra);
const action = (checks) => annotate(checks).actions[0];

test('successful and skipped checks do not propose repairs', () => {
    const result = annotate([
        check('host.device.fuse', '', { status: 'pass', actionIds: ['untrusted'] }),
        check('runtime.probes', '', { status: 'skip', next: 'sudo anything' }),
    ]);
    assert.deepEqual(result.actions, []);
    assert.ok(result.checks.every((entry) => !Object.hasOwn(entry, 'actionIds')));
});

test('the catalog replaces externally supplied actions and never executes or classifies prose hints', () => {
    const original = report([check('unknown.failure', 'Unclassified failure', {
        next: 'sudo sh -c "do something"', actionIds: ['injected'], repairId: 'start-podman-machine',
    })], { actions: [{ id: 'injected', mode: 'automatic', requiresSudo: false }] });
    const result = annotateRemediations(original);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].mode, 'manual');
    assert.equal(result.actions[0].requiresSudo, null);
    assert.equal(result.actions[0].repairId, undefined);
    assert.doesNotMatch(result.actions[0].instructions, /do something/);
    assert.deepEqual(original.checks[0].actionIds, ['injected']);
});

test('known system repairs require sudo and use the detected distribution package names', () => {
    const result = annotate([
        check('host.podman.version', 'podman version 4.9.3; required >= 5.4.0.', { exitCode: 0 }),
        check('host.seccomp'),
        check('host.device.fuse'), check('host.device.tun'), check('host.sysctl.max_user_namespaces'),
    ], { context: { packageFamily: 'fedora' } });
    assert.ok(result.actions.every((entry) => entry.mode === 'manual' && entry.requiresSudo === true && entry.required));
    assert.deepEqual(result.actions.find((entry) => entry.id === 'install-host-podman').commands,
        [{ file: 'sudo', args: ['dnf', 'install', 'podman', 'catatonit'] }]);
    assert.deepEqual(result.actions.find((entry) => entry.id === 'enable-device-tun').commands, [{ file: 'sudo', args: ['modprobe', 'tun'] }]);
});

test('unknown package managers and macOS do not receive guessed sudo apt commands', () => {
    const old = check('host.podman.version', 'podman version 4.9.3; required >= 5.4.0.', { exitCode: 0 });
    assert.equal(action([old]).commands, undefined);
    const mac = annotateRemediations(report([old], { platform: 'darwin' }), { context: { packageFamily: 'debian' } });
    assert.equal(mac.actions[0].requiresSudo, null);
    assert.equal(mac.actions[0].commands, undefined);
});

test('PATH-only failures do not claim missing packages or required administrator installation', () => {
    const result = annotate([
        check('host.podman.version', 'ENOENT', { exitCode: 1 }),
        check('host.helper.newuidmap', 'Executable not found on PATH.'),
        check('host.helper.newgidmap', 'Executable not found on PATH.'),
    ], { context: { packageFamily: 'fedora' } });
    const required = result.actions.filter((entry) => entry.required);
    assert.equal(required.length, 3);
    assert.ok(required.every((entry) => entry.mode === 'manual' && entry.requiresSudo === false));
    assert.ok(required.every((entry) => /Package absence has not been established/.test(entry.instructions)));
    const ids = result.actions.find((entry) => entry.id === 'install-uidmap');
    assert.equal(ids.required, false);
    assert.equal(ids.requiresSudo, true);
    assert.deepEqual(ids.checkIds, ['host.helper.newuidmap', 'host.helper.newgidmap']);
    assert.deepEqual(ids.commands, [{ file: 'sudo', args: ['dnf', 'install', 'shadow-utils'] }]);
    const rendered = formatRemediationActions(result.actions);
    assert.doesNotMatch(rendered, /Required administrator actions:|remain deployment blockers/);
    assert.match(rendered, /Conditional alternative after PATH inspection/);
});

test('unparseable or failed Podman version probes leave installation privileges undetermined', () => {
    for (const [detail, exitCode] of [['EACCES: permission denied', 1], ['unexpected wrapper output', 0], ['podman version 5.4.0; unexpected output', 1]]) {
        const result = action([check('host.podman.version', detail, { exitCode })]);
        assert.equal(result.id, 'inspect-podman-version-command');
        assert.equal(result.requiresSudo, null);
    }
});

test('repair execution and lock failures remain manual recovery actions even with policy words in errors', () => {
    for (const id of ['repair.lock', 'repair.lock.release', 'repair.execution.pull-box-image']) {
        const result = action([check(id, 'AppArmor DENIED while running automatic repair', {
            next: 'Review the exact operation before retrying. password=do-not-print', repairEligible: true,
        })]);
        assert.equal(result.mode, 'manual');
        assert.equal(result.requiresSudo, null);
        assert.equal(result.required, true);
        assert.equal(result.repairId, undefined);
        assert.match(result.instructions, /^Review the exact operation before retrying/);
        assert.doesNotMatch(result.instructions, /do-not-print/);
        assert.equal(result.commands, undefined);
    }
});

test('PATH, endpoint overrides, ports and personal configuration remain manual user actions', () => {
    const result = annotate([
        check('host.node.path'), check('host.endpoint'), check('workspace.publication', 'TCP 8080 already in use'),
        check('host.storage.vfs', '', { status: 'warn' }), check('workspace.current', 'No space left on device'),
    ]);
    assert.ok(result.actions.every((entry) => entry.mode === 'manual' && entry.requiresSudo === false));
    const ports = result.actions.find((entry) => entry.id === 'select-available-ports');
    assert.match(ports.instructions, /repair never terminates listeners/);
    assert.equal(result.actions.find((entry) => entry.id === 'inspect-user-storage').required, false);
});

test('selected executable failures leave privilege undetermined rather than assuming a missing package', () => {
    const selected = action([check('host.helper.oci', 'Selected executable: /opt/tools/crun; missing or not executable.')]);
    assert.equal(selected.requiresSudo, null);
    assert.match(selected.instructions, /already-installed executable/);
});

test('only a successful mapping probe with invalid output establishes an ID allocation repair', () => {
    const proven = action([check('host.mapping.uid', '0 1000 1; at least 65536 contiguous container IDs starting at 0 are required.', { exitCode: 0 })]);
    assert.equal(proven.id, 'allocate-subordinate-uids');
    assert.equal(proven.requiresSudo, true);
    for (const detail of ['unshare failed without output', 'cannot clone: Operation not permitted', 'newuidmap failed: Permission denied']) {
        const failed = action([check('host.mapping.uid', detail, { exitCode: 1 })]);
        assert.equal(failed.requiresSudo, null);
        assert.notEqual(failed.id, 'allocate-subordinate-uids');
    }
});

test('unreadable loaded policies and source-only rule warnings do not claim administrator blockers', () => {
    const result = annotate([
        check('host.apparmor.loaded', 'Not readable', { status: 'warn' }),
        check('host.apparmor.pasta', 'Narrow source rules not found', { status: 'warn' }),
        check('host.apparmor.fusermount', 'Narrow source rules not found', { status: 'warn' }),
    ]);
    assert.ok(result.actions.every((entry) => entry.requiresSudo === true && !entry.required));
    const rendered = formatRemediationActions(result.actions);
    assert.match(rendered, /Optional administrator diagnostics/);
    assert.doesNotMatch(rendered, /Required administrator actions:|remain deployment blockers/);
});

test('confirmed AppArmor denials promote the matching optional policy action to a required repair', () => {
    const result = annotate([
        check('host.apparmor.pasta', 'No narrow source rules', { status: 'warn' }),
        check('nested-engine.agent-start', 'apparmor="DENIED" profile="pasta" name="/run/netns/netns-123"'),
        check('nested-engine.agent-remove', 'apparmor="DENIED" profile="fusermount3" operation="umount" name="/data/podman/storage/overlay/123/merged/"'),
    ]);
    const pasta = result.actions.find((entry) => entry.id === 'review-pasta-policy');
    assert.equal(pasta.required, true);
    assert.equal(pasta.requiresSudo, true);
    assert.deepEqual(pasta.checkIds, ['host.apparmor.pasta', 'nested-engine.agent-start']);
    assert.equal(result.actions.find((entry) => entry.id === 'review-fusermount-policy').required, true);
});

test('generic namespace failures do not claim a proven AppArmor patch or allocation change', () => {
    const value = action([check('nested-engine.agent-start', "pasta failed: Couldn't open network namespace /run/netns/netns-123: Permission denied")]);
    assert.equal(value.id, 'inspect-runtime-policy');
    assert.equal(value.requiresSudo, null);
    const mention = action([check('unknown', 'AppArmor state could not be inspected')]);
    assert.equal(mention.requiresSudo, null);
});

test('only specifically admitted permission and Machine checks get automatic repair IDs', () => {
    const cases = [
        ['repair.binding.permissions', 'BINDING_SHARED_READ', 'secure-binding-permissions'],
        ['repair.machine.state', 'MACHINE_STOPPED_ELIGIBLE', 'start-podman-machine'],
        ['repair.image.cache', 'IMAGE_CACHE_MISSING', 'pull-box-image'],
    ];
    for (const [id, code, expected] of cases) {
        const admitted = action([check(id, '', { code, repairEligible: true })]);
        assert.equal(admitted.mode, 'automatic');
        assert.equal(admitted.requiresSudo, false);
        assert.equal(admitted.repairId, expected);
        for (const extra of [{ code }, { code: 'UNKNOWN', repairEligible: true }]) {
            assert.equal(action([check(id, '', extra)]).mode, 'manual');
        }
    }
    assert.equal(action([check('host.machine.state', 'machine: not running.', { repairEligible: true })]).mode, 'manual');
    assert.equal(action([check('repair.image.cache', '', { code: 'LOCAL_IMAGE_MISSING', repairEligible: false })]).mode, 'manual');
});

test('a verified stopped Machine replaces the earlier inconclusive host state guidance', () => {
    const result = annotate([
        check('host.machine.state', 'machine: not running.'),
        check('repair.machine.state', '', { code: 'MACHINE_STOPPED_ELIGIBLE', repairEligible: true }),
    ]);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].repairId, 'start-podman-machine');
    assert.ok(result.checks.every((entry) => entry.actionIds.join(',') === 'start-podman-machine'));
});

test('foreign or shared-writable metadata never gets automatic permission repair', () => {
    const foreign = action([check('repair.binding.permissions', '', { code: 'BINDING_FOREIGN_OWNER', repairEligible: true })]);
    assert.equal(foreign.mode, 'manual');
    assert.equal(foreign.requiresSudo, true);
    const shared = action([check('repair.binding.permissions', '', { code: 'BINDING_SHARED_WRITE', repairEligible: true })]);
    assert.equal(shared.mode, 'manual');
    assert.equal(shared.requiresSudo, false);
});

test('image pull retry is automatic only at host image.pull and retains manual authentication guidance', () => {
    const result = annotate([check('image.pull', 'Registry unauthorized: authentication required')]);
    assert.deepEqual(result.checks[0].actionIds, ['pull-box-image', 'restore-registry-access']);
    assert.equal(result.actions[0].repairId, 'pull-box-image');
    assert.equal(result.actions[1].mode, 'manual');
    assert.equal(result.actions[1].requiresSudo, false);
    const inner = action([check('inner.image-pull', 'Registry unauthorized: authentication required')]);
    assert.equal(inner.mode, 'manual');
});

test('nested image runtime incompatibility does not suggest upgrading the host runtime', () => {
    const detail = 'crun: unknown version specified';
    const host = action([check('box.lifecycle', detail)]);
    assert.equal(host.requiresSudo, true);
    assert.equal(host.id, 'update-oci-runtime');
    const inside = action([check('nested-engine.agent-start', detail)]);
    assert.equal(inside.requiresSudo, false);
    assert.equal(inside.id, 'restore-supported-box-image');
});

test('in-container storage failures point to the owning container configuration and source', () => {
    const detail = '{"driver":"vfs","graphRoot":"/data/podman/storage","rootless":false,"networkBackend":"netavark"}';
    for (const id of ['inner.podman-settings', 'nested-engine.podman-settings', 'workspace.storage', 'current.agent.3.podman']) {
        for (const observed of [detail, 'Podman returned invalid JSON; settings could not be verified.']) {
            const result = action([check(id, observed)]);
            assert.equal(result.id, 'inspect-container-storage');
            assert.equal(result.requiresSudo, false);
            assert.match(result.instructions, /in-container Podman command/);
            assert.match(result.instructions, /configuration generated from Ploinky and the Box image/);
            assert.doesNotMatch(result.instructions, /personal containers\/storage.conf/);
            assert.equal(result.commands, undefined);
        }
    }
    assert.equal(action([check('host.storage', detail)]).id, 'inspect-user-storage');
    assert.equal(action([check('nested-engine.agent-start', 'apparmor="DENIED" profile="fusermount3" overlay mount denied')]).requiresSudo, true);
});

test('aggregate failures reuse leaf actions and do not create redundant generic repairs', () => {
    const result = annotate([
        check('nested-engine.agent-start', 'apparmor="DENIED" profile="pasta"'),
        check('inner.engine-exec', 'Nested probes failed'),
        check('box.inner', 'Inner probes failed'),
        check('runtime.probes', 'An isolated deployment step failed'),
    ]);
    assert.equal(result.actions.length, 1);
    assert.ok(result.checks.every((entry) => entry.actionIds.join(',') === 'review-pasta-policy'));
    assert.deepEqual(new Set(result.actions[0].checkIds), new Set(result.checks.map((entry) => entry.id)));
});

test('formatter separates admin blockers and optional inspections and safely quotes commands', () => {
    const result = annotate([
        check('host.device.fuse'), check('host.endpoint'), check('host.apparmor.loaded', '', { status: 'warn' }),
        check('unknown'), check('image.pull'),
    ]);
    result.actions.push({ id: 'display', mode: 'manual', requiresSudo: false, required: false,
        title: 'Escapes\u001b[31m', instructions: 'password=do-not-print\nExtra',
        commands: [
            { file: 'podman', args: ['inspect', "name';touch /tmp/unwanted", 'token=do-not-print'] },
            { file: 'podman', args: ['login', '--password', 'do-not-print'] },
        ] });
    const rendered = formatRemediationActions(result.actions, { remaining: true });
    assert.match(rendered, /^Remaining actions/);
    for (const label of ['AUTO (no sudo)', 'MANUAL (no sudo)', 'SUDO REQUIRED', 'MANUAL (privilege undetermined)']) assert.ok(rendered.includes(`[${label}]`));
    assert.match(rendered, /Required administrator actions:/);
    assert.match(rendered, /Optional administrator diagnostics/);
    assert.match(rendered, /never invokes sudo/);
    assert.ok(rendered.includes("'name'\\'';touch /tmp/unwanted'"));
    assert.doesNotMatch(rendered, /do-not-print|\u001b/);
});

test('R1 a bundled AchillesAgentLib pin warning points to the supported image as an optional action', () => {
    const result = annotate([check('image.agentlib.pin', 'The Box image bundles AchillesAgentLib x', { status: 'warn' })]);
    assert.equal(result.actions[0].id, 'restore-supported-box-image');
    assert.equal(result.actions[0].required, false);
    // Image references, paths, and branch names in the detail must not select another remedy.
    for (const detail of [
        'The Box image registry.example.com/ploinky-box:latest (image cccccccccccc) bundles AchillesAgentLib bbbbbbbb.',
        'This Ploinky checkout is probably older than the Box image: /home/u/overlay-work/ploinky (master at deadbeef) has never pinned bbbbbbbb.',
        'This Ploinky checkout is probably older than the Box image: /home/u/ploinky (fix-cgroup-timeout at deadbeef) has never pinned bbbbbbbb.',
        'unauthorized TLS certificate ENOSPC crun: unknown version specified',
    ]) {
        for (const status of ['warn', 'fail']) {
            assert.deepEqual(annotate([check('image.agentlib.pin', detail, { status })]).actions.map((entry) => entry.id),
                ['restore-supported-box-image'], `${status}: ${detail}`);
        }
    }
});

test('R2 an invalid strict-pin setting points to the environment, not the image', () => {
    const [action] = annotate([check('image.agentlib.pin', 'PLOINKY_AGENTLIB_STRICT_PIN must be 0 or 1 (got "yes")',
        { code: 'PLOINKY_BOX_ARGUMENT_INVALID' })]).actions;
    assert.equal(action.id, 'set-agentlib-strict-pin');
    assert.equal(action.mode, 'manual');
    assert.equal(action.requiresSudo, false);
    assert.equal(action.required, true);
});
