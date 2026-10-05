import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MpsError } from './mpsEligibility.mjs';
import { MPS_CLIENT_PIPE, MPS_GENERATION_LABEL, mpsClientEnvironment } from './mps.mjs';

const MAX_INSPECT_BYTES = 1024 * 1024;
const fail = (reason) => { throw new MpsError(`MPS runtime observation failed: ${reason}`); };
const immutableId = (value) => typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.test(value) ? value.replace(/^sha256:/, '') : null;
const canonicalPath = (value) => typeof value === 'string' && value.startsWith('/') && !value.includes('\0') && path.posix.normalize(value) === value;
const overlaps = (left, right) => left === right || left === '/' || right === '/' || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

/** Inspect only the immutable runtime selected by lifecycle admission. Neither
 * the complete environment nor command output escapes this verification. */
export function verifyMpsRuntimeObservation({ containerId, imageId, share, state, runtime = 'podman', query = spawnSync, imageUser } = {}) {
    const expectedContainer = immutableId(containerId);
    const expectedImage = immutableId(imageId);
    if (!expectedContainer || !expectedImage || !['podman', 'docker'].includes(runtime)) fail('exact container, image and container runtime are required');
    if (!/^[A-Za-z0-9.-]{1,128}$/.test(String(state?.daemonGeneration || '')) || !/^[A-Za-z0-9.-]{1,128}$/.test(String(state?.configurationGeneration || ''))) fail('generation identity is invalid');
    const expectedEnvironment = mpsClientEnvironment(share, state.pipeDirectory);
    const generation = `${state.daemonGeneration}:${state.configurationGeneration}`;
    let reply;
    try { reply = query(runtime, ['container', 'inspect', expectedContainer], { encoding: 'utf8', timeout: 5000, timeoutMs: 5000, maxBuffer: MAX_INSPECT_BYTES, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (_) { fail('container inspection could not complete'); }
    const successful = reply && (Object.hasOwn(reply, 'status') ? reply.status === 0 && reply.ok !== false : reply.ok === true);
    if (!successful || reply.error || reply.signal || reply.truncated || typeof reply.stdout !== 'string' || Buffer.byteLength(reply.stdout) > MAX_INSPECT_BYTES) fail('container inspection failed, timed out or exceeded its bound');
    let rows;
    try { rows = JSON.parse(reply.stdout); } catch (_) { fail('container inspection is not valid JSON'); }
    if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') fail('container inspection did not select one runtime');
    const inspected = rows[0];
    if (immutableId(inspected.Id || inspected.ID) !== expectedContainer || immutableId(inspected.Image) !== expectedImage) fail('container or image identity changed');
    if (inspected.Config?.Labels?.[MPS_GENERATION_LABEL] !== generation) fail('generation label changed');
    if (imageUser !== undefined && inspected.Config?.User !== imageUser) fail('image user changed');
    const environment = {};
    if (!Array.isArray(inspected.Config?.Env) || inspected.Config.Env.length > 16384) fail('runtime environment is unavailable or oversized');
    for (const entry of inspected.Config.Env) {
        if (typeof entry !== 'string') fail('runtime environment contains an invalid entry');
        const separator = entry.indexOf('=');
        const name = separator < 0 ? entry : entry.slice(0, separator);
        if (!Object.hasOwn(expectedEnvironment, name)) continue;
        if (Object.hasOwn(environment, name) || separator < 0 || entry.slice(separator + 1) !== expectedEnvironment[name]) fail('MPS environment is missing, duplicated or changed');
        environment[name] = entry.slice(separator + 1);
    }
    if (Object.keys(environment).length !== 3) fail('MPS environment is incomplete');
    if (!Array.isArray(inspected.Mounts) || inspected.Mounts.length > 1024) fail('runtime mounts are unavailable or oversized');
    let pipeMount = null;
    for (const mount of inspected.Mounts) {
        if (!mount || !canonicalPath(mount.Destination)) fail('runtime mount destination is ambiguous');
        const source = mount.Source;
        if (mount.Type === 'bind' && !canonicalPath(source)) fail('runtime bind source is ambiguous');
        const destinationOverlap = overlaps(mount.Destination, MPS_CLIENT_PIPE);
        const sourceOverlap = canonicalPath(source) && overlaps(source, state.pipeDirectory);
        if (!destinationOverlap && !sourceOverlap) continue;
        if (pipeMount || mount.Type !== 'bind' || source !== state.pipeDirectory || mount.Destination !== MPS_CLIENT_PIPE || mount.RW !== true) fail('private pipe mount is missing, changed, duplicated or overlapping');
        pipeMount = Object.freeze({ source, destination: MPS_CLIENT_PIPE, readWrite: true });
    }
    if (!pipeMount) fail('private pipe mount is missing');
    return Object.freeze({ containerId: expectedContainer, imageId: expectedImage, mpsGeneration: generation, environment: Object.freeze(environment), pipeMount });
}
