// Router-side service for the private helper-ticket operation (plan section 5.6; frozen T0 section 8 + A1.7 + A11; mint
// route spec 2026-10-30 with plan-review dispositions R1-R2).
//
// The private Router listener authenticates the caller with its existing private agent assertion (privateRouter.js
// `authorizePrivateRoutePlan`) and admits only the exact current instance of the single execution-provider agent. This
// module sees only that verified identity. It owns the one long-lived target-helper ticket minter of the Router process
// (its helper-nonce set and per-lease epoch/owner map live as long as the process), the verified caller authority that
// feeds it, and a per-caller rate limit.
//
// Every fact the minter binds is asserted by the Router, never by the request body:
//   caller            the verified identity (principal, runtime instance, enable generation) of the assertion
//   worker generation the worker principal's generation pointer in Ploinky's source-protection store (T0 A2.3); no
//                     pointer means no ticket (`caller_mismatch`)
//   live Box scope    the Router's own derivation (liveScope.mjs); none means no ticket (`target_scope_mismatch`). The
//                     first scope seen pins the process minter; a different scope later is refused, never re-minted
//   target            the active generation's registry record for the target principal and container, the exact
//                     inspection of that one container, and the provisioning record's helper facts, combined by
//                     `discoverExecutionTargets`
//   secret            the per-helper-incarnation Router copy, reached only inside the minter's synchronous callback
// The body supplies only the operation tuple the minter validates; its scope fields are used solely to choose which
// registry record to inspect, and the minter compares every one of them against the evidence above.
//
// Two phases (R2): `prepare` resolves all asynchronous evidence and returns a synchronous `mint`. The caller commits the
// route plan between them, so an edge generation change after the evidence was read answers 503 with nothing minted and
// no helper nonce consumed. This module reads no environment, opens no network and spawns nothing; every reader is
// injected by the Router glue.

import fs from 'node:fs';

import { isOpaqueIdentity, isPrincipal, isId } from './contract.mjs';
import { discoverExecutionTargets } from './discovery.mjs';
import {
    createTargetHelperCallerAuthority,
    createTargetHelperTicketMinter,
} from '../security/tokens/targetHelperTicketMinter.mjs';
import { openSourceProtectionStore } from '../../utils/runtime/sourceProtectionStore.mjs';
import { sourceProtectionPresence } from '../../utils/runtime/sourceProtectionGate.mjs';

export const HELPER_TICKET_PATH = '/api/edge/target-helper-ticket';
export const HELPER_TICKET_MAX_BODY_BYTES = 65536;
export const HELPER_TICKET_RATE_LIMIT = Object.freeze({ maximumRequests: 60, windowMs: 60_000 });
// Registry records of one target principal and container that one request may inspect.
const MAX_TARGET_RECORDS = 4;
const CONTAINER_ID = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function transportError(status, error) {
    return Object.freeze({ status, body: Object.freeze({ error }) });
}

function refusal(code) {
    return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

async function settle(fn) {
    try {
        return await fn();
    } catch (_) {
        return null;
    }
}

function attempt(fn) {
    try {
        return fn();
    } catch (_) {
        return null;
    }
}

/**
 * The worker principal's current generation in the source-protection store (the pointer `advance` registered), or
 * null when there is no store, no pointer or the store cannot be read. Opens the store with create:false.
 */
export async function readWorkerGenerationPointer({ workspaceRoot, principal, fsApi = fs } = {}) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot || !isPrincipal(principal)) return null;
    try {
        if (sourceProtectionPresence(workspaceRoot, fsApi) !== 'present') return null;
        const opened = await openSourceProtectionStore({ workspaceRoot, create: false, fsApi });
        if (!opened.ok) return null;
        const snapshot = await opened.value.exclusive(async (transaction) => transaction.snapshot());
        const pointer = (snapshot?.generations || []).find((entry) => entry?.workerPrincipal === principal);
        return pointer && isId(pointer.currentGeneration) ? pointer.currentGeneration : null;
    } catch (_) {
        return null;
    }
}

/** At most `maximumRequests` per exact caller in any `windowMs`; `consume` answers whether this request may proceed. */
export function createHelperTicketRateLimiter({
    maximumRequests = HELPER_TICKET_RATE_LIMIT.maximumRequests,
    windowMs = HELPER_TICKET_RATE_LIMIT.windowMs,
    maximumCallers = 256,
} = {}) {
    const calls = new Map();
    return Object.freeze({
        consume(callerKey, nowMs) {
            if (typeof callerKey !== 'string' || !callerKey || !Number.isSafeInteger(nowMs)) return false;
            const cutoff = nowMs - windowMs;
            const recent = (calls.get(callerKey) || []).filter((timestamp) => timestamp > cutoff);
            if (recent.length >= maximumRequests) {
                calls.set(callerKey, recent);
                return false;
            }
            recent.push(nowMs);
            calls.delete(callerKey);
            calls.set(callerKey, recent);
            if (calls.size > maximumCallers) {
                for (const [candidate, timestamps] of calls) {
                    if (calls.size <= maximumCallers) break;
                    if (!timestamps.some((timestamp) => timestamp > cutoff)) calls.delete(candidate);
                }
                while (calls.size > maximumCallers) calls.delete(calls.keys().next().value);
            }
            return true;
        },
        size: () => calls.size,
    });
}

function liveKey(live) {
    return `${live.workspaceId}\u0000${live.boxIdentity}\u0000${live.boxGeneration}`;
}

function principalOf(record) {
    return `agent:${String(record?.repoName || '').trim()}/${String(record?.agentName || '').trim()}`;
}

/**
 * Create the Router's helper-ticket service (one per Router process; one per test world).
 *   now, randomBytes, issuedCapacity   minter seams (deterministic tests only)
 *   rateLimiter                        {consume(callerKey, nowMs)}; defaults to 60 per minute per exact caller
 *
 * prepare({identity, body, readers}) resolves to {answer} (a transport refusal: {status, body}) or {mint}, a synchronous
 * function returning the minter's common result. `readers` (all injected by the Router glue):
 *   liveScope()                          async {workspaceId, boxIdentity, boxGeneration} | null
 *   readWorkerGeneration(principal)      async generation Id | null
 *   readRegistry()                       {agents: {[containerName]: record}} of the active generation
 *   readManifest(record)                 the record's effective manifest
 *   inspectInstance(containerName, record)  async {running, containerId} from an exact, ownership-checked inspection
 *   readHelper(record)                   helper facts (provisioning.mjs `readExecutionTargetHelperFacts`)
 *   secrets                              {useSecret(target, fn)} (helperTicketSecrets.mjs)
 */
export function createHelperTicketService({
    now = () => Date.now(),
    randomBytes,
    issuedCapacity,
    rateLimiter = createHelperTicketRateLimiter(),
} = {}) {
    if (typeof now !== 'function' || !rateLimiter || typeof rateLimiter.consume !== 'function') {
        throw new TypeError('createHelperTicketService: now and rateLimiter.consume are required');
    }
    const authority = createTargetHelperCallerAuthority();
    // The evidence of the one synchronous mint in progress; set and cleared around minter.mint, which never yields.
    let pending = null;
    let pinned = null;

    function minterFor(live) {
        const key = liveKey(live);
        if (pinned) return pinned.key === key ? pinned.minter : null;
        const minter = createTargetHelperTicketMinter({
            live,
            readTarget: (scope) => (pending ? pending.readTarget(scope) : null),
            readWorker: () => (pending ? pending.worker : null),
            callerAuthority: authority,
            secrets: { useSecret: (target, fn) => (pending ? pending.secrets.useSecret(target, fn) : null) },
            now,
            ...(randomBytes ? { randomBytes } : {}),
            ...(issuedCapacity ? { issuedCapacity } : {}),
        });
        pinned = { key, minter };
        return minter;
    }

    async function targetEntries(live, scope, readers) {
        const targetPrincipal = isPlainObject(scope) && isPrincipal(scope.agentPrincipal) ? scope.agentPrincipal : null;
        const containerId = isPlainObject(scope) && CONTAINER_ID.test(String(scope.containerId || '')) ? scope.containerId : null;
        if (!live || !targetPrincipal || !containerId) return [];
        const registry = attempt(() => readers.readRegistry());
        const agents = isPlainObject(registry?.agents) ? registry.agents : {};
        const chosen = Object.keys(agents).sort().filter((name) => {
            const record = agents[name];
            return isPlainObject(record) && record.type === 'agent' && principalOf(record) === targetPrincipal
                && record.containerId === containerId;
        }).slice(0, MAX_TARGET_RECORDS);
        if (!chosen.length) return [];
        const instances = new Map();
        const helpers = new Map();
        const manifests = new Map();
        for (const name of chosen) {
            const record = agents[name];
            instances.set(record, await settle(() => readers.inspectInstance(name, record)));
            helpers.set(record, attempt(() => readers.readHelper(record)));
            manifests.set(record, attempt(() => readers.readManifest(record)));
        }
        const discovered = discoverExecutionTargets({
            live,
            readRegistry: () => ({ agents: Object.fromEntries(chosen.map((name) => [name, agents[name]])) }),
            readManifest: (record) => manifests.get(record),
            readInstance: (record) => instances.get(record) ?? null,
            readHelper: (record) => helpers.get(record) ?? null,
        });
        return discovered.ok ? discovered.value.entries : [];
    }

    // The one discovery entry the scope names: the only entry, or the only exact instance among several.
    function readTargetFrom(entries) {
        return (scope) => {
            if (entries.length === 1) return entries[0];
            const exact = entries.filter((entry) => entry.runtimeInstanceId === scope.runtimeInstanceId
                && entry.enableGeneration === scope.enableGeneration);
            return exact.length === 1 ? exact[0] : null;
        };
    }

    async function prepare({ identity, body, readers } = {}) {
        if (!Buffer.isBuffer(body)) return { answer: transportError(400, 'invalid_request') };
        if (body.length > HELPER_TICKET_MAX_BODY_BYTES) return { answer: transportError(413, 'request_too_large') };
        if (!isPlainObject(identity) || !isPrincipal(identity.agentId) || !isOpaqueIdentity(identity.instanceId)
            || !isOpaqueIdentity(identity.enableGeneration)) {
            return { answer: transportError(400, 'invalid_identity') };
        }
        if (!isPlainObject(readers) || !readers.secrets || typeof readers.secrets.useSecret !== 'function'
            || !['liveScope', 'readWorkerGeneration', 'readRegistry', 'readManifest', 'inspectInstance', 'readHelper']
                .every((name) => typeof readers[name] === 'function')) {
            throw new TypeError('helper ticket service readers are incomplete');
        }
        const callerKey = [identity.agentId, identity.instanceId, identity.enableGeneration].join('\u0000');
        if (!rateLimiter.consume(callerKey, now())) return { answer: transportError(429, 'capacity_exceeded') };
        let request;
        try {
            request = JSON.parse(body.toString('utf8'));
        } catch (_) {
            return { answer: transportError(400, 'invalid_request') };
        }

        // All asynchronous evidence first (R2).
        const live = await settle(() => readers.liveScope());
        const generation = await settle(() => readers.readWorkerGeneration(identity.agentId));
        const entries = await targetEntries(live, isPlainObject(request) && isPlainObject(request.binding) ? request.binding.scope : null, readers);
        const secrets = readers.secrets;

        function mint() {
            if (!isPlainObject(live) || !['workspaceId', 'boxIdentity', 'boxGeneration'].every((key) => isOpaqueIdentity(live[key]))) {
                return refusal('target_scope_mismatch');
            }
            const minter = minterFor(live);
            if (!minter) return refusal('target_scope_mismatch');
            if (!isId(generation)) return refusal('caller_mismatch');
            const worker = Object.freeze({
                principal: identity.agentId, runtimeInstanceId: identity.instanceId,
                enableGeneration: identity.enableGeneration, generation,
            });
            const context = authority.issue(worker);
            pending = { worker, readTarget: readTargetFrom(entries), secrets };
            try {
                return minter.mint(context, request);
            } finally {
                pending = null;
            }
        }
        return { mint };
    }

    return Object.freeze({ prepare });
}
