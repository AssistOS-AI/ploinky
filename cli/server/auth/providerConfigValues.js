import fs from 'node:fs';
import { findAgent } from '../../utils/utils.js';
import { loadAgents } from '../../utils/workspace.js';
import { resolveManifestRuntimeProfile } from '../../utils/runtime/profileService.js';
import { buildEnvMap, getManifestEnvSpecs } from '../../utils/security/secretVars.js';

// Provider modules run in the Router, while their services receive manifest
// environment values. Resolve shared generated values through the same
// profile/override contract so neither process needs to persist a second copy.
export function createProviderConfigReader(providerAgentRef, readExplicitValue) {
    const resolved = findAgent(providerAgentRef);
    const manifest = JSON.parse(fs.readFileSync(resolved.manifestPath, 'utf8'));
    const record = Object.values(loadAgents()).find((entry) => entry?.type === 'agent'
        && entry.repoName === resolved.repo && entry.agentName === resolved.shortAgentName && !entry.alias);
    const { profileConfig } = resolveManifestRuntimeProfile(manifest, {
        agentName: `${resolved.repo}/${resolved.shortAgentName}`,
        persistedProfileName: record?.profile,
    });
    const envSpecs = getManifestEnvSpecs(manifest, profileConfig);
    const runtimeExcludedNames = new Set(envSpecs.filter((spec) => spec.runtime === false)
        .map((spec) => spec.insideName));
    const sharedSpecs = envSpecs
        .filter((spec) => spec.generated?.scope === 'workspace' && spec.runtime !== false);
    const byName = new Map(sharedSpecs.map((spec) => [spec.insideName, spec]));
    let sharedValues;
    return (names, fallback) => {
        const candidates = Array.isArray(names) ? names : [names].filter(Boolean);
        for (const name of candidates) {
            if (!name || runtimeExcludedNames.has(name)) continue;
            if (!byName.has(name)) {
                const explicit = readExplicitValue(name, '');
                if (explicit !== undefined && explicit !== null && String(explicit).trim()) {
                    return String(explicit).trim();
                }
                continue;
            }
            if (!sharedValues) {
                // Only declared shared secrets are evaluated here. Agent-owned
                // settings keys remain confined to that agent's environment.
                sharedValues = buildEnvMap({}, { env: sharedSpecs.map((spec) => ({
                    name: spec.insideName,
                    varName: spec.sourceName,
                    sharedGeneratedSecret: true,
                    explicitOverride: spec.generated.explicitOverride,
                    explicitOverrideRequires: spec.generated.explicitOverrideRequires,
                })) }, { repoName: resolved.repo, agentName: resolved.shortAgentName, forRuntime: true });
            }
            return String(sharedValues[name] || '').trim();
        }
        return readExplicitValue([], fallback);
    };
}
