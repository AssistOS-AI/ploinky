import fs from 'fs';

import { readAgentRegistrySnapshot } from '../utils/agentRegistrySnapshot.js';
import { findAgent } from '../utils/utils.js';
import { resolveManifestRuntimeProfile } from '../utils/runtime/profileService.js';
import { resolveManifestImage } from '../utils/security/secretVars.js';
import { getRuntimeForAgent, imagePullTimeoutMs, isSandboxRuntime, pullImage } from '../sandbox/docker/common.js';
import { isLlmRuntimeManifest, resolveLlmRuntimeAdmissionContext } from '../sandbox/docker/llmRuntimeIntegration.js';
import { inspectLocalImageId, normalizeImageId } from '../sandbox/docker/runtimeImageIdentity.js';
import { createOperationRecord } from './updateOutcome.js';

// Agent image refresh for `ploinky update`.
//
// Agent images are otherwise pulled only when missing, so an image referenced
// by a mutable tag (`name:tag`, or `name` meaning `name:latest`) would keep
// its first local copy forever. The update pulls every distinct tag-referenced
// image of the enabled container agents once, after the repositories (and so
// the manifests) were updated. A digest reference (`name@sha256:…`) is
// immutable: a changed digest is a new reference that the start path pulls
// because it is missing. Only images that already have a local copy are
// refreshed; a missing one is pulled by the start path exactly as before.
//
// A failed pull keeps the existing local image: it is an optional, named skip,
// never a failure of the update. The next workspace restart recreates every
// container from the current local image of its reference.

const IMAGE_ID_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/;

// The host bounds the whole in-Box update (30 minutes by default). The pulls
// share a smaller budget so that a slow pull ends as a named skip that keeps
// the local image instead of the host cancelling the update.
export const UPDATE_IMAGE_PULL_BUDGET_MS = 20 * 60 * 1000;

/**
 * Classify one image reference.
 *
 * - `digest`: pinned by `@<algorithm>:<hex>` (with or without a tag).
 * - `tag`: a mutable reference; without an explicit tag the tag is `latest`.
 *   A `:` before the last `/` belongs to a registry host port.
 * - `id`: a bare immutable image ID.
 * - `invalid`: empty, unresolved template or whitespace.
 *
 * `key` identifies the same tagged image across spellings `name` and
 * `name:latest`.
 */
export function classifyImageReference(reference) {
    const ref = String(reference ?? '').trim();
    if (!ref || /\s/.test(ref) || ref.includes('${')) return Object.freeze({ kind: 'invalid', reference: ref });
    const at = ref.indexOf('@');
    if (at >= 0) {
        return Object.freeze({ kind: 'digest', reference: ref, name: ref.slice(0, at), digest: ref.slice(at + 1) });
    }
    if (IMAGE_ID_PATTERN.test(ref)) return Object.freeze({ kind: 'id', reference: ref });
    const slash = ref.lastIndexOf('/');
    const colon = ref.lastIndexOf(':');
    const explicitTag = colon > slash;
    const name = explicitTag ? ref.slice(0, colon) : ref;
    const tag = explicitTag ? ref.slice(colon + 1) : 'latest';
    if (!name || !tag) return Object.freeze({ kind: 'invalid', reference: ref });
    return Object.freeze({ kind: 'tag', reference: ref, name, tag, implicitTag: !explicitTag, key: `${name}:${tag}` });
}

export function isTagReference(reference) {
    return classifyImageReference(reference).kind === 'tag';
}

/**
 * The distinct tag-referenced images of the enabled agents, one entry per
 * runtime and image key, each naming the agents that use it.
 *
 * @param {object} registry - `.ploinky/agents.json` snapshot
 * @param {(record: object) => Array<{runtime: string, image: string}>} resolveImages
 * @param {{ repoName?: string|null, warn?: Function }} [options]
 */
export function collectTaggedAgentImages(registry, resolveImages, { repoName = null, warn = () => {} } = {}) {
    const entries = new Map();
    for (const [key, record] of Object.entries(registry || {})) {
        if (key === '_config' || !record || typeof record !== 'object' || record.type !== 'agent') continue;
        if (!record.repoName || !record.agentName) continue;
        if (repoName && record.repoName !== repoName) continue;
        const agentRef = `${record.repoName}/${record.agentName}${record.alias ? ` (${record.alias})` : ''}`;
        let images;
        try {
            images = resolveImages(record) || [];
        } catch (error) {
            warn(`[pull] ${agentRef}: image not resolved, not refreshed (${error?.message || error})`);
            continue;
        }
        for (const { runtime, image } of images) {
            const classified = classifyImageReference(image);
            if (classified.kind !== 'tag') continue;
            const entryKey = `${runtime}\u0000${classified.key}`;
            const entry = entries.get(entryKey) || { runtime, reference: classified.reference, key: classified.key, agents: [] };
            if (!entry.agents.includes(agentRef)) entry.agents.push(agentRef);
            entries.set(entryKey, entry);
        }
    }
    return [...entries.values()];
}

const shortId = id => normalizeImageId(id).slice(0, 12);

function imageRecord(entry, fields) {
    return createOperationRecord({
        phase: 'agent-image',
        id: entry.reference,
        required: false,
        ...fields,
        details: { runtime: entry.runtime, key: entry.key, agents: entry.agents, ...(fields.details || {}) },
    });
}

/**
 * Pull each entry once and record whether its local image ID changed. A
 * reference without a local copy is left to the start path (no record).
 */
export function refreshTaggedImages(entries, {
    inspectImageId = inspectLocalImageId,
    pull = pullImage,
    log = console.log,
    warn = console.warn,
    budgetMs = UPDATE_IMAGE_PULL_BUDGET_MS,
    pullTimeoutMs = imagePullTimeoutMs(),
    now = Date.now,
} = {}) {
    const records = [];
    const deadline = now() + budgetMs;
    for (const entry of entries) {
        const before = inspectImageId(entry.reference, entry.runtime);
        if (!before) {
            log(`[pull] ${entry.reference} is not present locally; it is pulled when an agent starts.`);
            continue;
        }
        const remaining = deadline - now();
        if (remaining < 1000) {
            warn(`[pull] ${entry.reference}: not refreshed, the update's pull time budget is spent; keeping local image ${shortId(before)}.`);
            records.push(imageRecord(entry, {
                outcome: 'skipped',
                attempted: false,
                code: 'image-pull-budget-exhausted',
                reason: `the update's image pull time budget is spent; the existing local image ${shortId(before)} is kept`,
                before: { imageId: before },
            }));
            continue;
        }
        try {
            pull(entry.reference, { runtime: entry.runtime, log, timeoutMs: Math.min(pullTimeoutMs, remaining) });
        } catch (error) {
            const message = String(error?.message || error);
            warn(`[pull] ${entry.reference}: refresh failed (${message}); keeping local image ${shortId(before)}.`);
            records.push(imageRecord(entry, {
                outcome: 'skipped',
                attempted: true,
                code: 'image-pull-failed',
                reason: `the pull failed (${message}); the existing local image ${shortId(before)} is kept`,
                before: { imageId: before },
                after: { imageId: before },
            }));
            continue;
        }
        const after = inspectImageId(entry.reference, entry.runtime);
        if (!after) {
            warn(`[pull] ${entry.reference}: no local image after the pull.`);
            records.push(imageRecord(entry, {
                outcome: 'skipped',
                attempted: true,
                code: 'image-missing-after-pull',
                reason: 'the image was not found locally after the pull',
                before: { imageId: before },
            }));
            continue;
        }
        const changed = after !== before;
        log(changed
            ? `[pull] ${entry.reference}: new image ${shortId(after)} (was ${shortId(before)}); agents using it are recreated on restart.`
            : `[pull] ${entry.reference}: already current (${shortId(after)}).`);
        records.push(imageRecord(entry, {
            outcome: changed ? 'changed' : 'unchanged',
            attempted: true,
            code: changed ? 'image-updated' : 'image-current',
            reason: changed ? `new image ${shortId(after)} (was ${shortId(before)})` : 'already current',
            before: { imageId: before },
            after: { imageId: after },
        }));
    }
    return records;
}

/**
 * The images one enabled agent runs from, read from its current manifest and
 * persisted profile. Host-sandbox agents have no image. An LLM runtime agent
 * runs its catalog-selected image; a catalog entry that pins a digest is
 * refreshed through the catalog itself, not by pulling its reference.
 */
export function resolveAgentRecordImages(record) {
    const ref = `${record.repoName}/${record.agentName}`;
    const resolved = findAgent(ref);
    const manifest = JSON.parse(fs.readFileSync(resolved.manifestPath, 'utf8'));
    const runtime = getRuntimeForAgent(manifest);
    if (isSandboxRuntime(runtime)) return [];
    const profile = resolveManifestRuntimeProfile(manifest, {
        agentName: record.agentName,
        persistedProfileName: record.profile,
    });
    if (isLlmRuntimeManifest(manifest, profile.profileConfig)) {
        const selection = resolveLlmRuntimeAdmissionContext({
            runtime, manifest, profileConfig: profile.profileConfig,
            agentName: record.agentName, alias: record.alias, env: process.env,
        }).startup?.selection;
        return selection?.imageRef && !selection.imageDigest ? [{ runtime, image: selection.imageRef }] : [];
    }
    return [{ runtime, image: resolveManifestImage(manifest, profile.profileConfig, { agentName: record.agentName, repoName: record.repoName }) }];
}

/**
 * The update phase: refresh the tag-referenced images of the enabled agents
 * (of `repoName` only, for `update repo <name>`). Never throws for an outcome.
 */
export function refreshAgentImagesForUpdate({
    repoName = null,
    readRegistry = readAgentRegistrySnapshot,
    resolveImages = resolveAgentRecordImages,
    log = console.log,
    warn = console.warn,
    ...deps
} = {}) {
    let registry;
    try {
        registry = readRegistry();
    } catch (error) {
        warn(`[pull] Agent images were not refreshed: ${error?.message || error}`);
        return [];
    }
    const entries = collectTaggedAgentImages(registry, resolveImages, { repoName, warn });
    if (!entries.length) return [];
    log(`Refreshing ${entries.length} tagged agent image(s)...`);
    return refreshTaggedImages(entries, { log, warn, ...deps });
}
