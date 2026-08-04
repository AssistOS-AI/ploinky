import {
    buildAgentCredentialPublicAttestation,
    readAgentCredentialDescriptor,
} from './agentCredentialDescriptor.mjs';
import {
    assertVerifiedGeneratedRouterDescriptor,
    loadVerifiedGeneratedRouterDescriptor,
} from '../client/generatedRouterDescriptor.mjs';

const CONTEXTS = new WeakSet();
const PRIVATE = new WeakMap();
const HEX_SECRET_RE = /^[a-f0-9]{64}$/;

export class AgentCredentialContextError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'AgentCredentialContextError';
        this.code = code;
    }
}

function fail(code, message, cause) {
    throw new AgentCredentialContextError(code, message, cause ? { cause } : undefined);
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function exactCredential(value, field, pattern = null) {
    if (typeof value !== 'string' || !value || value !== value.trim()
        || Buffer.byteLength(value, 'utf8') > 2048
        || (pattern && !pattern.test(value))) {
        fail('PLOINKY_AGENT_CREDENTIAL_CONTEXT_INVALID', `${field} is invalid`);
    }
    return value;
}

function normalizeNow(now) {
    const seconds = now === undefined ? Math.floor(Date.now() / 1000) : now;
    if (!Number.isSafeInteger(seconds) || seconds < 0) {
        fail('PLOINKY_AGENT_CREDENTIAL_CONTEXT_TIME', 'credential activity time must be nonnegative Unix seconds');
    }
    return seconds;
}

function contextMethod(name, fn) {
    return {
        [name]: function agentCredentialContextMethod(...args) {
            const context = assertAgentCredentialContext(this);
            return fn(context, PRIVATE.get(context), ...args);
        },
    }[name];
}

const assertActive = contextMethod('assertActive', (context, secretState, now) => {
    const seconds = normalizeNow(now);
    if (secretState.expiresAt !== null
        && (seconds < secretState.issuedAt || seconds >= secretState.expiresAt)) {
        fail('PLOINKY_AGENT_CREDENTIAL_CONTEXT_EXPIRED', 'agent credential context is not active');
    }
    return context;
});

function secretGetter(name, field) {
    return contextMethod(name, (context, secretState) => {
        assertActive.call(context);
        return `${secretState[field]}`;
    });
}

const getAgentSecret = secretGetter('getAgentSecret', 'agentSecret');
const getPrivateAgentSecret = secretGetter('getPrivateAgentSecret', 'privateSecret');
const getAgentApiKey = secretGetter('getAgentApiKey', 'apiKey');
const getAgentApiPublicKey = secretGetter('getAgentApiPublicKey', 'apiPublicKey');

function createContext({ identity, runtime, router, attestation, source, credentials }) {
    const context = {
        identity: deepFreeze({ ...identity }),
        runtime: deepFreeze({ ...runtime }),
        router: deepFreeze({ ...router }),
        attestation: deepFreeze({ ...attestation }),
        source,
    };
    Object.defineProperties(context, {
        assertActive: { value: assertActive, enumerable: false },
        getAgentSecret: { value: getAgentSecret, enumerable: false },
        getPrivateAgentSecret: { value: getPrivateAgentSecret, enumerable: false },
        getAgentApiKey: { value: getAgentApiKey, enumerable: false },
        getAgentApiPublicKey: { value: getAgentApiPublicKey, enumerable: false },
    });
    PRIVATE.set(context, Object.freeze({
        agentSecret: exactCredential(credentials.agentSecret, 'agentSecret', HEX_SECRET_RE),
        privateSecret: exactCredential(credentials.privateSecret, 'privateSecret', HEX_SECRET_RE),
        apiKey: exactCredential(credentials.apiKey, 'apiKey'),
        apiPublicKey: exactCredential(credentials.apiPublicKey, 'apiPublicKey', /^[A-Za-z0-9_-]+$/),
        issuedAt: attestation.issuedAt,
        expiresAt: attestation.expiresAt,
    }));
    CONTEXTS.add(context);
    return deepFreeze(context);
}

export function assertAgentCredentialContext(value) {
    if (!value || typeof value !== 'object' || !CONTEXTS.has(value)) {
        fail('PLOINKY_AGENT_CREDENTIAL_CONTEXT_REQUIRED', 'a trusted AgentCredentialContext is required');
    }
    return value;
}

function createBwrapContextFromRead(read) {
    const descriptor = read?.descriptor;
    if (!descriptor || !read.publicAttestation) {
        fail('PLOINKY_AGENT_CREDENTIAL_CONTEXT_INVALID', 'verified bwrap credential read is required');
    }
    const publicAttestation = buildAgentCredentialPublicAttestation(descriptor);
    return createContext({
        identity: {
            principalId: descriptor.principalId,
            instanceId: descriptor.instanceId,
            enableGeneration: descriptor.enableGeneration,
        },
        runtime: {
            runtimeKind: 'bwrap',
            runtimeKey: descriptor.runtimeKey,
            routeKey: descriptor.routeKey,
        },
        router: descriptor.router,
        attestation: {
            manifestDigest: descriptor.admission.manifestDigest,
            capabilityDigest: descriptor.admission.capabilityDigest,
            networkHash: descriptor.admission.networkHash,
            admissionDigest: descriptor.admissionDigest,
            nonceDigest: publicAttestation.nonceDigest,
            issuedAt: descriptor.issuedAt,
            expiresAt: descriptor.expiresAt,
        },
        source: 'bwrap-credential-v1',
        credentials: descriptor.credentials,
    });
}

export function createBwrapAgentCredentialContext() {
    return createBwrapContextFromRead(readAgentCredentialDescriptor());
}

function requireOwnGenerated(env, name) {
    if (!Object.prototype.hasOwnProperty.call(env, name)
        || typeof env[name] !== 'string'
        || !env[name]
        || env[`PLOINKY_ENV_SOURCE_${name}`] !== 'generated') {
        fail('PLOINKY_AGENT_CREDENTIAL_CONTEXT_PROVENANCE', `${name} lacks exact generated provenance`);
    }
    return env[name];
}

function createContainerContextWith(env, loadDescriptor) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
        fail('PLOINKY_AGENT_CREDENTIAL_CONTEXT_ENV', 'an explicit container environment is required');
    }
    const runtimeKind = String(env.PLOINKY_RUNTIME || '').trim().toLowerCase();
    if (runtimeKind === 'bwrap' || runtimeKind === 'seatbelt'
        || Object.prototype.hasOwnProperty.call(env, 'PLOINKY_AGENT_CREDENTIAL_FILE')) {
        fail('PLOINKY_AGENT_CREDENTIAL_CONTEXT_ENV', 'container credential adaptation is forbidden for a host sandbox runtime');
    }
    const verified = assertVerifiedGeneratedRouterDescriptor(loadDescriptor({ env }));
    const payload = verified.payload;
    const principalId = requireOwnGenerated(env, 'PLOINKY_AGENT_PRINCIPAL');
    if (principalId !== requireOwnGenerated(env, 'PLOINKY_AGENT_ID')
        || principalId !== payload.agentPrincipal
        || requireOwnGenerated(env, 'PLOINKY_AGENT_INSTANCE_ID') !== payload.instanceId
        || requireOwnGenerated(env, 'PLOINKY_AGENT_ENABLE_GENERATION') !== payload.generationId) {
        fail('PLOINKY_AGENT_CREDENTIAL_CONTEXT_PROVENANCE', 'container generated identity mirrors disagree');
    }
    const apiKey = requireOwnGenerated(env, 'PLOINKY_AGENT_API_KEY');
    const apiPublicKey = requireOwnGenerated(env, 'PLOINKY_AGENT_API_PUBLIC_KEY');
    const agentSecret = exactCredential(env.PLOINKY_AGENT_SECRET, 'PLOINKY_AGENT_SECRET', HEX_SECRET_RE);
    const privateSecret = exactCredential(env.PLOINKY_AGENT_PRIVATE_SECRET, 'PLOINKY_AGENT_PRIVATE_SECRET', HEX_SECRET_RE);
    if (!apiKey.startsWith(`${principalId}|`)) {
        fail('PLOINKY_AGENT_CREDENTIAL_CONTEXT_PROVENANCE', 'container API key does not belong to generated principal');
    }
    const routeKey = principalId.slice(principalId.indexOf('/') + 1);
    return createContext({
        identity: {
            principalId,
            instanceId: payload.instanceId,
            enableGeneration: payload.generationId,
        },
        runtime: {
            runtimeKind: 'container',
            runtimeKey: payload.instanceId,
            routeKey,
        },
        router: {
            physicalOrigin: payload.physicalOrigin,
            requestAuthority: payload.requestAuthority,
            host: payload.routerHost,
            port: Number(payload.routerPort),
        },
        attestation: {
            manifestDigest: null,
            capabilityDigest: null,
            networkHash: payload.networkFingerprint,
            admissionDigest: payload.semanticTopologyDigest,
            nonceDigest: payload.attestationId,
            issuedAt: Math.floor(payload.issuedAtUnixMs / 1000),
            expiresAt: null,
        },
        source: 'container-generated-env-v1',
        credentials: { agentSecret, privateSecret, apiKey, apiPublicKey },
    });
}

export function createContainerAgentCredentialContext(env) {
    return createContainerContextWith(env, loadVerifiedGeneratedRouterDescriptor);
}

export const __testables = Object.freeze({
    createBwrapContextFromRead,
    createContainerContextWith,
});
