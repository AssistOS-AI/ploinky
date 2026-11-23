// The left edge is open: an observation exactly ten minutes old has expired.
export const WINDOW_MS = 10 * 60_000;

const fields = [
    'requests', 'responses', 'backendFailures', 'serverErrors', 'unreachable', 'callerErrors',
    'probes', 'probeFailures', 'restarts', 'exits', 'inspectFailures',
];
const bits = Object.fromEntries(fields.map((field, i) => [field, 1 << i]));

function emptyCounts() {
    return Object.fromEntries([...fields, 'timedResponses', 'slowResponses'].map(field => [field, 0]));
}

export function outcomeFields({ status, serverError, unreachable }) {
    const metrics = ['requests'];
    if (status >= 100) metrics.push('responses');
    if (unreachable || serverError || status >= 500) {
        metrics.push('backendFailures', unreachable ? 'unreachable' : 'serverErrors');
    } else if (status >= 400 && status < 500) {
        metrics.push('callerErrors');
    }
    return metrics;
}

// Keep numeric triples (timestamp, counted fields, raw TTFB) for expiry.
// In particular, baseline traffic retains no request objects or per-call
// arrays. A negative timing distinguishes an unknown first byte from 0 ms.
const SAMPLE_SIZE = 3;
export class SignalCounts {
    #samples = [];
    #head = 0;
    #window = emptyCounts();
    #sinceStart = emptyCounts();

    constructor(slowMs) {
        this.slowMs = slowMs;
    }

    #apply(counts, mask, timing, delta) {
        for (let i = 0; i < fields.length; i++) {
            if (mask & (1 << i)) counts[fields[i]] += delta;
        }
        if (timing >= 0) {
            counts.timedResponses += delta;
            if (timing > this.slowMs) counts.slowResponses += delta;
        }
    }

    nextExpiry() {
        return this.#head < this.#samples.length ? this.#samples[this.#head] + WINDOW_MS : Infinity;
    }

    current(now) {
        while (this.#head < this.#samples.length && this.nextExpiry() <= now) {
            this.#apply(this.#window, this.#samples[this.#head + 1], this.#samples[this.#head + 2], -1);
            this.#head += SAMPLE_SIZE;
        }
        if (this.#head && this.#head * 2 >= this.#samples.length) {
            this.#samples = this.#samples.slice(this.#head);
            this.#head = 0;
        }
        return this.#window;
    }

    record(at, metrics, ttfbMs = -1) {
        this.current(at);
        let mask = 0;
        for (const field of metrics) mask |= bits[field];
        this.#samples.push(at, mask, ttfbMs);
        this.#apply(this.#window, mask, ttfbMs, 1);
        this.#apply(this.#sinceStart, mask, ttfbMs, 1);
    }

    // Compare against recent old-copy samples even when the new rollout
    // chooses a different slow threshold. Its lifetime totals start at zero.
    seedWindow(baseline, now) {
        baseline.current(now);
        this.#samples = baseline.#samples.slice(baseline.#head);
        for (let i = 0; i < this.#samples.length; i += SAMPLE_SIZE) {
            this.#apply(this.#window, this.#samples[i + 1], this.#samples[i + 2], 1);
        }
    }

    snapshot(now) {
        return { window: { ...this.current(now) }, sinceStart: { ...this.#sinceStart } };
    }
}
