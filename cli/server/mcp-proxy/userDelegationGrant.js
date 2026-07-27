import { UserDelegationGrantService, resolveMaxTtlSeconds } from '../security/tokens/UserDelegationGrantService.js';

function serviceForSecret(signingSecret) {
    return new UserDelegationGrantService({
        resolveGrantSecret: () => signingSecret,
    });
}

export { resolveMaxTtlSeconds };

export function mintUserDelegationGrant({
    signingSecret,
    now = new Date(),
    ttlSeconds,
    sourceAgentId,
    route,
    user,
    actor,
    targetAgentId,
    tools,
    scopes,
}) {
    return serviceForSecret(signingSecret).mintSync({
        now,
        ttlSeconds,
        sourceAgentId,
        route,
        user,
        actor,
        targetAgentId,
        tools,
        scopes,
    });
}

export function verifyUserDelegationGrant({
    signingSecret,
    token,
    now = new Date(),
    expectedSourceAgentId,
    expectedTargetAgentId,
    expectedTool,
    replayCache,
}) {
    return serviceForSecret(signingSecret).verifySync({
        token,
        now,
        expectedSourceAgentId,
        expectedTargetAgentId,
        expectedTool,
        replayCache,
    });
}

export default {
    mintUserDelegationGrant,
    verifyUserDelegationGrant,
};
