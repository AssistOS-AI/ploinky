import fs from 'fs';
import path from 'path';
import { manifestEnableEntries, parseEnableDirective, qualifyEnableSpecForRepo } from './bootstrapManifest.js';
import { findAgent } from './utils.js';
import { isSsoProviderManifest } from './agentRegistry.js';
import { getActiveProfile } from './profileService.js';

function normalizeAuthMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'local' || normalized === 'pwd') return 'local';
    if (normalized === 'sso') return 'sso';
    return 'none';
}

function parsePloinkyDirectives(rawValue) {
    if (Array.isArray(rawValue)) {
        return rawValue.flatMap((item) => parsePloinkyDirectives(item)).filter(Boolean);
    }
    if (typeof rawValue !== 'string') {
        return [];
    }
    return rawValue
        .split(/[,\n;]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
}

function resolveManifestAuthMode(manifest, registryRecord = null) {
    const registryMode = normalizeAuthMode(registryRecord?.auth?.mode);
    if (registryMode !== 'none') {
        return registryMode;
    }

    const ploinkyDirectives = parsePloinkyDirectives(manifest?.ploinky);
    if (ploinkyDirectives.includes('pwd enable')) {
        return 'local';
    }
    if (ploinkyDirectives.includes('sso enable')) {
        return 'sso';
    }
    return 'none';
}

function manifestForAgentRef(agentRef) {
    try {
        const resolved = findAgent(agentRef);
        if (!resolved || !resolved.manifestPath) return null;
        return JSON.parse(fs.readFileSync(resolved.manifestPath, 'utf8'));
    } catch (_) {
        return null;
    }
}

function shouldEnableManifestDependency(agentRef, authMode) {
    const normalizedRef = String(agentRef || '').trim();
    if (!normalizedRef) return false;
    const manifest = manifestForAgentRef(normalizedRef);
    if (manifest && isSsoProviderManifest(manifest)) {
        return authMode === 'sso';
    }
    return true;
}

function parseManifestDependencyRef(agentRef) {
    try {
        const parsed = parseEnableDirective(agentRef);
        const spec = String(parsed?.spec || '').trim();
        if (!spec) return '';
        const colonIndex = spec.indexOf(':');
        if (colonIndex !== -1) {
            return spec.slice(0, colonIndex).trim();
        }
        const tokens = spec.split(/\s+/).filter(Boolean);
        if (!tokens.length) return '';
        return tokens[0];
    } catch (_) {
        const raw = String(agentRef || '').trim();
        if (!raw) return '';
        const colonIndex = raw.indexOf(':');
        if (colonIndex !== -1) {
            return raw.slice(0, colonIndex).trim();
        }
        const tokens = raw.split(/\s+/).filter(Boolean);
        return tokens[0] || '';
    }
}

function createGraphNodeId(repoName, shortAgentName, alias = '') {
    return alias
        ? `${repoName}/${shortAgentName} as ${alias}`
        : `${repoName}/${shortAgentName}`;
}

function readManifest(manifestPath) {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function findRegistryRecord(registry, { repoName, shortAgentName, alias = '' }) {
    const entries = Object.values(registry || {});
    if (alias) {
        return entries.find((record) => (
            record && record.type === 'agent'
            && record.repoName === repoName
            && record.agentName === shortAgentName
            && record.alias === alias
        )) || null;
    }
    return entries.find((record) => (
        record && record.type === 'agent'
        && record.repoName === repoName
        && record.agentName === shortAgentName
        && !record.alias
    )) || null;
}

// Resolve an operator-facing agent token against an already-loaded workspace
// registry using the same precedence as the runtime command handlers. Keeping
// this helper pure lets the publication planner use its planning snapshot
// instead of re-reading agents.json partway through a plan.
function resolveEnabledAgentRegistryRecord(agentRef, registry = {}) {
    const input = typeof agentRef === 'string' ? agentRef.trim() : '';
    if (!input || !registry || typeof registry !== 'object') return null;

    const direct = registry[input];
    if (direct && direct.type === 'agent') {
        return { containerName: input, record: direct };
    }

    const hasNamespace = /[:/]/.test(input);
    let repoFilter = null;
    let agentFilter = input;
    if (hasNamespace) {
        const parts = input.split(/[:/]/).filter(Boolean);
        if (parts.length === 2) {
            [repoFilter, agentFilter] = parts;
        }
    }

    const entries = Object.entries(registry)
        .filter(([key]) => key !== '_config');
    let aliasEntry = entries.find(([, value]) => (
        value && value.type === 'agent' && value.alias === input
    ));
    if (!aliasEntry && hasNamespace) {
        aliasEntry = entries.find(([, value]) => (
            value && value.type === 'agent' && value.alias === agentFilter
        ));
    }
    if (aliasEntry) {
        return { containerName: aliasEntry[0], record: aliasEntry[1] };
    }

    const matches = entries
        .filter(([, value]) => value && typeof value === 'object' && value.type === 'agent')
        .filter(([, value]) => {
            if (!value.agentName) return false;
            if (repoFilter && value.repoName !== repoFilter) return false;
            return value.agentName === agentFilter;
        });
    if (!matches.length) return null;
    if (matches.length > 1) {
        const aliases = matches.map(([containerName, value]) => value.alias || containerName);
        const error = new Error(`Multiple containers found for agent '${agentRef}'. Use alias: ${aliases.join(', ')}`);
        error.code = 'AGENT_ALIAS_AMBIGUOUS';
        throw error;
    }

    const [containerName, record] = matches[0];
    return { containerName, record };
}

function normalizeProfileOverride(profile) {
    const normalized = String(profile || '').trim().toLowerCase();
    return normalized || '';
}

function resolveEffectiveProfile(manifest, requestedProfile, agentRef, { explicit = false } = {}) {
    const requested = normalizeProfileOverride(requestedProfile);
    const profiles = manifest?.profiles && typeof manifest.profiles === 'object'
        ? manifest.profiles
        : {};
    if (!requested) {
        return 'default';
    }
    if (Object.prototype.hasOwnProperty.call(profiles, requested)) {
        return requested;
    }
    if (explicit) {
        const available = Object.keys(profiles).sort();
        throw new Error(
            `profile '${requested}' is not defined by ${agentRef}; available profiles: ${available.join(', ') || '(none)'}`,
        );
    }
    return 'default';
}

function effectiveInstanceKey(repoName, shortAgentName, alias = '') {
    return alias
        ? `${repoName}/${shortAgentName}#alias:${alias}`
        : `${repoName}/${shortAgentName}#canonical`;
}

function resolveWorkspaceDependencyGraph({
    staticAgentRef,
    registry = {},
    workspaceProfile = '',
    rootProfile = '',
    rootAlias = '',
    onCycle = null,
} = {}) {
    if (!staticAgentRef || typeof staticAgentRef !== 'string') {
        throw new Error('Missing static agent reference.');
    }

    const nodes = new Map();
    const state = new Map();

    const selectedWorkspaceProfile = normalizeProfileOverride(workspaceProfile || getActiveProfile());

    function visit(agentRef, {
        alias = '',
        enableSpec = '',
        profile = '',
        profileExplicit = false,
        isStatic = false,
        stack = [],
        selectionPath = [],
    } = {}) {
        const resolved = findAgent(agentRef);
        const nodeId = createGraphNodeId(resolved.repo, resolved.shortAgentName, alias);
        const instanceKey = effectiveInstanceKey(resolved.repo, resolved.shortAgentName, alias);
        const requestedProfile = normalizeProfileOverride(profile);

        if (stack.includes(nodeId)) {
            throw new Error(`Dependency cycle detected: ${[...stack, nodeId].join(' -> ')}`);
        }

        let node = nodes.get(nodeId);
        if (!node) {
            const manifest = readManifest(resolved.manifestPath);
            const registryRecord = findRegistryRecord(registry, {
                repoName: resolved.repo,
                shortAgentName: resolved.shortAgentName,
                alias
            });
            const selectedProfile = requestedProfile || normalizeProfileOverride(registryRecord?.profile);
            const profileName = resolveEffectiveProfile(manifest, selectedProfile, `${resolved.repo}/${resolved.shortAgentName}`, {
                explicit: profileExplicit || (!requestedProfile && Boolean(registryRecord?.profile)),
            });
            node = {
                id: nodeId,
                instanceKey,
                agentRef: `${resolved.repo}/${resolved.shortAgentName}`,
                enableSpec: String(enableSpec || agentRef || `${resolved.repo}/${resolved.shortAgentName}`).trim(),
                profile: profileName,
                profileExplicit: Boolean(profileExplicit),
                repoName: resolved.repo,
                shortAgentName: resolved.shortAgentName,
                alias,
                manifestPath: resolved.manifestPath,
                agentPath: path.dirname(resolved.manifestPath),
                manifest,
                authMode: resolveManifestAuthMode(manifest, registryRecord),
                dependencies: new Set(),
                dependents: new Set(),
                // dependencyEdges maps a direct child's node id to the edge-local
                // metadata declared on the enable[] entry (currently just `noWait`).
                // The same agent may be a no-wait child of one parent and a
                // blocking child of another, so the modifier must live on the
                // edge rather than on the child node itself.
                dependencyEdges: new Map(),
                isStatic: Boolean(isStatic),
                selectionPath: selectionPath.length ? [...selectionPath] : [nodeId],
            };
            nodes.set(nodeId, node);
        } else if (isStatic) {
            node.isStatic = true;
        }

        if (node) {
            const candidateProfile = resolveEffectiveProfile(
                node.manifest,
                requestedProfile || node.profile,
                node.agentRef,
                { explicit: profileExplicit },
            );
            if (candidateProfile !== node.profile) {
                const firstPath = node.selectionPath?.join(' -> ') || node.id;
                const conflictingPath = selectionPath.length ? selectionPath.join(' -> ') : node.id;
                throw new Error(
                    `conflicting profiles for effective instance ${node.instanceKey}: profile '${node.profile}' via ${firstPath}; profile '${candidateProfile}' via ${conflictingPath}`,
                );
            }
        }

        const status = state.get(nodeId);
        if (status === 'visiting') {
            throw new Error(`Dependency cycle detected: ${[...stack, nodeId].join(' -> ')}`);
        }
        if (status === 'visited') {
            return nodeId;
        }

        state.set(nodeId, 'visiting');
        const nextStack = [...stack, nodeId];
        const enableList = manifestEnableEntries(node.manifest, node.profile);
        for (const rawDependency of enableList) {
            try {
                const parsedDependency = parseEnableDirective(rawDependency);
                if (!parsedDependency) continue;

                const qualifiedDependency = {
                    ...parsedDependency,
                    spec: qualifyEnableSpecForRepo(parsedDependency.spec, node.repoName),
                };
                const dependencyRef = parseManifestDependencyRef(qualifiedDependency.spec);
                if (!shouldEnableManifestDependency(dependencyRef, node.authMode)) {
                    continue;
                }

                const childId = visit(dependencyRef, {
                    alias: qualifiedDependency.alias || '',
                    enableSpec: qualifiedDependency.spec || dependencyRef,
                    profile: qualifiedDependency.profile || selectedWorkspaceProfile,
                    profileExplicit: Boolean(qualifiedDependency.profile),
                    stack: nextStack,
                    selectionPath: [...node.selectionPath, `${node.id} -> ${dependencyRef}${qualifiedDependency.alias ? ` as ${qualifiedDependency.alias}` : ''}`],
                });
                node.dependencies.add(childId);
                const noWait = Boolean(qualifiedDependency.noWait);
                const existingEdge = node.dependencyEdges.get(childId);
                // When the same parent declares the same child twice (typical when
                // a top-level enable[] entry overlaps a profile enable[] entry),
                // a blocking edge wins over a no-wait edge so the dependent still
                // waits when at least one parent declaration is fail-closed.
                if (!existingEdge || (existingEdge.noWait && !noWait)) {
                    node.dependencyEdges.set(childId, { noWait });
                }
                nodes.get(childId)?.dependents.add(nodeId);
            } catch (dependencyError) {
                const message = dependencyError?.message || String(dependencyError);
                // Cycles are an existing intentional truncation case: log and continue so the parent build can still proceed.
                // All other resolution failures (missing agents, malformed enable specs, manifest parse errors) fail-closed.
                if (message.startsWith('Dependency cycle detected:')) {
                    const warning = `[manifest enable] Failed to resolve dependency '${rawDependency}' for '${node.agentRef}': ${message}`;
                    if (typeof onCycle === 'function') onCycle(warning);
                    else console.error(warning);
                    continue;
                }
                throw new Error(`[manifest enable] Failed to resolve dependency '${rawDependency}' for '${node.agentRef}': ${message}`);
            }
        }
        state.set(nodeId, 'visited');
        return nodeId;
    }

    const staticNodeId = visit(staticAgentRef, {
        enableSpec: staticAgentRef,
        alias: rootAlias,
        profile: rootProfile || selectedWorkspaceProfile,
        profileExplicit: Boolean(rootProfile),
        isStatic: true,
        selectionPath: [String(staticAgentRef)],
    });
    return {
        staticNodeId,
        nodes
    };
}

// Classify each node as blocking or no-wait based on traversal from the static
// agent. A node is blocking when at least one path from the static agent
// reaches it entirely through edges declared without `no-wait`. A node is
// no-wait when every path from the static agent traverses at least one
// no-wait edge. The static node itself is always blocking — the operator
// invoked `ploinky start <staticAgent>` and is waiting on it.
function classifyDependencyGraphWaitMode(graph) {
    const nodes = graph?.nodes instanceof Map ? graph.nodes : new Map();
    const blocking = new Set();
    const staticNodeId = graph?.staticNodeId;
    if (!staticNodeId || !nodes.has(staticNodeId)) {
        return { blocking, noWait: new Set(nodes.keys()) };
    }

    // BFS: a child is blocking iff at least one blocking parent reaches it
    // through a blocking edge. Iterate until the blocking set stops growing
    // because cycle truncation can leave residual nodes; the topology is
    // already a DAG after that.
    blocking.add(staticNodeId);
    let changed = true;
    while (changed) {
        changed = false;
        for (const parentId of Array.from(blocking)) {
            const parent = nodes.get(parentId);
            if (!parent) continue;
            for (const childId of parent.dependencies) {
                if (blocking.has(childId)) continue;
                const edge = parent.dependencyEdges?.get(childId);
                if (!edge || !edge.noWait) {
                    blocking.add(childId);
                    changed = true;
                }
            }
        }
    }

    const noWait = new Set();
    for (const nodeId of nodes.keys()) {
        if (!blocking.has(nodeId)) {
            noWait.add(nodeId);
        }
    }
    return { blocking, noWait };
}

function topologicallyGroupDependencyGraph(graph) {
    const nodes = graph?.nodes instanceof Map ? graph.nodes : new Map();
    const indegree = new Map();
    for (const [nodeId, node] of nodes.entries()) {
        indegree.set(nodeId, node.dependencies.size);
    }

    const waves = [];
    let remaining = Array.from(nodes.keys());
    while (remaining.length) {
        const wave = remaining
            .filter((nodeId) => (indegree.get(nodeId) || 0) === 0)
            .sort((a, b) => a.localeCompare(b));
        if (!wave.length) {
            throw new Error('Dependency graph contains a cycle.');
        }
        waves.push(wave);

        for (const nodeId of wave) {
            for (const dependentId of nodes.get(nodeId)?.dependents || []) {
                indegree.set(dependentId, Math.max(0, (indegree.get(dependentId) || 0) - 1));
            }
            indegree.delete(nodeId);
        }
        remaining = remaining.filter((nodeId) => !wave.includes(nodeId));
    }

    return waves;
}

export {
    classifyDependencyGraphWaitMode,
    createGraphNodeId,
    effectiveInstanceKey,
    parseManifestDependencyRef,
    resolveEnabledAgentRegistryRecord,
    resolveWorkspaceDependencyGraph,
    topologicallyGroupDependencyGraph
};
