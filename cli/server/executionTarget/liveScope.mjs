// Live Box scope `{workspaceId, boxIdentity, boxGeneration}` (plan section 5.6; T0 section 4 `LiveScope`; proof slice P3).
//
// One derivation for every consumer that takes a trusted `live` scope: target discovery (`live`), the helper-ticket
// minter (`live`) and the source-protection service (`liveScope()`), and anything that persists a scope for later
// comparison. Values:
//   workspaceId    `workspace:<sha256 hex of the resolved workspace root>`; stable across Box recreation
//   boxIdentity    the versionless semantic Box instance name (`ploinky-box-<slug>-<pathHash>`), injected by the caller
//                  from the Box identity module (the engine does not expose the name inside an unprivileged container)
//   boxGeneration  the exact Box container ID. Podman bind-mounts `/run/.containerenv` from
//                  `.../overlay-containers/<id>/userdata/.containerenv`; the ID is read from that one mount's root in
//                  `/proc/self/mountinfo` (observed on Podman 5.7; the file itself is empty unless the container is
//                  privileged). When the file does carry `id="..."`, both must agree. The ID changes whenever the Box
//                  is recreated and never comes from the workspace path
// Every read goes to the files (no cache). Outside a Box, or when the engine evidence is missing, ambiguous or
// inconsistent, the scope is null and every consumer fails closed (`invalid_request` / `source_unavailable`).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { deepFreeze, isOpaqueIdentity } from './contract.mjs';

export const BOX_CONTAINER_ENV_PATH = '/run/.containerenv';
export const MOUNT_INFO_PATH = '/proc/self/mountinfo';
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const CONTAINER_ENV_ROOT = /\/overlay-containers\/([0-9a-f]{64})\/userdata\/\.containerenv$/;
const MAX_CONTAINER_ENV_BYTES = 16 * 1024;
const MAX_MOUNT_INFO_BYTES = 4 * 1024 * 1024;

/** `workspace:<sha256>` of the resolved workspace root. */
export function workspaceScopeId(workspaceRoot) {
    if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) return null;
    return `workspace:${crypto.createHash('sha256').update(path.resolve(workspaceRoot), 'utf8').digest('hex')}`;
}

// The engine writes Go-quoted `key="value"` lines; only plain printable values are accepted.
function parseContainerEnv(text) {
    const out = new Map();
    for (const line of text.split('\n')) {
        const match = /^([a-zA-Z][a-zA-Z0-9]*)="([\x21\x23-\x5b\x5d-\x7e]*)"$/.exec(line);
        if (match && !out.has(match[1])) out.set(match[1], match[2]);
    }
    return out;
}

// The container ID from the one mountinfo entry mounted at exactly /run/.containerenv, or null.
function containerIdFromMountInfo(text) {
    const ids = [];
    for (const line of text.split('\n')) {
        const fields = line.split(' ');
        if (fields.length < 10 || fields[4] !== BOX_CONTAINER_ENV_PATH) continue;
        const match = CONTAINER_ENV_ROOT.exec(fields[3]);
        ids.push(match ? match[1] : null);
    }
    return ids.length === 1 ? ids[0] : null;
}

function readBounded(fsApi, target, maxBytes) {
    try {
        const text = fsApi.readFileSync(target, 'utf8');
        return Buffer.byteLength(text, 'utf8') <= maxBytes ? text : null;
    } catch (_) {
        return null;
    }
}

/** Read the live scope once: the frozen scope or null. */
export function readLiveBoxScope({
    workspaceRoot,
    expectedBoxName,
    insideBox,
    containerEnvPath = BOX_CONTAINER_ENV_PATH,
    mountInfoPath = MOUNT_INFO_PATH,
    fsApi = fs,
} = {}) {
    if (insideBox !== true) return null;
    const workspaceId = workspaceScopeId(workspaceRoot);
    if (!workspaceId || typeof expectedBoxName !== 'string' || !isOpaqueIdentity(expectedBoxName)) return null;
    const mountInfo = readBounded(fsApi, mountInfoPath, MAX_MOUNT_INFO_BYTES);
    const id = mountInfo === null ? null : containerIdFromMountInfo(mountInfo);
    if (!CONTAINER_ID.test(id || '')) return null;
    // A populated engine record must agree (it names the same container and, when present, the same Box name).
    let stat;
    try {
        stat = fsApi.lstatSync(containerEnvPath);
    } catch (_) {
        return null;
    }
    if (!stat.isFile() || stat.size > MAX_CONTAINER_ENV_BYTES) return null;
    const record = readBounded(fsApi, containerEnvPath, MAX_CONTAINER_ENV_BYTES);
    if (record === null) return null;
    const fields = parseContainerEnv(record);
    if (fields.has('id') && fields.get('id') !== id) return null;
    if (fields.has('name') && fields.get('name') !== expectedBoxName) return null;
    return deepFreeze({ workspaceId, boxIdentity: expectedBoxName, boxGeneration: id });
}

/** An async provider of the live scope for injection (`liveScope` / `live: await provider()`). */
export function createLiveBoxScopeProvider(options = {}) {
    const frozen = Object.freeze({ ...options });
    return async () => readLiveBoxScope(frozen);
}
