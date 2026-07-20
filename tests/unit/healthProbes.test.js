import test from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../../cli/sandbox/docker/healthProbes.js');
const { clearLivenessState, __testHooks, __testConstants } = module;
const {
    coercePositiveNumber,
    coercePositiveInteger,
    validateScriptName,
    normalizeProbeConfig,
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
