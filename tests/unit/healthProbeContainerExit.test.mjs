import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runContainerScriptReadiness, __testHooks } from '../../cli/sandbox/docker/healthProbes.js';
import { inspectContainerState } from '../../cli/sandbox/docker/containerState.mjs';

const containerId = 'a'.repeat(64);
const containerName = 'exiting-probe-container';

function fixture(t, {
    claimed = false, firstResult = false, terminalAt = 0, inspectedState = 'exited',
    inspectPending, finalResult, controlPlaneFailureThreshold = 2,
} = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-probe-exit-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const controls = [];
    const inspections = [];
    let now = 0;
    return {
        controls,
        inspections,
        get elapsed() { return now; },
        run() {
            return runContainerScriptReadiness('fixture', containerName, {
                script: 'ready.sh', interval: 0.001, timeout: 0.01, failureThreshold: 3,
            }, {
                runtime: 'podman', probeControlHostRoot: root,
                tokenFactory: () => `probe-${controls.length + 1}`,
                killGraceSeconds: 0.001, probeClaimGraceMs: 100, probeResultGraceMs: 1,
                probeCancellationGraceMs: 30_000, controlPlaneFailureThreshold, controlPlaneRetryMs: 0,
                nowImpl: () => now,
                sleepMsImpl: milliseconds => { now += milliseconds; },
                spawnSyncImpl(runtime, args, options) {
                    assert.equal(runtime, 'podman');
                    inspections.push({ args, timeout: options.timeout });
                    if (inspections.length > 1 && inspectPending) return inspectPending(controls.at(-1), options);
                    const status = inspections.length === 1 || now < terminalAt ? 'running' : inspectedState;
                    return { status: 0, stdout: JSON.stringify([containerId, containerName, status]), stderr: '' };
                },
                submitProbeRequestImpl(control, probe, grace) {
                    __testHooks.submitProbeRequest(control, probe, grace);
                    controls.push(control);
                    if (firstResult && controls.length === 1) {
                        fs.writeFileSync(path.join(control.hostPath, 'result'), '1\n');
                    } else if (finalResult !== undefined) {
                        fs.writeFileSync(path.join(control.hostPath, 'result'), `${finalResult}\n`);
                    } else if (claimed) {
                        fs.mkdirSync(path.join(control.hostPath, 'claimed'));
                    }
                },
            });
        },
    };
}

for (const status of ['running', 'paused', 'restarting', 'stopping', 'created', 'unknown']) {
    test(`silent ${status} containers retain the exact cancellation requirement`, t => {
        const state = fixture(t, { claimed: true, inspectedState: status });
        assert.throws(() => state.run(), { code: 'PLOINKY_PROBE_EXECUTION_UNSAFE' });
        assert.equal(state.controls.length, 1);
        assert.equal(state.elapsed, 30_012);
        assert(fs.statSync(path.join(state.controls[0].hostPath, 'cancelled')).isDirectory());
        assert.equal(state.inspections.length, 4, 'recheck at most once per ten seconds');
    });
}

for (const [name, response] of [
    ['timeout', { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), status: null }],
    ['runtime error', { status: 125, stderr: 'runtime unavailable' }],
    ['missing original container', { status: 125, stderr: 'no such container' }],
    ['same-name replacement', { status: 0, stdout: JSON.stringify(['b'.repeat(64), containerName, 'exited']) }],
]) {
    test(`silent broker ${name} cannot prove an immutable exit`, t => {
        const state = fixture(t, { claimed: true, inspectPending: () => response });
        assert.throws(() => state.run(), { code: 'PLOINKY_PROBE_EXECUTION_UNSAFE' });
        assert.equal(state.controls.length, 1);
        assert(fs.statSync(path.join(state.controls[0].hostPath, 'request')).isFile());
        assert(fs.statSync(path.join(state.controls[0].hostPath, 'cancelled')).isDirectory());
    });
}

test('a broker result published during inspection precedes terminal-state classification', t => {
    const state = fixture(t, {
        claimed: true, controlPlaneFailureThreshold: 1,
        inspectPending(control) {
            fs.writeFileSync(path.join(control.hostPath, 'result'), '125\n');
            return { status: 0, stdout: JSON.stringify([containerId, containerName, 'exited']) };
        },
    });
    assert.throws(() => state.run(), error => {
        assert.equal(error.code, 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT');
        assert.match(error.message, /exceeded its bounded completion window/);
        return true;
    });
    assert.equal(fs.existsSync(state.controls[0].hostPath), false, 'acknowledged cancellation is retired normally');
});

test('responsive warming probes retain one exact runtime inspection', t => {
    const state = fixture(t, { firstResult: true, finalResult: 0 });
    assert.deepEqual(state.run(), { status: 'success', detail: '' });
    assert.equal(state.controls.length, 2);
    assert.equal(state.inspections.length, 1);
});

test('terminal-state inspection uses the original ID even if the container was renamed', t => {
    const state = fixture(t, { claimed: true, inspectPending: () => ({
        status: 0, stdout: JSON.stringify([containerId, 'renamed-original', 'exited']),
    }) });
    assert.deepEqual(state.run(), { status: 'failed', reason: 'container exited', detail: '' });
    assert.equal(state.inspections.at(-1).args.at(-1), containerId);
});

test('cancellation inspections are capped by the remaining grace period', t => {
    const state = fixture(t, { claimed: true, inspectedState: 'running' });
    assert.throws(() => state.run(), { code: 'PLOINKY_PROBE_EXECUTION_UNSAFE' });
    assert.deepEqual(state.inspections.map(value => value.timeout), [30_000, 30_000, 20_000, 10_000]);
});

for (const runtime of ['podman', 'docker']) {
    test(`${runtime} state inspection requests only identity and status`, () => {
        const value = inspectContainerState(containerName, { runtime, timeoutMs: 75,
            spawnSyncImpl(command, args, options) {
                assert.equal(command, runtime);
                assert.deepEqual(args, ['container', 'inspect', '--format',
                    runtime === 'podman' ? '[{{json .ID}},{{json .Name}},{{json .State.Status}}]'
                        : '[{{json .Id}},{{json .Name}},{{json .State.Status}}]', containerName]);
                assert.equal(options.timeout, 75);
                assert.equal(options.killSignal, 'SIGKILL');
                return { status: 0, stdout: JSON.stringify([containerId, '/' + containerName, 'running']) };
            },
        });
        assert.deepEqual(value, { id: containerId, name: containerName, status: 'running', runtime });
    });
}

for (const [name, response, code] of [
    ['short ID', { status: 0, stdout: JSON.stringify(['abc', containerName, 'exited']) }],
    ['wrong name', { status: 0, stdout: JSON.stringify([containerId, 'unrelated', 'exited']) }],
    ['unknown status', { status: 0, stdout: JSON.stringify([containerId, containerName, 'nonsense']) }],
    ['malformed output', { status: 0, stdout: '{' }],
    ['extra fields', { status: 0, stdout: JSON.stringify([containerId, containerName, 'exited', 'extra']) }],
    ['failed runtime', { status: 125, stderr: 'failure' }],
    ['timeout', { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }, 'PLOINKY_CONTAINER_CONTROL_PLANE_TIMEOUT'],
]) {
    test(`state inspection rejects ${name}`, () => {
        assert.throws(() => inspectContainerState(containerName, {
            runtime: 'podman', spawnSyncImpl: () => response,
        }), { code: code || 'PLOINKY_CONTAINER_CONTROL_PLANE_FAILED' });
    });
}

for (const [name, options, requests] of [
    ['exits after a failed response', { firstResult: true }, 2],
    ['exits before a broker claim', {}, 1],
    ['exits after a broker claim', { claimed: true }, 1],
    ['exits while awaiting cancellation', { claimed: true, terminalAt: 5_000 }, 1],
]) {
    test(`script readiness reports the exact container that ${name}`, t => {
        const state = fixture(t, options);
        assert.deepEqual(state.run(), { status: 'failed', reason: 'container exited', detail: '' });
        assert.equal(state.controls.length, requests, 'terminal evidence must prevent another request');
        assert(state.elapsed < 11_000, 'do not exhaust cancellation for a dead broker');
        const pending = state.controls.at(-1).hostPath;
        assert(fs.statSync(path.join(pending, 'cancelled')).isDirectory());
        assert(fs.statSync(path.join(pending, 'request')).isFile(), 'unacknowledged requests must remain cancelled');
        assert(state.inspections.slice(1).every(({ args }) => args.at(-1) === containerId));
    });
}
