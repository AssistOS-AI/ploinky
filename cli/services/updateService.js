import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { PLOINKY_DIR } from './config.js';

const ACHILLES_PACKAGE_NAME = 'achillesAgentLib';
const ACHILLES_REPO_URL = 'https://github.com/OutfinityResearch/achillesAgentLib.git';
const DEPENDENCY_SECTIONS = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
];

export const INTERACTIVE_PLOINKY_UPDATE_MESSAGE = [
    'A newer Ploinky version is available, but this interactive session is already running loaded code.',
    'Close this session, run `ploinky update` from your shell, then start Ploinky again so the new changes are visible.',
].join('\n');

function defaultLogger() {
    return console;
}

export function resolvePloinkyRoot() {
    const envRoot = String(process.env.PLOINKY_ROOT || '').trim();
    if (envRoot) return path.resolve(envRoot);
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

function isDirectory(dir) {
    try {
        return fs.statSync(dir).isDirectory();
    } catch (_) {
        return false;
    }
}

export function isGitRepo(repoPath) {
    return isDirectory(path.join(repoPath, '.git'))
        || fs.existsSync(path.join(repoPath, '.git'));
}

function gitOutput(repoPath, args, { execFile = execFileSync } = {}) {
    return String(execFile('git', ['-C', repoPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
    }) || '').trim();
}

export function getGitRef(repoPath, ref = 'HEAD', options = {}) {
    return gitOutput(repoPath, ['rev-parse', ref], options);
}

function runGit(repoPath, args, { spawn = spawnSync, stdio = 'inherit' } = {}) {
    const result = spawn('git', ['-C', repoPath, ...args], { stdio });
    if (result.error) {
        throw new Error(`git ${args.join(' ')} failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} exited with code ${result.status}`);
    }
    return result;
}

export function pullGitRepo(repoPath, {
    rebase = true,
    autostash = true,
    spawn = spawnSync,
    stdio = 'inherit',
} = {}) {
    const args = ['pull'];
    if (rebase) args.push('--rebase');
    if (autostash) args.push('--autostash');
    runGit(repoPath, args, { spawn, stdio });
    return true;
}

export function checkGitUpstreamUpdate(repoPath, {
    execFile = execFileSync,
    spawn = spawnSync,
} = {}) {
    if (!isGitRepo(repoPath)) {
        return { available: false, skipped: true, reason: 'not a git repository' };
    }

    let upstreamRef;
    try {
        upstreamRef = gitOutput(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { execFile });
    } catch (_) {
        return { available: false, skipped: true, reason: 'no upstream branch' };
    }

    runGit(repoPath, ['fetch', '--quiet'], { spawn, stdio: 'ignore' });

    const head = getGitRef(repoPath, 'HEAD', { execFile });
    const upstream = getGitRef(repoPath, '@{u}', { execFile });
    if (!head || !upstream || head === upstream) {
        return { available: false, head, upstream, upstreamRef };
    }

    const contains = spawn('git', ['-C', repoPath, 'merge-base', '--is-ancestor', upstream, 'HEAD'], {
        stdio: 'ignore',
    });
    if (contains.error) {
        throw new Error(`git merge-base failed: ${contains.error.message}`);
    }

    return {
        available: contains.status !== 0,
        head,
        upstream,
        upstreamRef,
    };
}

export function updatePloinkySelf({
    repoPath = resolvePloinkyRoot(),
    interactiveSession = false,
    logger = defaultLogger(),
    checkUpdate = checkGitUpstreamUpdate,
    pull = pullGitRepo,
    getRef = getGitRef,
} = {}) {
    if (!isGitRepo(repoPath)) {
        logger.warn?.(`Skipping Ploinky self-update: ${repoPath} is not a git repository.`);
        return { skipped: true, reason: 'not a git repository', repoPath };
    }

    if (interactiveSession) {
        const check = checkUpdate(repoPath);
        if (check.available) {
            logger.warn?.(INTERACTIVE_PLOINKY_UPDATE_MESSAGE);
            return {
                deferred: true,
                updateAvailable: true,
                repoPath,
                before: check.head,
                after: check.upstream,
            };
        }
        return {
            updated: false,
            updateAvailable: false,
            skipped: check.skipped === true,
            reason: check.reason,
            repoPath,
            before: check.head,
            after: check.upstream || check.head,
        };
    }

    const before = getRef(repoPath, 'HEAD');
    pull(repoPath);
    const after = getRef(repoPath, 'HEAD');
    return {
        updated: Boolean(before && after && before !== after),
        repoPath,
        before,
        after,
    };
}

function hasAchillesDependency(pkg) {
    for (const section of DEPENDENCY_SECTIONS) {
        const deps = pkg?.[section];
        if (deps && Object.prototype.hasOwnProperty.call(deps, ACHILLES_PACKAGE_NAME)) {
            return true;
        }
    }
    return false;
}

export function findAchillesDependencyPackages(rootDir) {
    const root = path.resolve(rootDir);
    if (!isDirectory(root)) return [];

    const packages = [];
    const ignored = new Set(['.git', 'node_modules']);

    function visit(dir) {
        const packagePath = path.join(dir, 'package.json');
        if (fs.existsSync(packagePath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
                if (hasAchillesDependency(pkg)) {
                    packages.push({ packageDir: dir, packagePath });
                }
            } catch (_) {
                // Ignore malformed package files during discovery; npm will report
                // actionable errors if an explicitly updated package is invalid.
            }
        }

        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
            visit(path.join(dir, entry.name));
        }
    }

    visit(root);
    return packages;
}

function runCommand(command, args, {
    cwd,
    spawn = spawnSync,
    stdio = 'inherit',
} = {}) {
    const result = spawn(command, args, { cwd, stdio });
    if (result.error) {
        throw new Error(`${command} ${args.join(' ')} failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
    }
    return result;
}

function cloneAchillesDependency(targetPath, {
    sourceUrl = ACHILLES_REPO_URL,
    spawn = spawnSync,
    stdio = 'inherit',
} = {}) {
    const nodeModulesDir = path.dirname(targetPath);
    fs.mkdirSync(nodeModulesDir, { recursive: true });

    const tempPath = path.join(
        nodeModulesDir,
        `.${ACHILLES_PACKAGE_NAME}.clone-${process.pid}-${Date.now()}`,
    );
    const backupPath = path.join(
        nodeModulesDir,
        `.${ACHILLES_PACKAGE_NAME}.replace-${process.pid}-${Date.now()}`,
    );

    let backedUp = false;
    let installed = false;

    try {
        runCommand('git', ['clone', '--quiet', sourceUrl, tempPath], {
            cwd: nodeModulesDir,
            spawn,
            stdio,
        });
        if (fs.existsSync(targetPath)) {
            fs.renameSync(targetPath, backupPath);
            backedUp = true;
        }
        fs.renameSync(tempPath, targetPath);
        installed = true;
        if (backedUp) {
            fs.rmSync(backupPath, { recursive: true, force: true });
        }
    } catch (err) {
        if (!installed && backedUp && !fs.existsSync(targetPath)) {
            try { fs.renameSync(backupPath, targetPath); } catch (_) {}
        }
        try { fs.rmSync(tempPath, { recursive: true, force: true }); } catch (_) {}
        if (installed) {
            try { fs.rmSync(backupPath, { recursive: true, force: true }); } catch (_) {}
        }
        throw err;
    }
}

/**
 * Parse an npm dependency spec into the git { url, ref } it points at, when the
 * spec is a *moving* git source (a branch/tag, or the implicit default branch).
 *
 * Returns null for non-git specs (semver ranges, tarballs) and for git specs
 * pinned to a 40-char commit SHA — those cannot advance, so they never need
 * cache invalidation. The npm `git+` scheme prefix is stripped so the URL is
 * usable directly with `git ls-remote`.
 *
 * @param {string} spec
 * @returns {{ url: string, ref: string }|null}
 */
export function parseGitDependencyRef(spec) {
    const raw = String(spec || '').trim();
    if (!raw) return null;
    const isGit = /^git\+/.test(raw)
        || /^git:\/\//.test(raw)
        || /^git@/.test(raw)
        || /^https?:\/\/.+\.git(#|$)/.test(raw);
    if (!isGit) return null;
    let url = raw.replace(/^git\+/, '');
    let ref = '';
    const hashIdx = url.indexOf('#');
    if (hashIdx >= 0) {
        ref = url.slice(hashIdx + 1);
        url = url.slice(0, hashIdx);
    }
    if (/^[0-9a-f]{40}$/i.test(ref)) return null; // pinned commit cannot move
    return { url, ref: ref || 'HEAD' };
}

/**
 * Resolve the commit a git url+ref currently points at via `git ls-remote`.
 * Returns null on any failure (offline, unknown ref, malformed output) so
 * callers fail open instead of acting on an unverified ref.
 *
 * @param {string} url
 * @param {string} ref
 * @param {object} [options]
 * @param {Function} [options.execFile=execFileSync] - injectable for tests.
 * @returns {string|null} 40-char hex sha, or null.
 */
export function resolveGitRefCommit(url, ref, { execFile = execFileSync } = {}) {
    try {
        const out = String(execFile('git', ['ls-remote', url, ref], {
            stdio: ['ignore', 'pipe', 'pipe'],
        }) || '').trim();
        if (!out) return null;
        const sha = out.split('\n')[0].trim().split(/\s+/)[0];
        return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
    } catch (_) {
        return null;
    }
}

/**
 * Resolve the upstream commit of every *moving* git dependency in a package's
 * dependency map (e.g. achillesAgentLib `#master`, mcp-sdk `#main`).
 *
 * `ploinky update` uses this to detect when a moving ref advanced even though
 * its package.json spec string — and therefore the dependency-cache hash — is
 * unchanged. It resolves the authoritative upstream tip (what a fresh cache
 * `npm install` would fetch) via `git ls-remote`; `ploinky update` is already
 * online. Deps that cannot be resolved are omitted (fail-open).
 *
 * @param {Record<string,string>} dependencies - dependency name -> spec map.
 * @param {object} [options]
 * @param {Function} [options.execFile=execFileSync] - injectable for tests.
 * @returns {Record<string,string>} name -> resolved sha (only moving git deps that resolved).
 */
export function resolveMovingGitDepCommits(dependencies, { execFile = execFileSync } = {}) {
    const commits = {};
    for (const [name, spec] of Object.entries(dependencies || {})) {
        const parsed = parseGitDependencyRef(spec);
        if (!parsed) continue;
        const sha = resolveGitRefCommit(parsed.url, parsed.ref, { execFile });
        if (sha) commits[name] = sha;
    }
    return commits;
}

export function refreshPloinkyRuntimeAchillesDependency({
    ploinkyRoot = resolvePloinkyRoot(),
    sourceUrl = ACHILLES_REPO_URL,
    spawn = spawnSync,
    stdio = 'inherit',
} = {}) {
    const packageDir = path.resolve(ploinkyRoot);
    const installedPath = path.join(packageDir, 'node_modules', ACHILLES_PACKAGE_NAME);

    if (isGitRepo(installedPath)) {
        runCommand('git', ['pull', '--rebase', '--autostash'], {
            cwd: installedPath,
            spawn,
            stdio,
        });
        return { packageDir, installedPath, method: 'git-pull' };
    }

    cloneAchillesDependency(installedPath, { sourceUrl, spawn, stdio });
    return { packageDir, installedPath, method: 'git-clone' };
}

export function refreshAchillesDependencyPackage(packageDir, {
    spawn = spawnSync,
    stdio = 'inherit',
} = {}) {
    const installedPath = path.join(packageDir, 'node_modules', ACHILLES_PACKAGE_NAME);
    if (isGitRepo(installedPath)) {
        runCommand('git', ['pull', '--rebase', '--autostash'], {
            cwd: installedPath,
            spawn,
            stdio,
        });
        return { packageDir, method: 'git-pull' };
    }

    runCommand('npm', ['update', ACHILLES_PACKAGE_NAME, '--no-package-lock'], {
        cwd: packageDir,
        spawn,
        stdio,
    });
    return { packageDir, method: 'npm-update' };
}

export function refreshAchillesDependenciesInRepos({
    reposRoot = path.join(PLOINKY_DIR, 'repos'),
    logger = defaultLogger(),
    spawn = spawnSync,
    stdio = 'inherit',
} = {}) {
    const packages = findAchillesDependencyPackages(reposRoot);
    const refreshed = [];
    const failed = [];

    if (!packages.length) {
        return { total: 0, refreshed, failed };
    }

    logger.log?.(`Refreshing ${ACHILLES_PACKAGE_NAME} in .ploinky repositories...`);
    for (const pkg of packages) {
        try {
            const result = refreshAchillesDependencyPackage(pkg.packageDir, { spawn, stdio });
            refreshed.push(result);
            logger.log?.(`  ✓ ${path.relative(reposRoot, pkg.packageDir) || '.'} (${result.method})`);
        } catch (err) {
            const message = err?.message || String(err);
            failed.push({ packageDir: pkg.packageDir, message });
            logger.error?.(`  ✗ ${path.relative(reposRoot, pkg.packageDir) || '.'}: ${message}`);
        }
    }

    return { total: packages.length, refreshed, failed };
}
