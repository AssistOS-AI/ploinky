import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { resolvePloinkyUpdateEligibility } from './ploinkyUpdateScope.js';
import {
    GIT_UPDATE_STRATEGY,
    GitUpdateError,
    updateCheckoutFastForward,
} from '../utils/git/verifiedUpdate.js';
import { acquireSourceLock, createDefaultSourceLockManager, ploinkySourceLockIdentity } from '../utils/git/sourceLock.js';
import { assessGeneratedCheckoutState } from '../utils/git/generatedState.js';

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

function legacySelfUpdateResult(record, repoPath) {
    const before = record.before?.head || null;
    const after = record.after?.head || before;
    if (record.outcome === 'changed' || record.outcome === 'unchanged') {
        return {
            updated: record.outcome === 'changed',
            repoPath,
            before,
            after,
            code: record.code,
            pullStrategy: GIT_UPDATE_STRATEGY,
            record,
        };
    }
    if (record.outcome === 'skipped') {
        return {
            skipped: true,
            reason: record.reason,
            code: record.code,
            repoPath,
            before,
            pullStrategy: GIT_UPDATE_STRATEGY,
            record,
        };
    }
    throw new GitUpdateError(record);
}

/**
 * Update a Ploinky source checkout by a verified fast-forward.
 *
 * Outside the Box the mutation holds the host Ploinky source lock (the same
 * lock manager and name as `ploinky-box/command/hostUpdate.mjs`) and releases
 * it before returning, so it is never held across a relaunch or a workspace
 * lock acquisition. A caller that already holds that lock passes it as
 * `heldSourceLock` ({ lockIdentity, lock }) instead of re-acquiring it.
 *
 * A named Git skip (dirty, diverged, detached, ...) returns `{ skipped: true,
 * code, reason, record }`; failed/uncertain outcomes throw a GitUpdateError
 * carrying the operation record.
 */
export async function updatePloinkySelf({
    repoPath = resolvePloinkyRoot(),
    updateScopePath,
    interactiveSession = false,
    logger = defaultLogger(),
    boxMarkerPath = PLOINKY_BOX_MARKER_PATH,
    exists = fs.existsSync,
    checkUpdate = checkGitUpstreamUpdate,
    updateCheckout = updateCheckoutFastForward,
    phase = 'host-ploinky',
    heldSourceLock = null,
    sourceLockManager = null,
    checkoutOptions = {},
    assessGeneratedState = assessGeneratedCheckoutState,
} = {}) {
    if (updateScopePath) {
        const scope = resolvePloinkyUpdateEligibility({ repoPath, updateScopePath });
        repoPath = scope.checkoutRoot;
        if (!scope.eligible) {
            logger.warn?.(`Skipping Ploinky self-update: ${scope.reason}.`);
            return {
                skipped: true,
                scopeExcluded: true,
                reason: scope.reason,
                repoPath,
                updateScopePath: scope.scopeRoot,
            };
        }
    }

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

    const source = ploinkySourceLockIdentity(repoPath);
    let lock;
    let owned = false;
    if (heldSourceLock) {
        if (heldSourceLock.lockIdentity !== source.lockIdentity || typeof heldSourceLock.lock?.assertHeld !== 'function') {
            throw new Error(`Ploinky self-update was given a source lock for a different checkout than ${source.canonicalRoot}`);
        }
        lock = heldSourceLock.lock;
    } else {
        const manager = sourceLockManager || await createDefaultSourceLockManager();
        lock = await acquireSourceLock(manager, source.lockIdentity);
        owned = true;
    }
    let record;
    try {
        lock.assertHeld(source.lockIdentity);
        record = updateCheckout({
            ...checkoutOptions,
            repoPath: source.canonicalRoot,
            phase,
            id: source.canonicalRoot,
            policy: { kind: 'generic' },
            assessGeneratedState,
        });
    } finally {
        if (owned) lock.release();
    }
    return legacySelfUpdateResult(record, source.canonicalRoot);
}
