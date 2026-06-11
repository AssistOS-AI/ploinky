import { signHmacJwt as defaultSignHmacJwt } from '../../../../Agent/lib/jwtSign.mjs';
import {
    createMemoryReplayCache as defaultCreateMemoryReplayCache,
    verifyJws as defaultVerifyJws,
} from '../../../../Agent/lib/jwtVerify.mjs';

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

export function createTokenReplayCache(options) {
    return defaultCreateMemoryReplayCache(options);
}
