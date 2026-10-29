import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { signPrivateRouterAssertion } from '../../Agent/lib/agentAssertion.mjs';
import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { postSourceProtection } from '../../Agent/lib/sourceProtectionTransport.mjs';
import { resourcesDigestOf, targetDigest } from '../../cli/server/executionTarget/contract.mjs';
import { createSourceProtectionService } from '../../cli/server/executionTarget/sourceProtectionService.mjs';
import { commitRoutePlan, resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import {
    authorizePrivateRoutePlan,
    readPrivateRequestBody,
    sendPrivateError,
    sendSourceProtection,
    sourceProtectionHolderCallers,
} from '../../cli/server/privateRouter.js';
import { derivePrivateAgentRequestSecret } from '../../cli/utils/security/masterKey.js';
import { linkInstallDeclarations, prepareLinkedRepositories } from '../../cli/utils/linkInstall.mjs';
import { aliasCoverageDigest } from '../../cli/utils/runtime/sourceProtectionInterlock.mjs';
import { MockResponse } from '../helpers/routerOriginsWorkspace.mjs';
import { domainFixture } from './directDomainFixtures.mjs';
import {
    SourceTransitionRefused,
    abortSourceTransition,
    assertSourceSetFixed,
    beginSourceTransition,
    commitSourceTransition,
    createLifecycleSourceEvidence,
    initializeSourceProtection,
    readTransitionMarker,
    sourceProtectionPresence,
    withApprovedSourceTransition,
} from '../../cli/utils/runtime/sourceProtectionGate.mjs';

// P5 wiring: lifecycle gate, Router-side service, Router admission of the worker and the agent-side transport.
// Everything is synthetic and runs in temporary directories; no process, network or container is started.

const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);
test.after(() => {
    if (previousMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previousMasterKey;
});

const WORKER = 'agent:fixtures/worker';
const OTHER = 'agent:fixtures/plain';
const WORKER_INSTANCE = 'worker-instance-1';
const WORKER_ENABLE = 'enable-1';

const idOf = (label) => crypto.createHash('sha256').update(`id:${label}`).digest().subarray(0, 16).toString('base64url');
const hex = (label) => crypto.createHash('sha256').update(`digest:${label}`).digest('hex');
const fsId = (inode, fileType = 'directory', mountId = '1') => ({
    filesystemId: 'fs-a', mountId, device: '64', inode: String(inode), fileType,
});
const digestOf = (value) => targetDigest(value).value;

const ROOT_ID = idOf('root');
const REVISION = { algorithm: 'git-sha1', value: 'a'.repeat(40) };
const REPOSITORY = 'https://example.invalid/fixtures/source.git';

function closureFixture(mutate = (value) => value) {
    return mutate({
        version: 1,
        roots: [{ rootId: ROOT_ID, rootIdentity: fsId(100), repositoryIdentity: REPOSITORY, revision: REVISION, sourceKind: 'workspace' }],
        entries: [{
            rootId: ROOT_ID, path: 'index.mjs', fileType: 'regular', mode: '0644', gitState: 'tracked-clean',
            contentDigest: hex('index'), linkTarget: null, resolvedIdentity: fsId(101, 'regular'), dependencyIdentity: null,
        }],
        dependencies: [],
        secretReferences: [],
    });
}

function selectionFixture(mode = 'prod') {
    return {
        version: 1,
        repositorySourceMode: mode,
        selections: [{
            consumerPrincipal: WORKER, role: 'agent', repositoryIdentity: REPOSITORY, revision: REVISION,
            sourceKind: 'workspace', rootIdentity: fsId(100), dependencyIdentity: null,
        }],
    };
}

function coverageRoots({ writableLink = false } = {}) {
    return [
        { kind: 'workspace', rootIdentity: fsId(100), paths: ['/ws/src'], aliases: [fsId(100, 'directory', '2')], writable: false },
        { kind: 'managed', rootIdentity: fsId(200), paths: ['/ws/.ploinky/repos/fixtures'], aliases: [], writable: false },
        { kind: 'link-install', rootIdentity: fsId(300), paths: ['/ws/agents/linked'], aliases: [fsId(301)], writable: writableLink },
    ];
}

const withLinkInstall = (identity) => (value) => {
    value.dependencies = [{
        id: idOf('dep-link'), kind: 'link-install', selectionDigest: hex('dep-selection'), closureDigest: hex('dep-closure'),
        rootIdentity: identity, lockDigest: null,
    }];
    value.entries[0].dependencyIdentity = idOf('dep-link');
    return value;
};

const SCOPE = Object.freeze({ workspaceId: 'ws-1', boxIdentity: 'box-1', boxGeneration: 'box-gen-1' });
const ENFORCEMENT = hex('enforcement');

function tempWorkspace(t) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ploinky-p5-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function listTree(root) {
    const out = [];
    const walk = (directory) => {
        let names;
        try { names = fs.readdirSync(directory).sort(); } catch (_) { return; }
        for (const name of names) {
            const full = path.join(directory, name);
            out.push(path.relative(root, full));
            if (fs.lstatSync(full).isDirectory()) walk(full);
        }
    };
    walk(root);
    return out;
}

function envelope(op, workerGeneration, request) {
    return Buffer.from(JSON.stringify({ version: 1, op, workerGeneration, ...(request === undefined ? {} : { request }) }));
}

const IDENTITY = Object.freeze({ agentId: WORKER, instanceId: WORKER_INSTANCE, enableGeneration: WORKER_ENABLE });

// A protected-source world: an initialized store, a service for the worker and the operator transition inputs.
async function makeWorld(t, { closure = closureFixture(), selection = selectionFixture(), coverage = coverageRoots(), holders = [WORKER] } = {}) {
    const workspaceRoot = tempWorkspace(t);
    const created = await initializeSourceProtection({
        workspaceRoot,
        assertWorkspaceLease: () => {},
        enumerateExpectedHolders: async () => ({ status: 'known', principals: holders }),
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const world = {
        workspaceRoot, closure, selection, coverage, storeId: created.value.sourceStoreIdentity,
        generation: idOf('gen-1'),
        accepted: new Map(),
        resolved: { selection, closure },
        resolvedAlias: { status: 'complete', roots: coverage },
    };
    world.accept = (label = 'acceptance-1', value = { selection: world.selection, closure: world.closure }) => {
        world.accepted.set(label, { selectionDigest: digestOf(value.selection), closureDigest: digestOf(value.closure) });
    };
    world.accept();
    world.holder = async (principal) => ({ status: principal === WORKER ? 'holder' : 'not-holder' });
    world.service = (extra = {}) => createSourceProtectionService({
        workspaceRoot,
        liveScope: async () => ({ ...SCOPE }),
        isSourceReservationHolder: world.holder,
        evidence: {
            enforcement: async () => ({ status: 'protected', enforcementDigest: ENFORCEMENT }),
            aliasCoverage: async () => world.resolvedAlias,
            resolveWritableResource: async (resource) => ({ status: 'resolved', paths: [`/ws/robots/${resource.resourceId}`], identities: [] }),
            releaseEvidence: async ({ reservation }) => ({
                status: 'absent',
                evidenceDigest: hex(`absent:${reservation.reservationId}`),
                absentResourceIds: reservation.resources.map((item) => item.resourceId),
                ownerInstanceAbsent: true,
                ownerRuntimeInstanceId: reservation.workerRuntimeInstanceId,
            }),
        },
        ...extra,
    });
    world.call = async (service, op, workerGeneration, request, identity = IDENTITY) => (
        service.handle({ identity, body: envelope(op, workerGeneration, request) })
    );
    world.register = async () => {
        const service = world.service();
        const advanced = await world.call(service, 'advance', world.generation, {
            version: 1, operationId: idOf('advance-1'), priorGeneration: null, nextGeneration: world.generation,
        });
        assert.equal(advanced.status, 200);
        assert.equal(advanced.body.ok, true, JSON.stringify(advanced.body));
        const acknowledged = await world.call(service, 'acknowledge', world.generation, {
            version: 1, operationId: idOf('ack-1'), sourceStoreIdentity: world.storeId, workerGeneration: world.generation,
            priorStoreIdentities: [], settlementAttestationDigest: hex('settled'),
        });
        assert.equal(acknowledged.body.ok, true, JSON.stringify(acknowledged.body));
        return service;
    };
    world.transitionRequest = (label, overrides = {}) => ({
        version: 1,
        operationId: idOf(`transition:${label}`),
        ...SCOPE,
        expectedEpoch: overrides.expectedEpoch ?? 0,
        selectionDigest: digestOf(world.selection),
        closureDigest: digestOf(world.closure),
        sourceAcceptanceIdentity: 'acceptance-1',
        enforcementDigest: ENFORCEMENT,
        aliasCoverageDigest: aliasCoverageDigest(world.coverage),
        ...overrides,
    });
    world.commitInputs = (request, approval, { evidence, lease = () => {}, fsApi } = {}) => ({
        workspaceRoot,
        operatorIdentity: 'operator-lifecycle',
        assertWorkspaceLease: lease,
        approval,
        scope: async () => ({
            ...SCOPE,
            workerInstances: { [WORKER]: { workerRuntimeInstanceId: WORKER_INSTANCE, workerEnableGeneration: WORKER_ENABLE } },
        }),
        isSourceReservationHolder: world.holder,
        evidence: evidence || createLifecycleSourceEvidence({
            resolveSource: async () => ({ selection: world.resolved.selection, closure: world.resolved.closure }),
            acceptedProvenance: world.accepted,
            enforcement: async () => ({ status: 'protected', enforcementDigest: ENFORCEMENT }),
            aliasRoots: async () => world.resolvedAlias,
        }),
        request,
        ...(fsApi ? { fsApi } : {}),
    });
    world.prepare = (label, { lease = () => {}, kinds = ['agent-link'], expected = null } = {}) => beginSourceTransition({
        workspaceRoot, assertWorkspaceLease: lease, operationId: idOf(`transition:${label}`), kinds, expected,
    });
    // PREPARE, optional synchronous edit inside the approved scope, COMMIT; a refused commit is aborted explicitly.
    world.transition = async (label, { overrides, evidence, lease = () => {}, edit, kinds } = {}) => {
        const request = world.transitionRequest(label, overrides);
        const begun = await world.prepare(label, { lease, kinds });
        if (!begun.ok) return begun;
        const { approval } = begun.value;
        if (edit) withApprovedSourceTransition(approval, edit);
        const committed = await commitSourceTransition(world.commitInputs(request, approval, { evidence, lease }));
        if (!committed.ok) {
            await abortSourceTransition({ workspaceRoot, assertWorkspaceLease: () => {}, approval, resolveSource: async () => world.resolved });
            return committed;
        }
        return { ok: true, value: { transition: committed.value.transition, approval } };
    };
    world.record = async () => (await world.call(world.service(), 'state', null)).body.value.record;
    return world;
}

function reserveRequest(world, label, epoch, resources) {
    return {
        version: 1,
        operationId: idOf(`reserve-op:${label}`),
        reservationId: idOf(`reservation:${label}`),
        ...SCOPE,
        workerGeneration: world.generation,
        robotId: idOf('robot-1'),
        executionId: idOf(`execution:${label}`),
        attemptId: idOf(`attempt:${label}`),
        consumerKind: 'execution',
        consumerId: idOf(`consumer:${label}`),
        expectedEpoch: epoch,
        resources,
    };
}

const robotResource = (label) => ({
    resourceId: idOf(`resource:${label}`), kind: 'home', rootIdentity: fsId(500), bindingChainDigest: hex(`chain:${label}`),
    access: 'write', aliasCoverageDigest: aliasCoverageDigest(coverageRoots()),
});

// ---------------------------------------------------------------- inertness

test('P5 inert: a workspace without a store is unchanged by the gate and the service (no write, every kind passes)', async (t) => {
    const root = tempWorkspace(t);
    const before = listTree(root);
    for (const kind of ['repository-install', 'repository-update', 'repository-enable', 'repository-disable', 'agent-link', 'link-install-clone', 'link-install-writable']) {
        assert.deepEqual(assertSourceSetFixed({ workspaceRoot: root, kind }), { inert: true });
    }
    assert.equal(sourceProtectionPresence(root), 'absent');
    assert.deepEqual(listTree(root), before);

    // An ordinary workspace has `.ploinky/data` but no source-protection entry: still inert.
    fs.mkdirSync(path.join(root, '.ploinky', 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ploinky', 'data', 'something-else.json'), '{}');
    const populated = listTree(root);
    assert.equal(sourceProtectionPresence(root), 'absent');
    assert.deepEqual(assertSourceSetFixed({ workspaceRoot: root, kind: 'agent-link' }), { inert: true });
    assert.deepEqual(listTree(root), populated);

    const service = createSourceProtectionService({
        workspaceRoot: root,
        liveScope: async () => ({ ...SCOPE }),
        isSourceReservationHolder: async () => ({ status: 'holder' }),
    });
    const described = await service.handle({ identity: IDENTITY, body: envelope('describe', null) });
    assert.deepEqual(described.body, { ok: true, value: { state: 'unavailable', sourceStoreIdentity: null, holderAcknowledged: false, currentGeneration: null } });
    for (const [op, request] of [['reserve', {}], ['release', {}], ['advance', {}], ['acknowledge', {}]]) {
        const answer = await service.handle({ identity: IDENTITY, body: envelope(op, idOf('g'), request) });
        assert.deepEqual(answer.body, { ok: false, error: { code: 'source_unavailable' } }, op);
    }
    assert.equal((await service.handle({ identity: IDENTITY, body: envelope('state', null) })).body.error.code, 'source_unavailable');
    assert.deepEqual(listTree(root), populated, 'the service wrote nothing');
});

test('P5 inert: an unreadable presence check refuses and an interrupted creation counts as present', async (t) => {
    const root = tempWorkspace(t);
    const deny = { lstatSync: () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; }, readdirSync: fs.readdirSync };
    assert.equal(sourceProtectionPresence(root, deny), 'unreadable');
    assert.throws(() => assertSourceSetFixed({ workspaceRoot: root, kind: 'agent-link', fsApi: deny }), (error) => error instanceof SourceTransitionRefused);
    fs.mkdirSync(path.join(root, '.ploinky', 'data', 'source-protection.creating-abc'), { recursive: true });
    assert.equal(sourceProtectionPresence(root), 'present');
    assert.throws(() => assertSourceSetFixed({ workspaceRoot: root, kind: 'repository-update' }), (error) => error.code === 'source_transition_blocked');
});

// ---------------------------------------------------------------- protected transitions

test('P5 a clean accepted closure reaches protected; lifecycle edits then need a prepared transition', async (t) => {
    const world = await makeWorld(t);
    await world.register();
    assert.equal(await world.record(), null);
    const result = await world.transition('clean');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.transition.record.protectionStatus, 'protected');
    assert.equal(result.value.transition.record.sourceProtectionEpoch, 1);
    assert.equal((await world.record()).protectionStatus, 'protected');
    assert.equal(readTransitionMarker(world.workspaceRoot).state, 'absent', 'commit removed the marker');

    for (const kind of ['repository-update', 'agent-link', 'link-install-clone']) {
        assert.throws(() => assertSourceSetFixed({ workspaceRoot: world.workspaceRoot, kind }), (error) => error instanceof SourceTransitionRefused && error.code === 'source_transition_blocked', kind);
    }
    // The consumed approval opens nothing, and a forged one never did.
    const consumed = result.value.approval;
    assert.throws(() => withApprovedSourceTransition(consumed, () => {}), (error) => error instanceof SourceTransitionRefused);
    assert.throws(() => withApprovedSourceTransition({ root: world.workspaceRoot, kinds: ['agent-link'] }, () => {}), (error) => error instanceof SourceTransitionRefused);
});

test('P5 two-phase: PREPARE blocks reserve, the approval is single use and scoped, COMMIT records the post-edit digests', async (t) => {
    const world = await makeWorld(t);
    const service = await world.register();
    assert.equal((await world.transition('first')).ok, true);

    const begun = await world.prepare('second', { kinds: ['agent-link'] });
    assert.equal(begun.ok, true, JSON.stringify(begun));
    const { approval } = begun.value;
    assert.equal(readTransitionMarker(world.workspaceRoot).state, 'present');
    // A reservation cannot slip in between PREPARE and COMMIT; the other operations are unaffected.
    const reserveWhile = await world.call(service, 'reserve', world.generation, reserveRequest(world, 'during', 1, [robotResource('during')]));
    assert.deepEqual(reserveWhile.body, { ok: false, error: { code: 'source_transition_blocked' } });
    assert.equal((await world.call(service, 'describe', null)).body.ok, true);
    assert.deepEqual((await world.call(service, 'state', null)).body.value.transition, { pending: true });
    // A second PREPARE refuses while one is open.
    assert.deepEqual(await world.prepare('third'), { ok: false, error: { code: 'source_transition_blocked' } });

    // EDIT: only inside the approved synchronous scope, only for an allowed kind, never detached.
    assert.throws(() => assertSourceSetFixed({ workspaceRoot: world.workspaceRoot, kind: 'agent-link' }), (error) => error.code === 'source_transition_blocked');
    withApprovedSourceTransition(approval, () => {
        assert.deepEqual(assertSourceSetFixed({ workspaceRoot: world.workspaceRoot, kind: 'agent-link' }), { inert: false, approved: true });
        assert.throws(() => assertSourceSetFixed({ workspaceRoot: world.workspaceRoot, kind: 'repository-update' }), (error) => error.code === 'source_transition_blocked');
        assert.throws(() => withApprovedSourceTransition(approval, () => {}), (error) => error instanceof SourceTransitionRefused, 'no nesting');
        // The edit changes the tree on disk: a new accepted closure.
        world.closure = closureFixture((value) => { value.entries[0].contentDigest = hex('edited-index'); return value; });
        world.resolved = { selection: world.selection, closure: world.closure };
        world.accept('acceptance-1', { selection: world.selection, closure: world.closure });
    });
    assert.throws(() => withApprovedSourceTransition(approval, async () => {}), (error) => error instanceof SourceTransitionRefused, 'an async scope is refused');
    assert.throws(() => assertSourceSetFixed({ workspaceRoot: world.workspaceRoot, kind: 'agent-link' }), (error) => error.code === 'source_transition_blocked', 'nothing carries past the scope');

    // COMMIT re-resolves the source: the pre-edit digests no longer match the disk, the post-edit ones do.
    const stale = world.transitionRequest('second', { expectedEpoch: 1, closureDigest: digestOf(closureFixture()) });
    assert.deepEqual(await commitSourceTransition(world.commitInputs(stale, approval)), { ok: false, error: { code: 'source_provenance_unaccepted' } });
    assert.equal(readTransitionMarker(world.workspaceRoot).state, 'present', 'a refused commit leaves the marker');
    const committed = await commitSourceTransition(world.commitInputs(world.transitionRequest('second', { expectedEpoch: 1 }), approval));
    assert.equal(committed.ok, true, JSON.stringify(committed));
    const record = await world.record();
    assert.equal(record.sourceProtectionEpoch, 2);
    assert.equal(record.sourceClosureDigest, digestOf(world.closure));
    assert.equal(readTransitionMarker(world.workspaceRoot).state, 'absent');

    // Reuse and later edits refuse; reservations are admitted again under the new epoch.
    assert.throws(() => withApprovedSourceTransition(approval, () => {}), (error) => error instanceof SourceTransitionRefused);
    assert.deepEqual(await commitSourceTransition(world.commitInputs(world.transitionRequest('second', { expectedEpoch: 2 }), approval)), { ok: false, error: { code: 'forbidden' } });
    assert.throws(() => assertSourceSetFixed({ workspaceRoot: world.workspaceRoot, kind: 'agent-link' }), (error) => error.code === 'source_transition_blocked');
    assert.equal((await world.call(service, 'reserve', world.generation, reserveRequest(world, 'after', 2, [robotResource('after')]))).body.ok, true);
});

test('P5 two-phase: a crash leaves a refusing marker until an explicit commit or abort; expected digests bind the commit', async (t) => {
    const world = await makeWorld(t);
    const service = await world.register();
    // PREPARE and "crash": the approval is lost, the marker stays.
    const begun = await world.prepare('crash');
    assert.equal(begun.ok, true);
    assert.deepEqual(await world.prepare('after-crash'), { ok: false, error: { code: 'source_transition_blocked' } });
    assert.throws(() => assertSourceSetFixed({ workspaceRoot: world.workspaceRoot, kind: 'agent-link' }), (error) => error.code === 'source_transition_blocked');
    assert.equal((await world.call(service, 'reserve', world.generation, reserveRequest(world, 'crash', 1, [robotResource('crash')]))).body.error.code, 'source_transition_blocked');
    // Another approval-less caller cannot commit; the operator aborts under the lease.
    assert.deepEqual(await abortSourceTransition({ workspaceRoot: world.workspaceRoot, assertWorkspaceLease: () => { throw new Error('no lease'); } }), { ok: false, error: { code: 'forbidden' } });
    assert.deepEqual(await abortSourceTransition({ workspaceRoot: world.workspaceRoot, assertWorkspaceLease: () => {} }), { ok: true, value: { aborted: true, unprotected: false } });
    assert.equal(readTransitionMarker(world.workspaceRoot).state, 'absent');

    // Expected digests recorded at PREPARE must be the ones committed.
    const expected = { selectionDigest: digestOf(world.selection), closureDigest: hex('somewhere-else') };
    const bound = await world.prepare('bound', { expected });
    assert.equal(bound.ok, true);
    const mismatch = await commitSourceTransition(world.commitInputs(world.transitionRequest('bound'), bound.value.approval));
    assert.deepEqual(mismatch, { ok: false, error: { code: 'source_binding_mismatch' } });
    await abortSourceTransition({ workspaceRoot: world.workspaceRoot, assertWorkspaceLease: () => {}, approval: bound.value.approval });

    // A crash after the epoch was written but before the marker was removed: the workspace keeps refusing, and
    // re-running the same commit replays the receipt and clears the marker.
    const real = fs;
    let failMarkerRemoval = true;
    const crashing = { ...real, unlinkSync(file) {
        if (failMarkerRemoval && String(file).endsWith('source-transition.json')) throw new Error('synthetic crash before the marker was removed');
        return real.unlinkSync(file);
    } };
    const late = await world.prepare('late');
    const request = world.transitionRequest('late');
    const crashed = await commitSourceTransition(world.commitInputs(request, late.value.approval, { fsApi: crashing }));
    assert.equal(crashed.ok, false);
    assert.equal(readTransitionMarker(world.workspaceRoot).state, 'present');
    assert.equal((await world.record()).sourceProtectionEpoch, 1, 'the epoch was durably written');
    assert.throws(() => assertSourceSetFixed({ workspaceRoot: world.workspaceRoot, kind: 'agent-link' }), (error) => error.code === 'source_transition_blocked');
    failMarkerRemoval = false;
    const replayed = await commitSourceTransition(world.commitInputs(request, late.value.approval));
    assert.equal(replayed.ok, true, JSON.stringify(replayed));
    assert.equal(replayed.value.transition.record.sourceProtectionEpoch, 1);
    assert.equal(readTransitionMarker(world.workspaceRoot).state, 'absent');
    assert.equal((await world.call(service, 'reserve', world.generation, reserveRequest(world, 'resumed', 1, [robotResource('resumed')]))).body.ok, true);
});

test('P5 abort re-resolves the tree: a partial edit leaves the record unavailable, an unchanged tree keeps it protected', async (t) => {
    const world = await makeWorld(t);
    const service = await world.register();
    assert.equal((await world.transition('first')).ok, true);
    const resolveNow = async () => world.resolved;

    // Crash after a partial edit: the tree no longer matches the record.
    const begun = await world.prepare('partial');
    assert.equal(begun.ok, true);
    withApprovedSourceTransition(begun.value.approval, () => {
        world.resolved = { selection: world.selection, closure: closureFixture((value) => { value.entries[0].contentDigest = hex('half-edited'); return value; }) };
    });
    const aborted = await abortSourceTransition({ workspaceRoot: world.workspaceRoot, assertWorkspaceLease: () => {}, resolveSource: resolveNow });
    assert.deepEqual(aborted, { ok: true, value: { aborted: true, unprotected: true } });
    assert.equal(readTransitionMarker(world.workspaceRoot).state, 'absent');
    const record = await world.record();
    assert.equal(record.protectionStatus, 'unavailable');
    assert.equal(record.sourceProtectionEpoch, 1, 'the epoch is unchanged');
    assert.deepEqual((await world.call(service, 'reserve', world.generation, reserveRequest(world, 'half', 1, [robotResource('half')]))).body, { ok: false, error: { code: 'source_unprotected' } });
    // Only a fresh prepare and commit records the tree as it now is.
    world.closure = world.resolved.closure;
    world.accept('acceptance-1', { selection: world.selection, closure: world.closure });
    const fresh = await world.transition('fresh', { overrides: { expectedEpoch: 1 } });
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    assert.equal((await world.record()).protectionStatus, 'protected');
    assert.equal((await world.record()).sourceProtectionEpoch, 2);
    assert.equal((await world.call(service, 'reserve', world.generation, reserveRequest(world, 'whole', 2, [robotResource('whole')]))).body.ok, true);

    // An abort with an unchanged tree, a missing resolver or an unreadable one: unchanged keeps it, the others fail safe.
    const other = await makeWorld(t);
    const otherService = await other.register();
    assert.equal((await other.transition('first')).ok, true);
    const same = await other.prepare('same');
    assert.equal(same.ok, true);
    assert.deepEqual(await abortSourceTransition({ workspaceRoot: other.workspaceRoot, assertWorkspaceLease: () => {}, resolveSource: async () => other.resolved }), { ok: true, value: { aborted: true, unprotected: false } });
    assert.equal((await other.record()).protectionStatus, 'protected');
    assert.equal((await other.call(otherService, 'reserve', other.generation, reserveRequest(other, 'same', 1, [robotResource('same')]))).body.ok, true);

    const blind = await makeWorld(t);
    await blind.register();
    assert.equal((await blind.transition('first')).ok, true);
    assert.equal((await blind.prepare('blind')).ok, true);
    assert.deepEqual(await abortSourceTransition({ workspaceRoot: blind.workspaceRoot, assertWorkspaceLease: () => {} }), { ok: true, value: { aborted: true, unprotected: true } });
    assert.equal((await blind.record()).protectionStatus, 'unavailable');
});

test('P5 the approval is bound to the canonical root: another spelling of the same directory is the same workspace', async (t) => {
    const world = await makeWorld(t);
    await world.register();
    const alias = `${world.workspaceRoot}-alias`;
    fs.symlinkSync(world.workspaceRoot, alias);
    t.after(() => fs.rmSync(alias, { force: true }));
    const begun = await world.prepare('spelling');
    assert.equal(begun.ok, true);
    assert.equal(begun.value.approval.root, fs.realpathSync(world.workspaceRoot));
    withApprovedSourceTransition(begun.value.approval, () => {
        assert.deepEqual(assertSourceSetFixed({ workspaceRoot: alias, kind: 'agent-link' }), { inert: false, approved: true });
    });
    // An unrelated protected workspace is not covered by it.
    const other = await makeWorld(t);
    withApprovedSourceTransition(begun.value.approval, () => {
        assert.throws(() => assertSourceSetFixed({ workspaceRoot: other.workspaceRoot, kind: 'agent-link' }), (error) => error.code === 'source_transition_blocked');
    });
});

test('P5 dirty and untracked trees are refused unless an independent acceptance names exactly those bytes', async (t) => {
    const clean = closureFixture();
    const dirty = closureFixture((value) => { value.entries[0].gitState = 'tracked-dirty'; value.entries[0].contentDigest = hex('edited'); return value; });
    const untracked = closureFixture((value) => {
        // Entries are kept in ascending path order.
        value.entries.unshift({
            rootId: ROOT_ID, path: 'extra.mjs', fileType: 'regular', mode: '0755', gitState: 'untracked',
            contentDigest: hex('extra'), linkTarget: null, resolvedIdentity: fsId(102, 'regular'), dependencyIdentity: null,
        });
        return value;
    });
    for (const [label, changed] of [['dirty', dirty], ['untracked', untracked]]) {
        const world = await makeWorld(t, { closure: clean });
        await world.register();
        // The accepted record names the clean closure; the tree on disk now differs.
        world.resolved = { selection: world.selection, closure: changed };
        const refused = await world.transition(`${label}-stale`, { overrides: { closureDigest: digestOf(clean) } });
        assert.deepEqual(refused, { ok: false, error: { code: 'source_provenance_unaccepted' } }, label);
        // Presenting the changed bytes without an acceptance record for them is refused too.
        const unaccepted = await world.transition(`${label}-new`, { overrides: { closureDigest: digestOf(changed) } });
        assert.deepEqual(unaccepted, { ok: false, error: { code: 'source_provenance_unaccepted' } }, label);
        assert.equal(await world.record(), null, `${label}: nothing became protected`);
        assert.throws(() => assertSourceSetFixed({ workspaceRoot: world.workspaceRoot, kind: 'agent-link' }), (error) => error.code === 'source_transition_blocked');
        // The adoption process records an acceptance for exactly the changed bytes.
        world.closure = changed;
        world.accept('acceptance-1', { selection: world.selection, closure: changed });
        const adopted = await world.transition(`${label}-adopted`);
        assert.equal(adopted.ok, true, `${label}: ${JSON.stringify(adopted)}`);
        assert.equal((await world.record()).sourceClosureDigest, digestOf(changed));
    }
});

test('P5 alias and link-install transitions: an uncovered or writable root never reaches protected', async (t) => {
    // Uncovered link-install root.
    const uncovered = closureFixture(withLinkInstall(fsId(777)));
    const world = await makeWorld(t, { closure: uncovered });
    await world.register();
    world.accept('acceptance-1', { selection: world.selection, closure: uncovered });
    assert.deepEqual(await world.transition('uncovered'), { ok: false, error: { code: 'source_alias_unproven' } });
    assert.equal(await world.record(), null);

    // Covered but writable (dev-mode style alias to a writable checkout).
    const covered = closureFixture(withLinkInstall(fsId(300)));
    const writable = await makeWorld(t, { closure: covered, selection: selectionFixture('dev'), coverage: coverageRoots({ writableLink: true }) });
    await writable.register();
    writable.accept('acceptance-1', { selection: writable.selection, closure: covered });
    assert.deepEqual(await writable.transition('writable'), { ok: false, error: { code: 'source_unprotected' } });

    // Unproven alias coverage (provider refuses) and unproven enforcement.
    const unproven = await makeWorld(t, { closure: covered });
    await unproven.register();
    unproven.accept('acceptance-1', { selection: unproven.selection, closure: covered });
    unproven.resolvedAlias = { status: 'unproven' };
    assert.deepEqual(await unproven.transition('alias-unproven'), { ok: false, error: { code: 'source_alias_unproven' } });
    unproven.resolvedAlias = { status: 'complete', roots: unproven.coverage };
    const noEnforcement = await unproven.transition('no-enforcement', { evidence: createLifecycleSourceEvidence({
        resolveSource: async () => ({ selection: unproven.selection, closure: covered }),
        acceptedProvenance: unproven.accepted,
        aliasRoots: async () => unproven.resolvedAlias,
    }) });
    assert.deepEqual(noEnforcement, { ok: false, error: { code: 'source_unprotected' } });

    // The same covered, read-only link-install closure is accepted and protected.
    const good = await makeWorld(t, { closure: covered });
    await good.register();
    good.accept('acceptance-1', { selection: good.selection, closure: covered });
    const accepted = await good.transition('covered');
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal((await good.record()).protectionStatus, 'protected');
});

test('P5 a transition needs the workspace lease, and is blocked while a writable reservation exists', async (t) => {
    const world = await makeWorld(t);
    const service = await world.register();
    const noLease = await world.transition('no-lease', { lease: () => { throw new Error('not held'); } });
    assert.deepEqual(noLease, { ok: false, error: { code: 'forbidden' } });
    const first = await world.transition('first');
    assert.equal(first.ok, true, JSON.stringify(first));

    const reserved = await world.call(service, 'reserve', world.generation, reserveRequest(world, 'live', 1, [robotResource('live')]));
    assert.equal(reserved.body.ok, true, JSON.stringify(reserved.body));
    const blocked = await world.transition('second', { overrides: { expectedEpoch: 1 } });
    assert.deepEqual(blocked, { ok: false, error: { code: 'source_transition_blocked' } });
    assert.equal((await world.record()).sourceProtectionEpoch, 1);

    const reservation = reserved.body.value;
    const released = await world.call(service, 'release', world.generation, {
        version: 1,
        operationId: idOf('release-op'),
        reservationId: reservation.reservationId,
        reservationRequestDigest: reservation.requestDigest,
        owningWorkerGeneration: reservation.workerGeneration,
        resourcesDigest: resourcesDigestOf(reservation.resources),
        releaseEvidenceDigest: hex(`absent:${reservation.reservationId}`),
    });
    assert.equal(released.body.ok, true, JSON.stringify(released.body));
    const second = await world.transition('third', { overrides: { expectedEpoch: 1 } });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal((await world.record()).sourceProtectionEpoch, 2);
});

// ---------------------------------------------------------------- service

test('P5 service: only holders, exact envelopes, bounded bodies; describe and state report the store', async (t) => {
    const world = await makeWorld(t);
    const service = await world.register();
    const described = await world.call(service, 'describe', null);
    assert.deepEqual(described.body.value, {
        state: 'ready', sourceStoreIdentity: world.storeId, holderAcknowledged: true, currentGeneration: world.generation,
    });
    // A non-holder is forbidden before any state is read.
    const stranger = await service.handle({ identity: { ...IDENTITY, agentId: OTHER }, body: envelope('describe', null) });
    assert.deepEqual(stranger.body, { ok: false, error: { code: 'forbidden' } });
    // Malformed requests are transport errors, never interlock results.
    for (const body of [Buffer.from('not json'), Buffer.from('[]'), Buffer.from(JSON.stringify({ version: 1, op: 'transition', workerGeneration: null })),
        Buffer.from(JSON.stringify({ version: 1, op: 'describe', workerGeneration: null, extra: 1 })),
        Buffer.from(JSON.stringify({ version: 1, op: 'reserve', workerGeneration: world.generation })),
        Buffer.from(JSON.stringify({ version: 2, op: 'describe', workerGeneration: null }))]) {
        assert.equal((await service.handle({ identity: IDENTITY, body })).status, 400);
    }
    assert.equal((await service.handle({ identity: IDENTITY, body: Buffer.alloc(1024 * 1024 + 1, 0x20) })).status, 413);
    assert.equal((await service.handle({ identity: { agentId: 'not-a-principal', instanceId: 'x', enableGeneration: 'y' }, body: envelope('describe', null) })).status, 400);
    // The registered generation is authoritative: a replayed advance with a changed body conflicts.
    const conflict = await world.call(service, 'advance', world.generation, {
        version: 1, operationId: idOf('advance-1'), priorGeneration: idOf('someone'), nextGeneration: world.generation,
    });
    assert.equal(conflict.body.ok, false);
    // `state` returns the record and the injected facts only.
    assert.equal((await world.transition('state')).ok, true);
    const stated = await world.call(world.service({ sourceFacts: async ({ record }) => ({ epoch: record.sourceProtectionEpoch }) }), 'state', null);
    assert.equal(stated.body.value.record.sourceProtectionEpoch, 1);
    assert.deepEqual(stated.body.value.facts, { epoch: 1 });
    // Without a live scope provider the service is unavailable, not permissive.
    const blind = world.service({ liveScope: async () => null });
    assert.equal((await world.call(blind, 'reserve', world.generation, reserveRequest(world, 'blind', 1, [robotResource('blind')]))).body.error.code, 'source_unavailable');
});

test('P5 service: reservations inherit the default refusal until trusted evidence is injected', async (t) => {
    const world = await makeWorld(t);
    await world.register();
    assert.equal((await world.transition('first')).ok, true);
    const bare = createSourceProtectionService({
        workspaceRoot: world.workspaceRoot,
        liveScope: async () => ({ ...SCOPE }),
        isSourceReservationHolder: world.holder,
    });
    const refused = await world.call(bare, 'reserve', world.generation, reserveRequest(world, 'bare', 1, [robotResource('bare')]));
    assert.deepEqual(refused.body, { ok: false, error: { code: 'source_unprotected' } });
});

// ---------------------------------------------------------------- Router admission and agent transport

function routerSnapshot() {
    const provider = (agentName) => ({
        version: 1,
        port: 7300,
        taskReferences: { path: `/${agentName}/task-refs` },
        coordinatorRoutes: [{ path: `/base-agent-additional-server/${agentName}/7000/api/coord/*`, callers: [OTHER] }],
    });
    return {
        agents: {
            'worker-container': { type: 'agent', repoName: 'fixtures', agentName: 'worker', instanceId: WORKER_INSTANCE, enableGeneration: WORKER_ENABLE },
            'plain-container': { type: 'agent', repoName: 'fixtures', agentName: 'plain', instanceId: 'plain-instance', enableGeneration: 'plain-enable' },
        },
        manifests: { worker: { executionProvider: provider('worker') }, plain: {} },
        compiled: { security: {} },
    };
}

function sourceProtectionPlan(snapshot) {
    return {
        ok: true,
        listener: 'private',
        kind: 'private-operation',
        operation: 'source-protection',
        pathname: '/api/edge/source-protection',
        parsedUrl: new URL('http://host.containers.internal/api/edge/source-protection'),
        snapshot,
    };
}

function agentEnv(agentId, instanceId, enableGeneration) {
    return {
        PLOINKY_AGENT_ID: agentId,
        PLOINKY_AGENT_INSTANCE_ID: instanceId,
        PLOINKY_AGENT_ENABLE_GENERATION: enableGeneration,
        PLOINKY_AGENT_PRIVATE_SECRET: derivePrivateAgentRequestSecret(agentId, instanceId, enableGeneration),
    };
}

// A transport request implementation that hands the captured request to `answer` and returns its HTTP answer.
function fakeRequest(captured, answer) {
    return (url, options, callback) => {
        const request = new EventEmitter();
        request.destroy = () => {};
        request.end = (body) => {
            captured.url = url;
            captured.method = options.method;
            captured.headers = Object.fromEntries(Object.entries(options.headers).map(([key, value]) => [key.toLowerCase(), value]));
            captured.body = body;
            Promise.resolve(answer(captured)).then((reply) => {
                const response = new EventEmitter();
                response.statusCode = reply.status;
                response.headers = {};
                response.destroy = () => {};
                callback(response);
                response.emit('data', Buffer.from(JSON.stringify(reply.body)));
                response.emit('end');
            });
        };
        return request;
    };
}

const DESCRIPTOR = () => ({ payload: { internalRouterUrl: 'http://127.0.0.1:8081' } });

test('P5 router holder ACL: exactly the current agents that declare an execution provider', () => {
    assert.deepEqual(sourceProtectionHolderCallers(routerSnapshot()), [{ agentId: WORKER, instanceId: WORKER_INSTANCE, enableGeneration: WORKER_ENABLE }]);
    const broken = routerSnapshot();
    broken.manifests.worker.executionProvider.port = 'invalid';
    assert.deepEqual(sourceProtectionHolderCallers(broken), []);
    const stale = routerSnapshot();
    delete stale.agents['worker-container'].enableGeneration;
    assert.deepEqual(sourceProtectionHolderCallers(stale), []);
});

test('P5 worker transport -> Router admission -> service: the existing private assertion carries the worker identity', async (t) => {
    const world = await makeWorld(t);
    const snapshot = routerSnapshot();
    const plan = sourceProtectionPlan(snapshot);
    const cache = createMemoryReplayCache();
    const route = async (captured) => {
        const req = { method: captured.method, headers: { 'ploinky-agent-assertion': captured.headers['ploinky-agent-assertion'] } };
        let identity;
        try {
            identity = authorizePrivateRoutePlan({ req, plan, body: captured.body, assertionCache: cache });
        } catch (error) {
            return { status: error.status || 403, body: { error: error.code } };
        }
        const service = world.service({ isSourceReservationHolder: async (principal) => ({ status: sourceProtectionHolderCallers(snapshot).some((entry) => entry.agentId === principal) ? 'holder' : 'not-holder' }) });
        return service.handle({ identity, body: captured.body });
    };
    const captured = {};
    const send = (body, env) => postSourceProtection(body, { env, loadDescriptor: DESCRIPTOR, requestImpl: fakeRequest(captured, route) });

    const advance = envelope('advance', world.generation, { version: 1, operationId: idOf('t-advance'), priorGeneration: null, nextGeneration: world.generation });
    const answer = await send(advance, agentEnv(WORKER, WORKER_INSTANCE, WORKER_ENABLE));
    assert.equal(answer.status, 200);
    assert.equal(captured.method, 'POST');
    assert.equal(captured.url.pathname, '/api/edge/source-protection');
    const parsed = JSON.parse(answer.body.toString('utf8'));
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.equal(parsed.value.workerPrincipal, WORKER);
    assert.equal(parsed.value.currentGeneration, world.generation);

    const described = JSON.parse((await send(envelope('describe', null), agentEnv(WORKER, WORKER_INSTANCE, WORKER_ENABLE))).body.toString('utf8'));
    assert.equal(described.value.currentGeneration, world.generation);

    // A current agent without a provider declaration is refused by the Router ACL, before the service runs.
    const plainEnv = agentEnv(OTHER, 'plain-instance', 'plain-enable');
    const refused = await send(envelope('describe', null), plainEnv);
    assert.equal(refused.status, 403);
    // A stale instance of the worker is refused by the assertion check.
    const stale = await send(envelope('describe', null), agentEnv(WORKER, 'worker-instance-0', WORKER_ENABLE));
    assert.equal(stale.status, 401);
});

test('P5 transport fails closed without a descriptor or identity and never reuses a body larger than the limit', async () => {
    const failing = (options) => postSourceProtection(Buffer.from('{}'), options);
    await assert.rejects(() => failing({ env: {}, loadDescriptor: () => { throw new Error('none'); } }), (error) => error.code === 'SOURCE_PROTECTION_TRANSPORT_UNAVAILABLE');
    await assert.rejects(() => failing({ env: {}, loadDescriptor: DESCRIPTOR }), (error) => error.code === 'SOURCE_PROTECTION_TRANSPORT_UNAVAILABLE');
    await assert.rejects(() => postSourceProtection(Buffer.alloc(1024 * 1024 + 1), { env: {}, loadDescriptor: DESCRIPTOR }), (error) => error.code === 'SOURCE_PROTECTION_TRANSPORT_UNAVAILABLE');
    await assert.rejects(() => failing({ env: agentEnv(WORKER, WORKER_INSTANCE, WORKER_ENABLE), loadDescriptor: () => ({ payload: { internalRouterUrl: 'https://127.0.0.1:8081' } }) }), (error) => error.code === 'SOURCE_PROTECTION_TRANSPORT_UNAVAILABLE');
});

// ---------------------------------------------------------------- the registered Router route

const ROUTE = '/api/edge/source-protection';
const BOX_ID = 'c'.repeat(64);
const PROVIDER_AGENT = 'agent:fixtures/explorer';
const providerDeclaration = { version: 1, port: 7300, taskReferences: { path: '/explorer/task-refs' } };

// The registry and generation of the shared edge fixture, with `explorer` declaring an execution provider.
function routerWorld(t, { declare = true } = {}) {
    const world = domainFixture(t);
    if (declare) {
        const file = path.join(world.root, 'fixtures', 'explorer', 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        manifest.executionProvider = providerDeclaration;
        fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
        world.apply();
    }
    return world;
}

const callerEnv = (name) => agentEnv(`agent:fixtures/${name}`, `${name}-instance`, `${name}-enable`);

function privateRequest({ method = 'POST', url = ROUTE, body = envelope('describe', null), env = callerEnv('explorer'), signedPath = ROUTE, headers = {} } = {}) {
    const bytes = Buffer.from(body);
    const req = Readable.from(bytes.length ? [bytes] : []);
    return Object.assign(req, {
        method,
        url,
        ploinkyListenerClass: 'private',
        headers: {
            host: '127.0.0.1:8081',
            ...(env ? { 'ploinky-agent-assertion': signPrivateRouterAssertion({ method, path: signedPath, body: bytes, env }) } : {}),
            ...headers,
        },
    });
}

// RoutingServer's private pipeline for this operation: exact route plan, bounded body, caller authorization, route
// plan commit, then the reply. The Router branch itself is pinned by the source test below.
async function throughPrivateListener(world, request, serving) {
    const res = new MockResponse();
    const parsedUrl = new URL(request.url, `http://${request.headers.host}`);
    const plan = resolveEdgeRoutePlan({ req: request, parsedUrl, listener: 'private' });
    if (!plan.ok) {
        res.writeHead(plan.status || 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: plan.code }));
        return { plan, res };
    }
    const body = await readPrivateRequestBody(request);
    try {
        authorizePrivateRoutePlan({ req: request, plan, body });
    } catch (error) {
        sendPrivateError(res, error);
        return { plan, res };
    }
    assert.equal(commitRoutePlan(plan), true);
    await sendSourceProtection(res, { plan, body, callerIdentity: request.privateAgentIdentity, ...serving });
    return { plan, res };
}

// A Box-like scope: the engine mount names this container and the evidence files are injected.
function boxScopeSources(t, workspaceRoot, { id = BOX_ID, record = '' } = {}) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'p5-box-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const mountInfoPath = path.join(dir, 'mountinfo');
    const containerEnvPath = path.join(dir, '.containerenv');
    fs.writeFileSync(mountInfoPath, [
        '7300 7290 0:70 / / rw,relatime - overlay overlay rw',
        `7388 7390 0:73 /containers/overlay-containers/${id}/userdata/.containerenv /run/.containerenv rw,nosuid,nodev,relatime - tmpfs tmpfs rw,mode=700`,
        '',
    ].join('\n'));
    fs.writeFileSync(containerEnvPath, record);
    return { mountInfoPath, containerEnvPath };
}

test('P5 route: /api/edge/source-protection resolves only as the exact private POST operation', (t) => {
    routerWorld(t);
    const plan = (url, { method = 'POST', listener = 'private', host } = {}) => resolveEdgeRoutePlan({
        req: { url, method, headers: { host: host || (listener === 'private' ? '127.0.0.1:8081' : '127.0.0.1:8080') }, ploinkyListenerClass: listener },
        listener,
    });
    const served = plan(ROUTE);
    assert.equal(served.ok, true);
    assert.equal(served.kind, 'private-operation');
    assert.equal(served.operation, 'source-protection');
    assert.equal(served.pathname, ROUTE);
    assert.equal(typeof served.lease?.isCurrent, 'function');
    // Exact method and raw target: no other method, query (even an empty one), fragment, alias or encoded spelling.
    // A fragment is refused earlier as a malformed selector.
    assert.equal(plan(`${ROUTE}#x`).ok, false);
    for (const [url, method] of [[ROUTE, 'GET'], [ROUTE, 'PUT'], [ROUTE, 'DELETE'], [`${ROUTE}?`, 'POST'], [`${ROUTE}?a=1`, 'POST']]) {
        const refused = plan(url, { method });
        assert.equal(refused.ok, false, `${method} ${url}`);
        assert.equal(refused.code, 'SOURCE_PROTECTION_REQUEST_INVALID', `${method} ${url}`);
    }
    for (const url of [`${ROUTE}/`, `${ROUTE}/x`, '/api/edge//source-protection', '/api/edge/source-protection%2f', '/api/edge/%73ource-protection',
        '/api/edge/Source-Protection', '/api/edge/./source-protection', '/api/edge/x/../source-protection']) {
        const refused = plan(url);
        assert.equal(refused.ok === true && refused.operation === 'source-protection', false, url);
    }
    // The public and managed listeners never serve it.
    for (const listener of ['public', 'managed']) {
        const other = plan(ROUTE, { listener, host: listener === 'managed' ? 'host.containers.internal:8080' : undefined });
        assert.equal(other.ok === true && other.kind === 'private-operation', false, listener);
    }
    // The neighbouring private operations are unchanged.
    assert.equal(plan('/api/edge/runtime-origins', { method: 'GET' }).operation, 'runtime-origins');
    assert.equal(plan('/api/edge/turn-credentials').operation, 'turn-credentials');
});

test('P5 route: reachable with the verified private identity of an execution-provider agent, refused for every other caller', async (t) => {
    const world = routerWorld(t);
    const store = await makeWorld(t);
    await store.register();
    const sources = boxScopeSources(t, store.workspaceRoot);
    const serving = { workspaceRoot: store.workspaceRoot, insideBox: true, scopeSources: sources };
    const call = (options) => throughPrivateListener(world, privateRequest(options), serving);

    // The provider agent reaches the service, which sees only the verified identity.
    const holders = sourceProtectionHolderCallers(resolveEdgeRoutePlan({
        req: privateRequest(), parsedUrl: new URL(ROUTE, 'http://127.0.0.1:8081'), listener: 'private',
    }).snapshot);
    assert.deepEqual(holders.map((entry) => entry.agentId), [PROVIDER_AGENT]);
    const reached = await call({});
    assert.equal(reached.res.statusCode, 200, reached.res.body);
    assert.equal(reached.res.headers['cache-control'], 'no-store');
    assert.equal(reached.res.headers['content-type'], 'application/json');
    const described = reached.res.json();
    assert.equal(described.ok, true, reached.res.body);
    // The store exists and the live Box scope is real, so the answer is the store state, not `unavailable`.
    assert.notEqual(described.value.state, 'unavailable');
    assert.equal(described.value.sourceStoreIdentity, store.storeId);
    assert.equal(described.value.holderAcknowledged, false, 'this worker has not registered a generation in this store');

    // A request-body op the service refuses is reported by the service, not by the transport.
    const malformed = await call({ body: Buffer.from('not json') });
    assert.equal(malformed.res.statusCode, 400);
    assert.deepEqual(malformed.res.json(), { error: 'invalid_request' });

    // Refused: a current agent without a provider declaration, a stale instance, an unsigned request, a wrong signed
    // path or method, an assertion for another body, a forged identity header.
    const plain = await call({ env: callerEnv('unrelated') });
    assert.equal(plain.res.statusCode, 403);
    assert.equal(plain.res.json().error, 'PRIVATE_CALLER_DENIED');
    const stale = await call({ env: agentEnv(PROVIDER_AGENT, 'explorer-instance-0', 'explorer-enable') });
    assert.equal(stale.res.statusCode, 401);
    const staleEnable = await call({ env: agentEnv(PROVIDER_AGENT, 'explorer-instance', 'explorer-enable-0') });
    assert.equal(staleEnable.res.statusCode, 401);
    assert.equal((await call({ env: null })).res.statusCode, 401);
    assert.equal((await call({ signedPath: '/api/edge/runtime-origins' })).res.statusCode, 401);
    const other = privateRequest({ body: envelope('state', null) });
    other.headers['ploinky-agent-assertion'] = privateRequest({ body: envelope('describe', null) }).headers['ploinky-agent-assertion'];
    assert.equal((await throughPrivateListener(world, other, serving)).res.statusCode, 401);
    const forged = await call({ env: callerEnv('unrelated'), headers: { 'x-ploinky-agent-id': PROVIDER_AGENT } });
    assert.equal(forged.res.statusCode, 403);
    // A refused caller never reaches the service: nothing was read from the store on its behalf.
    assert.equal(plain.res.body.includes(store.storeId), false);
    // Declarations are re-read from the active generation: without one nobody holds the reservation.
    const bare = routerWorld(t, { declare: false });
    const nobody = await throughPrivateListener(bare, privateRequest(), serving);
    assert.equal(nobody.res.statusCode, 403);
    assert.equal(nobody.res.json().error, 'PRIVATE_CALLER_DENIED');
});

test('P5 route: without a Box scope the service is unavailable, never permissive', async (t) => {
    const world = routerWorld(t);
    const store = await makeWorld(t);
    await store.register();
    const sources = boxScopeSources(t, store.workspaceRoot);
    const ask = async (serving, op = 'describe', generation = null, request) => (await throughPrivateListener(world,
        privateRequest({ body: envelope(op, generation, request) }), { workspaceRoot: store.workspaceRoot, ...serving })).res.json();

    // Outside the Box (the Router is not in a Box), engine-like evidence is not trusted.
    assert.deepEqual((await ask({ insideBox: false, scopeSources: sources })).value, {
        state: 'unavailable', sourceStoreIdentity: null, holderAcknowledged: false, currentGeneration: null,
    });
    assert.equal((await ask({ insideBox: false, scopeSources: sources }, 'state')).error.code, 'source_unavailable');
    // Inside a Box whose engine evidence is missing or names another Box.
    assert.equal((await ask({ insideBox: true, scopeSources: { ...sources, mountInfoPath: path.join(store.workspaceRoot, 'absent') } }, 'state')).error.code, 'source_unavailable');
    const foreign = boxScopeSources(t, store.workspaceRoot, { record: 'name="ploinky-box-other-000000000000"\n' });
    assert.equal((await ask({ insideBox: true, scopeSources: foreign }, 'state')).error.code, 'source_unavailable');
    // Inside the Box, the real scope reaches the store.
    assert.equal((await ask({ insideBox: true, scopeSources: sources }, 'state')).ok, true);
    // With no store on disk the route answers without creating one.
    const empty = tempWorkspace(t);
    const before = listTree(empty);
    const absent = (await throughPrivateListener(world, privateRequest(), { workspaceRoot: empty, insideBox: true, scopeSources: boxScopeSources(t, empty) })).res.json();
    assert.equal(absent.value.state, 'unavailable');
    assert.deepEqual(listTree(empty), before);
});

test('P5 route: RoutingServer dispatches the operation after the commit, with exactly the reviewed Router import', () => {
    const source = fs.readFileSync(new URL('../../cli/server/RoutingServer.js', import.meta.url), 'utf8');
    const branch = source.match(/if \(routePlan\.kind === 'private-operation' && routePlan\.operation === 'source-protection'\) \{\n([\s\S]*?)\n    \}\n/);
    assert.ok(branch, 'the source-protection branch exists');
    const lines = branch[1].split('\n').map((line) => line.trim());
    assert.equal(lines[0], 'if (!commitRoutePlan(routePlan)) {');
    assert.ok(lines.includes("sendJsonResponse(res, 503, { error: 'edge_generation_changed' }, { 'Cache-Control': 'no-store', ...refusalHeaders('route', 'edge-generation-changed') });"));
    const send = lines.findIndex((line) => line === 'await sendSourceProtection(res, {');
    assert.ok(send > lines.indexOf('if (!commitRoutePlan(routePlan)) {'), 'the plan is committed before the service runs');
    assert.deepEqual(lines.slice(send + 1, lines.indexOf('});', send)), [
        'plan: routePlan,', 'body,', 'callerIdentity: req.privateAgentIdentity,', 'workspaceRoot: PLOINKY_WORKSPACE_ROOT,', 'insideBox,',
        'audit: (event, value) => appendLog(event, value),',
    ]);
    // It follows authorizePrivateRoutePlan in the same request handler and is the only user of the operation.
    assert.ok(source.indexOf('authorizePrivateRoutePlan({ req, plan: routePlan, body })') < source.indexOf("routePlan.operation === 'source-protection'"));
    assert.equal(source.match(/sendSourceProtection/g).length, 2);
    assert.deepEqual(source.match(/^import .*sendSourceProtection.*$/gm), ["import { sendSourceProtection } from './privateRouter.js';"]);
    // The `insideBox` it passes is the Router's own Box-marker fact.
    assert.match(source, /^const insideBox = isInsideBox\(\);$/m);
});

// ---------------------------------------------------------------- call sites

test('P5 link-install: a writable alias or a clone reaches the gate before any Git command; inert without a store', async (t) => {
    const root = fs.realpathSync(tempWorkspace(t));
    const manifest = { 'link-install': ['https://example.invalid/fixtures/linked.git'] };
    assert.equal(linkInstallDeclarations(manifest).length, 1);
    const commands = [];
    const execFile = (command, args) => { commands.push(args.join(' ')); return ''; };

    // Inert: the writable path passes the gate and fails later for its own reason (the checkout is missing).
    assert.throws(() => prepareLinkedRepositories(manifest, { workspaceRoot: root, create: false, writable: true, execFile }), /missing from the workspace/);
    commands.length = 0;

    const created = await initializeSourceProtection({
        workspaceRoot: root, assertWorkspaceLease: () => {}, enumerateExpectedHolders: async () => ({ status: 'known', principals: [WORKER] }),
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    for (const options of [{ create: false, writable: true }, { create: true, writable: false }]) {
        assert.throws(() => prepareLinkedRepositories(manifest, { workspaceRoot: root, execFile, ...options }), (error) => error instanceof SourceTransitionRefused && error.code === 'source_transition_blocked', JSON.stringify(options));
    }
    assert.deepEqual(commands.filter((line) => line.includes('clone')), [], 'no clone ran');
    // A manifest without link-install declarations never reaches the gate.
    assert.deepEqual(prepareLinkedRepositories({}, { workspaceRoot: root, writable: true, execFile }), []);
});
