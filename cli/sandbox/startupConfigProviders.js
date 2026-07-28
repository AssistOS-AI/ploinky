import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import { parseEnableDirective } from '../utils/runtime/bootstrapManifest.js';
import { stripReservedAgentEnv } from '../utils/security/agentIdentityEnv.js';
import { PLOINKY_WORKSPACE_ROOT } from '../utils/config.js';
import { readSecretsFile, setSecretValue } from '../utils/security/encryptedSecretsFile.js';
import { edgeRuntimeEnvironment } from './edgeGeneration.js';
import { getProfileConfig } from '../utils/runtime/profileService.js';
import { buildEnvMap, getManifestEnvSpecs } from '../utils/security/secretVars.js';
import { findAgent } from '../utils/utils.js';
import { parseManifestDependencyRef } from '../utils/workspaceDependencyGraph.js';

const PROVIDER_SCHEMA_VERSION = 1;
const METADATA_DIR = 'config-providers';
const REDACTED = '[redacted]';
const RESERVED_OUTPUT_NAMES = new Set([
    'PLOINKY_MASTER_KEY',
    'PLOINKY_DERIVED_MASTER_KEY',
    'PLOINKY_AGENT_SECRET',
    'PLOINKY_AGENT_API_KEY',
    'PLOINKY_AGENT_API_PUBLIC_KEY',
]);

function normalizeEnvName(name) {
    return String(name || '').trim();
}

function assertValidEnvName(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Config provider output '${name}' is not a valid environment variable name.`);
    }
}

function isReservedOutputName(name) {
    const normalized = normalizeEnvName(name);
    return RESERVED_OUTPUT_NAMES.has(normalized) || normalized.startsWith('PLOINKY_');
}

function toBool(value, defaultValue = false) {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (!normalized) return defaultValue;
        return normalized === 'true' || normalized === '1' || normalized === 'yes';
    }
    return defaultValue;
}

function normalizeProviderOutputSpec(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('Config provider output declarations must be objects.');
    }
    const name = normalizeEnvName(entry.name);
    if (!name) {
        throw new Error('Config provider output declaration is missing name.');
    }
    assertValidEnvName(name);
    return {
        name,
        sensitive: toBool(entry.sensitive, false),
        required: toBool(entry.required, false),
    };
}

function normalizeProvidesConfig(manifest = {}) {
    const spec = manifest?.providesConfig;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        return null;
    }
    const command = String(spec.command || '').trim();
    if (!command) {
        throw new Error('providesConfig.command is required.');
    }
    const outputs = Array.isArray(spec.outputs)
        ? spec.outputs.map(normalizeProviderOutputSpec)
        : [];
    const byName = new Map();
    for (const output of outputs) {
        if (byName.has(output.name)) {
            throw new Error(`Duplicate config provider output '${output.name}'.`);
        }
        byName.set(output.name, output);
    }
    return {
        command,
        outputs,
        byName,
    };
}

function normalizeProviderEntry(entry) {
    if (typeof entry === 'string') {
        const agent = entry.trim();
        return agent ? { agent } : null;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
    }
    const agent = String(entry.agent ?? entry.ref ?? entry.spec ?? entry.name ?? '').trim();
    if (!agent) return null;
    return {
        ...entry,
        agent,
        profile: typeof entry.profile === 'string' && entry.profile.trim()
            ? entry.profile.trim().toLowerCase()
            : entry.profile,
    };
}

export function collectStartupConfigProviderEntries(manifest = {}, profileConfig = null) {
    const entries = [];
    const addEntries = (value) => {
        if (!Array.isArray(value)) return;
        for (const rawEntry of value) {
            const entry = normalizeProviderEntry(rawEntry);
            if (entry) entries.push(entry);
        }
    };
    addEntries(manifest?.configProviders);
    addEntries(profileConfig?.configProviders);
    return entries;
}

function sanitizeMetadataFilePart(value) {
    const normalized = String(value || 'provider').replace(/[^A-Za-z0-9_.-]/g, '-');
    return normalized || 'provider';
}

function providerAgentRef(provider) {
    return `${provider.repoName}/${provider.shortAgentName}`;
}

function providerAgentId(provider) {
    return `agent:${providerAgentRef(provider)}`;
}

export function buildProviderSubprocessEnv({
    provider,
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    profileName = 'default',
} = {}) {
    const manifestEnv = buildEnvMap(provider.manifest || {}, provider.profileConfig || null, {
        agentName: provider.shortAgentName,
        repoName: provider.repoName,
    });
    const env = {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        PLOINKY_WORKSPACE_ROOT: workspaceRoot,
        PLOINKY_PROFILE: profileName,
        PLOINKY_PROVIDER_AGENT: providerAgentRef(provider),
        PLOINKY_PROVIDER_AGENT_ID: providerAgentId(provider),
        PLOINKY_PROVIDER_REPO: provider.repoName,
        PLOINKY_PROVIDER_NAME: provider.shortAgentName,
        PLOINKY_PROVIDER_DATA_DIR: path.join(workspaceRoot, '.ploinky', 'data', provider.shortAgentName),
        ...manifestEnv,
    };
    const edgeEnv = edgeRuntimeEnvironment('host', { workspaceRoot });
    return {
        ...stripReservedAgentEnv(env),
        PLOINKY_EDGE_TOPOLOGY_FILE: edgeEnv.PLOINKY_EDGE_TOPOLOGY_FILE,
        PLOINKY_ROUTER_URL: edgeEnv.PLOINKY_ROUTER_URL,
        PLOINKY_INTERNAL_ROUTER_URL: edgeEnv.PLOINKY_INTERNAL_ROUTER_URL,
    };
}

export function redactProviderValue(_name, _value, _sensitive = false) {
    return REDACTED;
}

function redactText(value) {
    if (value === undefined || value === null) return '';
    return String(value)
        .replace(/(token|secret|password|api[_-]?key|jwt)\S*/gi, '$1=[redacted]')
        .slice(0, 2000);
}

function parseProviderCommandOutput(stdout) {
    if (stdout && typeof stdout === 'object' && !Buffer.isBuffer(stdout)) {
        return stdout;
    }
    const text = String(stdout || '').trim();
    if (!text) {
        throw new Error('Config provider command produced no JSON output.');
    }
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error(`Config provider command produced invalid JSON: ${err?.message || err}`);
    }
}

function runProviderCommand({ command, cwd, env }) {
    const child = spawnSync(command, {
        cwd,
        env,
        shell: true,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 300000,
    });
    if (child.error) {
        throw new Error(`Config provider command failed to start: ${child.error.message}`);
    }
    if (child.status !== 0) {
        throw new Error(`Config provider command failed with exit ${child.status}: ${redactText(child.stderr || child.stdout || '')}`);
    }
    return parseProviderCommandOutput(child.stdout);
}

function normalizeProviderOutputPayload(payload) {
    const parsed = parseProviderCommandOutput(payload);
    if (Number(parsed?.version) !== PROVIDER_SCHEMA_VERSION) {
        throw new Error(`Config provider output version must be ${PROVIDER_SCHEMA_VERSION}.`);
    }
    const values = Array.isArray(parsed.values) ? parsed.values : [];
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(redactText).filter(Boolean) : [];
    return { values, warnings };
}

function validateProviderValue({ valueEntry, providesConfig, protectedOutputNames }) {
    if (!valueEntry || typeof valueEntry !== 'object' || Array.isArray(valueEntry)) {
        throw new Error('Config provider values must be objects.');
    }
    const name = normalizeEnvName(valueEntry.name);
    if (!name) {
        throw new Error('Config provider value is missing name.');
    }
    assertValidEnvName(name);
    const declared = providesConfig.byName.get(name);
    if (!declared) {
        throw new Error(`Config provider output '${name}' is not declared by the provider manifest.`);
    }
    if (isReservedOutputName(name)) {
        throw new Error(`Config provider output '${name}' is reserved and cannot be written.`);
    }
    if (protectedOutputNames?.has?.(name)) {
        throw new Error(`Config provider output '${name}' targets a generated or shared generated secret name.`);
    }
    const sensitive = toBool(valueEntry.sensitive, false);
    if (sensitive !== declared.sensitive) {
        throw new Error(`Config provider output '${name}' sensitive flag does not match the provider manifest.`);
    }
    return {
        name,
        value: String(valueEntry.value ?? ''),
        sensitive,
        source: String(valueEntry.source || 'generated'),
    };
}

function metadataPathForProvider(provider, workspaceRoot) {
    return path.join(
        workspaceRoot,
        '.ploinky',
        METADATA_DIR,
        `${sanitizeMetadataFilePart(provider.shortAgentName)}.json`
    );
}

function writeProviderMetadata({ provider, workspaceRoot, profileName, outputs, warnings, applied }) {
    const filePath = metadataPathForProvider(provider, workspaceRoot);
    if (!applied.length && fs.existsSync(filePath)) {
        return filePath;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const metadata = {
        schema: 'ploinky-startup-config-provider',
        version: 1,
        providerAgent: providerAgentRef(provider),
        providerAgentId: providerAgentId(provider),
        providerManifestVersion: provider.manifest?.version || null,
        profileName,
        lastAppliedAt: new Date().toISOString(),
        outputNames: outputs.map((entry) => entry.name),
        outputs: outputs.map((entry) => ({
            name: entry.name,
            sensitive: entry.sensitive,
            source: entry.source,
            value: redactProviderValue(entry.name, entry.value, entry.sensitive),
        })),
        warnings,
    };
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(metadata, null, 2));
    fs.renameSync(tempPath, filePath);
    return filePath;
}

export async function applyStartupConfigProviders({
    providers = [],
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    profileName = 'default',
    protectedOutputNames = new Set(),
    runProviderCommand: runCommand = runProviderCommand,
} = {}) {
    const applied = [];
    const warnings = [];
    const providerResults = [];
    let currentSecrets = readSecretsFile();

    for (const provider of providers) {
        const providesConfig = normalizeProvidesConfig(provider.manifest || {});
        if (!providesConfig) continue;
        const env = buildProviderSubprocessEnv({ provider, workspaceRoot, profileName });
        const rawOutput = await runCommand({
            provider,
            command: providesConfig.command,
            cwd: provider.agentPath,
            env,
        });
        const payload = normalizeProviderOutputPayload(rawOutput);
        const outputs = payload.values.map((valueEntry) => validateProviderValue({
            valueEntry,
            providesConfig,
            protectedOutputNames,
        }));
        warnings.push(...payload.warnings);

        const providerApplied = [];
        for (const output of outputs) {
            if (currentSecrets[output.name] === output.value) {
                continue;
            }
            setSecretValue(output.name, output.value);
            currentSecrets = { ...currentSecrets, [output.name]: output.value };
            applied.push({ provider: providerAgentRef(provider), name: output.name });
            providerApplied.push(output.name);
        }

        const metadataPath = writeProviderMetadata({
            provider,
            workspaceRoot,
            profileName,
            outputs,
            warnings: payload.warnings,
            applied: providerApplied,
        });
        providerResults.push({
            provider: providerAgentRef(provider),
            metadataPath,
            outputs: outputs.map((entry) => entry.name),
            applied: providerApplied,
            warnings: payload.warnings,
        });
    }

    return { applied, warnings, providers: providerResults };
}

function findGraphNodeForProviderEntry(graph, entry) {
    const parsed = parseEnableDirective(entry.agent);
    const dependencyRef = parseManifestDependencyRef(parsed?.spec || entry.agent);
    if (!dependencyRef) {
        throw new Error(`Config provider entry '${entry.agent}' does not name an agent.`);
    }
    const resolved = findAgent(dependencyRef);
    for (const node of graph?.nodes?.values?.() || []) {
        if (node.repoName !== resolved.repo || node.shortAgentName !== resolved.shortAgentName) {
            continue;
        }
        if (parsed?.alias && node.alias !== parsed.alias) {
            continue;
        }
        return { node, parsed, resolved };
    }
    return {
        node: null,
        parsed,
        resolved,
    };
}

function collectGeneratedEnvNamesFromGraph(graph, profileName) {
    const names = new Set();
    for (const node of graph?.nodes?.values?.() || []) {
        let profileConfig = null;
        try {
            profileConfig = getProfileConfig(`${node.repoName}/${node.shortAgentName}`, node.profile || profileName);
        } catch (_) {
            profileConfig = null;
        }
        for (const spec of getManifestEnvSpecs(node.manifest || {}, profileConfig)) {
            if (spec.generated?.type !== 'generated-secret') continue;
            if (spec.insideName) names.add(spec.insideName);
            if (spec.sourceName) names.add(spec.sourceName);
        }
    }
    return names;
}

export async function applyStartupConfigProvidersForGraph({
    dependencyGraph,
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    profileName = 'default',
    runProviderCommand: runCommand,
} = {}) {
    const staticNode = dependencyGraph?.nodes?.get?.(dependencyGraph.staticNodeId);
    if (!staticNode) {
        return { applied: [], warnings: [], providers: [] };
    }
    let staticProfileConfig = null;
    try {
        staticProfileConfig = getProfileConfig(`${staticNode.repoName}/${staticNode.shortAgentName}`, profileName);
    } catch (_) {
        staticProfileConfig = null;
    }
    const entries = collectStartupConfigProviderEntries(staticNode.manifest || {}, staticProfileConfig);
    if (!entries.length) {
        return { applied: [], warnings: [], providers: [] };
    }

    const providers = entries.map((entry) => {
        const { node, parsed, resolved } = findGraphNodeForProviderEntry(dependencyGraph, entry);
        const providerProfile = String(entry.profile || parsed?.profile || node?.profile || 'default').trim().toLowerCase() || 'default';
        let providerProfileConfig = null;
        try {
            providerProfileConfig = getProfileConfig(`${resolved.repo}/${resolved.shortAgentName}`, providerProfile);
        } catch (_) {
            providerProfileConfig = null;
        }
        const manifest = node?.manifest || JSON.parse(fs.readFileSync(resolved.manifestPath, 'utf8'));
        return {
            repoName: resolved.repo,
            shortAgentName: resolved.shortAgentName,
            agentPath: path.dirname(resolved.manifestPath),
            profileName: providerProfile,
            manifest,
            profileConfig: providerProfileConfig,
        };
    });

    return applyStartupConfigProviders({
        providers,
        workspaceRoot,
        profileName,
        protectedOutputNames: collectGeneratedEnvNamesFromGraph(dependencyGraph, profileName),
        ...(runCommand ? { runProviderCommand: runCommand } : {}),
    });
}
