import fs from 'fs';
import path from 'path';
import { manifestEnableEntries, parseEnableDirective, qualifyEnableSpecForRepo } from './runtime/bootstrapManifest.js';
import { findAgent } from './utils.js';
import { isSsoProviderManifest } from './agentRegistry.js';
import { getActiveProfile, mergeProfiles } from './runtime/profileService.js';
import {
    assertNetworkStartupCompatibility,
    effectiveManifestNetwork,
    preflightNetworkAliases,
    validateManifestNetworks,
} from '../sandbox/networkContract.js';
import { resolveManifestStartup } from './runtime/manifestStartup.js';
import { resolveEnabledAgentRecordFromMap } from './agentRegistryResolver.js';
import { resolveAgentAuthPolicy } from './manifestAuth.js';

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
// registry. The precedence lives in the one pure resolver so graph resolution,
// the loading command handlers, and the read-only log command cannot drift.
function resolveEnabledAgentRegistryRecord(agentRef, registry = {}) {
    return resolveEnabledAgentRecordFromMap(agentRef, registry);
}

function normalizeProfileOverride(profile) {
    const normalized = String(profile || '').trim().toLowerCase();
    return normalized || '';
}

// The profile service's own test (profileService.js): a manifest declares profiles only with a non-empty plain `profiles` object.
function declaresProfiles(manifest) {
    const profiles = manifest?.profiles;
    return Boolean(profiles) && typeof profiles === 'object' && !Array.isArray(profiles) && Object.keys(profiles).length > 0;
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
    // A manifest that declares no profiles has the implicit 'default' profile, and the product persists exactly that
    // resolved name on every agent record. An explicit 'default' therefore resolves, as in the profile service
    // (profileService.js resolveManifestRuntimeProfile); any other explicit name on such a manifest still throws.
    if (requested === 'default' && !declaresProfiles(manifest)) {
        return 'default';
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
    // Opt-in: called for a no-wait dependency that cannot be resolved. The
    // dependency and everything only it reached leave the graph and the
    // parent still resolves. Without it every unresolvable dependency fails
    // the whole graph, as `start` requires.
    onUnresolvedNoWait = null,
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
            throw Object.assign(
                new Error(`Dependency cycle detected: ${[...stack, nodeId].join(' -> ')}`),
                { cycleNodeId: nodeId },
            );
        }

        let node = nodes.get(nodeId);
        if (!node) {
            const manifest = readManifest(resolved.manifestPath);
            validateManifestNetworks(manifest, { path: `manifest(${resolved.repo}/${resolved.shortAgentName})` });
            resolveManifestStartup(manifest);
            const registryRecord = findRegistryRecord(registry, {
                repoName: resolved.repo,
                shortAgentName: resolved.shortAgentName,
                alias
            });
            const selectedProfile = requestedProfile || normalizeProfileOverride(registryRecord?.profile);
            const profileName = resolveEffectiveProfile(manifest, selectedProfile, `${resolved.repo}/${resolved.shortAgentName}`, {
                explicit: profileExplicit || (!requestedProfile && Boolean(registryRecord?.profile)),
            });
            const network = effectiveManifestNetwork(manifest, profileName, {
                path: `manifest(${resolved.repo}/${resolved.shortAgentName})`,
            });
            const defaultProfileConfig = manifest.profiles?.default || null;
            const selectedProfileConfig = manifest.profiles?.[profileName] || null;
            const effectiveProfileConfig = profileName === 'default'
                ? defaultProfileConfig
                : mergeProfiles(defaultProfileConfig, selectedProfileConfig);
            assertNetworkStartupCompatibility(manifest, effectiveProfileConfig, network, {
                path: `manifest(${resolved.repo}/${resolved.shortAgentName})`,
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
                network,
                authMode: resolveAgentAuthPolicy(manifest,
                    ['', 'none'].includes(String(registryRecord?.auth?.mode || '').trim().toLowerCase())
                        ? undefined : registryRecord.auth,
                ).mode,
                dependencies: new Set(),
                dependents: new Set(),
                // dependencyEdges maps a direct child's node id to the edge-local
                // metadata declared on the enable[] entry (currently just `noWait`).
                // The same agent may be a no-wait child of one parent and a
                // blocking child of another, so the modifier must live on the
                // edge rather than on the child node itself.
                dependencyEdges: new Map(),
                // A declared edge that topology truncates as a cycle backedge
                // keeps its original wait kind for availability propagation.
                cycleBackedges: new Map(),
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
            throw Object.assign(
                new Error(`Dependency cycle detected: ${[...stack, nodeId].join(' -> ')}`),
                { cycleNodeId: nodeId },
            );
        }
        if (status === 'visited') {
            return nodeId;
        }

        state.set(nodeId, 'visiting');
        const nextStack = [...stack, nodeId];
        const enableList = manifestEnableEntries(node.manifest, node.profile);
        for (const rawDependency of enableList) {
            const knownNodeIds = typeof onUnresolvedNoWait === 'function' ? new Set(nodes.keys()) : null;
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
                    if (dependencyError.cycleNodeId) {
                        const noWait = Boolean(parseEnableDirective(rawDependency)?.noWait);
                        const existingBackedge = node.cycleBackedges.get(dependencyError.cycleNodeId);
                        if (!existingBackedge || (existingBackedge.noWait && !noWait)) {
                            node.cycleBackedges.set(dependencyError.cycleNodeId, { noWait });
                        }
                    }
                    const warning = `[manifest enable] Failed to resolve dependency '${rawDependency}' for '${node.agentRef}': ${message}`;
                    if (typeof onCycle === 'function') onCycle(warning);
                    else console.error(warning);
                    continue;
                }
                let tolerated = false;
                if (knownNodeIds) {
                    try { tolerated = parseEnableDirective(rawDependency)?.noWait === true; } catch (_) { /* malformed entries stay blocking */ }
                }
                if (tolerated) {
                    // Drop what the failed subtree added so a half-visited node is never mistaken for a cycle later.
                    const dropped = [...nodes.keys()].filter((nodeKey) => !knownNodeIds.has(nodeKey));
                    for (const nodeKey of dropped) {
                        nodes.delete(nodeKey);
                        state.delete(nodeKey);
                    }
                    for (const remaining of nodes.values()) {
                        for (const nodeKey of dropped) remaining.dependents.delete(nodeKey);
                    }
                    onUnresolvedNoWait({ rawDependency, parentRef: node.agentRef, message });
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
    preflightNetworkAliases(Array.from(nodes.values()).map((node) => ({
        id: node.id,
        agentRef: node.agentRef,
        canonicalAgentId: node.shortAgentName,
        instanceKey: node.instanceKey,
        network: node.network,
        path: `manifest(${node.agentRef})`,
    })));
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

// The agent reference of a dependency directive, without its no-wait and alias
// tokens, so an object directive is reported by its agent rather than as text.
function unavailableDependencyRef(rawDependency, parentRef) {
    try {
        const parsed = parseEnableDirective(rawDependency);
        const qualified = qualifyEnableSpecForRepo(parsed?.spec, String(parentRef || '').split('/')[0]);
        return (parseManifestDependencyRef(qualified) || 'unknown').slice(0, 256);
    } catch (_) {
        return 'unknown';
    }
}

// The manifest dependencies a Marketplace enable of `agentRef` must also enable,
// resolved by the same graph `start` uses (record-aware SSO gate, a blocking
// edge winning over a duplicate no-wait edge, fail-closed resolution). Blocking
// dependencies come first, deepest first, and run before the root; no-wait
// dependencies run after it. The one divergence from `start`: a no-wait
// dependency that cannot be resolved is reported as unavailable instead of
// failing the root. Read-only; it enables nothing.
function planManifestDependencyEnables(agentRef, {
    loadRegistry = () => ({}),
    alias = '',
    profile = '',
    onCycle = () => {},
} = {}) {
    const plan = { before: [], after: [], unavailable: [] };
    try {
        findAgent(agentRef);
    } catch (_) {
        // The root itself is unknown; its own enable reports that.
        return plan;
    }
    let graph;
    try {
        graph = resolveWorkspaceDependencyGraph({
            staticAgentRef: agentRef,
            registry: loadRegistry(),
            rootAlias: alias,
            rootProfile: profile,
            onCycle,
            onUnresolvedNoWait: ({ rawDependency, parentRef, message }) => {
                plan.unavailable.push({ ref: unavailableDependencyRef(rawDependency, parentRef), error: message.slice(0, 512) });
            },
        });
    } catch (error) {
        const message = String(error?.message || error);
        if (!message.startsWith('[manifest enable]')) throw error;
        throw Object.assign(new Error(message.slice(0, 512)), { code: 'MARKETPLACE_DEPENDENCY_UNAVAILABLE', cause: error });
    }
    const reachable = new Set();
    const pending = [graph.staticNodeId];
    while (pending.length) {
        const nodeId = pending.pop();
        if (reachable.has(nodeId)) continue;
        reachable.add(nodeId);
        pending.push(...(graph.nodes.get(nodeId)?.dependencies || []));
    }
    const { blocking } = classifyDependencyGraphWaitMode(graph);
    for (const wave of topologicallyGroupDependencyGraph(graph)) {
        for (const nodeId of wave) {
            if (nodeId === graph.staticNodeId || !reachable.has(nodeId)) continue;
            const node = graph.nodes.get(nodeId);
            (blocking.has(nodeId) ? plan.before : plan.after).push({
                ref: node.agentRef,
                agentRef: node.enableSpec,
                alias: node.alias,
                profile: node.profileExplicit ? node.profile : '',
                dependsOn: [...node.dependencies].map((dependencyId) => graph.nodes.get(dependencyId)?.agentRef).filter(Boolean),
            });
        }
    }
    return plan;
}

export {
    classifyDependencyGraphWaitMode,
    createGraphNodeId,
    effectiveInstanceKey,
    parseManifestDependencyRef,
    planManifestDependencyEnables,
    resolveEnabledAgentRegistryRecord,
    resolveWorkspaceDependencyGraph,
    topologicallyGroupDependencyGraph
};
