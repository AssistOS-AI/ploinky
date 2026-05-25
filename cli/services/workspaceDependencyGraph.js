import fs from 'fs';
import path from 'path';
import { parseEnableDirective } from './bootstrapManifest.js';
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

function normalizeProfileOverride(profile) {
    const normalized = String(profile || '').trim().toLowerCase();
    return normalized || '';
}

function resolveWorkspaceDependencyGraph({ staticAgentRef, registry = {} } = {}) {
    if (!staticAgentRef || typeof staticAgentRef !== 'string') {
        throw new Error('Missing static agent reference.');
    }

    const nodes = new Map();
    const state = new Map();

    function visit(agentRef, { alias = '', enableSpec = '', profile = '', isStatic = false, stack = [] } = {}) {
        const resolved = findAgent(agentRef);
        const nodeId = createGraphNodeId(resolved.repo, resolved.shortAgentName, alias);
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
            const profileName = requestedProfile || normalizeProfileOverride(registryRecord?.profile);
            node = {
                id: nodeId,
                agentRef: `${resolved.repo}/${resolved.shortAgentName}`,
                enableSpec: String(enableSpec || agentRef || `${resolved.repo}/${resolved.shortAgentName}`).trim(),
                profile: profileName,
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
                isStatic: Boolean(isStatic)
            };
            nodes.set(nodeId, node);
        } else if (isStatic) {
            node.isStatic = true;
        } else if (requestedProfile && node.profile !== requestedProfile) {
            node.profile = requestedProfile;
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
        const baseEnable = Array.isArray(node.manifest.enable) ? node.manifest.enable : [];
        let profileEnable = [];
        try {
            const activeProfile = node.profile || getActiveProfile();
            const profileBlock = node.manifest?.profiles?.[activeProfile];
            if (profileBlock && Array.isArray(profileBlock.enable)) {
                profileEnable = profileBlock.enable;
            }
        } catch (_) {
            // No active profile available (or profile lookup failed); fall back to top-level enable only.
        }
        const enableList = [...baseEnable, ...profileEnable];
        for (const rawDependency of enableList) {
            try {
                const parsedDependency = parseEnableDirective(rawDependency);
                if (!parsedDependency) continue;

                const dependencyRef = parseManifestDependencyRef(parsedDependency.spec);
                if (!shouldEnableManifestDependency(dependencyRef, node.authMode)) {
                    continue;
                }

                const childId = visit(dependencyRef, {
                    alias: parsedDependency.alias || '',
                    enableSpec: parsedDependency.spec || dependencyRef,
                    profile: parsedDependency.profile || '',
                    stack: nextStack
                });
                node.dependencies.add(childId);
                const noWait = Boolean(parsedDependency.noWait);
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
                    console.error(`[manifest enable] Failed to resolve dependency '${rawDependency}' for '${node.agentRef}': ${message}`);
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
        isStatic: true
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
    parseManifestDependencyRef,
    resolveWorkspaceDependencyGraph,
    topologicallyGroupDependencyGraph
};
