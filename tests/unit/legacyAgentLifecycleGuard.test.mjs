import '../helpers/isolatedWorkspaceRoot.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    assertInterimOwnedGlobalAgent, inspectInterimAgentLifecycle, inspectInterimContainer,
    isLegacyAgentLifecycleRefusal, LegacyAgentLifecycleRefusal,
    interimReceiptRegistryRecord,
} from '../../cli/sandbox/legacyAgentLifecycleGuard.mjs';
import { lifecycleRecord, inspectedLifecycleRecord, lifecycleHarness, CONTAINER_ID } from './helpers/legacyAgentLifecycleHarness.mjs';

const assertRecord = (record, overrides = {}) => assertInterimOwnedGlobalAgent({
    runtime: 'podman', runMode: 'global', containerName: 'agent', containerId: CONTAINER_ID, record, ...overrides,
});
const refusal = (error) => error.code === 'PLOINKY_LEGACY_AGENT_REFUSED';

for (const runtime of ['docker', 'podman']) {
    for (const view of ['Config', 'Labels', 'labels']) {
        test(`${runtime}: any own marker in ${view} refuses without modifying inspection`, () => {
            for (const value of ['', 'false', 'true', '0', 'a']) {
                const record = inspectedLifecycleRecord('agent');
                if (view === 'Config') record.Config.Labels['ploinky.procunmask'] = value;
                else record[view] = { 'ploinky.procunmask': value };
                const before = JSON.stringify(record);
                assert.throws(() => assertRecord(record, { runtime }), refusal);
                assert.equal(JSON.stringify(record), before);
            }
        });
    }
    for (const option of ['unmask=ALL', 'UNMASK:', 'unmask=/proc/*', 'unmask=', 'systempaths:unconfined', 'SYSTEMPATHS=UNCONFINED']) {
        test(`${runtime}: ${option} refuses`, () => {
            const record = inspectedLifecycleRecord('agent'); record.HostConfig.SecurityOpt = [option];
            assert.throws(() => assertRecord(record, { runtime }), refusal);
        });
    }
}

test('privileged and malformed representations refuse; absent optional fields and masks remain allowed', () => {
    for (const host of [{ Privileged: true }, { Privileged: 'false' }, { SecurityOpt: 'unmask=all' }, { SecurityOpt: [null] }]) {
        const record = inspectedLifecycleRecord('agent'); Object.assign(record.HostConfig, host);
        assert.throws(() => assertRecord(record), refusal);
    }
    for (const labels of [[], 'bad', { key: null }]) {
        const record = inspectedLifecycleRecord('agent'); record.labels = labels;
        assert.throws(() => assertRecord(record), refusal);
    }
    for (const masks of [{}, { MaskedPaths: [], ReadonlyPaths: [] }]) {
        const record = inspectedLifecycleRecord('agent'); Object.assign(record.HostConfig, masks);
        assert.equal(assertRecord(record).decision, 'interim-clear');
    }
});

test('known native and non-global controls preserve applicability; malformed present modes refuse', () => {
    const record = inspectedLifecycleRecord('agent', lifecycleRecord(), { marked: true });
    for (const runtime of ['bwrap', 'seatbelt']) assert.equal(assertRecord(record, { runtime }).decision, 'not-applicable');
    for (const runMode of [undefined, 'isolated', 'devel']) assert.equal(assertRecord(record, { runMode }).decision, 'not-applicable');
    for (const runMode of ['', null, 'GLOBAL', 0]) assert.throws(() => assertRecord(record, { runMode }), refusal);
    assert.throws(() => assertRecord(record, { runtime: 'unknown' }), refusal);
});

test('immutable identity cannot be missing, contradictory or changed', () => {
    for (const changes of [{ Id: undefined }, { ID: 'b'.repeat(64) }, { Id: 'b'.repeat(64) }]) {
        assert.throws(() => assertRecord({ ...inspectedLifecycleRecord('agent'), ...changes }), refusal);
    }
});

test('typed result is immutable, bounded and preserves unicode without raw inspect secrets', () => {
    let caught;
    try { assertRecord(inspectedLifecycleRecord('agent', lifecycleRecord(), { marked: true }), { containerName: 'ă😀'.repeat(300) }); }
    catch (error) { caught = error; }
    assert.ok(refusal(caught)); assert.ok(Object.isFrozen(caught.result));
    assert.ok([...caught.containerName].length <= 160); assert.doesNotMatch(caught.message, /SECRET_SENTINEL|never-output/);
    assert.throws(() => { caught.result.code = 'allow'; }, TypeError);
    assert.equal(Object.hasOwn(caught, 'cleanupReceipt'), false);
    assert.equal(Object.hasOwn(caught, 'recreateReason'), false);
    assert.ok(isLegacyAgentLifecycleRefusal(new Error('wrapped', { cause: caught })));
    const cycle = new Error('cycle'); cycle.cause = cycle;
    assert.equal(isLegacyAgentLifecycleRefusal(cycle), false);
});

test('exact preflight distinguishes absence, foreign ownership and replacement occupants without effects', () => {
    const f = lifecycleHarness(); const input = { containerName: 'agent', registryRecord: f.registry.agent };
    assert.equal(f.preflight(input).state, 'exact');
    f.containers.clear(); assert.equal(f.preflight(input).state, 'absent');
    f.containers.set('b'.repeat(64), inspectedLifecycleRecord('agent', lifecycleRecord({ containerId: 'b'.repeat(64) })));
    assert.throws(() => f.preflight(input), refusal);
    assert.deepEqual(f.effects, []);
    const foreign = lifecycleHarness(); foreign.containers.get(CONTAINER_ID).Config.Labels['io.assistos.ploinky.workspace'] = 'other';
    assert.throws(() => foreign.preflight(input), refusal); assert.deepEqual(foreign.effects, []);
});

test('name recovery pins an unpublished predecessor and refuses changes at exact read', () => {
    const f = lifecycleHarness(); const input = { containerName: 'agent', registryRecord: { ...f.registry.agent, containerId: undefined } };
    assert.equal(f.preflight(input).state, 'exact'); assert.deepEqual(f.reads, ['agent', CONTAINER_ID]);
    let count = 0;
    assert.throws(() => inspectInterimAgentLifecycle(input, { ...f.dependencies,
        inspect: (...args) => ++count === 1 ? f.inspect(...args) : null }), refusal);
});

test('bounded engine inspection sanitizes errors and distinguishes positive absence', () => {
    const replies = [{ status: 1, stderr: 'engine unavailable SECRET_SENTINEL' },
        { status: 0, stdout: '{SECRET_SENTINEL' }, { status: 0, stdout: '[]' },
        { status: 0, stdout: '[{},{}]' }, { status: 0, error: new Error('SECRET_SENTINEL') }];
    for (const reply of replies) assert.throws(() => inspectInterimContainer('podman', CONTAINER_ID, {
        run: (_runtime, args, options) => {
            assert.deepEqual(args, ['container', 'inspect', CONTAINER_ID]); assert.equal(options.timeout, 5000); return reply;
        },
    }), (error) => refusal(error) && !error.message.includes('SECRET_SENTINEL'));
    assert.equal(inspectInterimContainer('docker', CONTAINER_ID, { run: () => ({ status: 1, stderr: 'No such container' }) }), null);
    assert.ok(new LegacyAgentLifecycleRefusal().result);
});

test('receipt mode is borrowed only from the exact same immutable runtime', () => {
    const original = lifecycleRecord({ runMode: 'isolated' });
    const { runMode, ...receipt } = original;
    assert.equal(interimReceiptRegistryRecord(receipt, original).runMode, 'isolated');
    assert.equal(interimReceiptRegistryRecord(receipt, { ...original, instanceId: 'new' }).runMode, 'global');
    assert.equal(interimReceiptRegistryRecord(receipt, { ...original, containerId: 'b'.repeat(64) }).runMode, 'global');
    assert.equal(interimReceiptRegistryRecord(receipt, { ...original, runMode: null }).runMode, null);
});
