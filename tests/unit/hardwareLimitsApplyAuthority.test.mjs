import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHardwareApplyAuthority } from '../../cli/server/hardwareLimitsApplyAuthority.mjs';
import { withEdgeSelectionObserver, recordOwnedEdgeSelection } from '../../cli/sandbox/edgeSelectionMutations.mjs';
import { inactivateEdgeRoutingGeneration } from '../../cli/sandbox/edgeGeneration.js';
import { reconcileExactHardwareInstance } from '../../cli/sandbox/hardwareLimits/reconcile.mjs';

const selector = (id) => ({ state: 'active', generation: `sha256:${id.repeat(64)}`, activationId: `activation-${id}`, selectorDigest: `sha256:${id.repeat(64)}` });
const selectorFile = '/fixture/.ploinky/edge/active.json';
const source = fs.readFileSync(new URL('../../cli/sandbox/edgeGeneration.js', import.meta.url), 'utf8');
const start = source.indexOf('export function captureEdgeRoutingLease(');
const end = source.indexOf('\nexport function captureEdgeRoutingObservationLease(', start);
assert.ok(start > 0 && end > start);
const leaseSource = source.slice(start, end).replace('export function', 'function');

test('R.owned-generation-chain-does-not-self-refuse', async () => {
    let current = selector('a');
    // The lease also captures the resolver's effective availability (M-NW-01); this test is about the selector chain only, so it sees a constant one.
    const original = new Function('loadActiveEdgeRoutingGeneration', 'resolveLeaseEffective', `${leaseSource}\nreturn captureEdgeRoutingLease();`)(() => ({ selector: current, generation: {} }), () => ({ revision: 'sha256:fixture-effective' }));
    const authority = createHardwareApplyAuthority({ verifyInitial: () => original.commit(), readSelection: () => ({ selector: current, paths: { activeSelectorFile: selectorFile } }) });
    const record = { type: 'agent', repoName: 'demo', agentName: 'worker', instanceId: 'instance', enableGeneration: 'generation', containerId: 'f'.repeat(64) };
    const registry = { exact: record };
    const events = [];
    const own = (id) => {
        const before = current;
        current = selector(id);
        recordOwnedEdgeSelection({ selectorFile, before, after: current });
    };
    const run = (id) => withEdgeSelectionObserver((receipt) => assert.equal(authority.accept(receipt), true), () => reconcileExactHardwareInstance({ key: 'exact', record }, { authorize: () => authority.isCurrent() }, {
        loadRegistry: () => registry, readPolicy: () => ({ token: null, paths: null }),
        loadRouting: () => ({ routes: { worker: { container: 'exact' } } }),
        loadPlan: () => ({ runtime: 'podman', manifest: {}, profileResolution: {}, agentPath: '/fixture', routerEndpoint: null }),
        maintenance: (_key, _options, callback) => callback(), network: (callback) => callback({}),
        prepare: async () => { own(id); events.push('withdraw'); return { identity: {}, targetedRestart: {} }; },
        ensure: () => { events.push('create'); return { containerName: 'exact', registryRecord: record, containerId: record.containerId }; },
        readiness: async () => events.push('ready'), commit: async () => events.push('publish'), cleanupTargeted: () => {},
    }));
    assert.equal((await run('b')).state, 'applied');
    assert.equal(original.commit(), false, 'the actual original lease became stale');
    assert.equal((await run('c')).state, 'applied', 'the same operation can continue after its own activation');
    const beforeForeign = events.length;
    current = selector('d');
    await assert.rejects(run('e'), { code: 'identity_changed' });
    assert.equal(events.length, beforeForeign, 'foreign generation prevents destructive work');
});

test('R.owned-generation-receipt-rejects-foreign-chain', () => {
    let current = selector('a');
    const authority = createHardwareApplyAuthority({ readSelection: () => ({ selector: current, paths: { activeSelectorFile: selectorFile } }) });
    current = selector('b');
    assert.equal(authority.accept({ selectorFile, before: selector('x'), after: current }), false);
    assert.equal(authority.isCurrent(), false);
});

test('R.actual-selector-writes-are-operation-scoped', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-selection-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.ploinky'));
    const receipts = [];
    await withEdgeSelectionObserver((value) => receipts.push(value), async () => {
        inactivateEdgeRoutingGeneration('owned-operation-test', { workspaceRoot: root });
    });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].before, null);
    assert.equal(receipts[0].after.state, 'inactive');
    assert.ok(receipts[0].selectorFile.startsWith(root));
    inactivateEdgeRoutingGeneration('outside-operation-test', { workspaceRoot: root });
    assert.equal(receipts.length, 1, 'unrelated source writes are never attributed to the Apply');
});
