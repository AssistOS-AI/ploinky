import { createOperationRecord, sanitizeReason } from '../../cli/commands/updateOutcome.js';
import { parseImageReference, repoDigestSet } from '../../cli/sandbox/docker/imageReference.mjs';
import { fetchRemoteManifestDigest, nativeFetchIgnoresProxy } from '../../cli/sandbox/docker/registryDigest.mjs';
import { BOX_LABELS } from '../constants.mjs';
import { inspectAndValidateExistingImage } from '../contract/image.mjs';
import { normalizeImageId } from '../contract/image-id.mjs';
import { boxWorkspaceExecOptions } from '../contract/workspace-root.mjs';
import { probeImageAgentLib } from '../image-agentlib.mjs';
import { pullBoxImage } from '../lifecycle/transactions.mjs';

// The Box image check of a host-side full `ploinky update`. It runs on the host before the in-Box
// update. A registry-proven new image is pulled by digest (no tag moves) and validated, then the
// transaction replaces the Box; when the digest cannot be proven the transaction pulls the tag.

const POLICY_PROGRAM = '/opt/ploinky/ploinky-box/inbox/readImageRefreshPolicy.mjs';
const short = (id) => String(id || '').replace(/^sha256:/, '').slice(0, 12);

const result = (outcome, extra = {}) => ({
    outcome, replaceImage: false, refreshImageTag: false, digestRef: '', beforeId: '', afterId: '', reason: '',
    canonical: '', ...extra,
});

function isLocalhost(registry) {
    return registry === 'localhost' || registry.startsWith('localhost:');
}

// The policy of the workspace, read by a read-only program inside the Box: 'off', 'refresh' or 'unknown'.
function readBoxPolicy({ runner, engine, container, workspaceRoot }) {
    const q = runner.query(engine.name, [
        'container', 'exec', '--user', 'podman', ...boxWorkspaceExecOptions(workspaceRoot), container.id,
        '/usr/local/bin/node', POLICY_PROGRAM,
    ], { timeoutMs: 15_000 });
    if (!q?.ok) return 'unknown';
    try {
        const parsed = JSON.parse(String(q.stdout || '').trim());
        const keys = Object.keys(parsed || {});
        return keys.length === 1 && keys[0] === 'policy' && ['off', 'refresh'].includes(parsed.policy)
            ? parsed.policy : 'unknown';
    } catch (_) {
        return 'unknown';
    }
}

/** Never throws; any unexpected error is outcome `error`. */
export async function refreshBoxImageForUpdate({
    engine, container, imageRef, workspaceRoot, activity, env = process.env,
    stdout = process.stdout, stderr = process.stderr,
}, {
    runner,
    fetchDigest = fetchRemoteManifestDigest,
    pullImage = pullBoxImage,
    validateExisting = inspectAndValidateExistingImage,
    probeAgentLib = probeImageAgentLib,
} = {}) {
    try {
        const parsed = parseImageReference(imageRef);
        if (!container || !parsed || parsed.pinned || !parsed.explicitRegistry || isLocalhost(parsed.registry)
            || container.labels?.[BOX_LABELS.imageRef] !== imageRef) return result('skip');
        const base = { canonical: parsed.canonical };
        if (container.runtime?.running !== true || activity?.undetermined) return result('deferred', base);
        const policy = readBoxPolicy({ runner, engine, container, workspaceRoot });
        if (policy === 'off') {
            stderr?.write?.('[ploinky] Box image refresh is turned off for this workspace '
                + '(PLOINKY_IMAGE_REFRESH=off).\n');
            return result('off', base);
        }
        if (policy !== 'refresh') return result('policy-unavailable', base);

        const beforeId = normalizeImageId(container.runtime.imageId);
        const local = runner.query(engine.name, [
            'image', 'inspect', '--format', '{{json .RepoDigests}}', container.runtime.imageId,
        ], { timeoutMs: 10_000 });
        let localDigests;
        try {
            if (!local?.ok) throw new Error('RepoDigests query failed');
            localDigests = repoDigestSet(JSON.parse(String(local.stdout || '').trim() || 'null'), parsed);
        } catch (error) {
            return result('error', { ...base, beforeId, reason: sanitizeReason(error?.message || error) });
        }
        if (nativeFetchIgnoresProxy(env)) {
            return result('tag-refresh', {
                ...base, refreshImageTag: true, beforeId, reason: 'proxy not used by Node',
            });
        }
        const remote = await fetchDigest(parsed);
        if (remote.status === 'unavailable') return result('unreachable', { ...base, beforeId, reason: remote.reason });
        if (remote.status !== 'ok') {
            return result('tag-refresh', { ...base, refreshImageTag: true, beforeId, reason: remote.reason });
        }
        if (localDigests.has(remote.digest)) return result('current', { ...base, beforeId });

        const digestRef = `${parsed.registry}/${parsed.repository}@${remote.digest}`;
        stderr?.write?.(`[ploinky] Box image ${imageRef}: registry digest differs (local ${short(beforeId)}, `
            + `registry ${short(remote.digest)}); pulling by digest...\n`);
        try {
            await pullImage(engine, digestRef, runner, { stdout, stderr });
        } catch (error) {
            return result('pull-failed', {
                ...base, beforeId, digestRef, reason: sanitizeReason(error?.message || error),
            });
        }
        const inspected = runner.query(engine.name, ['image', 'inspect', '--format', '{{.Id}}', digestRef],
            { timeoutMs: 10_000 });
        if (!inspected?.ok) throw new Error('the pulled image could not be inspected');
        const afterId = normalizeImageId(String(inspected.stdout || '').trim());
        if (afterId === beforeId) return result('current', { ...base, beforeId, afterId });
        try {
            validateExisting(engine.name, afterId, imageRef, runner);
            probeAgentLib(engine.name, afterId, runner);
        } catch (error) {
            return result('invalid', {
                ...base, beforeId, afterId, digestRef, reason: sanitizeReason(error?.message || error),
            });
        }
        return result('replace', { ...base, replaceImage: true, digestRef, beforeId, afterId });
    } catch (error) {
        return result('error', { reason: sanitizeReason(error?.message || error) });
    }
}

const SIMPLE = Object.freeze({
    current: ['unchanged', 'box-image-current'],
    unreachable: ['skipped', 'registry-unreachable'],
    'pull-failed': ['skipped', 'box-image-pull-failed'],
    invalid: ['skipped', 'box-image-invalid'],
    deferred: ['skipped', 'box-image-check-deferred'],
    'policy-unavailable': ['skipped', 'box-image-policy-unavailable'],
    error: ['skipped', 'box-image-check-error'],
});
const TRANSACTION = Object.freeze({
    current: ['unchanged', 'box-image-current'],
    'pending-agentlib': ['skipped', 'box-image-refresh-pending'],
    'pull-failed': ['skipped', 'box-image-pull-failed'],
    invalid: ['skipped', 'box-image-invalid'],
});

/** One non-required `image` record for the Box, or null when the step skipped or the policy is off. */
export function boxImageUpdateRecord(boxImage, prepared) {
    if (!boxImage || boxImage.outcome === 'skip' || boxImage.outcome === 'off') return null;
    let mapped = SIMPLE[boxImage.outcome];
    let reason = boxImage.reason;
    let afterId = boxImage.afterId || null;
    const replaced = prepared?.action === 'replaced';
    if (boxImage.outcome === 'replace') {
        mapped = replaced ? ['changed', 'box-image-refreshed'] : ['unchanged', 'box-image-current'];
    } else if (boxImage.outcome === 'tag-refresh') {
        const refresh = prepared?.imageRefresh;
        mapped = refresh?.outcome === 'replace' && replaced ? ['changed', 'box-image-refreshed']
            : (TRANSACTION[refresh?.outcome] || ['skipped', 'box-image-check-error']);
        reason = refresh?.reason || boxImage.reason;
        afterId = refresh?.afterId || null;
    }
    if (mapped[0] === 'changed') afterId = prepared?.imageId || afterId;
    return createOperationRecord({
        phase: 'image',
        id: `box:${boxImage.canonical || 'image'}`,
        outcome: mapped[0],
        attempted: ['changed', 'skipped'].includes(mapped[0]) && ['box-image-refreshed', 'box-image-pull-failed',
            'box-image-invalid', 'box-image-refresh-pending'].includes(mapped[1]),
        required: false,
        code: mapped[1],
        reason: reason || '',
        before: boxImage.beforeId ? { imageId: boxImage.beforeId } : null,
        after: afterId ? { imageId: afterId } : null,
        details: { box: true },
    });
}
