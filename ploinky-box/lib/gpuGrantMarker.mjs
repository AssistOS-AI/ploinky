// Read-only view of the host GPU grant from inside a Box.
//
// The host bind-mounts one read-only marker per Box generation at
// BOX_GPU_MARKER_PATH, next to the hookless CDI spec at BOX_GPU_CDI_SPEC_PATH.
// In-Box admission trusts a marker only when it names this exact workspace and
// its spec digest matches the spec actually mounted, so a marker can neither be
// reused by another workspace nor outlive the wiring it describes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    BOX_GPU_CDI_DEVICE,
    BOX_GPU_CDI_SPEC_PATH,
    BOX_GPU_MARKER_PATH,
} from '../constants.mjs';

export const GPU_GRANT_MARKER_KIND = 'ploinky-box-gpu-grant';
export const GPU_GRANT_MARKER_VERSION = 1;
const MARKER_MAX_BYTES = 16 * 1024;
const SPEC_MAX_BYTES = 256 * 1024;
const MARKER_KEYS = Object.freeze([
    'agents',
    'cdiDevice',
    'fingerprint',
    'instance',
    'kind',
    'pathHash',
    'reason',
    'specSha256',
    'state',
    'vendor',
    'version',
    'workspaceRoot',
]);
const SELECTOR_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** REPO/AGENT, the same two segments Ploinky resolves agents by. */
export function normalizeGpuAgentSelector(value) {
    const text = String(value ?? '').trim();
    const segments = text.split('/');
    if (segments.length !== 2 || !segments.every((segment) => SELECTOR_SEGMENT_RE.test(segment))) {
        throw new Error(`GPU grant agent ${JSON.stringify(text)} must be REPO/AGENT`);
    }
    return text;
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readBoundedFile(fsApi, target, maxBytes) {
    const stat = fsApi.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${target} is not a regular file`);
    if (stat.size > maxBytes) throw new Error(`${target} exceeds ${maxBytes} bytes`);
    return fsApi.readFileSync(target);
}

function workspaceIdentity(workspaceRoot) {
    const root = path.resolve(String(workspaceRoot || ''));
    const pathHash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
    return { workspaceRoot: root, pathHash };
}

/**
 * Capture the Box GPU grant for admission.
 *
 * @returns {Readonly<object>} `{ present: false }` when no marker is mounted,
 *   otherwise the validated marker fields plus `valid`, a `problem` string for
 *   an invalid marker, and `digest` binding marker and spec bytes.
 */
export function readBoxGpuGrant({
    workspaceRoot,
    markerPath = BOX_GPU_MARKER_PATH,
    specPath = BOX_GPU_CDI_SPEC_PATH,
    fsApi = fs,
} = {}) {
    let markerBytes;
    try {
        markerBytes = readBoundedFile(fsApi, markerPath, MARKER_MAX_BYTES);
    } catch (error) {
        if (error?.code === 'ENOENT') return Object.freeze({ present: false });
        return Object.freeze({ present: true, valid: false, problem: `grant marker unreadable: ${error.message}` });
    }
    let specBytes = null;
    try {
        specBytes = readBoundedFile(fsApi, specPath, SPEC_MAX_BYTES);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            return Object.freeze({ present: true, valid: false, problem: `CDI spec unreadable: ${error.message}` });
        }
    }
    const digest = `sha256:${sha256(Buffer.concat([
        markerBytes,
        Buffer.from('\0'),
        specBytes || Buffer.alloc(0),
    ]))}`;
    const invalid = (problem) => Object.freeze({ present: true, valid: false, problem, digest });
    let marker;
    try {
        marker = JSON.parse(markerBytes.toString('utf8'));
    } catch {
        return invalid('grant marker is not valid JSON');
    }
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)
        || JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(MARKER_KEYS)
        || marker.version !== GPU_GRANT_MARKER_VERSION
        || marker.kind !== GPU_GRANT_MARKER_KIND) {
        return invalid('grant marker has an unsupported schema');
    }
    const identity = workspaceIdentity(workspaceRoot);
    if (marker.workspaceRoot !== identity.workspaceRoot || marker.pathHash !== identity.pathHash
        || typeof marker.instance !== 'string' || !marker.instance.endsWith(`-${identity.pathHash}`)) {
        return invalid('grant marker belongs to another workspace');
    }
    let agents;
    try {
        if (!Array.isArray(marker.agents)) throw new Error('agents must be a list');
        agents = marker.agents.map(normalizeGpuAgentSelector);
    } catch (error) {
        return invalid(`grant marker agents are invalid: ${error.message}`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(marker.fingerprint))) return invalid('grant marker fingerprint is invalid');
    if (marker.state === 'active') {
        if (marker.cdiDevice !== BOX_GPU_CDI_DEVICE || !specBytes
            || marker.specSha256 !== sha256(specBytes)) {
            return invalid('grant marker does not match the mounted CDI spec');
        }
    } else if (marker.state === 'stale') {
        if (marker.cdiDevice !== null || marker.specSha256 !== null || specBytes) {
            return invalid('stale grant marker still describes GPU wiring');
        }
    } else {
        return invalid('grant marker state is invalid');
    }
    return Object.freeze({
        present: true,
        valid: true,
        digest,
        vendor: String(marker.vendor),
        agents: Object.freeze(agents),
        state: marker.state,
        reason: marker.reason === null ? null : String(marker.reason),
        fingerprint: marker.fingerprint,
        cdiDevice: marker.cdiDevice,
    });
}
