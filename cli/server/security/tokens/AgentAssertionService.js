import { JwsCodec } from './JwsCodec.js';

const AGENT_PRINCIPAL_RE = /^agent:[^/\s:]+\/[^/\s:]+$/;

function isPromiseLike(value) {
    return value && typeof value.then === 'function';
}

function parseIssuer(token) {
    if (!token) {
        throw new Error('invocationMinter: agent assertion required');
    }
    const parts = String(token).split('.');
    if (parts.length !== 3) {
        throw new Error('invocationMinter: malformed agent assertion');
    }
    let claims;
    try {
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        throw new Error('invocationMinter: malformed agent assertion payload');
    }
    const iss = String(claims?.iss || '');
    if (!AGENT_PRINCIPAL_RE.test(iss)) {
        throw new Error('invocationMinter: agent assertion issuer is not a valid agent id');
    }
    return iss;
}

function bindingError(message) {
    return new Error(`AGENT_ASSERTION_BINDING_MISMATCH: ${message}`);
}

function validatePayload(payload, { method, path, tool, rch, targetAgentId }) {
    if (method !== undefined && String(payload.method || '') !== String(method)) {
        throw bindingError('method mismatch');
    }
    if (path !== undefined && String(payload.path || '') !== String(path)) {
        throw bindingError('path mismatch');
    }
    if (tool !== undefined && String(payload.tool || '') !== String(tool)) {
        throw bindingError('tool mismatch');
    }
    if (rch !== undefined && String(payload.rch || '') !== String(rch)) {
        throw bindingError('request hash mismatch');
    }
    if (!payload.targetAgent) {
        throw bindingError('agent assertion is missing targetAgent');
    }
    if (!targetAgentId || String(payload.targetAgent) !== String(targetAgentId)) {
        throw bindingError('agent assertion targetAgent mismatch');
    }
    if (payload?.typ !== 'agent-assertion') {
        throw new Error('jwtVerify: token type is not agent-assertion');
    }
    const iss = String(payload.iss || '');
    if (!iss) {
        throw new Error('jwtVerify: agent assertion missing issuer');
    }
    if (String(payload.sub || '') !== iss) {
        throw new Error('jwtVerify: agent assertion sub must equal iss');
    }
}

export class AgentAssertionService {
    constructor({
        jwsCodec = new JwsCodec(),
        resolveAgentSecret,
    } = {}) {
        this.jwsCodec = jwsCodec;
        this.resolveAgentSecret = resolveAgentSecret;
    }

    async verify({ token, method, path, tool, rch, targetAgentId, replayCache }) {
        let iss;
        try {
            iss = parseIssuer(token);
        } catch (error) {
            if (!String(error?.message || '').includes('malformed agent assertion')) {
                throw error;
            }
            iss = String(targetAgentId || '').trim();
            if (!iss) throw error;
        }
        const secret = await this.resolveAgentSecret(iss);
        const { payload } = await this.jwsCodec.verifyJws(token, {
            secret,
            expectedAudience: 'ploinky-router',
            method,
            path,
            tool,
            rch,
            replayCache,
            maxTtlSeconds: 60,
        });
        validatePayload(payload, { method, path, tool, rch, targetAgentId });
        return { callerPrincipal: iss, payload };
    }

    verifySync({ token, method, path, tool, rch, targetAgentId, replayCache }) {
        const iss = parseIssuer(token);
        const secret = this.resolveAgentSecret(iss);
        if (isPromiseLike(secret)) {
            throw new Error('AgentAssertionService: async secret resolver cannot be used through sync adapter');
        }
        const result = this.jwsCodec.verifyJws(token, {
            secret,
            expectedAudience: 'ploinky-router',
            replayCache,
            maxTtlSeconds: 60,
        });
        if (isPromiseLike(result)) {
            throw new Error('AgentAssertionService: async verifier cannot be used through sync adapter');
        }
        const payload = result.payload || {};
        validatePayload(payload, { method, path, tool, rch, targetAgentId });
        return { callerPrincipal: iss, payload };
    }
}
