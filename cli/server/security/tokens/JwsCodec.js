import { signHmacJwt as defaultSignHmacJwt } from '../../../../Agent/lib/jwtSign.mjs';
import { verifyJws as defaultVerifyJws } from '../../../../Agent/lib/jwtVerify.mjs';
import { createPartitionedReplayCache, legacyMinRetentionMs } from '../../../../Agent/lib/replayCache.mjs';

export class JwsCodec {
    constructor({ signHmacJwt = defaultSignHmacJwt, verifyJws = defaultVerifyJws } = {}) {
        this.signHmacJwt = signHmacJwt;
        this.verifyJws = verifyJws;
    }

    sign(input) {
        return this.signHmacJwt(input);
    }

    verify(token, options) {
        return this.verifyJws(token, options);
    }
}

// Router-side Agent Assertion replay cache: one quota per verified issuer, so
// an agent that exhausts its own quota cannot lock other agents out.
export function createTokenReplayCache(options = {}) {
    return createPartitionedReplayCache({
        perCallerMaxSize: 16384,
        maxSize: 131072,
        maxPartitions: 256,
        legacyMinRetentionMs: legacyMinRetentionMs({ maxTtlSeconds: 60 }),
        ...options,
    });
}
