import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { RUNNING_DIR as CONFIGURED_RUNNING_DIR } from '../config.js';
import { inspectProcessIdentity, normalizeProcessIdentity } from '../../sandbox/processIdentity.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 100;
const CONCURRENT_ARTIFACT_RECOVERY_STABILITY_MS = 100;
const MAX_WORKSPACE_MUTATION_WAIT_MS = 15 * 60 * 1000;
const MAX_WORKSPACE_MUTATION_RETRY_INTERVAL_MS = 1_000;
// Locks are security-sensitive authority, unlike the other status and PID
// files under RUNNING_DIR. Keep both lock classes in new private stores so the
// clean-break implementation never accepts the legacy shared-directory ABI.
const CONFIGURED_PLOINKY_DIR = path.dirname(CONFIGURED_RUNNING_DIR);
const CONFIGURED_WORKSPACE_ROOT = path.dirname(CONFIGURED_PLOINKY_DIR);
// The configured root may arrive through an OS path alias (for example
// `/var` versus `/private/var` on macOS). Bind persistent lineage and every
// lock pathname to the one physical workspace-root spelling so independent
// processes derive byte-identical clean-break authority paths.
const WORKSPACE_ROOT = fs.realpathSync.native(CONFIGURED_WORKSPACE_ROOT);
const PLOINKY_DIR = path.join(WORKSPACE_ROOT, path.basename(CONFIGURED_PLOINKY_DIR));
const RUNNING_DIR = path.join(PLOINKY_DIR, path.basename(CONFIGURED_RUNNING_DIR));
const LOCKS_DIR = path.join(RUNNING_DIR, 'locks');
const MAINTENANCE_DIR = path.join(LOCKS_DIR, 'maintenance');
const WORKSPACE_START_LOCK_PATH = path.join(LOCKS_DIR, 'workspace-start.json');
const LEGACY_MAINTENANCE_DIR = path.join(RUNNING_DIR, 'maintenance');
const LEGACY_WORKSPACE_START_LOCK_PATH = path.join(RUNNING_DIR, 'workspace-start.json');
const WORKSPACE_START_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_SCHEMA_VERSION = 1;
const STORE_LINEAGE_SCHEMA_VERSION = 1;
const MAX_LOCK_BYTES = 16 * 1024;
const MAX_METADATA_BYTES = 4 * 1024;
const MAX_STORE_LINEAGE_BYTES = 4 * 1024;
const MAX_PID = 0x7fffffff;
const LOCK_KINDS = Object.freeze({
    maintenance: 'maintenance',
    workspaceMutation: 'workspace-mutation',
});
const LOCK_RECORD_KEYS = Object.freeze([
    'containerName',
    'expiresAt',
    'kind',
    'metadata',
    'operation',
    'ownerPid',
    'ownerStartIdentity',
    'ownerUid',
    'schemaVersion',
    'startedAt',
    'token',
].sort());
const TOKEN_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function lockError(kind, message, code = null) {
    const error = new Error(message);
    error.code = code || (kind === LOCK_KINDS.maintenance
        ? 'PLOINKY_MAINTENANCE_LOCK_INVALID'
        : 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID');
    return error;
}

function currentUid(getUid = () => process.getuid?.()) {
    const uid = getUid();
    if (!Number.isSafeInteger(uid) || uid < 0) {
        throw lockError(LOCK_KINDS.workspaceMutation, 'maintenance locks require an exact current UID');
    }
    return uid;
}

function lockDependencies(overrides = {}) {
    return Object.freeze({
        fs: overrides.fs || fs,
        inspectProcessIdentity: overrides.inspectProcessIdentity || inspectProcessIdentity,
        randomUUID: overrides.randomUUID || randomUUID,
        now: overrides.now || Date.now,
        getUid: overrides.getUid || (() => process.getuid?.()),
        beforePublish: overrides.beforePublish,
        afterPrimaryRelease: overrides.afterPrimaryRelease,
        afterRenewalClaim: overrides.afterRenewalClaim,
        afterRenewalReplace: overrides.afterRenewalReplace,
        beforeExactReleaseAdmission: overrides.beforeExactReleaseAdmission,
        beforePublicationAdmission: overrides.beforePublicationAdmission,
        afterAcquisitionAdmission: overrides.afterAcquisitionAdmission,
    });
}

function normalizeContainerName(value, { allowEmpty = false } = {}) {
    if (allowEmpty && value === '') return '';
    if (typeof value !== 'string' || value.length < 1 || value.length > 200
        || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
        throw lockError(LOCK_KINDS.maintenance, 'maintenance lock requires an exact safe container name');
    }
    return value;
}

function normalizeOperation(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 256
        || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(value)) {
        throw lockError(LOCK_KINDS.workspaceMutation, 'lock operation is not exact bounded text');
    }
    return value;
}

function canonicalJson(value, depth = 0) {
    if (depth > 8) throw new TypeError('metadata nesting is too deep');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map((entry) => canonicalJson(entry, depth + 1));
    if (!value || typeof value !== 'object'
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        throw new TypeError('metadata must contain only JSON values');
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
        if (!key || key.length > 256 || key.includes('\0')) throw new TypeError('metadata key is invalid');
        result[key] = canonicalJson(value[key], depth + 1);
    }
    return result;
}

function normalizeMetadata(value, kind) {
    let metadata;
    try {
        metadata = canonicalJson(value ?? {});
    } catch (cause) {
        throw lockError(kind, `lock metadata is invalid: ${cause?.message || cause}`);
    }
    if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object'
        || Buffer.byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES) {
        throw lockError(kind, 'lock metadata is not an exact bounded object');
    }
    return metadata;
}

function normalizeTimestamp(value, kind) {
    if (typeof value !== 'string') throw lockError(kind, 'lock timestamp is invalid');
    let canonical;
    try { canonical = new Date(value).toISOString(); } catch (_) { canonical = ''; }
    if (canonical !== value) throw lockError(kind, 'lock timestamp is not canonical');
    return value;
}

function lockPathFor(containerName) {
    return path.join(MAINTENANCE_DIR, `${normalizeContainerName(containerName)}.json`);
}

function assertNoLegacyAuthority(expected, dependencies) {
    const legacyPath = expected.kind === LOCK_KINDS.maintenance
        ? path.join(LEGACY_MAINTENANCE_DIR, `${expected.containerName}.json`)
        : LEGACY_WORKSPACE_START_LOCK_PATH;
    try {
        // Exact-path presence is sufficient to deny mixed-generation state.
        // Never follow, parse, tolerate, or migrate the legacy authority.
        dependencies.fs.lstatSync(legacyPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    throw lockError(expected.kind, 'legacy lock authority exists outside the private lock store');
}

function canonicalLockRecord(value) {
    return {
        schemaVersion: value.schemaVersion,
        kind: value.kind,
        containerName: value.containerName,
        operation: value.operation,
        metadata: value.metadata,
        ownerPid: value.ownerPid,
        ownerUid: value.ownerUid,
        ownerStartIdentity: value.ownerStartIdentity,
        token: value.token,
        startedAt: value.startedAt,
        expiresAt: value.expiresAt,
    };
}

function serializeLockRecord(record) {
    return `${JSON.stringify(canonicalLockRecord(record))}\n`;
}

function validateLockRecord(parsed, { kind, containerName = '' }, expectedUid) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(LOCK_RECORD_KEYS)
        || parsed.schemaVersion !== LOCK_SCHEMA_VERSION || parsed.kind !== kind) {
        throw lockError(kind, `lock record is invalid or pre-v${LOCK_SCHEMA_VERSION}`);
    }
    const exactContainerName = kind === LOCK_KINDS.maintenance
        ? normalizeContainerName(parsed.containerName)
        : normalizeContainerName(parsed.containerName, { allowEmpty: true });
    if (exactContainerName !== containerName
        || (kind === LOCK_KINDS.workspaceMutation && exactContainerName !== '')) {
        throw lockError(kind, 'lock record does not match its canonical authority path');
    }
    const operation = normalizeOperation(parsed.operation);
    const metadata = normalizeMetadata(parsed.metadata, kind);
    const ownerPid = Number(parsed.ownerPid);
    const ownerUid = Number(parsed.ownerUid);
    let ownerStartIdentity;
    try { ownerStartIdentity = normalizeProcessIdentity(parsed.ownerStartIdentity); } catch (cause) {
        throw lockError(kind, `lock owner process identity is invalid: ${cause?.message || cause}`);
    }
    if (typeof parsed.ownerPid !== 'number' || !Number.isSafeInteger(ownerPid)
        || ownerPid <= 0 || ownerPid > MAX_PID
        || typeof parsed.ownerUid !== 'number' || !Number.isSafeInteger(ownerUid)
        || ownerUid < 0 || ownerUid !== expectedUid
        || typeof parsed.token !== 'string' || !TOKEN_PATTERN.test(parsed.token)) {
        throw lockError(kind, 'lock owner or token is invalid');
    }
    return Object.freeze(canonicalLockRecord({
        schemaVersion: LOCK_SCHEMA_VERSION,
        kind,
        containerName: exactContainerName,
        operation,
        metadata,
        ownerPid,
        ownerUid,
        ownerStartIdentity,
        token: parsed.token,
        startedAt: normalizeTimestamp(parsed.startedAt, kind),
        expiresAt: normalizeTimestamp(parsed.expiresAt, kind),
    }));
}

function storeTopology(directory) {
    if (directory === LOCKS_DIR) return [WORKSPACE_ROOT, PLOINKY_DIR, RUNNING_DIR, LOCKS_DIR];
    if (directory === MAINTENANCE_DIR) {
        return [WORKSPACE_ROOT, PLOINKY_DIR, RUNNING_DIR, LOCKS_DIR, MAINTENANCE_DIR];
    }
    throw lockError(LOCK_KINDS.workspaceMutation, 'lock store path is outside the exact private topology');
}

function privateStoreComponent(directory) {
    return directory === LOCKS_DIR || directory === MAINTENANCE_DIR;
}

function storeAuthorities(directory) {
    if (directory === LOCKS_DIR) return [LOCKS_DIR];
    if (directory === MAINTENANCE_DIR) return [LOCKS_DIR, MAINTENANCE_DIR];
    throw lockError(LOCK_KINDS.workspaceMutation, 'lock store path is outside the exact private topology');
}

function assertExactStoreDirectory(directory, dependencies, { missing = false } = {}) {
    let stat;
    try { stat = dependencies.fs.lstatSync(directory); } catch (error) {
        if (error?.code === 'ENOENT' && missing) return null;
        throw error;
    }
    const uid = currentUid(dependencies.getUid);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid
        || (privateStoreComponent(directory) && (stat.mode & 0o777) !== 0o700)) {
        throw lockError(LOCK_KINDS.workspaceMutation, 'lock store directory type or ownership is invalid');
    }
    return stat;
}

function storeLineagePath(directory) {
    const lineageId = createHash('sha256').update(directory).digest('hex').slice(0, 32);
    return path.join(WORKSPACE_ROOT, `.ploinky-lock-store-lineage-${lineageId}.json`);
}

function canonicalStoreLineage(directory, pins) {
    return Object.freeze({
        storePath: directory,
        components: Object.freeze(pins.map((pin) => Object.freeze({
            path: pin.directory,
            dev: String(pin.dev),
            ino: String(pin.ino),
        }))),
        schemaVersion: STORE_LINEAGE_SCHEMA_VERSION,
    });
}

function serializeStoreLineage(lineage) {
    return `${JSON.stringify({
        storePath: lineage.storePath,
        components: lineage.components.map((component) => ({
            path: component.path,
            dev: component.dev,
            ino: component.ino,
        })),
        schemaVersion: lineage.schemaVersion,
    })}\n`;
}

function validateStoreLineage(parsed, directory) {
    const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.keys(parsed).sort()
        : [];
    const exactKeys = ['components', 'schemaVersion', 'storePath'];
    const topology = storeTopology(directory);
    if (JSON.stringify(keys) !== JSON.stringify(exactKeys)
        || parsed.schemaVersion !== STORE_LINEAGE_SCHEMA_VERSION
        || parsed.storePath !== directory
        || !Array.isArray(parsed.components)
        || parsed.components.length !== topology.length) {
        throw lockError(LOCK_KINDS.workspaceMutation, 'lock store durable lineage is invalid');
    }
    const components = parsed.components.map((component, index) => {
        const componentKeys = component && typeof component === 'object' && !Array.isArray(component)
            ? Object.keys(component).sort()
            : [];
        if (JSON.stringify(componentKeys) !== JSON.stringify(['dev', 'ino', 'path'])
            || component.path !== topology[index]
            || !/^(?:0|[1-9][0-9]{0,31})$/.test(component.dev)
            || !/^(?:0|[1-9][0-9]{0,31})$/.test(component.ino)) {
            throw lockError(LOCK_KINDS.workspaceMutation, 'lock store durable lineage is invalid');
        }
        return Object.freeze({ path: component.path, dev: component.dev, ino: component.ino });
    });
    return Object.freeze({
        storePath: directory,
        components: Object.freeze(components),
        schemaVersion: STORE_LINEAGE_SCHEMA_VERSION,
    });
}

function readStoreLineage(directory, dependencies) {
    const lineagePath = storeLineagePath(directory);
    const noFollowFlag = dependencies.fs.constants?.O_NOFOLLOW;
    if (!Number.isInteger(noFollowFlag) || noFollowFlag === 0) {
        throw lockError(
            LOCK_KINDS.workspaceMutation,
            'O_NOFOLLOW is required for lock store lineage reads',
        );
    }
    let descriptor;
    try {
        descriptor = dependencies.fs.openSync(
            lineagePath,
            dependencies.fs.constants.O_RDONLY | noFollowFlag,
        );
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error?.code === 'ELOOP') {
            throw lockError(LOCK_KINDS.workspaceMutation, 'lock store durable lineage is a symlink');
        }
        throw error;
    }
    let raw;
    try {
        const stat = dependencies.fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid(dependencies.getUid)
            || (stat.mode & 0o777) !== 0o600 || stat.size <= 0
            || stat.size > MAX_STORE_LINEAGE_BYTES) {
            throw lockError(LOCK_KINDS.workspaceMutation, 'lock store durable lineage file is unsafe');
        }
        raw = dependencies.fs.readFileSync(descriptor, 'utf8');
    } finally {
        dependencies.fs.closeSync(descriptor);
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) {
        throw lockError(LOCK_KINDS.workspaceMutation, 'lock store durable lineage is malformed');
    }
    const lineage = validateStoreLineage(parsed, directory);
    if (serializeStoreLineage(lineage) !== raw) {
        throw lockError(LOCK_KINDS.workspaceMutation, 'lock store durable lineage is not canonical');
    }
    return lineage;
}

function writeStoreLineage(directory, lineage, workspacePin, dependencies) {
    const lineagePath = storeLineagePath(directory);
    const noFollowFlag = dependencies.fs.constants?.O_NOFOLLOW;
    if (!Number.isInteger(noFollowFlag) || noFollowFlag === 0) {
        throw lockError(
            LOCK_KINDS.workspaceMutation,
            'O_NOFOLLOW is required for lock store lineage creation',
        );
    }
    const payload = Buffer.from(serializeStoreLineage(lineage), 'utf8');
    let descriptor;
    try {
        descriptor = dependencies.fs.openSync(
            lineagePath,
            dependencies.fs.constants.O_WRONLY
                | dependencies.fs.constants.O_CREAT
                | dependencies.fs.constants.O_EXCL
                | noFollowFlag,
            0o600,
        );
        let offset = 0;
        while (offset < payload.length) {
            const written = dependencies.fs.writeSync(
                descriptor,
                payload,
                offset,
                payload.length - offset,
                null,
            );
            if (!Number.isSafeInteger(written) || written <= 0 || written > payload.length - offset) {
                throw lockError(LOCK_KINDS.workspaceMutation, 'lock store lineage write was incomplete');
            }
            offset += written;
        }
        dependencies.fs.fsyncSync(descriptor);
        const stat = dependencies.fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid(dependencies.getUid)
            || (stat.mode & 0o777) !== 0o600 || stat.size !== payload.length) {
            throw lockError(LOCK_KINDS.workspaceMutation, 'lock store lineage write was unsafe');
        }
    } finally {
        if (descriptor !== undefined) dependencies.fs.closeSync(descriptor);
    }
    fsyncPinnedStoreDirectory([workspacePin], dependencies);
}

function assertPinnedStoreDirectory(pin, dependencies, message) {
    const descriptorStat = dependencies.fs.fstatSync(pin.descriptor);
    const pathStat = dependencies.fs.lstatSync(pin.directory);
    const uid = currentUid(dependencies.getUid);
    if (!descriptorStat.isDirectory() || descriptorStat.uid !== uid
        || (pin.privateStore && (descriptorStat.mode & 0o777) !== 0o700)
        || !pathStat.isDirectory() || pathStat.isSymbolicLink()
        || pathStat.uid !== uid
        || (pin.privateStore && (pathStat.mode & 0o777) !== 0o700)
        || descriptorStat.dev !== pin.dev || descriptorStat.ino !== pin.ino
        || descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
        throw lockError(LOCK_KINDS.workspaceMutation, message);
    }
}

function openPinnedStoreDirectory(directory, dependencies) {
    assertExactStoreDirectory(directory, dependencies);
    const directoryFlag = dependencies.fs.constants?.O_DIRECTORY;
    const noFollowFlag = dependencies.fs.constants?.O_NOFOLLOW;
    if (!Number.isInteger(directoryFlag) || directoryFlag === 0
        || !Number.isInteger(noFollowFlag) || noFollowFlag === 0) {
        throw lockError(
            LOCK_KINDS.workspaceMutation,
            'O_DIRECTORY and O_NOFOLLOW are required for durable lock-store transitions',
        );
    }
    const descriptor = dependencies.fs.openSync(
        directory,
        dependencies.fs.constants.O_RDONLY | directoryFlag | noFollowFlag,
    );
    try {
        const descriptorStat = dependencies.fs.fstatSync(descriptor);
        const pin = {
            descriptor,
            directory,
            dev: descriptorStat.dev,
            ino: descriptorStat.ino,
            privateStore: privateStoreComponent(directory),
        };
        assertPinnedStoreDirectory(
            pin,
            dependencies,
            'lock store topology changed while opening an exact component',
        );
        return pin;
    } catch (error) {
        dependencies.fs.closeSync(descriptor);
        throw error;
    }
}

function ensureStoreLineage(directory, pins, dependencies, { terminalCreated }) {
    const expected = canonicalStoreLineage(directory, pins);
    let lineage = readStoreLineage(directory, dependencies);
    if (!lineage) {
        if (!terminalCreated) {
            throw lockError(
                LOCK_KINDS.workspaceMutation,
                'existing lock store has no durable workspace-root-bound lineage',
            );
        }
        try {
            writeStoreLineage(directory, expected, pins[0], dependencies);
            lineage = readStoreLineage(directory, dependencies);
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            lineage = readStoreLineage(directory, dependencies);
        }
    }
    if (!lineage || serializeStoreLineage(lineage) !== serializeStoreLineage(expected)) {
        throw lockError(
            LOCK_KINDS.workspaceMutation,
            'lock store does not match its durable workspace-root-bound lineage',
        );
    }
    for (const pin of pins) {
        assertPinnedStoreDirectory(
            pin,
            dependencies,
            'lock store topology changed while validating durable lineage',
        );
    }
}

function assertStoreLineagesAgainstPins(directory, pins, dependencies) {
    const topology = storeTopology(directory);
    if (pins.length !== topology.length
        || pins.some((pin, index) => pin.directory !== topology[index])) {
        throw lockError(LOCK_KINDS.workspaceMutation, 'lock store topology pins are incomplete');
    }
    for (const authority of storeAuthorities(directory)) {
        const authorityLength = storeTopology(authority).length;
        const lineage = readStoreLineage(authority, dependencies);
        const expected = canonicalStoreLineage(authority, pins.slice(0, authorityLength));
        if (!lineage || serializeStoreLineage(lineage) !== serializeStoreLineage(expected)) {
            throw lockError(
                LOCK_KINDS.workspaceMutation,
                'lock store does not match its durable workspace-root-bound lineage',
            );
        }
    }
    for (const pin of pins) {
        assertPinnedStoreDirectory(
            pin,
            dependencies,
            'lock store topology changed while validating durable lineage',
        );
    }
}

function createStoreTopology(directory, dependencies) {
    const pins = [];
    const createdComponents = new Set();
    try {
        for (const [index, component] of storeTopology(directory).entries()) {
            if (index > 0) {
                let created = false;
                try {
                    dependencies.fs.mkdirSync(component, {
                        mode: privateStoreComponent(component) ? 0o700 : 0o755,
                    });
                    created = true;
                } catch (error) {
                    if (error?.code !== 'EEXIST') throw error;
                }
                if (created) {
                    fsyncPinnedStoreDirectory(pins, dependencies);
                    createdComponents.add(component);
                }
            }
            pins.push(openPinnedStoreDirectory(component, dependencies));
        }
        for (const authority of storeAuthorities(directory)) {
            ensureStoreLineage(
                authority,
                pins.slice(0, storeTopology(authority).length),
                dependencies,
                { terminalCreated: createdComponents.has(authority) },
            );
        }
    } finally {
        closeStoreTopologyDescriptors(pins, dependencies);
    }
}

function assertStoreDirectory(directory, dependencies, { create = false } = {}) {
    if (create) {
        createStoreTopology(directory, dependencies);
        return true;
    }
    const topology = storeTopology(directory);
    const pins = [];
    try {
        pins.push(openPinnedStoreDirectory(topology[0], dependencies));
        for (const component of topology.slice(1)) {
            const stat = assertExactStoreDirectory(component, dependencies, { missing: true });
            if (!stat) {
                break;
            }
            pins.push(openPinnedStoreDirectory(component, dependencies));
        }
        for (const authority of storeAuthorities(directory)) {
            const authorityLength = storeTopology(authority).length;
            const lineage = readStoreLineage(authority, dependencies);
            if (pins.length < authorityLength) {
                if (lineage) {
                    throw lockError(
                        LOCK_KINDS.workspaceMutation,
                        'lock store does not match its durable workspace-root-bound lineage',
                    );
                }
                return false;
            }
            if (!lineage) {
                throw lockError(
                    LOCK_KINDS.workspaceMutation,
                    'existing lock store has no durable workspace-root-bound lineage',
                );
            }
            const expected = canonicalStoreLineage(authority, pins.slice(0, authorityLength));
            if (serializeStoreLineage(lineage) !== serializeStoreLineage(expected)) {
                throw lockError(
                    LOCK_KINDS.workspaceMutation,
                    'lock store does not match its durable workspace-root-bound lineage',
                );
            }
        }
        assertStoreLineagesAgainstPins(directory, pins, dependencies);
        return true;
    } finally {
        closeStoreTopologyDescriptors(pins, dependencies);
    }
}

function openStoreTopologyDescriptors(directory, dependencies) {
    const pins = [];
    try {
        for (const component of storeTopology(directory)) {
            const pin = openPinnedStoreDirectory(component, dependencies);
            pins.push(pin);
        }
        // The same descriptor set used by the mutation must prove the durable
        // workspace-root-bound lineage. A path-only preflight followed by a
        // reopen would leave an inter-pass directory replacement window.
        assertStoreLineagesAgainstPins(directory, pins, dependencies);
        return pins;
    } catch (error) {
        for (const pin of pins.reverse()) {
            try { dependencies.fs.closeSync(pin.descriptor); } catch (_) {}
        }
        throw error;
    }
}

function closeStoreTopologyDescriptors(pins, dependencies) {
    for (const pin of [...pins].reverse()) dependencies.fs.closeSync(pin.descriptor);
}

function fsyncPinnedStoreDirectory(pins, dependencies) {
    try {
        dependencies.fs.fsyncSync(pins.at(-1).descriptor);
        for (const pin of pins) {
            assertPinnedStoreDirectory(
                pin,
                dependencies,
                'lock store directory changed while syncing a durable transition',
            );
        }
    } catch (error) {
        throw error;
    }
}

function sameStoreDirectory(sourcePath, destinationPath, kind) {
    const sourceDirectory = path.dirname(sourcePath);
    if (sourceDirectory !== path.dirname(destinationPath)) {
        throw lockError(kind, 'lock transition paths must share one exact store directory');
    }
    return sourceDirectory;
}

function markAppliedDurabilityFailure(error) {
    if (error && typeof error === 'object') {
        error.lockTransitionApplied = true;
        error.lockDurabilityUncertain = true;
    }
    return error;
}

function transitionPathStat(filePath, dependencies) {
    try { return dependencies.fs.lstatSync(filePath); } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function sameTransitionInode(left, right) {
    return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino;
}

function exactPrivateTransitionFile(stat, dependencies) {
    return Boolean(stat) && stat.isFile() && !stat.isSymbolicLink()
        && stat.uid === currentUid(dependencies.getUid)
        && (stat.mode & 0o777) === 0o600;
}

function acceptAppliedMutation(pins, mutationError, dependencies) {
    try {
        fsyncPinnedStoreDirectory(pins, dependencies);
    } catch (durabilityError) {
        if (durabilityError && typeof durabilityError === 'object') {
            durabilityError.mutationError = mutationError;
        }
        throw markAppliedDurabilityFailure(durabilityError);
    }
}

function durableLinkSync(sourcePath, destinationPath, expected, dependencies) {
    const directory = sameStoreDirectory(sourcePath, destinationPath, expected.kind);
    const pins = openStoreTopologyDescriptors(directory, dependencies);
    try {
        const sourceBefore = transitionPathStat(sourcePath, dependencies);
        const destinationBefore = transitionPathStat(destinationPath, dependencies);
        try {
            dependencies.fs.linkSync(sourcePath, destinationPath);
        } catch (mutationError) {
            try {
                const sourceAfter = transitionPathStat(sourcePath, dependencies);
                const destinationAfter = transitionPathStat(destinationPath, dependencies);
                const exactSource = sourceAfter || sourceBefore;
                if (!destinationBefore && exactPrivateTransitionFile(exactSource, dependencies)
                    && exactPrivateTransitionFile(destinationAfter, dependencies)
                    && sameTransitionInode(exactSource, destinationAfter)) {
                    // A raw link(2) can install the destination and still report
                    // EIO. Accept it only after exact inode proof and store sync.
                    acceptAppliedMutation(pins, mutationError, dependencies);
                    return;
                }
            } catch (proofError) {
                proofError.mutationError = mutationError;
                throw markAppliedDurabilityFailure(proofError);
            }
            throw mutationError;
        }
        try { fsyncPinnedStoreDirectory(pins, dependencies); } catch (error) {
            throw markAppliedDurabilityFailure(error);
        }
    } finally {
        closeStoreTopologyDescriptors(pins, dependencies);
    }
}

function durableRenameSync(sourcePath, destinationPath, expected, dependencies) {
    sameStoreDirectory(sourcePath, destinationPath, expected.kind);
    // Node does not expose renameat2(RENAME_NOREPLACE), while plain POSIX
    // rename can silently overwrite a concurrently created quarantine owner.
    // Install the destination with hard-link no-clobber semantics first, then
    // retire the source. The surrounding content-addressed claim makes the
    // two-name interrupted state explicit and recoverable.
    try {
        durableLinkSync(sourcePath, destinationPath, expected, dependencies);
    } catch (error) {
        if (error?.code === 'EEXIST') {
            // Preserve the exact claim alongside the competing destination so
            // recovery can prove both owners; never clean it as an unapplied
            // transition and never overwrite the destination.
            error.lockTransitionApplied = true;
        }
        throw error;
    }
    try {
        durableUnlinkSync(sourcePath, expected, dependencies);
    } catch (error) {
        // Destination publication is already durable. Any source-retirement
        // failure is an interrupted no-clobber move and its two-name evidence
        // must remain for exact recovery.
        error.lockTransitionApplied = true;
        error.lockDurabilityUncertain = true;
        throw error;
    }
}

function durableUnlinkSync(filePath, expected, dependencies) {
    const directory = path.dirname(filePath);
    const pins = openStoreTopologyDescriptors(directory, dependencies);
    try {
        const before = transitionPathStat(filePath, dependencies);
        try {
            dependencies.fs.unlinkSync(filePath);
        } catch (mutationError) {
            try {
                const after = transitionPathStat(filePath, dependencies);
                if (exactPrivateTransitionFile(before, dependencies)
                    && (!after || !sameTransitionInode(before, after))) {
                    // Accept an applied unlink only after the exact old inode is
                    // absent from this name and the pinned private store syncs.
                    acceptAppliedMutation(pins, mutationError, dependencies);
                    return;
                }
            } catch (proofError) {
                proofError.mutationError = mutationError;
                throw markAppliedDurabilityFailure(proofError);
            }
            throw mutationError;
        }
        try { fsyncPinnedStoreDirectory(pins, dependencies); } catch (error) {
            throw markAppliedDurabilityFailure(error);
        }
    } finally {
        closeStoreTopologyDescriptors(pins, dependencies);
    }
}

function readLockSnapshotAt(filePath, expected, dependencies, {
    minimumLinks = 1,
    maximumLinks = 1,
} = {}) {
    const noFollow = dependencies.fs.constants?.O_NOFOLLOW;
    if (!Number.isInteger(noFollow) || noFollow === 0) {
        throw lockError(expected.kind, 'O_NOFOLLOW is required for lock record reads');
    }
    let descriptor;
    try {
        descriptor = dependencies.fs.openSync(filePath, dependencies.fs.constants.O_RDONLY | noFollow);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error?.code === 'ELOOP') throw lockError(expected.kind, 'lock record must not be a symlink');
        throw error;
    }
    let stat;
    let raw;
    try {
        stat = dependencies.fs.fstatSync(descriptor);
        const uid = currentUid(dependencies.getUid);
        const exactPrivateFile = stat.isFile()
            && stat.uid === uid
            && (stat.mode & 0o777) === 0o600
            && stat.size > 0
            && stat.size <= MAX_LOCK_BYTES;
        if (!exactPrivateFile || stat.nlink < minimumLinks || stat.nlink > maximumLinks) {
            const error = lockError(expected.kind, 'lock record is not an exact private bounded file');
            // A publisher validates a winning claim while the winner retires
            // that private name. open(2) can pin the exact inode before the
            // unlink while fstat(2) observes its settled one-link shape. Mark
            // only that otherwise-exact transition so the collision path can
            // re-prove the canonical authority; malformed files, extra links,
            // and unrelated inodes remain hard failures.
            if (exactPrivateFile && minimumLinks === 2 && maximumLinks === 2 && stat.nlink === 1) {
                error.lockSnapshotSettledLink = Object.freeze({
                    dev: stat.dev,
                    ino: stat.ino,
                });
            }
            throw error;
        }
        raw = dependencies.fs.readFileSync(descriptor, 'utf8');
    } finally {
        dependencies.fs.closeSync(descriptor);
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (cause) {
        throw lockError(expected.kind, `lock record is malformed: ${cause?.message || cause}`);
    }
    const record = validateLockRecord(parsed, expected, stat.uid);
    if (serializeLockRecord(record) !== raw) {
        throw lockError(expected.kind, 'lock record is not exact canonical JSON');
    }
    return Object.freeze({
        record,
        raw,
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        uid: stat.uid,
        nlink: stat.nlink,
        size: stat.size,
    });
}

function readLockSnapshot(filePath, expected, dependencies, options = {}) {
    if (!assertStoreDirectory(path.dirname(filePath), dependencies)) return null;
    return readLockSnapshotAt(filePath, expected, dependencies, options);
}

function sameLockSnapshot(left, right) {
    return Boolean(left && right)
        && left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.size === right.size
        && left.raw === right.raw;
}

function operationId(snapshot) {
    return createHash('sha256').update(snapshot.raw).digest('hex').slice(0, 32);
}

function operationPrefix(filePath) {
    return `${path.basename(filePath)}.operation-`;
}

function renewalPrefix(filePath) {
    return `${path.basename(filePath)}.renewal-`;
}

function publicationPrefix(filePath) {
    return `${path.basename(filePath)}.publication-`;
}

function operationArtifactNames(filePath, dependencies) {
    if (!assertStoreDirectory(path.dirname(filePath), dependencies)) return [];
    return dependencies.fs.readdirSync(path.dirname(filePath))
        .filter((name) => name.startsWith(operationPrefix(filePath)));
}

function renewalArtifactNames(filePath, dependencies) {
    if (!assertStoreDirectory(path.dirname(filePath), dependencies)) return [];
    return dependencies.fs.readdirSync(path.dirname(filePath))
        .filter((name) => name.startsWith(renewalPrefix(filePath)));
}

function publicationArtifactNames(filePath, dependencies) {
    if (!assertStoreDirectory(path.dirname(filePath), dependencies)) return [];
    return dependencies.fs.readdirSync(path.dirname(filePath))
        .filter((name) => name.startsWith(publicationPrefix(filePath)));
}

function inspectLockOwner(record, dependencies) {
    const inspection = dependencies.inspectProcessIdentity(record.ownerPid);
    if (!inspection || !['dead', 'identified', 'uid-diverged', 'unknown'].includes(inspection.state)) {
        throw lockError(record.kind, 'process identity inspector returned an invalid state');
    }
    if (inspection.state === 'dead') return Object.freeze({ state: 'stale', reason: 'dead' });
    if (inspection.state !== 'identified') return Object.freeze({ state: 'busy', uncertain: true });
    let identity;
    try { identity = normalizeProcessIdentity(inspection.processIdentity); } catch (_) {
        return Object.freeze({ state: 'busy', uncertain: true });
    }
    if (identity !== record.ownerStartIdentity) {
        return Object.freeze({ state: 'stale', reason: 'pid-reused' });
    }
    if (!Number.isSafeInteger(inspection.processUid)
        || inspection.processUid !== record.ownerUid
        || inspection.processUid !== currentUid(dependencies.getUid)) {
        return Object.freeze({ state: 'busy', uncertain: true });
    }
    return Object.freeze({ state: 'busy', uncertain: false });
}

function busyError(record, { uncertain = false } = {}) {
    const code = record.kind === LOCK_KINDS.maintenance
        ? 'PLOINKY_MAINTENANCE_BUSY'
        : 'PLOINKY_WORKSPACE_MUTATION_BUSY';
    const subject = record.kind === LOCK_KINDS.maintenance
        ? `maintenance for '${record.containerName}'`
        : (record.operation === 'workspace-start' ? 'workspace start' : `workspace mutation '${record.operation}'`);
    const error = lockError(record.kind, `${subject} is already active under pid ${record.ownerPid}`, code);
    error.owner = Object.freeze({ ...record, uncertain });
    return error;
}

function readRecoveryTransactionSnapshots(filePath, artifacts, expected, dependencies) {
    const claim = artifacts.has('claim')
        ? readLockSnapshotAt(artifacts.get('claim'), expected, dependencies, {
            minimumLinks: 1,
            maximumLinks: 3,
        })
        : null;
    const quarantine = artifacts.has('quarantine')
        ? readLockSnapshotAt(artifacts.get('quarantine'), expected, dependencies, {
            minimumLinks: 1,
            maximumLinks: 3,
        })
        : null;
    const canonical = readLockSnapshotAt(filePath, expected, dependencies, {
        minimumLinks: 1,
        maximumLinks: 3,
    });
    const entries = [];
    if (claim) entries.push({ role: 'claim', snapshot: claim });
    if (quarantine) entries.push({ role: 'quarantine', snapshot: quarantine });
    if (canonical) entries.push({ role: 'canonical', snapshot: canonical });
    assertAdmissionLinksAccounted(entries, expected, dependencies);
    return { claim, quarantine };
}

function recoverOperationArtifacts(filePath, expected, dependencies, {
    directorySnapshotRetry = false,
} = {}) {
    const names = operationArtifactNames(filePath, dependencies);
    if (names.length === 0) return false;
    const escapedPrefix = operationPrefix(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const groups = new Map();
    for (const name of names) {
        const match = name.match(new RegExp(`^${escapedPrefix}([a-f0-9]{32})\\.(claim|quarantine)$`));
        if (!match) throw lockError(expected.kind, 'lock store contains malformed exact-release state');
        if (!groups.has(match[1])) groups.set(match[1], new Map());
        const artifacts = groups.get(match[1]);
        if (artifacts.has(match[2])) throw lockError(expected.kind, 'lock store contains duplicate exact-release state');
        artifacts.set(match[2], path.join(path.dirname(filePath), name));
    }
    if (groups.size !== 1) throw lockError(expected.kind, 'lock store contains multiple interrupted exact releases');
    const [[contentId, artifacts]] = groups;
    let claim;
    let quarantine;
    try {
        ({ claim, quarantine } = readRecoveryTransactionSnapshots(
            filePath,
            artifacts,
            expected,
            dependencies,
        ));
    } catch (error) {
        if (error?.lockAdmissionDirectorySnapshotStale !== true || directorySnapshotRetry) {
            throw error;
        }
        return recoverOperationArtifacts(filePath, expected, dependencies, {
            directorySnapshotRetry: true,
        });
    }
    const operationSnapshot = claim || quarantine;
    if (!operationSnapshot || (claim && operationId(claim) !== contentId)
        || (!claim && operationId(quarantine) !== contentId)) {
        throw lockError(expected.kind, 'lock exact-release state is not content-exact');
    }
    if (claim && quarantine && claim.raw !== quarantine.raw) {
        const displacedOwner = inspectLockOwner(quarantine.record, dependencies);
        if (displacedOwner.state === 'busy') {
            const restored = restoreDisplacedPublicationPath(
                artifacts.get('quarantine'),
                filePath,
                quarantine,
                expected,
                dependencies,
            );
            if (!restored) throw busyError(quarantine.record, displacedOwner);
        } else {
            durableUnlinkSync(artifacts.get('quarantine'), expected, dependencies);
        }
        durableUnlinkSync(artifacts.get('claim'), expected, dependencies);
        return true;
    }
    if (claim && quarantine && !sameLockSnapshot(claim, quarantine)) {
        throw lockError(expected.kind, 'lock exact-release inode is not content-exact');
    }
    // The lock record identifies the authority being released, not a separate
    // transaction record. While that exact authority is live, private release
    // evidence can still belong to an executing releaser and must not be
    // completed by an observer.
    const operationOwner = inspectLockOwner(operationSnapshot.record, dependencies);
    if (operationOwner.state === 'busy') throw busyError(operationSnapshot.record, operationOwner);
    if (claim && !quarantine) {
        const current = readLockSnapshotAt(filePath, expected, dependencies, {
            minimumLinks: 1,
            maximumLinks: 2,
        });
        if (current && !sameLockSnapshot(current, claim)) {
            // A differing canonical owner proves the remaining old claim is
            // private cleanup state from a completed displaced-owner decision.
            // It is never revived as an independent acquisition authority.
            durableUnlinkSync(artifacts.get('claim'), expected, dependencies);
            return true;
        }
    }
    // Operation paths are never acquisition authorities. Recovery retires
    // only records whose exact UID/PID-start owner is proved dead or reused,
    // and never mutates a current owner at the canonical path.
    if (quarantine) durableUnlinkSync(artifacts.get('quarantine'), expected, dependencies);
    if (claim) durableUnlinkSync(artifacts.get('claim'), expected, dependencies);
    return true;
}

function sameRenewalAuthority(current, previous) {
    if (!current || !previous) return false;
    for (const key of [
        'schemaVersion',
        'kind',
        'containerName',
        'operation',
        'ownerPid',
        'ownerUid',
        'ownerStartIdentity',
        'token',
        'startedAt',
    ]) {
        if (current[key] !== previous[key]) return false;
    }
    return JSON.stringify(current.metadata) === JSON.stringify(previous.metadata)
        && Date.parse(current.expiresAt) > Date.parse(previous.expiresAt);
}

function recoverRenewalArtifacts(filePath, expected, dependencies) {
    const names = renewalArtifactNames(filePath, dependencies);
    if (names.length === 0) return false;
    const escapedPrefix = renewalPrefix(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const groups = new Map();
    for (const name of names) {
        const match = name.match(new RegExp(`^${escapedPrefix}([a-f0-9]{32})\\.(claim|candidate|quarantine)$`));
        if (!match) throw lockError(expected.kind, 'lock store contains malformed renewal state');
        if (!groups.has(match[1])) groups.set(match[1], new Map());
        const artifacts = groups.get(match[1]);
        if (artifacts.has(match[2])) throw lockError(expected.kind, 'lock store contains duplicate renewal state');
        artifacts.set(match[2], path.join(path.dirname(filePath), name));
    }
    if (groups.size !== 1) throw lockError(expected.kind, 'lock store contains multiple interrupted renewals');
    const [[contentId, artifacts]] = groups;
    if (!artifacts.has('claim')) throw lockError(expected.kind, 'lock renewal state has no exact old-owner claim');
    const claimPath = artifacts.get('claim');
    const claim = readLockSnapshotAt(claimPath, expected, dependencies, { minimumLinks: 1, maximumLinks: 3 });
    if (!claim || operationId(claim) !== contentId) {
        throw lockError(expected.kind, 'lock renewal state is not content-exact');
    }
    const candidate = artifacts.has('candidate')
        ? readLockSnapshotAt(artifacts.get('candidate'), expected, dependencies, {
            minimumLinks: 1,
            maximumLinks: 2,
        })
        : null;
    if (candidate && !sameRenewalAuthority(candidate.record, claim.record)) {
        throw lockError(expected.kind, 'lock renewal candidate does not extend the exact old owner');
    }
    const quarantine = artifacts.has('quarantine')
        ? readLockSnapshotAt(artifacts.get('quarantine'), expected, dependencies, {
            minimumLinks: 1,
            maximumLinks: 3,
        })
        : null;
    const current = readLockSnapshotAt(filePath, expected, dependencies, {
        minimumLinks: 1,
        maximumLinks: 3,
    });
    if (quarantine && quarantine.raw !== claim.raw) {
        const displacedOwner = inspectLockOwner(quarantine.record, dependencies);
        if (displacedOwner.state === 'busy') {
            const restored = restoreDisplacedPublicationPath(
                artifacts.get('quarantine'),
                filePath,
                quarantine,
                expected,
                dependencies,
            );
            if (!restored) throw busyError(quarantine.record, displacedOwner);
        } else {
            durableUnlinkSync(artifacts.get('quarantine'), expected, dependencies);
        }
        if (candidate) durableUnlinkSync(artifacts.get('candidate'), expected, dependencies);
        durableUnlinkSync(claimPath, expected, dependencies);
        return true;
    }
    if (quarantine && !sameLockSnapshot(claim, quarantine)) {
        throw lockError(expected.kind, 'lock renewal inode is not content-exact');
    }
    // Renewal is owner-bound: a live old authority proves the transaction may
    // still be between any two durable steps. Recovery observers must report
    // BUSY without restoring canonical or retiring the actor's evidence.
    const renewingOwner = inspectLockOwner(claim.record, dependencies);
    if (renewingOwner.state === 'busy') throw busyError(claim.record, renewingOwner);

    if (quarantine && current
        && sameLockSnapshot(current, claim)
        && sameLockSnapshot(current, quarantine)) {
        // Replay after restoring the old canonical owner but before retiring
        // the aborted renewal artifacts. This includes link applied+EIO where
        // the immediate proof read also failed. Exact same-inode equality
        // proves canonical/claim/quarantine are the old owner, never candidate.
        if (candidate) durableUnlinkSync(artifacts.get('candidate'), expected, dependencies);
        durableUnlinkSync(artifacts.get('quarantine'), expected, dependencies);
        durableUnlinkSync(claimPath, expected, dependencies);
        return true;
    }

    if (current && sameRenewalAuthority(current.record, claim.record)) {
        if (candidate && current.raw !== candidate.raw) {
            throw lockError(expected.kind, 'completed renewal differs from its exact candidate');
        }
        if (candidate) durableUnlinkSync(artifacts.get('candidate'), expected, dependencies);
        if (quarantine) durableUnlinkSync(artifacts.get('quarantine'), expected, dependencies);
        durableUnlinkSync(claimPath, expected, dependencies);
        return true;
    }

    if (!quarantine && current && !sameLockSnapshot(current, claim)) {
        // A canonical owner unrelated to both the old claim and its renewal
        // candidate proves cleanup already retired the displaced successor.
        // The remaining P1 records are private and replay-cleanable even while
        // that former owner process is still live.
        if (candidate) durableUnlinkSync(artifacts.get('candidate'), expected, dependencies);
        durableUnlinkSync(claimPath, expected, dependencies);
        return true;
    }

    const oldOwner = inspectLockOwner((quarantine || claim).record, dependencies);
    if (oldOwner.state === 'busy') {
        if (quarantine && !current) {
            try {
                durableLinkSync(artifacts.get('quarantine'), filePath, expected, dependencies);
            } catch (error) {
                if (error?.code !== 'EEXIST') throw error;
                throw busyError((quarantine || claim).record, oldOwner);
            }
            const restored = readLockSnapshotAt(filePath, expected, dependencies, {
                minimumLinks: 3,
                maximumLinks: 3,
            });
            const exactQuarantine = readLockSnapshotAt(artifacts.get('quarantine'), expected, dependencies, {
                minimumLinks: 3,
                maximumLinks: 3,
            });
            const exactClaim = readLockSnapshotAt(claimPath, expected, dependencies, {
                minimumLinks: 3,
                maximumLinks: 3,
            });
            if (!sameLockSnapshot(restored, claim)
                || !sameLockSnapshot(exactQuarantine, claim)
                || !sameLockSnapshot(exactClaim, claim)) {
                throw lockError(expected.kind, 'old renewal owner was not restored exactly');
            }
            if (candidate) durableUnlinkSync(artifacts.get('candidate'), expected, dependencies);
            durableUnlinkSync(artifacts.get('quarantine'), expected, dependencies);
            durableUnlinkSync(claimPath, expected, dependencies);
            return true;
        }
        throw busyError((quarantine || claim).record, oldOwner);
    }

    if (candidate) durableUnlinkSync(artifacts.get('candidate'), expected, dependencies);
    if (quarantine) durableUnlinkSync(artifacts.get('quarantine'), expected, dependencies);
    durableUnlinkSync(claimPath, expected, dependencies);
    return true;
}

function restoreDisplacedPublicationPath(quarantinePath, filePath, displaced, expected, dependencies) {
    try {
        durableLinkSync(quarantinePath, filePath, expected, dependencies);
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        // Replay after link(2) applied but both the syscall and immediate inode
        // proof failed sees EEXIST. Treat it as committed only when canonical
        // and quarantine are still the same exact displaced inode and bytes;
        // a different canonical successor remains no-clobber failure.
        const existing = readLockSnapshotAt(filePath, expected, dependencies, {
            minimumLinks: 1,
            maximumLinks: 2,
        });
        const quarantined = readLockSnapshotAt(quarantinePath, expected, dependencies, {
            minimumLinks: 1,
            maximumLinks: 2,
        });
        if (!sameLockSnapshot(existing, displaced) || !sameLockSnapshot(quarantined, displaced)
            || !sameLockSnapshot(existing, quarantined)) return false;
    }
    const restored = readLockSnapshotAt(filePath, expected, dependencies, {
        minimumLinks: 2,
        maximumLinks: 2,
    });
    const quarantined = readLockSnapshotAt(quarantinePath, expected, dependencies, {
        minimumLinks: 2,
        maximumLinks: 2,
    });
    if (!sameLockSnapshot(restored, displaced) || !sameLockSnapshot(quarantined, displaced)) {
        throw lockError(expected.kind, 'displaced publication owner was not restored exactly');
    }
    durableUnlinkSync(quarantinePath, expected, dependencies);
    return true;
}

function recoverPublicationArtifacts(filePath, expected, dependencies, {
    ownedContentId = null,
    directorySnapshotRetry = false,
} = {}) {
    const names = publicationArtifactNames(filePath, dependencies);
    if (names.length === 0) return false;
    const escapedPrefix = publicationPrefix(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const groups = new Map();
    for (const name of names) {
        const match = name.match(new RegExp(`^${escapedPrefix}([a-f0-9]{32})\\.(claim|quarantine)$`));
        if (!match) throw lockError(expected.kind, 'lock store contains malformed publication state');
        if (!groups.has(match[1])) groups.set(match[1], new Map());
        const artifacts = groups.get(match[1]);
        if (artifacts.has(match[2])) throw lockError(expected.kind, 'lock store contains duplicate publication state');
        artifacts.set(match[2], path.join(path.dirname(filePath), name));
    }
    if (groups.size !== 1) throw lockError(expected.kind, 'lock store contains multiple interrupted publications');
    const [[contentId, artifacts]] = groups;
    if (ownedContentId !== null && ownedContentId !== contentId) {
        throw lockError(expected.kind, 'publication cleanup does not own the interrupted content');
    }
    let claim;
    let quarantine;
    try {
        ({ claim, quarantine } = readRecoveryTransactionSnapshots(
            filePath,
            artifacts,
            expected,
            dependencies,
        ));
    } catch (error) {
        if (error?.lockAdmissionDirectorySnapshotStale !== true || directorySnapshotRetry) {
            throw error;
        }
        return recoverPublicationArtifacts(filePath, expected, dependencies, {
            ownedContentId,
            directorySnapshotRetry: true,
        });
    }
    const operationSnapshot = claim || quarantine;
    if (!operationSnapshot || (claim && operationId(claim) !== contentId)
        || (!claim && operationId(quarantine) !== contentId)) {
        throw lockError(expected.kind, 'lock publication state is not content-exact');
    }
    if (claim && quarantine && claim.raw !== quarantine.raw) {
        const displacedOwner = inspectLockOwner(quarantine.record, dependencies);
        if (displacedOwner.state === 'busy') {
            const restored = restoreDisplacedPublicationPath(
                artifacts.get('quarantine'),
                filePath,
                quarantine,
                expected,
                dependencies,
            );
            if (!restored) throw busyError(quarantine.record, displacedOwner);
            durableUnlinkSync(artifacts.get('claim'), expected, dependencies);
            return true;
        }
        // A differing quarantine is durable evidence that a successor replaced
        // the unreturned candidate between its snapshot and no-clobber move. It
        // remains fail-closed while that exact UID/PID-start owner is live or
        // uncertain. Once proved dead/reused, only the displaced record and the
        // old private candidate claim are retired; a canonical successor is
        // never renamed or unlinked.
        durableUnlinkSync(artifacts.get('quarantine'), expected, dependencies);
        durableUnlinkSync(artifacts.get('claim'), expected, dependencies);
        return true;
    }
    if (claim && quarantine && !sameLockSnapshot(claim, quarantine)) {
        throw lockError(expected.kind, 'lock publication inode is not content-exact');
    }
    if (ownedContentId === null) {
        const publishingOwner = inspectLockOwner(operationSnapshot.record, dependencies);
        if (publishingOwner.state === 'busy') throw busyError(operationSnapshot.record, publishingOwner);
    }
    const claimPath = artifacts.get('claim');
    const current = quarantine
        ? null
        : readLockSnapshotAt(filePath, expected, dependencies, { minimumLinks: 1, maximumLinks: 2 });
    if (claim && !quarantine && current && !sameLockSnapshot(current, claim)) {
        // The candidate is no longer current. Retire only the private claim;
        // a different canonical successor is never renamed or unlinked.
        durableUnlinkSync(claimPath, expected, dependencies);
        return true;
    }
    if (claim && !quarantine && !current) {
        durableUnlinkSync(claimPath, expected, dependencies);
        return true;
    }

    if (quarantine) {
        durableUnlinkSync(artifacts.get('quarantine'), expected, dependencies);
        if (claim) durableUnlinkSync(artifacts.get('claim'), expected, dependencies);
        return true;
    }

    const quarantinePath = `${filePath}.publication-${contentId}.quarantine`;
    durableRenameSync(filePath, quarantinePath, expected, dependencies);
    const quarantined = readLockSnapshotAt(quarantinePath, expected, dependencies, {
        minimumLinks: 1,
        maximumLinks: 2,
    });
    if (quarantined.raw !== claim.raw) {
        const displacedOwner = inspectLockOwner(quarantined.record, dependencies);
        if (displacedOwner.state === 'busy') {
            const restored = restoreDisplacedPublicationPath(
                quarantinePath,
                filePath,
                quarantined,
                expected,
                dependencies,
            );
            if (!restored) throw busyError(quarantined.record, displacedOwner);
            durableUnlinkSync(claimPath, expected, dependencies);
            return true;
        }
        durableUnlinkSync(quarantinePath, expected, dependencies);
        durableUnlinkSync(claimPath, expected, dependencies);
        return true;
    }
    if (!sameLockSnapshot(quarantined, claim)) {
        throw lockError(expected.kind, 'publication candidate inode changed during cleanup');
    }
    // Canonical removal above is the atomic cleanup point. Any successor that
    // publishes afterwards stays at the canonical path while cleanup touches
    // only the content-addressed private publication paths.
    durableUnlinkSync(quarantinePath, expected, dependencies);
    durableUnlinkSync(claimPath, expected, dependencies);
    return true;
}

function recoverInterruptedOperations(filePath, expected, dependencies) {
    const recoveredPublication = recoverPublicationArtifacts(filePath, expected, dependencies);
    const recoveredRelease = recoverOperationArtifacts(filePath, expected, dependencies);
    const recoveredRenewal = recoverRenewalArtifacts(filePath, expected, dependencies);
    return recoveredPublication || recoveredRelease || recoveredRenewal;
}

function artifactEvidenceFingerprint(family, group, canonical) {
    const entries = [...group.snapshots.entries()].map(([role, snapshot]) => ({
        role,
        name: path.basename(group.paths.get(role)),
        dev: String(snapshot.dev),
        ino: String(snapshot.ino),
        mode: snapshot.mode,
        uid: snapshot.uid,
        nlink: snapshot.nlink,
        size: snapshot.size,
        rawHash: createHash('sha256').update(snapshot.raw).digest('hex'),
    }));
    if (canonical) {
        entries.push({
            role: 'canonical',
            name: 'canonical',
            dev: String(canonical.dev),
            ino: String(canonical.ino),
            mode: canonical.mode,
            uid: canonical.uid,
            nlink: canonical.nlink,
            size: canonical.size,
            rawHash: createHash('sha256').update(canonical.raw).digest('hex'),
        });
    }
    entries.sort((left, right) => left.role.localeCompare(right.role)
        || left.name.localeCompare(right.name));
    const evidence = JSON.stringify({
        family,
        contentId: group.contentId,
        canonicalPresent: Boolean(canonical),
        entries,
    });
    return createHash('sha256').update(evidence).digest('hex');
}

function concurrentArtifactBusy(
    expected,
    snapshot = null,
    dependencies = null,
    evidence = null,
) {
    if (snapshot && dependencies) {
        const owner = inspectLockOwner(snapshot.record, dependencies);
        const error = busyError(snapshot.record, {
            uncertain: owner.state !== 'busy' || owner.uncertain,
        });
        error.concurrentLockArtifacts = true;
        if (evidence) {
            error.concurrentArtifactFamily = evidence.family;
            error.concurrentArtifactFingerprint = evidence.fingerprint;
            error.concurrentArtifactOwnerState = owner.state;
            if (owner.reason) error.concurrentArtifactOwnerReason = owner.reason;
        }
        return error;
    }
    const code = expected.kind === LOCK_KINDS.maintenance
        ? 'PLOINKY_MAINTENANCE_BUSY'
        : 'PLOINKY_WORKSPACE_MUTATION_BUSY';
    const error = lockError(
        expected.kind,
        'lock has a settling concurrent exact operation',
        code,
    );
    error.concurrentLockArtifacts = true;
    return error;
}

function readAdmissionSnapshot(filePath, expected, dependencies) {
    const snapshot = readLockSnapshotAt(filePath, expected, dependencies, {
        minimumLinks: 1,
        maximumLinks: 3,
    });
    if (!snapshot) throw concurrentArtifactBusy(expected);
    return snapshot;
}

function assertAdmissionLinksAccounted(entries, expected, dependencies) {
    for (const entry of entries) {
        const aliases = entries.filter(({ snapshot }) => sameTransitionInode(snapshot, entry.snapshot));
        if (aliases.some(({ snapshot }) => snapshot.raw !== entry.snapshot.raw)) {
            throw lockError(expected.kind, 'concurrent operation aliases are not byte-exact');
        }
        if (entry.snapshot.nlink < aliases.length) {
            // A name captured by readdir/open can retire before another alias
            // is opened or fstat'd. The store is settling, not malformed; retry
            // from a fresh directory snapshot without touching either inode.
            const authority = aliases.find(({ role }) => role === 'canonical')?.snapshot
                || entry.snapshot;
            throw concurrentArtifactBusy(expected, authority, dependencies);
        }
        if (entry.snapshot.nlink > aliases.length) {
            const error = lockError(
                expected.kind,
                'concurrent operation inode has an unaccounted hard link',
            );
            // readdir(2) can capture the transaction before its next durable
            // hard link is published while the later open/fstat observes that
            // new alias. Reclassify exactly once from a fresh directory
            // snapshot; a stable foreign link remains INVALID on the retry.
            error.lockAdmissionDirectorySnapshotStale = true;
            throw error;
        }
    }
}

function exactArtifactGroup(definition, names, filePath, expected, dependencies) {
    const escapedBase = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matcher = new RegExp(`^${escapedBase}\\.${definition.segment}-([a-f0-9]{32})\\.(${definition.roles.join('|')})$`);
    const groups = new Map();
    for (const name of names) {
        const match = name.match(matcher);
        if (!match) throw lockError(expected.kind, `lock store contains malformed ${definition.label} state`);
        if (!groups.has(match[1])) groups.set(match[1], new Map());
        const roles = groups.get(match[1]);
        if (roles.has(match[2])) throw lockError(expected.kind, `lock store contains duplicate ${definition.label} state`);
        roles.set(match[2], path.join(path.dirname(filePath), name));
    }
    if (groups.size !== 1) {
        throw lockError(expected.kind, `lock store contains multiple concurrent ${definition.label} groups`);
    }
    const [[contentId, paths]] = groups;
    const snapshots = new Map();
    for (const [role, artifactPath] of paths) {
        snapshots.set(role, readAdmissionSnapshot(artifactPath, expected, dependencies));
    }
    return { contentId, paths, snapshots };
}

function assertClaimHash(group, expected, label) {
    const claim = group.snapshots.get('claim');
    if (!claim || operationId(claim) !== group.contentId) {
        throw lockError(expected.kind, `lock ${label} state is not content-exact`);
    }
    return claim;
}

function classifyPublicationOrReleaseArtifacts({
    family,
    group,
    canonical,
    expected,
    dependencies,
}) {
    const label = family === 'publication' ? 'publication' : 'exact-release';
    const claim = assertClaimHash(group, expected, label);
    const quarantine = group.snapshots.get('quarantine') || null;
    const entries = [...group.snapshots.entries()].map(([role, snapshot]) => ({ role, snapshot }));
    if (canonical) entries.push({ role: 'canonical', snapshot: canonical });
    assertAdmissionLinksAccounted(entries, expected, dependencies);

    if (quarantine) {
        if (!sameLockSnapshot(claim, quarantine)) {
            throw lockError(expected.kind, `lock ${label} claim and quarantine are not inode-exact`);
        }
        if (canonical && sameLockSnapshot(canonical, claim)) {
            // durableRenameSync is a no-clobber link+unlink transition. Its
            // exact live midpoint has canonical, claim, and quarantine names
            // on the same three-link inode; observers preserve it as BUSY.
            if (claim.nlink !== 3 || quarantine.nlink !== 3 || canonical.nlink !== 3) {
                throw lockError(expected.kind, `lock ${label} transition triple is not exact`);
            }
        } else if (claim.nlink !== 2 || quarantine.nlink !== 2) {
            throw lockError(expected.kind, `lock ${label} private pair is not exact`);
        }
    } else if (canonical && sameLockSnapshot(canonical, claim)) {
        if (claim.nlink !== 2 || canonical.nlink !== 2) {
            throw lockError(expected.kind, `lock ${label} canonical pair is not exact`);
        }
    } else if (claim.nlink !== 1) {
        throw lockError(expected.kind, `lock ${label} private claim is not exact`);
    }
    const evidence = family === 'publication'
        ? {
            family,
            fingerprint: artifactEvidenceFingerprint(family, group, canonical),
        }
        : null;
    throw concurrentArtifactBusy(expected, claim, dependencies, evidence);
}

function classifyRenewalArtifacts({ group, canonical, expected, dependencies }) {
    if (expected.kind !== LOCK_KINDS.workspaceMutation) {
        throw lockError(expected.kind, 'maintenance lock store contains workspace renewal state');
    }
    const claim = assertClaimHash(group, expected, 'renewal');
    const quarantine = group.snapshots.get('quarantine') || null;
    const candidate = group.snapshots.get('candidate') || null;
    if (quarantine && !sameLockSnapshot(claim, quarantine)) {
        throw lockError(expected.kind, 'lock renewal claim and quarantine are not inode-exact');
    }
    if (candidate) {
        if (!sameRenewalAuthority(candidate.record, claim.record)) {
            throw lockError(expected.kind, 'lock renewal candidate does not extend the exact old owner');
        }
        if (sameTransitionInode(candidate, claim)) {
            throw lockError(expected.kind, 'lock renewal candidate reuses the old-owner inode');
        }
    }

    const entries = [...group.snapshots.entries()].map(([role, snapshot]) => ({ role, snapshot }));
    if (canonical) entries.push({ role: 'canonical', snapshot: canonical });
    assertAdmissionLinksAccounted(entries, expected, dependencies);
    const canonicalIsOld = canonical && sameLockSnapshot(canonical, claim);
    const canonicalIsCandidate = canonical && candidate && sameLockSnapshot(canonical, candidate);
    const canonicalIsRenewed = canonical && !canonicalIsOld
        && sameRenewalAuthority(canonical.record, claim.record);
    if (candidate && canonicalIsRenewed && !canonicalIsCandidate) {
        throw lockError(expected.kind, 'renewed canonical differs from its exact candidate');
    }

    if (quarantine) {
        if (canonicalIsOld) {
            // Recovery can be paused after restoring the old canonical name and
            // before retiring its exact claim/quarantine pair.
            if (claim.nlink !== 3 || quarantine.nlink !== 3 || canonical.nlink !== 3) {
                throw lockError(expected.kind, 'lock renewal restore triple is not exact');
            }
            if (candidate && candidate.nlink !== 1) {
                throw lockError(expected.kind, 'lock renewal restore candidate is not private');
            }
        } else {
            if (claim.nlink !== 2 || quarantine.nlink !== 2) {
                throw lockError(expected.kind, 'lock renewal old-owner pair is not exact');
            }
            if (candidate) {
                if (canonicalIsCandidate) {
                    if (candidate.nlink !== 2 || canonical.nlink !== 2) {
                        throw lockError(expected.kind, 'lock renewed canonical pair is not exact');
                    }
                } else if (candidate.nlink !== 1) {
                    throw lockError(expected.kind, 'lock renewal candidate is not private');
                }
            } else if (!canonicalIsRenewed || canonical.nlink !== 1) {
                throw lockError(expected.kind, 'lock renewal cleanup lacks an exact renewed canonical owner');
            }
        }
    } else {
        if (canonicalIsCandidate) {
            throw lockError(expected.kind, 'lock renewal canonical candidate lacks old-owner quarantine evidence');
        }
        if (canonicalIsOld) {
            if (claim.nlink !== 2 || canonical.nlink !== 2 || (candidate && candidate.nlink !== 1)) {
                throw lockError(expected.kind, 'lock renewal pre-rename state is not exact');
            }
        } else {
            if (claim.nlink !== 1 || (candidate && candidate.nlink !== 1)) {
                throw lockError(expected.kind, 'lock renewal cleanup state is not exact');
            }
            if (canonicalIsRenewed && canonical.nlink !== 1) {
                throw lockError(expected.kind, 'lock renewed canonical owner is not exact');
            }
        }
    }
    throw concurrentArtifactBusy(expected, claim, dependencies, {
        family: 'renewal',
        fingerprint: artifactEvidenceFingerprint('renewal', group, canonical),
    });
}

// Admission is deliberately read-only. Recovery belongs to the preceding
// quiescent inspection, never to the point where another process may have
// exposed a transaction-private hard link after that inspection completed.
function classifyConcurrentLockArtifacts(filePath, expected, dependencies, {
    ownedPublicationId = null,
    directorySnapshotRetry = false,
} = {}) {
    try {
        return classifyConcurrentLockArtifactsSnapshot(
            filePath,
            expected,
            dependencies,
            ownedPublicationId,
        );
    } catch (error) {
        if (error?.lockAdmissionDirectorySnapshotStale !== true || directorySnapshotRetry) {
            throw error;
        }
        return classifyConcurrentLockArtifacts(filePath, expected, dependencies, {
            ownedPublicationId,
            directorySnapshotRetry: true,
        });
    }
}

function classifyConcurrentLockArtifactsSnapshot(
    filePath,
    expected,
    dependencies,
    ownedPublicationId,
) {
    if (!assertStoreDirectory(path.dirname(filePath), dependencies)) return;
    const directoryNames = dependencies.fs.readdirSync(path.dirname(filePath));
    const baseName = path.basename(filePath);
    const definitions = Object.freeze([
        Object.freeze({ family: 'release', segment: 'operation', label: 'exact-release', roles: ['claim', 'quarantine'] }),
        Object.freeze({ family: 'renewal', segment: 'renewal', label: 'renewal', roles: ['claim', 'candidate', 'quarantine'] }),
        Object.freeze({ family: 'publication', segment: 'publication', label: 'publication', roles: ['claim', 'quarantine'] }),
    ]);
    const familyNames = new Map();
    for (const definition of definitions) {
        const prefix = `${baseName}.${definition.segment}-`;
        const names = directoryNames.filter((name) => name.startsWith(prefix));
        if (names.length > 0) familyNames.set(definition.family, { definition, names });
    }

    if (ownedPublicationId !== null) {
        const publication = familyNames.get('publication');
        if (!publication) throw lockError(expected.kind, 'owned publication claim is missing at collision admission');
        const ownedClaimName = `${baseName}.publication-${ownedPublicationId}.claim`;
        const ownedQuarantineName = `${baseName}.publication-${ownedPublicationId}.quarantine`;
        if (!publication.names.includes(ownedClaimName) || publication.names.includes(ownedQuarantineName)) {
            throw lockError(expected.kind, 'owned publication collision state is not exact');
        }
        const ownedClaim = readAdmissionSnapshot(
            path.join(path.dirname(filePath), ownedClaimName),
            expected,
            dependencies,
        );
        if (operationId(ownedClaim) !== ownedPublicationId || ownedClaim.nlink !== 1) {
            throw lockError(expected.kind, 'owned publication claim has an unaccounted alias');
        }
        publication.names = publication.names.filter((name) => name !== ownedClaimName);
        if (publication.names.length === 0) familyNames.delete('publication');
    }

    if (familyNames.size === 0) return;
    if (familyNames.size !== 1) {
        throw lockError(expected.kind, 'lock store contains multiple concurrent operation families');
    }
    const [[family, { definition, names }]] = familyNames;
    const group = exactArtifactGroup(definition, names, filePath, expected, dependencies);
    const canonical = readLockSnapshotAt(filePath, expected, dependencies, {
        minimumLinks: 1,
        maximumLinks: 3,
    });
    if (family === 'renewal') {
        classifyRenewalArtifacts({ group, canonical, expected, dependencies });
    }
    classifyPublicationOrReleaseArtifacts({
        family,
        group,
        canonical,
        expected,
        dependencies,
    });
}

function staleConcurrentArtifactObservation(error, previous, observedAt) {
    if (error?.concurrentLockArtifacts !== true
        || !['publication', 'renewal'].includes(error.concurrentArtifactFamily)
        || !/^[a-f0-9]{64}$/.test(error.concurrentArtifactFingerprint || '')
        || error.concurrentArtifactOwnerState !== 'stale') {
        return null;
    }
    if (previous
        && previous.family === error.concurrentArtifactFamily
        && previous.fingerprint === error.concurrentArtifactFingerprint) {
        return previous;
    }
    return Object.freeze({
        family: error.concurrentArtifactFamily,
        fingerprint: error.concurrentArtifactFingerprint,
        firstObservedAt: observedAt,
    });
}

function recoverStableConcurrentArtifacts(filePath, expected, observation, dependencies) {
    assertNoLegacyAuthority(expected, dependencies);
    try {
        classifyConcurrentLockArtifacts(filePath, expected, dependencies);
        return false;
    } catch (error) {
        if (error?.concurrentLockArtifacts !== true
            || error.concurrentArtifactFamily !== observation.family
            || error.concurrentArtifactFingerprint !== observation.fingerprint
            || error.concurrentArtifactOwnerState !== 'stale') {
            if (['PLOINKY_MAINTENANCE_BUSY', 'PLOINKY_WORKSPACE_MUTATION_BUSY'].includes(error?.code)) {
                return false;
            }
            throw error;
        }
    }

    try {
        if (observation.family === 'publication') {
            return recoverPublicationArtifacts(filePath, expected, dependencies);
        }
        if (observation.family === 'renewal') {
            return recoverRenewalArtifacts(filePath, expected, dependencies);
        }
    } catch (error) {
        if (['PLOINKY_MAINTENANCE_BUSY', 'PLOINKY_WORKSPACE_MUTATION_BUSY'].includes(error?.code)) {
            return false;
        }
        throw error;
    }
    return false;
}

function removeExactSnapshot(filePath, expected, snapshot, dependencies) {
    dependencies.beforeExactReleaseAdmission?.({ filePath, snapshot });
    // inspectLock/remove callers can observe a quiescent store immediately
    // before another exact publisher, renewal, or release exposes private
    // transaction evidence. Admission classifies that evidence without ever
    // completing, restoring, or cleaning another actor's transaction.
    classifyConcurrentLockArtifacts(filePath, expected, dependencies);
    const admitted = readLockSnapshotAt(filePath, expected, dependencies, {
        minimumLinks: 1,
        maximumLinks: 1,
    });
    if (!sameLockSnapshot(admitted, snapshot)) return false;
    const contentId = operationId(snapshot);
    const operationBase = `${filePath}.operation-${contentId}`;
    const claimPath = `${operationBase}.claim`;
    const quarantinePath = `${operationBase}.quarantine`;
    let claimCreated = false;
    let primaryRenamed = false;
    try {
        try {
            durableLinkSync(filePath, claimPath, expected, dependencies);
            claimCreated = true;
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            if (error?.code === 'EEXIST') {
                const competingClaim = readLockSnapshotAt(claimPath, expected, dependencies, {
                    minimumLinks: 1,
                    maximumLinks: 2,
                });
                if (sameLockSnapshot(competingClaim, snapshot)) {
                    const owner = inspectLockOwner(competingClaim.record, dependencies);
                    throw busyError(competingClaim.record, {
                        uncertain: owner.state !== 'busy' || owner.uncertain,
                    });
                }
                throw lockError(expected.kind, 'lock exact release raced another operation');
            }
            throw error;
        }
        const competing = operationArtifactNames(filePath, dependencies)
            .filter((name) => name !== path.basename(claimPath));
        if (competing.length > 0) throw lockError(expected.kind, 'lock has concurrent exact-release operations');
        const claim = readLockSnapshotAt(claimPath, expected, dependencies, { minimumLinks: 2, maximumLinks: 2 });
        if (!sameLockSnapshot(claim, snapshot)) {
            durableUnlinkSync(claimPath, expected, dependencies);
            claimCreated = false;
            return false;
        }

        // Rename is the atomic release point. A successor may publish at the
        // canonical pathname immediately afterwards; all later cleanup is
        // limited to these content-addressed operation-private paths.
        try {
            durableRenameSync(filePath, quarantinePath, expected, dependencies);
            primaryRenamed = true;
        } catch (error) {
            if (error?.lockTransitionApplied) primaryRenamed = true;
            throw error;
        }
        dependencies.afterPrimaryRelease?.({
            filePath,
            claimPath,
            quarantinePath,
            released: snapshot.record,
        });
        const quarantined = readLockSnapshotAt(quarantinePath, expected, dependencies, {
            minimumLinks: 1,
            maximumLinks: 2,
        });
        if (quarantined.raw !== snapshot.raw) {
            const displacedOwner = inspectLockOwner(quarantined.record, dependencies);
            if (displacedOwner.state === 'busy') {
                const restored = restoreDisplacedPublicationPath(
                    quarantinePath,
                    filePath,
                    quarantined,
                    expected,
                    dependencies,
                );
                if (!restored) throw busyError(quarantined.record, displacedOwner);
            } else {
                durableUnlinkSync(quarantinePath, expected, dependencies);
            }
            durableUnlinkSync(claimPath, expected, dependencies);
            return false;
        }
        const postClaim = readLockSnapshotAt(claimPath, expected, dependencies, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        if (!sameLockSnapshot(postClaim, snapshot) || !sameLockSnapshot(quarantined, snapshot)) {
            throw lockError(expected.kind, 'lock changed during exact release');
        }
        durableUnlinkSync(quarantinePath, expected, dependencies);
        durableUnlinkSync(claimPath, expected, dependencies);
        return true;
    } catch (error) {
        if (error?.lockDurabilityUncertain && primaryRenamed) {
            // The final private unlink can apply while both the syscall and its
            // immediate proof read fail. Re-probe the complete operation after
            // the wrapper has released its pinned descriptors. With no private
            // artifacts, the old exact inode is released if canonical is absent
            // or now names a different owner; report that committed outcome.
            try {
                if (operationArtifactNames(filePath, dependencies).length === 0) {
                    const current = readLockSnapshotAt(filePath, expected, dependencies, {
                        minimumLinks: 1,
                        maximumLinks: 1,
                    });
                    if (!current || !sameLockSnapshot(current, snapshot)) return true;
                }
            } catch (_) {
                // Preserve the original uncertain result when exact replay
                // cannot itself be established.
            }
        }
        if (claimCreated && !primaryRenamed && !error?.lockDurabilityUncertain) {
            try { durableUnlinkSync(claimPath, expected, dependencies); } catch (_) {}
        }
        throw error;
    }
}

function publishLockRecord(filePath, expected, record, dependencies) {
    assertStoreDirectory(path.dirname(filePath), dependencies, { create: true });
    dependencies.beforePublicationAdmission?.({ filePath, record });
    // The caller's earlier inspect is not an acquisition barrier. Classify a
    // transaction that appeared since then read-only: exact evidence is BUSY,
    // while malformed/cross-inode/extra-link evidence remains INVALID.
    classifyConcurrentLockArtifacts(filePath, expected, dependencies);
    const temporaryPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${dependencies.randomUUID()}.tmp`,
    );
    const payload = serializeLockRecord(record);
    const contentId = createHash('sha256').update(payload).digest('hex').slice(0, 32);
    const claimPath = `${filePath}.publication-${contentId}.claim`;
    let descriptor;
    let claimCreated = false;
    let canonicalLinked = false;
    try {
        descriptor = dependencies.fs.openSync(temporaryPath, 'wx', 0o600);
        dependencies.fs.writeFileSync(descriptor, payload, 'utf8');
        dependencies.fs.fsyncSync(descriptor);
        dependencies.fs.closeSync(descriptor);
        descriptor = undefined;
        try {
            durableLinkSync(temporaryPath, claimPath, expected, dependencies);
        } catch (error) {
            if (error?.code === 'EEXIST') {
                throw lockError(expected.kind, 'lock publication raced another exact operation');
            }
            throw error;
        }
        claimCreated = true;
        durableUnlinkSync(temporaryPath, expected, dependencies);
        dependencies.beforePublish?.({ filePath, record, payload, temporaryPath: claimPath });
        try {
            durableLinkSync(claimPath, filePath, expected, dependencies);
            canonicalLinked = true;
        } catch (error) {
            // link(2) returning EEXIST proves this candidate did not acquire
            // the canonical name. durableLinkSync preserves that collision as
            // transition evidence, but publication cleanup must retire only
            // this candidate's private claim, never the competing publisher's
            // in-flight claim.
            if (error?.lockTransitionApplied && error?.code !== 'EEXIST') canonicalLinked = true;
            if (error?.code !== 'EEXIST') throw error;
            // Our own publication claim is now present. Ignore exactly that
            // content-addressed private name while classifying any foreign
            // publication/release/renewal transaction without mutating it.
            classifyConcurrentLockArtifacts(filePath, expected, dependencies, {
                ownedPublicationId: contentId,
            });
            let competing = readLockSnapshotAt(filePath, expected, dependencies, {
                minimumLinks: 1,
                maximumLinks: 2,
            });
            if (!competing) {
                throw lockError(expected.kind, 'competing canonical lock vanished during publication');
            }
            if (competing.nlink === 2) {
                // A concurrent publisher legitimately holds the canonical
                // inode plus its content-addressed private claim until its
                // final directory-synced unlink. Accept that transient shape
                // only after proving the second name is the exact expected
                // claim for the same inode and canonical bytes. If the winner
                // retires its claim between reads, re-prove the now-single-link
                // canonical owner instead.
                const competingClaimPath = `${filePath}.publication-${operationId(competing)}.claim`;
                let competingClaim;
                try {
                    competingClaim = readLockSnapshotAt(
                        competingClaimPath,
                        expected,
                        dependencies,
                        { minimumLinks: 2, maximumLinks: 2 },
                    );
                } catch (error) {
                    const settledLink = error?.lockSnapshotSettledLink;
                    if (!settledLink
                        || settledLink.dev !== competing.dev
                        || settledLink.ino !== competing.ino) {
                        throw error;
                    }
                    competingClaim = null;
                }
                if (competingClaim) {
                    if (!sameLockSnapshot(competing, competingClaim)) {
                        throw lockError(expected.kind, 'competing lock publication claim is not exact');
                    }
                } else {
                    const settled = readLockSnapshotAt(filePath, expected, dependencies, {
                        minimumLinks: 1,
                        maximumLinks: 1,
                    });
                    if (!settled || !sameLockSnapshot(competing, settled)) {
                        throw lockError(expected.kind, 'competing lock publication shape is not exact');
                    }
                    competing = settled;
                }
            }
            const competingOwner = inspectLockOwner(competing.record, dependencies);
            throw busyError(competing.record, {
                uncertain: competingOwner.state !== 'busy' || competingOwner.uncertain,
            });
        }
        const published = readLockSnapshotAt(filePath, expected, dependencies, { minimumLinks: 2, maximumLinks: 2 });
        const claim = readLockSnapshotAt(claimPath, expected, dependencies, { minimumLinks: 2, maximumLinks: 2 });
        if (!published || published.raw !== payload || !sameLockSnapshot(published, claim)) {
            throw lockError(expected.kind, 'published lock record is not exact');
        }
        durableUnlinkSync(claimPath, expected, dependencies);
        claimCreated = false;
        return;
    } catch (error) {
        if (canonicalLinked && claimCreated) {
            // unlink(2) may remove the final private claim and still report an
            // I/O error. If no publication artifact remains, the already
            // directory-synced canonical inode is the committed authority;
            // return its exact record instead of orphaning an unreturned token.
            const remainingPublication = publicationArtifactNames(filePath, dependencies);
            if (remainingPublication.length === 0) {
                const committed = readLockSnapshotAt(filePath, expected, dependencies, {
                    minimumLinks: 1,
                    maximumLinks: 1,
                });
                if (committed?.raw === payload) {
                    claimCreated = false;
                    return;
                }
            }
            // A failed directory fsync after an applied transition leaves the
            // content-addressed claim as durable, recognized fail-closed
            // evidence. Do not erase it based on an uncertain persistence
            // result; normal recovery will resolve the exact state later.
            if (error?.lockDurabilityUncertain) throw error;
            try {
                recoverPublicationArtifacts(filePath, expected, dependencies, { ownedContentId: contentId });
                claimCreated = false;
            } catch (recoveryError) {
                error.publicationRecoveryError = recoveryError;
            }
        } else if (claimCreated && !error?.lockDurabilityUncertain) {
            try {
                durableUnlinkSync(claimPath, expected, dependencies);
                claimCreated = false;
            } catch (_) {}
        }
        throw error;
    } finally {
        if (descriptor !== undefined) {
            try { dependencies.fs.closeSync(descriptor); } catch (_) {}
        }
        try { durableUnlinkSync(temporaryPath, expected, dependencies); } catch (_) {}
    }
}

function createLockRecord({ kind, containerName = '', operation, ttlMs, metadata }, dependencies) {
    const now = Number(dependencies.now());
    const ttl = Number(ttlMs);
    if (!Number.isFinite(now) || !Number.isFinite(ttl)) throw lockError(kind, 'lock lifetime is invalid');
    const uid = currentUid(dependencies.getUid);
    const inspection = dependencies.inspectProcessIdentity(process.pid);
    let ownerStartIdentity;
    try { ownerStartIdentity = normalizeProcessIdentity(inspection?.processIdentity); } catch (_) { ownerStartIdentity = ''; }
    if (inspection?.state !== 'identified' || inspection.processUid !== uid || !ownerStartIdentity) {
        throw lockError(kind, 'lock owner cannot be bound to an exact same-UID PID-start identity');
    }
    const token = dependencies.randomUUID();
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw lockError(kind, 'lock token generator returned a noncanonical token');
    return canonicalLockRecord({
        schemaVersion: LOCK_SCHEMA_VERSION,
        kind,
        containerName,
        operation: normalizeOperation(operation),
        metadata: normalizeMetadata(metadata, kind),
        ownerPid: process.pid,
        ownerUid: uid,
        ownerStartIdentity,
        token,
        startedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttl).toISOString(),
    });
}

function inspectLock(filePath, expected, dependencies, attempt = 0) {
    const recovered = recoverInterruptedOperations(filePath, expected, dependencies);
    const snapshot = readLockSnapshot(filePath, expected, dependencies);
    if (!snapshot) return { active: false, stale: recovered, lock: null };
    const owner = inspectLockOwner(snapshot.record, dependencies);
    const expiresAtMs = Date.parse(snapshot.record.expiresAt);
    if (owner.state === 'busy') {
        return {
            active: true,
            stale: false,
            renewalOverdue: expiresAtMs <= Number(dependencies.now()),
            recoveryPending: owner.uncertain,
            lock: { ...snapshot.record, filePath },
        };
    }
    if (removeExactSnapshot(filePath, expected, snapshot, dependencies)) {
        return { active: false, stale: true, lock: snapshot.record };
    }
    if (attempt >= 2) {
        return { active: true, stale: false, recoveryPending: true, lock: snapshot.record };
    }
    return inspectLock(filePath, expected, dependencies, attempt + 1);
}

function inspectLockForAcquisition(filePath, expected, dependencies, attempt = 0) {
    classifyConcurrentLockArtifacts(filePath, expected, dependencies);
    const snapshot = readLockSnapshot(filePath, expected, dependencies);
    if (!snapshot) return { active: false, stale: false, lock: null };
    const owner = inspectLockOwner(snapshot.record, dependencies);
    const expiresAtMs = Date.parse(snapshot.record.expiresAt);
    if (owner.state === 'busy') {
        return {
            active: true,
            stale: false,
            renewalOverdue: expiresAtMs <= Number(dependencies.now()),
            recoveryPending: owner.uncertain,
            lock: { ...snapshot.record, filePath },
        };
    }
    // Acquisition must never replay transaction evidence. In particular, a
    // token-based exact release can be executing in a live process unrelated
    // to the stale canonical record owner. removeExactSnapshot performs its
    // own read-only admission classification before touching the canonical
    // inode, so a concurrent publication, renewal, or release remains BUSY.
    if (removeExactSnapshot(filePath, expected, snapshot, dependencies)) {
        return { active: false, stale: true, lock: snapshot.record };
    }
    if (attempt >= 2) {
        return { active: true, stale: false, recoveryPending: true, lock: snapshot.record };
    }
    return inspectLockForAcquisition(filePath, expected, dependencies, attempt + 1);
}

function workspaceMutationBusy(lock) {
    if (lock) return busyError(lock);
    return lockError(
        LOCK_KINDS.workspaceMutation,
        'workspace mutation is already active under an unverified owner',
        'PLOINKY_WORKSPACE_MUTATION_BUSY',
    );
}

function createWorkspaceMutationLease({
    ttlMs = WORKSPACE_START_TTL_MS,
    operation = 'workspace-mutation',
} = {}, dependencyOverrides = {}) {
    const dependencies = lockDependencies(dependencyOverrides);
    const expected = { kind: LOCK_KINDS.workspaceMutation, containerName: '' };
    assertNoLegacyAuthority(expected, dependencies);
    classifyConcurrentLockArtifacts(WORKSPACE_START_LOCK_PATH, expected, dependencies);
    dependencies.afterAcquisitionAdmission?.({
        filePath: WORKSPACE_START_LOCK_PATH,
        expected,
    });
    const existing = inspectLockForAcquisition(WORKSPACE_START_LOCK_PATH, expected, dependencies);
    if (existing.active) throw workspaceMutationBusy(existing.lock);
    const lock = createLockRecord({
        kind: expected.kind,
        operation,
        ttlMs,
        metadata: {},
    }, dependencies);
    publishLockRecord(WORKSPACE_START_LOCK_PATH, expected, lock, dependencies);
    return lock;
}

async function acquireWorkspaceMutationLease({
    waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
    ...lockOptions
} = {}) {
    const requestedWaitMs = Number(waitTimeoutMs);
    const boundedWaitMs = Number.isFinite(requestedWaitMs)
        ? Math.max(0, Math.min(MAX_WORKSPACE_MUTATION_WAIT_MS, requestedWaitMs))
        : DEFAULT_WAIT_TIMEOUT_MS;
    const requestedRetryMs = Number(retryIntervalMs);
    const boundedRetryMs = Number.isFinite(requestedRetryMs)
        ? Math.max(1, Math.min(MAX_WORKSPACE_MUTATION_RETRY_INTERVAL_MS, requestedRetryMs))
        : DEFAULT_RETRY_INTERVAL_MS;
    const deadline = Date.now() + boundedWaitMs;
    const recoveryDependencies = lockDependencies();
    const recoveryExpected = { kind: LOCK_KINDS.workspaceMutation, containerName: '' };
    let lastBusyOwner = null;
    let artifactObservation = null;
    let firstAttempt = true;
    while (true) {
        if (!firstAttempt && Date.now() >= deadline) {
            const error = new Error(
                `Timed out waiting for ${lastBusyOwner?.operation || 'workspace mutation'} to release the workspace mutation lease.`
            );
            error.code = 'workspace_mutation_lock_timeout';
            throw error;
        }
        firstAttempt = false;
        try {
            return createWorkspaceMutationLease(lockOptions);
        } catch (error) {
            if (!['PLOINKY_WORKSPACE_MUTATION_BUSY', 'PLOINKY_MAINTENANCE_BUSY'].includes(error?.code)) throw error;
            lastBusyOwner = error.owner || null;
            const observedAt = Date.now();
            artifactObservation = staleConcurrentArtifactObservation(
                error,
                artifactObservation,
                observedAt,
            );
            if (observedAt < deadline
                && artifactObservation
                && observedAt - artifactObservation.firstObservedAt
                    >= CONCURRENT_ARTIFACT_RECOVERY_STABILITY_MS) {
                const recovered = recoverStableConcurrentArtifacts(
                    WORKSPACE_START_LOCK_PATH,
                    recoveryExpected,
                    artifactObservation,
                    recoveryDependencies,
                );
                artifactObservation = null;
                if (recovered) continue;
            }
        }
        if (Date.now() >= deadline) {
            const error = new Error(
                `Timed out waiting for ${lastBusyOwner?.operation || 'workspace mutation'} to release the workspace mutation lease.`
            );
            error.code = 'workspace_mutation_lock_timeout';
            throw error;
        }
        await wait(Math.min(boundedRetryMs, Math.max(1, deadline - Date.now())));
    }
}

function releaseFailure(kind, lease, callbackError, cause = null) {
    const isMaintenance = kind === LOCK_KINDS.maintenance;
    const message = isMaintenance
        ? `maintenance '${lease.operation}' could not release its exact lease`
        : `workspace mutation '${lease.operation}' could not release its exact lease`;
    const error = new Error(message, callbackError ? { cause: callbackError } : undefined);
    error.code = isMaintenance ? 'maintenance_lock_release_failed' : 'workspace_mutation_lock_release_failed';
    if (callbackError) error.callbackError = callbackError;
    if (cause) error.releaseCause = cause;
    return error;
}

async function withWorkspaceMutationLease(options, fn) {
    if (typeof fn !== 'function') throw new TypeError('workspace mutation lease requires a callback');
    const lease = await acquireWorkspaceMutationLease(options);
    let value;
    let callbackError = null;
    try { value = await fn(); } catch (error) { callbackError = error; }
    let released = false;
    let releaseCause = null;
    try { released = releaseWorkspaceMutationLease(lease); } catch (error) { releaseCause = error; }
    if (!released) throw releaseFailure(LOCK_KINDS.workspaceMutation, lease, callbackError, releaseCause);
    if (callbackError) throw callbackError;
    return value;
}

function createWorkspaceStartLock(options = {}, dependencyOverrides = {}) {
    return createWorkspaceMutationLease({ ...options, operation: 'workspace-start' }, dependencyOverrides);
}

function inspectWorkspaceStartLock(dependencyOverrides = {}) {
    const dependencies = lockDependencies(dependencyOverrides);
    const expected = { kind: LOCK_KINDS.workspaceMutation, containerName: '' };
    assertNoLegacyAuthority(expected, dependencies);
    return inspectLock(
        WORKSPACE_START_LOCK_PATH,
        expected,
        dependencies,
    );
}

function renewWorkspaceMutationLease(lock, { ttlMs = WORKSPACE_START_TTL_MS } = {}, dependencyOverrides = {}) {
    if (!lock?.token || !TOKEN_PATTERN.test(lock.token)) return false;
    const dependencies = lockDependencies(dependencyOverrides);
    const expected = { kind: LOCK_KINDS.workspaceMutation, containerName: '' };
    assertNoLegacyAuthority(expected, dependencies);
    recoverInterruptedOperations(WORKSPACE_START_LOCK_PATH, expected, dependencies);
    const snapshot = readLockSnapshot(WORKSPACE_START_LOCK_PATH, expected, dependencies);
    if (!snapshot?.record || snapshot.record.token !== lock.token
        || snapshot.record.ownerPid !== process.pid
        || snapshot.record.ownerUid !== currentUid(dependencies.getUid)) return false;
    const current = inspectLockOwner(snapshot.record, dependencies);
    if (current.state !== 'busy' || current.uncertain) return false;
    const renewalNow = Number(dependencies.now());
    const renewalTtl = Number(ttlMs);
    if (!Number.isFinite(renewalNow) || !Number.isFinite(renewalTtl)) return false;
    let renewedExpiresAt;
    try { renewedExpiresAt = new Date(renewalNow + renewalTtl).toISOString(); } catch (_) { return false; }
    const renewed = canonicalLockRecord({
        ...snapshot.record,
        expiresAt: renewedExpiresAt,
    });
    if (Date.parse(renewed.expiresAt) <= Date.parse(snapshot.record.expiresAt)) return false;
    classifyConcurrentLockArtifacts(WORKSPACE_START_LOCK_PATH, expected, dependencies);
    const contentId = operationId(snapshot);
    const claimPath = `${WORKSPACE_START_LOCK_PATH}.renewal-${contentId}.claim`;
    const candidatePath = `${WORKSPACE_START_LOCK_PATH}.renewal-${contentId}.candidate`;
    const quarantinePath = `${WORKSPACE_START_LOCK_PATH}.renewal-${contentId}.quarantine`;
    const temporaryPath = path.join(
        path.dirname(WORKSPACE_START_LOCK_PATH),
        `.${path.basename(WORKSPACE_START_LOCK_PATH)}.${dependencies.randomUUID()}.renewal.tmp`,
    );
    let claimCreated = false;
    let candidateCreated = false;
    let primaryRenamed = false;
    let preserveEvidence = false;
    let descriptor;
    try {
        try {
            durableLinkSync(WORKSPACE_START_LOCK_PATH, claimPath, expected, dependencies);
            claimCreated = true;
        } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'EEXIST') return false;
            throw error;
        }
        const claim = readLockSnapshotAt(claimPath, expected, dependencies, { minimumLinks: 2, maximumLinks: 2 });
        if (!sameLockSnapshot(claim, snapshot)) return false;
        const current = readLockSnapshotAt(WORKSPACE_START_LOCK_PATH, expected, dependencies, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        if (!sameLockSnapshot(current, snapshot)) return false;
        dependencies.afterRenewalClaim?.({ claimPath, filePath: WORKSPACE_START_LOCK_PATH, previous: snapshot.record });

        descriptor = dependencies.fs.openSync(temporaryPath, 'wx', 0o600);
        dependencies.fs.writeFileSync(descriptor, serializeLockRecord(renewed), 'utf8');
        dependencies.fs.fsyncSync(descriptor);
        dependencies.fs.closeSync(descriptor);
        descriptor = undefined;
        durableLinkSync(temporaryPath, candidatePath, expected, dependencies);
        candidateCreated = true;
        durableUnlinkSync(temporaryPath, expected, dependencies);

        // Revalidate after the test/integration hook and after publishing the
        // private candidate. A successor that already replaced the old owner is
        // never renamed or overwritten.
        const preRenameClaim = readLockSnapshotAt(claimPath, expected, dependencies, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        const preRenameCurrent = readLockSnapshotAt(WORKSPACE_START_LOCK_PATH, expected, dependencies, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        if (!sameLockSnapshot(preRenameClaim, snapshot)
            || !sameLockSnapshot(preRenameCurrent, snapshot)) return false;

        try {
            durableRenameSync(WORKSPACE_START_LOCK_PATH, quarantinePath, expected, dependencies);
            primaryRenamed = true;
        } catch (error) {
            if (error?.lockTransitionApplied) primaryRenamed = true;
            throw error;
        }
        const quarantined = readLockSnapshotAt(quarantinePath, expected, dependencies, {
            minimumLinks: 1,
            maximumLinks: 2,
        });
        if (quarantined.raw !== snapshot.raw) {
            const displacedOwner = inspectLockOwner(quarantined.record, dependencies);
            if (displacedOwner.state === 'busy') {
                const restored = restoreDisplacedPublicationPath(
                    quarantinePath,
                    WORKSPACE_START_LOCK_PATH,
                    quarantined,
                    expected,
                    dependencies,
                );
                if (!restored) throw busyError(quarantined.record, displacedOwner);
            } else {
                durableUnlinkSync(quarantinePath, expected, dependencies);
            }
            durableUnlinkSync(candidatePath, expected, dependencies);
            candidateCreated = false;
            durableUnlinkSync(claimPath, expected, dependencies);
            claimCreated = false;
            return false;
        }
        if (!sameLockSnapshot(quarantined, snapshot)) {
            throw lockError(expected.kind, 'old renewal owner changed before no-clobber publication');
        }

        try {
            durableLinkSync(candidatePath, WORKSPACE_START_LOCK_PATH, expected, dependencies);
        } catch (error) {
            if (error?.code === 'EEXIST') throw busyError(quarantined.record);
            throw error;
        }
        dependencies.afterRenewalReplace?.({
            claimPath,
            filePath: WORKSPACE_START_LOCK_PATH,
            previous: snapshot.record,
            renewed,
        });
        const exact = readLockSnapshot(WORKSPACE_START_LOCK_PATH, expected, dependencies, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        const exactCandidate = readLockSnapshotAt(candidatePath, expected, dependencies, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        const oldClaim = readLockSnapshotAt(claimPath, expected, dependencies, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        const oldQuarantine = readLockSnapshotAt(quarantinePath, expected, dependencies, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        if (!exact || exact.raw !== serializeLockRecord(renewed)
            || !sameLockSnapshot(exact, exactCandidate)
            || !sameLockSnapshot(oldClaim, snapshot)
            || !sameLockSnapshot(oldQuarantine, snapshot)) {
            throw lockError(expected.kind, 'workspace mutation renewal did not remain content-exact');
        }
        durableUnlinkSync(candidatePath, expected, dependencies);
        candidateCreated = false;
        durableUnlinkSync(quarantinePath, expected, dependencies);
        durableUnlinkSync(claimPath, expected, dependencies);
        claimCreated = false;
        Object.assign(lock, renewed);
        return true;
    } catch (error) {
        if (error?.lockDurabilityUncertain) {
            const remainingRenewal = renewalArtifactNames(WORKSPACE_START_LOCK_PATH, dependencies);
            if (remainingRenewal.length === 0) {
                const committed = readLockSnapshotAt(
                    WORKSPACE_START_LOCK_PATH,
                    expected,
                    dependencies,
                    { minimumLinks: 1, maximumLinks: 1 },
                );
                if (committed?.raw === serializeLockRecord(renewed)) {
                    Object.assign(lock, renewed);
                    return true;
                }
            }
            preserveEvidence = true;
        }
        return false;
    } finally {
        if (descriptor !== undefined) {
            try { dependencies.fs.closeSync(descriptor); } catch (_) {}
        }
        try { durableUnlinkSync(temporaryPath, expected, dependencies); } catch (_) {}
        if (!preserveEvidence && candidateCreated && !primaryRenamed) {
            try { durableUnlinkSync(candidatePath, expected, dependencies); } catch (_) {}
        }
        if (!preserveEvidence && claimCreated && !primaryRenamed) {
            try { durableUnlinkSync(claimPath, expected, dependencies); } catch (_) {}
        }
    }
}

function releaseWorkspaceStartLock(lock, dependencyOverrides = {}) {
    if (!lock?.token || !TOKEN_PATTERN.test(lock.token)) return false;
    const dependencies = lockDependencies(dependencyOverrides);
    const expected = { kind: LOCK_KINDS.workspaceMutation, containerName: '' };
    assertNoLegacyAuthority(expected, dependencies);
    recoverInterruptedOperations(WORKSPACE_START_LOCK_PATH, expected, dependencies);
    const snapshot = readLockSnapshot(WORKSPACE_START_LOCK_PATH, expected, dependencies);
    if (!snapshot || snapshot.record.token !== lock.token) return false;
    return removeExactSnapshot(WORKSPACE_START_LOCK_PATH, expected, snapshot, dependencies);
}

const releaseWorkspaceMutationLease = releaseWorkspaceStartLock;

function createMaintenanceLock(containerName, {
    operation = 'maintenance',
    ttlMs = DEFAULT_TTL_MS,
    metadata = {},
} = {}, dependencyOverrides = {}) {
    const exactContainerName = normalizeContainerName(containerName);
    const dependencies = lockDependencies(dependencyOverrides);
    const filePath = lockPathFor(exactContainerName);
    const expected = { kind: LOCK_KINDS.maintenance, containerName: exactContainerName };
    assertNoLegacyAuthority(expected, dependencies);
    classifyConcurrentLockArtifacts(filePath, expected, dependencies);
    dependencies.afterAcquisitionAdmission?.({ filePath, expected });
    const existing = inspectLockForAcquisition(filePath, expected, dependencies);
    if (existing.active) throw busyError(existing.lock);
    const lock = createLockRecord({
        kind: expected.kind,
        containerName: exactContainerName,
        operation,
        ttlMs,
        metadata,
    }, dependencies);
    publishLockRecord(filePath, expected, lock, dependencies);
    return lock;
}

function wait(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function acquireMaintenanceLock(containerName, {
    waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
    ...lockOptions
} = {}) {
    const exactContainerName = normalizeContainerName(containerName);
    const deadline = Date.now() + Math.max(0, Number(waitTimeoutMs) || 0);
    const recoveryDependencies = lockDependencies();
    const recoveryFilePath = lockPathFor(exactContainerName);
    const recoveryExpected = {
        kind: LOCK_KINDS.maintenance,
        containerName: exactContainerName,
    };
    let lastBusyOwner = null;
    let artifactObservation = null;
    let firstAttempt = true;
    while (true) {
        if (!firstAttempt && Date.now() >= deadline) {
            const error = new Error(
                `Timed out waiting for maintenance lock on '${containerName}' held by ${lastBusyOwner?.operation || 'maintenance'}.`
            );
            error.code = 'maintenance_lock_timeout';
            throw error;
        }
        firstAttempt = false;
        try {
            return createMaintenanceLock(exactContainerName, lockOptions);
        } catch (error) {
            if (error?.code !== 'PLOINKY_MAINTENANCE_BUSY') throw error;
            lastBusyOwner = error.owner || null;
            const observedAt = Date.now();
            artifactObservation = staleConcurrentArtifactObservation(
                error,
                artifactObservation,
                observedAt,
            );
            if (observedAt < deadline
                && artifactObservation
                && observedAt - artifactObservation.firstObservedAt
                    >= CONCURRENT_ARTIFACT_RECOVERY_STABILITY_MS) {
                const recovered = recoverStableConcurrentArtifacts(
                    recoveryFilePath,
                    recoveryExpected,
                    artifactObservation,
                    recoveryDependencies,
                );
                artifactObservation = null;
                if (recovered) continue;
            }
        }
        if (Date.now() >= deadline) {
            const error = new Error(
                `Timed out waiting for maintenance lock on '${containerName}' held by ${lastBusyOwner?.operation || 'maintenance'}.`
            );
            error.code = 'maintenance_lock_timeout';
            throw error;
        }
        await wait(Math.min(
            Math.max(1, Number(retryIntervalMs) || DEFAULT_RETRY_INTERVAL_MS),
            Math.max(1, deadline - Date.now()),
        ));
    }
}

async function withMaintenanceLock(containerName, options, fn) {
    if (typeof fn !== 'function') throw new TypeError('maintenance lock requires a callback');
    const lock = await acquireMaintenanceLock(containerName, options);
    let value;
    let callbackError = null;
    try { value = await fn(); } catch (error) { callbackError = error; }
    let released = false;
    let releaseCause = null;
    try { released = removeMaintenanceLock(containerName, lock.token); } catch (error) { releaseCause = error; }
    if (!released) throw releaseFailure(LOCK_KINDS.maintenance, lock, callbackError, releaseCause);
    if (callbackError) throw callbackError;
    return value;
}

function inspectMaintenanceLock(containerName, dependencyOverrides = {}) {
    const exactContainerName = normalizeContainerName(containerName);
    const dependencies = lockDependencies(dependencyOverrides);
    const expected = { kind: LOCK_KINDS.maintenance, containerName: exactContainerName };
    assertNoLegacyAuthority(expected, dependencies);
    return inspectLock(
        lockPathFor(exactContainerName),
        expected,
        dependencies,
    );
}

function removeMaintenanceLock(containerName, token = null, dependencyOverrides = {}) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
    const exactContainerName = normalizeContainerName(containerName);
    const dependencies = lockDependencies(dependencyOverrides);
    const filePath = lockPathFor(exactContainerName);
    const expected = { kind: LOCK_KINDS.maintenance, containerName: exactContainerName };
    assertNoLegacyAuthority(expected, dependencies);
    recoverInterruptedOperations(filePath, expected, dependencies);
    const snapshot = readLockSnapshot(filePath, expected, dependencies);
    if (!snapshot || snapshot.record.token !== token) return false;
    return removeExactSnapshot(filePath, expected, snapshot, dependencies);
}

export {
    WORKSPACE_START_LOCK_PATH,
    acquireMaintenanceLock,
    acquireWorkspaceMutationLease,
    createMaintenanceLock,
    createWorkspaceMutationLease,
    createWorkspaceStartLock,
    inspectMaintenanceLock,
    inspectWorkspaceStartLock,
    releaseWorkspaceStartLock,
    releaseWorkspaceMutationLease,
    renewWorkspaceMutationLease,
    removeMaintenanceLock,
    withMaintenanceLock,
    withWorkspaceMutationLease,
};
