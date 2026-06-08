function normalizeRoles(value) {
  return Array.isArray(value) ? value.map((role) => String(role || '').trim()).filter(Boolean) : [];
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
  const subject = String(grant?.sub || '').trim();
  if (/^user:/i.test(subject)) {
    return normalizeUserPrincipal(subject);
  }
  return null;
}

export function authInfoFromInvocation(grant, { invocationToken = '' } = {}) {
  if (!grant || typeof grant !== 'object') return null;
  const out = {};
  const callerPrincipal = grant.caller || grant.sub || '';
  if (callerPrincipal && /^agent:/i.test(callerPrincipal)) {
    out.agent = {
      principalId: callerPrincipal,
      name: String(callerPrincipal).replace(/^agent:/i, '')
    };
  }
  const actor = grant.actor && typeof grant.actor === 'object' ? grant.actor : null;
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
    workspaceId: String(grant.workspace_id || '')
  };
  out.invocationToken = String(invocationToken || '');
  return out;
}

export default { authInfoFromInvocation };
