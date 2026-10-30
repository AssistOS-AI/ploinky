import fs from 'fs';
import path from 'path';

import { PLOINKY_WORKSPACE_ROOT } from '../config.js';
import {
    AGENT_DATA_POLICY_CODE,
    isPathWithin,
    projectedCanonicalPath,
} from './agentDataPathPolicy.js';
import {
    ensureAgentDataGuardSource,
    normalizeRuntimeMountTarget,
    runtimeDescendant,
    runtimePathWithin,
} from './controllerStateGuards.js';

// Every agent keeps private state beneath `<workspace>/.data`: its persistent
// storage (`runtime.resources.persistentStorage`), its home and its data-backed
// manifest volumes. The owner mounts that directory privately into its own
// runtime, but a global-mode agent also mounts the whole workspace, which
// contains every other agent's private directory. These guards mask each peer's
// private directory, inside a workspace grant, with the shared empty read-only
// guard source, in the style of the controller state guards.
//
// "Own" is derived from the runtime's own binds, never from names: any bind
// whose source lies strictly inside `.data` is this agent's explicit grant, and
// a peer directory that equals, contains or sits inside one is left alone.
// `.data/shared` is the deliberately shared directory and is never masked.
export const SHARED_DATA_DIRECTORY_NAME = 'shared';

function guardError(message, context = {}) {
    const error = new Error(message);
    error.code = AGENT_DATA_POLICY_CODE;
    error.status = 422;
    error.context = context;
    return error;
}

// The canonical `.data` directory, or '' when the workspace has none yet. A
// symlinked or non-directory `.data` is refused: agent storage policy already
// forbids it, and a link would move the masks somewhere else.
function canonicalDataRoot(workspaceRoot) {
    const lexical = path.join(path.resolve(workspaceRoot), '.data');
    let stat;
    try {
        stat = fs.lstatSync(lexical);
    } catch (error) {
        if (error?.code === 'ENOENT') return '';
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw guardError(`the agent data root '${lexical}' must be a real directory, not a link or a file`, {
            dataRoot: lexical,
        });
    }
    return projectedCanonicalPath(lexical);
}

function pathExists(target) {
    try {
        fs.lstatSync(target);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

function isRealDirectory(target) {
    try {
        const stat = fs.lstatSync(target);
        return stat.isDirectory() && !stat.isSymbolicLink();
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

// Every first-level directory of `.data` plus the declared peer roots, minus
// the ones the owner needs, deduplicated so no mask sits inside another.
function peerMaskRoots(dataRoot, ownRoots, peerRoots, skipped = []) {
    const candidates = new Set();
    const declaredPeers = new Set();
    for (const entry of fs.readdirSync(dataRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.add(path.join(dataRoot, entry.name));
    }
    for (const peerRoot of peerRoots || []) {
        // Canonicalize the parent only: a link planted at the peer path itself
        // must stay visible as a link so it is reported, never followed.
        const resolved = path.join(projectedCanonicalPath(path.dirname(path.resolve(peerRoot))),
            path.basename(peerRoot));
        if (!isPathWithin(resolved, dataRoot) || resolved === dataRoot) {
            throw guardError(`peer agent data root '${peerRoot}' must be strictly inside '${dataRoot}'`, {
                peerRoot, dataRoot,
            });
        }
        candidates.add(resolved);
        declaredPeers.add(resolved);
    }
    const eligible = Array.from(candidates).filter(candidate => {
        if (ownRoots.some(own => isPathWithin(candidate, own) || isPathWithin(own, candidate))) return false;
        if (isRealDirectory(candidate)) return true;
        // A declared peer path that exists as a link or a file cannot be masked
        // by a directory mount; report it instead of failing the launch. An
        // absent path is expected (the peer has not started) and not reported.
        if (declaredPeers.has(candidate) && pathExists(candidate)) {
            skipped.push({ peer: candidate, reason: 'not a real directory (link or file)' });
        }
        return false;
    });
    return eligible
        .filter(candidate => !eligible.some(other => other !== candidate && isPathWithin(candidate, other)))
        .sort();
}

/**
 * Plans the peer private-data masks for one runtime.
 *
 * `bindings` are the runtime's bind grants (`hostPath`/`runtimePath`/`readOnly`).
 * `peerRoots` are additional peer directories known from the agent registry;
 * they only matter if they exist, as an absent path is never mounted over (the
 * engine would create a host mountpoint). Returns the mounts to add:
 *   - `parent: true` entries pin each writable ancestor between a workspace
 *     grant and a masked directory (normally `.data`), so a peer cannot rename
 *     it away and recreate the old path, exactly like the controller parent pins;
 *   - the masks themselves, read-only, all backed by one empty source.
 * `skipped` lists peer directories left unmasked and why.
 */
export function planAgentPrivateDataGuards(bindings, {
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    peerRoots = [],
} = {}) {
    const plan = { pins: [], masks: [], skipped: [] };
    const dataRoot = canonicalDataRoot(workspaceRoot);
    if (!dataRoot) return plan;
    const grants = (bindings || []).map(binding => ({
        source: projectedCanonicalPath(binding.hostPath || binding.source),
        target: normalizeRuntimeMountTarget(binding.runtimePath || binding.destination),
        readOnly: binding.readOnly === true,
    }));
    const ownRoots = [
        path.join(dataRoot, SHARED_DATA_DIRECTORY_NAME),
        ...grants.filter(grant => grant.source !== dataRoot && isPathWithin(grant.source, dataRoot))
            .map(grant => grant.source),
    ];
    const peers = peerMaskRoots(dataRoot, ownRoots, peerRoots, plan.skipped);
    if (!peers.length) return plan;

    const masks = new Map();
    const pins = new Map();
    for (const peer of peers) {
        for (const grant of grants) {
            // Only a broad grant that contains the peer exposes it.
            if (peer === grant.source || !isPathWithin(peer, grant.source)) continue;
            const target = runtimeDescendant(grant.target, path.relative(grant.source, peer));
            if (grants.some(other => other.target === target || runtimePathWithin(other.target, target))) {
                plan.skipped.push({ peer, target, reason: 'an explicit grant occupies the mask target' });
                continue;
            }
            masks.set(target, { target, peer });
            if (grant.readOnly) continue;
            const segments = path.relative(grant.source, path.dirname(peer)).split(path.sep).filter(Boolean);
            let source = grant.source;
            let pinTarget = grant.target;
            for (const segment of segments) {
                source = path.join(source, segment);
                pinTarget = path.posix.join(pinTarget, segment);
                if (grants.some(other => other.target === pinTarget)) continue;
                pins.set(pinTarget, { source, target: pinTarget, readOnly: false, parent: true });
            }
        }
    }
    plan.pins = Array.from(pins.values())
        .sort((left, right) => left.target.split('/').length - right.target.split('/').length
            || left.target.localeCompare(right.target));
    plan.masks = Array.from(masks.values()).sort((left, right) => left.target.localeCompare(right.target));
    return plan;
}

// Mount list for the container managers: pins first, then the read-only masks
// over the single empty guard source.
export function agentPrivateDataGuardMounts(bindings, options = {}) {
    const plan = planAgentPrivateDataGuards(bindings, options);
    if (plan.skipped.length) {
        console.warn(`[agent-data] ${plan.skipped.length} peer private data path(s) left unmasked: `
            + plan.skipped.map(entry => `${entry.peer} (${entry.reason})`).join('; '));
    }
    if (!plan.masks.length) return [];
    const source = ensureAgentDataGuardSource({
        workspaceRoot: options.workspaceRoot || PLOINKY_WORKSPACE_ROOT,
    });
    return [
        ...plan.pins,
        ...plan.masks.map(mask => ({ source, target: mask.target, readOnly: true, peer: mask.peer })),
    ];
}

// Host-path view for runtimes without a mount namespace (seatbelt): the peer
// directories that the owner's grants do not cover.
export function peerAgentDataDenyPaths(ownRoots, {
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    peerRoots = [],
} = {}) {
    const dataRoot = canonicalDataRoot(workspaceRoot);
    if (!dataRoot) return [];
    const own = [
        path.join(dataRoot, SHARED_DATA_DIRECTORY_NAME),
        ...(ownRoots || []).map(value => projectedCanonicalPath(value))
            .filter(value => value !== dataRoot && isPathWithin(value, dataRoot)),
    ];
    return peerMaskRoots(dataRoot, own, peerRoots);
}
