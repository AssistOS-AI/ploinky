import path from 'path';
import { SECRETS_FILE } from '../config.js';
import { readSecretsFile } from './encryptedSecretsFile.js';
import { findEnvFile, loadEnvFile } from './masterKey.js';
import { debugLog } from '../utils.js';

/**
 * Load secrets from the .ploinky/.secrets file.
 * File format is KEY=VALUE, one per line, with # comments.
 * @returns {object} Map of secret names to values
 */
export function loadSecretsFile() {
    try {
        return readSecretsFile();
    } catch (err) {
        debugLog(`Failed to read encrypted secrets file: ${err.message}`);
        throw err;
    }
}

/**
 * Get a secret value from environment or .secrets file.
 * Environment variables take precedence over .secrets file.
 * @param {string} secretName - The secret name
 * @returns {string|undefined} The secret value or undefined
 */
export function getSecret(secretName) {
    // First check environment
    if (process.env[secretName] !== undefined) {
        return process.env[secretName];
    }

    // Then check .secrets file
    const fileSecrets = loadSecretsFile();
    if (fileSecrets[secretName] !== undefined) {
        return fileSecrets[secretName];
    }

    // Finally check .env file
    const envSecrets = loadEnvFile();
    return envSecrets[secretName];
}

/**
 * Get multiple secrets.
 * @param {string[]} secretNames - Array of secret names
 * @returns {object} Map of secret names to values (only includes found secrets)
 */
export function getSecrets(secretNames) {
    const secrets = {};
    const fileSecrets = loadSecretsFile();
    const envSecrets = loadEnvFile();

    for (const name of secretNames) {
        // Environment takes precedence
        if (process.env[name] !== undefined) {
            secrets[name] = process.env[name];
        } else if (fileSecrets[name] !== undefined) {
            secrets[name] = fileSecrets[name];
        } else if (envSecrets[name] !== undefined) {
            secrets[name] = envSecrets[name];
        }
    }

    return secrets;
}

/**
 * Validate that all required secrets exist.
 * @param {string[]} requiredSecrets - Array of required secret names
 * @returns {{ valid: boolean, missing: string[], source: object }}
 */
export function validateSecrets(requiredSecrets) {
    if (!requiredSecrets || requiredSecrets.length === 0) {
        return { valid: true, missing: [], source: {} };
    }

    const missing = [];
    const source = {};
    const fileSecrets = loadSecretsFile();
    const envSecrets = loadEnvFile();

    for (const name of requiredSecrets) {
        if (process.env[name] !== undefined) {
            source[name] = 'environment';
        } else if (fileSecrets[name] !== undefined) {
            source[name] = '.secrets file';
        } else if (envSecrets[name] !== undefined) {
            source[name] = '.env file';
        } else {
            missing.push(name);
        }
    }

    return {
        valid: missing.length === 0,
        missing,
        source
    };
}

/**
 * Build docker -e flags for secrets.
 * @param {object} secrets - Map of secret names to values
 * @returns {string[]} Array of docker -e flag strings
 */
export function buildSecretEnvFlags(secrets) {
    const flags = [];

    for (const [name, value] of Object.entries(secrets)) {
        if (value === undefined || value === null) {
            continue;
        }
        flags.push(`-e ${name}=${shellEscape(String(value))}`);
    }

    return flags;
}

/**
 * Build docker -e flags for required secrets.
 * @param {string[]} secretNames - Array of secret names to include
 * @returns {{ flags: string[], missing: string[] }}
 */
export function buildSecretFlags(secretNames) {
    const secrets = getSecrets(secretNames);
    const flags = buildSecretEnvFlags(secrets);
    const missing = secretNames.filter(name => !(name in secrets));

    return { flags, missing };
}

/**
 * Escape a value for shell/docker command.
 * @param {string} value - The value to escape
 * @returns {string} Escaped value
 */
function shellEscape(value) {
    // If value contains special characters, wrap in single quotes
    if (/[^a-zA-Z0-9_\-\.\/]/.test(value)) {
        // Escape single quotes within the value
        return `'${value.replace(/'/g, "'\\''")}'`;
    }
    return value;
}

/**
 * Get secrets source information (for debugging/display).
 * @param {string[]} secretNames - Secret names to check
 * @returns {object} Map of secret names to their sources
 */
export function getSecretsSource(secretNames) {
    const sources = {};
    const fileSecrets = loadSecretsFile();
    const envSecrets = loadEnvFile();

    for (const name of secretNames) {
        if (process.env[name] !== undefined) {
            sources[name] = 'environment';
        } else if (fileSecrets[name] !== undefined) {
            sources[name] = '.secrets';
        } else if (envSecrets[name] !== undefined) {
            sources[name] = '.env';
        } else {
            sources[name] = 'not found';
        }
    }

    return sources;
}

/**
 * Format missing secrets error message with guidance.
 * @param {string[]} missingSecrets - Array of missing secret names
 * @param {string} profileName - The profile name
 * @returns {string} Formatted error message
 */
export function formatMissingSecretsError(missingSecrets, profileName) {
    const lines = [
        `Missing required secrets for profile '${profileName}':`,
        ''
    ];

    for (const secret of missingSecrets) {
        lines.push(`  - ${secret}`);
    }

    lines.push('');
    lines.push('To provide secrets, either:');
    lines.push('  1. Set environment variables before running ploinky');
    lines.push('  2. Store them with `ploinky var <NAME> <value>`');
    const envFilePath = findEnvFile() || path.join(process.cwd(), '.env');
    lines.push(`  3. Add them to ${envFilePath}`);
    lines.push('');
    lines.push('Example:');
    for (const secret of missingSecrets.slice(0, 2)) {
        lines.push(`  ploinky var ${secret} your_value_here`);
    }

    return lines.join('\n');
}

/**
 * Inject profile secrets into process environment (for host hooks).
 * @param {object} secrets - Map of secret names to values
 */
export function injectSecretsToEnv(secrets) {
    for (const [name, value] of Object.entries(secrets)) {
        if (value !== undefined && value !== null) {
            process.env[name] = String(value);
        }
    }
}

/**
 * Create environment object with secrets (without modifying process.env).
 * @param {object} baseEnv - Base environment object
 * @param {object} secrets - Secrets to add
 * @returns {object} New environment object with secrets
 */
export function createEnvWithSecrets(baseEnv, secrets) {
    return {
        ...baseEnv,
        ...secrets
    };
}

export {
    findEnvFile,
    loadEnvFile,
};
