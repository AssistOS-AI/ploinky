import crypto from 'node:crypto';

export const WEBTTY_LAUNCH_LIMITS = Object.freeze({
    maxTargetsPerDiscovery: 64,
    maxBatchesPerAuthSession: 3,
    maxLaunchRecords: 512,
    ttlMs: 5 * 60_000,
});

const SAFE_TARGET_KEYS = Object.freeze(['kind', 'label', 'detail', 'access', 'cwdDisplay']);
const DISPLAY_LIMITS = Object.freeze({ label: 128, detail: 256, cwdDisplay: 4 * 1024 });

function launchError(code, message = code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function randomId(randomBytes) {
    const value = randomBytes(24);
    if (!Buffer.isBuffer(value) || value.length !== 24) {
        throw launchError('WEBTTY_LAUNCH_RANDOMNESS_INVALID');
    }
    return value.toString('base64url');
}

function exactText(value) {
    return typeof value === 'string' && value === value.trim() && value ? value : '';
}

function exactOwner(owner) {
    const userId = exactText(owner?.userId);
    const sessionFingerprint = exactText(owner?.sessionFingerprint);
    if (!userId || !sessionFingerprint) throw launchError('WEBTTY_LAUNCH_OWNER_INVALID');
    return Object.freeze({ userId, sessionFingerprint });
}

function exactRouteBinding(binding) {
    const host = exactText(binding?.host);
    const hostRouteKey = exactText(binding?.hostRouteKey);
    const generation = exactText(binding?.generation);
    const activationId = exactText(binding?.activationId);
    if (!host || !hostRouteKey || !generation || !activationId) {
        throw launchError('WEBTTY_LAUNCH_ROUTE_INVALID');
    }
    return Object.freeze({ host, hostRouteKey, generation, activationId });
}

function ownerMatches(left, right) {
    return left.userId === right.userId && left.sessionFingerprint === right.sessionFingerprint;
}

function routeMatches(left, right) {
    return left.host === right.host
        && left.hostRouteKey === right.hostRouteKey
        && left.generation === right.generation
        && left.activationId === right.activationId;
}

function displayText(value, field) {
    if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)
        || Buffer.byteLength(value, 'utf8') > DISPLAY_LIMITS[field]) {
        throw launchError('WEBTTY_LAUNCH_TARGET_INVALID');
    }
    return value;
}

function safeTarget(target) {
    if (!target || !['box', 'agent'].includes(target.kind)
        || !['rw', 'ro'].includes(target.access)) {
        throw launchError('WEBTTY_LAUNCH_TARGET_INVALID');
    }
    const row = {
        kind: target.kind,
        label: displayText(target.label, 'label'),
        detail: displayText(target.detail, 'detail'),
        access: target.access,
        cwdDisplay: displayText(target.cwdDisplay, 'cwdDisplay'),
    };
    if (Object.keys(row).some((key) => !SAFE_TARGET_KEYS.includes(key))) {
        throw launchError('WEBTTY_LAUNCH_TARGET_INVALID');
    }
    return Object.freeze(row);
}

function cloneInternal(value) {
    if (Array.isArray(value)) return Object.freeze(value.map(cloneInternal));
    if (!value || typeof value !== 'object') return value;
    const cloned = {};
    for (const [key, entry] of Object.entries(value)) cloned[key] = cloneInternal(entry);
    return Object.freeze(cloned);
}

function canonicalDirectory(targets) {
    const relative = exactText(targets[0]?.directory?.relativePath) || (
        targets[0]?.directory?.relativePath === '' ? '' : null
    );
    if (relative === null) throw launchError('WEBTTY_LAUNCH_DIRECTORY_INVALID');
    for (const target of targets) {
        if (target?.directory?.relativePath !== relative) {
            throw launchError('WEBTTY_LAUNCH_DIRECTORY_INVALID');
        }
    }
    return relative;
}

export class WebttyLaunchRecordStore {
    constructor({
        now = () => Date.now(),
        randomBytes = crypto.randomBytes,
        limits = WEBTTY_LAUNCH_LIMITS,
    } = {}) {
        this.now = now;
        this.randomBytes = randomBytes;
        this.limits = Object.freeze({ ...WEBTTY_LAUNCH_LIMITS, ...limits });
        this.batches = new Map();
        this.launches = new Map();
    }

    cleanupExpired(now = this.now()) {
        for (const batch of [...this.batches.values()]) {
            if (batch.expiresAt <= now) this.removeBatch(batch);
        }
    }

    removeBatch(batch) {
        if (!batch || this.batches.get(batch.id) !== batch) return false;
        this.batches.delete(batch.id);
        for (const launchId of batch.launchIds) this.launches.delete(launchId);
        return true;
    }

    sessionBatches(owner) {
        return [...this.batches.values()]
            .filter((batch) => ownerMatches(batch.owner, owner))
            .sort((left, right) => left.createdAt - right.createdAt || left.sequence - right.sequence);
    }

    mintUniqueId(...collections) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const id = randomId(this.randomBytes);
            if (collections.every((collection) => !collection.has(id))) return id;
        }
        throw launchError('WEBTTY_LAUNCH_RANDOMNESS_INVALID');
    }

    createDiscovery({
        owner: ownerInput,
        routeBinding: routeBindingInput,
        targets,
        agentTargetsAvailable = true,
    } = {}) {
        const now = this.now();
        this.cleanupExpired(now);
        const owner = exactOwner(ownerInput);
        const routeBinding = exactRouteBinding(routeBindingInput);
        if (!Array.isArray(targets) || targets.length < 1
            || targets.length > this.limits.maxTargetsPerDiscovery
            || targets[0]?.kind !== 'box') {
            throw launchError('WEBTTY_LAUNCH_TARGET_INVALID');
        }
        const directory = canonicalDirectory(targets);
        const rows = targets.map(safeTarget);
        const prior = this.sessionBatches(owner);
        const evictionCount = Math.max(0, prior.length - this.limits.maxBatchesPerAuthSession + 1);
        const evictions = prior.slice(0, evictionCount);
        const evictedLaunches = evictions.reduce((total, batch) => total + batch.launchIds.length, 0);
        if (this.launches.size - evictedLaunches + targets.length > this.limits.maxLaunchRecords) {
            throw launchError('WEBTTY_LAUNCH_QUOTA');
        }
        const id = this.mintUniqueId(this.batches, this.launches);
        const reservedIds = new Set([id]);
        const expiresAt = now + this.limits.ttlMs;
        const batch = {
            id,
            owner,
            routeBinding,
            directory,
            createdAt: now,
            expiresAt,
            sequence: now + this.batches.size,
            launchIds: [],
        };
        const responseTargets = [];
        const stagedLaunches = [];
        for (let index = 0; index < targets.length; index += 1) {
            const launchId = this.mintUniqueId(this.batches, this.launches, reservedIds);
            reservedIds.add(launchId);
            const record = Object.freeze({
                id: launchId,
                batchId: id,
                owner,
                routeBinding,
                directory,
                createdAt: now,
                expiresAt,
                target: cloneInternal(targets[index]),
            });
            stagedLaunches.push([launchId, record]);
            batch.launchIds.push(launchId);
            responseTargets.push(Object.freeze({ launch: launchId, ...rows[index] }));
        }
        // Allocation and validation above are side-effect free. Only after the
        // complete replacement is staged do we atomically evict/install maps.
        for (const evicted of evictions) this.removeBatch(evicted);
        for (const [launchId, record] of stagedLaunches) this.launches.set(launchId, record);
        this.batches.set(id, batch);
        return Object.freeze({
            id,
            directory,
            expiresAt,
            agentTargetsAvailable: agentTargetsAvailable === true,
            targets: Object.freeze(responseTargets),
        });
    }

    cancelDiscovery({ id, owner: ownerInput, routeBinding: routeBindingInput } = {}) {
        this.cleanupExpired();
        const batch = this.batches.get(exactText(id));
        if (!batch) return false;
        let owner;
        let routeBinding;
        try {
            owner = exactOwner(ownerInput);
            routeBinding = exactRouteBinding(routeBindingInput);
        } catch (_) {
            return false;
        }
        if (!ownerMatches(batch.owner, owner) || !routeMatches(batch.routeBinding, routeBinding)) return false;
        return this.removeBatch(batch);
    }

    consume({ launch, owner: ownerInput, routeBinding: routeBindingInput } = {}) {
        const now = this.now();
        this.cleanupExpired(now);
        const record = this.launches.get(exactText(launch));
        if (!record) throw launchError('WEBTTY_LAUNCH_NOT_FOUND');
        let owner;
        let routeBinding;
        try {
            owner = exactOwner(ownerInput);
            routeBinding = exactRouteBinding(routeBindingInput);
        } catch (_) {
            throw launchError('WEBTTY_LAUNCH_NOT_FOUND');
        }
        if (record.expiresAt <= now || !ownerMatches(record.owner, owner)
            || !routeMatches(record.routeBinding, routeBinding)) {
            throw launchError('WEBTTY_LAUNCH_NOT_FOUND');
        }
        const batch = this.batches.get(record.batchId);
        if (!batch) throw launchError('WEBTTY_LAUNCH_NOT_FOUND');
        // This synchronous deletion is the atomic consume point. No await or
        // callback can observe this record as available after this line.
        this.removeBatch(batch);
        return record;
    }

    async consumeAndRevalidate({ revalidate, ...request } = {}) {
        if (typeof revalidate !== 'function') throw launchError('WEBTTY_LAUNCH_REVALIDATOR_INVALID');
        const record = this.consume(request);
        const target = await revalidate(record.target, record);
        return Object.freeze({ record, target });
    }

    invalidateAuthSession(sessionFingerprint) {
        const fingerprint = exactText(sessionFingerprint);
        if (!fingerprint) return 0;
        let removed = 0;
        for (const batch of [...this.batches.values()]) {
            if (batch.owner.sessionFingerprint === fingerprint && this.removeBatch(batch)) removed += 1;
        }
        return removed;
    }

    invalidateRouteBinding(routeBindingInput) {
        let routeBinding;
        try {
            routeBinding = exactRouteBinding(routeBindingInput);
        } catch (_) {
            return 0;
        }
        let removed = 0;
        for (const batch of [...this.batches.values()]) {
            if (routeMatches(batch.routeBinding, routeBinding) && this.removeBatch(batch)) removed += 1;
        }
        return removed;
    }

    invalidateReplacedGenerations(currentBindingInput) {
        const current = exactRouteBinding(currentBindingInput);
        let removed = 0;
        for (const batch of [...this.batches.values()]) {
            if (batch.routeBinding.host === current.host
                && batch.routeBinding.hostRouteKey === current.hostRouteKey
                && !routeMatches(batch.routeBinding, current)
                && this.removeBatch(batch)) removed += 1;
        }
        return removed;
    }

    hasAuthSession(sessionFingerprint) {
        this.cleanupExpired();
        const fingerprint = exactText(sessionFingerprint);
        return Boolean(fingerprint && [...this.batches.values()].some(
            (batch) => batch.owner.sessionFingerprint === fingerprint,
        ));
    }

    counts() {
        this.cleanupExpired();
        return Object.freeze({ batches: this.batches.size, launches: this.launches.size });
    }
}
