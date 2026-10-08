// A2: the scoped acceptance gate, its policy files and fixed controls must
// REJECT every case the plan lists, each for its intended reason, and ACCEPT
// only a complete synthetic run. No live deployment request is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertBoxConfinement, assertRuntimeSet, sanitizeGapEvidence, verifyBoxAgainstPins } from './core.mjs';
import { evaluateScopedAcceptance, loadAcceptanceInputs, parseTap, validateExpectedGaps } from './acceptance/verify-acceptance.mjs';
import { enumerateMandatoryChecks, INLINE_TEMPLATES } from './acceptance/mandatory-checks.mjs';
import { deriveExpectedRuntimes, GraphError } from './acceptance/expected-runtime-graph.mjs';
import { loadPins, verifyCandidate, PinError } from './acceptance/pins.mjs';
import { capture } from './acceptance/evidence-capture.mjs';
import { policyDigest } from './acceptance/digest.mjs';
import { captureExitCode } from './acceptance/run-acceptance.mjs';
import { runMarketplaceAdmissionProbes, runTemplateProbes, marketplaceProjection } from './boundary-probes.mjs';
import { runWebchatProbes } from './webchat-probes.mjs';
import { discoverAgentMcp } from './agent-probes.mjs';
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
    };
    const offline = mandatory.checks.filter(c => c.kind === 'offline').map(entry => {
        const tap = tapFor(entry);
        const commit = entry.repo === 'ploinky' ? pins.ploinky.commit : pins.repositories.find(r => r.name === entry.repo).commit;
        return { sidecar: { repo: entry.repo, file: entry.file, commit, clean: true, exitCode: 0, tapSha256: sha(tap) }, tap };
    });
    return { report, exitCode: 2, offline, pins, pinsSha256: 'f'.repeat(64), ...inputs };
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
    const id = 'router:users-list.path-dot-segment:userA';
    let run = acceptedRun();
    run.report.routerCoverage.find(r => r.probeId === 'users-list.path-dot-segment' && r.actor === 'userA').status = 'CONTROL_UNAVAILABLE';
    expectReject(run, 'GAP_EVIDENCE_MISMATCH', 'coverage status');
    run = acceptedRun();
    run.report.gaps.find(g => g.id === id).evidence.httpStatus = 503;
    run.report.routerCoverage.find(r => r.probeId === 'users-list.path-dot-segment' && r.actor === 'userA').httpStatus = 503;
    expectReject(run, 'GAP_EVIDENCE_MISMATCH', '503');
    run = acceptedRun();
    run.report.gaps.find(g => g.id === id).evidence = { kind: 'positive-unavailable', probeId: 'users-list.path-dot-segment', actor: 'userA' };
    expectReject(run, 'GAP_EVIDENCE_MISMATCH', 'positive control failed under the same ID');
});

test('a boundary entry may instead be an explicit passing denial, but not a missing or failed one', () => {
    const probeId = 'users-list.path-encoded-slash';
    const id = `router:${probeId}:selfRegistered`;
    const run = acceptedRun();
    run.report.gaps = run.report.gaps.filter(g => g.id !== id);
    run.report.routerCoverage = run.report.routerCoverage.filter(r => !(r.probeId === probeId && r.actor === 'selfRegistered'));
    run.report.routerCoverage.push({ probeId, actor: 'selfRegistered', status: 'AUTHORIZATION_DENIAL_PASSED', httpStatus: 403 });
    run.report.checks.push({ id, status: 'PASS' });
    run.report.counts.PASS += 1;
    assert.equal(evaluate(run).decision, 'ACCEPT');
    const failed = clone(run);
    failed.report.routerCoverage.at(-1).status = 'AUTHORIZATION_DENIAL_FAILED';
    expectReject(failed, 'GAP_MISSING', 'denial not passed');
    const absent = clone(run);
    absent.report.checks = absent.report.checks.filter(c => c.id !== id);
    absent.report.counts.PASS -= 1;
    expectReject(absent, 'GAP_MISSING', 'neither');
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
    run.mandatory = clone(mandatory);
    run.mandatory.checks = run.mandatory.checks.filter(c => c.id !== 'agent.dpuAgent.discovery.tools.list.selfRegistered');
    run.report.checks = run.report.checks.filter(c => c.id !== 'agent.dpuAgent.discovery.tools.list.selfRegistered');
    run.report.counts.PASS = run.report.checks.length;
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
        Id: 'c'.repeat(64), Name: 'ploinky-box-testExplorerFresh-123456789abc', Image: 'd'.repeat(64),
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
    has(mutateFirst(g => g.id === 'router:users-list.path-dot-segment:userA', g => { g.evidence.httpStatuses = [404, 503]; }), 'GAP_BOUNDARY_STATUS');
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
    partition.expectedGaps.gaps = partition.expectedGaps.gaps.filter(g => g.id !== 'agent.tasksAgent.discovery.resources.list');
    expectReject(partition, 'DISCOVERY_PARTITION', 'neither mandatory nor excluded');
});

test('committed mandatory-checks.json equals the enumerator and every inline template is a literal ctx.check in its module', () => {
    assert.deepEqual(enumerateMandatoryChecks({ expectedRuntimes, expectedGaps }), mandatory);
    for (const [module, template] of INLINE_TEMPLATES) {
        const text = fs.readFileSync(path.join(here, module), 'utf8');
        const literal = template.includes('${') ? `\`${template}\`` : `'${template}'`;
        assert.ok(text.includes(`ctx.check(${literal}`), `${module} has no ctx.check(${literal})`);
    }
    assert.ok(!mandatory.checks.some(c => /^router:(users-list\.path-|openai-agent-discovery\.)/.test(c.id)), 'boundary and negative-only router probes are not mandatory');
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
        clients: {}, sequence: [], cleanup: () => {},
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

test('U6 WebChat probe: no isolation credit without own streams; a marker crossing to the other user fails', async () => {
    const closedCtx = fakeCtx(() => json(200, {}));
    await runWebchatProbes(closedCtx, { timing: { waitMs: 20, settleMs: 1, removalMs: 50, pollMs: 5 }, openStream: async () => ({ status: 409, contentType: 'text/plain', events: () => [], waitFor: async () => null, close() {} }), inspectProcesses: async () => [] });
    assert.ok(closedCtx.report.checks.every(c => c.status === 'FAIL' && c.id.startsWith('u6:webchat-own-stream:')));
    assert.ok(closedCtx.report.gaps.length > 10 && closedCtx.report.gaps.every(g => g.evidence.kind === 'positive-unavailable'));
    // Streams open, but A's marker is visible on B's stream: the isolation check must FAIL.
    const shared = [];
    const stream = () => ({ status: 200, contentType: 'text/event-stream', events: () => [...shared], waitFor: async pred => shared.find(pred) || null, close() {} });
    const ctx = fakeCtx((actor, { body }) => { if (body?.text) { shared.push({ event: 'user-message', data: JSON.stringify({ text: body.text }) }, { event: 'output', data: `unknown command ${body.text.slice(1)}` }); } return { status: 204, text: '', headers: {} }; });
    await runWebchatProbes(ctx, { timing: { waitMs: 20, settleMs: 1, removalMs: 50, pollMs: 5 }, openStream: async () => { ctx.sequence.push('stream'); return stream(); }, inspectProcesses: async () => [{ pid: 1, args: '', environ: 'X=1' }, { pid: 2, args: '', environ: 'X=1' }] });
    assert.equal(ctx.report.checks.find(c => c.id === 'u6:webchat-marker-isolation:userA-to-userB').status, 'FAIL');
    // Every GET /stream (owned opens and the denial probes) is immediately preceded by the ownership guard.
    const streams = ctx.sequence.map((e, i) => [e, ctx.sequence[i - 1]]).filter(([e]) => e === 'stream');
    assert.ok(streams.length >= 9, `expected owned and denial stream requests, saw ${streams.length}`);
    assert.ok(streams.every(([, previous]) => previous === 'guard'), 'a GET /stream was not guarded');
    assert.equal(ctx.report.checks.find(c => c.id === 'u6:webchat-own-marker:userA').status, 'PASS');
});
