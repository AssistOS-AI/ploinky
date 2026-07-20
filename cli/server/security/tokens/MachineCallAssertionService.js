import { createMemoryReplayCache } from '../../../../Agent/lib/jwtVerify.mjs';
import { verifyMachineCallAssertion } from '../../../../Agent/lib/machineCallAssertion.mjs';

export class MachineCallAssertionService {
    constructor({ resolveAgentSecret, generationStore, replayCache = createMemoryReplayCache() } = {}) {
        if (typeof resolveAgentSecret !== 'function' || !generationStore) {
            throw new Error('MachineCallAssertionService: secret resolver and generation store required');
        }
        this.resolveAgentSecret = resolveAgentSecret;
        this.generationStore = generationStore;
        this.replayCache = replayCache;
    }

    verify(token, request = {}) {
        const generation = this.generationStore.active;
        if (!generation) throw new Error('MachineCallAssertionService: no active generation');
        const untrustedParts = String(token || '').split('.');
        if (untrustedParts.length !== 3) throw new Error('MachineCallAssertionService: malformed assertion');
        let untrusted;
        try { untrusted = JSON.parse(Buffer.from(untrustedParts[1], 'base64url').toString('utf8')); } catch (_) {
            throw new Error('MachineCallAssertionService: malformed assertion payload');
        }
        const callerAgentId = String(untrusted.iss || '');
        const callerRoute = Object.values(generation.routes).find(route => route?.relay?.targetAgentId === callerAgentId);
        const targetRoute = generation.routes[request.targetRouteKey];
        if (!callerRoute || !targetRoute?.relay) throw new Error('MachineCallAssertionService: caller or target inactive');
        const allowed = generation.privateCallerAcls?.[request.targetRouteKey] || [];
        const allowedExactCall = allowed.some(entry => entry.callerAgentId === callerAgentId
            && entry.port === Number(request.port)
            && entry.method === String(request.method || '').toUpperCase()
            && entry.path === String(request.path || ''));
        if (!allowedExactCall) throw new Error('MachineCallAssertionService: private caller ACL denied');
        return verifyMachineCallAssertion(token, {
            secret: this.resolveAgentSecret(callerAgentId),
            replayCache: this.replayCache,
            callerAgentId,
            callerEnableGeneration: callerRoute.enableGeneration,
            targetAgentId: targetRoute.relay.targetAgentId,
            port: request.port,
            method: request.method,
            path: request.path,
            bodyHash: request.bodyHash,
            generationDigest: generation.digest,
        });
    }
}

export default MachineCallAssertionService;
