import fs from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';

import { PLOINKY_WORKSPACE_ROOT, PLOINKY_SKILL_SCOPE_ENV } from '../utils/config.js';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { readGraphSkillScope } from '../../ploinky-box/graphSkillScope.mjs';
import { resolveSkillRepositorySource } from '../utils/skillRepositorySource.js';
import { findSkillsManifestPath, readSkillsManifest } from './skills.js';
import { readAgentRegistrySnapshot } from '../utils/agentRegistrySnapshot.js';
import { resolveAgentRepositoryPath } from '../utils/agentRepositorySource.mjs';
import { linkInstallDeclarations } from '../utils/linkInstall.mjs';
import { parseEnableDirective } from '../utils/runtime/bootstrapManifest.js';
import { findAgent } from '../utils/utils.js';
import { createOperationRecord } from './updateOutcome.js';

// Graph closure for `ploinky update` records (P3b).
//
// The graph is what the workspace records say it runs: every enabled agent in
// the agents registry, the repository that provides it (and its devel
// repository), the repositories its manifest declares in `repos`, its
// `link-install` workspace checkouts and the agents it enables, transitively.
// Skills manifests located inside a required repository are required, and so
// are the sources they name; default-skill sources are required for a
// required target. Everything else is optional.
//
// The closure is read-only: it reads the verified registry, manifests and
// declared skill-source identities. It never updates a checkout. When
// membership cannot be determined (unreadable registry or manifest), the
// graph is marked undeterminable and every record that it does not already
// prove required gets `required: null`, which is treated as required.

const MANIFEST_BYTE_LIMIT = 1024 * 1024;
const commandSkillScopes = new AsyncLocalStorage();

export function withUpdateSkillScopes(context, run) {
    return commandSkillScopes.run(context, run);
}

function addSkillScopes(graph, workspaceRoot, registry, context, resolveSkillSource) {
    graph.skillScopePaths = new Set();
    graph.skillSourceNames = new Set();
    graph.skillSourcePaths = new Set();
    graph.skillScopesDetermined = true;
    const unknown = message => {
        graph.skillScopesDetermined = false;
        graph.errors.push(`skill scope: ${message}`);
    };
    if (context === undefined || context === null) {
        const selectedHere = canonical(workspaceRoot) === canonical(PLOINKY_WORKSPACE_ROOT);
        context = {
            proposed: selectedHere ? PLOINKY_SKILL_SCOPE_ENV.PLOINKY_SKILL_SCOPE : workspaceRoot,
            prior: null,
            priorRequired: Boolean(registry?._config?.static?.agent),
        };
        try {
            context.prior = readGraphSkillScope(buildWorkspaceIdentity(workspaceRoot))?.PLOINKY_SKILL_SCOPE || null;
        } catch (error) {
            if (context.priorRequired) unknown(error.message);
        }
    }
    if (!context || typeof context !== 'object' || Array.isArray(context)
        || typeof context.priorRequired !== 'boolean') {
        unknown('the prior/proposed scope contract is invalid');
        return;
    }
    const root = canonical(workspaceRoot);
    for (const [name, value, required] of [
        ['proposed', context.proposed, true], ['prior', context.prior, context.priorRequired],
    ]) {
        if (value === null || value === undefined) {
            if (required) unknown(`${name} scope is unavailable`);
            continue;
        }
        try {
            if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('scope is not an absolute path');
            const resolved = fs.realpathSync(value);
            if (!inside(root, resolved) || !fs.statSync(resolved).isDirectory()) {
                throw new Error('scope is outside the selected workspace or is not a directory');
            }
            graph.skillScopePaths.add(resolved);
        } catch (error) { unknown(`${name} scope: ${error.message}`); }
    }
    // Prior scopes can be outside this update's folder scan. Read their
    // declarations now so their providers remain required even without an
    // export record from the current command.
    for (const scope of graph.skillScopePaths) {
        try {
            const manifest = findSkillsManifestPath(scope);
            if (!manifest) continue;
            for (const entry of readSkillsManifest(manifest)) {
                graph.skillSourceNames.add(entry.name);
                const selected = resolveSkillSource(entry.name, entry.url, { workspaceRoot });
                const source = selected.origin === 'workspace' ? selected.source
                    : path.join(workspaceRoot, '.ploinky', 'repos', entry.name);
                graph.skillSourcePaths.add(canonical(source));
            }
        } catch (error) { unknown(`manifest in ${scope}: ${error.message}`); }
    }
}

// A missing leaf keeps the canonical spelling of its nearest existing
// ancestor, so a required path below a symlinked workspace still matches the
// canonical paths recorded for that workspace.
function canonical(target) {
    const resolved = path.resolve(target);
    for (let existing = resolved; ; existing = path.dirname(existing)) {
        try {
            return path.join(fs.realpathSync(existing), path.relative(existing, resolved));
        } catch (_) {
            if (path.dirname(existing) === existing) return resolved;
        }
    }
}

function inside(root, candidate) {
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function readManifest(manifestPath) {
    const stat = fs.statSync(manifestPath);
    if (!stat.isFile() || stat.size > MANIFEST_BYTE_LIMIT) throw new Error(`manifest is not a bounded regular file: ${manifestPath}`);
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`manifest is not an object: ${manifestPath}`);
    return value;
}

function enableEntries(manifest) {
    const entries = [];
    if (Array.isArray(manifest?.enable)) entries.push(...manifest.enable);
    // Every profile's dependencies may become active; include them all.
    for (const block of Object.values(manifest?.profiles || {})) {
        if (block && Array.isArray(block.enable)) entries.push(...block.enable);
    }
    return entries;
}

/**
 * Read the graph once. Returns an immutable description:
 *   { determinable, errors, repositories:Set<name>, repositoryPaths:Set<canonical>,
 *     linkInstallNames:Set<name>, linkInstallPaths:Set<canonical> }
 */
export function readUpdateGraph({
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    readRegistry = () => readAgentRegistrySnapshot({ workspaceRoot }),
    repositoryPath = resolveAgentRepositoryPath,
    // Same resolver the start path uses for a bare enabled agent name.
    resolveAgent = findAgent,
    skillScopeContext = commandSkillScopes.getStore(),
    resolveSkillSource = resolveSkillRepositorySource,
} = {}) {
    const graph = {
        determinable: true,
        errors: [],
        repositories: new Set(),
        repositoryPaths: new Set(),
        linkInstallNames: new Set(),
        linkInstallPaths: new Set(),
    };
    const unknown = message => {
        graph.determinable = false;
        graph.errors.push(message);
    };
    let registry;
    try {
        registry = readRegistry();
    } catch (error) {
        unknown(`agents registry: ${error?.message || error}`);
        return graph;
    }
    addSkillScopes(graph, workspaceRoot, registry, skillScopeContext, resolveSkillSource);
    const addRepository = name => {
        const repoName = String(name || '').trim();
        if (!repoName || graph.repositories.has(repoName)) return;
        graph.repositories.add(repoName);
        try {
            graph.repositoryPaths.add(canonical(repositoryPath(repoName)));
        } catch (error) {
            unknown(`repository ${repoName}: ${error?.message || error}`);
        }
    };
    const pending = [];
    const visited = new Set();
    for (const [key, record] of Object.entries(registry || {})) {
        if (key === '_config' || !record || typeof record !== 'object' || record.type !== 'agent') continue;
        if (!record.repoName || !record.agentName) {
            unknown(`agents registry entry ${key} has no repository or agent name`);
            continue;
        }
        addRepository(record.repoName);
        if (record.develRepo) addRepository(record.develRepo);
        pending.push([String(record.repoName), String(record.agentName)]);
    }
    while (pending.length) {
        const [repoName, agentName] = pending.shift();
        const agentKey = `${repoName}/${agentName}`;
        if (visited.has(agentKey)) continue;
        visited.add(agentKey);
        addRepository(repoName);
        let repoPath;
        try {
            repoPath = repositoryPath(repoName);
        } catch (error) {
            unknown(`repository ${repoName}: ${error?.message || error}`);
            continue;
        }
        let manifest;
        try {
            manifest = readManifest(path.join(repoPath, agentName, 'manifest.json'));
        } catch (error) {
            unknown(`manifest of ${agentKey}: ${error?.message || error}`);
            continue;
        }
        if (manifest.repos && typeof manifest.repos === 'object' && !Array.isArray(manifest.repos)) {
            for (const name of Object.keys(manifest.repos)) addRepository(name);
        }
        try {
            for (const declaration of linkInstallDeclarations(manifest)) {
                graph.linkInstallNames.add(declaration.name);
                graph.linkInstallPaths.add(canonical(path.join(workspaceRoot, declaration.name)));
            }
        } catch (error) {
            unknown(`link-install of ${agentKey}: ${error?.message || error}`);
        }
        for (const entry of enableEntries(manifest)) {
            let spec = '';
            try {
                spec = String(parseEnableDirective(entry)?.spec || '').trim().split(/\s+/)[0] || '';
            } catch (_) {}
            if (!spec) continue;
            const separator = spec.search(/[:/]/);
            if (separator > 0) {
                pending.push([spec.slice(0, separator), spec.slice(separator + 1)]);
            } else if (fs.existsSync(path.join(repoPath, spec, 'manifest.json'))) {
                pending.push([repoName, spec]);
            } else {
                try {
                    const found = resolveAgent(spec);
                    if (!found?.repo) throw new Error('no repository');
                    pending.push([String(found.repo), String(found.shortAgentName || spec)]);
                } catch (error) {
                    unknown(`enabled agent '${spec}' of ${agentKey} cannot be resolved: ${error?.message || error}`);
                }
            }
        }
    }
    return graph;
}

/**
 * Membership of one record in one graph: true (required), false (optional)
 * or null (the graph could not determine it).
 */
function membership(graph, record, context) {
    if (!graph) return null;
    const ids = [record.id, ...(record.details?.aliases || [])].map(String);
    const recordPath = record.details?.checkout?.path ? canonical(record.details.checkout.path) : null;
    const pathRequired = candidate => candidate && ([...graph.repositoryPaths].some(root => candidate === root)
        || graph.linkInstallPaths.has(candidate));
    let required = false;
    switch (record.phase) {
        case 'registered-repository':
            required = ids.some(id => graph.repositories.has(id) || graph.linkInstallNames.has(id))
                || pathRequired(recordPath)
                || ids.some(id => graph.skillSourceNames?.has(id))
                || (recordPath && graph.skillSourcePaths?.has(recordPath))
                || context.requiredSkillSources.has(record.id);
            break;
        case 'workspace-repository':
            required = pathRequired(recordPath || canonical(record.id))
                || graph.skillSourcePaths?.has(recordPath || canonical(record.id));
            break;
        case 'default-skills': {
            const target = record.details?.target;
            required = Boolean(target && (graph.repositories.has(target)
                || (record.details?.targetPath && pathRequired(canonical(record.details.targetPath)))));
            break;
        }
        case 'skills-manifest': {
            const folder = canonical(record.details?.folder || record.id);
            required = [...graph.repositoryPaths].some(root => inside(root, folder))
                || graph.skillScopePaths?.has(folder);
            if (!required && graph.skillScopesDetermined === false) return null;
            break;
        }
        default:
            return undefined;
    }
    if (required) return true;
    return graph.determinable && graph.skillScopesDetermined !== false ? false : null;
}

/**
 * Apply graph closure to records. `required` already decided by the phase
 * (AgentLib, host Ploinky, not-applicable skips) is kept; the graph decides
 * repository, default-skill and skills-manifest records.
 *
 * required = inPrior || inProposed ? true : (either undeterminable ? null : false)
 */
export function applyGraphRequirements(records, { prior = null, proposed = null } = {}) {
    // Sources named by required skills manifests and default-skill sources of
    // required targets are required repositories themselves.
    const requiredSkillSources = new Set();
    const requiredSkillPaths = new Set();
    const firstPass = records.map(record => {
        if (record.details?.requirementFixed) return record.required;
        const a = membership(prior, record, { requiredSkillSources });
        const b = membership(proposed, record, { requiredSkillSources });
        if (a === undefined) return record.required;
        if (a === true || b === true) return true;
        if (a === null || b === null) return null;
        return false;
    });
    records.forEach((record, index) => {
        if (firstPass[index] === false) return;
        if (record.phase === 'skills-manifest') {
            for (const name of record.details?.sources || []) requiredSkillSources.add(String(name));
            for (const source of record.details?.sourceStates || []) {
                if (source?.name) requiredSkillSources.add(String(source.name));
                if (source?.checkoutPath) requiredSkillPaths.add(canonical(source.checkoutPath));
            }
        } else if (record.phase === 'default-skills' && record.details?.source) {
            requiredSkillSources.add(String(record.details.source));
            if (record.details?.sourceState?.checkoutPath) {
                requiredSkillPaths.add(canonical(record.details.sourceState.checkoutPath));
            }
        }
    });
    return records.map((record, index) => {
        let required = firstPass[index];
        if (['registered-repository', 'workspace-repository'].includes(record.phase) && required !== true) {
            const ids = [record.id, ...(record.details?.aliases || [])];
            const checkout = record.details?.checkout?.path
                || (record.phase === 'workspace-repository' ? record.id : null);
            if (ids.some(id => requiredSkillSources.has(String(id)))
                || (checkout && requiredSkillPaths.has(canonical(checkout)))) required = true;
        }
        if (required === record.required) return record;
        return createOperationRecord({ ...record, attempted: record.attempted, required });
    });
}
