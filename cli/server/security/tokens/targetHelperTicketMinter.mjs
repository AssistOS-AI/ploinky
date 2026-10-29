// Router target-helper ticket minter (plan section 5.6; frozen T0 section 8 + A1.7; proof sequence slice P4).
//
// Mints the one-use bootstrap/reattach ticket a worker presents to the fixed target helper: a compact HS256 JWS with
// header `{alg:"HS256",typ:"ploinky-target-helper+jwt",kid}` and exactly the seventeen frozen claims, signed with the
// per-helper-incarnation secret. It is a dedicated token domain (purpose `ploinky.target-helper.v1`, issuer
// `ploinky-router`): never a coordinator, user, broker, terminal, router-service or agentExec token.
//
// The module is a pure library. It registers no route, opens no socket and reads no environment. The secret is reached
// only through an injected handle provider inside a callback; it is never stored on the minter, returned, logged or
// placed in an error. The Router verifies live target evidence through an injected reader before it signs anything.
// Full TargetBinding schema validation stays with the helper; this minter validates exactly the LiveScope fields it
// signs and embeds the binding verbatim.

import crypto from 'node:crypto';

import { canonicalOrThrow, digestOrThrow, isDigest, isId, isOpaqueIdentity, isOperationId, isPrincipal } from '../../executionTarget/contract.mjs';

export const TICKET_TYPE = 'ploinky-target-helper+jwt';
export const TICKET_PURPOSE = 'ploinky.target-helper.v1';
export const TICKET_ISSUER = 'ploinky-router';
export const TICKET_AUDIENCE_PREFIX = 'ploinky:target-helper:';
export const TICKET_PERMISSIONS = Object.freeze(['commit', 'connect', 'input', 'lookup', 'prepare', 'release', 'renew', 'stop']);
export const TICKET_MAX_LIFETIME_SECONDS = 30;
export const TICKET_ISSUED_CAPACITY = 4096;
const REPLAY_MARGIN_MS = 2000;
const MAX_TOKEN_LENGTH = 65536;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const U64_TEXT = /^[1-9][0-9]{0,19}$/;
const U64_MAX = 18446744073709551615n;

export const MINT_ERROR_CODES = Object.freeze([
    'invalid_request', 'caller_unverified', 'caller_mismatch', 'target_scope_mismatch', 'target_not_eligible', 'target_mismatch',
    'ticket_lifetime', 'ticket_permissions', 'ticket_format', 'channel_epoch_conflict', 'ticket_replayed',
    'secret_unavailable', 'capacity_exceeded'
]);

const REQUEST_KEYS = Object.freeze([
    'binding', 'reservationId', 'operationId', 'requestDigest', 'helperNonce', 'channelEpoch',
    'previousChannelEpoch', 'permissions', 'ttlSeconds'
]);
const SCOPE_KEYS = Object.freeze([
    'workspaceId', 'boxIdentity', 'boxGeneration', 'workerPrincipal', 'workerRuntimeInstanceId', 'workerEnableGeneration',
    'workerGeneration', 'agentPrincipal', 'containerId', 'runtimeInstanceId', 'enableGeneration', 'helperIncarnation'
]);

class MintRefusal {
    constructor(code) { this.code = code; }
}

function refuse(code) {
    throw new MintRefusal(code);
}

function need(condition, code = 'invalid_request') {
    if (!condition) refuse(code);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function exactKeys(value, keys) {
    return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNonce(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === 32 && bytes.toString('base64url') === value;
}

function isU64Text(value) {
    return typeof value === 'string' && U64_TEXT.test(value) && BigInt(value) <= U64_MAX;
}

function checkScope(scope) {
    need(exactKeys(scope, SCOPE_KEYS), 'invalid_request');
    for (const key of ['workspaceId', 'boxIdentity', 'boxGeneration', 'workerRuntimeInstanceId', 'workerEnableGeneration',
        'runtimeInstanceId', 'enableGeneration']) need(isOpaqueIdentity(scope[key]));
    need(isPrincipal(scope.workerPrincipal) && isPrincipal(scope.agentPrincipal));
    need(isId(scope.workerGeneration) && isId(scope.helperIncarnation));
    need(typeof scope.containerId === 'string' && CONTAINER_ID.test(scope.containerId));
}

// Identical to the helper's audience: the target and Box fields of the LiveScope only.
function targetIdentity(scope) {
    return {
        workspaceId: scope.workspaceId, boxIdentity: scope.boxIdentity, boxGeneration: scope.boxGeneration,
        agentPrincipal: scope.agentPrincipal, containerId: scope.containerId, runtimeInstanceId: scope.runtimeInstanceId,
        enableGeneration: scope.enableGeneration, helperIncarnation: scope.helperIncarnation
    };
}

// ---------------------------------------------------------------- verified caller contexts

class VerifiedHelperCaller {
    toJSON() {
        throw new TypeError('a verified caller context is not serializable');
    }
}

function workerIdentity(value) {
    return isPlainObject(value) && isPrincipal(value.principal) && isOpaqueIdentity(value.runtimeInstanceId)
        && isOpaqueIdentity(value.enableGeneration) && isId(value.generation);
}

/**
 * The issuer of verified caller contexts. Only the Router code that authenticated the current-instance worker may hold
 * `issue`; the minter holds `resolve` only. A context is a frozen, nonserializable object known to this authority's
 * WeakMap: a plain object, a JSON copy or a context of another authority resolves to null.
 */
export function createTargetHelperCallerAuthority() {
    const CALLER_CONTEXTS = new WeakMap();
    return Object.freeze({
        issue(worker) {
            if (!workerIdentity(worker)) throw new TypeError('invalid worker identity');
            const context = Object.freeze(new VerifiedHelperCaller());
            CALLER_CONTEXTS.set(context, Object.freeze({
                principal: worker.principal, runtimeInstanceId: worker.runtimeInstanceId,
                enableGeneration: worker.enableGeneration, generation: worker.generation
            }));
            return context;
        },
        resolve(context) {
            if (context === null || typeof context !== 'object') return null;
            return CALLER_CONTEXTS.get(context) ?? null;
        }
    });
}

function b64(bytes) {
    return Buffer.from(bytes).toString('base64url');
}

/**
 * Create a minter.
 *   live          {workspaceId, boxIdentity, boxGeneration}: the trusted current Box (never from the request)
 *   readWorker    () => {principal, runtimeInstanceId, enableGeneration, generation}: the CURRENT worker instance
 *   callerAuthority  {resolve(context)}: resolves a nonserializable verified caller context (see
 *                 createTargetHelperCallerAuthority) to the authenticated worker identity, or null
 *   readTarget    (scope) => discovery entry | null: live evidence for the target the scope names (the shape
 *                 `discoverExecutionTargets` emits); the Router re-verifies it before signing
 *   secrets       {useSecret(target, fn)}: calls fn(kid, secretBuffer) synchronously with the per-helper-incarnation
 *                 key for that exact target identity, and returns fn's result; the key is not retained here
 *   now           () => epoch milliseconds
 *   randomBytes   (n) => Buffer; defaults to node:crypto (injected only for deterministic tests)
 *   issuedCapacity  bound on the one-use helper-nonce set; live entries are never evicted
 *
 * mint(context, request) returns {ok:true,value:{ticket,kid,jti,iat,exp}} or {ok:false,error:{code}} and never throws on bad
 * input. `context` is the verified caller context, separate from the request, and must equal the current worker; the
 * binding's whole worker half must equal it too. The request is exactly: binding
 * (TargetBinding), reservationId (Id), operationId, requestDigest (Digest), helperNonce (helper challenge nonce),
 * channelEpoch / previousChannelEpoch (first bootstrap '1'/null, reattach previous+1), permissions (sorted unique
 * subset), ttlSeconds (1..30).
 */
export function createTargetHelperTicketMinter({
    live, readTarget, readWorker, callerAuthority, secrets, now = () => Date.now(), randomBytes = crypto.randomBytes, issuedCapacity = TICKET_ISSUED_CAPACITY
} = {}) {
    if (!isPlainObject(live) || !['workspaceId', 'boxIdentity', 'boxGeneration'].every((key) => isOpaqueIdentity(live[key]))
        || typeof readTarget !== 'function' || typeof readWorker !== 'function'
        || !callerAuthority || typeof callerAuthority.resolve !== 'function' || !secrets || typeof secrets.useSecret !== 'function'
        || typeof now !== 'function' || typeof randomBytes !== 'function'
        || !Number.isSafeInteger(issuedCapacity) || issuedCapacity < 1) {
        throw new TypeError('createTargetHelperTicketMinter: live, readTarget, readWorker, callerAuthority and secrets.useSecret are required');
    }
    const trustedLive = Object.freeze({ workspaceId: live.workspaceId, boxIdentity: live.boxIdentity, boxGeneration: live.boxGeneration });
    // helper-nonce digest -> retain-until ms. A helper nonce is a single challenge: one ticket per nonce.
    const issued = new Map();

    function sweep(nowMs) {
        for (const [key, until] of issued) if (until <= nowMs) issued.delete(key);
    }

    function checkCaller(context, scope) {
        const caller = callerAuthority.resolve(context);
        need(caller !== null && caller !== undefined, 'caller_unverified');
        let current;
        try { current = readWorker(); } catch { current = null; }
        need(workerIdentity(current), 'caller_mismatch');
        const same = (a, b) => a.principal === b.principal && a.runtimeInstanceId === b.runtimeInstanceId
            && a.enableGeneration === b.enableGeneration && a.generation === b.generation;
        // A superseded worker instance or generation keeps its principal but is not the current worker.
        need(same(caller, current), 'caller_mismatch');
        need(same(caller, { principal: scope.workerPrincipal, runtimeInstanceId: scope.workerRuntimeInstanceId,
            enableGeneration: scope.workerEnableGeneration, generation: scope.workerGeneration }), 'caller_mismatch');
    }

    function checkTarget(scope, request) {
        need(scope.workspaceId === trustedLive.workspaceId && scope.boxIdentity === trustedLive.boxIdentity
            && scope.boxGeneration === trustedLive.boxGeneration, 'target_scope_mismatch');
        let entry;
        try { entry = readTarget(Object.freeze({ ...scope })); } catch { entry = null; }
        need(isPlainObject(entry), 'target_mismatch');
        need(entry.workspaceId === trustedLive.workspaceId && entry.boxIdentity === trustedLive.boxIdentity
            && entry.boxGeneration === trustedLive.boxGeneration, 'target_scope_mismatch');
        need(entry.enabled === true && entry.running === true && entry.runtime === 'container' && entry.placement === 'global',
            'target_not_eligible');
        need(entry.principal === scope.agentPrincipal && entry.containerId === scope.containerId
            && entry.runtimeInstanceId === scope.runtimeInstanceId && entry.enableGeneration === scope.enableGeneration
            && entry.helperIncarnation === scope.helperIncarnation, 'target_mismatch');
    }

    function build(context, request) {
        need(exactKeys(request, REQUEST_KEYS));
        need(isPlainObject(request.binding) && request.binding.version === 1);
        const binding = request.binding;
        checkScope(binding.scope);
        need(isDigest(binding.limitsDigest));
        const bindingBytes = Buffer.byteLength(canonicalOrThrow(binding), 'utf8');
        need(bindingBytes <= 32 * 1024, 'capacity_exceeded');
        need(isId(request.reservationId) && isOperationId(request.operationId) && isDigest(request.requestDigest));
        need(isNonce(request.helperNonce));
        const ttl = request.ttlSeconds;
        need(Number.isSafeInteger(ttl) && ttl > 0 && ttl <= TICKET_MAX_LIFETIME_SECONDS, 'ticket_lifetime');
        const permissions = request.permissions;
        need(Array.isArray(permissions) && permissions.length > 0 && permissions.every((item, index) => (
            TICKET_PERMISSIONS.includes(item) && (index === 0 || permissions[index - 1] < item))), 'ticket_permissions');
        need(isU64Text(request.channelEpoch) && (request.previousChannelEpoch === null || isU64Text(request.previousChannelEpoch)),
            'channel_epoch_conflict');
        if (request.previousChannelEpoch === null) {
            need(request.channelEpoch === '1', 'channel_epoch_conflict');
        } else {
            need(BigInt(request.channelEpoch) === BigInt(request.previousChannelEpoch) + 1n && BigInt(request.channelEpoch) <= U64_MAX,
                'channel_epoch_conflict');
        }
        checkCaller(context, binding.scope);
        checkTarget(binding.scope, request);
        return { request, binding, permissions, ttl };
    }

    function mint(context, request) {
        try {
            const { binding, permissions, ttl } = build(context, request);
            const nowMs = now();
            need(Number.isSafeInteger(nowMs) && nowMs >= 0, 'invalid_request');
            sweep(nowMs);
            const nonceKey = crypto.createHash('sha256').update(request.helperNonce).digest('hex');
            need(!issued.has(nonceKey), 'ticket_replayed');
            need(issued.size < issuedCapacity, 'capacity_exceeded');
            const jtiBytes = randomBytes(32);
            need(Buffer.isBuffer(jtiBytes) && jtiBytes.length === 32, 'invalid_request');
            const iat = Math.floor(nowMs / 1000);
            const exp = iat + ttl;
            const claims = {
                version: 1,
                iss: TICKET_ISSUER,
                sub: binding.scope.workerPrincipal,
                purpose: TICKET_PURPOSE,
                aud: `${TICKET_AUDIENCE_PREFIX}${digestOrThrow(targetIdentity(binding.scope))}`,
                binding: JSON.parse(JSON.stringify(binding)),
                reservationId: request.reservationId,
                operationId: request.operationId,
                requestDigest: request.requestDigest,
                helperNonce: request.helperNonce,
                jti: b64(jtiBytes),
                iat,
                exp,
                channelEpoch: request.channelEpoch,
                previousChannelEpoch: request.previousChannelEpoch,
                permissions: [...permissions],
                limitsDigest: binding.limitsDigest
            };
            const payload = b64(Buffer.from(canonicalOrThrow(claims), 'utf8'));
            let signed;
            try {
                signed = secrets.useSecret(Object.freeze(targetIdentity(binding.scope)), (kid, secret) => {
                    if (!isOpaqueIdentity(kid) || !Buffer.isBuffer(secret) || secret.length < 32) return null;
                    const header = b64(Buffer.from(canonicalOrThrow({ alg: 'HS256', typ: TICKET_TYPE, kid }), 'utf8'));
                    const mac = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest();
                    return { ticket: `${header}.${payload}.${b64(mac)}`, kid };
                });
            } catch {
                signed = null;
            }
            need(isPlainObject(signed) && typeof signed.ticket === 'string', 'secret_unavailable');
            need(signed.ticket.length <= MAX_TOKEN_LENGTH, 'ticket_format');
            // Consume the nonce only after the ticket exists; the entry outlives the ticket by the replay margin.
            issued.set(nonceKey, exp * 1000 + REPLAY_MARGIN_MS);
            return Object.freeze({ ok: true, value: Object.freeze({ ticket: signed.ticket, kid: signed.kid, jti: claims.jti, iat, exp }) });
        } catch (error) {
            if (error instanceof MintRefusal) return Object.freeze({ ok: false, error: Object.freeze({ code: error.code }) });
            return Object.freeze({ ok: false, error: Object.freeze({ code: 'invalid_request' }) });
        }
    }

    return Object.freeze({ mint });
}
