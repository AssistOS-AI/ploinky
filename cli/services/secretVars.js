import fs from 'fs';
import { randomBytes } from 'crypto';
import { getConfig } from './workspace.js';
import { findAgent } from './utils.js';
import { loadSecretsFile, loadEnvFile } from './secretInjector.js';
import { deleteSecretValue, readSecretsFile, setSecretValue } from './encryptedSecretsFile.js';
import { deriveAgentSecret, deriveWorkspaceSecret } from './masterKey.js';

export function parseSecrets() {
    return readSecretsFile();
}

export function setEnvVar(name, value) {
    setSecretValue(name, value);
}

export function deleteVar(name) {
    deleteSecretValue(name);
}

export function declareVar(name) {
    return setEnvVar(name, '');
}

function resolveAlias(value, secrets, seen = new Set()) {
    if (typeof value !== 'string') return value;
    if (!value.startsWith('$')) return value;
    const ref = value.slice(1);
    if (!ref || seen.has(ref)) return '';
    seen.add(ref);
    const next = secrets[ref];
    if (next === undefined) return '';
    return resolveAlias(next, secrets, seen);
}

export function resolveVarValue(name) {
    const secrets = parseSecrets();
    const raw = secrets[name];
    if (raw === undefined) return '';
    return resolveAlias(raw, secrets);
}

export function ensurePersistentSecret(name, { allowEnvFile = true, byteLength = 32 } = {}) {
    if (!name) {
        throw new Error('Missing secret name.');
    }

    const processValue = String(process.env[name] || '').trim();
    if (processValue) {
        return processValue;
    }

    if (allowEnvFile) {
        const envFileValue = String(loadEnvFile()[name] || '').trim();
        if (envFileValue) {
            return envFileValue;
        }
    }

    const existingValue = String(resolveVarValue(name) || '').trim();
    if (existingValue) {
        return existingValue;
    }

    const generatedValue = randomBytes(byteLength).toString('hex');
    setEnvVar(name, generatedValue);
    return generatedValue;
}

function toBool(value, defaultValue = false) {
    if (value === undefined) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (!normalized) return defaultValue;
        return normalized === 'true' || normalized === '1' || normalized === 'yes';
    }
    return defaultValue;
}

const LEGACY_DERIVED_ENV_KEYS = [
    'derive',
    'deriveName',
    'deriveRepoName',
    'deriveRepo',
    'deriveAgentName',
    'deriveAgent',
    'deriveBytes',
    'deriveFormat',
];

function assertNoLegacyDerivedEnvFields(rawSpec, insideName) {
    if (!rawSpec || typeof rawSpec !== 'object') return;
    const legacyKeys = LEGACY_DERIVED_ENV_KEYS.filter(key =>
        Object.prototype.hasOwnProperty.call(rawSpec, key)
        && rawSpec[key] !== undefined
    );
    if (!legacyKeys.length) return;
    const target = insideName ? ` '${insideName}'` : '';
    const error = new Error(
        `Manifest env${target} uses removed legacy derivation keys (${legacyKeys.join(', ')}). `
        + 'Use generatedSecret: true for agent-owned secrets, or sharedGeneratedSecret: true for shared generated secrets.'
    );
    error.code = 'PLOINKY_LEGACY_DERIVED_MASTER_ENV';
    error.legacyKeys = legacyKeys;
    throw error;
}

function assertNoRemovedGeneratedScope(rawSpec, insideName) {
    if (!rawSpec || typeof rawSpec !== 'object') return;
    if (!Object.prototype.hasOwnProperty.call(rawSpec, 'generatedSecretScope')
        || rawSpec.generatedSecretScope === undefined) {
        return;
    }
    const target = insideName ? ` '${insideName}'` : '';
    const error = new Error(
        `Manifest env${target} uses removed generatedSecretScope. `
        + 'Use sharedGeneratedSecret: true for shared generated secrets.'
    );
    error.code = 'PLOINKY_REMOVED_GENERATED_SECRET_SCOPE';
    throw error;
}

function buildGeneratedEnvSpec({
    insideName,
    sourceName,
    generatedSecret,
    sharedGeneratedSecret,
    explicitOverride,
    explicitOverrideRequires,
} = {}) {
    if (toBool(sharedGeneratedSecret, false)) {
        return {
            type: 'generated-secret',
            scope: 'workspace',
            name: sourceName,
            explicitOverride: toBool(explicitOverride, false),
            explicitOverrideRequires: normalizeExplicitOverrideRequires(explicitOverrideRequires),
        };
    }
    if (toBool(generatedSecret, false)) {
        return {
            type: 'generated-secret',
            scope: 'agent',
            name: insideName,
            explicitOverride: toBool(explicitOverride, false),
            explicitOverrideRequires: normalizeExplicitOverrideRequires(explicitOverrideRequires),
        };
    }
    return null;
}

function normalizeExplicitOverrideRequires(value) {
    if (value === undefined || value === null) return [];
    const values = Array.isArray(value) ? value : [value];
    return values
        .map(entry => String(entry || '').trim())
        .filter(Boolean);
}

/**
 * Check if a string is a wildcard pattern (contains * character).
 * @param {string} pattern - The pattern to check
 * @returns {boolean} True if the pattern contains wildcard
 */
function isWildcardPattern(pattern) {
    return typeof pattern === 'string' && pattern.includes('*');
}

/**
 * Convert a wildcard pattern to a regular expression.
 * Supports patterns like:
 *   - "LLM_MODEL_*" - matches LLM_MODEL_ followed by anything
 *   - "LLM_MODEL*" - matches LLM_MODEL followed by anything
 *   - "*" - matches everything
 *   - "PREFIX_*_SUFFIX" - matches PREFIX_ + anything + _SUFFIX
 *
 * @param {string} pattern - The wildcard pattern
 * @returns {RegExp} The compiled regular expression
 */
function wildcardToRegex(pattern) {
    // Escape special regex characters except *
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    // Replace * with .* to match any characters
    const regexStr = '^' + escaped.replace(/\*/g, '.*') + '$';
    return new RegExp(regexStr);
}

/**
 * Check if a variable name contains API_KEY (case-insensitive check).
 * These variables are considered sensitive and excluded from wildcard expansion.
 * @param {string} name - The variable name
 * @returns {boolean} True if the variable is an API key
 */
function isApiKeyVariable(name) {
    if (!name || typeof name !== 'string') return false;
    const upper = name.toUpperCase();
    return upper.includes('API_KEY') || upper.includes('APIKEY');
}

function isSensitiveEnvVariableName(name) {
    if (!name || typeof name !== 'string') return false;
    const upper = name.toUpperCase();
    return (
        /(^|_)(SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL|CREDENTIALS)($|_)/.test(upper)
        || upper.includes('API_KEY')
        || upper.includes('APIKEY')
        || upper.includes('PRIVATE_KEY')
        || upper.includes('MASTER_KEY')
        || upper.includes('ENCRYPTION_KEY')
        || upper.includes('JWT_SECRET')
    );
}

/**
 * Get all available environment variable names from all sources.
 * Sources checked (in order):
 *   1. process.env (current environment)
 *   2. .ploinky/.secrets file
 *   3. .env file in workspace root
 *
 * @returns {Set<string>} Set of all available variable names
 */
function getAllAvailableEnvNames() {
    const names = new Set();

    // Add from process.env
    for (const key of Object.keys(process.env)) {
        names.add(key);
    }

    // Add from .ploinky/.secrets
    try {
        const secretsMap = loadSecretsFile();
        for (const key of Object.keys(secretsMap)) {
            names.add(key);
        }
    } catch (_) {
        // Ignore errors
    }

    // Add from .env file
    try {
        const envMap = loadEnvFile();
        for (const key of Object.keys(envMap)) {
            names.add(key);
        }
    } catch (_) {
        // Ignore errors
    }

    return names;
}

/**
 * Expand a wildcard pattern into matching environment variable names.
 * For the special "*" pattern (match all), API_KEY variables are excluded.
 *
 * @param {string} pattern - The wildcard pattern (e.g., "LLM_MODEL_*", "*")
 * @returns {string[]} Array of matching variable names (sorted)
 */
function expandEnvWildcard(pattern) {
    if (!isWildcardPattern(pattern)) {
        return [pattern];
    }

    const allNames = getAllAvailableEnvNames();
    const regex = wildcardToRegex(pattern);
    const isMatchAll = pattern === '*';
    const matches = [];

    for (const name of allNames) {
        if (!regex.test(name)) {
            continue;
        }

        // For "*" (match all), exclude API_KEY variables
        // They must be explicitly specified in the manifest
        if (isMatchAll && isApiKeyVariable(name)) {
            continue;
        }

        matches.push(name);
    }

    // Sort for deterministic ordering
    return matches.sort();
}

/**
 * Get environment variable specifications from manifest or profile configuration.
 * Profile-based env takes precedence over top-level manifest env.
 *
 * Supports wildcard patterns in variable names:
 *   - "LLM_MODEL_*" - matches all variables starting with LLM_MODEL_
 *   - "LLM_MODEL*" - matches all variables starting with LLM_MODEL
 *   - "*" - matches all variables EXCEPT those containing API_KEY
 *
 * Variables containing "API_KEY" (case-insensitive) must be explicitly listed
 * and will not be included when using the "*" wildcard pattern.
 *
 * @param {object} manifest - The manifest object
 * @param {object} [profileConfig] - The merged profile configuration (optional)
 * @returns {Array} Array of env specs
 */
export function getManifestEnvSpecs(manifest, profileConfig) {
    const specs = [];
    const seenNames = new Set(); // Track seen names to avoid duplicates
    // Profile env takes precedence over top-level manifest env
    const env = profileConfig?.env || manifest?.env;
    if (!env) return specs;

    /**
     * Add a spec, handling wildcard expansion.
     * @param {string} insideName - The name inside the container
     * @param {string} sourceName - The source variable name
     * @param {boolean} required - Whether the variable is required
     * @param {*} defaultValue - Default value if not found
     */
    function addSpec(insideName, sourceName, required, defaultValue, generated = null) {
        // Check if this is a wildcard pattern
        if (isWildcardPattern(insideName)) {
            // Expand the wildcard into matching variable names
            const expandedNames = expandEnvWildcard(insideName);
            for (const expandedName of expandedNames) {
                if (seenNames.has(expandedName)) continue;
                seenNames.add(expandedName);
                specs.push({
                    insideName: expandedName,
                    sourceName: expandedName,
                    required: false, // Wildcards are not required by default
                    defaultValue: undefined,
                    generated: null
                });
            }
        } else {
            // Regular non-wildcard entry
            if (seenNames.has(insideName)) return;
            seenNames.add(insideName);
            specs.push({
                insideName,
                sourceName,
                required,
                defaultValue,
                generated
            });
        }
    }

    if (Array.isArray(env)) {
        for (const entry of env) {
            if (entry === undefined || entry === null) continue;
            if (typeof entry === 'object' && !Array.isArray(entry)) {
                const {
                    name,
                    value,
                    default: defaultValue,
                    varName,
                    required,
                    generatedSecret,
                    sharedGeneratedSecret,
                    explicitOverride,
                    explicitOverrideRequires,
                } = entry;
                const insideName = typeof name === 'string' ? name.trim() : '';
                if (!insideName) continue;
                assertNoLegacyDerivedEnvFields(entry, insideName);
                assertNoRemovedGeneratedScope(entry, insideName);
                const sourceName = typeof varName === 'string' && varName.trim() ? varName.trim() : insideName;
                const resolvedDefault = value !== undefined ? value : defaultValue;
                const generatedSpec = buildGeneratedEnvSpec({
                    insideName,
                    sourceName,
                    generatedSecret,
                    sharedGeneratedSecret,
                    explicitOverride,
                    explicitOverrideRequires,
                });
                addSpec(insideName, sourceName, toBool(required, false), resolvedDefault, generatedSpec);
                continue;
            }
            const text = String(entry).trim();
            if (!text) continue;
            let insideName = text;
            let defaultValue;
            const eqIdx = text.indexOf('=');
            if (eqIdx >= 0) {
                insideName = text.slice(0, eqIdx).trim();
                defaultValue = text.slice(eqIdx + 1);
            }
            if (!insideName) continue;
            addSpec(insideName, insideName, false, defaultValue, null);
        }
        return specs;
    }

    if (env && typeof env === 'object') {
        for (const [insideKey, rawSpec] of Object.entries(env)) {
            if (!insideKey) continue;
            const insideName = String(insideKey).trim();
            if (!insideName) continue;

            let sourceName = insideName;
            let required = false;
            let defaultValue;
            let generatedSpec = null;
            if (rawSpec && typeof rawSpec === 'object' && !Array.isArray(rawSpec)) {
                assertNoLegacyDerivedEnvFields(rawSpec, insideName);
                assertNoRemovedGeneratedScope(rawSpec, insideName);
                if (typeof rawSpec.varName === 'string' && rawSpec.varName.trim()) {
                    sourceName = rawSpec.varName.trim();
                } else if (typeof rawSpec.name === 'string' && rawSpec.name.trim()) {
                    sourceName = rawSpec.name.trim();
                }
                if (Object.prototype.hasOwnProperty.call(rawSpec, 'required')) {
                    required = toBool(rawSpec.required, false);
                }
                if (Object.prototype.hasOwnProperty.call(rawSpec, 'default')) {
                    defaultValue = rawSpec.default;
                } else if (Object.prototype.hasOwnProperty.call(rawSpec, 'value')) {
                    defaultValue = rawSpec.value;
                }
                generatedSpec = buildGeneratedEnvSpec({
                    insideName,
                    sourceName,
                    generatedSecret: rawSpec.generatedSecret,
                    sharedGeneratedSecret: rawSpec.sharedGeneratedSecret,
                    explicitOverride: rawSpec.explicitOverride,
                    explicitOverrideRequires: rawSpec.explicitOverrideRequires,
                });
                addSpec(insideName, sourceName, required, defaultValue, generatedSpec);
                continue;
            } else {
                defaultValue = rawSpec;
            }

            addSpec(insideName, sourceName, required, defaultValue, generatedSpec);
        }
    }

    return specs;
}

function isEmptyValue(value) {
    if (value === undefined || value === null) return true;
    const str = String(value);
    return str.trim().length === 0;
}

function formatEnvSpecName(spec) {
    return (spec.sourceName && spec.sourceName !== spec.insideName)
        ? `${spec.insideName} (source: ${spec.sourceName})`
        : spec.insideName;
}

function resolveExplicitEnvSource(name, secrets, getEnvFile) {
    if (!name) return undefined;
    if (Object.prototype.hasOwnProperty.call(secrets, name)) {
        return resolveAlias(secrets[name], secrets);
    }
    if (Object.prototype.hasOwnProperty.call(process.env, name)) {
        return process.env[name];
    }
    const envFile = getEnvFile();
    if (Object.prototype.hasOwnProperty.call(envFile, name)) {
        return envFile[name];
    }
    return undefined;
}

function shouldUseExplicitGeneratedOverride(spec, explicitValue, secrets, getEnvFile) {
    const requiredNames = spec.generated?.explicitOverrideRequires || [];
    if (isEmptyValue(explicitValue)) {
        return false;
    }
    if (!requiredNames.length) {
        return spec.generated?.explicitOverride === true;
    }
    return requiredNames.every(name => !isEmptyValue(resolveExplicitEnvSource(name, secrets, getEnvFile)));
}

function envSourceMetadataName(name) {
    return `PLOINKY_ENV_SOURCE_${String(name || '').replace(/[^A-Za-z0-9_]/g, '_')}`;
}

export function getIncompleteManifestEnvProfileEntries(manifest, profileConfig) {
    return getManifestEnvSpecs(manifest, profileConfig).filter(spec => {
        if (!spec.required) return false;
        if (spec.generated?.type === 'generated-secret') return false;
        if (!isEmptyValue(spec.defaultValue)) return false;
        return !isSensitiveEnvVariableName(spec.insideName)
            && !isSensitiveEnvVariableName(spec.sourceName);
    });
}

export function validateManifestEnvProfileCompleteness(manifest, profileConfig, options = {}) {
    const missing = getIncompleteManifestEnvProfileEntries(manifest, profileConfig);
    if (!missing.length) {
        return { valid: true, issues: [], missing: [] };
    }

    const profileLabel = options.profileName ? ` profile '${options.profileName}'` : ' profile';
    const agentLabel = options.agentName ? ` for ${options.agentName}` : '';
    const details = missing.map(formatEnvSpecName);
    return {
        valid: false,
        missing,
        issues: [
            `Required non-sensitive env entries${agentLabel}${profileLabel} must define profile defaults: ${details.join(', ')}`
        ]
    };
}

export function assertManifestEnvProfileCompleteness(manifest, profileConfig, options = {}) {
    const result = validateManifestEnvProfileCompleteness(manifest, profileConfig, options);
    if (result.valid) return;
    const error = new Error(result.issues[0]);
    error.code = 'PLOINKY_PROFILE_CONFIG_INCOMPLETE';
    error.missing = result.missing.map(spec => spec.insideName);
    throw error;
}

function resolveManifestEnv(manifest, secrets, options = {}) {
    const { profileConfig, agentName = '', repoName = '' } = options;
    if (options.enforceProfileCompleteness) {
        assertManifestEnvProfileCompleteness(manifest, profileConfig, {
            agentName,
            repoName,
            profileName: options.profileName,
        });
    }
    const specs = getManifestEnvSpecs(manifest, profileConfig);
    const resolved = [];
    const missing = [];

    // Lazy-load .env so we only read the file when .secrets and process.env
    // both miss.  Mirrors the fallback order in secretInjector.getSecret():
    //   1. .ploinky/.secrets  2. process.env  3. $CWD/.env
    let envFileCache;
    const getEnvFile = () => {
        if (envFileCache === undefined) {
            try { envFileCache = loadEnvFile(); } catch (_) { envFileCache = {}; }
        }
        return envFileCache;
    };

    for (const spec of specs) {
        let resolvedValue;
        let usedDefault = false;
        let valueSource;
        const hasSecret = spec.sourceName
            && Object.prototype.hasOwnProperty.call(secrets, spec.sourceName);
        if (spec.generated?.type === 'generated-secret') {
            const explicitValue = resolveExplicitEnvSource(spec.sourceName, secrets, getEnvFile);
            if (shouldUseExplicitGeneratedOverride(spec, explicitValue, secrets, getEnvFile)) {
                resolvedValue = explicitValue;
                valueSource = 'explicit';
            } else if (spec.generated.scope === 'workspace') {
                resolvedValue = deriveWorkspaceSecret({
                    name: spec.generated.name || spec.sourceName || spec.insideName,
                });
                valueSource = 'generated';
            } else {
                resolvedValue = deriveAgentSecret({
                    repoName,
                    agentName,
                    name: spec.generated.name || spec.sourceName || spec.insideName,
                });
                valueSource = 'generated';
            }
        } else if (hasSecret) {
            resolvedValue = resolveAlias(secrets[spec.sourceName], secrets);
        } else if (spec.sourceName && Object.prototype.hasOwnProperty.call(process.env, spec.sourceName)) {
            resolvedValue = process.env[spec.sourceName];
        } else if (spec.sourceName && Object.prototype.hasOwnProperty.call(getEnvFile(), spec.sourceName)) {
            resolvedValue = getEnvFile()[spec.sourceName];
        } else if (Object.prototype.hasOwnProperty.call(spec, 'defaultValue')) {
            resolvedValue = spec.defaultValue;
            usedDefault = true;
        } else {
            resolvedValue = undefined;
        }

        if (!usedDefault && (resolvedValue === undefined || resolvedValue === null) && Object.prototype.hasOwnProperty.call(spec, 'defaultValue')) {
            resolvedValue = spec.defaultValue;
            usedDefault = true;
        }

        const normalizedValue = resolvedValue === undefined || resolvedValue === null
            ? undefined
            : String(resolvedValue);

        if (spec.required && isEmptyValue(normalizedValue)) {
            missing.push(spec);
        }

        resolved.push({
            insideName: spec.insideName,
            sourceName: spec.sourceName,
            required: spec.required,
            value: normalizedValue,
            defaultValue: Object.prototype.hasOwnProperty.call(spec, 'defaultValue') ? spec.defaultValue : undefined,
            usedDefault,
            source: valueSource
        });
    }

    if ((options?.enforceRequired) && missing.length) {
        const details = missing.map(spec =>
            (spec.sourceName && spec.sourceName !== spec.insideName)
                ? `${spec.insideName} (source: ${spec.sourceName})`
                : spec.insideName
        );
        const error = new Error(`Missing required environment variables: ${details.join(', ')}`);
        error.code = 'PLOINKY_ENV_REQUIRED_MISSING';
        error.missing = missing.map(spec => spec.insideName);
        throw error;
    }

    return { resolved, missing };
}

export function getManifestEnvNames(manifest, profileConfig) {
    return getManifestEnvSpecs(manifest, profileConfig).map(spec => spec.insideName);
}

export function collectManifestEnv(manifest, { enforceRequired = false, profileConfig, agentName = '', repoName = '' } = {}) {
    const secrets = parseSecrets();
    return resolveManifestEnv(manifest, secrets, { enforceRequired, profileConfig, agentName, repoName });
}

export function getExposedNames(manifest, profileConfig) {
    const names = new Set(getManifestEnvNames(manifest, profileConfig));
    const exp = manifest?.expose;
    if (Array.isArray(exp)) {
        exp.forEach(e => {
            if (e && e.name) names.add(String(e.name));
        });
    } else if (exp && typeof exp === 'object') {
        Object.keys(exp).forEach(n => names.add(String(n)));
    }
    return Array.from(names);
}

function quoteEnvValue(value) {
    const str = String(value ?? '');
    const escaped = str.replace(/(["\\$`])/g, '\\$1').replace(/\n/g, '\\n');
    return `"${escaped}"`;
}

export function formatEnvFlag(name, value) {
    return `-e ${name}=${quoteEnvValue(value)}`;
}

export function buildEnvFlags(manifest, profileConfig, options = {}) {
    assertManifestEnvProfileCompleteness(manifest, profileConfig, options);
    const secrets = parseSecrets();
    const envEntries = resolveManifestEnv(manifest, secrets, {
        enforceRequired: true,
        enforceProfileCompleteness: false,
        profileConfig,
        agentName: options.agentName,
        repoName: options.repoName,
        profileName: options.profileName,
    }).resolved;
    const out = [];
    for (const entry of envEntries) {
        if (entry.value !== undefined) {
            out.push(formatEnvFlag(entry.insideName, entry.value));
            if (entry.source) {
                out.push(formatEnvFlag(envSourceMetadataName(entry.insideName), entry.source));
            }
        }
    }
    const exp = manifest?.expose;
    if (Array.isArray(exp)) {
        for (const spec of exp) {
            if (!spec || !spec.name) continue;
            if (Object.prototype.hasOwnProperty.call(spec, 'value')) {
                out.push(formatEnvFlag(spec.name, spec.value));
            } else if (spec.ref) {
                const v = resolveAlias('$' + spec.ref, secrets);
                if (v !== undefined) out.push(formatEnvFlag(spec.name, v ?? ''));
            }
        }
    } else if (exp && typeof exp === 'object') {
        for (const [name, val] of Object.entries(exp)) {
            if (typeof val === 'string' && val.startsWith('$')) {
                const v = resolveAlias(val, secrets);
                if (v !== undefined) out.push(formatEnvFlag(name, v ?? ''));
            } else if (val !== undefined) {
                out.push(formatEnvFlag(name, val));
            }
        }
    }
    return out;
}

export function buildEnvMap(manifest, profileConfig, options = {}) {
    const secrets = parseSecrets();
    const out = {};
    const envEntries = resolveManifestEnv(manifest, secrets, {
        enforceRequired: false,
        profileConfig,
        agentName: options.agentName,
        repoName: options.repoName,
    }).resolved;
    for (const entry of envEntries) {
        if (entry.value !== undefined) {
            out[entry.insideName] = entry.value;
            if (entry.source) {
                out[envSourceMetadataName(entry.insideName)] = entry.source;
            }
        }
    }
    const exp = manifest?.expose;
    if (Array.isArray(exp)) {
        for (const spec of exp) {
            if (!spec || !spec.name) continue;
            if (Object.prototype.hasOwnProperty.call(spec, 'value')) {
                out[spec.name] = String(spec.value);
            } else if (spec.ref) {
                out[spec.name] = resolveAlias('$' + spec.ref, secrets) ?? '';
            }
        }
    } else if (exp && typeof exp === 'object') {
        for (const [name, val] of Object.entries(exp)) {
            if (typeof val === 'string' && val.startsWith('$')) {
                out[name] = resolveAlias(val, secrets) ?? '';
            } else {
                out[name] = val !== undefined ? String(val) : '';
            }
        }
    }
    return out;
}

export function resolveManifestImage(manifest, profileConfig, options = {}) {
    const raw = String(manifest?.container || manifest?.image || 'node:18-alpine');
    if (!raw.includes('${')) return raw;

    let envMap = {};
    try {
        envMap = buildEnvMap(manifest, profileConfig, options);
    } catch (error) {
        const message = error?.message || String(error);
        const secretsUnavailable = message.startsWith('PLOINKY_MASTER_KEY is required');
        if (!secretsUnavailable) {
            throw error;
        }
    }

    // Manifest env declarations carry their own defaults and do not require
    // secrets decryption. Read them directly so a non-templated default still
    // resolves the image even when the secrets store is unreachable.
    const manifestDefaults = {};
    try {
        const specs = getManifestEnvSpecs(manifest, profileConfig);
        for (const spec of specs) {
            if (spec.defaultValue !== undefined && spec.defaultValue !== null && spec.defaultValue !== '') {
                manifestDefaults[spec.insideName] = String(spec.defaultValue);
            }
        }
    } catch (_) {
        // Spec extraction itself should not fail, but stay defensive.
    }

    return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
        const fromMap = Object.prototype.hasOwnProperty.call(envMap, name) ? envMap[name] : undefined;
        if (fromMap !== undefined && fromMap !== '') return String(fromMap);
        const fromProcess = process.env[name];
        if (fromProcess !== undefined && fromProcess !== '') return String(fromProcess);
        const fromDefault = manifestDefaults[name];
        if (fromDefault !== undefined && fromDefault !== '') return fromDefault;
        throw new Error(`[manifest] image '${raw}' references ${match}, but no value is set in the agent's manifest env, ploinky vars, process.env, or manifest defaults`);
    });
}

export function updateAgentExpose(manifestPath, exposedName, src) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.expose) manifest.expose = [];
    if (!Array.isArray(manifest.expose)) {
        const obj = manifest.expose;
        manifest.expose = Object.entries(obj).map(([name, val]) =>
            typeof val === 'string' && val.startsWith('$')
                ? { name, ref: val.slice(1) }
                : { name, value: val }
        );
    }
    manifest.expose = manifest.expose.filter(e => e && e.name !== exposedName);
    if (src && typeof src === 'string') {
        if (src.startsWith('$')) manifest.expose.push({ name: exposedName, ref: src.slice(1) });
        else manifest.expose.push({ name: exposedName, value: src });
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

export function echoVar(nameOrAlias) {
    if (!nameOrAlias) return '';
    const isAlias = String(nameOrAlias).startsWith('$');
    const varName = isAlias ? String(nameOrAlias).slice(1) : String(nameOrAlias);
    if (!varName) return '';
    try {
        if (isAlias) {
            return resolveVarValue(varName) ?? '';
        }
        const rawMap = parseSecrets();
        const raw = rawMap[varName];
        return `${varName}=${raw ?? ''}`;
    } catch (_) {
        return '';
    }
}

function resolveAgentName(agentNameOpt) {
    if (agentNameOpt) return agentNameOpt;
    try {
        const cfg = getConfig();
        if (cfg && cfg.static && cfg.static.agent) {
            return cfg.static.agent;
        }
    } catch (_) {}
    return null;
}

export function exposeEnv(exposedName, valueOrRef, agentNameOpt) {
    const agentName = resolveAgentName(agentNameOpt);
    if (!agentName) {
        throw new Error('Missing agent name. Provide [agentName] or configure static with start <agent> <port>.');
    }
    let source = valueOrRef;
    if (source === undefined || source === null) {
        source = `$${exposedName}`;
    }
    const { manifestPath } = findAgent(agentName);
    updateAgentExpose(manifestPath, exposedName, source);
    return { agentName, manifestPath };
}

// Export wildcard-related functions for testing and external use
export {
    isWildcardPattern,
    wildcardToRegex,
    isApiKeyVariable,
    isSensitiveEnvVariableName,
    getAllAvailableEnvNames,
    expandEnvWildcard
};
