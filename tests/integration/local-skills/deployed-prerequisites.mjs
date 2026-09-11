import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const optionalCommand = ['npm', 'run', 'test:optional-agents', '--', '--workers=1', '--retries=0'];
const optionalTitle = 'OnlyOffice, Scribe, and STT start disabled and can be enabled through Marketplace';
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const within = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

function required(env, name) {
    assert.ok(typeof env[name] === 'string' && env[name].trim(), `Set ${name}. See the local-skills README.`);
    return env[name];
}

async function directory(value, label) {
    assert.ok(typeof value === 'string' && path.isAbsolute(value), `${label} must be an absolute directory.`);
    try {
        const resolved = await fs.realpath(value);
        assert.ok((await fs.stat(resolved)).isDirectory());
        return resolved;
    } catch {
        throw new Error(`${label} must name an existing readable directory.`);
    }
}

function timestamp(value, label) {
    assert.ok(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
        && Number.isFinite(Date.parse(value)), `${label} must be a valid timestamp.`);
    return Date.parse(value);
}

async function inspectLiveBox(container) {
    let output;
    try {
        output = await execute('podman', ['inspect', container], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    } catch {
        throw new Error('Read-only Podman inspection failed. Check the configured Box and Podman connection.');
    }
    try {
        const entries = JSON.parse(output.stdout);
        assert.ok(Array.isArray(entries) && entries.length === 1);
        return entries[0];
    } catch {
        throw new Error('Podman did not return exactly one valid Box inspection.');
    }
}

// Safe metadata for operator receipts. Never return raw inspection, environment, or credentials.
export async function inspectDeploymentTarget({ env = process.env, inspectBox = inspectLiveBox } = {}) {
    const workspaceRoot = await directory(required(env, 'SMOKE_WORKSPACE_ROOT'), 'SMOKE_WORKSPACE_ROOT');
    let url;
    try { url = new URL(required(env, 'SMOKE_BASE_URL')); } catch { throw new Error('Set a valid SMOKE_BASE_URL.'); }
    assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port
        && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    'SMOKE_BASE_URL must be an exact credential-free HTTP loopback origin with an explicit port.');
    const container = required(env, 'SMOKE_PLOINKY_BOX_CONTAINER');
    assert.ok(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container), 'Use one exact Box name or ID.');
    const inspected = await inspectBox(container);
    assert.ok(/^[a-f0-9]{64}$/.test(inspected?.Id || '') && inspected?.State?.Running === true,
        'The selected Box must have a full immutable ID and be running.');
    const boxStartedAt = new Date(timestamp(inspected.State.StartedAt, 'Box start time')).toISOString();
    const mounts = (inspected.Mounts || []).filter(item => item.Destination === '/workspace');
    assert.ok(mounts.length === 1 && mounts[0].Type === 'bind' && mounts[0].RW === true,
        'The Box must have exactly one writable workspace bind mount.');
    assert.ok(await directory(mounts[0].Source, 'Box workspace source') === workspaceRoot,
        'The Box belongs to a different workspace.');
    const publication = { containerPort: '8080/tcp', hostIp: '127.0.0.1', hostPort: url.port };
    for (const ports of [inspected.NetworkSettings?.Ports, inspected.HostConfig?.PortBindings]) {
        const bindings = ports?.[publication.containerPort];
        assert.ok(Array.isArray(bindings) && bindings.length === 1
            && bindings[0].HostIp === publication.hostIp && bindings[0].HostPort === publication.hostPort,
        'The requested origin must match the Box live and configured loopback Router publication.');
    }
    return { boxId: inspected.Id, boxStartedAt, workspaceRoot, baseURL: url.origin, publication };
}

async function jsonFile(filename, label, maxBytes) {
    try {
        assert.ok((await fs.stat(filename)).size <= maxBytes);
        return JSON.parse(await fs.readFile(filename, 'utf8'));
    } catch {
        throw new Error(`${label} is missing, too large, or invalid JSON.`);
    }
}

function checkStats(stats, label) {
    assert.ok(stats?.expected === 1 && stats.skipped === 0 && stats.unexpected === 0 && stats.flaky === 0,
        `${label} must report exactly one pass and zero skips, failures, or flaky results.`);
    assert.ok(Number.isFinite(stats.duration) && stats.duration >= 0, `${label} duration is invalid.`);
    timestamp(stats.startTime, `${label} start time`);
}

function reportTests(suites) {
    assert.ok(Array.isArray(suites), 'Marketplace report suites are missing.');
    return suites.flatMap(suite => [
        ...(suite.specs || []).flatMap(spec => (spec.tests || []).map(test => ({ spec, test }))),
        ...reportTests(suite.suites || []),
    ]);
}

function checkReport(report, receipt, startedAt, finishedAt) {
    checkStats(report.stats, 'Marketplace report');
    assert.ok(same(receipt.stats, report.stats), 'Receipt statistics do not match the authoritative report.');
    assert.ok(Array.isArray(report.errors) && report.errors.length === 0, 'Marketplace report has errors.');
    assert.ok(report.config?.workers === 1 && report.config.projects?.length === 1,
        'Marketplace must run with one worker and one project.');
    const project = report.config.projects[0];
    assert.ok(project.name === 'chromium' && project.retries === 0 && project.repeatEach === 1,
        'Marketplace must use Chromium with no configured retries or repeats.');
    assert.ok(report.config.configFile === path.join(receipt.cwd, 'playwright.config.mjs')
        && report.config.rootDir === path.join(receipt.cwd, 'specs')
        && project.outputDir === path.join(receipt.directory, 'test-results'),
    'Marketplace report paths do not match its receipt.');
    const cases = reportTests(report.suites);
    assert.ok(cases.length === 1, 'Marketplace report must contain exactly one test.');
    const { spec, test } = cases[0];
    assert.ok(spec.file === '03-optional-agents.spec.mjs' && spec.title === optionalTitle && spec.ok === true,
        'The report is not the intended Marketplace activation test.');
    assert.ok(test.expectedStatus === 'passed' && test.status === 'expected' && test.projectName === 'chromium'
        && test.results?.length === 1, 'Marketplace must have one successful, unretried result.');
    const result = test.results[0];
    assert.ok(result.status === 'passed' && result.retry === 0 && result.errors?.length === 0,
        'Marketplace result failed, skipped, or retried.');
    const reportStart = timestamp(report.stats.startTime, 'Report start');
    const testStart = timestamp(result.startTime, 'Test start');
    assert.ok(Number.isFinite(result.duration) && result.duration >= 0
        && startedAt <= reportStart && reportStart <= testStart
        && testStart + result.duration <= reportStart + report.stats.duration
        && reportStart + report.stats.duration <= finishedAt,
    'Marketplace report timing does not fit the completed receipt.');
}

// This is deployment-test orchestration proof, not a product prerequisite for ordinary Copilot use.
export async function assertMarketplacePrerequisite({ env = process.env, inspectBox, now = Date.now() } = {}) {
    const requested = required(env, 'SMOKE_OPTIONAL_GATE_RECEIPT');
    assert.ok(path.isAbsolute(requested), 'SMOKE_OPTIONAL_GATE_RECEIPT must be an absolute run.json path.');
    const receipt = await jsonFile(requested, 'Marketplace receipt', 64 * 1024);
    assert.ok(receipt.gate === 'optional' && receipt.result === 'passed' && receipt.exitCode === 0,
        'Marketplace prerequisite is incomplete or failed. Complete it before this dependent browser check.');
    assert.ok(same(receipt.command, optionalCommand), 'Marketplace receipt must identify the canonical optional command.');
    const receiptDirectory = await directory(receipt.directory, 'Marketplace receipt directory');
    assert.ok(receipt.directory === receiptDirectory && receipt.runId === path.basename(receiptDirectory)
        && await fs.realpath(requested) === path.join(receiptDirectory, 'run.json'),
    'Marketplace receipt location does not match its run identity.');
    const smokeDirectory = await directory(receipt.cwd, 'Marketplace smoke directory');
    assert.ok(smokeDirectory === receipt.cwd && path.basename(smokeDirectory) === 'smoke'
        && path.basename(path.dirname(smokeDirectory)) === 'tests',
    'Marketplace must identify its canonical Explorer tests/smoke directory.');
    const startedAt = timestamp(receipt.startedAt, 'Receipt start');
    const finishedAt = timestamp(receipt.finishedAt, 'Receipt finish');
    assert.ok(Number.isFinite(now) && startedAt <= finishedAt && finishedAt <= now,
        'Marketplace prerequisite has incomplete or future timing.');
    checkStats(receipt.stats, 'Marketplace receipt');
    const reportPath = path.join(receiptDirectory, 'test-results', 'results.json');
    assert.ok(await fs.realpath(reportPath) === reportPath, 'Marketplace report must belong to the receipt directory.');
    const report = await jsonFile(reportPath, 'Marketplace report', 32 * 1024 * 1024);
    checkReport(report, receipt, startedAt, finishedAt);
    const target = await inspectDeploymentTarget({ env, inspectBox });
    for (const field of ['boxId', 'boxStartedAt', 'workspaceRoot', 'baseURL', 'publication']) {
        assert.ok(same(receipt[field], target[field]), `Marketplace receipt has a stale or different ${field}.`);
    }
    assert.ok(timestamp(target.boxStartedAt, 'Box start') <= startedAt,
        'The Box started after Marketplace began; rerun the workflow on the current generation.');
    assert.ok(within(target.workspaceRoot, smokeDirectory),
        'Marketplace must run from the selected fresh workspace.');
    return { ...target, receiptPath: path.join(receiptDirectory, 'run.json'), runId: receipt.runId,
        smokeDirectory, finishedAt: receipt.finishedAt, stats: { ...receipt.stats } };
}

export async function assertExplorerSmokeDirectory(repo, prerequisite) {
    const smoke = await directory(path.join(await directory(repo, 'SMOKE_EXPLORER_REPO'), 'tests', 'smoke'),
        'Explorer smoke directory');
    assert.ok(smoke === prerequisite.smokeDirectory,
        'SMOKE_EXPLORER_REPO must be the same fresh checkout used by the Marketplace prerequisite.');
    return smoke;
}

// Resolve symlinks before checking containment. Preflight never creates the requested directory.
export async function assertArtifactRoot(value, sourceRoots) {
    const artifactRoot = await directory(value, 'SMOKE_ARTIFACT_DIR');
    for (const root of sourceRoots) {
        assert.ok(!within(await directory(root, 'Source/workspace root'), artifactRoot),
            'SMOKE_ARTIFACT_DIR must be outside source trees and the deployed workspace.');
    }
    return artifactRoot;
}
