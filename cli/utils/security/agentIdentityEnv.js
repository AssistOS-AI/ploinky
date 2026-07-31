import { deriveAgentRequestSecret, derivePrivateAgentRequestSecret } from './masterKey.js';
import { buildSubjectIdentityKey, getSubjectIdentityPublicKey } from './subjectIdentityKey.js';

/**
 * The per-agent identity injected into EVERY agent runtime (docker, bwrap, and
 * host lifecycle hooks). An agent receives ONLY its own canonical id and the
 * material derived/signed for that id (DS013) — never the master key, never the
 * shared derived-master key, never another agent's secret, and never any private
 * signing key.
 *
 * The injected material is:
 *  - PLOINKY_AGENT_ID / PLOINKY_AGENT_PRINCIPAL — the canonical subject id.
 *  - PLOINKY_AGENT_SECRET — the per-agent request-signing secret derived from id.
 *  - PLOINKY_AGENT_API_KEY — the signed identity key for this id,
 *    of shape `<id>|<signature>`, minted at build time from the canonical subject.
 *  - PLOINKY_AGENT_API_PUBLIC_KEY — the public verification key (base64url)
 *    consumers use to verify the signed key. Only public material.
 *  - PLOINKY_ENV_SOURCE_* — provenance markers (`generated`) flagging that the
 *    above identity values were minted here, not supplied by config.
 *
 * Centralized here so all three runtime managers inject one identical, audited
 * key set instead of duplicating the construction. Only public/derived material
 * is returned; the private signing key never leaves subjectIdentityKey.js.
 */
function normalizePrincipal(principalId) {
    const id = String(principalId || '').trim();
    if (!id) {
        throw new Error('agentIdentityEnv: principalId is required');
    }
    return id;
}

function normalizeRuntimeIdentity(instanceId, enableGeneration) {
    const instance = String(instanceId || '').trim();
    const generation = String(enableGeneration || '').trim();
    if (Boolean(instance) !== Boolean(generation)) {
        throw new Error('agentIdentityEnv: instanceId and enableGeneration must be provided together');
    }
    return { instance, generation };
}

function markGenerated(env, names) {
    for (const name of names) env[`PLOINKY_ENV_SOURCE_${name}`] = 'generated';
    return env;
}

// Non-secret identity fields may be prepared before topology attestation. They
// carry no signing key, API key, agent request secret, or private request
// secret, so a failed attestation cannot leave a key-capable partial env.
export function buildAgentPrincipalEnv(principalId, { instanceId = '', enableGeneration = '' } = {}) {
    const id = normalizePrincipal(principalId);
    const { instance, generation } = normalizeRuntimeIdentity(instanceId, enableGeneration);
    const identity = {
        PLOINKY_AGENT_ID: id,
        PLOINKY_AGENT_PRINCIPAL: id,
    };
    if (instance || generation) {
        identity.PLOINKY_AGENT_INSTANCE_ID = instance;
        identity.PLOINKY_AGENT_ENABLE_GENERATION = generation;
    }
    return markGenerated(identity, Object.keys(identity));
}

// Credential material is deliberately a separate post-attestation operation.
// Callers must not invoke this until the listener/Host observation and
// descriptor signature have succeeded and the observed generation is current.
export function buildAgentCredentialEnv(principalId, { instanceId = '', enableGeneration = '' } = {}) {
    const id = normalizePrincipal(principalId);
    const { instance, generation } = normalizeRuntimeIdentity(instanceId, enableGeneration);
    // Retrieve only the public trust anchor first, then mint the subject API
    // key. Neither helper returns the private signing key.
    const publicKey = getSubjectIdentityPublicKey();
    const apiKey = buildSubjectIdentityKey(id);
    const identity = {
        PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(id),
        PLOINKY_AGENT_API_KEY: apiKey,
        PLOINKY_AGENT_API_PUBLIC_KEY: publicKey,
    };
    if (instance || generation) {
        identity.PLOINKY_AGENT_PRIVATE_SECRET = derivePrivateAgentRequestSecret(id, instance, generation);
    }
    markGenerated(identity, ['PLOINKY_AGENT_API_KEY', 'PLOINKY_AGENT_API_PUBLIC_KEY']);
    return identity;
}

// Backward-compatible aggregate used by non-generated-local callers. New
// lifecycle code must use the two phases above around topology attestation.
export function buildAgentIdentityEnv(principalId, options = {}) {
    return {
        ...buildAgentPrincipalEnv(principalId, options),
        ...buildAgentCredentialEnv(principalId, options),
    };
}

// Env names that are router-managed and must NEVER be settable by agent-supplied
// configuration (manifest env, profile env, profile secrets, runtime resources):
// the workspace master keys (must never enter an agent at all), the per-agent
// identity, box-owned topology/Router locators, and the generated signed
// identity key / public verification key / provenance markers. All of these
// must come only from the owning runtime layer, never an override — a manifest
// must not be able to redirect a hook, substitute its own signed key, public
// key, or forge a `generated` provenance claim.
export const GENERATED_RUNTIME_ENV_NAMES = Object.freeze([
    'PLOINKY_ROUTER_DESCRIPTOR_FILE',
    'PLOINKY_ROUTER_HOST',
    'PLOINKY_ROUTER_PORT',
    'PLOINKY_ROUTER_URL',
    'PLOINKY_ROUTER_REQUEST_AUTHORITY',
    'PLOINKY_ROUTER_AUTHORITY',
    'PLOINKY_INTERNAL_ROUTER_URL',
    'PLOINKY_EDGE_TOPOLOGY_FILE',
    'PLOINKY_ROUTER_LISTENER_CLASS',
    'PLOINKY_ROUTER_ATTESTATION_ID',
    'PLOINKY_ROUTER_TRANSPORT_VERSION',
    'PLOINKY_ROUTER_LOCAL_STREAMING',
    'PLOINKY_AGENT_ID',
    'PLOINKY_AGENT_PRINCIPAL',
    'PLOINKY_AGENT_INSTANCE_ID',
    'PLOINKY_AGENT_ENABLE_GENERATION',
    'PLOINKY_AGENT_API_PUBLIC_KEY',
    'PLOINKY_AGENT_API_KEY',
]);

const GENERATED_RUNTIME_SOURCE_NAMES = GENERATED_RUNTIME_ENV_NAMES.map((name) => `PLOINKY_ENV_SOURCE_${name}`);

export const RESERVED_AGENT_ENV_NAMES = Object.freeze([
    'PLOINKY_MASTER_KEY',
    'PLOINKY_DERIVED_MASTER_KEY',
    'PLOINKY_TURN_SHARED_SECRET',
    'PLOINKY_CLOUDFLARE_TUNNEL_TOKEN',
    'PLOINKY_CLOUDFLARE_API_TOKEN',
    ...GENERATED_RUNTIME_ENV_NAMES,
    ...GENERATED_RUNTIME_SOURCE_NAMES,
    'PLOINKY_AGENT_LIB_DIR',
    'PLOINKY_AGENT_SECRET',
    'PLOINKY_AGENT_PRIVATE_SECRET',
]);

const RESERVED = new Set(RESERVED_AGENT_ENV_NAMES);

/**
 * Remove every reserved name from a CONFIG-sourced env map in place, so no
 * manifest/profile/secret layer can inject a master key or override an agent's
 * derived identity (DS011/DS013). Dropped names are logged (never their values).
 * Returns the same object for chaining. Apply this to config-sourced env BEFORE
 * the authoritative identity is (re)asserted with `buildAgentIdentityEnv`.
 */
export function stripReservedAgentEnv(env) {
    if (!env || typeof env !== 'object') return env;
    let dropped = null;
    for (const key of Object.keys(env)) {
        if (!RESERVED.has(key) && !key.startsWith('PLOINKY_ENV_SOURCE_PLOINKY_')) continue;
        (dropped ||= []).push(key);
        delete env[key];
    }
    if (dropped) {
        console.error(`[ploinky] ignored reserved agent env name(s) ${dropped.join(', ')} from runtime config — these are router-managed (DS011/DS013).`);
    }
    return env;
}

export default {
    buildAgentPrincipalEnv,
    buildAgentCredentialEnv,
    buildAgentIdentityEnv,
    stripReservedAgentEnv,
    GENERATED_RUNTIME_ENV_NAMES,
    RESERVED_AGENT_ENV_NAMES,
};
