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
  const userClaims = grant.usr || grant.user;
  if (userClaims && typeof userClaims === 'object') {
    out.user = {
      id: String(userClaims.id || userClaims.sub || ''),
      username: String(userClaims.username || userClaims.preferred_username || ''),
      email: String(userClaims.email || ''),
      roles: Array.isArray(userClaims.roles) ? [...userClaims.roles] : []
    };
  }
  out.invocation = {
    issuer: String(grant.iss || ''),
    subject: String(grant.sub || grant.actor?.id || ''),
    actor: grant.actor && typeof grant.actor === 'object'
      ? {
          kind: String(grant.actor.kind || ''),
          id: String(grant.actor.id || ''),
          roles: Array.isArray(grant.actor.roles) ? [...grant.actor.roles] : []
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
