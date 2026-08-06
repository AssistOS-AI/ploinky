import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
const containerId = 'a'.repeat(64);

function exactPodmanProbe(overrides = {}) {
    return {
        runtime: 'podman',
        containerId,
        instanceId: 'instance-health',
        enableGeneration: 'generation-health',
        inspectRuntimeIdentityImpl(identity) {
            assert.deepEqual(identity, {
                runtime: 'podman',
                containerName: identity.containerName,
                containerId,
                instanceId: 'instance-health',
                enableGeneration: 'generation-health',
                releaseGeneration: '',
            });
            return { identity };
        },
        ...overrides,
    };
}

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

function fakeSpawnSequence(results, calls) {
    return (_runtime, args, options) => {
        calls.push({ args, options });
        if (args.at(-1).startsWith('[ -f ')) {
            return { status: 0, stdout: '', stderr: '' };
        }
        return results.shift() || { status: 0, stdout: 'ready\n', stderr: '' };
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
    }, exactPodmanProbe({
        tokenFactory: (() => {
            let sequence = 0;
            return () => `success-${sequence += 1}`;
        })(),
        spawnSyncImpl: fakeSpawnSequence([
            { status: 0, stdout: 'warming\n', stderr: '' },
            { status: 0, stdout: 'ready\n', stderr: '' },
        ], calls),
        sleepMsImpl() {},
        isContainerRunningImpl() { return true; },
    }));

    assert.equal(result.status, 'success');
    assert.equal(result.detail, 'ready');
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1].args.slice(0, 6), [
        'exec',
        containerId,
        'sh',
        '/Agent/server/HealthProbeRunner.sh',
        'run',
        '/tmp/.ploinky-health-probe-success-1',
    ]);
    assert.deepEqual(calls[1].args.slice(-4), [
        'success-1',
        'healthcheck.sh',
        '2',
        '1',
    ]);
    assert.equal(calls[1].options.timeout, 17_000);
    assert.equal(calls[1].options.killSignal, 'SIGKILL');
});

test('blocking container script readiness reports nonzero exhaustion', () => {
    const calls = [];
    const result = runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        interval: 0.001,
        timeout: 1,
        failureThreshold: 2,
    }, exactPodmanProbe({
        spawnSyncImpl: fakeSpawnSequence([
            { status: 9, stdout: '', stderr: 'not ready\n' },
            { status: 9, stdout: '', stderr: 'still not ready\n' },
        ], calls),
        sleepMsImpl() {},
        isContainerRunningImpl() { return true; },
    }));

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
    }, exactPodmanProbe({
        tokenFactory: () => 'inner-timeout',
        spawnSyncImpl: fakeSpawnSequence([
            { status: 124, stdout: '', stderr: '' },
        ], calls),
        sleepMsImpl() {},
        isContainerRunningImpl() { return true; },
    }));

    assert.deepEqual(result, { status: 'failed', reason: 'timeout', detail: '' });
    assert.equal(
        calls.some(({ args }) => args.includes('cleanup')),
        false,
        'the exact in-container runner cleans its own deadline before returning 124',
    );
});

test('probe identity rejects unsafe generated tokens before runtime execution', () => {
    const calls = [];
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        timeout: 1,
        failureThreshold: 1,
    }, exactPodmanProbe({
        tokenFactory: () => 'unsafe token; touch /tmp/escaped',
        spawnSyncImpl: fakeSpawnSequence([], calls),
        isContainerRunningImpl() { return true; },
    })), /generated probe token is invalid/);
    assert.equal(calls.length, 1, 'only the argv-safe script existence check may run');
});

test('probe termination without an exit status fails closed', () => {
    const calls = [];
    const result = runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        timeout: 1,
        failureThreshold: 1,
    }, exactPodmanProbe({
        tokenFactory: () => 'signal-exit',
        spawnSyncImpl: fakeSpawnSequence([
            { status: null, signal: 'SIGKILL', stdout: '', stderr: '' },
            { status: 0, stdout: '', stderr: '' },
        ], calls),
        sleepMsImpl() {},
        isContainerRunningImpl() { return true; },
    }));

    assert.deepEqual(result, { status: 'failed', reason: 'exit 125', detail: '' });
    assert.equal(calls.some(({ args }) => args.includes('cleanup')), true);
});

test('non-timeout client errors clean the exact execution before surfacing', () => {
    const clientError = new Error('client output overflow');
    clientError.code = 'ENOBUFS';
    const calls = [];
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        timeout: 1,
        failureThreshold: 1,
    }, exactPodmanProbe({
        tokenFactory: () => 'client-error',
        spawnSyncImpl: fakeSpawnSequence([
            { status: null, error: clientError, stdout: '', stderr: '' },
            { status: 0, stdout: '', stderr: '' },
        ], calls),
        sleepMsImpl() {},
        isContainerRunningImpl() { return true; },
    })), /failed to run 'healthcheck\.sh': client output overflow/);
    assert.deepEqual(calls[2].args.slice(-3), [
        'cleanup',
        '/tmp/.ploinky-health-probe-client-error',
        'client-error',
    ]);
});

test('outer exec timeout invokes exact marker cleanup before reporting timeout', () => {
    const timeoutError = new Error('timed out');
    timeoutError.code = 'ETIMEDOUT';
    const calls = [];
    const result = runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        timeout: 0.01,
        failureThreshold: 1,
    }, exactPodmanProbe({
        tokenFactory: () => 'outer-timeout',
        spawnSyncImpl: fakeSpawnSequence([
            { status: null, signal: 'SIGTERM', error: timeoutError, stdout: '', stderr: '' },
            { status: 0, stdout: '', stderr: '' },
        ], calls),
        sleepMsImpl() {},
        isContainerRunningImpl() { return true; },
    }));

    assert.deepEqual(result, { status: 'failed', reason: 'timeout', detail: '' });
    assert.deepEqual(calls[2].args, [
        'exec',
        containerId,
        'sh',
        '/Agent/server/HealthProbeRunner.sh',
        'cleanup',
        '/tmp/.ploinky-health-probe-outer-timeout',
        'outer-timeout',
    ]);
    assert.equal(calls[2].options.timeout, 5000);
    assert.equal(calls[2].options.killSignal, 'SIGKILL');
});

test('outer exec timeout fails closed when exact cleanup cannot be proved', () => {
    const timeoutError = new Error('timed out');
    timeoutError.code = 'ETIMEDOUT';
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        timeout: 0.01,
        failureThreshold: 1,
    }, exactPodmanProbe({
        tokenFactory: () => 'cleanup-failure',
        spawnSyncImpl: fakeSpawnSequence([
            { status: null, error: timeoutError, stdout: '', stderr: '' },
            { status: 125, stdout: '', stderr: 'descendant survived' },
        ], []),
        sleepMsImpl() {},
        isContainerRunningImpl() { return true; },
    })), (error) => {
        assert.equal(error.code, 'PLOINKY_PROBE_CLEANUP_FAILED');
        assert.match(error.message, /descendant survived/);
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
    }, exactPodmanProbe({
        tokenFactory: () => 'runner-cleanup-failure',
        spawnSyncImpl: fakeSpawnSequence([
            {
                status: 125,
                stdout: '',
                stderr: 'exact probe descendants survived cleanup',
            },
            { status: 0, stdout: '', stderr: '' },
        ], calls),
        sleepMsImpl() {
            assert.fail('unsafe cleanup must not be retried');
        },
        isContainerRunningImpl() { return true; },
    })), (error) => {
        assert.equal(error.code, 'PLOINKY_PROBE_EXECUTION_UNSAFE');
        assert.match(error.message, /descendants survived cleanup/);
        return true;
    });
    assert.equal(calls.length, 3, 'existence, one probe, and one exact cleanup are the only calls');
    assert.deepEqual(calls[2].args.slice(-3), [
        'cleanup',
        '/tmp/.ploinky-health-probe-runner-cleanup-failure',
        'runner-cleanup-failure',
    ]);
});

test('blocking container script readiness fails fast when the script is missing', () => {
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'missing.sh',
    }, exactPodmanProbe({
        spawnSyncImpl(_runtime, args) {
            assert.ok(args.at(-1).startsWith('[ -f '));
            return { status: 1 };
        },
    })), /missing\.sh not found inside container/);
});

test('script inspection has a hard deadline and reports a typed timeout', () => {
    const timeoutError = new Error('runtime did not answer');
    timeoutError.code = 'ETIMEDOUT';
    const calls = [];
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
    }, exactPodmanProbe({
        controlPlaneTimeoutMs: 123,
        spawnSyncImpl(runtime, args, options) {
            calls.push({ runtime, args, options });
            return { status: null, error: timeoutError };
        },
    })), (error) => {
        assert.equal(error.code, 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT');
        assert.match(error.message, /runtime did not answer/);
        return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.timeout, 123);
    assert.equal(calls[0].options.killSignal, 'SIGKILL');
});

test('blocking container script readiness fails immediately after the container exits', () => {
    const calls = [];
    const result = runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        interval: 30,
        failureThreshold: 60,
    }, exactPodmanProbe({
        spawnSyncImpl: fakeSpawnSequence([], calls),
        isContainerRunningImpl() { return false; },
        sleepMsImpl() {
            assert.fail('an exited container must not consume another probe interval');
        },
    }));

    assert.deepEqual(result, {
        status: 'failed',
        reason: 'container exited',
        detail: '',
    });
    assert.equal(calls.length, 1, 'only the initial script existence check should run');
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
    }, exactPodmanProbe({
        tokenFactory: () => 'liveness-only',
        waitForContainerRunningImpl() { return true; },
        isContainerRunningImpl() { return true; },
        spawnSyncImpl: fakeSpawnSequence([
            { status: 0, stdout: 'live\n', stderr: '' },
        ], calls),
    }));

    const executedScripts = calls
        .filter(({ args }) => args.includes('/Agent/server/HealthProbeRunner.sh'))
        .map(({ args }) => args.at(-3));
    assert.deepEqual(executedScripts, ['liveness.sh']);
    assert.equal(
        calls.some(({ args }) => args.includes('healthcheck.sh')),
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
    }, exactPodmanProbe({
        waitForContainerRunningImpl() { return true; },
    })), (error) => {
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
    }, exactPodmanProbe({
        tokenFactory: () => 'readiness-failure',
        waitForContainerRunningImpl() { return true; },
        isContainerRunningImpl() { return true; },
        spawnSyncImpl: fakeSpawnSequence([
            { status: 7, stdout: '', stderr: 'semantic dependency unavailable\n' },
        ], calls),
    })), (error) => {
        assert.equal(error.code, 'PLOINKY_READINESS_FAILED');
        assert.match(error.message, /readiness probe failed \(exit 7, output='semantic dependency unavailable'\)/);
        assert.match(error.message, /managed restart required/);
        return true;
    });
    assert.equal(
        calls.filter(({ args }) => args.includes('/Agent/server/HealthProbeRunner.sh')).length,
        1,
    );
});

test('Podman health probes reject generic, missing, or incomplete runtime identity before execution', () => {
    for (const options of [
        {},
        { runtime: 'docker' },
        { runtime: 'container' },
        { runtime: 'podman', containerId: 'short', instanceId: 'i', enableGeneration: 'g' },
        { runtime: 'podman', containerId, instanceId: ' padded ', enableGeneration: 'g' },
    ]) {
        let calls = 0;
        assert.throws(
            () => runContainerScriptReadiness('database', 'database-container', {
                script: 'healthcheck.sh',
            }, {
                ...options,
                spawnSyncImpl() {
                    calls += 1;
                    return { status: 0 };
                },
            }),
            (error) => error?.code === 'PLOINKY_PODMAN_RUNTIME_IDENTITY_INVALID',
        );
        assert.equal(calls, 0);
    }
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
    assert.doesNotMatch(source, /(?:^|[\s`$(])timeout(?:\s|$)/m);
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
    assert.match(source, /\/tmp\/\.ploinky-health-probe-\$\{token\}/);
    assert.match(source, /expected_start="\$\{identity_rest#\*:\}"/);
    assert.match(source, /\[ "\$MATCHED_SIGNAL_PID" = "\$signal_pid" \]/);
    assert.match(source, /\[ "\$MATCHED_START_TIME" = "\$expected_start" \]/);
    assert.match(source, /signal_matching_probe_processes\s+\\?\s*TERM/);
    assert.match(source, /signal_matching_probe_processes\s+\\?\s*KILL/);
    assert.match(source, /\[ "\$session_id" -gt 0 \]/);
    assert.match(source, /mkdir "\$marker_path\/\$PROBE_CANCEL_DIR"/);
    assert.equal(
        (source.match(/grep -Fl/g) || []).length,
        1,
        'each process-table scan must use one fixed-string token lookup, not a helper pipeline per PID',
    );
});

test('probe runner rejects marker substitution and malformed durations before execution', () => {
    const runnerPath = fileURLToPath(new URL('../../Agent/server/HealthProbeRunner.sh', import.meta.url));
    const markerMismatch = spawnSync('sh', [
        runnerPath,
        'run',
        '/tmp/.ploinky-health-probe-other',
        'exact-token',
        'healthcheck.sh',
        '1',
        '1',
    ], { encoding: 'utf8' });
    assert.equal(markerMismatch.status, 125);
    assert.match(markerMismatch.stderr, /marker path is invalid/);

    const malformedDuration = spawnSync('sh', [
        runnerPath,
        'run',
        '/tmp/.ploinky-health-probe-exact-token',
        'exact-token',
        'healthcheck.sh',
        '1.2.3',
        '1',
    ], { encoding: 'utf8' });
    assert.equal(malformedDuration.status, 125);
    assert.match(malformedDuration.stderr, /duration is invalid/);
});
