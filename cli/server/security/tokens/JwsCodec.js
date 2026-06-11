import { signHmacJwt as defaultSignHmacJwt } from '../../../../Agent/lib/jwtSign.mjs';
import { verifyJws as defaultVerifyJws } from '../../../../Agent/lib/jwtVerify.mjs';

export class JwsCodec {
    constructor({ signHmacJwt = defaultSignHmacJwt, verifyJws = defaultVerifyJws } = {}) {
        this.signHmacJwt = signHmacJwt;
        this.verifyJws = verifyJws;
    }
}
