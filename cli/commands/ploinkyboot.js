import fs from 'fs';
import path from 'path';
import { PLOINKY_DIR } from '../utils/config.js';
import * as repos from '../utils/repos.js';
import { findAgent } from '../utils/utils.js';

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

export function prepareDefaultBootRepositories({
    branchPolicy,
    staticAgent,
    bootRepos = repos.getDefaultBootRepos(),
    log = console.log,
    error = console.error,
    stdio = 'inherit',
} = {}) {
    const prepared = [];
    for (const { name, url } of bootRepos) {
        const repoPath = path.join(PLOINKY_DIR, 'repos', name);
        const repoBranchPolicy = policyForBootRepo(name, branchPolicy, staticAgent);
        if (!fs.existsSync(repoPath)) {
            log(`Default '${name}' repository not found. Cloning...`);
            try {
                const result = repos.ensureRepoInstalled(name, url, {
                    branchPolicy: repoBranchPolicy,
                    stdio,
                });
                prepared.push({ name, action: result?.status || 'cloned', branch: result?.branch || null });
                log(`${name} repository cloned successfully.`);
            } catch (err) {
                if (isStrictBranchPolicy(repoBranchPolicy)) throw err;
                error(`Error cloning ${name} repository: ${err.message}`);
            }
        } else if (repoBranchPolicy?.branch || repoBranchPolicy?.repoBranches?.[name]) {
            try {
                const result = repos.ensureRepoOnBranch(name, {
                    branch: repos.resolveBranchForRepo(name, null, repoBranchPolicy),
                    resetRepos: repoBranchPolicy?.resetRepos || false,
                    fallback: repoBranchPolicy?.fallback || 'default',
                    stdio,
                });
                prepared.push({ name, action: result?.status || 'exists', branch: result?.branch || null });
            } catch (err) {
                if (isStrictBranchPolicy(repoBranchPolicy)) throw err;
                error(`Error switching '${name}' to branch: ${err.message}`);
            }
        }
    }

    // The global --branch must also reach the static agent's OWN repo when the
    // agent is named bare (e.g. `explorer`, not `AchillesIDE/explorer`).
    // repoNameFromAgentRef() can't resolve a bare name, and findAgent() needs the
    // repos on disk — so resolve it here, after the default repos are cloned, and
    // switch that repo to the branch (default fallback keeps it on its current
    // branch when the branch is absent). Repo-prefixed names are already handled
    // in the loop above via policyForBootRepo.
    if (branchPolicy?.branch && staticAgent && !repoNameFromAgentRef(staticAgent)) {
        try {
            const staticRepo = findAgent(String(staticAgent).trim())?.repo;
            if (staticRepo && fs.existsSync(path.join(PLOINKY_DIR, 'repos', staticRepo))) {
                const result = repos.ensureRepoOnBranch(staticRepo, {
                    branch: branchPolicy.branch,
                    resetRepos: branchPolicy.resetRepos || false,
                    fallback: branchPolicy.fallback || 'default',
                    stdio,
                });
                prepared.push({ name: staticRepo, action: result?.status || 'exists', branch: result?.branch || null });
            }
        } catch (err) {
            if (isStrictBranchPolicy(branchPolicy)) throw err;
            error(`Error switching static agent repo to branch: ${err.message}`);
        }
    }

    return prepared;
}

export function bootstrap({ branchPolicy, staticAgent } = {}) {
    return prepareDefaultBootRepositories({ branchPolicy, staticAgent });
}
