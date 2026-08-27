import fs from 'fs';
import path from 'path';
import { PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT } from '../utils/config.js';
import { showHelp } from './help.js';
import * as reposSvc from '../utils/repos.js';
import * as agentsSvc from '../utils/agents.js';
import * as skillsSvc from './skills.js';
import * as workspaceSvc from '../utils/workspace.js';
import {
    resolveMovingGitDepCommits,
    resolvePloinkyRoot,
    updatePloinkySelf,
} from './updateService.js';
import { invalidateDepsCacheForMovingGitDeps } from '../utils/dependencies/dependencyCache.js';
import { readGlobalDepsPackage } from '../utils/dependencies/dependencyInstaller.js';
import { collectAgentsSummary } from '../utils/status.js';
import { findAgent } from '../utils/utils.js';
import { updateWorkspaceAgentLibSource } from '../../ploinky-box/agentlib-source.mjs';
import { isInsideBoxRuntime } from '../../agentlib/bootstrap.mjs';

const REPOS_DIR = path.join(PLOINKY_DIR, 'repos');
const DEFAULT_SKILLS_REPO_NAMES = [
    'AchillesCopilotBasicSkills',
    'DocumentationSkills',
    'PloinkySkills',
];
function getRepoNames() {
    if (!fs.existsSync(REPOS_DIR)) return [];
    return fs.readdirSync(REPOS_DIR).filter(file => fs.statSync(path.join(REPOS_DIR, file)).isDirectory());
}

function getGitRepoNames() {
    const repoNames = getRepoNames();
    const gitRepoNames = [];
    for (const repoName of repoNames) {
        const repoPath = path.join(REPOS_DIR, repoName);
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
    return { repoName: normalizedRepoName, repoPath };
}

function refreshDefaultSkillsInPloinkyRepo(repoName, {
    defaultSkillsRepoName = DEFAULT_SKILLS_REPO_NAMES[0],
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

    const result = skillsSvc.installDefaultSkills(normalizedDefaultSkillsRepoName, {
        targetRoot: repoPath,
    });

    return {
        repoName: normalizedRepoName,
        repoPath,
        skills: result.skills,
        gitignoreUpdated: result.gitignoreUpdated,
        claudeLink: result.claudeLink,
        refreshed: true,
    };
}

function refreshDefaultSkillsInPloinkyRepos(repoNames = getGitRepoNames(), {
    defaultSkillsRepoName,
} = {}) {
    const defaultSkillsRepoNames = defaultSkillsRepoName
        ? [String(defaultSkillsRepoName).trim()]
        : DEFAULT_SKILLS_REPO_NAMES;
    const refreshed = [];
    const skipped = [];
    const failed = [];

    for (const repoName of repoNames) {
        for (const sourceRepoName of defaultSkillsRepoNames) {
            const repoNameLabel = String(repoName || '').trim();
            try {
                const result = refreshDefaultSkillsInPloinkyRepo(repoNameLabel, {
                    defaultSkillsRepoName: sourceRepoName,
                });
                if (result.refreshed) {
                    refreshed.push(result);
                } else {
                    skipped.push(result);
                }
            } catch (err) {
                failed.push({
                    repoName: repoNameLabel,
                    defaultSkillsRepoName: sourceRepoName,
                    message: err?.message || String(err),
                });
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
    };
}

function logRepoUpdateSuccess(repoName, result, indent = '') {
    if (result?.recloned) {
        console.log(`${indent}✓ ${repoName} (repaired by recloning)`);
        return;
    }
    console.log(`${indent}✓ ${repoName}`);
}

function formatWorkspaceRepoSkip(repo, remoteCheck) {
    const location = remoteCheck?.remoteUrl ? ` (${remoteCheck.remoteUrl})` : '';
    const reason = remoteCheck?.reason || 'remote unavailable';
    return `  - ${repo.name}: skipped update, ${reason}${location}`;
}

/**
 * Advance the one achillesAgentLib source and the npm dependency caches.
 *
 * A local workspace checkout is never pulled or reset — Ploinky reports what it
 * finds there and the developer owns it. A managed source advances only by
 * staging a new immutable generation. Either way the fingerprint change is what
 * forces a coherent restart, not an in-place package refresh.
 */
async function refreshAgentLibSourceForUpdate(failed, {
    branchPolicy = null,
    insideBox = isInsideBoxRuntime(),
    interactiveSession = false,
} = {}) {
    if (insideBox) {
        // The outer host supervisor is the one source writer. An in-Box update
        // must not take the source lock, clone, fetch, or rewrite active.json.
        console.log('achillesAgentLib source: owned by the outer host; run `ploinky update` there.');
        return null;
    }
    if (interactiveSession) {
        console.log('achillesAgentLib source: update deferred; close this session and run `ploinky-local update` from your shell.');
        return null;
    }
    console.log('Updating the achillesAgentLib source...');
    let result = null;
    try {
        result = await updateWorkspaceAgentLibSource({
            workspaceRoot: PLOINKY_WORKSPACE_ROOT,
            branchPolicy,
        });
        const where = result.mode === 'local'
            ? `local checkout ${result.selection.sourceRelativePath}`
            : `managed generation ${result.selection.resolvedCommit?.slice(0, 12) || 'unknown'}`;
        console.log(`  ✓ ${where} (${result.selection.contentFingerprint.slice(0, 12)})`);
        if (result.changed) {
            console.log('  ✓ achillesAgentLib content changed; this update will activate it coherently.');
        }
    } catch (err) {
        const message = err?.message || String(err);
        failed.push({ repoName: 'achillesAgentLib', message });
        console.error(`  ✗ achillesAgentLib: ${message}`);
    }
    // The npm caches under .ploinky/deps are keyed on package.json spec strings,
    // so a moving git ref (mcp-sdk `#main`) that advanced upstream would serve a
    // stale copy. This stays independent of the AgentLib source.
    try {
        const gitDepCommits = resolveMovingGitDepCommits(readGlobalDepsPackage().dependencies);
        const invalidation = invalidateDepsCacheForMovingGitDeps(gitDepCommits);
        if (invalidation.invalidated) {
            const changedLabel = invalidation.changed.length ? invalidation.changed.join(', ') : 'initial';
            console.log(`  ✓ Dependency caches invalidated (moving git deps changed: ${changedLabel}); agents reinstall on next start.`);
        }
    } catch (err) {
        console.error(`  ✗ dependency cache invalidation: ${err?.message || err}`);
    }
    return result;
}

function appendDefaultSkillFailures(failed, summary) {
    if (!summary?.failed?.length) return;
    for (const entry of summary.failed) {
        failed.push({
            repoName: `default skills ${entry.repoName}`,
            message: entry.message,
        });
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

async function updateRepo(repoName) {
    if (!repoName) throw new Error('Usage: update repo <name>');
    try {
        const result = reposSvc.updateRepo(repoName);
        if (result?.recloned) {
            console.log(`✓ Repo '${repoName}' repaired by recloning.`);
        } else {
            console.log(`✓ Repo '${repoName}' updated.`);
        }
        // achillesAgentLib is not a per-repository npm package any more: it is
        // the one workspace-selected source, advanced by `ploinky update`.
        const defaultSkills = refreshDefaultSkillsInPloinkyRepos([repoName]);
        logDefaultSkillSummary(defaultSkills, '  ');
        if (defaultSkills.failed.length) {
            const failedRepos = defaultSkills.failed.map(entry => entry.repoName).join(', ');
            throw new Error(`Failed to refresh default skills in ${failedRepos}`);
        }
    } catch (err) {
        throw new Error(`update repo failed: ${err?.message || err}`);
    }
}

async function updatePloinkyRepos(options = {}) {
    const ploinkyRepos = getGitRepoNames();
    const failed = [];
    let updated = 0;
    const agentLib = await refreshAgentLibSourceForUpdate(failed, {
        branchPolicy: options.agentLibBranchPolicy || null,
        interactiveSession: options.interactiveSession === true,
    });

    if (ploinkyRepos.length) {
        console.log('Updating ploinky repositories...');
        for (const repoName of ploinkyRepos) {
            try {
                const result = reposSvc.updateRepo(repoName);
                logRepoUpdateSuccess(repoName, result, '  ');
                updated += 1;
            } catch (err) {
                const message = err?.message || String(err);
                failed.push({ repoName, message });
                console.error(`  ✗ ${repoName}: ${message}`);
            }
        }
    } else {
        console.log('No ploinky repositories installed.');
    }

    const defaultSkills = refreshDefaultSkillsInPloinkyRepos(ploinkyRepos);
    logDefaultSkillSummary(defaultSkills);
    appendDefaultSkillFailures(failed, defaultSkills);

    console.log(`Ploinky repository update summary: ${updated}/${ploinkyRepos.length} repositories updated.`);

    if (failed.length) {
        const failedNames = failed.map(entry => entry.repoName).join(', ');
        throw new Error(`Failed to update ${failed.length} repository(s): ${failedNames}`);
    }

    return { total: ploinkyRepos.length, updated, failed, agentLib, defaultSkills };
}

async function updateAllRepos(folderPath, options = {}) {
    const projectsRoot = resolveUpdateProjectsRoot(folderPath);
    const ploinkyRoot = resolvePloinkyRoot();
    const workspaceRepos = reposSvc.findWorkspaceGitRepos(projectsRoot)
        .filter(repo => !pathsReferToSameLocation(repo.path, ploinkyRoot));
    const workspaceManifestFolders = skillsSvc.findWorkspaceFoldersWithSkillsManifest(projectsRoot)
        .filter(folderPath => !pathsReferToSameLocation(folderPath, ploinkyRoot))
        .filter(folderPath => {
            const hasManifest = skillsSvc.findSkillsManifestPath(folderPath);
            return Boolean(hasManifest);
        });
    const ploinkyRepos = getGitRepoNames();
    const failed = [];
    const skipped = [];
    let updated = 0;
    let agentLib = null;

    console.log('Updating Ploinky...');
    let selfUpdate = null;
    try {
        selfUpdate = updatePloinkySelf({
            interactiveSession: options.interactiveSession === true,
        });
        if (selfUpdate.deferred) {
            console.log('  - Ploinky self-update deferred; continuing repository and skills update.');
        } else if (selfUpdate.skipped) {
            console.log(`  - skipped (${selfUpdate.reason || 'not available'})`);
        } else if (selfUpdate.updated) {
            console.log('  ✓ Ploinky updated.');
            updated += 1;
        } else {
            console.log('  ✓ Ploinky already up to date.');
            updated += 1;
        }
    } catch (err) {
        const message = err?.message || String(err);
        failed.push({ repoName: 'ploinky', message });
        console.error(`  ✗ Ploinky: ${message}`);
    }

    agentLib = await refreshAgentLibSourceForUpdate(failed, {
        branchPolicy: options.agentLibBranchPolicy || null,
        interactiveSession: options.interactiveSession === true,
    });

    if (ploinkyRepos.length) {
        console.log('Updating ploinky repositories...');
        for (const repoName of ploinkyRepos) {
            try {
                const result = reposSvc.updateRepo(repoName);
                logRepoUpdateSuccess(repoName, result, '  ');
                updated += 1;
            } catch (err) {
                const message = err?.message || String(err);
                failed.push({ repoName, message });
                console.error(`  ✗ ${repoName}: ${message}`);
            }
        }
    }

    if (workspaceRepos.length) {
        console.log(`Updating workspace repositories in ${projectsRoot}...`);
        for (const repo of workspaceRepos) {
            try {
                const remoteCheck = reposSvc.checkGitRemoteReachable(repo.path);
                if (!remoteCheck.reachable) {
                    skipped.push({ repoName: repo.name, ...remoteCheck });
                    console.warn(formatWorkspaceRepoSkip(repo, remoteCheck));
                    continue;
                }
                reposSvc.pullGitRepo(repo.path);
                console.log(`  ✓ ${repo.name}`);
                updated += 1;
            } catch (err) {
                const message = err?.message || String(err);
                failed.push({ repoName: repo.name, message });
                console.error(`  ✗ ${repo.name}: ${message}`);
            }
        }
    }

    const defaultSkills = refreshDefaultSkillsInPloinkyRepos(ploinkyRepos);
    logDefaultSkillSummary(defaultSkills);
    appendDefaultSkillFailures(failed, defaultSkills);

    if (workspaceManifestFolders.length) {
        console.log('Installing skills from folders containing ploinky-skills-manifest.json...');
        console.log(`  Found ${workspaceManifestFolders.length} skills manifest folder(s) under ${projectsRoot}.`);
        for (const manifestFolder of workspaceManifestFolders) {
            const manifestPath = skillsSvc.findSkillsManifestPath(manifestFolder);
            try {
                const result = skillsSvc.installSkillsFromManifest(manifestPath, {
                    targetRoot: manifestFolder,
                });
                const reposLabel = result.repoCount ? ` from ${result.repoCount} repos` : '';
                const skillNames = result.skills.join(', ');
                const folderLabel = path.relative(projectsRoot, manifestFolder) || path.basename(manifestFolder);
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
                updated += 1;
            } catch (err) {
                const message = err?.message || String(err);
                const folderLabel = path.relative(projectsRoot, manifestFolder) || path.basename(manifestFolder);
                failed.push({ repoName: `${folderLabel} skills`, message });
                console.error(`  ✗ ${folderLabel} skills: ${message}`);
            }
        }
    } else {
        console.log(`No ploinky-skills-manifest.json files found under ${projectsRoot}.`);
    }

    const totalRepos = 1 + ploinkyRepos.length + workspaceRepos.length + workspaceManifestFolders.length;
    console.log(`Update summary: ${updated}/${totalRepos} repositories updated.`);
    if (skipped.length) {
        const skippedNames = skipped.map(entry => entry.repoName).join(', ');
        console.log(`Workspace repository update skipped: ${skippedNames}`);
    }
    if (failed.length) {
        const failedNames = failed.map(entry => entry.repoName).join(', ');
        throw new Error(`Failed to update ${failed.length} repository(s): ${failedNames}`);
    }

    return { total: totalRepos, updated, failed, skipped, selfUpdate, agentLib, defaultSkills };
}

function pathsReferToSameLocation(first, second) {
    try {
        return fs.realpathSync(first) === fs.realpathSync(second);
    } catch (_) {
        return path.resolve(first) === path.resolve(second);
    }
}

function resolveUpdateProjectsRoot(folderPath) {
    const explicitRoot = typeof folderPath === 'string' ? folderPath.trim() : '';
    if (explicitRoot) return path.resolve(explicitRoot);
    return process.cwd();
}

async function enableAgent(agentName, mode, repoNameParam, alias, authMode, username, password) {
    if (!agentName) throw new Error('Usage: enable agent <name|repo/name> [isolated|global|devel [repoName]] [--auth none|pwd|sso] [--user <name> --password <value>] [as <alias>]');
    const { shortAgentName, repoName, alias: resolvedAlias, auth } = await agentsSvc.enableAgent(agentName, mode, repoNameParam, alias, authMode, { username, password });
    const aliasNote = resolvedAlias ? ` as '${resolvedAlias}'` : '';
    const authLabel = auth?.mode === 'local' ? 'pwd' : (auth?.mode || 'none');
    console.log(`✓ Agent '${shortAgentName}' from repo '${repoName}' enabled and started${aliasNote} with auth '${authLabel}'.`);
    if (auth?.mode === 'local' && auth.usersVar) {
        console.log(`  Local auth users var: ${auth.usersVar}`);
        if (username) {
            console.log(`  Local auth user set to '${username}'.`);
        }
    }
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
    updatePloinkyRepos,
    updateAllRepos,
    refreshDefaultSkillsInPloinkyRepos,
    resolveUpdateProjectsRoot,
    enableAgent,
    findAgentManifest,
};
