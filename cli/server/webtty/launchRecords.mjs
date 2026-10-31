import crypto from 'node:crypto';

export const WEBTTY_LAUNCH_LIMITS = Object.freeze({
    // The Box, up to 63 agent targets and the provider inventories (each is
    // bounded at 256 by the provider protocol and is never truncated).
    maxTargetsPerDiscovery: 320,
    maxBatchesPerAuthSession: 3,
    maxLaunchRecords: 1024,
    ttlMs: 5 * 60_000,
    attachTtlMs: 60_000,
    maxAttachRecords: 512,
});

const SAFE_TARGET_KEYS = Object.freeze(['kind', 'label', 'detail', 'access', 'cwdDisplay', 'provider', 'targetId']);
const DISPLAY_LIMITS = Object.freeze({ label: 128, detail: 256, cwdDisplay: 4 * 1024 });
const PROVIDER_TARGET_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PROVIDER_REASON = /^[a-z][a-z0-9_]{0,63}$/;

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
    const userId = typeof owner?.userId === 'string' ? owner.userId : '';
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
    if (!target || !['box', 'agent', 'provider'].includes(target.kind)
        || !['rw', 'ro'].includes(target.access)) {
        throw launchError('WEBTTY_LAUNCH_TARGET_INVALID');
    }
    // A row that carries a removed `unavailable` mark, or a provider name on a
    // target that no provider serves, is never turned into a launchable record.
    if (target.unavailable !== undefined
        || (target.kind !== 'provider' && (target.provider !== undefined || target.targetId !== undefined))) {
        throw launchError('WEBTTY_LAUNCH_TARGET_INVALID');
    }
    const row = {
        kind: target.kind,
        label: displayText(target.label, 'label'),
        detail: displayText(target.detail, 'detail'),
        access: target.access,
        cwdDisplay: displayText(target.cwdDisplay, 'cwdDisplay'),
    };
    // A provider row names the route of the provider that serves it, so the
    // dialog can show the target under that provider.
    if (target.kind === 'provider') {
        if (typeof target.provider !== 'string' || !PROVIDER_NAME.test(target.provider)) {
            throw launchError('WEBTTY_LAUNCH_TARGET_INVALID');
        }
        row.provider = target.provider;
        // The provider's opaque target id (administrator-only): a client that
        // knows which target it means binds to it by id, never by label.
        if (typeof target.targetId !== 'string' || !PROVIDER_TARGET_ID.test(target.targetId)) {
            throw launchError('WEBTTY_LAUNCH_TARGET_INVALID');
        }
        row.targetId = target.targetId;
    }
    if (Object.keys(row).some((key) => !SAFE_TARGET_KEYS.includes(key))) {
        throw launchError('WEBTTY_LAUNCH_TARGET_INVALID');
    }
    return Object.freeze(row);
}

// Provider notices: a provider that declares terminals but cannot list them.
// They carry a name and a reason code, never an error text.
function safeProviders(providers) {
    if (providers === undefined || providers === null) return [];
    if (!Array.isArray(providers) || providers.length > 64) throw launchError('WEBTTY_LAUNCH_TARGET_INVALID');
    return providers.map((entry) => {
        if (!entry || typeof entry !== 'object' || entry.available !== false
            || typeof entry.name !== 'string' || !PROVIDER_NAME.test(entry.name)
            || typeof entry.reason !== 'string' || !PROVIDER_REASON.test(entry.reason)) {
            throw launchError('WEBTTY_LAUNCH_TARGET_INVALID');
        }
        return Object.freeze({ name: entry.name, available: false, reason: entry.reason });
    });
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
        this.attachments = new Map();
    }

    cleanupExpired(now = this.now()) {
        for (const batch of [...this.batches.values()]) {
            if (batch.expiresAt <= now) this.removeBatch(batch);
        }
        for (const [id, record] of this.attachments) {
            if (record.expiresAt <= now) this.attachments.delete(id);
        }
    }

    // `supersedes` optionally names the view an explicit recovery replaces.
    // Only its format is checked here; the session manager decides whether
    // the claim applies when the single-use record is consumed.
    createAttachment({ owner, routeBinding, sessionId, supersedes = null } = {}) {
        this.cleanupExpired();
        if (this.attachments.size >= this.limits.maxAttachRecords) throw launchError('WEBTTY_LAUNCH_QUOTA');
        if (!/^[A-Za-z0-9_-]{32}$/.test(sessionId)) throw launchError('WEBTTY_SESSION_NOT_FOUND');
        if (supersedes !== null && (typeof supersedes !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(supersedes))) {
            throw launchError('WEBTTY_ATTACH_CLAIM_INVALID');
        }
        const record = Object.freeze({
            id: this.mintUniqueId(this.attachments, this.launches, this.batches),
            owner: exactOwner(owner),
            routeBinding: exactRouteBinding(routeBinding),
            sessionId,
            supersedes,
            expiresAt: this.now() + this.limits.attachTtlMs,
        });
        this.attachments.set(record.id, record);
        return Object.freeze({ attach: record.id, expiresAt: record.expiresAt });
    }

    consumeAttachment({ attach, owner, routeBinding } = {}) {
        this.cleanupExpired();
        const record = this.attachments.get(exactText(attach));
        try {
            if (!record || !ownerMatches(record.owner, exactOwner(owner))
                || !routeMatches(record.routeBinding, exactRouteBinding(routeBinding))) {
                throw launchError('WEBTTY_ATTACH_NOT_FOUND');
            }
        } catch (_) { throw launchError('WEBTTY_ATTACH_NOT_FOUND'); }
        this.attachments.delete(record.id);
        return record;
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
        providers = [],
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
        const notices = safeProviders(providers);
        const launchable = targets.length;
        const prior = this.sessionBatches(owner);
        const evictionCount = Math.max(0, prior.length - this.limits.maxBatchesPerAuthSession + 1);
        const evictions = prior.slice(0, evictionCount);
        const evictedLaunches = evictions.reduce((total, batch) => total + batch.launchIds.length, 0);
        if (this.launches.size - evictedLaunches + launchable > this.limits.maxLaunchRecords) {
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
            ...(notices.length ? { providers: Object.freeze(notices) } : {}),
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
        for (const [id, record] of this.attachments) {
            if (record.owner.sessionFingerprint === fingerprint) this.attachments.delete(id);
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
        for (const [id, record] of this.attachments) {
            if (routeMatches(record.routeBinding, routeBinding)) this.attachments.delete(id);
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
        for (const [id, record] of this.attachments) {
            if (record.routeBinding.host === current.host && record.routeBinding.hostRouteKey === current.hostRouteKey
                && !routeMatches(record.routeBinding, current)) this.attachments.delete(id);
        }
        return removed;
    }

    hasAuthSession(sessionFingerprint) {
        this.cleanupExpired();
        const fingerprint = exactText(sessionFingerprint);
        return Boolean(fingerprint && [...this.batches.values(), ...this.attachments.values()].some(
            (batch) => batch.owner.sessionFingerprint === fingerprint,
        ));
    }

    counts() {
        this.cleanupExpired();
        return Object.freeze({ batches: this.batches.size, launches: this.launches.size });
    }
}
