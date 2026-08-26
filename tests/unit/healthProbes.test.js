import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const module = await import('../../cli/sandbox/docker/healthProbes.js');
const {
    clearLivenessState,
    runHealthProbes,
    __testHooks,
    __testConstants,
} = module;
const {
    coercePositiveNumber,
    coercePositiveInteger,
    validateScriptName,
    normalizeProbeConfig,
    runContainerScriptReadiness,
    healthProbeHostDir,
    prepareHealthProbeHostDirForLaunch,
    submitProbeRequest,
    computeBackoffDelay,
    maybeResetBackoff,
    getLivenessState
} = __testHooks;
const {
    DEFAULT_INTERVAL_SECONDS,
    DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_FAILURE_THRESHOLD,
    DEFAULT_SUCCESS_THRESHOLD,
    BACKOFF_BASE_DELAY_MS,
    BACKOFF_MAX_DELAY_MS,
    BACKOFF_RESET_MS
} = __testConstants;

const containerName = 'test_container_health';

function resetContainerState() {
    clearLivenessState(containerName);
}

test('coercers fall back on invalid input', () => {
    assert.equal(coercePositiveNumber(-5, 10), 10);
    assert.equal(coercePositiveNumber('abc', 7), 7);
    assert.equal(coercePositiveNumber(3.5, 10), 3.5);

    assert.equal(coercePositiveInteger(-1, 4), 4);
    assert.equal(coercePositiveInteger('bad', 2), 2);
    assert.equal(coercePositiveInteger(6.9, 3), 6);
});

test('validateScriptName enforces agent-root scripts', () => {
    assert.equal(validateScriptName('liveness', 'check.sh'), 'check.sh');
    assert.throws(() => validateScriptName('liveness', '../evil.sh'));
    assert.throws(() => validateScriptName('readiness', 'nested/check.sh'));
    assert.throws(() => validateScriptName('readiness', 'nested\\check.sh'));
});

test('launch preparation retires only exact fixed broker artifacts', async (t) => {
    const root = fs.mkdtempSync('/tmp/ploinky-probe-launch-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const name = 'agent-runtime-replacement';
    const control = path.join(root, name);
    fs.mkdirSync(path.join(control, '.broker-ready'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(
        path.join(control, '.runtime-relay-ready-123e4567-e89b-42d3-a456-426614174000'),
        { mode: 0o700 },
    );
    const preservedRequest = path.join(control, 'probe-request-token');
    fs.mkdirSync(preservedRequest, { mode: 0o700 });
    fs.writeFileSync(path.join(preservedRequest, 'request'), 'preserve-me');

    const socketPath = path.join(control, 'runtime-relay.sock');
    const server = net.createServer();
    let serverClosed = false;
    t.after(() => {
        if (!serverClosed) server.close();
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });

    assert.equal(prepareHealthProbeHostDirForLaunch(name, {
        probeControlHostRoot: root,
    }), control);
    assert.equal(fs.existsSync(path.join(control, '.broker-ready')), false);
    assert.equal(
        fs.existsSync(path.join(control, '.runtime-relay-ready-123e4567-e89b-42d3-a456-426614174000')),
        false,
    );
    assert.equal(fs.existsSync(socketPath), false);
    assert.equal(fs.readFileSync(path.join(preservedRequest, 'request'), 'utf8'), 'preserve-me');
    await new Promise(resolve => server.close(resolve));
    serverClosed = true;
});

test('launch preparation fails closed on a substituted relay socket', (t) => {
    const root = fs.mkdtempSync('/tmp/ploinky-probe-substitution-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const name = 'agent-runtime-substitution';
    const control = path.join(root, name);
    fs.mkdirSync(control, { recursive: true, mode: 0o700 });
    const substituted = path.join(control, 'runtime-relay.sock');
    fs.writeFileSync(substituted, 'not-a-socket');

    assert.throws(() => prepareHealthProbeHostDirForLaunch(name, {
        probeControlHostRoot: root,
    }), /socket identity is invalid/);
    assert.equal(fs.readFileSync(substituted, 'utf8'), 'not-a-socket');
});

test('health-probe control preparation rejects a substituted container directory', (t) => {
    const root = fs.mkdtempSync('/tmp/ploinky-probe-control-substitution-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outside = fs.mkdtempSync('/tmp/ploinky-probe-control-outside-');
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const name = 'agent-control-substitution';
    fs.symlinkSync(outside, path.join(root, name), 'dir');

    assert.throws(() => prepareHealthProbeHostDirForLaunch(name, {
        probeControlHostRoot: root,
    }), /control directory identity is invalid/);
});

test('normalizeProbeConfig applies defaults and ignores missing scripts', () => {
    const missing = normalizeProbeConfig('liveness', {});
    assert.equal(missing, null);

    const cfg = normalizeProbeConfig('liveness', { script: 'probe.sh' });
    assert.ok(cfg);
    assert.equal(cfg.script, 'probe.sh');
    assert.equal(cfg.interval, DEFAULT_INTERVAL_SECONDS);
    assert.equal(cfg.timeout, DEFAULT_TIMEOUT_SECONDS);
    assert.equal(cfg.failureThreshold, DEFAULT_FAILURE_THRESHOLD);
    assert.equal(cfg.successThreshold, DEFAULT_SUCCESS_THRESHOLD);
    assert.equal(cfg.continuous, true);

    const activationOnly = normalizeProbeConfig('readiness', {
        script: 'probe.sh',
        continuous: false,
    });
    assert.equal(activationOnly.continuous, false);
});

test('computeBackoffDelay doubles until capped', () => {
    const state = { retryCount: 0 };
    const observed = [];
    for (let i = 0; i < 6; i++) {
        state.retryCount = i;
        observed.push(computeBackoffDelay(state));
    }

    assert.equal(observed[0], BACKOFF_BASE_DELAY_MS);
    assert.equal(observed[1], BACKOFF_BASE_DELAY_MS * 2);
    assert.equal(observed[2], BACKOFF_BASE_DELAY_MS * 4);
    assert.equal(observed.at(-1), Math.min(BACKOFF_BASE_DELAY_MS * (2 ** 5), BACKOFF_MAX_DELAY_MS));

    state.retryCount = 20;
    assert.equal(computeBackoffDelay(state), BACKOFF_MAX_DELAY_MS);
});

test('maybeResetBackoff resets after sustained uptime', () => {
    resetContainerState();
    const state = getLivenessState(containerName);
    state.retryCount = 3;
    state.startedAt = Date.now() - BACKOFF_RESET_MS - 1000;

    maybeResetBackoff('agentA', state);
    assert.equal(state.retryCount, 0);

    state.retryCount = 2;
    state.startedAt = Date.now();
    maybeResetBackoff('agentA', state);
    assert.equal(state.retryCount, 2);
});

test('clearLivenessState fully resets container tracking', () => {
    resetContainerState();
    const state = getLivenessState(containerName);
    state.retryCount = 5;
    state.startedAt = 123;

    clearLivenessState(containerName);
    const reset = getLivenessState(containerName);
    assert.equal(reset.retryCount, 0);
    assert.equal(reset.startedAt, null);
});

function fakeBrokerSequence(results, calls) {
    return (control, probe, killGraceSeconds) => {
        submitProbeRequest(control, probe, killGraceSeconds);
        calls.push({
            control,
            probe,
            killGraceSeconds,
            request: fs.readFileSync(path.join(control.hostPath, 'request'), 'utf8'),
        });
        const result = results.shift() || { status: 0, stdout: 'ready\n', stderr: '' };
        const writeResult = (value) => {
            if (value.stdout) fs.writeFileSync(path.join(control.hostPath, 'probe-stdout'), value.stdout);
            if (value.stderr) fs.writeFileSync(path.join(control.hostPath, 'probe-stderr'), value.stderr);
            fs.writeFileSync(path.join(control.hostPath, 'result'), `${value.status}\n`);
        };
        if (result.claimed) fs.mkdirSync(path.join(control.hostPath, 'claimed'));
        if (Object.hasOwn(result, 'cancellationStatus')) {
            writeResult({
                status: result.cancellationStatus,
                stdout: result.cancellationStdout || '',
                stderr: result.cancellationStderr || '',
            });
        }
        if (result.noResult) return;
        if (result.error) throw result.error;
        writeResult(result);
    };
}

test('blocking container script readiness succeeds after the configured success threshold', () => {
    const calls = [];
    const result = runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        interval: 0.001,
        timeout: 2,
        failureThreshold: 3,
        successThreshold: 2,
    }, {
        runtime: 'fake-runtime',
        tokenFactory: (() => {
            let sequence = 0;
            return () => `success-${sequence += 1}`;
        })(),
        submitProbeRequestImpl: fakeBrokerSequence([
            { status: 0, stdout: 'warming\n', stderr: '' },
            { status: 0, stdout: 'ready\n', stderr: '' },
        ], calls),
        sleepMsImpl() {},
        isContainerRunningImpl() { return true; },
    });

    assert.equal(result.status, 'success');
    assert.equal(result.detail, 'ready');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].control.token, 'success-1');
    assert.equal(calls[0].probe.script, 'healthcheck.sh');
    assert.equal(calls[0].killGraceSeconds, 1);
    assert.equal(calls[0].request, [
        'ploinky-health-probe/1',
        'success-1',
        'healthcheck.sh',
        '2',
        '1',
        '',
    ].join('\n'));
});

test('blocking container script readiness reports nonzero exhaustion', () => {
    const calls = [];
    const result = runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        interval: 0.001,
        timeout: 1,
        failureThreshold: 2,
    }, {
        runtime: 'fake-runtime',
        submitProbeRequestImpl: fakeBrokerSequence([
            { status: 9, stdout: '', stderr: 'not ready\n' },
            { status: 9, stdout: '', stderr: 'still not ready\n' },
        ], calls),
        sleepMsImpl() {},
        isContainerRunningImpl() { return true; },
    });

    assert.deepEqual(result, {
        status: 'failed',
        reason: 'exit 9',
        detail: 'still not ready',
    });
});

test('blocking container script readiness reports the in-container hard deadline', () => {
    const calls = [];
    const result = runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        timeout: 0.01,
        failureThreshold: 1,
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => 'inner-timeout',
        submitProbeRequestImpl: fakeBrokerSequence([
            { status: 124, stdout: '', stderr: '' },
        ], calls),
        sleepMsImpl() {},
        isContainerRunningImpl() { return true; },
    });

    assert.deepEqual(result, { status: 'failed', reason: 'timeout', detail: '' });
    assert.equal(calls.length, 1, 'the mounted broker publishes one terminal result');
});

test('probe identity rejects unsafe generated tokens before runtime execution', () => {
    const calls = [];
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        timeout: 1,
        failureThreshold: 1,
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => 'unsafe token; touch /tmp/escaped',
        submitProbeRequestImpl: fakeBrokerSequence([], calls),
        isContainerRunningImpl() { return true; },
    }), /generated probe token is invalid/);
    assert.equal(calls.length, 0, 'unsafe identity must be rejected before runtime execution');
});

test('an unclaimed mounted request retries without any runtime exec', () => {
    const calls = [];
    const retrySleeps = [];
    let now = 0;
    let tokenSequence = 0;
    const result = runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        timeout: 0.01,
        failureThreshold: 1,
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => `outer-timeout-${tokenSequence += 1}`,
        submitProbeRequestImpl: fakeBrokerSequence([
            { noResult: true },
            { status: 0, stdout: 'ready\n', stderr: '' },
        ], calls),
        probeResultGraceMs: 1,
        probeCancellationGraceMs: 1,
        controlPlaneRetryMs: 17,
        nowImpl() { return now; },
        sleepMsImpl(ms) {
            now += ms;
            retrySleeps.push(ms);
        },
        isContainerRunningImpl() { return true; },
    });
    assert.deepEqual(result, { status: 'success', detail: 'ready' });
    assert.equal(retrySleeps.includes(17), true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].control.token, 'outer-timeout-1');
    assert.equal(calls[1].control.token, 'outer-timeout-2');
    assert.equal(
        fs.statSync(path.join(calls[0].control.hostPath, 'cancelled')).isDirectory(),
        true,
        'a late broker claimant must still observe exact cancellation',
    );
    fs.rmSync(calls[0].control.hostPath, { recursive: true, force: true });
});

test('the execution deadline begins only after a delayed broker claim', () => {
    let now = 0;
    let controlPath = '';
    let cancellationObserved = false;
    const result = runContainerScriptReadiness('onlyOffice', 'onlyoffice-container', {
        script: 'healthcheck.sh',
        timeout: 0.01,
        failureThreshold: 1,
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => 'delayed-broker-claim',
        killGraceSeconds: 0.01,
        probeClaimGraceMs: 100,
        probeResultGraceMs: 1,
        probeCancellationGraceMs: 1,
        submitProbeRequestImpl(control, probe, killGraceSeconds) {
            submitProbeRequest(control, probe, killGraceSeconds);
            controlPath = control.hostPath;
        },
        nowImpl() { return now; },
        sleepMsImpl(ms) {
            now += ms;
            if (fs.existsSync(path.join(controlPath, 'cancelled'))) {
                cancellationObserved = true;
            }
            if (now >= 50 && !fs.existsSync(path.join(controlPath, 'claimed'))) {
                fs.mkdirSync(path.join(controlPath, 'claimed'));
            }
            if (now >= 60
                && !cancellationObserved
                && !fs.existsSync(path.join(controlPath, 'result'))) {
                fs.writeFileSync(path.join(controlPath, 'probe-stdout'), 'ready after claim\n');
                fs.writeFileSync(path.join(controlPath, 'result'), '0\n');
            }
        },
        isContainerRunningImpl() { return true; },
    });

    assert.deepEqual(result, { status: 'success', detail: 'ready after claim' });
    assert.equal(cancellationObserved, false);
    assert.equal(fs.existsSync(controlPath), false, 'a completed request must be retired');
});

test('a claimed mounted request without cancellation acknowledgement fails closed', () => {
    const calls = [];
    let now = 0;
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        timeout: 0.01,
        failureThreshold: 1,
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => 'unacknowledged-request',
        submitProbeRequestImpl: fakeBrokerSequence([
            { noResult: true, claimed: true },
        ], calls),
        probeResultGraceMs: 1,
        probeCancellationGraceMs: 5,
        nowImpl() { return now; },
        sleepMsImpl(ms) { now += ms; },
        isContainerRunningImpl() { return true; },
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_PROBE_EXECUTION_UNSAFE');
        assert.match(error.message, /claimed 'healthcheck\.sh' but did not acknowledge exact cancellation/);
        return true;
    });
    assert.equal(calls.length, 1);
    fs.rmSync(
        path.join(healthProbeHostDir('database-container'), 'unacknowledged-request'),
        { recursive: true, force: true },
    );
});

test('a mounted cancellation acknowledgement permits a bounded broker retry', () => {
    const calls = [];
    let now = 0;
    let firstControlPath = '';
    let submissionCount = 0;
    let tokenSequence = 0;
    const result = runContainerScriptReadiness('onlyOffice', 'onlyoffice-container', {
        script: 'healthcheck.sh',
        timeout: 5,
        failureThreshold: 180,
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => `onlyoffice-${tokenSequence += 1}`,
        submitProbeRequestImpl(control, probe, killGraceSeconds) {
            submitProbeRequest(control, probe, killGraceSeconds);
            calls.push({ control, probe, killGraceSeconds });
            submissionCount += 1;
            if (submissionCount === 1) {
                firstControlPath = control.hostPath;
                fs.mkdirSync(path.join(control.hostPath, 'claimed'));
            } else {
                fs.writeFileSync(path.join(control.hostPath, 'probe-stdout'), 'ready\n');
                fs.writeFileSync(path.join(control.hostPath, 'result'), '0\n');
            }
        },
        probeResultGraceMs: 1,
        probeCancellationGraceMs: 10,
        controlPlaneRetryMs: 23,
        nowImpl() { return now; },
        sleepMsImpl(ms) {
            now += ms;
            if (firstControlPath
                && fs.existsSync(path.join(firstControlPath, 'cancelled'))
                && !fs.existsSync(path.join(firstControlPath, 'result'))) {
                fs.writeFileSync(path.join(firstControlPath, 'result'), '125\n');
            }
        },
        isContainerRunningImpl() { return true; },
    });

    assert.deepEqual(result, { status: 'success', detail: 'ready' });
    assert.equal(calls.length, 2);
});

test('mounted broker control-plane retries remain bounded after cancellation acknowledgements', () => {
    const calls = [];
    let now = 0;
    let tokenSequence = 0;
    assert.throws(() => runContainerScriptReadiness('onlyOffice', 'onlyoffice-container', {
        script: 'healthcheck.sh',
        timeout: 5,
        failureThreshold: 180,
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => `bounded-${tokenSequence += 1}`,
        submitProbeRequestImpl(control, probe, killGraceSeconds) {
            submitProbeRequest(control, probe, killGraceSeconds);
            calls.push(control);
            fs.mkdirSync(path.join(control.hostPath, 'claimed'));
        },
        controlPlaneFailureThreshold: 2,
        controlPlaneRetryMs: 0,
        probeResultGraceMs: 1,
        probeCancellationGraceMs: 1,
        nowImpl() { return now; },
        sleepMsImpl(ms) {
            now += ms;
            for (const control of calls) {
                if (fs.existsSync(path.join(control.hostPath, 'cancelled'))
                    && !fs.existsSync(path.join(control.hostPath, 'result'))) {
                    fs.writeFileSync(path.join(control.hostPath, 'result'), '125\n');
                }
            }
        },
        isContainerRunningImpl() { return true; },
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT');
        assert.match(error.message, /bounded completion window/);
        return true;
    });
    assert.equal(calls.length, 2);
});

test('mounted request submission errors surface without a runtime fallback', () => {
    const clientError = new Error('mounted request failed');
    clientError.code = 'EIO';
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        timeout: 0.01,
        failureThreshold: 1,
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => 'client-error',
        submitProbeRequestImpl() { throw clientError; },
        isContainerRunningImpl() { return true; },
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_PROBE_CONTROL_PLANE_FAILED');
        assert.match(error.message, /failed to submit 'healthcheck\.sh' to its mounted broker/);
        assert.equal(error.cause, clientError);
        return true;
    });
});

test('reserved runner cleanup failure is fatal and cannot enter the retry loop', () => {
    const calls = [];
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        interval: 0.001,
        timeout: 1,
        failureThreshold: 180,
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => 'runner-cleanup-failure',
        submitProbeRequestImpl: fakeBrokerSequence([
            {
                status: 125,
                stdout: '',
                stderr: 'exact probe descendants survived cleanup',
            },
        ], calls),
        sleepMsImpl() {
            assert.fail('unsafe cleanup must not be retried');
        },
        isContainerRunningImpl() { return true; },
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_PROBE_EXECUTION_UNSAFE');
        assert.match(error.message, /descendants survived cleanup/);
        return true;
    });
    assert.equal(calls.length, 1, 'one mounted request is the only control operation');
});

test('blocking container script readiness fails fast when the script is missing', () => {
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'missing.sh',
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => 'missing-script',
        submitProbeRequestImpl: fakeBrokerSequence([{ status: 127 }], []),
        isContainerRunningImpl() { return true; },
    }), /missing\.sh not found inside container/);
});

test('a malformed mounted result fails closed immediately', () => {
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => 'malformed-result',
        submitProbeRequestImpl(control, probe, killGraceSeconds) {
            submitProbeRequest(control, probe, killGraceSeconds);
            fs.writeFileSync(path.join(control.hostPath, 'result'), 'not-a-status\n');
        },
        isContainerRunningImpl() { return true; },
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_PROBE_EXECUTION_UNSAFE');
        assert.match(error.message, /invalid mounted-broker probe result/);
        return true;
    });
    fs.rmSync(
        path.join(healthProbeHostDir('database-container'), 'malformed-result'),
        { recursive: true, force: true },
    );
});

test('blocking container script readiness fails immediately after the container exits', () => {
    const calls = [];
    const result = runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        interval: 30,
        failureThreshold: 60,
    }, {
        runtime: 'fake-runtime',
        submitProbeRequestImpl: fakeBrokerSequence([], calls),
        isContainerRunningImpl() { return false; },
        sleepMsImpl() {
            assert.fail('an exited container must not consume another probe interval');
        },
    });

    assert.deepEqual(result, {
        status: 'failed',
        reason: 'container exited',
        detail: '',
    });
    assert.equal(calls.length, 0, 'an exited container must not launch a probe');
});

test('container running-state timeout remains a retryable probe control-plane failure', () => {
    const timeout = new Error('podman inventory timed out');
    timeout.code = 'PLOINKY_CONTAINER_CONTROL_PLANE_TIMEOUT';
    let attempts = 0;
    const retrySleeps = [];
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
    }, {
        runtime: 'fake-runtime',
        submitProbeRequestImpl: fakeBrokerSequence([], []),
        isContainerRunningImpl() {
            attempts += 1;
            throw timeout;
        },
        controlPlaneRetryMs: 17,
        sleepMsImpl(delayMs) { retrySleeps.push(delayMs); },
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT');
        assert.match(error.message, /podman inventory timed out/);
        return true;
    });
    assert.equal(attempts, 3);
    assert.deepEqual(retrySleeps, [17, 17]);
});

test('blocking readiness maps a typed container timeout to a typed probe timeout', () => {
    const timeout = new Error('podman inspect timed out');
    timeout.code = 'PLOINKY_CONTAINER_CONTROL_PLANE_TIMEOUT';
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
    }, {
        runtime: 'fake-runtime',
        isContainerRunningImpl() { throw timeout; },
        controlPlaneFailureThreshold: 1,
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT');
        assert.match(error.message, /inspect container running state/);
        return true;
    });
});

test('script readiness proves container state once instead of amplifying runtime inventory', () => {
    const calls = [];
    let stateInspections = 0;
    const result = runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        interval: 1,
        successThreshold: 1,
        failureThreshold: 3,
    }, {
        tokenFactory: (() => {
            let sequence = 0;
            return () => `single-state-${sequence += 1}`;
        })(),
        submitProbeRequestImpl: fakeBrokerSequence([
            { status: 9, stderr: 'warming\n' },
            { status: 0, stdout: 'ready\n' },
        ], calls),
        isContainerRunningImpl() {
            stateInspections += 1;
            return true;
        },
        sleepMsImpl() {},
    });

    assert.deepEqual(result, { status: 'success', detail: 'ready' });
    assert.equal(calls.length, 2);
    assert.equal(stateInspections, 1);
});

test('initial container wait timeout remains a retryable probe control-plane failure', () => {
    const timeout = new Error('podman inspect timed out');
    timeout.code = 'PLOINKY_CONTAINER_CONTROL_PLANE_TIMEOUT';
    assert.throws(() => runHealthProbes('database', 'database-container', {}, {
        waitForContainerRunningImpl() { throw timeout; },
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT');
        assert.match(error.message, /podman inspect timed out/);
        return true;
    });
});

test('blocking readiness preserves a typed running-state control-plane timeout', () => {
    const calls = [];
    const timeout = new Error('podman ps timed out');
    timeout.code = 'ETIMEDOUT';
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
    }, {
        submitProbeRequestImpl: fakeBrokerSequence([], calls),
        isContainerRunningImpl() { throw timeout; },
        controlPlaneFailureThreshold: 1,
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT');
        assert.match(error.message, /inspect container running state/);
        return true;
    });
    assert.equal(calls.length, 0, 'a failed running-state check must not submit a probe');
});

test('continuous health preserves a typed startup-state control-plane timeout', () => {
    const timeout = new Error('podman inspect timed out');
    timeout.code = 'ETIMEDOUT';
    assert.throws(() => runHealthProbes('webtty', 'webtty-container', {}, {
        waitForContainerRunningImpl() { throw timeout; },
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT');
        assert.match(error.message, /inspect container startup state/);
        return true;
    });
});

test('continuous health runs cheap liveness while activation-only readiness stays skipped', () => {
    const calls = [];
    runHealthProbes('onlyOffice', 'onlyoffice-container', {
        health: {
            liveness: {
                script: 'liveness.sh',
                timeout: 2,
                failureThreshold: 1,
            },
            readiness: {
                script: 'healthcheck.sh',
                timeout: 5,
                failureThreshold: 180,
                continuous: false,
            },
        },
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => 'liveness-only',
        waitForContainerRunningImpl() { return true; },
        isContainerRunningImpl() { return true; },
        submitProbeRequestImpl: fakeBrokerSequence([
            { status: 0, stdout: 'live\n', stderr: '' },
        ], calls),
    });

    const executedScripts = calls.map(({ probe }) => probe.script);
    assert.deepEqual(executedScripts, ['liveness.sh']);
    assert.equal(
        calls.some(({ probe }) => probe.script === 'healthcheck.sh'),
        false,
        'heavy readiness must not be re-executed by the continuous worker',
    );
});

test('activation-only readiness without recurring liveness fails closed', () => {
    assert.throws(() => runHealthProbes('composite', 'composite-container', {
        health: {
            readiness: {
                script: 'healthcheck.sh',
                continuous: false,
            },
        },
    }, {
        waitForContainerRunningImpl() { return true; },
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_CONTINUOUS_PROBE_REQUIRED');
        assert.match(error.message, /requires a recurring health\.liveness\.script/);
        return true;
    });
});

test('recurring readiness exhaustion is fatal to the probe worker cycle', () => {
    const calls = [];
    assert.throws(() => runHealthProbes('webmeetStt', 'webmeet-stt-container', {
        health: {
            readiness: {
                script: 'healthcheck.sh',
                failureThreshold: 1,
            },
        },
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => 'readiness-failure',
        waitForContainerRunningImpl() { return true; },
        isContainerRunningImpl() { return true; },
        submitProbeRequestImpl: fakeBrokerSequence([
            { status: 7, stdout: '', stderr: 'semantic dependency unavailable\n' },
        ], calls),
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_READINESS_FAILED');
        assert.match(error.message, /readiness probe failed \(exit 7, output='semantic dependency unavailable'\)/);
        assert.match(error.message, /managed restart required/);
        return true;
    });
    assert.equal(
        calls.length,
        1,
    );
});

test('probe runner is executable and binds cleanup to exact kernel identity', () => {
    const runnerUrl = new URL('../../Agent/server/HealthProbeRunner.sh', import.meta.url);
    const source = fs.readFileSync(runnerUrl, 'utf8');
    assert.notEqual(fs.statSync(runnerUrl).mode & 0o111, 0);
    assert.match(
        source,
        /setsid sh "\$0" session-run/,
        'the runner must use the BusyBox-compatible setsid contract',
    );
    assert.doesNotMatch(source, /setsid\s+-[a-z]/i);
    assert.doesNotMatch(
        source,
        /^[ \t]*(?:command[ \t]+-v[ \t]+)?timeout(?:[ \t]|$)/m,
        'the runner must not depend on a timeout executable',
    );
    assert.match(source, /proc_stat_path_fields "\/proc\/\$1\/stat"/);
    assert.match(source, /proc_stat_path_fields \/proc\/self\/stat/);
    assert.match(source, /session_proc_pid="\$PROC_PID"/);
    assert.match(source, /\[ "\$session_signal_pid" = "\$\$" \]/);
    assert.match(source, /status_key" = 'NSpid:'/);
    assert.match(source, /task\/\[0-9\]\*\/children/);
    assert.doesNotMatch(
        source,
        /for proc_dir in \/proc\/\[0-9\]\*/,
        'normal cleanup must walk only the exact probe tree and token matches',
    );
    assert.match(source, /PROC_START_TIME/);
    assert.match(source, /PROC_SESSION_ID/);
    assert.match(source, /PLOINKY_PROBE_TOKEN/);
    assert.match(source, /PLOINKY_PROBE_TOKEN="\$\{token\}:"/);
    assert.match(source, /\$\{PROBE_TOKEN_PREFIX\}\$\{token\}:/);
    assert.match(source, /PROBE_CONTROL_ROOT='\/run\/ploinky-health-probes'/);
    assert.match(source, /expected_start="\$\{identity_rest#\*:\}"/);
    assert.match(source, /\[ "\$MATCHED_SIGNAL_PID" = "\$signal_pid" \]/);
    assert.match(source, /\[ "\$MATCHED_START_TIME" = "\$expected_start" \]/);
    assert.match(source, /signal_matching_session_processes\s+\\?\s*TERM/);
    assert.match(source, /signal_matching_session_processes\s+\\?\s*KILL/);
    assert.match(source, /signal_collected_probe_identities TERM/);
    assert.match(source, /signal_collected_probe_identities KILL/);
    assert.match(source, /\[ "\$session_id" -gt 0 \]/);
    assert.match(source, /while \[ ! -d "\$control_path\/\$PROBE_CANCEL_DIR" \]/);
    assert.match(source, /PROBE_OUTPUT_BLOCK_COUNT=256/);
    assert.match(source, /mv "\$control_path\/result-tmp" "\$control_path\/result"/);
    assert.match(source, /serve_broker\(\)/);
    assert.match(source, /mkdir "\$control_path\/\$PROBE_CLAIM_DIR"/);
    assert.match(source, /mkdir "\$ready_path"/);
    assert.equal(
        (source.match(/grep -Fl/g) || []).length,
        1,
        'each process-table scan must use one fixed-string token lookup, not a helper pipeline per PID',
    );
});

test('agent entrypoint owns health and relay brokers without creating runtime exec sessions', () => {
    const entrypointUrl = new URL('../../Agent/server/AgentEntrypoint.sh', import.meta.url);
    const source = fs.readFileSync(entrypointUrl, 'utf8');
    assert.notEqual(fs.statSync(entrypointUrl).mode & 0o111, 0);
    assert.match(source, /sh "\$PROBE_BROKER" serve "\$PROBE_CONTROL_ROOT" &/);
    assert.match(source, /randomUUID/);
    assert.match(source, /node "\$RELAY_BROKER" serve "\$RELAY_SOCKET" "\$relay_ready" &/);
    assert.match(source, /while \[ ! -d "\$relay_ready" \]/);
    assert.doesNotMatch(source, /while \[ ! -S "\$RELAY_SOCKET" \]/);
    assert.match(source, /PLOINKY_HEALTH_PROBE_BROKER/);
    assert.match(source, /"\$@" &/);
    assert.match(source, /wait "\$main_pid"/);
    assert.match(source, /termination_fallback_status/);
    assert.match(source, /acknowledged_status="\$\?"/);
    assert.match(source, /main_status="\$acknowledged_status"/);
    assert.match(source, /exit "\$main_status"/);
    assert.doesNotMatch(
        source,
        /terminate\(\)[\s\S]*?exit "\$status"/,
        'the wrapper must not replace an application drain acknowledgement with the signal status',
    );
    assert.doesNotMatch(source, /\b(?:docker|podman)\b/);
    assert.doesNotMatch(source, /\bexec\b/);
});

test('runtime relay retries shared-filesystem bind release and unlinks only its own socket', () => {
    const relayUrl = new URL('../../Agent/server/RuntimeHttpRelay.mjs', import.meta.url);
    const source = fs.readFileSync(relayUrl, 'utf8');
    assert.match(source, /TRANSIENT_RELAY_BIND_ERRORS/);
    assert.match(source, /'ENOTSUP'/);
    assert.match(source, /serveSocketBrokerWithRetry/);
    assert.match(source, /removeOwnedRelaySocket/);
    assert.match(source, /current\.dev === ownedIdentity\.dev/);
    assert.match(source, /current\.ino === ownedIdentity\.ino/);
    assert.match(source, /requireRelayReadyPath/);
    assert.doesNotMatch(
        source,
        /process\.once\('exit',[\s\S]{0,160}removeStaleRelaySocket/,
    );
});

test('probe runner rejects control-path substitution and malformed durations before execution', () => {
    const runnerPath = fileURLToPath(new URL('../../Agent/server/HealthProbeRunner.sh', import.meta.url));
    const controlMismatch = spawnSync('sh', [
        runnerPath,
        'run',
        '/run/ploinky-health-probes/other',
        'exact-token',
        'healthcheck.sh',
        '1',
        '1',
    ], { encoding: 'utf8' });
    assert.equal(controlMismatch.status, 125);
    assert.match(controlMismatch.stderr, /control path is invalid/);

    const malformedDuration = spawnSync('sh', [
        runnerPath,
        'run',
        '/run/ploinky-health-probes/exact-token',
        'exact-token',
        'healthcheck.sh',
        '1.2.3',
        '1',
    ], { encoding: 'utf8' });
    assert.equal(malformedDuration.status, 125);
    assert.match(malformedDuration.stderr, /duration is invalid/);
});
