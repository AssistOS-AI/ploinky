import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertArtifactRoot, assertExplorerSmokeDirectory, assertMarketplacePrerequisite, inspectDeploymentTarget } from './deployed-prerequisites.mjs';

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deployed-prerequisite-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const artifacts = path.join(root, 'artifacts');
    const cwd = path.join(workspace, '.ploinky', 'repos', 'AchillesIDE', 'tests', 'smoke');
    const directory = path.join(artifacts, 'optional-run');
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(directory, 'test-results'), { recursive: true });
    const box = {
        Id: 'a'.repeat(64), State: { Running: true, StartedAt: '2026-09-10T13:00:00.000Z' },
        Mounts: [{ Type: 'bind', Source: workspace, Destination: '/workspace', RW: true }],
        NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] } },
        HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] } },
    };
    const stats = { startTime: '2026-09-10T13:01:01.000Z', duration: 3000,
        expected: 1, skipped: 0, unexpected: 0, flaky: 0 };
    const report = {
        stats: { ...stats }, errors: [],
        config: { workers: 1, configFile: path.join(cwd, 'playwright.config.mjs'), rootDir: path.join(cwd, 'specs'),
            projects: [{ name: 'chromium', retries: 0, repeatEach: 1, outputDir: path.join(directory, 'test-results') }] },
        suites: [{ specs: [], suites: [{ specs: [{
            file: '03-optional-agents.spec.mjs',
            title: 'OnlyOffice, Scribe, and STT start disabled and can be enabled through Marketplace', ok: true,
            tests: [{ projectName: 'chromium', expectedStatus: 'passed', status: 'expected', results: [{
                status: 'passed', retry: 0, errors: [], startTime: '2026-09-10T13:01:02.000Z', duration: 1000,
            }] }],
        }] }] }],
    };
    const receipt = { gate: 'optional', runId: 'optional-run', directory, cwd,
        command: ['npm', 'run', 'test:optional-agents', '--', '--workers=1', '--retries=0'],
        boxId: box.Id, boxStartedAt: box.State.StartedAt, workspaceRoot: workspace,
        baseURL: 'http://127.0.0.1:8080', publication: { containerPort: '8080/tcp', hostIp: '127.0.0.1', hostPort: '8080' },
        startedAt: '2026-09-10T13:01:00.000Z', finishedAt: '2026-09-10T13:01:05.000Z',
        result: 'passed', exitCode: 0, stats };
    const env = { SMOKE_WORKSPACE_ROOT: workspace, SMOKE_BASE_URL: receipt.baseURL,
        SMOKE_PLOINKY_BOX_CONTAINER: 'test-box', SMOKE_OPTIONAL_GATE_RECEIPT: path.join(directory, 'run.json') };
    const save = async () => {
        await fs.writeFile(env.SMOKE_OPTIONAL_GATE_RECEIPT, JSON.stringify(receipt));
        await fs.writeFile(path.join(directory, 'test-results', 'results.json'), JSON.stringify(report));
    };
    await save();
    const options = { env, inspectBox: async selected => {
        assert.equal(selected, 'test-box');
        return box;
    }, now: Date.parse('2026-09-10T13:02:00.000Z') };
    return { root, workspace, artifacts, cwd, box, report, receipt, env, options, save };
}

test('completed exact Marketplace proof returns only safe metadata for the current Box', async t => {
    const f = await fixture(t);
    f.box.Config = { Env: ['SECRET=must-not-appear'] };
    const target = await inspectDeploymentTarget(f.options);
    assert.deepEqual(Object.keys(target).sort(), ['baseURL', 'boxId', 'boxStartedAt', 'publication', 'workspaceRoot']);
    const proof = await assertMarketplacePrerequisite(f.options);
    assert.equal(proof.boxId, f.box.Id);
    assert.equal(proof.receiptPath, f.env.SMOKE_OPTIONAL_GATE_RECEIPT);
    assert.equal(proof.runId, f.receipt.runId);
    assert.equal(proof.workspaceRoot, f.workspace);
    assert.equal(JSON.stringify(proof).includes('must-not-appear'), false);
});

const invalidProofs = [
    ['in-progress receipt', f => { f.receipt.result = 'running'; delete f.receipt.finishedAt; }, /incomplete or failed/],
    ['failed receipt', f => { f.receipt.result = 'failed'; f.receipt.exitCode = 1; }, /incomplete or failed/],
    ['nonzero exit marked passed', f => { f.receipt.exitCode = 1; }, /incomplete or failed/],
    ['skipped test', f => { f.receipt.stats.skipped = 1; f.report.stats.skipped = 1; }, /zero skips/],
    ['unexpected failure', f => { f.report.stats.unexpected = 1; }, /zero skips/],
    ['flaky pass', f => { f.receipt.stats.flaky = 1; f.report.stats.flaky = 1; }, /zero skips/],
    ['report statistics mismatch', f => { f.report.stats.duration = 2999; }, /statistics do not match/],
    ['no discovered tests behind passing totals', f => { f.report.suites = []; }, /exactly one test/],
    ['different one-test gate', f => { f.report.suites[0].suites[0].specs[0].file = '05-copilot-folder-launch.spec.mjs'; }, /not the intended/],
    ['different Marketplace test', f => { f.report.suites[0].suites[0].specs[0].title = 'Setup succeeds'; }, /not the intended/],
    ['configured retries', f => { f.report.config.projects[0].retries = 1; }, /no configured retries/],
    ['actual retry hidden by totals', f => { f.report.suites[0].suites[0].specs[0].tests[0].results[0].retry = 1; }, /failed, skipped, or retried/],
    ['multiple attempts hidden by totals', f => { f.report.suites[0].suites[0].specs[0].tests[0].results.push({ status: 'passed' }); }, /unretried result/],
    ['authoritative result skipped', f => { f.report.suites[0].suites[0].specs[0].tests[0].results[0].status = 'skipped'; }, /failed, skipped, or retried/],
    ['report error hidden by totals', f => { f.report.errors.push({ message: 'failure' }); }, /report has errors/],
    ['report from different output directory', f => { f.report.config.projects[0].outputDir = '/another/run/test-results'; }, /paths do not match/],
    ['wrong Box', f => { f.box.Id = 'b'.repeat(64); }, /different boxId/],
    ['stopped Box', f => { f.box.State.Running = false; }, /must have a full immutable ID and be running/],
    ['restarted same Box', f => { f.box.State.StartedAt = '2026-09-10T13:01:50.000Z'; }, /different boxStartedAt/],
    ['Box start after gate start', f => { f.box.State.StartedAt = f.receipt.boxStartedAt = '2026-09-10T13:01:03.000Z'; }, /Box started after/],
    ['wrong workspace mount', f => { f.box.Mounts[0].Source = f.artifacts; }, /different workspace/],
    ['wrong receipt workspace', f => { f.receipt.workspaceRoot = f.artifacts; }, /different workspaceRoot/],
    ['wildcard Router publication', f => { f.box.NetworkSettings.Ports['8080/tcp'][0].HostIp = '0.0.0.0'; }, /loopback Router/],
    ['configured publication differs', f => { f.box.HostConfig.PortBindings['8080/tcp'][0].HostPort = '8089'; }, /loopback Router/],
    ['receipt publication differs', f => { f.receipt.publication.hostPort = '8089'; }, /different publication/],
    ['missing completion time', f => { delete f.receipt.finishedAt; }, /valid timestamp/],
    ['future completion time', f => { f.receipt.finishedAt = '2026-09-10T13:03:00.000Z'; }, /future timing/],
    ['invalid time', f => { f.receipt.startedAt = 'not-a-time'; }, /valid timestamp/],
    ['report belongs to an older invocation', f => { f.receipt.startedAt = '2026-09-10T13:01:03.000Z'; }, /timing does not fit/],
    ['missing report duration', f => { delete f.report.stats.duration; delete f.receipt.stats.duration; }, /duration is invalid/],
    ['legacy boolean guard without bound target', f => { delete f.receipt.boxStartedAt; }, /different boxStartedAt/],
];
for (const [name, change, expected] of invalidProofs) {
    test(`rejects ${name}`, async t => {
        const f = await fixture(t);
        change(f);
        await f.save();
        await assert.rejects(assertMarketplacePrerequisite(f.options), expected);
    });
}

test('missing receipt is an error before any Box inspection', async t => {
    const f = await fixture(t);
    await fs.unlink(f.env.SMOKE_OPTIONAL_GATE_RECEIPT);
    let inspected = false;
    await assert.rejects(assertMarketplacePrerequisite({ ...f.options,
        inspectBox: () => { inspected = true; } }), /receipt is missing/);
    assert.equal(inspected, false);
});

test('receipt cannot redirect its authoritative report outside its run directory', async t => {
    const f = await fixture(t);
    const reportPath = path.join(f.receipt.directory, 'test-results', 'results.json');
    const elsewhere = path.join(f.root, 'other-results.json');
    await fs.rename(reportPath, elsewhere);
    await fs.symlink(elsewhere, reportPath);
    await assert.rejects(assertMarketplacePrerequisite(f.options), /report must belong/);
});

test('explicit artifact output must exist outside sources, including through symlinks', async t => {
    const f = await fixture(t);
    assert.equal(await assertArtifactRoot(f.artifacts, [f.workspace]), f.artifacts);
    await assert.rejects(assertArtifactRoot(undefined, [f.workspace]), /absolute directory/);
    await assert.rejects(assertArtifactRoot(path.join(f.root, 'missing'), [f.workspace]), /existing readable directory/);
    await assert.rejects(assertArtifactRoot(f.cwd, [f.workspace]), /outside source trees/);
    const alias = path.join(f.artifacts, 'source-alias');
    await fs.symlink(f.cwd, alias);
    await assert.rejects(assertArtifactRoot(alias, [f.workspace]), /outside source trees/);
});

test('receipt cwd cannot escape its fixture through a lexical prefix or directory symlink', async t => {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.artifacts, 'tests', 'smoke'), { recursive: true });
    f.receipt.cwd = `${f.workspace}/../artifacts/tests/smoke`;
    await f.save();
    await assert.rejects(assertMarketplacePrerequisite(f.options), /canonical Explorer/);
    const alias = path.join(f.workspace, 'external');
    await fs.symlink(f.artifacts, alias);
    f.receipt.cwd = path.join(alias, 'tests', 'smoke');
    await f.save();
    await assert.rejects(assertMarketplacePrerequisite(f.options), /canonical Explorer/);
});

test('Settings must load the same canonical Explorer helpers as the successful Marketplace run', async t => {
    const f = await fixture(t);
    const proof = await assertMarketplacePrerequisite(f.options);
    const repo = path.dirname(path.dirname(f.cwd));
    assert.equal(await assertExplorerSmokeDirectory(repo, proof), f.cwd);
    const otherRepo = path.join(f.workspace, 'other-explorer');
    await fs.mkdir(path.join(otherRepo, 'tests', 'smoke'), { recursive: true });
    await assert.rejects(assertExplorerSmokeDirectory(otherRepo, proof), /same fresh checkout/);
    const alias = path.join(f.root, 'explorer-alias');
    await fs.symlink(repo, alias);
    assert.equal(await assertExplorerSmokeDirectory(alias, proof), f.cwd);
});

test('invalid prerequisite stops the real entrypoint before loading Playwright or creating fixture/output files', async t => {
    const f = await fixture(t);
    f.receipt.result = 'running';
    await f.save();
    const fakePackage = path.join(f.cwd, 'node_modules', '@playwright', 'test');
    await fs.mkdir(fakePackage, { recursive: true });
    const marker = path.join(f.root, 'browser-dependency-loaded');
    await fs.writeFile(path.join(f.cwd, 'package.json'), '{}');
    await fs.writeFile(path.join(fakePackage, 'index.js'),
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected'); throw new Error('Playwright loaded');`);
    const before = await fs.readdir(f.artifacts);
    const script = fileURLToPath(new URL('./deployed-settings.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script], { cwd: f.root, encoding: 'utf8', timeout: 10_000,
        env: { PATH: process.env.PATH, ...f.env, SMOKE_EXPLORER_REPO: path.dirname(path.dirname(f.cwd)),
            SMOKE_ARTIFACT_DIR: f.artifacts, SMOKE_USERNAME: 'fixture-user', SMOKE_PASSWORD: 'fixture-secret' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Marketplace prerequisite is incomplete or failed/);
    assert.equal(result.stderr.includes('fixture-secret'), false);
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(f.artifacts), before);
    assert.deepEqual(await fs.readdir(f.workspace), ['.ploinky']);
});
