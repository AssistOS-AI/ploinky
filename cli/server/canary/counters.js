// The left edge is open: an observation exactly ten minutes old has expired.
export const WINDOW_MS = 10 * 60_000;

const fields = [
    'requests', 'responses', 'backendFailures', 'serverErrors', 'unreachable', 'callerErrors',
    'probes', 'probeFailures', 'restarts', 'exits', 'inspectFailures',
];
const bits = Object.fromEntries(fields.map((field, i) => [field, 1 << i]));
const countFields = [...fields, 'timedResponses', 'slowResponses'];
const zeroCounts = Object.freeze(Object.fromEntries(countFields.map(field => [field, 0])));

// As in proxy/recordProxyOutcome.js, the upper edges are inclusive.
export const LATENCY_BUCKETS = Object.freeze([10, 50, 100, 250, 500, 1_000, 5_000, 15_000]);
const latencyLimits = [...LATENCY_BUCKETS, Infinity];
const MAX_DISTINCT_PER_BIN = 8;

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

function addTiming(histogram, value) {
    const i = latencyLimits.findIndex(limit => value <= limit);
    const bin = histogram[i];
    if (!bin) {
        histogram[i] = {
            count: 1, min: value, minCount: 1, max: value, maxCount: 1, distinct: new Map([[value, 1]]),
        };
        return;
    }
    if (bin.distinct) {
        const count = bin.distinct.get(value);
        if (count || bin.distinct.size < MAX_DISTINCT_PER_BIN) bin.distinct.set(value, (count || 0) + 1);
        else bin.distinct = null;
    }
    bin.count++;
    if (value < bin.min) {
        bin.min = value;
        bin.minCount = 1;
    } else if (value === bin.min) bin.minCount++;
    if (value > bin.max) {
        bin.max = value;
        bin.maxCount = 1;
    } else if (value === bin.max) bin.maxCount++;
}

// Only an interior cutoff in an overflowed historical bin can be ambiguous.
// Credit known slow timings there so old traffic cannot mask a canary regression.
function slowAbove(histogram, threshold) {
    let slow = 0;
    for (const bin of histogram) {
        if (!bin || threshold >= bin.max) continue;
        if (threshold < bin.min) slow += bin.count;
        else if (threshold === bin.min) slow += bin.count - bin.minCount;
        else if (bin.distinct) {
            for (const [value, count] of bin.distinct) if (value > threshold) slow += count;
        } else slow += bin.maxCount;
    }
    return slow;
}

// Adjacent milliseconds can expire separately and trigger a trip between sweeps.
// The ten-minute window spans at most 601 seconds (two can be partial).
// Allocate only occupied seconds, each with at most 1000 millisecond buckets.
const SECOND_MS = 1_000;
const PAGE_COUNT = WINDOW_MS / SECOND_MS + 1;
// Ten low bits hold the 0..999 offset. The higher bits hold the metric mask.
// Keep small bursts as packed pairs. A busy millisecond folds into one aggregate.
const OFFSET_BITS = 10;
const OFFSET_MASK = (1 << OFFSET_BITS) - 1;
const CELL_SIZE = 2;
const MAX_PACKED_PER_MS = 8;

function applyObservation(counts, mask, timing, slowMs, delta) {
    for (let i = 0; i < fields.length; i++) {
        if (mask & (1 << i)) counts[fields[i]] += delta;
    }
    if (timing >= 0) {
        counts.timedResponses += delta;
        if (timing > slowMs) counts.slowResponses += delta;
    }
}

function recordInGroup(group, mask, timing, slowMs) {
    applyObservation(group.counts, mask, timing, slowMs, 1);
    if (timing >= 0) addTiming(group.histogram, timing);
}

function applyCell(counts, values, offset, slowMs, delta) {
    const timing = values[offset + 1];
    if (typeof timing === 'number') applyObservation(counts, values[offset] >>> OFFSET_BITS, timing, slowMs, delta);
    else for (const field of countFields) counts[field] += delta * timing.counts[field];
}

function recordCell(page, offset, mask, timing, slowMs) {
    const values = page.values;
    const last = values.length - CELL_SIZE;
    // Keep FIFO expiry if the wall clock steps back during a window.
    if (last >= 0) offset = Math.max(offset, values[last] & OFFSET_MASK);
    if (last >= 0 && (values[last] & OFFSET_MASK) === offset && typeof values[last + 1] !== 'number') {
        recordInGroup(values[last + 1], mask, timing, slowMs);
        return;
    }
    const first = values.length - CELL_SIZE * MAX_PACKED_PER_MS;
    if (first < page.first || (values[first] & OFFSET_MASK) !== offset) {
        values.push((mask << OFFSET_BITS) | offset, timing);
        return;
    }
    const group = { counts: { ...zeroCounts }, histogram: [] };
    for (let i = first; i <= last; i += CELL_SIZE) {
        recordInGroup(group, values[i] >>> OFFSET_BITS, values[i + 1], slowMs);
    }
    recordInGroup(group, mask, timing, slowMs);
    values.length = first + CELL_SIZE;
    values[first + 1] = group;
}

export class SignalCounts {
    #pages = new Array(PAGE_COUNT);
    #head = 0;
    #size = 0;
    #window = { ...zeroCounts };
    #sinceStart = { ...zeroCounts };
    #timingTotals = Array(latencyLimits.length).fill(0);

    constructor(slowMs) {
        this.slowMs = slowMs;
    }

    #page(offset) {
        return this.#pages[(this.#head + offset) % PAGE_COUNT];
    }

    #appendPage(start, values) {
        const page = { start, values, first: 0 };
        this.#pages[(this.#head + this.#size) % PAGE_COUNT] = page;
        this.#size++;
        return page;
    }

    nextExpiry() {
        if (!this.#size) return Infinity;
        const page = this.#page(0);
        return page.start + (page.values[page.first] & OFFSET_MASK) + WINDOW_MS;
    }

    current(now) {
        while (this.#size && this.nextExpiry() <= now) {
            const page = this.#page(0);
            applyCell(this.#window, page.values, page.first, this.slowMs, -1);
            page.values[page.first + 1] = 0;
            page.first += CELL_SIZE;
            if (page.first === page.values.length) {
                this.#pages[this.#head] = undefined;
                this.#head = (this.#head + 1) % PAGE_COUNT;
                this.#size--;
            }
        }
        return this.#window;
    }

    record(at, metrics, ttfbMs = -1) {
        this.current(at);
        let mask = 0;
        for (const field of metrics) mask |= bits[field];
        at = Math.ceil(at);
        let page = this.#size && this.#page(this.#size - 1);
        if (!page || at >= page.start + SECOND_MS) {
            page = this.#appendPage(Math.floor(at / SECOND_MS) * SECOND_MS, []);
        }
        recordCell(page, at - page.start, mask, ttfbMs, this.slowMs);
        applyObservation(this.#window, mask, ttfbMs, this.slowMs, 1);
        applyObservation(this.#sinceStart, mask, ttfbMs, this.slowMs, 1);
        if (ttfbMs >= 0) this.#timingTotals[latencyLimits.findIndex(limit => ttfbMs <= limit)]++;
    }

    withSlowMs(slowMs, now) {
        if (this.slowMs === slowMs) return this;
        const next = new SignalCounts(slowMs);
        next.seedWindow(this, now);
        next.#timingTotals = [...this.#timingTotals];
        const slowResponses = this.#timingTotals.reduce((sum, count, i) =>
            sum + (latencyLimits[i] > slowMs ? count : 0), 0);
        next.#sinceStart = { ...this.#sinceStart, slowResponses };
        return next;
    }

    // Compare against recent old-copy samples even when the new rollout
    // chooses a different slow threshold. Its lifetime totals start at zero.
    seedWindow(baseline, now) {
        baseline.current(now);
        for (let p = 0; p < baseline.#size; p++) {
            const source = baseline.#page(p);
            const values = source.values.slice(source.first);
            this.#appendPage(source.start, values);
            for (let i = 0; i < values.length; i += CELL_SIZE) {
                const group = values[i + 1];
                if (typeof group !== 'number') {
                    const counts = { ...group.counts };
                    if (this.slowMs !== baseline.slowMs) counts.slowResponses = slowAbove(group.histogram, this.slowMs);
                    const histogram = group.histogram.map(bin => ({
                        ...bin, distinct: bin.distinct && new Map(bin.distinct),
                    }));
                    values[i + 1] = { counts, histogram };
                }
                applyCell(this.#window, values, i, this.slowMs, 1);
            }
        }
    }

    snapshot(now) {
        return { window: { ...this.current(now) }, sinceStart: { ...this.#sinceStart } };
    }
}
