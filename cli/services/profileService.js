import fs from 'fs';
import path from 'path';
import { PROFILE_FILE, PLOINKY_CWD, PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT, REPOS_DIR } from './config.js';
import { validateSecrets } from './secretInjector.js';
import { validateManifestEnvProfileCompleteness } from './secretVars.js';
import { debugLog, findAgent } from './utils.js';

// Discover all valid profile names from installed agent manifests.
// Any profile name declared in a manifest's "profiles" section is valid.
// "default" is always valid — it's the base profile every agent must have.
function discoverManifestProfiles() {
    const discovered = new Set(['default']);
    try {
        if (!fs.existsSync(REPOS_DIR)) return discovered;
        for (const repo of fs.readdirSync(REPOS_DIR)) {
            const repoDir = path.join(REPOS_DIR, repo);
            if (!fs.statSync(repoDir).isDirectory()) continue;
            for (const agent of fs.readdirSync(repoDir)) {
                const manifestPath = path.join(repoDir, agent, 'manifest.json');
                try {
                    if (!fs.existsSync(manifestPath)) continue;
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                    if (manifest?.profiles && typeof manifest.profiles === 'object') {
                        for (const profileName of Object.keys(manifest.profiles)) {
                            discovered.add(profileName);
                        }
                    }
                } catch (_) {}
            }
        }
    } catch (_) {}
    return discovered;
}

function isValidProfile(profileName) {
    return discoverManifestProfiles().has(profileName);
}

// Hook names in execution order
// preinstall: HOST hook that runs BEFORE container creation (can set ploinky vars)
// hosthook_aftercreation: HOST hook that runs after container creation
// install: CONTAINER hook for installation
// postinstall: CONTAINER hook after install
// hosthook_postinstall: HOST hook after container postinstall
const HOOK_NAMES = ['preinstall', 'hosthook_aftercreation', 'install', 'postinstall', 'hosthook_postinstall'];

/**
 * Merge env configurations, handling both array and object formats.
 * Array format: ["VAR1", "VAR2=value"] - variable names to pull from .secrets
 * Object format: { "VAR1": "value" } - explicit key-value pairs
 *
 * For arrays: concatenate and deduplicate (active entries override default for same var name)
 * For objects: shallow merge (active overrides default)
 * For mixed: convert to array format and merge
 *
 * @param {Array|object} defaultEnv - Default profile env
 * @param {Array|object} activeEnv - Active profile env
 * @returns {Array|object} Merged env
 */
function mergeEnv(defaultEnv, activeEnv) {
    const defaultIsArray = Array.isArray(defaultEnv);
    const activeIsArray = Array.isArray(activeEnv);

    // Both arrays - merge and deduplicate
    if (defaultIsArray && activeIsArray) {
        const result = [];
        const seenVars = new Set();

        // Helper to extract variable name from array entry
        const getVarName = (entry) => {
            if (typeof entry === 'string') {
                const eqIdx = entry.indexOf('=');
                return eqIdx >= 0 ? entry.slice(0, eqIdx) : entry;
            }
            if (entry && typeof entry === 'object') {
                return entry.name || '';
            }
            return '';
        };

        // Add active entries first (they take precedence)
        for (const entry of activeEnv) {
            const varName = getVarName(entry);
            if (varName) {
                seenVars.add(varName);
                result.push(entry);
            }
        }

        // Add default entries that aren't overridden
        for (const entry of defaultEnv) {
            const varName = getVarName(entry);
            if (varName && !seenVars.has(varName)) {
                result.push(entry);
            }
        }

        return result;
    }

    // Both objects - shallow merge
    if (!defaultIsArray && !activeIsArray) {
        return { ...(defaultEnv || {}), ...(activeEnv || {}) };
    }

    // Mixed formats - convert object specs to array specs without flattening
    // structured entries into "[object Object]" strings.
    const toArray = (env) => {
        if (Array.isArray(env)) return env;
        if (!env || typeof env !== 'object') return [];
        return Object.entries(env).map(([key, val]) => {
            if (val && typeof val === 'object' && !Array.isArray(val)) {
                const { name: sourceName, varName, ...rest } = val;
                return {
                    name: key,
                    ...rest,
                    ...(varName !== undefined
                        ? { varName }
                        : (sourceName !== undefined ? { varName: sourceName } : {})),
                };
            }
            return val === '' || val === undefined ? key : `${key}=${val}`;
        });
    };

    return mergeEnv(toArray(defaultEnv), toArray(activeEnv));
}

/**
 * Merge default profile with active profile.
 * - Env variables: smart merge (handles both array and object formats)
 * - Hooks: active overrides default (not concatenate)
 * - Secrets: concatenate (active adds to default)
 * - Mounts: deep merge (active overrides default)
 *
 * @param {object} defaultProfile - The default profile configuration
 * @param {object} activeProfile - The active profile configuration
 * @returns {object} Merged profile configuration
 */
export function mergeProfiles(defaultProfile, activeProfile) {
    if (!defaultProfile) return activeProfile || {};
    if (!activeProfile || activeProfile === defaultProfile) return defaultProfile;

    const merged = { ...defaultProfile };

    // Merge env - handle both array and object formats
    if (activeProfile.env !== undefined) {
        merged.env = mergeEnv(defaultProfile.env, activeProfile.env);
    }

    // Hooks: active overrides default
    for (const hook of HOOK_NAMES) {
        if (activeProfile[hook] !== undefined) {
            merged[hook] = activeProfile[hook];
        }
    }

    // Merge array fields by concatenation (secrets)
    if (activeProfile.secrets || defaultProfile.secrets) {
        merged.secrets = [...(defaultProfile.secrets || []), ...(activeProfile.secrets || [])];
    }

    // Merge object fields (active overrides default) - mounts
    if (activeProfile.mounts) {
        merged.mounts = { ...defaultProfile.mounts, ...activeProfile.mounts };
    }

    // Merge ports - active replaces default (like hooks)
    if (activeProfile.ports !== undefined) {
        merged.ports = activeProfile.ports;
    }

    // Merge network - active replaces default because the namespace is selected as a unit.
    if (activeProfile.network !== undefined) {
        merged.network = activeProfile.network;
    }

    // Merge profile server - active replaces default because it selects one upstream.
    if (activeProfile.server !== undefined) {
        merged.server = activeProfile.server;
    }

    return merged;
}

/**
 * Get the currently active profile.
 * @returns {string} The active profile name (defaults to 'dev')
 */
export function getActiveProfile() {
    try {
        if (fs.existsSync(PROFILE_FILE)) {
            const profile = fs.readFileSync(PROFILE_FILE, 'utf8').trim();
            if (profile && isValidProfile(profile)) {
                return profile;
            }
        }
    } catch (_) {}
    return 'default';
}

/**
 * Set the active profile.
 * @param {string} profileName - The profile name to set
 * @returns {{ success: boolean, message: string }}
 */
export function setActiveProfile(profileName) {
    const normalizedProfile = profileName.toLowerCase().trim();

    if (!isValidProfile(normalizedProfile)) {
        return {
            success: false,
            message: `Invalid profile '${profileName}'. Valid profiles are: ${getValidProfiles().join(', ')}`,
        };
    }

    try {
        // Ensure .ploinky directory exists
        if (!fs.existsSync(PLOINKY_DIR)) {
            fs.mkdirSync(PLOINKY_DIR, { recursive: true });
        }

        fs.writeFileSync(PROFILE_FILE, normalizedProfile);
        return {
            success: true,
            message: `Profile set to '${normalizedProfile}'`
        };
    } catch (err) {
        return {
            success: false,
            message: `Failed to set profile: ${err.message}`
        };
    }
}

/**
 * Get profile configuration from an agent's manifest.
 * Always merges the default profile with the requested profile.
 *
 * @param {string} agentName - The agent name
 * @param {string} profileName - The profile name (defaults to active profile)
 * @returns {object|null} The merged profile configuration or null
 */
export function getProfileConfig(agentName, profileName) {
    try {
        const { manifestPath } = findAgent(agentName);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const profiles = manifest?.profiles;

        // If no profiles section exists, agent uses legacy mode (no profile config)
        if (!profiles || Object.keys(profiles).length === 0) {
            return null;
        }

        // If profiles exist, a 'default' profile is required for proper isolation
        const defaultProfile = profiles.default;
        if (!defaultProfile) {
            throw new Error(`Agent ${agentName} missing required 'default' profile in manifest.json`);
        }

        // Get active profile name
        const activeProfileName = profileName || getActiveProfile();

        // If requesting default or no active profile config exists, return default
        if (activeProfileName === 'default' || !profiles[activeProfileName]) {
            return defaultProfile;
        }

        // Merge default with active profile (active overrides default)
        const activeProfile = profiles[activeProfileName];
        return mergeProfiles(defaultProfile, activeProfile);
    } catch (err) {
        debugLog(`getProfileConfig: ${err.message}`);
        // Re-throw missing profile errors so they bubble up
        if (err.message.includes('missing required')) {
            throw err;
        }
        return null;
    }
}

/**
 * Validate a profile configuration for an agent.
 * Uses merged profile (default + requested profile).
 *
 * @param {string} agentName - The agent name
 * @param {string} profileName - The profile name
 * @returns {{ valid: boolean, issues: string[], config: object|null }}
 */
export function validateProfile(agentName, profileName) {
    const issues = [];
    let config = null;

    try {
        const { manifestPath } = findAgent(agentName);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

        if (!manifest.profiles) {
            issues.push('Manifest has no profiles section');
            return { valid: false, issues, config: null };
        }

        // Mandatory: every agent must have a 'default' profile
        if (!manifest.profiles.default) {
            issues.push(`Agent missing required 'default' profile in manifest.json`);
            return { valid: false, issues, config: null };
        }

        // Get merged profile configuration
        config = getProfileConfig(agentName, profileName);

        if (!config) {
            issues.push(`Could not resolve profile configuration for '${profileName}'`);
            return { valid: false, issues, config: null };
        }

        const envProfileValidation = validateManifestEnvProfileCompleteness(manifest, config, {
            agentName,
            profileName,
        });
        issues.push(...envProfileValidation.issues);

        // Validate required secrets
        if (config.secrets && Array.isArray(config.secrets)) {
            const secretValidation = validateSecrets(config.secrets);
            for (const secretName of secretValidation.missing) {
                issues.push(`Missing required secret: ${secretName}`);
            }
        }

        // Validate hook scripts exist (only host hooks need file validation)
        // preinstall is now a host hook that runs before container creation
        const hostHookFields = ['preinstall', 'hosthook_aftercreation', 'hosthook_postinstall'];
        for (const hookField of hostHookFields) {
            if (config[hookField]) {
                const agentPath = path.dirname(manifestPath);
                const hookPath = path.join(agentPath, config[hookField]);
                if (!fs.existsSync(hookPath)) {
                    issues.push(`Host hook script not found: ${config[hookField]}`);
                }
            }
        }

        // Validate hook format (must be string, not array)
        for (const hookName of HOOK_NAMES) {
            if (config[hookName] !== undefined && typeof config[hookName] !== 'string') {
                issues.push(`Hook '${hookName}' must be a string command, not ${typeof config[hookName]}`);
            }
        }

        // Check mounts configuration
        if (config.mounts) {
            const validMountModes = ['rw', 'ro'];
            if (config.mounts.code && !validMountModes.includes(config.mounts.code)) {
                issues.push(`Invalid mount mode for code: ${config.mounts.code}`);
            }
            if (config.mounts.skills && !validMountModes.includes(config.mounts.skills)) {
                issues.push(`Invalid mount mode for skills: ${config.mounts.skills}`);
            }
        }

        return {
            valid: issues.length === 0,
            issues,
            config
        };
    } catch (err) {
        issues.push(`Validation error: ${err.message}`);
        return { valid: false, issues, config: null };
    }
}

/**
 * List available profiles for an agent.
 * @param {string} agentName - The agent name
 * @returns {{ profiles: string[], defaultProfile: string|null }}
 */
export function listProfiles(agentName) {
    try {
        const { manifestPath } = findAgent(agentName);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

        const profiles = manifest.profiles ? Object.keys(manifest.profiles) : [];
        const defaultProfile = manifest.defaultProfile || (profiles.includes('dev') ? 'dev' : profiles[0] || null);

        return { profiles, defaultProfile };
    } catch (err) {
        debugLog(`listProfiles: ${err.message}`);
        return { profiles: [], defaultProfile: null };
    }
}

/**
 * Get default mount modes based on profile.
 * @param {string} profile - The profile name
 * @returns {{ code: string, skills: string }}
 */
export function getDefaultMountModes(profile) {
    if (profile === 'default' || profile === 'dev') {
        return { code: 'rw', skills: 'rw' };
    }
    return { code: 'ro', skills: 'ro' };
}

/**
 * Get profile environment based on profile name.
 * @param {string} profile - The profile name
 * @returns {string} Environment identifier
 */
export function getProfileEnvironment(profile) {
    if (profile === 'default') return 'development';
    return profile;
}

/**
 * Get all profile-related environment variables.
 * @param {string} agentName - The agent name
 * @param {string} repoName - The repository name
 * @param {string} profile - The profile name
 * @param {object} containerInfo - Container information
 * @returns {object} Environment variables map
 */
export function getProfileEnvVars(agentName, repoName, profile, containerInfo = {}) {
    return {
        PLOINKY_PROFILE: profile,
        PLOINKY_PROFILE_ENV: getProfileEnvironment(profile),
        PLOINKY_AGENT_NAME: agentName,
        PLOINKY_REPO_NAME: repoName,
        PLOINKY_WORKSPACE_ROOT,
        PLOINKY_CWD,
        ...(containerInfo.containerName && { PLOINKY_CONTAINER_NAME: containerInfo.containerName }),
        ...(containerInfo.containerId && { PLOINKY_CONTAINER_ID: containerInfo.containerId })
    };
}

/**
 * Get the list of valid profiles.
 * @returns {string[]} Array of valid profile names
 */
export function getValidProfiles() {
    return [...discoverManifestProfiles()];
}

export { isValidProfile };

/**
 * Get the list of hook names in execution order.
 * @returns {string[]} Array of hook names
 */
export function getHookNames() {
    return [...HOOK_NAMES];
}
