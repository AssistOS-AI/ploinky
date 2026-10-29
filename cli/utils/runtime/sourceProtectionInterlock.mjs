// Generic serialized source-protection interlock (frozen T0 §5-§6 + A1.2 +
// A1.5 + A2.2-A2.4 + A3 + A4). Reservations, source transitions, releases,
// holder acknowledgements and worker-generation advances share one
// controller-private store and one lock domain.
//
// Every operation takes a nonserializable verified management context minted by
// the trusted authority passed at construction (brand by identity: a copied or
// foreign context is refused), then the exact request document. Results are
// exactly `{ok:true,value}` (deep-frozen) or `{ok:false,error:{code}}`.
//
// Trusted facts come only from injected providers. Every default provider
// refuses: without wiring nothing is protected, no holder is known and no
// release is proved. T1 registers no route and wires no lifecycle call site.
//
// Lock order: lifecycle callers hold the workspace mutation lease before this
// store lock; reservation callers take only the store lock and must never
// acquire the workspace lease while an operation is in progress.

import {
    CONTRACT_ERROR_CODES,
    INTERLOCK_LIMITS_V1,
    SOURCE_KINDS,
    digestOrThrow,
    errorResult,
    isFsIdentity,
    isOpaqueIdentity,
    isPrincipal,
    okResult,
    resourcesDigestOf,
    sameInode,
    validateSourceClosure,
    validateSourceOperation,
    validateSourceSelection,
} from '../../server/executionTarget/contract.mjs';
import {
    SUPERSEDED_GENERATION_HISTORY_BOUND,
    isSimulatedCrash,
    isStoreError,
} from './sourceProtectionStore.mjs';

export { INTERLOCK_LIMITS_V1, SUPERSEDED_GENERATION_HISTORY_BOUND };

export const INTERLOCK_ERROR_CODES = Object.freeze({
    invalidRequest: CONTRACT_ERROR_CODES.invalidRequest,
    unsupportedVersion: CONTRACT_ERROR_CODES.unsupportedVersion,
    noncanonicalEncoding: CONTRACT_ERROR_CODES.noncanonicalEncoding,
    unauthorized: 'unauthorized',
    forbidden: 'forbidden',
    staleGeneration: 'stale_generation',
    staleSourceEpoch: 'stale_source_epoch',
    sourceUnavailable: 'source_unavailable',
    sourceUnprotected: 'source_unprotected',
    protectedSourceOverlap: 'protected_source_overlap',
    sourceAliasUnproven: 'source_alias_unproven',
    sourceProvenanceUnaccepted: 'source_provenance_unaccepted',
    sourceBindingMismatch: 'source_binding_mismatch',
    sourceTransitionBlocked: 'source_transition_blocked',
    releaseUnverified: 'release_unverified',
    resourceQuarantined: 'resource_quarantined',
    notFound: 'not_found',
    operationConflict: 'operation_conflict',
    capacityExceeded: 'capacity_exceeded',
    stateCorrupt: 'state_corrupt',
    outcomeUnknown: 'outcome_unknown',
});

const E = INTERLOCK_ERROR_CODES;

// ---------------------------------------------------------------- verified management contexts

const CONTEXTS = new WeakMap();

class VerifiedManagementContext {
    toJSON() {
        throw new TypeError('a verified management context is not serializable');
    }
}

/**
 * The trusted issuer of management contexts. Only code that authenticated a
 * current worker instance, or holds trusted operator lifecycle authority,
 * may hold it. The interlock accepts only contexts minted by the exact
 * authority object it was constructed with.
 */
export function createManagementContextAuthority() {
    const authority = Object.freeze({
        worker({ workerPrincipal, workerRuntimeInstanceId, workerEnableGeneration, workerGeneration }) {
            if (!isPrincipal(workerPrincipal) || !isOpaqueIdentity(workerRuntimeInstanceId)
                || !isOpaqueIdentity(workerEnableGeneration) || typeof workerGeneration !== 'string') {
                throw new TypeError('invalid worker context');
            }
            const context = Object.freeze(new VerifiedManagementContext());
            CONTEXTS.set(context, Object.freeze({
                authority,
                actor: Object.freeze({
                    kind: 'worker', workerPrincipal, workerRuntimeInstanceId, workerEnableGeneration, workerGeneration,
                }),
            }));
            return context;
        },
        operator({ operatorIdentity }) {
            if (!isOpaqueIdentity(operatorIdentity)) throw new TypeError('invalid operator context');
            const context = Object.freeze(new VerifiedManagementContext());
            CONTEXTS.set(context, Object.freeze({ authority, actor: Object.freeze({ kind: 'operator', operatorIdentity }) }));
            return context;
        },
    });
    return authority;
}

// ---------------------------------------------------------------- refusing defaults

export const DEFAULT_SOURCE_EVIDENCE = Object.freeze({
    enforcement: async () => ({ status: 'unprotected' }),
    aliasCoverage: async () => ({ status: 'unproven' }),
    resolveWritableResource: async () => ({ status: 'unknown' }),
    provenance: async () => ({ status: 'unaccepted' }),
    releaseEvidence: async () => ({ status: 'unverified' }),
});

const DEFAULT_HOLDER_PREDICATE = async () => ({ status: 'unknown' });
const DEFAULT_SCOPE = async () => null;

// ---------------------------------------------------------------- pure helpers

function isAbsolutePath(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || /[\u0000-\u001f\u007f]/.test(value)) return false;
    if (value === '/') return true;
    return !value.endsWith('/') && value.slice(1).split('/').every((part) => part && part !== '.' && part !== '..');
}

function segments(value) {
    return value === '/' ? [] : value.slice(1).split('/');
}

/** Equal, ancestor or descendant, compared by whole path segments. */
export function pathsOverlap(left, right) {
    const a = segments(left);
    const b = segments(right);
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) if (a[index] !== b[index]) return false;
    return true;
}

function validCoverage(evidence) {
    if (!evidence || evidence.status !== 'complete' || !Array.isArray(evidence.roots) || evidence.roots.length < 1) {
        return null;
    }
    const roots = [];
    for (const root of evidence.roots) {
        if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
        const keys = Object.keys(root).sort().join(',');
        if (keys !== 'aliases,kind,paths,rootIdentity,writable') return null;
        if (!SOURCE_KINDS.includes(root.kind) || !isFsIdentity(root.rootIdentity) || typeof root.writable !== 'boolean') {
            return null;
        }
        if (!Array.isArray(root.paths) || root.paths.length < 1 || !root.paths.every(isAbsolutePath)) return null;
        if (!Array.isArray(root.aliases) || !root.aliases.every(isFsIdentity)) return null;
        roots.push(root);
    }
    let digest;
    try {
        digest = digestOrThrow({ version: 1, roots });
    } catch (_) {
        return null;
    }
    return { roots, digest };
}

/** Digest a trusted alias-coverage provider must report for its roots. */
export function aliasCoverageDigest(roots) {
    return digestOrThrow({ version: 1, roots });
}

function validResourceView(view, resource) {
    if (!view || view.status !== 'resolved' || !Array.isArray(view.paths) || !Array.isArray(view.identities)) return null;
    if (view.paths.length < 1 || !view.paths.every(isAbsolutePath) || !view.identities.every(isFsIdentity)) return null;
    return { paths: view.paths, identities: [resource.rootIdentity, ...view.identities] };
}

/**
 * Classify one writable resource view against protected source roots:
 * `overlap` for an inode/bind/hard-link alias of a protected root or alias,
 * or any equal/ancestor/descendant path; otherwise `disjoint`.
 */
export function classifyWritableOverlap(view, roots) {
    for (const root of roots) {
        const protectedIdentities = [root.rootIdentity, ...root.aliases];
        if (view.identities.some((identity) => protectedIdentities.some((other) => sameInode(identity, other)))) {
            return 'overlap';
        }
        if (view.paths.some((candidate) => root.paths.some((protectedPath) => pathsOverlap(candidate, protectedPath)))) {
            return 'overlap';
        }
    }
    return 'disjoint';
}

function covered(identity, roots) {
    return roots.some((root) => sameInode(root.rootIdentity, identity)
        || root.aliases.some((alias) => sameInode(alias, identity)));
}

async function ask(provider, argument) {
    try {
        return await provider(argument);
    } catch (_) {
        return null;
    }
}

function validScope(scope) {
    if (!scope || typeof scope !== 'object') return null;
    if (!isOpaqueIdentity(scope.workspaceId) || !isOpaqueIdentity(scope.boxIdentity) || !isOpaqueIdentity(scope.boxGeneration)) {
        return null;
    }
    if (!scope.workerInstances || typeof scope.workerInstances !== 'object') return null;
    return scope;
}

function pointerOf(snapshot, principal) {
    return snapshot.generations.find((pointer) => pointer.workerPrincipal === principal) || null;
}

function workerStaleness(actor, scope, snapshot) {
    const instance = Object.hasOwn(scope.workerInstances, actor.workerPrincipal)
        ? scope.workerInstances[actor.workerPrincipal] : null;
    if (!instance || instance.workerRuntimeInstanceId !== actor.workerRuntimeInstanceId
        || instance.workerEnableGeneration !== actor.workerEnableGeneration) {
        return E.staleGeneration;
    }
    const pointer = pointerOf(snapshot, actor.workerPrincipal);
    if (!pointer || pointer.currentGeneration !== actor.workerGeneration) return E.staleGeneration;
    return null;
}

function scopeMismatch(request, scope) {
    if (request.workspaceId !== scope.workspaceId || request.boxIdentity !== scope.boxIdentity) return E.forbidden;
    if (request.boxGeneration !== scope.boxGeneration) return E.staleGeneration;
    return null;
}

function findOperation(snapshot, operationId) {
    const reservation = snapshot.reservations.find((item) => item.operationId === operationId);
    if (reservation) return { type: 'reservation', item: reservation };
    const tombstone = snapshot.tombstones.find((item) => item.operationId === operationId);
    if (tombstone) return { type: 'tombstone', item: tombstone };
    const receipt = snapshot.receipts.find((item) => item.operationId === operationId);
    return receipt ? { type: 'receipt', item: receipt } : null;
}

function sameActor(stored, actor) {
    if (stored.kind !== actor.kind) return false;
    return actor.kind === 'worker'
        ? stored.workerPrincipal === actor.workerPrincipal
        : stored.operatorIdentity === actor.operatorIdentity;
}

// Receipt replay: identical body from the same actor returns the stored
// result; anything else under the operation ID conflicts.
function replayReceipt(found, kind, requestDigest, actor) {
    if (!found) return null;
    if (found.type === 'receipt' && found.item.kind === kind && found.item.requestDigest === requestDigest
        && sameActor(found.item.actor, actor)) {
        return { value: found.item.result };
    }
    return { code: E.operationConflict };
}

function storedActor(actor) {
    return actor.kind === 'worker'
        ? { kind: 'worker', workerPrincipal: actor.workerPrincipal, workerGeneration: actor.workerGeneration }
        : { kind: 'operator', operatorIdentity: actor.operatorIdentity };
}

function byKey(key) {
    return (left, right) => (left[key] < right[key] ? -1 : left[key] > right[key] ? 1 : 0);
}

// A2.3: entries of a non-current generation with no unreleased reservation
// may be compacted; current-generation entries and unreleased reservations
// never are.
export function compactSupersededGenerations(document) {
    const current = new Map(document.generations.map((pointer) => [pointer.workerPrincipal, pointer.currentGeneration]));
    const pinned = new Set(document.reservations.map((item) => `${item.workerPrincipal}\n${item.workerGeneration}`));
    const keep = (principal, generation) => principal === null
        || current.get(principal) === generation
        || pinned.has(`${principal}\n${generation}`);
    return {
        ...document,
        tombstones: document.tombstones.filter((item) => keep(item.workerPrincipal, item.workerGeneration)),
        receipts: document.receipts.filter((item) => keep(item.ownerPrincipal, item.ownerGeneration)),
    };
}

function withinBudget(document, limits) {
    return document.reservations.length <= limits.writableReservations
        && document.tombstones.length + document.receipts.length + 2 * document.reservations.length
            <= limits.operationReceipts;
}

function mutable(snapshot) {
    return {
        holders: snapshot.holders,
        record: snapshot.record,
        generations: [...snapshot.generations],
        reservations: [...snapshot.reservations],
        tombstones: [...snapshot.tombstones],
        receipts: [...snapshot.receipts],
    };
}

function receipt({ operationId, kind, requestDigest, actor, ownerPrincipal, ownerGeneration, result }) {
    return {
        operationId, kind, requestDigest, actor: storedActor(actor), ownerPrincipal, ownerGeneration, result,
    };
}

// ---------------------------------------------------------------- interlock

/**
 * Options:
 *   store                        handle from openSourceProtectionStore
 *   authority                    createManagementContextAuthority() result
 *   currentScope()               trusted live scope {workspaceId, boxIdentity, boxGeneration, workerInstances}
 *   isSourceReservationHolder(p) trusted predicate -> {status:'holder'|'not-holder'}; default unknown
 *   evidence                     trusted providers (see DEFAULT_SOURCE_EVIDENCE); defaults refuse
 *   clock                        {nowMs}
 */
export function createSourceProtectionInterlock({
    store,
    authority,
    currentScope = DEFAULT_SCOPE,
    isSourceReservationHolder = DEFAULT_HOLDER_PREDICATE,
    evidence = {},
    clock = { nowMs: () => Date.now() },
} = {}) {
    if (!store || typeof store.exclusive !== 'function' || !authority) {
        throw new TypeError('createSourceProtectionInterlock requires a store and a context authority');
    }
    const providers = Object.freeze({ ...DEFAULT_SOURCE_EVIDENCE, ...evidence });
    const { limits, storeId } = store;

    function actorOf(context) {
        if (context === undefined || context === null) return { code: E.unauthorized };
        const entry = (typeof context === 'object' || typeof context === 'function') ? CONTEXTS.get(context) : undefined;
        if (!entry || entry.authority !== authority) return { code: E.forbidden };
        return { actor: entry.actor };
    }

    async function holderStatus(principal) {
        const answer = await ask(isSourceReservationHolder, principal);
        if (answer?.status === 'holder') return 'holder';
        if (answer?.status === 'not-holder') return 'not-holder';
        return 'unknown';
    }

    async function operate(kind, context, request, handler) {
        const resolved = actorOf(context);
        if (resolved.code) return errorResult(resolved.code);
        const validated = validateSourceOperation(kind, request);
        if (!validated.ok) return validated;
        if (Object.hasOwn(validated.value, 'requestDigest')) return errorResult(E.invalidRequest);
        const body = validated.value;
        const requestDigest = digestOrThrow(body);
        try {
            return await store.exclusive(async (transaction) => {
                const snapshot = transaction.snapshot();
                const scope = validScope(await ask(currentScope));
                if (!scope) return errorResult(E.sourceUnavailable);
                const outcome = await handler({
                    transaction, snapshot, scope, actor: resolved.actor, request: body, requestDigest,
                });
                if (outcome.code) return errorResult(outcome.code);
                if (outcome.next) {
                    const next = compactSupersededGenerations(outcome.next);
                    if (!withinBudget(next, limits)) return errorResult(E.capacityExceeded);
                    for (const [put, document] of outcome.content || []) transaction[put](document);
                    transaction.commit(next);
                    transaction.crashPoint('beforeReply', { kind, operationId: body.operationId });
                }
                const check = validateSourceOperation(kind, outcome.value);
                if (!check.ok) return errorResult(E.stateCorrupt);
                return okResult(outcome.value);
            });
        } catch (error) {
            if (isSimulatedCrash(error)) return errorResult(E.outcomeUnknown);
            if (isStoreError(error)) {
                if (error.committed) return errorResult(E.outcomeUnknown);
                if ([E.stateCorrupt, E.sourceUnavailable, E.capacityExceeded, E.outcomeUnknown].includes(error.code)) {
                    return errorResult(error.code);
                }
            }
            return errorResult(E.outcomeUnknown);
        }
    }

    async function verifyProtection(record) {
        const enforcement = await ask(providers.enforcement, { phase: 'reserve', record });
        if (enforcement?.status !== 'protected' || enforcement.enforcementDigest !== record.enforcementDigest) {
            return { code: E.sourceUnprotected };
        }
        const coverage = validCoverage(await ask(providers.aliasCoverage, { phase: 'reserve', record }));
        if (!coverage || coverage.digest !== record.aliasCoverageDigest) return { code: E.sourceAliasUnproven };
        if (coverage.roots.some((root) => root.writable)) return { code: E.sourceUnprotected };
        return { coverage };
    }

    // ------------------------------------------------------------ reserve

    async function reserveWritableResources(context, request) {
        return operate('reserve', context, request, async ({ snapshot, scope, actor, request: body, requestDigest }) => {
            if (actor.kind !== 'worker') return { code: E.forbidden };
            if (body.workspaceId !== scope.workspaceId || body.boxIdentity !== scope.boxIdentity) return { code: E.forbidden };
            // A6.2 (amends A3.3): the operation lookup comes first. An identical
            // body returns what was recorded even from a superseded generation or
            // after the epoch advanced; nothing new is ever created that way.
            const found = findOperation(snapshot, body.operationId);
            if (found) {
                const item = found.type === 'receipt' ? null : found.item;
                if (!item || item.workerPrincipal !== actor.workerPrincipal || item.requestDigest !== requestDigest) {
                    return { code: E.operationConflict };
                }
                return {
                    value: found.type === 'reservation'
                        ? item
                        : { version: 1, ...item, sourceStoreIdentity: storeId },
                };
            }
            if (body.boxGeneration !== scope.boxGeneration) return { code: E.staleGeneration };
            const stale = workerStaleness(actor, scope, snapshot);
            if (stale || body.workerGeneration !== actor.workerGeneration) return { code: E.staleGeneration };
            const holder = await holderStatus(actor.workerPrincipal);
            if (holder === 'not-holder') return { code: E.forbidden };
            if (holder !== 'holder') return { code: E.sourceUnavailable };
            if (!snapshot.holders.acknowledged.includes(actor.workerPrincipal)) return { code: E.sourceUnavailable };
            const { record } = snapshot;
            if (!record || record.protectionStatus !== 'protected' || record.boxGeneration !== scope.boxGeneration
                || record.workspaceId !== scope.workspaceId || record.boxIdentity !== scope.boxIdentity) {
                return { code: E.sourceUnprotected };
            }
            if (body.expectedEpoch !== record.sourceProtectionEpoch) return { code: E.staleSourceEpoch };
            if (snapshot.reservations.some((item) => item.reservationId === body.reservationId)
                || snapshot.tombstones.some((item) => item.reservationId === body.reservationId)) {
                return { code: E.operationConflict };
            }
            if (snapshot.reservations.length + 1 > limits.writableReservations
                || snapshot.tombstones.length + snapshot.receipts.length + 2 * (snapshot.reservations.length + 1)
                    > limits.operationReceipts) {
                return { code: E.capacityExceeded };
            }
            const protection = await verifyProtection(record);
            if (protection.code) return protection;
            for (const resource of body.resources) {
                if (resource.aliasCoverageDigest !== record.aliasCoverageDigest) return { code: E.sourceAliasUnproven };
                const view = validResourceView(await ask(providers.resolveWritableResource, resource), resource);
                if (!view) return { code: E.sourceAliasUnproven };
                if (classifyWritableOverlap(view, protection.coverage.roots) !== 'disjoint') {
                    return { code: E.protectedSourceOverlap };
                }
            }
            const reservation = {
                version: 1,
                reservationId: body.reservationId,
                operationId: body.operationId,
                workspaceId: body.workspaceId,
                boxIdentity: body.boxIdentity,
                boxGeneration: body.boxGeneration,
                sourceStoreIdentity: storeId,
                workerPrincipal: actor.workerPrincipal,
                workerRuntimeInstanceId: actor.workerRuntimeInstanceId,
                workerEnableGeneration: actor.workerEnableGeneration,
                workerGeneration: actor.workerGeneration,
                robotId: body.robotId,
                executionId: body.executionId,
                attemptId: body.attemptId,
                consumerKind: body.consumerKind,
                consumerId: body.consumerId,
                sourceProtectionEpoch: record.sourceProtectionEpoch,
                sourceSelectionDigest: record.sourceSelectionDigest,
                sourceClosureDigest: record.sourceClosureDigest,
                sourceAcceptanceIdentity: record.sourceAcceptanceIdentity,
                resources: body.resources,
                requestDigest,
                state: 'reserved',
                createdAtMs: clock.nowMs(),
                releaseEvidenceDigest: null,
            };
            const next = mutable(snapshot);
            next.reservations = [...next.reservations, reservation].sort(byKey('reservationId'));
            return { next, value: reservation };
        });
    }

    // ------------------------------------------------------------ transition

    async function prepareSourceTransition(context, request) {
        return operate('transition', context, request, async ({ snapshot, scope, actor, request: body, requestDigest }) => {
            if (actor.kind !== 'operator') return { code: E.forbidden };
            const mismatch = scopeMismatch(body, scope);
            if (mismatch) return { code: mismatch };
            const replay = replayReceipt(findOperation(snapshot, body.operationId), 'transition', requestDigest, actor);
            if (replay) return replay;
            if (snapshot.holders.state !== 'ready') return { code: E.sourceUnavailable };
            const currentEpoch = snapshot.record ? snapshot.record.sourceProtectionEpoch : 0;
            if (body.expectedEpoch !== currentEpoch) return { code: E.staleSourceEpoch };
            if (snapshot.reservations.length !== 0) return { code: E.sourceTransitionBlocked };
            const provenance = await ask(providers.provenance, {
                selectionDigest: body.selectionDigest,
                closureDigest: body.closureDigest,
                sourceAcceptanceIdentity: body.sourceAcceptanceIdentity,
            });
            if (provenance?.status !== 'accepted' || provenance.acceptanceIdentity !== body.sourceAcceptanceIdentity) {
                return { code: E.sourceProvenanceUnaccepted };
            }
            const selection = validateSourceSelection(provenance.selection);
            const closure = validateSourceClosure(provenance.closure);
            if (!selection.ok || !closure.ok) return { code: E.sourceProvenanceUnaccepted };
            if (digestOrThrow(selection.value) !== body.selectionDigest || digestOrThrow(closure.value) !== body.closureDigest) {
                return { code: E.sourceBindingMismatch };
            }
            const enforcement = await ask(providers.enforcement, { phase: 'transition', request: body });
            if (enforcement?.status !== 'protected' || enforcement.enforcementDigest !== body.enforcementDigest) {
                return { code: E.sourceUnprotected };
            }
            const coverage = validCoverage(await ask(providers.aliasCoverage, { phase: 'transition', request: body }));
            if (!coverage || coverage.digest !== body.aliasCoverageDigest) return { code: E.sourceAliasUnproven };
            // A5.2: every closure root, selection root and dependency root must be alias-covered.
            const identities = [
                ...closure.value.roots.map((root) => root.rootIdentity),
                ...selection.value.selections.map((entry) => entry.rootIdentity),
                ...closure.value.dependencies.map((dependency) => dependency.rootIdentity),
            ];
            if (!identities.every((identity) => covered(identity, coverage.roots))) return { code: E.sourceAliasUnproven };
            if (coverage.roots.some((root) => root.writable)) return { code: E.sourceUnprotected };
            const record = {
                version: 1,
                workspaceId: scope.workspaceId,
                boxIdentity: scope.boxIdentity,
                boxGeneration: scope.boxGeneration,
                sourceStoreIdentity: storeId,
                sourceProtectionEpoch: currentEpoch + 1,
                sourceSelectionDigest: body.selectionDigest,
                sourceClosureDigest: body.closureDigest,
                sourceAcceptanceIdentity: body.sourceAcceptanceIdentity,
                protectionStatus: 'protected',
                enforcementDigest: body.enforcementDigest,
                aliasCoverageDigest: body.aliasCoverageDigest,
                acceptedAtMs: clock.nowMs(),
            };
            const result = {
                version: 1, operationId: body.operationId, previousEpoch: currentEpoch, record, requestDigest, sourceStoreIdentity: storeId,
            };
            const next = mutable(snapshot);
            next.record = record;
            next.receipts = [...next.receipts, receipt({
                operationId: body.operationId, kind: 'transition', requestDigest, actor,
                ownerPrincipal: null, ownerGeneration: null, result,
            })].sort(byKey('operationId'));
            // Closures and selections are immutable content-addressed files
            // published before the snapshot that references them.
            return {
                next,
                value: result,
                content: [['putSelection', selection.value], ['putClosure', closure.value]],
            };
        });
    }

    // ------------------------------------------------------------ release

    async function releaseWritableReservation(context, request) {
        return operate('release', context, request, async ({ snapshot, scope, actor, request: body, requestDigest }) => {
            // A6.2: lookup by operation ID before any generation check.
            const replay = replayReceipt(findOperation(snapshot, body.operationId), 'release', requestDigest, actor);
            if (replay) return replay;
            if (actor.kind === 'worker') {
                const stale = workerStaleness(actor, scope, snapshot);
                if (stale) return { code: stale };
            }
            const reservation = snapshot.reservations.find((item) => item.reservationId === body.reservationId);
            if (!reservation) {
                // Already released under another operation, or never recorded:
                // a missing record is never evidence of release.
                return snapshot.tombstones.some((item) => item.reservationId === body.reservationId)
                    ? { code: E.operationConflict }
                    : { code: E.notFound };
            }
            if (actor.kind === 'worker' && actor.workerPrincipal !== reservation.workerPrincipal) return { code: E.forbidden };
            if (body.owningWorkerGeneration !== reservation.workerGeneration
                || body.reservationRequestDigest !== reservation.requestDigest) {
                return { code: E.operationConflict };
            }
            if (body.resourcesDigest !== resourcesDigestOf(reservation.resources)) return { code: E.releaseUnverified };
            const proof = await ask(providers.releaseEvidence, {
                reservation,
                request: body,
                actor: storedActor(actor),
            });
            if (proof?.status === 'quarantined') return { code: E.resourceQuarantined };
            if (proof?.status !== 'absent' || proof.evidenceDigest !== body.releaseEvidenceDigest
                || !Array.isArray(proof.absentResourceIds)) {
                return { code: E.releaseUnverified };
            }
            const absent = new Set(proof.absentResourceIds);
            if (!reservation.resources.every((resource) => absent.has(resource.resourceId))) {
                return { code: E.releaseUnverified };
            }
            // A2.4: the operator path additionally needs Ploinky-verified absence
            // of the exact owning worker runtime instance.
            if (actor.kind === 'operator' && (proof.ownerInstanceAbsent !== true
                || proof.ownerRuntimeInstanceId !== reservation.workerRuntimeInstanceId)) {
                return { code: E.releaseUnverified };
            }
            const result = {
                version: 1,
                operationId: body.operationId,
                reservationId: reservation.reservationId,
                state: 'released',
                requestDigest,
                releaseEvidenceDigest: body.releaseEvidenceDigest,
                sourceStoreIdentity: storeId,
            };
            const owner = actor.kind === 'worker'
                ? [actor.workerPrincipal, actor.workerGeneration]
                : [reservation.workerPrincipal, pointerOf(snapshot, reservation.workerPrincipal).currentGeneration];
            const next = mutable(snapshot);
            next.reservations = next.reservations.filter((item) => item.reservationId !== reservation.reservationId);
            next.tombstones = [...next.tombstones, {
                reservationId: reservation.reservationId,
                operationId: reservation.operationId,
                requestDigest: reservation.requestDigest,
                workerPrincipal: reservation.workerPrincipal,
                workerGeneration: reservation.workerGeneration,
                state: 'released',
                releaseEvidenceDigest: body.releaseEvidenceDigest,
            }].sort(byKey('reservationId'));
            next.receipts = [...next.receipts, receipt({
                operationId: body.operationId, kind: 'release', requestDigest, actor,
                ownerPrincipal: owner[0], ownerGeneration: owner[1], result,
            })].sort(byKey('operationId'));
            return { next, value: result };
        });
    }

    // ------------------------------------------------------------ acknowledge (A2.2, A3.2, A4)

    async function acknowledgeSourceStore(context, request) {
        return operate('acknowledge', context, request, async ({ snapshot, scope, actor, request: body, requestDigest }) => {
            if (actor.kind !== 'worker') return { code: E.forbidden };
            const stale = workerStaleness(actor, scope, snapshot);
            if (stale || body.workerGeneration !== actor.workerGeneration) return { code: E.staleGeneration };
            const replay = replayReceipt(findOperation(snapshot, body.operationId), 'acknowledge', requestDigest, actor);
            if (replay) return replay;
            if (!snapshot.holders.expected.includes(actor.workerPrincipal)) {
                const holder = await holderStatus(actor.workerPrincipal);
                if (holder === 'not-holder') return { code: E.forbidden };
                if (holder !== 'holder') return { code: E.sourceUnavailable };
            }
            if (body.sourceStoreIdentity !== storeId) return { code: E.operationConflict };
            const acknowledged = [...new Set([...snapshot.holders.acknowledged, actor.workerPrincipal])].sort();
            const ready = snapshot.holders.expected.every((principal) => acknowledged.includes(principal));
            const holders = { state: ready ? 'ready' : 'awaiting-holder-ack', expected: snapshot.holders.expected, acknowledged };
            const result = {
                version: 1,
                operationId: body.operationId,
                sourceStoreIdentity: storeId,
                workerPrincipal: actor.workerPrincipal,
                state: holders.state,
                requestDigest,
            };
            const next = mutable(snapshot);
            next.holders = holders;
            next.receipts = [...next.receipts, receipt({
                operationId: body.operationId, kind: 'acknowledge', requestDigest, actor,
                ownerPrincipal: actor.workerPrincipal, ownerGeneration: actor.workerGeneration, result,
            })].sort(byKey('operationId'));
            return { next, value: result };
        });
    }

    // ------------------------------------------------------------ advance (A2.3, A3.1)

    async function advanceWorkerGeneration(context, request) {
        return operate('advance', context, request, async ({ snapshot, scope, actor, request: body, requestDigest }) => {
            if (actor.kind !== 'worker') return { code: E.forbidden };
            const instance = Object.hasOwn(scope.workerInstances, actor.workerPrincipal)
                ? scope.workerInstances[actor.workerPrincipal] : null;
            if (!instance || instance.workerRuntimeInstanceId !== actor.workerRuntimeInstanceId
                || instance.workerEnableGeneration !== actor.workerEnableGeneration
                || actor.workerGeneration !== body.nextGeneration) {
                return { code: E.staleGeneration };
            }
            const replay = replayReceipt(findOperation(snapshot, body.operationId), 'advance', requestDigest, actor);
            if (replay) return replay;
            const pointer = pointerOf(snapshot, actor.workerPrincipal);
            // Compare-and-set against the registered pointer only (A3.1).
            if ((pointer ? pointer.currentGeneration : null) !== body.priorGeneration) return { code: E.staleGeneration };
            // A5.1: a generation the store knows as superseded never becomes current
            // again: the current pointer, the bounded history and any generation
            // still referenced by a retained record of this principal.
            const superseded = new Set([
                pointer?.priorGeneration,
                ...(pointer?.history || []),
                ...snapshot.reservations.filter((item) => item.workerPrincipal === actor.workerPrincipal)
                    .map((item) => item.workerGeneration),
                ...snapshot.tombstones.filter((item) => item.workerPrincipal === actor.workerPrincipal)
                    .map((item) => item.workerGeneration),
                ...snapshot.receipts.filter((item) => item.ownerPrincipal === actor.workerPrincipal)
                    .map((item) => item.ownerGeneration),
            ]);
            if (superseded.has(body.nextGeneration) || pointer?.currentGeneration === body.nextGeneration) {
                return { code: E.staleGeneration };
            }
            const result = {
                version: 1,
                operationId: body.operationId,
                workerPrincipal: actor.workerPrincipal,
                priorGeneration: body.priorGeneration,
                currentGeneration: body.nextGeneration,
                requestDigest,
            };
            // Newest first; the superseded current generation enters the history
            // and the oldest entry is evicted beyond the bound. Never compacted.
            const history = pointer
                ? [pointer.currentGeneration, ...pointer.history.filter((item) => item !== pointer.currentGeneration)]
                    .slice(0, SUPERSEDED_GENERATION_HISTORY_BOUND)
                : [];
            const next = mutable(snapshot);
            next.generations = [
                ...next.generations.filter((item) => item.workerPrincipal !== actor.workerPrincipal),
                {
                    workerPrincipal: actor.workerPrincipal,
                    currentGeneration: body.nextGeneration,
                    priorGeneration: body.priorGeneration,
                    history,
                },
            ].sort(byKey('workerPrincipal'));
            next.receipts = [...next.receipts, receipt({
                operationId: body.operationId, kind: 'advance', requestDigest, actor,
                ownerPrincipal: actor.workerPrincipal, ownerGeneration: body.nextGeneration, result,
            })].sort(byKey('operationId'));
            return { next, value: result };
        });
    }

    return Object.freeze({
        storeId,
        reserveWritableResources,
        prepareSourceTransition,
        releaseWritableReservation,
        acknowledgeSourceStore,
        advanceWorkerGeneration,
    });
}
