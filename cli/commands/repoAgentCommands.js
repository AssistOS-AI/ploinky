import fs from 'fs';
import path from 'path';
import { PLOINKY_DIR } from '../services/config.js';
import { showHelp } from '../services/help.js';
import * as reposSvc from '../services/repos.js';
import * as agentsSvc from '../services/agents.js';
import * as skillsSvc from '../services/skills.js';
import * as workspaceSvc from '../services/workspace.js';
import {
    refreshAchillesDependenciesInRepos,
    refreshPloinkyRuntimeAchillesDependency,
    resolveMovingGitDepCommits,
    resolvePloinkyRoot,
    updatePloinkySelf,
} from '../services/updateService.js';
import { invalidateDepsCacheForMovingGitDeps } from '../services/dependencyCache.js';
import { readGlobalDepsPackage } from '../services/dependencyInstaller.js';
import { collectAgentsSummary } from '../services/status.js';
import { findAgent } from '../services/utils.js';

const REPOS_DIR = path.join(PLOINKY_DIR, 'repos');
const DEFAULT_SKILLS_REPO_NAME = 'AchillesCopilotBasicSkills';
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

function refreshDefaultSkillsInPloinkyRepo(repoName, {
    defaultSkillsRepoName = DEFAULT_SKILLS_REPO_NAME,
} = {}) {
    const repoNameLabel = String(repoName || '').trim();
    if (!repoNameLabel) {
        return { repoName: repoNameLabel, skipped: true, reason: 'missing repo name' };
    }
    const normalizedRepoName = reposSvc.normalizeRepoName(repoNameLabel);
    const normalizedDefaultSkillsRepoName = reposSvc.normalizeRepoName(defaultSkillsRepoName);
    if (normalizedRepoName === normalizedDefaultSkillsRepoName) {
        return { repoName: normalizedRepoName, skipped: true, reason: 'default skills source repo' };
    }

    const repoPath = path.join(REPOS_DIR, normalizedRepoName);
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
    defaultSkillsRepoName = DEFAULT_SKILLS_REPO_NAME,
} = {}) {
    const defaultSkillsRepoNameLabel = String(defaultSkillsRepoName || '').trim();
    const refreshed = [];
    const skipped = [];
    const failed = [];

    for (const repoName of repoNames) {
        const repoNameLabel = String(repoName || '').trim();
        try {
            const result = refreshDefaultSkillsInPloinkyRepo(repoNameLabel, {
                defaultSkillsRepoName: defaultSkillsRepoNameLabel,
            });
            if (result.refreshed) {
                refreshed.push(result);
            } else {
                skipped.push(result);
            }
        } catch (err) {
            failed.push({
                repoName: repoNameLabel,
                message: err?.message || String(err),
            });
        }
    }

    return {
        defaultSkillsRepoName: defaultSkillsRepoNameLabel,
        total: repoNames.length,
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

function refreshRuntimeAchillesForUpdate(failed, ploinkyRoot = resolvePloinkyRoot()) {
    console.log('Refreshing Ploinky Achilles runtime dependency...');
    try {
        const result = refreshPloinkyRuntimeAchillesDependency({ ploinkyRoot });
        console.log(`  ✓ ${path.relative(ploinkyRoot, result.installedPath)} (${result.method})`);
        // The prepared dependency caches under .ploinky/deps embed the global git
        // dependencies (achillesAgentLib `#master`, mcp-sdk `#main`) but are keyed
        // on the package.json spec string, so a moving ref that advanced upstream
        // would otherwise serve a stale copy to containers. Resolve each moving git
        // dep's upstream commit and invalidate the caches only when one changed.
        const gitDepCommits = resolveMovingGitDepCommits(readGlobalDepsPackage().dependencies);
        const invalidation = invalidateDepsCacheForMovingGitDeps(gitDepCommits);
        if (invalidation.invalidated) {
            const changedLabel = invalidation.changed.length ? invalidation.changed.join(', ') : 'initial';
            console.log(`  ✓ Dependency caches invalidated (moving git deps changed: ${changedLabel}); agents reinstall on next start.`);
        }
        return result;
    } catch (err) {
        const message = err?.message || String(err);
        failed.push({
            repoName: 'ploinky/node_modules/achillesAgentLib',
            message,
        });
        console.error(`  ✗ node_modules/achillesAgentLib: ${message}`);
        return null;
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
        const repoPath = path.join(REPOS_DIR, repoName);
        const achilles = refreshAchillesDependenciesInRepos({ reposRoot: repoPath });
        if (achilles.failed.length) {
            const failedPackages = achilles.failed.map(entry => path.relative(repoPath, entry.packageDir) || '.').join(', ');
            throw new Error(`Failed to refresh achillesAgentLib in ${failedPackages}`);
        }
    } catch (err) {
        throw new Error(`update repo failed: ${err?.message || err}`);
    }
}

async function updatePloinkyRepos() {
    const ploinkyRepos = getGitRepoNames();
    const failed = [];
    let updated = 0;
    const runtimeAchilles = refreshRuntimeAchillesForUpdate(failed);

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

    const achilles = refreshAchillesDependenciesInRepos();
    if (achilles.failed.length) {
        for (const entry of achilles.failed) {
            failed.push({
                repoName: `achillesAgentLib ${path.relative(REPOS_DIR, entry.packageDir) || '.'}`,
                message: entry.message,
            });
        }
    }

    console.log(`Ploinky repository update summary: ${updated}/${ploinkyRepos.length} repositories updated.`);
    if (achilles.total) {
        console.log(`Achilles dependency summary: ${achilles.refreshed.length}/${achilles.total} package(s) refreshed.`);
    }

    if (failed.length) {
        const failedNames = failed.map(entry => entry.repoName).join(', ');
        throw new Error(`Failed to update ${failed.length} repository(s): ${failedNames}`);
    }

    return { total: ploinkyRepos.length, updated, failed, runtimeAchilles, achilles };
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
    let runtimeAchilles = null;

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

    runtimeAchilles = refreshRuntimeAchillesForUpdate(failed, ploinkyRoot);

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

    const achilles = refreshAchillesDependenciesInRepos();
    if (achilles.failed.length) {
        for (const entry of achilles.failed) {
            failed.push({
                repoName: `achillesAgentLib ${path.relative(REPOS_DIR, entry.packageDir) || '.'}`,
                message: entry.message,
            });
        }
    }

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
    if (achilles.total) {
        console.log(`Achilles dependency summary: ${achilles.refreshed.length}/${achilles.total} package(s) refreshed.`);
    }

    if (failed.length) {
        const failedNames = failed.map(entry => entry.repoName).join(', ');
        throw new Error(`Failed to update ${failed.length} repository(s): ${failedNames}`);
    }

    return { total: totalRepos, updated, failed, skipped, selfUpdate, runtimeAchilles, achilles };
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
    const { shortAgentName, repoName, alias: resolvedAlias, auth } = agentsSvc.enableAgent(agentName, mode, repoNameParam, alias, authMode, { username, password });
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
    uninstallRepo,
    updateRepo,
    updatePloinkyRepos,
    updateAllRepos,
    refreshDefaultSkillsInPloinkyRepos,
    resolveUpdateProjectsRoot,
    enableAgent,
    findAgentManifest,
};
