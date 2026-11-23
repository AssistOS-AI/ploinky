export const DEFAULT_THRESHOLDS = Object.freeze({
    minFailures: 5,
    errorMultiple: 2,
    errorDeltaPoints: 2,
    consecutiveConnections: 3,
    consecutiveProbes: 3,
    minResponses: 20,
    slowMs: 5_000,
    slowDeltaPoints: 10,
    slowWithoutBaselinePercent: 20,
});

const countThresholds = new Set(['minFailures', 'minResponses', 'consecutiveConnections', 'consecutiveProbes']);
const percentThresholds = new Set(['errorDeltaPoints', 'slowDeltaPoints', 'slowWithoutBaselinePercent']);

export function rolloutThresholds(overrides = {}) {
    if (!overrides || typeof overrides !== 'object'
        || ![Object.prototype, null].includes(Object.getPrototypeOf(overrides))) {
        throw new RangeError('canary thresholds must be an object');
    }
    const thresholds = { ...DEFAULT_THRESHOLDS };
    for (const key of Reflect.ownKeys(overrides)) {
        const value = overrides[key];
        if (!Object.hasOwn(DEFAULT_THRESHOLDS, key) || !Number.isFinite(value) || value < 0
            || (countThresholds.has(key) && (!Number.isSafeInteger(value) || value < 1))
            || (percentThresholds.has(key) && value > 100)) {
            throw new RangeError(`invalid canary threshold: ${String(key)}`);
        }
        thresholds[key] = value;
    }
    return Object.freeze(thresholds);
}

// Cross-multiply before comparing: equal shares plus the configured margin
// must never trip because of floating-point subtraction of two percentages.
function exceedsMargin(count, total, oldCount, oldTotal, points) {
    return 100 * (count * oldTotal - oldCount * total) > points * total * oldTotal;
}

export function excessErrors(canary, old, t) {
    if (canary.backendFailures < t.minFailures) return false;
    if (!old.requests) return true;
    return canary.backendFailures * old.requests > t.errorMultiple * old.backendFailures * canary.requests
        && exceedsMargin(canary.backendFailures, canary.requests, old.backendFailures, old.requests, t.errorDeltaPoints);
}

export function excessLatency(canary, old, t) {
    if (canary.timedResponses < t.minResponses) return false;
    if (!old.timedResponses) {
        return 100 * canary.slowResponses > t.slowWithoutBaselinePercent * canary.timedResponses;
    }
    return exceedsMargin(canary.slowResponses, canary.timedResponses, old.slowResponses, old.timedResponses, t.slowDeltaPoints);
}
