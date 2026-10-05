// M-NW-01 D2-S: both edge lease families capture the resolver's effective
// availability and fence commit()/isCurrent() on its revision (LS5), and an
// inactive selector denies every route until reactivation, when the first
// capture applies the activation (LS8). Real workspace, real generations, real
// durable store, statuses written by the real worker writer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { captureEdgeRoutingObservationLease, loadEdgeRoutingGenerationForEvidence } from '../../cli/sandbox/edgeGeneration.js';
import { dispatchAgentStartupAfterRouterSurfaces } from '../../cli/server/agentStartupDispatch.js';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import { createHardwareAvailabilityResolverCache } from '../../cli/server/hardwareAvailabilityResolver.mjs';
import { entryFor, makeWorld } from './hardwareAvailabilityResolverFixtures.mjs';
import { namedGeneration } from './hardwareAvailabilityEvidenceProbe.mjs';

function quiet(t) {
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
}

const FAMILIES = Object.freeze([
    ['normal', (world) => world.lease()],
    ['observation', (world) => captureEdgeRoutingObservationLease({ expectedGeneration: world.selection().generation, ...world.options })],
]);

test('NW1.S-both-lease-families-capture-and-fence-the-effective-revision', (t) => {
    quiet(t);
    for (const [family, capture] of FAMILIES) {
        // pending -> succeeded leaves the revision unchanged (no denial class moves it).
        {
            const world = makeWorld(t);
            const slot = world.stageSlot('alpha');
            const lease = capture(world);
            const revision = lease.effective.revision;
            assert.equal(lease.effective.slots.get('alpha').evidenceClass, 'missing', family);
            assert.equal(lease.commit(), true, `${family}: fresh`);
            world.writeWorker('alpha', slot, { kind: 'starting' });
            assert.equal(lease.commit(), true, `${family}: pending does not fail the lease`);
            assert.equal(capture(world).effective.slots.get('alpha').evidenceClass, 'pending');
            world.writeWorker('alpha', slot, { kind: 'running' });
            assert.equal(lease.commit(), true, `${family}: succeeded does not fail the lease`);
            assert.equal(lease.isCurrent(), true, family);
            const after = capture(world);
            assert.equal(after.effective.slots.get('alpha').evidenceClass, 'succeeded');
            assert.equal(after.effective.revision, revision, `${family}: pending to succeeded leaves the revision`);
            assert.equal(after.effective.denials.size, 0);
        }
        // An activation between capture and commit fails the lease.
        {
            const world = makeWorld(t);
            const slot = world.stageSlot('alpha');
            world.writeWorker('alpha', slot, { kind: 'starting' });
            const lease = capture(world);
            const first = capture(world);
            assert.equal(lease.commit(), true);
            world.writeWorker('alpha', slot, { kind: 'hardware' });
            assert.equal(lease.commit(), false, `${family}: activation fails commit()`);
            assert.equal(lease.isCurrent(), false, `${family}: activation fails isCurrent()`);
            const later = capture(world);
            assert.notEqual(later.effective.revision, first.effective.revision);
            assert.equal(later.effective.denials.get('alpha').state, 'refused');
            assert.equal(later.commit(), true, `${family}: a lease captured after the activation is current`);
        }
        // An unreadable store fails the capture and the fence.
        {
            const world = makeWorld(t);
            world.stageSlot('alpha');
            const lease = capture(world);
            assert.equal(lease.commit(), true);
            fs.rmSync(world.paths.availabilityPolicyFile);
            assert.throws(() => capture(world), (error) => error?.code === 'HARDWARE_AVAILABILITY_POLICY_UNREADABLE', `${family}: capture`);
            assert.equal(lease.commit(), false, `${family}: commit()`);
            assert.equal(lease.isCurrent(), false, `${family}: isCurrent()`);
        }
        // An identical-content latch (the activation becomes a committed entry of the same
        // compiled denial) changes the store but not the effective revision.
        {
            const world = makeWorld(t);
            const slot = world.stageSlot('alpha');
            const finishedAtMs = Date.now() - 100;
            world.writeWorker('alpha', slot, { kind: 'hardware', finishedAtMs });
            const lease = capture(world);
            assert.equal(lease.effective.denials.get('alpha').state, 'refused');
            const storeBefore = world.store().revision;
            world.commitStore({
                entries: {
                    ...world.store().entries,
                    alpha: entryFor('alpha', { runId: slot.runId, runStartedAtMs: slot.runStartedAtMs, waveIndex: slot.waveIndex, finishedAtMs }),
                },
                slots: {},
            });
            assert.notEqual(world.store().revision, storeBefore, 'the store did change');
            assert.equal(lease.commit(), true, `${family}: identical-content latch keeps the lease current`);
            assert.equal(lease.isCurrent(), true, family);
            const latched = capture(world);
            assert.equal(latched.effective.revision, lease.effective.revision, `${family}: revision unchanged`);
            assert.equal(latched.effective.slots.size, 0);
            assert.deepEqual(latched.effective.denials.get('alpha'), lease.effective.denials.get('alpha'));
        }
    }
});

class MockResponse {
    constructor() { this.statusCode = 0; this.headers = {}; this.body = ''; }
    writeHead(statusCode, headers = {}) { this.statusCode = statusCode; this.headers = { ...headers }; }
    end(body = '') { this.body += body === undefined ? '' : String(body); }
}

test('NW1.S-inactive-selector-applies-the-activation-at-the-first-capture-after-reactivation', async (t) => {
    quiet(t);
    const world = makeWorld(t);
    const slot = world.stageSlot('alpha');
    const requestFor = () => ({ method: 'GET', url: '/alpha/api/data', headers: { host: '127.0.0.1:18080', accept: 'application/json' } });
    const activeGeneration = world.selection().generation;
    world.inactivate('sibling-replacement-preparation');
    assert.equal(world.selection().state, 'inactive');
    // The activation arrives while the selector is inactive.
    world.writeWorker('alpha', slot, { kind: 'hardware' });
    // Router-wide denial before route resolution; nothing is forwarded and no typed answer is possible (E-1 option a).
    const during = resolveEdgeRoutePlan({ req: requestFor(), listener: 'public' });
    assert.equal(during.ok, false);
    assert.equal(during.code, 'EDGE_GENERATION_INACTIVE');
    assert.equal(during.target ?? null, null);
    assert.equal(during.hardwareAvailability, undefined);
    // The lease-free evaluation against the generation the selector names already holds the typed denial.
    const named = namedGeneration(world.selection());
    assert.equal(named.source, 'selector.previousGeneration');
    assert.equal(named.id, activeGeneration);
    const generation = loadEdgeRoutingGenerationForEvidence(named.id, world.options);
    const evaluated = world.resolve({ generation, cache: createHardwareAvailabilityResolverCache() });
    assert.equal(evaluated.denials.get('alpha').state, 'refused');
    assert.equal(evaluated.denials.get('alpha').reasonCode, 'gate_off');
    // Reactivation: the very first plan carries the typed denial, with no fresh grace and no generic interval.
    world.apply('reactivate');
    assert.equal(world.selection().state, 'active');
    const req = requestFor();
    const plan = resolveEdgeRoutePlan({ req, listener: 'public' });
    assert.equal(plan.kind, 'agent-root-pending');
    assert.equal(plan.hardwareAvailability.state, 'refused');
    assert.equal(plan.lease.effective.slots.get('alpha').evidenceClass, 'active');
    const res = new MockResponse();
    let lifecycleReads = 0;
    const handled = await dispatchAgentStartupAfterRouterSurfaces({
        req, res, parsedUrl: plan.parsedUrl, routePlan: plan,
        ensureRouteAccess: async () => ({ ok: true }),
        inspectPublication: () => ({ ok: true, canPublishHttp: true }),
        resolveStartupState: async () => { lifecycleReads += 1; return { state: 'starting' }; },
    });
    assert.equal(handled, true);
    assert.equal(lifecycleReads, 0, 'terminal: no startup observation');
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).error, 'AGENT_HARDWARE_UNAVAILABLE');
    assert.equal(JSON.parse(res.body).code, 'hardware_refused');
    // The healthy sibling stays routable.
    const beta = resolveEdgeRoutePlan({ req: { method: 'GET', url: '/beta/api/data', headers: { host: '127.0.0.1:18080', accept: 'application/json' } }, listener: 'public' });
    assert.equal(beta.kind, 'agent-root');
});
