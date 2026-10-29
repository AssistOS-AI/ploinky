import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverExecutionTargets } from '../../cli/server/executionTarget/discovery.mjs';
import { EXECUTION_TARGET_HELPER_CONTRACT_ID, TARGET_LIMITS_V1 } from '../../cli/server/executionTarget/declaration.mjs';

// The worker availability projection (Explorer availability.mjs) checks exactly these keys on every entry.
const ENTRY_KEYS = [
    'ref', 'label', 'principal', 'aliases', 'runtimeInstanceId', 'containerId', 'enableGeneration', 'helperIncarnation',
    'workspaceId', 'boxIdentity', 'boxGeneration', 'enabled', 'running', 'runtime', 'placement', 'declaration', 'prepared',
    'journal', 'attestation', 'activeExecutions',
];
const LIVE = { workspaceId: 'ws-1', boxIdentity: 'box-1', boxGeneration: 'gen-1' };
const digest = (char) => char.repeat(64);
const cid = (char) => char.repeat(64);
const helperId = Buffer.alloc(16, 7).toString('base64url');

function declaration() {
    return {
        version: 1,
        helper: { contractId: EXECUTION_TARGET_HELPER_CONTRACT_ID, contractDigest: digest('a'), executableDigest: digest('b') },
        inventoryDigest: digest('c'),
        profile: { id: 'nested-target', digest: digest('d') },
        stateExports: [],
        serviceExports: [],
        limits: { ...TARGET_LIMITS_V1 },
    };
}

function record(overrides = {}) {
    return {
        type: 'agent', repoName: 'repoa', agentName: 'alpha', runtime: 'podman', runMode: 'global',
        containerId: cid('1'), instanceId: 'inst-1', enableGeneration: 'egen-1', ...overrides,
    };
}

function run({ agents, manifests = {}, instances = {}, helpers = {} }) {
    return discoverExecutionTargets({
        live: LIVE,
        readRegistry: () => ({ agents }),
        readManifest: (rec) => {
            const m = manifests[`${rec.repoName}/${rec.agentName}`];
            if (m instanceof Error) throw m;
            return m === undefined ? {} : m;
        },
        readInstance: (rec) => instances[rec.containerId] ?? null,
        readHelper: (rec) => helpers[`${rec.repoName}/${rec.agentName}`] ?? null,
    });
}

const running = (id) => ({ [id]: { running: true, containerId: id } });

// Reimplements the worker precedence steps 6-7 and 9 (frozen T0 section 3 / A1.7) from the contract text.
function workerReason(entry) {
    if (!(entry.enabled === true && entry.running === true && entry.runtime === 'container' && entry.placement === 'global'
        && entry.containerId !== null && entry.runtimeInstanceId !== null && entry.helperIncarnation !== null)) return 'target_not_eligible';
    if (entry.declaration === null) return 'target_contract_missing';
    if (entry.declaration.valid !== true) return 'target_contract_invalid';
    if (entry.prepared !== true) return 'target_unprepared';
    if (entry.journal !== 'available') return 'journal_unavailable';
    return 'eligible_so_far';
}

const READY_HELPER = { helperIncarnation: helperId, prepared: true, journal: 'available', attestation: { x: 1 }, activeExecutions: 2 };

test('P1 an eligible global running podman agent with a valid declaration yields the exact worker entry', () => {
    const result = run({
        agents: { c1: record({ alias: 'short' }) },
        manifests: { 'repoa/alpha': { executionTarget: declaration() } },
        instances: running(cid('1')),
        helpers: { 'repoa/alpha': READY_HELPER },
    });
    assert.equal(result.ok, true);
    const [entry] = result.value.entries;
    assert.deepEqual(Object.keys(entry).sort(), [...ENTRY_KEYS].sort());
    assert.equal(entry.ref, 'repoa/alpha');
    assert.equal(entry.principal, 'agent:repoa/alpha');
    assert.deepEqual(entry.aliases, ['agent:repoa/short']);
    assert.deepEqual([entry.workspaceId, entry.boxIdentity, entry.boxGeneration], ['ws-1', 'box-1', 'gen-1']);
    assert.deepEqual([entry.runtime, entry.placement, entry.enabled, entry.running], ['container', 'global', true, true]);
    assert.equal(entry.declaration.valid, true);
    assert.equal(entry.helperIncarnation, helperId);
    assert.equal(entry.activeExecutions, 2);
    assert.equal(workerReason(entry), 'eligible_so_far');
    assert.deepEqual(result.value.diagnostics, [{ ref: 'repoa/alpha', containerId: cid('1'), reasons: [] }]);
    assert.throws(() => { entry.running = false; }, TypeError);
});

test('P1 distinct unavailable reasons: absent, invalid, null, non-container, stopped, non-global, disabled', () => {
    const agents = {
        a: record({ agentName: 'absent', containerId: cid('a'), instanceId: 'ia' }),
        b: record({ agentName: 'invalid', containerId: cid('b'), instanceId: 'ib' }),
        c: record({ agentName: 'nulled', containerId: cid('c'), instanceId: 'ic' }),
        d: record({ agentName: 'bwrap', runtime: 'bwrap', containerId: cid('d'), instanceId: 'id' }),
        e: record({ agentName: 'stopped', containerId: cid('e'), instanceId: 'ie' }),
        f: record({ agentName: 'isolated', runMode: 'isolated', containerId: cid('f'), instanceId: 'if' }),
        g: record({ agentName: 'disabled', enabled: false, containerId: cid('0'), instanceId: 'ig' }),
        h: record({ agentName: 'broken', containerId: cid('9'), instanceId: 'ih' }),
    };
    const good = { executionTarget: declaration() };
    const result = run({
        agents,
        manifests: {
            'repoa/absent': {},
            'repoa/invalid': { executionTarget: { version: 1 } },
            'repoa/nulled': { executionTarget: null },
            'repoa/bwrap': good, 'repoa/stopped': good, 'repoa/isolated': good, 'repoa/disabled': good,
            'repoa/broken': new Error('unreadable'),
        },
        instances: {
            ...running(cid('a')), ...running(cid('b')), ...running(cid('c')), ...running(cid('d')), ...running(cid('f')),
            ...running(cid('0')), ...running(cid('9')),
        },
        helpers: Object.fromEntries(['absent', 'invalid', 'nulled', 'bwrap', 'stopped', 'isolated', 'disabled', 'broken']
            .map((name) => [`repoa/${name}`, READY_HELPER])),
    });
    assert.equal(result.ok, true);
    const byRef = Object.fromEntries(result.value.entries.map((entry) => [entry.ref, entry]));
    const reasonOf = (name) => workerReason(byRef[`repoa/${name}`]);
    assert.equal(reasonOf('absent'), 'target_contract_missing');
    assert.equal(reasonOf('invalid'), 'target_contract_invalid');
    assert.equal(reasonOf('nulled'), 'target_contract_invalid');
    assert.equal(reasonOf('broken'), 'target_contract_invalid');
    for (const name of ['bwrap', 'stopped', 'isolated', 'disabled']) assert.equal(reasonOf(name), 'target_not_eligible', name);
    assert.equal(byRef['repoa/absent'].declaration, null);
    assert.equal(byRef['repoa/nulled'].declaration.valid, false);
    // The per-case reason that the worker code collapses is kept outside the entries.
    const diag = Object.fromEntries(result.value.diagnostics.map((item) => [item.ref, item.reasons]));
    assert.deepEqual(diag['repoa/absent'], ['declaration_absent']);
    assert.deepEqual(diag['repoa/invalid'], ['declaration_invalid']);
    assert.deepEqual(diag['repoa/nulled'], ['declaration_invalid']);
    assert.deepEqual(diag['repoa/broken'], ['manifest_unreadable']);
    assert.deepEqual(diag['repoa/bwrap'], ['non_container']);
    assert.deepEqual(diag['repoa/stopped'], ['stopped']);
    assert.deepEqual(diag['repoa/isolated'], ['non_global']);
    assert.deepEqual(diag['repoa/disabled'], ['disabled']);
    for (const entry of result.value.entries) assert.deepEqual(Object.keys(entry).sort(), [...ENTRY_KEYS].sort());
});

test('P1 executionProvider and routerAccess.agentExec are never a target opt-in', () => {
    const result = run({
        agents: { a: record() },
        manifests: { 'repoa/alpha': { executionProvider: { x: 1 }, routerAccess: { agentExec: true } } },
        instances: running(cid('1')),
        helpers: { 'repoa/alpha': READY_HELPER },
    });
    assert.equal(workerReason(result.value.entries[0]), 'target_contract_missing');
});

test('P1 running needs live instance evidence that matches the registry container ID', () => {
    const agents = { a: record() };
    for (const instances of [{}, { [cid('1')]: { running: false, containerId: cid('1') } },
        { [cid('1')]: { running: true, containerId: cid('2') } }, { [cid('1')]: { running: 'true', containerId: cid('1') } }]) {
        const result = run({ agents, manifests: { 'repoa/alpha': { executionTarget: declaration() } }, instances, helpers: { 'repoa/alpha': READY_HELPER } });
        assert.equal(result.value.entries[0].running, false);
        assert.equal(workerReason(result.value.entries[0]), 'target_not_eligible');
    }
});

test('P1 missing preparation or journal is reported, an unprepared helper exposes no incarnation or attestation', () => {
    const base = { agents: { a: record() }, manifests: { 'repoa/alpha': { executionTarget: declaration() } }, instances: running(cid('1')) };
    const none = run(base).value.entries[0];
    assert.deepEqual([none.prepared, none.journal, none.attestation, none.helperIncarnation, none.activeExecutions],
        [false, 'unavailable', null, null, 0]);
    assert.equal(workerReason(none), 'target_not_eligible');
    const noJournal = run({ ...base, helpers: { 'repoa/alpha': { ...READY_HELPER, journal: 'lost' } } }).value.entries[0];
    assert.equal(noJournal.journal, 'unavailable');
    assert.equal(workerReason(noJournal), 'journal_unavailable');
    const badId = run({ ...base, helpers: { 'repoa/alpha': { ...READY_HELPER, helperIncarnation: 'nope' } } }).value.entries[0];
    assert.equal(badId.helperIncarnation, null);
    assert.equal(badId.prepared, false);
    // prepared:false never exposes a helper incarnation, even a valid one.
    const unprepared = run({ ...base, helpers: { 'repoa/alpha': { ...READY_HELPER, prepared: false } } }).value.entries[0];
    assert.deepEqual([unprepared.prepared, unprepared.helperIncarnation, unprepared.journal, unprepared.attestation], [false, null, 'unavailable', null]);
});

test('P1 malformed records never break the inventory: bad refs are dropped, bad identities normalize to null', () => {
    const result = run({
        agents: {
            ok: record(),
            badRef: record({ repoName: 'a/b', agentName: 'x' }),
            blank: record({ repoName: '', agentName: '' }),
            notAgent: { type: 'service', repoName: 'r', agentName: 's' },
            junk: 'text',
            idless: record({ agentName: 'idless', containerId: 'short', instanceId: '', enableGeneration: 5, alias: 'bad alias/with/slash' }),
        },
        manifests: { 'repoa/alpha': { executionTarget: declaration() } },
        instances: running(cid('1')),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.entries.map((entry) => entry.ref), ['repoa/alpha', 'repoa/idless']);
    assert.deepEqual(result.value.dropped.map((item) => item.reason), ['invalid_identity', 'invalid_identity']);
    const idless = result.value.entries[1];
    assert.deepEqual([idless.containerId, idless.runtimeInstanceId, idless.enableGeneration, idless.aliases], [null, null, null, []]);
    assert.ok(result.value.diagnostics.find((item) => item.ref === 'repoa/idless').reasons.includes('identity_incomplete'));
});

test('P1 inputs: invalid live, missing readers, throwing registry and oversized registry fail closed without throwing', () => {
    const readers = { readRegistry: () => ({ agents: {} }), readManifest: () => ({}), readInstance: () => null };
    assert.equal(discoverExecutionTargets({ ...readers, live: { workspaceId: 'w' } }).error.code, 'invalid_request');
    assert.equal(discoverExecutionTargets({ live: LIVE, readRegistry: () => ({ agents: {} }) }).error.code, 'invalid_request');
    assert.equal(discoverExecutionTargets({ ...readers, live: LIVE, readRegistry: () => { throw new Error('x'); } }).error.code, 'invalid_request');
    assert.equal(discoverExecutionTargets({ ...readers, live: LIVE, readRegistry: () => ({ agents: [] }) }).error.code, 'invalid_request');
    const many = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`c${index}`, record()]));
    assert.equal(discoverExecutionTargets({ ...readers, live: LIVE, readRegistry: () => ({ agents: many }) }).error.code, 'capacity_exceeded');
    const edge = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`c${index}`, record({ agentName: `a${index}` })]));
    assert.equal(discoverExecutionTargets({ ...readers, live: LIVE, readRegistry: () => ({ agents: edge }) }).value.entries.length, 256);
    assert.equal(discoverExecutionTargets().error.code, 'invalid_request');
    // Throwing instance and helper readers degrade the entry (stopped, unprepared) rather than the inventory.
    const degraded = discoverExecutionTargets({
        live: LIVE, readRegistry: () => ({ agents: { a: record() } }), readManifest: () => ({}),
        readInstance: () => { throw new Error('x'); }, readHelper: () => { throw new Error('y'); },
    });
    assert.equal(degraded.ok, true);
    assert.deepEqual([degraded.value.entries[0].running, degraded.value.entries[0].prepared], [false, false]);
});

test('P1 labels stay within 1-128 bytes even for a maximal ref', () => {
    const long = 'r'.repeat(128);
    const result = run({ agents: { a: record({ repoName: long, agentName: long }), b: record({ agentName: 'short', containerId: cid('2'), instanceId: 'i2' }) } });
    for (const entry of result.value.entries) {
        const bytes = Buffer.byteLength(entry.label, 'utf8');
        assert.ok(bytes >= 1 && bytes <= 128, entry.label);
    }
    assert.equal(result.value.entries.find((entry) => entry.ref === 'repoa/short').label, 'repoa/short');
});

test('P1 duplicate refs stay separate entries so the worker can refuse them as ambiguous, ordered deterministically', () => {
    const result = run({
        agents: { z: record({ containerId: cid('2'), instanceId: 'i2' }), y: record({ containerId: cid('3'), instanceId: 'i3' }) },
    });
    assert.deepEqual(result.value.entries.map((entry) => entry.runtimeInstanceId), ['i2', 'i3']);
    assert.equal(result.value.entries.filter((entry) => entry.principal === 'agent:repoa/alpha').length, 2);
});

test('P1 an entry carries a record-claimed foreign Box identity so the worker refuses it, never the active one', () => {
    const result = run({ agents: { a: record({ workspaceId: 'other-ws' }) } });
    assert.equal(result.value.entries[0].workspaceId, 'other-ws');
});

test('P1 discovery names no agent and reads no ambient state', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../../cli/server/executionTarget/discovery.mjs', import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /explorer|roboteam|robo-team|dpuagent|gitagent|webchat|soplang|basic\/|process\.env/i);
    assert.doesNotMatch(source, /from ['"]node:(fs|child_process|net|http|https|dgram|os)['"]/);
});

test('P1 the result is the shared executionTarget discovery inventory shape used with a fixture-free synthetic Box', () => {
    const result = run({ agents: {} });
    assert.deepEqual(result.value, { version: 1, entries: [], diagnostics: [], dropped: [] });
    assert.ok(Object.isFrozen(result.value));
});
