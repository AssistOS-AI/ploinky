import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn as spawnChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    inspectProcessIdentity,
    normalizeProcessIdentity,
} from './processIdentity.mjs';
import { assertAgentCredentialContext } from './agentCredentialContext.mjs';

export const BWRAP_LAUNCH_PROTOCOL = 'PLBWLP02';
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
export const BWRAP_HOME_SOURCE_KINDS = Object.freeze({
    SANDBOX_WORKSPACE_V2: 'sandbox-workspace-v2',
    CONTAINER_NATIVE: 'container-native',
});
export const BWRAP_SYMLINK_MAPPINGS = Object.freeze({
    'usr-bin': 1,
    'usr-sbin': 2,
    'usr-lib': 3,
    'usr-lib64': 4,
});
export const DEFAULT_PROVIDER_HOME_LEASE_ROOT = '/workspace/.ploinky/run/provider-home-leases';
export const PROVIDER_SANDBOX_HELPER = '/usr/local/libexec/ploinky-bwrap-launch';
export const PROVIDER_SANDBOX_MODES = Object.freeze({
    TASK: 'task',
    READINESS: 'readiness',
});
export const PROVIDER_SANDBOX_PROVIDERS = Object.freeze({
    OPENCODE: 'opencode',
    PI: 'pi',
    CODEX: 'codex',
});

const RECORD_NAMES = new Set(Object.keys(BWRAP_RECORD_TYPES));
const TRUSTED_CREDENTIAL_RECORDS = new WeakSet();
const MAX_INT32 = 0x7fffffff;
const MAX_LEASE_BYTES = 8192;
const MAX_METADATA_BYTES = 4096;
const MAX_METADATA_KEYS = 32;
const MAX_METADATA_DEPTH = 3;
const DEFAULT_PROVIDER_TERM_GRACE_MS = 250;
const DEFAULT_PROVIDER_KILL_GRACE_MS = 2_000;
const LEASE_SCHEMA_VERSION = 2;
const LEASE_LINEAGE_SCHEMA_VERSION = 2;
const MAX_LEASE_LINEAGE_BYTES = 1024;
const LEASE_KEYS = Object.freeze([
    'acquiredAt',
    'generation',
    'homeKey',
    'metadata',
    'ownerPid',
    'ownerStartIdentity',
    'ownerToken',
    'ownerUid',
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
const CONTAINER_SYSTEM_PATHS = Object.freeze([
    Object.freeze({ source: '/usr', target: '/usr', sourceType: 'directory' }),
    Object.freeze({ source: '/etc/resolv.conf', target: '/etc/resolv.conf', dataFile: true }),
    Object.freeze({ source: '/etc/hosts', target: '/etc/hosts', dataFile: true }),
    Object.freeze({ source: '/etc/passwd', target: '/etc/passwd', dataFile: true }),
    Object.freeze({ source: '/etc/group', target: '/etc/group', dataFile: true }),
    Object.freeze({ source: '/etc/nsswitch.conf', target: '/etc/nsswitch.conf', dataFile: true }),
    Object.freeze({ source: '/etc/ld.so.cache', target: '/etc/ld.so.cache', dataFile: true }),
    Object.freeze({ source: '/etc/ssl', target: '/etc/ssl', sourceType: 'directory' }),
]);
const FIXED_DATA_FILE_MAPPINGS = Object.freeze([
    ...FIXED_SYSTEM_PATHS,
    ...CONTAINER_SYSTEM_PATHS,
].filter((entry, index, entries) => entry.dataFile === true && entries.findIndex((candidate) => (
    candidate.dataFile === true
    && candidate.source === entry.source
    && candidate.target === entry.target
)) === index));

const PROVIDER_PROFILES = Object.freeze({
    [PROVIDER_SANDBOX_PROVIDERS.OPENCODE]: Object.freeze({
        executable: '/home/agent/.opencode/bin/opencode',
        pathPrefix: '/home/agent/.opencode/bin',
        immutableRoots: Object.freeze([
            Object.freeze({
                source: '/home/agent/.opencode/bin/opencode',
                target: '/home/agent/.opencode/bin/opencode',
                sourceType: 'regular',
            }),
        ]),
        readinessArgs: Object.freeze(['--version']),
    }),
    [PROVIDER_SANDBOX_PROVIDERS.PI]: Object.freeze({
        executable: '/home/agent/.local/bin/pi',
        pathPrefix: '/home/agent/.local/bin',
        immutableRoots: Object.freeze([
            Object.freeze({
                source: '/home/agent/.local/bin/pi',
                target: '/home/agent/.local/bin/pi',
                sourceType: 'regular',
            }),
            Object.freeze({
                source: '/home/agent/.local/lib/node_modules/@earendil-works/pi-coding-agent',
                target: '/home/agent/.local/lib/node_modules/@earendil-works/pi-coding-agent',
                sourceType: 'directory',
            }),
        ]),
        readinessArgs: Object.freeze(['--version']),
    }),
    [PROVIDER_SANDBOX_PROVIDERS.CODEX]: Object.freeze({
        executable: '/home/agent/.local/bin/codex',
        pathPrefix: '/home/agent/.local/bin',
        immutableRoots: Object.freeze([
            Object.freeze({
                source: '/home/agent/.local/bin/codex',
                target: '/home/agent/.local/bin/codex',
                sourceType: 'regular',
            }),
            Object.freeze({
                source: '/home/agent/.local/lib/node_modules/@openai/codex',
                target: '/home/agent/.local/lib/node_modules/@openai/codex',
                sourceType: 'directory',
            }),
        ]),
        readinessArgs: Object.freeze(['--version']),
    }),
});

const PROVIDER_FIXED_ENV = Object.freeze({
    HOME: '/home/agent',
    XDG_CONFIG_HOME: '/home/agent/.config',
    XDG_CACHE_HOME: '/tmp/cache',
    XDG_DATA_HOME: '/home/agent/.local/share',
    XDG_STATE_HOME: '/home/agent/.local/state',
    TMPDIR: '/tmp',
});
const PROVIDER_UX_ENV = new Set([
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM',
    'NO_COLOR', 'FORCE_COLOR', 'COLUMNS', 'LINES',
]);
const PROVIDER_TASK_ENV = new Set([
    'PLOINKY_TASK_BROKER_URL',
    'PLOINKY_TASK_BROKER_KEY',
    'PLOINKY_PROVIDER_MODEL',
    'PLOINKY_PROVIDER_SESSION_ID',
    'PLOINKY_PROVIDER_TASK_ID',
]);
const PROVIDER_RESERVED_ENV_PREFIXES = Object.freeze([
    'PLOINKY_AGENT_',
    'PLOINKY_ENV_SOURCE_',
    'PLOINKY_ROUTER_',
]);
const MAX_PROVIDER_ENV_ENTRIES = 24;
const MAX_PROVIDER_ENV_BYTES = 16 * 1024;
const SANDBOX_HOME_SUFFIX = '.sandbox-v2';

export const TRUSTED_SERVICE_ENV = Object.freeze({
    HOME: '/home/agent',
    PATH: '/opt/ploinky-node/bin:/usr/bin:/bin',
    XDG_CONFIG_HOME: '/home/agent/.config',
    XDG_CACHE_HOME: '/tmp/cache',
    XDG_DATA_HOME: '/home/agent/.local/share',
    XDG_STATE_HOME: '/home/agent/.local/state',
    TMPDIR: '/tmp',
    PLOINKY_WORKSPACE_ROOT: '/workspace',
    WORKSPACE_PATH: '/workspace',
    NODE_PATH: '/code/node_modules',
    PLOINKY_MCP_CONFIG_PATH: '/home/agent/mcp-config.json',
    PLOINKY_CODE_DIR: '/code',
    PLOINKY_RUNTIME: 'bwrap',
    PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
    PLOINKY_AGENT_CREDENTIAL_FILE: '/run/ploinky-agent/credential.json',
    PLOINKY_ENV_SOURCE_PLOINKY_AGENT_CREDENTIAL_FILE: 'generated',
});

const MAX_TRUSTED_ENV_ENTRIES = 64;
const MAX_TRUSTED_ENV_BYTES = 32 * 1024;
const TRUSTED_SERVICE_RESERVED_ENV_NAMES = new Set([
    'AGENT_NAME',
    'HOME',
    'PATH',
    'PORT',
    'TMPDIR',
    'WORKSPACE_PATH',
    'NODE_PATH',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'PLOINKY_MASTER_KEY',
    'PLOINKY_DERIVED_MASTER_KEY',
    'PLOINKY_TURN_SHARED_SECRET',
    'PLOINKY_CLOUDFLARE_TUNNEL_TOKEN',
    'PLOINKY_CLOUDFLARE_API_TOKEN',
    'PLOINKY_AGENT_NAME',
    'PLOINKY_REPO_NAME',
    'PLOINKY_AGENT_ID',
    'PLOINKY_AGENT_PRINCIPAL',
    'PLOINKY_AGENT_INSTANCE_ID',
    'PLOINKY_AGENT_ENABLE_GENERATION',
    'PLOINKY_AGENT_HOME_KEY',
    'PLOINKY_AGENT_API_KEY',
    'PLOINKY_AGENT_API_PUBLIC_KEY',
    'PLOINKY_AGENT_SECRET',
    'PLOINKY_AGENT_PRIVATE_SECRET',
    'PLOINKY_AGENT_PRIVATE_KEY',
    'PLOINKY_INTERNAL_ROUTER_URL',
    'PLOINKY_EDGE_TOPOLOGY_FILE',
    'PLOINKY_RUNTIME',
    'PLOINKY_WORKSPACE_ROOT',
    'PLOINKY_CWD',
    'PLOINKY_MCP_CONFIG_PATH',
    'PLOINKY_CODE_DIR',
    'PLOINKY_AGENT_CONFIG',
    'PLOINKY_AGENT_MANIFEST',
    'PLOINKY_MANIFEST_FILE',
    'PLOINKY_AGENT_LIB_DIR',
    'PLOINKY_INVOCATION_AUTH_MODULE',
    'PLOINKY_AGENT_BIND_HOST',
    'PLOINKY_CONTAINER_NAME',
    'PLOINKY_CONTAINER_ID',
    'PLOINKY_AGENT_CREDENTIAL_FILE',
    '__PLOINKY_AGENT_PRIVATE_KEY_HOST_PATH',
]);

export function isTrustedServiceReservedEnvName(value) {
    const name = typeof value === 'string' ? value : '';
    return TRUSTED_SERVICE_RESERVED_ENV_NAMES.has(name)
        || name.startsWith('PLOINKY_ROUTER_')
        || name.startsWith('PLOINKY_AGENT_CREDENTIAL_')
        || name.startsWith('PLOINKY_ENV_SOURCE_PLOINKY_');
}

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function policyError(message, code = 'PLOINKY_BWRAP_PROTOCOL_INVALID', options) {
    const error = new Error(message, options);
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

function normalizeHomeSource(value) {
    assertPlainObject(value, 'HOME source');
    if (value.sourceKind === BWRAP_HOME_SOURCE_KINDS.SANDBOX_WORKSPACE_V2) {
        assertExactKeys(
            value,
            new Set(['sourceKind', 'homeKey']),
            new Set(['sourceKind', 'homeKey']),
            'sandbox HOME source',
        );
        const homeKey = validateRuntimeKey(value.homeKey);
        if (!homeKey.endsWith(SANDBOX_HOME_SUFFIX)
            || homeKey.length === SANDBOX_HOME_SUFFIX.length) {
            throw policyError(
                'sandbox HOME source requires the versioned sandbox-v2 key',
                'PLOINKY_HOME_STATE_INCOMPATIBLE',
            );
        }
        return Object.freeze({ sourceKind: value.sourceKind, homeKey });
    }
    if (value.sourceKind === BWRAP_HOME_SOURCE_KINDS.CONTAINER_NATIVE) {
        assertExactKeys(
            value,
            new Set(['sourceKind']),
            new Set(['sourceKind']),
            'container HOME source',
        );
        return Object.freeze({ sourceKind: value.sourceKind });
    }
    throw policyError('HOME source kind is unsupported', 'PLOINKY_HOME_PATH_INVALID');
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

export function createHomeRecord(homeSource) {
    return frozenRecord('HOME', normalizeHomeSource(homeSource));
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
    if (!FIXED_DATA_FILE_MAPPINGS.some((entry) => (
        entry.source === source
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
    if (record.type === 'HOME') {
        const { type: _type, ...homeSource } = record;
        normalizeHomeSource(homeSource);
        return;
    }
    const fields = {
        ARG: ['type', 'value'],
        WORKSPACE: ['type', 'mode'],
        WORKDIR: ['type', 'path'],
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
    case 'HOME': {
        const { type: _type, ...homeSource } = record;
        const checked = createHomeRecord(homeSource);
        if (checked.sourceKind === BWRAP_HOME_SOURCE_KINDS.CONTAINER_NATIVE) {
            return Buffer.from([2]);
        }
        const homeKey = utf8(checked.homeKey, 'HOME key');
        return Buffer.concat([Buffer.from([1]), homeKey]);
    }
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
    let credentialDataSeen = false;
    const allowCredentialData = TRUSTED_CREDENTIAL_RECORDS.has(records);
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
            if (record.value === '--perms' && allowCredentialData) {
                const sequence = records.slice(index, index + 5);
                if (sequence.length !== 5
                    || sequence.some((item) => item?.type !== 'ARG')
                    || sequence[1].value !== '0400'
                    || sequence[2].value !== '--ro-bind-data'
                    || sequence[4].value !== '/run/ploinky-agent/credential.json') {
                    throw policyError(
                        'trusted credential data requires exact --perms 0400 --ro-bind-data grammar',
                        'PLOINKY_BWRAP_CREDENTIAL_TRANSPORT_INVALID',
                    );
                }
                const credentialFd = Number(sequence[3].value);
                if (credentialDataSeen
                    || !Number.isSafeInteger(credentialFd)
                    || credentialFd <= 3
                    || credentialFd > MAX_INT32
                    || String(credentialFd) !== sequence[3].value
                    || !targets.has('/run/ploinky-agent')
                    || targets.has('/run/ploinky-agent/credential.json')) {
                    throw policyError(
                        'trusted credential data fd, directory, or destination is invalid',
                        'PLOINKY_BWRAP_CREDENTIAL_TRANSPORT_INVALID',
                    );
                }
                for (const item of sequence.slice(1)) {
                    encodeRecordPayload(item);
                }
                argCount += 4;
                if (argCount > BWRAP_LAUNCH_LIMITS.args) throw policyError('too many ARG records');
                credentialDataSeen = true;
                targets.add('/run/ploinky-agent/credential.json');
                index += 4;
                continue;
            }
            if (record.value === '--perms' || record.value.startsWith('--perms=')) {
                throw policyError(
                    'credential data arguments require the dedicated trusted credential builder',
                    'PLOINKY_BWRAP_CREDENTIAL_TRANSPORT_INVALID',
                );
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
    if (allowCredentialData && !credentialDataSeen) {
        throw policyError(
            'trusted credential record set is missing its exact data mount',
            'PLOINKY_BWRAP_CREDENTIAL_TRANSPORT_INVALID',
        );
    }
}

export function encodeBwrapLaunchDescriptor(records) {
    if (!Array.isArray(records) || records.length === 0 || records.length > BWRAP_LAUNCH_LIMITS.records) {
        throw policyError('launch record count is outside the v2 bound');
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

function normalizeTrustedServiceText(value, label, pattern) {
    try {
        utf8(value, label, { maxBytes: 256 });
    } catch (_) {
        throw policyError(`${label} is invalid`, 'PLOINKY_BWRAP_SERVICE_IDENTITY_INVALID');
    }
    if (value !== value.trim() || !pattern.test(value)) {
        throw policyError(`${label} is invalid`, 'PLOINKY_BWRAP_SERVICE_IDENTITY_INVALID');
    }
    return value;
}

function buildTrustedServicePlatformEnvironment(input) {
    assertExactKeys(
        input.identity,
        new Set(['principalId', 'instanceId', 'enableGeneration']),
        new Set(['principalId', 'instanceId', 'enableGeneration']),
        'trusted service identity',
    );
    const identityPattern = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/;
    const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
    const principalId = normalizeTrustedServiceText(input.identity.principalId, 'trusted service principalId', identityPattern);
    const instanceId = normalizeTrustedServiceText(input.identity.instanceId, 'trusted service instanceId', identityPattern);
    const enableGeneration = normalizeTrustedServiceText(input.identity.enableGeneration, 'trusted service enableGeneration', identityPattern);
    const agentName = normalizeTrustedServiceText(input.agentName, 'trusted service agentName', namePattern);
    const repoName = normalizeTrustedServiceText(input.repoName, 'trusted service repoName', namePattern);
    if (!Number.isSafeInteger(input.listenPort) || input.listenPort < 1 || input.listenPort > 65535) {
        throw policyError('trusted service listenPort is invalid', 'PLOINKY_BWRAP_ROOT_PORT_INVALID');
    }
    const identityEnvironment = {
        PLOINKY_AGENT_ID: principalId,
        PLOINKY_AGENT_PRINCIPAL: principalId,
        PLOINKY_AGENT_INSTANCE_ID: instanceId,
        PLOINKY_AGENT_ENABLE_GENERATION: enableGeneration,
    };
    for (const name of Object.keys(identityEnvironment)) {
        identityEnvironment[`PLOINKY_ENV_SOURCE_${name}`] = 'generated';
    }
    return Object.freeze({
        ...TRUSTED_SERVICE_ENV,
        AGENT_NAME: agentName,
        PLOINKY_AGENT_NAME: agentName,
        PLOINKY_REPO_NAME: repoName,
        ...identityEnvironment,
        PORT: String(input.listenPort),
    });
}

export function buildTrustedServicePolicy(input) {
    const allowed = new Set([
        'homeSource', 'command', 'nodeRuntimePath', 'agentRuntimePath',
        'codePath', 'codeDependenciesPath', 'agentDependenciesPath', 'preexecBarrier',
        'environment', 'credentialFd', 'identity', 'agentName', 'repoName', 'listenPort',
    ]);
    const required = new Set([
        'homeSource', 'command', 'nodeRuntimePath', 'agentRuntimePath',
        'codePath', 'codeDependenciesPath', 'agentDependenciesPath',
        'identity', 'agentName', 'repoName', 'listenPort',
    ]);
    assertExactKeys(input, allowed, required, 'trusted service policy input');
    const homeSource = normalizeHomeSource(input.homeSource);
    if (homeSource.sourceKind !== BWRAP_HOME_SOURCE_KINDS.SANDBOX_WORKSPACE_V2) {
        throw policyError(
            'trusted bwrap service requires the sandbox HOME ABI',
            'PLOINKY_HOME_STATE_INCOMPATIBLE',
        );
    }
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
    const platformEnvironment = buildTrustedServicePlatformEnvironment(input);
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
        if (isTrustedServiceReservedEnvName(name)) {
            throw policyError(
                `trusted service environment ${name} is reserved`,
                'PLOINKY_BWRAP_SERVICE_ENV_RESERVED',
            );
        }
        if (typeof value !== 'string') throw policyError(`trusted service environment ${name} must be a string`);
        const valueBytes = utf8(value, `trusted service environment ${name}`, { allowEmpty: true, maxBytes: 4096 });
        environmentBytes += Buffer.byteLength(name) + valueBytes.length;
        if (environmentBytes > MAX_TRUSTED_ENV_BYTES) throw policyError('trusted service environment exceeds its byte limit');
        dynamicEnvironment[name] = value;
    }
    const env = Object.freeze({ ...platformEnvironment, ...dynamicEnvironment });
    let credentialFd = null;
    if (input.credentialFd !== undefined) {
        credentialFd = Number(input.credentialFd);
        if (!Number.isSafeInteger(credentialFd)
            || credentialFd <= 3
            || credentialFd > MAX_INT32
            || credentialFd !== input.credentialFd) {
            throw policyError(
                'trusted service credentialFd must be an exact inherited fd above 3',
                'PLOINKY_BWRAP_CREDENTIAL_TRANSPORT_INVALID',
            );
        }
    }

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
        createHomeRecord(homeSource),
        createTmpfsRecord('/tmp'),
        createTmpfsRecord('/run'),
        ...(credentialFd === null ? [] : [createDirectoryRecord('/run/ploinky-agent')]),
        createProcRecord(),
        createDevRecord(),
        ...(credentialFd === null ? [] : [
            createArgRecord('--perms'),
            createArgRecord('0400'),
            createArgRecord('--ro-bind-data'),
            createArgRecord(String(credentialFd)),
            createArgRecord('/run/ploinky-agent/credential.json'),
        ]),
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
    if (credentialFd !== null) TRUSTED_CREDENTIAL_RECORDS.add(records);
    validateRecordPolicy(records);
    return Object.freeze({
        records: Object.freeze(records),
        env,
        command,
        homeSource,
    });
}

function normalizeProvider(value) {
    if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(PROVIDER_PROFILES, value)) {
        throw policyError('provider sandbox provider is unsupported', 'PLOINKY_PROVIDER_UNSUPPORTED');
    }
    return value;
}

function normalizeProviderMode(value) {
    if (value !== PROVIDER_SANDBOX_MODES.TASK && value !== PROVIDER_SANDBOX_MODES.READINESS) {
        throw policyError('provider sandbox mode is unsupported', 'PLOINKY_PROVIDER_MODE_UNSUPPORTED');
    }
    return value;
}

function providerIdentityFromCredentialContext(value) {
    const credentialContext = assertAgentCredentialContext(value);
    credentialContext.assertActive();
    const generation = normalizeBoundedText(
        credentialContext.identity.enableGeneration,
        'provider sandbox generation',
        256,
        /^[A-Za-z0-9][A-Za-z0-9:._-]*$/,
    );
    if (credentialContext.runtime.runtimeKind === 'bwrap'
        && credentialContext.source === 'bwrap-credential-v1') {
        const runtimeKey = validateRuntimeKey(credentialContext.runtime.runtimeKey);
        const homeKey = validateRuntimeKey(`${runtimeKey}${SANDBOX_HOME_SUFFIX}`);
        return Object.freeze({
            runtimeKind: 'bwrap',
            homeKey,
            homeSource: Object.freeze({
                sourceKind: BWRAP_HOME_SOURCE_KINDS.SANDBOX_WORKSPACE_V2,
                homeKey,
            }),
            nodeRuntimeSource: '/opt/ploinky-node',
            providerHomeSource: '/home/agent',
            generation,
        });
    }
    if (credentialContext.runtime.runtimeKind === 'container'
        && credentialContext.source === 'container-generated-env-v1') {
        return Object.freeze({
            runtimeKind: 'container',
            homeKey: validateRuntimeKey(credentialContext.runtime.homeKey),
            homeSource: Object.freeze({
                sourceKind: BWRAP_HOME_SOURCE_KINDS.CONTAINER_NATIVE,
            }),
            nodeRuntimeSource: '/usr/local',
            providerHomeSource: '/root',
            generation,
        });
    }
    throw policyError(
        'provider sandbox requires an exact runtime credential context',
        'PLOINKY_PROVIDER_CONTEXT_INVALID',
    );
}

function providerSystemPaths(identity) {
    if (identity.runtimeKind === 'bwrap') return FIXED_SYSTEM_PATHS;
    if (identity.runtimeKind === 'container') return CONTAINER_SYSTEM_PATHS;
    throw policyError(
        'provider sandbox runtime context is unsupported',
        'PLOINKY_PROVIDER_CONTEXT_INVALID',
    );
}

function providerImmutableSource(identity, logicalSource) {
    const providerHomePrefix = '/home/agent/';
    if (!logicalSource.startsWith(providerHomePrefix)) {
        throw policyError(
            'provider immutable source is outside the logical provider HOME',
            'PLOINKY_PROVIDER_EXECUTABLE_INVALID',
        );
    }
    return `${identity.providerHomeSource}/${logicalSource.slice(providerHomePrefix.length)}`;
}

function normalizeProviderWorkdir(value) {
    if (typeof value !== 'string' || value.includes('\0')) {
        throw policyError('provider WORKDIR is invalid', 'PLOINKY_WORKDIR_INVALID');
    }
    let relative = value;
    if (value === '/workspace') {
        throw policyError('the workspace root cannot be selected writable', 'PLOINKY_WORKDIR_ROOT_FORBIDDEN');
    }
    if (value.startsWith('/workspace/')) relative = value.slice('/workspace/'.length);
    else if (value.startsWith('/')) {
        throw policyError('provider WORKDIR must be workspace-relative', 'PLOINKY_WORKDIR_INVALID');
    }
    return createWorkdirRecord(relative).path;
}

function managedRepositoryParents(workdir) {
    const parts = workdir.split('/');
    if (parts[0] !== '.ploinky' || parts[1] !== 'repos') return [];
    const targets = ['/workspace/.ploinky/repos'];
    // The selected WORKDIR bind supplies the final target. Only reconstruct
    // lexical parents beneath the otherwise-empty protected-state mask.
    for (let length = 3; length < parts.length; length += 1) {
        targets.push(`/workspace/${parts.slice(0, length).join('/')}`);
    }
    return targets;
}

function normalizeProviderCommand(command, profile, mode) {
    const source = mode === PROVIDER_SANDBOX_MODES.READINESS
        ? [profile.executable, ...profile.readinessArgs]
        : command;
    if (!Array.isArray(source) || source.length === 0) {
        throw policyError('provider command must be a non-empty argv array', 'PLOINKY_PROVIDER_COMMAND_INVALID');
    }
    const normalized = Object.freeze(source.map((argument) => {
        utf8(argument, 'provider command argument', { maxBytes: BWRAP_LAUNCH_LIMITS.argumentBytes });
        return argument;
    }));
    if (normalized[0] !== profile.executable) {
        throw policyError('provider command must use the fixed immutable executable', 'PLOINKY_PROVIDER_COMMAND_INVALID');
    }
    return normalized;
}

function validateProviderBrokerEnvironment(environment, mode) {
    const url = environment.PLOINKY_TASK_BROKER_URL;
    const key = environment.PLOINKY_TASK_BROKER_KEY;
    if (mode === PROVIDER_SANDBOX_MODES.READINESS) {
        if (url !== undefined || key !== undefined) {
            throw policyError('readiness cannot receive a task broker capability', 'PLOINKY_PROVIDER_ENV_INVALID');
        }
        return;
    }
    if (typeof url !== 'string' || typeof key !== 'string') {
        throw policyError('task provider requires an exact scoped broker capability', 'PLOINKY_PROVIDER_BROKER_REQUIRED');
    }
    let parsed;
    try { parsed = new URL(url); } catch (_) {
        throw policyError('task broker URL is invalid', 'PLOINKY_PROVIDER_BROKER_INVALID');
    }
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
        || !parsed.port || parsed.username || parsed.password
        || parsed.pathname !== '/v1' || parsed.search || parsed.hash) {
        throw policyError('task broker URL must be the exact loopback v1 endpoint', 'PLOINKY_PROVIDER_BROKER_INVALID');
    }
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(key)) {
        throw policyError('task broker key is invalid', 'PLOINKY_PROVIDER_BROKER_INVALID');
    }
}

function buildProviderEnvironment({ mode, profile, workdir, environment = {} }) {
    assertPlainObject(environment, 'provider environment');
    const entries = Object.entries(environment);
    if (entries.length > MAX_PROVIDER_ENV_ENTRIES) {
        throw policyError('provider environment contains too many entries', 'PLOINKY_PROVIDER_ENV_INVALID');
    }
    let bytes = 0;
    const dynamic = {};
    for (const [name, value] of entries.sort(([left], [right]) => compareText(left, right))) {
        if (!PROVIDER_UX_ENV.has(name) && !PROVIDER_TASK_ENV.has(name)) {
            const reserved = PROVIDER_RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
                || isTrustedServiceReservedEnvName(name)
                || /(?:SECRET|TOKEN|API_KEY|PRIVATE_KEY|MASTER_KEY|CREDENTIAL)/u.test(name);
            throw policyError(
                `provider environment ${name} is ${reserved ? 'reserved' : 'not allowlisted'}`,
                'PLOINKY_PROVIDER_ENV_INVALID',
            );
        }
        if (typeof value !== 'string') {
            throw policyError(`provider environment ${name} must be a string`, 'PLOINKY_PROVIDER_ENV_INVALID');
        }
        const valueBytes = utf8(value, `provider environment ${name}`, { allowEmpty: true, maxBytes: 4096 });
        bytes += Buffer.byteLength(name) + valueBytes.length;
        if (bytes > MAX_PROVIDER_ENV_BYTES) {
            throw policyError('provider environment exceeds its byte limit', 'PLOINKY_PROVIDER_ENV_INVALID');
        }
        dynamic[name] = value;
    }
    validateProviderBrokerEnvironment(dynamic, mode);
    const cwd = mode === PROVIDER_SANDBOX_MODES.READINESS
        ? '/workspace/readiness'
        : `/workspace/${workdir}`;
    return Object.freeze({
        ...PROVIDER_FIXED_ENV,
        PATH: `${profile.pathPrefix}:/opt/ploinky-node/bin:/usr/bin:/bin`,
        PWD: cwd,
        ...dynamic,
    });
}

/**
 * Build the one canonical inner-provider policy. The identity object is a
 * bounded, non-secret task capability supplied by the trusted AgentServer
 * channel; providers never receive it in their environment or filesystem.
 */
export function buildProviderSandboxPolicy(input) {
    const allowed = new Set([
        'mode', 'provider', 'credentialContext', 'workdir', 'command', 'environment',
        'preexecBarrier',
    ]);
    const required = new Set(['mode', 'provider', 'credentialContext']);
    assertExactKeys(input, allowed, required, 'provider sandbox policy input');
    const mode = normalizeProviderMode(input.mode);
    const provider = normalizeProvider(input.provider);
    const identity = providerIdentityFromCredentialContext(input.credentialContext);
    const profile = PROVIDER_PROFILES[provider];
    const workdir = mode === PROVIDER_SANDBOX_MODES.TASK
        ? normalizeProviderWorkdir(input.workdir)
        : null;
    if (mode === PROVIDER_SANDBOX_MODES.READINESS && input.workdir !== undefined) {
        throw policyError('readiness cannot select a real workspace directory', 'PLOINKY_WORKDIR_INVALID');
    }
    if (mode === PROVIDER_SANDBOX_MODES.READINESS
        && (input.command !== undefined || input.environment !== undefined)) {
        throw policyError(
            'readiness command and environment are fixed by provider policy',
            'PLOINKY_PROVIDER_READINESS_INVALID',
        );
    }
    const command = normalizeProviderCommand(input.command, profile, mode);
    const env = buildProviderEnvironment({
        mode,
        profile,
        workdir,
        environment: input.environment,
    });

    const records = [
        ...providerSystemPaths(identity).map((entry) => entry.dataFile
            ? createReadOnlyDataFileRecord(entry.source, entry.target)
            : createReadOnlyPathRecord(entry.source, entry.target, entry.sourceType)),
        createSymlinkRecord('usr-bin'),
        createSymlinkRecord('usr-sbin'),
        createSymlinkRecord('usr-lib'),
        createSymlinkRecord('usr-lib64'),
        createDirectoryRecord('/opt'),
        createReadOnlyPathRecord(identity.nodeRuntimeSource, '/opt/ploinky-node'),
        createReadOnlyPathRecord('/code', '/code'),
        ...(mode === PROVIDER_SANDBOX_MODES.TASK
            ? [
                createWorkspaceRecord('ro'),
                createTmpfsRecord('/workspace/.ploinky'),
                createTmpfsRecord('/workspace/.data'),
                ...managedRepositoryParents(workdir).map(createDirectoryRecord),
                createWorkdirRecord(workdir),
            ]
            : [
                createTmpfsRecord('/workspace'),
                createDirectoryRecord('/workspace/readiness'),
            ]),
        createDirectoryRecord('/home'),
        createHomeRecord(identity.homeSource),
        ...profile.immutableRoots.map((root) => createReadOnlyPathRecord(
            providerImmutableSource(identity, root.source),
            root.target,
            root.sourceType,
        )),
        createTmpfsRecord('/tmp'),
        createTmpfsRecord('/tmp/cache'),
        createTmpfsRecord('/run'),
        createProcRecord(),
        createDevRecord(),
        createArgRecord('--die-with-parent'),
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
        createArgRecord(env.PWD),
    ];
    if (input.preexecBarrier !== undefined) {
        assertExactKeys(
            input.preexecBarrier,
            new Set(['readyFd', 'releaseFd']),
            new Set(['readyFd', 'releaseFd']),
            'provider preexecBarrier',
        );
        records.push(createPreexecBarrierRecord(
            input.preexecBarrier.readyFd,
            input.preexecBarrier.releaseFd,
        ));
    }
    records.push(createArgRecord('--'), ...command.map(createArgRecord));
    validateRecordPolicy(records);
    return Object.freeze({
        mode,
        provider,
        identity,
        workdir,
        cwd: env.PWD,
        records: Object.freeze(records),
        env,
        command,
    });
}

export function buildProviderSandboxLaunch(input) {
    const policy = buildProviderSandboxPolicy(input);
    return Object.freeze({
        helper: PROVIDER_SANDBOX_HELPER,
        args: Object.freeze([]),
        descriptor: encodeBwrapLaunchDescriptor(policy.records),
        mode: policy.mode,
        provider: policy.provider,
        identity: policy.identity,
        workdir: policy.workdir,
        cwd: policy.cwd,
        env: policy.env,
        command: policy.command,
        records: policy.records,
    });
}

function providerSpawnDependencies(overrides = {}) {
    assertExactKeys(
        overrides,
        new Set([
            'spawn', 'acquireProviderHomeLease', 'releaseProviderHomeLease',
            'inspectProcessIdentity', 'getUid', 'signalProcessGroup',
            'setTimeout', 'clearTimeout', 'termGraceMs', 'killGraceMs',
            'identityCaptureAttempts', 'identityCaptureRetryMs',
        ]),
        new Set(),
        'provider spawn dependencies',
    );
    const termGraceMs = overrides.termGraceMs ?? DEFAULT_PROVIDER_TERM_GRACE_MS;
    const killGraceMs = overrides.killGraceMs ?? DEFAULT_PROVIDER_KILL_GRACE_MS;
    const identityCaptureAttempts = overrides.identityCaptureAttempts ?? 8;
    const identityCaptureRetryMs = overrides.identityCaptureRetryMs ?? 10;
    for (const [label, value] of [['termGraceMs', termGraceMs], ['killGraceMs', killGraceMs]]) {
        if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
            throw policyError(`provider ${label} is invalid`, 'PLOINKY_PROVIDER_TERMINATION_INVALID');
        }
    }
    if (!Number.isSafeInteger(identityCaptureAttempts) || identityCaptureAttempts < 1 || identityCaptureAttempts > 100
        || !Number.isSafeInteger(identityCaptureRetryMs) || identityCaptureRetryMs < 1 || identityCaptureRetryMs > 1_000) {
        throw policyError('provider identity capture retry policy is invalid', 'PLOINKY_PROVIDER_TERMINATION_INVALID');
    }
    return {
        spawn: overrides.spawn || spawnChildProcess,
        acquireProviderHomeLease: overrides.acquireProviderHomeLease || acquireProviderHomeLease,
        releaseProviderHomeLease: overrides.releaseProviderHomeLease || releaseProviderHomeLease,
        inspectProcessIdentity: overrides.inspectProcessIdentity || inspectProviderLeaseProcess,
        getUid: overrides.getUid || (() => (typeof process.getuid === 'function' ? process.getuid() : null)),
        signalProcessGroup: overrides.signalProcessGroup || ((pid, signal) => process.kill(-pid, signal)),
        setTimeout: overrides.setTimeout || setTimeout,
        clearTimeout: overrides.clearTimeout || clearTimeout,
        termGraceMs,
        killGraceMs,
        identityCaptureAttempts,
        identityCaptureRetryMs,
    };
}

function inspectSpawnedProcessOwnership(child, dependencies) {
    const pid = Number(child?.pid);
    const ownerUid = dependencies.getUid();
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_INT32
        || !Number.isSafeInteger(ownerUid) || ownerUid < 0) {
        throw policyError(
            'cannot capture the provider helper process identity',
            'PLOINKY_PROVIDER_PROCESS_IDENTITY_UNVERIFIED',
        );
    }
    let inspected;
    try {
        inspected = dependencies.inspectProcessIdentity(pid);
    } catch (cause) {
        const error = policyError(
            'provider helper process identity inspection failed',
            'PLOINKY_PROVIDER_PROCESS_IDENTITY_UNVERIFIED',
            { cause },
        );
        error.evidence = Object.freeze({ pid, state: 'inspector-error' });
        throw error;
    }
    if (inspected?.state !== 'identified' || inspected.processUid !== ownerUid) {
        const error = policyError(
            'cannot capture a boot-bound same-UID provider helper identity',
            'PLOINKY_PROVIDER_PROCESS_IDENTITY_UNVERIFIED',
        );
        error.evidence = Object.freeze({ pid, state: inspected?.state ?? 'invalid' });
        throw error;
    }
    let processIdentity;
    try { processIdentity = normalizeProcessIdentity(inspected.processIdentity); } catch (_) {
        throw policyError(
            'provider helper identity is not boot-bound and canonical',
            'PLOINKY_PROVIDER_PROCESS_IDENTITY_UNVERIFIED',
        );
    }
    return Object.freeze({ pid, processIdentity, processUid: ownerUid });
}

async function captureSpawnedProcessOwnership(child, terminal, dependencies) {
    let lastError = null;
    for (let attempt = 1; attempt <= dependencies.identityCaptureAttempts; attempt += 1) {
        try {
            return inspectSpawnedProcessOwnership(child, dependencies);
        } catch (error) {
            lastError = error;
        }
        if (attempt < dependencies.identityCaptureAttempts) {
            const observation = await Promise.race([
                terminal.then((result) => Object.freeze({ terminal: result })),
                delay(dependencies.identityCaptureRetryMs, dependencies),
            ]);
            if (observation?.terminal) {
                lastError.ownershipRetained = false;
                lastError.evidence = Object.freeze({
                    ...(lastError.evidence ?? {}),
                    attempts: attempt,
                    terminalObserved: true,
                    code: observation.terminal.code,
                    signal: observation.terminal.signal,
                });
                throw lastError;
            }
        }
    }
    lastError.evidence = Object.freeze({
        ...(lastError.evidence ?? {}),
        attempts: dependencies.identityCaptureAttempts,
        terminalObserved: false,
    });
    throw lastError;
}

function inspectExactSpawnedProcess(ownership, dependencies) {
    let inspected;
    try {
        inspected = dependencies.inspectProcessIdentity(ownership.pid);
    } catch (error) {
        return Object.freeze({
            state: 'unknown',
            observedState: 'inspector-error',
            causeCode: error?.code ?? null,
        });
    }
    if (!inspected || !['dead', 'identified', 'uid-diverged', 'unknown'].includes(inspected.state)) {
        return Object.freeze({ state: 'unknown', observedState: inspected?.state ?? 'invalid' });
    }
    if (inspected.state === 'dead') return Object.freeze({ state: 'terminated', reason: 'dead' });
    if (inspected.state !== 'identified') {
        return Object.freeze({ state: 'unknown', observedState: inspected.state });
    }
    let processIdentity;
    try { processIdentity = normalizeProcessIdentity(inspected.processIdentity); } catch (_) {
        return Object.freeze({ state: 'unknown', observedState: 'unbootbound' });
    }
    if (processIdentity !== ownership.processIdentity) {
        return Object.freeze({ state: 'terminated', reason: 'pid-reused' });
    }
    if (inspected.processUid !== ownership.processUid) {
        return Object.freeze({ state: 'unknown', observedState: 'uid-diverged' });
    }
    return Object.freeze({ state: 'exact' });
}

function exactProcessError(message, ownership, evidence = {}, cause) {
    const error = policyError(
        message,
        'PLOINKY_PROVIDER_TERMINATION_UNPROVEN',
        cause ? { cause } : undefined,
    );
    error.ownershipRetained = true;
    error.evidence = Object.freeze({
        pid: ownership?.pid ?? null,
        processIdentity: ownership?.processIdentity ?? null,
        processUid: ownership?.processUid ?? null,
        ...evidence,
    });
    return error;
}

function signalExactProviderProcessGroup(ownership, signal, dependencies) {
    const before = inspectExactSpawnedProcess(ownership, dependencies);
    if (before.state === 'terminated') return Object.freeze({ signalled: false, terminated: true, evidence: before });
    if (before.state !== 'exact') {
        throw exactProcessError(
            `refusing to signal an unverified provider process group with ${signal}`,
            ownership,
            { phase: `before-${signal}`, observedState: before.observedState ?? before.state },
        );
    }
    try {
        dependencies.signalProcessGroup(ownership.pid, signal);
        return Object.freeze({ signalled: true, terminated: false });
    } catch (cause) {
        const after = inspectExactSpawnedProcess(ownership, dependencies);
        if (after.state === 'terminated') {
            return Object.freeze({ signalled: false, terminated: true, evidence: after });
        }
        throw exactProcessError(
            `provider process-group ${signal} delivery failed`,
            ownership,
            { phase: `signal-${signal}`, observedState: after.observedState ?? after.state },
            cause,
        );
    }
}

function delay(ms, dependencies) {
    return new Promise((resolve) => {
        const timer = dependencies.setTimeout(() => resolve(Object.freeze({ timedOut: true })), ms);
        timer.unref?.();
    });
}

async function terminateExactProviderProcess({ ownership, terminal }, dependencies, reason = 'cleanup') {
    const evidence = [];
    const waitTerminal = async (ms) => Promise.race([terminal, delay(ms, dependencies)]);
    let initial = inspectExactSpawnedProcess(ownership, dependencies);
    if (initial.state === 'terminated') {
        const result = await waitTerminal(dependencies.killGraceMs);
        if (!result?.timedOut) return Object.freeze({ result, evidence: Object.freeze([{ phase: 'initial', ...initial }]) });
        throw exactProcessError(
            'provider process terminated but its child terminal event was not observed',
            ownership,
            { reason, phase: 'terminal-event', observations: Object.freeze([{ phase: 'initial', ...initial }]) },
        );
    }
    if (initial.state !== 'exact') {
        throw exactProcessError(
            'provider process termination cannot start from an unverified identity',
            ownership,
            { reason, phase: 'initial', observedState: initial.observedState ?? initial.state },
        );
    }

    try {
        const term = signalExactProviderProcessGroup(ownership, 'SIGTERM', dependencies);
        evidence.push({ phase: 'term', ...term });
    } catch (error) {
        evidence.push({ phase: 'term-failed', ...(error.evidence ?? {}) });
    }
    let terminalResult = await waitTerminal(dependencies.termGraceMs);
    let observed = inspectExactSpawnedProcess(ownership, dependencies);
    evidence.push({ phase: 'after-term', ...observed, terminal: !terminalResult?.timedOut });
    if (!terminalResult?.timedOut && observed.state === 'terminated') {
        return Object.freeze({ result: terminalResult, evidence: Object.freeze(evidence) });
    }
    if (observed.state !== 'exact') {
        throw exactProcessError(
            'provider termination was not proven after SIGTERM',
            ownership,
            { reason, phase: 'after-term', observedState: observed.observedState ?? observed.state, observations: Object.freeze(evidence) },
        );
    }

    try {
        const killed = signalExactProviderProcessGroup(ownership, 'SIGKILL', dependencies);
        evidence.push({ phase: 'kill', ...killed });
    } catch (error) {
        evidence.push({ phase: 'kill-failed', ...(error.evidence ?? {}) });
        throw exactProcessError(
            'provider SIGKILL delivery could not be proven',
            ownership,
            { reason, phase: 'kill', observations: Object.freeze(evidence) },
            error,
        );
    }
    terminalResult = await waitTerminal(dependencies.killGraceMs);
    observed = inspectExactSpawnedProcess(ownership, dependencies);
    evidence.push({ phase: 'after-kill', ...observed, terminal: !terminalResult?.timedOut });
    if (!terminalResult?.timedOut && observed.state === 'terminated') {
        return Object.freeze({ result: terminalResult, evidence: Object.freeze(evidence) });
    }
    throw exactProcessError(
        'provider termination was not proven after SIGKILL',
        ownership,
        { reason, phase: 'after-kill', observedState: observed.observedState ?? observed.state, observations: Object.freeze(evidence) },
    );
}

function waitForExactBarrierReady(stream, child) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            stream.removeAllListeners('data');
            stream.removeAllListeners('end');
            stream.removeAllListeners('error');
            stream.removeListener('close', onStreamClose);
            child.removeListener('error', onChildError);
            child.removeListener('exit', onChildExit);
            child.removeListener('close', onChildClose);
            if (error) reject(error);
            else resolve();
        };
        const onChildError = (cause) => finish(policyError(
            'provider helper failed before retained-fd readiness',
            'PLOINKY_PROVIDER_HELPER_FAILED',
            { cause },
        ));
        const onChildExit = () => finish(policyError(
            'provider helper exited before retained-fd readiness',
            'PLOINKY_PROVIDER_HELPER_FAILED',
        ));
        const onChildClose = () => finish(policyError(
            'provider helper closed before retained-fd readiness',
            'PLOINKY_PROVIDER_HELPER_FAILED',
        ));
        const onStreamClose = () => finish(policyError(
            'provider helper closed the retained-fd readiness stream before an exact signal',
            'PLOINKY_PROVIDER_PREEXEC_BARRIER_FAILED',
        ));
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.once('error', onChildError);
        stream.once('close', onStreamClose);
        stream.once('end', () => {
            const ready = Buffer.concat(chunks);
            if (ready.length !== 1 || ready[0] !== 0x52) {
                finish(policyError(
                    'provider helper returned an invalid retained-fd readiness signal',
                    'PLOINKY_PROVIDER_PREEXEC_BARRIER_FAILED',
                ));
                return;
            }
            finish();
        });
        child.once('error', onChildError);
        child.once('exit', onChildExit);
        child.once('close', onChildClose);
    });
}

function writeExactStream(stream, bytes, code, message) {
    return new Promise((resolve, reject) => {
        stream.once('error', (cause) => reject(policyError(message, code, { cause })));
        stream.end(bytes, (error) => {
            if (error) reject(policyError(message, code, { cause: error }));
            else resolve();
        });
    });
}

/**
 * Spawn the fixed privileged helper and hold it at the native retained-fd
 * barrier. HOME ownership and the scoped broker are activated only after all
 * helper path opens have succeeded. The returned completion promise includes
 * exact lease/capability cleanup.
 */
export async function spawnProviderSandbox(input, lifecycle = {}, dependencyOverrides = {}) {
    assertExactKeys(
        lifecycle,
        new Set([
            'activateCapability', 'deactivateCapability', 'onSpawn', 'afterExit',
            'leaseRoot', 'leaseMetadata', 'stdio',
        ]),
        new Set(),
        'provider sandbox lifecycle',
    );
    if (lifecycle.activateCapability !== undefined && typeof lifecycle.activateCapability !== 'function') {
        throw new TypeError('activateCapability must be a function');
    }
    if (lifecycle.deactivateCapability !== undefined && typeof lifecycle.deactivateCapability !== 'function') {
        throw new TypeError('deactivateCapability must be a function');
    }
    if (lifecycle.onSpawn !== undefined && typeof lifecycle.onSpawn !== 'function') {
        throw new TypeError('onSpawn must be a function');
    }
    if (lifecycle.afterExit !== undefined && typeof lifecycle.afterExit !== 'function') {
        throw new TypeError('afterExit must be a function');
    }
    const dependencies = providerSpawnDependencies(dependencyOverrides);
    const policyInput = { ...input, preexecBarrier: { readyFd: 4, releaseFd: 5 } };
    const launch = buildProviderSandboxLaunch(policyInput);
    const requestedStdio = lifecycle.stdio ?? ['pipe', 'pipe', 'pipe'];
    if (!Array.isArray(requestedStdio) || requestedStdio.length !== 3
        || requestedStdio.some((value) => !['pipe', 'inherit', 'ignore'].includes(value))) {
        throw policyError('provider stdio must contain exactly three safe modes', 'PLOINKY_PROVIDER_STDIO_INVALID');
    }
    const child = dependencies.spawn(launch.helper, launch.args, {
        cwd: '/',
        env: {},
        detached: true,
        stdio: [...requestedStdio, 'pipe', 'pipe', 'pipe'],
    });
    let childError = null;
    const terminal = new Promise((resolve) => {
        child.once('error', (error) => { childError = error; });
        child.once('close', (code, signal) => resolve(Object.freeze({ code, signal, error: childError })));
    });
    let ownership;
    try {
        ownership = await captureSpawnedProcessOwnership(child, terminal, dependencies);
    } catch (error) {
        for (const stream of child.stdio ?? []) {
            try { stream?.destroy?.(); } catch (_) { }
        }
        const terminalAfterClose = await Promise.race([
            terminal.then((result) => Object.freeze({ terminal: result })),
            delay(dependencies.killGraceMs, dependencies),
        ]);
        const terminalObserved = Boolean(terminalAfterClose?.terminal);
        error.ownershipRetained = !terminalObserved;
        error.evidence = Object.freeze({
            ...(error.evidence ?? {}),
            terminalObserved,
            transportClosed: true,
        });
        if (!terminalObserved) {
            error.retainedProcess = Object.freeze({
                pid: Number.isSafeInteger(Number(child?.pid)) ? Number(child.pid) : null,
                child,
                terminal,
            });
        }
        throw error;
    }
    let terminationPromise = null;
    const terminate = (reason = 'cleanup') => {
        if (!terminationPromise) {
            terminationPromise = terminateExactProviderProcess({ ownership, terminal }, dependencies, reason);
        }
        return terminationPromise;
    };
    const processControl = Object.freeze({
        ownership,
        signal(signal) {
            if (!['SIGTERM', 'SIGKILL'].includes(signal)) {
                throw policyError('provider process signal is not allowed', 'PLOINKY_PROVIDER_TERMINATION_INVALID');
            }
            return signalExactProviderProcessGroup(ownership, signal, dependencies);
        },
        terminate,
    });
    const descriptorStream = child.stdio?.[3];
    const readyStream = child.stdio?.[4];
    const releaseStream = child.stdio?.[5];
    if (!descriptorStream || !readyStream || !releaseStream) {
        const transportError = policyError(
            'provider helper did not expose the exact fd transport',
            'PLOINKY_PROVIDER_HELPER_TRANSPORT_INVALID',
        );
        try {
            const terminated = await terminate('helper-transport');
            transportError.terminationEvidence = terminated.evidence;
        } catch (terminationError) {
            terminationError.cause = transportError;
            throw terminationError;
        }
        throw transportError;
    }
    const readyPromise = waitForExactBarrierReady(readyStream, child);
    // If a trusted onSpawn hook rejects, the helper is still killed below; keep
    // the already-attached barrier observer from becoming an unhandled rejection.
    readyPromise.catch(() => {});
    if (lifecycle.onSpawn) {
        try { lifecycle.onSpawn(child, processControl); } catch (error) {
            try {
                const terminated = await terminate('on-spawn-hook');
                error.terminationEvidence = terminated.evidence;
            } catch (terminationError) {
                terminationError.cause = error;
                throw terminationError;
            }
            throw error;
        }
    }

    let lease = null;
    let capabilityActive = false;
    let cleanupPromise = null;
    const deactivateCapability = async () => {
        if (!capabilityActive || !lifecycle.deactivateCapability) return;
        await lifecycle.deactivateCapability();
        capabilityActive = false;
    };
    const releaseLease = () => {
        if (!lease) return;
        const ownedLease = lease;
        lease = null;
        dependencies.releaseProviderHomeLease(ownedLease);
    };
    const cleanupResources = async () => {
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
            let firstError = null;
            try { await deactivateCapability(); } catch (error) { firstError = error; }
            if (!firstError) {
                try { releaseLease(); } catch (error) { firstError = error; }
            }
            if (firstError) {
                const error = policyError(
                    'provider terminal resource cleanup failed',
                    'PLOINKY_PROVIDER_TERMINAL_CLEANUP_FAILED',
                    { cause: firstError },
                );
                error.ownershipRetained = Boolean(capabilityActive || lease);
                error.evidence = Object.freeze({
                    capabilityActive,
                    leaseRetained: Boolean(lease),
                    causeCode: firstError?.code ?? null,
                });
                throw error;
            }
        })();
        return cleanupPromise;
    };

    try {
        await writeExactStream(
            descriptorStream,
            launch.descriptor,
            'PLOINKY_PROVIDER_HELPER_TRANSPORT_INVALID',
            'cannot write the provider launch descriptor',
        );
        await readyPromise;
        lease = dependencies.acquireProviderHomeLease({
            homeKey: launch.identity.homeKey,
            generation: launch.identity.generation,
            role: launch.mode === PROVIDER_SANDBOX_MODES.READINESS ? 'readiness' : 'provider-task',
            metadata: {
                provider: launch.provider,
                mode: launch.mode,
                ...(launch.workdir ? { workdir: launch.workdir } : {}),
                ...(lifecycle.leaseMetadata ?? {}),
            },
            ...(lifecycle.leaseRoot ? { leaseRoot: lifecycle.leaseRoot } : {}),
            ownerPid: child.pid,
        });
        if (lifecycle.activateCapability) {
            await lifecycle.activateCapability({
                childPid: child.pid,
                provider: launch.provider,
                mode: launch.mode,
                workdir: launch.workdir,
                identity: launch.identity,
            });
            capabilityActive = true;
        }
        await writeExactStream(
            releaseStream,
            Buffer.from('G'),
            'PLOINKY_PROVIDER_PREEXEC_BARRIER_FAILED',
            'cannot release the provider helper barrier',
        );
    } catch (error) {
        try { releaseStream.destroy(); } catch (_) { }
        let terminated;
        try {
            terminated = await terminate('provider-bootstrap');
        } catch (terminationError) {
            terminationError.cause = error;
            throw terminationError;
        }
        try {
            await cleanupResources();
        } catch (cleanupError) {
            cleanupError.cause = error;
            cleanupError.terminationEvidence = terminated.evidence;
            throw cleanupError;
        }
        error.terminationEvidence = terminated.evidence;
        throw error;
    }

    const completion = terminal.then(async (result) => {
        const observed = inspectExactSpawnedProcess(ownership, dependencies);
        if (observed.state !== 'terminated') {
            throw exactProcessError(
                'provider child closed without exact termination proof',
                ownership,
                { phase: 'terminal-close', observedState: observed.observedState ?? observed.state },
            );
        }
        let afterExit;
        try {
            await deactivateCapability();
        } catch (cause) {
            const error = policyError(
                'provider capability cleanup failed after terminal exit',
                'PLOINKY_PROVIDER_TERMINAL_CLEANUP_FAILED',
                { cause },
            );
            error.ownershipRetained = true;
            error.evidence = Object.freeze({ capabilityActive, leaseRetained: Boolean(lease) });
            throw error;
        }
        if (lifecycle.afterExit) {
            try {
                afterExit = await lifecycle.afterExit(Object.freeze({
                    code: result.code,
                    signal: result.signal,
                    child,
                    launch,
                }));
            } catch (error) {
                try { releaseLease(); } catch (releaseError) { error.cause = releaseError; }
                throw error;
            }
        }
        releaseLease();
        cleanupPromise = Promise.resolve();
        if (result.error) throw result.error;
        return Object.freeze({
            code: result.code,
            signal: result.signal,
            ...(lifecycle.afterExit ? { afterExit } : {}),
        });
    });
    const cleanup = async () => {
        await terminate('explicit-cleanup');
        return completion;
    };
    return Object.freeze({ child, launch, lease, ownership, processControl, completion, terminate, cleanup });
}

export async function runProviderSandboxReadiness({
    provider,
    credentialContext,
    timeoutMs = 15_000,
    leaseRoot,
    dependencyOverrides,
} = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
        throw policyError('provider readiness timeout is invalid', 'PLOINKY_PROVIDER_READINESS_INVALID');
    }
    let timer;
    let processControl = null;
    let resolveProcessControl;
    const processControlAvailable = new Promise((resolve) => {
        resolveProcessControl = resolve;
    });
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(Object.freeze({ kind: 'timeout' })), timeoutMs);
        timer.unref?.();
    });
    const spawnOutcome = Promise.resolve().then(() => spawnProviderSandbox({
        mode: PROVIDER_SANDBOX_MODES.READINESS,
        provider,
        credentialContext,
    }, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(leaseRoot ? { leaseRoot } : {}),
        onSpawn(_child, exactProcessControl) {
            processControl = exactProcessControl;
            resolveProcessControl(Object.freeze({ kind: 'process-control', processControl: exactProcessControl }));
        },
    }, dependencyOverrides)).then(
        (handle) => Object.freeze({ kind: 'handle', handle }),
        (error) => Object.freeze({ kind: 'spawn-error', error }),
    );

    const cleanupTimedOutReadiness = async (initialOutcome = null) => {
        let outcome = initialOutcome;
        let controller = processControl;
        if (!outcome && !controller) {
            const available = await Promise.race([processControlAvailable, spawnOutcome]);
            if (available.kind === 'process-control') controller = available.processControl;
            else outcome = available;
        }
        if (outcome?.kind === 'handle') controller = outcome.handle.processControl;

        let termination = null;
        if (controller) termination = await controller.terminate('readiness-timeout');
        if (!outcome) outcome = await spawnOutcome;

        if (outcome.kind === 'handle') {
            if (!termination) termination = await outcome.handle.terminate('readiness-timeout');
            try {
                await outcome.handle.completion;
            } catch (error) {
                if (error?.ownershipRetained
                    || error?.code === 'PLOINKY_PROVIDER_TERMINATION_UNPROVEN'
                    || error?.code === 'PLOINKY_PROVIDER_TERMINAL_CLEANUP_FAILED') {
                    throw error;
                }
            }
        } else if (outcome.error?.ownershipRetained
            || outcome.error?.code === 'PLOINKY_PROVIDER_TERMINATION_UNPROVEN'
            || outcome.error?.code === 'PLOINKY_PROVIDER_TERMINAL_CLEANUP_FAILED') {
            throw outcome.error;
        }
        return termination;
    };

    try {
        const launched = await Promise.race([spawnOutcome, timeout]);
        if (launched.kind === 'timeout') {
            const termination = await cleanupTimedOutReadiness();
            const timeoutError = policyError('provider readiness timed out', 'PLOINKY_PROVIDER_READINESS_TIMEOUT');
            timeoutError.terminationEvidence = termination?.evidence ?? Object.freeze([]);
            throw timeoutError;
        }
        if (launched.kind === 'spawn-error') throw launched.error;

        const handle = launched.handle;
        const output = [];
        let outputBytes = 0;
        const collect = (chunk) => {
            if (outputBytes >= 64 * 1024) return;
            const bytes = Buffer.from(chunk);
            const remaining = 64 * 1024 - outputBytes;
            output.push(bytes.subarray(0, remaining));
            outputBytes += Math.min(bytes.length, remaining);
        };
        handle.child.stdout?.on('data', collect);
        handle.child.stderr?.on('data', collect);
        const completionOutcome = handle.completion.then(
            (result) => Object.freeze({ kind: 'completion', result }),
            (error) => Object.freeze({ kind: 'completion-error', error }),
        );
        const completed = await Promise.race([completionOutcome, timeout]);
        if (completed.kind === 'timeout') {
            const termination = await cleanupTimedOutReadiness(launched);
            const timeoutError = policyError('provider readiness timed out', 'PLOINKY_PROVIDER_READINESS_TIMEOUT');
            timeoutError.terminationEvidence = termination?.evidence ?? Object.freeze([]);
            throw timeoutError;
        }
        if (completed.kind === 'completion-error') throw completed.error;
        const result = completed.result;
        if (result.code !== 0 || result.signal) {
            throw policyError('provider readiness command failed', 'PLOINKY_PROVIDER_READINESS_FAILED');
        }
        return Object.freeze({
            provider: handle.launch.provider,
            mode: handle.launch.mode,
            output: Buffer.concat(output).toString('utf8'),
        });
    } finally {
        if (timer) clearTimeout(timer);
    }
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
    leaseRootTopology(value);
    return value;
}

export function inspectProviderLeaseProcess(pid, options = {}) {
    return inspectProcessIdentity(pid, options);
}

function leaseDependencies(overrides = {}) {
    assertExactKeys(overrides, new Set(['fs', 'inspectProcessIdentity', 'randomBytes', 'now', 'getUid']), new Set(), 'lease dependencies');
    return {
        fs: overrides.fs || fs,
        inspectProcessIdentity: overrides.inspectProcessIdentity || inspectProviderLeaseProcess,
        randomBytes: overrides.randomBytes || randomBytes,
        now: overrides.now || Date.now,
        getUid: overrides.getUid || (() => (typeof process.getuid === 'function' ? process.getuid() : null)),
    };
}

function normalizeLeaseInput(input, dependencies) {
    const allowed = new Set(['homeKey', 'generation', 'role', 'metadata', 'leaseRoot', 'ownerPid', 'ownerToken']);
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
    const currentUid = dependencies.getUid();
    if (!Number.isSafeInteger(currentUid) || currentUid < 0) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'cannot prove the effective lease owner uid');
    }
    const current = dependencies.inspectProcessIdentity(ownerPid);
    if (current?.state !== 'identified'
        || !Number.isSafeInteger(current.processUid)
        || current.processUid < 0
        || current.processUid !== currentUid) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'cannot prove lease owner process identity and uid');
    }
    let ownerStartIdentity;
    try {
        ownerStartIdentity = normalizeProcessIdentity(current.processIdentity);
    } catch (_) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease owner start identity is not boot-bound and canonical');
    }
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
        ownerUid: currentUid,
        ownerStartIdentity,
        ownerToken,
    };
}

function ensureLeaseRoot(root, fsImpl) {
    const topology = openPinnedLeaseTopology(root, fsImpl);
    let created = false;
    let storePin = null;
    try {
        try {
            fsImpl.mkdirSync(root, { mode: 0o700 });
            created = true;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }
        if (created) fsyncPinnedLeaseDirectory(topology.runPin, fsImpl);
        else {
            assertPinnedLeaseDirectory(
                topology.runPin,
                fsImpl,
                'provider HOME lease parent changed while opening the private store',
            );
        }
        storePin = Object.freeze({
            ...openPinnedLeaseDirectoryPath(root, fsImpl, { privateStore: true }),
            parentPin: topology.runPin,
        });
        ensureLeaseRootLineage(root, topology, storePin, fsImpl, { initialize: created });
        assertPinnedLeaseDirectory(
            storePin,
            fsImpl,
            'provider HOME lease root changed while validating store lineage',
        );
    } finally {
        if (storePin) closePinnedLeaseDirectory(storePin, fsImpl);
        else closePinnedLeaseDirectory(topology.runPin, fsImpl);
    }
}

function leaseRootTopology(root) {
    const run = path.dirname(root);
    const ploinky = path.dirname(run);
    const workspace = path.dirname(ploinky);
    const expected = path.join(workspace, '.ploinky', 'run', 'provider-home-leases');
    if (workspace === path.parse(workspace).root
        || path.basename(root) !== 'provider-home-leases'
        || path.basename(run) !== 'run'
        || path.basename(ploinky) !== '.ploinky'
        || expected !== root) {
        throw leaseError(
            'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
            'provider HOME lease root must use the exact workspace .ploinky/run/provider-home-leases topology',
        );
    }
    return Object.freeze({ workspace, ploinky, run, root });
}

function leaseLineagePath(topology) {
    return path.join(topology.workspace, '.ploinky-provider-home-leases-lineage.json');
}

function canonicalLeaseLineage(root, topology, storePin) {
    return Object.freeze({
        leaseRoot: root,
        ploinkyDev: String(topology.ploinkyPin.dev),
        ploinkyIno: String(topology.ploinkyPin.ino),
        rootDev: String(storePin.dev),
        rootIno: String(storePin.ino),
        runDev: String(topology.runPin.dev),
        runIno: String(topology.runPin.ino),
        schemaVersion: LEASE_LINEAGE_SCHEMA_VERSION,
        workspaceDev: String(topology.workspacePin.dev),
        workspaceIno: String(topology.workspacePin.ino),
    });
}

function serializeLeaseLineage(lineage) {
    return `${JSON.stringify({
        leaseRoot: lineage.leaseRoot,
        ploinkyDev: lineage.ploinkyDev,
        ploinkyIno: lineage.ploinkyIno,
        rootDev: lineage.rootDev,
        rootIno: lineage.rootIno,
        runDev: lineage.runDev,
        runIno: lineage.runIno,
        schemaVersion: lineage.schemaVersion,
        workspaceDev: lineage.workspaceDev,
        workspaceIno: lineage.workspaceIno,
    })}\n`;
}

function validateLeaseLineage(parsed, root) {
    const keys = new Set([
        'leaseRoot', 'ploinkyDev', 'ploinkyIno', 'rootDev', 'rootIno',
        'runDev', 'runIno', 'schemaVersion', 'workspaceDev', 'workspaceIno',
    ]);
    assertExactKeys(
        parsed,
        keys,
        keys,
        'provider HOME lease lineage',
    );
    const decimalFields = [
        parsed.ploinkyDev, parsed.ploinkyIno, parsed.rootDev, parsed.rootIno,
        parsed.runDev, parsed.runIno, parsed.workspaceDev, parsed.workspaceIno,
    ];
    if (parsed.schemaVersion !== LEASE_LINEAGE_SCHEMA_VERSION || parsed.leaseRoot !== root
        || decimalFields.some((value) => !/^(?:0|[1-9][0-9]{0,31})$/.test(value))) {
        throw leaseError(
            'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
            'provider HOME lease lineage is invalid',
        );
    }
    return Object.freeze({ ...parsed });
}

function readLeaseLineage(lineagePath, root, fsImpl) {
    const noFollow = fsImpl.constants?.O_NOFOLLOW;
    if (!Number.isInteger(noFollow) || noFollow === 0) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'O_NOFOLLOW is required for lease lineage reads');
    }
    let descriptor;
    try {
        descriptor = fsImpl.openSync(lineagePath, fsImpl.constants.O_RDONLY | noFollow);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error?.code === 'ELOOP') {
            throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease lineage is a symlink');
        }
        throw error;
    }
    let raw;
    try {
        const stat = fsImpl.fstatSync(descriptor);
        const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
        if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > MAX_LEASE_LINEAGE_BYTES
            || (stat.mode & 0o777) !== 0o600 || (currentUid !== null && stat.uid !== currentUid)) {
            throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease lineage file is unsafe');
        }
        raw = fsImpl.readFileSync(descriptor, 'utf8');
    } finally {
        fsImpl.closeSync(descriptor);
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease lineage is malformed');
    }
    const lineage = validateLeaseLineage(parsed, root);
    if (serializeLeaseLineage(lineage) !== raw) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease lineage is not canonical');
    }
    return lineage;
}

function writeLeaseLineage(lineagePath, lineage, workspacePin, fsImpl) {
    const noFollow = fsImpl.constants?.O_NOFOLLOW;
    if (!Number.isInteger(noFollow) || noFollow === 0) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'O_NOFOLLOW is required for lease lineage creation');
    }
    const payload = Buffer.from(serializeLeaseLineage(lineage), 'utf8');
    let descriptor;
    try {
        descriptor = fsImpl.openSync(
            lineagePath,
            fsImpl.constants.O_WRONLY | fsImpl.constants.O_CREAT | fsImpl.constants.O_EXCL | noFollow,
            0o600,
        );
        let offset = 0;
        while (offset < payload.length) {
            const written = fsImpl.writeSync(descriptor, payload, offset, payload.length - offset, null);
            if (!Number.isSafeInteger(written) || written <= 0 || written > payload.length - offset) {
                throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease lineage write was incomplete');
            }
            offset += written;
        }
        fsImpl.fsyncSync(descriptor);
        const stat = fsImpl.fstatSync(descriptor);
        const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== payload.length
            || (stat.mode & 0o777) !== 0o600 || (currentUid !== null && stat.uid !== currentUid)) {
            throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease lineage write was unsafe');
        }
    } finally {
        if (descriptor !== undefined) fsImpl.closeSync(descriptor);
    }
    fsyncPinnedLeaseDirectory(workspacePin, fsImpl);
}

function ensureLeaseRootLineage(root, topology, storePin, fsImpl, { initialize }) {
    const lineagePath = leaseLineagePath(topology.paths);
    const expected = canonicalLeaseLineage(root, topology, storePin);
    let lineage = readLeaseLineage(lineagePath, root, fsImpl);
    if (initialize) {
        if (lineage) {
            throw leaseError(
                'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
                'provider HOME lease store was recreated under an existing workspace lineage',
            );
        }
        try {
            writeLeaseLineage(lineagePath, expected, topology.workspacePin, fsImpl);
            lineage = readLeaseLineage(lineagePath, root, fsImpl);
        } catch (error) {
            if (error?.code === 'EEXIST') {
                throw leaseError(
                    'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
                    'provider HOME lease lineage appeared during initialization',
                );
            }
            throw error;
        }
    } else if (!lineage) {
        throw leaseError(
            'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
            'provider HOME lease lineage is missing for the existing store',
        );
    }
    if (!lineage || serializeLeaseLineage(lineage) !== serializeLeaseLineage(expected)) {
        throw leaseError(
            'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
            'provider HOME lease root does not match its durable workspace lineage',
        );
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
        ownerUid: value.ownerUid,
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
    try {
        normalizeProcessIdentity(parsed.ownerStartIdentity);
    } catch (_) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease owner start identity is not boot-bound and canonical');
    }
    normalizeBoundedText(parsed.ownerToken, 'lease owner token', 128, /^[A-Za-z0-9_-]{32,128}$/);
    if (!Number.isSafeInteger(parsed.ownerPid) || parsed.ownerPid <= 0 || parsed.ownerPid > MAX_INT32) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease owner pid is invalid');
    }
    if (!Number.isSafeInteger(parsed.ownerUid) || parsed.ownerUid < 0) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'lease owner uid is invalid');
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
            || stat.size <= 0 || stat.size > MAX_LEASE_BYTES || (stat.mode & 0o777) !== 0o600
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

function leasePublicationPrefix(leasePath) {
    return `${path.basename(leasePath)}.publication-`;
}

function leasePublicationArtifacts(leasePath, fsImpl) {
    const prefix = leasePublicationPrefix(leasePath);
    return fsImpl.readdirSync(path.dirname(leasePath))
        .filter((name) => name.startsWith(prefix));
}

function publicationArtifactStat(candidatePath, fsImpl) {
    const stat = fsImpl.lstatSync(candidatePath);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1 || stat.nlink > 2
        || stat.size < 0 || stat.size > MAX_LEASE_BYTES || (stat.mode & 0o777) !== 0o600
        || (currentUid !== null && stat.uid !== currentUid)) {
        throw leaseError(
            'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
            'provider HOME lease publication artifact is unsafe',
        );
    }
    return stat;
}

function recoverLeasePublicationArtifacts(leasePath, homeKey, fsImpl) {
    const names = leasePublicationArtifacts(leasePath, fsImpl);
    if (names.length > 16) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease has excessive publication state');
    }
    const escapedPrefix = leasePublicationPrefix(leasePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const name of names.sort()) {
        if (!new RegExp(`^${escapedPrefix}[a-f0-9]{32}\\.candidate$`).test(name)) {
            throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease has malformed publication state');
        }
        const candidatePath = path.join(path.dirname(leasePath), name);
        let stat;
        try { stat = publicationArtifactStat(candidatePath, fsImpl); } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
        }
        if (stat.nlink === 1) {
            // A private candidate is never lease authority. This includes a
            // crash or EIO during its bounded write; removing only this name
            // cannot affect an already-published canonical lease.
            try { durableLeaseUnlinkSync(candidatePath, fsImpl); } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
            continue;
        }

        const canonical = readLeaseSnapshot(leasePath, homeKey, fsImpl, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        if (!canonical) {
            throw leaseError(
                'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
                'linked publication state exists without its canonical lease',
            );
        }
        const candidate = readLeaseSnapshot(candidatePath, homeKey, fsImpl, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        if (!sameLeaseSnapshot(candidate, canonical)) {
            throw leaseError(
                'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
                'publication artifact does not match the canonical lease',
            );
        }
        durableLeaseUnlinkSync(candidatePath, fsImpl);
        readLeaseSnapshot(leasePath, homeKey, fsImpl);
    }
}

function writeExactLeaseCandidate(candidatePath, payload, homeKey, fsImpl) {
    const noFollow = fsImpl.constants?.O_NOFOLLOW;
    if (!Number.isInteger(noFollow) || noFollow === 0) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'O_NOFOLLOW is required for provider HOME lease publication');
    }
    const flags = fsImpl.constants.O_WRONLY | fsImpl.constants.O_CREAT
        | fsImpl.constants.O_EXCL | noFollow;
    const bytes = Buffer.from(payload, 'utf8');
    let descriptor;
    try {
        descriptor = fsImpl.openSync(candidatePath, flags, 0o600);
        let offset = 0;
        while (offset < bytes.length) {
            const written = fsImpl.writeSync(descriptor, bytes, offset, bytes.length - offset, null);
            if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) {
                throw leaseError(
                    'PLOINKY_PROVIDER_HOME_LEASE_PUBLICATION_FAILED',
                    'provider HOME lease candidate write was incomplete',
                );
            }
            offset += written;
        }
        fsImpl.fsyncSync(descriptor);
        const stat = fsImpl.fstatSync(descriptor);
        const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes.length
            || (stat.mode & 0o777) !== 0o600 || (currentUid !== null && stat.uid !== currentUid)) {
            throw leaseError(
                'PLOINKY_PROVIDER_HOME_LEASE_PUBLICATION_FAILED',
                'provider HOME lease candidate validation failed',
            );
        }
    } finally {
        if (descriptor !== undefined) fsImpl.closeSync(descriptor);
    }
    const snapshot = readLeaseSnapshot(candidatePath, homeKey, fsImpl);
    if (snapshot.raw !== payload) {
        throw leaseError(
            'PLOINKY_PROVIDER_HOME_LEASE_PUBLICATION_FAILED',
            'provider HOME lease candidate changed before publication',
        );
    }
    return snapshot;
}

function markLeaseTransitionApplied(error, { durabilityUncertain = true } = {}) {
    if (error && typeof error === 'object') {
        error.providerLeaseTransitionApplied = true;
        if (durabilityUncertain) error.providerLeaseDurabilityUncertain = true;
    }
    return error;
}

function leaseTransitionPathStat(filePath, fsImpl) {
    try { return fsImpl.lstatSync(filePath); } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function sameLeaseTransitionInode(left, right) {
    return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino;
}

function exactLeaseTransitionFile(stat) {
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    return Boolean(stat) && stat.isFile() && !stat.isSymbolicLink()
        && (stat.mode & 0o777) === 0o600
        && (currentUid === null || stat.uid === currentUid);
}

function assertPinnedLeaseDirectory(pin, fsImpl, message) {
    const descriptorStat = fsImpl.fstatSync(pin.descriptor);
    const pathStat = fsImpl.lstatSync(pin.directory);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    const mode = pathStat.mode & 0o777;
    const expectedMode = pin.privateStore ? mode === 0o700 : (mode & 0o022) === 0;
    if (!descriptorStat.isDirectory() || !pathStat.isDirectory() || pathStat.isSymbolicLink()
        || descriptorStat.dev !== pin.dev || descriptorStat.ino !== pin.ino
        || pathStat.dev !== pin.dev || pathStat.ino !== pin.ino
        || !expectedMode || (descriptorStat.mode & 0o777) !== mode
        || (currentUid !== null && (descriptorStat.uid !== currentUid || pathStat.uid !== currentUid))) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', message);
    }
    if (pin.parentPin) assertPinnedLeaseDirectory(pin.parentPin, fsImpl, message);
}

function leaseDirectoryFlags(fsImpl) {
    const noFollow = fsImpl.constants?.O_NOFOLLOW;
    const directoryFlag = fsImpl.constants?.O_DIRECTORY;
    if (!Number.isInteger(noFollow) || noFollow === 0
        || !Number.isInteger(directoryFlag) || directoryFlag === 0) {
        throw leaseError(
            'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
            'O_NOFOLLOW and O_DIRECTORY are required for provider HOME lease publication',
        );
    }
    return fsImpl.constants.O_RDONLY | directoryFlag | noFollow;
}

function openPinnedLeaseDirectoryPath(directory, fsImpl, { privateStore }) {
    let descriptor;
    try {
        descriptor = fsImpl.openSync(directory, leaseDirectoryFlags(fsImpl));
    } catch (error) {
        if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR' || error?.code === 'ENOENT') {
            throw leaseError(
                'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
                'provider HOME lease directory topology is unavailable or contains a symlink',
            );
        }
        throw error;
    }
    try {
        const stat = fsImpl.fstatSync(descriptor);
        const pin = Object.freeze({
            descriptor,
            directory,
            dev: stat.dev,
            ino: stat.ino,
            privateStore,
        });
        assertPinnedLeaseDirectory(
            pin,
            fsImpl,
            'provider HOME lease directory changed before a durable transition',
        );
        return pin;
    } catch (error) {
        try { fsImpl.closeSync(descriptor); } catch (_) { }
        throw error;
    }
}

function openPinnedLeaseTopology(leaseRoot, fsImpl) {
    const paths = leaseRootTopology(leaseRoot);
    let workspacePin = null;
    let ploinkyPin = null;
    let runPin = null;
    try {
        workspacePin = openPinnedLeaseDirectoryPath(paths.workspace, fsImpl, { privateStore: false });
        ploinkyPin = Object.freeze({
            ...openPinnedLeaseDirectoryPath(paths.ploinky, fsImpl, { privateStore: false }),
            parentPin: workspacePin,
        });
        runPin = Object.freeze({
            ...openPinnedLeaseDirectoryPath(paths.run, fsImpl, { privateStore: false }),
            parentPin: ploinkyPin,
        });
        assertPinnedLeaseDirectory(
            runPin,
            fsImpl,
            'provider HOME lease workspace topology changed while it was pinned',
        );
        return Object.freeze({ paths, workspacePin, ploinkyPin, runPin });
    } catch (error) {
        if (runPin) closePinnedLeaseDirectory(runPin, fsImpl);
        else if (ploinkyPin) closePinnedLeaseDirectory(ploinkyPin, fsImpl);
        else if (workspacePin) closePinnedLeaseDirectory(workspacePin, fsImpl);
        throw error;
    }
}

function openPinnedLeaseDirectory(leasePath, fsImpl) {
    const directory = path.dirname(leasePath);
    const topology = openPinnedLeaseTopology(directory, fsImpl);
    let storePin = null;
    try {
        storePin = Object.freeze({
            ...openPinnedLeaseDirectoryPath(directory, fsImpl, { privateStore: true }),
            parentPin: topology.runPin,
        });
        ensureLeaseRootLineage(directory, topology, storePin, fsImpl, { initialize: false });
        assertPinnedLeaseDirectory(
            storePin,
            fsImpl,
            'provider HOME lease workspace topology changed while opening the store',
        );
        return storePin;
    } catch (error) {
        if (storePin) closePinnedLeaseDirectory(storePin, fsImpl);
        else closePinnedLeaseDirectory(topology.runPin, fsImpl);
        throw error;
    }
}

function closePinnedLeaseDirectory(pin, fsImpl) {
    try { fsImpl.closeSync(pin.descriptor); } catch (_) { }
    if (pin.parentPin) closePinnedLeaseDirectory(pin.parentPin, fsImpl);
}

function fsyncPinnedLeaseDirectory(pin, fsImpl) {
    fsImpl.fsyncSync(pin.descriptor);
    if (pin.parentPin) {
        assertPinnedLeaseDirectory(
            pin.parentPin,
            fsImpl,
            'provider HOME lease parent changed during a durable transition',
        );
    }
    assertPinnedLeaseDirectory(
        pin,
        fsImpl,
        'provider HOME lease directory changed during a durable transition',
    );
}

function acceptAppliedLeaseMutation(pin, mutationError, fsImpl) {
    try {
        fsyncPinnedLeaseDirectory(pin, fsImpl);
    } catch (durabilityError) {
        if (durabilityError && typeof durabilityError === 'object') {
            durabilityError.mutationError = mutationError;
        }
        throw markLeaseTransitionApplied(durabilityError);
    }
}

function durableLeaseLinkSync(sourcePath, destinationPath, fsImpl) {
    if (path.dirname(sourcePath) !== path.dirname(destinationPath)) {
        throw leaseError(
            'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
            'provider HOME lease transition paths must share one exact directory',
        );
    }
    const pin = openPinnedLeaseDirectory(sourcePath, fsImpl);
    try {
        const sourceBefore = leaseTransitionPathStat(sourcePath, fsImpl);
        const destinationBefore = leaseTransitionPathStat(destinationPath, fsImpl);
        try {
            fsImpl.linkSync(sourcePath, destinationPath);
        } catch (mutationError) {
            try {
                const sourceAfter = leaseTransitionPathStat(sourcePath, fsImpl);
                const destinationAfter = leaseTransitionPathStat(destinationPath, fsImpl);
                const exactSource = sourceAfter || sourceBefore;
                if (!destinationBefore && exactLeaseTransitionFile(exactSource)
                    && exactLeaseTransitionFile(destinationAfter)
                    && sameLeaseTransitionInode(exactSource, destinationAfter)) {
                    acceptAppliedLeaseMutation(pin, mutationError, fsImpl);
                    return;
                }
            } catch (proofError) {
                if (proofError && typeof proofError === 'object') proofError.mutationError = mutationError;
                throw markLeaseTransitionApplied(proofError);
            }
            throw mutationError;
        }
        try {
            fsyncPinnedLeaseDirectory(pin, fsImpl);
        } catch (error) {
            throw markLeaseTransitionApplied(error);
        }
        try {
            const sourceAfter = leaseTransitionPathStat(sourcePath, fsImpl);
            const destinationAfter = leaseTransitionPathStat(destinationPath, fsImpl);
            if (destinationBefore || !exactLeaseTransitionFile(sourceAfter)
                || !exactLeaseTransitionFile(destinationAfter)
                || !sameLeaseTransitionInode(sourceAfter, destinationAfter)) {
                throw leaseError(
                    'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
                    'provider HOME lease hard-link source changed during publication',
                );
            }
        } catch (proofError) {
            throw markLeaseTransitionApplied(proofError);
        }
    } finally {
        closePinnedLeaseDirectory(pin, fsImpl);
    }
}

function durableLeaseUnlinkSync(filePath, fsImpl) {
    const pin = openPinnedLeaseDirectory(filePath, fsImpl);
    try {
        const before = leaseTransitionPathStat(filePath, fsImpl);
        try {
            fsImpl.unlinkSync(filePath);
        } catch (mutationError) {
            try {
                const after = leaseTransitionPathStat(filePath, fsImpl);
                if (exactLeaseTransitionFile(before)
                    && (!after || !sameLeaseTransitionInode(before, after))) {
                    acceptAppliedLeaseMutation(pin, mutationError, fsImpl);
                    return;
                }
            } catch (proofError) {
                if (proofError && typeof proofError === 'object') proofError.mutationError = mutationError;
                throw markLeaseTransitionApplied(proofError);
            }
            throw mutationError;
        }
        try {
            fsyncPinnedLeaseDirectory(pin, fsImpl);
        } catch (error) {
            throw markLeaseTransitionApplied(error);
        }
    } finally {
        closePinnedLeaseDirectory(pin, fsImpl);
    }
}

function durableLeaseMoveNoClobberSync(sourcePath, destinationPath, fsImpl) {
    try {
        durableLeaseLinkSync(sourcePath, destinationPath, fsImpl);
    } catch (error) {
        if (error?.code === 'EEXIST') {
            // A pre-existing destination may be independent ownership evidence.
            // Preserve it and the caller's claim for exact recovery.
            throw markLeaseTransitionApplied(error, { durabilityUncertain: false });
        }
        throw error;
    }
    try {
        durableLeaseUnlinkSync(sourcePath, fsImpl);
    } catch (error) {
        // The no-clobber destination is already durable. Preserve both names
        // when retirement of the source cannot be established exactly.
        throw markLeaseTransitionApplied(error);
    }
}

function publishLeaseRecord(leasePath, homeKey, payload, fsImpl) {
    const publicationId = createHash('sha256').update(payload).digest('hex').slice(0, 32);
    const candidatePath = `${leasePath}.publication-${publicationId}.candidate`;
    let candidateCreated = false;
    let canonicalLinked = false;
    try {
        let candidate;
        try {
            candidate = writeExactLeaseCandidate(candidatePath, payload, homeKey, fsImpl);
        } catch (error) {
            if (error?.code === 'EEXIST') return false;
            throw error;
        }
        candidateCreated = true;
        try {
            durableLeaseLinkSync(candidatePath, leasePath, fsImpl);
            canonicalLinked = true;
        } catch (error) {
            if ((error?.code === 'EEXIST' || error?.code === 'ENOENT')
                && !error?.providerLeaseTransitionApplied) {
                durableLeaseUnlinkSync(candidatePath, fsImpl);
                candidateCreated = false;
                return false;
            }
            throw error;
        }
        const linkedCandidate = readLeaseSnapshot(candidatePath, homeKey, fsImpl, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        const canonical = readLeaseSnapshot(leasePath, homeKey, fsImpl, {
            minimumLinks: 2,
            maximumLinks: 2,
        });
        if (!sameLeaseSnapshot(candidate, linkedCandidate) || !sameLeaseSnapshot(candidate, canonical)) {
            throw leaseError(
                'PLOINKY_PROVIDER_HOME_LEASE_PUBLICATION_FAILED',
                'provider HOME lease changed during exact publication',
            );
        }
        try {
            durableLeaseUnlinkSync(candidatePath, fsImpl);
            candidateCreated = false;
        } catch (cleanupError) {
            // The canonical name and its inode were validated before the
            // successful directory fsync above, so lease authority is already
            // durably committed. Candidate cleanup is idempotent recovery
            // state; returning ownership avoids orphaning a live lease when
            // unlink or the cleanup fsync reports an error.
            const committed = readLeaseSnapshot(leasePath, homeKey, fsImpl, {
                minimumLinks: 1,
                maximumLinks: 2,
            });
            if (!sameLeaseSnapshot(candidate, committed)) throw cleanupError;
            return true;
        }
        const published = readLeaseSnapshot(leasePath, homeKey, fsImpl);
        if (!sameLeaseSnapshot(candidate, published)) {
            throw leaseError(
                'PLOINKY_PROVIDER_HOME_LEASE_PUBLICATION_FAILED',
                'provider HOME lease changed after exact publication',
            );
        }
        return true;
    } catch (error) {
        if (candidateCreated && !canonicalLinked && !error?.providerLeaseTransitionApplied) {
            try { durableLeaseUnlinkSync(candidatePath, fsImpl); } catch (_) { }
        }
        throw error;
    }
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

function inspectLeaseOwner(record, dependencies) {
    const owner = dependencies.inspectProcessIdentity(record.ownerPid);
    if (!owner || !['dead', 'identified', 'uid-diverged', 'unknown'].includes(owner.state)) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'process identity inspector returned an invalid result');
    }
    if (owner.state === 'dead') return Object.freeze({ state: 'stale', reason: 'dead' });
    if (owner.state === 'unknown' || owner.state === 'uid-diverged') {
        return Object.freeze({ state: 'busy', uncertain: true });
    }
    if (!Number.isSafeInteger(owner.processUid) || owner.processUid < 0) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'process identity inspector returned an invalid uid');
    }
    let processIdentity;
    try {
        processIdentity = normalizeProcessIdentity(owner.processIdentity);
    } catch (_) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'process identity inspector returned an unbootbound identity');
    }
    if (processIdentity !== record.ownerStartIdentity) {
        return Object.freeze({ state: 'stale', reason: 'pid-reused' });
    }
    if (owner.processUid !== record.ownerUid) {
        return Object.freeze({ state: 'busy', uncertain: true });
    }
    return Object.freeze({ state: 'busy', uncertain: false });
}

function recoverLeaseOperationArtifacts(leasePath, homeKey, dependencies) {
    const names = leaseOperationArtifacts(leasePath, dependencies.fs);
    if (names.length === 0) return;
    if (names.length > 4) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease has excessive exact-removal state');
    }
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
        ? readLeaseSnapshot(artifacts.get('claim'), homeKey, dependencies.fs, { minimumLinks: 1, maximumLinks: 3 })
        : null;
    const quarantine = artifacts.has('quarantine')
        ? readLeaseSnapshot(artifacts.get('quarantine'), homeKey, dependencies.fs, { minimumLinks: 1, maximumLinks: 3 })
        : null;
    if (!claim && !quarantine) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease operation state is not exact');
    }

    if (claim && operationSnapshotId(claim) !== operationId) {
        throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease claim state is not exact');
    }

    const canonical = readLeaseSnapshot(leasePath, homeKey, dependencies.fs, {
        minimumLinks: 1,
        maximumLinks: 3,
    });

    if (claim && !quarantine) {
        if (canonical) {
            // With canonical authority still present, the lone claim is
            // operation-private whether it names that authority or an older
            // inode. Retire only the exact claim name.
            durableLeaseUnlinkSync(artifacts.get('claim'), dependencies.fs);
            return;
        }
        // Without canonical or quarantine, the claim is the last recognized
        // authority. Exact UID/PID-start death or reuse is required.
        const claimedOwner = inspectLeaseOwner(claim.record, dependencies);
        if (claimedOwner.state === 'busy') throw busyLease(claim.record, claimedOwner.uncertain);
        durableLeaseUnlinkSync(artifacts.get('claim'), dependencies.fs);
        return;
    }

    if (!claim && quarantine) {
        if (canonical && sameLeaseSnapshot(canonical, quarantine)) {
            durableLeaseUnlinkSync(artifacts.get('quarantine'), dependencies.fs);
            return;
        }
        // A quarantine without matching canonical authority is itself the
        // last recognized owner, including a displaced P2. Never retire it
        // until exact UID/PID-start staleness is proved.
        const quarantinedOwner = inspectLeaseOwner(quarantine.record, dependencies);
        if (quarantinedOwner.state === 'busy') {
            throw busyLease(quarantine.record, quarantinedOwner.uncertain);
        }
        durableLeaseUnlinkSync(artifacts.get('quarantine'), dependencies.fs);
        return;
    }

    if (!sameLeaseSnapshot(claim, quarantine)) {
        if (canonical && sameLeaseSnapshot(canonical, quarantine)) {
            // The displaced owner is already restored at the canonical name;
            // both operation paths are now private cleanup state.
            durableLeaseUnlinkSync(artifacts.get('quarantine'), dependencies.fs);
            durableLeaseUnlinkSync(artifacts.get('claim'), dependencies.fs);
            return;
        }
        // P1 was claimed, P2 replaced it and was moved to quarantine, and P3
        // may already own the canonical path. P2 is not our private state: it
        // remains an ownership authority until exact death/PID reuse is proven.
        const quarantinedOwner = inspectLeaseOwner(quarantine.record, dependencies);
        if (quarantinedOwner.state === 'busy') {
            throw busyLease(quarantine.record, quarantinedOwner.uncertain);
        }
        // Retire the stale displaced authority first. If interrupted, the
        // claim-only state remains exact and recovery never touches canonical.
        durableLeaseUnlinkSync(artifacts.get('quarantine'), dependencies.fs);
        durableLeaseUnlinkSync(artifacts.get('claim'), dependencies.fs);
        return;
    }

    if (canonical) {
        // The canonical name (same inode or a successor) preserves authority;
        // the two matching operation names can be retired without consulting
        // a live owner and without touching canonical.
        durableLeaseUnlinkSync(artifacts.get('quarantine'), dependencies.fs);
        durableLeaseUnlinkSync(artifacts.get('claim'), dependencies.fs);
        return;
    }

    const owner = inspectLeaseOwner(quarantine.record, dependencies);
    if (owner.state === 'busy') throw busyLease(quarantine.record, owner.uncertain);

    // Operation paths are never acquisition authorities. Once their recorded
    // owner is proved dead or PID-reused, removing only these paths is safe;
    // a successor at the canonical lease path is never touched.
    durableLeaseUnlinkSync(artifacts.get('quarantine'), dependencies.fs);
    durableLeaseUnlinkSync(artifacts.get('claim'), dependencies.fs);
}

function removeExactLeaseSnapshot(leasePath, homeKey, snapshot, fsImpl) {
    assertNoLeaseOperationArtifacts(leasePath, fsImpl);
    const operationId = operationSnapshotId(snapshot);
    const operationBase = `${leasePath}.operation-${operationId}`;
    const claimPath = `${operationBase}.claim`;
    const quarantinePath = `${operationBase}.quarantine`;
    let claimCreated = false;
    let primaryTransitionApplied = false;

    try {
        try {
            durableLeaseLinkSync(leasePath, claimPath, fsImpl);
            claimCreated = true;
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            if (error?.providerLeaseTransitionApplied) claimCreated = true;
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
            minimumLinks: 1,
            maximumLinks: 2,
        });
        if (!sameLeaseSnapshot(claim, snapshot)) {
            // A successor won before our hard-link claim. The claim is the
            // only private name created by this operation; remove only it and
            // leave the successor at the canonical path untouched.
            durableLeaseUnlinkSync(claimPath, fsImpl);
            claimCreated = false;
            return false;
        }

        // Publish the quarantine with hard-link no-clobber semantics before
        // retiring canonical. Plain rename is forbidden because it can
        // overwrite independent recovery evidence at the destination.
        try {
            durableLeaseMoveNoClobberSync(leasePath, quarantinePath, fsImpl);
            primaryTransitionApplied = true;
        } catch (error) {
            if (error?.providerLeaseTransitionApplied) primaryTransitionApplied = true;
            throw error;
        }
        const postClaim = readLeaseSnapshot(claimPath, homeKey, fsImpl, {
            minimumLinks: 1,
            maximumLinks: 3,
        });
        const quarantined = readLeaseSnapshot(quarantinePath, homeKey, fsImpl, {
            minimumLinks: 1,
            maximumLinks: 3,
        });
        if (
            !sameLeaseSnapshot(postClaim, snapshot)
            || !sameLeaseSnapshot(quarantined, snapshot)
        ) {
            // A successor won between the claim and rename. Put the exact
            // inode we moved back under the canonical no-clobber name. Our
            // old claim is private and can then be removed deterministically.
            try {
                durableLeaseLinkSync(quarantinePath, leasePath, fsImpl);
            } catch (error) {
                if (error?.code !== 'EEXIST') throw error;
                const canonical = readLeaseSnapshot(leasePath, homeKey, fsImpl, {
                    minimumLinks: 1,
                    maximumLinks: 3,
                });
                if (!sameLeaseSnapshot(canonical, quarantined)) {
                    throw leaseError(
                        'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
                        'multiple successors raced exact lease removal',
                    );
                }
            }
            durableLeaseUnlinkSync(quarantinePath, fsImpl);
            durableLeaseUnlinkSync(claimPath, fsImpl);
            claimCreated = false;
            primaryTransitionApplied = false;
            return false;
        }

        durableLeaseUnlinkSync(quarantinePath, fsImpl);
        durableLeaseUnlinkSync(claimPath, fsImpl);
        claimCreated = false;
        primaryTransitionApplied = false;
        return true;
    } catch (error) {
        if (error?.providerLeaseDurabilityUncertain && primaryTransitionApplied) {
            // The last private unlink can apply while both the syscall and its
            // immediate proof read fail. Re-probe only after the pinned
            // descriptor is closed; with no artifacts and no old canonical
            // inode, the exact release has committed.
            try {
                if (leaseOperationArtifacts(leasePath, fsImpl).length === 0) {
                    const canonical = readLeaseSnapshot(leasePath, homeKey, fsImpl);
                    if (!canonical || !sameLeaseSnapshot(canonical, snapshot)) return true;
                }
            } catch (_) { }
        }
        // Before the primary no-clobber transition, removing our private
        // hardlink is safe. Afterwards, preserve every artifact and fail
        // closed for inspection.
        if (claimCreated && !primaryTransitionApplied && !error?.providerLeaseDurabilityUncertain) {
            try {
                durableLeaseUnlinkSync(claimPath, fsImpl);
            } catch (_) { }
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
        ownerUid: record.ownerUid,
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
    recoverLeasePublicationArtifacts(leasePath, normalized.homeKey, dependencies.fs);
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
            ownerUid: normalized.ownerUid,
            generation: normalized.generation,
            role: normalized.role,
            metadata: normalized.metadata,
            acquiredAt: new Date(dependencies.now()).toISOString(),
        }));
        const payload = serializeLeaseRecord(record);
        if (Buffer.byteLength(payload) > MAX_LEASE_BYTES) {
            throw leaseError('PLOINKY_PROVIDER_HOME_LEASE_INVALID', 'provider HOME lease record is too large');
        }
        const published = publishLeaseRecord(leasePath, normalized.homeKey, payload, dependencies.fs);
        if (published) {
            return Object.freeze({
                ...record,
                leasePath,
                leaseRoot: normalized.leaseRoot,
                recoveredStaleOwner,
            });
        }
        recoverLeasePublicationArtifacts(leasePath, normalized.homeKey, dependencies.fs);

        const snapshot = readLeaseSnapshot(leasePath, normalized.homeKey, dependencies.fs);
        if (!snapshot) continue;
        const owner = inspectLeaseOwner(snapshot.record, dependencies);
        if (owner.state === 'busy') throw busyLease(snapshot.record, owner.uncertain);
        if (removeExactLeaseSnapshot(leasePath, normalized.homeKey, snapshot, dependencies.fs)) {
            recoveredStaleOwner = Object.freeze({
                generation: snapshot.record.generation,
                ownerPid: snapshot.record.ownerPid,
                ownerStartIdentity: snapshot.record.ownerStartIdentity,
                ownerUid: snapshot.record.ownerUid,
                role: snapshot.record.role,
                reason: owner.reason,
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
    recoverLeasePublicationArtifacts(leasePath, homeKey, dependencies.fs);
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
