// An update that changes any captured manifest stalls the previous start's
// no-wait workers: they are alive but cannot pass their lifecycle check, so a
// restart does not wait for them. One that already created its runtime left
// the next start a container with no registered ID ("preserved container ...
// not proven"), and a next start that kept its staged identity let it resume
// and replace runtimes behind that start. The worker here is the real
// noWaitWorker.js process bound to that identity; its runtime is created by
// the production ensureAgentService, and every engine call goes to the
// stateful fake engine behind the real exact-removal routine.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { installFakeEngine } from './dependencyStoreFakeEngine.mjs';
import { tempRoot } from './dependencyStoreFixtures.mjs';

const DRIVER = path.resolve(import.meta.dirname, 'noWaitRunSupersessionDriver.mjs');
const WORKER = path.resolve(import.meta.dirname, '../../cli/commands/noWaitWorker.js');
const CONTAINER = 'ploinky_repo_demo';
const MANIFEST = { container: 'node:20', start: 'node index.js', network: { mode: 'none' }, readiness: { protocol: 'none' } };
const DESTRUCTIVE = new Set(['create', 'start', 'kill', 'stop', 'rm', 'run']);

function workspace(t) {
    const root = fs.realpathSync(tempRoot(t, 'no-wait-supersession-'));
    const ws = path.join(root, 'ws');
    for (const name of ['demo', 'other']) {
        const dir = path.join(ws, '.ploinky', 'repos', 'repo', name);
        fs.mkdirSync(path.join(dir, 'code'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(MANIFEST));
        fs.writeFileSync(path.join(dir, 'code', 'index.js'), 'console.log(1)\n');
    }
    fs.mkdirSync(path.join(ws, '.ploinky', 'data'), { recursive: true });
    const engine = installFakeEngine(root, { engines: ['podman'] });
    const env = {
        ...process.env,
        ...engine.env,
        PLOINKY_WORKSPACE_ROOT: ws,
        PLOINKY_ROOT: ws,
        CONTAINER_RUNTIME: 'podman',
        HOME: path.join(root, 'home'),
        PLOINKY_AGENTLIB_FINGERPRINT: 'fixture-fingerprint',
        PLOINKY_AGENTLIB_MODE: 'local',
        PLOINKY_AGENTLIB_SOURCE_ID: 'd'.repeat(64),
        PLOINKY_ROUTER_HOST_PORT: '18080',
        PLOINKY_MEDIA_HOST_PORT: '17891',
        PLOINKY_NO_WAIT_EDGE_TIMEOUT_MS: '20000',
        PLOINKY_NO_WAIT_LIFECYCLE_LEASE_TIMEOUT_MS: '20000',
    };
    const drive = (phase, argument) => {
        const run = spawnSync(process.execPath, [DRIVER, phase, ...(argument ? [JSON.stringify(argument)] : [])], {
            cwd: ws, env, encoding: 'utf8', timeout: 120_000,
        });
        assert.equal(run.status, 0, `${phase}: ${run.stdout}\n${run.stderr}`);
        return JSON.parse(run.stdout.trim().split('\n').at(-1));
    };
    return { root, ws, engine, env, drive };
}

// The earlier start's worker for the staged demo identity, parked in its wave
// barrier until the test settles its producer.
async function earlierStartWorker(t, w, { agent = 'demo', executable = process.execPath } = {}) {
    const container = `ploinky_repo_${agent}`;
    const runId = randomUUID();
    const runStartedAtMs = Date.now();
    const noWaitDir = path.join(w.ws, '.ploinky', 'running', 'no-wait');
    fs.mkdirSync(noWaitDir, { recursive: true, mode: 0o700 });
    const barrier = path.join(noWaitDir, `ploinky_repo_producer.${runId}.json`);
    const settleProducer = (state) => fs.writeFileSync(barrier, JSON.stringify({
        runId, runStartedAtMs, waveIndex: 0, state, sequencePhase: 'active', sequencePhaseStartedAtMs: Date.now(), pid: process.pid,
    }), { mode: 0o600 });
    settleProducer('starting');
    const identity = {
        containerName: container, instanceId: `${agent}-instance`, enableGeneration: `${agent}-generation`,
        repoName: 'repo', shortAgent: agent, alias: '', routeKey: agent,
        runId, runStartedAtMs, waveIndex: 1, statusFile: `${container}.${runId}.json`,
    };
    fs.writeFileSync(path.join(noWaitDir, `${container}.current.json`),
        JSON.stringify({ createdAt: new Date().toISOString(), ...identity }), { mode: 0o600 });
    const statusPath = path.join(noWaitDir, identity.statusFile);
    const agentPath = path.join(w.ws, '.ploinky', 'repos', 'repo', agent);
    const child = spawn(executable, [
        WORKER,
        '--container', container, '--instance-id', identity.instanceId, '--enable-generation', identity.enableGeneration,
        '--short-agent', agent, '--repo', 'repo', '--alias', '', '--manifest-path', path.join(agentPath, 'manifest.json'),
        '--agent-path', agentPath, '--route-key', agent, '--run-id', runId, '--run-started-at-ms', String(runStartedAtMs),
        '--wave-index', '1', '--status-file', statusPath, '--profile', 'default',
        '--wait-for-statuses', JSON.stringify([{ path: barrier, runId, waveIndex: 0, directDependency: true }]),
    ], { cwd: w.ws, env: w.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await exited;
        }
    });
    const deadline = Date.now() + 30_000;
    while (!(fs.existsSync(statusPath) && JSON.parse(fs.readFileSync(statusPath, 'utf8')).sequencePhase === 'waiting-barrier')) {
        assert.equal(child.exitCode, null, `the earlier worker exited early: ${output}`);
        assert.ok(Date.now() < deadline, `the earlier worker never parked: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
        child, identity, exited, output: () => output,
        status: () => JSON.parse(fs.readFileSync(statusPath, 'utf8')),
        release: () => settleProducer('running'),
    };
}

function containers(w) {
    return Object.fromEntries(Object.values(w.engine.state().containers).map((c) => [c.Id, c.State.Status]));
}

function receiptInstances(w) {
    const dir = path.join(w.ws, '.ploinky', 'run', 'runtime-candidates');
    return fs.existsSync(dir)
        ? fs.readdirSync(dir).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).registryRecord.instanceId)
        : [];
}

function changeOtherManifest(w) {
    fs.writeFileSync(path.join(w.ws, '.ploinky', 'repos', 'repo', 'other', 'manifest.json'),
        JSON.stringify({ ...MANIFEST, start: 'node index.js --updated' }));
}

// Setup shared by every case: the earlier start committed, its worker created
// the runtime without publishing it, and the next update changed a manifest.
async function stalledEarlierWorker(t) {
    const w = workspace(t);
    assert.deepEqual(w.drive('setup'), { selector: 'active' });
    const ensured = w.drive('worker-ensure');
    assert.equal(ensured.registeredContainerId, null, 'the worker has not published its runtime');
    assert.equal(ensured.receipt, true);
    const worker = await earlierStartWorker(t, w);
    assert.equal(w.drive('inspect').inFlight.length, 1, 'with unchanged sources the worker is waited for');
    changeOtherManifest(w);
    const inspected = w.drive('inspect');
    assert.deepEqual(inspected.inFlight, [], 'a source change stalls it, so a restart does not wait');
    assert.deepEqual(inspected.live.map(({ containerName, pid, canProgress }) => ({ containerName, pid, canProgress })),
        [{ containerName: CONTAINER, pid: worker.child.pid, canProgress: false }]);
    return { w, worker, firstContainerId: ensured.containerId };
}

test('the next start supersedes a stalled earlier worker: its runtime is removed by exact ID and it can never resume', async (t) => {
    const { w, worker, firstContainerId } = await stalledEarlierWorker(t);
    const callsBefore = w.engine.calls().length;
    const next = w.drive('next-start', { runtimeCurrent: true });
    assert.equal(next.staged, true, JSON.stringify(next));
    assert.deepEqual(next.superseded, [{ containerName: CONTAINER, pid: worker.child.pid }]);
    assert.deepEqual(next.changedContainers, [CONTAINER]);
    assert.notEqual(next.record.instanceId, 'demo-instance', 'the stalled worker\'s staged identity rotated');
    assert.notEqual(next.record.enableGeneration, 'demo-generation');
    const removals = w.engine.calls().slice(callsBefore).filter(([command]) => command === 'rm');
    assert.deepEqual(removals, [['rm', '-f', firstContainerId]], 'only the worker\'s exact runtime was removed');
    assert.deepEqual(receiptInstances(w), [next.record.instanceId],
        'its launch receipt was retired with it; only the next launch\'s own receipt remains');
    assert.deepEqual(containers(w), { [next.launchedContainerId]: 'running' });

    // The earlier worker is released after the next start committed and
    // launched: it fails its own identity check and touches no runtime.
    const released = w.engine.calls().length;
    worker.release();
    assert.equal(await worker.exited, 1, worker.output());
    assert.equal(worker.status().state, 'failed');
    assert.match(worker.status().error.message, /requires the exact staged registry identity/);
    const workerCalls = w.engine.calls().slice(released).filter(([command]) => DESTRUCTIVE.has(command));
    assert.deepEqual(workerCalls, [], `the superseded worker issued no runtime mutation: ${JSON.stringify(workerCalls)}`);
    assert.deepEqual(containers(w), { [next.launchedContainerId]: 'running' }, 'the next start\'s runtime survives');
});

test('a live earlier worker that became able to progress after the settle is superseded too', async (t) => {
    // The restart's settle found nothing in flight; before the start took its
    // network lock a coordinated write made this worker's generation current
    // again. Under the start's locks it still cannot act, and it must not
    // resume once they are released.
    const w = workspace(t);
    w.drive('setup');
    const ensured = w.drive('worker-ensure');
    const worker = await earlierStartWorker(t, w);
    const inspected = w.drive('inspect');
    assert.deepEqual(inspected.live.map(({ pid, canProgress }) => ({ pid, canProgress })),
        [{ pid: worker.child.pid, canProgress: true }]);
    const callsBefore = w.engine.calls().length;
    const next = w.drive('next-start', { runtimeCurrent: true });
    assert.equal(next.staged, true, JSON.stringify(next));
    assert.deepEqual(next.superseded, [{ containerName: CONTAINER, pid: worker.child.pid }]);
    assert.notEqual(next.record.instanceId, 'demo-instance');
    assert.deepEqual(w.engine.calls().slice(callsBefore).filter(([command]) => command === 'rm'),
        [['rm', '-f', ensured.containerId]]);
    const released = w.engine.calls().length;
    worker.release();
    assert.equal(await worker.exited, 1, worker.output());
    assert.match(worker.status().error.message, /requires the exact staged registry identity/);
    assert.deepEqual(w.engine.calls().slice(released).filter(([command]) => DESTRUCTIVE.has(command)), []);
    assert.deepEqual(containers(w), { [next.launchedContainerId]: 'running' });
});

test('a genuine earlier worker launched through another Node executable path is superseded too', async (t) => {
    const w = workspace(t);
    w.drive('setup');
    const ensured = w.drive('worker-ensure');
    const alternateNode = path.join(w.root, 'node-alternate');
    fs.symlinkSync(process.execPath, alternateNode);
    const worker = await earlierStartWorker(t, w, { executable: alternateNode });
    assert.deepEqual(w.drive('inspect').live.map(({ pid }) => pid), [worker.child.pid],
        'the same run identity under another executable is still a live earlier worker');
    const callsBefore = w.engine.calls().length;
    const next = w.drive('next-start', { runtimeCurrent: true });
    assert.equal(next.staged, true, JSON.stringify(next));
    assert.deepEqual(next.superseded, [{ containerName: CONTAINER, pid: worker.child.pid }]);
    assert.notEqual(next.record.instanceId, 'demo-instance');
    assert.deepEqual(w.engine.calls().slice(callsBefore).filter(([command]) => command === 'rm'),
        [['rm', '-f', ensured.containerId]]);
    const released = w.engine.calls().length;
    worker.release();
    assert.equal(await worker.exited, 1, worker.output());
    assert.match(worker.status().error.message, /requires the exact staged registry identity/);
    assert.deepEqual(w.engine.calls().slice(released).filter(([command]) => DESTRUCTIVE.has(command)), []);
    assert.deepEqual(containers(w), { [next.launchedContainerId]: 'running' });
});

test('an earlier worker of an enabled agent outside the start\'s graph is superseded too', async (t) => {
    // `other` is enabled but not a dependency of the static `demo` graph: the
    // start stages it as an additional node, so its worker is matched as well.
    const w = workspace(t);
    w.drive('setup');
    const worker = await earlierStartWorker(t, w, { agent: 'other' });
    const next = w.drive('next-start', { runtimeCurrent: true });
    assert.equal(next.staged, true, JSON.stringify(next));
    assert.deepEqual(next.superseded, [{ containerName: 'ploinky_repo_other', pid: worker.child.pid }]);
    assert.deepEqual(next.changedContainers, ['ploinky_repo_other']);
    assert.notEqual(next.otherRecord.instanceId, 'other-instance', 'the out-of-graph identity rotated');
    assert.equal(next.record.instanceId, 'demo-instance', 'the unrelated in-graph identity is kept');
    worker.release();
    assert.equal(await worker.exited, 1, worker.output());
    assert.match(worker.status().error.message, /requires the exact staged registry identity/);
});

test('an unpublished predecessor that is already gone leaves no launch receipt behind', async (t) => {
    const w = workspace(t);
    w.drive('setup');
    const ensured = w.drive('worker-ensure');
    const staged = JSON.parse(fs.readFileSync(path.join(w.ws, '.ploinky', 'agents.json'), 'utf8'))[CONTAINER];
    assert.deepEqual(receiptInstances(w), ['demo-instance']);
    const removed = spawnSync('podman', ['rm', '-f', ensured.containerId], { env: w.env, encoding: 'utf8' });
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(containers(w), {});
    const result = w.drive('remove-predecessor', { record: staged });
    assert.deepEqual(result.removed, { removed: false, state: 'absent' });
    assert.deepEqual(receiptInstances(w), [], 'the receipt of the provably absent runtime is retired');
});

test('without a stalled earlier worker the same next start keeps the staged identity', async (t) => {
    const w = workspace(t);
    w.drive('setup');
    w.drive('worker-ensure');
    changeOtherManifest(w);
    assert.deepEqual(w.drive('inspect'), { inFlight: [], live: [] }, 'no earlier worker is alive');
    const next = w.drive('next-start', { runtimeCurrent: true });
    assert.equal(next.staged, true, JSON.stringify(next));
    assert.deepEqual(next.superseded, []);
    assert.deepEqual(next.changedContainers, [], 'nothing forces a replacement');
    assert.equal(next.record.instanceId, 'demo-instance', 'so only supersession rotates the identity');
    assert.equal(next.record.enableGeneration, 'demo-generation');
});

test('an unpublished predecessor is removed only on its exact launch identity, with or without its receipt', async (t) => {
    const w = workspace(t);
    w.drive('setup');
    const ensured = w.drive('worker-ensure');
    const staged = JSON.parse(fs.readFileSync(path.join(w.ws, '.ploinky', 'agents.json'), 'utf8'))[CONTAINER];

    // A different staged identity never authorizes removal, even by name.
    const foreign = w.drive('remove-predecessor', { record: { ...staged, instanceId: 'another-instance' } });
    assert.match(foreign.refused, /preserved container 'ploinky_repo_demo' because exact immutable ownership\/removal was not proven/);
    assert.deepEqual(containers(w), { [ensured.containerId]: 'running' });

    // Without the launch receipt the container's own labels and launch
    // environment must prove the exact staged identity.
    fs.rmSync(path.join(w.ws, '.ploinky', 'run', 'runtime-candidates'), { recursive: true, force: true });
    const recovered = w.drive('remove-predecessor', { record: staged });
    assert.equal(recovered.removed?.removed, true, JSON.stringify(recovered));
    assert.equal(recovered.removed.containerId, ensured.containerId);
    assert.deepEqual(containers(w), {});
});
