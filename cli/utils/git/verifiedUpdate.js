import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createOperationRecord, sanitizeReason } from '../../commands/updateOutcome.js';
import { DEFAULT_NETWORK_TIMEOUT_MS, describeGitFailure, runGit } from './gitExec.js';
import { acquireCheckoutLock } from './checkoutLock.js';

// One verified Git update contract for every `ploinky update` writer:
// registered repositories, generic workspace repositories and both Ploinky
// source writers.
//
// The promise is "verified clean fast-forward or preserved state", never an
// atomic pull. A checkout is only advanced when it is on its expected branch,
// has no staged, unstaged or unmerged tracked changes, no operation in
// progress and no Git lock, and the fetched target strictly descends from the
// current HEAD. Otherwise the checkout is left byte-for-byte untouched and a
// named outcome is returned. There is no stash, reset, rebase, abort or Git
// lock deletion anywhere in this module.
//
// Injected generated-state assessment (P4 seam)
// --------------------------------------------
// `assessGeneratedState({ repoPath, preflight })` runs under the checkout lock
// after operation/lock checks and before branch/dirty classification. It may
// return:
//   { status: 'none' }                      nothing to do; classification continues
//   { status: 'restored', paths: [...] }    it restored proven generated state; the
//                                           preflight is recaptured before classifying
//   { status: 'preserve', code, reason }    leave everything untouched; the result is a
//                                           `skipped` record with that code
// Any other value, or a thrown error, preserves the checkout and yields an
// `uncertain` record with code `assessment-failed`.

export const GIT_UPDATE_STRATEGY = 'fast-forward-only';
const PATH_SAMPLE_LIMIT = 50;
const PRIVATE_REF_PREFIX = 'refs/ploinky-update';

export class GitUpdateError extends Error {
    constructor(record) {
        super(record?.reason || `Git update ${record?.outcome || 'failed'}`);
        this.name = 'GitUpdateError';
        this.code = `PLOINKY_GIT_UPDATE_${String(record?.outcome || 'failed').toUpperCase()}`;
        this.record = record;
    }
}

export function isVerifiedRecord(record) {
    return record?.outcome === 'changed' || record?.outcome === 'unchanged';
}

function realpathOrNull(target) {
    try {
        return fs.realpathSync.native(target);
    } catch (_) {
        return null;
    }
}

function lines(text) {
    return String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
}

function sample(list) {
    return list.slice(0, PATH_SAMPLE_LIMIT);
}

// `git status --porcelain=v2 -z --untracked-files=all`
export function parsePorcelainV2(output) {
    const tokens = String(output || '').split('\0');
    const state = { staged: [], unstaged: [], untracked: [], unmerged: [], ignored: [] };
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!token) continue;
        const kind = token[0];
        if (kind === '?') {
            state.untracked.push(token.slice(2));
        } else if (kind === '!') {
            state.ignored.push(token.slice(2));
        } else if (kind === '1' || kind === '2') {
            const fieldCount = kind === '1' ? 8 : 9;
            const parts = token.split(' ');
            const xy = parts[1] || '..';
            const filePath = parts.slice(fieldCount).join(' ');
            if (xy[0] !== '.') state.staged.push(filePath);
            if (xy[1] !== '.') state.unstaged.push(filePath);
            if (kind === '2') index += 1; // original path of a rename/copy
        } else if (kind === 'u') {
            state.unmerged.push(token.split(' ').slice(10).join(' '));
        }
    }
    return state;
}

function fileExists(target) {
    try {
        fs.lstatSync(target);
        return true;
    } catch (_) {
        return false;
    }
}

function inspectOperations(gitDir, commonDir, branch) {
    const inGitDir = name => path.join(gitDir, name);
    const operations = {
        rebaseMerge: fileExists(inGitDir('rebase-merge')),
        rebaseApply: fileExists(inGitDir('rebase-apply')),
        merge: fileExists(inGitDir('MERGE_HEAD')),
        cherryPick: fileExists(inGitDir('CHERRY_PICK_HEAD')),
        revert: fileExists(inGitDir('REVERT_HEAD')),
        sequencer: fileExists(inGitDir('sequencer')),
        bisect: fileExists(inGitDir('BISECT_LOG')),
    };
    const autostash = [
        'rebase-merge/autostash',
        'rebase-apply/autostash',
        'MERGE_AUTOSTASH',
    ].filter(name => fileExists(inGitDir(name)));
    const lockCandidates = [
        [gitDir, 'index.lock'],
        [gitDir, 'HEAD.lock'],
        [commonDir, 'packed-refs.lock'],
        [commonDir, 'config.lock'],
    ];
    if (branch) lockCandidates.push([commonDir, `refs/heads/${branch}.lock`]);
    const locks = lockCandidates
        .filter(([base, name]) => fileExists(path.join(base, name)))
        .map(([base, name]) => (base === gitDir ? name : `common:${name}`));
    const active = Object.entries(operations).filter(([, present]) => present).map(([name]) => name);
    return { ...operations, active, autostash, locks };
}

function gitValue(exec, repoPath, args, options) {
    const result = exec(repoPath, args, options);
    return result.ok ? result.stdout.trim() : '';
}

/**
 * Resolve the checkout identity without mutating anything. Returns null when
 * `repoPath` is not the top level of a Git worktree (a non-Git directory
 * nested in another repository must never be treated as that repository).
 */
export function resolveCheckoutIdentity(repoPath, { exec = runGit, env = process.env } = {}) {
    const canonical = realpathOrNull(repoPath);
    if (!canonical) return { ok: false, code: 'checkout-missing', reason: `checkout ${repoPath} does not exist` };
    const result = exec(repoPath, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { env });
    if (!result.ok) {
        return { ok: false, code: 'not-a-git-checkout', reason: `${repoPath} is not a Git checkout` };
    }
    const [toplevelRaw, gitDirRaw, commonRaw] = String(result.stdout).split('\n');
    const toplevel = realpathOrNull(toplevelRaw || '');
    const gitDir = realpathOrNull(gitDirRaw || '');
    const commonDir = realpathOrNull(path.resolve(repoPath, commonRaw || ''));
    if (!toplevel || !gitDir || !commonDir) {
        return { ok: false, code: 'not-a-git-checkout', reason: `${repoPath} has no resolvable Git directories` };
    }
    if (toplevel !== canonical) {
        return {
            ok: false,
            code: 'not-repository-root',
            reason: `${repoPath} is inside another Git checkout (${toplevel}), not a repository root`,
        };
    }
    return { ok: true, requested: repoPath, canonical, toplevel, gitDir, commonDir };
}

/**
 * Capture the complete preflight record under the checkout lock.
 */
export function capturePreflight(identity, { exec = runGit, env = process.env, transactionId } = {}) {
    const repoPath = identity.requested;
    const symbolic = exec(repoPath, ['symbolic-ref', '-q', 'HEAD'], { env });
    const symbolicRef = symbolic.ok ? symbolic.stdout.trim() : '';
    const branch = symbolicRef.startsWith('refs/heads/') ? symbolicRef.slice('refs/heads/'.length) : null;
    const head = gitValue(exec, repoPath, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { env }) || null;
    let upstream = null;
    if (branch) {
        const remote = gitValue(exec, repoPath, ['config', '--get', `branch.${branch}.remote`], { env });
        const mergeRef = gitValue(exec, repoPath, ['config', '--get', `branch.${branch}.merge`], { env });
        if (remote || mergeRef) upstream = { remote, mergeRef };
    }
    const statusResult = exec(repoPath, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all'], { env });
    const status = statusResult.ok ? parsePorcelainV2(statusResult.stdout) : null;
    const stashResult = exec(repoPath, ['stash', 'list', '--format=%H'], { env });
    const stashes = stashResult.ok ? lines(stashResult.stdout) : null;
    const sshConfigured = Boolean(gitValue(exec, repoPath, ['config', '--get', 'core.sshCommand'], { env }));
    return {
        transactionId,
        capturedAt: new Date().toISOString(),
        checkout: {
            path: identity.canonical,
            toplevel: identity.toplevel,
            gitDir: identity.gitDir,
            commonDir: identity.commonDir,
        },
        symbolicRef: symbolicRef || null,
        branch,
        head,
        upstream,
        status,
        statusError: statusResult.ok ? '' : describeGitFailure(statusResult),
        stashes,
        operations: inspectOperations(identity.gitDir, identity.commonDir, branch),
        sshConfigured,
    };
}

// Remote values may be URLs with embedded credentials; evidence keeps them sanitized.
function sanitizeUpstream(upstream) {
    if (!upstream) return upstream;
    return { ...upstream, remote: upstream.remote ? sanitizeReason(upstream.remote) : upstream.remote };
}

export function summarizePreflight(preflight) {
    if (!preflight) return null;
    const status = preflight.status || { staged: [], unstaged: [], untracked: [], unmerged: [] };
    return {
        branch: preflight.branch,
        head: preflight.head,
        upstream: sanitizeUpstream(preflight.upstream),
        staged: { count: status.staged.length, paths: sample(status.staged) },
        unstaged: { count: status.unstaged.length, paths: sample(status.unstaged) },
        untracked: { count: status.untracked.length, paths: sample(status.untracked) },
        unmerged: { count: status.unmerged.length, paths: sample(status.unmerged) },
        stashes: preflight.stashes,
        operations: {
            active: preflight.operations.active,
            autostash: preflight.operations.autostash,
            locks: preflight.operations.locks,
        },
    };
}

function selectTarget(preflight, policy) {
    const branch = preflight.branch;
    if (policy.kind === 'registered') {
        if (policy.branch) {
            if (branch !== policy.branch) {
                return { skip: 'branch-mismatch', reason: `checkout is on branch '${branch}', not the requested branch '${policy.branch}'` };
            }
            return { remote: 'origin', mergeRef: `refs/heads/${policy.branch}` };
        }
        if (!preflight.upstream?.remote || !preflight.upstream?.mergeRef) {
            return { skip: 'no-upstream', reason: `branch '${branch}' has no configured upstream` };
        }
        if (preflight.upstream.remote !== 'origin' || preflight.upstream.mergeRef !== `refs/heads/${branch}`) {
            return {
                skip: 'upstream-mismatch',
                reason: `checkout is on branch '${branch}' but its upstream is '${preflight.upstream.remote}:${preflight.upstream.mergeRef}'. `
                    + 'Refusing to pull a different source or branch into this cache; correct the upstream to the same branch on origin '
                    + 'or specify the intended branch in the skills manifest.',
            };
        }
        return { remote: 'origin', mergeRef: preflight.upstream.mergeRef };
    }
    if (!preflight.upstream?.remote || !preflight.upstream?.mergeRef) {
        return { skip: 'no-upstream', reason: `branch '${branch}' has no configured upstream` };
    }
    return { remote: preflight.upstream.remote, mergeRef: preflight.upstream.mergeRef };
}

// Pre-existing operation or Git lock state: preserved, reported as uncertain.
function classifyRecoveryState(preflight) {
    const operations = preflight.operations;
    if (operations.autostash.length) {
        return {
            outcome: 'uncertain',
            code: 'recovery-required',
            reason: `an autostash is held in Git operation metadata (${operations.autostash.join(', ')}); `
                + 'finish or abort that operation manually',
        };
    }
    if (operations.active.length) {
        return {
            outcome: 'uncertain',
            code: 'recovery-required',
            reason: `a Git operation is in progress (${operations.active.join(', ')}); finish or abort it manually`,
        };
    }
    if (operations.locks.length) {
        return {
            outcome: 'uncertain',
            code: 'git-lock-present',
            reason: `Git lock files are present (${operations.locks.join(', ')}); another Git process may be running`,
        };
    }
    if (!preflight.status || !preflight.stashes) {
        return { outcome: 'failed', code: 'status-unavailable', reason: preflight.statusError || 'unable to read the checkout status' };
    }
    return null;
}

function classifyWorkingState(preflight) {
    const status = preflight.status;
    if (status.unmerged.length) {
        return { outcome: 'skipped', code: 'unmerged-paths', reason: `unmerged paths are present (${sample(status.unmerged).join(', ')})` };
    }
    if (!preflight.head) {
        return { outcome: 'skipped', code: 'unborn-head', reason: 'the checkout has no commit yet' };
    }
    if (!preflight.branch) {
        return { outcome: 'skipped', code: 'detached-head', reason: 'the checkout is not on a branch (detached HEAD)' };
    }
    if (status.staged.length) {
        return {
            outcome: 'skipped',
            code: 'dirty-index',
            reason: `staged changes are present (${sample(status.staged).join(', ')}); commit or unstage them before updating`,
        };
    }
    if (status.unstaged.length) {
        return {
            outcome: 'skipped',
            code: 'dirty-worktree',
            reason: `uncommitted changes are present (${sample(status.unstaged).join(', ')}); commit or discard them before updating`,
        };
    }
    return null;
}

function pathsCollide(untracked, incoming) {
    const incomingSet = new Set(incoming);
    const collisions = [];
    for (const file of untracked) {
        if (incomingSet.has(file)) {
            collisions.push(file);
            continue;
        }
        if (incoming.some(entry => entry.startsWith(`${file}/`) || file.startsWith(`${entry}/`))) collisions.push(file);
    }
    return collisions;
}

function sameObservation(first, second) {
    return first.checkout.toplevel === second.checkout.toplevel
        && first.checkout.gitDir === second.checkout.gitDir
        && first.checkout.commonDir === second.checkout.commonDir
        && first.symbolicRef === second.symbolicRef
        && first.head === second.head
        && JSON.stringify(first.upstream) === JSON.stringify(second.upstream);
}

/**
 * Update one checkout by a verified fast-forward.
 *
 * @param {object} options
 * @param {string} options.repoPath - checkout top level
 * @param {string} options.phase - update phase for the operation record
 * @param {string} [options.id] - record identity (defaults to the canonical path)
 * @param {{ kind: 'registered', branch?: string|null } | { kind: 'generic' }} [options.policy]
 * @param {Function} [options.assessGeneratedState] - see the module header
 * @param {boolean} [options.probeRemote] - probe the selected remote first; an
 *   unreachable remote is a named skip (generic workspace behavior)
 * @returns {object} frozen operation record from updateOutcome.createOperationRecord
 */
export function updateCheckoutFastForward({
    repoPath,
    phase,
    id,
    policy = { kind: 'generic' },
    assessGeneratedState = null,
    probeRemote = false,
    required = null,
    aliases = [],
    exec = runGit,
    env = process.env,
    fetchTimeoutMs = DEFAULT_NETWORK_TIMEOUT_MS,
    lockOptions = {},
    acquireLock = acquireCheckoutLock,
    transactionId = crypto.randomUUID(),
} = {}) {
    const recordId = id || repoPath;
    const details = {
        transactionId,
        strategy: GIT_UPDATE_STRATEGY,
        policy: policy.kind === 'registered' ? { kind: 'registered', branch: policy.branch || null } : { kind: 'generic' },
        aliases,
    };
    let attempted = false;
    let before = null;
    let after = null;
    const finish = (outcome, code, reason, extra = {}) => createOperationRecord({
        phase,
        id: recordId,
        outcome,
        attempted,
        required,
        code,
        reason: sanitizeReason(reason),
        before: summarizePreflight(before),
        after: summarizePreflight(after),
        details: { ...details, ...extra },
    });

    const identity = resolveCheckoutIdentity(repoPath, { exec, env });
    if (!identity.ok) return finish('skipped', identity.code, identity.reason);
    details.checkout = { path: identity.canonical, gitDir: identity.gitDir, commonDir: identity.commonDir };

    const acquired = acquireLock({ commonDir: identity.commonDir, checkout: identity.canonical, transactionId, ...lockOptions });
    if (!acquired.ok) {
        const outcome = acquired.code === 'lock-unavailable' ? 'failed' : 'uncertain';
        return finish(outcome, acquired.code, acquired.reason, { lockOwner: acquired.owner || null });
    }
    const lock = acquired.lock;
    let privateRef = '';
    let privateOid = '';
    try {
        before = capturePreflight(identity, { exec, env, transactionId });
        const recovery = classifyRecoveryState(before);
        if (recovery) return finish(recovery.outcome, recovery.code, recovery.reason);

        if (typeof assessGeneratedState === 'function') {
            let assessment;
            try {
                assessment = assessGeneratedState({ repoPath: identity.canonical, preflight: before });
            } catch (error) {
                return finish('uncertain', 'assessment-failed', `generated-state assessment failed: ${error?.message || error}`);
            }
            const status = assessment?.status;
            if (status === 'preserve') {
                return finish('skipped', assessment.code || 'generated-state-preserved', assessment.reason || 'generated state was preserved');
            }
            if (status === 'restored') {
                details.restoredGeneratedPaths = sample(Array.isArray(assessment.paths) ? assessment.paths.map(String) : []);
                before = capturePreflight(identity, { exec, env, transactionId });
                const again = classifyRecoveryState(before);
                if (again) return finish(again.outcome, again.code, again.reason);
            } else if (status !== 'none') {
                return finish('uncertain', 'assessment-failed', 'generated-state assessment returned an unsupported result');
            }
        }

        const working = classifyWorkingState(before);
        if (working) return finish(working.outcome, working.code, working.reason);
        const target = selectTarget(before, policy);
        if (target.skip) return finish('skipped', target.skip, target.reason);
        details.fetch = { remote: sanitizeReason(target.remote), ref: target.mergeRef };

        const netOptions = { env, timeoutMs: fetchTimeoutMs, sshConfigured: before.sshConfigured };
        if (probeRemote) {
            const probe = exec(repoPath, ['ls-remote', '--quiet', '--exit-code', target.remote, target.mergeRef], netOptions);
            if (!probe.ok) {
                return finish('skipped', 'remote-unreachable', `remote '${target.remote}' is not reachable or has no ${target.mergeRef}: ${describeGitFailure(probe)}`);
            }
        }

        attempted = true;
        privateRef = `${PRIVATE_REF_PREFIX}/${transactionId}`;
        const fetched = exec(repoPath, [
            'fetch', '--no-tags', '--no-recurse-submodules', '--quiet', target.remote, `+${target.mergeRef}:${privateRef}`,
        ], netOptions);
        if (!fetched.ok) {
            return finish('failed', fetched.timedOut ? 'fetch-timeout' : 'fetch-failed', describeGitFailure(fetched));
        }
        privateOid = gitValue(exec, repoPath, ['rev-parse', '-q', '--verify', `${privateRef}^{commit}`], { env });
        if (!privateOid) return finish('failed', 'fetch-target-unresolved', `fetched ${target.mergeRef} did not resolve to a commit`);
        details.fetch.oid = privateOid;

        const revalidate = () => {
            const observedIdentity = resolveCheckoutIdentity(repoPath, { exec, env });
            const current = observedIdentity.ok
                ? capturePreflight(observedIdentity, { exec, env, transactionId })
                : null;
            if (!current || !sameObservation(before, current)
                || classifyRecoveryState(current) || classifyWorkingState(current) || !lock.isHeld()) {
                after = current;
                return null;
            }
            after = current;
            return current;
        };
        const concurrentChange = () => finish('failed', 'concurrent-change',
            'the checkout changed between preflight and update; nothing was overwritten');

        if (privateOid === before.head) {
            if (!revalidate()) return concurrentChange();
            return finish('unchanged', 'current', 'already up to date');
        }
        const descends = exec(repoPath, ['merge-base', '--is-ancestor', before.head, privateOid], { env });
        if (!descends.ok) {
            if (descends.status !== 1) return finish('failed', 'ancestry-unavailable', describeGitFailure(descends));
            const ahead = exec(repoPath, ['merge-base', '--is-ancestor', privateOid, before.head], { env });
            if (ahead.ok) {
                if (!revalidate()) return concurrentChange();
                return finish('unchanged', 'local-ahead', 'local branch contains the upstream commit and is ahead of it');
            }
            if (ahead.status !== 1) return finish('failed', 'ancestry-unavailable', describeGitFailure(ahead));
            return finish('skipped', 'diverged', 'local and upstream history diverged; manual reconciliation is required');
        }

        const incomingResult = exec(repoPath, ['diff', '--name-only', '-z', '--no-renames', before.head, privateOid], { env });
        if (!incomingResult.ok) return finish('failed', 'diff-unavailable', describeGitFailure(incomingResult));
        const incoming = incomingResult.stdout.split('\0').filter(Boolean);

        // Revalidate immediately before the only mutation of the worktree.
        const current = revalidate();
        if (!current) return concurrentChange();
        const collisions = pathsCollide(current.status.untracked, incoming);
        if (collisions.length) {
            after = current;
            return finish('failed', 'untracked-would-be-overwritten',
                `untracked files would be overwritten by the update (${sample(collisions).join(', ')}); move them aside and retry`);
        }

        // Ignored files are user data too: refuse instead of overwriting them.
        // A large checkout gets the network-class deadline, not the local one.
        const merged = exec(repoPath, [
            '-c', 'merge.autoStash=false', 'merge', '--ff-only', '--no-edit', '--quiet', '--no-overwrite-ignore', privateOid,
        ], { env, timeoutMs: fetchTimeoutMs });
        after = capturePreflight(identity, { exec, env, transactionId });
        return verifyPostconditions({ before: current, after, target: privateOid, merged, finish });
    } finally {
        if (privateRef) {
            const args = privateOid ? ['update-ref', '-d', privateRef, privateOid] : ['update-ref', '-d', privateRef];
            exec(repoPath, args, { env });
        }
        lock.release();
    }
}

function verifyPostconditions({ before, after, target, merged, finish }) {
    const status = after.status;
    const branchKept = after.symbolicRef === before.symbolicRef;
    const conflict = after.operations.active.length || after.operations.autostash.length || status?.unmerged.length;
    const dirty = !status || status.staged.length || status.unstaged.length;
    const missingUntracked = before.status.untracked.filter(file => !fileExists(path.join(before.checkout.toplevel, file)));
    if (merged.ok) {
        if (conflict) {
            return finish('failed', 'conflict-after-merge',
                'Git reported success but left unmerged entries or an operation in progress; resolve it manually');
        }
        if (!branchKept || after.head !== target) {
            return finish('uncertain', 'recovery-required',
                `Git reported success but HEAD is ${after.head || 'unknown'} on ${after.symbolicRef || 'a detached HEAD'}, not ${target}`);
        }
        if (dirty || missingUntracked.length) {
            return finish('failed', 'postcondition-dirty',
                'the update left unexpected index/worktree changes; inspect the checkout');
        }
        return finish('changed', 'fast-forward', `advanced ${before.head.slice(0, 12)}..${target.slice(0, 12)}`);
    }
    // An interrupted Git process can leave locks or partially written files
    // behind even when HEAD did not move; that is not a clean refusal.
    const newLocks = after.operations.locks.filter(lock => !before.operations.locks.includes(lock));
    const priorUntracked = new Set(before.status.untracked);
    const newUntracked = (status?.untracked || []).filter(file => !priorUntracked.has(file));
    if (merged.timedOut || newLocks.length || newUntracked.length) {
        return finish('uncertain', 'recovery-required',
            `the fast-forward was interrupted or left ${newLocks.length ? `Git locks (${newLocks.join(', ')})` : 'new files'} behind; inspect the checkout: ${describeGitFailure(merged)}`);
    }
    if (branchKept && after.head === before.head && !conflict && !dirty) {
        return finish('failed', 'fast-forward-refused', describeGitFailure(merged));
    }
    return finish('uncertain', 'recovery-required',
        `the fast-forward failed and left the checkout changed; inspect it manually: ${describeGitFailure(merged)}`);
}

export function throwUnlessVerified(record) {
    if (!isVerifiedRecord(record)) throw new GitUpdateError(record);
    return record;
}
