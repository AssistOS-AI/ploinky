import fs from 'node:fs';
import path from 'node:path';

import { PLOINKY_DIR } from '../../utils/config.js';

const PODMAN_RUNTIME_OWNERSHIP_SCHEMA_VERSION = 1;
const MAX_RECORD_BYTES = 32 * 1024;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMMUTABLE_ID = /^[a-f0-9]{64}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RECORD_KEYS = Object.freeze([
    'agentName',
    'alias',
    'containerId',
    'containerName',
    'contractHash',
    'enableGeneration',
    'imageId',
    'instanceId',
    'manifestSha256',
    'networkContractHash',
    'ownerRef',
    'profile',
    'projectPath',
    'releaseGeneration',
    'repoName',
    'role',
    'runtime',
    'schemaVersion',
]);

export const PODMAN_RUNTIME_OWNERSHIP_DIR = path.join(
    PLOINKY_DIR,
    'run',
    'podman-runtime-owners',
);

function ownershipError(message, code = 'PLOINKY_RUNTIME_OWNERSHIP_INVALID', cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = code;
    return error;
}

function currentUid() {
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    if (!Number.isSafeInteger(uid) || uid < 0) {
        throw ownershipError(
            'Podman runtime ownership requires an exact filesystem uid',
            'PLOINKY_RUNTIME_OWNERSHIP_STORE_INVALID',
        );
    }
    return uid;
}

function exactText(value, label, { pattern, maximumBytes = 4096, allowEmpty = false } = {}) {
    if (typeof value !== 'string'
        || (!allowEmpty && value.length === 0)
        || value !== value.trim()
        || Buffer.byteLength(value, 'utf8') > maximumBytes
        || /[\u0000-\u001f\u007f]/.test(value)
        || (pattern && !pattern.test(value))) {
        throw ownershipError(`Podman runtime ownership ${label} is invalid`);
    }
    return value;
}

function exactContainerName(value) {
    const name = exactText(value, 'containerName', {
        pattern: CONTAINER_NAME,
        maximumBytes: 128,
    });
    if (name === '.' || name === '..') {
        throw ownershipError('Podman runtime ownership containerName is invalid');
    }
    return name;
}

function exactContainerId(value, label = 'containerId', { allowEmpty = false } = {}) {
    if (allowEmpty && value === '') return '';
    return exactText(value, label, { pattern: IMMUTABLE_ID, maximumBytes: 64 });
}

function exactHash(value, label) {
    return exactText(value, label, { pattern: SHA256, maximumBytes: 71 });
}

function exactReleaseGeneration(value) {
    if (value === '') return '';
    return exactContainerId(value, 'releaseGeneration');
}

function exactProjectPath(value) {
    const projectPath = exactText(value, 'projectPath');
    if (!path.isAbsolute(projectPath) || path.normalize(projectPath) !== projectPath
        || projectPath === path.parse(projectPath).root) {
        throw ownershipError('Podman runtime ownership projectPath is not one canonical workspace path');
    }
    return projectPath;
}

function exactRecordKeys(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw ownershipError('Podman runtime ownership record must be one plain object');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw ownershipError('Podman runtime ownership record must be one plain object');
    }
    const actual = Object.keys(value).sort();
    const expected = [...RECORD_KEYS].sort();
    if (actual.length !== expected.length
        || actual.some((key, index) => key !== expected[index])) {
        throw ownershipError('Podman runtime ownership record has an invalid schema');
    }
    return value;
}

function canonicalRecord(input) {
    const containerName = exactContainerName(input?.containerName);
    const agentName = exactText(input?.agentName, 'agentName', { maximumBytes: 255 });
    const repoName = exactText(input?.repoName, 'repoName', { maximumBytes: 255 });
    const ownerRef = `${repoName}/${agentName}`;
    const record = {
        schemaVersion: PODMAN_RUNTIME_OWNERSHIP_SCHEMA_VERSION,
        role: 'podman-runtime',
        runtime: 'podman',
        containerName,
        containerId: exactContainerId(input?.containerId),
        ownerRef,
        repoName,
        agentName,
        alias: exactText(input?.alias || agentName, 'alias', { maximumBytes: 255 }),
        instanceId: exactText(input?.instanceId, 'instanceId', { maximumBytes: 512 }),
        enableGeneration: exactText(input?.enableGeneration, 'enableGeneration', { maximumBytes: 512 }),
        releaseGeneration: exactReleaseGeneration(String(input?.releaseGeneration || '')),
        projectPath: exactProjectPath(input?.projectPath),
        profile: exactText(input?.profile, 'profile', { maximumBytes: 255 }),
        imageId: exactContainerId(input?.imageId, 'imageId'),
        manifestSha256: exactHash(input?.manifestSha256, 'manifestSha256'),
        contractHash: exactHash(input?.contractHash, 'contractHash'),
        networkContractHash: exactHash(input?.networkContractHash, 'networkContractHash'),
    };
    if (input?.runtime !== undefined && input.runtime !== 'podman') {
        throw ownershipError('Podman runtime ownership runtime must be exactly podman');
    }
    if (input?.ownerRef !== undefined && input.ownerRef !== ownerRef) {
        throw ownershipError('Podman runtime ownership ownerRef does not match its exact agent path');
    }
    if (input?.schemaVersion !== undefined
        && input.schemaVersion !== PODMAN_RUNTIME_OWNERSHIP_SCHEMA_VERSION) {
        throw ownershipError('Podman runtime ownership schemaVersion is invalid');
    }
    if (input?.role !== undefined && input.role !== 'podman-runtime') {
        throw ownershipError('Podman runtime ownership role is invalid');
    }
    return Object.freeze(record);
}

function validateStoredRecord(value, expectedContainerName) {
    exactRecordKeys(value);
    const canonical = canonicalRecord(value);
    if (canonical.containerName !== expectedContainerName
        || RECORD_KEYS.some((key) => canonical[key] !== value[key])) {
        throw ownershipError(
            'Podman runtime ownership record is not canonical',
            'PLOINKY_RUNTIME_OWNERSHIP_STORE_INVALID',
        );
    }
    return canonical;
}

function assertPrivateDirectory(directory, { create = false, protectMode = true } = {}) {
    if (create) {
        try {
            fs.mkdirSync(directory, { mode: 0o700 });
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }
    }
    let stat;
    try {
        stat = fs.lstatSync(directory);
    } catch (error) {
        if (!create && error?.code === 'ENOENT') return false;
        throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== currentUid()) {
        throw ownershipError(
            'Podman runtime ownership directory is not a private owned directory',
            'PLOINKY_RUNTIME_OWNERSHIP_STORE_INVALID',
        );
    }
    if (protectMode && (stat.mode & 0o777) !== 0o700) {
        if (!create) {
            throw ownershipError(
                'Podman runtime ownership directory permissions are invalid',
                'PLOINKY_RUNTIME_OWNERSHIP_STORE_INVALID',
            );
        }
        fs.chmodSync(directory, 0o700);
    }
    return true;
}

function managedDirectoryChain() {
    const root = path.resolve(PLOINKY_DIR);
    const target = path.resolve(PODMAN_RUNTIME_OWNERSHIP_DIR);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw ownershipError(
            'Podman runtime ownership directory escaped workspace state',
            'PLOINKY_RUNTIME_OWNERSHIP_STORE_INVALID',
        );
    }
    const chain = [root];
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        chain.push(current);
    }
    return chain;
}

function ensureStore() {
    for (const [index, directory] of managedDirectoryChain().entries()) {
        assertPrivateDirectory(directory, { create: true, protectMode: index !== 0 });
    }
}

function assertStoreReadOnly() {
    for (const [index, directory] of managedDirectoryChain().entries()) {
        if (!assertPrivateDirectory(directory, { protectMode: index !== 0 })) return false;
    }
    return true;
}

function fsyncDirectory(directory) {
    let descriptor;
    try {
        descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        fs.fsyncSync(descriptor);
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
}

export function podmanRuntimeOwnershipFile(containerName) {
    return path.join(PODMAN_RUNTIME_OWNERSHIP_DIR, `${exactContainerName(containerName)}.owner.json`);
}

function readPinnedRecord(file, containerName) {
    let descriptor;
    try {
        descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw ownershipError(
            'Podman runtime ownership record could not be opened safely',
            'PLOINKY_RUNTIME_OWNERSHIP_STORE_INVALID',
            error,
        );
    }
    try {
        const before = fs.fstatSync(descriptor);
        if (!before.isFile() || before.uid !== currentUid() || before.nlink !== 1
            || (before.mode & 0o777) !== 0o600 || before.size <= 0
            || before.size > MAX_RECORD_BYTES) {
            throw ownershipError(
                'Podman runtime ownership record metadata is invalid',
                'PLOINKY_RUNTIME_OWNERSHIP_STORE_INVALID',
            );
        }
        const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
            || after.mtimeMs !== before.mtimeMs) {
            throw ownershipError(
                'Podman runtime ownership record changed while it was read',
                'PLOINKY_RUNTIME_OWNERSHIP_STORE_INVALID',
            );
        }
        let parsed;
        try {
            parsed = JSON.parse(bytes.toString('utf8'));
        } catch (error) {
            throw ownershipError(
                'Podman runtime ownership record is not valid JSON',
                'PLOINKY_RUNTIME_OWNERSHIP_STORE_INVALID',
                error,
            );
        }
        return validateStoredRecord(parsed, containerName);
    } finally {
        fs.closeSync(descriptor);
    }
}

export function readPodmanRuntimeOwnership(containerName) {
    const exactName = exactContainerName(containerName);
    if (!assertStoreReadOnly()) return null;
    return readPinnedRecord(podmanRuntimeOwnershipFile(exactName), exactName);
}

function matchingRegistryText(record, owner, field, { fallback = '' } = {}) {
    const expected = String(record?.[field] ?? fallback);
    if (expected !== String(owner[field])) {
        throw ownershipError(
            `Podman runtime ownership ${field} does not match its selected registry owner`,
            'PLOINKY_RUNTIME_OWNERSHIP_CONFLICT',
        );
    }
}

/**
 * Resolve the exact physical identity for one selected Podman runtime.
 *
 * Prepared edge-generation records intentionally exist before Podman returns
 * an immutable ID.  Once launch publishes the physical ownership journal,
 * status and lifecycle operations may enrich that same selected record only
 * when every owner/path/generation field still matches.  A missing journal is
 * acceptable only for an already-complete registry record; disagreement is
 * never treated as adoption authority.
 */
export function resolvePodmanRuntimeOwnership(containerName, record, {
    readOwnership = readPodmanRuntimeOwnership,
} = {}) {
    const exactName = exactContainerName(containerName);
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || record.type !== 'agent' || record.runtime !== 'podman') {
        throw ownershipError(
            `Podman runtime ownership for '${exactName}' requires one selected agent record`,
        );
    }
    const recordedId = String(record.containerId || '');
    const owner = readOwnership(exactName);
    if (!owner) {
        if (!IMMUTABLE_ID.test(recordedId)) {
            throw ownershipError(
                `Podman runtime ownership for '${exactName}' is incomplete`,
            );
        }
        return Object.freeze({ ...record, containerId: recordedId });
    }
    if (owner.containerName !== exactName || owner.runtime !== 'podman') {
        throw ownershipError(
            `Podman runtime ownership for '${exactName}' changed before selection`,
            'PLOINKY_RUNTIME_OWNERSHIP_CONFLICT',
        );
    }
    matchingRegistryText(record, owner, 'repoName');
    matchingRegistryText(record, owner, 'agentName');
    matchingRegistryText(record, owner, 'alias', {
        fallback: record.agentName,
    });
    matchingRegistryText(record, owner, 'instanceId');
    matchingRegistryText(record, owner, 'enableGeneration');
    matchingRegistryText(record, owner, 'releaseGeneration', { fallback: '' });
    matchingRegistryText(record, owner, 'projectPath');
    matchingRegistryText(record, owner, 'profile');
    if (recordedId && (!IMMUTABLE_ID.test(recordedId) || recordedId !== owner.containerId)) {
        throw ownershipError(
            `Podman runtime ownership for '${exactName}' conflicts with its immutable registry ID`,
            'PLOINKY_RUNTIME_OWNERSHIP_CONFLICT',
        );
    }
    return Object.freeze({ ...record, containerId: owner.containerId });
}

function sameRecord(left, right) {
    return Boolean(left && right) && RECORD_KEYS.every((key) => left[key] === right[key]);
}

function acquireClaim(target) {
    const claim = `${target}.claim`;
    let descriptor;
    try {
        descriptor = fs.openSync(
            claim,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
            0o600,
        );
        fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
    } catch (error) {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        throw ownershipError(
            'Podman runtime ownership compare-and-swap is already in progress',
            error?.code === 'EEXIST'
                ? 'PLOINKY_RUNTIME_OWNERSHIP_CONFLICT'
                : 'PLOINKY_RUNTIME_OWNERSHIP_STORE_INVALID',
            error,
        );
    }
    return claim;
}

function withClaim(target, callback) {
    const claim = acquireClaim(target);
    let callbackError = null;
    try {
        return callback();
    } catch (error) {
        callbackError = error;
        throw error;
    } finally {
        try {
            fs.unlinkSync(claim);
            fsyncDirectory(PODMAN_RUNTIME_OWNERSHIP_DIR);
        } catch (error) {
            if (!callbackError) {
                throw ownershipError(
                    'Podman runtime ownership compare-and-swap claim could not be released',
                    'PLOINKY_RUNTIME_OWNERSHIP_STORE_INVALID',
                    error,
                );
            }
        }
    }
}

export function publishPodmanRuntimeOwnership(input, { expectedContainerId = '' } = {}) {
    const record = canonicalRecord(input);
    const expectedId = exactContainerId(
        expectedContainerId,
        'expectedContainerId',
        { allowEmpty: true },
    );
    ensureStore();
    const target = podmanRuntimeOwnershipFile(record.containerName);
    return withClaim(target, () => {
        const current = readPinnedRecord(target, record.containerName);
        if (sameRecord(current, record)) return current;
        const sameOwner = !current || (
            current.ownerRef === record.ownerRef
            && current.alias === record.alias
            && current.instanceId === record.instanceId
        );
        // Exact predecessor cleanup may already have removed its journal. An
        // absent target is still a valid CAS state while this per-name claim is
        // held; only an existing record must match the captured predecessor ID.
        if (!sameOwner || (current && current.containerId !== expectedId)) {
            throw ownershipError(
                `Podman runtime ownership for '${record.containerName}' changed before publication`,
                'PLOINKY_RUNTIME_OWNERSHIP_CONFLICT',
            );
        }

        const temporary = `${target}.${process.pid}.tmp`;
        let descriptor;
        try {
            descriptor = fs.openSync(
                temporary,
                fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
                0o600,
            );
            fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = undefined;
            fs.renameSync(temporary, target);
            fsyncDirectory(PODMAN_RUNTIME_OWNERSHIP_DIR);
        } catch (error) {
            if (descriptor !== undefined) fs.closeSync(descriptor);
            try { fs.unlinkSync(temporary); } catch (_) {}
            throw ownershipError(
                'Podman runtime ownership could not be published atomically',
                'PLOINKY_RUNTIME_OWNERSHIP_STORE_INVALID',
                error,
            );
        }
        return readPinnedRecord(target, record.containerName);
    });
}

export function removePodmanRuntimeOwnership(containerName, containerId) {
    const exactName = exactContainerName(containerName);
    const exactId = exactContainerId(containerId);
    if (!assertStoreReadOnly()) return false;
    const target = podmanRuntimeOwnershipFile(exactName);
    return withClaim(target, () => {
        const current = readPinnedRecord(target, exactName);
        if (!current || current.containerId !== exactId) return false;
        try {
            fs.unlinkSync(target);
            fsyncDirectory(PODMAN_RUNTIME_OWNERSHIP_DIR);
        } catch (error) {
            throw ownershipError(
                'Podman runtime ownership could not be removed atomically',
                'PLOINKY_RUNTIME_OWNERSHIP_STORE_INVALID',
                error,
            );
        }
        return true;
    });
}
