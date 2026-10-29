import crypto from 'node:crypto';

import { JwsCodec } from './JwsCodec.js';
import {
    EXECUTION_PROVIDER_TERMINAL_HELLO_PURPOSE,
    EXECUTION_PROVIDER_TERMINAL_PURPOSE,
    ROUTER_SERVICE_ISSUER,
    ROUTER_SERVICE_METHOD,
    ROUTER_SERVICE_TOKEN_TYPE,
    ROUTER_SERVICE_TTL_SECONDS,
    computeRouterServiceRch,
    isRouterServiceNonce,
    isRouterServicePurpose,
} from '../../../../Agent/lib/routerServiceToken.mjs';

function isPromiseLike(value) {
    return value && typeof value.then === 'function';
}

/**
 * Mints Router-service tokens (`typ: 'router-service'`) for Router-internal
 * service channels, signed with the target agent's own per-agent secret.
 *
 * A Router-service token names a purpose and carries no identity: never an
 * actor, subject, tool, user, caller, scope or delegation. Method is fixed to
 * GET, `rch` binds method and path, and the lifetime is fixed at 30 seconds.
 * The hello purpose additionally carries `nonce`, the connection's challenge
 * nonce (required there, refused for any other purpose).
 * Forwarded route invocations keep using RouterRequestTokenService
 * (`typ: 'router-request'`); this service is the only minter of this type.
 */
export class RouterServiceTokenService {
    constructor({
        jwsCodec = new JwsCodec(),
        resolveAgentSecret,
        now = () => new Date(),
        randomId = () => crypto.randomBytes(16).toString('base64url'),
    } = {}) {
        this.jwsCodec = jwsCodec;
        this.resolveAgentSecret = resolveAgentSecret;
        this.now = now;
        this.randomId = randomId;
    }

    _payload({ targetAgentId, path, purpose = EXECUTION_PROVIDER_TERMINAL_PURPOSE, nonce } = {}) {
        const target = String(targetAgentId || '').trim();
        if (!target) throw new Error('RouterServiceTokenService: targetAgentId required');
        if (typeof path !== 'string' || !path.startsWith('/')) {
            throw new Error('RouterServiceTokenService: path must be an absolute path');
        }
        if (!isRouterServicePurpose(purpose)) {
            throw new Error('RouterServiceTokenService: unknown purpose');
        }
        const isHello = purpose === EXECUTION_PROVIDER_TERMINAL_HELLO_PURPOSE;
        if (isHello && !isRouterServiceNonce(nonce)) {
            throw new Error('RouterServiceTokenService: hello purpose requires a 32-byte base64url nonce');
        }
        if (!isHello && nonce !== undefined) {
            throw new Error('RouterServiceTokenService: nonce is only valid for the hello purpose');
        }
        const iat = Math.floor(this.now().getTime() / 1000);
        const payload = {
            typ: ROUTER_SERVICE_TOKEN_TYPE,
            iss: ROUTER_SERVICE_ISSUER,
            aud: target,
            purpose,
            method: ROUTER_SERVICE_METHOD,
            path,
            rch: computeRouterServiceRch({ method: ROUTER_SERVICE_METHOD, path }),
            jti: this.randomId(),
            iat,
            exp: iat + ROUTER_SERVICE_TTL_SECONDS,
            ...(isHello ? { nonce } : {}),
        };
        return { target, payload };
    }

    async mint(input) {
        const { token } = await this.mintWithPayload(input);
        return token;
    }

    async mintWithPayload(input) {
        const { target, payload } = this._payload(input);
        const token = await this.jwsCodec.signHmacJwt({
            payload,
            secret: await this.resolveAgentSecret(target),
        });
        return { token, payload };
    }

    mintWithPayloadSync(input) {
        const { target, payload } = this._payload(input);
        const secret = this.resolveAgentSecret(target);
        if (isPromiseLike(secret)) {
            throw new Error('RouterServiceTokenService: async secret resolver cannot be used through sync adapter');
        }
        const token = this.jwsCodec.signHmacJwt({ payload, secret });
        if (isPromiseLike(token)) {
            throw new Error('RouterServiceTokenService: async signer cannot be used through sync adapter');
        }
        return { token, payload };
    }
}
