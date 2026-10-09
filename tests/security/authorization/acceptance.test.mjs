// A2: the scoped acceptance gate, its policy files and fixed controls must
// REJECT every case the plan lists, each for its intended reason, and ACCEPT
// only a complete synthetic run. No live deployment request is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertBoxConfinement, assertRuntimeSet, sanitizeGapEvidence, verifyBoxAgainstPins } from './core.mjs';
import { evaluateScopedAcceptance, loadAcceptanceInputs, parseTap, validateExpectedGaps } from './acceptance/verify-acceptance.mjs';
import { enumerateMandatoryChecks, INLINE_TEMPLATES, D2_DENIAL_MATRIX } from './acceptance/mandatory-checks.mjs';
import { deriveExpectedRuntimes, GraphError } from './acceptance/expected-runtime-graph.mjs';
import { loadPins, verifyCandidate, PinError } from './acceptance/pins.mjs';
import { capture } from './acceptance/evidence-capture.mjs';
import { policyDigest } from './acceptance/digest.mjs';
import { captureExitCode } from './acceptance/run-acceptance.mjs';
import { runMarketplaceAdmissionProbes, runTemplateProbes, marketplaceProjection } from './boundary-probes.mjs';
import { runWebchatProbes, dpuProcessInspector, createStreamHandle, waitForStartupReady, DPU_UNSUPPORTED_REPLY, LIVE_INTERACTION_LIMITATION } from './webchat-probes.mjs';
import { discoverAgentMcp } from './agent-probes.mjs';
import { workspaceWriteMatrix, workspaceWriteCheckDefinitions } from './stream-probes.mjs';
import { runCapabilityProbes, nonApplicableRecord } from './capability-probes.mjs';
import { deriveCapabilities } from './acceptance/expected-runtime-graph.mjs';
import { ackCount } from './webchat-probes.mjs';
import { BOX_DATA_MOUNTS } from '../../../ploinky-box/constants.mjs';
import { inventoryBaseline } from './agent-inventory.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const inputs = loadAcceptanceInputs();
const { policy, mandatory, expectedGaps, expectedRuntimes } = inputs;
const clone = value => JSON.parse(JSON.stringify(value));
const sha = value => createHash('sha256').update(value).digest('hex');
const SHA1 = 'a'.repeat(40);
const WS = policy.workspace;

function makePins() {
    return {
        schema: 'authz-acceptance-pins/1',
        ploinky: { commit: SHA1, branch: 'test/authz-live-acceptance', upstream: 'origin/test/authz-live-acceptance' },
        ploinkyCheckout: '/candidate/ploinky',
        workspace: WS,
        repositories: expectedRuntimes.inventoryRepositories.map(name => ({ name, path: `.ploinky/repos/${name}`, commit: inventoryBaseline.repositories.find(r => r.name === name).commit, branch: 'main', upstream: 'origin/main' })),
        policyDigest: inputs.acceptanceDigest,
        box: { id: 'c'.repeat(64), name: 'ploinky-box-testExplorerFresh-123456789abc', startedAt: '2026-10-09T00:00:00.000Z', imageId: `sha256:${'d'.repeat(64)}`, imageDigest: `sha256:${'e'.repeat(64)}` },
        agentlib: { mode: 'image' },
    };
}

function tapFor(entry) {
    const names = entry.tests.length ? entry.tests : ['representative test'];
    const lines = ['TAP version 13', ...names.map((n, i) => `ok ${i + 1} - ${n}`), `1..${names.length}`, `# tests ${names.length}`, '# suites 0', `# pass ${names.length}`, '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'];
    return lines.join('\n') + '\n';
}

/** A complete synthetic run that satisfies every rule. */
function acceptedRun() {
    const pins = makePins();
    const checks = [];
    const gaps = [];
    const routerCoverage = [];
    for (const entry of mandatory.checks.filter(c => c.kind === 'live')) for (let i = 0; i < entry.count; i++) checks.push({ id: entry.id, status: 'PASS' });
    for (const entry of mandatory.checks.filter(c => /^router:users-list\.path-/.test(c.id))) {
        const [, probeId, actor] = entry.id.split(':');
        routerCoverage.push({ probeId, actor, status: 'AUTHORIZATION_DENIAL_PASSED', httpStatus: actor === 'anonymous' ? 401 : 403 });
    }
    for (const entry of expectedGaps.gaps) {
        const ev = entry.evidence;
        if (ev.kind === 'boundary-rejected') {
            gaps.push({ id: entry.id, reason: 'r', evidence: { kind: 'boundary-rejected', probeId: ev.probeId, actor: ev.actor, httpStatus: 404 } });
            routerCoverage.push({ probeId: ev.probeId, actor: ev.actor, status: 'BOUNDARY_REJECTED_ONLY', httpStatus: 404 });
        } else if (ev.kind === 'negative-only-protocol') {
            gaps.push({ id: entry.id, reason: 'r', evidence: { kind: ev.kind, probeId: ev.probeId, actor: ev.actor } });
            routerCoverage.push({ probeId: ev.probeId, actor: ev.actor, status: 'NEGATIVE_ONLY_PASSED', httpStatus: 401 });
            checks.push({ id: `router:${ev.probeId}:${ev.actor}`, status: 'PASS' });
        } else gaps.push({ id: entry.id, reason: 'r', evidence: { ...ev } });
    }
    const report = {
        checks, gaps, routerCoverage, cleanup: [{ index: 0, status: 'PASS' }], finalOwnership: 'PASS', workspaceMutationLock: 'RELEASED',
        counts: { PASS: checks.length, FAIL: 0, ERROR: 0 }, verdict: 'NO_FAILURES_WITH_GAPS',
        pins: { sha256: 'f'.repeat(64), policyDigest: pins.policyDigest },
        deployment: { boxId: pins.box.id, startedAt: pins.box.startedAt, image: { imageId: pins.box.imageId }, repositories: pins.repositories.map(({ name, commit }) => ({ name, commit })) },
        principals: Object.entries(policy.principals).map(([name, roles], i) => ({ name, roles, idHash: String(i), authoritativeRoleVerified: true })),
        runtimes: expectedRuntimes.enabled.map(({ repo, agent }) => ({ repo, agent, enabled: true, running: true })),
        liveLimitations: [{ ...LIVE_INTERACTION_LIMITATION }],
        capabilityNonApplicable: nonApplicableRecord(policy.capabilities),
    };
    const offline = mandatory.checks.filter(c => c.kind === 'offline').map(entry => {
        const tap = tapFor(entry);
        const commit = entry.repo === 'ploinky' ? pins.ploinky.commit : pins.repositories.find(r => r.name === entry.repo).commit;
        return { sidecar: { repo: entry.repo, file: entry.file, commit, clean: true, exitCode: 0, tapSha256: sha(tap) }, tap };
    });
    return { report, exitCode: 2, offline, pins, pinsSha256: 'f'.repeat(64), derivedRuntimes: clone(expectedRuntimes), ...inputs };
}

const evaluate = run => evaluateScopedAcceptance(run);
function expectReject(run, code, label) {
    const result = evaluate(run);
    assert.equal(result.decision, 'REJECT', `${label}: expected REJECT`);
    assert.ok(result.reasons.some(r => r.startsWith(code)), `${label}: expected ${code}, got ${result.reasons.slice(0, 5).join(' | ')}`);
}

test('positive control: a complete synthetic run is ACCEPTed', () => {
    const result = evaluate(acceptedRun());
    assert.deepEqual(result.reasons, []);
    assert.equal(result.decision, 'ACCEPT');
});

test('REJECT: same discovery gap ID with a timeout, a 503, a malformed result or an initialization -32601', () => {
    const id = 'agent.dpuAgent.discovery.prompts.list';
    const substitutes = {
        timeout: { kind: 'positive-unavailable', actor: 'admin', endpoint: '/dpuAgent/mcp', requestedMethod: 'prompts/list' },
        http503: { kind: 'positive-unavailable', actor: 'admin', endpoint: '/dpuAgent/mcp', requestedMethod: 'prompts/list', stage: 'prompts/list', httpStatus: 503 },
        malformed: { kind: 'positive-unavailable', actor: 'admin', endpoint: '/dpuAgent/mcp', requestedMethod: 'prompts/list', stage: 'prompts/list', httpStatus: 200 },
        initialize32601: { kind: 'rpc-method-unsupported', actor: 'admin', endpoint: '/dpuAgent/mcp', requestedMethod: 'prompts/list', stage: 'initialize', initialized: false, httpStatus: 200, rpcCode: -32601 },
        wrongStatus: { kind: 'rpc-method-unsupported', actor: 'admin', endpoint: '/dpuAgent/mcp', requestedMethod: 'prompts/list', stage: 'prompts/list', initialized: true, httpStatus: 503, rpcCode: -32601 },
        untyped: undefined,
    };
    for (const [label, evidence] of Object.entries(substitutes)) {
        const run = acceptedRun();
        const gap = run.report.gaps.find(g => g.id === id);
        assert.ok(gap, 'fixture must contain the reviewed exclusion');
        gap.evidence = sanitizeGapEvidence(evidence);
        expectReject(run, 'GAP_EVIDENCE_MISMATCH', label);
    }
});

test('REJECT: a raw-path boundary gap without BOUNDARY_REJECTED_ONLY or with an unreviewed status', () => {
    const probeId = 'users-list.path-duplicate-slash';
    const id = `router:${probeId}:userA`;
    let run = acceptedRun();
    run.report.routerCoverage.find(r => r.probeId === probeId && r.actor === 'userA').status = 'CONTROL_UNAVAILABLE';
    expectReject(run, 'GAP_EVIDENCE_MISMATCH', 'coverage status');
    for (const status of [400, 405, 421, 503]) {
        run = acceptedRun();
        run.report.gaps.find(g => g.id === id).evidence.httpStatus = status;
        run.report.routerCoverage.find(r => r.probeId === probeId && r.actor === 'userA').httpStatus = status;
        expectReject(run, 'GAP_EVIDENCE_MISMATCH', `ungrounded ${status}`);
    }
    run = acceptedRun();
    run.report.gaps.find(g => g.id === id).evidence = { kind: 'positive-unavailable', probeId, actor: 'userA' };
    expectReject(run, 'GAP_EVIDENCE_MISMATCH', 'positive control failed under the same ID');
});

test('D2 matrix: normalized families must be explicit denials linked to their exact request; a boundary gap there rejects', () => {
    let run = acceptedRun();
    run.report.checks = run.report.checks.filter(c => c.id !== 'router:users-list.path-dot-segment:userA');
    run.report.counts.PASS = run.report.checks.length;
    run.report.routerCoverage = run.report.routerCoverage.filter(r => !(r.probeId === 'users-list.path-dot-segment' && r.actor === 'userA'));
    run.report.routerCoverage.push({ probeId: 'users-list.path-dot-segment', actor: 'userA', status: 'BOUNDARY_REJECTED_ONLY', httpStatus: 404 });
    run.report.gaps.push({ id: 'router:users-list.path-dot-segment:userA', reason: 'r', evidence: { kind: 'boundary-rejected', probeId: 'users-list.path-dot-segment', actor: 'userA', httpStatus: 404 } });
    expectReject(run, 'GAP_UNEXPECTED', 'normalized family as boundary');
    assert.ok(evaluate(run).reasons.some(r => r.startsWith('MANDATORY_MISSING: router:users-list.path-dot-segment:userA')));
    run = acceptedRun();
    run.report.routerCoverage.find(r => r.probeId === 'users-list.path-encoded-owner' && r.actor === 'selfRegistered').httpStatus = 404;
    expectReject(run, 'RAW_PATH_DENIAL_LINKAGE', 'denial linkage');
    assert.ok(mandatory.checks.some(c => c.id === 'router:users-list.path-encoded-slash:anonymous'));
    assert.ok(!expectedGaps.gaps.some(g => g.id === 'router:users-list.path-encoded-slash:anonymous'));
    assert.deepEqual(policy.boundaryRejectionStatuses, [404]);
});

test('REJECT: unexpected, missing and duplicate gaps', () => {
    let run = acceptedRun();
    run.report.gaps.push({ id: 'agent.webmeetAgent.discovery.tools.list', reason: 'r', evidence: { kind: 'rpc-method-unsupported' } });
    expectReject(run, 'GAP_UNEXPECTED', 'unexpected');
    run = acceptedRun();
    run.report.gaps = run.report.gaps.filter(g => g.id !== 'agent.GPTResearcher.disabled');
    expectReject(run, 'GAP_MISSING', 'missing');
    run = acceptedRun();
    run.report.gaps.push(clone(run.report.gaps.find(g => g.id === 'agent.inference')));
    expectReject(run, 'GAP_DUPLICATE', 'duplicate');
    run = acceptedRun();
    run.report.gaps.push({ id: 'agent.dpuAgent.discovery.tools.list.selfRegistered.scope', reason: 'r', evidence: { kind: 'selfregistered-visible-tools', actor: 'selfRegistered', visibleTools: ['dpu_whoami'] } });
    expectReject(run, 'GAP_UNEXPECTED', 'unlisted metadata visibility');
});

test('selfRegistered visible-tool exclusion requires exact equality with the reviewed list', () => {
    const entry = { id: 'agent.dpuAgent.discovery.tools.list.selfRegistered.scope', category: 'protocol-combination-outside-changed-paths', presence: 'required', source: 'tests/security/authorization/agent-probes.mjs:288', reason: 'r', affectedObligations: ['router/agent-mcp.post'], outsideChangedBehavior: 'o', reviewedBy: 'test',
        evidence: { kind: 'selfregistered-visible-tools', actor: 'selfRegistered', endpoint: '/dpuAgent/mcp', requestedMethod: 'tools/list', stage: 'tools/list', visibleTools: ['dpu_whoami'] } };
    const run = acceptedRun();
    run.expectedGaps = clone(expectedGaps);
    run.expectedGaps.gaps.push(entry);
    const gap = { id: entry.id, reason: 'r', evidence: { ...entry.evidence, httpStatus: 200 } };
    run.report.gaps.push(gap);
    assert.equal(evaluate(run).decision, 'ACCEPT');
    gap.evidence.visibleTools = ['dpu_whoami', 'dpu_workspace_roots'];
    expectReject(run, 'GAP_EVIDENCE_MISMATCH', 'policy exposes more tools');
});

test('REJECT: a mandatory check that is missing, FAIL, duplicated, or whose positive control failed', () => {
    let run = acceptedRun();
    run.report.checks = run.report.checks.filter(c => c.id !== 'router:users-list.allow:admin');
    run.report.counts.PASS = run.report.checks.length;
    expectReject(run, 'MANDATORY_MISSING', 'missing (skipped/never executed)');
    run = acceptedRun();
    run.report.checks.find(c => c.id === 'resource.dpu.userB.read').status = 'FAIL';
    run.report.counts = { PASS: run.report.counts.PASS - 1, FAIL: 1, ERROR: 0 };
    run.report.verdict = 'FAIL';
    run.exitCode = 1;
    expectReject(run, 'MANDATORY_NOT_PASS', 'FAIL');
    run = acceptedRun();
    run.report.checks.push({ id: 'u6:webchat-distinct-processes', status: 'PASS' });
    run.report.counts.PASS += 1;
    expectReject(run, 'MANDATORY_DUPLICATE', 'duplicate');
    // A deny check counts only when its linked positive control passed in the same run.
    run = acceptedRun();
    run.report.checks = run.report.checks.filter(c => c.id !== 'u7:marketplace-unknown-action:admin:repos');
    run.report.counts.PASS = run.report.checks.length;
    expectReject(run, 'MANDATORY_POSITIVE_CONTROL_FAILED', 'deny without positive');
});

test('C4 acceptance requires the fixture, its positive dependencies and all five feed actors', () => {
    const fixture = 'agent.tool.webmeet_room_list.fixture';
    const feed = 'agent.tool.webmeet_room_events_list';
    for (const tool of ['webmeet_room_list', 'webmeet_room_events_list']) {
        const admin = mandatory.checks.find(c => c.id === `agent.tool.${tool}.admin`);
        assert.deepEqual(admin.positiveControlAnyOf, [fixture]);
    }
    for (const actor of ['admin', 'anonymous', 'selfRegistered', 'userA', 'userB']) assert.ok(mandatory.checks.some(c => c.id === `${feed}.${actor}`));
    for (const id of [fixture, ...['admin', 'anonymous', 'selfRegistered', 'userA', 'userB'].map(actor => `${feed}.${actor}`)]) {
        const missing = acceptedRun();
        missing.report.checks = missing.report.checks.filter(c => c.id !== id);
        missing.report.counts.PASS = missing.report.checks.length;
        expectReject(missing, 'MANDATORY_MISSING', id);
        const failed = acceptedRun();
        failed.report.checks.find(c => c.id === id).status = 'FAIL';
        failed.report.counts = { PASS: failed.report.counts.PASS - 1, FAIL: 1, ERROR: 0 };
        failed.report.verdict = 'FAIL';
        failed.exitCode = 1;
        expectReject(failed, 'MANDATORY_NOT_PASS', id);
        if (id === fixture) assert.ok(evaluate(failed).reasons.some(r => r.startsWith('MANDATORY_POSITIVE_CONTROL_FAILED: agent.tool.webmeet_room_events_list.admin')));
    }
    const stale = acceptedRun();
    stale.mandatory = clone(mandatory);
    stale.mandatory.checks = stale.mandatory.checks.filter(c => c.id !== fixture && !c.id.startsWith(`${feed}.`));
    expectReject(stale, 'MANDATORY_FILE_DRIFT', 'stale pre-C4 mandatory inventory');
});

test('C4 acceptance rejects missing, duplicate and stale inventory repository pins', () => {
    for (const mutate of [
        repositories => repositories.slice(1),
        repositories => [],
        repositories => [...repositories, repositories[0]],
        repositories => repositories.map((r, i) => i ? r : { ...r, commit: '0'.repeat(40) }),
    ]) {
        const run = acceptedRun();
        const repositories = inventoryBaseline.repositories.filter(r => r.name !== 'ploinky');
        run.baseline = { ...clone(inventoryBaseline), repositories: mutate(repositories) };
        expectReject(run, 'INVENTORY_BASELINE_BINDING', 'inventory candidate mismatch');
    }
});

test('REJECT: an exit code that disagrees with the verdict, or a non-gap raw outcome', () => {
    for (const exitCode of [0, 1, 3, undefined]) {
        const run = acceptedRun();
        run.exitCode = exitCode;
        expectReject(run, exitCode === undefined ? 'EXIT_CODE_MISSING' : 'EXIT_CODE_VERDICT_MISMATCH', `exit ${exitCode}`);
    }
    const run = acceptedRun();
    run.report.verdict = 'PASS';
    run.exitCode = 0;
    expectReject(run, 'RAW_OUTCOME', 'full PASS is not the scoped raw outcome');
});

test('REJECT: run health, pins binding, principals and offline evidence', () => {
    const cases = [
        [r => { r.report.setupError = 'x'; }, 'SETUP_ERROR'],
        [r => { r.report.interrupted = 'SIGINT'; }, 'INTERRUPTED'],
        [r => { r.report.cleanup.push({ status: 'FAIL' }); }, 'CLEANUP_NOT_PASS'],
        [r => { r.report.finalOwnership = 'Box changed'; }, 'FINAL_OWNERSHIP'],
        [r => { r.report.workspaceMutationLock = 'HELD'; }, 'LOCK_NOT_RELEASED'],
        [r => { r.pinsSha256 = '0'.repeat(64); }, 'PINS_BINDING'],
        [r => { r.acceptanceDigest = '0'.repeat(64); }, 'POLICY_DIGEST_BINDING'],
        [r => { r.report.deployment.boxId = '9'.repeat(64); }, 'DEPLOYMENT_BINDING'],
        [r => { r.baseline = { repositories: [{ name: 'AchillesIDE', commit: '7'.repeat(40) }] }; }, 'INVENTORY_BASELINE_BINDING'],
        [r => { r.report.principals[0].roles = ['user']; }, 'PRINCIPAL_ROLE'],
        [r => { r.report.principals.pop(); }, 'PRINCIPALS_SET'],
        [r => { r.offline[0].sidecar.commit = '1'.repeat(40); }, 'OFFLINE_COMMIT'],
        [r => { r.offline[0].sidecar.clean = false; }, 'OFFLINE_DIRTY'],
        [r => { r.offline[0].tap += '\n'; }, 'OFFLINE_TAP_HASH'],
        [r => { r.offline.pop(); }, 'OFFLINE_MISSING'],
    ];
    for (const [mutate, code] of cases) { const run = acceptedRun(); mutate(run); expectReject(run, code, code); }
    const skipped = acceptedRun();
    const entry = skipped.offline[0];
    entry.tap = entry.tap.replace('ok 1 - ', 'ok 1 - ').replace(/(ok 1 - [^\n]*)/, '$1 # SKIP not run').replace('# skipped 0', '# skipped 1');
    entry.sidecar.tapSha256 = sha(entry.tap);
    expectReject(skipped, 'OFFLINE_SUMMARY', 'skipped offline test');
    const missingName = acceptedRun();
    const webchat = missingName.offline.find(o => o.sidecar.file === 'tests/unit/webchatPrincipalRuntime.test.mjs');
    webchat.tap = webchat.tap.replace('a delayed close', 'a renamed close');
    webchat.sidecar.tapSha256 = sha(webchat.tap);
    expectReject(missingName, 'OFFLINE_TEST_MISSING', 'named regression missing');
    assert.deepEqual(parseTap('ok 1 - a # SKIP x\n# skipped 1\n').results[0].directive, 'SKIP');
});

test('REJECT: runtime set empty, duplicated, extra, missing or not running', () => {
    const live = expectedRuntimes.enabled.map(({ repo, agent }) => ({ repoName: repo, agentName: agent, enabled: true, state: { running: true } }));
    assert.equal(assertRuntimeSet(live, expectedRuntimes.enabled).length, expectedRuntimes.counts.enabled);
    const negatives = {
        RUNTIME_SET_EMPTY: [],
        RUNTIME_SET_DUPLICATE: [...live, live[0]],
        RUNTIME_SET_EXTRA: [...live, { repoName: 'AchillesIDE', agentName: 'webmeetStt', enabled: true, state: { running: true } }],
        RUNTIME_SET_MISSING: live.slice(1),
        RUNTIME_NOT_RUNNING: live.map((r, i) => i ? r : { ...r, state: { running: false } }),
    };
    for (const [code, value] of Object.entries(negatives)) assert.throws(() => assertRuntimeSet(value, expectedRuntimes.enabled), new RegExp(code), code);
    assert.throws(() => assertRuntimeSet(live, []), /RUNTIME_SET_EXPECTED_EMPTY/);
    const reportCases = {
        RUNTIME_SET_EMPTY: r => { r.report.runtimes = []; },
        RUNTIME_SET_DUPLICATE: r => { r.report.runtimes.push(r.report.runtimes[0]); },
        RUNTIME_SET_EXTRA: r => { r.report.runtimes.push({ repo: 'proxies', agent: 'opencode-free', enabled: true, running: true }); },
        RUNTIME_SET_MISSING: r => { r.report.runtimes.shift(); },
        RUNTIME_NOT_RUNNING: r => { r.report.runtimes[0].running = false; },
    };
    for (const [code, mutate] of Object.entries(reportCases)) { const run = acceptedRun(); mutate(run); expectReject(run, code, code); }
});

function boxRecord(overrides = {}) {
    const mounts = [
        { Type: 'bind', Source: '/candidate/ploinky', Destination: '/opt/ploinky', RW: false },
        { Type: 'bind', Source: WS, Destination: WS, RW: true },
        { Type: 'bind', Source: `${WS}/.ploinky/box/dependencies`, Destination: BOX_DATA_MOUNTS.dependencies, RW: true },
        { Type: 'bind', Source: `${WS}/.ploinky/box/images`, Destination: BOX_DATA_MOUNTS.images, RW: true },
        { Type: 'tmpfs', Source: '', Destination: '/tmp', RW: true },
        ...(overrides.extraMounts || []),
    ];
    return {
        Id: 'c'.repeat(64), Name: 'ploinky-box-testExplorerFresh-123456789abc', Image: 'd'.repeat(64), ImageDigest: `sha256:${'e'.repeat(64)}`,
        State: { Running: true, StartedAt: '2026-10-09T00:00:00.000Z', Status: 'running' },
        Config: { User: 'podman', Image: 'x', Env: [] },
        HostConfig: { Privileged: false, Init: true, Tmpfs: { '/tmp': 'rw,exec,nosuid,nodev,mode=1777,rprivate' } },
        NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }], '7882/udp': [{ HostIp: '', HostPort: '7882' }] } },
        Mounts: overrides.mounts ? overrides.mounts(mounts) : mounts,
    };
}
const confinement = (box, agentLib = { mode: 'image' }) => assertBoxConfinement(box, { workspace: WS, ploinkyCheckout: '/candidate/ploinky', agentLib, policy });
const localLib = { mode: 'local', sourceRelativePath: '.ploinky/agentlib/source' };
const localMounts = [
    { Type: 'bind', Source: `${WS}/.ploinky/agentlib/source`, Destination: '/opt/ploinky-agentlib', RW: false },
    { Type: 'bind', Source: `${WS}/.ploinky/agentlib/source`, Destination: `${WS}/.ploinky/agentlib/source`, RW: false },
];

test('fixed mount policy accepts the canonical Box contract in image and local modes', () => {
    assert.equal(confinement(boxRecord()), true);
    assert.equal(confinement(boxRecord({ extraMounts: localMounts }), localLib), true);
});

test('REJECT mount negatives: writable /opt/ploinky, writable local agentlib, changed data source, extra bind, extra bind in the captured snapshot', () => {
    assert.throws(() => confinement(boxRecord({ mounts: m => m.map(x => x.Destination === '/opt/ploinky' ? { ...x, RW: true } : x) })), /BOX_MOUNT_MODE: \/opt\/ploinky/);
    assert.throws(() => confinement(boxRecord({ extraMounts: localMounts.map((m, i) => i ? m : { ...m, RW: true }) }), localLib), /BOX_MOUNT_MODE: \/opt\/ploinky-agentlib/);
    assert.throws(() => confinement(boxRecord({ mounts: m => m.map(x => x.Destination === BOX_DATA_MOUNTS.images ? { ...x, Source: '/tmp/other' } : x) })), /BOX_MOUNT_SOURCE/);
    const extra = { Type: 'bind', Source: '/Users/danielsava', Destination: '/host-home', RW: true };
    assert.throws(() => confinement(boxRecord({ extraMounts: [extra] })), /BOX_MOUNT_EXTRA/);
    // The captured snapshot is drift evidence only: an extra bind present in it is still rejected.
    const pins = makePins();
    const box = boxRecord({ extraMounts: [extra] });
    const captured = { id: box.Id, name: box.Name, startedAt: box.State.StartedAt, imageId: pins.box.imageId, observedMounts: box.Mounts };
    assert.throws(() => verifyBoxAgainstPins({ box, captured, pins, policy }), /BOX_MOUNT_EXTRA/);
    assert.doesNotThrow(() => verifyBoxAgainstPins({ box: boxRecord(), captured: { ...captured, observedMounts: [] }, pins, policy }));
    // Image mode never admits agentlib binds; local mode requires both.
    assert.throws(() => confinement(boxRecord({ extraMounts: localMounts })), /BOX_MOUNT_EXTRA/);
    assert.throws(() => confinement(boxRecord({ extraMounts: localMounts.slice(1) }), localLib), /BOX_MOUNT_MISSING_OR_DUPLICATE/);
    assert.throws(() => confinement(boxRecord({ mounts: m => m.map(x => x.Destination === '/tmp' ? { ...x, Type: 'bind', Source: '/private/tmp' } : x) })), /BOX_TMPFS_MOUNT/);
    const digest = boxRecord(); digest.ImageDigest = `sha256:${'0'.repeat(64)}`;
    assert.throws(() => verifyBoxAgainstPins({ box: digest, captured: { ...captured, observedMounts: [] }, pins, policy }), /BOX_IMAGE_DIGEST/);
    const noDigest = boxRecord(); delete noDigest.ImageDigest;
    assert.throws(() => verifyBoxAgainstPins({ box: noDigest, captured: { ...captured, observedMounts: [] }, pins, policy }), /BOX_IMAGE_DIGEST/);
    const privileged = boxRecord(); privileged.HostConfig.Privileged = true;
    assert.throws(() => confinement(privileged), /BOX_PRIVILEGED/);
});

test('gap file load rules reject wildcards, missing fields, changed boundaries, enabled agents, wrong discovery stage and unreviewed statuses', () => {
    assert.deepEqual(validateExpectedGaps(expectedGaps, inputs), []);
    const mutateFirst = (predicate, mutate) => { const file = clone(expectedGaps); mutate(file.gaps.find(predicate)); return validateExpectedGaps(file, inputs); };
    const has = (errors, code) => assert.ok(errors.some(e => e.startsWith(code)), `${code}: ${errors.join(' | ')}`);
    has(mutateFirst(g => g.id === 'agent.inference', g => { g.id = 'agent.*'; }), 'GAP_FORBIDDEN_ID');
    has(mutateFirst(g => g.id === 'agent.inference', g => { delete g.outsideChangedBehavior; }), 'GAP_FIELD_MISSING');
    has(mutateFirst(g => g.id === 'agent.aliases', g => { g.affectedObligations.push('router/webchat-stream.get'); }), 'GAP_COVERS_CHANGED_BOUNDARY');
    has(mutateFirst(g => g.id === 'agent.aliases', g => { g.affectedObligations.push('router/marketplace-enable_agent.post'); }), 'GAP_COVERS_CHANGED_BOUNDARY');
    has(mutateFirst(g => g.id === 'agent.aliases', g => { g.affectedObligations.push('router/agent-static.get'); }), 'GAP_COVERS_CHANGED_BOUNDARY');
    has(mutateFirst(g => g.id === 'agent.webmeetStt.disabled', g => { g.id = 'agent.dpuAgent.disabled'; g.evidence = { kind: 'agent-disabled', repo: 'AchillesIDE', agent: 'dpuAgent' }; g.affectedObligations = ['agent-inventory/AchillesIDE/dpuAgent']; }), 'GAP_DISABLED_AGENT_REQUIRED');
    has(mutateFirst(g => g.id === 'agent.dpuAgent.discovery.prompts.list', g => { g.evidence.stage = 'initialize'; }), 'GAP_DISCOVERY_RULE');
    has(mutateFirst(g => g.id === 'agent.dpuAgent.discovery.prompts.list', g => { g.evidence.kind = 'positive-unavailable'; }), 'GAP_KIND_NOT_ACCEPTABLE');
    has(mutateFirst(g => g.id === 'router:users-list.path-duplicate-slash:userA', g => { g.evidence.httpStatuses = [404, 400]; }), 'GAP_BOUNDARY_STATUS');
    has(mutateFirst(g => g.id === 'agent.inference', g => { g.source = 'no citation'; }), 'GAP_SOURCE_UNCITED');
    for (const id of ['agent.tool.dpu_whoami', 'agent.username-admin.reserved', 'agent.dpuAgent.discovery.tools.list.pagination', 'router:terminal-backend', 'resource.dpu.idor']) {
        has(mutateFirst(g => g.id === 'agent.inference', g => { g.id = id; }), 'GAP_FORBIDDEN_ID');
    }
});

test('mandatory checks and expected gaps partition the discovery space and never overlap', () => {
    const run = acceptedRun();
    run.mandatory = clone(mandatory);
    run.mandatory.checks.push({ id: 'agent.inference', kind: 'live', count: 1 });
    expectReject(run, 'MANDATORY_GAP_OVERLAP', 'overlap');
    const partition = acceptedRun();
    partition.expectedGaps = clone(expectedGaps);
    partition.expectedGaps.gaps = partition.expectedGaps.gaps.filter(g => g.id !== 'agent.tasksAgent.discovery.prompts.list');
    expectReject(partition, 'DISCOVERY_PARTITION', 'neither mandatory nor excluded');
});

test('committed mandatory-checks.json equals the enumerator and every inline template is a literal ctx.check in its module', () => {
    assert.deepEqual(enumerateMandatoryChecks({ expectedRuntimes, expectedGaps }), mandatory);
    for (const [module, template] of INLINE_TEMPLATES) {
        const text = fs.readFileSync(path.join(here, module), 'utf8');
        const literal = template.includes('${') ? `\`${template}\`` : `'${template}'`;
        assert.ok(text.includes(`ctx.check(${literal}`), `${module} has no ctx.check(${literal})`);
    }
    assert.ok(!mandatory.checks.some(c => /^router:openai-agent-discovery\./.test(c.id)), 'negative-only router probes are not mandatory');
    const rawPath = mandatory.checks.filter(c => /^router:users-list\.path-/.test(c.id)).map(c => c.id.split(':').slice(1).join(':')).sort();
    assert.deepEqual(rawPath, Object.entries(D2_DENIAL_MATRIX).flatMap(([family, actors]) => actors.map(a => `users-list.path-${family}:${a}`)).sort(), 'raw-path denials follow the D2 matrix exactly');
    assert.equal(rawPath.length, 24);
    assert.ok(mandatory.checks.some(c => c.id === 'router:users-list.allow:admin') && mandatory.checks.some(c => c.id === 'router:users-list.deny:userA'));
});

test('expected-runtime graph requires the explicit reviewed profile and rejects aliases, ambiguity and empty sets', () => {
    const manifests = {
        'R/root': { ploinky: 'sso enable', enable: ['child global', { agent: 'R/sso', profile: 'x' }], profiles: { default: { enable: ['S/other no-wait'] } } },
        'R/child': {}, 'R/sso': { ssoProvider: true }, 'S/other': {}, 'S/idle': {},
    };
    const source = { listAgents: repo => Object.keys(manifests).filter(k => k.startsWith(`${repo}/`)).map(k => k.split('/')[1]), readManifest: (repo, agent) => manifests[`${repo}/${agent}`] || null };
    const base = { rootAgent: 'R/root', inventoryRepositories: [{ name: 'R' }, { name: 'S' }] };
    const derived = deriveExpectedRuntimes({ policy: { ...base, profile: 'default' }, source });
    assert.deepEqual(derived.enabled.map(a => `${a.repo}/${a.agent}`), ['R/child', 'R/root', 'R/sso', 'S/other']);
    assert.deepEqual(derived.disabled.map(a => `${a.repo}/${a.agent}`), ['S/idle']);
    for (const profile of ['', '  ', undefined]) assert.throws(() => deriveExpectedRuntimes({ policy: { ...base, profile }, source }), e => e instanceof GraphError && e.code === 'GRAPH_PROFILE_EMPTY');
    // An SSO provider is admitted only under an SSO parent.
    const noSso = clone(manifests); delete noSso['R/root'].ploinky;
    assert.ok(!deriveExpectedRuntimes({ policy: { ...base, profile: 'default' }, source: { ...source, readManifest: (r, a) => noSso[`${r}/${a}`] || null } }).enabled.some(a => a.agent === 'sso'));
    const alias = clone(manifests); alias['R/root'].enable = ['child as twin'];
    assert.throws(() => deriveExpectedRuntimes({ policy: { ...base, profile: 'default' }, source: { ...source, readManifest: (r, a) => alias[`${r}/${a}`] || null } }), /GRAPH_ALIAS_UNSUPPORTED/);
    const ambiguous = { ...manifests, 'S/child': {} }; ambiguous['R/root'] = { enable: ['T/x'] };
    assert.throws(() => deriveExpectedRuntimes({ policy: { ...base, profile: 'default' }, source: { listAgents: repo => Object.keys(ambiguous).filter(k => k.startsWith(`${repo}/`)).map(k => k.split('/')[1]), readManifest: (r, a) => ambiguous[`${r}/${a}`] || null } }), /GRAPH_REPOSITORY_OUTSIDE_POLICY/);
    assert.equal(expectedRuntimes.profile, policy.profile);
});

test('pins: hash first, frozen mode, schema; candidate SHA and policy digest are verified before observation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authz-pins-'));
    try {
        const file = path.join(dir, 'pins.json');
        fs.writeFileSync(file, JSON.stringify(makePins()));
        fs.chmodSync(file, 0o444);
        const hash = sha(fs.readFileSync(file));
        assert.equal(loadPins(file, hash).sha256, hash);
        assert.throws(() => loadPins(file, '0'.repeat(64)), e => e instanceof PinError && e.code === 'PINS_HASH_MISMATCH');
        fs.chmodSync(file, 0o644);
        assert.throws(() => loadPins(file, hash), e => e.code === 'PINS_NOT_FROZEN');
        const bad = makePins(); bad.ploinky.commit = 'short';
        fs.writeFileSync(file, JSON.stringify(bad)); fs.chmodSync(file, 0o444);
        assert.throws(() => loadPins(file, sha(fs.readFileSync(file))), e => e.code === 'PINS_SCHEMA');
        // verifyCandidate with a scripted git: wrong SHA, unpushed, dirty, digest mismatch.
        const pins = { ...makePins(), ploinkyCheckout: fs.realpathSync(dir), repositories: [] };
        const git = overrides => (root, args) => {
            const cmd = args.join(' ');
            if (overrides[cmd] instanceof Error) throw overrides[cmd];
            if (cmd in overrides) return overrides[cmd];
            return { 'rev-parse HEAD': SHA1, 'branch --show-current': pins.ploinky.branch, 'rev-parse --abbrev-ref @{upstream}': pins.ploinky.upstream, 'merge-base --is-ancestor HEAD @{upstream}': '', 'status --porcelain': '' }[cmd];
        };
        const digest = () => pins.policyDigest;
        assert.equal(verifyCandidate(pins, dir, { run: git({}), digest }), pins.policyDigest);
        assert.throws(() => verifyCandidate(pins, dir, { run: git({ 'rev-parse HEAD': '1'.repeat(40) }), digest }), e => e.code === 'SOURCE_PIN_MISMATCH');
        assert.throws(() => verifyCandidate(pins, dir, { run: git({ 'merge-base --is-ancestor HEAD @{upstream}': new Error('no') }), digest }), e => e.code === 'SOURCE_NOT_PUSHED');
        assert.throws(() => verifyCandidate(pins, dir, { run: git({ 'status --porcelain': ' M x' }), digest }), e => e.code === 'SOURCE_DIRTY');
        assert.throws(() => verifyCandidate(pins, dir, { run: git({}), digest: () => '0'.repeat(64) }), e => e.code === 'POLICY_DIGEST_MISMATCH');
        assert.throws(() => verifyCandidate({ ...pins, ploinkyCheckout: '/elsewhere' }, dir, { run: git({}), digest }), e => e.code === 'SOURCE_ROOT_MISMATCH');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('capture refuses before any Box inspection when the pins hash differs', async () => {
    let inspected = false;
    await assert.rejects(capture({ pinsFile: '/nonexistent/pins.json', pinsSha256: '0'.repeat(64), out: '/tmp/x', inspectBox: async () => { inspected = true; }, readAgents: async () => ({}), policy, verifyBox: () => true }));
    assert.equal(inspected, false);
});

test('policy digest covers all four acceptance files and changes with any byte', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authz-digest-'));
    try {
        for (const name of ['policy.json', 'expected-runtimes.json', 'expected-gaps.json', 'mandatory-checks.json']) fs.copyFileSync(path.join(here, 'acceptance', name), path.join(dir, name));
        assert.equal(policyDigest(dir), inputs.acceptanceDigest);
        for (const name of ['policy.json', 'expected-runtimes.json', 'expected-gaps.json', 'mandatory-checks.json']) {
            const original = fs.readFileSync(path.join(dir, name));
            fs.appendFileSync(path.join(dir, name), ' ');
            assert.notEqual(policyDigest(dir), inputs.acceptanceDigest, name);
            fs.writeFileSync(path.join(dir, name), original);
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('typed gap evidence keeps only enumerated scalars; error text and private markers are dropped', async () => {
    const marker = 'never-repeat-private-payload';
    assert.deepEqual(sanitizeGapEvidence({ kind: 'positive-unavailable', actor: 'admin', reason: marker, httpStatus: 503, endpoint: `/x/${marker} y` }), { kind: 'positive-unavailable', actor: 'admin', httpStatus: 503 });
    assert.deepEqual(sanitizeGapEvidence({ kind: marker }), { kind: 'untyped' });
    const gaps = [];
    const ctx = { report: {}, recordGap: (id, reason, evidence) => gaps.push({ id, reason, evidence: sanitizeGapEvidence(evidence) }), check: async () => {} };
    const mcp = { async rpc() { return { response: { status: 200, json: { error: { code: -32601, message: marker } } }, stage: 'initialize', success: false }; }, async initialize() { throw new Error(marker); } };
    await discoverAgentMcp(ctx, mcp, [{ agent: 'probe', enabled: true, tools: [] }, { repo: 'R', agent: 'off', enabled: false, tools: [] }]);
    assert.ok(!JSON.stringify(gaps.map(g => g.evidence)).includes(marker));
    const discovery = gaps.find(g => g.id === 'agent.probe.discovery.tools.list');
    assert.deepEqual(discovery.evidence, { kind: 'rpc-method-unsupported', actor: 'admin', endpoint: '/probe/mcp', requestedMethod: 'tools/list', stage: 'initialize', httpStatus: 200, rpcCode: -32601, initialized: false });
    assert.deepEqual(gaps.find(g => g.id === 'agent.off.disabled').evidence, { kind: 'agent-disabled', repo: 'R', agent: 'off' });
});

test('A7 wrapper captures the raw exit code programmatically', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authz-exit-'));
    try {
        const stub = path.join(dir, 'stub.mjs');
        fs.writeFileSync(stub, 'process.exitCode = 2;\n');
        const raw = await captureExitCode(stub, [], { env: { PATH: process.env.PATH } });
        assert.equal(raw.exitCode, 2);
        fs.writeFileSync(stub, 'process.exit(1);\n');
        assert.equal((await captureExitCode(stub)).exitCode, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fakeCtx(handler) {
    const report = { checks: [], gaps: [], requests: [] };
    return {
        report, principals: { admin: { id: 'a' }, userA: { id: 'ua' }, userB: { id: 'ub' } }, secrets: new Set(), prefix: 'authz-test',
        clients: {}, sequence: [], cleanups: [], cleanup(fn) { this.cleanups.push(fn); },
        async guard() { this.sequence.push('guard'); return {}; },
        recordGap: (id, reason, evidence) => report.gaps.push({ id, evidence: sanitizeGapEvidence(evidence) }),
        async request(actor, options) { if (String(options.path).startsWith('/webchat/stream')) this.sequence.push('stream'); report.requests.push({ actor, ...options }); return handler(actor, options); },
        async check(id, fn) { try { await fn(); report.checks.push({ id, status: 'PASS' }); } catch (e) { report.checks.push({ id, status: e?.code === 'ERR_ASSERTION' ? 'FAIL' : 'ERROR' }); } },
    };
}
const json = (status, body) => ({ status, json: body, text: JSON.stringify(body), headers: {} });
const listing = { repos: { ok: true, marketplace: { repositories: [{ name: 'AchillesIDE', installed: true, pid: 1 }] } }, agents: { ok: true, marketplace: { agents: [{ ref: 'AchillesIDE/explorer', repo: 'AchillesIDE', name: 'explorer', active: true, pid: 7, status: 'running' }] } } };
function marketplaceHandler({ adminPostStatus = 400 } = {}) {
    return (actor, { method = 'GET', path: p, proof }) => {
        if (method === 'GET' && p.startsWith('/api/marketplace/')) return json(200, listing[p.split('/').pop()]);
        if (method === 'GET') return json(200, { ok: true });
        if (actor === 'admin' && proof === false) return json(403, { ok: false, error: 'csrf_required' });
        if (actor === 'admin') return adminPostStatus === 400 ? json(400, { ok: false, error: 'unknown_action' }) : json(adminPostStatus, { ok: false, error: 'forbidden' });
        return json(actor === 'anonymous' ? 401 : 403, { ok: false, error: 'admin_required' });
    };
}

test('U7 admission probe: positive 400 unknown_action, explicit denials and an unchanged normalized listing', async () => {
    const ctx = fakeCtx(marketplaceHandler());
    await runMarketplaceAdmissionProbes(ctx);
    assert.ok(ctx.report.checks.length >= 11 && ctx.report.checks.every(c => c.status === 'PASS'), JSON.stringify(ctx.report.checks));
    assert.deepEqual(ctx.report.gaps, []);
    const churn = clone(listing); churn.agents.marketplace.agents[0].pid = 99; churn.agents.marketplace.agents[0].status = 'restarting';
    assert.equal(marketplaceProjection(churn.repos, churn.agents), marketplaceProjection(listing.repos, listing.agents), 'lifecycle fields never change the projection');
    const enabled = clone(listing); enabled.agents.marketplace.agents[0].active = false;
    assert.notEqual(marketplaceProjection(enabled.repos, enabled.agents), marketplaceProjection(listing.repos, listing.agents));
});

test('REJECT: a U7 admin request that does not return 400', async () => {
    const ctx = fakeCtx(marketplaceHandler({ adminPostStatus: 403 }));
    await runMarketplaceAdmissionProbes(ctx);
    assert.equal(ctx.report.checks.find(c => c.id === 'u7:marketplace-unknown-action:admin:repos').status, 'FAIL');
    assert.ok(ctx.report.gaps.every(g => g.evidence.kind === 'positive-unavailable'));
    const run = acceptedRun();
    run.report.checks = run.report.checks.filter(c => !c.id.startsWith('u7:'));
    run.report.checks.push(...ctx.report.checks);
    run.report.gaps.push(...ctx.report.gaps.map(g => ({ ...g, reason: 'r' })));
    run.report.counts = { PASS: run.report.checks.filter(c => c.status === 'PASS').length, FAIL: run.report.checks.filter(c => c.status === 'FAIL').length, ERROR: 0 };
    run.report.verdict = 'FAIL';
    run.exitCode = 1;
    expectReject(run, 'MANDATORY_NOT_PASS', 'U7 positive not 400');
    assert.ok(evaluate(run).reasons.some(r => r.startsWith('GAP_UNEXPECTED: u7:')));
});

test('U3 probe: a denied principal that revalidates to 304 fails; exact bytes and 304 are the positive control', async () => {
    const body = '<template>settings</template>';
    const sources = { protected: Buffer.from(body), public: Buffer.from('<template>preview</template>') };
    const handler = (denied304) => (actor, { path: p, headers = {} }) => {
        const isPublic = p.includes('file-exp-preview');
        const text = isPublic ? sources.public.toString() : body;
        if (!isPublic && ['anonymous', 'selfRegistered'].includes(actor)) {
            return denied304 && headers['if-none-match'] ? { status: 304, text: '', headers: {} } : json(401, { error: 'authentication required' });
        }
        if (headers['sec-fetch-dest'] === 'document') return { status: 200, text, headers: { 'cache-control': 'no-store' } };
        if (headers['if-none-match']) return { status: 304, text: '', headers: {} };
        return { status: 200, text, headers: { etag: 'W/"1"', 'cache-control': isPublic ? 'no-store' : 'private, no-cache', 'last-modified': new Date(0).toUTCString() } };
    };
    const readSource = rel => rel.includes('file-exp-preview') ? sources.public : sources.protected;
    const good = fakeCtx(handler(false));
    await runTemplateProbes(good, { readSource });
    assert.ok(good.report.checks.every(c => c.status === 'PASS'), JSON.stringify(good.report.checks));
    const bad = fakeCtx(handler(true));
    await runTemplateProbes(bad, { readSource });
    assert.equal(bad.report.checks.find(c => c.id === 'u3:protected-template-deny:anonymous:etag').status, 'FAIL');
});

test('corrected discovery policy: resources/list and multimedia tools/list are mandatory positives, a -32601 for them rejects', () => {
    const notApplicable = new Map(expectedRuntimes.capabilities.map(c => [c.agent, new Set(c.nonApplicable)]));
    for (const { agent } of expectedRuntimes.enabled) for (const method of ['tools.list', 'resources.list']) {
        if (notApplicable.get(agent)?.has(`mcp-discovery:${method.replace('.', '/')}`)) continue;
        assert.ok(mandatory.checks.some(c => c.id === `agent.${agent}.discovery.${method}.positive`), `${agent} ${method} positive is mandatory`);
        assert.ok(!expectedGaps.gaps.some(g => g.id === `agent.${agent}.discovery.${method}`), `${agent} ${method} is not excluded`);
    }
    let run = acceptedRun();
    run.report.checks = run.report.checks.filter(c => !c.id.startsWith('agent.explorer.discovery.resources.list'));
    run.report.counts.PASS = run.report.checks.length;
    run.report.gaps.push({ id: 'agent.explorer.discovery.resources.list', reason: 'r', evidence: { kind: 'rpc-method-unsupported', actor: 'admin', endpoint: '/explorer/mcp', requestedMethod: 'resources/list', stage: 'resources/list', initialized: true, httpStatus: 200, rpcCode: -32601 } });
    expectReject(run, 'GAP_UNEXPECTED', 'removed resources/list exclusion');
    assert.ok(evaluate(run).reasons.some(r => r.startsWith('MANDATORY_MISSING: agent.explorer.discovery.resources.list.positive')));
    run = acceptedRun();
    run.report.checks.find(c => c.id === 'agent.multimedia.discovery.tools.list.positive').status = 'FAIL';
    run.report.counts = { PASS: run.report.counts.PASS - 1, FAIL: 1, ERROR: 0 }; run.report.verdict = 'FAIL'; run.exitCode = 1;
    expectReject(run, 'MANDATORY_NOT_PASS', 'multimedia tools/list positive must pass');
    // Router-default exclusions cite the Router, not an absent AgentServer handler.
    for (const g of expectedGaps.gaps.filter(g => g.evidence.kind === 'rpc-method-unsupported')) {
        assert.ok(/mcp-proxy\/index\.js:.*:782-783 \(default branch/.test(g.source) && !/AgentServer\.mjs/.test(g.source), g.id);
        assert.ok(['resources/templates/list', 'prompts/list'].includes(g.evidence.requestedMethod), g.id);
    }
});

test('GET /<agent>/mcp is typed unsupported-transport evidence; 200, 404 or a different contract rejects', () => {
    assert.ok(!mandatory.checks.some(c => /\.sse\.(positive|cross-session)/.test(c.id)), 'impossible SSE positives are gone');
    const id = 'agent.dpuAgent.mcp-get-transport';
    for (const [label, evidence] of [
        ['stream 200', { kind: 'positive-unavailable', actor: 'admin', endpoint: '/dpuAgent/mcp', httpStatus: 200 }],
        ['route 404', { kind: 'positive-unavailable', actor: 'admin', endpoint: '/dpuAgent/mcp', httpStatus: 404, errorCode: 'agent_not_found' }],
        ['other allow', { kind: 'unsupported-transport', actor: 'admin', endpoint: '/dpuAgent/mcp', httpStatus: 405, errorCode: 'event_stream_not_supported', allow: 'POST' }],
        ['other error', { kind: 'unsupported-transport', actor: 'admin', endpoint: '/dpuAgent/mcp', httpStatus: 405, errorCode: 'method_not_allowed', allow: 'POST,DELETE' }],
    ]) {
        const run = acceptedRun();
        run.report.gaps.find(g => g.id === id).evidence = sanitizeGapEvidence(evidence);
        expectReject(run, 'GAP_EVIDENCE_MISMATCH', label);
    }
});

test('the comparator recomputes the mandatory list and the runtime graph instead of trusting committed files', () => {
    // A mutation dropping U6 marker checks and the offline interaction test must not ACCEPT.
    const run = acceptedRun();
    run.mandatory = clone(mandatory);
    run.mandatory.checks = run.mandatory.checks.filter(c => !/^u6:webchat-own-marker|webchatInteraction/.test(c.id + (c.file || '')));
    expectReject(run, 'MANDATORY_FILE_DRIFT', 'dropped mandatory entries');
    const noGraph = acceptedRun(); delete noGraph.derivedRuntimes;
    expectReject(noGraph, 'RUNTIME_GRAPH_NOT_VERIFIED', 'graph not re-derived');
    const drift = acceptedRun(); drift.derivedRuntimes.enabled.pop();
    expectReject(drift, 'RUNTIME_GRAPH_DRIFT', 'graph drift');
    const limitation = acceptedRun(); limitation.report.liveLimitations = [];
    expectReject(limitation, 'LIVE_LIMITATION_RECORD', 'interaction limitation not reported');
});

const DPU_REPLY_DATA = JSON.stringify(DPU_UNSUPPORTED_REPLY);
/** Fake Router + pinned DPU with the real protocol shapes: input emits a user-message plus the generic reply; control emits the reply only. */
function webchatWorld({ copiedInputStatus = 204, copiedControlStatus = 204, reply = DPU_REPLY_DATA, forgedArgs = '', emptyProcesses = false, keepProcesses = false, startup = 'delayed-ready', startupMs = 15 } = {}) {
    const runtimes = new Map();
    let next = 100;
    const handles = new Map();
    const ids = { userA: 'principal-A', userB: 'principal-B' };
    const world = { inputsBeforeReady: 0, inputsSent: 0 };
    const startupEvent = state => ({ event: 'startup-state', data: JSON.stringify({ state }) });
    const valueOf = p => new URLSearchParams(String(p).split('?')[1] || '').get('authz-probe');
    const deliver = (actor, value, events) => { const list = (handles.get(`${actor}|${value}`) || []).filter(h => !h.closed); for (const e of events) list.at(-1)?.push(e); };
    const ctx = fakeCtx((actor, { path: p, body }) => {
        const route = p.split('?')[0];
        if (['anonymous', 'selfRegistered'].includes(actor)) return json(actor === 'anonymous' ? 401 : 403, { ok: false, error: 'authentication required' });
        const value = valueOf(p);
        // Like the Router (runtimeRoutes.js:304-306): no input while the runtime is starting.
        if (['/webchat/input', '/webchat/control'].includes(route)) {
            world.inputsSent++;
            const runtime = runtimes.get(`${actor}|${value}`);
            if (runtime?.state !== 'ready') { world.inputsBeforeReady++; return { status: 409, text: 'Agent startup is still in progress.', headers: {} }; }
        }
        if (route === '/webchat/input') {
            if (body.text.includes('B-copied') && copiedInputStatus !== 204) return { status: copiedInputStatus, text: 'Service Unavailable', headers: {} };
            deliver(actor, value, [{ event: 'user-message', data: JSON.stringify({ sourceTabId: 't', message: { role: 'user', text: body.text } }) }, { event: 'message', data: reply }]);
            return { status: 204, text: '', headers: {} };
        }
        if (route === '/webchat/control') {
            if (body.includes('B-copied') && copiedControlStatus !== 204) return { status: copiedControlStatus, text: '', headers: {} };
            deliver(actor, value, [{ event: 'message', data: reply }]);
            return { status: 204, text: '', headers: {} };
        }
        return json(404, { error: 'not_found' });
    });
    Object.assign(ctx.principals, { userA: { id: ids.userA }, userB: { id: ids.userB } });
    ctx.secrets.add('browser-session-cookie-value');
    const openStream = async (_ctx, actor, p) => {
        ctx.sequence.push('stream');
        const value = valueOf(p);
        if (value.endsWith(`slot-3`)) return { status: 429, contentType: 'text/plain', events: () => [], close() {} };
        const key = `${actor}|${value}`;
        const created = !runtimes.has(key);
        if (created) runtimes.set(key, { pid: next++, start: String(5000 + next), actor, value, state: startup === 'ready' ? 'ready' : 'starting' });
        const runtime = runtimes.get(key);
        const events = [startupEvent(runtime.state)];
        let ended = false;
        const handle = { status: 200, contentType: 'text/event-stream', events: () => [...events], push: e => events.push(e), closed: false, ended: () => ended,
            close() { handle.closed = true; } };
        handles.set(key, [...(handles.get(key) || []), handle]);
        if (created && runtime.state === 'starting' && startup !== 'never') setTimeout(() => {
            if (startup === 'delayed-ready') { runtime.state = 'ready'; for (const h of handles.get(key)) h.push(startupEvent('ready')); }
            else if (startup === 'failed') { runtime.state = 'failed'; for (const h of handles.get(key)) h.push(startupEvent('failed')); }
            else if (startup === 'close') for (const h of handles.get(key)) h.push({ event: 'close', data: JSON.stringify({ state: 'failed' }) });
            else if (startup === 'end') ended = true;
        }, startupMs);
        return handle;
    };
    // Like the Router's delayed disconnect cleanup: a runtime whose streams are all
    // closed survives a reconnect and disappears by the time removal is polled.
    const purge = () => { if (keepProcesses) return; for (const [key] of runtimes) if ((handles.get(key) || []).every(h => h.closed)) runtimes.delete(key); };
    // A runtime that is not ready yet has no attributable DPU process.
    const inspectProcesses = async (value, { prefix = false } = {}) => { if (prefix) purge(); return emptyProcesses ? [] : [...runtimes.values()]
        .filter(r => r.state === 'ready')
        .filter(r => prefix ? r.value.startsWith(value) : r.value === value)
        .map(r => ({ pid: r.pid, start: r.start, ssoUserId: ids[r.actor], args: `node /code/src/index.mjs --authz-probe=${r.value} --sso-user=${r.actor} --sso-user-id=${ids[r.actor]} --sso-roles=user${r.value.endsWith('-forged') ? forgedArgs : ''}`, environ: 'NODE_ENV=production' })); };
    return { ctx, openStream, inspectProcesses, world };
}
const fast = { waitMs: 30, settleMs: 1, removalMs: 30, pollMs: 5, readyMs: 2000, readyPollMs: 2 };
const status = (ctx, id) => ctx.report.checks.find(c => c.id === id)?.status;

test('U6 WebChat probe passes on the real DPU acknowledgement shape, guards every stream and records the interaction limitation', async () => {
    const world = webchatWorld();
    await runWebchatProbes(world.ctx, { ...world, timing: fast });
    const u6 = world.ctx.report.checks.filter(c => c.id.startsWith('u6:'));
    assert.deepEqual(u6.filter(c => c.status !== 'PASS'), [], JSON.stringify(u6.filter(c => c.status !== 'PASS')));
    assert.deepEqual(u6.map(c => c.id).sort(), mandatory.checks.filter(c => c.id.startsWith('u6:')).map(c => c.id).sort());
    assert.deepEqual(world.ctx.report.gaps, []);
    assert.deepEqual(world.ctx.report.liveLimitations, [{ ...LIVE_INTERACTION_LIMITATION }]);
    assert.ok(!world.ctx.report.checks.some(c => /interaction/.test(c.id)), 'no live interaction credit');
    const streams = world.ctx.sequence.map((e, i) => [e, world.ctx.sequence[i - 1]]).filter(([e]) => e === 'stream');
    assert.ok(streams.length >= 9 && streams.every(([, previous]) => previous === 'guard'), 'a GET /stream was not guarded');
    for (const fn of world.ctx.cleanups) await fn();
});

test('REJECT (real shapes): copied-ID input 503 and copied-ID control 409 are never isolation evidence', async () => {
    const world = webchatWorld({ copiedInputStatus: 503, copiedControlStatus: 409 });
    await runWebchatProbes(world.ctx, { ...world, timing: fast });
    assert.equal(status(world.ctx, 'u6:webchat-copied-ids-input:userB'), 'FAIL');
    assert.equal(status(world.ctx, 'u6:webchat-copied-ids-control:userB'), 'FAIL');
    assert.equal(status(world.ctx, 'u6:webchat-own-marker:userB'), 'PASS', 'the own positive still works');
    const run = acceptedRun();
    run.report.checks = run.report.checks.filter(c => !c.id.startsWith('u6:')).concat(world.ctx.report.checks.filter(c => c.id.startsWith('u6:')));
    run.report.counts = { PASS: run.report.checks.filter(c => c.status === 'PASS').length, FAIL: run.report.checks.filter(c => c.status === 'FAIL').length, ERROR: run.report.checks.filter(c => c.status === 'ERROR').length };
    run.report.verdict = 'FAIL'; run.exitCode = 1;
    expectReject(run, 'MANDATORY_NOT_PASS', 'copied-ID failures');
});

test('U6 negative controls: an invented marker echo, a forged B identity, empty or unattributed process lists and leftover runtimes fail', async () => {
    const echo = webchatWorld({ reply: JSON.stringify('unknown command authz-A-x\n') });
    await runWebchatProbes(echo.ctx, { ...echo, timing: fast });
    assert.equal(status(echo.ctx, 'u6:webchat-own-marker:userA'), 'FAIL', 'only the real DPU acknowledgement counts');
    const forged = webchatWorld({ forgedArgs: ' --sso-user-id=principal-B' });
    await runWebchatProbes(forged.ctx, { ...forged, timing: fast });
    assert.equal(status(forged.ctx, 'u6:webchat-reserved-keys:userA'), 'FAIL');
    const legit = webchatWorld();
    await runWebchatProbes(legit.ctx, { ...legit, timing: fast });
    assert.equal(status(legit.ctx, 'u6:webchat-reserved-keys:userA'), 'PASS', "A's router-issued --sso-* identity is legitimate");
    const empty = webchatWorld({ emptyProcesses: true });
    await runWebchatProbes(empty.ctx, { ...empty, timing: fast });
    assert.equal(status(empty.ctx, 'u6:webchat-distinct-processes'), 'FAIL');
    assert.equal(status(empty.ctx, 'u6:webchat-credential-confinement'), 'FAIL', 'an empty process list proves nothing');
    const leftover = webchatWorld({ keepProcesses: true });
    await runWebchatProbes(leftover.ctx, { ...leftover, timing: fast });
    assert.equal(status(leftover.ctx, 'u6:webchat-runtimes-removed'), 'FAIL');
    await assert.rejects(leftover.ctx.cleanups[0](), /remained after cleanup/, 'cleanup verifies removal on every path');
    const closed = webchatWorld();
    await runWebchatProbes(closed.ctx, { openStream: async () => ({ status: 409, contentType: 'text/plain', events: () => [], close() {} }), inspectProcesses: closed.inspectProcesses, timing: fast });
    assert.ok(closed.ctx.report.gaps.length > 10 && closed.ctx.report.gaps.every(g => g.evidence.kind === 'positive-unavailable'));
});

test('DPU process inspector selects only the pinned DPU entry inside the DPU container, with start identity and principal', async () => {
    const listing = [
        `101\t555\tsh\x1f-c\x1fnode /code/src/index.mjs --authz-probe=v --sso-user-id=principal-A`,
        `102\t556\tpodman\x1fexec\x1f-i\x1fdpu\x1fnode\x1f/code/src/index.mjs\x1f--authz-probe=v`,
        `103\t557\tnode\x1f/code/src/index.mjs\x1f--authz-probe=v\x1f--sso-user-id=principal-A`,
        `104\t558\tnode\x1f/code/src/index.mjs\x1f--authz-probe=v2\x1f--sso-user-id=principal-B`,
    ].join('\n') + '\n';
    const calls = [];
    const run = args => { calls.push(args); return args.includes('sh') ? listing : 'HOME=/root\0'; };
    const inspect = dpuProcessInspector({ boxId: 'c'.repeat(64), container: 'ploinky_AchillesIDE_dpuAgent_testExplorerFresh_d8f88a10', run });
    const found = await inspect('v');
    assert.deepEqual(found.map(p => [p.pid, p.start, p.ssoUserId]), [[103, '557', 'principal-A']]);
    assert.deepEqual((await inspect('v', { prefix: true })).map(p => p.pid), [103, 104]);
    assert.ok(calls.every(a => a[0] === 'exec' && a[2] === 'podman' && a[3] === 'exec' && a[4] === 'ploinky_AchillesIDE_dpuAgent_testExplorerFresh_d8f88a10'), 'only inside the DPU container');
    const unreadable = dpuProcessInspector({ boxId: 'c'.repeat(64), container: 'ploinky_AchillesIDE_dpuAgent_x', run: args => args.includes('sh') ? listing : '' });
    await assert.rejects(unreadable('v'), /environment must be readable/);
    assert.throws(() => dpuProcessInspector({ boxId: 'c'.repeat(64), container: 'ploinky_AchillesIDE_userPersistoAgent_x', run }), /DPU container/);
});

test('capability partition: LiveKit (D3) and Soul (D4) non-applicability is exact, reported, and leaves every other agent strict', () => {
    const caps = Object.fromEntries(expectedRuntimes.capabilities.map(c => [c.agent, c]));
    assert.deepEqual(Object.keys(caps).sort(), ['liveKitServerAgent', 'soul-gateway']);
    assert.ok(expectedRuntimes.enabled.some(a => a.agent === 'liveKitServerAgent') && expectedRuntimes.enabled.some(a => a.agent === 'soul-gateway'), 'classified agents stay enabled');
    assert.equal(caps.liveKitServerAgent.nonApplicable.length, 5);
    assert.deepEqual(caps['soul-gateway'].nonApplicable, ['mcp-discovery:tools/list', 'mcp-discovery:resources/list']);
    assert.ok(!mandatory.checks.some(c => /^agent\.liveKitServerAgent\.discovery\./.test(c.id)), 'the 20 impossible LiveKit discovery checks are gone');
    assert.ok(!mandatory.checks.some(c => /^agent\.soul-gateway\.discovery\.(tools|resources)\.list\./.test(c.id)), 'Soul upstream tools/resources checks are gone');
    for (const kept of ['agent.soul-gateway.discovery.resources.templates.list', 'agent.soul-gateway.discovery.prompts.list', 'agent.soul-gateway.mcp-get-transport']) assert.ok(expectedGaps.gaps.some(g => g.id === kept), `${kept} stays asserted`);
    for (const id of [...caps.liveKitServerAgent.retainedControls, ...caps['soul-gateway'].retainedControls, 'agent.soul.management.me.admin', 'agent.soul.management.me.userA']) assert.ok(mandatory.checks.some(c => c.id === id), `${id} retained`);
    // Missing report record, or executing a non-applicable surface, rejects.
    let run = acceptedRun(); delete run.report.capabilityNonApplicable;
    expectReject(run, 'CAPABILITY_RECORD', 'record missing');
    run = acceptedRun(); run.report.checks.push({ id: 'agent.liveKitServerAgent.discovery.tools.list.positive', status: 'PASS' }); run.report.counts.PASS += 1;
    expectReject(run, 'CAPABILITY_RECORD', 'non-applicable surface executed');
    // Missing classified runtime rejects; derived capabilities that differ from the policy reject.
    run = acceptedRun(); run.report.runtimes = run.report.runtimes.filter(r => r.agent !== 'liveKitServerAgent');
    expectReject(run, 'RUNTIME_SET_MISSING', 'LiveKit runtime missing');
    run = acceptedRun(); run.derivedRuntimes.capabilities[0].contractSha256 = '0'.repeat(64);
    expectReject(run, 'RUNTIME_GRAPH_DRIFT', 'pinned contract drift');
    // A failed retained real-service control rejects.
    for (const id of ['capability:soul-gateway:health:anonymous', 'capability:liveKitServerAgent:no-primary-port', 'capability:liveKitServerAgent:runtime-image']) {
        run = acceptedRun();
        run.report.checks.find(c => c.id === id).status = 'FAIL';
        run.report.counts = { PASS: run.report.counts.PASS - 1, FAIL: 1, ERROR: 0 }; run.report.verdict = 'FAIL'; run.exitCode = 1;
        expectReject(run, 'MANDATORY_NOT_PASS', id);
    }
});

function contractWorld() {
    const files = {
        'R:agent/manifest.json': JSON.stringify({ start: 'sh /code/s.sh', health: { readiness: { script: 'h.sh' } } }),
        'R:agent/s.sh': 'exec livekit-server\n',
        'ploinky:cli/server/RoutingServer.js': "if (!route.hostPort) {\n",
    };
    const hash = v => createHash('sha256').update(Buffer.from(v)).digest('hex');
    const policyFor = (overrides = {}) => ({ capabilities: [{ id: 'X', repo: 'R', agent: 'agent', nonApplicable: ['mcp-discovery:tools/list'], retainedControls: ['capability:x'],
        contract: { files: [{ repo: 'R', path: 'agent/manifest.json', sha256: hash(files['R:agent/manifest.json']) }, { repo: 'R', path: 'agent/s.sh', sha256: hash(files['R:agent/s.sh']) }],
            manifest: { start: 'sh /code/s.sh', agent: null, readinessScript: 'h.sh' }, absent: [{ repo: 'R', path: 'agent/s.sh', text: 'AgentServer' }],
            present: [{ repo: 'ploinky', path: 'cli/server/RoutingServer.js', text: 'if (!route.hostPort) {' }] }, ...overrides }] });
    const source = (mutate = {}) => {
        const all = { ...files, ...mutate };
        return { readFile: (repo, file) => all[`${repo}:${file}`] === undefined ? null : Buffer.from(all[`${repo}:${file}`]), readManifest: (repo, agent) => JSON.parse(all[`${repo}:${agent}/manifest.json`]) };
    };
    return { policyFor, source, enabled: new Set(['R/agent']) };
}

test('REJECT altered pinned startup/route contract: bytes, manifest facts, anchors, enablement or an unbound claim', () => {
    const w = contractWorld();
    assert.equal(deriveCapabilities({ policy: w.policyFor(), source: w.source(), enabled: w.enabled }).length, 1);
    const drift = (fn, label) => assert.throws(fn, e => e instanceof GraphError && e.code === 'CAPABILITY_CONTRACT_DRIFT', label);
    drift(() => deriveCapabilities({ policy: w.policyFor(), source: w.source({ 'R:agent/s.sh': 'exec livekit-server\nsh /Agent/server/AgentServer.sh\n' }), enabled: w.enabled }), 'start script now launches AgentServer');
    const withAgent = JSON.stringify({ start: 'sh /code/s.sh', agent: 'node x', health: { readiness: { script: 'h.sh' } } });
    const p = w.policyFor(); p.capabilities[0].contract.files[0].sha256 = createHash('sha256').update(withAgent).digest('hex');
    drift(() => deriveCapabilities({ policy: p, source: w.source({ 'R:agent/manifest.json': withAgent }), enabled: w.enabled }), 'manifest gains an agent command');
    drift(() => deriveCapabilities({ policy: w.policyFor(), source: w.source({ 'ploinky:cli/server/RoutingServer.js': 'route changed\n' }), enabled: w.enabled }), 'Router route contract changed');
    drift(() => deriveCapabilities({ policy: w.policyFor(), source: w.source(), enabled: new Set() }), 'classified agent not enabled (missing runtime)');
    drift(() => deriveCapabilities({ policy: w.policyFor({ contract: { files: [] } }), source: w.source(), enabled: w.enabled }), 'claim without a pinned contract');
    drift(() => deriveCapabilities({ policy: w.policyFor({ retainedControls: [] }), source: w.source(), enabled: w.enabled }), 'claim without retained real-service controls');
    drift(() => deriveCapabilities({ policy: w.policyFor({ nonApplicable: ['tools/call'] }), source: w.source(), enabled: w.enabled }), 'unknown surface');
});

test('REJECT: a supported DPU MCP method returning 404 or -32000 is never excluded or non-applicable', async () => {
    for (const [label, response] of [['404', { status: 404, json: { error: 'agent_not_found' } }], ['-32000', { status: 200, json: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Agent dpuAgent is still starting.' } } }]]) {
        const gaps = [];
        const ctx = { report: {}, capabilities: policy.capabilities, recordGap: (id, reason, evidence) => gaps.push({ id, reason: 'r', evidence: sanitizeGapEvidence(evidence) }), check: async () => {} };
        const mcp = { async rpc(actor, agent, method) { return method === 'tools/list' ? { response, stage: 'tools/list', success: false } : { response: { status: 200, json: { result: {} } }, stage: method, success: true, value: { resources: [], resourceTemplates: [], prompts: [] } }; }, async initialize() { return { failure: response }; } };
        await discoverAgentMcp(ctx, mcp, [{ repo: 'AchillesIDE', agent: 'dpuAgent', enabled: true, tools: [] }]);
        const gap = gaps.find(g => g.id === 'agent.dpuAgent.discovery.tools.list');
        assert.equal(gap.evidence.kind, 'positive-unavailable', label);
        const run = acceptedRun();
        run.report.checks = run.report.checks.filter(c => !c.id.startsWith('agent.dpuAgent.discovery.tools.list'));
        run.report.counts.PASS = run.report.checks.length;
        run.report.gaps.push(gap);
        expectReject(run, 'GAP_UNEXPECTED', `DPU tools/list ${label}`);
        assert.ok(evaluate(run).reasons.some(r => r.startsWith('MANDATORY_MISSING: agent.dpuAgent.discovery.tools.list.positive')));
    }
    // A classified agent's still-asserted Router contracts must match exactly: Soul templates 404 rejects.
    const run = acceptedRun();
    run.report.gaps.find(g => g.id === 'agent.soul-gateway.discovery.prompts.list').evidence = sanitizeGapEvidence({ kind: 'positive-unavailable', actor: 'admin', endpoint: '/soul-gateway/mcp', requestedMethod: 'prompts/list', stage: 'initialize', httpStatus: 404 });
    expectReject(run, 'GAP_EVIDENCE_MISMATCH', 'Soul prompts/list 404');
});

test('capability probes: retained controls pass on the real shapes and fail on missing/failed services', async () => {
    const lk = expectedRuntimes.capabilities.find(c => c.agent === 'liveKitServerAgent');
    const caps = policy.capabilities;
    const handler = ({ soulDb = true, signal = 200, mcp404 = true } = {}) => (actor, { path: p, method = 'GET' }) => {
        if (p.endsWith('/healthz/')) return json(200, { ok: true, db: soulDb, snapshotGeneration: 1, uptimeSeconds: 5 });
        if (p.endsWith('/7880/')) return { status: signal, text: 'OK', headers: {} };
        if (p.includes('/twirp/')) return json(401, { ok: false, error: 'not_authenticated' });
        if (p === '/liveKitServerAgent/mcp') return mcp404 ? json(404, { error: 'agent_not_found', agent: 'liveKitServerAgent' }) : json(200, { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'still starting' } });
        return json(404, {});
    };
    const deps = (overrides = {}) => ({ capabilities: caps,
        readRouting: async () => ({ routes: { liveKitServerAgent: { agent: 'liveKitServerAgent', hostPort: overrides.hostPort ?? null } } }),
        readManifest: async () => ({ container: 'docker.io/assistos/livekit-server-agent@sha256:x' }),
        inspectContainer: async () => ({ State: { Running: overrides.running ?? true }, Config: { Image: overrides.image ?? 'docker.io/assistos/livekit-server-agent@sha256:x' } }) });
    const good = fakeCtx(handler()); good.report.deployment = { classifiedContainers: { 'AchillesIDE/liveKitServerAgent': 'ploinky_AchillesIDE_liveKitServerAgent_testExplorerFresh_d8f88a10' } };
    await runCapabilityProbes(good, deps());
    assert.deepEqual(good.report.checks.map(c => c.id).sort(), [...lk.retainedControls, 'capability:soul-gateway:health:anonymous'].sort());
    assert.ok(good.report.checks.every(c => c.status === 'PASS'), JSON.stringify(good.report.checks));
    assert.deepEqual(good.report.capabilityNonApplicable, nonApplicableRecord(caps));
    const cases = [
        [handler({ soulDb: false }), {}, 'capability:soul-gateway:health:anonymous'],
        [handler(), { hostPort: 43000 }, 'capability:liveKitServerAgent:no-primary-port'],
        [handler(), { running: false }, 'capability:liveKitServerAgent:runtime-image'],
        [handler(), { image: 'docker.io/other@sha256:y' }, 'capability:liveKitServerAgent:runtime-image'],
        [handler({ mcp404: false }), {}, 'capability:liveKitServerAgent:mcp-absent-corroboration:admin'],
    ];
    for (const [h, o, id] of cases) {
        const ctx = fakeCtx(h); ctx.report.deployment = good.report.deployment;
        await runCapabilityProbes(ctx, deps(o));
        assert.equal(ctx.report.checks.find(c => c.id === id).status, 'FAIL', id);
    }
    const down = fakeCtx(handler({ signal: 503 })); down.report.deployment = good.report.deployment;
    await runCapabilityProbes(down, deps());
    assert.equal(down.report.checks.find(c => c.id === 'capability:liveKitServerAgent:signaling-route:anonymous').status, 'FAIL');
    assert.equal(down.report.gaps.find(g => g.id === 'capability:liveKitServerAgent:twirp-route-deny:anonymous').evidence.kind, 'positive-unavailable');
});

test('DPU acknowledgement accumulates split SSE frames per stream without crediting partial replies', () => {
    const stream = events => ({ events: () => events });
    const frame = text => ({ event: 'message', data: JSON.stringify(text) });
    const half = DPU_UNSUPPORTED_REPLY.length >> 1;
    assert.equal(ackCount(stream([frame(DPU_UNSUPPORTED_REPLY.slice(0, half)), frame(DPU_UNSUPPORTED_REPLY.slice(half))])), 1);
    assert.equal(ackCount(stream([frame(DPU_UNSUPPORTED_REPLY.slice(0, half))])), 0, 'a partial reply is not an acknowledgement');
    assert.equal(ackCount(stream([frame(DPU_UNSUPPORTED_REPLY), { event: 'user-message', data: JSON.stringify({ message: { text: DPU_UNSUPPORTED_REPLY } }) }, frame(DPU_UNSUPPORTED_REPLY)])), 2);
});

test('Router workspace-write matrix: all 68 checks are mandatory, counted once and gated on the positive the runtime uses', () => {
    const { positives, denials } = workspaceWriteMatrix();
    const rows = [...positives, ...denials];
    assert.equal(rows.length, 68);
    assert.deepEqual(workspaceWriteCheckDefinitions().map(d => d.id), rows.map(r => r.id));
    for (const row of rows) {
        const entries = mandatory.checks.filter(c => c.id === row.id);
        assert.equal(entries.length, 1, row.id);
        assert.equal(entries[0].kind, 'live');
        assert.equal(entries[0].count, 1, `${row.id} is recorded once per run`);
        if (!row.positiveControl) { assert.equal(entries[0].positiveControlAnyOf, null, row.id); continue; }
        assert.deepEqual(entries[0].positiveControlAnyOf, [row.positiveControl], row.id);
        const positive = positives.find(p => p.id === row.positiveControl);
        assert.ok(positive, `${row.id} names a real positive`);
        assert.equal(positive.operation, row.operation, `${row.id}: the positive proves the same sink`);
        assert.ok(['admin', 'userA'].includes(positive.actor), 'the positive is an entitled actor');
    }
    assert.equal(denials.filter(r => r.operation === 'sink-upload').every(r => r.positiveControl === 'router:workspace-upload-owner-positive:admin'), true);
    assert.deepEqual({ live: mandatory.counts.live, offline: mandatory.counts.offline }, { live: 569, offline: 10 });
});

test('Router workspace-write matrix: no row can be satisfied as an expected gap, and an unavailable denial rejects twice', () => {
    const { positives, denials } = workspaceWriteMatrix();
    const rows = [...positives, ...denials];
    for (const row of rows) {
        const file = clone(expectedGaps);
        file.gaps.find(g => g.id === 'agent.inference').id = row.id;
        assert.ok(validateExpectedGaps(file, inputs).some(e => e.startsWith('GAP_FORBIDDEN_ID')), `${row.id} must be a forbidden gap identity`);
    }
    // The same identities stay forbidden for the legacy selector and fixture controls.
    for (const id of ['router:workspace-file-selector-deny:anonymous:?agent=userPersistoAgent', 'router:workspace-file-fixture-positive:admin', 'router:workspace-upload-selector-deny:anonymous:0']) {
        const file = clone(expectedGaps);
        file.gaps.find(g => g.id === 'agent.inference').id = id;
        assert.ok(validateExpectedGaps(file, inputs).some(e => e.startsWith('GAP_FORBIDDEN_ID')), id);
    }
    // A denial recorded as a positive-unavailable gap instead of a check is missing and unexpected.
    const id = denials[0].id;
    const run = acceptedRun();
    run.report.checks = run.report.checks.filter(c => c.id !== id);
    run.report.counts.PASS = run.report.checks.length;
    run.report.gaps.push({ id, reason: 'positive-unavailable', evidence: { kind: 'positive-unavailable' } });
    const result = evaluate(run);
    assert.equal(result.decision, 'REJECT');
    assert.ok(result.reasons.includes(`MANDATORY_MISSING: ${id}`));
    assert.ok(result.reasons.includes(`GAP_UNEXPECTED: ${id}`));
});

test('Router workspace-write matrix: a failed or missing positive rejects the run and each dependent denial', () => {
    const { denials } = workspaceWriteMatrix();
    for (const positiveId of ['router:workspace-upload-owner-positive:admin', 'router:webchat-upload-positive:admin', 'router:webchat-directory-create-positive:admin', 'router:webchat-directory-list-positive:userA', 'router:webchat-suggestions-positive:userA']) {
        const run = acceptedRun();
        run.report.checks = run.report.checks.filter(c => c.id !== positiveId);
        run.report.counts.PASS = run.report.checks.length;
        const result = evaluate(run);
        assert.equal(result.decision, 'REJECT', positiveId);
        assert.ok(result.reasons.includes(`MANDATORY_MISSING: ${positiveId}`), positiveId);
        for (const denial of denials.filter(d => d.positiveControl === positiveId)) {
            assert.ok(result.reasons.includes(`MANDATORY_POSITIVE_CONTROL_FAILED: ${denial.id}`), `${denial.id} depends on ${positiveId}`);
        }
        const failed = acceptedRun();
        failed.report.checks.find(c => c.id === positiveId).status = 'FAIL';
        failed.report.counts = { PASS: failed.report.counts.PASS - 1, FAIL: 1, ERROR: 0 };
        failed.report.verdict = 'FAIL'; failed.exitCode = 1;
        expectReject(failed, 'MANDATORY_NOT_PASS', positiveId);
    }
    // One denial that FAILs rejects even when every positive control passed.
    const run = acceptedRun();
    run.report.checks.find(c => c.id === denials[7].id).status = 'FAIL';
    run.report.counts = { PASS: run.report.counts.PASS - 1, FAIL: 1, ERROR: 0 };
    run.report.verdict = 'FAIL'; run.exitCode = 1;
    expectReject(run, 'MANDATORY_NOT_PASS', 'denied write that FAILed');
    const duplicated = acceptedRun();
    duplicated.report.checks.push({ id: denials[8].id, status: 'PASS' });
    duplicated.report.counts.PASS += 1;
    expectReject(duplicated, 'MANDATORY_DUPLICATE', 'denial recorded twice');
});

// U6 readiness: input and the process census wait for the Router's startup-state.
const u6Statuses = ctx => ctx.report.checks.filter(c => c.id.startsWith('u6:'));
const startupObservations = ctx => (ctx.report.webchatObservations || []).filter(o => o.step === 'startup');

test('U6 waits for startup-state ready before any input or process census, and a 409 is never retried around', async () => {
    const world = webchatWorld({ startup: 'delayed-ready', startupMs: 60 });
    // The model refuses input while starting, exactly like the Router.
    const early = await world.openStream(world.ctx, 'userA', '/webchat/stream?agent=dpuAgent&authz-probe=early');
    assert.deepEqual(early.events().map(e => e.event), ['startup-state']);
    assert.equal((await world.ctx.request('userA', { method: 'POST', path: '/webchat/input?authz-probe=early', body: { text: 'x' } })).status, 409);
    world.world.inputsBeforeReady = 0; world.world.inputsSent = 0;
    await runWebchatProbes(world.ctx, { ...world, timing: fast });
    assert.deepEqual(u6Statuses(world.ctx).filter(c => c.status !== 'PASS'), []);
    assert.equal(world.world.inputsBeforeReady, 0, 'no input was sent before the runtime reported ready');
    assert.ok(world.world.inputsSent >= 8, 'inputs were actually sent after readiness');
    const own = startupObservations(world.ctx);
    assert.ok(own.length >= 4 && own.every(o => o.ready === true), 'every waited stream observed ready');
    for (const fn of world.ctx.cleanups) await fn();
});

for (const [startup, reason] of [['failed', 'failed'], ['close', 'closed'], ['end', 'stream-ended'], ['never', 'timeout']]) {
    test(`U6 fails closed when the runtime ${startup === 'never' ? 'never reports ready' : `reports ${startup}`}: no input, no census, no credit`, async () => {
        const world = webchatWorld({ startup, startupMs: 5 });
        await runWebchatProbes(world.ctx, { ...world, timing: { ...fast, readyMs: startup === 'never' ? 80 : 2000 } });
        assert.equal(status(world.ctx, 'u6:webchat-own-stream:userA'), 'FAIL');
        assert.ok(startupObservations(world.ctx).some(o => o.ready === false && o.reason === reason), `observed ${reason}`);
        assert.equal(world.world.inputsSent, 0, 'nothing was sent to a runtime that never became ready');
        assert.deepEqual(u6Statuses(world.ctx).filter(c => c.status === 'PASS'), [], 'no U6 credit at all');
        assert.ok(world.ctx.report.gaps.length > 10 && world.ctx.report.gaps.every(g => g.evidence.kind === 'positive-unavailable'));
        const run = acceptedRun();
        run.report.checks = run.report.checks.filter(c => !c.id.startsWith('u6:')).concat(u6Statuses(world.ctx));
        run.report.counts = { PASS: run.report.checks.filter(c => c.status === 'PASS').length, FAIL: run.report.checks.filter(c => c.status === 'FAIL').length, ERROR: 0 };
        run.report.verdict = 'FAIL'; run.exitCode = 1;
        expectReject(run, 'MANDATORY_NOT_PASS', 'unready runtime');
        for (const fn of world.ctx.cleanups) await fn().catch(() => {});
    });
}

test('waitForStartupReady: latest state wins, failure and close are final, unknown states are ignored, the deadline is bounded', async () => {
    const handle = (events, ended = false) => ({ events: () => events, ended: () => ended });
    const ev = (event, state) => ({ event, data: JSON.stringify({ state }) });
    assert.deepEqual(await waitForStartupReady(handle([ev('startup-state', 'starting'), ev('startup-state', 'ready')]), { ms: 50, pollMs: 2 }), { ok: true });
    assert.deepEqual(await waitForStartupReady(handle([ev('startup-state', 'starting')]), { ms: 30, pollMs: 2 }), { ok: false, reason: 'timeout' });
    assert.deepEqual(await waitForStartupReady(handle([ev('startup-state', 'starting')], true), { ms: 50, pollMs: 2 }), { ok: false, reason: 'stream-ended' });
    assert.deepEqual(await waitForStartupReady(handle([ev('startup-state', 'ready'), ev('startup-state', 'failed')]), { ms: 50, pollMs: 2 }), { ok: false, reason: 'failed' });
    assert.deepEqual(await waitForStartupReady(handle([ev('startup-state', 'ready'), ev('close', 'closed')]), { ms: 50, pollMs: 2 }), { ok: false, reason: 'closed' });
    assert.equal((await waitForStartupReady(handle([ev('startup-state', 'warming'), { event: 'message', data: '"ready"' }, { event: 'startup-state', data: 'not json' }]), { ms: 20, pollMs: 2 })).ok, false, 'only a parsed {"state":"ready"} startup-state counts');
    // A ready event that arrives later is observed while polling.
    const live = []; const pending = waitForStartupReady(handle(live), { ms: 500, pollMs: 2 });
    setTimeout(() => live.push(ev('startup-state', 'ready')), 20);
    assert.deepEqual(await pending, { ok: true });
});

test('SSE stream handle parses frames split across chunks, ignores comments, and reports transport end', async () => {
    const res = new EventEmitter();
    Object.assign(res, { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, setEncoding() {}, destroy() { res.emit('close'); } });
    const handle = createStreamHandle(res, null);
    assert.equal(handle.status, 200);
    res.emit('data', ': connected\n\nevent: startup-st');
    res.emit('data', 'ate\ndata: {"state":"starting"}\n\nevent: startup-state\ndata: {"state":"re');
    assert.deepEqual(handle.events().map(e => [e.event, e.data]), [['startup-state', '{"state":"starting"}']]);
    assert.equal(handle.ended(), false);
    assert.deepEqual(await Promise.race([waitForStartupReady(handle, { ms: 20, pollMs: 2 }), new Promise(r => setTimeout(() => r('slow'), 200))]), { ok: false, reason: 'timeout' });
    res.emit('data', 'ady"}\n\n');
    assert.deepEqual(await waitForStartupReady(handle, { ms: 50, pollMs: 2 }), { ok: true });
    res.emit('data', 'event: close\ndata: {"state":"closed"}\n\n');
    assert.deepEqual(await waitForStartupReady(handle, { ms: 50, pollMs: 2 }), { ok: false, reason: 'closed' });
    res.emit('end');
    assert.equal(handle.ended(), true);
    const dead = new EventEmitter();
    Object.assign(dead, { statusCode: 200, headers: {}, setEncoding() {}, destroy() {} });
    const deadHandle = createStreamHandle(dead, null);
    dead.emit('end');
    assert.deepEqual(await waitForStartupReady(deadHandle, { ms: 50, pollMs: 2 }), { ok: false, reason: 'stream-ended' });
});

test('DPU inspector accepts a /proc entry vanishing only for an owned pid during owned removal polling', async () => {
    const box = 'c'.repeat(64);
    const container = 'ploinky_AchillesIDE_dpuAgent_testExplorerFresh_d8f88a10';
    const row = (pid, start, value) => `${pid}\t${start}\tnode\x1f/code/src/index.mjs\x1f--authz-probe=${value}\x1f--sso-user-id=principal-A`;
    const missing = pid => Object.assign(new Error(`Command failed: podman exec cat /proc/${pid}/environ\ncat: /proc/${pid}/environ: No such file or directory\n`), { stderr: `cat: /proc/${pid}/environ: No such file or directory\n` });
    const make = ({ lists, environ }) => {
        let call = 0;
        return dpuProcessInspector({ boxId: box, container, run: args => {
            if (args.includes('sh')) return lists[Math.min(call++, lists.length - 1)];
            return environ(args.at(-1));
        } });
    };
    const owned = `${row(573, '9001', 'authz-run-1')}\n`;
    // Owned cleanup, prefix lookup, the pid is gone in a fresh listing: accepted and reported.
    const ok = await make({ lists: [owned, ''], environ: () => { throw missing(573); } })('authz-run', { prefix: true, tolerateOwnedExit: true });
    assert.equal(ok.length, 0);
    assert.deepEqual(ok.vanished, ['573@9001']);
    // No tolerance flag (a census) -> failure.
    await assert.rejects(make({ lists: [owned, ''], environ: () => { throw missing(573); } })('authz-run-1'), /No such file or directory/);
    await assert.rejects(make({ lists: [owned, ''], environ: () => { throw missing(573); } })('authz-run', { prefix: true }), /No such file or directory/);
    // Tolerance is for prefix removal polling only, never an exact lookup.
    await assert.rejects(make({ lists: [owned, ''], environ: () => { throw missing(573); } })('authz-run-1', { tolerateOwnedExit: true }), /No such file or directory/);
    // The process is still listed after the failed read -> failure, never "gone".
    await assert.rejects(make({ lists: [owned, owned], environ: () => { throw missing(573); } })('authz-run', { prefix: true, tolerateOwnedExit: true }), /still present/);
    // Any other failure (permission, empty environment, a different pid) is never tolerated.
    await assert.rejects(make({ lists: [owned, ''], environ: () => { throw Object.assign(new Error('Command failed: cat /proc/573/environ\ncat: /proc/573/environ: Permission denied'), { stderr: 'cat: /proc/573/environ: Permission denied' }); } })('authz-run', { prefix: true, tolerateOwnedExit: true }), /Permission denied/);
    await assert.rejects(make({ lists: [owned, ''], environ: () => { throw missing(999); } })('authz-run', { prefix: true, tolerateOwnedExit: true }), /No such file or directory/);
    await assert.rejects(make({ lists: [owned, ''], environ: () => '' })('authz-run', { prefix: true, tolerateOwnedExit: true }), /environment must be readable/);
    // A reused pid (same number, other start time) still counts the original as gone.
    const reused = await make({ lists: [owned, `${row(573, '9777', 'authz-other')}\n`], environ: () => { throw missing(573); } })('authz-run', { prefix: true, tolerateOwnedExit: true });
    assert.deepEqual(reused.vanished, ['573@9001']);
    // Other principals' or foreign processes are never matched, so never tolerated.
    const foreign = await make({ lists: [`${row(700, '1', 'someone-else')}\n`], environ: () => { throw missing(700); } })('authz-run', { prefix: true, tolerateOwnedExit: true });
    assert.equal(foreign.length, 0);
    assert.deepEqual(foreign.vanished, []);
});

test('U6 removal polling tolerates an owned process exiting under inspection but the census does not', async () => {
    const world = webchatWorld();
    let exiting = true;
    const inspect = world.inspectProcesses;
    const guarded = async (value, options = {}) => {
        if (options.prefix && exiting) {
            exiting = false;
            await inspect(value, options);
            return Object.assign([], { vanished: ['573@9001'] });
        }
        return inspect(value, options);
    };
    await runWebchatProbes(world.ctx, { ...world, inspectProcesses: guarded, timing: fast });
    assert.equal(status(world.ctx, 'u6:webchat-runtimes-removed'), 'PASS');
    assert.ok((world.ctx.report.webchatObservations || []).some(o => o.step === 'removal' && /^\d+@\d+$/.test(o.exitedDuringInspection)));
    for (const fn of world.ctx.cleanups) await fn();
    // A census (exact lookup) that throws is a FAIL, not a tolerated exit.
    const strict = webchatWorld();
    const failing = async (value, options = {}) => { if (!options.prefix) throw new Error('cat: /proc/573/environ: No such file or directory'); return strict.inspectProcesses(value, options); };
    await runWebchatProbes(strict.ctx, { ...strict, inspectProcesses: failing, timing: fast });
    assert.notEqual(status(strict.ctx, 'u6:webchat-distinct-processes'), 'PASS');
});
