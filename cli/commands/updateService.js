import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

export const PLOINKY_BOX_MARKER_PATH = '/etc/ploinky-box';
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
    boxMarkerPath = PLOINKY_BOX_MARKER_PATH,
    exists = fs.existsSync,
    checkUpdate = checkGitUpstreamUpdate,
    pull = pullGitRepo,
    getRef = getGitRef,
} = {}) {
    if (exists(boxMarkerPath)) {
        logger.warn?.(
            `Skipping Ploinky self-update inside ploinky-box: ${repoPath} is mounted read-only.`,
        );
        return {
            skipped: true,
            boxed: true,
            reason: 'Ploinky source is mounted read-only inside ploinky-box',
            repoPath,
        };
    }

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
 * dependency map (e.g. mcp-sdk `#main` or an explicit deploy-time override).
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
