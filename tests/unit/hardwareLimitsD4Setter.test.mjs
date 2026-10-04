// D4 at the typed setter (decision D-R25-P-01): setAgentLimits refuses, under the store lock and before anything commits, a limit the runtime would
// refuse as host_network_nested_podman for the agent's default record or any of its registry instances. The refusal is the typed 422, leaves the
// policy bytes and the token as they were and is audited. These are the controls; the mutants that remove the check are in
// hardwareLimitsD4SetterMutants.test.mjs and run the guarding tests below.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';

// Workspace-relative writes (master key behind CSRF tokens, workspace lease) go to this test's own temporary workspace.
const priorWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const testWorkspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-d4s-workspace-')));
process.env.PLOINKY_WORKSPACE_ROOT = testWorkspace;
test.after(() => {
    if (priorWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = priorWorkspaceRoot;
    fs.rmSync(testWorkspace, { recursive: true, force: true });
});
const { handleHardwareLimitsRoutes } = await import('../../cli/server/authHandlers/hardwareLimitsRoutes.mjs');
const { hardwareStorePaths, initializeStore, readStoreSnapshot, setAgentLimits } = await import('../../cli/sandbox/hardwareLimits/store.mjs');
const { acquireStoreLock } = await import('../../cli/sandbox/hardwareLimits/storeLock.mjs');
const { buildWorkspaceIdentity } = await import('../../ploinky-box/identity.mjs');
const { mintAdminCsrfToken, verifyAdminMutationRequest } = await import('../../cli/server/adminControlSecurity.js');
const { admitManifestRuntimeCapabilities, hardwareRefusalOf } = await import('../../cli/sandbox/runtimeCapabilities.js');
const { resolveManifestRuntimeProfile } = await import('../../cli/utils/runtime/profileService.js');

const D4_CODE = 'PLOINKY_HARDWARE_LIMITS_UNENFORCEABLE';
const BASE = { container: 'node:20-alpine' };
const NESTED = { containerSecurity: { nestedPodman: true } };
const HOST = { network: { mode: 'host' } };
const ENVELOPE = Object.freeze({ cpus: 8, memoryBytes: 8 * 1024 ** 3 });

// The route's own admission (defaultAdmission), with the Box marker replaced by an explicit inside-Box fact: the product reads /etc/ploinky-box.
function realAdmit(agent, record = {}, context) {
    const bytes = fs.readFileSync(agent.manifestPath);
    const manifest = JSON.parse(bytes.toString('utf8'));
    const profile = resolveManifestRuntimeProfile(manifest, { agentName: agent.ref, profileName: record.profile || undefined });
    return admitManifestRuntimeCapabilities(manifest, {
        manifestPath: agent.manifestPath, manifestBytes: bytes, agentId: agent.ref,
        profileName: profile.resolvedProfileName, profileConfig: profile.profileConfig, network: profile.network, runtime: record.runtime || 'podman',
        instanceKey: record.key || agent.ref, alias: record.alias || '', hardwareAdmission: 'metadata', hardwareContext: context, insideBox: true,
    });
}

function world(t, manifest, { records = {}, context = {} } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-d4s-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const paths = hardwareStorePaths({ identity, homeDirectory: path.join(root, 'home') });
    initializeStore({ paths, identity });
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const registry = {};
    for (const [key, extra] of Object.entries(records)) {
        registry[key] = { type: 'agent', repoName: 'demo', agentName: 'worker', alias: key, instanceId: `instance-${key}`, enableGeneration: `generation-${key}`, containerId: 'a'.repeat(64), ...extra };
    }
    const admitted = [];
    const getContext = () => {
        const snapshot = readStoreSnapshot({ paths, identity });
        return { gate: 'on', prepared: true, backendReady: true, controllers: ['cpu', 'memory', 'pids'], storeState: 'valid', storeToken: snapshot.token, overrides: snapshot.agents, envelope: ENVELOPE, paths, identity, ...context };
    };
    const dependencies = {
        ensureAdmin: async (req) => req.user?.roles?.includes('admin') === true,
        verifyMutation: verifyAdminMutationRequest, getContext,
        getInstalled: () => [{ ref: 'demo/worker', manifestPath }],
        // A fresh copy per call: a reader that kept an earlier call's result does not see what the registry gained since.
        getRegistry: () => structuredClone(registry), getRouting: () => ({ routes: {} }), getMetrics: () => null,
        refreshMetrics: async () => ({ fresh: true }),
        admit: (agent, record, admissionContext) => { admitted.push(record?.key || 'default'); return realAdmit(agent, record, admissionContext); },
    };
    return { root, paths, identity, registry, manifestPath, admitted, dependencies, getContext, token: getContext().storeToken };
}

async function post(w, body, dependencies = {}) {
    const req = Readable.from([JSON.stringify(body)]);
    Object.assign(req, { method: 'POST', headers: { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' }, rawHeaders: [], socket: {}, user: { id: 'fixture-admin', roles: ['admin'] }, sessionId: 'fixture-session' });
    req.headers['x-ploinky-csrf-token'] = mintAdminCsrfToken({ req, sessionId: req.sessionId });
    let status;
    let response;
    const res = { writeHead(value) { status = value; }, end(value) { response = JSON.parse(value); } };
    await handleHardwareLimitsRoutes(req, res, new URL('http://127.0.0.1:8080/api/marketplace/hardware-limits'), { ...w.dependencies, ...dependencies });
    return { status, body: response };
}

const setBody = (w, extra = {}) => ({ action: 'set_agent_limits', expectedToken: w.token, agentRef: 'demo/worker', limits: { cpus: 1 }, ...extra });
const policyBytes = (w) => fs.readFileSync(w.paths.policyPath);
const tokenOf = (w) => readStoreSnapshot({ paths: w.paths, identity: w.identity }).token;
const storedOf = (w) => readStoreSnapshot({ paths: w.paths, identity: w.identity }).agents;
function auditEvents(w) {
    try {
        return fs.readFileSync(w.paths.auditPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
}

function assertNothingCommitted(w, before, { audit = 'refused-set' } = {}) {
    assert.deepEqual(policyBytes(w), before.bytes, 'limits.json is byte-identical');
    assert.deepEqual(tokenOf(w), before.token, 'the token did not move');
    assert.equal(storedOf(w).size, before.stored, 'no entry was stored');
    const events = auditEvents(w);
    if (audit === null) assert.deepEqual(events, [], 'no audit record');
    else {
        assert.equal(events.length, 1, JSON.stringify(events));
        assert.equal(events[0].action, audit);
        assert.equal(events[0].result, 'refused');
        assert.equal(events[0].ref, 'demo/worker');
    }
}
const snapshotOf = (w) => ({ bytes: policyBytes(w), token: tokenOf(w), stored: storedOf(w).size });

test('D4S.a-host-network-nested-podman-agent-is-refused-with-the-typed-422-and-the-policy-token-and-audit-show-only-the-refusal', async (t) => {
    const w = world(t, { ...BASE, ...NESTED, ...HOST });
    const before = snapshotOf(w);
    const result = await post(w, setBody(w));
    assert.equal(result.status, 422);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error, D4_CODE);
    assert.equal(result.body.hardwareOutcome.state, 'refused');
    assert.equal(result.body.hardwareOutcome.reasonCode, 'host_network_nested_podman');
    assert.equal(result.body.hardwareOutcome.ref, 'demo/worker');
    assert.deepEqual(result.body.hardwareOutcome.requested, [{ field: 'cpus', value: '1', source: 'settings' }]);
    assert.match(result.body.message, /host networking with nestedPodman/);
    assert.match(result.body.fix, /managed networking, remove nestedPodman/);
    assert.equal(Object.hasOwn(result.body, 'token'), false);
    assertNothingCommitted(w, before);
    assert.match(auditEvents(w)[0].reason, /host networking with nestedPodman/);
    // The token still works for a limit that is admissible once the manifest no longer combines them.
    fs.writeFileSync(w.manifestPath, JSON.stringify({ ...BASE, ...NESTED }));
    assert.equal((await post(w, setBody(w))).status, 200);
});

test('D4S.an-agent-on-managed-bridge-networking-is-accepted', async (t) => {
    const w = world(t, { ...BASE, network: { mode: 'bridge', attachments: [{ name: 'core', primary: true }] } });
    const result = await post(w, setBody(w));
    assert.equal(result.status, 200);
    assert.equal(result.body.committed, true);
    assert.equal(result.body.token.revision, w.token.revision + 1);
    assert.deepEqual(storedOf(w).get('demo/worker'), { cpus: 1 });
    assert.deepEqual(auditEvents(w).map((event) => event.action), ['set']);
});

test('D4S.nested-podman-alone-on-default-networking-is-accepted', async (t) => {
    const w = world(t, { ...BASE, ...NESTED });
    const result = await post(w, setBody(w));
    assert.equal(result.status, 200);
    assert.equal(result.body.token.revision, w.token.revision + 1);
    assert.deepEqual(storedOf(w).get('demo/worker'), { cpus: 1 });
});

test('D4S.host-networking-alone-without-nested-podman-is-accepted', async (t) => {
    const w = world(t, { ...BASE, ...HOST });
    const result = await post(w, setBody(w));
    assert.equal(result.status, 200);
    assert.equal(result.body.token.revision, w.token.revision + 1);
    assert.deepEqual(storedOf(w).get('demo/worker'), { cpus: 1 });
});

test('D4S.a-profile-that-only-one-registry-instance-selects-refuses-the-set-and-names-that-instance', async (t) => {
    const manifest = { ...BASE, ...NESTED, profiles: { default: {}, hostnet: { network: { mode: 'host' } } } };
    const w = world(t, manifest, { records: { canonical: { alias: '' }, one: {}, edge: { profile: 'hostnet' } } });
    const before = snapshotOf(w);
    const result = await post(w, setBody(w));
    assert.equal(result.status, 422);
    assert.equal(result.body.error, D4_CODE);
    assert.equal(result.body.hardwareOutcome.reasonCode, 'host_network_nested_podman');
    assert.equal(result.body.hardwareOutcome.key, 'edge');
    assertNothingCommitted(w, before);
});

test('D4S.the-default-record-alone-refuses-when-every-registry-instance-selects-a-managed-profile', async (t) => {
    const manifest = { ...BASE, ...NESTED, ...HOST, profiles: { default: {}, managed: { network: { mode: 'default' } } } };
    const w = world(t, manifest, { records: { canonical: { alias: '', profile: 'managed' }, one: { profile: 'managed' } } });
    const before = snapshotOf(w);
    const result = await post(w, setBody(w));
    assert.equal(result.status, 422);
    assert.equal(result.body.hardwareOutcome.reasonCode, 'host_network_nested_podman');
    assert.equal(result.body.hardwareOutcome.key, 'demo/worker');
    assertNothingCommitted(w, before);
});

test('D4S.the-facts-are-read-fresh-under-the-lock-a-manifest-and-an-instance-changed-after-the-request-was-read-decide', async (t) => {
    // The manifest and the registry are rewritten after the route read them and before the locked setter runs.
    const manifestRewrite = world(t, { ...BASE, ...NESTED });
    let before = snapshotOf(manifestRewrite);
    let result = await post(manifestRewrite, setBody(manifestRewrite), {
        set: (options) => { fs.writeFileSync(manifestRewrite.manifestPath, JSON.stringify({ ...BASE, ...NESTED, ...HOST })); return setAgentLimits(options); },
    });
    assert.equal(result.status, 422);
    assert.equal(result.body.hardwareOutcome.reasonCode, 'host_network_nested_podman');
    assertNothingCommitted(manifestRewrite, before);

    const registryGrowth = world(t, { ...BASE, ...NESTED, profiles: { default: {}, hostnet: { network: { mode: 'host' } } } }, { records: { canonical: { alias: '' } } });
    before = snapshotOf(registryGrowth);
    result = await post(registryGrowth, setBody(registryGrowth), {
        set: (options) => { registryGrowth.registry.late = { type: 'agent', repoName: 'demo', agentName: 'worker', alias: 'late', profile: 'hostnet', instanceId: 'instance-late', enableGeneration: 'generation-late', containerId: 'b'.repeat(64) }; return setAgentLimits(options); },
    });
    assert.equal(result.status, 422);
    assert.equal(result.body.hardwareOutcome.key, 'late');
    assertNothingCommitted(registryGrowth, before);
});

test('D4S.clearing-a-stored-limit-of-a-now-unenforceable-agent-still-works-and-setting-it-again-is-refused', async (t) => {
    const w = world(t, { ...BASE, ...NESTED, ...HOST });
    // The entry was stored before the manifest combined host networking with nestedPodman (a historical entry).
    const seeded = setAgentLimits({ paths: w.paths, identity: w.identity, expectedToken: w.token, agentRef: 'demo/worker', limits: { cpus: 2 }, installedRefs: new Set(['demo/worker']), capabilities: { gate: 'on', controllers: ['cpu', 'memory', 'pids'] }, envelope: ENVELOPE });
    const stored = snapshotOf(w);
    const again = await post(w, setBody(w, { expectedToken: seeded.token, limits: { cpus: 3 } }));
    assert.equal(again.status, 422);
    assert.deepEqual(policyBytes(w), stored.bytes);
    assert.deepEqual(storedOf(w).get('demo/worker'), { cpus: 2 });
    const cleared = await post(w, { action: 'clear_agent_limits', expectedToken: seeded.token, agentRef: 'demo/worker' });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.committed, true);
    assert.equal(storedOf(w).size, 0);
    assert.deepEqual(auditEvents(w).map((event) => event.action), ['set', 'refused-set', 'clear']);
});

test('D4S.with-the-gate-off-the-answer-stays-hardware-limits-off-and-nothing-is-admitted-or-audited', async (t) => {
    const w = world(t, { ...BASE, ...NESTED, ...HOST }, { context: { gate: 'off' } });
    const before = snapshotOf(w);
    const result = await post(w, setBody(w));
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'hardware_limits_off');
    assert.deepEqual(w.admitted, []);
    assertNothingCommitted(w, before, { audit: null });

    // At the store, the gate check precedes the admission callback and keeps its own code (and its existing refusal audit).
    const w2 = world(t, { ...BASE, ...NESTED, ...HOST });
    const before2 = snapshotOf(w2);
    let calls = 0;
    assert.throws(() => setAgentLimits({
        paths: w2.paths, identity: w2.identity, expectedToken: w2.token, agentRef: 'demo/worker', limits: { cpus: 1 }, installedRefs: new Set(['demo/worker']),
        capabilities: { gate: 'off', controllers: ['cpu'] }, envelope: ENVELOPE, admitProposed: () => { calls += 1; },
    }), { code: 'hardware_limits_off' });
    assert.equal(calls, 0);
    assertNothingCommitted(w2, before2);
});

test('D4S.a-changed-token-wins-over-the-admission-and-nothing-is-admitted-or-audited', async (t) => {
    const w = world(t, { ...BASE, ...NESTED, ...HOST });
    const before = snapshotOf(w);
    const result = await post(w, setBody(w, { expectedToken: { ...w.token, revision: w.token.revision + 5 } }));
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'revision_conflict');
    assert.deepEqual(w.admitted, []);
    assertNothingCommitted(w, before, { audit: null });
});

test('D4S.only-the-d4-refusal-propagates-an-unprepared-box-still-accepts-a-managed-agent-and-still-refuses-a-d4-agent', async (t) => {
    const unprepared = { prepared: false, unpreparedKind: 'cgroup' };
    const managed = world(t, { ...BASE, ...NESTED }, { context: unprepared });
    const accepted = await post(managed, setBody(managed));
    assert.equal(accepted.status, 200);
    assert.deepEqual(storedOf(managed).get('demo/worker'), { cpus: 1 });
    const d4 = world(t, { ...BASE, ...NESTED, ...HOST }, { context: unprepared });
    const before = snapshotOf(d4);
    const refused = await post(d4, setBody(d4));
    assert.equal(refused.status, 422);
    assert.equal(refused.body.hardwareOutcome.reasonCode, 'host_network_nested_podman');
    assertNothingCommitted(d4, before);
});

test('D4S.a-record-that-cannot-be-admitted-is-skipped-and-never-turns-into-a-refusal-of-the-set', async (t) => {
    const w = world(t, { ...BASE, ...NESTED, ...HOST });
    const result = await post(w, setBody(w), { admit: () => { throw new Error('manifest unreadable'); } });
    assert.equal(result.status, 200);
    assert.deepEqual(storedOf(w).get('demo/worker'), { cpus: 1 });
});

test('D4S.a-later-record-refused-by-d4-still-refuses-the-set-and-names-it-after-an-earlier-record-failed-admission', async (t) => {
    const manifest = { ...BASE, ...NESTED, profiles: { default: {}, hostnet: { network: { mode: 'host' } } } };
    const w = world(t, manifest, { records: { one: {}, edge: { profile: 'hostnet' } } });
    const before = snapshotOf(w);
    const failed = [];
    const result = await post(w, setBody(w), {
        admit: (agent, record, admissionContext) => {
            if (record?.key === 'one') { failed.push('one'); throw new Error('manifest unreadable'); }
            return realAdmit(agent, record, admissionContext);
        },
    });
    assert.deepEqual(failed, ['one'], 'the earlier record was admitted, and failed, before the later one');
    assert.equal(result.status, 422);
    assert.equal(result.body.error, D4_CODE);
    assert.equal(result.body.hardwareOutcome.reasonCode, 'host_network_nested_podman');
    assert.equal(result.body.hardwareOutcome.key, 'edge');
    assertNothingCommitted(w, before);
});

// The runtime's decision returns one reason, and an earlier-ranked one hides D4 there. Each control proves, from the admission itself (the first one the
// setter makes under the lock), that the other reason really is the one the runtime would return, and then that the set is still refused as D4 with the policy, the token and the audit untouched.
function hiddenBy() {
    const reasons = [];
    return { reasons, admit: (agent, record, admissionContext) => { const admission = realAdmit(agent, record, admissionContext); reasons.push(hardwareRefusalOf(admission)?.reasonCode ?? null); return admission; } };
}

test('D4S.an-unknown-envelope-does-not-hide-d4-and-only-d4-is-raised', async (t) => {
    const w = world(t, { ...BASE, ...NESTED, ...HOST }, { context: { envelope: null } });
    const before = snapshotOf(w);
    const probe = hiddenBy();
    const result = await post(w, setBody(w), { admit: probe.admit });
    assert.equal(probe.reasons[0], 'envelope_unknown', 'the runtime reports the unknown envelope, not D4, for this agent');
    assert.equal(result.status, 422);
    assert.equal(result.body.error, D4_CODE);
    assert.equal(result.body.hardwareOutcome.state, 'refused');
    assert.equal(result.body.hardwareOutcome.reasonCode, 'host_network_nested_podman');
    assert.equal(result.body.hardwareOutcome.ref, 'demo/worker');
    assert.deepEqual(result.body.hardwareOutcome.requested, [{ field: 'cpus', value: '1', source: 'settings' }]);
    assert.match(result.body.message, /host networking with nestedPodman/);
    assert.match(result.body.fix, /managed networking, remove nestedPodman/);
    assert.equal(Object.hasOwn(result.body, 'token'), false);
    assertNothingCommitted(w, before);
    assert.match(auditEvents(w)[0].reason, /host networking with nestedPodman/);
    // Only D4 is raised: the same unknown envelope does not refuse an agent that is not host-network + nestedPodman.
    for (const manifest of [{ ...BASE, ...NESTED }, { ...BASE, ...HOST }, BASE]) {
        const other = world(t, manifest, { context: { envelope: null } });
        const seen = hiddenBy();
        const accepted = await post(other, setBody(other), { admit: seen.admit });
        assert.equal(seen.reasons[0], 'envelope_unknown', 'the other agent is refused by the same reason in the runtime and is still accepted by the setter');
        assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
        assert.deepEqual(storedOf(other).get('demo/worker'), { cpus: 1 });
    }
});

test('D4S.a-declaration-conflict-does-not-hide-d4-and-only-d4-is-raised', async (t) => {
    const conflict = { hardwareLimits: { pidsLimit: 64 }, llmRuntime: { runtimePolicy: { resources: { pidsLimit: 32 } } } };
    const w = world(t, { ...BASE, ...NESTED, ...HOST, ...conflict });
    const before = snapshotOf(w);
    const probe = hiddenBy();
    const result = await post(w, setBody(w), { admit: probe.admit });
    assert.equal(probe.reasons[0], 'declaration_conflict', 'the runtime reports the conflict, not D4, for this agent');
    assert.equal(result.status, 422);
    assert.equal(result.body.error, D4_CODE);
    assert.equal(result.body.hardwareOutcome.reasonCode, 'host_network_nested_podman');
    assert.equal(result.body.hardwareOutcome.ref, 'demo/worker');
    assert.ok(result.body.hardwareOutcome.requested.some((entry) => entry.field === 'cpus' && entry.value === '1' && entry.source === 'settings'));
    assertNothingCommitted(w, before);
    // Only D4 is raised: the same conflict does not refuse a managed agent.
    const managed = world(t, { ...BASE, ...NESTED, ...conflict });
    const seen = hiddenBy();
    const accepted = await post(managed, setBody(managed), { admit: seen.admit });
    assert.equal(seen.reasons[0], 'declaration_conflict');
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(storedOf(managed).get('demo/worker'), { cpus: 1 });
});

test('D4S.the-store-runs-the-admission-under-its-lock-with-the-locked-snapshot-plus-the-proposed-entry-and-a-throw-commits-nothing', (t) => {
    const w = world(t, BASE);
    const capabilities = { gate: 'on', controllers: ['cpu', 'memory', 'pids'] };
    const installedRefs = new Set(['demo/worker', 'demo/other']);
    const seeded = setAgentLimits({ paths: w.paths, identity: w.identity, expectedToken: w.token, agentRef: 'demo/other', limits: { cpus: 2 }, installedRefs, capabilities, envelope: ENVELOPE });
    const before = snapshotOf(w);
    const seenBefore = auditEvents(w).length;
    let seen = null;
    const marker = Object.assign(new Error('proposal refused by the caller'), { code: 'exceeds_envelope', status: 422 });
    assert.throws(() => setAgentLimits({
        paths: w.paths, identity: w.identity, expectedToken: seeded.token, agentRef: 'demo/worker', limits: { cpus: 1 }, installedRefs, capabilities, envelope: ENVELOPE,
        admitProposed: (proposal) => {
            // Called while the store lock is held: a second writer is refused as busy.
            assert.throws(() => acquireStoreLock({ storeRoot: w.paths.storeRoot, deadlineMs: 30 }), { code: 'store_busy' });
            seen = { agentRef: proposal.agentRef, entry: proposal.entry, agents: [...proposal.agents].sort(([a], [b]) => a.localeCompare(b)) };
            proposal.agents.set('demo/injected', { cpus: 1 });
            throw marker;
        },
    }), (error) => error === marker);
    assert.deepEqual(seen, { agentRef: 'demo/worker', entry: { cpus: 1 }, agents: [['demo/other', { cpus: 2 }], ['demo/worker', { cpus: 1 }]] });
    assert.deepEqual(policyBytes(w), before.bytes);
    assert.deepEqual(tokenOf(w), before.token);
    const events = auditEvents(w);
    assert.equal(events.length, seenBefore + 1);
    assert.equal(events.at(-1).action, 'refused-set');
    assert.equal(events.at(-1).reason, 'proposal refused by the caller');
    // A passing callback commits exactly the proposed entry (the callback's copy is not what is stored).
    const committed = setAgentLimits({
        paths: w.paths, identity: w.identity, expectedToken: seeded.token, agentRef: 'demo/worker', limits: { cpus: 1 }, installedRefs, capabilities, envelope: ENVELOPE,
        admitProposed: (proposal) => { proposal.agents.set('demo/injected', { cpus: 1 }); },
    });
    assert.equal(committed.token.revision, seeded.token.revision + 1);
    assert.deepEqual([...storedOf(w).keys()].sort(), ['demo/other', 'demo/worker']);
});
