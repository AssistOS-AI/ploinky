// Router-side service for the worker's source-protection operations (proof slice P5; frozen T0 section 6 + A2-A6).
//
// The private Router listener authenticates the caller with its existing private agent assertion
// (privateRouter.js `authorizePrivateRoutePlan`: exact current instance and enable generation, replay protected,
// request-bound) and restricts the operation to current agents that declare an execution provider. This module sees
// only the verified identity; it performs no authentication of its own and registers no route or listener.
//
// Request body (exact keys): {version:1, op, workerGeneration, request}
//   op                   describe | state | advance | acknowledge | reserve | release
//   workerGeneration     the worker's S1 generation (string; null for describe and state)
//   request              the T0 operation body for advance/acknowledge/reserve/release; absent otherwise
// Response: HTTP 200 with the common result {ok:true,value} / {ok:false,error:{code}}; transport-level problems are
// 400/413/405 with {error}. The source-transition operation is deliberately absent: only operator code with the
// workspace mutation lease may transition (sourceProtectionGate: beginSourceTransition / commitSourceTransition).
//
// Inertness: with no store on disk the service answers without writing anything (`describe` reports `unavailable`,
// every other operation `source_unavailable`). It opens the store with create:false and never takes the workspace
// lease (T0 section 6: reservation callers take only the store lock).

import fs from 'node:fs';

import { errorResult, isOpaqueIdentity, isPrincipal, okResult } from './contract.mjs';
import { createManagementContextAuthority, createSourceProtectionInterlock } from '../../utils/runtime/sourceProtectionInterlock.mjs';
import { openSourceProtectionStore } from '../../utils/runtime/sourceProtectionStore.mjs';
import {
    guardReservationsAgainstTransition,
    readTransitionMarker,
    sourceProtectionPresence,
} from '../../utils/runtime/sourceProtectionGate.mjs';

export const SOURCE_PROTECTION_PATH = '/api/edge/source-protection';
export const SOURCE_PROTECTION_MAX_BODY_BYTES = 1024 * 1024;
export const SOURCE_PROTECTION_OPERATIONS = Object.freeze(['describe', 'state', 'advance', 'acknowledge', 'reserve', 'release']);

function transportError(status, error) {
    return Object.freeze({ status, body: Object.freeze({ error }) });
}

function result(value) {
    return Object.freeze({ status: 200, body: value });
}

function parseEnvelope(bodyBytes) {
    if (!Buffer.isBuffer(bodyBytes) && !(bodyBytes instanceof Uint8Array)) return null;
    if (bodyBytes.length > SOURCE_PROTECTION_MAX_BODY_BYTES) return 'too_large';
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(bodyBytes).toString('utf8'));
    } catch (_) {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const keys = Object.keys(parsed).sort().join(',');
    if (keys !== 'op,version,workerGeneration' && keys !== 'op,request,version,workerGeneration') return null;
    if (parsed.version !== 1 || !SOURCE_PROTECTION_OPERATIONS.includes(parsed.op)) return null;
    const needsRequest = ['advance', 'acknowledge', 'reserve', 'release'].includes(parsed.op);
    if (needsRequest !== Object.hasOwn(parsed, 'request')) return null;
    if (needsRequest) {
        if (typeof parsed.workerGeneration !== 'string' || parsed.workerGeneration.length < 1) return null;
    } else if (parsed.workerGeneration !== null) {
        return null;
    }
    return parsed;
}

/**
 * Dependencies (all trusted, injected by the Router glue):
 *   workspaceRoot                 the workspace whose store is served
 *   liveScope()                   {workspaceId, boxIdentity, boxGeneration} of the active Box, or null (unavailable)
 *   isSourceReservationHolder(p)  A3: {status:'holder'|'not-holder'} for a canonical principal
 *   evidence                      trusted source evidence providers (interlock defaults refuse)
 *   sourceFacts()                 optional async facts for admission (`state`): repository mode, alias coverage, ...
 *   fsApi, clock                  test seams
 */
export function createSourceProtectionService({
    workspaceRoot, liveScope, isSourceReservationHolder, evidence = {}, sourceFacts, fsApi = fs, clock,
} = {}) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot || typeof liveScope !== 'function'
        || typeof isSourceReservationHolder !== 'function') {
        throw new TypeError('createSourceProtectionService requires workspaceRoot, liveScope and isSourceReservationHolder');
    }

    async function handle({ identity, body } = {}) {
        const envelope = parseEnvelope(body);
        if (envelope === 'too_large') return transportError(413, 'request_too_large');
        if (envelope === null) return transportError(400, 'invalid_request');
        if (!identity || !isPrincipal(identity.agentId) || !isOpaqueIdentity(identity.instanceId)
            || !isOpaqueIdentity(identity.enableGeneration)) {
            return transportError(400, 'invalid_identity');
        }
        // The caller must currently be a holder (declares an execution provider); checked before any state is read.
        let holder;
        try {
            holder = await isSourceReservationHolder(identity.agentId);
        } catch (_) {
            holder = null;
        }
        if (holder?.status !== 'holder') return result(errorResult('forbidden'));

        const presence = sourceProtectionPresence(workspaceRoot, fsApi);
        if (presence === 'absent') {
            return result(envelope.op === 'describe'
                ? okResult({ state: 'unavailable', sourceStoreIdentity: null, holderAcknowledged: false, currentGeneration: null })
                : errorResult('source_unavailable'));
        }
        if (presence !== 'present') return result(errorResult('source_unavailable'));
        const live = await liveScope();
        if (!live) return result(envelope.op === 'describe'
            ? okResult({ state: 'unavailable', sourceStoreIdentity: null, holderAcknowledged: false, currentGeneration: null })
            : errorResult('source_unavailable'));

        const opened = await openSourceProtectionStore({ workspaceRoot, create: false, fsApi });
        if (!opened.ok) return result(opened);
        const store = opened.value;

        if (envelope.op === 'describe' || envelope.op === 'state') {
            let snapshot;
            try {
                snapshot = await store.exclusive(async (transaction) => transaction.snapshot());
            } catch (_) {
                return result(errorResult('source_unavailable'));
            }
            if (envelope.op === 'describe') {
                const pointer = snapshot.generations.find((entry) => entry.workerPrincipal === identity.agentId) || null;
                return result(okResult({
                    state: snapshot.holders.state,
                    sourceStoreIdentity: store.storeId,
                    holderAcknowledged: snapshot.holders.acknowledged.includes(identity.agentId),
                    currentGeneration: pointer ? pointer.currentGeneration : null,
                }));
            }
            let facts = null;
            if (typeof sourceFacts === 'function') {
                try {
                    facts = (await sourceFacts({ record: snapshot.record })) ?? null;
                } catch (_) {
                    facts = null;
                }
            }
            const transition = readTransitionMarker(workspaceRoot, fsApi);
            return result(okResult({
                version: 1,
                sourceStoreIdentity: store.storeId,
                record: snapshot.record,
                // A prepared (or crashed) source transition: the record is not final until it commits or aborts.
                transition: transition.state === 'absent' ? null : { pending: true },
                facts,
            }));
        }

        const authority = createManagementContextAuthority();
        let context;
        try {
            context = authority.worker({
                workerPrincipal: identity.agentId,
                workerRuntimeInstanceId: identity.instanceId,
                workerEnableGeneration: identity.enableGeneration,
                // Advance is authorized as the generation it registers (T0 A2.3); the others as the current one.
                workerGeneration: envelope.workerGeneration,
            });
        } catch (_) {
            return transportError(400, 'invalid_identity');
        }
        const interlock = createSourceProtectionInterlock({
            // A reservation refuses while a source transition is prepared; the other operations are unaffected.
            store: envelope.op === 'reserve' ? guardReservationsAgainstTransition(store, workspaceRoot, fsApi) : store,
            authority,
            // The verified caller is by construction the current instance of its principal.
            currentScope: async () => {
                const scope = await liveScope();
                return scope ? {
                    ...scope,
                    workerInstances: {
                        [identity.agentId]: {
                            workerRuntimeInstanceId: identity.instanceId,
                            workerEnableGeneration: identity.enableGeneration,
                        },
                    },
                } : null;
            },
            isSourceReservationHolder,
            evidence,
            ...(clock ? { clock } : {}),
        });
        const call = {
            advance: interlock.advanceWorkerGeneration,
            acknowledge: interlock.acknowledgeSourceStore,
            reserve: interlock.reserveWritableResources,
            release: interlock.releaseWritableReservation,
        }[envelope.op];
        return result(await call(context, envelope.request));
    }

    return Object.freeze({ handle });
}
