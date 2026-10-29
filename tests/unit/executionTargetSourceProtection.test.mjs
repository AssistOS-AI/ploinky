import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { threadId } from 'node:worker_threads';

import {
    CONTRACT_ERROR_CODES,
    INTERLOCK_LIMITS_V1,
    canonicalTargetJson,
    parseCanonicalTargetJson,
    resourcesDigestOf,
    targetDigest,
    validateReservationTombstone,
    validateSourceClosure,
    validateSourceOperation,
    validateSourceProtectionRecord,
    validateSourceSelection,
    validateWritableReservation,
} from '../../cli/server/executionTarget/contract.mjs';
import {
    STORE_ERROR_CODES,
    openSourceProtectionStore,
    sourceProtectionPaths,
} from '../../cli/utils/runtime/sourceProtectionStore.mjs';
import {
    DEFAULT_SOURCE_EVIDENCE,
    INTERLOCK_ERROR_CODES,
    aliasCoverageDigest,
    classifyWritableOverlap,
    createManagementContextAuthority,
    createSourceProtectionInterlock,
} from '../../cli/utils/runtime/sourceProtectionInterlock.mjs';

// ---------------------------------------------------------------- synthetic identities

const WORKER = 'agent:fixtures/worker';
const OTHER = 'agent:fixtures/other';
const REMOVED = 'agent:fixtures/removed';
const LATE = 'agent:fixtures/late';
const NOW = 1_800_000_000_000;

const idOf = (label) => crypto.createHash('sha256').update(`id:${label}`).digest().subarray(0, 16).toString('base64url');
const hex = (label) => crypto.createHash('sha256').update(`digest:${label}`).digest('hex');
const fsId = (inode, fileType = 'directory', mountId = '1', filesystemId = 'fs-a') => ({
    filesystemId, mountId, device: '64', inode: String(inode), fileType,
});

const ROOT_ID = idOf('root');
const REVISION = { algorithm: 'git-sha1', value: 'a'.repeat(40) };
const REPOSITORY = 'https://example.invalid/fixtures/source.git';

function closureFixture(mutate = (value) => value) {
    return mutate({
        version: 1,
        roots: [{ rootId: ROOT_ID, rootIdentity: fsId(100), repositoryIdentity: REPOSITORY, revision: REVISION, sourceKind: 'workspace' }],
        entries: [
            {
                rootId: ROOT_ID, path: 'index.mjs', fileType: 'regular', mode: '0644', gitState: 'tracked-clean',
                contentDigest: hex('index'), linkTarget: null, resolvedIdentity: fsId(101, 'regular'), dependencyIdentity: null,
            },
            {
                rootId: ROOT_ID, path: 'lib', fileType: 'directory', mode: '0755', gitState: 'non-git',
                contentDigest: null, linkTarget: null, resolvedIdentity: null, dependencyIdentity: null,
            },
            {
                rootId: ROOT_ID, path: 'link.mjs', fileType: 'symlink', mode: '0777', gitState: 'untracked',
                contentDigest: null, linkTarget: 'index.mjs', resolvedIdentity: fsId(101, 'regular'), dependencyIdentity: null,
            },
        ],
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

const digestOf = (value) => targetDigest(value).value;
const ENFORCEMENT = hex('enforcement');
const ALIAS = aliasCoverageDigest(coverageRoots());

function resource(label, { kind = 'home', inode = 500 } = {}) {
    return {
        resourceId: idOf(`resource:${label}`), kind, rootIdentity: fsId(inode), bindingChainDigest: hex(`chain:${label}`),
        access: 'write', aliasCoverageDigest: ALIAS,
    };
}

// ---------------------------------------------------------------- world

function fakeIdentity(pid, alive, scope = 'scope-1') {
    return {
        pid,
        scope,
        startIdentity: `start-${pid}`,
        isAlive: (target) => alive.has(target),
        startIdentityOf: (target) => (alive.has(target) ? `start-${target}` : null),
    };
}

function listTree(root) {
    const out = [];
    const walk = (directory) => {
        let names;
        try { names = fs.readdirSync(directory).sort(); } catch (_) { return; }
        for (const name of names) {
            const full = path.join(directory, name);
            const stat = fs.lstatSync(full);
            out.push(`${path.relative(root, full)}:${stat.isDirectory() ? 'd' : stat.size}`);
            if (stat.isDirectory()) walk(full);
        }
    };
    walk(root);
    return out;
}

function tempWorkspace(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-source-protection-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const workspaceRoot = path.join(dir, 'ws');
    fs.mkdirSync(workspaceRoot);
    return workspaceRoot;
}

async function makeWorld(t, {
    holders = [WORKER],
    predicate = { [WORKER]: 'holder', [OTHER]: 'holder', [LATE]: 'holder' },
    limits,
    faults,
    workspaceRoot = tempWorkspace(t),
    pid = 1001,
    alive = new Set(),
    create = true,
} = {}) {
    alive.add(pid);
    const world = {
        workspaceRoot,
        alive,
        pid,
        scope: {
            workspaceId: 'ws-1',
            boxIdentity: 'box-1',
            boxGeneration: 'box-gen-1',
            workerInstances: {
                [WORKER]: { workerRuntimeInstanceId: 'worker-instance-1', workerEnableGeneration: 'enable-1' },
                [OTHER]: { workerRuntimeInstanceId: 'other-instance-1', workerEnableGeneration: 'enable-1' },
                [REMOVED]: { workerRuntimeInstanceId: 'removed-instance-1', workerEnableGeneration: 'enable-1' },
                [LATE]: { workerRuntimeInstanceId: 'late-instance-1', workerEnableGeneration: 'enable-1' },
            },
        },
        predicate: { ...predicate },
        coverage: coverageRoots(),
        enforcementDigest: ENFORCEMENT,
        closure: closureFixture(),
        selection: selectionFixture(),
        provenance: 'accepted',
        acceptance: 'acceptance-1',
        views: new Map(),
        releaseProof: new Map(),
        gates: {},
        calls: { enforcement: 0 },
        authority: createManagementContextAuthority(),
    };
    const evidence = {
        async enforcement(argument) {
            world.calls.enforcement += 1;
            await world.gates.enforcement?.(argument);
            return { status: 'protected', enforcementDigest: world.enforcementDigest };
        },
        async aliasCoverage() {
            return { status: 'complete', roots: world.coverage };
        },
        async resolveWritableResource(item) {
            if (world.views.has(item.resourceId)) return world.views.get(item.resourceId);
            return { status: 'resolved', paths: [`/ws/robots/${item.resourceId}`], identities: [] };
        },
        async provenance() {
            await world.gates.provenance?.();
            if (world.provenance !== 'accepted') return { status: 'unaccepted' };
            return { status: 'accepted', acceptanceIdentity: world.acceptance, selection: world.selection, closure: world.closure };
        },
        async releaseEvidence({ reservation, actor }) {
            const custom = world.releaseProof.get(reservation.reservationId);
            if (custom) return custom({ reservation, actor });
            return {
                status: 'absent',
                evidenceDigest: hex(`absent:${reservation.reservationId}`),
                absentResourceIds: reservation.resources.map((item) => item.resourceId),
                ownerInstanceAbsent: true,
                ownerRuntimeInstanceId: reservation.workerRuntimeInstanceId,
            };
        },
    };
    world.evidence = evidence;
    world.open = async ({ processIdentity = fakeIdentity(world.pid, world.alive), storeFaults, storeLimits = limits, createStore = false, fsApi = fs } = {}) => {
        const opened = await openSourceProtectionStore({
            workspaceRoot,
            fsApi,
            create: createStore,
            assertWorkspaceLease: () => {},
            enumerateExpectedHolders: async () => ({ status: 'known', principals: holders }),
            limits: storeLimits,
            faults: storeFaults,
            processIdentity,
            clock: { nowMs: () => NOW, monotonicMs: () => performance.now(), sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }) },
        });
        return opened;
    };
    world.attach = (store) => {
        world.store = store;
        world.interlock = createSourceProtectionInterlock({
            store,
            authority: world.authority,
            currentScope: async () => structuredClone(world.scope),
            isSourceReservationHolder: async (principal) => ({ status: world.predicate[principal] || 'not-holder' }),
            evidence,
            clock: { nowMs: () => NOW },
        });
        return world.interlock;
    };
    world.reopen = async (options = {}) => {
        const opened = await world.open(options);
        assert.equal(opened.ok, true, JSON.stringify(opened));
        return world.attach(opened.value);
    };
    world.ctx = (principal = WORKER, generation = world.generation?.[principal]) => {
        const instance = world.scope.workerInstances[principal];
        return world.authority.worker({
            workerPrincipal: principal,
            workerRuntimeInstanceId: instance.workerRuntimeInstanceId,
            workerEnableGeneration: instance.workerEnableGeneration,
            workerGeneration: generation,
        });
    };
    world.operator = () => world.authority.operator({ operatorIdentity: 'operator-lifecycle' });
    world.generation = {};
    world.register = async (principal = WORKER, generation = idOf(`gen:${principal}:1`), prior = null) => {
        const result = await world.interlock.advanceWorkerGeneration(world.ctx(principal, generation), {
            version: 1, operationId: idOf(`advance:${principal}:${generation}`), priorGeneration: prior, nextGeneration: generation,
        });
        if (result.ok) world.generation[principal] = generation;
        return result;
    };
    world.ack = (principal = WORKER, label = 'ack') => world.interlock.acknowledgeSourceStore(world.ctx(principal), {
        version: 1,
        operationId: idOf(`ack:${principal}:${label}:${world.generation[principal]}`),
        sourceStoreIdentity: world.store.storeId,
        workerGeneration: world.generation[principal],
        priorStoreIdentities: [],
        settlementAttestationDigest: hex(`settled:${principal}`),
    });
    world.transitionRequest = (expectedEpoch, label = `t${expectedEpoch}`, overrides = {}) => ({
        version: 1,
        operationId: idOf(`transition:${label}`),
        workspaceId: world.scope.workspaceId,
        boxIdentity: world.scope.boxIdentity,
        boxGeneration: world.scope.boxGeneration,
        expectedEpoch,
        selectionDigest: digestOf(selectionFixture()),
        closureDigest: digestOf(closureFixture()),
        sourceAcceptanceIdentity: 'acceptance-1',
        enforcementDigest: ENFORCEMENT,
        aliasCoverageDigest: ALIAS,
        ...overrides,
    });
    world.transition = (expectedEpoch, label, overrides) => world.interlock.prepareSourceTransition(
        world.operator(), world.transitionRequest(expectedEpoch, label, overrides),
    );
    world.reserveRequest = (label, { epoch = 1, resources = [resource(label)], principal = WORKER, consumerKind = 'execution', ...rest } = {}) => ({
        version: 1,
        operationId: idOf(`reserve-op:${label}`),
        reservationId: idOf(`reservation:${label}`),
        workspaceId: world.scope.workspaceId,
        boxIdentity: world.scope.boxIdentity,
        boxGeneration: world.scope.boxGeneration,
        workerGeneration: world.generation[principal],
        robotId: idOf('robot-1'),
        executionId: idOf(`execution:${label}`),
        attemptId: idOf(`attempt:${label}`),
        consumerKind,
        consumerId: idOf(`consumer:${label}`),
        expectedEpoch: epoch,
        resources,
        ...rest,
    });
    world.reserve = (label, options = {}) => world.interlock.reserveWritableResources(
        world.ctx(options.principal || WORKER), world.reserveRequest(label, options),
    );
    world.releaseRequest = (reservation, label = 'release', overrides = {}) => ({
        version: 1,
        operationId: idOf(`release-op:${label}:${reservation.reservationId}`),
        reservationId: reservation.reservationId,
        reservationRequestDigest: reservation.requestDigest,
        owningWorkerGeneration: reservation.workerGeneration,
        resourcesDigest: resourcesDigestOf(reservation.resources),
        releaseEvidenceDigest: hex(`absent:${reservation.reservationId}`),
        ...overrides,
    });
    world.release = (reservation, { context, label, overrides } = {}) => world.interlock.releaseWritableReservation(
        context || world.ctx(), world.releaseRequest(reservation, label, overrides),
    );
    world.snapshot = () => JSON.parse(fs.readFileSync(sourceProtectionPaths(workspaceRoot).stateFile, 'utf8'));
    if (create) {
        const opened = await world.open({ faults, createStore: true });
        assert.equal(opened.ok, true, JSON.stringify(opened));
        world.attach(opened.value);
    }
    return world;
}

// Register, acknowledge and accept the first source epoch.
async function readyWorld(t, options) {
    const world = await makeWorld(t, options);
    assert.equal((await world.register()).ok, true);
    assert.equal((await world.ack()).ok, true);
    const transition = await world.transition(0);
    assert.equal(transition.ok, true, JSON.stringify(transition));
    return world;
}

const code = (result) => (result.ok ? 'ok' : result.error.code);

// Asserts a refused operation left the durable snapshot byte-identical.
async function refusedUnchanged(world, operation, expected, label = expected) {
    const file = sourceProtectionPaths(world.workspaceRoot).stateFile;
    const before = fs.readFileSync(file);
    assert.equal(code(await operation()), expected, label);
    assert.deepEqual(fs.readFileSync(file), before, `${label}: state unchanged`);
}

function assertResultShape(result) {
    assert.equal(Object.isFrozen(result), true);
    if (result.ok) assert.deepEqual(Object.keys(result).sort(), ['ok', 'value']);
    else {
        assert.deepEqual(Object.keys(result).sort(), ['error', 'ok']);
        assert.deepEqual(Object.keys(result.error), ['code']);
    }
}

// ---------------------------------------------------------------- contract documents

test('ENC-03 canonical parse refuses duplicate keys, invalid UTF-8, lone surrogates, BOM and noncanonical bytes', () => {
    for (const input of ['{"a":1,"a":1}', '{"a":"\\ud800"}', '\ufeff{"a":1}', '{"a": 1}', '{"b":1,"a":2}', '{"a":"\\u00e9"}',
        Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x22, 0x7d])]) {
        const result = parseCanonicalTargetJson(input);
        assertResultShape(result);
        assert.equal(code(result), CONTRACT_ERROR_CODES.noncanonicalEncoding, String(input));
    }
    // A5.5: malformed JSON text is noncanonical.
    assert.equal(code(parseCanonicalTargetJson('{"a":')), 'noncanonical_encoding');
    const positive = parseCanonicalTargetJson('{"a":[1,"é",null,true],"b":{}}');
    assert.equal(positive.ok, true);
    assert.equal(Object.isFrozen(positive.value.a), true);
    assert.equal(code(parseCanonicalTargetJson('"x"', { maxBytes: 2 })), 'capacity_exceeded');
});

test('ENC-05 canonical encoding refuses non-JSON numbers, accessors, inherited and deep values', () => {
    assert.equal(canonicalTargetJson({ b: [1, { d: null, c: 'x' }], a: true }).value, '{"a":true,"b":[1,{"c":"x","d":null}]}');
    for (const value of [{ a: -0 }, { a: 1.5 }, { a: Number.MAX_SAFE_INTEGER + 1 }, { a: Number.NaN }, { a: Infinity },
        { a: undefined }, { a: () => 1 }, Object.create({ a: 1 }), new Date(0), [, 1], { a: 1n }]) {
        assert.equal(code(canonicalTargetJson(value)), 'invalid_request');
    }
    const accessor = {};
    Object.defineProperty(accessor, 'a', { get: () => 1, enumerable: true });
    assert.equal(code(canonicalTargetJson(accessor)), 'invalid_request');
    let deep = 1;
    for (let index = 0; index < 16; index += 1) deep = [deep];
    assert.equal(canonicalTargetJson(deep).ok, true);
    assert.equal(code(canonicalTargetJson([deep])), 'invalid_request');
    assert.equal(code(canonicalTargetJson({ a: '\ud800' })), 'noncanonical_encoding');
    assert.equal(targetDigest({ a: 1 }).value, crypto.createHash('sha256').update('{"a":1}').digest('hex'));
});

test('source protection record, selection and closure schemas are exact (ENC-01, ENC-02, ENC-04, ENC-06)', () => {
    const record = {
        version: 1, workspaceId: 'ws-1', boxIdentity: 'box-1', boxGeneration: 'box-gen-1', sourceStoreIdentity: idOf('store'),
        sourceProtectionEpoch: 1, sourceSelectionDigest: hex('s'), sourceClosureDigest: hex('c'),
        sourceAcceptanceIdentity: 'acceptance-1', protectionStatus: 'protected', enforcementDigest: hex('e'),
        aliasCoverageDigest: hex('a'), acceptedAtMs: NOW,
    };
    const valid = validateSourceProtectionRecord(record);
    assert.equal(valid.ok, true);
    assert.equal(Object.isFrozen(valid.value), true);
    assert.notEqual(valid.value, record);
    assert.equal(code(validateSourceProtectionRecord({ ...record, extra: 1 })), 'invalid_request');
    for (const version of [0, 2, '1', null]) {
        assert.equal(code(validateSourceProtectionRecord({ ...record, version })), 'unsupported_version');
    }
    const { version, ...noVersion } = record;
    assert.equal(code(validateSourceProtectionRecord(noVersion)), 'unsupported_version');
    for (const sourceStoreIdentity of ['', 'A'.repeat(21), `${idOf('x').slice(0, 21)}B`, 'x'.repeat(23)]) {
        assert.equal(code(validateSourceProtectionRecord({ ...record, sourceStoreIdentity })), 'invalid_request');
    }
    assert.equal(code(validateSourceProtectionRecord({ ...record, sourceClosureDigest: hex('c').toUpperCase() })), 'invalid_request');
    for (const sourceProtectionEpoch of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(code(validateSourceProtectionRecord({ ...record, sourceProtectionEpoch })), 'invalid_request');
    }
    assert.equal(code(validateSourceProtectionRecord({ ...record, workspaceId: 'w s' })), 'invalid_request');

    assert.equal(validateSourceSelection(selectionFixture()).ok, true);
    const credential = selectionFixture();
    credential.selections[0].repositoryIdentity = 'https://user:token@example.invalid/x.git';
    assert.equal(code(validateSourceSelection(credential)), 'invalid_request');
    const unsorted = selectionFixture();
    unsorted.selections.push({ ...unsorted.selections[0], role: 'agent', consumerPrincipal: 'agent:fixtures/aaa' });
    assert.equal(code(validateSourceSelection(unsorted)), 'invalid_request');
    unsorted.selections.reverse();
    assert.equal(validateSourceSelection(unsorted).ok, true);

    assert.equal(validateSourceClosure(closureFixture()).ok, true);
    const nested = closureFixture((value) => { value.entries[0].extra = 1; return value; });
    assert.equal(code(validateSourceClosure(nested)), 'invalid_request');
    for (const mode of ['4755', '2755', '1777', '755', '0800']) {
        assert.equal(code(validateSourceClosure(closureFixture((value) => { value.entries[0].mode = mode; return value; }))), 'invalid_request', mode);
    }
    const dangling = closureFixture((value) => { value.entries[2].resolvedIdentity = fsId(999, 'regular'); return value; });
    assert.equal(code(validateSourceClosure(dangling)), 'invalid_request');
    const unresolved = closureFixture((value) => { value.entries[2].resolvedIdentity = null; return value; });
    assert.equal(code(validateSourceClosure(unresolved)), 'invalid_request');
    const fifo = closureFixture((value) => { value.entries[1].fileType = 'fifo'; return value; });
    assert.equal(code(validateSourceClosure(fifo)), 'invalid_request');
    const duplicate = closureFixture((value) => { value.entries.push({ ...value.entries[2] }); return value; });
    assert.equal(code(validateSourceClosure(duplicate)), 'invalid_request');
    // ENC-06: a path at the 4096-byte bound is accepted, one byte more is capacity.
    const component = 'z'.repeat(240);
    const atBound = Array(17).fill(component).join('/');
    assert.equal(Buffer.byteLength(atBound), 4096);
    assert.equal(validateSourceClosure(closureFixture((value) => {
        value.entries.push({ ...value.entries[1], path: atBound });
        return value;
    })).ok, true);
    assert.equal(code(validateSourceClosure(closureFixture((value) => {
        value.entries.push({ ...value.entries[1], path: `${atBound}z` });
        return value;
    }))), 'capacity_exceeded');
    const wide = `${'é'.repeat(127)}a`;
    assert.equal(Buffer.byteLength(wide), 255);
    assert.equal(validateSourceClosure(closureFixture((value) => {
        value.entries.push({ ...value.entries[1], path: `${wide}` });
        return value;
    })).ok, true);
    assert.equal(code(validateSourceClosure(closureFixture((value) => {
        value.entries.push({ ...value.entries[1], path: `${wide}é` });
        return value;
    }))), 'capacity_exceeded');
});

test('A9.1 closure-root repositoryIdentity and revision are nullable for every sourceKind', () => {
    for (const sourceKind of ['workspace', 'managed', 'link-install', 'image', 'dependency-store']) {
        for (const nulls of [['repositoryIdentity'], ['revision'], ['repositoryIdentity', 'revision']]) {
            const closure = closureFixture((value) => {
                value.roots[0].sourceKind = sourceKind;
                for (const key of nulls) value.roots[0][key] = null;
                return value;
            });
            assert.equal(validateSourceClosure(closure).ok, true, `${sourceKind} ${nulls}`);
        }
    }
    // Selections keep a required revision.
    const selection = selectionFixture();
    selection.selections[0].revision = null;
    assert.equal(code(validateSourceSelection(selection)), 'invalid_request');
    // Null is not a wildcard for a malformed value.
    assert.equal(code(validateSourceClosure(closureFixture((value) => { value.roots[0].revision = { algorithm: 'git-sha1', value: 'x' }; return value; }))), 'invalid_request');
});

test('SRC-09 secret contents or tokens in a closure are refused; only opaque handles are allowed', () => {
    const withSecret = (reference) => closureFixture((value) => { value.secretReferences = [reference]; return value; });
    const handle = { rootId: ROOT_ID, path: 'config/token', secretHandleId: 'secret-handle-1', revisionId: 'rev-1' };
    assert.equal(validateSourceClosure(withSecret(handle)).ok, true);
    for (const extra of [{ value: 'plaintext' }, { ciphertext: 'abc' }, { token: 'abc' }, { contentDigest: hex('secret') }]) {
        assert.equal(code(validateSourceClosure(withSecret({ ...handle, ...extra }))), 'invalid_request');
    }
    assert.equal(code(validateSourceClosure(withSecret({ ...handle, secretHandleId: 'Bearer abc def' }))), 'invalid_request');
});

test('SRC-09-b (A5.3) a secret reference naming a content entry is invalid_request', () => {
    const overlap = closureFixture((value) => {
        value.secretReferences = [{ rootId: ROOT_ID, path: 'index.mjs', secretHandleId: 'secret-handle-1', revisionId: 'rev-1' }];
        return value;
    });
    assert.equal(code(validateSourceClosure(overlap)), 'invalid_request');
    const disjoint = closureFixture((value) => {
        value.secretReferences = [{ rootId: ROOT_ID, path: 'index.mjs.secret', secretHandleId: 'secret-handle-1', revisionId: 'rev-1' }];
        return value;
    });
    assert.equal(validateSourceClosure(disjoint).ok, true);
});

test('writable reservation, tombstone and every private operation kind validate requests and results exactly', () => {
    const resources = [resource('a')];
    const reservation = {
        version: 1, reservationId: idOf('r'), operationId: idOf('op'), workspaceId: 'ws-1', boxIdentity: 'box-1',
        boxGeneration: 'box-gen-1', sourceStoreIdentity: idOf('store'), workerPrincipal: WORKER,
        workerRuntimeInstanceId: 'i-1', workerEnableGeneration: 'e-1', workerGeneration: idOf('g'), robotId: idOf('robot'),
        executionId: null, attemptId: null, consumerKind: 'terminal', consumerId: idOf('c'), sourceProtectionEpoch: 1,
        sourceSelectionDigest: hex('s'), sourceClosureDigest: hex('c'), sourceAcceptanceIdentity: 'acceptance-1',
        resources, requestDigest: hex('req'), state: 'reserved', createdAtMs: NOW, releaseEvidenceDigest: null,
    };
    assert.equal(validateWritableReservation(reservation).ok, true);
    assert.equal(code(validateWritableReservation({ ...reservation, executionId: idOf('e') })), 'invalid_request');
    assert.equal(code(validateWritableReservation({ ...reservation, state: 'quarantined' })), 'invalid_request');
    assert.equal(code(validateWritableReservation({ ...reservation, state: 'released' })), 'invalid_request');
    assert.equal(validateWritableReservation({ ...reservation, state: 'released', releaseEvidenceDigest: hex('x') }).ok, true);
    assert.equal(code(validateWritableReservation({ ...reservation, resources: [] })), 'invalid_request');
    assert.equal(code(validateWritableReservation({ ...reservation, resources: [{ ...resources[0], access: 'read' }] })), 'invalid_request');
    const many = Array.from({ length: 65 }, (_, index) => resource(`m${index}`)).sort((a, b) => (a.resourceId < b.resourceId ? -1 : 1));
    assert.equal(validateWritableReservation({ ...reservation, resources: many.slice(0, 64) }).ok, true);
    assert.equal(code(validateWritableReservation({ ...reservation, resources: many })), 'capacity_exceeded');
    assert.equal(code(validateWritableReservation({ ...reservation, resources: [...many.slice(0, 2)].reverse() })), 'invalid_request');
    const tombstone = {
        reservationId: idOf('r'), operationId: idOf('op'), requestDigest: hex('req'), workerPrincipal: WORKER,
        workerGeneration: idOf('g'), state: 'released', releaseEvidenceDigest: hex('x'),
    };
    assert.equal(validateReservationTombstone(tombstone).ok, true);

    const reserveRequest = {
        version: 1, operationId: idOf('op'), reservationId: idOf('r'), workspaceId: 'ws-1', boxIdentity: 'box-1',
        boxGeneration: 'box-gen-1', workerGeneration: idOf('g'), robotId: idOf('robot'), executionId: null, attemptId: null,
        consumerKind: 'execution', consumerId: idOf('c'), expectedEpoch: 1, resources,
    };
    assert.equal(validateSourceOperation('reserve', reserveRequest).ok, true);
    assert.equal(validateSourceOperation('reserve', reservation).ok, true);
    assert.equal(validateSourceOperation('reserve', { version: 1, ...tombstone, sourceStoreIdentity: idOf('store') }).ok, true);
    assert.equal(code(validateSourceOperation('reserve', { ...reserveRequest, workerPrincipal: WORKER })), 'invalid_request');
    assert.equal(code(validateSourceOperation('reserve', { ...reserveRequest, expectedEpoch: 0 })), 'invalid_request');
    assert.equal(code(validateSourceOperation('reserve', { ...reserveRequest, version: 2 })), 'unsupported_version');

    const transitionRequest = {
        version: 1, operationId: idOf('t'), workspaceId: 'ws-1', boxIdentity: 'box-1', boxGeneration: 'box-gen-1',
        expectedEpoch: 0, selectionDigest: hex('s'), closureDigest: hex('c'), sourceAcceptanceIdentity: 'acceptance-1',
        enforcementDigest: hex('e'), aliasCoverageDigest: hex('a'),
    };
    assert.equal(validateSourceOperation('transition', transitionRequest).ok, true);
    // ENC-05: expectedEpoch + 1 must not overflow.
    assert.equal(code(validateSourceOperation('transition', { ...transitionRequest, expectedEpoch: Number.MAX_SAFE_INTEGER })), 'invalid_request');
    assert.equal(validateSourceOperation('transition', { ...transitionRequest, expectedEpoch: Number.MAX_SAFE_INTEGER - 1 }).ok, true);
    const record = {
        version: 1, workspaceId: 'ws-1', boxIdentity: 'box-1', boxGeneration: 'box-gen-1', sourceStoreIdentity: idOf('store'),
        sourceProtectionEpoch: 1, sourceSelectionDigest: hex('s'), sourceClosureDigest: hex('c'),
        sourceAcceptanceIdentity: 'acceptance-1', protectionStatus: 'protected', enforcementDigest: hex('e'),
        aliasCoverageDigest: hex('a'), acceptedAtMs: NOW,
    };
    // A5.5: the transition result carries the store identity and a protected record of the next epoch.
    const transitionResult = { version: 1, operationId: idOf('t'), previousEpoch: 0, record, requestDigest: hex('q'), sourceStoreIdentity: idOf('store') };
    assert.equal(validateSourceOperation('transition', transitionResult).ok, true);
    assert.equal(code(validateSourceOperation('transition', { ...transitionResult, previousEpoch: 1 })), 'invalid_request');
    assert.equal(code(validateSourceOperation('transition', { ...transitionResult, sourceStoreIdentity: idOf('other') })), 'invalid_request');
    assert.equal(code(validateSourceOperation('transition', { ...transitionResult, record: { ...record, protectionStatus: 'unavailable' } })), 'invalid_request');
    const { sourceStoreIdentity: omitted, ...withoutStore } = transitionResult;
    assert.equal(code(validateSourceOperation('transition', withoutStore)), 'invalid_request');
    // A5.5: an unavailable record is a valid document with nullable evidence; a protected one needs both digests.
    assert.equal(validateSourceProtectionRecord({ ...record, protectionStatus: 'unavailable', enforcementDigest: null, aliasCoverageDigest: null }).ok, true);
    assert.equal(code(validateSourceProtectionRecord({ ...record, enforcementDigest: null })), 'invalid_request');

    const releaseRequest = {
        version: 1, operationId: idOf('rel'), reservationId: idOf('r'), reservationRequestDigest: hex('req'),
        owningWorkerGeneration: idOf('g'), resourcesDigest: hex('res'), releaseEvidenceDigest: hex('x'),
    };
    assert.equal(validateSourceOperation('release', releaseRequest).ok, true);
    assert.equal(validateSourceOperation('release', {
        version: 1, operationId: idOf('rel'), reservationId: idOf('r'), state: 'released', requestDigest: hex('q'),
        releaseEvidenceDigest: hex('x'), sourceStoreIdentity: idOf('store'),
    }).ok, true);

    const ackRequest = {
        version: 1, operationId: idOf('ack'), sourceStoreIdentity: idOf('store'), workerGeneration: idOf('g'),
        priorStoreIdentities: [idOf('a'), idOf('b')].sort(), settlementAttestationDigest: hex('settle'),
    };
    assert.equal(validateSourceOperation('acknowledge', ackRequest).ok, true);
    assert.equal(code(validateSourceOperation('acknowledge', { ...ackRequest, priorStoreIdentities: [...ackRequest.priorStoreIdentities].reverse() })), 'invalid_request');
    assert.equal(code(validateSourceOperation('acknowledge', { ...ackRequest, priorStoreIdentities: [idOf('store')] })), 'invalid_request');
    const priors = Array.from({ length: 65 }, (_, index) => idOf(`p${index}`)).sort();
    assert.equal(validateSourceOperation('acknowledge', { ...ackRequest, priorStoreIdentities: priors.slice(0, 64) }).ok, true);
    assert.equal(code(validateSourceOperation('acknowledge', { ...ackRequest, priorStoreIdentities: priors })), 'capacity_exceeded');
    assert.equal(validateSourceOperation('acknowledge', {
        version: 1, operationId: idOf('ack'), sourceStoreIdentity: idOf('store'), workerPrincipal: WORKER, state: 'ready', requestDigest: hex('q'),
    }).ok, true);

    assert.equal(validateSourceOperation('advance', { version: 1, operationId: idOf('adv'), priorGeneration: null, nextGeneration: idOf('g') }).ok, true);
    assert.equal(code(validateSourceOperation('advance', { version: 1, operationId: idOf('adv'), priorGeneration: idOf('g'), nextGeneration: idOf('g') })), 'invalid_request');
    assert.equal(validateSourceOperation('advance', {
        version: 1, operationId: idOf('adv'), workerPrincipal: WORKER, priorGeneration: null, currentGeneration: idOf('g'),
        requestDigest: hex('q'),
    }).ok, true);
    // Explicit document types are accepted as well as operation names.
    assert.equal(validateSourceOperation('advanceRequest', { version: 1, operationId: idOf('adv'), priorGeneration: null, nextGeneration: idOf('g') }).ok, true);
    assert.equal(code(validateSourceOperation('advanceResult', { version: 1, operationId: idOf('adv'), priorGeneration: null, nextGeneration: idOf('g') })), 'invalid_request');
    assert.equal(code(validateSourceOperation('retire', {})), 'invalid_request');
});

test('CAP-03 interlock limits are the A2.3 workspace-wide set and never declarable', () => {
    assert.deepEqual({ ...INTERLOCK_LIMITS_V1 }, {
        writableReservations: 4096, sourceStateBytes: 33554432, operationReceipts: 65536, lockWaitMs: 5000,
    });
    assert.equal(Object.isFrozen(INTERLOCK_LIMITS_V1), true);
    assert.equal(Object.hasOwn(INTERLOCK_LIMITS_V1, 'retiredWorkerGenerations'), false);
    for (const enumeration of [CONTRACT_ERROR_CODES, STORE_ERROR_CODES, INTERLOCK_ERROR_CODES]) {
        assert.equal(Object.isFrozen(enumeration), true);
    }
});

// ---------------------------------------------------------------- store creation and identity

test('SRC-10 open with neither witness nor store and no create is source_unavailable and writes nothing', async (t) => {
    const workspaceRoot = tempWorkspace(t);
    const before = listTree(workspaceRoot);
    const result = await openSourceProtectionStore({ workspaceRoot });
    assertResultShape(result);
    assert.equal(code(result), 'source_unavailable');
    assert.deepEqual(listTree(workspaceRoot), before);
    // Creation is lifecycle-only: without a lease proof, or with the refusing
    // default holder enumeration, nothing is created.
    assert.equal(code(await openSourceProtectionStore({ workspaceRoot, create: true })), 'forbidden');
    assert.equal(code(await openSourceProtectionStore({ workspaceRoot, create: true, assertWorkspaceLease: () => { throw new Error('no'); } })), 'forbidden');
    assert.equal(code(await openSourceProtectionStore({ workspaceRoot, create: true, assertWorkspaceLease: () => {} })), 'source_unavailable');
    assert.deepEqual(listTree(workspaceRoot), before);
});

test('SRC-11 exactly one store member present, each way, is state_corrupt and nothing is written', async (t) => {
    for (const remove of ['witness', 'store']) {
        const world = await makeWorld(t);
        const paths = sourceProtectionPaths(world.workspaceRoot);
        if (remove === 'witness') fs.rmSync(paths.witnessFile);
        else fs.rmSync(paths.storeDir, { recursive: true });
        const before = listTree(world.workspaceRoot);
        assert.equal(code(await world.open()), 'state_corrupt', remove);
        assert.equal(code(await world.open({ createStore: true })), 'state_corrupt', remove);
        assert.deepEqual(listTree(world.workspaceRoot), before, remove);
        // The open handle notices too and stops serving.
        assert.equal(code(await world.register()), 'state_corrupt');
    }
});

test('SRC-12 storeId mismatch between witness and snapshot is state_corrupt; never reset', async (t) => {
    const world = await makeWorld(t);
    const paths = sourceProtectionPaths(world.workspaceRoot);
    const witness = JSON.parse(fs.readFileSync(paths.witnessFile, 'utf8'));
    const forged = canonicalTargetJson({ ...witness, storeId: idOf('other-store') }).value;
    fs.writeFileSync(paths.witnessFile, forged);
    const before = listTree(world.workspaceRoot);
    assert.equal(code(await world.open()), 'state_corrupt');
    assert.equal(code(await world.open({ createStore: true })), 'state_corrupt');
    assert.equal(code(await world.register()), 'state_corrupt');
    assert.deepEqual(listTree(world.workspaceRoot), before);
    // A noncanonical witness or snapshot is corrupt as well.
    fs.writeFileSync(paths.witnessFile, `${JSON.stringify(witness, null, 2)}\n`);
    assert.equal(code(await world.open()), 'state_corrupt');
});

test('A2.2 creation crash windows: staging only is never-initialized; witness plus staging is interrupted and completed only under the lease', async (t) => {
    // Crash after the staging directory is durable but before the witness.
    const early = tempWorkspace(t);
    const crashEarly = await openSourceProtectionStore({
        workspaceRoot: early, create: true, assertWorkspaceLease: () => {},
        enumerateExpectedHolders: async () => ({ status: 'known', principals: [] }),
        faults: { afterStagingFsync: () => { throw new Error('crash'); } },
    });
    assert.equal(code(crashEarly), 'outcome_unknown');
    const paths = sourceProtectionPaths(early);
    assert.equal(fs.readdirSync(paths.dataDir).filter((name) => name.startsWith('source-protection.creating-')).length, 1);
    assert.equal(code(await openSourceProtectionStore({ workspaceRoot: early })), 'source_unavailable');
    const recreated = await openSourceProtectionStore({
        workspaceRoot: early, create: true, assertWorkspaceLease: () => {},
        enumerateExpectedHolders: async () => ({ status: 'known', principals: [] }),
    });
    assert.equal(recreated.ok, true);
    assert.deepEqual(fs.readdirSync(paths.dataDir).sort(), ['source-protection', 'source-protection.witness.json']);

    // Crash after the witness is published but before the rename.
    const late = tempWorkspace(t);
    const latePaths = sourceProtectionPaths(late);
    const crashLate = await openSourceProtectionStore({
        workspaceRoot: late, create: true, assertWorkspaceLease: () => {},
        enumerateExpectedHolders: async () => ({ status: 'known', principals: [WORKER] }),
        faults: { afterWitnessPublish: () => { throw new Error('crash'); } },
    });
    assert.equal(code(crashLate), 'outcome_unknown');
    const witnessId = JSON.parse(fs.readFileSync(latePaths.witnessFile, 'utf8')).storeId;
    const before = listTree(late);
    // A3.3: any opener without the workspace mutation lease reports unavailable and writes nothing.
    assert.equal(code(await openSourceProtectionStore({ workspaceRoot: late })), 'source_unavailable');
    assert.equal(code(await openSourceProtectionStore({ workspaceRoot: late, assertWorkspaceLease: () => { throw new Error('no'); } })), 'source_unavailable');
    assert.deepEqual(listTree(late), before);
    const completed = await openSourceProtectionStore({ workspaceRoot: late, assertWorkspaceLease: () => {} });
    assert.equal(completed.ok, true);
    assert.equal(completed.value.storeId, witnessId);
    // Any other combination is corrupt: two staging directories with a witness.
    const other = tempWorkspace(t);
    await openSourceProtectionStore({
        workspaceRoot: other, create: true, assertWorkspaceLease: () => {},
        enumerateExpectedHolders: async () => ({ status: 'known', principals: [] }),
        faults: { afterWitnessPublish: () => { throw new Error('crash'); } },
    });
    const otherPaths = sourceProtectionPaths(other);
    fs.mkdirSync(otherPaths.creatingDir(idOf('stray')));
    assert.equal(code(await openSourceProtectionStore({ workspaceRoot: other, assertWorkspaceLease: () => {} })), 'state_corrupt');
});

// ---------------------------------------------------------------- contexts

test('verified management contexts: missing is unauthorized, copied JSON or foreign authority is forbidden', async (t) => {
    const world = await readyWorld(t);
    const context = world.ctx();
    assert.throws(() => JSON.stringify(context));
    const copied = { ...context, workerPrincipal: WORKER, workerGeneration: world.generation[WORKER] };
    const request = world.reserveRequest('ctx');
    assert.equal(code(await world.interlock.reserveWritableResources(undefined, request)), 'unauthorized');
    assert.equal(code(await world.interlock.reserveWritableResources(copied, request)), 'forbidden');
    assert.equal(code(await world.interlock.reserveWritableResources(JSON.parse('{}'), request)), 'forbidden');
    const foreign = createManagementContextAuthority().worker({
        workerPrincipal: WORKER, workerRuntimeInstanceId: 'worker-instance-1', workerEnableGeneration: 'enable-1',
        workerGeneration: world.generation[WORKER],
    });
    assert.equal(code(await world.interlock.reserveWritableResources(foreign, request)), 'forbidden');
    // Operators do not reserve; workers do not transition.
    assert.equal(code(await world.interlock.reserveWritableResources(world.operator(), request)), 'forbidden');
    assert.equal(code(await world.interlock.prepareSourceTransition(world.ctx(), world.transitionRequest(1))), 'forbidden');
    assert.equal(world.snapshot().reservations.length, 0);
});

test('default evidence providers refuse every protection fact', async () => {
    assert.deepEqual(await DEFAULT_SOURCE_EVIDENCE.enforcement(), { status: 'unprotected' });
    assert.deepEqual(await DEFAULT_SOURCE_EVIDENCE.aliasCoverage(), { status: 'unproven' });
    assert.deepEqual(await DEFAULT_SOURCE_EVIDENCE.resolveWritableResource(), { status: 'unknown' });
    assert.deepEqual(await DEFAULT_SOURCE_EVIDENCE.provenance(), { status: 'unaccepted' });
    assert.deepEqual(await DEFAULT_SOURCE_EVIDENCE.releaseEvidence(), { status: 'unverified' });
});

test('an interlock with refusing defaults never protects, never knows a holder and never releases', async (t) => {
    const world = await makeWorld(t);
    const bare = createSourceProtectionInterlock({ store: world.store, authority: world.authority });
    assert.equal(code(await bare.prepareSourceTransition(world.operator(), world.transitionRequest(0))), 'source_unavailable');
    const scoped = createSourceProtectionInterlock({
        store: world.store, authority: world.authority, currentScope: async () => structuredClone(world.scope),
    });
    assert.equal((await world.register()).ok, true);
    assert.equal((await world.ack()).ok, true);
    assert.equal(code(await scoped.prepareSourceTransition(world.operator(), world.transitionRequest(0))), 'source_provenance_unaccepted');
    assert.equal((await world.transition(0)).ok, true);
    // Holder predicate default: unknown -> unavailable, never authority.
    assert.equal(code(await scoped.reserveWritableResources(world.ctx(), world.reserveRequest('d'))), 'source_unavailable');
    const holderOnly = createSourceProtectionInterlock({
        store: world.store, authority: world.authority, currentScope: async () => structuredClone(world.scope),
        isSourceReservationHolder: async () => ({ status: 'holder' }),
    });
    assert.equal(code(await holderOnly.reserveWritableResources(world.ctx(), world.reserveRequest('d'))), 'source_unprotected');
    const reserved = await world.reserve('d');
    assert.equal(reserved.ok, true);
    assert.equal(code(await holderOnly.releaseWritableReservation(world.ctx(), world.releaseRequest(reserved.value))), 'release_unverified');
    assert.equal(world.snapshot().reservations.length, 1);
});

test('each refusing default maps to its own code: source_provenance_unaccepted, source_unprotected, source_alias_unproven', async (t) => {
    const world = await makeWorld(t);
    assert.equal((await world.register()).ok, true);
    assert.equal((await world.ack()).ok, true);
    const build = (evidence) => createSourceProtectionInterlock({
        store: world.store, authority: world.authority, currentScope: async () => structuredClone(world.scope), evidence,
    });
    const provenanceOnly = build({ provenance: world.evidence.provenance });
    assert.equal(code(await provenanceOnly.prepareSourceTransition(world.operator(), world.transitionRequest(0))), 'source_unprotected');
    const withoutAlias = build({ provenance: world.evidence.provenance, enforcement: world.evidence.enforcement });
    assert.equal(code(await withoutAlias.prepareSourceTransition(world.operator(), world.transitionRequest(0))), 'source_alias_unproven');
    assert.equal(world.snapshot().record, null);
});

// ---------------------------------------------------------------- source vectors

test('SRC-01 stale protection epoch refuses reserve and transition', async (t) => {
    const world = await readyWorld(t);
    assert.equal(code(await world.reserve('stale', { epoch: 2 })), 'stale_source_epoch');
    assert.equal(code(await world.transition(0, 'again')), 'stale_source_epoch');
    assert.equal(code(await world.transition(2, 'future')), 'stale_source_epoch');
    assert.equal(world.snapshot().reservations.length, 0);
    assert.equal(world.snapshot().record.sourceProtectionEpoch, 1);
});

test('SRC-02 writable workspace, managed, link-install, ancestor and descendant sources overlap', async (t) => {
    const world = await readyWorld(t);
    const cases = {
        workspace: '/ws/src/lib',
        managed: '/ws/.ploinky/repos/fixtures',
        'link-install': '/ws/agents/linked',
        ancestor: '/ws',
        descendant: '/ws/agents/linked/deep/file',
    };
    for (const [label, candidate] of Object.entries(cases)) {
        const item = resource(`src02-${label}`);
        world.views.set(item.resourceId, { status: 'resolved', paths: [candidate], identities: [] });
        assert.equal(code(await world.reserve(`src02-${label}`, { resources: [item] })), 'protected_source_overlap', label);
    }
    const unrelated = resource('src02-unrelated');
    world.views.set(unrelated.resourceId, { status: 'resolved', paths: ['/ws/srcx'], identities: [] });
    assert.equal((await world.reserve('src02-unrelated', { resources: [unrelated] })).ok, true);
    assert.equal(world.snapshot().reservations.length, 1);
});

test('SRC-03 an inode, bind or hard-link alias of a protected root overlaps', async (t) => {
    const world = await readyWorld(t);
    const bind = { ...resource('src03-bind'), rootIdentity: fsId(100, 'directory', '5') };
    world.views.set(bind.resourceId, { status: 'resolved', paths: ['/elsewhere/bind'], identities: [] });
    assert.equal(code(await world.reserve('src03-bind', { resources: [bind] })), 'protected_source_overlap');
    const hardLink = resource('src03-hard');
    world.views.set(hardLink.resourceId, { status: 'resolved', paths: ['/elsewhere/hard'], identities: [fsId(301, 'regular', '9')] });
    assert.equal(code(await world.reserve('src03-hard', { resources: [hardLink] })), 'protected_source_overlap');
    assert.equal(classifyWritableOverlap({ paths: ['/x'], identities: [fsId(100, 'directory', '7')] }, coverageRoots()), 'overlap');
    assert.equal(classifyWritableOverlap({ paths: ['/x'], identities: [fsId(100, 'directory', '7', 'fs-b')] }, coverageRoots()), 'disjoint');
    assert.equal(world.snapshot().reservations.length, 0);
});

test('SRC-04 unknown hard-link/bind coverage or mount identity is source_alias_unproven', async (t) => {
    const world = await readyWorld(t);
    const unknown = resource('src04-unknown');
    world.views.set(unknown.resourceId, { status: 'unknown' });
    assert.equal(code(await world.reserve('src04-unknown', { resources: [unknown] })), 'source_alias_unproven');
    const badMount = resource('src04-mount');
    world.views.set(badMount.resourceId, { status: 'resolved', paths: ['/ws/robots/x'], identities: [{ ...fsId(9), mountId: 'unknown' }] });
    assert.equal(code(await world.reserve('src04-mount', { resources: [badMount] })), 'source_alias_unproven');
    const stale = { ...resource('src04-digest'), aliasCoverageDigest: hex('other-coverage') };
    assert.equal(code(await world.reserve('src04-digest', { resources: [stale] })), 'source_alias_unproven');
    world.coverage = [coverageRoots()[1]];
    assert.equal(code(await world.reserve('src04-coverage')), 'source_alias_unproven');
    const narrow = aliasCoverageDigest(world.coverage);
    // Coverage that misses a closure root never accepts a transition.
    assert.equal(code(await world.transition(1, 'narrow', { aliasCoverageDigest: narrow })), 'source_alias_unproven');
    assert.equal(world.snapshot().record.sourceProtectionEpoch, 1);
});

test('SRC-04-b (A5.2) an uncovered dependency root refuses source_alias_unproven; the epoch is unchanged and no reserve is admitted under it', async (t) => {
    const uncovered = closureFixture((value) => {
        value.dependencies = [{
            id: idOf('dep-999'), kind: 'shared-library', selectionDigest: hex('dep-selection'), closureDigest: hex('dep-closure'),
            rootIdentity: fsId(999), lockDigest: null,
        }];
        value.entries[0].dependencyIdentity = idOf('dep-999');
        return value;
    });
    const overDependency = { ...resource('src04b'), rootIdentity: fsId(999) };
    // First acceptance: nothing becomes protected.
    const fresh = await makeWorld(t);
    assert.equal((await fresh.register()).ok, true);
    assert.equal((await fresh.ack()).ok, true);
    fresh.closure = uncovered;
    await refusedUnchanged(fresh, () => fresh.transition(0, 'src04b', { closureDigest: digestOf(uncovered) }), 'source_alias_unproven');
    assert.equal(fresh.snapshot().record, null);
    await refusedUnchanged(fresh, () => fresh.reserve('src04b', { resources: [overDependency] }), 'source_unprotected');
    // Later transition: epoch 1 stays, a reserve against the would-be epoch is not admitted.
    const world = await readyWorld(t);
    world.closure = uncovered;
    await refusedUnchanged(world, () => world.transition(1, 'src04b', { closureDigest: digestOf(uncovered) }), 'source_alias_unproven');
    assert.equal(world.snapshot().record.sourceProtectionEpoch, 1);
    await refusedUnchanged(world, () => world.reserve('src04b', { epoch: 2, resources: [overDependency] }), 'stale_source_epoch');
    // Covering the dependency root makes the same closure acceptable.
    world.coverage = [...coverageRoots(), { kind: 'dependency-store', rootIdentity: fsId(999), paths: ['/ws/.deps/lib'], aliases: [], writable: false }];
    const covered = await world.transition(1, 'src04b-covered', { closureDigest: digestOf(uncovered), aliasCoverageDigest: aliasCoverageDigest(world.coverage) });
    assert.equal(covered.ok, true);
    world.views.set(overDependency.resourceId, { status: 'resolved', paths: ['/ws/robots/x'], identities: [] });
    const coveredResource = { ...overDependency, aliasCoverageDigest: aliasCoverageDigest(world.coverage) };
    await refusedUnchanged(world, () => world.reserve('src04b-after', { epoch: 2, resources: [coveredResource] }), 'protected_source_overlap');
});

test('SRC-05 and SRC-06 a changed dirty file, mode, link target or dependency with an unchanged HEAD is a binding mismatch', async (t) => {
    const world = await readyWorld(t);
    const mutations = {
        'SRC-05 dirty content': (value) => { value.entries[0].contentDigest = hex('changed'); value.entries[0].gitState = 'tracked-dirty'; return value; },
        'SRC-05 untracked loadable file': (value) => {
            value.entries.push({ ...value.entries[0], path: 'zz-new.mjs', gitState: 'untracked', contentDigest: hex('new'), resolvedIdentity: fsId(150, 'regular') });
            return value;
        },
        'SRC-06 executable mode': (value) => { value.entries[0].mode = '0755'; return value; },
        'SRC-06 symlink target': (value) => { value.entries[2].linkTarget = './index.mjs'; return value; },
        'SRC-06 dependency identity': (value) => {
            value.dependencies = [{ id: idOf('dep'), kind: 'link-install', selectionDigest: hex('ds'), closureDigest: hex('dc'), rootIdentity: fsId(300), lockDigest: hex('lock') }];
            value.entries[0].dependencyIdentity = idOf('dep');
            return value;
        },
    };
    for (const [label, mutate] of Object.entries(mutations)) {
        world.closure = closureFixture(mutate);
        assert.equal(validateSourceClosure(world.closure).ok, true, label);
        assert.equal(code(await world.transition(1, label)), 'source_binding_mismatch', label);
    }
    world.closure = closureFixture();
    world.selection = selectionFixture('dev');
    assert.equal(code(await world.transition(1, 'mode')), 'source_binding_mismatch');
    assert.equal(world.snapshot().record.sourceProtectionEpoch, 1);
});

test('SRC-07 matching hashes without accepted provenance are refused', async (t) => {
    const world = await readyWorld(t);
    world.provenance = 'unaccepted';
    assert.equal(code(await world.transition(1, 'unaccepted')), 'source_provenance_unaccepted');
    world.provenance = 'accepted';
    world.acceptance = 'acceptance-other';
    assert.equal(code(await world.transition(1, 'other-acceptance')), 'source_provenance_unaccepted');
    world.acceptance = 'acceptance-1';
    world.closure = closureFixture((value) => { value.secretReferences = [{ rootId: ROOT_ID, path: 'x', secretHandleId: 'h', revisionId: 'r', value: 'secret' }]; return value; });
    assert.equal(code(await world.transition(1, 'secret')), 'source_provenance_unaccepted');
    assert.equal(world.snapshot().record.sourceProtectionEpoch, 1);
});

test('SRC-08 prod with a writable backing or link-install alias is unprotected; a caller digest alone is insufficient', async (t) => {
    const world = await readyWorld(t);
    world.coverage = coverageRoots({ writableLink: true });
    const writableDigest = aliasCoverageDigest(world.coverage);
    assert.equal(code(await world.transition(1, 'writable', { aliasCoverageDigest: writableDigest })), 'source_unprotected');
    assert.equal(code(await world.reserve('src08')), 'source_alias_unproven');
    world.coverage = coverageRoots();
    assert.equal(code(await world.transition(1, 'claimed', { enforcementDigest: hex('caller-claimed') })), 'source_unprotected');
    world.enforcementDigest = hex('changed-mechanism');
    assert.equal(code(await world.reserve('src08-enforcement')), 'source_unprotected');
    assert.equal(world.snapshot().record.sourceProtectionEpoch, 1);
    assert.equal(world.snapshot().reservations.length, 0);
});

test('SRC-13 a worker holding store-A reservations sees store B: no release by absence, acknowledgement before any reserve', async (t) => {
    const world = await readyWorld(t);
    const held = await world.reserve('src13');
    assert.equal(held.ok, true);
    assert.equal(held.value.sourceStoreIdentity, world.store.storeId);
    const storeA = world.store.storeId;
    const paths = sourceProtectionPaths(world.workspaceRoot);
    fs.rmSync(paths.witnessFile);
    fs.rmSync(paths.storeDir, { recursive: true });
    const recreated = await world.open({ createStore: true });
    assert.equal(recreated.ok, true);
    world.attach(recreated.value);
    assert.notEqual(world.store.storeId, storeA);
    assert.equal((await world.register(WORKER, world.generation[WORKER])).ok, true);
    // A missing reservation in a new store is never evidence of release.
    assert.equal(code(await world.release(held.value)), 'not_found');
    assert.equal(code(await world.reserve('src13-b')), 'source_unavailable');
});

test('SRC-14 a recreated store refuses transitions until every expected holder acknowledges', async (t) => {
    const world = await readyWorld(t);
    assert.equal((await world.reserve('src14')).ok, true);
    const paths = sourceProtectionPaths(world.workspaceRoot);
    fs.rmSync(paths.witnessFile);
    fs.rmSync(paths.storeDir, { recursive: true });
    world.attach((await world.open({ createStore: true })).value);
    assert.equal(world.snapshot().holders.state, 'awaiting-holder-ack');
    assert.equal((await world.register()).ok, true);
    assert.equal(code(await world.transition(0, 'b0')), 'source_unavailable');
    // The worker still holds unsettled store-A intents, so it does not acknowledge (worker-side rule); the
    // store therefore stays blocked.
    assert.equal(code(await world.transition(0, 'b0-again')), 'source_unavailable');
    const acknowledged = await world.ack();
    assert.equal(acknowledged.ok, true);
    assert.equal(acknowledged.value.state, 'ready');
    const transition = await world.transition(0, 'b0-final');
    assert.equal(transition.ok, true);
    assert.equal(world.snapshot().reservations.length, 0);
    assert.equal(transition.value.record.sourceStoreIdentity, world.store.storeId);
});

test('SRC-15 a later-added holder that has not acknowledged cannot reserve', async (t) => {
    const world = await readyWorld(t);
    assert.equal((await world.register(LATE)).ok, true);
    await refusedUnchanged(world, () => world.reserve('src15', { principal: LATE }), 'source_unavailable');
    // Transitions are not blocked by it.
    assert.equal((await world.transition(1, 'late')).ok, true);
    assert.equal((await world.ack(LATE)).ok, true);
    assert.equal((await world.reserve('src15', { principal: LATE, epoch: 2 })).ok, true);
});

test('SRC-16 a principal without the declaration is forbidden to reserve; a removed declaration with a live instance still blocks until it acknowledges', async (t) => {
    const world = await makeWorld(t, { holders: [REMOVED, WORKER], predicate: { [WORKER]: 'holder', [REMOVED]: 'not-holder', [OTHER]: 'not-holder' } });
    for (const principal of [WORKER, REMOVED, OTHER]) assert.equal((await world.register(principal)).ok, true);
    assert.equal((await world.ack(WORKER)).ok, true);
    await refusedUnchanged(world, () => world.transition(0), 'source_unavailable');
    // A principal outside the expected set without the declaration cannot even acknowledge.
    await refusedUnchanged(world, () => world.ack(OTHER), 'forbidden');
    // A4: an expected holder acknowledges even after its declaration was removed.
    assert.equal((await world.ack(REMOVED)).value.state, 'ready');
    assert.equal((await world.transition(0)).ok, true);
    await refusedUnchanged(world, () => world.reserve('src16-removed', { principal: REMOVED }), 'forbidden');
    await refusedUnchanged(world, () => world.reserve('src16-other', { principal: OTHER }), 'forbidden');
    assert.equal((await world.reserve('src16-worker')).ok, true);
    world.predicate[WORKER] = 'unknown';
    await refusedUnchanged(world, () => world.reserve('src16-unknown'), 'source_unavailable');
});

// ---------------------------------------------------------------- reservations

test('RSV-01 identical reserve replay after a lost reply returns the same reservation without a second record', async (t) => {
    const world = await readyWorld(t);
    const crashing = await world.reopen({ storeFaults: { beforeReply: () => { throw new Error('lost reply'); } } });
    const lost = await crashing.reserveWritableResources(world.ctx(), world.reserveRequest('rsv01'));
    assert.equal(code(lost), 'outcome_unknown');
    // The crashed process left its lock; a restarted controller proves it dead and reclaims it.
    world.alive.delete(world.pid);
    world.pid = 1002;
    world.alive.add(1002);
    await world.reopen();
    const first = await world.reserve('rsv01');
    const second = await world.reserve('rsv01');
    assert.equal(first.ok, true);
    assert.deepEqual(second.value, first.value);
    assert.equal(world.snapshot().reservations.length, 1);
    assertResultShape(first);
});

test('RSV-02 the same operation ID with altered resources conflicts', async (t) => {
    const world = await readyWorld(t);
    assert.equal((await world.reserve('rsv02')).ok, true);
    const altered = world.reserveRequest('rsv02', { resources: [resource('rsv02-other')] });
    assert.equal(code(await world.interlock.reserveWritableResources(world.ctx(), altered)), 'operation_conflict');
    const reused = world.reserveRequest('rsv02-new', { operationId: idOf('reserve-op:rsv02-x') });
    assert.equal((await world.interlock.reserveWritableResources(world.ctx(), reused)).ok, true);
    const sameReservation = world.reserveRequest('rsv02', { operationId: idOf('reserve-op:rsv02-y') });
    assert.equal(code(await world.interlock.reserveWritableResources(world.ctx(), sameReservation)), 'operation_conflict');
    assert.equal(world.snapshot().reservations.length, 2);
});

test('RSV-03 releasing an unknown reservation ID is not_found, never success', async (t) => {
    const world = await readyWorld(t);
    const phantom = {
        reservationId: idOf('nobody'), requestDigest: hex('x'), workerGeneration: world.generation[WORKER], resources: [resource('p')],
    };
    assert.equal(code(await world.release(phantom)), 'not_found');
});

test('RSV-04 release while a handle remains or evidence omits a child is release_unverified', async (t) => {
    const world = await readyWorld(t);
    const reserved = (await world.reserve('rsv04', { resources: [resource('rsv04-a'), resource('rsv04-b')].sort((a, b) => (a.resourceId < b.resourceId ? -1 : 1)) })).value;
    world.releaseProof.set(reserved.reservationId, () => ({ status: 'incomplete' }));
    assert.equal(code(await world.release(reserved)), 'release_unverified');
    world.releaseProof.set(reserved.reservationId, ({ reservation }) => ({
        status: 'absent', evidenceDigest: hex(`absent:${reservation.reservationId}`), absentResourceIds: [reservation.resources[0].resourceId],
    }));
    assert.equal(code(await world.release(reserved, { label: 'omit' })), 'release_unverified');
    world.releaseProof.delete(reserved.reservationId);
    assert.equal(code(await world.release(reserved, { label: 'digest', overrides: { releaseEvidenceDigest: hex('stale-evidence') } })), 'release_unverified');
    assert.equal(code(await world.release(reserved, { label: 'resources', overrides: { resourcesDigest: hex('fewer') } })), 'release_unverified');
    assert.equal(world.snapshot().reservations.length, 1);
    assert.equal((await world.release(reserved, { label: 'complete' })).ok, true);
});

test('RSV-05 quarantine presented as release is resource_quarantined and the reservation stays', async (t) => {
    const world = await readyWorld(t);
    const reserved = (await world.reserve('rsv05')).value;
    world.releaseProof.set(reserved.reservationId, () => ({ status: 'quarantined' }));
    assert.equal(code(await world.release(reserved)), 'resource_quarantined');
    assert.equal(world.snapshot().reservations[0].state, 'reserved');
    assert.equal(code(await world.transition(1, 'q')), 'source_transition_blocked');
});

async function gate() {
    let open;
    let entered;
    const reached = new Promise((resolve) => { entered = resolve; });
    const released = new Promise((resolve) => { open = resolve; });
    return { wait: async () => { entered(); await released; }, reached, open };
}

test('T1-05 / RSV-06 deterministic schedule: reserve before transition — the transition is blocked', async (t) => {
    const world = await readyWorld(t);
    const second = await makeWorld(t, { workspaceRoot: world.workspaceRoot, create: false, pid: 2001, alive: world.alive });
    second.authority = world.authority;
    second.scope = world.scope;
    second.attach((await second.open()).value);
    const hold = await gate();
    world.gates.enforcement = hold.wait;
    const reserving = world.reserve('rsv06-a');
    await hold.reached;
    const transitioning = second.interlock.prepareSourceTransition(world.operator(), world.transitionRequest(1, 'rsv06-a'));
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    hold.open();
    const [reserved, transitioned] = await Promise.all([reserving, transitioning]);
    assert.equal(reserved.ok, true);
    assert.equal(reserved.value.sourceProtectionEpoch, 1);
    assert.equal(code(transitioned), 'source_transition_blocked');
    assert.equal(world.snapshot().record.sourceProtectionEpoch, 1);
});

test('T1-05 / RSV-06 deterministic schedule: transition before reserve — the reserve sees a stale epoch', async (t) => {
    const world = await readyWorld(t);
    const second = await makeWorld(t, { workspaceRoot: world.workspaceRoot, create: false, pid: 2002, alive: world.alive });
    second.authority = world.authority;
    second.scope = world.scope;
    second.generation = world.generation;
    second.attach((await second.open()).value);
    const hold = await gate();
    world.gates.provenance = hold.wait;
    const transitioning = world.transition(1, 'rsv06-b');
    await hold.reached;
    const reserving = second.reserve('rsv06-b');
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    hold.open();
    const [transitioned, reserved] = await Promise.all([transitioning, reserving]);
    assert.equal(transitioned.ok, true);
    assert.equal(transitioned.value.record.sourceProtectionEpoch, 2);
    assert.equal(code(reserved), 'stale_source_epoch');
    assert.equal(world.snapshot().reservations.length, 0);
});

test('RSV-07 / T1-05 terminal, retained GUI, pending-create, unknown, quarantined and prior-generation reservations block transition, including after reopen', async (t) => {
    const world = await readyWorld(t);
    const kinds = [
        ['terminal', { consumerKind: 'terminal', resources: [resource('t')] }],
        ['retained-gui', { consumerKind: 'retained-gui', resources: [resource('g', { kind: 'retained-gui' })] }],
        ['pending-create', { resources: [resource('p', { kind: 'pending-create' })] }],
    ];
    const reservations = [];
    for (const [label, options] of kinds) reservations.push((await world.reserve(`rsv07-${label}`, options)).value);
    // Unknown outcome: a reserve whose reply was lost is committed and keeps blocking.
    const lossy = await world.reopen({ storeFaults: { afterCommit: () => { throw new Error('crash after commit'); } } });
    assert.equal(code(await lossy.reserveWritableResources(world.ctx(), world.reserveRequest('rsv07-unknown'))), 'outcome_unknown');
    world.alive.delete(world.pid);
    world.pid = 1003;
    world.alive.add(1003);
    await world.reopen();
    // Quarantined: a release attempt that found a quarantined resource.
    world.releaseProof.set(reservations[0].reservationId, () => ({ status: 'quarantined' }));
    assert.equal(code(await world.release(reservations[0])), 'resource_quarantined');
    // Prior generation: the worker advances; old-generation reservations stay.
    assert.equal((await world.register(WORKER, idOf('gen:worker:2'), world.generation[WORKER])).ok, true);
    await world.reopen();
    const snapshot = world.snapshot();
    assert.equal(snapshot.reservations.length, 4);
    assert.ok(snapshot.reservations.every((item) => item.state === 'reserved' && item.workerGeneration === idOf(`gen:${WORKER}:1`)));
    assert.equal(code(await world.transition(1, 'rsv07')), 'source_transition_blocked');
});

test('RSV-08 a broker child asking for a wider grant overlapping protected source writes nothing', async (t) => {
    const world = await readyWorld(t);
    const before = fs.readFileSync(sourceProtectionPaths(world.workspaceRoot).stateFile);
    const broker = resource('rsv08', { kind: 'broker-write' });
    world.views.set(broker.resourceId, { status: 'resolved', paths: ['/ws/src'], identities: [] });
    assert.equal(code(await world.reserve('rsv08', { consumerKind: 'broker', resources: [broker] })), 'protected_source_overlap');
    assert.deepEqual(fs.readFileSync(sourceProtectionPaths(world.workspaceRoot).stateFile), before);
});

test('RSV-09..RSV-13 release across generations, principals and Box recreation (A1.2)', async (t) => {
    const world = await readyWorld(t);
    const g1 = world.generation[WORKER];
    const old = (await world.reserve('rsv09')).value;
    const old2 = (await world.reserve('rsv09-b')).value;
    assert.equal((await world.register(OTHER)).ok, true);
    // Box recreation: new Box generation and new worker instance at a new generation.
    world.scope.boxGeneration = 'box-gen-2';
    world.scope.workerInstances[WORKER] = { workerRuntimeInstanceId: 'worker-instance-2', workerEnableGeneration: 'enable-2' };
    const superseded = world.authority.worker({
        workerPrincipal: WORKER, workerRuntimeInstanceId: 'worker-instance-1', workerEnableGeneration: 'enable-1', workerGeneration: g1,
    });
    assert.equal((await world.register(WORKER, idOf('gen:worker:2'), g1)).ok, true);
    // RSV-13: the old-generation record is never launch authority under the new Box generation.
    assert.equal(code(await world.reserve('rsv13-new')), 'source_unprotected');
    assert.equal(code(await world.transition(1, 'rsv13-blocked')), 'source_transition_blocked');
    // RSV-10 superseded writer.
    assert.equal(code(await world.release(old, { context: superseded })), 'stale_generation');
    // RSV-11 other principal.
    assert.equal(code(await world.release(old, { context: world.ctx(OTHER) })), 'forbidden');
    // RSV-12 wrong owning generation.
    assert.equal(code(await world.release(old, { label: 'wrong-owner', overrides: { owningWorkerGeneration: idOf('gen:worker:2') } })), 'operation_conflict');
    // RSV-09 successor releases with exact evidence.
    const released = await world.release(old);
    assert.equal(released.ok, true);
    assert.deepEqual(Object.keys(released.value).sort(), ['operationId', 'releaseEvidenceDigest', 'requestDigest', 'reservationId', 'sourceStoreIdentity', 'state', 'version']);
    assert.equal(code(await world.transition(1, 'rsv13-still')), 'source_transition_blocked');
    // A2.4 operator release requires Ploinky-verified absence of the exact owning instance.
    world.releaseProof.set(old2.reservationId, ({ reservation }) => ({
        status: 'absent', evidenceDigest: hex(`absent:${reservation.reservationId}`),
        absentResourceIds: reservation.resources.map((item) => item.resourceId), ownerInstanceAbsent: false,
        ownerRuntimeInstanceId: reservation.workerRuntimeInstanceId,
    }));
    assert.equal(code(await world.release(old2, { context: world.operator(), label: 'op' })), 'release_unverified');
    world.releaseProof.set(old2.reservationId, ({ reservation }) => ({
        status: 'absent', evidenceDigest: hex(`absent:${reservation.reservationId}`),
        absentResourceIds: reservation.resources.map((item) => item.resourceId), ownerInstanceAbsent: true,
        ownerRuntimeInstanceId: 'worker-instance-2',
    }));
    assert.equal(code(await world.release(old2, { context: world.operator(), label: 'op2' })), 'release_unverified');
    world.releaseProof.delete(old2.reservationId);
    assert.equal((await world.release(old2, { context: world.operator(), label: 'op3' })).ok, true);
    const receipts = world.snapshot().receipts.filter((item) => item.kind === 'release');
    assert.ok(receipts.some((item) => item.actor.kind === 'operator' && item.actor.operatorIdentity === 'operator-lifecycle'));
    // Only now may the source be accepted for the new Box generation, with a new epoch.
    const transition = await world.transition(1, 'rsv13-ok');
    assert.equal(transition.ok, true);
    assert.equal(transition.value.record.boxGeneration, 'box-gen-2');
    assert.equal(transition.value.record.sourceProtectionEpoch, 2);
    assert.equal((await world.reserve('rsv13-after', { epoch: 2 })).ok, true);
});

test('RSV-14 a delayed duplicate reserve after release returns the tombstone and creates nothing', async (t) => {
    const world = await readyWorld(t);
    const reserved = (await world.reserve('rsv14')).value;
    assert.equal((await world.release(reserved)).ok, true);
    const duplicate = await world.reserve('rsv14');
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.value.state, 'released');
    assert.equal(duplicate.value.reservationId, reserved.reservationId);
    assert.equal(duplicate.value.sourceStoreIdentity, world.store.storeId);
    assert.equal(world.snapshot().reservations.length, 0);
    // Identical release retry reconciles; a changed body conflicts; another operation on it conflicts.
    assert.deepEqual((await world.release(reserved)).value, (await world.release(reserved)).value);
    assert.equal(code(await world.release(reserved, { overrides: { releaseEvidenceDigest: hex('other') } })), 'operation_conflict');
    assert.equal(code(await world.release(reserved, { label: 'second' })), 'operation_conflict');
});

test('RSV-15 (A2.3 as amended by A6.2) a superseded generation retrieves exactly its recorded reserve, and is stale_generation once nothing is recorded', async (t) => {
    const world = await readyWorld(t);
    const g1 = world.generation[WORKER];
    const pending = (await world.reserve('rsv15-pending')).value;
    const done = (await world.reserve('rsv15-done')).value;
    assert.equal((await world.release(done)).ok, true);
    const oldContext = world.ctx(WORKER, g1);
    const recordedBody = (label) => world.reserveRequest(label, { workerGeneration: g1 });
    const doneBody = recordedBody('rsv15-done');
    const pendingBody = recordedBody('rsv15-pending');
    assert.equal((await world.register(WORKER, idOf('gen:worker:2'), g1)).ok, true);
    // A6.2: the identical recorded body returns the recorded result, never a new record.
    const tombstone = await world.interlock.reserveWritableResources(oldContext, doneBody);
    assert.equal(tombstone.value.state, 'released');
    assert.deepEqual((await world.interlock.reserveWritableResources(oldContext, pendingBody)).value, pending);
    // A changed body under the same operation ID conflicts.
    assert.equal(code(await world.interlock.reserveWritableResources(oldContext, { ...pendingBody, consumerKind: 'terminal' })), 'operation_conflict');
    assert.equal((await world.release(pending)).ok, true);
    // Generation 1 is now fully released and compacted: the duplicate finds nothing and refuses.
    assert.equal(world.snapshot().tombstones.filter((item) => item.workerGeneration === g1).length, 0);
    const before = fs.readFileSync(sourceProtectionPaths(world.workspaceRoot).stateFile);
    assert.equal(code(await world.interlock.reserveWritableResources(oldContext, doneBody)), 'stale_generation');
    assert.deepEqual(fs.readFileSync(sourceProtectionPaths(world.workspaceRoot).stateFile), before);
    assert.equal(world.snapshot().reservations.length, 0);
});

test('A6.2 reserve and release look up the operation first; never-recorded stale requests create nothing', async (t) => {
    const world = await readyWorld(t);
    const g1 = world.generation[WORKER];
    const g2 = idOf('gen:worker:2');
    const paths = sourceProtectionPaths(world.workspaceRoot);
    const recorded = (await world.reserve('a62-recorded')).value;
    const pinned = (await world.reserve('a62-pinned')).value;
    const released = await world.release(recorded);
    assert.equal(released.ok, true);
    const neverRecorded = world.reserveRequest('a62-never', { workerGeneration: g1 });
    const oldContext = world.ctx(WORKER, g1);
    assert.equal((await world.register(WORKER, g2, g1)).ok, true);
    // Identical reserve retry from the superseded generation returns the recorded reservation.
    assert.deepEqual((await world.interlock.reserveWritableResources(oldContext, world.reserveRequest('a62-pinned', { workerGeneration: g1 }))).value, pinned);
    // Identical release retry from the superseded generation returns the recorded release
    // (generation 1 is still pinned by an unreleased reservation, so its receipt is retained).
    assert.deepEqual((await world.interlock.releaseWritableReservation(oldContext, world.releaseRequest(recorded))).value, released.value);
    // A non-recorded operation from that generation is stale_generation and creates nothing.
    let before = fs.readFileSync(paths.stateFile);
    assert.equal(code(await world.interlock.reserveWritableResources(oldContext, neverRecorded)), 'stale_generation');
    assert.equal(code(await world.interlock.releaseWritableReservation(oldContext, world.releaseRequest(pinned, 'a62-never'))), 'stale_generation');
    assert.deepEqual(fs.readFileSync(paths.stateFile), before);
    assert.equal((await world.release(pinned)).ok, true);
    // Epoch: a never-recorded reserve with the old expectedEpoch after a transition is stale_source_epoch.
    const oldEpoch = world.reserveRequest('a62-epoch', { epoch: 1 });
    const recordedAtEpoch1 = (await world.reserve('a62-epoch-recorded', { epoch: 1 })).value;
    assert.equal((await world.release(recordedAtEpoch1, { label: 'a62-epoch' })).ok, true);
    assert.equal((await world.transition(1, 'a62')).ok, true);
    before = fs.readFileSync(paths.stateFile);
    assert.equal(code(await world.interlock.reserveWritableResources(world.ctx(), oldEpoch)), 'stale_source_epoch');
    assert.deepEqual(fs.readFileSync(paths.stateFile), before);
    // ...while the identical retry of an operation recorded at the old epoch still returns its record.
    assert.equal((await world.reserve('a62-epoch-recorded', { epoch: 1 })).value.state, 'released');
});

test('RSV-16 compaction never removes current-generation tombstones or unreleased reservations', async (t) => {
    const world = await readyWorld(t);
    const g1 = world.generation[WORKER];
    const kept = (await world.reserve('rsv16-kept')).value;
    const released = (await world.reserve('rsv16-released')).value;
    assert.equal((await world.release(released)).ok, true);
    assert.equal(world.snapshot().tombstones.length, 1);
    const g2 = idOf('gen:worker:2');
    assert.equal((await world.register(WORKER, g2, g1)).ok, true);
    // Generation 1 still has an unreleased reservation: nothing of it is compacted.
    let snapshot = world.snapshot();
    assert.equal(snapshot.reservations.length, 1);
    assert.equal(snapshot.tombstones.length, 1);
    const current = (await world.reserve('rsv16-current', { workerGeneration: g2 })).value;
    assert.equal((await world.release(current)).ok, true);
    assert.equal((await world.release(kept)).ok, true);
    snapshot = world.snapshot();
    assert.deepEqual(snapshot.tombstones.map((item) => item.workerGeneration), [g2]);
    assert.ok(snapshot.receipts.every((item) => item.ownerGeneration === null || item.ownerGeneration === g2));
    // The retained current-generation tombstone still answers its duplicate.
    assert.equal((await world.reserve('rsv16-current', { workerGeneration: g2 })).value.state, 'released');
});

test('RSV-17, RSV-18 and RSV-19 generation pointer compare-and-set', async (t) => {
    const world = await readyWorld(t);
    const g1 = world.generation[WORKER];
    const g2 = idOf('gen:worker:2');
    const g3 = idOf('gen:worker:3');
    // RSV-17: wrong prior.
    assert.equal(code(await world.register(WORKER, g2, idOf('gen:worker:unknown'))), 'stale_generation');
    assert.equal(code(await world.register(WORKER, g2, null)), 'stale_generation');
    // RSV-19: G2 rolled in S1 but never registered; next start G3 advances from the registered G1.
    assert.equal((await world.register(WORKER, g3, g1)).ok, true);
    const g2Context = world.ctx(WORKER, g2);
    assert.equal(code(await world.interlock.reserveWritableResources(g2Context, { ...world.reserveRequest('rsv19'), workerGeneration: g2 })), 'stale_generation');
    assert.equal(code(await world.interlock.acknowledgeSourceStore(g2Context, {
        version: 1, operationId: idOf('rsv19-ack'), sourceStoreIdentity: world.store.storeId, workerGeneration: g2,
        priorStoreIdentities: [], settlementAttestationDigest: hex('s'),
    })), 'stale_generation');
    assert.equal(code(await world.register(WORKER, g2, g1)), 'stale_generation');
    // RSV-18: a superseded generation can never become current again.
    assert.equal(code(await world.register(WORKER, g1, g3)), 'stale_generation');
    const pointer = world.snapshot().generations.find((item) => item.workerPrincipal === WORKER);
    assert.deepEqual(pointer, { workerPrincipal: WORKER, currentGeneration: g3, priorGeneration: g1, history: [g1] });
    // Identical advance retry returns the stored result.
    const retry = await world.interlock.advanceWorkerGeneration(world.ctx(WORKER, g3), {
        version: 1, operationId: idOf(`advance:${WORKER}:${g3}`), priorGeneration: g1, nextGeneration: g3,
    });
    assert.equal(retry.ok, true);
    assert.equal(retry.value.currentGeneration, g3);
});

test('RSV-18 (A5.1) re-advancing to a superseded generation is refused after its records were compacted', async (t) => {
    const world = await readyWorld(t);
    const g1 = world.generation[WORKER];
    const g2 = idOf('gen:worker:2');
    const g3 = idOf('gen:worker:3');
    const done = (await world.reserve('rsv18')).value;
    assert.equal((await world.release(done)).ok, true);
    assert.equal((await world.register(WORKER, g2, g1)).ok, true);
    assert.equal((await world.register(WORKER, g3, g2)).ok, true);
    const snapshot = world.snapshot();
    const { generations, ...rest } = snapshot;
    // Compaction removed every record of generation 1; only the history remembers it.
    assert.equal(JSON.stringify(rest).includes(g1), false);
    const pointer = generations.find((item) => item.workerPrincipal === WORKER);
    assert.deepEqual(pointer, { workerPrincipal: WORKER, currentGeneration: g3, priorGeneration: g2, history: [g2, g1] });
    await refusedUnchanged(world, () => world.register(WORKER, g1, g3), 'stale_generation', 'G3->G1');
    await refusedUnchanged(world, () => world.register(WORKER, g2, g3), 'stale_generation', 'G3->G2');
    assert.equal((await world.register(WORKER, idOf('gen:worker:4'), g3)).ok, true);
});

test('A5.1 superseded-generation history is bounded at 1024 per principal, newest first, oldest evicted, never compacted', async (t) => {
    const world = await readyWorld(t);
    const g1 = world.generation[WORKER];
    const old = Array.from({ length: 1024 }, (_, index) => idOf(`history-${index}`));
    await seed(world, (document) => ({
        ...document,
        generations: document.generations.map((item) => (item.workerPrincipal === WORKER ? { ...item, history: old } : item)),
    }));
    await world.reopen();
    const g2 = idOf('gen:worker:2');
    assert.equal((await world.register(WORKER, g2, g1)).ok, true);
    const history = world.snapshot().generations.find((item) => item.workerPrincipal === WORKER).history;
    assert.equal(history.length, 1024);
    assert.equal(history[0], g1);
    assert.deepEqual(history.slice(1), old.slice(0, 1023));
    await refusedUnchanged(world, () => world.register(WORKER, old[500], g2), 'stale_generation');
    const reserved = (await world.reserve('history')).value;
    assert.equal((await world.release(reserved)).ok, true);
    assert.deepEqual(world.snapshot().generations.find((item) => item.workerPrincipal === WORKER).history, history);
    // A history above the bound is corrupt state.
    const paths = sourceProtectionPaths(world.workspaceRoot);
    const bad = world.snapshot();
    bad.generations = bad.generations.map((item) => (item.workerPrincipal === WORKER ? { ...item, history: [...history, idOf('extra')] } : item));
    fs.writeFileSync(paths.stateFile, canonicalTargetJson(bad).value);
    assert.equal(code(await world.open()), 'state_corrupt');
});

test('acknowledgement is idempotent, rejects another store identity and changed bodies', async (t) => {
    const world = await makeWorld(t);
    assert.equal((await world.register()).ok, true);
    const first = await world.ack();
    assert.deepEqual((await world.ack()).value, first.value);
    const request = {
        version: 1, operationId: idOf(`ack:${WORKER}:ack:${world.generation[WORKER]}`), sourceStoreIdentity: world.store.storeId,
        workerGeneration: world.generation[WORKER], priorStoreIdentities: [idOf('old-store')], settlementAttestationDigest: hex(`settled:${WORKER}`),
    };
    assert.equal(code(await world.interlock.acknowledgeSourceStore(world.ctx(), request)), 'operation_conflict');
    assert.equal(code(await world.interlock.acknowledgeSourceStore(world.ctx(), {
        ...request, operationId: idOf('ack-other-store'), sourceStoreIdentity: idOf('other-store'), priorStoreIdentities: [],
    })), 'operation_conflict');
});

// ---------------------------------------------------------------- ERR-01 and locking

test('ERR-01 crash before and after the durable commit and before the reply: old or committed state, no duplicate', async (t) => {
    for (const point of ['beforeCommit', 'afterCommit', 'afterDirectoryFsync', 'beforeReply']) {
        const world = await readyWorld(t);
        const before = world.snapshot();
        const crashing = await world.reopen({ storeFaults: { [point]: () => { throw new Error(point); } } });
        assert.equal(code(await crashing.reserveWritableResources(world.ctx(), world.reserveRequest('err01'))), 'outcome_unknown', point);
        const paths = sourceProtectionPaths(world.workspaceRoot);
        assert.equal(fs.existsSync(paths.lockFile), true, `${point} leaves its lock like process death`);
        const after = world.snapshot();
        if (point === 'beforeCommit') assert.deepEqual(after, before, point);
        else assert.equal(after.reservations.length, 1, point);
        // A live owner is never reclaimed: the next opener waits, then reports unavailable.
        const waiting = await world.reopen({ storeLimits: { lockWaitMs: 40 } });
        assert.equal(code(await waiting.reserveWritableResources(world.ctx(), world.reserveRequest('err01'))), 'source_unavailable', point);
        world.alive.delete(world.pid);
        world.pid += 100;
        world.alive.add(world.pid);
        await world.reopen();
        const retried = await world.reserve('err01');
        assert.equal(retried.ok, true, point);
        assert.equal((await world.reserve('err01')).value.reservationId, retried.value.reservationId);
        assert.equal(world.snapshot().reservations.length, 1, point);
        assert.deepEqual(fs.readdirSync(paths.storeDir).filter((name) => name.endsWith('.tmp')), [], point);
    }
});

test('ERR-01 / A3.3 a release whose reply was lost after the commit reconciles by its operation receipt', async (t) => {
    const world = await readyWorld(t);
    const reserved = (await world.reserve('err01-release')).value;
    const crashing = await world.reopen({ storeFaults: { afterCommit: () => { throw new Error('crash'); } } });
    assert.equal(code(await crashing.releaseWritableReservation(world.ctx(), world.releaseRequest(reserved))), 'outcome_unknown');
    world.alive.delete(world.pid);
    world.pid = 1500;
    world.alive.add(1500);
    await world.reopen();
    assert.equal(world.snapshot().reservations.length, 0);
    const retried = await world.release(reserved);
    assert.equal(retried.ok, true);
    assert.equal(retried.value.reservationId, reserved.reservationId);
    assert.equal(world.snapshot().tombstones.length, 1);
});

test('ERR-01 a dead owner in another PID namespace or with an unreadable scope is never reclaimed', async (t) => {
    const world = await readyWorld(t);
    const paths = sourceProtectionPaths(world.workspaceRoot);
    for (const scope of ['other-namespace', null]) {
        fs.writeFileSync(paths.lockFile, canonicalTargetJson({ pid: 4242, scope, startIdentity: 'start-4242', token: 'dead' }).value);
        await world.reopen({ storeLimits: { lockWaitMs: 40 } });
        assert.equal(code(await world.reserve('lock')), 'source_unavailable');
        fs.rmSync(paths.lockFile);
    }
    fs.writeFileSync(paths.lockFile, 'not json');
    await world.reopen({ storeLimits: { lockWaitMs: 40 } });
    assert.equal(code(await world.reserve('lock')), 'source_unavailable');
    fs.rmSync(paths.lockFile);
    // Same namespace, PID reused by another process (different start identity): reclaimed.
    world.alive.add(4243);
    fs.writeFileSync(paths.lockFile, canonicalTargetJson({ pid: 4243, scope: 'scope-1', startIdentity: 'start-old', token: 'reused' }).value);
    await world.reopen({ storeLimits: { lockWaitMs: 40 } });
    assert.equal((await world.reserve('lock')).ok, true);
    assert.equal(fs.existsSync(paths.lockFile), false);
});

test('lock acquisition never spins: a vanished store directory is state_corrupt and a persistent ENOENT waits out lockWaitMs', async (t) => {
    const world = await readyWorld(t);
    const paths = sourceProtectionPaths(world.workspaceRoot);
    let calls = 0;
    const vanishing = {
        ...fs,
        linkSync(source, target) {
            if (target === paths.lockFile) {
                calls += 1;
                // Spin detector: a synchronous loop would never let a test timeout fire.
                if (calls > 1000) throw Object.assign(new Error('spin'), { code: 'ESPIN' });
                fs.rmSync(paths.storeDir, { recursive: true, force: true });
                throw Object.assign(new Error('gone'), { code: 'ENOENT' });
            }
            return fs.linkSync(source, target);
        },
    };
    await world.reopen({ fsApi: vanishing });
    assert.equal(code(await world.reserve('spin')), 'state_corrupt');
    assert.ok(calls <= 2, `bounded attempts (${calls})`);

    const steady = await readyWorld(t);
    const steadyPaths = sourceProtectionPaths(steady.workspaceRoot);
    let attempts = 0;
    const swept = {
        ...fs,
        linkSync(source, target) {
            if (target === steadyPaths.lockFile) {
                attempts += 1;
                if (attempts > 1000) throw Object.assign(new Error('spin'), { code: 'ESPIN' });
                throw Object.assign(new Error('swept'), { code: 'ENOENT' });
            }
            return fs.linkSync(source, target);
        },
    };
    await steady.reopen({ fsApi: swept, storeLimits: { lockWaitMs: 50 } });
    const started = performance.now();
    assert.equal(code(await steady.reserve('spin')), 'source_unavailable');
    assert.ok(performance.now() - started >= 40);
    assert.ok(attempts < 30, `every iteration yields (${attempts})`);
});

// The first mutating step a reclaimer takes after observing a dead lock: the
// exclusive claim (current design) or a rename of the lock path (any
// move-aside design). Hooks fire around exactly that step.
function isReclaimStep(paths, kind, source, target) {
    return (kind === 'link' && path.basename(target).startsWith('lock.reclaim-'))
        || (kind === 'rename' && source === paths.lockFile);
}

function reclaimStepFs(paths, { before = () => {}, after = () => {} }) {
    let fired = false;
    const wrap = (kind, real) => (source, target) => {
        if (fired || !isReclaimStep(paths, kind, source, target)) return real(source, target);
        fired = true;
        before(target);
        try {
            return real(source, target);
        } finally {
            after(target);
        }
    };
    return {
        fsApi: { ...fs, linkSync: wrap('link', fs.linkSync), renameSync: wrap('rename', fs.renameSync) },
        fired: () => fired,
    };
}

test('stale-lock reclaim is atomic: a reclaimer never removes a live lock that replaced the dead one, and does not enter', async (t) => {
    const world = await readyWorld(t);
    const paths = sourceProtectionPaths(world.workspaceRoot);
    const dead = canonicalTargetJson({ pid: 9999, scope: 'scope-1', startIdentity: 'start-9999', token: 'dead' }).value;
    const live = canonicalTargetJson({ pid: 3000, scope: 'scope-1', startIdentity: 'start-3000', token: 'live-z' }).value;
    fs.writeFileSync(paths.lockFile, dead);
    world.alive.add(3000);
    let zClaim = null;
    // Interleaving: after Y observed the dead lock, Z claims and reclaims it and publishes its live lock.
    const racing = reclaimStepFs(paths, {
        before(target) {
            if (path.basename(target).startsWith('lock.reclaim-')) {
                zClaim = path.basename(target);
                const digest = zClaim.slice('lock.reclaim-'.length).replace(/-\d+$/, '');
                fs.writeFileSync(target, canonicalTargetJson({ pid: 3000, scope: 'scope-1', startIdentity: 'start-3000', thread: 0, target: digest }).value);
            }
            fs.unlinkSync(paths.lockFile);
            fs.writeFileSync(paths.lockFile, live);
        },
    });
    const before = fs.readFileSync(paths.stateFile);
    await world.reopen({ fsApi: racing.fsApi, storeLimits: { lockWaitMs: 40 } });
    assert.equal(code(await world.reserve('race')), 'source_unavailable');
    assert.equal(racing.fired(), true);
    assert.equal(fs.readFileSync(paths.lockFile, 'utf8'), live, 'the live lock is never removed or moved');
    assert.deepEqual(fs.readFileSync(paths.stateFile), before);
    // Y left nothing of its own: the only claim is Z's.
    assert.deepEqual(fs.readdirSync(paths.storeDir).filter((name) => name.startsWith('lock.reclaim-')), [zClaim]);
    // Once Z is gone, the reclaim succeeds and the holder sweeps every leftover claim.
    world.alive.delete(3000);
    await world.reopen();
    assert.equal((await world.reserve('race')).ok, true);
    assert.deepEqual(fs.readdirSync(paths.storeDir).filter((name) => name.startsWith('lock.reclaim-')), []);
    assert.equal(fs.existsSync(paths.lockFile), false);
});

// Z runs in a worker thread so that it really executes while the main thread
// (the reclaimer R) is suspended inside its reclaim step (Atomics.wait).
const WORKER_Z = `
const { workerData } = require('node:worker_threads');
(async () => {
    const flags = new Int32Array(workerData.shared);
    const { openSourceProtectionStore } = await import(workerData.storeUrl);
    const identity = {
        pid: 3000, scope: 'scope-1', startIdentity: 'start-3000',
        isAlive: (pid) => pid === 3000 || pid === 1001 || pid === 1002,
        startIdentityOf: (pid) => 'start-' + pid,
    };
    Atomics.wait(flags, 0, 0);
    // Optional pause inside Z's own reclaim window: after its claim is published, before it re-reads the lock.
    const faults = workerData.pauseAtClaim ? {
        afterReclaimClaim: () => { Atomics.store(flags, 5, 1); Atomics.notify(flags, 5); Atomics.wait(flags, 6, 0, 15000); },
    } : {};
    const opened = await openSourceProtectionStore({ workspaceRoot: workerData.workspaceRoot, processIdentity: identity, faults });
    if (!opened.ok) { Atomics.store(flags, 4, 1); Atomics.store(flags, 3, 1); Atomics.notify(flags, 3); return; }
    await opened.value.exclusive(async () => {
        Atomics.store(flags, 1, 1);
        Atomics.notify(flags, 1);
        Atomics.wait(flags, 2, 0);
    });
    Atomics.store(flags, 3, 1);
    Atomics.notify(flags, 3);
})().catch(() => { Atomics.store(flags, 4, 2); Atomics.store(flags, 3, 1); Atomics.notify(flags, 3); });
`;

function waitFlag(flags, index) {
    const outcome = Atomics.wait(flags, index, 0, 15000);
    if (outcome === 'timed-out') throw new Error(`worker flag ${index} timed out`);
}

for (const order of ['owner-releases-after-the-reclaim-step', 'owner-releases-before-the-reclaim-step', 'owner-holds-through-the-reclaim-step']) {
    test(`A9.2 lock reclaim liveness: the displaced-owner wedge cannot occur (${order})`, async (t) => {
        const world = await readyWorld(t);
        const paths = sourceProtectionPaths(world.workspaceRoot);
        fs.writeFileSync(paths.lockFile, canonicalTargetJson({ pid: 9999, scope: 'scope-1', startIdentity: 'start-9999', token: 'dead' }).value);
        world.alive.add(3000);
        const shared = new SharedArrayBuffer(8 * 4);
        const flags = new Int32Array(shared);
        const { Worker } = await import('node:worker_threads');
        const worker = new Worker(WORKER_Z, {
            eval: true,
            workerData: {
                shared,
                workspaceRoot: world.workspaceRoot,
                storeUrl: new URL('../../cli/utils/runtime/sourceProtectionStore.mjs', import.meta.url).href,
            },
        });
        const exited = new Promise((resolve) => { worker.once('exit', resolve); });
        t.after(() => worker.terminate());
        const hooks = {
            // Z reclaims the dead lock and holds; R takes its step; then Z releases inside R's window.
            'owner-releases-after-the-reclaim-step': {
                before() { Atomics.store(flags, 0, 1); Atomics.notify(flags, 0); waitFlag(flags, 1); },
                after() { Atomics.store(flags, 2, 1); Atomics.notify(flags, 2); waitFlag(flags, 3); },
            },
            // Z reclaims, holds and releases completely before R's step.
            'owner-releases-before-the-reclaim-step': {
                before() { Atomics.store(flags, 2, 1); Atomics.store(flags, 0, 1); Atomics.notify(flags, 0); waitFlag(flags, 3); },
            },
            // R has observed the dead lock; before it even lists claims, Z reclaims it and keeps holding
            // while R finishes its whole reclaim step; Z releases later.
            'owner-holds-through-the-reclaim-step': null,
        }[order];
        let holdFired = false;
        const stepped = hooks ? reclaimStepFs(paths, hooks) : {
            fsApi: {
                ...fs,
                readdirSync(directory, ...rest) {
                    if (!holdFired && directory === paths.storeDir) {
                        holdFired = true;
                        Atomics.store(flags, 0, 1);
                        Atomics.notify(flags, 0);
                        waitFlag(flags, 1);
                        setTimeout(() => { Atomics.store(flags, 2, 1); Atomics.notify(flags, 2); }, 50);
                    }
                    return fs.readdirSync(directory, ...rest);
                },
            },
            fired: () => holdFired,
        };
        let removedLiveLock = false;
        const watched = {
            ...stepped.fsApi,
            unlinkSync(target) {
                if (target === paths.lockFile && Atomics.load(flags, 1) === 1 && Atomics.load(flags, 2) === 0) removedLiveLock = true;
                return fs.unlinkSync(target);
            },
        };
        await world.reopen({ fsApi: watched });
        const result = await world.reserve('wedge');
        assert.equal(stepped.fired(), true);
        assert.equal(removedLiveLock, false, 'R never removes the lock of a live holder');
        assert.equal(Atomics.load(flags, 4), 0, 'Z ran its transaction');
        assert.equal(await exited, 0);
        assert.equal(result.ok, true, `R entered after Z released: ${code(result)}`);
        assert.equal(fs.existsSync(paths.lockFile), false, 'no lock is left behind');
        assert.deepEqual(fs.readdirSync(paths.storeDir).filter((name) => name.startsWith('lock.reclaim-')), []);
        // Any other handle proceeds too.
        world.pid = 1002;
        world.alive.add(1002);
        await world.reopen();
        assert.equal((await world.reserve('wedge-after')).ok, true);
        assert.equal(fs.existsSync(paths.lockFile), false);
    });
}

test('A9.2 the reclaim claim is exclusive: a second reclaimer of the same dead lock never enters or removes the winner\'s lock', async (t) => {
    const world = await readyWorld(t);
    const paths = sourceProtectionPaths(world.workspaceRoot);
    fs.writeFileSync(paths.lockFile, canonicalTargetJson({ pid: 9999, scope: 'scope-1', startIdentity: 'start-9999', token: 'dead' }).value);
    world.alive.add(3000);
    const shared = new SharedArrayBuffer(8 * 4);
    const flags = new Int32Array(shared);
    const { Worker } = await import('node:worker_threads');
    const worker = new Worker(WORKER_Z, {
        eval: true,
        workerData: {
            shared,
            workspaceRoot: world.workspaceRoot,
            storeUrl: new URL('../../cli/utils/runtime/sourceProtectionStore.mjs', import.meta.url).href,
        },
    });
    const exited = new Promise((resolve) => { worker.once('exit', resolve); });
    t.after(() => worker.terminate());
    let zEnteredInsideWindow = null;
    // R has won the claim and re-read the dead lock; inside that window Z (which also saw the dead lock)
    // runs its own reclaim attempt for a while.
    const stepped = {
        ...fs,
        unlinkSync(target) {
            if (target === paths.lockFile && zEnteredInsideWindow === null) {
                Atomics.store(flags, 0, 1);
                Atomics.notify(flags, 0);
                Atomics.wait(flags, 1, 0, 300);
                zEnteredInsideWindow = Atomics.load(flags, 1) === 1;
            }
            return fs.unlinkSync(target);
        },
    };
    await world.reopen({ fsApi: stepped });
    const reserving = world.reserve('exclusive-claim');
    // Once the dead lock is gone either party may win the free lock; Z holds only until released here.
    const releaseZ = (async () => {
        while (Atomics.load(flags, 1) !== 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
        Atomics.store(flags, 2, 1);
        Atomics.notify(flags, 2);
    })();
    const result = await reserving;
    assert.equal(zEnteredInsideWindow, false, 'Z must not enter while R holds the claim on the same dead lock');
    assert.equal(result.ok, true, code(result));
    await releaseZ;
    assert.equal(await exited, 0);
    assert.equal(Atomics.load(flags, 4), 0);
    assert.equal(fs.existsSync(paths.lockFile), false);
});

test('A9.2 two reclaimers racing for the same claim: the loser never removes the winner\'s live lock', async (t) => {
    const world = await readyWorld(t);
    const paths = sourceProtectionPaths(world.workspaceRoot);
    fs.writeFileSync(paths.lockFile, canonicalTargetJson({ pid: 9999, scope: 'scope-1', startIdentity: 'start-9999', token: 'dead' }).value);
    world.alive.add(3000);
    const shared = new SharedArrayBuffer(8 * 4);
    const flags = new Int32Array(shared);
    const { Worker } = await import('node:worker_threads');
    const worker = new Worker(WORKER_Z, {
        eval: true,
        workerData: {
            shared,
            pauseAtClaim: true,
            workspaceRoot: world.workspaceRoot,
            storeUrl: new URL('../../cli/utils/runtime/sourceProtectionStore.mjs', import.meta.url).href,
        },
    });
    const exited = new Promise((resolve) => { worker.once('exit', resolve); });
    t.after(() => worker.terminate());
    const resumeZ = () => { if (Atomics.load(flags, 6) === 0) { Atomics.store(flags, 6, 1); Atomics.notify(flags, 6); } };
    let removedLiveLock = false;
    let claimRaced = false;
    const stepped = {
        ...fs,
        linkSync(source, target) {
            if (!claimRaced && path.basename(target).startsWith('lock.reclaim-')) {
                claimRaced = true;
                // Z observed the same dead lock and published the same claim first, then paused.
                Atomics.store(flags, 0, 1);
                Atomics.notify(flags, 0);
                waitFlag(flags, 5);
                try {
                    return fs.linkSync(source, target);
                } finally {
                    setTimeout(resumeZ, 50);
                }
            }
            return fs.linkSync(source, target);
        },
        unlinkSync(target) {
            if (target === paths.lockFile && claimRaced && Atomics.load(flags, 6) === 0) {
                // R is about to remove the lock it observed: let Z (the claim winner) finish its reclaim first.
                resumeZ();
                Atomics.wait(flags, 1, 0, 2000);
                const zHolds = Atomics.load(flags, 1) === 1 && Atomics.load(flags, 2) === 0;
                fs.unlinkSync(target);
                if (zHolds) removedLiveLock = true;
                return undefined;
            }
            return fs.unlinkSync(target);
        },
    };
    await world.reopen({ fsApi: stepped });
    const reserving = world.reserve('claim-race');
    const releaseZ = (async () => {
        while (Atomics.load(flags, 1) !== 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
        Atomics.store(flags, 2, 1);
        Atomics.notify(flags, 2);
    })();
    const result = await reserving;
    await releaseZ;
    assert.equal(claimRaced, true);
    assert.equal(removedLiveLock, false, 'the claim loser must not remove the winner\'s live lock');
    assert.equal(result.ok, true, code(result));
    assert.equal(await exited, 0);
    assert.equal(Atomics.load(flags, 4), 0);
    assert.equal(fs.existsSync(paths.lockFile), false);
    assert.deepEqual(fs.readdirSync(paths.storeDir).filter((name) => name.startsWith('lock.reclaim-')), []);
});

test('A9.2 a releasing owner removes every reclaim claim that targets its own token', async (t) => {
    const world = await readyWorld(t);
    const paths = sourceProtectionPaths(world.workspaceRoot);
    let claimFile = null;
    await world.store.exclusive(async () => {
        const lock = JSON.parse(fs.readFileSync(paths.lockFile, 'utf8'));
        const target = crypto.createHash('sha256').update(lock.token, 'utf8').digest('hex');
        claimFile = path.join(paths.storeDir, `lock.reclaim-${target}-0`);
        fs.writeFileSync(claimFile, canonicalTargetJson({ pid: 4444, scope: 'scope-1', startIdentity: 'start-4444', thread: 0, target }).value);
    });
    assert.equal(fs.existsSync(claimFile), false);
    assert.equal(fs.existsSync(paths.lockFile), false);
});

// One non-crash I/O error right after the claim is published (the post-claim lock
// read), optionally followed by a failing withdrawal of that claim.
function postClaimFaultFs(paths, { failClaimWithdrawal = false } = {}) {
    let claimFile = null;
    let readFaults = 1;
    let withdrawalFaults = failClaimWithdrawal ? 1 : 0;
    return {
        ...fs,
        linkSync(source, target) {
            const result = fs.linkSync(source, target);
            if (claimFile === null && path.basename(target).startsWith('lock.reclaim-')) claimFile = target;
            return result;
        },
        openSync(file, ...rest) {
            if (claimFile !== null && file === paths.lockFile && readFaults > 0) {
                readFaults -= 1;
                throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
            }
            return fs.openSync(file, ...rest);
        },
        unlinkSync(file) {
            if (file === claimFile && withdrawalFaults > 0) {
                withdrawalFaults -= 1;
                throw Object.assign(new Error('i/o error'), { code: 'EIO' });
            }
            return fs.unlinkSync(file);
        },
    };
}

const claimFiles = (paths) => fs.readdirSync(paths.storeDir).filter((name) => name.startsWith('lock.reclaim-')).sort();
const DEAD_LOCK = canonicalTargetJson({ pid: 9999, scope: 'scope-1', startIdentity: 'start-9999', token: 'dead' }).value;

for (const recoverer of ['same-handle-retry', 'new-handle-same-process', 'second-process']) {
    test(`a non-crash error after the claim publish withdraws the claim; ${recoverer} recovers`, async (t) => {
        const world = await readyWorld(t);
        const paths = sourceProtectionPaths(world.workspaceRoot);
        fs.writeFileSync(paths.lockFile, DEAD_LOCK);
        await world.reopen({ fsApi: postClaimFaultFs(paths) });
        assert.equal(code(await world.reserve('emfile')), 'outcome_unknown');
        assert.deepEqual(claimFiles(paths), [], 'the live claimant withdrew its claim');
        assert.equal(fs.readFileSync(paths.lockFile, 'utf8'), DEAD_LOCK);
        if (recoverer === 'new-handle-same-process') await world.reopen();
        if (recoverer === 'second-process') {
            world.pid = 2000;
            world.alive.add(2000);
            await world.reopen({ storeLimits: { lockWaitMs: 200 } });
        }
        assert.equal((await world.reserve('emfile')).ok, true);
        assert.equal(fs.existsSync(paths.lockFile), false);
        assert.deepEqual(claimFiles(paths), []);
    });
}

test('a claim this thread abandoned (withdrawal also failed) is superseded by this process; a second process recovers once the claimant acts or exits', async (t) => {
    for (const recoverer of ['same-handle-retry', 'new-handle-same-process', 'second-process']) {
        const world = await readyWorld(t);
        const paths = sourceProtectionPaths(world.workspaceRoot);
        fs.writeFileSync(paths.lockFile, DEAD_LOCK);
        await world.reopen({ fsApi: postClaimFaultFs(paths, { failClaimWithdrawal: true }) });
        assert.equal(code(await world.reserve('abandoned')), 'outcome_unknown', recoverer);
        assert.equal(claimFiles(paths).length, 1, `${recoverer}: the claim was left behind`);
        if (recoverer === 'same-handle-retry') {
            assert.equal((await world.reserve('abandoned')).ok, true, recoverer);
        } else if (recoverer === 'new-handle-same-process') {
            await world.reopen();
            assert.equal((await world.reserve('abandoned')).ok, true, recoverer);
        } else {
            // While the live claimant does nothing, another process cannot tell its claim from one in flight.
            const claimant = world.pid;
            world.pid = 2000;
            world.alive.add(2000);
            await world.reopen({ storeLimits: { lockWaitMs: 40 } });
            assert.equal(code(await world.reserve('abandoned')), 'source_unavailable', recoverer);
            // Any store operation of the claimant process supersedes its own abandoned claim...
            world.pid = claimant;
            await world.reopen();
            assert.equal((await world.reserve('claimant-acts')).ok, true, recoverer);
            // ...after which the second process proceeds.
            world.pid = 2000;
            await world.reopen();
            assert.equal((await world.reserve('abandoned')).ok, true, recoverer);
        }
        assert.equal(fs.existsSync(paths.lockFile), false, recoverer);
        assert.deepEqual(claimFiles(paths), [], recoverer);
    }
    // And if the claimant process exits instead, the second process supersedes the claim.
    const world = await readyWorld(t);
    const paths = sourceProtectionPaths(world.workspaceRoot);
    fs.writeFileSync(paths.lockFile, DEAD_LOCK);
    await world.reopen({ fsApi: postClaimFaultFs(paths, { failClaimWithdrawal: true }) });
    assert.equal(code(await world.reserve('exit')), 'outcome_unknown');
    world.alive.delete(world.pid);
    world.pid = 2001;
    world.alive.add(2001);
    await world.reopen();
    assert.equal((await world.reserve('exit')).ok, true);
    assert.deepEqual(claimFiles(paths), []);
});

test('a claim of the same pid but another thread is never treated as abandoned by this thread', async (t) => {
    const world = await readyWorld(t);
    const paths = sourceProtectionPaths(world.workspaceRoot);
    fs.writeFileSync(paths.lockFile, DEAD_LOCK);
    const target = crypto.createHash('sha256').update('dead', 'utf8').digest('hex');
    const claimOf = (thread) => canonicalTargetJson({
        pid: world.pid, scope: 'scope-1', startIdentity: `start-${world.pid}`, thread, target,
    }).value;
    fs.writeFileSync(path.join(paths.storeDir, `lock.reclaim-${target}-0`), claimOf(threadId + 7));
    await world.reopen({ storeLimits: { lockWaitMs: 40 } });
    assert.equal(code(await world.reserve('thread')), 'source_unavailable');
    assert.equal(fs.readFileSync(paths.lockFile, 'utf8'), DEAD_LOCK);
    // The same claim written by this very thread is an abandoned one and is superseded.
    fs.writeFileSync(path.join(paths.storeDir, `lock.reclaim-${target}-0`), claimOf(threadId));
    assert.equal((await world.reserve('thread')).ok, true);
    assert.deepEqual(claimFiles(paths), []);
});

test('a reclaim claimant that dies inside its window is superseded only once proved dead', async (t) => {
    const world = await readyWorld(t);
    const paths = sourceProtectionPaths(world.workspaceRoot);
    const dead = canonicalTargetJson({ pid: 9999, scope: 'scope-1', startIdentity: 'start-9999', token: 'dead' }).value;
    fs.writeFileSync(paths.lockFile, dead);
    const crashing = await world.reopen({ storeFaults: { afterReclaimClaim: () => { throw new Error('claimant died'); } } });
    assert.equal(code(await crashing.reserveWritableResources(world.ctx(), world.reserveRequest('claimant'))), 'outcome_unknown');
    const claims = () => fs.readdirSync(paths.storeDir).filter((name) => name.startsWith('lock.reclaim-')).sort();
    assert.equal(claims().length, 1);
    assert.match(claims()[0], /-0$/);
    assert.equal(fs.readFileSync(paths.lockFile, 'utf8'), dead);
    // The claimant (pid 1001) is alive: nobody else may take over its reclaim.
    world.pid = 1002;
    world.alive.add(1002);
    await world.reopen({ storeLimits: { lockWaitMs: 40 } });
    assert.equal(code(await world.reserve('claimant')), 'source_unavailable');
    assert.equal(fs.readFileSync(paths.lockFile, 'utf8'), dead);
    // Proved dead: claim 1 supersedes it, the dead lock goes and every claim is swept.
    world.alive.delete(1001);
    await world.reopen();
    assert.equal((await world.reserve('claimant')).ok, true);
    assert.deepEqual(claims(), []);
    assert.equal(fs.existsSync(paths.lockFile), false);
});

test('commit compare-and-set: a snapshot changed under the holder is never overwritten', async (t) => {
    const world = await readyWorld(t);
    const paths = sourceProtectionPaths(world.workspaceRoot);
    let foreign;
    await world.reopen({
        storeFaults: {
            beforeCommit: () => {
                const document = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
                document.revision += 7;
                foreign = canonicalTargetJson(document).value;
                fs.writeFileSync(paths.stateFile, foreign);
            },
        },
    });
    assert.equal(code(await world.reserve('cas')), 'source_unavailable');
    assert.equal(fs.readFileSync(paths.stateFile, 'utf8'), foreign);
    assert.deepEqual(fs.readdirSync(paths.storeDir).filter((name) => name.endsWith('.tmp')), []);
    assert.equal(fs.existsSync(paths.lockFile), false, 'a refused commit releases its lock');
});

test('content-addressed closure and selection files are immutable and published before the snapshot', async (t) => {
    const world = await readyWorld(t);
    const paths = sourceProtectionPaths(world.workspaceRoot);
    const closureDigest = digestOf(closureFixture());
    const closureFile = path.join(paths.closuresDir, `${closureDigest}.json`);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(closureFile)).digest('hex'), closureDigest);
    assert.equal(world.store.readClosure(closureDigest).ok, true);
    // Crash after publishing content but before the snapshot: the epoch is unchanged.
    const crashing = await world.reopen({ storeFaults: { beforeCommit: () => { throw new Error('crash'); } } });
    world.closure = closureFixture((value) => { value.entries[0].mode = '0600'; return value; });
    const nextDigest = digestOf(world.closure);
    assert.equal(code(await crashing.prepareSourceTransition(world.operator(), world.transitionRequest(1, 'content', { closureDigest: nextDigest }))), 'outcome_unknown');
    assert.equal(fs.existsSync(path.join(paths.closuresDir, `${nextDigest}.json`)), true);
    assert.equal(world.snapshot().record.sourceProtectionEpoch, 1);
    // Tampering with a referenced immutable file is corruption on open.
    fs.rmSync(paths.lockFile);
    fs.appendFileSync(closureFile, ' ');
    assert.equal(code(await world.open()), 'state_corrupt');
});

// ---------------------------------------------------------------- capacity

function syntheticReservation(world, index, generation) {
    const resources = [{ ...resource(`cap-${index}`) }];
    return {
        version: 1, reservationId: idOf(`cap-reservation-${index}`), operationId: idOf(`cap-op-${index}`),
        workspaceId: world.scope.workspaceId, boxIdentity: world.scope.boxIdentity, boxGeneration: world.scope.boxGeneration,
        sourceStoreIdentity: world.store.storeId, workerPrincipal: WORKER, workerRuntimeInstanceId: 'worker-instance-1',
        workerEnableGeneration: 'enable-1', workerGeneration: generation, robotId: idOf('robot-1'), executionId: null,
        attemptId: null, consumerKind: 'execution', consumerId: idOf(`cap-consumer-${index}`), sourceProtectionEpoch: 1,
        sourceSelectionDigest: digestOf(selectionFixture()), sourceClosureDigest: digestOf(closureFixture()),
        sourceAcceptanceIdentity: 'acceptance-1', resources, requestDigest: hex(`cap-request-${index}`), state: 'reserved',
        createdAtMs: NOW, releaseEvidenceDigest: null,
    };
}

async function seed(world, mutate) {
    await world.store.exclusive(async (transaction) => {
        const snapshot = structuredClone(transaction.snapshot());
        const { schema, storeId, revision, ...rest } = snapshot;
        transaction.commit(mutate(rest));
    });
}

const sortBy = (key) => (left, right) => (left[key] < right[key] ? -1 : left[key] > right[key] ? 1 : 0);

test('CAP-01 writableReservations at the 4096 ceiling succeeds and 4097 is capacity_exceeded without eviction', async (t) => {
    const world = await readyWorld(t);
    const generation = world.generation[WORKER];
    await seed(world, (document) => ({
        ...document,
        reservations: Array.from({ length: 4095 }, (_, index) => syntheticReservation(world, index, generation)).sort(sortBy('reservationId')),
    }));
    await world.reopen();
    const atCeiling = await world.reserve('cap-4096');
    assert.equal(atCeiling.ok, true);
    assert.equal(world.snapshot().reservations.length, 4096);
    assert.equal(code(await world.reserve('cap-4097')), 'capacity_exceeded');
    assert.equal(world.snapshot().reservations.length, 4096);
    // CAP-02: the identical retry and a release still reconcile at the ceiling.
    assert.deepEqual((await world.reserve('cap-4096')).value, atCeiling.value);
    assert.equal((await world.release(atCeiling.value)).ok, true);
});

test('CAP-01 / CAP-02 operationReceipts at the 65536 ceiling: release still reconciles, new work refuses', async (t) => {
    const world = await readyWorld(t);
    const generation = world.generation[WORKER];
    const existing = world.snapshot();
    const room = INTERLOCK_LIMITS_V1.operationReceipts - existing.receipts.length - 2;
    await seed(world, (document) => ({
        ...document,
        tombstones: Array.from({ length: room }, (_, index) => ({
            reservationId: idOf(`cap-t-${index}`), operationId: idOf(`cap-t-op-${index}`), requestDigest: hex(`t${index}`),
            workerPrincipal: WORKER, workerGeneration: generation, state: 'released', releaseEvidenceDigest: hex(`e${index}`),
        })).sort(sortBy('reservationId')),
    }));
    await world.reopen();
    // At the ceiling: entries + 2 * reservations == 65536.
    const reserved = await world.reserve('cap-r');
    assert.equal(reserved.ok, true);
    assert.equal(code(await world.reserve('cap-r2')), 'capacity_exceeded');
    const released = await world.release(reserved.value);
    assert.equal(released.ok, true);
    const snapshot = world.snapshot();
    assert.equal(snapshot.tombstones.length + snapshot.receipts.length, INTERLOCK_LIMITS_V1.operationReceipts);
    assert.deepEqual((await world.release(reserved.value)).value, released.value);
    assert.equal((await world.reserve('cap-r')).value.state, 'released');
    assert.equal(code(await world.ack(WORKER, 'cap-new')), 'capacity_exceeded');
    assert.equal(code(await world.transition(1, 'cap')), 'capacity_exceeded');
});

test('CAP-01 sourceStateBytes bound refuses exactly above the ceiling; limits may only be lowered', async (t) => {
    const probe = await readyWorld(t);
    assert.equal((await probe.reserve('bytes')).ok, true);
    const size = fs.statSync(sourceProtectionPaths(probe.workspaceRoot).stateFile).size;
    for (const [limit, expected] of [[size, 'ok'], [size - 1, 'capacity_exceeded']]) {
        const world = await readyWorld(t);
        await world.reopen({ storeLimits: { sourceStateBytes: limit } });
        assert.equal(code(await world.reserve('bytes')), expected, String(limit));
    }
    const workspaceRoot = tempWorkspace(t);
    for (const limits of [{ sourceStateBytes: INTERLOCK_LIMITS_V1.sourceStateBytes + 1 }, { lockWaitMs: 0 }, { retiredWorkerGenerations: 1 }]) {
        assert.equal(code(await openSourceProtectionStore({ workspaceRoot, limits })), 'invalid_request');
    }
});
