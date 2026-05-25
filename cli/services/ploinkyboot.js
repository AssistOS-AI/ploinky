import fs from 'fs';
import path from 'path';
import { PLOINKY_DIR } from './config.js';
import * as repos from './repos.js';

const DEFAULT_REPOS = [
    { name: 'basic', url: 'https://github.com/PloinkyRepos/Basic.git' },
    { name: 'AchillesIDE', url: 'https://github.com/PloinkyRepos/AssistOSExplorer.git' },
    { name: 'AchillesCLI', url: 'https://github.com/OutfinityResearch/AchillesCLI.git' },
];

export function getDefaultBootRepos() {
    return DEFAULT_REPOS.map(repo => ({ ...repo }));
}

function repoNameFromAgentRef(agentRef) {
    const ref = String(agentRef || '').trim();
    const slashIdx = ref.indexOf('/');
    const colonIdx = ref.indexOf(':');
    const sepIdx = slashIdx > 0 ? slashIdx : (colonIdx > 0 ? colonIdx : -1);
    return sepIdx > 0 ? ref.slice(0, sepIdx) : null;
}

function policyForBootRepo(repoName, branchPolicy, staticAgent) {
    if (!branchPolicy) return null;
    if (branchPolicy.repoBranches?.[repoName]) return branchPolicy;
    const staticRepoName = repoNameFromAgentRef(staticAgent);
    if (branchPolicy.branch && staticRepoName === repoName) return branchPolicy;
    return null;
}

function isStrictBranchPolicy(branchPolicy) {
    return branchPolicy?.fallback === 'fail'
        && (Boolean(branchPolicy.branch) || Object.keys(branchPolicy.repoBranches || {}).length > 0);
}

export function bootstrap({ branchPolicy, staticAgent } = {}) {
    for (const { name, url } of getDefaultBootRepos()) {
        const repoPath = path.join(PLOINKY_DIR, 'repos', name);
        const repoBranchPolicy = policyForBootRepo(name, branchPolicy, staticAgent);
        if (!fs.existsSync(repoPath)) {
            console.log(`Default '${name}' repository not found. Cloning...`);
            try {
                repos.ensureRepoInstalled(name, url, {
                    branchPolicy: repoBranchPolicy,
                    stdio: 'inherit',
                });
                console.log(`${name} repository cloned successfully.`);
            } catch (error) {
                if (isStrictBranchPolicy(repoBranchPolicy)) throw error;
                console.error(`Error cloning ${name} repository: ${error.message}`);
            }
        } else if (repoBranchPolicy?.branch || repoBranchPolicy?.repoBranches?.[name]) {
            try {
                repos.ensureRepoOnBranch(name, {
                    branch: repos.resolveBranchForRepo(name, null, repoBranchPolicy),
                    resetRepos: repoBranchPolicy?.resetRepos || false,
                    fallback: repoBranchPolicy?.fallback || 'default',
                    stdio: 'inherit',
                });
            } catch (error) {
                if (isStrictBranchPolicy(repoBranchPolicy)) throw error;
                console.error(`Error switching '${name}' to branch: ${error.message}`);
            }
        }
    }
    try {
        const list = repos.loadEnabledRepos();
        for (const { name } of getDefaultBootRepos()) {
            const repoPath = path.join(PLOINKY_DIR, 'repos', name);
            if (fs.existsSync(repoPath) && !list.includes(name)) {
                list.push(name);
                repos.saveEnabledRepos(list);
            }
        }
    } catch (_) {}
}
