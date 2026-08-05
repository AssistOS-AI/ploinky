import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PLOINKY_DIR } from '../../utils/config.js';
import { debugLog } from '../../utils/utils.js';
import { inspectProcessIdentity, normalizeProcessIdentity } from '../processIdentity.js';

const BWRAP_PIDS_DIR = path.join(PLOINKY_DIR, 'bwrap-pids');
const SANDBOX_OWNER_SCHEMA_VERSION = 5;
const BWRAP_PID_SCHEMA_VERSION = SANDBOX_OWNER_SCHEMA_VERSION;
const SANDBOX_OWNER_ROLES = Object.freeze({
    service: 'service',
    providerTask: 'provider-task',
});
const OWNER_RECORD_SUFFIX = '.owner.json';
const LEGACY_PID_SUFFIX = '.pid';
const MAX_OWNER_RECORD_BYTES = 16 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_TEXT_BYTES = 512;
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OWNER_RECORD_KEYS = Object.freeze([
    'admissionDigest',
    'credentialExpiresAt',
    'credentialNonceDigest',
    'enableGeneration',
    'homeKey',
    'instanceId',
    'logPath',
    'manifestDigest',
    'networkHash',
    'ownerKey',
    'pid',
    'processIdentity',
    'processUid',
    'provider',
    'role',
    'rootPort',
    'routeKey',
    'runtimeKey',
    'schemaVersion',
    'taskId',
    'workdir',
]);
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function ownerError(message, code = 'PLOINKY_SANDBOX_OWNER_INVALID') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function sleepMs(ms) {
    Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function currentProcessUid() {
    if (typeof process.getuid !== 'function') {
        throw ownerError(
            'sandbox ownership requires an exact process uid',
            'PLOINKY_SANDBOX_OWNER_STORE_INVALID',
        );
    }
    const uid = process.getuid();
    if (!Number.isSafeInteger(uid) || uid < 0) {
        throw ownerError(
            'sandbox ownership process uid is invalid',
            'PLOINKY_SANDBOX_OWNER_STORE_INVALID',
        );
    }
    return uid;
}

function exactText(value, label, {
    allowEmpty = false,
    maxBytes = MAX_TEXT_BYTES,
    safeKey = false,
} = {}) {
    if (typeof value !== 'string'
        || value !== value.trim()
        || (!allowEmpty && !value)
        || Buffer.byteLength(value, 'utf8') > maxBytes
        || /[\u0000-\u001f\u007f]/.test(value)
        || (safeKey && value && !/^[A-Za-z0-9_.-]+$/.test(value))) {
        throw ownerError(`sandbox owner ${label} is invalid`);
    }
    return value;
}

function exactAbsolutePath(value, label) {
    const normalized = exactText(value, label, { maxBytes: MAX_PATH_BYTES });
    if (!path.isAbsolute(normalized) || path.normalize(normalized) !== normalized) {
        throw ownerError(`sandbox owner ${label} must be an exact normalized absolute path`);
    }
    return normalized;
}

function exactSha256Digest(value, label) {
    if (typeof value !== 'string' || !SHA256_DIGEST_PATTERN.test(value)) {
        throw ownerError(`sandbox owner ${label} must be an exact sha256 digest`);
    }
    return value;
}

function ensureOwnerDir() {
    const expectedUid = currentProcessUid();
    if (!fs.existsSync(BWRAP_PIDS_DIR)) {
        fs.mkdirSync(BWRAP_PIDS_DIR, { recursive: true, mode: 0o700 });
        fs.chmodSync(BWRAP_PIDS_DIR, 0o700);
    }
    const stat = fs.lstatSync(BWRAP_PIDS_DIR);
    if (!stat.isDirectory()
        || stat.isSymbolicLink()
        || stat.uid !== expectedUid
        || (stat.mode & 0o777) !== 0o700) {
        throw ownerError(
            'sandbox owner directory is not an exact private directory',
            'PLOINKY_SANDBOX_OWNER_STORE_INVALID',
        );
    }
}

function normalizeBwrapRuntimeKey(runtimeKey) {
    if (typeof runtimeKey !== 'string'
        || !runtimeKey
        || runtimeKey !== runtimeKey.trim()
        || Buffer.byteLength(runtimeKey, 'utf8') > 255
        || !/^[A-Za-z0-9_.-]+$/.test(runtimeKey)
        || runtimeKey === '.'
        || runtimeKey === '..') {
        throw ownerError('sandbox runtime key must be an exact safe container name');
    }
    return runtimeKey;
}

function normalizeSandboxRuntimeIdentity(identity) {
    if (!isPlainObject(identity)
        || typeof identity.instanceId !== 'string'
        || identity.instanceId.length === 0
        || typeof identity.enableGeneration !== 'string'
        || identity.enableGeneration.length === 0) {
        throw ownerError('sandbox runtime identity requires exact instanceId and enableGeneration');
    }
    const instanceId = exactText(identity.instanceId, 'instanceId');
    const enableGeneration = exactText(identity.enableGeneration, 'enableGeneration');
    return Object.freeze({ instanceId, enableGeneration });
}

function ownerDigest(namespace, fields) {
    const payload = JSON.stringify([namespace, ...fields]);
    return crypto.createHash('sha256').update(payload).digest('hex');
}

function serviceOwnerKey(runtimeKey) {
    const normalized = normalizeBwrapRuntimeKey(runtimeKey);
    return `service-${ownerDigest('service', [normalized])}`;
}

function providerTaskOwnerKey(runtimeKey, taskId) {
    const normalized = normalizeBwrapRuntimeKey(runtimeKey);
    const exactTaskId = exactText(taskId, 'taskId');
    return `provider-task-${ownerDigest('provider-task', [normalized, exactTaskId])}`;
}

function normalizeRole(role) {
    if (role !== SANDBOX_OWNER_ROLES.service && role !== SANDBOX_OWNER_ROLES.providerTask) {
        throw ownerError("sandbox owner role must be exactly 'service' or 'provider-task'");
    }
    return role;
}

function canonicalOwnerKey({ role, runtimeKey, taskId }) {
    return role === SANDBOX_OWNER_ROLES.service
        ? serviceOwnerKey(runtimeKey)
        : providerTaskOwnerKey(runtimeKey, taskId);
}

function normalizeRoutingAttestation(value, role, {
    allowUnroutedService = false,
    requireFuture = false,
} = {}) {
    if (role === SANDBOX_OWNER_ROLES.providerTask) {
        if (value.routeKey !== ''
            || value.rootPort !== 0
            || value.credentialNonceDigest !== ''
            || value.credentialExpiresAt !== 0
            || value.manifestDigest !== ''
            || value.admissionDigest !== ''
            || value.networkHash !== '') {
            throw ownerError('sandbox provider-task owner must not carry service routing authority');
        }
        return Object.freeze({
            routeKey: '',
            rootPort: 0,
            credentialNonceDigest: '',
            credentialExpiresAt: 0,
            manifestDigest: '',
            admissionDigest: '',
            networkHash: '',
        });
    }

    const unroutedService = (value.routeKey === undefined || value.routeKey === '')
        && (value.rootPort === undefined || value.rootPort === 0)
        && (value.credentialNonceDigest === undefined || value.credentialNonceDigest === '')
        && (value.credentialExpiresAt === undefined || value.credentialExpiresAt === 0)
        && (value.manifestDigest === undefined || value.manifestDigest === '')
        && (value.admissionDigest === undefined || value.admissionDigest === '')
        && (value.networkHash === undefined || value.networkHash === '');
    if (unroutedService && allowUnroutedService) {
        return Object.freeze({
            routeKey: '',
            rootPort: 0,
            credentialNonceDigest: '',
            credentialExpiresAt: 0,
            manifestDigest: '',
            admissionDigest: '',
            networkHash: '',
        });
    }

    const routeKey = exactText(value.routeKey, 'routeKey', {
        maxBytes: 255,
        safeKey: true,
    });
    if (routeKey === '.' || routeKey === '..') {
        throw ownerError('sandbox service owner routeKey is not a safe key');
    }
    if (typeof value.rootPort !== 'number'
        || !Number.isSafeInteger(value.rootPort)
        || value.rootPort < 1
        || value.rootPort > 65535) {
        throw ownerError('sandbox service owner rootPort must be an exact TCP port');
    }
    if (typeof value.credentialExpiresAt !== 'number'
        || !Number.isSafeInteger(value.credentialExpiresAt)
        || value.credentialExpiresAt <= 0
        || (requireFuture && value.credentialExpiresAt <= Math.floor(Date.now() / 1000))) {
        throw ownerError('sandbox service owner credentialExpiresAt must be an exact future timestamp');
    }
    return Object.freeze({
        routeKey,
        rootPort: value.rootPort,
        credentialNonceDigest: exactSha256Digest(
            value.credentialNonceDigest,
            'credentialNonceDigest',
        ),
        credentialExpiresAt: value.credentialExpiresAt,
        manifestDigest: exactSha256Digest(value.manifestDigest, 'manifestDigest'),
        admissionDigest: exactSha256Digest(value.admissionDigest, 'admissionDigest'),
        networkHash: exactSha256Digest(value.networkHash, 'networkHash'),
    });
}

function normalizeOwnerMetadata(value, options = {}) {
    if (!isPlainObject(value)) throw ownerError('sandbox owner record must be a plain object');
    const role = normalizeRole(value.role);
    const runtimeKey = normalizeBwrapRuntimeKey(value.runtimeKey);
    const identity = normalizeSandboxRuntimeIdentity(value);
    const homeKey = exactText(value.homeKey, 'homeKey', { safeKey: true, maxBytes: 255 });
    if (homeKey === '.' || homeKey === '..') {
        throw ownerError('sandbox owner homeKey is invalid');
    }
    const workdir = exactAbsolutePath(value.workdir, 'workdir');
    const logPath = exactAbsolutePath(value.logPath, 'logPath');
    const taskId = exactText(value.taskId ?? '', 'taskId', {
        allowEmpty: role === SANDBOX_OWNER_ROLES.service,
    });
    const provider = exactText(value.provider ?? '', 'provider', {
        allowEmpty: role === SANDBOX_OWNER_ROLES.service,
    });
    if (role === SANDBOX_OWNER_ROLES.service && (taskId || provider)) {
        throw ownerError('sandbox service owner requires empty taskId and provider');
    }
    if (role === SANDBOX_OWNER_ROLES.providerTask && (!taskId || !provider)) {
        throw ownerError('sandbox provider-task owner requires exact taskId and provider');
    }
    const ownerKey = canonicalOwnerKey({ role, runtimeKey, taskId });
    if (value.ownerKey !== undefined && value.ownerKey !== ownerKey) {
        throw ownerError('sandbox ownerKey does not match the canonical role/runtime identity');
    }
    const routingAttestation = normalizeRoutingAttestation(value, role, options);
    return Object.freeze({
        role,
        runtimeKey,
        ownerKey,
        ...identity,
        homeKey,
        workdir,
        logPath,
        taskId,
        provider,
        ...routingAttestation,
    });
}

function ownerFile(ownerKey) {
    const normalized = exactText(ownerKey, 'ownerKey', { safeKey: true });
    return path.join(BWRAP_PIDS_DIR, `${normalized}${OWNER_RECORD_SUFFIX}`);
}

function legacyPidFile(runtimeKey) {
    return path.join(BWRAP_PIDS_DIR, `${normalizeBwrapRuntimeKey(runtimeKey)}${LEGACY_PID_SUFFIX}`);
}

function inspectSandboxOwnerProcess(record) {
    const expectedUid = currentProcessUid();
    try {
        process.kill(record.pid, 0);
    } catch (error) {
        if (error?.code !== 'EPERM') return Object.freeze({ state: 'dead' });
    }
    const identityInspection = inspectProcessIdentity(record.pid);
    if (identityInspection.state === 'dead') return Object.freeze({ state: 'dead' });
    if (identityInspection.state === 'uid-diverged') {
        return Object.freeze({
            state: 'unknown',
            processUid: identityInspection.processUid,
        });
    }
    if (identityInspection.state !== 'identified') {
        try {
            process.kill(record.pid, 0);
        } catch (error) {
            if (error?.code !== 'EPERM') return Object.freeze({ state: 'dead' });
        }
        return Object.freeze({ state: 'unknown' });
    }
    const processIdentity = identityInspection.processIdentity;
    const processUid = identityInspection.processUid;
    const identityMatches = processIdentity === record.processIdentity;
    const uidMatches = processUid === record.processUid && record.processUid === expectedUid;
    return Object.freeze({
        state: identityMatches ? (uidMatches ? 'exact' : 'unknown') : 'pid-reused',
        processIdentity,
        processUid,
    });
}

function validateStoredOwner(parsed, expectedOwnerKey) {
    if (!isPlainObject(parsed)
        || JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(OWNER_RECORD_KEYS)
        || parsed.schemaVersion !== SANDBOX_OWNER_SCHEMA_VERSION) {
        throw ownerError(
            `sandbox owner ${expectedOwnerKey} has an invalid or pre-v${SANDBOX_OWNER_SCHEMA_VERSION} record`,
            'PLOINKY_SANDBOX_OWNER_RECORD_INVALID',
        );
    }
    const metadata = normalizeOwnerMetadata(parsed, { allowUnroutedService: true });
    const pid = Number(parsed.pid);
    const processUid = Number(parsed.processUid);
    let processIdentity;
    try {
        processIdentity = normalizeProcessIdentity(parsed.processIdentity);
    } catch (cause) {
        throw ownerError(
            `sandbox owner ${expectedOwnerKey} processIdentity is invalid: ${cause?.message || cause}`,
            'PLOINKY_SANDBOX_OWNER_RECORD_INVALID',
        );
    }
    if (metadata.ownerKey !== expectedOwnerKey
        || parsed.ownerKey !== expectedOwnerKey
        || typeof parsed.pid !== 'number'
        || !Number.isSafeInteger(pid)
        || pid <= 0
        || typeof parsed.processUid !== 'number'
        || !Number.isSafeInteger(processUid)
        || processUid < 0) {
        throw ownerError(
            `sandbox owner ${expectedOwnerKey} record does not match its exact authority key`,
            'PLOINKY_SANDBOX_OWNER_RECORD_INVALID',
        );
    }
    return Object.freeze({
        schemaVersion: SANDBOX_OWNER_SCHEMA_VERSION,
        ...metadata,
        pid,
        processUid,
        processIdentity,
    });
}

function canonicalOwnerPayload(record) {
    return `${JSON.stringify(record)}\n`;
}

function readOwnerSnapshotAt(file, expectedOwnerKey, {
    minimumLinks = 1,
    maximumLinks = 1,
} = {}) {
    const expectedUid = currentProcessUid();
    let fd = -1;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()
            || stat.nlink < minimumLinks
            || stat.nlink > maximumLinks
            || stat.uid !== expectedUid
            || stat.size <= 0
            || stat.size > MAX_OWNER_RECORD_BYTES
            || (stat.mode & 0o777) !== 0o600) {
            throw ownerError(
                `sandbox owner ${expectedOwnerKey} file is not an exact private bounded record`,
                'PLOINKY_SANDBOX_OWNER_RECORD_INVALID',
            );
        }
        const bytes = fs.readFileSync(fd, 'utf8');
        let parsed;
        try {
            parsed = JSON.parse(bytes);
        } catch (cause) {
            throw ownerError(
                `sandbox owner ${expectedOwnerKey} record is malformed: ${cause?.message || cause}`,
                'PLOINKY_SANDBOX_OWNER_RECORD_INVALID',
            );
        }
        const record = validateStoredOwner(parsed, expectedOwnerKey);
        if (bytes !== canonicalOwnerPayload(record)) {
            throw ownerError(
                `sandbox owner ${expectedOwnerKey} record is not exact canonical v${SANDBOX_OWNER_SCHEMA_VERSION} JSON`,
                'PLOINKY_SANDBOX_OWNER_RECORD_INVALID',
            );
        }
        return Object.freeze({
            record,
            raw: bytes,
            dev: stat.dev,
            ino: stat.ino,
            mode: stat.mode,
            size: stat.size,
        });
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error?.code === 'ELOOP') {
            throw ownerError(
                `sandbox owner ${expectedOwnerKey} file must not be a symlink`,
                'PLOINKY_SANDBOX_OWNER_RECORD_INVALID',
            );
        }
        throw error;
    } finally {
        if (fd >= 0) fs.closeSync(fd);
    }
}

function readOwnerSnapshot(expectedOwnerKey, options = {}) {
    return readOwnerSnapshotAt(ownerFile(expectedOwnerKey), expectedOwnerKey, options);
}

function readOwnerFile(expectedOwnerKey) {
    return readOwnerSnapshot(expectedOwnerKey)?.record ?? null;
}

function ownerOperationId(snapshot) {
    return crypto.createHash('sha256').update(snapshot.raw).digest('hex').slice(0, 32);
}

function recoverOwnerOperationArtifacts() {
    const pattern = /^(?<ownerKey>[A-Za-z0-9_.-]+\.owner\.json)\.operation-(?<operationId>[a-f0-9]{32})\.(?<kind>claim|quarantine)$/;
    const names = fs.readdirSync(BWRAP_PIDS_DIR)
        .filter((name) => name.includes('.owner.json.operation-'));
    const groups = new Map();
    for (const name of names) {
        const match = name.match(pattern);
        if (!match?.groups) {
            throw ownerError(
                `sandbox ownership store contains malformed operation entry '${name}'`,
                'PLOINKY_SANDBOX_OWNER_STORE_INVALID',
            );
        }
        const canonicalOwnerKey = match.groups.ownerKey.slice(0, -OWNER_RECORD_SUFFIX.length);
        const groupKey = `${canonicalOwnerKey}:${match.groups.operationId}`;
        if (!groups.has(groupKey)) {
            groups.set(groupKey, {
                ownerKey: canonicalOwnerKey,
                operationId: match.groups.operationId,
                artifacts: new Map(),
            });
        }
        const group = groups.get(groupKey);
        if (group.artifacts.has(match.groups.kind)) {
            throw ownerError(
                `sandbox owner ${canonicalOwnerKey} has duplicate operation state`,
                'PLOINKY_SANDBOX_OWNER_STORE_INVALID',
            );
        }
        group.artifacts.set(match.groups.kind, path.join(BWRAP_PIDS_DIR, name));
    }

    const ownerKeys = new Set();
    for (const group of groups.values()) {
        if (ownerKeys.has(group.ownerKey)) {
            throw ownerError(
                `sandbox owner ${group.ownerKey} has multiple interrupted operations`,
                'PLOINKY_SANDBOX_OWNER_STORE_INVALID',
            );
        }
        ownerKeys.add(group.ownerKey);
        const claim = group.artifacts.has('claim')
            ? readOwnerSnapshotAt(group.artifacts.get('claim'), group.ownerKey, {
                minimumLinks: 1,
                maximumLinks: 2,
            })
            : null;
        const quarantine = group.artifacts.has('quarantine')
            ? readOwnerSnapshotAt(group.artifacts.get('quarantine'), group.ownerKey, {
                minimumLinks: 1,
                maximumLinks: 2,
            })
            : null;
        const operationSnapshot = claim || quarantine;
        if (
            !operationSnapshot
            || ownerOperationId(operationSnapshot) !== group.operationId
            || (claim && quarantine && !sameOwnerSnapshot(claim, quarantine))
        ) {
            throw ownerError(
                `sandbox owner ${group.ownerKey} operation state is not exact`,
                'PLOINKY_SANDBOX_OWNER_STORE_INVALID',
            );
        }
        if (isExactSandboxOwnerProcess(operationSnapshot.record)) {
            throw ownerError(
                `sandbox owner ${group.ownerKey} interrupted removal still belongs to a live process`,
                'PLOINKY_SANDBOX_OWNER_SLOT_BUSY',
            );
        }

        // Operation paths are not owner authorities. Clean only these exact
        // dead/PID-reused artifacts and never the canonical successor path.
        if (quarantine) fs.unlinkSync(group.artifacts.get('quarantine'));
        if (claim) fs.unlinkSync(group.artifacts.get('claim'));
    }
}

function assertOwnerDirectoryCurrent() {
    if (!fs.existsSync(BWRAP_PIDS_DIR)) return;
    ensureOwnerDir();
    recoverOwnerOperationArtifacts();
    for (const name of fs.readdirSync(BWRAP_PIDS_DIR)) {
        if (name.startsWith('.') && name.endsWith('.tmp')) continue;
        if (name.endsWith(LEGACY_PID_SUFFIX)) {
            throw ownerError(
                `sandbox ownership store contains a pre-v${SANDBOX_OWNER_SCHEMA_VERSION} PID record`,
                'PLOINKY_SANDBOX_OWNER_RECORD_INVALID',
            );
        }
        if (!name.endsWith(OWNER_RECORD_SUFFIX)) {
            throw ownerError(
                `sandbox ownership store contains unexpected entry '${name}'`,
                'PLOINKY_SANDBOX_OWNER_STORE_INVALID',
            );
        }
        const key = name.slice(0, -OWNER_RECORD_SUFFIX.length);
        readOwnerFile(key);
    }
}

function readSandboxOwner(ownerKey) {
    assertOwnerDirectoryCurrent();
    return readOwnerFile(ownerKey);
}

function readServiceOwner(runtimeKey) {
    const normalized = normalizeBwrapRuntimeKey(runtimeKey);
    if (fs.existsSync(legacyPidFile(normalized))) {
        throw ownerError(
            `sandbox runtime ${normalized} has a pre-v${SANDBOX_OWNER_SCHEMA_VERSION} PID record`,
            'PLOINKY_SANDBOX_OWNER_RECORD_INVALID',
        );
    }
    return readSandboxOwner(serviceOwnerKey(normalized));
}

function readProviderTaskOwner(runtimeKey, taskId) {
    return readSandboxOwner(providerTaskOwnerKey(runtimeKey, taskId));
}

function sameOwnerRecord(left, right) {
    return Boolean(left && right)
        && OWNER_RECORD_KEYS.every((key) => left[key] === right[key]);
}

function sameOwnerSnapshot(left, right) {
    return Boolean(left && right)
        && left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.size === right.size
        && left.raw === right.raw;
}

function ownerMatchesExpected(record, expected) {
    if (expected === undefined) return true;
    const identity = normalizeSandboxRuntimeIdentity(expected);
    if (record.instanceId !== identity.instanceId
        || record.enableGeneration !== identity.enableGeneration) return false;
    for (const field of [
        'role',
        'runtimeKey',
        'ownerKey',
        'homeKey',
        'workdir',
        'logPath',
        'taskId',
        'provider',
        'pid',
        'processIdentity',
        'processUid',
        'routeKey',
        'rootPort',
        'credentialNonceDigest',
        'credentialExpiresAt',
        'manifestDigest',
        'admissionDigest',
        'networkHash',
    ]) {
        if (expected[field] !== undefined && expected[field] !== record[field]) return false;
    }
    return true;
}

function isExactSandboxOwnerProcess(record) {
    if (!record) return false;
    const inspection = inspectSandboxOwnerProcess(record);
    if (inspection.state === 'unknown') {
        throw ownerError(
            `cannot prove sandbox owner ${record.ownerKey} process identity`,
            'PLOINKY_SANDBOX_OWNER_IDENTITY_UNVERIFIED',
        );
    }
    return inspection.state === 'exact';
}

function normalizeExactServiceOwnerAttestation(expected) {
    try {
        if (!isPlainObject(expected)) throw ownerError('expected service owner must be a plain object');
        const expectedOwnerKey = serviceOwnerKey(expected.runtimeKey);
        const expectedRecord = validateStoredOwner(expected, expectedOwnerKey);
        if (expectedRecord.role !== SANDBOX_OWNER_ROLES.service) {
            throw ownerError('expected owner must be an exact service record');
        }
        return expectedRecord;
    } catch (cause) {
        throw ownerError(
            `exact service owner expectation is invalid: ${cause?.message || cause}`,
            'PLOINKY_SANDBOX_OWNER_ATTESTATION_MISMATCH',
        );
    }
}

function assertExactServiceOwner(expected, { now = Math.floor(Date.now() / 1000) } = {}) {
    const expectedRecord = normalizeExactServiceOwnerAttestation(expected);
    if (!Number.isSafeInteger(now) || now < 0) {
        throw ownerError(
            'exact service owner verification time is invalid',
            'PLOINKY_SANDBOX_OWNER_ATTESTATION_MISMATCH',
        );
    }
    const record = readServiceOwner(expectedRecord.runtimeKey);
    if (!record || !sameOwnerRecord(record, expectedRecord)) {
        throw ownerError(
            `sandbox service owner ${expectedRecord.ownerKey} does not match its immutable attestation`,
            'PLOINKY_SANDBOX_OWNER_ATTESTATION_MISMATCH',
        );
    }
    if (record.credentialExpiresAt <= now) {
        throw ownerError(
            `sandbox service owner ${record.ownerKey} credential attestation expired`,
            'PLOINKY_SANDBOX_OWNER_ATTESTATION_EXPIRED',
        );
    }
    if (!isExactSandboxOwnerProcess(record)) {
        throw ownerError(
            `sandbox service owner ${record.ownerKey} process no longer matches its immutable attestation`,
            'PLOINKY_SANDBOX_OWNER_ATTESTATION_MISMATCH',
        );
    }
    return record;
}

function clearOwnerIfExact(record) {
    const file = ownerFile(record.ownerKey);
    const snapshot = readOwnerSnapshot(record.ownerKey);
    if (!snapshot || !sameOwnerRecord(snapshot.record, record)) return false;
    const operationId = ownerOperationId(snapshot);
    const operationBase = `${file}.operation-${operationId}`;
    const claimFile = `${operationBase}.claim`;
    const quarantineFile = `${operationBase}.quarantine`;
    let claimCreated = false;
    let primaryRenamed = false;

    try {
        try {
            fs.linkSync(file, claimFile);
            claimCreated = true;
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw error;
        }

        const operationPrefix = `${path.basename(file)}.operation-`;
        const competingArtifacts = fs.readdirSync(BWRAP_PIDS_DIR)
            .filter((name) => name.startsWith(operationPrefix))
            .filter((name) => name !== path.basename(claimFile));
        if (competingArtifacts.length > 0) {
            throw ownerError(
                `sandbox owner ${record.ownerKey} has concurrent exact-removal operations`,
                'PLOINKY_SANDBOX_OWNER_STORE_INVALID',
            );
        }

        const claim = readOwnerSnapshotAt(claimFile, record.ownerKey, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        if (!sameOwnerSnapshot(claim, snapshot)) return false;

        // Rename is the atomic release point. A successor may claim the
        // primary path immediately; cleanup never touches that path again.
        primaryRenamed = true;
        fs.renameSync(file, quarantineFile);
        const postClaim = readOwnerSnapshotAt(claimFile, record.ownerKey, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        const quarantined = readOwnerSnapshotAt(quarantineFile, record.ownerKey, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        if (
            !sameOwnerSnapshot(postClaim, snapshot)
            || !sameOwnerSnapshot(quarantined, snapshot)
        ) {
            throw ownerError(
                `sandbox owner ${record.ownerKey} changed during exact removal`,
                'PLOINKY_SANDBOX_OWNER_STORE_INVALID',
            );
        }

        fs.unlinkSync(quarantineFile);
        fs.unlinkSync(claimFile);
        return true;
    } catch (error) {
        if (claimCreated && !primaryRenamed) {
            try { fs.unlinkSync(claimFile); } catch (_) { }
        }
        throw error;
    }
}

function publishOwnerRecord(record) {
    ensureOwnerDir();
    const file = ownerFile(record.ownerKey);
    const tempFile = path.join(
        BWRAP_PIDS_DIR,
        `.${record.ownerKey}.${process.pid}.${Date.now()}.tmp`,
    );
    const payload = canonicalOwnerPayload(record);
    try {
        fs.writeFileSync(tempFile, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        try {
            fs.linkSync(tempFile, file);
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            throw ownerError(
                `sandbox owner ${record.ownerKey} was claimed concurrently`,
                'PLOINKY_SANDBOX_OWNER_SLOT_BUSY',
            );
        }
        // The hard link retains the private temporary inode's 0600 mode. The
        // canonical path is the publication boundary and is never mutated.
    } finally {
        try { fs.unlinkSync(tempFile); } catch (_) { }
    }
}

function saveSandboxOwner(value, { allowUnroutedService = false } = {}) {
    assertOwnerDirectoryCurrent();
    const metadata = normalizeOwnerMetadata(value, {
        allowUnroutedService,
        requireFuture: true,
    });
    const pid = Number(value.pid);
    const processUid = currentProcessUid();
    const processInspection = inspectProcessIdentity(pid);
    const processIdentity = processInspection.processIdentity || '';
    if (typeof value.pid !== 'number'
        || !Number.isSafeInteger(pid)
        || pid <= 0
        || processInspection.state !== 'identified'
        || processInspection.processUid !== processUid
        || !processIdentity) {
        throw ownerError(`cannot bind sandbox owner ${metadata.ownerKey} to an exact live uid/process identity`);
    }
    const record = Object.freeze({
        schemaVersion: SANDBOX_OWNER_SCHEMA_VERSION,
        ...metadata,
        pid,
        processUid,
        processIdentity,
    });
    const existing = readOwnerFile(metadata.ownerKey);
    if (existing) {
        if (sameOwnerRecord(existing, record) && isExactSandboxOwnerProcess(existing)) return existing;
        if (isExactSandboxOwnerProcess(existing)) {
            throw ownerError(
                `sandbox owner ${metadata.ownerKey} is already bound to a live process`,
                'PLOINKY_SANDBOX_OWNER_SLOT_BUSY',
            );
        }
        clearOwnerIfExact(existing);
    }
    publishOwnerRecord(record);
    return record;
}

function saveServiceOwner(value) {
    return saveSandboxOwner({
        ...value,
        role: SANDBOX_OWNER_ROLES.service,
        ownerKey: serviceOwnerKey(value?.runtimeKey),
        taskId: '',
        provider: '',
    });
}

function saveProviderTaskOwner(value) {
    return saveSandboxOwner({
        ...value,
        role: SANDBOX_OWNER_ROLES.providerTask,
        ownerKey: providerTaskOwnerKey(value?.runtimeKey, value?.taskId),
        routeKey: '',
        rootPort: 0,
        credentialNonceDigest: '',
        credentialExpiresAt: 0,
        manifestDigest: '',
        admissionDigest: '',
        networkHash: '',
    });
}

function isSandboxOwnerRunning(ownerKey, expected) {
    if (expected === undefined) {
        throw ownerError('exact sandbox owner check requires instanceId and enableGeneration');
    }
    const record = readSandboxOwner(ownerKey);
    if (!record || !ownerMatchesExpected(record, expected)) return false;
    if (isExactSandboxOwnerProcess(record)) return true;
    clearOwnerIfExact(record);
    return false;
}

function listSandboxOwners({ role, runtimeKey } = {}) {
    assertOwnerDirectoryCurrent();
    if (!fs.existsSync(BWRAP_PIDS_DIR)) return Object.freeze([]);
    const exactRole = role === undefined ? '' : normalizeRole(role);
    const exactRuntimeKey = runtimeKey === undefined ? '' : normalizeBwrapRuntimeKey(runtimeKey);
    const owners = fs.readdirSync(BWRAP_PIDS_DIR)
        .filter((name) => name.endsWith(OWNER_RECORD_SUFFIX))
        .map((name) => readOwnerFile(name.slice(0, -OWNER_RECORD_SUFFIX.length)))
        .filter((record) => record
            && (!exactRole || record.role === exactRole)
            && (!exactRuntimeKey || record.runtimeKey === exactRuntimeKey))
        .sort((left, right) => left.ownerKey.localeCompare(right.ownerKey));
    return Object.freeze(owners);
}

function listServiceOwners(options = {}) {
    return listSandboxOwners({ ...options, role: SANDBOX_OWNER_ROLES.service });
}

function listProviderTaskOwners(options = {}) {
    return listSandboxOwners({ ...options, role: SANDBOX_OWNER_ROLES.providerTask });
}

function signalExactOwner(record, signal) {
    if (!isExactSandboxOwnerProcess(record)) return true;
    try {
        process.kill(-record.pid, signal);
        debugLog(`[sandbox] ${record.ownerKey}: sent ${signal} to process group ${record.pid}`);
        return true;
    } catch (groupError) {
        if (groupError?.code === 'ESRCH') return true;
        if (!isExactSandboxOwnerProcess(record)) return true;
        try {
            process.kill(record.pid, signal);
            debugLog(`[sandbox] ${record.ownerKey}: sent ${signal} to process ${record.pid}`);
            return true;
        } catch (processError) {
            if (processError?.code === 'ESRCH') return true;
            debugLog(`[sandbox] ${record.ownerKey}: signal failed: ${processError?.message || processError}`);
            return false;
        }
    }
}

function waitForOwnerExit(record, timeout) {
    const deadline = Date.now() + Math.max(0, timeout);
    while (Date.now() < deadline) {
        if (!isExactSandboxOwnerProcess(record)) return true;
        sleepMs(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    return !isExactSandboxOwnerProcess(record);
}

function stopSandboxOwner(ownerKey, {
    expected,
    signal = 'SIGTERM',
    timeout = 5000,
    killTimeout = 1000,
} = {}) {
    if (expected === undefined) {
        throw ownerError('exact sandbox owner stop requires instanceId and enableGeneration');
    }
    const record = readSandboxOwner(ownerKey);
    if (!record || !ownerMatchesExpected(record, expected)) return false;
    if (!isExactSandboxOwnerProcess(record)) {
        clearOwnerIfExact(record);
        return true;
    }
    if (!signalExactOwner(record, signal)) return false;
    if (!waitForOwnerExit(record, timeout)) {
        if (!isExactSandboxOwnerProcess(record)) {
            clearOwnerIfExact(record);
            return true;
        }
        if (!signalExactOwner(record, 'SIGKILL') || !waitForOwnerExit(record, killTimeout)) {
            return false;
        }
    }
    clearOwnerIfExact(record);
    return true;
}

function stopSandboxOwners(owners, options = {}) {
    if (!Array.isArray(owners)) throw ownerError('sandbox owners must be an array');
    const stopped = [];
    for (const owner of owners) {
        if (!owner || typeof owner.ownerKey !== 'string') {
            throw ownerError('sandbox owner stop list requires exact owner records');
        }
        if (stopSandboxOwner(owner.ownerKey, { ...options, expected: owner })) {
            stopped.push(owner.ownerKey);
        }
    }
    return stopped;
}

/** Stop every exact service/task owner and return the stopped ownerKey values. */
function stopAllSandboxOwners(options = {}) {
    return stopSandboxOwners([...listSandboxOwners()], options);
}

function assertBwrapPidSlotAvailable(runtimeKey) {
    const normalized = normalizeBwrapRuntimeKey(runtimeKey);
    const record = readServiceOwner(normalized);
    if (!record) return;
    if (isExactSandboxOwnerProcess(record)) {
        throw ownerError(
            `sandbox service ${normalized} is already bound to a live process`,
            'PLOINKY_SANDBOX_OWNER_SLOT_BUSY',
        );
    }
    clearOwnerIfExact(record);
}

function saveBwrapPid(runtimeKey, pid, runtimeIdentity) {
    const hasRoutingAttestation = Boolean(runtimeIdentity?.routeKey);
    if (!hasRoutingAttestation) {
        return saveSandboxOwner({
            ...runtimeIdentity,
            role: SANDBOX_OWNER_ROLES.service,
            ownerKey: serviceOwnerKey(runtimeKey),
            runtimeKey,
            pid,
            taskId: '',
            provider: '',
            routeKey: '',
            rootPort: 0,
            credentialNonceDigest: '',
            credentialExpiresAt: 0,
            manifestDigest: '',
            admissionDigest: '',
            networkHash: '',
        }, { allowUnroutedService: true });
    }
    return saveServiceOwner({
        ...runtimeIdentity,
        runtimeKey,
        pid,
    });
}

function getBwrapPid(runtimeKey, expectedIdentity = undefined) {
    const record = readServiceOwner(runtimeKey);
    if (!record || !ownerMatchesExpected(record, expectedIdentity)) return 0;
    if (!isExactSandboxOwnerProcess(record)) {
        clearOwnerIfExact(record);
        return 0;
    }
    return record.pid;
}

function clearBwrapPid(runtimeKey, expectedIdentity = undefined) {
    const record = readServiceOwner(runtimeKey);
    if (!record || !ownerMatchesExpected(record, expectedIdentity)) return false;
    return clearOwnerIfExact(record);
}

function isBwrapProcessRunning(runtimeKey, expectedIdentity = undefined) {
    const record = readServiceOwner(runtimeKey);
    if (!record || !ownerMatchesExpected(record, expectedIdentity)) return false;
    if (isExactSandboxOwnerProcess(record)) return true;
    clearOwnerIfExact(record);
    return false;
}

function stopBwrapProcess(runtimeKey, {
    signal = 'SIGTERM',
    timeout = 5000,
    expectedIdentity = undefined,
} = {}) {
    const record = readServiceOwner(runtimeKey);
    if (!record || !ownerMatchesExpected(record, expectedIdentity)) return false;
    return stopSandboxOwner(record.ownerKey, {
        expected: record,
        signal,
        timeout,
    });
}

function stopBwrapProcesses(runtimeKeys, {
    signal = 'SIGTERM',
    timeout = 5000,
    expectedIdentities = undefined,
} = {}) {
    if (!Array.isArray(runtimeKeys) || !runtimeKeys.length) return [];
    const stopped = [];
    const seen = new Set();
    for (const requestedKey of runtimeKeys) {
        const runtimeKey = normalizeBwrapRuntimeKey(requestedKey);
        if (seen.has(runtimeKey)) continue;
        seen.add(runtimeKey);
        const record = readServiceOwner(runtimeKey);
        if (!record) continue;
        const expectedIdentity = expectedIdentities instanceof Map
            ? expectedIdentities.get(runtimeKey)
            : undefined;
        if (!ownerMatchesExpected(record, expectedIdentity)) continue;
        if (stopSandboxOwner(record.ownerKey, {
            expected: record,
            signal,
            timeout,
        })) {
            stopped.push(runtimeKey);
        }
    }
    return stopped;
}

/** Stop exact service owners only and preserve the historical runtimeKey[] result shape. */
function stopAllBwrapProcesses(options = {}) {
    const stopped = [];
    for (const owner of listServiceOwners()) {
        if (stopSandboxOwner(owner.ownerKey, { ...options, expected: owner })) {
            stopped.push(owner.runtimeKey);
        }
    }
    return stopped;
}

export {
    BWRAP_PIDS_DIR,
    BWRAP_PID_SCHEMA_VERSION,
    SANDBOX_OWNER_ROLES,
    SANDBOX_OWNER_SCHEMA_VERSION,
    assertExactServiceOwner,
    assertBwrapPidSlotAvailable,
    clearBwrapPid,
    getBwrapPid,
    isBwrapProcessRunning,
    isSandboxOwnerRunning,
    listProviderTaskOwners,
    listSandboxOwners,
    listServiceOwners,
    normalizeExactServiceOwnerAttestation,
    normalizeBwrapRuntimeKey,
    normalizeSandboxRuntimeIdentity,
    providerTaskOwnerKey,
    readProviderTaskOwner,
    readSandboxOwner,
    readServiceOwner,
    saveBwrapPid,
    saveProviderTaskOwner,
    saveSandboxOwner,
    saveServiceOwner,
    serviceOwnerKey,
    stopAllBwrapProcesses,
    stopAllSandboxOwners,
    stopBwrapProcess,
    stopBwrapProcesses,
    stopSandboxOwner,
    stopSandboxOwners,
};
