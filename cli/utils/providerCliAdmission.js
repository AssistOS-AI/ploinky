import fs from 'node:fs';
import path from 'node:path';

import { normalizeProviderSandboxConfig } from '../../Agent/lib/providerSandboxConfig.mjs';

export const PROVIDER_INTERACTIVE_ADAPTER = 'node /code/scripts/interactive-cli.mjs';

function admissionError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.status = 409;
    return error;
}

function readProviderConfig(manifestPath) {
    if (typeof manifestPath !== 'string' || !manifestPath) return {};
    const configPath = path.join(path.dirname(manifestPath), 'mcp-config.json');
    if (!fs.existsSync(configPath)) return {};
    try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        throw admissionError(
            'PLOINKY_PROVIDER_CONFIG_INVALID',
            `provider capability config is invalid for '${manifestPath}'`,
        );
    }
}

function readProviderManifest(manifestPath) {
    if (typeof manifestPath !== 'string' || !manifestPath || !fs.existsSync(manifestPath)) return {};
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        throw admissionError(
            'PLOINKY_PROVIDER_CONFIG_INVALID',
            `provider manifest capability evidence is invalid for '${manifestPath}'`,
        );
    }
}

export function admitProviderManifestCli(cliCommand, {
    manifestPath = '',
    providerConfig,
    providerManifest,
} = {}) {
    const config = providerConfig === undefined
        ? readProviderConfig(manifestPath)
        : providerConfig;
    const manifest = providerManifest === undefined
        ? readProviderManifest(manifestPath)
        : providerManifest;
    let capability;
    try {
        capability = normalizeProviderSandboxConfig(config);
        if (manifest?.endpoints !== undefined) {
            const manifestCapability = normalizeProviderSandboxConfig({
                ...(capability ? { providerSandbox: capability } : {}),
                endpoints: manifest.endpoints,
            });
            if (manifestCapability) capability = manifestCapability;
        }
    } catch (error) {
        if (error && !Number.isInteger(error.status)) error.status = 409;
        throw error;
    }
    if (capability && String(cliCommand || '').trim() !== PROVIDER_INTERACTIVE_ADAPTER) {
        throw admissionError(
            'PLOINKY_PROVIDER_CLI_INVALID',
            `provider-capable agent must use the canonical interactive adapter at '${manifestPath}'`,
        );
    }
    return Object.freeze({ capability, cli: String(cliCommand || '').trim() });
}
