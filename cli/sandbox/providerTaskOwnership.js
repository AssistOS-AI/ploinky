import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PLOINKY_DIR } from '../utils/config.js';
import { deriveAgentPrincipalId } from '../utils/security/agentIdentity.js';
import { normalizeProcessIdentity } from './processIdentity.js';

const PROVIDER_TASK_OWNER_SCHEMA_VERSION = 7;
const PROVIDER_TASK_REQUEST_SCHEMA_VERSION = 1;
const PROVIDER_TASK_OWNER_DIR = path.join(PLOINKY_DIR, 'run', 'provider-task-owners');
const PROVIDER_TASK_LOG_ROOT = path.join(PLOINKY_DIR, 'logs', 'agents');
const OWNER_SUFFIX = '.owner.json';
const HEARTBEAT_SUFFIX = '.heartbeat.json';
const REPORT_SUFFIX = '.report.json';
const MAX_OWNER_BYTES = 32 * 1024;
const MAX_HEARTBEAT_BYTES = 1024;
const MAX_REPORT_BYTES = 40 * 1024;
const MAX_LOG_CHUNK_BYTES = 16 * 1024;
const PROVIDER_TASK_STALE_AFTER_MS = 90_000;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMON_REQUEST_KEYS = Object.freeze([
    'audience', 'brokerOwner', 'homeKey', 'mode', 'pid', 'processGroupId', 'processIdentity',
    'processUid', 'provider', 'readiness', 'runtimeKey', 'runtimeKind',
    'schemaVersion', 'state', 'taskId', 'workdir',
]);
const LOG_REQUEST_KEYS = Object.freeze([
    'chunk', 'processIdentity', 'provider', 'runtimeKey', 'schemaVersion',
    'sequence', 'stream', 'taskId',
]);
const TERMINAL_REQUEST_KEYS = Object.freeze([
    ...COMMON_REQUEST_KEYS, 'terminalProof', 'terminalState',
].sort());
const REPORT_REQUEST_KEYS = Object.freeze([
    ...COMMON_REQUEST_KEYS, 'reportState',
].sort());
const TERMINAL_PROOF_KEYS = Object.freeze([
    'brokerClosed', 'descendantsTerminal', 'leaseReleased', 'processTerminal',
]);
const OWNER_KEYS = Object.freeze([
    'agentId', 'alias', 'audience', 'brokerOwner', 'enableGeneration', 'homeKey', 'instanceId',
    'logPath', 'mode', 'ownerKey', 'pid', 'processGroupId', 'processIdentity',
    'processUid', 'provider', 'readiness', 'releaseGeneration', 'role', 'runtime', 'runtimeKey',
    'runtimeKind', 'schemaVersion', 'state', 'taskId', 'workdir',
]);
const sequenceByOwner = new Map();

function ownershipError(message, code = 'PLOINKY_PROVIDER_TASK_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
    if (!isPlainObject(value)) throw ownershipError(`${label} must be a plain JSON object`);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        throw ownershipError(`${label} has an invalid schema`);
    }
    return value;
}

function exactText(value, label, { pattern, maximumBytes = 512 } = {}) {
    if (typeof value !== 'string' || !value || value !== value.trim()
        || Buffer.byteLength(value, 'utf8') > maximumBytes
        || /[\u0000-\u001f\u007f]/.test(value)
        || (pattern && !pattern.test(value))) {
        throw ownershipError(`provider task ${label} is invalid`);
    }
    return value;
}

function safeSegment(value, label) {
    const segment = exactText(value, label, { pattern: SAFE_SEGMENT, maximumBytes: 255 });
    if (segment === '.' || segment === '..') throw ownershipError(`provider task ${label} is invalid`);
    return segment;
}

function canonicalWorkspacePath(value) {
    const workdir = exactText(value, 'workdir', { maximumBytes: 4096 });
    if (!path.posix.isAbsolute(workdir) || path.posix.normalize(workdir) !== workdir
        || workdir === '/workspace' || !workdir.startsWith('/workspace/')) {
        throw ownershipError('provider task workdir must be a canonical private workspace path');
    }
    return workdir;
}

function exactPositiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw ownershipError(`provider task ${label} must be a positive integer`);
    }
    return value;
}

function brokerOwnerFor(agentId, instanceId, enableGeneration, taskId, provider, audience) {
    const digest = crypto.createHash('sha256').update(JSON.stringify([
        agentId,
        instanceId,
        enableGeneration,
        taskId,
        provider,
        audience,
    ]), 'utf8').digest('hex');
    return `sha256:${digest}`;
}

function providerTaskOwnerKey(runtimeKey, taskId) {
    const runtime = safeSegment(runtimeKey, 'runtimeKey');
    const task = safeSegment(taskId, 'taskId');
    const digest = crypto.createHash('sha256')
        .update(JSON.stringify(['provider-task', runtime, task]), 'utf8')
        .digest('hex');
    return `provider-task-${digest}`;
}

function selectedRuntimeKind(runtime) {
    if (runtime === 'podman' || runtime === 'container') return 'container';
    if (runtime === 'bwrap' || runtime === 'seatbelt') return 'bwrap';
    throw ownershipError('selected provider runtime is unsupported', 'PLOINKY_PROVIDER_TASK_RUNTIME_MISMATCH', 403);
}

function resolveSelectedProviderRuntime(snapshot, callerIdentity) {
    const caller = callerIdentity || {};
    const matches = [];
    for (const [runtimeKey, record] of Object.entries(snapshot?.agents || {})) {
        if (!record || record.type !== 'agent') continue;
        let agentId;
        try { agentId = deriveAgentPrincipalId(record.repoName, record.agentName); } catch (_) { continue; }
        if (agentId !== caller.agentId
            || record.instanceId !== caller.instanceId
            || record.enableGeneration !== caller.enableGeneration) continue;
        matches.push({ runtimeKey, record, agentId });
    }
    if (matches.length !== 1) {
        throw ownershipError(
            'provider task caller does not select one exact active runtime',
            'PLOINKY_PROVIDER_TASK_RUNTIME_MISMATCH',
            403,
        );
    }
    const { runtimeKey, record, agentId } = matches[0];
    const runtime = exactText(record.runtime, 'selected runtime');
    const expectedHomeKey = runtime === 'podman'
        ? runtimeKey
        : `${runtimeKey}.sandbox-v2`;
    if (runtime !== 'podman' && record.homeKey !== expectedHomeKey) {
        throw ownershipError('selected provider HOME identity is invalid', 'PLOINKY_PROVIDER_TASK_RUNTIME_MISMATCH', 403);
    }
    return Object.freeze({
        agentId,
        alias: exactText(record.alias || record.agentName, 'alias'),
        enableGeneration: record.enableGeneration,
        homeKey: expectedHomeKey,
        instanceId: record.instanceId,
        releaseGeneration: String(record.releaseGeneration || ''),
        runtime: runtime === 'podman' ? 'container' : runtime,
        runtimeKey,
        runtimeKind: selectedRuntimeKind(runtime),
    });
}

function normalizeContext({ snapshot, callerIdentity, selectedRuntime } = {}) {
    const selected = selectedRuntime || resolveSelectedProviderRuntime(snapshot, callerIdentity);
    const caller = callerIdentity || {};
    for (const field of ['agentId', 'instanceId', 'enableGeneration']) {
        if (selected[field] !== caller[field]) {
            throw ownershipError('provider task caller identity does not match selected runtime', 'PLOINKY_PROVIDER_TASK_RUNTIME_MISMATCH', 403);
        }
    }
    return Object.freeze({
        agentId: exactText(selected.agentId, 'agentId'),
        alias: exactText(selected.alias || caller.routeKey, 'alias'),
        enableGeneration: exactText(selected.enableGeneration, 'enableGeneration'),
        homeKey: safeSegment(selected.homeKey, 'homeKey'),
        instanceId: exactText(selected.instanceId, 'instanceId'),
        releaseGeneration: (() => {
            const value = String(selected.releaseGeneration || '');
            if (value && !/^[a-f0-9]{64}$/.test(value)) {
                throw ownershipError('provider task releaseGeneration is invalid');
            }
            return value;
        })(),
        runtime: exactText(selected.runtime, 'runtime'),
        runtimeKey: safeSegment(selected.runtimeKey, 'runtimeKey'),
        runtimeKind: selected.runtimeKind || selectedRuntimeKind(selected.runtime),
    });
}

function normalizeCommonRequest(body, context) {
    exactKeys(body, COMMON_REQUEST_KEYS, 'provider task request');
    if (body.schemaVersion !== PROVIDER_TASK_REQUEST_SCHEMA_VERSION
        || !['task', 'operation'].includes(body.mode)
        || !['bwrap', 'container'].includes(body.runtimeKind)
        || body.readiness !== 'ready'
        || body.state !== 'running') {
        throw ownershipError('provider task request has invalid fixed values');
    }
    const taskId = safeSegment(body.taskId, 'taskId');
    const audience = exactText(body.audience, 'audience', { maximumBytes: 2048 });
    const provider = safeSegment(body.provider, 'provider');
    const runtimeKey = safeSegment(body.runtimeKey, 'runtimeKey');
    const homeKey = safeSegment(body.homeKey, 'homeKey');
    const pid = exactPositiveInteger(body.pid, 'pid');
    if (body.processGroupId !== pid) {
        throw ownershipError('provider task processGroupId must equal its inner pid');
    }
    const processUid = Number(body.processUid);
    if (!Number.isSafeInteger(processUid) || processUid < 0) {
        throw ownershipError('provider task processUid is invalid');
    }
    let processIdentity;
    try { processIdentity = normalizeProcessIdentity(body.processIdentity); } catch (_) {
        throw ownershipError('provider task processIdentity is invalid');
    }
    const brokerOwner = exactText(body.brokerOwner, 'brokerOwner', { pattern: SHA256 });
    const expectedBrokerOwner = brokerOwnerFor(
        context.agentId,
        context.instanceId,
        context.enableGeneration,
        taskId,
        provider,
        audience,
    );
    if (brokerOwner !== expectedBrokerOwner) {
        throw ownershipError('provider task broker owner does not match its exact runtime identity', 'PLOINKY_PROVIDER_TASK_BROKER_MISMATCH', 403);
    }
    if (runtimeKey !== context.runtimeKey
        || homeKey !== context.homeKey
        || body.runtimeKind !== context.runtimeKind) {
        throw ownershipError('provider task request does not match selected runtime', 'PLOINKY_PROVIDER_TASK_RUNTIME_MISMATCH', 403);
    }
    return Object.freeze({
        audience,
        brokerOwner,
        homeKey,
        mode: body.mode,
        pid,
        processGroupId: pid,
        processIdentity,
        processUid,
        provider,
        readiness: 'ready',
        runtimeKey,
        runtimeKind: body.runtimeKind,
        state: 'running',
        taskId,
        workdir: canonicalWorkspacePath(body.workdir),
    });
}

function expectedOwner(context, common) {
    const logPath = path.join(
        PROVIDER_TASK_LOG_ROOT,
        safeSegment(context.instanceId, 'instanceId'),
        'tasks',
        `${common.taskId}-provider.log`,
    );
    return Object.freeze({
        schemaVersion: PROVIDER_TASK_OWNER_SCHEMA_VERSION,
        role: 'provider-task',
        ownerKey: providerTaskOwnerKey(common.runtimeKey, common.taskId),
        agentId: context.agentId,
        alias: context.alias,
        instanceId: context.instanceId,
        enableGeneration: context.enableGeneration,
        releaseGeneration: context.releaseGeneration,
        runtime: context.runtime,
        logPath,
        ...common,
    });
}

function currentUid() {
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    if (!Number.isSafeInteger(uid) || uid < 0) {
        throw ownershipError('provider task owner store requires an exact uid', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
    }
    return uid;
}

function assertPrivateDirectory(directory, { create = false, mutable = false, requirePrivateMode = true } = {}) {
    if (create) {
        try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }
    }
    let stat;
    try { stat = fs.lstatSync(directory); } catch (error) {
        if (error?.code === 'ENOENT' && !create) return false;
        throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== currentUid()) {
        throw ownershipError('provider task owner directory is not private', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
    }
    if (requirePrivateMode && (stat.mode & 0o777) !== 0o700) {
        if (!mutable) {
            throw ownershipError('provider task owner directory mode is not private', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
        }
        fs.chmodSync(directory, 0o700);
    }
    return true;
}

function managedDirectoryChain(target) {
    const root = path.resolve(PLOINKY_DIR);
    const resolved = path.resolve(target);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw ownershipError('provider task managed directory escaped workspace state', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
    }
    const result = [root];
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        result.push(current);
    }
    return result;
}

function ensurePrivateTree(target) {
    for (const [index, directory] of managedDirectoryChain(target).entries()) {
        assertPrivateDirectory(directory, {
            create: true,
            mutable: true,
            requirePrivateMode: index !== 0,
        });
    }
}

function assertPrivateTreeReadOnly(target) {
    for (const [index, directory] of managedDirectoryChain(target).entries()) {
        if (!assertPrivateDirectory(directory, { requirePrivateMode: index !== 0 })) return false;
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

function ensureStore() {
    ensurePrivateTree(PROVIDER_TASK_OWNER_DIR);
}

function assertStoreReadOnly() {
    return assertPrivateTreeReadOnly(PROVIDER_TASK_OWNER_DIR);
}

function ownerFile(ownerKey) {
    return path.join(PROVIDER_TASK_OWNER_DIR, `${safeSegment(ownerKey, 'ownerKey')}${OWNER_SUFFIX}`);
}

function heartbeatFile(ownerKey) {
    return path.join(PROVIDER_TASK_OWNER_DIR, `${safeSegment(ownerKey, 'ownerKey')}${HEARTBEAT_SUFFIX}`);
}

function reportFile(ownerKey) {
    return path.join(PROVIDER_TASK_OWNER_DIR, `${safeSegment(ownerKey, 'ownerKey')}${REPORT_SUFFIX}`);
}

function sameOwner(left, right) {
    return Boolean(left && right) && OWNER_KEYS.every((key) => left[key] === right[key]);
}

function validateStoredOwner(value, expectedKey) {
    exactKeys(value, OWNER_KEYS, 'provider task owner record');
    if (value.schemaVersion !== PROVIDER_TASK_OWNER_SCHEMA_VERSION || value.role !== 'provider-task') {
        throw ownershipError('provider task owner record version or role is invalid', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
    }
    const context = normalizeContext({
        callerIdentity: value,
        selectedRuntime: value,
    });
    const common = normalizeCommonRequest({
        schemaVersion: 1,
        taskId: value.taskId,
        audience: value.audience,
        provider: value.provider,
        mode: value.mode,
        runtimeKind: value.runtimeKind,
        runtimeKey: value.runtimeKey,
        homeKey: value.homeKey,
        workdir: value.workdir,
        pid: value.pid,
        processGroupId: value.processGroupId,
        processIdentity: value.processIdentity,
        processUid: value.processUid,
        brokerOwner: value.brokerOwner,
        readiness: value.readiness,
        state: value.state,
    }, context);
    const canonical = expectedOwner(context, common);
    if (canonical.ownerKey !== expectedKey || !sameOwner(canonical, value)) {
        throw ownershipError('provider task owner record is not canonical', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
    }
    return Object.freeze({ ...canonical });
}

function readPinnedJson(file, { maximumBytes, expectedLinks = 1, label }) {
    let descriptor;
    try {
        descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw ownershipError(`${label} could not be opened safely`, 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
    }
    try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.uid !== currentUid() || (stat.mode & 0o777) !== 0o600
            || stat.nlink !== expectedLinks || stat.size <= 0 || stat.size > maximumBytes) {
            throw ownershipError(`${label} is not an exact private regular file`, 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
        }
        let parsed;
        try { parsed = JSON.parse(fs.readFileSync(descriptor, 'utf8')); } catch (_) {
            throw ownershipError(`${label} is malformed`, 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
        }
        return Object.freeze({ parsed, stat });
    } finally {
        fs.closeSync(descriptor);
    }
}

function readOwnerAt(file, key, expectedLinks = 1) {
    const pinned = readPinnedJson(file, {
        maximumBytes: MAX_OWNER_BYTES,
        expectedLinks,
        label: 'provider task owner record',
    });
    if (!pinned) return null;
    return Object.freeze({ record: validateStoredOwner(pinned.parsed, key), stat: pinned.stat });
}

function readOwnerFile(key, { initialize = true } = {}) {
    if (initialize) ensureStore();
    else if (!assertStoreReadOnly()) return null;
    return readOwnerAt(ownerFile(key), key)?.record || null;
}

function canonicalBytes(owner) {
    return `${JSON.stringify(Object.fromEntries(OWNER_KEYS.map((key) => [key, owner[key]])))}\n`;
}

function publishOwner(owner) {
    ensureStore();
    const file = ownerFile(owner.ownerKey);
    const temporary = path.join(PROVIDER_TASK_OWNER_DIR, `.${owner.ownerKey}.${crypto.randomUUID()}.tmp`);
    try {
        const descriptor = fs.openSync(temporary, 'wx', 0o600);
        try {
            fs.writeFileSync(descriptor, canonicalBytes(owner), 'utf8');
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        fs.linkSync(temporary, file);
        fsyncDirectory(PROVIDER_TASK_OWNER_DIR);
    } finally {
        unlinkApplied(temporary);
    }
}

function ensureLog(owner) {
    const tasksDirectory = path.dirname(owner.logPath);
    ensurePrivateTree(tasksDirectory);
    let descriptor;
    try {
        descriptor = fs.openSync(owner.logPath, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.uid !== currentUid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
            throw ownershipError('provider task log is not a private regular file', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
        }
        fs.fsyncSync(descriptor);
        fsyncDirectory(tasksDirectory);
        return descriptor;
    } catch (error) {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        if (String(error?.code || '').startsWith('PLOINKY_PROVIDER_TASK_')) throw error;
        throw ownershipError('provider task log could not be opened safely', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
    }
}

function closeDescriptor(descriptor) {
    if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (_) {}
    }
}

function ownerDigestValue(owner) {
    return crypto.createHash('sha256').update(canonicalBytes(owner), 'utf8').digest('hex');
}

function validateReport(value, expectedKey) {
    exactKeys(value, ['owner', 'ownerDigest', 'ownerKey', 'reportedAt', 'schemaVersion', 'state'], 'provider task runtime report');
    if (value.schemaVersion !== 1 || value.ownerKey !== expectedKey
        || !['contained', 'pid-reused', 'terminal'].includes(value.state)
        || !Number.isSafeInteger(value.reportedAt) || value.reportedAt <= 0) {
        throw ownershipError('provider task runtime report is invalid', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
    }
    const owner = validateStoredOwner(value.owner, expectedKey);
    if (value.ownerDigest !== ownerDigestValue(owner)) {
        throw ownershipError('provider task runtime report does not match its immutable owner', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
    }
    return Object.freeze({
        schemaVersion: 1,
        ownerKey: expectedKey,
        ownerDigest: value.ownerDigest,
        reportedAt: value.reportedAt,
        state: value.state,
        owner,
    });
}

function readReport(ownerKey, { initialize = true } = {}) {
    if (initialize) ensureStore();
    else if (!assertStoreReadOnly()) return null;
    const pinned = readPinnedJson(reportFile(ownerKey), {
        maximumBytes: MAX_REPORT_BYTES,
        expectedLinks: 1,
        label: 'provider task runtime report',
    });
    return pinned ? validateReport(pinned.parsed, ownerKey) : null;
}

function cleanupExactReportTemps(owner) {
    const pattern = new RegExp(`^\\.${owner.ownerKey}\\.[0-9a-f-]{36}\\.report\\.tmp$`);
    const candidates = fs.readdirSync(PROVIDER_TASK_OWNER_DIR).filter((name) => pattern.test(name));
    for (const name of candidates) {
        const file = path.join(PROVIDER_TASK_OWNER_DIR, name);
        const pinned = readPinnedJson(file, {
            maximumBytes: MAX_REPORT_BYTES,
            expectedLinks: 1,
            label: 'provider task runtime report temporary',
        });
        const report = pinned ? validateReport(pinned.parsed, owner.ownerKey) : null;
        if (!sameOwner(report?.owner, owner)) {
            throw ownershipError('provider task report recovery changed identity', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
        }
        unlinkApplied(file);
    }
    if (candidates.length) fsyncDirectory(PROVIDER_TASK_OWNER_DIR);
}

function writeReport(owner, state, nowMs = Date.now()) {
    if (!['contained', 'pid-reused', 'terminal'].includes(state)
        || !Number.isSafeInteger(nowMs) || nowMs <= 0) {
        throw ownershipError('provider task runtime report is invalid');
    }
    ensureStore();
    cleanupExactReportTemps(owner);
    const target = reportFile(owner.ownerKey);
    const existing = readReport(owner.ownerKey);
    if (existing) {
        const allowedTransition = existing.state === 'pid-reused'
            && (state === 'contained' || state === 'terminal');
        if (!sameOwner(existing.owner, owner)
            || (existing.state !== state && !allowedTransition)) {
            throw ownershipError('provider task runtime report conflicts with existing evidence', 'PLOINKY_PROVIDER_TASK_CONFLICT', 409);
        }
        if (existing.state === state) return existing;
    }
    const temporary = path.join(PROVIDER_TASK_OWNER_DIR, `.${owner.ownerKey}.${crypto.randomUUID()}.report.tmp`);
    const payload = `${JSON.stringify({
        schemaVersion: 1,
        ownerKey: owner.ownerKey,
        ownerDigest: ownerDigestValue(owner),
        reportedAt: nowMs,
        state,
        owner: Object.fromEntries(OWNER_KEYS.map((key) => [key, owner[key]])),
    })}\n`;
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, payload, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, target);
        fsyncDirectory(PROVIDER_TASK_OWNER_DIR);
    } catch (error) {
        const applied = readReport(owner.ownerKey);
        if (!applied || applied.state !== state || !sameOwner(applied.owner, owner)) throw error;
    } finally {
        closeDescriptor(descriptor);
        unlinkApplied(temporary);
    }
    return readReport(owner.ownerKey);
}

function validateHeartbeat(value, owner) {
    exactKeys(value, ['heartbeatAt', 'ownerDigest', 'ownerKey', 'schemaVersion'], 'provider task heartbeat');
    if (value.schemaVersion !== 1 || value.ownerKey !== owner.ownerKey
        || value.ownerDigest !== ownerDigestValue(owner)
        || !Number.isSafeInteger(value.heartbeatAt) || value.heartbeatAt <= 0) {
        throw ownershipError('provider task heartbeat does not match its immutable owner', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
    }
    return Object.freeze({ ...value });
}

function readHeartbeat(owner, { initialize = true } = {}) {
    if (initialize) ensureStore();
    else if (!assertStoreReadOnly()) return null;
    const pinned = readPinnedJson(heartbeatFile(owner.ownerKey), {
        maximumBytes: MAX_HEARTBEAT_BYTES,
        expectedLinks: 1,
        label: 'provider task heartbeat',
    });
    return pinned ? validateHeartbeat(pinned.parsed, owner) : null;
}

function cleanupExactHeartbeatTemps(owner) {
    const pattern = new RegExp(`^\\.${owner.ownerKey}\\.[0-9a-f-]{36}\\.heartbeat\\.tmp$`);
    const candidates = fs.readdirSync(PROVIDER_TASK_OWNER_DIR).filter((name) => pattern.test(name));
    for (const name of candidates) {
        const file = path.join(PROVIDER_TASK_OWNER_DIR, name);
        const pinned = readPinnedJson(file, {
            maximumBytes: MAX_HEARTBEAT_BYTES,
            expectedLinks: 1,
            label: 'provider task heartbeat temporary',
        });
        if (!pinned || !validateHeartbeat(pinned.parsed, owner)) {
            throw ownershipError('provider task heartbeat recovery changed identity', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
        }
        unlinkApplied(file);
    }
    if (candidates.length) fsyncDirectory(PROVIDER_TASK_OWNER_DIR);
}

function writeHeartbeat(owner, nowMs = Date.now()) {
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
        throw ownershipError('provider task heartbeat time is invalid');
    }
    ensureStore();
    cleanupExactHeartbeatTemps(owner);
    const target = heartbeatFile(owner.ownerKey);
    const existing = readHeartbeat(owner);
    if (fs.existsSync(target) && !existing) {
        throw ownershipError('provider task heartbeat target is unsafe', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
    }
    const temporary = path.join(PROVIDER_TASK_OWNER_DIR, `.${owner.ownerKey}.${crypto.randomUUID()}.heartbeat.tmp`);
    const payload = `${JSON.stringify({
        schemaVersion: 1,
        ownerKey: owner.ownerKey,
        ownerDigest: ownerDigestValue(owner),
        heartbeatAt: nowMs,
    })}\n`;
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, payload, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, target);
        fsyncDirectory(PROVIDER_TASK_OWNER_DIR);
    } finally {
        closeDescriptor(descriptor);
        unlinkApplied(temporary);
    }
    return readHeartbeat(owner);
}

function publishProviderTask({ body, ...options } = {}) {
    const context = normalizeContext(options);
    const owner = expectedOwner(context, normalizeCommonRequest(body, context));
    ensureStore();
    enumerateStoreOwnerKeys({ recoverableOwnerKey: owner.ownerKey });
    if (readReport(owner.ownerKey)) {
        throw ownershipError('provider task owner has unresolved terminal or PID-reuse evidence', 'PLOINKY_PROVIDER_TASK_CONFLICT', 409);
    }
    const existing = readOwnerFile(owner.ownerKey);
    if (existing) {
        if (!sameOwner(existing, owner)) {
            throw ownershipError('provider task owner is already claimed by different immutable identity', 'PLOINKY_PROVIDER_TASK_CONFLICT', 409);
        }
        const descriptor = ensureLog(owner);
        closeDescriptor(descriptor);
        writeHeartbeat(owner);
    } else {
        const descriptor = ensureLog(owner);
        closeDescriptor(descriptor);
        try { publishOwner(owner); } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            const raced = readOwnerFile(owner.ownerKey);
            if (!sameOwner(raced, owner)) {
                throw ownershipError('provider task owner was claimed concurrently', 'PLOINKY_PROVIDER_TASK_CONFLICT', 409);
            }
        }
        try {
            writeHeartbeat(owner);
        } catch (cause) {
            throw ownershipError(
                'provider task publish has a recoverable incomplete heartbeat; retry exact publish',
                'PLOINKY_PROVIDER_TASK_ATOMIC_PARTIAL',
                503,
            );
        }
    }
    return Object.freeze({ ok: true, owner: Object.freeze({ ownerKey: owner.ownerKey, logPath: owner.logPath }) });
}

function exactOwnerForCommon(body, options, { requireHeartbeat = true } = {}) {
    const context = normalizeContext(options);
    const expected = expectedOwner(context, normalizeCommonRequest(body, context));
    const report = readReport(expected.ownerKey);
    const owner = readOwnerFile(expected.ownerKey) || report?.owner || null;
    if (!owner || !sameOwner(owner, expected)) {
        throw ownershipError('provider task owner does not match its published immutable identity', 'PLOINKY_PROVIDER_TASK_NOT_FOUND', 404);
    }
    if (requireHeartbeat && !readHeartbeat(owner)) {
        throw ownershipError('provider task owner heartbeat is incomplete', 'PLOINKY_PROVIDER_TASK_ATOMIC_PARTIAL', 503);
    }
    return owner;
}

function heartbeatProviderTask({ body, ...options } = {}) {
    const owner = exactOwnerForCommon(body, options);
    if (readReport(owner.ownerKey)?.state === 'pid-reused') {
        throw ownershipError('provider task PID identity was reported reused', 'PLOINKY_PROVIDER_TASK_PID_REUSED', 409);
    }
    writeHeartbeat(owner);
    return Object.freeze({ ok: true, owner: Object.freeze({ ownerKey: owner.ownerKey, logPath: owner.logPath }) });
}

function reportProviderTask({ body, ...options } = {}) {
    exactKeys(body, REPORT_REQUEST_KEYS, 'provider task report request');
    if (body.reportState !== 'pid-reused') {
        throw ownershipError('provider task reportState is invalid');
    }
    const common = Object.fromEntries(COMMON_REQUEST_KEYS.map((key) => [key, body[key]]));
    const owner = exactOwnerForCommon(common, options);
    writeReport(owner, 'pid-reused');
    return Object.freeze({ ok: true });
}

function normalizeLogRequest(body) {
    exactKeys(body, LOG_REQUEST_KEYS, 'provider task log request');
    if (body.schemaVersion !== 1 || !['stdout', 'stderr'].includes(body.stream)) {
        throw ownershipError('provider task log request has invalid fixed values');
    }
    const chunk = typeof body.chunk === 'string' ? body.chunk : '';
    if (!chunk || Buffer.byteLength(chunk, 'utf8') > MAX_LOG_CHUNK_BYTES || chunk.includes('\0')) {
        throw ownershipError('provider task log chunk is empty or oversized');
    }
    let processIdentity;
    try { processIdentity = normalizeProcessIdentity(body.processIdentity); } catch (_) {
        throw ownershipError('provider task log processIdentity is invalid');
    }
    return Object.freeze({
        chunk,
        processIdentity,
        provider: safeSegment(body.provider, 'provider'),
        runtimeKey: safeSegment(body.runtimeKey, 'runtimeKey'),
        sequence: exactPositiveInteger(body.sequence, 'sequence'),
        stream: body.stream,
        taskId: safeSegment(body.taskId, 'taskId'),
    });
}

function redactLogChunk(chunk) {
    return chunk
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
        .replace(/\b(authorization|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
        .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
        .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
}

function appendProviderTaskLog({ body, ...options } = {}) {
    const context = normalizeContext(options);
    const request = normalizeLogRequest(body);
    if (request.runtimeKey !== context.runtimeKey) {
        throw ownershipError('provider task log runtime does not match selected runtime', 'PLOINKY_PROVIDER_TASK_RUNTIME_MISMATCH', 403);
    }
    const owner = readOwnerFile(providerTaskOwnerKey(request.runtimeKey, request.taskId));
    if (!owner || owner.agentId !== context.agentId
        || owner.instanceId !== context.instanceId
        || owner.enableGeneration !== context.enableGeneration
        || owner.releaseGeneration !== context.releaseGeneration
        || owner.provider !== request.provider
        || owner.processIdentity !== request.processIdentity) {
        throw ownershipError('provider task log does not match a published owner', 'PLOINKY_PROVIDER_TASK_NOT_FOUND', 404);
    }
    if (!readHeartbeat(owner)) {
        throw ownershipError('provider task owner heartbeat is incomplete', 'PLOINKY_PROVIDER_TASK_ATOMIC_PARTIAL', 503);
    }
    const last = sequenceByOwner.get(owner.ownerKey) || 0;
    if (request.sequence <= last) {
        throw ownershipError('provider task log sequence is stale', 'PLOINKY_PROVIDER_TASK_LOG_SEQUENCE', 409);
    }
    const line = `[${request.sequence}] ${request.stream}: ${redactLogChunk(request.chunk)}`;
    const descriptor = ensureLog(owner);
    try {
        fs.writeSync(descriptor, line.endsWith('\n') ? line : `${line}\n`, undefined, 'utf8');
        fs.fsyncSync(descriptor);
    } finally {
        closeDescriptor(descriptor);
    }
    sequenceByOwner.set(owner.ownerKey, request.sequence);
    return Object.freeze({ ok: true });
}

function terminalProof(body) {
    exactKeys(body.terminalProof, TERMINAL_PROOF_KEYS, 'provider task terminal proof');
    if (!TERMINAL_PROOF_KEYS.every((key) => body.terminalProof[key] === true)) {
        throw ownershipError('provider task terminal proof is incomplete');
    }
}

function unlinkApplied(file) {
    try {
        fs.unlinkSync(file);
        return true;
    } catch (error) {
        try { fs.lstatSync(file); } catch (observed) {
            if (observed?.code === 'ENOENT') return true;
        }
        throw error;
    }
}

function cleanupExactRemovalClaims(owner, report) {
    const prefix = `${ownerFile(owner.ownerKey)}.`;
    const claims = fs.readdirSync(PROVIDER_TASK_OWNER_DIR)
        .filter((name) => name.startsWith(`${owner.ownerKey}${OWNER_SUFFIX}.`) && name.endsWith('.claim'))
        .map((name) => path.join(PROVIDER_TASK_OWNER_DIR, name));
    if (claims.length && !sameOwner(report?.owner, owner)) {
        throw ownershipError('provider task removal claim has no exact durable proof', 'PLOINKY_PROVIDER_TASK_ATOMIC_PARTIAL', 503);
    }
    for (const claim of claims) {
        if (!claim.startsWith(prefix)) {
            throw ownershipError('provider task removal claim escaped its owner identity', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
        }
        const pinned = readOwnerAt(claim, owner.ownerKey);
        if (!sameOwner(pinned?.record, owner)) {
            throw ownershipError('provider task removal claim changed identity', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
        }
        unlinkApplied(claim);
    }
    if (claims.length) fsyncDirectory(PROVIDER_TASK_OWNER_DIR);
}

function unlinkExactOwner(owner) {
    const file = ownerFile(owner.ownerKey);
    const report = readReport(owner.ownerKey);
    const current = readOwnerAt(file, owner.ownerKey);
    if (!current) {
        if (!sameOwner(report?.owner, owner)) return false;
        cleanupExactRemovalClaims(owner, report);
        unlinkApplied(reportFile(owner.ownerKey));
        fsyncDirectory(PROVIDER_TASK_OWNER_DIR);
        sequenceByOwner.delete(owner.ownerKey);
        return true;
    }
    if (!sameOwner(current.record, owner)) return false;
    const claim = `${file}.${crypto.randomUUID()}.claim`;
    fs.linkSync(file, claim);
    let removed = false;
    try {
        fsyncDirectory(PROVIDER_TASK_OWNER_DIR);
        const claimed = readOwnerAt(claim, owner.ownerKey, 2);
        const primary = readOwnerAt(file, owner.ownerKey, 2);
        if (!sameOwner(claimed?.record, owner)
            || !sameOwner(primary?.record, owner)
            || claimed.stat.dev !== primary.stat.dev
            || claimed.stat.ino !== primary.stat.ino) return false;
        const heartbeat = readHeartbeat(owner);
        if (!heartbeat && !sameOwner(report?.owner, owner)) {
            throw ownershipError('provider task heartbeat is missing during exact removal', 'PLOINKY_PROVIDER_TASK_ATOMIC_PARTIAL', 503);
        }
        if (heartbeat) unlinkApplied(heartbeatFile(owner.ownerKey));
        unlinkApplied(file);
        fsyncDirectory(PROVIDER_TASK_OWNER_DIR);
        sequenceByOwner.delete(owner.ownerKey);
        removed = true;
    } finally {
        unlinkApplied(claim);
        fsyncDirectory(PROVIDER_TASK_OWNER_DIR);
    }
    if (removed && report) {
        unlinkApplied(reportFile(owner.ownerKey));
        fsyncDirectory(PROVIDER_TASK_OWNER_DIR);
    }
    return removed;
}

function terminalProviderTask({ body, allowRetiredOwner = false, ...options } = {}) {
    exactKeys(body, TERMINAL_REQUEST_KEYS, 'provider task terminal request');
    if (!['completed', 'failed', 'cancelled'].includes(body.terminalState)) {
        throw ownershipError('provider task terminalState is invalid');
    }
    terminalProof(body);
    const common = Object.fromEntries(COMMON_REQUEST_KEYS.map((key) => [key, body[key]]));
    let owner;
    if (allowRetiredOwner) {
        owner = readProviderTaskOwner(body.runtimeKey, body.taskId);
        if (!owner) throw ownershipError('retired provider task owner was not found', 'PLOINKY_PROVIDER_TASK_NOT_FOUND', 404);
        const context = normalizeContext({ callerIdentity: owner, selectedRuntime: owner });
        const expected = expectedOwner(context, normalizeCommonRequest(common, context));
        if (!sameOwner(owner, expected)) {
            throw ownershipError('retired terminal claim does not match the complete immutable owner', 'PLOINKY_PROVIDER_TASK_TERMINAL_MISMATCH', 403);
        }
    } else {
        owner = exactOwnerForCommon(common, options, { requireHeartbeat: false });
    }
    writeReport(owner, 'terminal');
    if (!unlinkExactOwner(owner)) {
        throw ownershipError('provider task owner changed during exact terminal removal', 'PLOINKY_PROVIDER_TASK_CONFLICT', 409);
    }
    return Object.freeze({ ok: true });
}

function readProviderTaskOwner(runtimeKey, taskId) {
    const key = providerTaskOwnerKey(runtimeKey, taskId);
    const report = readReport(key);
    const owner = readOwnerFile(key) || report?.owner || null;
    if (owner && !readHeartbeat(owner) && !sameOwner(report?.owner, owner)) {
        throw ownershipError('provider task owner heartbeat is incomplete', 'PLOINKY_PROVIDER_TASK_ATOMIC_PARTIAL', 503);
    }
    return owner;
}

function enumerateStoreOwnerKeys({ recoverableOwnerKey = '' } = {}) {
    const names = fs.readdirSync(PROVIDER_TASK_OWNER_DIR);
    const owners = new Set();
    const heartbeats = new Set();
    const reports = new Set();
    for (const name of names) {
        let match = /^\.(provider-task-[a-f0-9]{64})\.([0-9a-f-]{36})\.tmp$/.exec(name);
        if (match) {
            const key = match[1];
            if (!recoverableOwnerKey || key !== recoverableOwnerKey) {
                throw ownershipError(
                    'provider task owner store contains an incomplete publication',
                    'PLOINKY_PROVIDER_TASK_ATOMIC_PARTIAL',
                    503,
                );
            }
            const temporary = path.join(PROVIDER_TASK_OWNER_DIR, name);
            const primary = readOwnerAt(ownerFile(key), key, 2);
            const staged = readOwnerAt(temporary, key, 2);
            if (!primary || !staged || !sameOwner(primary.record, staged.record)
                || primary.stat.dev !== staged.stat.dev || primary.stat.ino !== staged.stat.ino) {
                throw ownershipError('provider task publication artifact changed identity', 'PLOINKY_PROVIDER_TASK_STORE_INVALID', 500);
            }
            unlinkApplied(temporary);
            fsyncDirectory(PROVIDER_TASK_OWNER_DIR);
            continue;
        }
        match = /^(provider-task-[a-f0-9]{64})\.owner\.json$/.exec(name);
        if (match) {
            owners.add(match[1]);
            continue;
        }
        match = /^(provider-task-[a-f0-9]{64})\.heartbeat\.json$/.exec(name);
        if (match) {
            heartbeats.add(match[1]);
            continue;
        }
        match = /^(provider-task-[a-f0-9]{64})\.report\.json$/.exec(name);
        if (match) {
            reports.add(match[1]);
            continue;
        }
        throw ownershipError(
            'provider task owner store contains an incomplete atomic operation',
            'PLOINKY_PROVIDER_TASK_ATOMIC_PARTIAL',
            503,
        );
    }
    const missingHeartbeats = [...owners].filter((key) => !heartbeats.has(key) && !reports.has(key));
    const orphanHeartbeats = [...heartbeats].filter((key) => !owners.has(key));
    const recoverable = recoverableOwnerKey
        && missingHeartbeats.length === 1
        && missingHeartbeats[0] === recoverableOwnerKey
        && orphanHeartbeats.length === 0;
    if (!recoverable && (missingHeartbeats.length || orphanHeartbeats.length)) {
        throw ownershipError(
            'provider task owner store contains an incomplete owner/heartbeat pair',
            'PLOINKY_PROVIDER_TASK_ATOMIC_PARTIAL',
            503,
        );
    }
    return [...new Set([...owners, ...reports])].sort();
}

function listProviderTaskOwners({ runtimeKey, instanceId, enableGeneration, releaseGeneration } = {}) {
    ensureStore();
    const selectedRuntime = runtimeKey === undefined ? '' : safeSegment(runtimeKey, 'runtimeKey');
    const selectedInstance = instanceId === undefined ? '' : exactText(instanceId, 'instanceId');
    const selectedGeneration = enableGeneration === undefined ? '' : exactText(enableGeneration, 'enableGeneration');
    const selectedRelease = releaseGeneration === undefined ? null : String(releaseGeneration || '');
    if (selectedRelease && !/^[a-f0-9]{64}$/.test(selectedRelease)) {
        throw ownershipError('provider task releaseGeneration is invalid');
    }
    return Object.freeze(enumerateStoreOwnerKeys()
        .map((key) => {
            const report = readReport(key);
            const owner = readOwnerFile(key) || report?.owner || null;
            if (!owner || (!readHeartbeat(owner) && !sameOwner(report?.owner, owner))) {
                throw ownershipError('provider task owner heartbeat is incomplete', 'PLOINKY_PROVIDER_TASK_ATOMIC_PARTIAL', 503);
            }
            return owner;
        })
        .filter((owner) => owner
            && (!selectedRuntime || owner.runtimeKey === selectedRuntime)
            && (!selectedInstance || owner.instanceId === selectedInstance)
            && (!selectedGeneration || owner.enableGeneration === selectedGeneration)
            && (selectedRelease === null || owner.releaseGeneration === selectedRelease))
        .sort((left, right) => left.ownerKey.localeCompare(right.ownerKey)));
}

function collectProviderTaskOwnersReadOnly({ runtimeKey, instanceId, enableGeneration, releaseGeneration } = {}) {
    if (!assertStoreReadOnly()) return Object.freeze([]);
    const selectedRuntime = runtimeKey === undefined ? '' : safeSegment(runtimeKey, 'runtimeKey');
    const selectedInstance = instanceId === undefined ? '' : exactText(instanceId, 'instanceId');
    const selectedGeneration = enableGeneration === undefined ? '' : exactText(enableGeneration, 'enableGeneration');
    const selectedRelease = releaseGeneration === undefined ? null : String(releaseGeneration || '');
    if (selectedRelease && !/^[a-f0-9]{64}$/.test(selectedRelease)) {
        throw ownershipError('provider task releaseGeneration is invalid');
    }
    return Object.freeze(enumerateStoreOwnerKeys()
        .map((key) => {
            const report = readReport(key, { initialize: false });
            const owner = readOwnerFile(key, { initialize: false }) || report?.owner || null;
            if (!owner || (!readHeartbeat(owner, { initialize: false }) && !sameOwner(report?.owner, owner))) {
                throw ownershipError('provider task owner heartbeat is incomplete', 'PLOINKY_PROVIDER_TASK_ATOMIC_PARTIAL', 503);
            }
            return owner;
        })
        .filter((owner) => owner
            && (!selectedRuntime || owner.runtimeKey === selectedRuntime)
            && (!selectedInstance || owner.instanceId === selectedInstance)
            && (!selectedGeneration || owner.enableGeneration === selectedGeneration)
            && (selectedRelease === null || owner.releaseGeneration === selectedRelease))
        .sort((left, right) => left.ownerKey.localeCompare(right.ownerKey)));
}

function classifyProviderTaskOwnersReadOnly({
    runtimeKey,
    instanceId,
    enableGeneration,
    releaseGeneration,
    nowMs = Date.now(),
    staleAfterMs = PROVIDER_TASK_STALE_AFTER_MS,
} = {}) {
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0
        || !Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) {
        throw ownershipError('provider task classification clock is invalid');
    }
    return Object.freeze(collectProviderTaskOwnersReadOnly({
        runtimeKey,
        instanceId,
        enableGeneration,
        releaseGeneration,
    }).map((owner) => {
        const report = readReport(owner.ownerKey, { initialize: false });
        const heartbeat = readHeartbeat(owner, { initialize: false });
        const classification = report?.state === 'contained'
            ? 'parent-contained'
            : report?.state
            || (nowMs - heartbeat.heartbeatAt <= staleAfterMs ? 'live' : 'stale');
        return Object.freeze({
            classification,
            heartbeatAt: heartbeat?.heartbeatAt || report.reportedAt,
            owner,
            processAuthority: 'inner-runtime-attestation',
        });
    }));
}

function reconcileProviderTaskOwnershipReadOnly({
    registry = {},
    serviceStates = [],
    runtimeReports = [],
    nowMs = Date.now(),
    staleAfterMs = PROVIDER_TASK_STALE_AFTER_MS,
} = {}) {
    if (!isPlainObject(registry) || !Array.isArray(serviceStates) || !Array.isArray(runtimeReports)) {
        throw ownershipError('provider task reconciliation inputs are invalid');
    }
    const parents = new Map(serviceStates.map((entry) => [
        String(entry?.runtimeKey || entry?.containerName || ''),
        entry,
    ]));
    const reports = new Map(runtimeReports.map((entry) => [
        `${String(entry?.runtimeKey || '')}\0${String(entry?.taskId || '')}`,
        entry,
    ]));
    return Object.freeze(classifyProviderTaskOwnersReadOnly({ nowMs, staleAfterMs })
        .map(({ owner, classification: freshness, heartbeatAt }) => {
            const record = registry[owner.runtimeKey];
            const expectedRuntime = record?.runtime === 'podman' ? 'container' : record?.runtime;
            const exactHomeKey = record?.runtime === 'podman'
                ? owner.homeKey === owner.runtimeKey
                : typeof record?.homeKey === 'string' && record.homeKey === owner.homeKey;
            const exactGeneration = Boolean(record?.type === 'agent'
                && record.instanceId === owner.instanceId
                && record.enableGeneration === owner.enableGeneration
                && String(record.releaseGeneration || '') === owner.releaseGeneration
                && exactHomeKey
                && expectedRuntime === owner.runtime);
            const parent = parents.get(owner.runtimeKey);
            const exactParent = Boolean(exactGeneration && parent
                && parent.instanceId === owner.instanceId
                && parent.enableGeneration === owner.enableGeneration
                && String(parent.releaseGeneration || '') === owner.releaseGeneration);
            const report = reports.get(`${owner.runtimeKey}\0${owner.taskId}`);
            const exactReport = Boolean(report
                && report.processIdentity === owner.processIdentity
                && report.instanceId === owner.instanceId
                && report.enableGeneration === owner.enableGeneration);
            let classification;
            if (freshness === 'terminal') classification = 'terminal';
            else if (!exactGeneration) classification = 'mixed-generation';
            else if (freshness === 'pid-reused') classification = 'pid-reused';
            else if (exactReport && report.state === 'pid-reused') classification = 'pid-reused';
            else if (exactReport && report.state === 'terminal') classification = 'terminal';
            else if (freshness === 'stale') classification = 'stale';
            else if (!exactParent || parent.state?.running !== true) classification = 'parent-contained';
            else classification = 'live';
            return Object.freeze({
                classification,
                heartbeatAt,
                role: 'provider-task',
                runtime: owner.runtime,
                runtimeKey: owner.runtimeKey,
                ownerKey: owner.ownerKey,
                instanceId: owner.instanceId,
                enableGeneration: owner.enableGeneration,
                releaseGeneration: owner.releaseGeneration,
                effectiveInstance: owner.alias,
                homeKey: owner.homeKey,
                workdir: owner.workdir,
                logPath: owner.logPath,
                taskId: owner.taskId,
                provider: owner.provider,
                mode: owner.mode,
                pid: owner.pid,
                processGroupId: owner.processGroupId,
                processIdentity: owner.processIdentity,
                processAuthority: 'inner-runtime-attestation',
                readiness: owner.readiness,
                state: classification === 'live' ? 'running' : 'failed',
            });
        }));
}

function removeProviderTaskOwnersAfterContainment(owners, proof = {}) {
    if (!Array.isArray(owners) || proof?.contained !== true
        || !proof.runtimeKey || !proof.instanceId || !proof.enableGeneration
        || !Object.hasOwn(proof, 'releaseGeneration')) {
        throw ownershipError('exact service/container containment proof is required', 'PLOINKY_PROVIDER_TASK_CONTAINMENT_REQUIRED', 409);
    }
    const removed = [];
    for (const owner of owners) {
        const validated = validateStoredOwner(owner, owner?.ownerKey);
        if (validated.runtimeKey !== proof.runtimeKey
            || validated.instanceId !== proof.instanceId
            || validated.enableGeneration !== proof.enableGeneration
            || validated.releaseGeneration !== String(proof.releaseGeneration || '')) {
            throw ownershipError('containment proof does not match captured provider owner', 'PLOINKY_PROVIDER_TASK_CONTAINMENT_REQUIRED', 409);
        }
        writeReport(validated, 'contained');
        if (unlinkExactOwner(validated)) removed.push(validated.ownerKey);
    }
    return Object.freeze(removed);
}

function removeReportedTerminalProviderTaskOwner(entry) {
    if (!entry || entry.classification !== 'terminal'
        || !entry.runtimeKey || !entry.taskId || !entry.ownerKey) {
        throw ownershipError('exact terminal reconciliation evidence is required', 'PLOINKY_PROVIDER_TASK_TERMINAL_MISMATCH', 409);
    }
    const owner = readProviderTaskOwner(entry.runtimeKey, entry.taskId);
    const report = owner ? readReport(owner.ownerKey) : null;
    if (!owner || owner.ownerKey !== entry.ownerKey
        || owner.instanceId !== entry.instanceId
        || owner.enableGeneration !== entry.enableGeneration
        || owner.releaseGeneration !== String(entry.releaseGeneration || '')
        || owner.processIdentity !== entry.processIdentity
        || report?.state !== 'terminal'
        || !sameOwner(report.owner, owner)) {
        throw ownershipError('terminal reconciliation evidence changed identity', 'PLOINKY_PROVIDER_TASK_TERMINAL_MISMATCH', 409);
    }
    if (!unlinkExactOwner(owner)) {
        throw ownershipError('terminal reconciliation owner changed during removal', 'PLOINKY_PROVIDER_TASK_CONFLICT', 409);
    }
    return true;
}

function resolveRetiredProviderTaskCaller(body) {
    exactKeys(body, TERMINAL_REQUEST_KEYS, 'provider task terminal request');
    if (!['completed', 'failed', 'cancelled'].includes(body.terminalState)) return null;
    terminalProof(body);
    const owner = readProviderTaskOwner(body.runtimeKey, body.taskId);
    if (!owner) return null;
    const common = Object.fromEntries(COMMON_REQUEST_KEYS.map((key) => [key, body[key]]));
    const context = normalizeContext({ callerIdentity: owner, selectedRuntime: owner });
    if (!sameOwner(owner, expectedOwner(context, normalizeCommonRequest(common, context)))) return null;
    return Object.freeze({
        agentId: owner.agentId,
        instanceId: owner.instanceId,
        enableGeneration: owner.enableGeneration,
        releaseGeneration: owner.releaseGeneration,
        routeKey: owner.alias,
        containerName: owner.runtimeKey,
        retired: true,
    });
}

function handleProviderTaskOperation({ operation, body, ...options } = {}) {
    if (operation === 'provider-tasks/publish') return publishProviderTask({ body, ...options });
    if (operation === 'provider-tasks/heartbeat') return heartbeatProviderTask({ body, ...options });
    if (operation === 'provider-tasks/log') return appendProviderTaskLog({ body, ...options });
    if (operation === 'provider-tasks/report') return reportProviderTask({ body, ...options });
    if (operation === 'provider-tasks/terminal') return terminalProviderTask({ body, ...options });
    throw ownershipError('provider task operation is unsupported', 'PLOINKY_PROVIDER_TASK_OPERATION_DENIED', 404);
}

export {
    MAX_LOG_CHUNK_BYTES,
    PROVIDER_TASK_OWNER_DIR,
    PROVIDER_TASK_OWNER_SCHEMA_VERSION,
    appendProviderTaskLog,
    brokerOwnerFor,
    classifyProviderTaskOwnersReadOnly,
    collectProviderTaskOwnersReadOnly,
    handleProviderTaskOperation,
    heartbeatProviderTask,
    listProviderTaskOwners,
    providerTaskOwnerKey,
    publishProviderTask,
    readProviderTaskOwner,
    reportProviderTask,
    removeProviderTaskOwnersAfterContainment,
    removeReportedTerminalProviderTaskOwner,
    reconcileProviderTaskOwnershipReadOnly,
    resolveRetiredProviderTaskCaller,
    resolveSelectedProviderRuntime,
    terminalProviderTask,
};
