import { deriveAgentRequestSecret } from './masterKey.js';

/**
 * The per-agent request-signing identity injected into EVERY agent runtime
 * (docker, bwrap, and host lifecycle hooks). An agent receives ONLY its own
 * canonical id and its own derived secret (DS013) — never the master key, never
 * the shared derived-master key, never another agent's secret.
 *
 * Centralized here so all three runtime managers inject one identical, audited
 * key set instead of duplicating the construction.
 */
export function buildAgentIdentityEnv(principalId) {
    const id = String(principalId || '').trim();
    if (!id) {
        throw new Error('agentIdentityEnv: principalId is required');
    }
    return {
        PLOINKY_AGENT_ID: id,
        PLOINKY_AGENT_PRINCIPAL: id,
        PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(id),
    };
}

// Env names that are router-managed and must NEVER be settable by agent-supplied
// configuration (manifest env, profile env, profile secrets, runtime resources):
// the workspace master keys (must never enter an agent at all) and the per-agent
// identity (must come only from `buildAgentIdentityEnv`, never an override).
export const RESERVED_AGENT_ENV_NAMES = Object.freeze([
    'PLOINKY_MASTER_KEY',
    'PLOINKY_DERIVED_MASTER_KEY',
    'PLOINKY_AGENT_ID',
    'PLOINKY_AGENT_PRINCIPAL',
    'PLOINKY_AGENT_SECRET',
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
