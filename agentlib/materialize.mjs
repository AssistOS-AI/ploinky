// Explicit Git/network operations for a managed achillesAgentLib source.
//
// Nothing here runs as a side effect of an import. The caller decides when a
// managed generation may be staged, and holds the workspace AgentLib source
// lock while it does.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { AGENTLIB_ERROR_CODES, agentLibError, canonicalAgentLibRemote } from './contract.mjs';
import { fingerprintSource } from './fingerprint.mjs';
import {
    GENERATIONS_DIRNAME,
    buildSelection,
    generationDirName,
    managedGenerationsDir,
    managedMirrorPath,
    managedRootPath,
    validateAgentLibSource,
} from './source.mjs';

const GIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Default Git runner. Tests inject a stub so the selection layer can be
 * exercised without touching the network.
 *
 * @returns {{ run: (args: string[], opts?: object) => {status:number, stdout:string, stderr:string} }}
 */
export function createGitRunner({ spawn = spawnSync, env = process.env } = {}) {
    return {
        run(args, { cwd = undefined } = {}) {
            const result = spawn('git', args, {
                cwd,
                encoding: 'utf8',
                timeout: GIT_TIMEOUT_MS,
                env: { ...env, GIT_TERMINAL_PROMPT: '0' },
            });
            if (result.error) {
                throw agentLibError(
                    AGENTLIB_ERROR_CODES.materializeFailed,
                    `git ${args.join(' ')} failed: ${result.error.message}`,
                    { cause: result.error },
                );
            }
            return {
                status: result.status === null ? 1 : result.status,
                stdout: String(result.stdout || ''),
                stderr: String(result.stderr || ''),
            };
        },
    };
}

function git(runner, args, opts, what) {
    const result = runner.run(args, opts);
    if (result.status !== 0) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.materializeFailed,
            `${what} failed (git ${args.join(' ')}): ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`,
        );
    }
    return result;
}

/**
 * Resolve one exact remote commit for a ref.
 *
 * @returns {string|null} 40-hex commit, or null when the remote has no such ref
 */
export function resolveRemoteRef(remoteUrl, ref, { runner = createGitRunner() } = {}) {
    const result = runner.run(['ls-remote', remoteUrl, ref]);
    if (result.status !== 0) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.materializeFailed,
            `Unable to query the achillesAgentLib remote ${remoteUrl}: ${result.stderr.trim() || `exit ${result.status}`}`,
        );
    }
    const line = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean)[0];
    if (!line) return null;
    const commit = line.split(/\s+/)[0];
    return /^[0-9a-f]{40}$/.test(commit) ? commit : null;
}

/**
 * Decide which commit a managed source should be at, and whether resolving it
 * needs the network at all.
 *
 * An ordinary start with no explicit branch reuses the active managed commit
 * offline; only the lock commit or an explicit branch introduces a remote
 * lookup, and the lock commit is already immutable.
 *
 * @param {object} params
 * @param {object|null} params.activeDescriptor
 * @param {{branch: string|null, fallback: 'default'|'fail'}|null} params.branchPolicy
 * @param {string} params.defaultCommit - the canonical lock commit
 * @param {string} params.remoteUrl
 * @returns {{ commit: string, requestedRef: string|null, viaNetwork: boolean }}
 */
export function resolveManagedTarget({
    activeDescriptor = null,
    branchPolicy = null,
    defaultCommit,
    remoteUrl,
    runner = createGitRunner(),
}) {
    const branch = branchPolicy?.branch ? String(branchPolicy.branch) : null;
    if (branch) {
        const commit = resolveRemoteRef(remoteUrl, branch, { runner });
        if (commit) return { commit, requestedRef: branch, viaNetwork: true };
        if (branchPolicy?.fallback === 'fail') {
            throw agentLibError(
                AGENTLIB_ERROR_CODES.branchMissing,
                `Branch '${branch}' does not exist on the achillesAgentLib remote (${remoteUrl}); `
                + 'aborting (--branch-fallback fail).',
            );
        }
        return { commit: defaultCommit, requestedRef: branch, viaNetwork: true };
    }
    if (activeDescriptor?.mode === 'managed' && /^[0-9a-f]{40}$/.test(String(activeDescriptor.resolvedCommit || ''))) {
        return { commit: activeDescriptor.resolvedCommit, requestedRef: activeDescriptor.requestedRef || null, viaNetwork: false };
    }
    return { commit: defaultCommit, requestedRef: null, viaNetwork: false };
}

/**
 * An already-materialized, still-valid generation for `commit`, or null.
 *
 * Reuse is fully offline: it never consults the mirror or the remote.
 */
export function findExistingGeneration(workspaceRoot, commit, {
    fsApi = fs,
    runner = createGitRunner(),
} = {}) {
    const dir = managedGenerationsDir(workspaceRoot);
    let names;
    try {
        names = fsApi.readdirSync(dir);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    for (const name of names.sort()) {
        if (!name.startsWith(`${commit}-`)) continue;
        const candidate = path.join(dir, name);
        try {
            const { sourceDir } = validateAgentLibSource(candidate, { fsApi, deepSymlinkScan: false });
            const { fingerprint } = fingerprintSource(sourceDir, { fsApi });
            if (name !== generationDirName(commit, fingerprint)) continue;
            const head = runner.run(['rev-parse', 'HEAD'], { cwd: sourceDir });
            const status = runner.run(['status', '--porcelain', '--untracked-files=all'], { cwd: sourceDir });
            if (head.status !== 0 || head.stdout.trim() !== commit) continue;
            if (status.status !== 0 || status.stdout.trim() !== '') continue;
            return sourceDir;
        } catch (_) {
            // A half-written or corrupt generation is simply not reusable; it is
            // never deleted here because pruning requires proven non-use.
        }
    }
    return null;
}

function ensureMirror(workspaceRoot, remoteUrl, { runner, fsApi }) {
    const mirror = managedMirrorPath(workspaceRoot);
    fsApi.mkdirSync(managedRootPath(workspaceRoot), { recursive: true, mode: 0o700 });
    if (!fsApi.existsSync(path.join(mirror, 'HEAD'))) {
        git(runner, ['clone', '--mirror', remoteUrl, mirror], {}, 'achillesAgentLib mirror clone');
        return mirror;
    }
    const configured = runner.run(['config', '--get', 'remote.origin.url'], { cwd: mirror });
    const current = configured.stdout.trim();
    if (current && current !== remoteUrl) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.materializeFailed,
            `The managed AgentLib mirror at ${mirror} tracks '${current}' but the canonical remote is '${remoteUrl}'.`,
        );
    }
    return mirror;
}

function mirrorHasCommit(runner, mirror, commit) {
    return runner.run(['cat-file', '-e', `${commit}^{commit}`], { cwd: mirror }).status === 0;
}

function removeTree(target, fsApi) {
    try {
        fsApi.rmSync(target, { recursive: true, force: true });
    } catch (_) { /* best effort staging cleanup */ }
}

/**
 * Stage one immutable managed generation for `commit`.
 *
 * The staged tree is built under a temporary name and only then renamed to its
 * content-addressed generation directory, so a generation that other consumers
 * may already have mounted is never modified in place.
 *
 * @returns {{ sourceDir: string, commit: string, reused: boolean }}
 */
export function materializeManagedGeneration({
    workspaceRoot,
    commit,
    remoteUrl,
    runner = createGitRunner(),
    fsApi = fs,
}) {
    if (!/^[0-9a-f]{40}$/.test(String(commit))) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.materializeFailed,
            `A managed AgentLib generation requires an exact 40-hex commit (got ${String(commit)}).`,
        );
    }
    const existing = findExistingGeneration(workspaceRoot, commit, { fsApi, runner });
    if (existing) return { sourceDir: existing, commit, reused: true };

    const mirror = ensureMirror(workspaceRoot, remoteUrl, { runner, fsApi });
    if (!mirrorHasCommit(runner, mirror, commit)) {
        git(runner, ['fetch', '--prune', 'origin', '+refs/*:refs/*'], { cwd: mirror }, 'achillesAgentLib mirror fetch');
    }
    if (!mirrorHasCommit(runner, mirror, commit)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.materializeFailed,
            `Commit ${commit} is not present on the achillesAgentLib remote ${remoteUrl}.`,
        );
    }

    const generations = managedGenerationsDir(workspaceRoot);
    fsApi.mkdirSync(generations, { recursive: true, mode: 0o700 });
    const staging = path.join(generations, `.staging-${commit}-${process.pid}`);
    removeTree(staging, fsApi);
    try {
        git(runner, ['clone', '--no-checkout', '--shared', mirror, staging], {}, 'achillesAgentLib generation clone');
        git(runner, ['checkout', '--detach', commit], { cwd: staging }, 'achillesAgentLib generation checkout');
        const { fingerprint } = fingerprintSource(fsApi.realpathSync(staging), { fsApi });
        const finalDir = path.join(generations, generationDirName(commit, fingerprint));
        if (fsApi.existsSync(finalDir)) {
            // Another holder of the lock may have won the race. Reuse it only
            // after the same commit/content/cleanliness proof as an offline
            // generation; a mutated directory is never relabelled as clean.
            removeTree(staging, fsApi);
            const existingWinner = findExistingGeneration(workspaceRoot, commit, { fsApi, runner });
            if (existingWinner === fsApi.realpathSync(finalDir)) {
                return { sourceDir: existingWinner, commit, reused: true };
            }
            throw agentLibError(
                AGENTLIB_ERROR_CODES.materializeFailed,
                `Managed achillesAgentLib generation ${finalDir} exists but no longer matches commit ${commit}; `
                + 'refusing to reuse or overwrite it.',
            );
        }
        fsApi.renameSync(staging, finalDir);
        const { sourceDir } = validateAgentLibSource(finalDir, { fsApi });
        return { sourceDir, commit, reused: false };
    } catch (error) {
        removeTree(staging, fsApi);
        throw error;
    }
}

/**
 * Select or stage a managed source and return a full selection descriptor.
 *
 * @param {object} params
 * @param {string} params.workspaceRoot
 * @param {object|null} [params.activeDescriptor]
 * @param {{branch:string|null,fallback:'default'|'fail'}|null} [params.branchPolicy]
 * @param {object} [params.remote] - overrides the canonical lock entry (tests)
 */
export function selectManagedSource({
    workspaceRoot,
    activeDescriptor = null,
    branchPolicy = null,
    remote = null,
    runner = createGitRunner(),
    fsApi = fs,
    now,
}) {
    const { url, commit: defaultCommit } = remote || canonicalAgentLibRemote({ fsApi });
    const target = resolveManagedTarget({
        activeDescriptor,
        branchPolicy,
        defaultCommit,
        remoteUrl: url,
        runner,
    });
    const { sourceDir, reused } = materializeManagedGeneration({
        workspaceRoot,
        commit: target.commit,
        remoteUrl: url,
        runner,
        fsApi,
    });
    const selection = buildSelection({
        workspaceRoot,
        sourceDir,
        mode: 'managed',
        remoteUrl: url,
        requestedRef: target.requestedRef,
        resolvedCommit: target.commit,
        dirty: false,
        fsApi,
        ...(now ? { now } : {}),
    });
    return { selection, reused, viaNetwork: target.viaNetwork };
}

/**
 * Generation directories that are safe to prune.
 *
 * Ambiguous ownership means preserve: a generation is only prunable when it is
 * absent from every reference set the caller could enumerate.
 *
 * @param {string} workspaceRoot
 * @param {Set<string>|string[]} referencedDirs - absolute generation paths still in use
 */
export function prunableGenerations(workspaceRoot, referencedDirs, { fsApi = fs } = {}) {
    const referenced = new Set(Array.from(referencedDirs || []).map((p) => path.resolve(p)));
    const dir = managedGenerationsDir(workspaceRoot);
    let names;
    try {
        names = fsApi.readdirSync(dir);
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
    return names
        .filter((name) => !name.startsWith('.staging-'))
        .map((name) => path.join(dir, name))
        .filter((candidate) => !referenced.has(path.resolve(candidate)));
}

export { GENERATIONS_DIRNAME };
