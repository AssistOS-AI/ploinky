import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PloinkyBoxError } from './errors.mjs';

export const BOX_EDGE_DESIRED_FILE = 'edge-desired.json';
export const BOX_EDGE_DESIRED_MAX_BYTES = 1024 * 1024;

const admittedCandidateStats = new WeakMap();

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

function readExactBoundedDescriptor(fsApi, descriptor, expectedSize) {
    const buffer = Buffer.alloc(expectedSize + 1);
    let offset = 0;
    while (offset < buffer.length) {
        const count = fsApi.readSync(
            descriptor,
            buffer,
            offset,
            buffer.length - offset,
            null,
        );
        if (count === 0) break;
        offset += count;
    }
    return buffer.subarray(0, offset);
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
        const bytes = readExactBoundedDescriptor(fsApi, descriptor, before.size);
        const after = fsApi.fstatSync(descriptor);
        if (!sameFile(before, after) || bytes.length !== before.size) {
            throw desiredError(`Box edge desired state changed while being read: ${candidatePath}`);
        }
        validateCandidateDocument(bytes, candidatePath);
        const candidate = Object.freeze({
            path: candidatePath,
            digest: crypto.createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
        });
        admittedCandidateStats.set(candidate, after);
        return candidate;
    } finally {
        fsApi.closeSync(descriptor);
    }
}

function readAdmittedCandidateBytes(candidate, {
    fsApi = fs,
} = {}) {
    const admitted = admittedCandidateStats.get(candidate);
    if (!admitted) {
        throw desiredError('Box edge desired staging requires the exact admitted candidate');
    }
    let descriptor;
    try {
        descriptor = fsApi.openSync(
            candidate.path,
            fsApi.constants.O_RDONLY
                | fsApi.constants.O_NOFOLLOW
                | (fsApi.constants.O_NONBLOCK || 0),
        );
    } catch (error) {
        throw desiredError('Box edge desired state changed before archive staging', error);
    }

    try {
        const before = fsApi.fstatSync(descriptor);
        validateCandidateStat(before, candidate.path);
        if (!sameFile(admitted, before) || before.size !== candidate.size) {
            throw desiredError('Box edge desired state changed before archive staging');
        }
        const bytes = readExactBoundedDescriptor(fsApi, descriptor, before.size);
        const after = fsApi.fstatSync(descriptor);
        if (!sameFile(before, after)
            || !sameFile(admitted, after)
            || bytes.length !== candidate.size
            || crypto.createHash('sha256').update(bytes).digest('hex') !== candidate.digest) {
            throw desiredError('Box edge desired state changed before archive staging');
        }
        return Buffer.from(bytes);
    } finally {
        fsApi.closeSync(descriptor);
    }
}

function exactDigest(result) {
    if (result?.exitCode !== 0) return '';
    return String(result.stdout || '').trim().split(/\s+/)[0];
}

function tarOctal(value, width) {
    return `${Number(value).toString(8).padStart(width - 1, '0')}\0`;
}

function tarString(header, offset, length, value) {
    const bytes = Buffer.from(String(value));
    if (bytes.length > length) throw desiredError('Box edge archive field exceeds its bound');
    bytes.copy(header, offset);
}

function singleFileTar(name, bytes) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) {
        throw desiredError('Box edge archive name is invalid');
    }
    const header = Buffer.alloc(512);
    tarString(header, 0, 100, name);
    tarString(header, 100, 8, tarOctal(0o600, 8));
    tarString(header, 108, 8, tarOctal(0, 8));
    tarString(header, 116, 8, tarOctal(0, 8));
    tarString(header, 124, 12, tarOctal(bytes.length, 12));
    tarString(header, 136, 12, tarOctal(0, 12));
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    tarString(header, 257, 6, 'ustar\0');
    tarString(header, 263, 2, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    tarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
    return Buffer.concat([header, bytes, padding, Buffer.alloc(1024)]);
}

async function directExec(hostClient, journal, containerId, argv, {
    user = 'podman',
    workdir = '/workspace',
} = {}) {
    const result = await hostClient.execContainer({
        id: containerId,
        argv,
        user,
        workdir,
        env: {},
        journal,
        maxOutputBytes: 1024 * 1024,
    });
    if (result.exitCode !== 0) {
        throw desiredError(
            `Box edge staging command failed with status ${result.exitCode}: ${result.stderr || result.stdout || argv[0]}`,
        );
    }
    return result;
}

export async function stageWorkspaceEdgeDesired({
    candidate,
    containerId,
    hostClient,
    journal,
} = {}) {
    if (!candidate) return Object.freeze({ staged: false });
    if (!/^[a-f0-9]{64}$/.test(String(containerId || ''))) {
        throw desiredError('Box edge desired staging requires an immutable outer container ID');
    }
    if (!/^[a-f0-9]{64}$/.test(String(candidate.digest || ''))) {
        throw desiredError('Box edge desired staging requires an exact SHA-256 candidate digest');
    }

    if (!hostClient || typeof hostClient.execContainer !== 'function'
        || typeof hostClient.putArchive !== 'function') {
        throw desiredError('Box edge desired staging requires the structured host client');
    }
    const desiredDirectory = '/workspace/.ploinky/data/edge-routing';
    const desiredTarget = `${desiredDirectory}/desired.json`;
    const stagedTarget = `${desiredTarget}.box-candidate`;
    const bytes = readAdmittedCandidateBytes(candidate);

    await directExec(hostClient, journal, containerId, [
        '/opt/ploinky/bin/ploinky-local', 'list', 'agents',
    ]);
    await directExec(hostClient, journal, containerId, [
        'mkdir', '-p', desiredDirectory,
    ], { user: 'root', workdir: '/' });
    await directExec(hostClient, journal, containerId, [
        'chown', 'podman:podman', desiredDirectory,
    ], { user: 'root', workdir: '/' });
    await directExec(hostClient, journal, containerId, [
        'chmod', '700', desiredDirectory,
    ], { user: 'root', workdir: '/' });
    await directExec(hostClient, journal, containerId, [
        'rm', '-f', stagedTarget,
    ], { user: 'root', workdir: '/' });

    try {
        await hostClient.putArchive({
            id: containerId,
            path: desiredDirectory,
            body: singleFileTar(path.posix.basename(stagedTarget), bytes),
            journal,
        });
        const stagedDigest = await directExec(hostClient, journal, containerId, [
            'sha256sum', stagedTarget,
        ], { user: 'root', workdir: '/' });
        if (exactDigest(stagedDigest) !== candidate.digest) {
            throw desiredError('Box edge desired state changed before in-box staging completed');
        }
        await directExec(hostClient, journal, containerId, [
            'mv', stagedTarget, desiredTarget,
        ], { user: 'root', workdir: '/' });
        await directExec(hostClient, journal, containerId, [
            'chown', 'podman:podman', desiredTarget,
        ], { user: 'root', workdir: '/' });
        await directExec(hostClient, journal, containerId, [
            'chmod', '600', desiredTarget,
        ], { user: 'root', workdir: '/' });
        const installedDigest = await directExec(hostClient, journal, containerId, [
            'sha256sum', desiredTarget,
        ]);
        if (exactDigest(installedDigest) !== candidate.digest) {
            throw desiredError('Installed Box edge desired state does not match its host authority');
        }
    } finally {
        try {
            await directExec(hostClient, journal, containerId, [
                'rm', '-f', stagedTarget,
            ], { user: 'root', workdir: '/' });
        } catch {}
    }

    return Object.freeze({
        staged: true,
        digest: candidate.digest,
    });
}
