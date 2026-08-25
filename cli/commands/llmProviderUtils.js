import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { debugLog } from '../utils/utils.js';
import { resolveAgentLibPath } from '../../agentlib/runtime.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedValidApiKeys = null;
const DEFAULT_ENV_FILENAME = '.env';

/**
 * LLMConfig.json comes from the one selected achillesAgentLib source.
 *
 * The retired candidate search walked several install trees and could silently
 * read a different copy than the runtime loaded; the explicit resolver cannot.
 */
function resolveLlmConfigPath() {
    return resolveAgentLibPath('LLMConfig.json');
}

function findEnvFileUpwards(startDir = process.cwd(), filename = DEFAULT_ENV_FILENAME) {
    let current = startDir ? path.resolve(startDir) : process.cwd();
    const { root } = path.parse(current);

    while (true) { // eslint-disable-line no-constant-condition
        const candidate = path.join(current, filename);
        try {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        } catch (error) {
            debugLog('findEnvFileUpwards: check failed', error?.message || error);
        }
        if (current === root) break;
        current = path.dirname(current);
    }
    return null;
}

function resolveEnvFilePath(envPathOrDir) {
    if (envPathOrDir) {
        const resolved = path.resolve(envPathOrDir);
        try {
            if (fs.existsSync(resolved)) {
                const stats = fs.statSync(resolved);
                if (stats.isDirectory()) {
                    const candidate = path.join(resolved, DEFAULT_ENV_FILENAME);
                    if (fs.existsSync(candidate)) {
                        return candidate;
                    }
                } else {
                    return resolved;
                }
            }
        } catch (error) {
            debugLog('resolveEnvFilePath: failed', error?.message || error);
        }
        // If a path was provided but not found, walk up from its directory
        return findEnvFileUpwards(path.dirname(resolved), DEFAULT_ENV_FILENAME);
    }
    return findEnvFileUpwards(process.cwd(), DEFAULT_ENV_FILENAME);
}

function loadValidLlmApiKeys() {
    if (cachedValidApiKeys) {
        return cachedValidApiKeys;
    }
    try {
        const configPath = resolveLlmConfigPath();
        if (!configPath || !fs.existsSync(configPath)) {
            cachedValidApiKeys = [];
            return cachedValidApiKeys;
        }
        const contents = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(contents);
        const providers = parsed?.providers || {};
        const keys = Object.values(providers)
            .map(entry => entry?.apiKeyEnv)
            .filter(Boolean);
        cachedValidApiKeys = Array.from(new Set(keys));
    } catch (error) {
        cachedValidApiKeys = [];
        debugLog('loadValidLlmApiKeys: unable to load config', error?.message || error);
    }
    return cachedValidApiKeys;
}

function parseEnvFile(envPath) {
    try {
        const contents = fs.readFileSync(envPath, 'utf8');
        const result = {};
        for (const rawLine of contents.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const equalIndex = line.indexOf('=');
            if (equalIndex === -1) continue;
            const key = line.slice(0, equalIndex).trim();
            if (!key) continue;
            let value = line.slice(equalIndex + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            result[key] = value;
        }
        return result;
    } catch (error) {
        debugLog('parseEnvFile: failed to read env file', error?.message || error);
        return {};
    }
}

function collectAvailableLlmKeys(envPath) {
    const validKeys = loadValidLlmApiKeys();
    if (!validKeys.length) return [];
    const resolvedEnvPath = resolveEnvFilePath(envPath);
    const envFileExists = Boolean(resolvedEnvPath && fs.existsSync(resolvedEnvPath));
    const envVars = envFileExists ? parseEnvFile(resolvedEnvPath) : {};

    return validKeys.filter((keyName) => {
        const fileValue = envFileExists ? envVars[keyName] : undefined;
        if (typeof fileValue === 'string' && fileValue.trim().length > 0) {
            return true;
        }
        const envValue = process.env[keyName];
        return typeof envValue === 'string' && envValue.trim().length > 0;
    });
}

function populateProcessEnvFromEnvFile(envPath) {
    const resolvedEnvPath = resolveEnvFilePath(envPath);
    if (!resolvedEnvPath || !fs.existsSync(resolvedEnvPath)) {
        console.log('[LLM] No valid key definitions or .env file missing, skipping env population.');
        return;
    }
    const envVars = parseEnvFile(resolvedEnvPath);
    //console.log(`Found env vars: ${Object.keys(envVars).join(', ')}`)
    Object.entries(envVars).forEach(([keyName, fileValue]) => {
        if (typeof fileValue === 'string' && fileValue.trim().length > 0) {
            if (!process.env[keyName] || !process.env[keyName].trim().length) {
                //console.log(`Set var: ${keyName}=${fileValue}`)
                process.env[keyName] = fileValue;
            }
        }
    });
}

export {
    loadValidLlmApiKeys,
    collectAvailableLlmKeys,
    populateProcessEnvFromEnvFile,
    findEnvFileUpwards,
    resolveEnvFilePath
};
