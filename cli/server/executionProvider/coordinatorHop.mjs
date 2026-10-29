import { computeRchHttp } from '../../../Agent/lib/requestHash.mjs';
import { buildRouterRequest } from '../mcp-proxy/invocationMinter.js';
import { verifyUserDelegationGrant } from '../mcp-proxy/userDelegationGrant.js';
import { deriveSubkey } from '../../utils/security/masterKey.js';
import { coordinatorRouteForPlan, headerValue } from './coordinatorRoutes.mjs';

// The signed coordinator hop (private listener only). A provider declares its
// coordinator routes and the coordinator principals allowed to call them. The
// Router restricts those routes to exactly the declared callers, verifies an
// optional Router-minted user delegation grant as owner evidence, and forwards
// the verified facts only as claims of a provider-audience Router Request.
// No request content can name the caller or the owner.

export const COORDINATOR_ADMISSION_TOOL = '__coordinator_admission__';
export const COORDINATOR_OWNER_SCOPE = 'execution:owner';
export const COORDINATOR_OWNER_GRANT_MAX_TTL_SECONDS = 30;
export const USER_DELEGATION_HEADER = 'x-ploinky-user-delegation';
export const COORDINATOR_CALLER_DENIED = 'COORDINATOR_CALLER_DENIED';
export const COORDINATOR_OWNER_GRANT_REJECTED = 'COORDINATOR_OWNER_GRANT_REJECTED';
export const COORDINATOR_HOP_UNAVAILABLE = 'COORDINATOR_HOP_UNAVAILABLE';

function hopError(status, code, message) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

// The caller ACL of a coordinator scope: exactly its declared principals.
export function coordinatorCallerAcl(plan, entry) {
    return {
        routeKey: plan.routeKey,
        coordinator: true,
        callerPrincipals: [...entry.callers],
        callers: [],
        anyCurrentCaller: false,
        methods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
        paths: [String(plan.pathname || '')],
    };
}

function resolveGrantSigningSecret() {
    return deriveSubkey('router-user-delegation', 32);
}

// Owner evidence. The grant must be Router-signed, unexpired, issued to a
// non-guest user, for source = the verified caller, target = the provider and
// tool = `__coordinator_admission__`, and its scope must contain
// `execution:owner`. Verification consumes no grant `jti`, so one grant can
// serve several coordinator operations within its lifetime.
export function verifyCoordinatorOwnerGrant({
    token,
    callerPrincipal,
    providerPrincipal,
    now = new Date(),
    signingSecret = resolveGrantSigningSecret(),
}) {
    let verified;
    try {
        verified = verifyUserDelegationGrant({
            signingSecret,
            token,
            now,
            expectedSourceAgentId: callerPrincipal,
            expectedTargetAgentId: providerPrincipal,
            expectedTool: COORDINATOR_ADMISSION_TOOL,
        });
    } catch (error) {
        throw hopError(403, COORDINATOR_OWNER_GRANT_REJECTED,
            `coordinator owner grant rejected: ${String(error?.message || 'invalid')}`);
    }
    if (!verified.delegation.scope.includes(COORDINATOR_OWNER_SCOPE)) {
        throw hopError(403, COORDINATOR_OWNER_GRANT_REJECTED, 'coordinator owner grant lacks the execution:owner scope');
    }
    // Owner evidence lives at most 30 seconds (plan §8.2): a longer signed
    // lifetime is refused even before it expires. Generic delegations keep
    // their own lifetimes; this check applies only to the coordinator hop.
    const iat = Number(verified.claims?.iat);
    const exp = Number(verified.claims?.exp);
    if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp - iat > COORDINATOR_OWNER_GRANT_MAX_TTL_SECONDS) {
        throw hopError(403, COORDINATOR_OWNER_GRANT_REJECTED, 'coordinator owner grant lifetime exceeds 30 seconds');
    }
    return Object.freeze({
        user: Object.freeze({ ...verified.user, roles: [...verified.user.roles] }),
        delegation: Object.freeze({ ...verified.delegation, scope: [...verified.delegation.scope] }),
    });
}

// Runs after the private assertion verified `callerIdentity` and the
// coordinator ACL admitted it. Removes the grant header in every case, so the
// grant bytes never reach the provider, and returns the immutable admission
// facts the forward signs. A present but invalid grant is refused: it never
// degrades to a forward without owner claims.
export function admitCoordinatorRequest({ req, plan, entry, callerIdentity, now = new Date() }) {
    const raw = headerValue(req, USER_DELEGATION_HEADER);
    if (req?.headers) delete req.headers[USER_DELEGATION_HEADER];
    const callerPrincipal = String(callerIdentity?.agentId || '');
    if (!entry || !entry.callers.includes(callerPrincipal)) {
        throw hopError(403, COORDINATOR_CALLER_DENIED, 'caller is not a declared coordinator of this route');
    }
    const providerPrincipal = String(plan?.relay?.targetAgentId || '');
    if (!providerPrincipal) throw hopError(503, COORDINATOR_HOP_UNAVAILABLE, 'provider principal is unavailable');
    if (Array.isArray(raw)) {
        throw hopError(403, COORDINATOR_OWNER_GRANT_REJECTED, 'coordinator owner grant header is repeated');
    }
    const grant = raw === undefined
        ? null
        : verifyCoordinatorOwnerGrant({ token: raw.trim(), callerPrincipal, providerPrincipal, now });
    return Object.freeze({
        routeKey: String(plan.routeKey || ''),
        path: entry.path,
        callerPrincipal,
        providerPrincipal,
        grant,
    });
}

// The provider-audience Router Request for one forward of an admitted
// coordinator request, bound to its exact method, agent-local path, query and
// body hash. `usr` and `delegation` appear only from a verified grant.
export function mintCoordinatorAdmissionRequest({ admission, plan, bodyHash }) {
    if (!admission?.callerPrincipal || !admission?.providerPrincipal) {
        throw hopError(503, COORDINATOR_HOP_UNAVAILABLE, 'coordinator admission facts are missing');
    }
    const method = String(plan.method || 'GET').toUpperCase();
    const path = String(plan.unmatchedSuffix || '').split('?')[0];
    const search = String(plan.parsedUrl?.search || '');
    const caller = admission.callerPrincipal;
    const invocationBody = {
        method,
        externalPath: String(plan.pathname || ''),
        path,
        search,
        routeKey: admission.routeKey,
        bodyHash: String(bodyHash || ''),
    };
    const { token, payload } = buildRouterRequest({
        targetAgentId: admission.providerPrincipal,
        sub: caller,
        actor: { kind: 'agent', id: caller, roles: [] },
        caller: { kind: 'agent', id: caller, roles: ['agent'] },
        usr: admission.grant?.user || undefined,
        delegation: admission.grant?.delegation || undefined,
        method,
        path,
        tool: COORDINATOR_ADMISSION_TOOL,
        rch: computeRchHttp({ method, path, query: search, bodyHash: invocationBody.bodyHash }),
    });
    return { token, payload, invocationBody };
}

// `trustedHeadersFactory` for a private agent-port forward. Ordinary private
// routes keep forwarding without Router claims. A coordinator plan forwards
// only with its admission facts, recorded by the private authorization step;
// without them it fails before the relay is opened.
export function privateForwardTrustedHeadersFactory({ req, plan }) {
    const coordinator = coordinatorRouteForPlan(plan);
    if (!coordinator.matched) return undefined;
    return ({ bodyHash, plan: finalized }) => {
        const admission = req?.coordinatorAdmission;
        if (!coordinator.entry || !admission || admission.path !== coordinator.entry.path) {
            throw hopError(503, COORDINATOR_HOP_UNAVAILABLE, 'coordinator route forward lacks verified admission');
        }
        const { token, invocationBody } = mintCoordinatorAdmissionRequest({ admission, plan: finalized || plan, bodyHash });
        return { authInfo: JSON.stringify({ invocationToken: token, invocationBody }) };
    };
}
