/**
 * replayCache.mjs — Ploinky-owned, fail-closed JWT replay caches.
 *
 * The verifier records each consumed `jti` here. A cache keeps a live entry for
 * the whole interval in which the verifier could still accept the token, and a
 * full cache refuses a new `jti` instead of forgetting a live one.
 *
 * Both caches serve either verifier interface:
 *   - `consume(jti, ttlMs)` checks and records in one call and keeps the entry
 *     for exactly `ttlMs` (current shared JWT library);
 *   - `seen(jti)` + `remember(jti, ttlMs)` (older shared JWT library, which
 *     under-reports `ttlMs`), so `remember` retains at least
 *     `legacyMinRetentionMs`.
 *
 * Expiry is lazy: an entry is live while its expiry is after `now()`. Map
 * insertion order follows the last record, so each call drops the expired
 * prefix in O(1) amortized time; one full sweep, at most once per second per
 * partition and once per second for the whole table, runs before a quota or
 * capacity refusal so sustained flooding is refused in O(1).
 */

import crypto from 'node:crypto';

export const REPLAY_CACHE_EXHAUSTED_CODE = 'JWT_REPLAY_CACHE_EXHAUSTED';
export const REPLAY_QUOTA_EXHAUSTED_CODE = 'PLOINKY_REPLAY_QUOTA_EXHAUSTED';
export const REPLAY_PARTITION_REQUIRED_CODE = 'PLOINKY_REPLAY_PARTITION_REQUIRED';
export const REPLAY_PARTITION_INVALID_CODE = 'PLOINKY_REPLAY_PARTITION_INVALID';
export const REPLAY_CLOCK_INVALID_CODE = 'PLOINKY_REPLAY_CLOCK_INVALID';
export const REPLAY_JTI_INVALID_CODE = 'PLOINKY_REPLAY_JTI_INVALID';
// Router and agent issuers mint 22-character jtis (the relay minter mints 24 and
// uses its own cache). Defined here rather than imported so
// the bound also holds with an older shared JWT library that has no such check.
export const MAX_JTI_LENGTH = 128;

const SWEEP_INTERVAL_MS = 1000;
const MAX_PARTITION_KEY_LENGTH = 512;

function replayError(message, code, status) {
    const error = new Error(message);
    error.code = code;
    if (status) error.status = status;
    return error;
}

function capacityExhausted(message = 'replayCache: replay cache capacity exhausted') {
    return replayError(message, REPLAY_CACHE_EXHAUSTED_CODE, 503);
}

function positiveInteger(value, name) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw new TypeError(`replayCache: ${name} must be a positive safe integer`);
    }
    return number;
}

function nonNegativeNumber(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new TypeError(`replayCache: ${name} must be a finite number >= 0`);
    }
    return number;
}

function clockInvalid(message) {
    return replayError(`replayCache: ${message}`, REPLAY_CLOCK_INVALID_CODE, 503);
}

// Returns a reader that refuses a non-finite time before any entry is read or
// removed: such a reading would make every entry look expired and admit replays.
function finiteClock(now) {
    if (typeof now !== 'function') throw clockInvalid('now must be a function');
    return () => {
        const currentTime = Number(now());
        if (!Number.isFinite(currentTime)) throw clockInvalid('clock returned a non-finite time');
        return currentTime;
    };
}

// Refuses a jti the cache must not store, before any allocation or sweep. It
// carries no status, so callers keep their ordinary 401 rejection.
function assertJti(jti) {
    if (typeof jti !== 'string' || jti.length > MAX_JTI_LENGTH) {
        throw replayError(
            `replayCache: jti must be a string of at most ${MAX_JTI_LENGTH} characters`,
            REPLAY_JTI_INVALID_CODE,
        );
    }
}

// Entries and partitions are keyed by a fixed-size digest, never by the
// caller's string: a jti or issuer parsed from a token may be a slice that keeps
// the whole decoded payload alive for as long as the entry lives.
function digestKey(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('base64url');
}

function entryKey(jti) {
    assertJti(jti);
    return digestKey(jti);
}

function retentionMs(ttlMs) {
    return Math.max(1, Number(ttlMs) || 1);
}

/**
 * Worst-case acceptance interval of a token, for an older shared JWT library
 * that reports a TTL shorter than the verifier's acceptance window: a token
 * issued up to `clockSkewSeconds` in the future stays acceptable for
 * `maxTtlSeconds` plus another skew, plus the rounding/clock margin.
 */
export function legacyMinRetentionMs({ maxTtlSeconds, clockSkewSeconds = 30, marginMs = 2000 } = {}) {
    const ttl = nonNegativeNumber(maxTtlSeconds, 'maxTtlSeconds');
    const skew = nonNegativeNumber(clockSkewSeconds, 'clockSkewSeconds');
    const margin = nonNegativeNumber(marginMs, 'marginMs');
    return ((ttl + (2 * skew)) * 1000) + margin;
}

/** HTTP status for a replay quota, capacity or clock refusal; null for every other error. */
export function replayRefusalStatus(error) {
    switch (error?.code) {
        case REPLAY_QUOTA_EXHAUSTED_CODE:
            return 429;
        case REPLAY_CACHE_EXHAUSTED_CODE:
        case REPLAY_CLOCK_INVALID_CODE:
            return 503;
        default:
            return null;
    }
}

// One insertion-ordered jti -> expiresAt map plus its full-sweep throttle.
function createEntrySet() {
    return { entries: new Map(), lastFullSweepAt: -Infinity };
}

function isLive(set, jti, currentTime) {
    const expiresAt = set?.entries.get(jti);
    return expiresAt !== undefined && expiresAt > currentTime;
}

// Each sweep returns the number of entries it deleted, so callers keep counts exact.
function sweepExpiredPrefix(set, currentTime) {
    let removed = 0;
    for (const [jti, expiresAt] of set.entries) {
        if (expiresAt > currentTime) break;
        set.entries.delete(jti);
        removed += 1;
    }
    return removed;
}

function sweepAllExpired(set, currentTime) {
    let removed = 0;
    for (const [jti, expiresAt] of set.entries) {
        if (expiresAt <= currentTime) {
            set.entries.delete(jti);
            removed += 1;
        }
    }
    return removed;
}

function throttledSweep(set, currentTime) {
    if (currentTime - set.lastFullSweepAt < SWEEP_INTERVAL_MS) return 0;
    set.lastFullSweepAt = currentTime;
    return sweepAllExpired(set, currentTime);
}

// Stores max(existing live expiry, now + ttl) and re-inserts at the end.
// Returns 1 when the key was absent (one more stored entry), else 0.
function storeEntry(set, jti, ttlMs, currentTime) {
    const existing = set.entries.get(jti);
    const requested = currentTime + retentionMs(ttlMs);
    const expiresAt = existing !== undefined && existing > currentTime ? Math.max(existing, requested) : requested;
    set.entries.delete(jti);
    set.entries.set(jti, expiresAt);
    return existing === undefined ? 1 : 0;
}

/**
 * Single fail-closed cache with a hard `maxSize`. Used where only one trusted
 * issuer can fill the cache (agent-side Router Request verification).
 */
export function createBoundedReplayCache({
    maxSize,
    legacyMinRetentionMs: legacyFloorMs = 0,
    now = () => Date.now(),
} = {}) {
    const capacity = positiveInteger(maxSize, 'maxSize');
    const floorMs = nonNegativeNumber(legacyFloorMs, 'legacyMinRetentionMs');
    const readClock = finiteClock(now);
    const set = createEntrySet();

    function startCall() {
        const currentTime = readClock();
        sweepExpiredPrefix(set, currentTime);
        return currentTime;
    }

    function record(jti, ttlMs, currentTime) {
        if (!isLive(set, jti, currentTime)) {
            set.entries.delete(jti);
            if (set.entries.size >= capacity) {
                throttledSweep(set, currentTime);
                if (set.entries.size >= capacity) throw capacityExhausted();
            }
        }
        storeEntry(set, jti, ttlMs, currentTime);
    }

    return Object.freeze({
        consume(jti, ttlMs) {
            const key = entryKey(jti);
            const currentTime = startCall();
            if (isLive(set, key, currentTime)) return false;
            record(key, ttlMs, currentTime);
            return true;
        },
        seen(jti) {
            const key = entryKey(jti);
            return isLive(set, key, startCall());
        },
        remember(jti, ttlMs) {
            const key = entryKey(jti);
            record(key, Math.max(retentionMs(ttlMs), floorMs), startCall());
        },
        reset() {
            set.entries.clear();
            set.lastFullSweepAt = -Infinity;
        },
        size() {
            startCall();
            return set.entries.size;
        },
    });
}

/**
 * Router-side cache shared by many callers. Each caller key (a verified agent
 * principal) gets its own quota of `perCallerMaxSize` live entries, so one
 * caller exhausting its quota is refused with 429 while other callers keep
 * working. `maxSize` bounds all partitions together and `maxPartitions` bounds
 * the number of callers; either ceiling refuses with 503.
 *
 * Callers must use `forCaller(key)`; the root interface throws so that an older
 * verifier which only probes `seen` cannot silently skip replay protection.
 */
export function createPartitionedReplayCache({
    perCallerMaxSize = 16384,
    maxSize = 131072,
    maxPartitions = 256,
    legacyMinRetentionMs: legacyFloorMs = 0,
    now = () => Date.now(),
} = {}) {
    const globalCapacity = positiveInteger(maxSize, 'maxSize');
    const quota = Math.min(positiveInteger(perCallerMaxSize, 'perCallerMaxSize'), globalCapacity);
    const partitionCapacity = positiveInteger(maxPartitions, 'maxPartitions');
    const floorMs = nonNegativeNumber(legacyFloorMs, 'legacyMinRetentionMs');
    const readClock = finiteClock(now);
    const partitions = new Map();
    let total = 0;
    let lastGlobalSweepAt = -Infinity;

    function deleteIfEmpty(key, set) {
        if (set.entries.size === 0 && partitions.get(key) === set) partitions.delete(key);
    }

    function pruneEmptyPartitions() {
        for (const [key, set] of partitions) deleteIfEmpty(key, set);
    }

    function throttledGlobalSweep(currentTime) {
        if (currentTime - lastGlobalSweepAt < SWEEP_INTERVAL_MS) return;
        lastGlobalSweepAt = currentTime;
        for (const [key, set] of partitions) {
            total -= sweepAllExpired(set, currentTime);
            deleteIfEmpty(key, set);
        }
    }

    // Sweeps the caller's expired prefix and returns its partition, or
    // undefined when the caller has no live entries (nothing is allocated).
    function currentPartition(key, currentTime) {
        const set = partitions.get(key);
        if (!set) return undefined;
        total -= sweepExpiredPrefix(set, currentTime);
        deleteIfEmpty(key, set);
        return partitions.get(key);
    }

    function admitNewEntry(key, currentTime) {
        if (!partitions.has(key) && partitions.size >= partitionCapacity) {
            pruneEmptyPartitions();
            throttledGlobalSweep(currentTime);
            if (!partitions.has(key) && partitions.size >= partitionCapacity) {
                throw capacityExhausted('replayCache: replay cache partition table exhausted');
            }
        }
        const set = partitions.get(key);
        if (set && set.entries.size >= quota) {
            const removed = throttledSweep(set, currentTime);
            total -= removed;
            if (set.entries.size >= quota) {
                throw replayError('replayCache: replay quota exhausted', REPLAY_QUOTA_EXHAUSTED_CODE, 429);
            }
            deleteIfEmpty(key, set);
        }
        if (total >= globalCapacity) {
            throttledGlobalSweep(currentTime);
            if (total >= globalCapacity) throw capacityExhausted();
        }
    }

    function record(key, jti, ttlMs, currentTime) {
        const existing = currentPartition(key, currentTime);
        if (existing && isLive(existing, jti, currentTime)) {
            storeEntry(existing, jti, ttlMs, currentTime);
            return;
        }
        if (existing && existing.entries.delete(jti)) {
            total -= 1;
            deleteIfEmpty(key, existing);
        }
        admitNewEntry(key, currentTime);
        // Look the partition up only after every sweep, so the write can never
        // land in a partition object that a sweep has already detached.
        let set = partitions.get(key);
        if (!set) {
            set = createEntrySet();
            partitions.set(key, set);
        }
        total += storeEntry(set, jti, ttlMs, currentTime);
    }

    function assertPartitionKey(key) {
        if (typeof key !== 'string' || key.length === 0 || key.length > MAX_PARTITION_KEY_LENGTH) {
            throw replayError('replayCache: replay partition key is invalid', REPLAY_PARTITION_INVALID_CODE);
        }
    }

    function partitionRequired() {
        throw replayError(
            'replayCache: partitioned replay cache requires forCaller(key)',
            REPLAY_PARTITION_REQUIRED_CODE,
            503,
        );
    }

    return Object.freeze({
        // The view keeps only the key and resolves the partition on every call:
        // a caller may await between forCaller() and consume(), during which a
        // sweep can delete and later recreate the partition.
        forCaller(callerKey) {
            assertPartitionKey(callerKey);
            // The issuer key on the assertion path is parsed from token bytes.
            const key = digestKey(callerKey);
            return Object.freeze({
                consume(jti, ttlMs) {
                    const entry = entryKey(jti);
                    const currentTime = readClock();
                    if (isLive(currentPartition(key, currentTime), entry, currentTime)) return false;
                    record(key, entry, ttlMs, currentTime);
                    return true;
                },
                seen(jti) {
                    const entry = entryKey(jti);
                    const currentTime = readClock();
                    return isLive(currentPartition(key, currentTime), entry, currentTime);
                },
                remember(jti, ttlMs) {
                    const entry = entryKey(jti);
                    record(key, entry, Math.max(retentionMs(ttlMs), floorMs), readClock());
                },
            });
        },
        consume: partitionRequired,
        seen: partitionRequired,
        remember: partitionRequired,
        reset() {
            partitions.clear();
            total = 0;
            lastGlobalSweepAt = -Infinity;
        },
        stats() {
            return { partitions: partitions.size, entries: total };
        },
    });
}

export default {
    REPLAY_CACHE_EXHAUSTED_CODE,
    REPLAY_QUOTA_EXHAUSTED_CODE,
    REPLAY_PARTITION_REQUIRED_CODE,
    REPLAY_PARTITION_INVALID_CODE,
    REPLAY_CLOCK_INVALID_CODE,
    REPLAY_JTI_INVALID_CODE,
    MAX_JTI_LENGTH,
    createBoundedReplayCache,
    createPartitionedReplayCache,
    legacyMinRetentionMs,
    replayRefusalStatus,
};
