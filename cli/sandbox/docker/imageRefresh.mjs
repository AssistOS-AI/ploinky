// Registry refresh of mutable container image tags, used only by `ploinky
// update`. Start, restart and the no-wait worker never call into this module.
// Results are plain objects; the commands layer turns them into update records.
import { spawnSync } from 'node:child_process';
import { resolveVarValue } from '../../utils/security/secretVars.js';
import { debugLog } from '../../utils/utils.js';
import { imagePullTimeoutMs, probeContainerRuntime, pullImage } from './common.js';
import { readLocalImageId } from './imageChange.mjs';
import { parseImageReference, repoDigestSet } from './imageReference.mjs';
import { IMAGE_REFRESH_VAR, imageRefreshPolicyOf } from './imageRefreshPolicy.mjs';
import { fetchRemoteManifestDigest, nativeFetchIgnoresProxy } from './registryDigest.mjs';

export { IMAGE_REFRESH_VAR };
// A pull that cannot get at least this long is deferred instead of started.
const MIN_PULL_BUDGET_MS = 60_000;

// The workspace variable (`ploinky var PLOINKY_IMAGE_REFRESH off`, visible inside the Box) is the only
// source. `off` turns the refresh off, `on` is the default; anything else is ignored.
// Returns { policy: 'off' | 'refresh', ignoredValue }.
export function resolveImageRefreshPolicy({ readVar = resolveVarValue } = {}) {
    let raw = '';
    try {
        raw = String(readVar(IMAGE_REFRESH_VAR) || '').trim();
    } catch (error) {
        debugLog(`[pull] ${IMAGE_REFRESH_VAR}: workspace variables unreadable `
            + `(${error?.message || error}); refreshing`);
    }
    return imageRefreshPolicyOf(raw);
}

// null when the image is missing locally; otherwise its RepoDigests (maybe empty).
function defaultReadRepoDigests(runtime, ref, spawn = spawnSync) {
    const result = spawn(runtime, ['image', 'inspect', '--format', '{{json .RepoDigests}}', ref], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000,
    });
    if (result.error || result.status !== 0) return null;
    try {
        const parsed = JSON.parse(String(result.stdout || '').trim() || 'null');
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

// Bounded, credential-free text for logs and records.
const clean = (value) => String(value ?? '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .slice(0, 500);
const short = (id) => String(id || '').replace(/^sha256:/, '').slice(0, 12);
const bareId = (id) => String(id || '').replace(/^sha256:/, '');
const runLeased = async (fn) => ({ ok: true, value: await fn() });

/**
 * One refresh session per command. `refresh` never throws, except for an error
 * thrown by the caller's `beforePull` or `afterPullFailure` hooks (update
 * cancellation). With a registry digest known, the digest is pulled (the tag
 * does not move) and the tag is then moved inside `withRetagLease`; without
 * one, the engine pulls the tag itself.
 */
export function createImageRefreshSession({
    policy,
    runtime = undefined,
    log = console.log,
    beforePull = null,
    afterPullFailure = null,
    beforeRetag = null,
    stillEnabled = () => true,
    withRetagLease = runLeased,
    deadlineMs = Infinity,
    now = Date.now,
    fetchImpl = globalThis.fetch,
    spawn = spawnSync,
    env = process.env,
    execArgv = process.execArgv,
    pull = pullImage,
    pullTimeoutMs = imagePullTimeoutMs,
    readImageId = readLocalImageId,
    readRepoDigests = (rt, ref) => defaultReadRepoDigests(rt, ref, spawn),
} = {}) {
    const memo = new Map();
    const unreachableHosts = new Set();
    let resolvedRuntime = runtime;
    let hookError = null;

    const skipped = (ref) => ({ ref, canonical: ref, action: 'skipped', agents: [] });
    const hook = async (fn) => {
        try {
            await fn?.();
        } catch (error) {
            hookError = error;
            throw error;
        }
    };

    function retag(rt, imageId, ref) {
        const result = spawn(rt, ['tag', imageId, ref], {
            encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000,
        });
        if (result.error || result.status !== 0) {
            const detail = result.error?.message || result.stderr || `exit ${result.status}`;
            throw new Error(`${rt} tag failed: ${clean(detail)}`);
        }
    }

    const deferredResult = (base, action, reason) => {
        const what = action === 'retag-deferred' ? 'tag move' : 'refresh';
        log(`[pull] ${base.ref}: ${what} deferred (${reason}); using the cached image.`);
        return { ...base, action, reason };
    };

    async function pullAndMove(rt, ref, base, knownDigest, parsed) {
        const beforeId = readImageId(rt, ref);
        await hook(beforePull);
        const configuredMs = pullTimeoutMs();
        const remaining = deadlineMs - now();
        if (remaining < Math.min(MIN_PULL_BUDGET_MS, configuredMs)) {
            return deferredResult(base, 'deferred', 'the update time budget is used up');
        }
        const timeoutMs = Math.floor(Math.min(configuredMs, remaining));
        const budgetCapped = timeoutMs < configuredMs;
        const pulledRef = knownDigest ? `${parsed.registry}/${parsed.repository}@${knownDigest}` : ref;
        const failed = async (error) => {
            await hook(afterPullFailure);
            const message = clean(error?.message || error);
            log(`[pull] Warning: pull of ${pulledRef} failed (${message}); using the cached image.`);
            return { ...base, action: 'pull-failed', reason: message };
        };
        try {
            pull(pulledRef, { runtime: rt, log, timeoutMs });
        } catch (error) {
            if (budgetCapped && /timed out/i.test(String(error?.message))) {
                await hook(afterPullFailure);
                return deferredResult(base, 'deferred', 'the update time budget ended during the pull');
            }
            return failed(error);
        }
        const afterId = readImageId(rt, pulledRef);
        if (knownDigest) {
            if (!afterId) return failed(new Error('the pulled image could not be inspected'));
            if (afterId !== beforeId) {
                await hook(beforeRetag);
                // Revalidated under the lease: the policy, and the tag still being the image seen before the pull.
                let outcome = '';
                const withIds = { ...base, beforeId, afterId };
                try {
                    const moved = await withRetagLease(() => {
                        if (!stillEnabled()) return 'turned-off';
                        if (readImageId(rt, ref) !== beforeId) return 'tag-changed';
                        retag(rt, afterId, ref);
                        return 'retagged';
                    });
                    if (!moved.ok) return deferredResult(withIds, 'retag-deferred', 'the workspace lease is busy');
                    outcome = moved.value;
                } catch (error) {
                    return failed(error);
                }
                if (outcome === 'turned-off') {
                    return deferredResult(withIds, 'turned-off', 'image refresh was turned off during the update');
                }
                if (outcome === 'tag-changed') {
                    return deferredResult(withIds, 'tag-changed',
                        'the tag moved during the update, for example a local build');
                }
            }
        }
        if (beforeId && afterId && beforeId !== afterId) {
            const agents = base.agents.join(', ') || 'its agents';
            log(`[pull] ${ref} refreshed for ${agents}; previous image ${bareId(beforeId)}. `
                + `To roll back: ${rt} tag ${bareId(beforeId)} ${ref}, then ploinky restart.`);
            return { ...base, action: 'refreshed', beforeId, afterId };
        }
        return { ...base, action: 'current', beforeId, afterId };
    }

    async function check(ref, agents) {
        const rt = resolvedRuntime;
        const parsed = parseImageReference(ref);
        if (!parsed || parsed.pinned || !parsed.explicitRegistry || parsed.registry === 'localhost'
            || parsed.registry.startsWith('localhost:')) return skipped(ref);
        const base = { ref, canonical: parsed.canonical, agents };
        const local = readRepoDigests(rt, ref);
        if (local === null) return skipped(ref);
        if (deadlineMs - now() < Math.min(MIN_PULL_BUDGET_MS, pullTimeoutMs())) {
            return deferredResult(base, 'deferred', 'the update time budget is used up');
        }
        let knownDigest = '';
        if (!nativeFetchIgnoresProxy(env, execArgv)) {
            const remote = await fetchRemoteManifestDigest(parsed, { fetchImpl, unreachableHosts });
            const localSet = repoDigestSet(local, parsed);
            if (remote.status === 'ok' && localSet.has(remote.digest)) {
                debugLog(`[pull] ${ref}: current (${short(remote.digest)})`);
                return { ...base, action: 'current' };
            }
            if (remote.status === 'ok') {
                const localDigest = [...localSet][0];
                const localText = localDigest ? `sha256:${short(localDigest)}` : 'unknown';
                log(`[pull] ${ref}: registry digest differs (local ${localText}, `
                    + `registry sha256:${short(remote.digest)}); pulling...`);
                knownDigest = remote.digest;
            } else if (remote.status === 'unavailable') {
                const message = clean(remote.reason);
                log(`[pull] Warning: registry ${parsed.apiHost} unreachable for ${ref} (${message}); `
                    + 'using the cached image.');
                return { ...base, action: 'unavailable', reason: message };
            } else {
                log(`[pull] ${ref}: registry digest not readable (${clean(remote.reason)}); asking ${rt} to pull`);
            }
        }
        return pullAndMove(rt, ref, base, knownDigest, parsed);
    }

    async function refresh(ref, { agents = [] } = {}) {
        const text = String(ref || '').trim();
        if (policy === 'off') return skipped(text);
        if (resolvedRuntime === undefined) {
            try { resolvedRuntime = probeContainerRuntime(); } catch (_) { resolvedRuntime = null; }
        }
        if (!resolvedRuntime) return skipped(text);
        const canonical = parseImageReference(text)?.canonical || text;
        const key = `${resolvedRuntime}|${canonical}`;
        const known = memo.get(key);
        if (known) {
            for (const agent of agents) if (!known.agents.includes(agent)) known.agents.push(agent);
            return known;
        }
        const list = [...new Set(agents)];
        let result;
        try {
            result = await check(text, list);
        } catch (error) {
            if (hookError && error === hookError) throw error;
            const message = clean(error?.message || error);
            log(`[pull] Warning: image refresh of ${text} failed (${message}); using the cached image.`);
            result = { ref: text, canonical, action: 'error', agents: list, reason: message };
        }
        memo.set(key, result);
        return result;
    }

    return Object.freeze({
        get enabled() { return policy !== 'off'; },
        refresh,
        results: () => [...memo.values()].filter((entry) => entry.action !== 'skipped'),
        summaryLine() {
            const count = (...actions) => [...memo.values()].filter((entry) => actions.includes(entry.action)).length;
            return `[pull] Image refresh: ${count('refreshed')} refreshed, ${count('current')} current, `
                + `${count('unavailable')} unavailable, ${count('pull-failed', 'error')} failed, `
                + `${count('deferred', 'retag-deferred', 'turned-off', 'tag-changed')} deferred.`;
        },
    });
}
