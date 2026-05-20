import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { PLOINKY_DIR } from './config.js';

export const ENABLED_REPOS_FILE = path.join(PLOINKY_DIR, 'enabled_repos.json');
export const REPO_SOURCES_FILE = path.join(PLOINKY_DIR, 'repo_sources.json');
const REPOS_DIR = path.join(PLOINKY_DIR, 'repos');

function loadRepoSources() {
    try {
        const raw = fs.readFileSync(REPO_SOURCES_FILE, 'utf8');
        const data = JSON.parse(raw || '{}');
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (_) {
        return {};
    }
}

function saveRepoSources(sources) {
    try {
        fs.mkdirSync(PLOINKY_DIR, { recursive: true });
        fs.writeFileSync(REPO_SOURCES_FILE, JSON.stringify(sources || {}, null, 2));
    } catch (_) {}
}

function normalizeRepoBranch(branch) {
    const value = String(branch || '').trim();
    if (!value || value === 'default') return null;
    return value;
}

function normalizeRepoSourceValue(value) {
    if (typeof value === 'string') {
        const url = value.trim();
        return url ? { url, branch: null } : null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const url = String(value.url || '').trim();
    if (!url) return null;
    return {
        url,
        branch: normalizeRepoBranch(value.branch),
    };
}

function readStoredRepoSource(name) {
    const repoName = String(name || '').trim();
    if (!repoName) return null;
    return normalizeRepoSourceValue(loadRepoSources()[repoName]);
}

function recordRepoSource(name, url, branch = null) {
    const repoName = String(name || '').trim();
    const repoUrl = String(url || '').trim();
    if (!repoName || !repoUrl) return;
    const previous = readStoredRepoSource(repoName);
    const repoBranch = normalizeRepoBranch(branch)
        || (previous?.url === repoUrl ? previous.branch : null);
    const next = { url: repoUrl };
    if (repoBranch) next.branch = repoBranch;
    const sources = loadRepoSources();
    const current = normalizeRepoSourceValue(sources[repoName]);
    if (current?.url === next.url && current?.branch === (next.branch || null)) return;
    sources[repoName] = next;
    saveRepoSources(sources);
}

export function loadEnabledRepos() {
    try {
        const raw = fs.readFileSync(ENABLED_REPOS_FILE, 'utf8');
        const data = JSON.parse(raw || '[]');
        return Array.isArray(data) ? data : [];
    } catch (_) {
        return [];
    }
}

export function saveEnabledRepos(list) {
    try {
        fs.mkdirSync(PLOINKY_DIR, { recursive: true });
        fs.writeFileSync(ENABLED_REPOS_FILE, JSON.stringify(list || [], null, 2));
    } catch (_) {}
}

export function getInstalledRepos(REPOS_DIR) {
    try {
        return fs
            .readdirSync(REPOS_DIR)
            .filter(name => {
                try {
                    return fs.statSync(path.join(REPOS_DIR, name)).isDirectory();
                } catch (_) {
                    return false;
                }
            });
    } catch (_) {
        return [];
    }
}

export function getActiveRepos(REPOS_DIR) {
    const enabled = loadEnabledRepos();
    if (enabled && enabled.length) return enabled;
    return getInstalledRepos(REPOS_DIR);
}

const PREDEFINED_REPOS = {
    basic: { url: 'https://github.com/PloinkyRepos/Basic.git', description: 'Default base agents', kind: 'agents' },
    cloud: { url: 'https://github.com/PloinkyRepos/cloud.git', description: 'Cloud infrastructure agents', kind: 'agents' },
    vibe: { url: 'https://github.com/PloinkyRepos/vibe.git', description: 'Vibe coding agents', kind: 'agents' },
    security: { url: 'https://github.com/PloinkyRepos/security.git', description: 'Security and scanning tools', kind: 'agents' },
    extra: { url: 'https://github.com/PloinkyRepos/extra.git', description: 'Additional utility agents', kind: 'agents' },
    AchillesIDE: { url: 'https://github.com/PloinkyRepos/AssistOSExplorer.git', description: 'Workspace IDE with Explorer UI, SOPLang editing and Git workflows', kind: 'agents' },
    AchillesCLI: { url: 'https://github.com/OutfinityResearch/AchillesCLI.git', description: 'Workspace CLI for setup and management', kind: 'agents' },
    demo: { url: 'https://github.com/PloinkyRepos/demo.git', description: 'Demo agents and examples', kind: 'agents' },
    proxies: { url: 'https://github.com/PloinkyRepos/proxies.git', description: 'API proxy agents (Kiro Gateway)', kind: 'agents' },
    AchillesCopilotBasicSkills: { url: 'https://github.com/AssistOS-AI/AchillesCopilotBasicSkills.git', description: 'Default Anthropic-style skill catalog (SKILL.md folders)', kind: 'skills' }
};

export function getPredefinedRepos() {
    return PREDEFINED_REPOS;
}

export function classifyRepoKind(repoName) {
    const declared = PREDEFINED_REPOS[repoName]?.kind;
    if (declared) return declared;

    const repoPath = path.join(PLOINKY_DIR, 'repos', repoName);
    if (!fs.existsSync(repoPath)) return 'unknown';

    let hasSkills = false;
    const skillsDir = path.join(repoPath, 'skills');
    try {
        if (fs.statSync(skillsDir).isDirectory()) {
            const subs = fs.readdirSync(skillsDir, { withFileTypes: true });
            hasSkills = subs.some(entry => entry.isDirectory()
                && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')));
        }
    } catch (_) {}

    let hasAgents = false;
    try {
        const top = fs.readdirSync(repoPath, { withFileTypes: true });
        hasAgents = top.some(entry => entry.isDirectory()
            && entry.name !== 'skills'
            && !entry.name.startsWith('.')
            && fs.existsSync(path.join(repoPath, entry.name, 'manifest.json')));
    } catch (_) {}

    if (hasSkills && hasAgents) return 'mixed';
    if (hasSkills) return 'skills';
    if (hasAgents) return 'agents';
    return 'unknown';
}

function ensureReposDir() {
    const dir = path.join(PLOINKY_DIR, 'repos');
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
    return dir;
}

export function resolveRepoUrl(name, url) {
    if (url && url.trim()) return url;
    const rawName = String(name || '');
    const preset = PREDEFINED_REPOS[rawName]
        || PREDEFINED_REPOS[rawName.toLowerCase()]
        || Object.entries(PREDEFINED_REPOS).find(([key]) => key.toLowerCase() === rawName.toLowerCase())?.[1];
    return preset ? preset.url : null;
}

function findManifestRepoSource(repoName) {
    const targetName = String(repoName || '').trim();
    if (!targetName) return null;
    const ignoredDirNames = new Set(['.git', 'node_modules']);

    function inspectManifest(filePath) {
        try {
            const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const repos = manifest?.repos;
            if (!repos || typeof repos !== 'object' || Array.isArray(repos)) return null;
            return normalizeRepoSourceValue(repos[targetName]);
        } catch (_) {
            return null;
        }
    }

    function visit(dir) {
        const manifestPath = path.join(dir, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            const url = inspectManifest(manifestPath);
            if (url) return url;
        }

        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
            return null;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith('.') || ignoredDirNames.has(entry.name)) continue;
            const found = visit(path.join(dir, entry.name));
            if (found) return found;
        }
        return null;
    }

    try {
        if (!fs.existsSync(REPOS_DIR) || !fs.statSync(REPOS_DIR).isDirectory()) return null;
    } catch (_) {
        return null;
    }

    return visit(REPOS_DIR);
}

export function resolveRepoSource(name, url = null, branch = null) {
    const repoName = String(name || '').trim();
    const directUrl = resolveRepoUrl(name, url);
    const stored = readStoredRepoSource(repoName);
    const manifest = findManifestRepoSource(repoName);
    const sourceUrl = directUrl || stored?.url || manifest?.url || null;
    if (!sourceUrl) return null;

    const sourceBranch = normalizeRepoBranch(branch)
        || (stored?.url === sourceUrl ? stored.branch : null)
        || (manifest?.url === sourceUrl ? manifest.branch : null)
        || null;

    if (manifest?.url === sourceUrl || stored?.url === sourceUrl) {
        recordRepoSource(repoName, sourceUrl, sourceBranch);
    }
    return { url: sourceUrl, branch: sourceBranch };
}

export function resolveRepoSourceUrl(name, url = null) {
    return resolveRepoSource(name, url)?.url || null;
}

export function addRepo(name, url, branch = null, { stdio = 'inherit' } = {}) {
    if (!name) throw new Error('Missing repository name.');
    const REPOS_DIR = ensureReposDir();
    const repoPath = path.join(REPOS_DIR, name);
    const source = resolveRepoSource(name, url, branch);
    const actualUrl = source?.url || null;
    const actualBranch = source?.branch || null;
    if (fs.existsSync(repoPath)) {
        recordRepoSource(name, actualUrl, actualBranch);
        return { status: 'exists', path: repoPath, branch: actualBranch };
    }
    if (!actualUrl) throw new Error(`Missing repository URL for '${name}'.`);
    const args = ['clone'];
    if (actualBranch) args.push('--branch', actualBranch);
    args.push(actualUrl, repoPath);
    execFileSync('git', args, { stdio });
    recordRepoSource(name, actualUrl, actualBranch);
    return { status: 'cloned', path: repoPath, branch: actualBranch || 'default' };
}

export function enableRepo(name, branch = null, { stdio = 'inherit' } = {}) {
    if (!name) throw new Error('Missing repository name.');

    if (PREDEFINED_REPOS[name]?.kind === 'skills') {
        throw new Error(`Repo '${name}' is a skills-only repo (no agents). Use 'default-skills ${name}' to install its skills into the workspace.`);
    }

    const REPOS_DIR = ensureReposDir();
    const repoPath = path.join(REPOS_DIR, name);
    const source = resolveRepoSource(name, null, branch);
    if (!fs.existsSync(repoPath)) {
        const url = source?.url || null;
        if (!url) throw new Error(`No URL configured for repo '${name}'.`);
        const args = ['clone'];
        if (source.branch) args.push('--branch', source.branch);
        args.push(url, repoPath);
        execFileSync('git', args, { stdio });
        recordRepoSource(name, url, source.branch);
    } else if (source?.url) {
        recordRepoSource(name, source.url, source.branch);
    }

    if (classifyRepoKind(name) === 'skills') {
        throw new Error(`Repo '${name}' contains only skills (no agents found). Use 'default-skills ${name}' to install its skills into the workspace.`);
    }

    const list = loadEnabledRepos();
    if (!list.includes(name)) {
        list.push(name);
        saveEnabledRepos(list);
    }
    return true;
}

export function disableRepo(name) {
    const list = loadEnabledRepos();
    const filtered = list.filter(r => r !== name);
    saveEnabledRepos(filtered);
    return true;
}

function recloneNonGitRepo(name, repoPath, url, { branch = null, stdio = 'inherit' } = {}) {
    const reposRoot = path.dirname(repoPath);
    const safeName = String(name || 'repo').replace(/[^a-zA-Z0-9_.-]+/g, '-');
    const tempPath = path.join(reposRoot, `.${safeName}.clone-${process.pid}-${Date.now()}`);
    const args = ['clone', '--quiet'];
    if (branch) args.push('--branch', branch);
    args.push(url, tempPath);

    execFileSync('git', args, { stdio });

    let installed = false;
    try {
        fs.rmSync(repoPath, { recursive: true, force: true });
        fs.renameSync(tempPath, repoPath);
        installed = true;
    } catch (err) {
        if (!fs.existsSync(repoPath) && fs.existsSync(tempPath)) {
            try {
                fs.renameSync(tempPath, repoPath);
                installed = true;
            } catch (_) {}
        }
        throw err;
    } finally {
        if (installed || fs.existsSync(repoPath)) {
            try { fs.rmSync(tempPath, { recursive: true, force: true }); } catch (_) {}
        }
    }

    recordRepoSource(name, url);
    return { recloned: true, replaced: true };
}

function gitCommandErrorMessage(err) {
    const stderr = err?.stderr ? String(err.stderr).trim() : '';
    if (stderr) return stderr;
    return err?.message || String(err);
}

export function updateRepo(name, { rebase = true, autostash = true, stdio = 'inherit' } = {}) {
    if (!name) throw new Error('Missing repository name.');
    const REPOS_DIR = ensureReposDir();
    const repoPath = path.join(REPOS_DIR, name);
    if (!fs.existsSync(repoPath)) {
        throw new Error(`Repository '${name}' is not installed.`);
    }
    if (!isGitRepository(repoPath)) {
        const source = resolveRepoSource(name, null);
        if (!source?.url) {
            throw new Error(`Repository '${name}' is not a git repository and no source URL is known.`);
        }
        return recloneNonGitRepo(name, repoPath, source.url, { branch: source.branch, stdio });
    }
    const args = ['-C', repoPath, 'pull'];
    if (rebase) args.push('--rebase');
    if (autostash) args.push('--autostash');
    execFileSync('git', args, { stdio });
    return { pulled: true };
}

export function isGitRepository(repoPath) {
    if (!repoPath) return false;
    try {
        return fs.existsSync(path.join(repoPath, '.git'));
    } catch (_) {
        return false;
    }
}

export function findWorkspaceGitRepos(workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        throw new Error(`Search root '${root}' is not a directory.`);
    }

    const repos = [];
    const ignoredDirNames = new Set([
        '.git',
        '.ploinky',
        'node_modules',
        'globalDeps',
    ]);

    function visit(dir) {
        if (fs.existsSync(path.join(dir, '.git'))) {
            repos.push({ name: path.basename(dir), path: dir });
            if (dir !== root) return;
        }

        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            if (err?.code === 'EACCES' || err?.code === 'EPERM') return;
            throw err;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith('.') || ignoredDirNames.has(entry.name)) continue;
            visit(path.join(dir, entry.name));
        }
    }

    visit(root);
    return repos;
}

export function checkGitRemoteReachable(repoPath, { remote = 'origin' } = {}) {
    const remoteName = String(remote || 'origin').trim() || 'origin';
    let remoteUrl = '';

    try {
        remoteUrl = String(execFileSync('git', ['-C', repoPath, 'remote', 'get-url', remoteName], {
            stdio: ['ignore', 'pipe', 'pipe'],
        }) || '').trim();
    } catch (err) {
        return {
            reachable: false,
            skipped: true,
            reason: `missing ${remoteName} remote`,
            remote: remoteName,
            message: gitCommandErrorMessage(err),
        };
    }

    try {
        execFileSync('git', ['-C', repoPath, 'ls-remote', '--quiet', remoteName], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        return {
            reachable: true,
            skipped: false,
            remote: remoteName,
            remoteUrl,
        };
    } catch (err) {
        return {
            reachable: false,
            skipped: true,
            reason: 'remote not reachable',
            remote: remoteName,
            remoteUrl,
            message: gitCommandErrorMessage(err),
        };
    }
}

export function pullGitRepo(repoPath, { rebase = true, autostash = true, stdio = 'inherit' } = {}) {
    const args = ['-C', repoPath, 'pull'];
    if (rebase) args.push('--rebase');
    if (autostash) args.push('--autostash');
    execFileSync('git', args, { stdio });
    return true;
}
