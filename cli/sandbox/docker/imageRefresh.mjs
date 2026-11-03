// Registry refresh of mutable container image tags, used only by `ploinky
// update`. Start, restart and the no-wait worker never call into this module.
import { spawnSync } from 'node:child_process';
import { containerToolchainIdentity } from '../../utils/dependencies/store/installContract.mjs';
import { resolveManifestImage, resolveVarValue } from '../../utils/security/secretVars.js';
import { resolveManifestRuntimeProfile } from '../../utils/runtime/profileService.js';
import { classifyDependencyGraphWaitMode } from '../../utils/workspaceDependencyGraph.js';
import { createOperationRecord, sanitizeReason } from '../../commands/updateOutcome.js';
import { debugLog } from '../../utils/utils.js';
import { probeContainerRuntime, pullImage } from './common.js';
import { parseImageReference, repoDigestSet } from './imageReference.mjs';
import { fetchRemoteManifestDigest, nativeFetchIgnoresProxy } from './registryDigest.mjs';

export const IMAGE_REFRESH_VAR = 'PLOINKY_IMAGE_REFRESH';
const IMAGE_REFRESH_POLICIES = new Set(['check', 'always', 'off']);

// Workspace variable first (`ploinky var PLOINKY_IMAGE_REFRESH off`, visible
// inside the Box), then the process environment, then 'check'.
export function resolveImageRefreshPolicy({ env = process.env, readVar = resolveVarValue } = {}) {
    let raw = '';
    try {
        raw = String(readVar(IMAGE_REFRESH_VAR) || '').trim();
    } catch (error) {
        debugLog(`[pull] ${IMAGE_REFRESH_VAR}: workspace variables unreadable (${error?.message || error}); using the environment`);
    }
    if (!raw) raw = String(env?.[IMAGE_REFRESH_VAR] || '').trim();
    if (!raw) return 'check';
    if (!IMAGE_REFRESH_POLICIES.has(raw)) {
        const error = new Error(`${IMAGE_REFRESH_VAR} must be 'check', 'always' or 'off', not '${raw}'`);
        error.code = 'PLOINKY_IMAGE_REFRESH_INVALID';
        throw error;
    }
    return raw;
}

function defaultReadImageId(runtime, ref) {
    try {
        return containerToolchainIdentity({ runtime, image: ref }).identity.imageId;
    } catch (_) {
        return null;
    }
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

const short = (id) => String(id || '').replace(/^sha256:/, '').slice(0, 12);
const bareId = (id) => String(id || '').replace(/^sha256:/, '');

/**
 * One refresh session per command. `refresh` never throws, except for an error
 * thrown by the caller's `beforePull` (update cancellation).
 */
export function createImageRefreshSession({
    policy,
    runtime = undefined,
    log = console.log,
    beforePull = null,
    fetchImpl = globalThis.fetch,
    spawn = spawnSync,
    env = process.env,
    execArgv = process.execArgv,
    pull = pullImage,
    readImageId = defaultReadImageId,
    readRepoDigests = (rt, ref) => defaultReadRepoDigests(rt, ref, spawn),
} = {}) {
    const memo = new Map();
    const unreachableHosts = new Set();
    let resolvedRuntime = runtime;
    let cancelError = null;

    const skipped = (ref) => ({ ref, canonical: ref, action: 'skipped', agents: [] });

    async function check(ref, agents) {
        const rt = resolvedRuntime;
        const parsed = parseImageReference(ref);
        if (!parsed || parsed.pinned || !parsed.explicitRegistry || parsed.registry === 'localhost'
            || parsed.registry.startsWith('localhost:')) return skipped(ref);
        const base = { ref, canonical: parsed.canonical, agents };
        const local = readRepoDigests(rt, ref);
        if (local === null) return skipped(ref);
        if (policy !== 'always' && !nativeFetchIgnoresProxy(env, execArgv)) {
            const remote = await fetchRemoteManifestDigest(parsed, { fetchImpl, unreachableHosts });
            const localSet = repoDigestSet(local, parsed);
            if (remote.status === 'ok' && localSet.has(remote.digest)) {
                debugLog(`[pull] ${ref}: current (${short(remote.digest)})`);
                return { ...base, action: 'current' };
            }
            if (remote.status === 'ok') {
                const localDigest = [...localSet][0];
                log(`[pull] ${ref}: registry digest differs (local ${localDigest ? `sha256:${short(localDigest)}` : 'unknown'}, registry sha256:${short(remote.digest)}); pulling...`);
            } else if (remote.status === 'unavailable') {
                const message = sanitizeReason(remote.reason);
                log(`[pull] Warning: registry ${parsed.apiHost} unreachable for ${ref} (${message}); using the cached image.`);
                return { ...base, action: 'unavailable', reason: message };
            } else {
                log(`[pull] ${ref}: registry digest not readable (${sanitizeReason(remote.reason)}); asking ${rt} to pull`);
            }
        }
        const beforeId = readImageId(rt, ref);
        try {
            await beforePull?.();
        } catch (error) {
            cancelError = error;
            throw error;
        }
        try {
            pull(ref, { runtime: rt, log });
        } catch (error) {
            const message = sanitizeReason(error?.message || error);
            log(`[pull] Warning: pull of ${ref} failed (${message}); using the cached image.`);
            return { ...base, action: 'pull-failed', reason: message };
        }
        const afterId = readImageId(rt, ref);
        if (beforeId && afterId && beforeId !== afterId) {
            log(`[pull] ${ref} refreshed for ${agents.join(', ') || 'its agents'}; previous image ${bareId(beforeId)}. `
                + `To roll back: ${rt} tag ${bareId(beforeId)} ${ref}, then ploinky restart.`);
            return { ...base, action: 'refreshed', beforeId, afterId };
        }
        return { ...base, action: 'current', beforeId, afterId };
    }

    async function refresh(ref, { agents = [] } = {}) {
        const text = String(ref || '').trim();
        if (policy === 'off') return skipped(text);
        if (resolvedRuntime === undefined) {
            try { resolvedRuntime = probeContainerRuntime(); } catch (_) { resolvedRuntime = null; }
        }
        if (!resolvedRuntime) return skipped(text);
        const key = `${resolvedRuntime}|${parseImageReference(text)?.canonical || text}`;
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
            if (error === cancelError) throw error;
            const message = sanitizeReason(error?.message || error);
            log(`[pull] Warning: image refresh of ${text} failed (${message}); using the cached image.`);
            result = { ref: text, canonical: text, action: 'unavailable', agents: list, reason: message };
        }
        memo.set(key, result);
        return result;
    }

    return Object.freeze({
        get enabled() { return policy !== 'off'; },
        refresh,
        results: () => [...memo.values()].filter((entry) => entry.action !== 'skipped'),
        summaryLine() {
            const counts = { refreshed: 0, current: 0, unavailable: 0, 'pull-failed': 0 };
            for (const entry of memo.values()) if (entry.action in counts) counts[entry.action] += 1;
            return `[pull] Image refresh: ${counts.refreshed} refreshed, ${counts.current} current, `
                + `${counts.unavailable} unavailable, ${counts['pull-failed']} failed.`;
        },
    });
}

/**
 * The mutable image refs of an admitted graph: one target per container
 * agent. Catalog-digest-pinned and hardware-refused records are skipped, and
 * no-wait nodes only when `includeNoWait`. `additionalNodes` are not graph
 * nodes, so they always count as blocking. Never throws.
 */
export function collectAdmittedImageTargets(admittedStart, { includeNoWait = false, filter = null } = {}) {
    const noWait = classifyDependencyGraphWaitMode(admittedStart?.graph).noWait;
    const targets = [];
    for (const record of admittedStart?.admissions || []) {
        try {
            if (record.runtimeKind !== 'container' || record.hardwareRefusal) continue;
            if (!includeNoWait && noWait.has(record.nodeId)) continue;
            const catalog = record.admission?.descriptor?.catalogIdentity;
            if (catalog?.imageDigest) continue;
            const agentId = String(record.admission?.agentId || '');
            const slash = agentId.lastIndexOf('/');
            const repoName = slash === -1 ? '' : agentId.slice(0, slash);
            const agentName = slash === -1 ? agentId : agentId.slice(slash + 1);
            let ref = String(catalog?.imageRef || '').trim();
            if (!ref) {
                const manifest = JSON.parse(Buffer.from(record.manifestBytesBase64, 'base64').toString('utf8'));
                const { profileConfig } = resolveManifestRuntimeProfile(manifest, {
                    agentName: agentId,
                    profileName: record.profileName || undefined,
                    path: `manifest(${agentId})`,
                });
                ref = resolveManifestImage(manifest, profileConfig, { agentName, repoName });
            }
            if (!ref || ref.includes('${')) continue;
            const target = { ref, repoName, agentName, manifestPath: record.manifestPath };
            if (filter && !filter(target)) continue;
            targets.push(target);
        } catch (error) {
            debugLog(`[pull] image target skipped for ${record?.nodeId}: ${error?.message || error}`);
        }
    }
    return targets;
}

/** Refresh each distinct ref of the admitted graph once; prints the summary when anything was checked. */
export async function refreshAdmittedGraphImages(admittedStart, session, options = {}) {
    if (!session?.enabled) return [];
    const groups = new Map();
    for (const target of collectAdmittedImageTargets(admittedStart, options)) {
        if (!groups.has(target.ref)) groups.set(target.ref, []);
        groups.get(target.ref).push(`${target.repoName}/${target.agentName}`);
    }
    for (const [ref, agents] of groups) await session.refresh(ref, { agents });
    const results = session.results();
    if (results.length) console.log(session.summaryLine());
    return results;
}

const RECORD_MAP = Object.freeze({
    refreshed: ['changed', 'image-refreshed'],
    current: ['unchanged', 'image-current'],
    unavailable: ['skipped', 'registry-unreachable'],
    'pull-failed': ['skipped', 'image-pull-failed'],
});

/** One optional `image` phase record per checked mutable ref. */
export function imageRefreshUpdateRecords(results = []) {
    const records = [];
    for (const result of results) {
        const mapped = RECORD_MAP[result.action];
        if (!mapped) continue;
        records.push(createOperationRecord({
            phase: 'image',
            id: result.canonical || result.ref,
            outcome: mapped[0],
            attempted: result.action === 'refreshed' || result.action === 'pull-failed',
            required: false,
            code: mapped[1],
            reason: result.reason || '',
            before: result.beforeId ? { imageId: result.beforeId } : null,
            after: result.afterId ? { imageId: result.afterId } : null,
            details: { agents: result.agents || [] },
        }));
    }
    return records;
}
