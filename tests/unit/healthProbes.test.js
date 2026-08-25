import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
        const result = results.shift() || { status: 0, stdout: 'ready\n', stderr: '' };
        if (!args.includes('/Agent/server/HealthProbeRunner.sh')) return result;

        const controlPath = path.join(healthProbeHostDir(args[2]), args[7]);
        const writeResult = (value) => {
            if (value.stdout) fs.writeFileSync(path.join(controlPath, 'probe-stdout'), value.stdout);
            if (value.stderr) fs.writeFileSync(path.join(controlPath, 'probe-stderr'), value.stderr);
            fs.writeFileSync(path.join(controlPath, 'result'), `${value.status}\n`);
        };
        if (Object.hasOwn(result, 'cancellationStatus')) {
            writeResult({
                status: result.cancellationStatus,
                stdout: result.cancellationStdout || '',
                stderr: result.cancellationStderr || '',
            });
        }
        if (result.launchOnly || result.error || typeof result.status !== 'number') {
            return result;
        }
        writeResult(result);
        return { status: 0, stdout: '', stderr: '' };
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
        spawnSyncImpl: fakeSpawnSequence([
            { status: 0, stdout: 'warming\n', stderr: '' },
            { status: 0, stdout: 'ready\n', stderr: '' },
        ], calls),
        sleepMsImpl() {},
        isContainerRunningImpl() { return true; },
    });

    assert.equal(result.status, 'success');
    assert.equal(result.detail, 'ready');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args.slice(0, 7), [
        'exec',
        '--detach',
        'database-container',
        'sh',
        '/Agent/server/HealthProbeRunner.sh',
        'run',
        '/run/ploinky-health-probes/success-1',
    ]);
    assert.deepEqual(calls[0].args.slice(-4), [
        'success-1',
        'healthcheck.sh',
        '2',
        '1',
    ]);
    assert.equal(calls[0].options.timeout, 60_000);
    assert.equal(calls[0].options.killSignal, 'SIGTERM');
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
        spawnSyncImpl: fakeSpawnSequence([
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
        spawnSyncImpl: fakeSpawnSequence([
            { status: 124, stdout: '', stderr: '' },
        ], calls),
        sleepMsImpl() {},
        isContainerRunningImpl() { return true; },
    });

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
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => 'unsafe token; touch /tmp/escaped',
        spawnSyncImpl: fakeSpawnSequence([], calls),
        isContainerRunningImpl() { return true; },
    }), /generated probe token is invalid/);
    assert.equal(calls.length, 0, 'unsafe identity must be rejected before runtime execution');
});

test('an uncertain detached launch is cancelled through the mount before retry', () => {
    const timeoutError = new Error('timed out');
    timeoutError.code = 'ETIMEDOUT';
    const calls = [];
    const retrySleeps = [];
    let tokenSequence = 0;
    const result = runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        timeout: 0.01,
        failureThreshold: 1,
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => `outer-timeout-${tokenSequence += 1}`,
        spawnSyncImpl: fakeSpawnSequence([
            {
                status: null,
                signal: 'SIGTERM',
                error: timeoutError,
                cancellationStatus: 125,
            },
            { status: 0, stdout: 'ready\n', stderr: '' },
        ], calls),
        controlPlaneRetryMs: 17,
        sleepMsImpl(ms) { retrySleeps.push(ms); },
        isContainerRunningImpl() { return true; },
    });
    assert.deepEqual(result, { status: 'success', detail: 'ready' });
    assert.deepEqual(retrySleeps, [17]);
    assert.equal(calls.length, 2, 'no cleanup exec is launched');
    assert.equal(calls[0].args.includes('--detach'), true);
    assert.equal(calls[1].args.includes('outer-timeout-2'), true);
});

test('an unacknowledged detached launch fails closed without a second runtime exec', () => {
    const timeoutError = new Error('detached launch timed out');
    timeoutError.code = 'ETIMEDOUT';
    const calls = [];
    let now = 0;
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        timeout: 0.01,
        failureThreshold: 1,
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => 'unacknowledged-launch',
        spawnSyncImpl: fakeSpawnSequence([
            { status: null, error: timeoutError, stdout: '', stderr: '' },
        ], calls),
        probeCancellationGraceMs: 5,
        nowImpl() { return now; },
        sleepMsImpl(ms) { now += ms; },
        isContainerRunningImpl() { return true; },
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_PROBE_EXECUTION_UNSAFE');
        assert.match(error.message, /exact cancellation was not acknowledged/);
        return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(calls.some(({ args }) => args.includes('cleanup')), false);
    fs.rmSync(
        path.join(healthProbeHostDir('database-container'), 'unacknowledged-launch'),
        { recursive: true, force: true },
    );
});

test('a mounted cancellation acknowledgement recovers a delayed detached result', () => {
    const calls = [];
    let now = 0;
    let firstControlPath = '';
    let launchCount = 0;
    let tokenSequence = 0;
    const result = runContainerScriptReadiness('onlyOffice', 'onlyoffice-container', {
        script: 'healthcheck.sh',
        timeout: 5,
        failureThreshold: 180,
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => `onlyoffice-${tokenSequence += 1}`,
        spawnSyncImpl(_runtime, args, options) {
            calls.push({ args, options });
            launchCount += 1;
            const controlPath = path.join(healthProbeHostDir(args[2]), args[7]);
            if (launchCount === 1) {
                firstControlPath = controlPath;
            } else {
                fs.writeFileSync(path.join(controlPath, 'probe-stdout'), 'ready\n');
                fs.writeFileSync(path.join(controlPath, 'result'), '0\n');
            }
            return { status: 0, stdout: '', stderr: '' };
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
    assert.equal(calls.every(({ args }) => args.includes('--detach')), true);
});

test('detached launch control-plane retries remain bounded after cancellation acknowledgements', () => {
    const timeoutError = new Error('spawnSync podman ETIMEDOUT');
    timeoutError.code = 'ETIMEDOUT';
    const calls = [];
    let tokenSequence = 0;
    assert.throws(() => runContainerScriptReadiness('onlyOffice', 'onlyoffice-container', {
        script: 'healthcheck.sh',
        timeout: 5,
        failureThreshold: 180,
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => `bounded-${tokenSequence += 1}`,
        spawnSyncImpl: fakeSpawnSequence([
            { status: null, error: timeoutError, cancellationStatus: 125 },
            { status: null, error: timeoutError, cancellationStatus: 125 },
        ], calls),
        controlPlaneFailureThreshold: 2,
        controlPlaneRetryMs: 0,
        sleepMsImpl() {},
        isContainerRunningImpl() { return true; },
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT');
        assert.match(error.message, /runtime control plane timed out/);
        return true;
    });
    assert.equal(calls.filter(({ args }) => args.includes('run')).length, 2);
    assert.equal(calls.filter(({ args }) => args.includes('cleanup')).length, 0);
});

test('non-timeout launch errors surface after mounted cancellation is acknowledged', () => {
    const clientError = new Error('detached client failed');
    clientError.code = 'EIO';
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        timeout: 0.01,
        failureThreshold: 1,
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => 'client-error',
        spawnSyncImpl: fakeSpawnSequence([
            { status: null, error: clientError, cancellationStatus: 125 },
        ], []),
        isContainerRunningImpl() { return true; },
    }), (error) => {
        assert.match(error.message, /failed to launch 'healthcheck\.sh': detached client failed/);
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
        spawnSyncImpl: fakeSpawnSequence([
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
    assert.equal(calls.length, 1, 'one detached probe launch is the only runtime call');
});

test('blocking container script readiness fails fast when the script is missing', () => {
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'missing.sh',
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => 'missing-script',
        spawnSyncImpl: fakeSpawnSequence([{ status: 127 }], []),
        isContainerRunningImpl() { return true; },
    }), /missing\.sh not found inside container/);
});

test('a definitive detached launch failure does not wait for a result', () => {
    const calls = [];
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
    }, {
        runtime: 'fake-runtime',
        tokenFactory: () => 'launch-rejected',
        spawnSyncImpl: fakeSpawnSequence([
            { status: 42, stderr: 'runtime rejected launch', launchOnly: true },
        ], calls),
        isContainerRunningImpl() { return true; },
    }), (error) => {
        assert.match(error.message, /runtime rejected launch/);
        return true;
    });
    assert.equal(calls.length, 1);
});

test('blocking container script readiness fails immediately after the container exits', () => {
    const calls = [];
    const result = runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        interval: 30,
        failureThreshold: 60,
    }, {
        runtime: 'fake-runtime',
        spawnSyncImpl: fakeSpawnSequence([], calls),
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

test('blocking readiness preserves a typed running-state control-plane timeout', () => {
    const calls = [];
    const timeout = new Error('podman ps timed out');
    timeout.code = 'ETIMEDOUT';
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
    }, {
        runtime: 'fake-runtime',
        spawnSyncImpl: fakeSpawnSequence([], calls),
        isContainerRunningImpl() { throw timeout; },
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT');
        assert.match(error.message, /inspect container running state/);
        return true;
    });
    assert.equal(calls.length, 1, 'only script inspection should reach the runtime');
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
        spawnSyncImpl: fakeSpawnSequence([
            { status: 0, stdout: 'live\n', stderr: '' },
        ], calls),
    });

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
        spawnSyncImpl: fakeSpawnSequence([
            { status: 7, stdout: '', stderr: 'semantic dependency unavailable\n' },
        ], calls),
    }), (error) => {
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
    assert.match(source, /PROBE_CONTROL_ROOT='\/run\/ploinky-health-probes'/);
    assert.match(source, /expected_start="\$\{identity_rest#\*:\}"/);
    assert.match(source, /\[ "\$MATCHED_SIGNAL_PID" = "\$signal_pid" \]/);
    assert.match(source, /\[ "\$MATCHED_START_TIME" = "\$expected_start" \]/);
    assert.match(source, /signal_matching_probe_processes\s+\\?\s*TERM/);
    assert.match(source, /signal_matching_probe_processes\s+\\?\s*KILL/);
    assert.match(source, /\[ "\$session_id" -gt 0 \]/);
    assert.match(source, /while \[ ! -d "\$control_path\/\$PROBE_CANCEL_DIR" \]/);
    assert.match(source, /PROBE_OUTPUT_BLOCK_COUNT=256/);
    assert.match(source, /mv "\$control_path\/result-tmp" "\$control_path\/result"/);
    assert.equal(
        (source.match(/grep -Fl/g) || []).length,
        1,
        'each process-table scan must use one fixed-string token lookup, not a helper pipeline per PID',
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
