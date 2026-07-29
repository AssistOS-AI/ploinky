import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { PLOINKY_DIR } from './config.js';

export const REPO_SOURCES_FILE = path.join(PLOINKY_DIR, 'repo_sources.json');
export const ENABLED_REPOS_FILE = path.join(PLOINKY_DIR, 'enabled_repos.json');
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
    const kind = String(value.kind || '').trim();
    return {
        url,
        branch: normalizeRepoBranch(value.branch),
        kind: kind || null,
    };
}

function readStoredRepoSource(name) {
    const repoName = String(name || '').trim();
    if (!repoName) return null;
    return normalizeRepoSourceValue(loadRepoSources()[repoName]);
}

export function getRepoSources() {
    const result = {};
    const sources = loadRepoSources();
    for (const [name, value] of Object.entries(sources)) {
        const source = normalizeRepoSourceValue(value);
        if (source?.url) result[name] = source;
    }
    return result;
}

function looksLikeRepoUrl(value) {
    const candidate = String(value || '').trim();
    if (!candidate) return false;
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)
        || /^git@[^:]+:.+/.test(candidate)
        || candidate.startsWith('ssh://')
        || candidate.startsWith('file://')
        || candidate.startsWith('/')
        || candidate.startsWith('./')
        || candidate.startsWith('../')
        || candidate.endsWith('.git');
}

function recordRepoSource(name, url, branch = null, kind = null) {
    const repoName = String(name || '').trim();
    const repoUrl = String(url || '').trim();
    if (!repoName || !repoUrl) return;
    const previous = readStoredRepoSource(repoName);
    const repoBranch = normalizeRepoBranch(branch)
        || (previous?.url === repoUrl ? previous.branch : null);
    const repoKind = String(kind || '').trim()
        || (previous?.url === repoUrl ? previous.kind : null);
    const next = { url: repoUrl };
    if (repoBranch) next.branch = repoBranch;
    if (repoKind) next.kind = repoKind;
    const sources = loadRepoSources();
    const current = normalizeRepoSourceValue(sources[repoName]);
    if (current?.url === next.url
        && current?.branch === (next.branch || null)
        && current?.kind === (next.kind || null)) return;
    sources[repoName] = next;
    saveRepoSources(sources);
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
    if (!enabled.length) {
        return getInstalledRepos(REPOS_DIR);
    }
    const installed = new Set(getInstalledRepos(REPOS_DIR));
    return enabled.filter(repoName => installed.has(repoName));
}

const PREDEFINED_REPOS = {
    basic: { url: 'https://github.com/AssistOS-AI/Basic.git', description: 'Default base agents', kind: 'agents' },
    cloud: { url: 'https://github.com/AssistOS-AI/cloud.git', description: 'Cloud infrastructure agents', kind: 'agents' },
    vibe: { url: 'https://github.com/AssistOS-AI/vibe.git', description: 'Vibe coding agents', kind: 'agents' },
    security: { url: 'https://github.com/AssistOS-AI/security.git', description: 'Security and scanning tools', kind: 'agents' },
    extra: { url: 'https://github.com/AssistOS-AI/extra.git', description: 'Additional utility agents', kind: 'agents' },
    AchillesIDE: { url: 'https://github.com/AssistOS-AI/AssistOSExplorer.git', description: 'Workspace IDE with Explorer UI, SOPLang editing and Git workflows', kind: 'agents' },
    AchillesCLI: { url: 'https://github.com/AssistOS-AI/AchillesCLI.git', description: 'Workspace CLI for setup and management', kind: 'agents' },
    'copilot-agents': { url: 'https://github.com/AssistOS-AI/copilot-agents.git', description: 'OpenCode copilot agents', kind: 'agents' },
    demo: { url: 'https://github.com/AssistOS-AI/demo.git', description: 'Demo agents and examples', kind: 'agents' },
    proxies: { url: 'https://github.com/AssistOS-AI/proxies.git', description: 'API proxy agents (Kiro Gateway)', kind: 'agents' },
    AchillesCopilotBasicSkills: { url: 'https://github.com/AssistOS-AI/AchillesCopilotBasicSkills.git', description: 'Default Anthropic-style skill catalog (SKILL.md folders)', kind: 'skills' }
};

const BOOT_REPO_NAMES = ['basic', 'AchillesIDE', 'AchillesCLI', 'copilot-agents'];

export function getDefaultBootRepos() {
    return BOOT_REPO_NAMES
        .map((repoName) => {
            const url = resolveRepoUrl(repoName);
            if (!url) return null;
            return { name: repoName, url };
        })
        .filter(Boolean);
}

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

export function deriveRepoNameFromUrl(url) {
    const rawUrl = String(url || '').trim();
    if (!rawUrl) return '';
    const withoutHash = rawUrl.split('#')[0].split('?')[0];
    const withoutSlash = withoutHash.replace(/\/+$/, '');
    const lastSegment = withoutSlash.slice(withoutSlash.lastIndexOf('/') + 1);
    const name = lastSegment.replace(/\.git$/i, '').replace(/[^a-zA-Z0-9_.-]+/g, '-');
    return name.replace(/^-+|-+$/g, '');
}

export function normalizeRepoName(name) {
    const repoName = String(name || '').trim();
    if (!repoName || !/^[a-zA-Z0-9_.-]+$/.test(repoName)) {
        throw new Error('Invalid repository name.');
    }
    return repoName;
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

export function loadEnabledRepos() {
    try {
        const raw = fs.readFileSync(ENABLED_REPOS_FILE, 'utf8');
        const parsed = JSON.parse(raw || '[]');
        if (!Array.isArray(parsed)) return [];
        const seen = new Set();
        const repos = [];
        for (const entry of parsed) {
            const repoName = String(entry || '').trim();
            if (!repoName || seen.has(repoName)) continue;
            seen.add(repoName);
            repos.push(repoName);
        }
        return repos;
    } catch (_) {
        return [];
    }
}

function saveEnabledRepos(repoNames) {
    const seen = new Set();
    const repos = [];
    for (const entry of repoNames || []) {
        const repoName = String(entry || '').trim();
        if (!repoName || seen.has(repoName)) continue;
        seen.add(repoName);
        repos.push(repoName);
    }
    fs.mkdirSync(PLOINKY_DIR, { recursive: true });
    fs.writeFileSync(ENABLED_REPOS_FILE, JSON.stringify(repos, null, 2));
    return repos;
}

export function enableRepo(name, { branch = null, branchPolicy = null, stdio = 'inherit' } = {}) {
    const repoName = normalizeRepoName(name);
    const source = resolveRepoSource(repoName, null, branch);
    const result = ensureRepoInstalled(repoName, source?.url || null, {
        branchPolicy,
        branch,
        stdio,
    });
    const enabled = loadEnabledRepos();
    if (!enabled.includes(repoName)) {
        enabled.push(repoName);
        saveEnabledRepos(enabled);
    }
    return {
        status: enabled.includes(repoName) ? 'enabled' : 'unchanged',
        name: repoName,
        path: result.path,
        branch: result.branch || null,
    };
}

export function disableRepo(name) {
    const repoName = normalizeRepoName(name);
    const enabled = loadEnabledRepos();
    const next = enabled.filter(entry => entry !== repoName);
    saveEnabledRepos(next);
    return {
        status: next.length === enabled.length ? 'not-enabled' : 'disabled',
        name: repoName,
    };
}

export function installRepo(url, name = null, branch = null, { stdio = 'inherit' } = {}) {
    const input = String(url || '').trim();
    if (!input) throw new Error('Missing repository URL.');

    let repoUrl = input;
    let repoName = name ? normalizeRepoName(name) : null;
    let resolvedBranch = normalizeRepoBranch(branch);

    if (!looksLikeRepoUrl(input)) {
        const sourceName = normalizeRepoName(input);
        const source = resolveRepoSource(sourceName, null, resolvedBranch);
        if (!source?.url) {
            throw new Error(`Missing repository URL for '${sourceName}'. Install by name only works for repositories in repo_sources.json or predefined repositories.`);
        }
        repoName = sourceName;
        repoUrl = source.url;
        resolvedBranch = normalizeRepoBranch(branch) || source.branch || null;
    } else if (!repoName) {
        repoName = normalizeRepoName(deriveRepoNameFromUrl(repoUrl));
    }

    const result = addRepo(repoName, repoUrl, resolvedBranch, { stdio });
    const kind = classifyRepoKind(repoName);
    recordRepoSource(repoName, repoUrl, result.branch, kind);
    return {
        ...result,
        name: repoName,
        url: repoUrl,
        kind,
        installed: true
    };
}

export function resolveInstalledRepoTarget(target) {
    const rawTarget = String(target || '').trim();
    if (!rawTarget) throw new Error('Missing repository target.');
    const reposDir = ensureReposDir();
    const installed = getInstalledRepos(reposDir);
    if (installed.includes(rawTarget)) return rawTarget;

    const sources = loadRepoSources();
    for (const repoName of installed) {
        const source = normalizeRepoSourceValue(sources[repoName]);
        if (source?.url === rawTarget) return repoName;
    }

    for (const repoName of installed) {
        const predefinedUrl = PREDEFINED_REPOS[repoName]?.url || '';
        if (predefinedUrl && predefinedUrl === rawTarget) return repoName;
    }

    const derived = deriveRepoNameFromUrl(rawTarget);
    if (derived && installed.includes(derived)) return derived;
    throw new Error(`Repository '${rawTarget}' is not installed.`);
}

export function uninstallRepo(target, { stdio = 'inherit' } = {}) {
    const repoName = resolveInstalledRepoTarget(target);
    const repoPath = path.join(ensureReposDir(), repoName);
    if (!fs.existsSync(repoPath)) {
        return { status: 'missing', name: repoName, path: repoPath };
    }
    fs.rmSync(repoPath, { recursive: true, force: true });
    return { status: 'removed', name: repoName, path: repoPath };
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

// ---------------------------------------------------------------------------
// Branch policy — used by `ploinky start --branch`
// ---------------------------------------------------------------------------

export function parseBranchPolicy(args) {
    const policy = {
        branch: null,
        repoBranches: {},
        fallback: 'default',
        resetRepos: false,
    };
    if (!Array.isArray(args) || !args.length) return policy;

    for (let i = 0; i < args.length; i += 1) {
        const arg = String(args[i] || '');

        if (arg === '--branch' && i + 1 < args.length) {
            policy.branch = String(args[++i]);
            continue;
        }
        if (arg.startsWith('--branch=')) {
            policy.branch = arg.slice('--branch='.length);
            continue;
        }

        if (arg === '--repo-branch' && i + 1 < args.length) {
            const pair = String(args[++i]);
            const eqIdx = pair.indexOf('=');
            if (eqIdx < 1) {
                throw new Error(`Malformed --repo-branch value '${pair}'. Expected repo=branch.`);
            }
            policy.repoBranches[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
            continue;
        }
        if (arg.startsWith('--repo-branch=')) {
            const pair = arg.slice('--repo-branch='.length);
            const eqIdx = pair.indexOf('=');
            if (eqIdx < 1) {
                throw new Error(`Malformed --repo-branch value '${pair}'. Expected repo=branch.`);
            }
            policy.repoBranches[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
            continue;
        }

        if (arg === '--branch-fallback' && i + 1 < args.length) {
            policy.fallback = String(args[++i]);
            continue;
        }
        if (arg.startsWith('--branch-fallback=')) {
            policy.fallback = arg.slice('--branch-fallback='.length);
            continue;
        }

        if (arg === '--reset-repos') {
            policy.resetRepos = true;
            continue;
        }
    }

    if (policy.fallback !== 'default' && policy.fallback !== 'fail') {
        throw new Error(`Invalid --branch-fallback value '${policy.fallback}'. Use 'default' or 'fail'.`);
    }
    return policy;
}

export function parseStartArgs(rawArgs) {
    const args = (rawArgs || []).map(a => String(a));
    let staticAgent = null;
    let port = null;
    let profile = null;
    const policyArgs = [];
    const positional = [];

    const selectProfile = (value) => {
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized) {
            throw new Error('--profile needs a value.');
        }
        if (profile && profile !== normalized) {
            throw new Error(`Conflicting --profile values '${profile}' and '${normalized}'.`);
        }
        profile = normalized;
    };

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--port' || arg.startsWith('--port=')) {
            throw new Error(
                "start-tail --port is not supported. Use prefix 'ploinky --port PORT start AGENT' or positional 'ploinky start AGENT PORT'.",
            );
        }
        if (arg === '--profile') {
            const value = args[i + 1];
            if (value === undefined || value === '' || value.startsWith('--')) {
                throw new Error('--profile needs a value.');
            }
            selectProfile(value);
            i += 1;
            continue;
        }
        if (arg.startsWith('--profile=')) {
            selectProfile(arg.slice('--profile='.length));
            continue;
        }
        if (arg === '--branch' || arg === '--repo-branch' || arg === '--branch-fallback') {
            policyArgs.push(arg);
            if (i + 1 < args.length) policyArgs.push(args[++i]);
            continue;
        }
        if (arg.startsWith('--branch=') || arg.startsWith('--repo-branch=') || arg.startsWith('--branch-fallback=')) {
            policyArgs.push(arg);
            continue;
        }
        if (arg === '--reset-repos') {
            policyArgs.push(arg);
            continue;
        }
        if (arg.startsWith('--')) continue;
        positional.push(arg);
    }

    if (positional.length >= 1) staticAgent = positional[0];
    if (positional.length >= 2) {
        port = positional[1];
    }

    return {
        staticAgent,
        port,
        profile,
        branchPolicy: parseBranchPolicy(policyArgs),
    };
}

export function resolveBranchForRepo(repoName, source, branchPolicy) {
    if (!branchPolicy) return source?.branch || null;
    if (branchPolicy.repoBranches[repoName]) {
        return branchPolicy.repoBranches[repoName];
    }
    if (source?.branch) return source.branch;
    if (branchPolicy.branch) return branchPolicy.branch;
    const stored = readStoredRepoSource(repoName);
    if (stored?.branch) return stored.branch;
    return null;
}

export function remoteBranchExists(repoPathOrUrl, branch) {
    if (!branch) return false;
    try {
        const output = execFileSync('git', ['ls-remote', '--heads', repoPathOrUrl, `refs/heads/${branch}`], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return String(output).trim().length > 0;
    } catch (_) {
        return false;
    }
}

function repoIsDirty(repoPath) {
    try {
        const status = String(execFileSync('git', ['-C', repoPath, 'status', '--porcelain'], {
            stdio: ['ignore', 'pipe', 'pipe'],
        }));
        return status.trim().length > 0;
    } catch (_) {
        return false;
    }
}

function currentBranch(repoPath) {
    try {
        return String(execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
            stdio: ['ignore', 'pipe', 'pipe'],
        })).trim();
    } catch (_) {
        return null;
    }
}

export function ensureRepoInstalled(name, url, { branchPolicy, branch, stdio = 'inherit' } = {}) {
    const reposDir = ensureReposDir();
    const repoPath = path.join(reposDir, name);
    const source = resolveRepoSource(name, url, branch);
    const actualUrl = source?.url || url || null;
    const resolvedBranch = resolveBranchForRepo(name, { branch: branch || source?.branch }, branchPolicy);

    if (fs.existsSync(repoPath)) {
        let actualBranch = resolvedBranch || currentBranch(repoPath);
        if (resolvedBranch && isGitRepository(repoPath)) {
            const switchResult = ensureRepoOnBranch(name, {
                branch: resolvedBranch,
                resetRepos: branchPolicy?.resetRepos || false,
                fallback: branchPolicy?.fallback || 'default',
                stdio,
            });
            actualBranch = switchResult?.branch || currentBranch(repoPath);
        }
        recordRepoSource(name, actualUrl, actualBranch);
        return { status: 'exists', path: repoPath, branch: actualBranch };
    }

    if (!actualUrl) throw new Error(`Missing repository URL for '${name}'.`);

    let cloneBranch = resolvedBranch;
    if (cloneBranch && !remoteBranchExists(actualUrl, cloneBranch)) {
        if (branchPolicy?.fallback === 'fail') {
            throw new Error(`Branch '${cloneBranch}' does not exist on remote for repo '${name}'. Aborting (--branch-fallback fail).`);
        }
        console.log(`[repos] Branch '${cloneBranch}' not found on remote for '${name}'; falling back to default branch.`);
        cloneBranch = null;
    }

    const args = ['clone'];
    if (cloneBranch) args.push('--branch', cloneBranch);
    args.push(actualUrl, repoPath);
    execFileSync('git', args, { stdio });
    recordRepoSource(name, actualUrl, cloneBranch);
    return { status: 'cloned', path: repoPath, branch: cloneBranch || 'default' };
}

export function ensureRepoOnBranch(name, { branch, resetRepos = false, fallback = 'default', stdio = 'inherit' } = {}) {
    if (!branch) return { status: 'noop', branch: null };
    const repoPath = path.join(PLOINKY_DIR, 'repos', name);
    if (!fs.existsSync(repoPath) || !isGitRepository(repoPath)) return { status: 'missing', branch: null };

    const current = currentBranch(repoPath);
    if (current === branch && !resetRepos) {
        recordRepoSource(name, resolveRepoSourceUrl(name), branch);
        return { status: 'current', branch };
    }

    if (repoIsDirty(repoPath)) {
        if (!resetRepos) {
            throw new Error(
                `Repository '${name}' has uncommitted changes and is on branch '${current}', ` +
                `not '${branch}'. Use --reset-repos to force checkout, or commit/stash changes first.`
            );
        }
    }

    try {
        execFileSync('git', ['-C', repoPath, 'fetch', '--prune'], { stdio });
    } catch (_) {}

    const localBranchExists = (() => {
        try {
            execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', `refs/heads/${branch}`], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            return true;
        } catch (_) {
            return false;
        }
    })();

    const remoteBranch = (() => {
        try {
            execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', `refs/remotes/origin/${branch}`], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            return true;
        } catch (_) {
            return false;
        }
    })();

    if (!localBranchExists && !remoteBranch) {
        if (fallback === 'fail') {
            throw new Error(`Branch '${branch}' does not exist locally or on remote for repo '${name}'. Aborting (--branch-fallback fail).`);
        }
        console.log(`[repos] Branch '${branch}' not available for '${name}'; keeping current branch '${current}'.`);
        return { status: 'fallback', branch: current, requestedBranch: branch };
    }

    if (resetRepos) {
        const target = remoteBranch ? `origin/${branch}` : branch;
        execFileSync('git', ['-C', repoPath, 'checkout', '-B', branch, target], { stdio });
        execFileSync('git', ['-C', repoPath, 'reset', '--hard', target], { stdio });
        execFileSync('git', ['-C', repoPath, 'clean', '-fd'], { stdio });
    } else {
        if (localBranchExists) {
            execFileSync('git', ['-C', repoPath, 'checkout', branch], { stdio });
        } else {
            execFileSync('git', ['-C', repoPath, 'checkout', '-b', branch, `origin/${branch}`], { stdio });
        }
    }

    recordRepoSource(name, resolveRepoSourceUrl(name), branch);
    return { status: 'switched', branch };
}
