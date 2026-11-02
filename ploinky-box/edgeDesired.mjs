import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    boxWorkspaceEnvironment,
    boxWorkspaceExecOptions,
    boxWorkspacePath,
} from './contract/workspace-root.mjs';
import { PloinkyBoxError } from './errors.mjs';

export const BOX_EDGE_DESIRED_FILE = 'edge-desired.json';
export const BOX_EDGE_DESIRED_MAX_BYTES = 1024 * 1024;

function desiredError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_EDGE_DESIRED_INVALID',
        cause,
    });
}

function sameFile(left, right) {
    return String(left.dev) === String(right.dev)
        && String(left.ino) === String(right.ino)
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}

function validateCandidateStat(stat, candidatePath) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw desiredError(`Box edge desired state must be one non-linked regular file: ${candidatePath}`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw desiredError(`Box edge desired state must be owned by the current user: ${candidatePath}`);
    }
    if ((stat.mode & 0o022) !== 0) {
        throw desiredError(`Box edge desired state must not be group- or world-writable: ${candidatePath}`);
    }
    if (stat.size > BOX_EDGE_DESIRED_MAX_BYTES) {
        throw desiredError(
            `Box edge desired state exceeds ${BOX_EDGE_DESIRED_MAX_BYTES} bytes: ${candidatePath}`,
        );
    }
}

function validateCandidateDocument(bytes, candidatePath) {
    let document;
    try {
        document = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw desiredError(`Box edge desired state must contain valid JSON: ${candidatePath}`, error);
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)
        || !document.hosts
        || typeof document.hosts !== 'object'
        || Array.isArray(document.hosts)) {
        throw desiredError(
            `Box edge desired state lacks the required hosts shape: ${candidatePath}`,
        );
    }
    return document;
}

export function readWorkspaceEdgeDesired(identity, {
    fsApi = fs,
} = {}) {
    const candidatePath = path.join(identity.anchorPath, BOX_EDGE_DESIRED_FILE);
    let descriptor;
    try {
        descriptor = fsApi.openSync(
            candidatePath,
            fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW,
        );
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw desiredError(`Unable to open Box edge desired state: ${candidatePath}`, error);
    }

    try {
        const before = fsApi.fstatSync(descriptor);
        validateCandidateStat(before, candidatePath);
        const bytes = fsApi.readFileSync(descriptor);
        const after = fsApi.fstatSync(descriptor);
        if (!sameFile(before, after) || bytes.length !== before.size) {
            throw desiredError(`Box edge desired state changed while being read: ${candidatePath}`);
        }
        validateCandidateDocument(bytes, candidatePath);
        return Object.freeze({
            path: candidatePath,
            digest: crypto.createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
        });
    } finally {
        fsApi.closeSync(descriptor);
    }
}

function exactDigest(result) {
    if (!result?.ok) return '';
    return String(result.stdout || '').trim().split(/\s+/)[0];
}

function validatedAuthorityBytes(bytes, assertHeld) {
    if (typeof assertHeld !== 'function') throw desiredError('Edge authority replacement requires mutation coordination');
    assertHeld();
    const text = Buffer.from(bytes || '');
    if (text.length > BOX_EDGE_DESIRED_MAX_BYTES) throw desiredError('Edge authority replacement is too large');
    validateCandidateDocument(text, BOX_EDGE_DESIRED_FILE);
    return text;
}

function installAuthorityBytes(identity, target, text, { assertHeld, assertCurrent, fsApi }) {
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
        const fd = fsApi.openSync(temporary, 'wx', 0o600);
        try { fsApi.writeFileSync(fd, text); fsApi.fsyncSync(fd); } finally { fsApi.closeSync(fd); }
        assertHeld();
        assertCurrent();
        fsApi.renameSync(temporary, target);
        const directory = fsApi.openSync(identity.anchorPath, 'r');
        try { fsApi.fsyncSync(directory); } finally { fsApi.closeSync(directory); }
    } finally {
        try { fsApi.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return readWorkspaceEdgeDesired(identity, { fsApi });
}

// The caller journals both versions before entering its mutation coordination.
// The same writer is usable through the confined Box channel for subuid-owned anchors.
export function replaceWorkspaceEdgeDesired(identity, { expectedDigest, bytes, assertHeld, fsApi = fs } = {}) {
    const text = validatedAuthorityBytes(bytes, assertHeld);
    if (!/^[a-f0-9]{64}$/.test(String(expectedDigest || ''))) throw desiredError('Expected edge authority digest is required');
    const current = readWorkspaceEdgeDesired(identity, { fsApi });
    if (!current || current.digest !== expectedDigest) throw desiredError('Edge authority changed before replacement');
    return installAuthorityBytes(identity, current.path, text, {
        assertHeld,
        fsApi,
        assertCurrent() {
            if (readWorkspaceEdgeDesired(identity, { fsApi })?.digest !== expectedDigest) {
                throw desiredError('Edge authority changed during replacement');
            }
        },
    });
}

function assertWritableAuthorityPath(identity, target, fsApi) {
    const anchor = fsApi.lstatSync(identity.anchorPath);
    if (!anchor.isDirectory() || anchor.isSymbolicLink()) {
        throw desiredError(`Workspace identity anchor must be a real directory: ${identity.anchorPath}`);
    }
    let stat;
    try {
        stat = fsApi.lstatSync(target);
    } catch (error) {
        if (error.code === 'ENOENT') return;
        throw desiredError(`Unable to inspect Box edge desired state: ${target}`, error);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw desiredError(`Box edge desired state must be one non-linked regular file: ${target}`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw desiredError(`Box edge desired state must be owned by the current user: ${target}`);
    }
}

// The operator's save of the host-owned input that the next start stages. It
// never touches the Box or activates a routing generation.
export function writeWorkspaceEdgeDesired(identity, { bytes, assertHeld, fsApi = fs } = {}) {
    const text = validatedAuthorityBytes(bytes, assertHeld);
    const target = path.join(identity.anchorPath, BOX_EDGE_DESIRED_FILE);
    assertWritableAuthorityPath(identity, target, fsApi);
    return installAuthorityBytes(identity, target, text, {
        assertHeld,
        fsApi,
        assertCurrent: () => assertWritableAuthorityPath(identity, target, fsApi),
    });
}

export function stageWorkspaceEdgeDesired({
    candidate,
    engine,
    containerId,
    runner,
    workspaceRoot,
} = {}) {
    if (!candidate) return Object.freeze({ staged: false });
    if (!/^[a-f0-9]{12,64}$/.test(String(containerId || ''))) {
        throw desiredError('Box edge desired staging requires an immutable outer container ID');
    }
    if (!/^[a-f0-9]{64}$/.test(String(candidate.digest || ''))) {
        throw desiredError('Box edge desired staging requires an exact SHA-256 candidate digest');
    }

    const engineName = String(engine?.name || engine || '');
    const desiredDirectory = boxWorkspacePath(workspaceRoot, '.ploinky/data/edge-routing');
    const desiredTarget = `${desiredDirectory}/desired.json`;
    const stagedTarget = `${desiredTarget}.box-candidate`;

    runner.run(engineName, [
        'container', 'exec', '--user', 'podman', ...boxWorkspaceExecOptions(workspaceRoot),
        ...Object.entries(boxWorkspaceEnvironment(workspaceRoot))
            .flatMap(([key, value]) => ['--env', `${key}=${value}`]),
        containerId,
        'node', '/opt/ploinky/ploinky-box/entrypoint/initialize-edge-routing.mjs',
    ]);
    runner.run(engineName, [
        'container', 'exec', '--user', 'podman', containerId,
        'mkdir', '-p', desiredDirectory,
    ]);
    runner.run(engineName, [
        'container', 'exec', '--user', 'podman', containerId,
        'chmod', '700', desiredDirectory,
    ]);
    runner.run(engineName, [
        'container', 'exec', '--user', 'podman', containerId,
        'rm', '-f', stagedTarget,
    ]);

    try {
        runner.run(engineName, [
            'container', 'cp', candidate.path, `${containerId}:${stagedTarget}`,
        ]);
        const stagedDigest = runner.query(engineName, [
            'container', 'exec', '--user', 'podman', containerId,
            'sha256sum', stagedTarget,
        ]);
        if (exactDigest(stagedDigest) !== candidate.digest) {
            throw desiredError('Box edge desired state changed before in-box staging completed');
        }
        runner.run(engineName, [
            'container', 'exec', '--user', 'podman', containerId,
            'mv', stagedTarget, desiredTarget,
        ]);
        runner.run(engineName, [
            'container', 'exec', '--user', 'podman', containerId,
            'chmod', '600', desiredTarget,
        ]);
        const installedDigest = runner.query(engineName, [
            'container', 'exec', '--user', 'podman', containerId,
            'sha256sum', desiredTarget,
        ]);
        if (exactDigest(installedDigest) !== candidate.digest) {
            throw desiredError('Installed Box edge desired state does not match its host authority');
        }
    } finally {
        runner.query(engineName, [
            'container', 'exec', '--user', 'podman', containerId,
            'rm', '-f', stagedTarget,
        ]);
    }

    return Object.freeze({
        staged: true,
        digest: candidate.digest,
    });
}
