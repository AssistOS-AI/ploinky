import test from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../../cli/services/docker/healthProbes.js');
const { clearLivenessState, __testHooks, __testConstants } = module;
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
    }, {
        runtime: 'fake-runtime',
        spawnSyncImpl: fakeSpawnSequence([
            { status: 0, stdout: 'warming\n', stderr: '' },
            { status: 0, stdout: 'ready\n', stderr: '' },
        ], calls),
        sleepMsImpl() {},
    });

    assert.equal(result.status, 'success');
    assert.equal(result.detail, 'ready');
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1].args, [
        'exec', 'database-container', 'sh', '-lc', 'cd /code && sh "./healthcheck.sh"',
    ]);
    assert.equal(calls[1].options.timeout, 2000);
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
    });

    assert.deepEqual(result, {
        status: 'failed',
        reason: 'exit 9',
        detail: 'still not ready',
    });
});

test('blocking container script readiness reports per-attempt execution timeout', () => {
    const timeoutError = new Error('timed out');
    timeoutError.code = 'ETIMEDOUT';
    const result = runContainerScriptReadiness('database', 'database-container', {
        script: 'healthcheck.sh',
        timeout: 0.01,
        failureThreshold: 1,
    }, {
        runtime: 'fake-runtime',
        spawnSyncImpl: fakeSpawnSequence([
            { status: null, signal: 'SIGTERM', error: timeoutError, stdout: '', stderr: '' },
        ], []),
        sleepMsImpl() {},
    });

    assert.deepEqual(result, { status: 'failed', reason: 'timeout', detail: '' });
});

test('blocking container script readiness fails fast when the script is missing', () => {
    assert.throws(() => runContainerScriptReadiness('database', 'database-container', {
        script: 'missing.sh',
    }, {
        runtime: 'fake-runtime',
        spawnSyncImpl(_runtime, args) {
            assert.ok(args.at(-1).startsWith('[ -f '));
            return { status: 1 };
        },
    }), /missing\.sh not found inside container/);
});
