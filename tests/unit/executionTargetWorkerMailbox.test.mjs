import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXECUTION_TARGET_HELPER_CONTRACT_ID, TARGET_LIMITS_V1 } from '../../cli/server/executionTarget/declaration.mjs';
import { readExecutionProviderDeclaration } from '../../cli/server/executionProvider/declaration.mjs';
import {
    BOX_MAILBOXES_DIRECTORY,
    PROVISIONING_ERROR_CODES as E,
    TARGET_JOURNAL_PATH,
    mailboxRootPath,
    planExecutionTargetLaunch,
    provisionExecutionTarget,
    readProvisioningRecord,
    targetStatePaths,
} from '../../cli/server/executionTarget/provisioning.mjs';
import {
    WORKER_MAILBOX_ERROR_CODES,
    WORKER_TARGETS_PATH,
    ensureMailboxRoot,
    planWorkerMailboxGrant,
    retireInstanceMailboxes,
} from '../../cli/server/executionTarget/workerMailbox.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TARGET = 'agent:rwrepo/rwtarget';
const IMAGE = `localhost/rwtarget@sha256:${'e'.repeat(64)}`;
const BOX_TMP = '/tmp';
const digest = (char) => char.repeat(64);

// ---- fixtures ----

const provider = (port = 7300) => ({ version: 1, port, terminals: { path: '/terminal-control' } });
const workerManifest = (extra = {}) => ({ container: 'localhost/rwworker:x', executionProvider: provider(), ...extra });

function targetDeclaration() {
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
const targetManifest = () => ({ container: IMAGE, containerSecurity: { nestedPodman: true }, executionTarget: targetDeclaration() });

const agentRecord = (repoName, agentName, extra = {}) => ({
    type: 'agent', repoName, agentName, instanceId: `${agentName}-inst`, enableGeneration: `${agentName}-egen`, ...extra,
});

// Manifests by route key; a route key absent from the map has no route (null), `throws` marks an unreadable manifest.
function manifestReader(byRouteKey) {
    return ({ routeKey }) => {
        if (!Object.hasOwn(byRouteKey, routeKey)) return null;
        if (byRouteKey[routeKey] === 'throws') throw new Error('unreadable manifest');
        return byRouteKey[routeKey];
    };
}

const OWN = Object.freeze({ containerName: 'ploinky_rwrepo_rwworker_ws', predecessor: null });

function plan(overrides = {}) {
    const { manifests = {}, ...rest } = overrides;
    return planWorkerMailboxGrant({
        manifest: workerManifest(),
        routeKey: 'rwworker',
        repoName: 'rwrepo',
        agentName: 'rwworker',
        runtime: 'podman',
        insideBox: true,
        registry: {},
        readManifestOf: manifestReader(manifests),
        readProviderDeclaration: readExecutionProviderDeclaration,
        boxTmpRoot: BOX_TMP,
        listMailboxRootHolders: () => [],
        ownContainers: OWN,
        ...rest,
    });
}

const GRANT = { source: path.join(BOX_TMP, BOX_MAILBOXES_DIRECTORY), target: WORKER_TARGETS_PATH, readOnly: true };

function code(fn) {
    try {
        fn();
    } catch (error) {
        return error.code;
    }
    return null;
}

function workspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmbx-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const controllerStateDir = path.join(root, 'ws', '.ploinky', 'data');
    const boxTmpRoot = path.join(root, 'boxtmp');
    fs.mkdirSync(controllerStateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(boxTmpRoot, { mode: 0o1777 });
    return { root, controllerStateDir, boxTmpRoot };
}

// The target helper's journal-init stand-in (as in executionTargetProvisioning.test.mjs).
function journalRunner(args) {
    const volume = args[args.indexOf('-v') + 1];
    const journal = path.join(volume.slice(0, volume.indexOf(`:${TARGET_JOURNAL_PATH}`)), 'journal');
    if (!fs.existsSync(journal)) {
        fs.mkdirSync(journal, { mode: 0o700 });
        fs.writeFileSync(path.join(journal, 'journal-store.json'), JSON.stringify({ version: 1, journalStoreIdentity: crypto.randomBytes(16).toString('base64url') }));
    }
    const identity = JSON.parse(fs.readFileSync(path.join(journal, 'journal-store.json'), 'utf8')).journalStoreIdentity;
    const stat = fs.lstatSync(journal, { bigint: true });
    return { status: 0, stdout: `${JSON.stringify({ ok: true, value: { device: String(stat.dev), inode: String(stat.ino), journalStoreIdentity: identity } })}\n` };
}

const INSTANCES = Object.freeze({
    a: Object.freeze({ containerName: 'ploinky_rwrepo_rwtarget_ws', instanceId: 'inst-a', enableGeneration: 'egen-a' }),
    b: Object.freeze({ containerName: 'ploinky_rwrepo_rwtarget_ws__candidate_b', instanceId: 'inst-b', enableGeneration: 'egen-b' }),
});

function provision(env, instance, overrides = {}) {
    return provisionExecutionTarget({
        plan: planExecutionTargetLaunch({ manifest: targetManifest(), runMode: 'global', runtime: 'podman', insideBox: true }),
        principal: TARGET,
        ...instance,
        image: IMAGE,
        controllerStateDir: env.controllerStateDir,
        boxTmpRoot: env.boxTmpRoot,
        runJournalInit: journalRunner,
        ...overrides,
    });
}

function retire(env, instance, overrides = {}) {
    return retireInstanceMailboxes({
        controllerStateDir: env.controllerStateDir, boxTmpRoot: env.boxTmpRoot, principal: TARGET, ...instance, ...overrides,
    });
}

const listMailboxes = (env) => fs.readdirSync(path.join(env.boxTmpRoot, BOX_MAILBOXES_DIRECTORY)).sort();
const mode = (target) => fs.lstatSync(target).mode & 0o777;

// ---- U2: the grant decision table ----

test('U2 an agent without a valid executionProvider declaration, outside Podman or outside a Box gets no mailbox bind', () => {
    for (const manifest of [{}, { container: 'node:24' }, targetManifest(), { container: 'x', routerAccess: { agentExec: true } }]) {
        assert.equal(plan({ manifest }), null, JSON.stringify(manifest));
    }
    // An invalid declaration (refused by its own publication check) is never a grant.
    assert.equal(plan({ manifest: workerManifest({ executionProvider: { version: 1, port: 7300 } }) }), null);
    for (const runtime of ['docker', 'bwrap', 'seatbelt', undefined]) assert.equal(plan({ runtime }), null, String(runtime));
    for (const insideBox of [false, undefined, 'true']) assert.equal(plan({ insideBox }), null, String(insideBox));
});

test('U2 the only provider principal gets exactly the read-only mailbox-only root at the fixed worker path', () => {
    const grant = plan();
    assert.deepEqual(grant, GRANT);
    assert.ok(Object.isFrozen(grant));
    assert.equal(grant.source, mailboxRootPath(BOX_TMP));
    // Ordinary agents and non-provider targets around it do not change that.
    const registry = {
        ploinky_rwrepo_rwtarget: agentRecord('rwrepo', 'rwtarget'),
        ploinky_demo_plain: agentRecord('demo', 'plain'),
        ploinky_demo_noroute: agentRecord('demo', 'noroute'),
    };
    assert.deepEqual(plan({ registry, manifests: { rwtarget: targetManifest(), plain: { container: 'node:24' } } }), GRANT);
});

test('U2 several instances of the same provider principal are one holder and keep the grant', () => {
    const registry = {
        ploinky_rwrepo_rwworker: agentRecord('rwrepo', 'rwworker'),
        ploinky_rwrepo_rwworker_second: agentRecord('rwrepo', 'rwworker', { alias: 'second', instanceId: 'w2', enableGeneration: 'g2' }),
    };
    const manifests = { rwworker: workerManifest(), second: workerManifest() };
    assert.deepEqual(plan({ registry, manifests }), GRANT);
    assert.deepEqual(plan({ registry, manifests, routeKey: 'second' }), GRANT);
});

test('U2/R3 another enabled provider principal withholds the bind (both principals named); disabling it restores the grant', () => {
    const manifests = { other: workerManifest() };
    const enabled = { ploinky_demo_other: agentRecord('demo', 'other') };
    assert.deepEqual(plan({ registry: enabled, manifests }), { withheld: 'ambiguous', principals: ['agent:rwrepo/rwworker', 'agent:demo/other'] });
    // R3 in both directions: the worker's expected mounts change whenever the other provider is enabled or not.
    assert.deepEqual(plan({ registry: { ploinky_demo_other: agentRecord('demo', 'other', { enableGeneration: '' }) }, manifests }), GRANT);
    assert.deepEqual(plan({ registry: {}, manifests }), GRANT);
    // Its route carries no provider declaration (or no route at all): not a holder.
    assert.deepEqual(plan({ registry: enabled, manifests: { other: { container: 'node:24' } } }), GRANT);
    assert.deepEqual(plan({ registry: enabled, manifests: {} }), GRANT);
    // A routed manifest that cannot be read fails closed.
    assert.deepEqual(plan({ registry: enabled, manifests: { other: 'throws' } }), { withheld: 'ambiguous', principals: ['agent:rwrepo/rwworker', 'agent:demo/other'] });
    // Several others: all named, sorted after this one.
    const many = { ploinky_z_p: agentRecord('z', 'p'), ploinky_a_q: agentRecord('a', 'q') };
    assert.deepEqual(plan({ registry: many, manifests: { p: workerManifest(), q: workerManifest() } }).principals,
        ['agent:rwrepo/rwworker', 'agent:a/q', 'agent:z/p']);
});

test('U2 the grant mirrors the Router source-protection holder ACL over the same registry and manifests', async () => {
    const { sourceProtectionHolderCallers } = await import('../../cli/server/privateRouter.js');
    const cases = [
        {},
        { w: agentRecord('rwrepo', 'rwworker') },
        { w: agentRecord('rwrepo', 'rwworker'), o: agentRecord('demo', 'other') },
        { w: agentRecord('rwrepo', 'rwworker'), o: agentRecord('demo', 'other', { enableGeneration: '' }) },
        // First record of a principal decides, as in currentEnabledAgentIdentity.
        { o1: agentRecord('demo', 'other', { enableGeneration: '' }), o2: agentRecord('demo', 'other', { alias: 'o2' }) },
        { o1: agentRecord('demo', 'other', { alias: 'plainroute' }), o2: agentRecord('demo', 'other') },
        { w: agentRecord('rwrepo', 'rwworker'), w2: agentRecord('rwrepo', 'rwworker', { alias: 'second' }) },
    ];
    const manifests = { rwworker: workerManifest(), second: workerManifest(), other: workerManifest(), o2: workerManifest(), plainroute: { container: 'node:24' } };
    for (const agents of cases) {
        const holders = new Set(sourceProtectionHolderCallers({ agents, manifests }).map((caller) => caller.agentId));
        holders.delete('agent:rwrepo/rwworker');
        const grant = plan({ registry: agents, manifests });
        assert.equal(Boolean(grant.withheld), holders.size > 0, JSON.stringify(agents));
        if (grant.withheld) assert.deepEqual(grant.principals.slice(1), [...holders].sort());
    }
});

test('U2/L6 a manifest that declares both executionProvider and executionTarget refuses, wherever it would run', () => {
    const both = { ...targetManifest(), executionProvider: provider() };
    for (const overrides of [{}, { runtime: 'docker' }, { insideBox: false }]) {
        const error = (() => { try { plan({ manifest: both, ...overrides }); } catch (caught) { return caught; } return null; })();
        assert.equal(error?.code, WORKER_MAILBOX_ERROR_CODES.conflict);
        assert.equal(error.code, 'EXECUTION_WORKER_TARGET_CONFLICT');
        assert.equal(error.status, 422);
    }
    // An invalid provider declaration beside a target declaration refuses too (presence decides).
    assert.equal(code(() => plan({ manifest: { ...targetManifest(), executionProvider: { version: 1 } } })), 'EXECUTION_WORKER_TARGET_CONFLICT');
});

test('U2 the readers are injected, never defaulted', () => {
    assert.throws(() => plan({ readProviderDeclaration: undefined }), TypeError);
    assert.throws(() => plan({ readManifestOf: undefined }), TypeError);
    assert.throws(() => plan({ listMailboxRootHolders: undefined }), TypeError);
    assert.throws(() => plan({ boxTmpRoot: 'tmp' }), TypeError);
});

// ---- U3: the worker path is reserved against every other grant ----

test('U3 no other grant may equal, contain or sit inside the worker mailbox path', async () => {
    const { assertExecutionTargetMountsReserved } = await import('../../cli/sandbox/docker/agentServiceManager.js');
    const ok = ['-v', '/ws:/ws:z', '--tmpfs', '/tmp:rw', '-v', '/k:/run/ploinky-agent.key:ro',
        '-v', '/d:/run/ploinky/router-descriptor.json:ro', '-v', '/e:/run/ploinky-edge-topology:z,ro',
        '-v', '/b:/srv/ploinky-worker-targetsx', '-v', '/o:/run/other'];
    assert.doesNotThrow(() => assertExecutionTargetMountsReserved(ok, WORKER_TARGETS_PATH));
    for (const bad of [
        ['-v', '/ws/x:/run/ploinky-worker-targets/x'],
        ['-v', '/ws/r:/run'],
        ['-v', '/ws/v:/var/run/ploinky-worker-targets'],
        ['-v', '/ws/v:/run/ploinky-worker-targets'],
        ['--tmpfs', '/run/ploinky-worker-targets'],
        ['--mount', 'type=bind,source=/ws/q,target=/run/ploinky-worker-targets/inc/helper.sock'],
        ['-v', '/ws/v:/opt/ploinky-worker-targets'],
        ['-v', '/ws/root:/'],
    ]) assert.throws(() => assertExecutionTargetMountsReserved([...ok, ...bad], WORKER_TARGETS_PATH), /overlaps another mount/, JSON.stringify(bad));
});

// ---- U4: render order in startAgentContainer ----

function startAgentContainerBody() {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'cli/sandbox/docker/agentServiceManager.js'), 'utf8');
    const start = text.indexOf('function startAgentContainer(');
    return { text, body: text.slice(start, text.indexOf('\nfunction ', start + 1)) };
}

test('U4 the grant is decided beside the target plan and the bind is rendered after every guard and target bind', () => {
    const { text, body } = startAgentContainerBody();
    const targetPlanAt = body.indexOf('const executionTargetPlan = planExecutionTargetLaunch({');
    const grantAt = body.indexOf('const workerMailboxGrant = planWorkerMailboxGrant({');
    const provisionAt = body.indexOf('const executionTargetProvisioning = executionTargetPlan');
    const guardAt = body.indexOf('appendControllerStateGuards(args, runtime);');
    const targetBindsAt = body.indexOf('for (const bind of executionTargetProvisioning?.binds || []) {');
    const blockAt = body.indexOf('if (workerMailboxGrant?.source) {');
    const ensureAt = body.indexOf('ensureMailboxRoot({ boxTmpRoot: BOX_TMPFS.destination });');
    const adoptAt = body.indexOf("requireManagedAdoptionDirectory(workerMailboxGrant.source, 'worker target mailbox root', { requireOwner: true });");
    const reservedThenBind = 'assertExecutionTargetMountsReserved(args, WORKER_TARGETS_PATH);\n'
        + '        appendExactManagedBindMount(args, `${workerMailboxGrant.source}:${WORKER_TARGETS_PATH}:z,ro`);';
    const bindAt = body.indexOf(reservedThenBind);
    const imageAt = body.indexOf("args.push('--entrypoint', AGENT_CONTROL_ENTRYPOINT);");
    assert.ok(targetPlanAt > 0 && grantAt > targetPlanAt && provisionAt > grantAt, 'decided beside the target plan, before provisioning');
    assert.ok(guardAt > provisionAt && targetBindsAt > guardAt && blockAt > targetBindsAt, 'after the guards and the target binds');
    assert.ok(adoptAt > blockAt && ensureAt > adoptAt && bindAt > ensureAt && imageAt > bindAt,
        'root validated (adoption) or created, then the reserved check immediately before the read-only bind');
    // The grant inputs: Box decision, Podman runtime, the registry snapshot, routed manifests and the injected reader.
    assert.match(body.slice(grantAt, provisionAt), /runtime,\n\s+insideBox: isPloinkyBoxRuntime\(\),\n\s+registry: agentSnapshot,\n\s+readManifestOf: routedAgentManifestReader\(\),\n\s+readProviderDeclaration: readExecutionProviderDeclaration,\n\s+boxTmpRoot: BOX_TMPFS\.destination,\n\s+listMailboxRootHolders: \(source\) => runningMailboxRootHolders\(runtime, source\),\n\s+ownContainers: \{\n\s+containerName,\n\s+predecessor: options\.replacementPredecessor\n/);
    // ensureAgentService hands the exact replaced predecessor to the launch.
    assert.ok(text.includes('replacementPredecessor: options.replacementPredecessor || null,'));
    // Exactly one bind to the worker path anywhere, and it is read-only.
    assert.equal(text.match(/WORKER_TARGETS_PATH\}/g).length, 1);
    // A withheld grant prints one stderr line naming the principals.
    assert.match(body, /\} else if \(workerMailboxGrant\?\.withheld === 'held-elsewhere'\) \{\n\s+console\.error\(`\[start\] \$\{repoName\}\/\$\{agentName\}: target mailboxes withheld from this worker: the mailbox root is already held by another container/);
    assert.match(body, /if \(workerMailboxGrant\?\.withheld === 'ambiguous'\) \{\n\s+console\.error\(`\[start\] \$\{repoName\}\/\$\{agentName\}: target mailboxes withheld from this worker: more than one execution provider is enabled \(\$\{workerMailboxGrant\.principals\.join\(', '\)\}\)`\);\n\s+\}/);
});

test('U4 mailboxes are retired only after a proven exact removal; predecessor retirement keeps the current incarnation', () => {
    const { text } = startAgentContainerBody();
    const section = (name) => {
        const start = text.indexOf(name);
        assert.ok(start >= 0, name);
        return text.slice(start, text.indexOf('\n}\n', start));
    };
    const remover = section('function removeExactGenerationCandidate({');
    const provenAt = remover.indexOf("if (cleanup.removed !== true && cleanup.state !== 'absent') {");
    const retireAt = remover.indexOf('retireRemovedTargetMailboxes(containerName, record, { keepCurrent: keepCurrentMailbox });');
    assert.ok(provenAt > 0 && retireAt > provenAt);
    assert.match(remover, /keepCurrentMailbox = false,/);
    assert.match(section('export function retireExactAgentRuntimePredecessor('), /keepCurrentMailbox: true,\n\s+\}\);/);
    const recreate = section('function removeContainerForRecreate(');
    const recreateProvenAt = recreate.indexOf("if (result?.removed !== true && result?.state !== 'absent') {");
    const recreateRetireAt = recreate.indexOf('retireRemovedTargetMailboxes(containerName, exactRecord, { keepCurrent: true });');
    assert.ok(recreateProvenAt > 0 && recreateRetireAt > recreateProvenAt);
    // The helper acts only inside a Box and never throws.
    const helper = section('function retireRemovedTargetMailboxes(');
    assert.match(helper, /if \(!isPloinkyBoxRuntime\(\) \|\| !record\?\.repoName \|\| !record\?\.agentName\) return;/);
    assert.match(helper, /\} catch \(_\) \{\}$/);
    assert.equal(text.match(/\bretireRemovedTargetMailboxes\(/g).length, 3, 'definition plus the two removal sites');
});

// ---- R2: worker start before any target ----

test('R2 a worker started before any target creates the private mailbox root; a later target lands in that same directory', (t) => {
    const env = workspace(t);
    const root = path.join(env.boxTmpRoot, BOX_MAILBOXES_DIRECTORY);
    assert.equal(fs.existsSync(root), false);
    assert.equal(ensureMailboxRoot({ boxTmpRoot: env.boxTmpRoot }), root);
    assert.equal(mode(root), 0o700);
    const before = fs.lstatSync(root);
    assert.equal(ensureMailboxRoot({ boxTmpRoot: env.boxTmpRoot }), root, 'idempotent');
    const result = provision(env, INSTANCES.a);
    const after = fs.lstatSync(root);
    assert.deepEqual([after.dev, after.ino], [before.dev, before.ino], 'the bound root is never replaced');
    assert.equal(path.dirname(result.binds[0].source), root);
    // A group/other-accessible root is tightened like every other private directory.
    fs.chmodSync(root, 0o755);
    ensureMailboxRoot({ boxTmpRoot: env.boxTmpRoot });
    assert.equal(mode(root), 0o700);
});

test('R2 a symlinked, non-directory or foreign mailbox root, or a missing Box tmpfs, refuses', (t) => {
    const env = workspace(t);
    const root = path.join(env.boxTmpRoot, BOX_MAILBOXES_DIRECTORY);
    const elsewhere = path.join(env.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, root);
    assert.equal(code(() => ensureMailboxRoot({ boxTmpRoot: env.boxTmpRoot })), E.stateInvalid);
    fs.unlinkSync(root);
    fs.writeFileSync(root, '');
    assert.equal(code(() => ensureMailboxRoot({ boxTmpRoot: env.boxTmpRoot })), E.stateInvalid);
    fs.unlinkSync(root);
    assert.equal(code(() => ensureMailboxRoot({ boxTmpRoot: env.boxTmpRoot, euid: process.geteuid() + 1 })), E.stateInvalid);
    assert.equal(code(() => ensureMailboxRoot({ boxTmpRoot: path.join(env.root, 'missing') })), E.stateInvalid);
    assert.equal(fs.existsSync(path.join(env.root, 'missing')), false);
    assert.equal(code(() => ensureMailboxRoot({ boxTmpRoot: 'relative' })), E.stateInvalid);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
});

// ---- U5: exact-instance retirement ----

test('U5 the previous mailbox survives provisioning; predecessor retirement leaves only the current one', (t) => {
    const env = workspace(t);
    const first = provision(env, INSTANCES.a);
    const second = provision(env, INSTANCES.b);
    assert.deepEqual(listMailboxes(env), [first.helperIncarnation, second.helperIncarnation].sort());
    fs.writeFileSync(path.join(first.binds[0].source, 'helper.sock'), '');
    assert.deepEqual(retire(env, INSTANCES.a, { keepCurrent: true }), { removed: [first.helperIncarnation] });
    assert.deepEqual(listMailboxes(env), [second.helperIncarnation]);
    // Idempotent: a second retirement of the same instance finds nothing.
    assert.deepEqual(retire(env, INSTANCES.a, { keepCurrent: true }), { removed: [] });
    // The record is not rewritten by retirement.
    assert.equal(readProvisioningRecord({ controllerStateDir: env.controllerStateDir, principal: TARGET }).current.helperIncarnation, second.helperIncarnation);
});

test('U5 a removed failed candidate deletes only its own mailbox; predecessor retirement never deletes the current one', (t) => {
    const env = workspace(t);
    const first = provision(env, INSTANCES.a);
    const candidate = provision(env, INSTANCES.b);
    // Predecessor-retirement mode never touches the current incarnation, even for its own tuple.
    assert.deepEqual(retire(env, INSTANCES.b, { keepCurrent: true }), { removed: [] });
    assert.deepEqual(listMailboxes(env), [first.helperIncarnation, candidate.helperIncarnation].sort());
    // The failed candidate's proven removal deletes exactly its mailbox; the still-running predecessor keeps its own.
    assert.deepEqual(retire(env, INSTANCES.b), { removed: [candidate.helperIncarnation] });
    assert.deepEqual(listMailboxes(env), [first.helperIncarnation]);
});

test('U5 a mismatched tuple, another principal, no record or a record without owners is a no-op', (t) => {
    const env = workspace(t);
    assert.deepEqual(retire(env, INSTANCES.a), { removed: [] }, 'no record');
    const first = provision(env, INSTANCES.a);
    for (const instance of [
        { ...INSTANCES.a, instanceId: 'inst-x' },
        { ...INSTANCES.a, enableGeneration: 'egen-x' },
        { ...INSTANCES.a, containerName: 'ploinky_rwrepo_rwtarget_other' },
    ]) assert.deepEqual(retire(env, instance), { removed: [] }, JSON.stringify(instance));
    assert.deepEqual(retire(env, INSTANCES.a, { principal: 'agent:rwrepo/other' }), { removed: [] });
    for (const bad of [{ instanceId: '' }, { containerName: '' }, { principal: 'rwrepo/rwtarget' }, { boxTmpRoot: 'relative' }]) {
        assert.deepEqual(retire(env, INSTANCES.a, bad), { removed: [] }, JSON.stringify(bad));
    }
    assert.deepEqual(listMailboxes(env), [first.helperIncarnation]);
    // A record written before owners existed names no owner: nothing is deleted.
    const recordPath = targetStatePaths(env.controllerStateDir, TARGET).record;
    const legacy = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    delete legacy.incarnationOwners;
    fs.writeFileSync(recordPath, `${JSON.stringify(legacy)}\n`);
    assert.deepEqual(retire(env, INSTANCES.a), { removed: [] });
    assert.deepEqual(listMailboxes(env), [first.helperIncarnation]);
    // The next provisioning carries the legacy current instance over as the owner of its incarnation.
    const second = provision(env, INSTANCES.b);
    assert.deepEqual(readProvisioningRecord({ controllerStateDir: env.controllerStateDir, principal: TARGET }).incarnationOwners, {
        [first.helperIncarnation]: { ...INSTANCES.a },
        [second.helperIncarnation]: { ...INSTANCES.b },
    });
    assert.deepEqual(retire(env, INSTANCES.a, { keepCurrent: true }), { removed: [first.helperIncarnation] });
});

test('U5 an EACCES unlink never fails retirement; a nested directory survives; symlinks are unlinked, never followed', (t) => {
    const env = workspace(t);
    const first = provision(env, INSTANCES.a);
    provision(env, INSTANCES.b);
    const mailbox = first.binds[0].source;
    const outside = path.join(env.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), 'keep');
    fs.writeFileSync(path.join(mailbox, 'helper.sock'), '');
    fs.symlinkSync(outside, path.join(mailbox, 'link-dir'));
    fs.symlinkSync(path.join(outside, 'keep'), path.join(mailbox, 'link-file'));
    fs.mkdirSync(path.join(mailbox, 'nested'));
    fs.writeFileSync(path.join(mailbox, 'nested', 'inner'), '');
    // First an fs whose unlink fails with EACCES: nothing throws, nothing is reported removed.
    const denied = { ...fs, unlinkSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
    assert.deepEqual(retire(env, INSTANCES.a, { fsApi: denied }), { removed: [] });
    assert.ok(fs.existsSync(path.join(mailbox, 'helper.sock')));
    // A throwing lstat or readdir is no failure either.
    const broken = { ...fs, readdirSync: () => { throw Object.assign(new Error('io'), { code: 'EIO' }); } };
    assert.deepEqual(retire(env, INSTANCES.a, { fsApi: broken }), { removed: [] });
    // Then the real fs: non-directory entries go, the nested directory (and so the mailbox) stays.
    assert.deepEqual(retire(env, INSTANCES.a), { removed: [] });
    assert.deepEqual(fs.readdirSync(mailbox), ['nested']);
    assert.deepEqual(fs.readdirSync(path.join(mailbox, 'nested')), ['inner']);
    assert.deepEqual(fs.readdirSync(outside), ['keep']);
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep');
});

test('U5 a symlink at the incarnation name is unlinked, not followed; a symlinked mailbox root is never entered', (t) => {
    const env = workspace(t);
    const first = provision(env, INSTANCES.a);
    provision(env, INSTANCES.b);
    const outside = path.join(env.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), '');
    fs.rmdirSync(first.binds[0].source);
    fs.symlinkSync(outside, first.binds[0].source);
    assert.deepEqual(retire(env, INSTANCES.a), { removed: [first.helperIncarnation] });
    assert.equal(fs.existsSync(first.binds[0].source), false);
    assert.deepEqual(fs.readdirSync(outside), ['keep']);

    const env2 = workspace(t);
    const again = provision(env2, INSTANCES.a);
    provision(env2, INSTANCES.b);
    const root = path.join(env2.boxTmpRoot, BOX_MAILBOXES_DIRECTORY);
    const moved = path.join(env2.root, 'moved');
    fs.renameSync(root, moved);
    fs.symlinkSync(moved, root);
    assert.deepEqual(retire(env2, INSTANCES.a), { removed: [] });
    assert.ok(fs.existsSync(path.join(moved, again.helperIncarnation)));
});

test('U5 an owner map that is malformed or names an unrecorded incarnation makes the record invalid', (t) => {
    const env = workspace(t);
    const first = provision(env, INSTANCES.a);
    const recordPath = targetStatePaths(env.controllerStateDir, TARGET).record;
    const good = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    for (const owners of [
        null, [], 'x',
        { [Buffer.alloc(16, 7).toString('base64url')]: { ...INSTANCES.a } },
        { [first.helperIncarnation]: { ...INSTANCES.a, extra: 1 } },
        { [first.helperIncarnation]: { ...INSTANCES.a, instanceId: '' } },
        { [first.helperIncarnation]: { containerName: '', instanceId: 'i', enableGeneration: 'g' } },
    ]) {
        fs.writeFileSync(recordPath, `${JSON.stringify({ ...good, incarnationOwners: owners })}\n`);
        assert.equal(code(() => readProvisioningRecord({ controllerStateDir: env.controllerStateDir, principal: TARGET })), E.stateInvalid, JSON.stringify(owners));
        // Retirement swallows the invalid record and deletes nothing.
        assert.deepEqual(retire(env, INSTANCES.a), { removed: [] });
    }
    assert.deepEqual(listMailboxes(env), [first.helperIncarnation]);
});

// ---- U6: an entry already at the new incarnation's mailbox name ----

test('U6 a directory, symlink or file at the new incarnation mailbox name refuses with no record, launch file or secret', (t) => {
    const fixed = () => Buffer.alloc(16, 4);
    const incarnation = fixed().toString('base64url');
    for (const plant of ['dir', 'symlink', 'file']) {
        const env = workspace(t);
        const root = ensureMailboxRoot({ boxTmpRoot: env.boxTmpRoot });
        const name = path.join(root, incarnation);
        const elsewhere = path.join(env.root, 'elsewhere');
        fs.mkdirSync(elsewhere);
        if (plant === 'dir') fs.mkdirSync(name);
        else if (plant === 'symlink') fs.symlinkSync(elsewhere, name);
        else fs.writeFileSync(name, '');
        assert.equal(code(() => provision(env, INSTANCES.a, { randomBytes: fixed })), E.stateInvalid, plant);
        assert.equal(readProvisioningRecord({ controllerStateDir: env.controllerStateDir, principal: TARGET }), null);
        assert.equal(fs.existsSync(path.join(env.boxTmpRoot, 'ploinky-execution-targets')), false, 'no instance, launch or secret file');
        assert.deepEqual(fs.readdirSync(root), [incarnation], 'the planted entry is left as found');
        assert.deepEqual(fs.readdirSync(elsewhere), []);
    }
});

// ---- held elsewhere: a running container outside the registry already holds the mailbox root ----

const ID = (char) => char.repeat(64);

test('H1 the grant needs no foreign running holder: own container (adoption) and the exact replaced predecessor are allowed', () => {
    let asked = null;
    const reader = (holders) => (source) => { asked = source; return holders; };
    assert.deepEqual(plan({ listMailboxRootHolders: reader([]) }), GRANT);
    assert.equal(asked, GRANT.source, 'the reader is asked about exactly the mailbox root');
    // Adoption, or a same-name replacement: the holder is the very container being started.
    assert.deepEqual(plan({ listMailboxRootHolders: reader([{ id: ID('a'), name: OWN.containerName }]) }), GRANT);
    assert.deepEqual(plan({ listMailboxRootHolders: reader([{ id: ID('a'), name: `/${OWN.containerName}` }]) }), GRANT);
    // A coordinated reinstall: the candidate starts while the exact predecessor (name and immutable id) still runs.
    const predecessor = { containerName: 'ploinky_rwrepo_rwworker_ws__candidate_old', containerId: ID('b') };
    const ownContainers = { containerName: 'ploinky_rwrepo_rwworker_ws__candidate_new', predecessor };
    assert.deepEqual(plan({ ownContainers, listMailboxRootHolders: reader([{ id: ID('b'), name: predecessor.containerName }]) }), GRANT);
});

test('H2 an unregistered running holder withholds the bind (held-elsewhere), even when this is the only provider principal', () => {
    const orphan = { id: ID('c'), name: 'ploinky_rwrepo_rwworker_ws__candidate_44b7fad0ab95' };
    assert.deepEqual(plan({ listMailboxRootHolders: () => [orphan] }), { withheld: 'held-elsewhere', holders: [orphan.name] });
    // The verifier's c19: the orphan is the only holder and a different provider principal starts.
    assert.deepEqual(plan({ repoName: 'rwrepo', agentName: 'rwworker2', routeKey: 'rwworker2',
        ownContainers: { containerName: 'ploinky_rwrepo_rwworker2_ws', predecessor: null }, listMailboxRootHolders: () => [orphan] }),
    { withheld: 'held-elsewhere', holders: [orphan.name] });
    // A predecessor is allowed only by its exact immutable id; a same-named other container is foreign.
    const predecessor = { containerName: orphan.name, containerId: ID('d') };
    assert.deepEqual(plan({ ownContainers: { containerName: 'ploinky_rwrepo_rwworker_ws', predecessor }, listMailboxRootHolders: () => [orphan] }),
        { withheld: 'held-elsewhere', holders: [orphan.name] });
    // Own container plus a foreign one: still withheld, foreign names sorted.
    assert.deepEqual(plan({ listMailboxRootHolders: () => [{ id: ID('e'), name: 'z-other' }, { id: ID('a'), name: OWN.containerName }, orphan] }),
        { withheld: 'held-elsewhere', holders: [orphan.name, 'z-other'] });
});

test('U2/H5 a running holder that the registry records as another instance of the same principal keeps the grant', () => {
    // Two instances of rwrepo/rwworker: the first (no alias) runs and holds the root; the second (alias "second") starts.
    const first = { key: 'ploinky_rwrepo_rwworker_ws', id: ID('f') };
    const registry = {
        [first.key]: agentRecord('rwrepo', 'rwworker', { containerId: first.id }),
        ploinky_rwrepo_rwworker_ws_second: agentRecord('rwrepo', 'rwworker', { alias: 'second', instanceId: 'w2', enableGeneration: 'g2' }),
    };
    const manifests = { rwworker: workerManifest(), second: workerManifest() };
    const ownContainers = { containerName: 'ploinky_rwrepo_rwworker_ws_second', predecessor: null };
    const holders = () => [{ id: first.id, name: first.key }];
    assert.deepEqual(plan({ registry, manifests, routeKey: 'second', ownContainers, listMailboxRootHolders: holders }), GRANT);
    // And symmetrically: the first restarting while the second holds the root.
    registry.ploinky_rwrepo_rwworker_ws_second.containerId = ID('9');
    assert.deepEqual(plan({ registry, manifests, ownContainers: { containerName: first.key, predecessor: null },
        listMailboxRootHolders: () => [{ id: ID('9'), name: 'ploinky_rwrepo_rwworker_ws_second' }] }), GRANT);
});

test('U2/H5 an unregistered, other-principal or id-mismatched holder stays foreign', () => {
    const key = 'ploinky_rwrepo_rwworker_ws_second';
    const ownContainers = { containerName: 'ploinky_rwrepo_rwworker_ws', predecessor: null };
    const holder = [{ id: ID('f'), name: key }];
    const withheld = { withheld: 'held-elsewhere', holders: [key] };
    // Unregistered (the verifier's orphan): no record under its name.
    assert.deepEqual(plan({ ownContainers, listMailboxRootHolders: () => holder }), withheld);
    // Registered under its name, but its record names another principal (an enabled non-provider agent here, so the
    // ambiguity check does not decide first).
    assert.deepEqual(plan({ ownContainers, registry: { [key]: agentRecord('demo', 'other', { containerId: ID('f') }) },
        manifests: { other: { container: 'node:24' } }, listMailboxRootHolders: () => holder }), withheld);
    // Same principal, but a different immutable id (a replaced or foreign container reusing the name).
    assert.deepEqual(plan({ ownContainers, registry: { [key]: agentRecord('rwrepo', 'rwworker', { alias: 'second', containerId: ID('e') }) },
        manifests: { second: workerManifest() }, listMailboxRootHolders: () => holder }), withheld);
    // Same principal with no recorded id.
    assert.deepEqual(plan({ ownContainers, registry: { [key]: agentRecord('rwrepo', 'rwworker', { alias: 'second' }) },
        manifests: { second: workerManifest() }, listMailboxRootHolders: () => holder }), withheld);
    // A non-agent record of that name.
    assert.deepEqual(plan({ ownContainers, registry: { [key]: { type: 'static', repoName: 'rwrepo', agentName: 'rwworker', containerId: ID('f') } },
        listMailboxRootHolders: () => holder }), withheld);
});

test('H3 holders that cannot be listed or are malformed fail closed; the reader is consulted only when all else grants', () => {
    assert.deepEqual(plan({ listMailboxRootHolders: () => { throw new Error('podman unavailable'); } }), { withheld: 'held-elsewhere', holders: null });
    for (const bad of [null, 'x', [{ id: '', name: 'n' }], [{ id: ID('a') }], [null]]) {
        assert.deepEqual(plan({ listMailboxRootHolders: () => bad }), { withheld: 'held-elsewhere', holders: null }, JSON.stringify(bad));
    }
    assert.deepEqual(plan({ ownContainers: undefined }), { withheld: 'held-elsewhere', holders: null });
    let calls = 0;
    const counting = () => { calls += 1; return []; };
    assert.equal(plan({ manifest: {}, listMailboxRootHolders: counting }), null);
    assert.equal(plan({ runtime: 'docker', listMailboxRootHolders: counting }), null);
    assert.equal(plan({ insideBox: false, listMailboxRootHolders: counting }), null);
    assert.equal(plan({ registry: { o: agentRecord('demo', 'other') }, manifests: { other: workerManifest() }, listMailboxRootHolders: counting }).withheld, 'ambiguous');
    assert.equal(calls, 0);
});

test('H4 the runtime holder reader reports exact-root binds by name and id, skips vanished containers and fails closed otherwise', async () => {
    const { runningMailboxRootHolders } = await import('../../cli/sandbox/docker/agentServiceManager.js');
    const root = '/tmp/ploinky-target-mailboxes';
    const containers = {
        [ID('1')]: { Id: ID('1'), Name: 'worker', Mounts: [{ Source: root, Destination: '/run/ploinky-worker-targets' }] },
        [ID('2')]: { Id: ID('2'), Name: '/orphan', Mounts: [{ Source: `${root}/`, Destination: '/x' }] },
        [ID('3')]: { Id: ID('3'), Name: 'target', Mounts: [{ Source: `${root}/AAAAAAAAAAAAAAAAAAAAAA`, Destination: '/run/ploinky-target/mailbox' }] },
        [ID('4')]: { Id: ID('4'), Name: 'plain', Mounts: [] },
    };
    const fake = ({ listed = Object.keys(containers), vanish = null, stillListed = false, psFails = false } = {}) => (command, args) => {
        assert.equal(command, 'podman');
        if (args[0] === 'ps') {
            if (psFails) return { status: 125, stdout: '' };
            const ids = vanish && !stillListed && fake.seen ? listed.filter((id) => id !== vanish) : listed;
            fake.seen = true;
            return { status: 0, stdout: `${ids.join('\n')}\n` };
        }
        assert.deepEqual(args.slice(0, 4), ['inspect', '--type', 'container', '--format']);
        const id = args.at(-1);
        if (id === vanish) return { status: 125, stdout: '' };
        return { status: 0, stdout: `${JSON.stringify(containers[id])}\n` };
    };
    fake.seen = false;
    assert.deepEqual(runningMailboxRootHolders('podman', root, fake()), [{ id: ID('1'), name: 'worker' }, { id: ID('2'), name: 'orphan' }]);
    fake.seen = false;
    assert.deepEqual(runningMailboxRootHolders('podman', root, fake({ vanish: ID('2') })), [{ id: ID('1'), name: 'worker' }]);
    fake.seen = false;
    assert.throws(() => runningMailboxRootHolders('podman', root, fake({ vanish: ID('2'), stillListed: true })), /could not be inspected/);
    assert.throws(() => runningMailboxRootHolders('podman', root, fake({ psFails: true })), /could not be listed/);
});
