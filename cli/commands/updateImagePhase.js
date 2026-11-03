import path from 'node:path';
import { REPOS_DIR } from '../utils/config.js';
import { acquireWorkspaceMutationLease, releaseWorkspaceMutationLease } from '../utils/runtime/maintenanceLocks.js';
import { resolveManifestImage } from '../utils/security/secretVars.js';
import { resolveManifestRuntimeProfile } from '../utils/runtime/profileService.js';
import { classifyDependencyGraphWaitMode } from '../utils/workspaceDependencyGraph.js';
import { debugLog } from '../utils/utils.js';
import { UPDATE_RUNNER_DEFAULTS } from '../../ploinky-box/update/coreRunner.mjs';
import { createImageRefreshSession, resolveImageRefreshPolicy } from '../sandbox/docker/imageRefresh.mjs';
import { UpdateCancelledError } from './updateCancellation.js';
import { createOperationRecord } from './updateOutcome.js';
import { appendUpdateRecords } from './updateRecords.js';

// The image phase of `ploinky update`: the only place a registry is contacted
// or a changed image tag is pulled. It runs after the git phases, outside the
// workspace mutation lease; only the final tag move takes the lease, briefly.

// The host bounds the whole in-Box update (UPDATE_RUNNER_DEFAULTS.timeoutMs,
// ploinky-box/update/coreRunner.mjs). The image phase must end this much before
// that bound so the report is still published; later pulls are deferred.
export const IMAGE_PHASE_MARGIN_MS = 10 * 60 * 1000;
export const IMAGE_PHASE_BUDGET_MS = UPDATE_RUNNER_DEFAULTS.timeoutMs - IMAGE_PHASE_MARGIN_MS;
const RETAG_LEASE_WAIT_MS = 5_000;
const LOCK_BUSY_CODES = new Set(['workspace_mutation_lock_timeout', 'PLOINKY_WORKSPACE_MUTATION_BUSY']);

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
    deferred: ['skipped', 'image-refresh-deferred'],
    'retag-deferred': ['skipped', 'image-retag-deferred'],
    error: ['skipped', 'image-refresh-error'],
    'turned-off': ['skipped', 'image-refresh-turned-off'],
    'tag-changed': ['skipped', 'image-tag-changed'],
    // The whole phase was skipped before any ref was checked; `result.code` names why.
    'phase-skipped': ['skipped', 'image-refresh-skipped'],
});

const ATTEMPTED = new Set(['refreshed', 'pull-failed', 'retag-deferred', 'turned-off', 'tag-changed']);
const phaseSkipped = (code, reason) => [{
    action: 'phase-skipped', canonical: 'image-refresh', ref: 'image-refresh', code, reason, agents: [],
}];

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
            attempted: ATTEMPTED.has(result.action),
            required: false,
            code: result.action === 'phase-skipped' ? result.code : mapped[1],
            reason: result.reason || '',
            before: result.beforeId ? { imageId: result.beforeId } : null,
            after: result.afterId ? { imageId: result.afterId } : null,
            details: { agents: result.agents || [] },
        }));
    }
    return records;
}

/**
 * Which graph agents the update refreshes. A repo update keeps that repo's
 * agents. A folder-scoped update keeps workspace-checkout agents under the
 * folder, and always the agents of registered repositories (`.ploinky/repos`),
 * which `update all` updates whatever folder it runs from.
 */
export function buildImageFilter(request, { reposDir = REPOS_DIR } = {}) {
    if (request.kind === 'repo') return (target) => target.repoName === request.repoName;
    if (!request.folderPath) return null;
    const inside = (base, file) => {
        if (!file) return false;
        const relative = path.relative(path.resolve(base), path.resolve(file));
        return !relative.startsWith('..') && !path.isAbsolute(relative);
    };
    return (target) => inside(reposDir, target.manifestPath) || inside(request.folderPath, target.manifestPath);
}

// Resolves the workspace graph and refreshes its mutable image tags. Never throws on an unresolvable graph.
export async function refreshWorkspaceGraphImages(session, { includeNoWait = true, filter = null } = {}) {
    if (!session?.enabled) return [];
    const { preflightWorkspaceStartRuntimeCapabilities } = await import('./workspaceUtil.js');
    let admitted;
    try {
        admitted = preflightWorkspaceStartRuntimeCapabilities();
    } catch (error) {
        const reason = `the workspace graph could not be resolved (${error?.message || error})`;
        console.log(`[pull] Warning: image refresh skipped; ${reason}.`);
        return phaseSkipped('image-refresh-graph-unavailable', reason);
    }
    return refreshAdmittedGraphImages(admitted, session, { includeNoWait, filter });
}

// Lazy imports keep workspaceUtil.js out of the update command's load path.
export async function refreshUpdateImages({ request, session, log }, deps = {}) {
    const getConfig = deps.getConfig || (await import('../utils/workspace.js')).getConfig;
    if (!getConfig()?.static?.agent) return [];
    const inspectInFlight = deps.inspectInFlightNoWaitWorkers
        || (await import('./noWaitRunSettlement.js')).inspectInFlightNoWaitWorkers;
    if (inspectInFlight().length) {
        log('[update] Image refresh skipped: no-wait workers of an earlier start are still running. '
            + 'Run `ploinky update` again once they finish.');
        return phaseSkipped('image-refresh-workers-active', 'no-wait workers of an earlier start are still running');
    }
    const refreshGraph = deps.refreshWorkspaceGraphImages || refreshWorkspaceGraphImages;
    return refreshGraph(session, { includeNoWait: true, filter: buildImageFilter(request, deps) });
}

/** Runs `fn` under the workspace mutation lease; `{ ok: false }` when the lease stays busy. */
export function createRetagLease({
    heldLease = null,
    acquire = acquireWorkspaceMutationLease,
    release = releaseWorkspaceMutationLease,
    log = console.log,
} = {}) {
    return async (fn) => {
        // The caller of this update already holds the lease for its whole run.
        if (heldLease) return { ok: true, value: await fn() };
        let lease;
        try {
            lease = await acquire({ operation: 'update-image-retag', waitTimeoutMs: RETAG_LEASE_WAIT_MS });
        } catch (error) {
            if (LOCK_BUSY_CODES.has(error?.code)) return { ok: false };
            throw error;
        }
        try {
            return { ok: true, value: await fn() };
        } finally {
            if (!release(lease)) {
                log('[pull] Warning: the workspace lease taken for the image tag move could not be released exactly.');
            }
        }
    };
}

const phaseRecord = (id, code, reason) => createOperationRecord({
    phase: 'image', id, outcome: 'skipped', attempted: false, required: false, code, reason,
});

export async function appendImageRefreshPhase(result, {
    request, policy, ignoredValue = '', cancellation, hostActivates, log, refreshImages = refreshUpdateImages,
    deadlineMs, heldLease = null, sessionOptions = {},
}) {
    if (request.kind === 'repos') return result;
    if (policy === 'off') {
        log('[update] Image refresh is turned off for this workspace (PLOINKY_IMAGE_REFRESH=off); '
            + 'no image was checked or pulled.');
        return result;
    }
    if (ignoredValue) {
        log(`[update] Warning: PLOINKY_IMAGE_REFRESH='${ignoredValue.slice(0, 40)}' is ignored; `
            + "the recognised values are 'off' and 'on'. Refreshing images as usual.");
    }
    if (result.activationAllowed === false) {
        return appendUpdateRecords(result, [phaseRecord('image-refresh', 'image-refresh-skipped-git-failed',
            'the repository phases failed or need recovery; image tags were not refreshed')]);
    }
    let session;
    // A signal stops the update at the next checkpoint; the records so far, images included, are kept.
    const checkpoint = () => cancellation.checkpoint('image', [
        ...result.records, ...imageRefreshUpdateRecords(session.results()),
    ]);
    session = createImageRefreshSession({
        policy, log, deadlineMs, beforePull: checkpoint, afterPullFailure: checkpoint, beforeRetag: checkpoint,
        stillEnabled: () => resolveImageRefreshPolicy().policy !== 'off',
        withRetagLease: createRetagLease({ heldLease, log }), ...sessionOptions,
    });
    let results;
    try {
        results = await refreshImages({ request, session, log });
    } catch (error) {
        if (error instanceof UpdateCancelledError) throw error;
        log(`[pull] Warning: image refresh skipped (${error?.message || error}).`);
        results = phaseSkipped('image-refresh-error', String(error?.message || error));
    }
    const records = imageRefreshUpdateRecords(results);
    if (!records.length) return result;
    if (!hostActivates && results.some((entry) => entry.action === 'refreshed')) {
        log('[update] Refreshed images take effect after `ploinky restart` (or `ploinky restart <agent>`).');
    }
    return appendUpdateRecords(result, records);
}
