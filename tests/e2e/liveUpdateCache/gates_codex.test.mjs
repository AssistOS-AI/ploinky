import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { manifestFixture, installPureGuards } from './test_support_codex.mjs';
import { createFakeHost } from './fake_host_support_codex.mjs';
import { createMemoryFs } from './fake_fs_support_codex.mjs';
import { GATE_SPECS, gateEnvironment, boxEnvironment, projectReport, createGatePort, remainingGateWorkMs, GATE_WRAPPER_ALLOWANCE_MS } from './gates_codex.mjs';
import { gpuWiringIdentityOf, sha256Hex } from './engine_codex.mjs';
installPureGuards();

const inputs = { releaseManifest: '/home/skutner/work/release/manifest_codex.json', probeAgentImage: 'x', expectedUpdates: {} };
const result = (extra = {}) => ({ status: 'passed', retry: 0, errors: [], ...extra });
const report = ({ tests = 1, expected = 1, unexpected = 0, skipped = 0, flaky = 0, results = [result()] } = {}) => ({ stats: { expected, unexpected, skipped, flaky }, suites: [{ title: 'f', specs: [{ title: 's', tests: Array.from({ length: tests }, () => ({ results })) }], suites: [] }] });
const bytes = value => Buffer.from(JSON.stringify(value));

test('the three gates are the exact canonical entries with fixed budgets and the validity admission sums them', () => {
    assert.deepEqual(Object.keys(GATE_SPECS), ['Copilot', 'OnlyOffice', 'WebMeet']);
    assert.equal(GATE_SPECS.OnlyOffice.title, 'Explorer-created Confidential document saves through callback, drains, and reopens after targeted restart'); assert.equal(GATE_SPECS.WebMeet.title, 'two Explorer accounts can join one room and exchange chat');
    assert.equal(GATE_SPECS.Copilot.title, 'opens a working Copilot from a newly created folder'); assert.deepEqual([GATE_SPECS.Copilot.budgetMs, GATE_SPECS.OnlyOffice.budgetMs, GATE_SPECS.WebMeet.budgetMs], [540000, 840000, 120000]);
    assert.equal(remainingGateWorkMs(['Copilot', 'OnlyOffice', 'WebMeet']), 1500000 + 3 * GATE_WRAPPER_ALLOWANCE_MS); assert.equal(remainingGateWorkMs(['WebMeet']), 120000 + GATE_WRAPPER_ALLOWANCE_MS);
});

test('gate environments carry exactly the bound origin, run, flags and allowlisted login settings, and refuse timeout or error overrides', () => {
    const { value: manifest } = manifestFixture(), processEnv = { PATH: '/usr/bin', HOME: '/home/skutner', SMOKE_USERNAME: 'admin', SMOKE_TOTP_SECRET: 'PRIVATE-SENTINEL', NODE_OPTIONS: '--require x', OTHER_SECRET: 'PRIVATE', XDG_RUNTIME_DIR: '/run/user/1000' };
    const env = gate => gateEnvironment({ manifest, inputs, gate, runId: `r-${gate}`, artifactDir: `/e/${gate}`, processEnv });
    const copilot = env('Copilot'); assert.equal(copilot.SMOKE_RELEASE_MANIFEST, inputs.releaseManifest); assert.equal(copilot.SMOKE_SOURCE_VERIFICATION, 'release'); assert.equal(copilot.SMOKE_BASE_URL, 'http://localhost:8080');
    assert.equal(copilot.SMOKE_USERNAME, 'admin'); assert.equal(copilot.SMOKE_TOTP_SECRET, 'PRIVATE-SENTINEL', 'login settings pass through to the child only'); assert.equal(copilot.NODE_OPTIONS, undefined); assert.equal(copilot.OTHER_SECRET, undefined);
    assert.equal(env('OnlyOffice').SMOKE_ONLYOFFICE, '1'); assert.equal(env('OnlyOffice').SMOKE_PLOINKY_BIN, manifest.candidate.cliPath); assert.equal(env('OnlyOffice').SMOKE_DEPLOYMENT_MODE, 'box');
    const webmeet = env('WebMeet'); assert.equal(webmeet.SMOKE_WEBMEET_HEADLESS, '1'); assert.equal(webmeet.SMOKE_WEBMEET_MEDIA, '1'); assert.equal(webmeet.SMOKE_RELEASE_MANIFEST, undefined);
    for (const name of ['SMOKE_MEDIA_TIMEOUT_MS', 'SMOKE_TEST_TIMEOUT_MS', 'SMOKE_ACTION_TIMEOUT_MS', 'SMOKE_WEBMEET_REFRESH_MAX_WAIT_MS', 'SMOKE_RELAY_TIMEOUT_MS']) assert.throws(() => gateEnvironment({ manifest, inputs, gate: 'WebMeet', runId: 'r', artifactDir: '/e', processEnv: { ...processEnv, [name]: '999999' } }), error => error.code === 'gate-timeout-override', name);
    assert.throws(() => gateEnvironment({ manifest, inputs, gate: 'WebMeet', runId: 'r', artifactDir: '/e', processEnv: { ...processEnv, SMOKE_ALLOW_BROWSER_ERRORS: '1' } }), error => error.code === 'gate-browser-errors-allowed');
    assert.throws(() => gateEnvironment({ manifest, inputs, gate: 'Unknown', runId: 'r', artifactDir: '/e', processEnv }), error => error.code === 'gate-unknown');
});

// AC-13: the complete Box environment of every gate, for a labelled (active GPU wiring) and an unlabelled Box. One predicate, applied to
// every gate environment; each mutant of gateEnvironment/boxEnvironment must break it.
const HEX64 = /^[a-f0-9]{64}$/, LABEL = sha256Hex('fabricated-gpu-grant-fingerprint');
function boxContract(env, manifest, { labelled }) {
    const port = manifest.publications[0].hostPort;
    assert.equal(env.SMOKE_BASE_URL, `http://localhost:${port}`, 'SMOKE_BASE_URL');
    assert.equal(env.SMOKE_BOX_BASE_URL, `http://127.0.0.1:${port}`, 'SMOKE_BOX_BASE_URL');
    assert.equal(env.SMOKE_PLOINKY_BOX_CONTAINER, manifest.box.name, 'SMOKE_PLOINKY_BOX_CONTAINER is the container name');
    assert.doesNotMatch(env.SMOKE_PLOINKY_BOX_CONTAINER, HEX64, 'SMOKE_PLOINKY_BOX_CONTAINER is not the 64-hex ID'); assert.notEqual(env.SMOKE_PLOINKY_BOX_CONTAINER, manifest.box.id);
    if (labelled) { assert.equal(typeof env.SMOKE_BOX_GPU_GRANT, 'string', 'SMOKE_BOX_GPU_GRANT is set when the label is present'); assert.match(env.SMOKE_BOX_GPU_GRANT, HEX64); assert.equal(env.SMOKE_BOX_GPU_GRANT, LABEL, 'SMOKE_BOX_GPU_GRANT carries the label value'); }
    else assert.equal(Object.hasOwn(env, 'SMOKE_BOX_GPU_GRANT'), false, 'no SMOKE_BOX_GPU_GRANT without the label');
    assert.equal(env.SMOKE_EXPECT_BOX_IMAGE_REF, manifest.box.imageRef, 'image ref pin'); assert.equal(env.SMOKE_EXPECT_BOX_IMAGE_ID, `sha256:${manifest.box.imageId}`, 'image ID pin');
}
const fabricated = labelled => { const { value } = manifestFixture(); value.engine.gpuWiringIdentity = labelled ? LABEL : gpuWiringIdentityOf({}); return value; };

test('AC-13: every gate environment carries the complete Box contract for a labelled and an unlabelled Box', () => {
    const processEnv = { PATH: '/usr/bin', HOME: '/home/skutner' };
    for (const labelled of [true, false]) {
        const manifest = fabricated(labelled);
        for (const gate of Object.keys(GATE_SPECS)) boxContract(gateEnvironment({ manifest, inputs, gate, runId: `r-${gate}`, artifactDir: `/e/${gate}`, processEnv }), manifest, { labelled });
        boxContract(boxEnvironment(manifest), manifest, { labelled });
    }
    // A different port is carried through to both origins.
    const moved = fabricated(false); moved.publications[0].hostPort = 18443; boxContract(gateEnvironment({ manifest: moved, inputs, gate: 'OnlyOffice', runId: 'r', artifactDir: '/e', processEnv }), moved, { labelled: false });
    // The operator's own environment can neither supply nor override any Box binding.
    const hostile = { ...processEnv, SMOKE_PLOINKY_BOX_CONTAINER: 'other', SMOKE_BOX_GPU_GRANT: LABEL, SMOKE_BOX_BASE_URL: 'http://evil:1', SMOKE_EXPECT_BOX_IMAGE_ID: 'x' }, plain = fabricated(false);
    boxContract(gateEnvironment({ manifest: plain, inputs, gate: 'Copilot', runId: 'r', artifactDir: '/e', processEnv: hostile }), plain, { labelled: false });
});

test('AC-13: a missing, ID-shaped, malformed or ID-equal Box name refuses with gate-box-binding and so do malformed pins', () => {
    const refuse = mutate => { const manifest = fabricated(false); mutate(manifest); assert.throws(() => gateEnvironment({ manifest, inputs, gate: 'Copilot', runId: 'r', artifactDir: '/e', processEnv: { PATH: '/usr/bin' } }), error => error.code === 'gate-box-binding'); };
    refuse(m => { delete m.box.name; }); refuse(m => { m.box.name = undefined; }); refuse(m => { m.box.name = m.box.id; }); refuse(m => { m.box.name = sha256Hex('a'); });
    refuse(m => { m.box.name = 'ploinky-box-'; }); refuse(m => { m.box.name = 'Ploinky-Box-x'; }); refuse(m => { m.box.name = '/ploinky-box-x1'; }); refuse(m => { m.box.name = `ploinky-box-${'a'.repeat(202)}`; });
    refuse(m => { m.box.name = 'workspace-box'; }); refuse(m => { m.box.name = 7; });
    refuse(m => { delete m.box.imageRef; }); refuse(m => { m.box.imageRef = ''; }); refuse(m => { m.box.imageId = 'sha256:abc'; });
    refuse(m => { m.engine.gpuWiringIdentity = 'not-hex'; }); refuse(m => { m.publications = []; }); refuse(m => { m.publications[0].hostPort = 0; });
    const edge = fabricated(false); edge.box.name = `ploinky-box-${'a'.repeat(201)}`; assert.equal(boxEnvironment(edge).SMOKE_PLOINKY_BOX_CONTAINER, edge.box.name);
});

test('report projection counts exactly one passed test and never exposes titles, errors or attachments', () => {
    assert.deepEqual(projectReport(bytes(report())), { discovered: 1, passed: 1, failed: 0, skipped: 0, retries: 0, ignoredErrors: 0 });
    assert.deepEqual(projectReport(bytes(report({ tests: 0, expected: 0, results: [] }))), { discovered: 0, passed: 0, failed: 0, skipped: 0, retries: 0, ignoredErrors: 0 });
    assert.equal(projectReport(bytes(report({ tests: 2, expected: 2 }))).discovered, 2); assert.equal(projectReport(bytes(report({ expected: 0, skipped: 1, results: [result({ status: 'skipped' })] }))).skipped, 1);
    assert.equal(projectReport(bytes(report({ expected: 0, flaky: 1, results: [result({ retry: 0 }), result({ retry: 1 })] }))).failed, 1); assert.equal(projectReport(bytes(report({ results: [result({ retry: 1 })] }))).retries, 1);
    assert.equal(projectReport(bytes(report({ results: [result({ errors: [{ message: 'PRIVATE' }] })] }))).ignoredErrors, 1); assert.doesNotMatch(JSON.stringify(projectReport(bytes(report({ results: [result({ errors: [{ message: 'PRIVATE' }] })] })))), /PRIVATE/);
    for (const bad of [Buffer.from('not json'), bytes({}), bytes({ stats: {}, suites: [] }), bytes({ stats: { expected: -1, unexpected: 0, skipped: 0, flaky: 0 }, suites: [] }), bytes({ stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 } })]) assert.throws(() => projectReport(bad), error => error.code === 'gate-report' || error.code === 'manifest-json');
});

function build(reportValue = report(), { exit = 0, writeReport = true } = {}) {
    const { value: manifest } = manifestFixture(), explorer = manifest.candidate.repositories.find(repo => repo.name === 'AssistOSExplorer'), fsMemory = createMemoryFs({});
    const host = createFakeHost([{ match: () => true, reply: ({ options }) => { if (writeReport) fsMemory.setFile(path.join(options.env.SMOKE_ARTIFACT_DIR, 'test-results', 'results.json'), JSON.stringify(reportValue)); return { code: exit }; } }]);
    let tick = Date.parse('2026-10-04T12:00:00Z'); const port = createGatePort({ manifest, inputs, deps: host.deps, processEnv: { PATH: '/usr/bin' }, io: fsMemory, now: () => (tick += 1000) });
    return { manifest, host, port, explorer };
}

test('a gate runs the smoke entrypoint once with fixed arguments, a new run and artifact directory, and reports counts', async () => {
    const h = build(); const row = await h.port.run('OnlyOffice');
    assert.deepEqual({ ...row, startedAt: undefined, finishedAt: undefined }, { name: 'OnlyOffice', runId: `${h.manifest.runId.replace(/_codex$/, '')}-onlyoffice`, discovered: 1, passed: 1, failed: 0, skipped: 0, retries: 0, ignoredErrors: 0, closed: true, startedAt: undefined, finishedAt: undefined });
    assert.ok(row.finishedAt > row.startedAt); const [launch] = h.host.log; const smoke = path.join(h.explorer.path, 'tests', 'smoke');
    assert.equal(launch.bin, h.manifest.host.node.path); assert.deepEqual(launch.args, [path.join(smoke, 'scripts/run-playwright.mjs'), '--project=chromium', '--workers=1', '--retries=0', '--grep', GATE_SPECS.OnlyOffice.title, 'specs/50-onlyoffice-dpu.spec.mjs']);
    assert.equal(launch.options.cwd, smoke); assert.equal(launch.options.env.SMOKE_ARTIFACT_DIR, path.join(h.manifest.evidence.root, 'gates', 'onlyoffice'));
    assert.equal(h.host.log.length, 1); assert.equal(h.host.custody.snapshot()[0].settled, true);
});

test('a failing exit, missing report, skipped, duplicated or retried test never produces a passing row', async () => {
    await assert.rejects(build(report(), { exit: 1 }).port.run('Copilot'), error => error.code === 'command-exit-unexpected');
    await assert.rejects(build(report(), { writeReport: false }).port.run('Copilot'), error => error.code === 'gate-report');
    for (const [label, value, check] of [['zero tests', report({ tests: 0, expected: 0, results: [] }), row => row.discovered === 0], ['skip', report({ expected: 0, skipped: 1, results: [result({ status: 'skipped' })] }), row => row.skipped === 1 && row.passed === 0],
        ['two tests', report({ tests: 2, expected: 2 }), row => row.discovered === 2], ['retry', report({ results: [result({ retry: 1 })] }), row => row.retries === 1], ['ignored error', report({ results: [result({ errors: [{ message: 'x' }] })] }), row => row.ignoredErrors === 1]]) {
        const row = await build(value).port.run('WebMeet'); assert.equal(check(row), true, label);
    }
});
