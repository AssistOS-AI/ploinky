/**
 * invocation-auth.mjs
 *
 * Normalizes a VERIFIED router-request grant (the payload the AgentServer places
 * in `metadata.invocation` after secure-wire verification) into the `authInfo`
 * shape agents consume for ACL checks. It performs no verification and must only
 * ever be called with an already-verified grant.
 *
 * Identity precedence:
 *   1. Delegated-user claims (`usr`/`user`) — authoritative for identity + roles.
 *   2. A user `actor` (`actor.kind === 'user'` with a non-empty `actor.id`).
 *   3. A user-shaped `sub` (`user:<id>`) when no actor identity applies.
 * An explicit non-user actor ('guest'/'agent') is never promoted to a user.
 *
 * NOTE: This module is mirrored byte-for-byte at
 * AssistOSExplorer/shared/invocation-auth.mjs (the dev/local fallback load path).
 * Keep the two identical; shared/tests/invocationAuthParity.test.mjs guards drift.
 */
function normalizeRoles(value) {
  return Array.isArray(value) ? value.map((role) => String(role || '').trim()).filter(Boolean) : [];
}

function extractCallerPrincipal(grant) {
  const caller = grant?.caller;
  if (caller && typeof caller === 'object') {
    return String(caller.id || '').trim();
  }
  return String(caller || grant?.sub || '').trim();
}

function normalizeUserPrincipal(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const principalId = /^user:/i.test(raw) ? raw : `user:${raw}`;
  const id = principalId.replace(/^user:/i, '');
  const localMatch = id.match(/^local:(.+)$/i);
  return {
    principalId,
    id,
    username: localMatch?.[1] || id
  };
}

function deriveUserIdentity(grant, actor) {
  const actorKind = String(actor?.kind || '').trim().toLowerCase();
  const actorId = String(actor?.id || '').trim();
  if (actorKind === 'user' && actorId) {
    return normalizeUserPrincipal(actorId);
  }
  // An explicit non-user actor (e.g. 'guest'/'agent') is never promoted to an
  // authenticated user, even when `sub` is user-shaped. Only fall back to `sub`
  // when the actor is absent, kindless, or a user actor missing its id.
  if (actorKind && actorKind !== 'user') {
    return null;
  }
  const subject = String(grant?.sub || '').trim();
  if (/^user:/i.test(subject)) {
    return normalizeUserPrincipal(subject);
  }
  return null;
}

export function authInfoFromInvocation(grant, { invocationToken = '' } = {}) {
  if (!grant || typeof grant !== 'object') return null;
  const out = {};
  const callerPrincipal = extractCallerPrincipal(grant);
  if (callerPrincipal && /^agent:/i.test(callerPrincipal)) {
    out.agent = {
      principalId: callerPrincipal,
      name: String(callerPrincipal).replace(/^agent:/i, '')
    };
  }
  const actor = grant.actor && typeof grant.actor === 'object' ? grant.actor : null;
  // Precedence: explicit delegated-user claims (`usr`/`user`) are authoritative
  // for the resolved user identity AND its roles. When present, the router-signed
  // `actor.roles` are intentionally NOT merged — an actor must not widen a
  // delegated user's privileges. `actor`/`sub` seed the identity only when no
  // user claims exist.
  const userClaims = grant.usr || grant.user;
  if (userClaims && typeof userClaims === 'object') {
    const fallbackIdentity = deriveUserIdentity(grant, actor);
    const claimedIdentity = normalizeUserPrincipal(userClaims.id || userClaims.sub || fallbackIdentity?.id || '');
    out.user = {
      id: claimedIdentity?.id || String(userClaims.id || userClaims.sub || ''),
      username: String(userClaims.username || userClaims.preferred_username || claimedIdentity?.username || ''),
      email: String(userClaims.email || ''),
      roles: normalizeRoles(userClaims.roles)
    };
    if (userClaims.principalId || claimedIdentity?.principalId) {
      out.principalId = String(userClaims.principalId || claimedIdentity.principalId);
    }
  } else {
    const identity = deriveUserIdentity(grant, actor);
    if (identity) {
      out.principalId = identity.principalId;
      out.user = {
        id: identity.id,
        username: identity.username,
        email: '',
        roles: normalizeRoles(actor?.roles)
      };
    }
  }
  out.invocation = {
    issuer: String(grant.iss || ''),
    subject: String(grant.sub || grant.actor?.id || ''),
    actor: actor
      ? {
          kind: String(actor.kind || ''),
          id: String(actor.id || ''),
          roles: normalizeRoles(actor.roles)
        }
      : null,
    scope: Array.isArray(grant.scope) ? [...grant.scope] : [],
    tool: String(grant.tool || ''),
    workspaceId: String(grant.workspace_id || ''),
    caller: grant.caller && typeof grant.caller === 'object'
      ? {
          kind: String(grant.caller.kind || ''),
          id: String(grant.caller.id || ''),
          roles: normalizeRoles(grant.caller.roles)
        }
      : (callerPrincipal ? { kind: 'agent', id: callerPrincipal, roles: [] } : null),
    delegation: grant.delegation && typeof grant.delegation === 'object'
      ? {
          jti: String(grant.delegation.jti || ''),
          scope: normalizeRoles(grant.delegation.scope),
          sourceAgentId: String(grant.delegation.sourceAgentId || '')
        }
      : null
  };
  out.invocationToken = String(invocationToken || '');
  return out;
}

export default { authInfoFromInvocation };
