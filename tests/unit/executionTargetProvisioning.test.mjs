import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXECUTION_TARGET_HELPER_CONTRACT_ID, TARGET_LIMITS_V1 } from '../../cli/server/executionTarget/declaration.mjs';
import { discoverExecutionTargets } from '../../cli/server/executionTarget/discovery.mjs';
import {
    BOX_TARGETS_DIRECTORY,
    HELPER_LAUNCH_FILE,
    HELPER_SECRET_FILE,
    PROVISIONING_ERROR_CODES as E,
    ROUTER_SECRET_FILE,
    TARGET_CONTROL_PATH,
    TARGET_HELPER_EXECUTABLE,
    TARGET_JOURNAL_PATH,
    TARGET_MAILBOX_PATH,
    instanceKey,
    instancePaths,
    journalInitRunArgs,
    planExecutionTargetLaunch,
    provisionExecutionTarget,
    readExecutionTargetHelperFacts,
    readProvisioningRecord,
    targetStatePaths,
} from '../../cli/server/executionTarget/provisioning.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PRINCIPAL = 'agent:rwrepo/rwtarget';
const IMAGE = `localhost/rwtarget@sha256:${'e'.repeat(64)}`;
const digest = (char) => char.repeat(64);

function declaration() {
    return {
        version: 1,
        helper: { contractId: EXECUTION_TARGET_HELPER_CONTRACT_ID, contractDigest: digest('a'), executableDigest: digest('b') },
        inventoryDigest: digest('c'),
        profile: { id: 'nested-podman-proof', digest: digest('d') },
        stateExports: [],
        serviceExports: [],
        limits: { ...TARGET_LIMITS_V1 },
    };
}

function targetManifest(extra = {}) {
    return { container: IMAGE, start: '/usr/libexec/ploinky-target/launch', containerSecurity: { nestedPodman: true }, executionTarget: declaration(), ...extra };
}

const PLAN_INPUT = Object.freeze({ runMode: 'global', runtime: 'podman', insideBox: true });

function code(fn) {
    try {
        fn();
    } catch (error) {
        return error.code;
    }
    return null;
}

function workspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p3-prov-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const controllerStateDir = path.join(root, 'ws', '.ploinky', 'data');
    const boxTmpRoot = path.join(root, 'boxtmp');
    fs.mkdirSync(controllerStateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(boxTmpRoot, { mode: 0o1777 });
    return { root, controllerStateDir, boxTmpRoot };
}

// Stands in for the target helper's `journal-init --root`: mints once, then reports the existing store.
function fakeHelper() {
    const calls = [];
    const runner = (args) => {
        calls.push(args);
        const volume = args[args.indexOf('-v') + 1];
        const journalRoot = volume.slice(0, volume.indexOf(`:${TARGET_JOURNAL_PATH}`));
        const journal = path.join(journalRoot, 'journal');
        if (!fs.existsSync(journal)) {
            fs.mkdirSync(journal, { mode: 0o700 });
            fs.writeFileSync(path.join(journal, 'journal-store.json'), JSON.stringify({ version: 1, journalStoreIdentity: crypto.randomBytes(16).toString('base64url') }));
        }
        // Like the real helper: an existing journal directory without its witness is state_corrupt (exit 1).
        if (!fs.existsSync(path.join(journal, 'journal-store.json'))) return { status: 1, stdout: '{"ok":false,"error":{"code":"state_corrupt"}}\n' };
        const identity = JSON.parse(fs.readFileSync(path.join(journal, 'journal-store.json'), 'utf8')).journalStoreIdentity;
        const stat = fs.lstatSync(journal, { bigint: true });
        return { status: 0, stdout: `${JSON.stringify({ ok: true, value: { device: String(stat.dev), inode: String(stat.ino), journalStoreIdentity: identity } })}\n` };
    };
    return { calls, runner };
}

function provision(env, helper, overrides = {}) {
    return provisionExecutionTarget({
        plan: planExecutionTargetLaunch({ manifest: targetManifest(), ...PLAN_INPUT }),
        principal: PRINCIPAL,
        containerName: 'ploinky_rwrepo_rwtarget_abc',
        instanceId: 'inst-1',
        enableGeneration: 'egen-1',
        image: IMAGE,
        controllerStateDir: env.controllerStateDir,
        boxTmpRoot: env.boxTmpRoot,
        runJournalInit: helper.runner,
        ...overrides,
    });
}

const mode = (target) => fs.lstatSync(target).mode & 0o777;
const inside = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
// The shared helper/Ploinky literal vector: incarnation 16 x 0x02, secret 32 x 0x11.
const VECTOR_TEXT = 'version=1\nhelperIncarnation=AgICAgICAgICAgICAgICAg\nkid=hti1.AgICAgICAgICAgICAgICAg\nsecret=ERERERERERERERERERERERERERERERERERERERERERE\n';
// Records every drawn secret (a copy) and the buffer handed over, which provisioning must zero.
function secretSpy() {
    const drawn = [];
    const handed = [];
    const draw = (n) => {
        const bytes = crypto.randomBytes(n);
        drawn.push(Buffer.from(bytes));
        handed.push(bytes);
        return bytes;
    };
    return { drawn, handed, draw };
}
function encodings(secret) {
    return [secret.toString('base64url'), secret.toString('base64'), secret.toString('hex'), secret.toString('hex').toUpperCase()];
}

test('P3 ordinary agents are untouched: no executionTarget key plans nothing, whatever else the manifest declares', () => {
    for (const manifest of [
        {},
        { container: 'node:24' },
        { container: 'x', containerSecurity: { nestedPodman: true } },
        { container: 'x', executionProvider: { version: 1 } },
        { container: 'x', routerAccess: { agentExec: true } },
    ]) {
        for (const runMode of ['global', 'isolated', undefined]) {
            assert.equal(planExecutionTargetLaunch({ manifest, runMode, runtime: 'podman', insideBox: true }), null);
            assert.equal(planExecutionTargetLaunch({ manifest, runMode, runtime: 'bwrap', insideBox: false }), null);
        }
    }
});

test('P3 a present but invalid declaration refuses the start instead of starting an ordinary agent', () => {
    for (const value of [null, {}, { ...declaration(), version: 2 }, { ...declaration(), stateExports: [{}] }]) {
        assert.equal(code(() => planExecutionTargetLaunch({ manifest: targetManifest({ executionTarget: value }), ...PLAN_INPUT })), E.declarationInvalid);
    }
});

test('P3 a declared target refuses outside a global Podman agent inside a Box', () => {
    const manifest = targetManifest();
    assert.equal(code(() => planExecutionTargetLaunch({ manifest, ...PLAN_INPUT, runMode: 'isolated' })), E.unsupported);
    assert.equal(code(() => planExecutionTargetLaunch({ manifest, ...PLAN_INPUT, runMode: 'devel' })), E.unsupported);
    assert.equal(code(() => planExecutionTargetLaunch({ manifest, ...PLAN_INPUT, runtime: 'docker' })), E.unsupported);
    assert.equal(code(() => planExecutionTargetLaunch({ manifest, ...PLAN_INPUT, runtime: 'bwrap' })), E.unsupported);
    assert.equal(code(() => planExecutionTargetLaunch({ manifest, ...PLAN_INPUT, insideBox: false })), E.unsupported);
    const plan = planExecutionTargetLaunch({ manifest, ...PLAN_INPUT });
    assert.deepEqual(plan.declaration, declaration());
    assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.declaration));
});

test('P3 journal-init runs the exact target image with no capability, no network, no pull and only the journal root', () => {
    assert.deepEqual([...journalInitRunArgs({ image: IMAGE, journalRoot: '/w/.ploinky/data/execution-targets/k/journal-root' })], [
        'run', '--rm', '--pull=never', '--network', 'none',
        '--cap-drop', 'all', '--security-opt', 'no-new-privileges',
        '--read-only', '--image-volume=ignore', '--user', '0:0',
        '--entrypoint', TARGET_HELPER_EXECUTABLE,
        '-v', `/w/.ploinky/data/execution-targets/k/journal-root:${TARGET_JOURNAL_PATH}:z`,
        IMAGE,
        'journal-init', '--root', TARGET_JOURNAL_PATH,
    ]);
    assert.equal(code(() => journalInitRunArgs({ image: 'a b', journalRoot: '/x' })), E.stateInvalid);
    assert.equal(code(() => journalInitRunArgs({ image: IMAGE, journalRoot: 'relative' })), E.stateInvalid);
});

test('P3 provisioning creates private dirs, records journal identity and dev/ino, and hands one incarnation over a single-use launch file', (t) => {
    const env = workspace(t);
    const helper = fakeHelper();
    const result = provision(env, helper);
    const paths = targetStatePaths(env.controllerStateDir, PRINCIPAL);

    assert.equal(helper.calls.length, 1);
    assert.deepEqual(helper.calls[0], [...journalInitRunArgs({ image: IMAGE, journalRoot: paths.journalRoot })]);
    // Exactly three binds at fixed in-target paths; the journal lives in controller state, the mailbox/control in the Box tmpfs.
    assert.deepEqual(result.binds.map((bind) => bind.target), [TARGET_MAILBOX_PATH, TARGET_JOURNAL_PATH, TARGET_CONTROL_PATH]);
    const [mailbox, journalRoot, control] = result.binds.map((bind) => bind.source);
    assert.equal(journalRoot, paths.journalRoot);
    assert.ok(journalRoot.startsWith(path.join(env.controllerStateDir, 'execution-targets') + path.sep));
    assert.ok(mailbox.startsWith(path.join(env.boxTmpRoot, BOX_TARGETS_DIRECTORY) + path.sep));
    assert.equal(path.dirname(mailbox), path.dirname(control));
    for (const directory of [paths.root, journalRoot, mailbox, control, path.dirname(mailbox), path.join(env.boxTmpRoot, BOX_TARGETS_DIRECTORY)]) {
        assert.equal(mode(directory), 0o700, directory);
    }
    // The controller state directory itself is never re-moded.
    assert.equal(mode(env.controllerStateDir), 0o700);

    const launch = path.join(control, HELPER_LAUNCH_FILE);
    assert.equal(mode(launch), 0o600);
    assert.equal(fs.readFileSync(launch, 'utf8'),
        `version=1\njournalStoreIdentity=${result.journalStoreIdentity}\nhelperIncarnation=${result.helperIncarnation}\n`);

    const record = readProvisioningRecord({ controllerStateDir: env.controllerStateDir, principal: PRINCIPAL });
    const journalStat = fs.lstatSync(paths.journal, { bigint: true });
    assert.deepEqual(record.journal, { storeIdentity: result.journalStoreIdentity, device: String(journalStat.dev), inode: String(journalStat.ino) });
    assert.equal(record.current.helperIncarnation, result.helperIncarnation);
    assert.equal(record.current.containerName, 'ploinky_rwrepo_rwtarget_abc');
    assert.deepEqual([record.current.instanceId, record.current.enableGeneration], ['inst-1', 'egen-1']);
    assert.deepEqual(record.incarnations, [result.helperIncarnation]);
    assert.equal(mode(paths.record), 0o600);
    assert.equal(fs.readdirSync(paths.root).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('P3 every helper start gets a fresh incarnation; the journal (keyed by principal) survives instance replacement', (t) => {
    const env = workspace(t);
    const helper = fakeHelper();
    const first = provision(env, helper);
    const second = provision(env, helper, { containerName: 'ploinky_rwrepo_rwtarget_candidate', instanceId: 'inst-2', enableGeneration: 'egen-2' });
    assert.notEqual(second.helperIncarnation, first.helperIncarnation);
    assert.equal(second.journalStoreIdentity, first.journalStoreIdentity);
    assert.equal(second.binds[1].source, first.binds[1].source);
    assert.notEqual(second.binds[0].source, first.binds[0].source);
    // The predecessor's instance directories are left in place (it may still be running).
    assert.ok(fs.existsSync(first.binds[0].source));
    const record = readProvisioningRecord({ controllerStateDir: env.controllerStateDir, principal: PRINCIPAL });
    assert.deepEqual(record.incarnations, [first.helperIncarnation, second.helperIncarnation]);
    assert.equal(record.current.instanceId, 'inst-2');
});

test('P3 a recorded incarnation is never issued again', (t) => {
    const env = workspace(t);
    const helper = fakeHelper();
    const fixed = () => Buffer.alloc(16, 9);
    provision(env, helper, { randomBytes: fixed });
    const before = fs.readFileSync(targetStatePaths(env.controllerStateDir, PRINCIPAL).record, 'utf8');
    assert.equal(code(() => provision(env, helper, { instanceId: 'inst-2', randomBytes: fixed })), E.incarnationReused);
    assert.equal(fs.readFileSync(targetStatePaths(env.controllerStateDir, PRINCIPAL).record, 'utf8'), before);
});

test('P3 a lost or replaced journal refuses before the helper is asked to mint a new store', (t) => {
    const env = workspace(t);
    const helper = fakeHelper();
    provision(env, helper);
    const paths = targetStatePaths(env.controllerStateDir, PRINCIPAL);
    fs.rmSync(paths.journal, { recursive: true });
    assert.equal(code(() => provision(env, helper, { instanceId: 'inst-2' })), E.journalChanged);
    assert.equal(helper.calls.length, 1, 'no journal-init for a missing recorded journal');
    // A replacement directory may reuse the inode number. Then dev/ino cannot tell, but the helper refuses an empty
    // journal directory and a complete foreign store differs in store identity: never adopted either way.
    fs.mkdirSync(paths.journal, { mode: 0o700 });
    const empty = code(() => provision(env, helper, { instanceId: 'inst-3' }));
    assert.ok([E.journalChanged, E.journalUnavailable].includes(empty), empty);
    fs.writeFileSync(path.join(paths.journal, 'journal-store.json'), JSON.stringify({ version: 1, journalStoreIdentity: Buffer.alloc(16, 5).toString('base64url') }));
    assert.equal(code(() => provision(env, helper, { instanceId: 'inst-4' })), E.journalChanged);
    assert.equal(readProvisioningRecord({ controllerStateDir: env.controllerStateDir, principal: PRINCIPAL }).incarnations.length, 1);
});

test('P3 helper-reported identity must match the provisioned directory and the recorded store', (t) => {
    const env = workspace(t);
    const helper = fakeHelper();
    const first = provision(env, helper);
    const wrongInode = (args) => {
        const out = JSON.parse(helper.runner(args).stdout);
        out.value.inode = String(BigInt(out.value.inode) + 1n);
        return { status: 0, stdout: JSON.stringify(out) };
    };
    assert.equal(code(() => provision(env, { runner: wrongInode }, { instanceId: 'inst-2' })), E.journalUnavailable);
    const otherStore = (args) => {
        const out = JSON.parse(helper.runner(args).stdout);
        out.value.journalStoreIdentity = Buffer.alloc(16, 3).toString('base64url');
        return { status: 0, stdout: JSON.stringify(out) };
    };
    assert.equal(code(() => provision(env, { runner: otherStore }, { instanceId: 'inst-3' })), E.journalChanged);
    for (const bad of [{ status: 75, stdout: '' }, { status: 0, stdout: 'not json' }, { status: 0, stdout: '{"ok":false,"error":{"code":"journal_unavailable"}}' },
        { error: new Error('timeout'), status: null, stdout: '' }]) {
        assert.equal(code(() => provision(env, { runner: () => bad }, { instanceId: 'inst-4' })), E.journalUnavailable);
    }
    const record = readProvisioningRecord({ controllerStateDir: env.controllerStateDir, principal: PRINCIPAL });
    assert.deepEqual(record.incarnations, [first.helperIncarnation], 'refused starts record nothing');
});

test('P3 a missing controller state directory refuses and creates nothing', (t) => {
    const env = workspace(t);
    fs.rmSync(env.controllerStateDir, { recursive: true });
    const helper = fakeHelper();
    assert.equal(code(() => provision(env, helper)), E.stateInvalid);
    assert.equal(fs.existsSync(env.controllerStateDir), false);
    assert.equal(helper.calls.length, 0);
});

test('P3 a symlinked execution-target root or record refuses', (t) => {
    const env = workspace(t);
    const elsewhere = path.join(env.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(env.controllerStateDir, 'execution-targets'));
    assert.equal(code(() => provision(env, fakeHelper())), E.stateInvalid);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('P3 a launch that may adopt the already provisioned exact instance re-derives it: no new incarnation, no move', (t) => {
    const env = workspace(t);
    const helper = fakeHelper();
    const first = provision(env, helper);
    const before = fs.readFileSync(targetStatePaths(env.controllerStateDir, PRINCIPAL).record, 'utf8');
    const again = provision(env, helper);
    assert.deepEqual(again.binds, first.binds);
    assert.equal(again.helperIncarnation, first.helperIncarnation);
    assert.equal(helper.calls.length, 1, 'no second journal-init');
    assert.equal(fs.readFileSync(targetStatePaths(env.controllerStateDir, PRINCIPAL).record, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.dirname(path.dirname(first.binds[0].source))), [path.basename(path.dirname(first.binds[0].source))]);
    // The launch file stays single-use: once the first helper consumed it, nothing re-creates it.
    fs.rmSync(path.join(first.binds[2].source, HELPER_LAUNCH_FILE));
    provision(env, helper);
    assert.equal(fs.existsSync(path.join(first.binds[2].source, HELPER_LAUNCH_FILE)), false);
});

test('P3 a left-over instance directory the record does not name is set aside, never reused', (t) => {
    const env = workspace(t);
    const helper = fakeHelper();
    const key = instanceKey({ principal: PRINCIPAL, containerName: 'ploinky_rwrepo_rwtarget_abc', instanceId: 'inst-1', enableGeneration: 'egen-1' });
    const left = instancePaths(env.boxTmpRoot, key);
    fs.mkdirSync(left.mailbox, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(left.mailbox, 'stale.sock'), '');
    const result = provision(env, helper);
    assert.equal(result.binds[0].source, left.mailbox);
    assert.deepEqual(fs.readdirSync(left.mailbox), []);
    const parked = fs.readdirSync(left.parent).filter((name) => name.startsWith(`${key}.stale-`));
    assert.equal(parked.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(left.parent, parked[0], 'mailbox')), ['stale.sock']);
});

test('P3 adopting the running provisioned instance re-derives its binds without minting or provisioning', (t) => {
    const env = workspace(t);
    const helper = fakeHelper();
    const first = provision(env, helper);
    const adopted = provision(env, { runner: () => assert.fail('no journal-init on adoption') }, { adoptOnly: true });
    assert.deepEqual(adopted.binds, first.binds);
    assert.equal(adopted.helperIncarnation, first.helperIncarnation);
    assert.ok(fs.existsSync(path.join(first.binds[2].source, HELPER_LAUNCH_FILE)), 'adoption writes no launch file');
    assert.equal(code(() => provision(env, helper, { adoptOnly: true, instanceId: 'inst-x' })), E.adoptionMismatch);
    fs.rmSync(first.binds[0].source, { recursive: true });
    assert.equal(code(() => provision(env, helper, { adoptOnly: true })), E.adoptionMismatch);
    assert.equal(readProvisioningRecord({ controllerStateDir: env.controllerStateDir, principal: PRINCIPAL }).incarnations.length, 1);
});

test('P3 discovery reads helper facts of the exact provisioned instance through readHelper', (t) => {
    const env = workspace(t);
    const first = provision(env, fakeHelper());
    const record = { type: 'agent', repoName: 'rwrepo', agentName: 'rwtarget', runtime: 'podman', runMode: 'global',
        containerId: '1'.repeat(64), instanceId: 'inst-1', enableGeneration: 'egen-1' };
    const facts = readExecutionTargetHelperFacts(record, { controllerStateDir: env.controllerStateDir });
    assert.deepEqual(facts, { helperIncarnation: first.helperIncarnation, prepared: true, journal: 'available', attestation: null, activeExecutions: 0 });
    assert.equal(readExecutionTargetHelperFacts({ ...record, instanceId: 'inst-other' }, { controllerStateDir: env.controllerStateDir }), null);
    assert.equal(readExecutionTargetHelperFacts({ ...record, agentName: 'other' }, { controllerStateDir: env.controllerStateDir }), null);

    const result = discoverExecutionTargets({
        live: { workspaceId: 'workspace:x', boxIdentity: 'ploinky-box-ws-x', boxGeneration: 'f'.repeat(64) },
        readRegistry: () => ({ agents: { ploinky_rwrepo_rwtarget_abc: record } }),
        readManifest: () => targetManifest(),
        readInstance: () => ({ running: true, containerId: '1'.repeat(64) }),
        readHelper: (item) => readExecutionTargetHelperFacts(item, { controllerStateDir: env.controllerStateDir }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.entries[0].helperIncarnation, first.helperIncarnation);
    assert.equal(result.value.entries[0].prepared, true);
    assert.equal(result.value.entries[0].journal, 'available');
    assert.deepEqual(result.value.diagnostics[0].reasons, []);

    fs.rmSync(targetStatePaths(env.controllerStateDir, PRINCIPAL).journal, { recursive: true });
    assert.equal(readExecutionTargetHelperFacts(record, { controllerStateDir: env.controllerStateDir }).journal, 'unavailable');
});

test('P3 the start boundary provisions only behind the plan and renders the binds after the controller-state guards', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'cli/sandbox/docker/agentServiceManager.js'), 'utf8');
    const start = text.indexOf('function startAgentContainer(');
    const body = text.slice(start, text.indexOf('\nfunction ', start + 1));
    const planAt = body.indexOf('const executionTargetPlan = planExecutionTargetLaunch({');
    const provisionAt = body.indexOf('const executionTargetProvisioning = executionTargetPlan\n        ? provisionExecutionTarget({');
    const guardAt = body.indexOf('appendControllerStateGuards(args, runtime);');
    const bindsAt = body.indexOf('for (const bind of executionTargetProvisioning?.binds || []) {');
    const imageAt = body.indexOf("args.push('--entrypoint', AGENT_CONTROL_ENTRYPOINT);");
    assert.ok(planAt > 0 && provisionAt > planAt && guardAt > provisionAt && bindsAt > guardAt && imageAt > bindsAt);
    assert.match(body.slice(planAt, provisionAt), /runMode: launchRecord\.runMode \|\| 'isolated',\n\s+runtime,\n\s+insideBox: isPloinkyBoxRuntime\(\),/);
    // Nothing else of the start path reads the plan or the provisioning result.
    assert.equal(body.match(/executionTargetPlan/g).length, 4);
    assert.equal(body.match(/executionTargetProvisioning/g).length, 3);
    // The reserved-root overlap check runs on the final argument list immediately before the target binds.
    assert.ok(body.includes('if (executionTargetProvisioning) assertExecutionTargetMountsReserved(args);\n    for (const bind of executionTargetProvisioning?.binds || []) {'));
});

test('P3 no other grant may equal, contain or sit inside the target runtime root', async () => {
    const { assertExecutionTargetMountsReserved } = await import('../../cli/sandbox/docker/agentServiceManager.js');
    // Every Ploinky-owned /run bind seen on a live target (r2 inspect), plus ordinary grants.
    const ok = ['-v', '/ws:/ws:z', '--tmpfs', '/tmp:rw', '-v', '/k:/run/ploinky-agent.key:ro',
        '-v', '/d:/run/ploinky/router-descriptor.json:ro', '-v', '/tmp/ploinky-health-probes/x:/run/ploinky-health-probes:z',
        '-v', '/e:/run/ploinky-edge-topology:z,ro', '-v', '/b:/srv/ploinky-targetx', '-v', '/l:/var/lock', '-v', '/o:/run/other'];
    assert.doesNotThrow(() => assertExecutionTargetMountsReserved(ok));
    for (const bad of [
        ['-v', '/ws/dir:/run/ploinky-target/journal/journal'],
        ['--volume=/ws/m:/run/ploinky-target/mailbox:ro'],
        ['-v', '/ws/x:/run/ploinky-target'],
        ['-v', '/ws/r:/run'],
        ['--tmpfs', '/run/ploinky-target/control'],
        ['--mount', 'type=bind,source=/ws/q,target=/run/ploinky-target/mailbox/s'],
        ['-v', '/ws/v:/var/run/ploinky-target/mailbox'],
        ['-v', '/ws/v:/opt/ploinky-target/mailbox'],
        ['-v', '/ws/v:/var/run//ploinky-target/../ploinky-target'],
    ]) assert.throws(() => assertExecutionTargetMountsReserved([...ok, ...bad]), /overlaps another mount/, JSON.stringify(bad));
});

test('P3 an identity-preserving targeted restart of an execution target refuses before any effect', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'cli/sandbox/docker/agentServiceManager.js'), 'utf8');
    const start = text.indexOf('function ensureAgentService(');
    const body = text.slice(start, text.indexOf('\nfunction ', start + 1));
    const refuseAt = body.indexOf("error.code = 'PLOINKY_EXECUTION_TARGET_RESTART_UNSUPPORTED';");
    const drainAt = body.indexOf('drainTargetedContainer(containerName, drainOptions)');
    const lockAt = body.indexOf('return withNetworkLifecycleLock(');
    assert.ok(refuseAt > 0 && refuseAt < lockAt && refuseAt < drainAt, 'refusal precedes the lock and every drain');
    assert.match(body.slice(0, refuseAt), /if \(targetedRestart && planExecutionTargetLaunch\(\{ manifest,/);
});

test('P4 each helper start gets one 32-byte ticket secret in exactly two 0600 copies, the Router copy outside every bind source', (t) => {
    const env = workspace(t);
    const spy = secretSpy();
    const result = provision(env, fakeHelper(), { secretRandomBytes: spy.draw });
    assert.equal(spy.drawn.length, 1);
    const secret = spy.drawn[0];
    assert.equal(secret.length, 32);
    assert.ok(spy.handed[0].equals(Buffer.alloc(32)), 'the drawn buffer is zeroed once written');

    const key = instanceKey({ principal: PRINCIPAL, containerName: 'ploinky_rwrepo_rwtarget_abc', instanceId: 'inst-1', enableGeneration: 'egen-1' });
    const instance = instancePaths(env.boxTmpRoot, key);
    const control = result.binds[2].source;
    assert.equal(instance.secret, path.join(control, HELPER_SECRET_FILE));
    assert.equal(instance.routerSecret, path.join(path.dirname(control), ROUTER_SECRET_FILE));
    const expected = `version=1\nhelperIncarnation=${result.helperIncarnation}\nkid=hti1.${result.helperIncarnation}\nsecret=${secret.toString('base64url')}\n`;
    for (const file of [instance.secret, instance.routerSecret]) {
        assert.equal(mode(file), 0o600, file);
        assert.ok(fs.lstatSync(file).isFile());
        assert.equal(fs.readFileSync(file, 'utf8'), expected, file);
    }
    // The launch file keeps its exact three lines: the secret never passes through launcher variables.
    assert.equal(fs.readFileSync(instance.launch, 'utf8'),
        `version=1\njournalStoreIdentity=${result.journalStoreIdentity}\nhelperIncarnation=${result.helperIncarnation}\n`);
    // The Router copy is never under a bind source; the helper copy is only in the bound control directory.
    for (const bind of result.binds) assert.equal(inside(bind.source, instance.routerSecret), false, bind.source);
    assert.deepEqual(result.binds.filter((bind) => inside(bind.source, instance.secret)).map((bind) => bind.target), [TARGET_CONTROL_PATH]);
    // Neither the return value nor the controller-private record carries the secret in any encoding.
    assert.deepEqual(Object.keys(result).sort(), ['binds', 'helperIncarnation', 'instanceKey', 'journalStoreIdentity']);
    const returned = JSON.stringify(result);
    const recordText = fs.readFileSync(targetStatePaths(env.controllerStateDir, PRINCIPAL).record, 'utf8');
    for (const text of encodings(secret)) {
        assert.equal(returned.includes(text), false);
        assert.equal(recordText.includes(text), false);
    }
    assert.deepEqual(Object.keys(JSON.parse(recordText).current).sort(),
        ['containerName', 'enableGeneration', 'helperIncarnation', 'instanceId', 'instanceKey', 'issuedAtMs']);
});

test('P4 both secret copies match the shared literal vector byte for byte', (t) => {
    const env = workspace(t);
    const result = provision(env, fakeHelper(), { randomBytes: () => Buffer.alloc(16, 2), secretRandomBytes: () => Buffer.alloc(32, 0x11) });
    assert.equal(result.helperIncarnation, 'AgICAgICAgICAgICAgICAg');
    const instance = instancePaths(env.boxTmpRoot, result.instanceKey);
    assert.deepEqual(fs.readFileSync(instance.secret), Buffer.from(VECTOR_TEXT, 'utf8'));
    assert.deepEqual(fs.readFileSync(instance.routerSecret), Buffer.from(VECTOR_TEXT, 'utf8'));
});

test('P4 a secret draw that is not exactly 32 bytes refuses before any instance directory or record exists', (t) => {
    const env = workspace(t);
    for (const bad of [() => Buffer.alloc(31, 1), () => Buffer.alloc(33, 1), () => Buffer.alloc(0), () => 'x'.repeat(32),
        () => new Uint8Array(32), () => null]) {
        assert.equal(code(() => provision(env, fakeHelper(), { secretRandomBytes: bad })), E.stateInvalid);
        assert.equal(fs.existsSync(path.join(env.boxTmpRoot, BOX_TARGETS_DIRECTORY)), false);
        assert.equal(readProvisioningRecord({ controllerStateDir: env.controllerStateDir, principal: PRINCIPAL }), null);
    }
    // A reused incarnation refuses before any secret is drawn.
    const fixed = () => Buffer.alloc(16, 9);
    provision(env, fakeHelper(), { randomBytes: fixed });
    let draws = 0;
    assert.equal(code(() => provision(env, fakeHelper(), { instanceId: 'inst-2', randomBytes: fixed,
        secretRandomBytes: (n) => { draws += 1; return crypto.randomBytes(n); } })), E.incarnationReused);
    assert.equal(draws, 0);
});

test('P4 a set-aside left-over instance keeps no launch file and no secret copy', (t) => {
    const env = workspace(t);
    const key = instanceKey({ principal: PRINCIPAL, containerName: 'ploinky_rwrepo_rwtarget_abc', instanceId: 'inst-1', enableGeneration: 'egen-1' });
    const left = instancePaths(env.boxTmpRoot, key);
    fs.mkdirSync(left.mailbox, { recursive: true, mode: 0o700 });
    fs.mkdirSync(left.control, { mode: 0o700 });
    fs.writeFileSync(path.join(left.mailbox, 'stale.sock'), '');
    for (const file of [left.launch, left.secret, left.routerSecret]) fs.writeFileSync(file, 'old secret material\n', { mode: 0o600 });
    const spy = secretSpy();
    provision(env, fakeHelper(), { secretRandomBytes: spy.draw });
    const parked = fs.readdirSync(left.parent).filter((name) => name.startsWith(`${key}.stale-`));
    assert.equal(parked.length, 1);
    const stale = path.join(left.parent, parked[0]);
    assert.deepEqual(fs.readdirSync(path.join(stale, 'mailbox')), ['stale.sock']);
    assert.deepEqual(fs.readdirSync(path.join(stale, 'control')), []);
    assert.deepEqual(fs.readdirSync(stale).sort(), ['control', 'mailbox']);
    // The new instance has fresh copies.
    assert.ok(fs.readFileSync(left.routerSecret, 'utf8').includes(spy.drawn[0].toString('base64url')));
    assert.ok(fs.readFileSync(left.secret, 'utf8').includes(spy.drawn[0].toString('base64url')));
});

test('P4 a left-over whose secret path cannot be removed, or whose control path is a symlink, refuses before the set-aside', (t) => {
    const env = workspace(t);
    const key = instanceKey({ principal: PRINCIPAL, containerName: 'ploinky_rwrepo_rwtarget_abc', instanceId: 'inst-1', enableGeneration: 'egen-1' });
    const left = instancePaths(env.boxTmpRoot, key);
    fs.mkdirSync(left.control, { recursive: true, mode: 0o700 });
    fs.mkdirSync(left.secret);
    assert.equal(code(() => provision(env, fakeHelper())), E.stateInvalid);
    assert.deepEqual(fs.readdirSync(left.parent), [key], 'nothing set aside');
    assert.equal(readProvisioningRecord({ controllerStateDir: env.controllerStateDir, principal: PRINCIPAL }), null);

    fs.rmSync(left.control, { recursive: true });
    const elsewhere = path.join(env.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, HELPER_LAUNCH_FILE), 'keep');
    fs.writeFileSync(path.join(elsewhere, HELPER_SECRET_FILE), 'keep');
    fs.symlinkSync(elsewhere, left.control);
    assert.equal(code(() => provision(env, fakeHelper())), E.stateInvalid);
    assert.deepEqual(fs.readdirSync(elsewhere).sort(), [HELPER_LAUNCH_FILE, HELPER_SECRET_FILE].sort(), 'never unlinks through a symlink');
    assert.deepEqual(fs.readdirSync(left.parent), [key]);
});

test('P4 adopting the provisioned instance draws no secret and leaves both copies and the record byte-identical', (t) => {
    const env = workspace(t);
    const helper = fakeHelper();
    const first = provision(env, helper);
    const instance = instancePaths(env.boxTmpRoot, first.instanceKey);
    const recordPath = targetStatePaths(env.controllerStateDir, PRINCIPAL).record;
    const before = [instance.secret, instance.routerSecret, instance.launch, recordPath].map((file) => fs.readFileSync(file));
    const noDraw = () => assert.fail('no secret is drawn on adoption');
    provision(env, helper, { secretRandomBytes: noDraw });
    provision(env, { runner: () => assert.fail('no journal-init on adoption') }, { adoptOnly: true, secretRandomBytes: noDraw });
    assert.deepEqual([instance.secret, instance.routerSecret, instance.launch, recordPath].map((file) => fs.readFileSync(file)), before);
    // A helper that already consumed its copy does not get a new one from a re-derivation.
    fs.rmSync(instance.secret);
    provision(env, helper, { secretRandomBytes: noDraw });
    assert.equal(fs.existsSync(instance.secret), false);
});

test('P4 a new incarnation changes secret and kid and retires the previous Router copy; the predecessor dirs stay', (t) => {
    const env = workspace(t);
    const helper = fakeHelper();
    const spy = secretSpy();
    const first = provision(env, helper, { secretRandomBytes: spy.draw });
    const second = provision(env, helper, { containerName: 'ploinky_rwrepo_rwtarget_candidate', instanceId: 'inst-2', enableGeneration: 'egen-2',
        secretRandomBytes: spy.draw });
    assert.equal(spy.drawn.length, 2);
    assert.equal(spy.drawn[0].equals(spy.drawn[1]), false);
    const old = instancePaths(env.boxTmpRoot, first.instanceKey);
    const now = instancePaths(env.boxTmpRoot, second.instanceKey);
    assert.equal(fs.existsSync(old.routerSecret), false, 'the superseded Router copy is retired');
    assert.ok(fs.existsSync(old.mailbox) && fs.existsSync(old.control), 'the predecessor may still be running');
    const text = fs.readFileSync(now.routerSecret, 'utf8');
    assert.ok(text.includes(`kid=hti1.${second.helperIncarnation}\n`) && text.includes(spy.drawn[1].toString('base64url')));
    assert.notEqual(first.helperIncarnation, second.helperIncarnation);
});

test('P4 a lost instance directory of the same identity is re-provisioned without retiring the fresh copy', (t) => {
    const env = workspace(t);
    const helper = fakeHelper();
    const first = provision(env, helper);
    const instance = instancePaths(env.boxTmpRoot, first.instanceKey);
    fs.rmSync(instance.root, { recursive: true });
    const spy = secretSpy();
    const again = provision(env, helper, { secretRandomBytes: spy.draw });
    assert.equal(again.instanceKey, first.instanceKey);
    assert.notEqual(again.helperIncarnation, first.helperIncarnation);
    assert.equal(mode(instance.routerSecret), 0o600);
    assert.ok(fs.readFileSync(instance.routerSecret, 'utf8').includes(`kid=hti1.${again.helperIncarnation}\nsecret=${spy.drawn[0].toString('base64url')}\n`));
});

test('P4 retiring the previous Router copy is best effort: an unremovable copy or an unreadable root never fails the start', (t) => {
    const env = workspace(t);
    const helper = fakeHelper();
    const first = provision(env, helper);
    const old = instancePaths(env.boxTmpRoot, first.instanceKey);
    // An unlink that fails with something other than ENOENT (EISDIR here).
    fs.rmSync(old.routerSecret);
    fs.mkdirSync(old.routerSecret);
    const second = provision(env, helper, { containerName: 'ploinky_rwrepo_rwtarget_b', instanceId: 'inst-2', enableGeneration: 'egen-2' });
    assert.equal(readProvisioningRecord({ controllerStateDir: env.controllerStateDir, principal: PRINCIPAL }).current.helperIncarnation,
        second.helperIncarnation);
    assert.ok(fs.lstatSync(old.routerSecret).isDirectory(), 'left in place');
    assert.ok(fs.existsSync(instancePaths(env.boxTmpRoot, second.instanceKey).routerSecret));
    // An lstat of the previous root that throws (not ENOENT).
    const prev = instancePaths(env.boxTmpRoot, second.instanceKey);
    const failingFs = {
        ...fs,
        lstatSync: (target, ...rest) => {
            if (target === prev.root) throw Object.assign(new Error('denied'), { code: 'EACCES' });
            return fs.lstatSync(target, ...rest);
        },
    };
    const third = provision(env, helper, { containerName: 'ploinky_rwrepo_rwtarget_c', instanceId: 'inst-3', enableGeneration: 'egen-3', fsApi: failingFs });
    assert.equal(readProvisioningRecord({ controllerStateDir: env.controllerStateDir, principal: PRINCIPAL }).current.helperIncarnation,
        third.helperIncarnation);
    assert.ok(fs.existsSync(prev.routerSecret), 'not retired when its root cannot be inspected');
});
