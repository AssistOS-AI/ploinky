import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { manifestFixture, installPureGuards, OPTIONAL_GRAPH, H } from './test_support_codex.mjs';
import { createFakeHost } from './fake_host_support_codex.mjs';
import { createMemoryFs } from './fake_fs_support_codex.mjs';
import { gpuWiringIdentityOf, sha256Hex, RECEIPT_INSPECT_FORMAT, receiptInspectArgs, parseReceiptInspect } from './engine_codex.mjs';
import { OPTIONAL_ACTIVATION } from './contracts_codex.mjs';
import { prepareWorkspaceSmoke, workspaceSmoke, assertActivationWindow, assertRegistryMembership, assertActivationReceipt, createActivationPort, runActivationPhase, sameState } from './activation_codex.mjs';
installPureGuards();

const codeIs = code => error => error.code === code;
const rejects = (promise, code, label) => assert.rejects(promise, codeIs(code), label);
const NODE_DIR = '/usr/local/bin', PIN = '1.55.0';
const T0 = Date.parse('2026-10-04T12:00:00Z'), iso = ms => new Date(ms).toISOString();

// ---- UA-0 (AC-16) ----
function smokeWorld({ pin = PIN, have = PIN, exits = {}, status = '', packageJson } = {}) {
    const { value: release2 } = manifestFixture(), { checkout, smoke } = workspaceSmoke(release2);
    const files = { [path.join(smoke, 'package.json')]: packageJson ?? JSON.stringify({ devDependencies: { '@playwright/test': pin } }) };
    const io = createMemoryFs(files);
    const host = createFakeHost([
        { match: (bin, args) => args[0] === 'ci', reply: () => ({ code: exits.install ?? 0, stdout: 'added 3 packages\n' }) },
        { match: bin => bin.endsWith('/npx'), reply: () => ({ code: exits.version ?? 0, stdout: `Version ${have}\n` }) },
        { match: (bin, args) => bin === release2.host.node.path && args[0] === '-e', reply: () => ({ code: exits.chromium ?? 0 }) },
        { match: bin => bin === '/usr/bin/git', reply: () => ({ stdout: status }) },
    ]);
    return { release2, checkout, smoke, io, host, run: () => prepareWorkspaceSmoke({ release2, deps: host.deps, io, processEnv: { PATH: '/usr/bin:/bin', HOME: '/home/skutner', SMOKE_PASSWORD: 'PRIVATE-SENTINEL' } }) };
}

test('UA-0 runs the owned install, the Playwright and Chromium pins and the clean check in order, each from the workspace checkout', async () => {
    const w = smokeWorld(); assert.deepEqual(await w.run(), { exitCode: 0, clean: true });
    assert.deepEqual(w.host.log.map(row => [row.bin, ...row.args]), [[`${NODE_DIR}/npm`, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], [`${NODE_DIR}/npx`, '--no-install', 'playwright', '--version'],
        ['/usr/local/bin/node', '-e', w.host.log[2].args[1]], ['/usr/bin/git', '-C', w.checkout, 'status', '--porcelain=v1']]);
    assert.deepEqual(w.host.log.map(row => row.options.cwd), [w.smoke, w.smoke, w.smoke, w.checkout]);
    const [install] = w.host.log; assert.equal(install.options.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, '1'); assert.ok(install.options.env.PATH.startsWith(`${NODE_DIR}:`)); assert.equal(install.options.env.SMOKE_PASSWORD, undefined); assert.equal(install.options.shell, false);
    assert.match(w.host.log[2].args[1], /chromium\.executablePath\(\)/);
    const custody = w.host.custody.snapshot(); assert.equal(custody.length, 4); assert.equal(custody[0].operation, 'ua-workspace-npm-ci'); assert.ok(custody.every(row => row.settled === true), 'the npm ci command is owned and settled');
});

test('UA-0 refusals have fixed codes and stop before any later command', async () => {
    const cases = [
        ['npm ci exits non-zero', { exits: { install: 1 } }, 'workspace-smoke-install-failed', 1],
        ['Playwright version differs from the pin', { have: '1.54.9' }, 'workspace-playwright-unpinned', 2],
        ['no Playwright pin in package.json', { packageJson: '{}' }, 'workspace-playwright-unpinned', 2],
        ['unreadable package.json', { packageJson: 'not json' }, 'workspace-playwright-unpinned', 2],
        ['playwright --version fails', { exits: { version: 1 } }, 'workspace-playwright-unpinned', 2],
        ['pinned Chromium is missing', { exits: { chromium: 1 } }, 'workspace-chromium-missing', 3],
        ['the checkout is dirty after npm ci', { status: ' M tests/smoke/package.json\n' }, 'workspace-checkout-unclean', 4],
        ['untracked file after npm ci', { status: '?? tests/smoke/extra\n' }, 'workspace-checkout-unclean', 4],
    ];
    for (const [label, options, code, launched] of cases) { const w = smokeWorld(options); await rejects(w.run(), code, label); assert.equal(w.host.log.length, launched, label); assert.ok(w.host.custody.snapshot().every(row => row.settled), label); }
});

test('UA-0: an npm ci that overruns its deadline is a custody handoff with nothing signalled and no later command', async () => {
    const w = smokeWorld(), launched = [];
    const launch = (bin, args, options) => { const child = new EventEmitter(); child.pid = 4242; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); launched.push({ bin, args }); return child; };
    const deps = { ...w.host.deps, launch };
    await assert.rejects(prepareWorkspaceSmoke({ release2: w.release2, deps, io: w.io, processEnv: { PATH: '/usr/bin' } }), error => error.code === 'command-deadline' && error.retained?.childClosed === false);
    assert.equal(launched.length, 1); assert.deepEqual(w.host.custody.snapshot().map(row => row.settled), [false]); assert.equal(w.host.latch.snapshot().uncertain, true);
});

test('the receipt inspection template selects only identity, start, mounts and publications and never the environment', () => {
    assert.doesNotMatch(RECEIPT_INSPECT_FORMAT, /Config\.Env|\.Env\b|Labels|Secret|Auth|\{\{json \.\}\}/); assert.match(RECEIPT_INSPECT_FORMAT, /\{\{json \.Id\}\}/);
    assert.deepEqual(receiptInspectArgs('/usr/bin/podman', 'ploinky-box-x-0123456789ab').slice(-3), ['--format', RECEIPT_INSPECT_FORMAT, 'ploinky-box-x-0123456789ab']);
    for (const bad of ['a b', '', '-x', 'a;b']) assert.throws(() => receiptInspectArgs('/usr/bin/podman', bad), codeIs('engine-argument'));
    const good = { Id: H('b'), State: { Running: true, StartedAt: 'x' }, Mounts: [], NetworkSettings: { Ports: {} }, HostConfig: { PortBindings: {} } };
    assert.deepEqual(parseReceiptInspect(Buffer.from(JSON.stringify(good))), good);
    for (const bad of [{ ...good, Config: { Env: ['X=1'] } }, { Id: 1 }, [], null]) assert.throws(() => parseReceiptInspect(Buffer.from(JSON.stringify(bad))), codeIs('receipt-inspect-shape'));
});

// ---- Activation window (AC-7) ----
const rows = (names = ['AssistOSExplorer/explorer', 'AssistOSExplorer/dpuAgent']) => names.map(name => [name, `rt-${name}`, `inst-${name}`, 'en-1']);
const added = () => OPTIONAL_ACTIVATION.agents.map(agent => [`Repo/${agent}`, `rt-${agent}`, `inst-${agent}`, 'en-2']);
const state = (runtimes, generation = 'g-1') => ({ generation, runtimes });

test('AC-7: the activation window allows a generation change and exactly the three declared optional runtimes', () => {
    const before = state(rows());
    assert.equal(assertActivationWindow({ before, after: state([...rows(), ...added()]) }), true);
    assert.equal(assertActivationWindow({ before, after: state([...rows(), ...added()], 'g-2') }), true, 'a generation change alone is inside the window');
    assert.equal(sameState(before, state(rows())), true); assert.equal(sameState(before, state(rows(), 'g-2')), false);
    const refuse = (after, label) => assert.throws(() => assertActivationWindow({ before, after }), codeIs('activation-epoch-changed'), label);
    const changed = rows(); changed[0][1] = 'replaced'; refuse(state([...changed, ...added()]), 'one changed default row');
    refuse(state([...rows(), rows()[0], ...added()]), 'a duplicated default row'); refuse(state([...rows(), ...added(), ['Repo/extra', 'r', 'i', 'e']]), '4 added'); refuse(state([...rows(), ...added().slice(0, 2)]), '2 added'); refuse(state([...rows(), ...added().slice(0, 2), ['Repo/other', 'r', 'i', 'e']]), 'three added but one undeclared');
    refuse(state(rows()), 'nothing added'); refuse(state([rows()[0], ...added()]), 'a default row removed'); refuse(state([...rows(), ...added(), ...added()]), 'duplicates');
    assert.throws(() => assertActivationWindow({ before: state([...rows(), added()[0]]), after: state([...rows(), ...added()]) }), codeIs('activation-epoch-changed'), 'an optional agent already present before');
    assert.throws(() => assertActivationWindow({ before, after: null }), codeIs('activation-epoch-changed'));
});

// ---- Receipt (AC-6) and the whole port ----
const optionalTitle = 'OnlyOffice, Scribe, and STT start disabled and can be enabled through Marketplace';
function receiptWorld(patch = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ua-'))), ws = path.join(root, 'workspace'), { smoke } = workspaceSmoke({ workspace: { path: ws } });
    fs.mkdirSync(smoke, { recursive: true });
    const { value } = manifestFixture(), release2 = structuredClone(value);
    Object.assign(release2, { runId: 'update-cache-20261004T123000Z-feedc0de_codex' }); release2.workspace.path = ws; release2.evidence = { ...release2.evidence, root: path.join(root, 'evidence') };
    release2.box = { ...release2.box, id: H('r2-box'), startedAt: iso(T0) }; release2.publications = [{ ...release2.publications[0], hostPort: 18080 }, release2.publications[1]];
    const boxFor = id => ({ Id: id, State: { Running: true, StartedAt: iso(T0 + 234) }, Mounts: [{ Destination: ws, Type: 'bind', RW: true, Source: ws }],
        NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] } }, HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] } } });
    return { root, ws, smoke, release2, boxFor, inspectBox: async () => boxFor(patch.boxId ?? release2.box.id) };
}
function writeReceipt(w, { receipt = {}, result = {}, stats = {}, tests = 1, startOffset = 120000, durationMs = 300000 } = {}) {
    const dir = path.join(w.root, 'evidence', 'gates', 'ua-run'); fs.mkdirSync(path.join(dir, 'test-results'), { recursive: true });
    const reportStart = T0 + startOffset + 1000, testStart = reportStart + 1000, statsValue = { expected: 1, skipped: 0, unexpected: 0, flaky: 0, duration: durationMs + 5000, startTime: iso(reportStart), ...stats };
    const testRow = () => ({ expectedStatus: 'passed', status: 'expected', projectName: 'chromium', results: [{ status: 'passed', retry: 0, errors: [], startTime: iso(testStart), duration: durationMs, ...result }] });
    const report = { stats: statsValue, errors: [], config: { workers: 1, configFile: path.join(w.smoke, 'playwright.config.mjs'), rootDir: path.join(w.smoke, 'specs'), projects: [{ name: 'chromium', retries: 0, repeatEach: 1, outputDir: path.join(dir, 'test-results') }] },
        suites: [{ specs: [{ file: '03-optional-agents.spec.mjs', title: optionalTitle, ok: true, tests: Array.from({ length: tests }, testRow) }], suites: [] }] };
    fs.writeFileSync(path.join(dir, 'test-results', 'results.json'), JSON.stringify(report), { mode: 0o600 });
    const finishedAt = iso(reportStart + statsValue.duration + 1000);
    const full = { gate: 'optional', result: 'passed', exitCode: 0, runId: 'ua-run', directory: dir, cwd: w.smoke, command: [...OPTIONAL_ACTIVATION.command], boxId: w.release2.box.id, boxStartedAt: iso(T0 + 234), workspaceRoot: w.ws,
        baseURL: 'http://localhost:18080', publication: { containerPort: '8080/tcp', hostIp: '127.0.0.1', hostPort: '18080' }, startedAt: iso(T0 + startOffset), finishedAt, stats: statsValue, ...receipt };
    const file = path.join(dir, 'run.json'); fs.writeFileSync(file, JSON.stringify(full, null, 2), { mode: 0o600 });
    return { file, finishedMs: Date.parse(finishedAt), dir };
}
const envOf = w => ({ SMOKE_BASE_URL: 'http://localhost:18080', SMOKE_PLOINKY_BOX_CONTAINER: w.release2.box.name });
const U7D = T0 + 100000;
const verify = (w, written, extra = {}) => assertActivationReceipt({ receiptPath: written.file, release2: w.release2, u7dFinishedAt: U7D, postObservedAt: written.finishedMs + 5000, env: envOf(w), inspectBox: w.inspectBox, ...extra });

test('AC-6: a valid receipt of this generation is accepted and its hash is recorded', async () => {
    const w = receiptWorld(), written = writeReceipt(w), result = await verify(w, written);
    assert.match(result.receiptSha256, /^[a-f0-9]{64}$/); assert.equal(result.runId, 'ua-run');
    assert.equal(result.receiptSha256, (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(written.file)).digest('hex'));
});

test('AC-6: every receipt that is not exactly this generation\'s own passed activation is activation-receipt-invalid', async () => {
    const cases = [
        ['boxStartedAt off by one second', w => writeReceipt(w, { receipt: { boxStartedAt: iso(T0 + 1234) } })],
        ['the other generation\'s Box ID', w => writeReceipt(w, { receipt: { boxId: H('r1-box') } })],
        ['a 127.0.0.1 baseURL', w => writeReceipt(w, { receipt: { baseURL: 'http://127.0.0.1:18080' } })],
        ['started before U7d finished', w => writeReceipt(w, { startOffset: 50000 })],
        ['a retry in the report', w => writeReceipt(w, { result: { retry: 1 } })],
        ['two tests in the report', w => writeReceipt(w, { tests: 2 })],
        ['a skipped stat', w => writeReceipt(w, { stats: { skipped: 1 } })],
        ['result running', w => writeReceipt(w, { receipt: { result: 'running', exitCode: null, finishedAt: null } })],
        ['non-zero exit', w => writeReceipt(w, { receipt: { exitCode: 1 } })],
        ['another command', w => writeReceipt(w, { receipt: { command: ['npm', 'test'] } })],
        ['another workspace root', w => writeReceipt(w, { receipt: { workspaceRoot: '/elsewhere' } })],
    ];
    for (const [label, build] of cases) { const w = receiptWorld(), written = build(w); await rejects(verify(w, written), 'activation-receipt-invalid', label); }
    // Checks only the runner makes: the receipt must be of R2's own Box and of the localhost origin even when the live Box and the environment agree with it.
    const other = receiptWorld(), otherId = H('some-other-box'), otherWritten = writeReceipt(other, { receipt: { boxId: otherId } });
    await rejects(verify(other, otherWritten, { inspectBox: async () => other.boxFor(otherId) }), 'activation-receipt-invalid', 'the receipt and the live Box agree but are not R2\'s Box');
    const loopback = receiptWorld(), loopbackWritten = writeReceipt(loopback, { receipt: { baseURL: 'http://127.0.0.1:18080' } });
    await rejects(verify(loopback, loopbackWritten, { env: { SMOKE_BASE_URL: 'http://127.0.0.1:18080', SMOKE_PLOINKY_BOX_CONTAINER: loopback.release2.box.name } }), 'activation-receipt-invalid', 'a loopback receipt whose helper-side environment agrees');
    const late = receiptWorld(), lateWritten = writeReceipt(late); await rejects(verify(late, lateWritten, { postObservedAt: lateWritten.finishedMs - 1 }), 'activation-receipt-invalid', 'finished after the post observation');
    const after = receiptWorld(), afterWritten = writeReceipt(after); await rejects(verify(after, afterWritten, { u7dFinishedAt: T0 + 130000 }), 'activation-receipt-invalid', 'started before the U7d finish (runner-owned check)');
    const stale = receiptWorld({ boxId: H('other-live-box') }), staleWritten = writeReceipt(stale); await rejects(verify(stale, staleWritten), 'activation-receipt-invalid', 'the live Box is not the receipt\'s Box');
    const missing = receiptWorld(); await rejects(verify(missing, { file: path.join(missing.root, 'evidence', 'gates', 'ua-run', 'run.json'), finishedMs: T0 }), 'activation-receipt-invalid', 'no receipt');
    const bad = receiptWorld(), badWritten = writeReceipt(bad); fs.writeFileSync(badWritten.file, '{"gate":', { mode: 0o600 }); await rejects(verify(bad, badWritten), 'activation-receipt-invalid', 'malformed JSON');
});

function portWorld({ runExit = 0, writeReport = true, clean = '' } = {}) {
    const w = receiptWorld(), clock = { t: T0 + 120000 };
    const reportFor = env => { const dir = env.SMOKE_ARTIFACT_DIR; fs.mkdirSync(path.join(dir, 'test-results'), { recursive: true });
        const start = clock.t + 1000, report = { stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0, duration: 305000, startTime: iso(start) }, errors: [],
            config: { workers: 1, configFile: path.join(w.smoke, 'playwright.config.mjs'), rootDir: path.join(w.smoke, 'specs'), projects: [{ name: 'chromium', retries: 0, repeatEach: 1, outputDir: path.join(dir, 'test-results') }] },
            suites: [{ specs: [{ file: '03-optional-agents.spec.mjs', title: optionalTitle, ok: true, tests: [{ expectedStatus: 'passed', status: 'expected', projectName: 'chromium', results: [{ status: 'passed', retry: 0, errors: [], startTime: iso(start + 1000), duration: 300000 }] }] }], suites: [] }] };
        fs.writeFileSync(path.join(dir, 'test-results', 'results.json'), JSON.stringify(report), { mode: 0o600 }); };
    const host = createFakeHost([
        { match: (bin, args) => args[0] === 'container' && args[1] === 'inspect', reply: () => ({ stdout: JSON.stringify(w.boxFor(w.release2.box.id)) }) },
        { match: (bin, args) => args[0] === 'run' && args[1] === 'test:optional-agents', reply: ({ options }) => { if (writeReport && runExit === 0) reportFor(options.env); clock.t += 310000; return { code: runExit }; } },
        { match: (bin, args) => args[0] === 'ci', reply: () => ({}) }, { match: bin => bin.endsWith('/npx'), reply: () => ({ stdout: `Version ${PIN}\n` }) }, { match: (bin, args) => args[0] === '-e', reply: () => ({}) },
        { match: bin => bin === '/usr/bin/git', reply: () => ({ stdout: clean }) },
    ]);
    fs.writeFileSync(path.join(w.smoke, 'package.json'), JSON.stringify({ devDependencies: { '@playwright/test': PIN } }), { mode: 0o600 });
    w.release2.engine = { ...w.release2.engine, path: '/usr/bin/podman' };
    const port = createActivationPort({ deps: host.deps, processEnv: { PATH: '/usr/bin:/bin', SMOKE_USERNAME: 'admin', SMOKE_PASSWORD: 'PRIVATE-SENTINEL' }, now: () => clock.t });
    return { ...w, host, port, clock };
}

test('the activation port writes the running receipt before the command, runs the canonical command once with the complete Box environment, finishes and verifies it', async () => {
    const w = portWorld(), order = [];
    const place = await w.port.start(w.release2); const running = JSON.parse(fs.readFileSync(place.receiptPath, 'utf8'));
    assert.equal(running.result, 'running'); assert.equal(running.exitCode, null); assert.equal(running.boxId, w.release2.box.id); assert.equal(running.baseURL, 'http://localhost:18080'); assert.deepEqual(running.command, OPTIONAL_ACTIVATION.command);
    assert.equal(w.host.log.some(row => row.args.includes('test:optional-agents')), false, 'the running receipt exists before the command is launched'); order.push('start');
    const run = await w.port.execute(w.release2, place); assert.deepEqual(run, { exitCode: 0 });
    const launch = w.host.log.find(row => row.args[0] === 'run'); assert.deepEqual([launch.bin, ...launch.args], [`${NODE_DIR}/npm`, 'run', 'test:optional-agents', '--', '--workers=1', '--retries=0']); assert.equal(launch.options.cwd, w.smoke);
    const env = launch.options.env;
    assert.equal(env.SMOKE_OPTIONAL_AGENTS, '1'); assert.equal(env.SMOKE_PLOINKY_BOX_CONTAINER, w.release2.box.name); assert.equal(env.SMOKE_BASE_URL, 'http://localhost:18080'); assert.equal(env.SMOKE_BOX_BASE_URL, 'http://127.0.0.1:18080');
    assert.equal(env.SMOKE_ARTIFACT_DIR, place.directory); assert.equal(env.SMOKE_WORKSPACE_ROOT, w.ws); assert.ok(env.PATH.startsWith(`${NODE_DIR}:`)); assert.equal(env.SMOKE_USERNAME, 'admin');
    assert.equal(env.SMOKE_EXPECT_BOX_IMAGE_REF, w.release2.box.imageRef); assert.equal(Object.hasOwn(env, 'SMOKE_BOX_GPU_GRANT'), true, 'the fixture is labelled: the grant fingerprint is exported');
    await w.port.finish(w.release2, place, run); const done = JSON.parse(fs.readFileSync(place.receiptPath, 'utf8')); assert.equal(done.result, 'passed'); assert.equal(done.exitCode, 0); assert.equal(done.stats.expected, 1);
    const result = await w.port.verify({ release2: w.release2, place, u7dFinishedAt: T0 + 100000, postObservedAt: w.clock.t + 1000 }); assert.match(result.receiptSha256, /^[a-f0-9]{64}$/);
    // The inspection commands are read-only: only the install and the activation are mutations of the workspace.
    assert.ok(w.host.log.filter(row => row.args[0] === 'container').length >= 2); assert.ok(w.host.log.every(row => !row.args.includes('start') && !row.args.includes('restart')));
    assert.ok(w.host.custody.snapshot().every(row => row.settled)); assert.equal(order.length, 1);
});

test('a second activation is refused before anything launches, and a failed command records a failed receipt and never verifies', async () => {
    const w = portWorld(); await w.port.start(w.release2); const launched = w.host.log.length;
    await rejects(w.port.start(w.release2), 'activation-already-run'); assert.equal(w.host.log.length, launched, 'the refused second UA launched nothing');
    const failing = portWorld({ runExit: 1 }), place = await failing.port.start(failing.release2), run = await failing.port.execute(failing.release2, place); assert.deepEqual(run, { exitCode: 1 });
    await rejects(failing.port.finish(failing.release2, place, run), 'activation-failed'); assert.equal(JSON.parse(fs.readFileSync(place.receiptPath, 'utf8')).result, 'failed');
    const noReport = portWorld({ writeReport: false }), noPlace = await noReport.port.start(noReport.release2), noRun = await noReport.port.execute(noReport.release2, noPlace);
    await rejects(noReport.port.finish(noReport.release2, noPlace, noRun), 'activation-failed'); assert.equal(JSON.parse(fs.readFileSync(noPlace.receiptPath, 'utf8')).result, 'failed');
});

// ---- The UA phase order and guards (AC-5) ----
function phaseWorld({ ageMs = 100000, generation = 'g-1', afterRows, secondRows, imageAgeMs = 3600000, beforeRows } = {}) {
    const { value } = manifestFixture(), release = structuredClone(value), log = [], clock = { t: T0 + ageMs };
    release.box = { ...release.box, startedAt: iso(T0), imageCreatedAt: iso(T0 - imageAgeMs) };
    const known = state(beforeRows ?? rows()), post = state(afterRows ?? [...rows(), ...added()], 'g-2'), epochs = [];
    const epoch = async options => { epochs.push(options); log.push(`epoch:${options.addedGraph ? 'added' : 'base'}`);
        if (!options.addedGraph) return state(beforeRows ?? rows(), options.generation); return epochs.filter(row => row.addedGraph).length === 2 && secondRows ? state(secondRows, post.generation) : post; };
    const port = { async prepare() { log.push('prepare'); clock.t += 30000; return { exitCode: 0, clean: true }; }, async start() { log.push('start'); return { runId: 'ua' }; }, async execute() { log.push('execute'); return { exitCode: 0 }; },
        async finish() { log.push('finish'); }, async verify({ postObservedAt }) { log.push('verify'); assert.equal(postObservedAt, clock.t); return { receiptSha256: H('receipt') }; } };
    return { release, known, log, epochs, run: () => runActivationPhase({ release, known, u7dFinishedAt: T0 + 90000, epoch, port, wallNow: () => clock.t, check: () => log.push('check') }), clock };
}

test('AC-5: the UA phase runs its guards, the install, the activation and the post-activation proof in the SPEC order', async () => {
    const w = phaseWorld(), result = await w.run();
    assert.deepEqual(w.log.filter(row => row !== 'check'), ['prepare', 'epoch:base', 'start', 'execute', 'finish', 'verify', 'epoch:added', 'epoch:added']);
    assert.deepEqual(w.epochs, [{ generation: 'g-1' }, { addedGraph: true }, { addedGraph: true, generation: 'g-2' }]);
    assert.equal(result.receipt.receiptSha256, H('receipt')); assert.deepEqual(result.install, { exitCode: 0, clean: true }); assert.ok(result.after.runtimes.length === result.before.runtimes.length + 3);
});

test('AC-5: the pre-guard proceeds at 150,000 ms and refuses at 150,001 ms before anything launches', async () => {
    assert.ok((await phaseWorld({ ageMs: 150000 }).run()).receipt);
    const late = phaseWorld({ ageMs: 150001 }); await rejects(late.run(), 'activation-window-insufficient'); assert.deepEqual(late.log, [], 'no port call, no observation');
    const host = createFakeHost([]); assert.deepEqual(host.custody.snapshot(), [], 'an empty custody snapshot');
});

test('AC-5: the activation guard proceeds at 180,000 ms and refuses at 180,001 ms, and UA-1 is never launched', async () => {
    const guarded = async prepareMs => {
        const { value } = manifestFixture(), release = structuredClone(value), calls = [], clock = { t: T0 + 100000 };
        release.box = { ...release.box, startedAt: iso(T0), imageCreatedAt: iso(T0 - 3600000) };
        const port = { async prepare() { calls.push('prepare'); clock.t += prepareMs; return {}; }, async start() { calls.push('start'); return {}; }, async execute() { calls.push('execute'); return { exitCode: 0 }; }, async finish() { calls.push('finish'); }, async verify() { calls.push('verify'); return {}; } };
        const epoch = async options => (options.addedGraph ? state([...rows(), ...added()], 'g-2') : state(rows(), options.generation));
        const outcome = await runActivationPhase({ release, known: state(rows()), u7dFinishedAt: T0, epoch, port, wallNow: () => clock.t, check() {} }).then(() => null, error => error.code);
        return { outcome, calls };
    };
    assert.deepEqual(await guarded(80000), { outcome: null, calls: ['prepare', 'start', 'execute', 'finish', 'verify'] }, 'age 180,000 ms proceeds');
    assert.deepEqual(await guarded(80001), { outcome: 'activation-window-insufficient', calls: ['prepare'] }, 'age 180,001 ms refuses and neither start nor execute ran');
});

test('the UA phase refuses a moved epoch, an unstable post-activation epoch, an off-window result and an exhausted campaign image reserve', async () => {
    const moved = phaseWorld(); moved.known.runtimes[0][1] = 'other'; await rejects(moved.run(), 'canonical-epoch-changed'); assert.equal(moved.log.includes('start'), false, 'the activation was not launched');
    const unstable = phaseWorld({ secondRows: [...rows(), ...added()].map((row, index) => (index === 0 ? [row[0], 'replaced', row[2], row[3]] : row)) }); await rejects(unstable.run(), 'canonical-epoch-changed');
    const four = phaseWorld({ afterRows: [...rows(), ...added(), ['Repo/extra', 'r', 'i', 'e']] }); await rejects(four.run(), 'activation-epoch-changed');
    const replaced = rows(); replaced[1][1] = 'replaced'; const changedDefault = phaseWorld({ afterRows: [...replaced, ...added()] }); await rejects(changedDefault.run(), 'activation-epoch-changed');
    const reserve = phaseWorld({ imageAgeMs: 14400000 - 1620000 + 1 - 100000 }); await rejects(reserve.run(), 'campaign-image-window-insufficient'); assert.deepEqual(reserve.log.filter(row => ['start', 'execute'].includes(row)), [], 'B3 refuses before UA-1');
    assert.ok((await phaseWorld({ imageAgeMs: 14400000 - 1620000 - 100000 - 30000 }).run()).receipt, 'B3 accepts at its limit (the image ages with the install)');
});

test('N-A: registry membership is the exact default graph, plus exactly the three declared agents after the activation', () => {
    const { value } = manifestFixture(), release = { graph: value.graph, activation: null }, r2 = { graph: value.graph, activation: OPTIONAL_GRAPH };
    const base = value.graph.map(entry => entry.name), three = OPTIONAL_GRAPH.map(entry => entry.name);
    assert.equal(assertRegistryMembership({ registryAgents: [...base].reverse(), release, afterActivation: false }), true, 'order is irrelevant');
    assert.equal(assertRegistryMembership({ registryAgents: base, release: r2, afterActivation: false }), true); assert.equal(assertRegistryMembership({ registryAgents: [...base, ...three], release: r2, afterActivation: true }), true);
    const refuse = (registryAgents, subject, afterActivation, code) => assert.throws(() => assertRegistryMembership({ registryAgents, release: subject, afterActivation }), codeIs(code), JSON.stringify([registryAgents, afterActivation]));
    for (const agents of [[...base, three[0]], [...base, ...three], [...base, 'Elsewhere/optional'], base.slice(1), [...base, base[0]]]) refuse(agents, release, false, agents.some(name => ['onlyOffice', 'webmeetScribeAgent', 'webmeetStt'].includes(name.split('/').at(-1))) ? 'release-graph-activated' : 'activation-epoch-changed');
    refuse([...base, three[0]], r2, false, 'activation-epoch-changed'); refuse([...base, ...three], r2, false, 'activation-epoch-changed');
    refuse(base, r2, true, 'activation-epoch-changed'); refuse([...base, ...three.slice(0, 2)], r2, true, 'activation-epoch-changed'); refuse([...base, ...three, 'Elsewhere/fourth'], r2, true, 'activation-epoch-changed'); refuse([...base, ...three, three[0]], r2, true, 'activation-epoch-changed');
    for (const bad of [undefined, 'x', [1]]) assert.throws(() => assertRegistryMembership({ registryAgents: bad, release, afterActivation: false }), codeIs('live-probe-output'));
});
