import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { appendLog } from '../server/utils/logger.js';
import { DEPS_DIR, PLOINKY_WORKSPACE_ROOT, RUNNING_DIR } from '../utils/config.js';
import {
    addSessionContainer,
    cleanupSessionSet,
    destroyWorkspaceContainers
} from '../sandbox/docker/index.js';
import { debugLog } from '../utils/utils.js';
import { resolvePersistedRouterPort } from '../sandbox/routerPort.js';
import { inspectProcessIdentity, normalizeProcessIdentity } from '../sandbox/processIdentity.js';

const ROUTER_PROCESS_RECORD_SCHEMA = 1;
const ROUTER_PROCESS_RECORD_KEYS = Object.freeze([
    'pid',
    'processIdentity',
    'processUid',
    'schema',
    'workspaceRoot',
]);
const MAX_ROUTER_PROCESS_RECORD_BYTES = 4096;
const ROUTER_OPERATION_PATTERN_SUFFIX = '\\.operation-(?<operationId>[a-f0-9]{32})\\.(?<kind>claim|quarantine)$';
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function routerOwnerError(message, code = 'PLOINKY_ROUTER_OWNER_RECORD_INVALID') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function sleepMs(milliseconds) {
    Atomics.wait(SLEEP_ARRAY, 0, 0, milliseconds);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function currentProcessUid() {
    if (typeof process.getuid !== 'function') {
        throw routerOwnerError(
            'Router process ownership requires an operating-system UID',
            'PLOINKY_ROUTER_OWNER_STORE_INVALID',
        );
    }
    const uid = process.getuid();
    if (!Number.isSafeInteger(uid) || uid < 0) {
        throw routerOwnerError(
            'Router process ownership found an invalid operating-system UID',
            'PLOINKY_ROUTER_OWNER_STORE_INVALID',
        );
    }
    return uid;
}

function normalizeWorkspaceRoot(workspaceRoot) {
    if (typeof workspaceRoot !== 'string'
        || !workspaceRoot
        || workspaceRoot.includes('\0')
        || workspaceRoot.includes('\n')
        || workspaceRoot.includes('\r')
        || !path.isAbsolute(workspaceRoot)
        || path.normalize(workspaceRoot) !== workspaceRoot) {
        throw routerOwnerError('Router process ownership workspace root is not canonical');
    }
    return workspaceRoot;
}

function normalizeRouterProcessRecord(candidate, {
    expectedWorkspaceRoot,
    expectedUid = currentProcessUid(),
} = {}) {
    if (!isPlainObject(candidate)) {
        throw routerOwnerError('Router process ownership record must be a plain object');
    }
    const keys = Object.keys(candidate).sort();
    if (keys.length !== ROUTER_PROCESS_RECORD_KEYS.length
        || keys.some((key, index) => key !== ROUTER_PROCESS_RECORD_KEYS[index])) {
        throw routerOwnerError('Router process ownership record fields are invalid');
    }
    if (candidate.schema !== ROUTER_PROCESS_RECORD_SCHEMA) {
        throw routerOwnerError('Router process ownership record schema is invalid');
    }
    if (!Number.isSafeInteger(candidate.pid) || candidate.pid <= 0 || candidate.pid > 0x7fffffff) {
        throw routerOwnerError('Router process ownership PID is invalid');
    }
    if (!Number.isSafeInteger(candidate.processUid)
        || candidate.processUid < 0
        || candidate.processUid !== expectedUid) {
        throw routerOwnerError('Router process ownership UID is invalid');
    }
    const workspaceRoot = normalizeWorkspaceRoot(candidate.workspaceRoot);
    if (expectedWorkspaceRoot !== undefined
        && workspaceRoot !== normalizeWorkspaceRoot(expectedWorkspaceRoot)) {
        throw routerOwnerError('Router process ownership workspace does not match');
    }
    let processIdentity;
    try {
        processIdentity = normalizeProcessIdentity(candidate.processIdentity);
    } catch (cause) {
        throw routerOwnerError(`Router process ownership identity is invalid: ${cause?.message || cause}`);
    }
    return Object.freeze({
        schema: ROUTER_PROCESS_RECORD_SCHEMA,
        pid: candidate.pid,
        processIdentity,
        processUid: candidate.processUid,
        workspaceRoot,
    });
}

function createRouterProcessRecord(pid, workspaceRoot, {
    inspectIdentity = inspectProcessIdentity,
    expectedUid = currentProcessUid(),
} = {}) {
    const inspection = inspectIdentity(pid);
    if (inspection?.state !== 'identified'
        || inspection.processUid !== expectedUid) {
        throw routerOwnerError(
            'Router process ownership could not identify the launched Watchdog',
            'PLOINKY_ROUTER_OWNER_IDENTITY_UNVERIFIED',
        );
    }
    return normalizeRouterProcessRecord({
        schema: ROUTER_PROCESS_RECORD_SCHEMA,
        pid,
        processIdentity: inspection.processIdentity,
        processUid: inspection.processUid,
        workspaceRoot,
    }, { expectedWorkspaceRoot: workspaceRoot, expectedUid });
}

function serializeRouterProcessRecord(record) {
    return `${JSON.stringify(record)}\n`;
}

function ensureRouterProcessStore(pidFile, { expectedUid = currentProcessUid() } = {}) {
    const directory = path.dirname(pidFile);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory()
        || stat.isSymbolicLink()
        || stat.uid !== expectedUid
        || (stat.mode & 0o022) !== 0) {
        throw routerOwnerError(
            'Router process ownership directory is not an exact owner-controlled directory',
            'PLOINKY_ROUTER_OWNER_STORE_INVALID',
        );
    }
}

function readRouterProcessSnapshotAt(pidFile, workspaceRoot, {
    expectedUid = currentProcessUid(),
    minimumLinks = 1,
    maximumLinks = 1,
} = {}) {
    if (!fs.constants.O_NOFOLLOW) {
        throw routerOwnerError(
            'Router process ownership requires O_NOFOLLOW',
            'PLOINKY_ROUTER_OWNER_STORE_INVALID',
        );
    }
    let fd = -1;
    try {
        fd = fs.openSync(pidFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()
            || stat.nlink < minimumLinks
            || stat.nlink > maximumLinks
            || stat.uid !== expectedUid
            || stat.size <= 0
            || stat.size > MAX_ROUTER_PROCESS_RECORD_BYTES
            || (stat.mode & 0o777) !== 0o600) {
            throw routerOwnerError('Router process ownership file is not an exact private bounded record');
        }
        const contents = fs.readFileSync(fd, 'utf8');
        let parsed;
        try {
            parsed = JSON.parse(contents);
        } catch (cause) {
            throw routerOwnerError(`Router process ownership record is malformed: ${cause?.message || cause}`);
        }
        const record = normalizeRouterProcessRecord(parsed, {
            expectedWorkspaceRoot: workspaceRoot,
            expectedUid,
        });
        if (contents !== serializeRouterProcessRecord(record)) {
            throw routerOwnerError('Router process ownership record is not exact canonical JSON');
        }
        return Object.freeze({
            record,
            raw: contents,
            dev: stat.dev,
            ino: stat.ino,
            mode: stat.mode,
            size: stat.size,
        });
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error?.code === 'ELOOP') {
            throw routerOwnerError('Router process ownership file must not be a symlink');
        }
        throw error;
    } finally {
        if (fd >= 0) fs.closeSync(fd);
    }
}

function readRouterProcessRecord(pidFile, workspaceRoot, options = {}) {
    return readRouterProcessSnapshotAt(pidFile, workspaceRoot, options)?.record ?? null;
}

function sameRouterProcessRecord(left, right) {
    return Boolean(left && right)
        && ROUTER_PROCESS_RECORD_KEYS.every((key) => left[key] === right[key]);
}

function sameRouterProcessSnapshot(left, right) {
    return Boolean(left && right)
        && left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.size === right.size
        && left.raw === right.raw;
}

function routerOperationId(snapshot) {
    return crypto.createHash('sha256').update(snapshot.raw).digest('hex').slice(0, 32);
}

function inspectRouterProcess(record, {
    inspectIdentity = inspectProcessIdentity,
    probeProcess = process.kill.bind(process),
    expectedUid = currentProcessUid(),
} = {}) {
    try {
        probeProcess(record.pid, 0);
    } catch (error) {
        if (error?.code !== 'EPERM') return Object.freeze({ state: 'dead' });
    }
    const inspection = inspectIdentity(record.pid);
    if (inspection?.state === 'dead') return Object.freeze({ state: 'dead' });
    if (inspection?.state !== 'identified') return Object.freeze({ state: 'unknown' });
    if (inspection.processIdentity !== record.processIdentity) {
        return Object.freeze({ state: 'pid-reused' });
    }
    if (inspection.processUid !== record.processUid || record.processUid !== expectedUid) {
        return Object.freeze({ state: 'unknown' });
    }
    return Object.freeze({ state: 'exact' });
}

function requireVerifiableRouterProcess(record, dependencies = {}) {
    const inspection = inspectRouterProcess(record, dependencies);
    if (inspection.state === 'unknown') {
        throw routerOwnerError(
            'Router process ownership identity cannot be verified',
            'PLOINKY_ROUTER_OWNER_IDENTITY_UNVERIFIED',
        );
    }
    return inspection.state;
}

function routerOperationArtifacts(pidFile) {
    const directory = path.dirname(pidFile);
    const basename = path.basename(pidFile);
    const escapedBasename = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escapedBasename}${ROUTER_OPERATION_PATTERN_SUFFIX}`);
    const names = fs.readdirSync(directory).filter((name) => name.startsWith(`${basename}.operation-`));
    const groups = new Map();
    for (const name of names) {
        const match = name.match(pattern);
        if (!match?.groups) {
            throw routerOwnerError(
                `Router process ownership contains malformed operation entry '${name}'`,
                'PLOINKY_ROUTER_OWNER_STORE_INVALID',
            );
        }
        const group = groups.get(match.groups.operationId) || new Map();
        if (group.has(match.groups.kind)) {
            throw routerOwnerError(
                'Router process ownership contains duplicate operation state',
                'PLOINKY_ROUTER_OWNER_STORE_INVALID',
            );
        }
        group.set(match.groups.kind, path.join(directory, name));
        groups.set(match.groups.operationId, group);
    }
    if (groups.size > 1) {
        throw routerOwnerError(
            'Router process ownership contains multiple interrupted operations',
            'PLOINKY_ROUTER_OWNER_STORE_INVALID',
        );
    }
    return groups;
}

function recoverRouterProcessOperations(pidFile, workspaceRoot, dependencies = {}) {
    ensureRouterProcessStore(pidFile, dependencies);
    const groups = routerOperationArtifacts(pidFile);
    for (const [operationId, artifacts] of groups) {
        const claim = artifacts.has('claim')
            ? readRouterProcessSnapshotAt(artifacts.get('claim'), workspaceRoot, {
                ...dependencies,
                minimumLinks: 1,
                maximumLinks: 2,
            })
            : null;
        const quarantine = artifacts.has('quarantine')
            ? readRouterProcessSnapshotAt(artifacts.get('quarantine'), workspaceRoot, {
                ...dependencies,
                minimumLinks: 1,
                maximumLinks: 2,
            })
            : null;
        const operationSnapshot = claim || quarantine;
        if (!operationSnapshot
            || routerOperationId(operationSnapshot) !== operationId
            || (claim && quarantine && !sameRouterProcessSnapshot(claim, quarantine))) {
            throw routerOwnerError(
                'Router process ownership interrupted operation state is not exact',
                'PLOINKY_ROUTER_OWNER_STORE_INVALID',
            );
        }
        if (requireVerifiableRouterProcess(operationSnapshot.record, dependencies) === 'exact') {
            throw routerOwnerError(
                'Router process ownership interrupted removal still belongs to a live process',
                'PLOINKY_ROUTER_OWNER_SLOT_BUSY',
            );
        }

        // These content-addressed paths are private to the interrupted
        // operation. Recovery never touches the canonical owner slot.
        if (quarantine) fs.unlinkSync(artifacts.get('quarantine'));
        if (claim) fs.unlinkSync(artifacts.get('claim'));
    }
}

function preserveDisplacedRouterSnapshot(
    pidFile,
    workspaceRoot,
    retiringSnapshot,
    displacedSnapshot,
    claimFile,
    quarantineFile,
    dependencies,
) {
    let restoredCanonical = false;
    try {
        fs.linkSync(quarantineFile, pidFile);
        restoredCanonical = true;
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const canonical = readRouterProcessSnapshotAt(pidFile, workspaceRoot, dependencies);
        if (!canonical || !sameRouterProcessRecord(canonical.record, displacedSnapshot.record)) {
            const displacedOperationId = routerOperationId(displacedSnapshot);
            const displacedQuarantine = `${pidFile}.operation-${displacedOperationId}.quarantine`;
            if (displacedQuarantine === quarantineFile) {
                throw routerOwnerError(
                    'Router process ownership displaced successor collided with the retiring operation',
                    'PLOINKY_ROUTER_OWNER_STORE_INVALID',
                );
            }
            try {
                fs.linkSync(quarantineFile, displacedQuarantine);
            } catch (preserveError) {
                if (preserveError?.code !== 'EEXIST') throw preserveError;
                const existingPreserved = readRouterProcessSnapshotAt(
                    displacedQuarantine,
                    workspaceRoot,
                    { ...dependencies, minimumLinks: 1, maximumLinks: 2 },
                );
                if (!sameRouterProcessSnapshot(existingPreserved, displacedSnapshot)) {
                    throw routerOwnerError(
                        'Router process ownership could not preserve a displaced live successor',
                        'PLOINKY_ROUTER_OWNER_STORE_INVALID',
                    );
                }
            }
            fs.unlinkSync(quarantineFile);
            const privateClaim = readRouterProcessSnapshotAt(claimFile, workspaceRoot, {
                ...dependencies,
                minimumLinks: 1,
                maximumLinks: 1,
            });
            if (!sameRouterProcessSnapshot(privateClaim, retiringSnapshot)) {
                throw routerOwnerError(
                    'Router process ownership retiring claim changed while preserving a successor',
                    'PLOINKY_ROUTER_OWNER_STORE_INVALID',
                );
            }
            fs.unlinkSync(claimFile);
            throw routerOwnerError(
                'Router process ownership preserved a displaced owner while a newer canonical owner won publication',
                'PLOINKY_ROUTER_OWNER_SLOT_BUSY',
            );
        }
    }

    if (restoredCanonical) {
        const restored = readRouterProcessSnapshotAt(pidFile, workspaceRoot, {
            ...dependencies,
            minimumLinks: 2,
            maximumLinks: 2,
        });
        if (!sameRouterProcessSnapshot(restored, displacedSnapshot)) {
            throw routerOwnerError(
                'Router process ownership could not restore the displaced canonical successor',
                'PLOINKY_ROUTER_OWNER_STORE_INVALID',
            );
        }
    }
    fs.unlinkSync(quarantineFile);
    const privateClaim = readRouterProcessSnapshotAt(claimFile, workspaceRoot, {
        ...dependencies,
        minimumLinks: 1,
        maximumLinks: 1,
    });
    if (!sameRouterProcessSnapshot(privateClaim, retiringSnapshot)) {
        throw routerOwnerError(
            'Router process ownership retiring claim changed while restoring a successor',
            'PLOINKY_ROUTER_OWNER_STORE_INVALID',
        );
    }
    fs.unlinkSync(claimFile);
}

function clearRouterProcessRecordIfExact(pidFile, workspaceRoot, record, {
    afterPrimaryRelease,
    beforePrimaryRelease,
    ...dependencies
} = {}) {
    const snapshot = readRouterProcessSnapshotAt(pidFile, workspaceRoot, dependencies);
    if (!snapshot || !sameRouterProcessRecord(snapshot.record, record)) return false;
    const operationId = routerOperationId(snapshot);
    const operationBase = `${pidFile}.operation-${operationId}`;
    const claimFile = `${operationBase}.claim`;
    const quarantineFile = `${operationBase}.quarantine`;
    let claimCreated = false;
    let primaryRenamed = false;

    try {
        try {
            fs.linkSync(pidFile, claimFile);
            claimCreated = true;
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            if (error?.code === 'EEXIST') {
                throw routerOwnerError(
                    'Router process ownership has a concurrent exact-removal operation',
                    'PLOINKY_ROUTER_OWNER_STORE_INVALID',
                );
            }
            throw error;
        }
        const competing = routerOperationArtifacts(pidFile);
        if (competing.size !== 1 || !competing.has(operationId)
            || competing.get(operationId).size !== 1
            || !competing.get(operationId).has('claim')) {
            throw routerOwnerError(
                'Router process ownership has concurrent exact-removal operations',
                'PLOINKY_ROUTER_OWNER_STORE_INVALID',
            );
        }
        const claim = readRouterProcessSnapshotAt(claimFile, workspaceRoot, {
            ...dependencies,
            minimumLinks: 2,
            maximumLinks: 2,
        });
        if (!sameRouterProcessSnapshot(claim, snapshot)) {
            fs.unlinkSync(claimFile);
            claimCreated = false;
            return false;
        }

        if (typeof beforePrimaryRelease === 'function') beforePrimaryRelease();

        // Rename is the atomic release point. A concurrent publisher can
        // replace the pathname between claim validation and this rename. If
        // that occurs, restore its exact record before retiring our old claim.
        fs.renameSync(pidFile, quarantineFile);
        primaryRenamed = true;
        if (typeof afterPrimaryRelease === 'function') afterPrimaryRelease();
        const quarantined = readRouterProcessSnapshotAt(quarantineFile, workspaceRoot, {
            ...dependencies,
            minimumLinks: 1,
            maximumLinks: 2,
        });
        if (!sameRouterProcessSnapshot(quarantined, snapshot)) {
            preserveDisplacedRouterSnapshot(
                pidFile,
                workspaceRoot,
                snapshot,
                quarantined,
                claimFile,
                quarantineFile,
                dependencies,
            );
            claimCreated = false;
            return false;
        }
        const postClaim = readRouterProcessSnapshotAt(claimFile, workspaceRoot, {
            ...dependencies,
            minimumLinks: 2,
            maximumLinks: 2,
        });
        if (!sameRouterProcessSnapshot(postClaim, snapshot)
            || !sameRouterProcessSnapshot(quarantined, snapshot)) {
            throw routerOwnerError(
                'Router process ownership changed during exact removal',
                'PLOINKY_ROUTER_OWNER_STORE_INVALID',
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

function publishRouterProcessSlot(pidFile, record, { beforePublish } = {}) {
    const directory = path.dirname(pidFile);
    const temporaryFile = path.join(
        directory,
        `.${path.basename(pidFile)}.publish-${process.pid}-${crypto.randomBytes(16).toString('hex')}.tmp`,
    );
    try {
        fs.writeFileSync(temporaryFile, serializeRouterProcessRecord(record), {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        });
        if (typeof beforePublish === 'function') beforePublish();
        try {
            fs.linkSync(temporaryFile, pidFile);
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            throw routerOwnerError(
                'Router process ownership slot was claimed concurrently',
                'PLOINKY_ROUTER_OWNER_SLOT_BUSY',
            );
        }
        // The canonical pathname is the atomic publication boundary. It is
        // never chmodded, renamed, or unlinked by publication cleanup.
    } finally {
        try { fs.unlinkSync(temporaryFile); } catch (_) { }
    }
}

function publishPreparedRouterProcessRecord(pidFile, record, workspaceRoot, dependencies = {}) {
    ensureRouterProcessStore(pidFile, dependencies);
    recoverRouterProcessOperations(pidFile, workspaceRoot, dependencies);
    const normalizedRecord = normalizeRouterProcessRecord(record, {
        expectedWorkspaceRoot: workspaceRoot,
        expectedUid: dependencies.expectedUid,
    });
    if (requireVerifiableRouterProcess(normalizedRecord, dependencies) !== 'exact') {
        throw routerOwnerError(
            'Router process ownership prepared owner is no longer exact',
            'PLOINKY_ROUTER_OWNER_IDENTITY_UNVERIFIED',
        );
    }
    const existing = readRouterProcessSnapshotAt(pidFile, workspaceRoot, dependencies);
    if (existing) {
        const state = requireVerifiableRouterProcess(existing.record, dependencies);
        if (sameRouterProcessRecord(existing.record, normalizedRecord) && state === 'exact') {
            return existing.record;
        }
        if (state === 'exact') {
            throw routerOwnerError(
                'Router process ownership slot already belongs to a live exact owner',
                'PLOINKY_ROUTER_OWNER_SLOT_BUSY',
            );
        }
        clearRouterProcessRecordIfExact(pidFile, workspaceRoot, existing.record, dependencies);
    }
    publishRouterProcessSlot(pidFile, normalizedRecord, dependencies);
    return normalizedRecord;
}

function writeRouterProcessRecord(pidFile, pid, workspaceRoot, dependencies = {}) {
    const record = createRouterProcessRecord(pid, workspaceRoot, dependencies);
    return publishPreparedRouterProcessRecord(pidFile, record, workspaceRoot, dependencies);
}

function waitForRouterProcessExit(record, timeout, {
    inspectIdentity = inspectProcessIdentity,
    probeProcess = process.kill.bind(process),
    expectedUid = currentProcessUid(),
    now = Date.now,
    sleep = sleepMs,
} = {}) {
    const deadline = now() + Math.max(0, timeout);
    while (now() < deadline) {
        const state = requireVerifiableRouterProcess(record, {
            inspectIdentity,
            probeProcess,
            expectedUid,
        });
        if (state !== 'exact') return true;
        sleep(Math.min(50, Math.max(1, deadline - now())));
    }
    return requireVerifiableRouterProcess(record, {
        inspectIdentity,
        probeProcess,
        expectedUid,
    }) !== 'exact';
}

function signalExactRouterProcess(record, signal, dependencies = {}) {
    if (requireVerifiableRouterProcess(record, dependencies) !== 'exact') return true;
    try {
        (dependencies.killProcess || process.kill.bind(process))(record.pid, signal);
        return true;
    } catch (error) {
        if (error?.code === 'ESRCH') {
            return requireVerifiableRouterProcess(record, dependencies) !== 'exact';
        }
        return false;
    }
}

function validateRouterStopTimeouts(timeout, killTimeout) {
    if (!Number.isSafeInteger(timeout) || timeout < 0
        || !Number.isSafeInteger(killTimeout) || killTimeout < 0) {
        throw routerOwnerError(
            'Router process ownership stop timeouts are invalid',
            'PLOINKY_ROUTER_OWNER_STORE_INVALID',
        );
    }
}

function terminateExactRouterProcess(record, {
    timeout = 5000,
    killTimeout = 1000,
    ...dependencies
} = {}) {
    validateRouterStopTimeouts(timeout, killTimeout);
    const normalizedRecord = normalizeRouterProcessRecord(record, {
        expectedWorkspaceRoot: record?.workspaceRoot,
        expectedUid: dependencies.expectedUid,
    });
    const initialState = requireVerifiableRouterProcess(normalizedRecord, dependencies);
    if (initialState !== 'exact') {
        return Object.freeze({ stopped: false, reason: 'stale-process', pid: normalizedRecord.pid });
    }
    if (!signalExactRouterProcess(normalizedRecord, 'SIGTERM', dependencies)) {
        return Object.freeze({ stopped: false, reason: 'term-signal-failed', pid: normalizedRecord.pid });
    }
    let signal = 'SIGTERM';
    if (!waitForRouterProcessExit(normalizedRecord, timeout, dependencies)) {
        if (requireVerifiableRouterProcess(normalizedRecord, dependencies) !== 'exact') {
            return Object.freeze({ stopped: true, pid: normalizedRecord.pid, signal });
        }
        if (!signalExactRouterProcess(normalizedRecord, 'SIGKILL', dependencies)) {
            return Object.freeze({ stopped: false, reason: 'kill-signal-failed', pid: normalizedRecord.pid });
        }
        signal = 'SIGKILL';
        if (!waitForRouterProcessExit(normalizedRecord, killTimeout, dependencies)) {
            return Object.freeze({ stopped: false, reason: 'kill-timeout', pid: normalizedRecord.pid });
        }
    }
    return Object.freeze({ stopped: true, pid: normalizedRecord.pid, signal });
}

function terminateRouterProcessRecordIfExact(pidFile, workspaceRoot, record, options = {}) {
    validateRouterStopTimeouts(options.timeout ?? 5000, options.killTimeout ?? 1000);
    ensureRouterProcessStore(pidFile, options);
    recoverRouterProcessOperations(pidFile, workspaceRoot, options);
    const normalizedRecord = normalizeRouterProcessRecord(record, {
        expectedWorkspaceRoot: workspaceRoot,
        expectedUid: options.expectedUid,
    });
    const result = terminateExactRouterProcess(normalizedRecord, options);
    if (result.stopped || result.reason === 'stale-process') {
        clearRouterProcessRecordIfExact(pidFile, workspaceRoot, normalizedRecord, options);
    }
    if (result.reason === 'stale-process') {
        return Object.freeze({ stopped: false, reason: 'stale-record', pid: normalizedRecord.pid });
    }
    return result;
}

function terminateRouterFromProcessRecord(pidFile, workspaceRoot, options = {}) {
    validateRouterStopTimeouts(options.timeout ?? 5000, options.killTimeout ?? 1000);
    ensureRouterProcessStore(pidFile, options);
    recoverRouterProcessOperations(pidFile, workspaceRoot, options);
    const snapshot = readRouterProcessSnapshotAt(pidFile, workspaceRoot, options);
    if (!snapshot) return Object.freeze({ stopped: false, reason: 'absent' });
    return terminateRouterProcessRecordIfExact(pidFile, workspaceRoot, snapshot.record, options);
}

function registerSessionContainer(name) {
    try { addSessionContainer(name); } catch (_) { }
}

function cleanupSessionContainers() {
    try { cleanupSessionSet(); } catch (_) { }
}

function killRouterIfRunning() {
    try {
        const pidFile = path.join(RUNNING_DIR, 'router.pid');
        let port = null;
        try { port = resolvePersistedRouterPort(); } catch (_) { }

        const logRouterStop = (pid, signal, source) => {
            try {
                appendLog('server_stop', { pid, signal, source, port });
            } catch (_) { }
        };

        // Run recovery even when the canonical slot is absent: an interrupted
        // rename may leave only claim/quarantine state for a still-live owner.
        const result = terminateRouterFromProcessRecord(pidFile, PLOINKY_WORKSPACE_ROOT);
        if (result.stopped) {
            logRouterStop(result.pid, result.signal, 'owned_process_record');
            console.log(`Stopped Router (pid ${result.pid}).`);
        }

        // Never infer ownership from a shared TCP port. Without this
        // workspace's PID record there is no process we are authorized to signal.
        return result;
    } catch (error) {
        return Object.freeze({ stopped: false, reason: 'ownership-unverified', error });
    }
}

function requireRouterStopCompleted(result, label = 'Router lifecycle') {
    if (result?.stopped === true
        || result?.reason === 'absent'
        || result?.reason === 'stale-record') {
        return result;
    }
    const error = new Error(
        `${label}: refusing to continue because exact Router ownership cleanup did not complete (${result?.reason || 'invalid-result'})`,
        { cause: result?.error },
    );
    error.code = 'PLOINKY_ROUTER_STOP_REFUSED';
    throw error;
}

async function destroyAll() {
    try {
        const list = destroyWorkspaceContainers({ fast: true });
        if (list.length) {
            console.log('Removed containers:');
            list.forEach(n => console.log(` - ${n}`));
        }

        try {
            fs.rmSync(DEPS_DIR, { recursive: true, force: true });
            console.log('Cleared dependency cache: .ploinky/deps');
            console.log('Preserved agent data: .data');
        } catch (err) {
            console.error(`Failed to clear .ploinky/deps: ${err.message}`);
        }

        console.log(`Destroyed ${list.length} containers from this workspace.`);
    }
    catch (e) { console.error('Destroy failed:', e.message); }
}

async function shutdownSession() {
    try { cleanupSessionContainers(); } catch (e) { debugLog('shutdown error:', e.message); }
    console.log('Shutdown completed for current session containers.');
}

export {
    registerSessionContainer,
    cleanupSessionContainers,
    createRouterProcessRecord,
    killRouterIfRunning,
    normalizeRouterProcessRecord,
    publishPreparedRouterProcessRecord,
    readRouterProcessRecord,
    requireRouterStopCompleted,
    terminateExactRouterProcess,
    terminateRouterFromProcessRecord,
    terminateRouterProcessRecordIfExact,
    writeRouterProcessRecord,
    destroyAll,
    shutdownSession,
};
