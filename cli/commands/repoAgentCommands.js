import fs from 'fs';
import path from 'path';
import { PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT } from '../utils/config.js';
import { showHelp } from './help.js';
import * as reposSvc from '../utils/repos.js';
import * as agentsSvc from '../utils/agents.js';
import * as skillsSvc from './skills.js';
import * as workspaceSvc from '../utils/workspace.js';
import {
    resolvePloinkyRoot,
    updatePloinkySelf,
} from './updateService.js';
import { collectAgentsSummary } from '../utils/status.js';
import { findAgent } from '../utils/utils.js';
import { updateWorkspaceAgentLibSource } from '../../ploinky-box/agentlib-source.mjs';
import { isInsideBoxRuntime } from '../../agentlib/bootstrap.mjs';
import { agentLibRoot } from '../../agentlib/runtime.mjs';
import { PLOINKY_UPDATED_WORKSPACE_CHECKOUT_ENV } from './ploinkyUpdateScope.js';
import { sanitizeGitDiagnostic } from '../utils/gitCommand.js';
import { createOperationRecord } from './updateOutcome.js';
import { applyGraphRequirements, readUpdateGraph } from './updateGraph.js';
import { buildCoreUpdateResult, defaultSkillsRecord, skillsManifestRecord } from './updateRecords.js';
import { UpdateRequestError, resolveUpdateFolderScope } from './updateRequest.js';
import { refreshUpdateGitPins } from '../utils/dependencies/store/updatePins.mjs';

import { listAgentRepositoryNames, resolveAgentRepositoryPath } from '../utils/agentRepositorySource.mjs';
const REPOS_DIR = path.join(PLOINKY_DIR, 'repos');
const DEFAULT_SKILLS_REPO_NAMES = [
    'AchillesCopilotBasicSkills',
    'DocumentationSkills',
    'PloinkySkills',
];
function getRepoNames() {
    return listAgentRepositoryNames();
}

function getGitRepoNames() {
    const repoNames = getRepoNames();
    const gitRepoNames = [];
    for (const repoName of repoNames) {
        const repoPath = resolveAgentRepositoryPath(repoName);
        if (reposSvc.isGitRepository(repoPath) || reposSvc.resolveRepoSourceUrl(repoName)) {
            gitRepoNames.push(repoName);
        } else {
            console.warn(`  ! Skipping ${repoName}: not a git repository and no source URL is known.`);
        }
    }
    return gitRepoNames;
}

function normalizeManagedRepoName(repoName) {
    const normalizedRepoName = reposSvc.normalizeRepoName(repoName);
    const reposRoot = path.resolve(REPOS_DIR);
    const repoPath = path.resolve(reposRoot, normalizedRepoName);
    const relativeRepoPath = path.relative(reposRoot, repoPath);
    if (!relativeRepoPath
        || relativeRepoPath === '..'
        || relativeRepoPath.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativeRepoPath)) {
        throw new Error('Invalid repository name.');
    }
    return {
        repoName: normalizedRepoName,
        repoPath: resolveAgentRepositoryPath(normalizedRepoName),
    };
}

function refreshDefaultSkillsInPloinkyRepo(repoName, {
    defaultSkillsRepoName = DEFAULT_SKILLS_REPO_NAMES[0],
    sourceOutcomes = null,
} = {}) {
    const repoNameLabel = String(repoName || '').trim();
    if (!repoNameLabel) {
        return { repoName: repoNameLabel, skipped: true, reason: 'missing repo name' };
    }
    const { repoName: normalizedRepoName, repoPath } = normalizeManagedRepoName(repoNameLabel);
    const { repoName: normalizedDefaultSkillsRepoName } = normalizeManagedRepoName(defaultSkillsRepoName);
    if (normalizedRepoName === normalizedDefaultSkillsRepoName) {
        return { repoName: normalizedRepoName, skipped: true, reason: 'default skills source repo' };
    }

    if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
        return { repoName: normalizedRepoName, skipped: true, reason: 'repo path missing' };
    }
    if (reposSvc.classifyRepoKind(normalizedRepoName) === 'skills') {
        return { repoName: normalizedRepoName, skipped: true, reason: 'skills-only repo' };
    }

    // With `sourceOutcomes` the source is consumed from the update's single
    // operation set: never pulled here; a skipped/failed source is used as it
    // is without pruning, and an uncertain one is not read at all.
    const result = skillsSvc.installDefaultSkills(normalizedDefaultSkillsRepoName, {
        targetRoot: repoPath,
        pruneMissing: true,
        sourceOutcomes,
    });
    if (result.sourceSkipped) {
        return {
            repoName: normalizedRepoName,
            repoPath,
            sourceSkipped: result.sourceSkipped,
            reason: `default skills source not refreshed (${result.sourceSkipped.code})`,
        };
    }

    return {
        repoName: normalizedRepoName,
        repoPath,
        skills: result.skills,
        gitignoreUpdated: result.gitignoreUpdated,
        claudeLink: result.claudeLink,
        managedExport: result.managedExport,
        exclusions: result.exclusions || null,
        sourceState: result.sourceState || null,
        destRoot: result.destRoot || repoPath,
        refreshed: true,
    };
}

function refreshDefaultSkillsInPloinkyRepos(repoNames = getGitRepoNames(), {
    defaultSkillsRepoName,
    sourceOutcomes = null,
} = {}) {
    const defaultSkillsRepoNames = defaultSkillsRepoName
        ? [String(defaultSkillsRepoName).trim()]
        : DEFAULT_SKILLS_REPO_NAMES;
    const refreshed = [];
    const skipped = [];
    const failed = [];
    const records = [];

    for (const repoName of repoNames) {
        for (const sourceRepoName of defaultSkillsRepoNames) {
            const repoNameLabel = String(repoName || '').trim();
            try {
                const result = refreshDefaultSkillsInPloinkyRepo(repoNameLabel, {
                    defaultSkillsRepoName: sourceRepoName,
                    sourceOutcomes,
                });
                if (result.refreshed) {
                    refreshed.push(result);
                } else {
                    skipped.push(result);
                }
                records.push(defaultSkillsRecord({ ...result, defaultSkillsRepoName: sourceRepoName }));
            } catch (err) {
                failed.push({
                    repoName: repoNameLabel,
                    defaultSkillsRepoName: sourceRepoName,
                    message: err?.message || String(err),
                });
                records.push(defaultSkillsRecord({ repoName: repoNameLabel, defaultSkillsRepoName: sourceRepoName, error: err }));
            }
        }
    }

    return {
        defaultSkillsRepoName: defaultSkillsRepoNames.length === 1 ? defaultSkillsRepoNames[0] : null,
        defaultSkillsRepoNames,
        total: repoNames.length * defaultSkillsRepoNames.length,
        refreshed,
        skipped,
        failed,
        records,
    };
}

// Folders (core spelling) whose private exclusions a container run could not
// publish. The host refreshes them with skillsSvc.refreshExportExclusions.
const DEFERRED_EXCLUSION_CODE = 'exclusions-executor-view-unverified';
function deferredExclusionFolders(results) {
    return [...new Set(results
        .filter(result => result?.exclusions?.code === DEFERRED_EXCLUSION_CODE)
        .map(result => path.resolve(result.destRoot || result.repoPath)))];
}

function logRepoUpdateSuccess(repoName, result, indent = '') {
    if (result?.recloned) {
        console.log(`${indent}✓ ${repoName} (cloned into its empty managed directory)`);
        return;
    }
    console.log(`${indent}✓ ${repoName}`);
}

// ---------------------------------------------------------------------------
// The update operation set (P11a)
//
// Every checkout is updated at most once per command. The set is built from
// registered repositories and workspace discoveries before any Git command
// runs. Checkouts are deduplicated by physical identity (canonical path, then
// device+inode for bind aliases); distinct linked worktrees stay separate. A
// registered identity wins over a generic discovery, and a registered update
// that was skipped or failed is never retried through the generic loop.

function physicalIdentity(target) {
    let canonical = null;
    try { canonical = fs.realpathSync(target); } catch (_) {}
    let inode = null;
    try {
        const stat = fs.statSync(target, { bigint: true });
        inode = `${String(stat.dev)}:${String(stat.ino)}`;
    } catch (_) {}
    return { path: path.resolve(target), canonical, inode };
}

function sameIdentity(first, second) {
    if (first.path === second.path) return true;
    if (first.canonical && first.canonical === second.canonical) return true;
    return Boolean(first.inode && first.inode === second.inode);
}

function findOperation(operations, identity) {
    return operations.find(operation => sameIdentity(operation.identity, identity)) || null;
}

function buildRegisteredOperations(repoNames) {
    const operations = [];
    for (const name of repoNames) {
        let repoPath;
        try {
            repoPath = resolveAgentRepositoryPath(name);
        } catch (_) {
            continue;
        }
        const identity = physicalIdentity(repoPath);
        const existing = findOperation(operations, identity);
        if (existing) {
            existing.aliases.push(name);
            continue;
        }
        operations.push({ kind: 'registered', name, path: repoPath, identity, aliases: [] });
    }
    return operations;
}

function buildWorkspaceOperations(discovered, registered, excludedPaths) {
    const operations = [];
    for (const repo of discovered) {
        if (excludedPaths.some(excluded => pathsReferToSameLocation(repo.path, excluded))) continue;
        const identity = physicalIdentity(repo.path);
        const owner = findOperation(registered, identity);
        if (owner) {
            owner.aliases.push(repo.path);
            continue;
        }
        const existing = findOperation(operations, identity);
        if (existing) {
            existing.aliases.push(repo.path);
            continue;
        }
        operations.push({ kind: 'workspace', name: repo.name, path: repo.path, identity, aliases: [] });
    }
    return operations;
}

function recordLabel(operation) {
    return operation.aliases.length
        ? `${operation.name} (also ${operation.aliases.join(', ')})`
        : operation.name;
}

/**
 * Execute one operation, classify its record into the legacy counters and
 * log it. Returns the record.
 */
function executeGitOperation(operation, records, indent = '  ') {
    let record;
    let result = null;
    try {
        if (operation.kind === 'registered') {
            record = reposSvc.updateRegisteredRepository(operation.name);
        } else {
            record = reposSvc.updateWorkspaceRepository(operation.path, {
                id: operation.path,
                aliases: operation.aliases.map(String),
            });
        }
        result = { recloned: record?.details?.recloned === true };
    } catch (err) {
        const message = err?.message || String(err);
        record = err?.record || createOperationRecord({
            phase: operation.kind === 'registered' ? 'registered-repository' : 'workspace-repository',
            id: operation.kind === 'registered' ? operation.name : operation.path,
            outcome: 'failed',
            code: 'update-error',
            reason: message,
            details: { checkout: { path: operation.path }, aliases: operation.aliases.map(String) },
        });
    }
    if (operation.delegatedWorkspacePloinky) {
        record = createOperationRecord({ ...record, required: true,
            details: { ...(record.details || {}), requirementFixed: true, delegatedWorkspacePloinky: true } });
    }
    records.push(record);
    const label = recordLabel(operation);
    if (record.outcome === 'changed' || record.outcome === 'unchanged') {
        logRepoUpdateSuccess(operation.name, result, indent);
        if (operation.aliases.length) console.log(`${indent}  (same checkout as ${operation.aliases.join(', ')})`);
    } else if (record.outcome === 'skipped' || record.outcome === 'deferred') {
        console.warn(`${indent}- ${label}: skipped update (${record.code}): ${record.reason}`);
    } else {
        console.error(`${indent}✗ ${label}: ${record.reason}`);
    }
    return record;
}

function logSkippedSummary(skipped) {
    if (!skipped.length) return;
    console.log(`Update skipped: ${skipped.map(entry => `${entry.repoName} (${entry.code || 'skipped'})`).join(', ')}`);
}

// The running Ploinky checkout is reported but is not one of the graph's
// required inputs (selected scopes, link-install repositories, manifests,
// skills sources, pins and AgentLib), so its record is `required: false`: a
// named skip (dirty, diverged, detached, deferred) does not block activation,
// while a failed or uncertain self-update still makes the exit nonzero through
// the error rule. The host side applies the same rule to its own checkout.
function selfUpdateRecord(selfUpdate, repoPath) {
    if (!selfUpdate) return null;
    const id = selfUpdate.repoPath || repoPath;
    const fixed = { requirementFixed: true };
    if (selfUpdate.record) {
        return createOperationRecord({
            ...selfUpdate.record,
            attempted: selfUpdate.record.attempted,
            required: false,
            details: { ...(selfUpdate.record.details || {}), ...fixed },
        });
    }
    if (selfUpdate.deferred) {
        return createOperationRecord({
            phase: 'host-ploinky', id, outcome: 'deferred', code: 'interactive-session', required: false,
            reason: 'a newer Ploinky version is available; close this session and run `ploinky update` from a shell',
            details: fixed,
        });
    }
    if (selfUpdate.skipped) {
        const code = selfUpdate.boxed ? 'owned-by-host'
            : selfUpdate.scopeExcluded ? 'scope-excluded' : 'not-a-git-checkout';
        return createOperationRecord({
            phase: 'host-ploinky', id, outcome: 'skipped', code, required: false,
            reason: selfUpdate.reason || 'not applicable',
            details: fixed,
        });
    }
    if (selfUpdate.updateAvailable === false) {
        return createOperationRecord({
            phase: 'host-ploinky', id, outcome: 'unchanged', attempted: false, code: 'current', required: false,
            reason: 'no newer Ploinky version is available',
            details: fixed,
        });
    }
    return null;
}

function validateUpdateFolder(projectsRoot) {
    let stat = null;
    try { stat = fs.statSync(projectsRoot); } catch (_) {}
    if (!stat?.isDirectory()) {
        throw new UpdateRequestError(`Search root '${projectsRoot}' is not a directory.`, 'PLOINKY_UPDATE_SCOPE_MISSING');
    }
    return resolveUpdateFolderScope(projectsRoot, PLOINKY_WORKSPACE_ROOT);
}

/**
 * Advance the one achillesAgentLib source. Dependency caches are not touched
 * here; the lifecycle command that admits a runtime prepares its cache.
 *
 * A local workspace checkout is never pulled or reset — Ploinky reports what it
 * finds there and the developer owns it. A managed source advances only by
 * staging a new immutable generation. Either way the fingerprint change is what
 * forces a coherent restart, not an in-place package refresh.
 */
async function refreshAgentLibSourceForUpdate({
    branchPolicy = null,
    insideBox = isInsideBoxRuntime(),
    interactiveSession = false,
    updateSource = updateWorkspaceAgentLibSource,
} = {}) {
    const id = 'achillesAgentLib';
    if (insideBox) {
        // The outer host supervisor is the one source writer. An in-Box update
        // must not take the source lock, clone, fetch, or rewrite active.json.
        console.log('achillesAgentLib source: owned by the outer host; run `ploinky update` there.');
        return {
            result: null,
            record: createOperationRecord({
                phase: 'agentlib', id, outcome: 'deferred', code: 'owned-by-host', required: false,
                reason: 'the outer host owns the achillesAgentLib source',
                details: { requirementFixed: true },
            }),
        };
    }
    if (interactiveSession) {
        console.log('achillesAgentLib source: update deferred; close this session and run `ploinky-local update` from your shell.');
        return {
            result: null,
            record: createOperationRecord({
                phase: 'agentlib', id, outcome: 'deferred', code: 'interactive-session', required: false,
                reason: 'achillesAgentLib is not updated inside an interactive session',
                details: { requirementFixed: true },
            }),
        };
    }
    console.log('Updating the achillesAgentLib source...');
    try {
        const result = await updateSource({
            workspaceRoot: PLOINKY_WORKSPACE_ROOT,
            branchPolicy,
        });
        const where = result.mode === 'local'
            ? `local checkout ${result.selection.sourceRelativePath}`
            : `managed generation ${result.selection.resolvedCommit?.slice(0, 12) || 'unknown'}`;
        console.log(`  ✓ ${where} (${result.selection.contentFingerprint.slice(0, 12)})`);
        if (result.changed) {
            console.log('  ✓ achillesAgentLib content changed; activation follows only when every required input is verified.');
        }
        return {
            result,
            record: createOperationRecord({
                phase: 'agentlib', id, outcome: result.changed ? 'changed' : 'unchanged', attempted: true, required: true,
                code: result.mode === 'local' ? 'local-checkout' : 'managed-generation',
                reason: where,
                before: { fingerprint: result.previous?.contentFingerprint || null },
                after: { fingerprint: result.selection.contentFingerprint, commit: result.selection.resolvedCommit || null },
                details: { requirementFixed: true, mode: result.mode },
            }),
        };
    } catch (err) {
        const message = err?.message || String(err);
        console.error(`  ✗ achillesAgentLib: ${message}`);
        return {
            result: null,
            record: createOperationRecord({
                phase: 'agentlib', id, outcome: 'failed', attempted: true, required: true,
                code: String(err?.code || 'agentlib-update-failed'), reason: message,
                details: { requirementFixed: true },
            }),
        };
    }
}

function logDefaultSkillSummary(summary, indent = '') {
    const refreshedCount = summary?.refreshed?.length || 0;
    const skippedCount = summary?.skipped?.length || 0;
    const failedCount = summary?.failed?.length || 0;
    if (!refreshedCount && !failedCount) return;

    console.log(`${indent}Default skills summary: ${refreshedCount}/${summary.total} repo(s) refreshed.`);
    if (skippedCount) {
        console.log(`${indent}Default skills skipped: ${skippedCount} repo(s).`);
    }
    if (failedCount) {
        console.log(`${indent}Default skills failed: ${failedCount} repo(s).`);
    }
}

function logUpdateFailures(failed) {
    if (!failed.length) return;
    console.error(`Update completed with ${failed.length} error(s):`);
    for (const entry of failed) {
        const source = entry.defaultSkillsRepoName ? ` (source: ${entry.defaultSkillsRepoName})` : '';
        console.error(sanitizeGitDiagnostic(`  ✗ ${entry.repoName}${source}: ${entry.message}`));
        if (entry.manifestPath) console.error(`    Manifest: ${entry.manifestPath}`);
    }
}

function getAgentNames() {
    const summary = collectAgentsSummary();
    if (!summary.length) return [];

    const catalog = [];
    for (const item of summary) {
        if (!item || !Array.isArray(item.agents)) continue;
        for (const agent of item.agents) {
            if (agent && agent.name) {
                catalog.push({ repo: agent.repo, name: agent.name });
            }
        }
    }

    if (!catalog.length) return [];

    const counts = {};
    for (const agent of catalog) {
        counts[agent.name] = (counts[agent.name] || 0) + 1;
    }

    const suggestions = new Set();
    for (const agent of catalog) {
        const repoName = agent.repo || '';
        if (repoName) {
            suggestions.add(`${repoName}/${agent.name}`);
            suggestions.add(`${repoName}:${agent.name}`);
        }
        if (counts[agent.name] === 1) {
            suggestions.add(agent.name);
        }
    }

    return Array.from(suggestions).sort();
}

function installRepo(repoUrl, repoName = null, branch = null) {
    if (!repoUrl) { showHelp(); throw new Error('Missing repository URL or known repository name.'); }
    const res = reposSvc.installRepo(repoUrl, repoName, branch);
    const name = res.name || repoName || reposSvc.deriveRepoNameFromUrl(repoUrl);
    if (res.status === 'exists') console.log(`✓ Repository '${name}' already installed.`);
    else {
        const branchNote = branch ? ` (branch: ${branch})` : '';
        console.log(`✓ Repository '${name}' installed successfully${branchNote}.`);
    }
}

function addRepo(repoUrl, repoName = null, branch = null) {
    return installRepo(repoUrl, repoName, branch);
}

function enableRepo(repoName, branch = null) {
    if (!repoName) throw new Error('Usage: enable repo <name> [--branch <branch>]');
    const result = reposSvc.enableRepo(repoName, { branch });
    const branchNote = result.branch && result.branch !== 'default' ? ` (branch: ${result.branch})` : '';
    console.log(`✓ Repository '${result.name}' enabled${branchNote}.`);
    return result;
}

function disableRepo(repoName) {
    if (!repoName) throw new Error('Usage: disable repo <name>');
    const result = reposSvc.disableRepo(repoName);
    if (result.status === 'disabled') {
        console.log(`✓ Repository '${result.name}' disabled.`);
    } else {
        console.log(`Repository '${result.name}' is not enabled in this workspace.`);
    }
    return result;
}

function uninstallRepo(target) {
    if (!target) throw new Error('Usage: uninstall repo <name|url>');
    const repoName = reposSvc.resolveInstalledRepoTarget(target);
    const agents = workspaceSvc.loadAgents();
    const containerNames = Object.entries(agents || {})
        .filter(([, record]) => record && record.type === 'agent' && record.repoName === repoName && record.agentName)
        .map(([containerName]) => containerName);
    const disabledAgents = agentsSvc.disableAgentContainers(containerNames);
    const result = reposSvc.uninstallRepo(repoName);
    console.log(`✓ Repository '${repoName}' uninstalled.`);
    return { ...result, disabledAgents };
}

// Graph closure for the records of one command. The prior graph is read
// before any mutation; the proposed graph after every Git phase.
function readGraphSafely() {
    try {
        return readUpdateGraph();
    } catch (error) {
        return { determinable: false, errors: [String(error?.message || error)], repositories: new Set(),
            repositoryPaths: new Set(), linkInstallNames: new Set(), linkInstallPaths: new Set() };
    }
}

function finishUpdateResult({ command, records, prior, agentLib = null, extra = {} }) {
    const proposed = readGraphSafely();
    const closed = applyGraphRequirements(records, { prior, proposed });
    return buildCoreUpdateResult({ command, records: closed, agentLib, extra });
}

/**
 * `update repo <name>` as an update result (never throws for an outcome).
 */
async function updateRepoResult(repoName, { command = ['update', 'repo', repoName] } = {}) {
    if (!repoName) throw new Error('Usage: update repo <name>');
    const prior = readGraphSafely();
    const records = [];
    let record;
    try {
        const result = reposSvc.updateRepo(repoName);
        record = result?.record;
        if (result?.recloned) {
            console.log(`✓ Repo '${repoName}' cloned into its empty managed directory.`);
        } else if (record?.outcome === 'unchanged') {
            console.log(`✓ Repo '${repoName}' is up to date.`);
        } else {
            console.log(`✓ Repo '${repoName}' updated.`);
        }
    } catch (err) {
        record = err?.record || createOperationRecord({
            phase: 'registered-repository', id: String(repoName), outcome: 'failed',
            code: String(err?.code || 'update-error'), reason: err?.message || String(err),
        });
        console.error(`✗ Repo '${repoName}': ${record.reason}`);
    }
    records.push(record);
    records.push(...(await refreshUpdateGitPins({ repositoryNames: [repoName], sourceOutcomes: records })).records);
    const sourceOutcomes = [record];
    let defaultSkills = null;
    if (record.outcome === 'changed' || record.outcome === 'unchanged') {
        // achillesAgentLib is not a per-repository npm package any more: it is
        // the one workspace-selected source, advanced by `ploinky update`.
        defaultSkills = refreshDefaultSkillsInPloinkyRepos([repoName], { sourceOutcomes });
        logDefaultSkillSummary(defaultSkills, '  ');
        records.push(...defaultSkills.records);
    }
    // Targeted refresh of the manifest consumers of this source, each with its
    // complete owner set. Nothing is pulled; a skipped/failed source is used as
    // it is without pruning and an uncertain one retains every output.
    let skillConsumers = null;
    const checkout = record.details?.checkout?.path;
    if (checkout) {
        skillConsumers = skillsSvc.refreshSkillConsumersForSource({
            folders: skillsSvc.findWorkspaceFoldersWithSkillsManifest(PLOINKY_WORKSPACE_ROOT),
            sourcePath: checkout,
            sourceOutcomes,
        });
        for (const result of skillConsumers.refreshed) {
            records.push(skillsManifestRecord({
                folder: result.destRoot, manifestPath: result.manifestPath,
                label: path.relative(PLOINKY_WORKSPACE_ROOT, result.destRoot) || path.basename(result.destRoot), result,
            }));
            console.log(`  ✓ skills consumer ${result.destRoot}: ${result.skills.length} skill(s)`);
        }
        for (const failure of skillConsumers.failed) {
            records.push(skillsManifestRecord({
                folder: failure.folder, manifestPath: failure.manifestPath,
                label: path.relative(PLOINKY_WORKSPACE_ROOT, failure.folder) || path.basename(failure.folder),
                error: new Error(failure.message),
            }));
            console.error(`  ✗ skills consumer ${failure.folder}: ${failure.message}`);
        }
    }
    return finishUpdateResult({
        command,
        records,
        prior,
        extra: {
            defaultSkills,
            record,
            skillConsumers,
            deferredExclusionFolders: deferredExclusionFolders([
                ...(defaultSkills?.refreshed || []),
                ...(skillConsumers?.refreshed || []),
            ]),
        },
    });
}

// Throwing form kept for existing callers: rejects with the records attached
// when the update is not complete.
async function updateRepo(repoName) {
    const result = await updateRepoResult(repoName);
    if (result.exitCode === 0) return result;
    const repoRecord = result.record;
    let message;
    if (repoRecord && !['changed', 'unchanged'].includes(repoRecord.outcome)) {
        message = repoRecord.reason;
    } else if (result.defaultSkills?.failed?.length) {
        message = `Failed to refresh default skills in ${result.defaultSkills.failed.map(entry => entry.repoName).join(', ')}`;
    } else {
        message = result.blockedBy.map(entry => `${entry.phase} ${entry.id} ${entry.outcome}`).join(', ') || result.status;
    }
    const error = new Error(`update repo failed: ${message}`);
    error.code = 'PLOINKY_UPDATE_INCOMPLETE';
    error.record = repoRecord;
    error.records = result.records;
    error.result = result;
    throw error;
}

async function updatePloinkyRepos(options = {}) {
    const prior = readGraphSafely();
    const ploinkyRepos = getGitRepoNames();
    const operations = buildRegisteredOperations(ploinkyRepos);
    const records = [];
    const agentLib = await refreshAgentLibSourceForUpdate({
        branchPolicy: options.agentLibBranchPolicy || null,
        interactiveSession: options.interactiveSession === true,
        insideBox: options.insideBox ?? isInsideBoxRuntime(),
    });
    records.push(agentLib.record);

    if (operations.length) {
        console.log('Updating ploinky repositories...');
        for (const operation of operations) executeGitOperation(operation, records);
    } else {
        console.log('No ploinky repositories installed.');
    }

    records.push(...(await refreshUpdateGitPins({ repositoryNames: ploinkyRepos, sourceOutcomes: records })).records);

    // The skills phase consumes the operation records; it never pulls again.
    const defaultSkills = refreshDefaultSkillsInPloinkyRepos(ploinkyRepos, { sourceOutcomes: [...records] });
    logDefaultSkillSummary(defaultSkills);
    records.push(...defaultSkills.records);

    const result = finishUpdateResult({
        command: options.command || ['update', 'repos'],
        records,
        prior,
        agentLib: agentLib.result,
        extra: { defaultSkills, deferredExclusionFolders: deferredExclusionFolders(defaultSkills.refreshed) },
    });
    const repositoryRecords = result.records.filter(record => record.phase === 'registered-repository');
    const verified = repositoryRecords.filter(record => record.outcome === 'changed' || record.outcome === 'unchanged').length;
    console.log(`Ploinky repository update summary: ${verified}/${operations.length} repositories updated.`);
    logSkippedSummary(result.skipped);
    logUpdateFailures(result.failed);
    return { ...result, total: operations.length, updated: verified };
}

async function updateAllRepos(folderPath, options = {}) {
    const projectsRoot = resolveUpdateProjectsRoot(folderPath);
    // An explicit folder is validated against the selected workspace before
    // any mutation, including the Ploinky self-update.
    if (typeof folderPath === 'string' && folderPath.trim()) validateUpdateFolder(projectsRoot);
    const prior = readGraphSafely();
    const ploinkyRoot = resolvePloinkyRoot();
    const runtimeAgentLibSource = agentLibRoot();
    const hostUpdatedWorkspaceCheckout = String(
        process.env[PLOINKY_UPDATED_WORKSPACE_CHECKOUT_ENV] || '',
    ).trim();
    // Build the complete operation set before executing anything. The AgentLib
    // selection made by the refresh below is excluded again after it runs.
    const discoveredWorkspaceRepos = reposSvc.findWorkspaceGitRepos(projectsRoot);
    let delegatedWorkspacePloinky = null;
    if (options.delegatedWorkspacePloinkyPath !== undefined && options.delegatedWorkspacePloinkyPath !== null) {
        if (typeof options.delegatedWorkspacePloinkyPath !== 'string' || !path.isAbsolute(options.delegatedWorkspacePloinkyPath)) {
            throw new UpdateRequestError('Delegated workspace Ploinky path must be an absolute workspace path.', 'PLOINKY_UPDATE_SCOPE_INVALID');
        }
        delegatedWorkspacePloinky = validateUpdateFolder(options.delegatedWorkspacePloinkyPath).canonicalFolder;
        // The requested folder may be below this checkout. Downward discovery
        // cannot find its ancestor; the host delegates this exact validated path.
        discoveredWorkspaceRepos.push({ name: path.basename(delegatedWorkspacePloinky), path: delegatedWorkspacePloinky });
    }
    const baseExclusions = [ploinkyRoot, hostUpdatedWorkspaceCheckout, runtimeAgentLibSource].filter(Boolean);
    const workspaceManifestFolders = skillsSvc.findWorkspaceFoldersWithSkillsManifest(projectsRoot)
        .filter(folderPath => !pathsReferToSameLocation(folderPath, ploinkyRoot))
        .filter(folderPath => {
            const hasManifest = skillsSvc.findSkillsManifestPath(folderPath);
            return Boolean(hasManifest);
        });
    const ploinkyRepos = getGitRepoNames();
    const registeredOperations = buildRegisteredOperations(ploinkyRepos);
    // Declared manifest sources join the one operation set; a checkout already
    // covered by a registered or discovered operation is not added twice.
    const declaredSources = skillsSvc.listDeclaredSkillSources(workspaceManifestFolders)
        .filter(source => source.exists && !source.error)
        .map(source => ({ name: source.name, path: source.checkoutPath }));
    let workspaceOperations = buildWorkspaceOperations(
        [...discoveredWorkspaceRepos, ...declaredSources], registeredOperations, baseExclusions,
    );
    if (delegatedWorkspacePloinky) {
        for (const operation of [...registeredOperations, ...workspaceOperations]) {
            if (pathsReferToSameLocation(operation.path, delegatedWorkspacePloinky)) operation.delegatedWorkspacePloinky = true;
        }
    }
    const records = [];

    console.log('Updating Ploinky...');
    let selfUpdate = null;
    try {
        selfUpdate = await (options.updateSelf || updatePloinkySelf)({
            repoPath: ploinkyRoot,
            updateScopePath: projectsRoot,
            interactiveSession: options.interactiveSession === true,
        });
        const record = selfUpdateRecord(selfUpdate, ploinkyRoot);
        if (record) records.push(record);
        if (selfUpdate.deferred) {
            console.log('  - Ploinky self-update deferred; continuing repository and skills update.');
        } else if (selfUpdate.skipped) {
            console.log(`  - skipped (${selfUpdate.reason || 'not available'})`);
        } else if (selfUpdate.updated) {
            console.log('  ✓ Ploinky updated.');
        } else {
            console.log('  ✓ Ploinky already up to date.');
        }
    } catch (err) {
        const message = err?.message || String(err);
        const base = err?.record || { phase: 'host-ploinky', id: ploinkyRoot, outcome: 'failed', code: 'self-update-error', reason: message };
        records.push(createOperationRecord({ ...base, attempted: base.attempted ?? true, required: false, details: { ...(base.details || {}), requirementFixed: true } }));
        console.error(`  ✗ Ploinky: ${message}`);
    }

    const agentLib = await refreshAgentLibSourceForUpdate({
        branchPolicy: options.agentLibBranchPolicy || null,
        interactiveSession: options.interactiveSession === true,
        insideBox: options.insideBox ?? isInsideBoxRuntime(),
    });
    records.push(agentLib.record);

    // AgentLib has one source owner. The runtime source may also be visible at
    // a workspace bind mount, and a host refresh may have selected a new source.
    // Neither belongs in the generic Git update loop.
    const selectedAgentLibSource = agentLib.result?.selection?.sourceDir;
    if (selectedAgentLibSource) {
        workspaceOperations = workspaceOperations.filter(operation =>
            !pathsReferToSameLocation(operation.path, selectedAgentLibSource));
    }

    if (registeredOperations.length) {
        console.log('Updating ploinky repositories...');
        for (const operation of registeredOperations) executeGitOperation(operation, records);
    }

    if (workspaceOperations.length) {
        console.log(`Updating workspace repositories in ${projectsRoot}...`);
        for (const operation of workspaceOperations) executeGitOperation(operation, records);
    }

    records.push(...(await refreshUpdateGitPins({ repositoryNames: ploinkyRepos, sourceOutcomes: records })).records);

    // The skills phases consume the operation records; they never pull again.
    const sourceOutcomes = [...records];
    const defaultSkills = refreshDefaultSkillsInPloinkyRepos(ploinkyRepos, { sourceOutcomes });
    logDefaultSkillSummary(defaultSkills);
    records.push(...defaultSkills.records);
    const manifestResults = [];

    if (workspaceManifestFolders.length) {
        console.log('Installing skills from folders containing ploinky-skills-manifest.json...');
        console.log(`  Found ${workspaceManifestFolders.length} skills manifest folder(s) under ${projectsRoot}.`);
        for (const manifestFolder of workspaceManifestFolders) {
            const manifestPath = skillsSvc.findSkillsManifestPath(manifestFolder);
            const folderLabel = path.relative(projectsRoot, manifestFolder) || path.basename(manifestFolder);
            try {
                const result = skillsSvc.installSkillsFromManifest(manifestPath, {
                    targetRoot: manifestFolder,
                    pruneMissing: true,
                    sourceOutcomes,
                });
                manifestResults.push(result);
                for (const entry of result.prunedSkills || []) {
                    console.log(`    Removed missing skill '${entry.skill}' from '${entry.repository}' in the manifest.`);
                }
                const reposLabel = result.repoCount ? ` from ${result.repoCount} repos` : '';
                const skillNames = result.skills.join(', ');
                console.log(`  ✓ ${folderLabel}: ${result.skills.length} skill(s)${reposLabel} (${skillNames})`);
                if (result.duplicateSkills?.length) {
                    const duplicates = result.duplicateSkills
                        .map((entry) => `  - ${entry.skill}: ${entry.previousSource} -> ${entry.chosenSource}`)
                        .join('\n');
                    console.log(`    duplicate skills resolved by manifest order:\n${duplicates}`);
                }
                if (result.gitignoreUpdated) {
                    console.log(`    .gitignore updated`);
                }
                records.push(skillsManifestRecord({ folder: manifestFolder, manifestPath, label: folderLabel, result }));
            } catch (err) {
                const message = err?.message || String(err);
                records.push(skillsManifestRecord({ folder: manifestFolder, manifestPath, label: folderLabel, error: err }));
                console.error(`  ✗ ${folderLabel} skills: ${message}`);
            }
        }
    } else {
        console.log(`No ploinky-skills-manifest.json files found under ${projectsRoot}.`);
    }

    const result = finishUpdateResult({
        command: options.command || ['update', ...(folderPath ? ['all', projectsRoot] : [])],
        records,
        prior,
        agentLib: agentLib.result,
        extra: {
            selfUpdate,
            defaultSkills,
            deferredExclusionFolders: deferredExclusionFolders([...defaultSkills.refreshed, ...manifestResults]),
        },
    });
    // A skipped or deferred self-update was never attempted, so it is neither a
    // success nor a failure; a self-update that threw still counts as failed.
    const selfUpdateNotAttempted = selfUpdate?.skipped === true || selfUpdate?.deferred === true;
    const selfUpdateNote = selfUpdateNotAttempted
        ? ` (Ploinky self-update ${selfUpdate.deferred ? 'deferred' : 'skipped'})`
        : '';
    console.log(`Update summary: ${result.updated}/${result.total} update operations succeeded${selfUpdateNote}.`);
    logSkippedSummary(result.skipped);
    logUpdateFailures(result.failed);
    return result;
}

function pathsReferToSameLocation(first, second) {
    if (path.resolve(first) === path.resolve(second)) return true;
    try {
        if (fs.realpathSync(first) === fs.realpathSync(second)) return true;
    } catch (_) {}
    try {
        // Separate bind mounts have different realpaths but share file identity.
        const firstStat = fs.statSync(first, { bigint: true });
        const secondStat = fs.statSync(second, { bigint: true });
        return firstStat.dev === secondStat.dev && firstStat.ino === secondStat.ino;
    } catch (_) { return false; }
}

function resolveUpdateProjectsRoot(folderPath) {
    const explicitRoot = typeof folderPath === 'string' ? folderPath.trim() : '';
    if (explicitRoot) return path.resolve(explicitRoot);
    return process.cwd();
}

async function enableAgent(agentName, mode, repoNameParam, alias, authMode) {
    if (!agentName) throw new Error('Usage: enable agent <name|repo/name> [isolated|global|devel [repoName]] [--auth none|guest|sso] [as <alias>]');
    const { shortAgentName, repoName, alias: resolvedAlias, auth } = await agentsSvc.enableAgent(agentName, mode, repoNameParam, alias, authMode);
    const aliasNote = resolvedAlias ? ` as '${resolvedAlias}'` : '';
    const authLabel = auth?.mode || 'none';
    console.log(`✓ Agent '${shortAgentName}' from repo '${repoName}' enabled and started${aliasNote} with auth '${authLabel}'.`);
}

function findAgentManifest(agentName) {
    const { manifestPath } = findAgent(agentName);
    return manifestPath;
}

export {
    getRepoNames,
    getAgentNames,
    installRepo,
    addRepo,
    enableRepo,
    disableRepo,
    uninstallRepo,
    updateRepo,
    updateRepoResult,
    updatePloinkyRepos,
    updateAllRepos,
    refreshDefaultSkillsInPloinkyRepos,
    resolveUpdateProjectsRoot,
    enableAgent,
    findAgentManifest,
};
