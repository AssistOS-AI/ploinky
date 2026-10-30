// Worker access to execution-target mailboxes.
//
// Every execution target's helper listens in its own mailbox directory, `<boxTmp>/ploinky-target-mailboxes/<incarnation>`
// (provisioning.mjs), bound into the target at /run/ploinky-target/mailbox. The mailbox-only root holds nothing else: no
// control directory, launch file or ticket-secret copy. This module decides whether one agent, the single
// execution-provider worker, also gets that whole root read-only at /run/ploinky-worker-targets, so targets provisioned
// later appear in the running worker without a restart; and it deletes the mailboxes of one exact target instance once
// that instance's container is proven removed or absent.
//
// The grant mirrors the Router's source-protection holder ACL (privateRouter.js `sourceProtectionHolderCallers`): an
// agent is a holder when its manifest carries a valid `executionProvider` declaration and it is the first, enabled
// registry record of its principal. A worker gets the bind only while it is the only holder principal (several
// instances of the same principal are one holder). The registry alone cannot see a container that lost its record but
// still runs with the bind, so the grant also requires that no running container other than this worker's own (the
// container being started or adopted, and the exact predecessor it replaces) already holds the mailbox root. Holding
// the bind grants no channel authority: every helper channel still needs a Router ticket. File permissions do not separate rootless agents (all map to the Box user), so reach is by
// mount only.
//
// This module reads no environment, spawns nothing and opens no network: the manifest reader, the provider-declaration
// reader, the Box decision and fs are injected by the call site.

import fs from 'node:fs';
import path from 'node:path';

import { deepFreeze, isOpaqueIdentity, isPrincipal } from './contract.mjs';
import { readExecutionTargetDeclaration } from './declaration.mjs';
import { ensureMailboxRoot, mailboxRootPath, readProvisioningRecord, WORKER_TARGETS_PATH } from './provisioning.mjs';

export { ensureMailboxRoot, WORKER_TARGETS_PATH };

export const WORKER_MAILBOX_ERROR_CODES = Object.freeze({
    conflict: 'EXECUTION_WORKER_TARGET_CONFLICT',
});

export class WorkerMailboxError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'WorkerMailboxError';
        this.code = code;
        this.status = 422;
    }
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function principalOf(repoName, agentName) {
    return `agent:${String(repoName || '').trim()}/${String(agentName || '').trim()}`;
}

// The holder principals other than `own` among the registry records, exactly as the Router's ACL selects them: the
// first record of each principal, only while it carries an enable generation, with the manifest of its route key. A
// routed manifest that cannot be read is counted as a holder (fail closed: the bind is withheld, never granted on doubt).
function otherHolderPrincipals({ own, registry, readManifestOf, readProviderDeclaration }) {
    const seen = new Set();
    const holders = new Set();
    for (const [containerName, record] of Object.entries(isPlainObject(registry) ? registry : {})) {
        if (!isPlainObject(record) || record.type !== 'agent') continue;
        const principal = principalOf(record.repoName, record.agentName);
        if (seen.has(principal)) continue;
        seen.add(principal);
        if (principal === own || !String(record.enableGeneration || '')) continue;
        const routeKey = String(record.alias || record.agentName || '');
        let read;
        try {
            const manifest = readManifestOf({ containerName, record, routeKey });
            // No routed manifest: the Router has none for this route either.
            if (manifest === null || manifest === undefined) continue;
            read = readProviderDeclaration(manifest, { routeKey });
        } catch (_) {
            holders.add(principal);
            continue;
        }
        if (read?.present === true && read.valid === true) holders.add(principal);
    }
    return [...holders].sort();
}

/**
 * Start-boundary decision for one agent:
 *   - null: no `executionProvider` declaration, an invalid one (its publication check refuses it elsewhere), a runtime
 *     other than Podman, or a start outside a Ploinky Box;
 *   - throws EXECUTION_WORKER_TARGET_CONFLICT: the manifest declares both `executionProvider` and `executionTarget`;
 *   - `{withheld: 'ambiguous', principals}`: another enabled holder principal exists (this one first);
 *   - `{withheld: 'held-elsewhere', holders}`: a running container other than this worker's own already holds the
 *     mailbox root (or the holders could not be listed: `holders` is then null);
 *   - `{source, target, readOnly: true}`: the mailbox-only root, read-only at /run/ploinky-worker-targets.
 * `readManifestOf({containerName, record, routeKey})` returns another agent's routed manifest, null when it has no
 * route, and throws when a routed manifest cannot be read. `readProviderDeclaration(manifest, {routeKey})` is the
 * execution-provider declaration reader. `listMailboxRootHolders(source)` returns `[{id, name}]` of every running
 * container with a bind of exactly `source` (it is called only when everything else grants); `ownContainers` names this
 * worker's own: `{containerName, predecessor: {containerName, containerId} | null}`. A holder that `registry` records as
 * an instance of this same principal (same key and immutable id) is not foreign: several instances are one holder.
 */
export function planWorkerMailboxGrant({
    manifest,
    routeKey,
    repoName,
    agentName,
    runtime,
    insideBox,
    registry,
    readManifestOf,
    readProviderDeclaration,
    boxTmpRoot,
    listMailboxRootHolders,
    ownContainers,
} = {}) {
    if (typeof readProviderDeclaration !== 'function' || typeof readManifestOf !== 'function'
        || typeof listMailboxRootHolders !== 'function') {
        throw new TypeError('planWorkerMailboxGrant requires injected manifest, provider-declaration and holder readers');
    }
    const own = readProviderDeclaration(manifest, { routeKey: String(routeKey || '') });
    if (own?.present !== true) return null;
    if (readExecutionTargetDeclaration(manifest).present) {
        throw new WorkerMailboxError('an agent cannot declare both executionProvider and executionTarget',
            WORKER_MAILBOX_ERROR_CODES.conflict);
    }
    if (own.valid !== true || runtime !== 'podman' || insideBox !== true) return null;
    const principal = principalOf(repoName, agentName);
    if (!isPrincipal(principal)) return null;
    if (typeof boxTmpRoot !== 'string' || !path.isAbsolute(boxTmpRoot)) {
        throw new TypeError('planWorkerMailboxGrant requires the absolute Box tmpfs root');
    }
    const others = otherHolderPrincipals({ own: principal, registry, readManifestOf, readProviderDeclaration });
    if (others.length) return deepFreeze({ withheld: 'ambiguous', principals: [principal, ...others] });
    const source = mailboxRootPath(boxTmpRoot);
    const foreign = foreignHolders({ source, listMailboxRootHolders, ownContainers, principal, registry });
    if (foreign === null || foreign.length) return deepFreeze({ withheld: 'held-elsewhere', holders: foreign });
    return deepFreeze({ source, target: WORKER_TARGETS_PATH, readOnly: true });
}

// The running holders of the mailbox root that are not this worker's own container (by exact name), the exact
// predecessor it replaces (by exact name and immutable id), or another registered instance of the same principal (the
// registry key equals the holder's name and its record names this principal and the holder's immutable id). Null when
// they cannot be listed (fail closed). An unregistered container, or one of another principal, is foreign.
function foreignHolders({ source, listMailboxRootHolders, ownContainers, principal, registry }) {
    const ownName = String(ownContainers?.containerName || '');
    const predecessor = ownContainers?.predecessor;
    const predecessorName = String(predecessor?.containerName || '');
    const predecessorId = String(predecessor?.containerId || '');
    let holders;
    try {
        holders = listMailboxRootHolders(source);
    } catch (_) {
        return null;
    }
    if (!Array.isArray(holders) || !ownName) return null;
    const foreign = [];
    for (const holder of holders) {
        const name = String(holder?.name || '').replace(/^\//, '');
        const id = String(holder?.id || '');
        if (!name || !id) return null;
        if (name === ownName) continue;
        if (predecessorName && predecessorId && name === predecessorName && id === predecessorId) continue;
        const registered = isPlainObject(registry) && Object.hasOwn(registry, name) ? registry[name] : null;
        if (isPlainObject(registered) && registered.type === 'agent'
            && principalOf(registered.repoName, registered.agentName) === principal
            && String(registered.containerId || '') === id) continue;
        foreign.push(name);
    }
    return foreign.sort();
}

function lstatOrNull(fsApi, target) {
    try {
        return fsApi.lstatSync(target);
    } catch (_) {
        return null;
    }
}

// Removes one incarnation mailbox: a symlink or other non-directory at that name is unlinked (never followed); in a
// real directory every non-directory entry (the helper socket, files, symlinks) is unlinked and the directory removed.
// A nested directory is left, and so is its parent. Nothing here throws.
function removeMailbox(fsApi, directory) {
    const stat = lstatOrNull(fsApi, directory);
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        try { fsApi.unlinkSync(directory); return true; } catch (_) { return false; }
    }
    let names = [];
    try { names = fsApi.readdirSync(directory); } catch (_) { names = []; }
    for (const name of names) {
        const entry = path.join(directory, String(name));
        const entryStat = lstatOrNull(fsApi, entry);
        if (!entryStat || entryStat.isDirectory()) continue;
        try { fsApi.unlinkSync(entry); } catch (_) {}
    }
    try { fsApi.rmdirSync(directory); return true; } catch (_) { return false; }
}

/**
 * After the exact container `{containerName, instanceId, enableGeneration}` of target `principal` was proven removed or
 * absent: deletes the mailboxes of exactly the incarnations the provisioning record says that instance owns. With
 * `keepCurrent` (predecessor retirement) the record's current incarnation is never touched. A record without an owner
 * map, an unowned incarnation, a symlinked or missing mailbox root and every fs error are no-ops. Never throws.
 * Returns `{removed}` (the incarnations whose mailbox is gone).
 */
export function retireInstanceMailboxes({
    controllerStateDir,
    boxTmpRoot,
    principal,
    containerName,
    instanceId,
    enableGeneration,
    keepCurrent = false,
    fsApi = fs,
} = {}) {
    const removed = [];
    try {
        if (!isPrincipal(principal) || typeof containerName !== 'string' || !containerName
            || !isOpaqueIdentity(instanceId) || !isOpaqueIdentity(enableGeneration)
            || typeof controllerStateDir !== 'string' || !path.isAbsolute(controllerStateDir)
            || typeof boxTmpRoot !== 'string' || !path.isAbsolute(boxTmpRoot)) {
            return deepFreeze({ removed });
        }
        const record = readProvisioningRecord({ controllerStateDir, principal, fsApi });
        const owners = record?.incarnationOwners;
        if (!owners) return deepFreeze({ removed });
        const root = mailboxRootPath(boxTmpRoot);
        const rootStat = lstatOrNull(fsApi, root);
        if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return deepFreeze({ removed });
        for (const [incarnation, owner] of Object.entries(owners)) {
            if (owner.containerName !== containerName || owner.instanceId !== instanceId
                || owner.enableGeneration !== enableGeneration) continue;
            if (keepCurrent && record.current?.helperIncarnation === incarnation) continue;
            if (removeMailbox(fsApi, path.join(root, incarnation))) removed.push(incarnation);
        }
    } catch (_) {
        // Best effort: an undeleted mailbox is inert (its helper is gone) and the Box tmpfs is cleared with the Box.
    }
    return deepFreeze({ removed });
}
