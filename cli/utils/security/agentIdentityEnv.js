import { deriveAgentRequestSecret } from './masterKey.js';
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
export function buildAgentIdentityEnv(principalId) {
    const id = String(principalId || '').trim();
    if (!id) {
        throw new Error('agentIdentityEnv: principalId is required');
    }
    // `id` is the canonical `agent:<repo>/<agentName>` subject, so we can sign it
    // directly.
    // NOTE: `buildSubjectIdentityKey`/`getSubjectIdentityPublicKey` widen the throw
    // surface beyond the prior master-key-absence path — they also touch the
    // encrypted keypair store (.ploinky/), so corrupt/unwritable key material now
    // throws here too. The docker/bwrap/lifecycle callers swallow this throw and
    // continue, which means a key-store fault degrades an agent to no-identity
    // rather than failing startup; fail-closing that path is a separate change.
    const apiKey = buildSubjectIdentityKey(id);
    const publicKey = getSubjectIdentityPublicKey();
    return {
        PLOINKY_AGENT_ID: id,
        PLOINKY_AGENT_PRINCIPAL: id,
        PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(id),
        PLOINKY_AGENT_API_KEY: apiKey,
        PLOINKY_AGENT_API_PUBLIC_KEY: publicKey,
        PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY: 'generated',
        PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_PUBLIC_KEY: 'generated',
    };
}

// Env names that are router-managed and must NEVER be settable by agent-supplied
// configuration (manifest env, profile env, profile secrets, runtime resources):
// the workspace master keys (must never enter an agent at all), the per-agent
// identity, and the generated signed identity key / public verification key /
// provenance markers. All of these must come only from `buildAgentIdentityEnv`,
// never an override — a manifest must not be able to substitute its own signed
// key, public key, or forge a `generated` provenance claim.
export const RESERVED_AGENT_ENV_NAMES = Object.freeze([
    'PLOINKY_MASTER_KEY',
    'PLOINKY_DERIVED_MASTER_KEY',
    'PLOINKY_AGENT_ID',
    'PLOINKY_AGENT_PRINCIPAL',
    'PLOINKY_AGENT_SECRET',
    'PLOINKY_AGENT_API_KEY',
    'PLOINKY_AGENT_API_PUBLIC_KEY',
    'PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY',
    'PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_PUBLIC_KEY',
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
    for (const key of RESERVED) {
        if (Object.prototype.hasOwnProperty.call(env, key)) {
            (dropped ||= []).push(key);
            delete env[key];
        }
    }
    if (dropped) {
        console.error(`[ploinky] ignored reserved agent env name(s) ${dropped.join(', ')} from runtime config — these are router-managed (DS011/DS013).`);
    }
    return env;
}

export default { buildAgentIdentityEnv, stripReservedAgentEnv, RESERVED_AGENT_ENV_NAMES };
