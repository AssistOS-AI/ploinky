import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BWRAP_LAUNCH_PROTOCOL = 'PLBWLP01';
export const BWRAP_LAUNCH_LIMITS = Object.freeze({
    descriptorBytes: 256 * 1024,
    records: 1024,
    mounts: 96,
    args: 768,
    argumentBytes: 16 * 1024,
    pathBytes: 4096,
});
export const BWRAP_RECORD_TYPES = Object.freeze({
    ARG: 1,
    WORKSPACE: 2,
    WORKDIR: 3,
    HOME: 4,
    RO_PATH: 5,
    DIR: 6,
    TMPFS: 7,
    PROC: 8,
    DEV: 9,
    SYMLINK: 10,
    PREEXEC_BARRIER: 11,
    RO_DATA_PATH: 12,
});
export const BWRAP_SYMLINK_MAPPINGS = Object.freeze({
    'usr-bin': 1,
    'usr-sbin': 2,
    'usr-lib': 3,
    'usr-lib64': 4,
});
export const DEFAULT_PROVIDER_HOME_LEASE_ROOT = '/workspace/.ploinky/run/provider-home-leases';

const RECORD_NAMES = new Set(Object.keys(BWRAP_RECORD_TYPES));
const MAX_INT32 = 0x7fffffff;
const MAX_LEASE_BYTES = 8192;
const MAX_METADATA_BYTES = 4096;
const MAX_METADATA_KEYS = 32;
const MAX_METADATA_DEPTH = 3;
const LEASE_SCHEMA_VERSION = 1;
const LEASE_KEYS = Object.freeze([
    'acquiredAt',
    'generation',
    'homeKey',
    'metadata',
    'ownerPid',
    'ownerStartIdentity',
    'ownerToken',
    'role',
    'schemaVersion',
]);
const FORBIDDEN_BWRAP_OPTIONS = Object.freeze([
    '--bind', '--bind-try', '--ro-bind', '--ro-bind-try',
    '--dev-bind', '--dev-bind-try', '--bind-fd', '--ro-bind-fd',
    '--bind-data', '--ro-bind-data', '--file', '--args', '--seccomp',
    '--add-seccomp-fd', '--block-fd', '--userns', '--userns2',
    '--userns-block-fd', '--pidns', '--sync-fd', '--info-fd',
    '--json-status-fd', '--overlay-src', '--overlay', '--ro-overlay',
    '--tmp-overlay', '--lock-file', '--dir', '--tmpfs', '--proc',
    '--dev', '--mqueue', '--symlink', '--chmod', '--remount-ro',
    '--size', '--file-label', '--exec-label', '--cap-add', '--cap-drop',
    '--keep-fd', '--unshare-user-try', '--unshare-cgroup-try',
]);
const TMPFS_TARGETS = new Set([
    '/tmp',
    '/tmp/cache',
    '/run',
    '/workspace',
    '/workspace/.ploinky',
    '/workspace/.data',
]);
const FIXED_SYSTEM_PATHS = Object.freeze([
    Object.freeze({ source: '/usr', target: '/usr', sourceType: 'directory' }),
    Object.freeze({ source: '/etc/resolv.conf', target: '/etc/resolv.conf', dataFile: true }),
    Object.freeze({ source: '/etc/hosts', target: '/etc/hosts', dataFile: true }),
    Object.freeze({ source: '/etc/passwd', target: '/etc/passwd', dataFile: true }),
    Object.freeze({ source: '/etc/group', target: '/etc/group', dataFile: true }),
    // Fedora's /etc/nsswitch.conf is an authselect symlink. The helper forbids
    // every source symlink, so pin the canonical source at the conventional
    // sandbox destination.
    Object.freeze({ source: '/etc/authselect/nsswitch.conf', target: '/etc/nsswitch.conf', dataFile: true }),
    Object.freeze({ source: '/etc/ld.so.cache', target: '/etc/ld.so.cache', dataFile: true }),
    Object.freeze({ source: '/etc/pki', target: '/etc/pki', sourceType: 'directory' }),
    Object.freeze({ source: '/etc/alternatives', target: '/etc/alternatives', sourceType: 'directory' }),
    Object.freeze({ source: '/etc/crypto-policies', target: '/etc/crypto-policies', sourceType: 'directory' }),
]);

export const TRUSTED_SERVICE_ENV = Object.freeze({
    HOME: '/home/agent',
    PATH: '/opt/ploinky-node/bin:/usr/bin:/bin',
    XDG_CONFIG_HOME: '/home/agent/.config',
    XDG_CACHE_HOME: '/tmp/cache',
    XDG_DATA_HOME: '/home/agent/.local/share',
    XDG_STATE_HOME: '/home/agent/.local/state',
    TMPDIR: '/tmp',
    PLOINKY_WORKSPACE_ROOT: '/workspace',
});

const MAX_TRUSTED_ENV_ENTRIES = 64;
const MAX_TRUSTED_ENV_BYTES = 32 * 1024;
const FORBIDDEN_TRUSTED_ENV_NAMES = new Set([
    'PLOINKY_MASTER_KEY',
    'PLOINKY_DERIVED_MASTER_KEY',
    'PLOINKY_AGENT_SECRET',
    'PLOINKY_AGENT_PRIVATE_KEY',
    'PLOINKY_AGENT_CREDENTIAL_FILE',
]);

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function policyError(message, code = 'PLOINKY_BWRAP_PROTOCOL_INVALID') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be a plain object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${label} must be a plain object`);
    }
}

function assertExactKeys(value, allowed, required, label) {
    assertPlainObject(value, label);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) throw policyError(`${label} contains unknown field ${key}`);
    }
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            throw policyError(`${label} is missing required field ${key}`);
        }
    }
}

function utf8(value, label, { allowEmpty = false, maxBytes = Infinity } = {}) {
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.includes('\0')) {
        throw policyError(`${label} must be a non-NUL string`);
    }
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.toString('utf8') !== value) throw policyError(`${label} must contain well-formed Unicode`);
    if (bytes.length > maxBytes) throw policyError(`${label} exceeds its byte limit`);
    return bytes;
}

function isCleanAbsolutePath(value) {
    let bytes;
    try { bytes = utf8(value, 'absolute path', { maxBytes: BWRAP_LAUNCH_LIMITS.pathBytes - 1 }); } catch (_) { return false; }
    if (bytes.length < 2 || value[0] !== '/' || value.endsWith('/')) return false;
    return value.slice(1).split('/').every((part) => part && part !== '.' && part !== '..');
}

function isCleanRelativePath(value) {
    let bytes;
    try { bytes = utf8(value, 'relative path', { maxBytes: BWRAP_LAUNCH_LIMITS.pathBytes - 1 }); } catch (_) { return false; }
    if (bytes.length === 0 || value[0] === '/' || value.endsWith('/')) return false;
    return value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function requireAbsolutePath(value, label) {
    if (!isCleanAbsolutePath(value)) throw policyError(`${label} must be a normalized non-root absolute path`, 'PLOINKY_PATH_INVALID');
    return value;
}

function requireRelativePath(value, label) {
    if (!isCleanRelativePath(value)) throw policyError(`${label} must be a normalized relative path`, 'PLOINKY_PATH_INVALID');
    return value;
}

function validateRuntimeKey(value) {
    if (typeof value !== 'string' || !value || value.length > 255 || !/^[A-Za-z0-9._-]+$/.test(value)) {
        throw policyError('HOME runtime key must be an exact safe key', 'PLOINKY_HOME_PATH_INVALID');
    }
    requireRelativePath(`.data/${value}`, 'HOME source');
    return value;
}

function frozenRecord(type, fields = {}) {
    if (!RECORD_NAMES.has(type)) throw policyError(`unknown record type ${type}`);
    return Object.freeze({ type, ...fields });
}

export function createArgRecord(value) {
    utf8(value, 'ARG', { maxBytes: BWRAP_LAUNCH_LIMITS.argumentBytes });
    return frozenRecord('ARG', { value });
}

export function createWorkspaceRecord(mode) {
    if (mode !== 'ro' && mode !== 'rw') throw policyError('WORKSPACE mode must be ro or rw');
    return frozenRecord('WORKSPACE', { mode });
}

export function createWorkdirRecord(relativePath) {
    if (relativePath === '' || relativePath === '.' || relativePath === '/workspace') {
        throw policyError('the workspace root cannot be selected writable', 'PLOINKY_WORKDIR_ROOT_FORBIDDEN');
    }
    requireRelativePath(relativePath, 'WORKDIR');
    const parts = relativePath.split('/');
    if (parts[0] === '.data' || (parts[0] === '.ploinky' && (parts.length < 3 || parts[1] !== 'repos'))) {
        throw policyError('WORKDIR selects protected workspace state', 'PLOINKY_WORKDIR_INVALID');
    }
    return frozenRecord('WORKDIR', { path: relativePath });
}

export function createHomeRecord(runtimeKey) {
    return frozenRecord('HOME', { runtimeKey: validateRuntimeKey(runtimeKey) });
}

export function createReadOnlyPathRecord(source, target, sourceType = 'directory') {
    requireAbsolutePath(source, 'RO_PATH source');
    requireAbsolutePath(target, 'RO_PATH target');
    if (sourceType !== 'directory' && sourceType !== 'regular') {
        throw policyError('RO_PATH sourceType must be directory or regular');
    }
    if (
        target === '/proc' || target.startsWith('/proc/')
        || target === '/dev' || target.startsWith('/dev/')
        || target === '/workspace' || target.startsWith('/workspace/')
        || target === '/run/ploinky-agent' || target.startsWith('/run/ploinky-agent/')
        || target === '/home/agent'
    ) {
        throw policyError('RO_PATH target requires a dedicated record', 'PLOINKY_MOUNT_DESTINATION_UNSUPPORTED');
    }
    return frozenRecord('RO_PATH', { source, target, sourceType });
}

export function createReadOnlyDataFileRecord(source, target) {
    requireAbsolutePath(source, 'RO_DATA_PATH source');
    requireAbsolutePath(target, 'RO_DATA_PATH target');
    if (!FIXED_SYSTEM_PATHS.some((entry) => (
        entry.dataFile === true
        && entry.source === source
        && entry.target === target
    ))) {
        throw policyError('RO_DATA_PATH source and target are not an exact fixed data-file mapping', 'PLOINKY_MOUNT_DESTINATION_UNSUPPORTED');
    }
    return frozenRecord('RO_DATA_PATH', { source, target });
}

export function createDirectoryRecord(target) {
    requireAbsolutePath(target, 'DIR target');
    if (!(
        target === '/opt'
        || target === '/home'
        || target === '/workspace/readiness'
        || target === '/run/ploinky-agent'
        || target === '/workspace/.ploinky/repos'
        || target.startsWith('/workspace/.ploinky/repos/')
    )) {
        throw policyError('DIR target is not in the v1 allowlist', 'PLOINKY_MOUNT_DESTINATION_UNSUPPORTED');
    }
    return frozenRecord('DIR', { target });
}

export function createTmpfsRecord(target) {
    if (!TMPFS_TARGETS.has(target)) throw policyError('TMPFS target is not in the v1 allowlist', 'PLOINKY_MOUNT_DESTINATION_UNSUPPORTED');
    return frozenRecord('TMPFS', { target });
}

export function createProcRecord() { return frozenRecord('PROC'); }
export function createDevRecord() { return frozenRecord('DEV'); }

export function createSymlinkRecord(mapping) {
    if (!Object.prototype.hasOwnProperty.call(BWRAP_SYMLINK_MAPPINGS, mapping)) {
        throw policyError('SYMLINK mapping is not in the fixed v1 map');
    }
    return frozenRecord('SYMLINK', { mapping });
}

export function createPreexecBarrierRecord(readyFd, releaseFd) {
    if (
        !Number.isSafeInteger(readyFd) || !Number.isSafeInteger(releaseFd)
        || readyFd <= 3 || releaseFd <= 3 || readyFd > MAX_INT32 || releaseFd > MAX_INT32
        || readyFd === releaseFd
    ) {
        throw policyError('PREEXEC_BARRIER requires two distinct inherited fds above 3');
    }
    return frozenRecord('PREEXEC_BARRIER', { readyFd, releaseFd });
}

export const typedBwrapRecords = Object.freeze({
    arg: createArgRecord,
    workspace: createWorkspaceRecord,
    workdir: createWorkdirRecord,
    home: createHomeRecord,
    readOnlyPath: createReadOnlyPathRecord,
    readOnlyDataFile: createReadOnlyDataFileRecord,
    directory: createDirectoryRecord,
    tmpfs: createTmpfsRecord,
    proc: createProcRecord,
    dev: createDevRecord,
    symlink: createSymlinkRecord,
    preexecBarrier: createPreexecBarrierRecord,
});

function recordTarget(record) {
    switch (record.type) {
    case 'WORKSPACE': return '/workspace';
    case 'WORKDIR': return `/workspace/${record.path}`;
    case 'HOME': return '/home/agent';
    case 'RO_PATH': return record.target;
    case 'RO_DATA_PATH': return record.target;
    case 'DIR':
    case 'TMPFS': return record.target;
    case 'PROC': return '/proc';
    case 'DEV': return '/dev';
    case 'SYMLINK': return `/${record.mapping.replace('usr-', '')}`;
    default: return null;
    }
}

function isForbiddenBwrapOption(value) {
    return FORBIDDEN_BWRAP_OPTIONS.some((option) => value === option || value.startsWith(`${option}=`));
}

function validateRecordShape(record, index) {
    assertPlainObject(record, `record ${index}`);
    if (!RECORD_NAMES.has(record.type)) throw policyError(`record ${index} has unknown type`);
    const fields = {
        ARG: ['type', 'value'],
        WORKSPACE: ['type', 'mode'],
        WORKDIR: ['type', 'path'],
        HOME: ['type', 'runtimeKey'],
        RO_PATH: ['type', 'source', 'target', 'sourceType'],
        RO_DATA_PATH: ['type', 'source', 'target'],
        DIR: ['type', 'target'],
        TMPFS: ['type', 'target'],
        PROC: ['type'],
        DEV: ['type'],
        SYMLINK: ['type', 'mapping'],
        PREEXEC_BARRIER: ['type', 'readyFd', 'releaseFd'],
    }[record.type];
    assertExactKeys(record, new Set(fields), new Set(fields), `record ${index}`);
}

function encodeRecordPayload(record) {
    switch (record.type) {
    case 'ARG': return utf8(createArgRecord(record.value).value, 'ARG', { maxBytes: BWRAP_LAUNCH_LIMITS.argumentBytes });
    case 'WORKSPACE': return Buffer.from([createWorkspaceRecord(record.mode).mode === 'rw' ? 2 : 1]);
    case 'WORKDIR': return utf8(createWorkdirRecord(record.path).path, 'WORKDIR');
    case 'HOME': return utf8(`.data/${createHomeRecord(record.runtimeKey).runtimeKey}`, 'HOME');
    case 'RO_PATH': {
        const checked = createReadOnlyPathRecord(record.source, record.target, record.sourceType);
        const source = utf8(checked.source, 'RO_PATH source');
        const target = utf8(checked.target, 'RO_PATH target');
        if (source.length > 0xffff || target.length > 0xffff) throw policyError('RO_PATH field exceeds uint16');
        const payload = Buffer.allocUnsafe(5 + source.length + target.length);
        payload[0] = checked.sourceType === 'directory' ? 1 : 2;
        payload.writeUInt16BE(source.length, 1);
        payload.writeUInt16BE(target.length, 3);
        source.copy(payload, 5);
        target.copy(payload, 5 + source.length);
        return payload;
    }
    case 'RO_DATA_PATH': {
        const checked = createReadOnlyDataFileRecord(record.source, record.target);
        const source = utf8(checked.source, 'RO_DATA_PATH source');
        const target = utf8(checked.target, 'RO_DATA_PATH target');
        if (source.length > 0xffff || target.length > 0xffff) throw policyError('RO_DATA_PATH field exceeds uint16');
        const payload = Buffer.allocUnsafe(4 + source.length + target.length);
        payload.writeUInt16BE(source.length, 0);
        payload.writeUInt16BE(target.length, 2);
        source.copy(payload, 4);
        target.copy(payload, 4 + source.length);
        return payload;
    }
    case 'DIR': return utf8(createDirectoryRecord(record.target).target, 'DIR');
    case 'TMPFS': return utf8(createTmpfsRecord(record.target).target, 'TMPFS');
    case 'PROC': createProcRecord(); return Buffer.alloc(0);
    case 'DEV': createDevRecord(); return Buffer.alloc(0);
    case 'SYMLINK': return Buffer.from([BWRAP_SYMLINK_MAPPINGS[createSymlinkRecord(record.mapping).mapping]]);
    case 'PREEXEC_BARRIER': {
        const checked = createPreexecBarrierRecord(record.readyFd, record.releaseFd);
        const payload = Buffer.allocUnsafe(8);
        payload.writeUInt32BE(checked.readyFd, 0);
        payload.writeUInt32BE(checked.releaseFd, 4);
        return payload;
    }
    default: throw policyError(`unsupported record type ${record.type}`);
    }
}

function validateRecordPolicy(records) {
    let separator = false;
    let commandSeen = false;
    let argCount = 0;
    let mountCount = 0;
    let preexecSeen = false;
    const targets = new Set();
    const targetKinds = new Map();

    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        validateRecordShape(record, index);
        // Validate each typed value before it can influence duplicate/order
        // accounting. The final encoder repeats this pure validation while
        // constructing bytes, keeping malformed values out of both stages.
        encodeRecordPayload(record);
        if (record.type === 'ARG') {
            argCount += 1;
            if (argCount > BWRAP_LAUNCH_LIMITS.args) throw policyError('too many ARG records');
            if (!separator && record.value === '--') {
                separator = true;
                continue;
            }
            if (separator) {
                commandSeen = true;
                continue;
            }
            if (record.value === '--perms' || record.value.startsWith('--perms=')) {
                throw policyError('credential data arguments require the dedicated trusted credential builder');
            }
            if (isForbiddenBwrapOption(record.value)) {
                throw policyError(`raw filesystem/fd bwrap option ${record.value} is forbidden`, 'PLOINKY_BWRAP_OPTION_FORBIDDEN');
            }
            continue;
        }
        if (separator) throw policyError('mount records are forbidden after the bwrap separator');
        if (record.type === 'PREEXEC_BARRIER') {
            if (preexecSeen) throw policyError('duplicate PREEXEC_BARRIER record');
            preexecSeen = true;
            continue;
        }
        mountCount += 1;
        if (mountCount > BWRAP_LAUNCH_LIMITS.mounts) throw policyError('too many mount records');
        const target = recordTarget(record);
        if (targets.has(target)) throw policyError(`duplicate mount destination ${target}`, 'PLOINKY_BWRAP_DUPLICATE_MOUNT');
        for (const prior of targets) {
            if (prior.startsWith(`${target}/`)) {
                throw policyError(`later mount ${target} hides prior target ${prior}`, 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID');
            }
        }
        if (target.startsWith('/workspace/') && !targets.has('/workspace')) {
            throw policyError('workspace root must precede descendant mounts', 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID');
        }
        if (record.type === 'WORKDIR' && !records.slice(0, index).some((item) => item.type === 'WORKSPACE')) {
            throw policyError('WORKDIR requires WORKSPACE first', 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID');
        }
        if (record.type === 'RO_PATH' && target.startsWith('/home/agent/') && !targets.has('/home/agent')) {
            throw policyError('HOME must precede executable overlays', 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID');
        }
        if (record.type === 'DIR' && target.startsWith('/run/') && !targets.has('/run')) {
            throw policyError('/run tmpfs must precede its directories', 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID');
        }
        if (record.type === 'DIR' && target === '/workspace/readiness' && targetKinds.get('/workspace') !== 'TMPFS') {
            throw policyError('private readiness requires /workspace TMPFS first', 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID');
        }
        if (record.type === 'TMPFS' && target === '/tmp/cache' && !targets.has('/tmp')) {
            throw policyError('/tmp tmpfs must precede /tmp/cache', 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID');
        }
        if (target === '/workspace/.ploinky/repos' || target.startsWith('/workspace/.ploinky/repos/')) {
            if (targetKinds.get('/workspace/.ploinky') !== 'TMPFS') {
                throw policyError('managed repository reconstruction requires the .ploinky mask first', 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID');
            }
            if (target !== '/workspace/.ploinky/repos' && targetKinds.get('/workspace/.ploinky/repos') !== 'DIR') {
                throw policyError('managed repository reconstruction requires its root directory first', 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID');
            }
            const parts = target.split('/');
            for (let length = 5; length < parts.length; length += 1) {
                const parent = parts.slice(0, length).join('/');
                if (targetKinds.get(parent) !== 'DIR') {
                    throw policyError(`managed repository parent ${parent} must be created first`, 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID');
                }
            }
        }
        targets.add(target);
        targetKinds.set(target, record.type);
    }
    if (!separator || !commandSeen) throw policyError('launch requires -- followed by an explicit command');
}

export function encodeBwrapLaunchDescriptor(records) {
    if (!Array.isArray(records) || records.length === 0 || records.length > BWRAP_LAUNCH_LIMITS.records) {
        throw policyError('launch record count is outside the v1 bound');
    }
    validateRecordPolicy(records);
    let descriptorLength = 16;
    const encoded = records.map((record, index) => {
        const payload = encodeRecordPayload(record);
        if (payload.length > 0xffffffff) throw policyError(`record ${index} payload exceeds uint32`);
        descriptorLength += 8 + payload.length;
        if (descriptorLength > BWRAP_LAUNCH_LIMITS.descriptorBytes) {
            throw policyError('launch descriptor exceeds 256 KiB', 'PLOINKY_BWRAP_PROTOCOL_TOO_LARGE');
        }
        const header = Buffer.alloc(8);
        header[0] = BWRAP_RECORD_TYPES[record.type];
        header.writeUInt32BE(payload.length, 4);
        return Buffer.concat([header, payload]);
    });
    const header = Buffer.alloc(16);
    header.write(BWRAP_LAUNCH_PROTOCOL, 0, 'ascii');
    header.writeUInt32BE(records.length, 8);
    const descriptor = Buffer.concat([header, ...encoded]);
    if (descriptor.length !== descriptorLength) throw policyError('launch descriptor length accounting failed');
    return descriptor;
}

export function buildTrustedServicePolicy(input) {
    const allowed = new Set([
        'runtimeKey', 'command', 'nodeRuntimePath', 'agentRuntimePath',
        'codePath', 'codeDependenciesPath', 'agentDependenciesPath', 'preexecBarrier',
        'environment',
    ]);
    const required = new Set([
        'runtimeKey', 'command', 'nodeRuntimePath', 'agentRuntimePath',
        'codePath', 'codeDependenciesPath', 'agentDependenciesPath',
    ]);
    assertExactKeys(input, allowed, required, 'trusted service policy input');
    validateRuntimeKey(input.runtimeKey);
    if (!Array.isArray(input.command) || input.command.length === 0) {
        throw policyError('trusted service command must be a non-empty argv array');
    }
    const command = Object.freeze(input.command.map((arg) => {
        utf8(arg, 'command argument', { maxBytes: BWRAP_LAUNCH_LIMITS.argumentBytes });
        return arg;
    }));
    const nodeRuntimePath = requireAbsolutePath(input.nodeRuntimePath, 'Node runtime source');
    const agentRuntimePath = requireAbsolutePath(input.agentRuntimePath, 'Agent runtime source');
    const codePath = requireAbsolutePath(input.codePath, 'agent code source');
    const codeDependenciesPath = requireAbsolutePath(input.codeDependenciesPath, 'code dependency source');
    const agentDependenciesPath = requireAbsolutePath(input.agentDependenciesPath, 'Agent dependency source');
    const suppliedEnvironment = input.environment ?? {};
    assertPlainObject(suppliedEnvironment, 'trusted service environment');
    const environmentEntries = Object.entries(suppliedEnvironment);
    if (environmentEntries.length > MAX_TRUSTED_ENV_ENTRIES) {
        throw policyError('trusted service environment contains too many entries');
    }
    let environmentBytes = 0;
    const dynamicEnvironment = {};
    for (const [name, value] of environmentEntries.sort(([left], [right]) => compareText(left, right))) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || Buffer.byteLength(name) > 128) {
            throw policyError(`trusted service environment name ${name} is invalid`);
        }
        if (FORBIDDEN_TRUSTED_ENV_NAMES.has(name)) {
            throw policyError(`trusted service environment ${name} is forbidden`);
        }
        if (typeof value !== 'string') throw policyError(`trusted service environment ${name} must be a string`);
        const valueBytes = utf8(value, `trusted service environment ${name}`, { allowEmpty: true, maxBytes: 4096 });
        environmentBytes += Buffer.byteLength(name) + valueBytes.length;
        if (environmentBytes > MAX_TRUSTED_ENV_BYTES) throw policyError('trusted service environment exceeds its byte limit');
        if (Object.prototype.hasOwnProperty.call(TRUSTED_SERVICE_ENV, name)) {
            if (TRUSTED_SERVICE_ENV[name] !== value) throw policyError(`trusted service environment cannot override ${name}`);
            continue;
        }
        dynamicEnvironment[name] = value;
    }
    const env = Object.freeze({ ...TRUSTED_SERVICE_ENV, ...dynamicEnvironment });

    const records = [
        ...FIXED_SYSTEM_PATHS.map((entry) => entry.dataFile
            ? createReadOnlyDataFileRecord(entry.source, entry.target)
            : createReadOnlyPathRecord(entry.source, entry.target, entry.sourceType)),
        createSymlinkRecord('usr-bin'),
        createSymlinkRecord('usr-sbin'),
        createSymlinkRecord('usr-lib'),
        createSymlinkRecord('usr-lib64'),
        createDirectoryRecord('/opt'),
        createReadOnlyPathRecord(nodeRuntimePath, '/opt/ploinky-node'),
        createReadOnlyPathRecord(agentRuntimePath, '/Agent'),
        createReadOnlyPathRecord(codePath, '/code'),
        createReadOnlyPathRecord(codeDependenciesPath, '/code/node_modules'),
        createReadOnlyPathRecord(agentDependenciesPath, '/Agent/node_modules'),
        createWorkspaceRecord('rw'),
        createDirectoryRecord('/home'),
        createHomeRecord(input.runtimeKey),
        createTmpfsRecord('/tmp'),
        createTmpfsRecord('/run'),
        createProcRecord(),
        createDevRecord(),
        createArgRecord('--unshare-user'),
        createArgRecord('--unshare-pid'),
        createArgRecord('--unshare-ipc'),
        createArgRecord('--unshare-uts'),
        createArgRecord('--share-net'),
        createArgRecord('--clearenv'),
        ...Object.entries(env).sort(([left], [right]) => compareText(left, right)).flatMap(([name, value]) => [
            createArgRecord('--setenv'),
            createArgRecord(name),
            createArgRecord(value),
        ]),
        createArgRecord('--chdir'),
        createArgRecord('/code'),
    ];
    if (input.preexecBarrier !== undefined) {
        assertExactKeys(input.preexecBarrier, new Set(['readyFd', 'releaseFd']), new Set(['readyFd', 'releaseFd']), 'preexecBarrier');
        records.push(createPreexecBarrierRecord(input.preexecBarrier.readyFd, input.preexecBarrier.releaseFd));
    }
    records.push(createArgRecord('--'), ...command.map(createArgRecord));
    validateRecordPolicy(records);
    return Object.freeze({ records: Object.freeze(records), env, command });
}

function leaseError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function normalizeBoundedText(value, label, maxBytes, pattern = null) {
    let bytes;
    try { bytes = utf8(value, label, { maxBytes }); } catch (_) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', `${label} is invalid`);
    }
    if (bytes.length === 0 || value !== value.trim() || (pattern && !pattern.test(value))) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', `${label} is invalid`);
    }
    return value;
}

function normalizeMetadata(value, depth = 0, counter = { keys: 0 }) {
    if (depth > MAX_METADATA_DEPTH) throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease metadata is too deep');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return normalizeBoundedText(value, 'lease metadata string', 512);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease metadata number is invalid');
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > MAX_METADATA_KEYS) throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease metadata array is too large');
        return value.map((item) => normalizeMetadata(item, depth + 1, counter));
    }
    try { assertPlainObject(value, 'lease metadata'); } catch (_) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease metadata must contain only bounded JSON values');
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
        counter.keys += 1;
        if (counter.keys > MAX_METADATA_KEYS || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) {
            throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease metadata key is invalid');
        }
        result[key] = normalizeMetadata(value[key], depth + 1, counter);
    }
    return result;
}

function deepFreezeJson(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreezeJson(child);
        Object.freeze(value);
    }
    return value;
}

function normalizeLeaseRoot(value) {
    if (!isCleanAbsolutePath(value)) throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease root must be a normalized absolute path');
    return value;
}

function readLinuxIdentity(pid, fsImpl) {
    try {
        const stat = fsImpl.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const commandEnd = stat.lastIndexOf(') ');
        if (commandEnd < 0) return null;
        const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
        if (fields[0] === 'Z') return { state: 'dead' };
        const startTicks = fields[19];
        if (!startTicks) return null;
        let bootId = '';
        try { bootId = fsImpl.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (_) { }
        return { state: 'live', startIdentity: `linux-proc:${bootId || 'unknown-boot'}:${startTicks}` };
    } catch (_) {
        return null;
    }
}

export function inspectProviderLeaseProcess(pid, {
    fsImpl = fs,
    execFileSyncImpl = execFileSync,
    killImpl = process.kill.bind(process),
} = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_INT32) return Object.freeze({ state: 'dead' });
    try {
        killImpl(pid, 0);
    } catch (error) {
        if (error?.code === 'ESRCH') return Object.freeze({ state: 'dead' });
        if (error?.code !== 'EPERM') return Object.freeze({ state: 'unknown' });
    }
    const linux = readLinuxIdentity(pid, fsImpl);
    if (linux) return Object.freeze(linux);
    try {
        const startedAt = execFileSyncImpl('ps', ['-p', String(pid), '-o', 'lstart='], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim().replace(/\s+/g, ' ');
        if (startedAt) return Object.freeze({ state: 'live', startIdentity: `ps-lstart:${startedAt}` });
    } catch (_) { }
    return Object.freeze({ state: 'unknown' });
}

function leaseDependencies(overrides = {}) {
    assertExactKeys(overrides, new Set(['fs', 'inspectProcessIdentity', 'randomBytes', 'now']), new Set(), 'lease dependencies');
    return {
        fs: overrides.fs || fs,
        inspectProcessIdentity: overrides.inspectProcessIdentity || inspectProviderLeaseProcess,
        randomBytes: overrides.randomBytes || randomBytes,
        now: overrides.now || Date.now,
    };
}

function normalizeLeaseInput(input, dependencies) {
    const allowed = new Set(['homeKey', 'generation', 'role', 'metadata', 'leaseRoot', 'ownerPid', 'ownerStartIdentity', 'ownerToken']);
    assertExactKeys(input, allowed, new Set(['homeKey', 'generation', 'role']), 'provider HOME lease input');
    const homeKey = validateRuntimeKey(input.homeKey);
    const generation = normalizeBoundedText(input.generation, 'lease generation', 256, /^[A-Za-z0-9][A-Za-z0-9:._-]*$/);
    const role = normalizeBoundedText(input.role, 'lease role', 64, /^[a-z][a-z0-9-]*$/);
    const metadata = deepFreezeJson(normalizeMetadata(input.metadata ?? {}));
    if (Buffer.byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease metadata exceeds its byte limit');
    }
    const ownerPid = input.ownerPid ?? process.pid;
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || ownerPid > MAX_INT32) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease owner pid is invalid');
    }
    let ownerStartIdentity = input.ownerStartIdentity;
    if (ownerStartIdentity === undefined) {
        const current = dependencies.inspectProcessIdentity(ownerPid);
        if (current?.state !== 'live' || !current.startIdentity) {
            throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'cannot prove lease owner process identity');
        }
        ownerStartIdentity = current.startIdentity;
    }
    ownerStartIdentity = normalizeBoundedText(ownerStartIdentity, 'lease owner start identity', 256, /^[A-Za-z0-9][A-Za-z0-9:._+ -]*$/);
    let ownerToken = input.ownerToken;
    if (ownerToken === undefined) {
        ownerToken = dependencies.randomBytes(32).toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }
    ownerToken = normalizeBoundedText(ownerToken, 'lease owner token', 128, /^[A-Za-z0-9_-]{32,128}$/);
    return {
        homeKey,
        generation,
        role,
        metadata,
        leaseRoot: normalizeLeaseRoot(input.leaseRoot ?? DEFAULT_PROVIDER_HOME_LEASE_ROOT),
        ownerPid,
        ownerStartIdentity,
        ownerToken,
    };
}

function ensureLeaseRoot(root, fsImpl) {
    fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = fsImpl.lstatSync(root);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (currentUid !== null && stat.uid !== currentUid)) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease root ownership, type, or permissions are invalid');
    }
}

function canonicalLeaseRecord(value) {
    return {
        acquiredAt: value.acquiredAt,
        generation: value.generation,
        homeKey: value.homeKey,
        metadata: value.metadata,
        ownerPid: value.ownerPid,
        ownerStartIdentity: value.ownerStartIdentity,
        ownerToken: value.ownerToken,
        role: value.role,
        schemaVersion: value.schemaVersion,
    };
}

function serializeLeaseRecord(record) {
    return `${JSON.stringify(canonicalLeaseRecord(record))}\n`;
}

function validateLeaseRecord(parsed, expectedHomeKey) {
    assertExactKeys(parsed, new Set(LEASE_KEYS), new Set(LEASE_KEYS), 'provider HOME lease record');
    if (parsed.schemaVersion !== LEASE_SCHEMA_VERSION || parsed.homeKey !== expectedHomeKey) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease schema or key is invalid');
    }
    validateRuntimeKey(parsed.homeKey);
    normalizeBoundedText(parsed.generation, 'lease generation', 256, /^[A-Za-z0-9][A-Za-z0-9:._-]*$/);
    normalizeBoundedText(parsed.role, 'lease role', 64, /^[a-z][a-z0-9-]*$/);
    normalizeBoundedText(parsed.ownerStartIdentity, 'lease owner start identity', 256, /^[A-Za-z0-9][A-Za-z0-9:._+ -]*$/);
    normalizeBoundedText(parsed.ownerToken, 'lease owner token', 128, /^[A-Za-z0-9_-]{32,128}$/);
    if (!Number.isSafeInteger(parsed.ownerPid) || parsed.ownerPid <= 0 || parsed.ownerPid > MAX_INT32) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease owner pid is invalid');
    }
    if (typeof parsed.acquiredAt !== 'string') {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease timestamp is invalid');
    }
    let canonicalTime;
    try { canonicalTime = new Date(parsed.acquiredAt).toISOString(); } catch (_) { canonicalTime = ''; }
    if (canonicalTime !== parsed.acquiredAt) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease timestamp is invalid');
    }
    const metadata = deepFreezeJson(normalizeMetadata(parsed.metadata));
    if (JSON.stringify(metadata) !== JSON.stringify(parsed.metadata) || Buffer.byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease metadata is not canonical');
    }
    return Object.freeze(canonicalLeaseRecord({ ...parsed, metadata }));
}

function readLeaseSnapshot(leasePath, homeKey, fsImpl, { minimumLinks = 1, maximumLinks = 1 } = {}) {
    const noFollow = fsImpl.constants?.O_NOFOLLOW;
    if (!Number.isInteger(noFollow) || noFollow === 0) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'O_NOFOLLOW is required for provider HOME lease reads');
    }
    let descriptor;
    try { descriptor = fsImpl.openSync(leasePath, fsImpl.constants.O_RDONLY | noFollow); } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error?.code === 'ELOOP') throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease file is a symlink');
        throw error;
    }
    let stat;
    let raw;
    try {
        stat = fsImpl.fstatSync(descriptor);
        const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
        if (
            !stat.isFile() || stat.nlink < minimumLinks || stat.nlink > maximumLinks
            || stat.size <= 0 || stat.size > MAX_LEASE_BYTES || (stat.mode & 0o077) !== 0
            || (currentUid !== null && stat.uid !== currentUid)
        ) {
            throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease file is unsafe');
        }
        raw = fsImpl.readFileSync(descriptor, 'utf8');
    } finally {
        fsImpl.closeSync(descriptor);
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease record is malformed');
    }
    let record;
    try { record = validateLeaseRecord(parsed, homeKey); } catch (error) {
        error.code = 'PLOINKY_PROVIDER_HOME_LEASE_INVALID';
        throw error;
    }
    if (serializeLeaseRecord(record) !== raw) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease record is not canonical');
    }
    return Object.freeze({
        record,
        raw,
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        size: stat.size,
    });
}

function sameLeaseSnapshot(left, right) {
    return Boolean(left && right)
        && left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.size === right.size
        && left.raw === right.raw;
}

function leaseOperationPrefix(leasePath) {
    return `${path.basename(leasePath)}.operation-`;
}

function leaseOperationArtifacts(leasePath, fsImpl) {
    const prefix = leaseOperationPrefix(leasePath);
    return fsImpl.readdirSync(path.dirname(leasePath))
        .filter((name) => name.startsWith(prefix));
}

function assertNoLeaseOperationArtifacts(leasePath, fsImpl) {
    if (leaseOperationArtifacts(leasePath, fsImpl).length > 0) {
        throw leaseError(
            'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
            'provider HOME lease has an interrupted or concurrent exact-removal operation',
        );
    }
}

function operationSnapshotId(snapshot) {
    return createHash('sha256').update(snapshot.raw).digest('hex').slice(0, 32);
}

function recoverLeaseOperationArtifacts(leasePath, homeKey, dependencies) {
    const names = leaseOperationArtifacts(leasePath, dependencies.fs);
    if (names.length === 0) return;
    const escapedPrefix = leaseOperationPrefix(leasePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const groups = new Map();
    for (const name of names) {
        const match = name.match(new RegExp(`^${escapedPrefix}([a-f0-9]{32})\\.(claim|quarantine)$`));
        if (!match) {
            throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease has malformed operation state');
        }
        if (!groups.has(match[1])) groups.set(match[1], new Map());
        const group = groups.get(match[1]);
        if (group.has(match[2])) {
            throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease has duplicate operation state');
        }
        group.set(match[2], path.join(path.dirname(leasePath), name));
    }
    if (groups.size !== 1) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease has multiple interrupted operations');
    }

    const [[operationId, artifacts]] = groups;
    const claim = artifacts.has('claim')
        ? readLeaseSnapshot(artifacts.get('claim'), homeKey, dependencies.fs, { minimumLinks: 1, maximumLinks: 2 })
        : null;
    const quarantine = artifacts.has('quarantine')
        ? readLeaseSnapshot(artifacts.get('quarantine'), homeKey, dependencies.fs, { minimumLinks: 1, maximumLinks: 2 })
        : null;
    const operationSnapshot = claim || quarantine;
    if (
        !operationSnapshot
        || operationSnapshotId(operationSnapshot) !== operationId
        || (claim && quarantine && !sameLeaseSnapshot(claim, quarantine))
    ) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease operation state is not exact');
    }

    const owner = dependencies.inspectProcessIdentity(operationSnapshot.record.ownerPid);
    if (!owner || !['dead', 'live', 'unknown'].includes(owner.state)) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'process identity inspector returned an invalid result');
    }
    if (owner.state === 'unknown') throw busyLease(operationSnapshot.record, true);
    if (owner.state === 'live' && (!owner.startIdentity || owner.startIdentity === operationSnapshot.record.ownerStartIdentity)) {
        throw busyLease(operationSnapshot.record, !owner.startIdentity);
    }

    // Operation paths are never acquisition authorities. Once their recorded
    // owner is proved dead or PID-reused, removing only these paths is safe;
    // a successor at the canonical lease path is never touched.
    if (quarantine) dependencies.fs.unlinkSync(artifacts.get('quarantine'));
    if (claim) dependencies.fs.unlinkSync(artifacts.get('claim'));
}

function removeExactLeaseSnapshot(leasePath, homeKey, snapshot, fsImpl) {
    assertNoLeaseOperationArtifacts(leasePath, fsImpl);
    const operationId = operationSnapshotId(snapshot);
    const operationBase = `${leasePath}.operation-${operationId}`;
    const claimPath = `${operationBase}.claim`;
    const quarantinePath = `${operationBase}.quarantine`;
    let claimCreated = false;
    let primaryRenamed = false;

    try {
        try {
            fsImpl.linkSync(leasePath, claimPath);
            claimCreated = true;
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw error;
        }

        const competingArtifacts = fsImpl.readdirSync(path.dirname(leasePath))
            .filter((name) => name.startsWith(leaseOperationPrefix(leasePath)))
            .filter((name) => name !== path.basename(claimPath));
        if (competingArtifacts.length > 0) {
            throw leaseError(
                'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
                'provider HOME lease has concurrent exact-removal operations',
            );
        }

        const claim = readLeaseSnapshot(claimPath, homeKey, fsImpl, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        if (!sameLeaseSnapshot(claim, snapshot)) return false;

        // Rename is the atomic release point. Any successor may claim the
        // primary path immediately afterwards; cleanup only touches the
        // operation-private hardlinks, never that primary path again.
        primaryRenamed = true;
        fsImpl.renameSync(leasePath, quarantinePath);
        const postClaim = readLeaseSnapshot(claimPath, homeKey, fsImpl, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        const quarantined = readLeaseSnapshot(quarantinePath, homeKey, fsImpl, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        if (
            !sameLeaseSnapshot(postClaim, snapshot)
            || !sameLeaseSnapshot(quarantined, snapshot)
        ) {
            throw leaseError(
                'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
                'provider HOME lease changed during exact removal',
            );
        }

        fsImpl.unlinkSync(quarantinePath);
        fsImpl.unlinkSync(claimPath);
        return true;
    } catch (error) {
        // Before the primary rename, removing our private hardlink is safe.
        // Afterwards, preserve every artifact and fail closed for inspection.
        if (claimCreated && !primaryRenamed) {
            try { fsImpl.unlinkSync(claimPath); } catch (_) { }
        }
        throw error;
    }
}

function busyLease(record, uncertain = false) {
    const error = leaseError('PLOINKY_PROVIDER_HOME_BUSY', `provider HOME ${record.homeKey} is owned by a live or unverified ${record.role} process`);
    error.owner = Object.freeze({
        acquiredAt: record.acquiredAt,
        generation: record.generation,
        homeKey: record.homeKey,
        metadata: record.metadata,
        ownerPid: record.ownerPid,
        ownerStartIdentity: record.ownerStartIdentity,
        role: record.role,
        uncertain,
    });
    return error;
}

export function acquireProviderHomeLease(input, dependencyOverrides = {}) {
    const dependencies = leaseDependencies(dependencyOverrides);
    const normalized = normalizeLeaseInput(input, dependencies);
    ensureLeaseRoot(normalized.leaseRoot, dependencies.fs);
    const leasePath = path.join(normalized.leaseRoot, `${normalized.homeKey}.lease.json`);
    recoverLeaseOperationArtifacts(leasePath, normalized.homeKey, dependencies);
    let recoveredStaleOwner = null;

    for (let attempt = 0; attempt < 8; attempt += 1) {
        assertNoLeaseOperationArtifacts(leasePath, dependencies.fs);
        const record = Object.freeze(canonicalLeaseRecord({
            schemaVersion: LEASE_SCHEMA_VERSION,
            homeKey: normalized.homeKey,
            ownerToken: normalized.ownerToken,
            ownerPid: normalized.ownerPid,
            ownerStartIdentity: normalized.ownerStartIdentity,
            generation: normalized.generation,
            role: normalized.role,
            metadata: normalized.metadata,
            acquiredAt: new Date(dependencies.now()).toISOString(),
        }));
        const payload = serializeLeaseRecord(record);
        if (Buffer.byteLength(payload) > MAX_LEASE_BYTES) {
            throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease record is too large');
        }
        try {
            dependencies.fs.writeFileSync(leasePath, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            return Object.freeze({
                ...record,
                leasePath,
                leaseRoot: normalized.leaseRoot,
                recoveredStaleOwner,
            });
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }

        const snapshot = readLeaseSnapshot(leasePath, normalized.homeKey, dependencies.fs);
        if (!snapshot) continue;
        const owner = dependencies.inspectProcessIdentity(snapshot.record.ownerPid);
        if (!owner || !['dead', 'live', 'unknown'].includes(owner.state)) {
            throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'process identity inspector returned an invalid result');
        }
        if (owner.state === 'live' && (typeof owner.startIdentity !== 'string' || owner.startIdentity.length === 0)) {
            throw busyLease(snapshot.record, true);
        }
        if (owner.state === 'live' && owner.startIdentity === snapshot.record.ownerStartIdentity) {
            throw busyLease(snapshot.record);
        }
        if (owner.state === 'unknown') throw busyLease(snapshot.record, true);
        if (removeExactLeaseSnapshot(leasePath, normalized.homeKey, snapshot, dependencies.fs)) {
            recoveredStaleOwner = Object.freeze({
                generation: snapshot.record.generation,
                ownerPid: snapshot.record.ownerPid,
                ownerStartIdentity: snapshot.record.ownerStartIdentity,
                role: snapshot.record.role,
                reason: owner.state === 'dead' ? 'dead' : 'pid-reused',
            });
        }
    }
    throw leaseError('PLOINKY_PROVIDER_HOME_BUSY', `provider HOME ${normalized.homeKey} lease changed during recovery`);
}

function exactTokenEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function releaseProviderHomeLease(lease, dependencyOverrides = {}) {
    assertPlainObject(lease, 'provider HOME lease handle');
    const dependencies = leaseDependencies(dependencyOverrides);
    const homeKey = validateRuntimeKey(lease.homeKey);
    const leaseRoot = normalizeLeaseRoot(lease.leaseRoot ?? DEFAULT_PROVIDER_HOME_LEASE_ROOT);
    const ownerToken = normalizeBoundedText(lease.ownerToken, 'lease owner token', 128, /^[A-Za-z0-9_-]{32,128}$/);
    const leasePath = path.join(leaseRoot, `${homeKey}.lease.json`);
    ensureLeaseRoot(leaseRoot, dependencies.fs);
    assertNoLeaseOperationArtifacts(leasePath, dependencies.fs);
    const snapshot = readLeaseSnapshot(leasePath, homeKey, dependencies.fs);
    if (!snapshot) throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_NOT_FOUND', 'provider HOME lease no longer exists');
    if (!exactTokenEqual(snapshot.record.ownerToken, ownerToken)) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_NOT_OWNER', 'provider HOME lease belongs to another owner');
    }
    if (!removeExactLeaseSnapshot(leasePath, homeKey, snapshot, dependencies.fs)) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_CHANGED', 'provider HOME lease changed before release');
    }
    return true;
}

export async function withProviderHomeLease(input, callback, dependencyOverrides = {}) {
    if (typeof callback !== 'function') throw new TypeError('provider HOME lease requires a callback');
    const lease = acquireProviderHomeLease(input, dependencyOverrides);
    let callbackError = null;
    try {
        return await callback(lease);
    } catch (error) {
        callbackError = error;
        throw error;
    } finally {
        try {
            releaseProviderHomeLease(lease, dependencyOverrides);
        } catch (releaseError) {
            if (callbackError) callbackError.message += `; ${releaseError.message}`;
            else throw releaseError;
        }
    }
}
