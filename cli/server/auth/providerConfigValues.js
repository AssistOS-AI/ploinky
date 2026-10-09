import fs from 'node:fs';
import { resolveAgentManifestLocation } from '../../utils/agentRegistry.js';
import { readAgentsSnapshot } from '../../utils/workspace.js';
import { loadActiveRoutingState } from '../routingState.js';
import { resolveManifestRuntimeProfile } from '../../utils/runtime/profileService.js';
import { buildEnvMap, getManifestEnvSpecs } from '../../utils/security/secretVars.js';

// The active generation's snapshot, or null when no generation is active.
export function tryLoadActiveSnapshot() {
    try {
        return loadActiveRoutingState().snapshot || null;
    } catch (_) {
        return null;
    }
}

// Provider modules run in the Router, while their services receive manifest
// environment values. Resolve shared generated values through the same
// profile/override contract so neither process needs to persist a second copy.
// The provider's one manifest is located through the active route (no
// installed-repository scan) and read once, fresh, per reader.
//
// `inputs` (optional, one scope from providerConfigInputs.js) supplies the
// manifest and the decrypted secrets through a validate-on-every-hit memo and
// derives generated workspace secrets from the scope's master-seed
// resolution; without it everything is read and derived directly.
export function createProviderConfigReader(providerAgentRef, readExplicitValue, { snapshot, inputs = null } = {}) {
    const located = resolveAgentManifestLocation(providerAgentRef, {
        snapshot: snapshot === undefined ? tryLoadActiveSnapshot() : snapshot,
    });
    if (!located) throw new Error(`Agent '${providerAgentRef}' not found.`);
    const resolved = { manifestPath: located.manifestPath, repo: located.repo, shortAgentName: located.agent };
    // Profile and env-spec resolution only read the manifest; a memoized
    // (frozen) manifest is copied anyway so no caller can observe another's edits.
    const manifest = inputs
        ? structuredClone(inputs.readJson(resolved.manifestPath))
        : JSON.parse(fs.readFileSync(resolved.manifestPath, 'utf8'));
    const record = Object.values(readAgentsSnapshot()).find((entry) => entry?.type === 'agent'
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
                })) }, {
                    repoName: resolved.repo,
                    agentName: resolved.shortAgentName,
                    forRuntime: true,
                    ...(inputs ? { secrets: inputs.readSecrets(), deriveWorkspaceSecret: inputs.deriveWorkspaceSecret } : {}),
                });
            }
            return String(sharedValues[name] || '').trim();
        }
        return readExplicitValue([], fallback);
    };
}
