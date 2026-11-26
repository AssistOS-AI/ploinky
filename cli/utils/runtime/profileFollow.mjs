// Single-select profiles (PD5, PD8). The workspace profile is one of four
// environment names. A record or an enable pin that names an environment
// follows the workspace profile; a role pin (`embedded`, `explorer`, ...) names
// a purpose rather than an environment and stays explicit.

import { checkManifestProfiles, ENVIRONMENT_PROFILES } from './profileRules.mjs';
export { ENVIRONMENT_PROFILES } from './profileRules.mjs';

function normalizeName(value) {
    return String(value ?? '').trim().toLowerCase();
}

export function isEnvironmentProfile(name) {
    return ENVIRONMENT_PROFILES.includes(normalizeName(name));
}

function declaredProfiles(manifest) {
    const profiles = manifest?.profiles;
    return profiles && typeof profiles === 'object' && !Array.isArray(profiles) ? profiles : {};
}

// A profile counts as declared only when it is an object: `prod: null` or
// `profiles: []` declares nothing.
function declaresProfile(profiles, name) {
    const value = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function profileNotFound(agentRef, profileName, profiles) {
    const error = new Error(
        `[profile] ${agentRef}: profile '${profileName}' not found. Available: ${Object.keys(profiles).sort().join(', ') || '(none)'}`,
    );
    error.code = 'PLOINKY_PROFILE_NOT_FOUND';
    return error;
}

// The profile a record (or an enable pin) launches with, given the workspace
// profile. `prod` is the captured PROD value: under PROD every agent must
// declare `prod`, and an agent without it refuses instead of falling back.
//
//  - A role name is returned unchanged.
//  - An environment name follows the workspace profile when the manifest
//    declares it, otherwise `default`.
//  - An empty record profile (a legacy record) stays empty unless PROD is on,
//    so a default workspace does not rotate legacy runtimes.
export function followWorkspaceProfile(manifest, recordProfile, workspaceProfile, { prod = false, agentRef = 'agent' } = {}) {
    const record = normalizeName(recordProfile);
    const profiles = declaredProfiles(manifest);
    if (prod) {
        const required = record && !isEnvironmentProfile(record) ? [...ENVIRONMENT_PROFILES, record] : ENVIRONMENT_PROFILES;
        const issues = checkManifestProfiles(manifest, required);
        if (issues.length) {
            const error = profileNotFound(agentRef, record && !isEnvironmentProfile(record) ? record : 'prod', profiles);
            error.message += ` (${issues.join('; ')})`;
            throw error;
        }
    }
    if (record && !isEnvironmentProfile(record)) return record;
    if (!record && !prod) return '';
    const workspace = normalizeName(workspaceProfile) || 'default';
    return declaresProfile(profiles, workspace) ? workspace : 'default';
}
