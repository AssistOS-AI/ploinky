import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { domainToASCII } from 'node:url';

import {
    AGENTS_FILE,
    PLOINKY_WORKSPACE_ROOT,
    ROUTING_FILE,
} from '../utils/config.js';
import { normalizeManifestHttpRouteAccess } from '../server/policy/HttpRouteProviders.js';
import { compileHttpRoutePolicy } from '../server/policy/HttpRoutePolicyCompiler.js';
import { resolveManifestRuntimeProfile } from '../utils/runtime/profileService.js';
import { parseRouterHostPort, selectedRouterHostPort } from './routerPort.js';

export const EDGE_GENERATION_SCHEMA_VERSION = 1;
export const EDGE_TOPOLOGY_CONTAINER_DIR = '/run/ploinky-edge-topology';
export const EDGE_TOPOLOGY_CONTAINER_FILE = `${EDGE_TOPOLOGY_CONTAINER_DIR}/current.json`;
export const EDGE_DESIRED_CANDIDATE_MAX_BYTES = 1024 * 1024;
export const PRIVATE_ROUTER_AUDIENCE = 'ploinky-private-router';
export const ROUTER_SURFACE_CATALOG = Object.freeze([
    'agent-mcp',
    'blob-transfer',
    'browser-auth',
    'marketplace-ui',
    'workspace-assets',
]);

const ROUTER_SURFACES = new Set(ROUTER_SURFACE_CATALOG);
const EMPTY_ROUTING_BYTES = Buffer.from(JSON.stringify({ routes: {} }));
const EMPTY_POLICY_BYTES = Buffer.from(JSON.stringify({
    schema: 'router-policy',
    httpRoutes: [],
    mcpTools: [],
}));
const EMPTY_DESIRED_BYTES = Buffer.from(JSON.stringify({
    hosts: {},
}));
const EMPTY_AGENTS_BYTES = Buffer.from('{}');
const AGENT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_HANDLE = /^[a-z0-9](?:[a-z0-9/_-]{0,253}[a-z0-9_-])?$/;
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TOPOLOGY_STATES = new Set([
    'ready',
    'reconciling',
    'error',
]);
const EDGE_PREPARATION_LEASE_SCHEMA_VERSION = 2;
const APPLY_LOCK_CAPABILITIES = new WeakMap();
const PREPARED_HOST_MODE_CAPABILITIES = new WeakMap();

// A box media address must be an operator-configured ordinary public unicast
// address. Special-purpose ranges cannot identify the box even when an entry
// (for example a protocol anycast allocation) is globally reachable.
const NON_GLOBAL_UNICAST_IPV4_RANGES = Object.freeze([
    ['0.0.0.0', 8, 'this-network'],
    ['10.0.0.0', 8, 'private-use'],
    ['100.64.0.0', 10, 'shared-address-space'],
    ['127.0.0.0', 8, 'loopback'],
    ['169.254.0.0', 16, 'link-local'],
    ['172.16.0.0', 12, 'private-use'],
    ['192.0.0.0', 24, 'IETF-protocol-assignments'],
    ['192.0.2.0', 24, 'documentation'],
    ['192.31.196.0', 24, 'AS112-service'],
    ['192.52.193.0', 24, 'AMT-service'],
    ['192.88.99.0', 24, 'deprecated-6to4-relay'],
    ['192.168.0.0', 16, 'private-use'],
    ['192.175.48.0', 24, 'AS112-service'],
    ['198.18.0.0', 15, 'benchmarking'],
    ['198.51.100.0', 24, 'documentation'],
    ['203.0.113.0', 24, 'documentation'],
    ['224.0.0.0', 4, 'multicast'],
    ['240.0.0.0', 4, 'reserved-or-limited-broadcast'],
].map(([network, prefixLength, purpose]) => Object.freeze({
    network,
    prefixLength,
    purpose,
})));

function edgeError(message, code = 'EDGE_GENERATION_INVALID') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function canonicalIpv4Integer(value) {
    if (typeof value !== 'string' || value !== value.trim()) return null;
    const parts = value.split('.');
    if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/.test(part))) return null;
    const octets = parts.map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    return octets.reduce((integer, octet) => (integer * 256) + octet, 0) >>> 0;
}

function ipv4RangeContains(address, network, prefixLength) {
    const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
    return ((address & mask) >>> 0) === ((network & mask) >>> 0);
}

export function normalizePublicMediaIPv4(value) {
    const address = canonicalIpv4Integer(value);
    if (address === null || net.isIP(value) !== 4) {
        throw edgeError('edge desired media.publicIPv4 must be an exact canonical literal IPv4 address');
    }
    const special = NON_GLOBAL_UNICAST_IPV4_RANGES.find((entry) => (
        ipv4RangeContains(address, canonicalIpv4Integer(entry.network), entry.prefixLength)
    ));
    if (special) {
        throw edgeError(
            `edge desired media.publicIPv4 must be a globally routable unicast IPv4 address; ${value} is in ${special.network}/${special.prefixLength} (${special.purpose})`,
        );
    }
    return value;
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertObject(value, label) {
    if (!isPlainObject(value)) throw edgeError(`${label} must be an object`);
    return value;
}

function assertOnlyKeys(value, allowed, label) {
    for (const key of Object.keys(value)) {
        if (RESERVED_OBJECT_KEYS.has(key) || !allowed.has(key)) {
            throw edgeError(`${label} contains unsupported field '${key}'`);
        }
    }
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
}

function stableStringify(value) {
    return JSON.stringify(stableValue(value));
}

function deepFreeze(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    return Object.freeze(value);
}

function resolveWorkspaceRoot(workspaceRoot) {
    return path.resolve(String(workspaceRoot || process.env.PLOINKY_WORKSPACE_ROOT || PLOINKY_WORKSPACE_ROOT));
}

export function resolveEdgeGenerationPaths({ workspaceRoot } = {}) {
    const root = resolveWorkspaceRoot(workspaceRoot);
    const ploinkyDir = path.join(root, '.ploinky');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const topologyDir = path.join(ploinkyDir, 'run', 'edge-topology');
    return {
        root,
        ploinkyDir,
        routingFile: root === PLOINKY_WORKSPACE_ROOT ? ROUTING_FILE : path.join(ploinkyDir, 'routing.json'),
        agentsFile: root === PLOINKY_WORKSPACE_ROOT ? AGENTS_FILE : path.join(ploinkyDir, 'agents.json'),
        policyFile: path.join(ploinkyDir, 'data', 'router-security', 'policy-state.json'),
        desiredFile: path.join(edgeDir, 'desired.json'),
        edgeDir,
        generationsDir: path.join(edgeDir, 'generations'),
        activeSelectorFile: path.join(edgeDir, 'active.json'),
        applyLockFile: path.join(edgeDir, 'apply.lock'),
        preparationLeaseFile: path.join(edgeDir, 'preparation-lease.json'),
        topologyDir,
        topologyGenerationsDir: path.join(topologyDir, 'generations'),
        topologyCurrentFile: path.join(topologyDir, 'current.json'),
    };
}

function parseJsonBytes(bytes, label) {
    try {
        return JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch (_) {
        // Parser diagnostics can echo the malformed source text on newer Node
        // releases. Desired state may contain secret handles, so never include
        // source fragments in an operator-visible error.
        throw edgeError(`${label} is not valid JSON`);
    }
}

function readExact(file, { label = file } = {}) {
    try {
        return fs.readFileSync(file);
    } catch (error) {
        throw edgeError(`${label} is unavailable: ${error?.message || error}`);
    }
}

function hasPersistedGenerationEvidence(paths) {
    if (fs.existsSync(paths.activeSelectorFile) || fs.existsSync(paths.topologyCurrentFile)) return true;
    for (const directory of [paths.generationsDir, paths.topologyGenerationsDir]) {
        try {
            if (fs.readdirSync(directory).length > 0) return true;
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                throw edgeError(`edge initialization evidence is unavailable: ${error?.message || error}`);
            }
        }
    }
    return false;
}

export function initializeFreshEdgeRoutingSources(options = {}) {
    const paths = resolveEdgeGenerationPaths(options);
    const release = acquireApplyLock(paths, options);
    try {
        const sources = [
            ['routing.json', paths.routingFile, EMPTY_ROUTING_BYTES, 0o600],
            ['agents.json', paths.agentsFile, EMPTY_AGENTS_BYTES, 0o600],
            ['policy-state.json', paths.policyFile, EMPTY_POLICY_BYTES, 0o600],
            ['edge desired state', paths.desiredFile, EMPTY_DESIRED_BYTES, 0o600],
        ];
        const present = sources.map(([, file]) => fs.existsSync(file));
        if (present.every(Boolean)) return Object.freeze({ initialized: false, paths });
        if (present.some(Boolean) || hasPersistedGenerationEvidence(paths)) {
            const missing = sources
                .filter((_, index) => !present[index])
                .map(([label]) => label)
                .join(', ');
            throw edgeError(
                `edge routing sources are incomplete; missing ${missing || 'required source files'}; `
                + 'restore exact validated sources before coordinated apply',
                'EDGE_GENERATION_SOURCE_UNAVAILABLE',
            );
        }
        for (const [label, file, bytes, mode] of sources) {
            installImmutableDurable(file, bytes, mode, {
                conflictMessage: `${label} appeared during fresh edge initialization`,
                conflictCode: 'EDGE_GENERATION_SOURCE_UNAVAILABLE',
            });
        }
        return Object.freeze({ initialized: true, paths });
    } finally {
        release();
    }
}

function fsyncDirectory(directory) {
    let fd;
    try {
        fd = fs.openSync(directory, fs.constants.O_RDONLY);
        fs.fsyncSync(fd);
    } catch (error) {
        // Directory fsync is not supported by every host filesystem. File fsync
        // and atomic rename remain authoritative on those platforms.
        if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(error?.code)) throw error;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (_) {}
        }
    }
}

function atomicWrite(file, bytes, { mode } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(tmp, 'wx', mode || 0o600);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(tmp, file);
        fsyncDirectory(path.dirname(file));
    } catch (error) {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (_) {}
        }
        try { removeDurableTemp(tmp); } catch (_) {}
        throw error;
    }
}

function writeDurableTemp(file, bytes, mode) {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const tmp = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(tmp, 'wx', mode);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fsyncDirectory(directory);
        return tmp;
    } catch (error) {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (_) {}
        }
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw error;
    }
}

function removeDurableTemp(tmp) {
    try {
        fs.unlinkSync(tmp);
        fsyncDirectory(path.dirname(tmp));
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

function installImmutableDurable(file, bytes, mode, {
    afterTempFsync = null,
    conflictMessage = 'immutable file already exists with different bytes',
    conflictCode = 'EDGE_GENERATION_CORRUPT',
} = {}) {
    const tmp = writeDurableTemp(file, bytes, mode);
    let preserveCrashArtifact = false;
    try {
        if (typeof afterTempFsync === 'function') {
            try {
                afterTempFsync({ file, tmp });
            } catch (error) {
                // A deterministic test hook models abrupt process death after
                // the durable temp exists. Preserve the artifact exactly as a
                // real crash would; retry must ignore it.
                preserveCrashArtifact = true;
                throw error;
            }
        }
        try {
            fs.linkSync(tmp, file);
            fsyncDirectory(path.dirname(file));
            return { created: true, file, tmp };
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            const existing = fs.readFileSync(file);
            if (!existing.equals(Buffer.from(bytes))) {
                throw edgeError(conflictMessage, conflictCode);
            }
            return { created: false, file, tmp };
        }
    } finally {
        if (!preserveCrashArtifact) removeDurableTemp(tmp);
    }
}

function readDesiredCandidateFile(candidateFile) {
    const raw = String(candidateFile || '').trim();
    if (!raw) throw edgeError('Edge desired-state candidate path is required.', 'EDGE_DESIRED_CANDIDATE_INVALID');
    const file = path.resolve(raw);
    let initial;
    try {
        initial = fs.lstatSync(file, { bigint: true });
    } catch (error) {
        throw edgeError(`edge desired candidate is unavailable: ${error?.message || error}`, 'EDGE_DESIRED_CANDIDATE_INVALID');
    }
    if (!initial.isFile() || initial.isSymbolicLink()) {
        throw edgeError('edge desired candidate must be a non-symlink regular file', 'EDGE_DESIRED_CANDIDATE_INVALID');
    }
    if (initial.size > BigInt(EDGE_DESIRED_CANDIDATE_MAX_BYTES)) {
        throw edgeError(
            `edge desired candidate exceeds ${EDGE_DESIRED_CANDIDATE_MAX_BYTES} bytes`,
            'EDGE_DESIRED_CANDIDATE_TOO_LARGE',
        );
    }

    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino) {
            throw edgeError('edge desired candidate changed before it could be read', 'EDGE_DESIRED_CANDIDATE_RACE');
        }
        if (opened.size > BigInt(EDGE_DESIRED_CANDIDATE_MAX_BYTES)) {
            throw edgeError(
                `edge desired candidate exceeds ${EDGE_DESIRED_CANDIDATE_MAX_BYTES} bytes`,
                'EDGE_DESIRED_CANDIDATE_TOO_LARGE',
            );
        }
        const bytes = fs.readFileSync(fd);
        const finished = fs.fstatSync(fd, { bigint: true });
        if (bytes.length > EDGE_DESIRED_CANDIDATE_MAX_BYTES
            || finished.dev !== opened.dev || finished.ino !== opened.ino
            || finished.size !== opened.size || finished.mtimeNs !== opened.mtimeNs
            || finished.ctimeNs !== opened.ctimeNs) {
            throw edgeError('edge desired candidate changed while it was being read', 'EDGE_DESIRED_CANDIDATE_RACE');
        }
        return bytes;
    } catch (error) {
        if (error?.code?.startsWith?.('EDGE_DESIRED_')) throw error;
        throw edgeError(`edge desired candidate cannot be read safely: ${error?.message || error}`, 'EDGE_DESIRED_CANDIDATE_INVALID');
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (_) {}
        }
    }
}

function digestParts(parts) {
    const hash = crypto.createHash('sha256');
    for (const [name, bytes] of parts) {
        const label = Buffer.from(String(name), 'utf8');
        const body = Buffer.from(bytes);
        hash.update(Buffer.from(String(label.length)));
        hash.update(Buffer.from(':'));
        hash.update(label);
        hash.update(Buffer.from(':'));
        hash.update(Buffer.from(String(body.length)));
        hash.update(Buffer.from(':'));
        hash.update(body);
        hash.update(Buffer.from('\n'));
    }
    return `sha256:${hash.digest('hex')}`;
}

function sourceDigest(bytes) {
    return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function compiledDigest(compiled) {
    return `sha256:${crypto.createHash('sha256').update(stableStringify(compiled)).digest('hex')}`;
}

function decodeCanonicalBase64(value, label) {
    if (typeof value !== 'string' || !value.length || value.length % 4 !== 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw edgeError(`${label} is not canonical base64`, 'EDGE_GENERATION_CORRUPT');
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) {
        throw edgeError(`${label} is not canonical base64`, 'EDGE_GENERATION_CORRUPT');
    }
    return bytes;
}

function normalizeServicePort(value, label) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'boolean') throw edgeError(`${label} must be an integer TCP port`);
    const raw = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isSafeInteger(raw) || raw < 1 || raw > 65535) {
        throw edgeError(`${label} must be an integer TCP port in 1..65535`);
    }
    return raw;
}

function validatePolicy(policy) {
    assertObject(policy, 'policy-state');
    if (policy.schema !== 'router-policy') throw edgeError('policy-state has an unexpected schema');
    if (!Array.isArray(policy.httpRoutes) || !Array.isArray(policy.mcpTools)) {
        throw edgeError('policy-state is missing httpRoutes/mcpTools');
    }
    for (const [index, entry] of policy.httpRoutes.entries()) {
        assertObject(entry, `policy-state.httpRoutes[${index}]`);
    }
    for (const [index, entry] of policy.mcpTools.entries()) {
        assertObject(entry, `policy-state.mcpTools[${index}]`);
        if (typeof entry.agent !== 'string' || !entry.agent
            || typeof entry.tool !== 'string' || !entry.tool
            || !['authenticated', 'internal', 'admin'].includes(String(entry.access || '').trim().toLowerCase())
            || (entry.enabled !== undefined && typeof entry.enabled !== 'boolean')) {
            throw edgeError(`policy-state.mcpTools[${index}] is invalid`);
        }
    }
}

function asManifestHttpRouteSpecs(manifest, routeKey) {
    if (manifest?.routerAccess === undefined || manifest?.routerAccess === null) return [];
    const routerAccess = assertObject(manifest.routerAccess, `manifest(${routeKey}).routerAccess`);
    const raw = routerAccess.httpRoutes;
    if (raw === undefined || raw === null) return [];
    if (Array.isArray(raw)) return raw;
    if (isPlainObject(raw)) {
        return Object.entries(raw).map(([pathValue, value]) => (
            isPlainObject(value)
                ? { path: pathValue, ...value }
                : { path: pathValue, access: String(value || '') }
        ));
    }
    throw edgeError(`manifest(${routeKey}).routerAccess.httpRoutes must be an array or object`);
}

function collectStrictManifestPolicyEntries(routing, manifests) {
    const entries = [];
    for (const [routeKey, route] of Object.entries(routing.routes || {})) {
        if (!route || route.disabled) continue;
        const manifest = manifests[routeKey] || {};
        for (const [index, spec] of asManifestHttpRouteSpecs(manifest, routeKey).entries()) {
            assertObject(spec, `manifest(${routeKey}).routerAccess.httpRoutes[${index}]`);
            if (spec.enabled !== undefined && typeof spec.enabled !== 'boolean') {
                throw edgeError(`manifest(${routeKey}).routerAccess.httpRoutes[${index}].enabled must be a boolean`);
            }
            const normalized = normalizeManifestHttpRouteAccess(spec, { routeKey });
            if (!normalized.ok) {
                throw edgeError(
                    `manifest(${routeKey}).routerAccess.httpRoutes[${index}] is invalid: ${normalized.error || normalized.code}`,
                );
            }
            if (spec.enabled === false) continue;
            entries.push({
                path: normalized.path,
                access: normalized.access,
                routeKey: normalized.routeKey,
                source: 'manifest',
            });
        }
    }
    return entries;
}

function routeDefaultDecision(routing, agents, routeKey, seen = new Set()) {
    const key = String(routeKey || '');
    if (!key || seen.has(key)) return { access: 'guest', routeKey: key, source: 'routeDefault' };
    seen.add(key);
    const route = routing.routes?.[key];
    const record = Object.values(agents || {}).find((entry) => entry && entry.type === 'agent' && (
        String(entry.alias || '') === key
        || (String(entry.repoName || '') === String(route?.repo || '')
            && String(entry.agentName || '') === String(route?.agent || ''))
        || String(entry.agentName || '') === key
    ));
    const mode = String(record?.auth?.mode || '').trim().toLowerCase();
    if (mode === 'guest') return { access: 'guest', routeKey: key, source: 'routeDefault' };
    if (mode && mode !== 'none') return { access: 'authenticated', routeKey: key, source: 'routeDefault' };
    const staticKey = String(routing.static?.agent || '').trim();
    if (staticKey && staticKey !== key) {
        const staticDecision = routeDefaultDecision(routing, agents, staticKey, seen);
        return staticDecision.access === 'authenticated'
            ? { access: 'authenticated', routeKey: key, source: 'routeDefault' }
            : { access: 'guest', routeKey: key, source: 'routeDefault' };
    }
    return { access: 'guest', routeKey: key, source: 'routeDefault' };
}

function normalizeAgentReference(value, label) {
    const raw = String(value || '').trim();
    const parts = raw.split('/');
    if (parts.length !== 2 || !parts.every((part) => AGENT_SEGMENT.test(part))) {
        throw edgeError(`${label} must be an exact <repo>/<agent> identifier`);
    }
    return raw;
}

function normalizePublicHostname(value, label) {
    const raw = String(value || '');
    if (!raw || raw !== raw.trim() || raw.endsWith('.') || raw.includes(':') || raw.includes('/')
        || /[\u0000-\u0020\u007f,@\\%]/.test(raw)) {
        throw edgeError(`${label} must be an exact DNS hostname without a port`);
    }
    const hostname = domainToASCII(raw.toLowerCase());
    const labels = hostname.split('.');
    if (!hostname || hostname.length > 253 || labels.length < 2 || net.isIP(hostname)
        || hostname === 'localhost' || hostname.endsWith('.localhost')
        || labels.some((part) => !part || part.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) {
        throw edgeError(`${label} must be a valid non-local public hostname`);
    }
    return hostname;
}

function normalizeSecretHandle(value, label) {
    const handle = String(value || '').trim();
    if (!SECRET_HANDLE.test(handle) || handle.includes('//') || handle.split('/').some((part) => part === '.' || part === '..')) {
        throw edgeError(`${label} must be an opaque secret-store handle`);
    }
    return handle;
}

function uniqueStrings(values, label, normalizer = (value) => String(value || '').trim()) {
    if (!Array.isArray(values)) throw edgeError(`${label} must be an array`);
    const seen = new Set();
    return values.map((value, index) => {
        const normalized = normalizer(value, `${label}[${index}]`);
        if (!normalized || seen.has(normalized)) throw edgeError(`${label} contains a duplicate or empty value`);
        seen.add(normalized);
        return normalized;
    });
}

function normalizeDesired(desired) {
    assertObject(desired, 'edge desired state');
    assertOnlyKeys(desired, new Set(['hosts', 'cloudflare', 'media', 'turn']), 'edge desired state');

    const hostsInput = assertObject(desired.hosts, 'edge desired hosts');
    const hosts = {};
    for (const [rawHostname, rawEntry] of Object.entries(hostsInput)) {
        const hostname = normalizePublicHostname(rawHostname, `edge desired host '${rawHostname}'`);
        if (Object.prototype.hasOwnProperty.call(hosts, hostname)) {
            throw edgeError(`duplicate desired hostname '${hostname}'`);
        }
        const entry = assertObject(rawEntry, `edge desired host '${hostname}'`);
        assertOnlyKeys(entry, new Set(['agent', 'routerSurfaces']), `edge desired host '${hostname}'`);
        const agent = normalizeAgentReference(entry.agent, `edge desired host '${hostname}'.agent`);
        const normalized = { agent };
        if (entry.routerSurfaces !== undefined) {
            const surfaces = uniqueStrings(entry.routerSurfaces, `edge desired host '${hostname}'.routerSurfaces`);
            for (const surface of surfaces) {
                if (!ROUTER_SURFACES.has(surface)) throw edgeError(`unknown Router surface '${surface}' for '${hostname}'`);
            }
            normalized.routerSurfaces = surfaces.sort();
        }
        hosts[hostname] = normalized;
    }

    let cloudflare;
    if (desired.cloudflare !== undefined) {
        const input = assertObject(desired.cloudflare, 'edge desired cloudflare');
        assertOnlyKeys(input, new Set([
            'accountId',
            'zoneId',
            'tunnelId',
            'tunnelName',
            'tunnelTokenSecret',
            'apiTokenSecret',
            'deleteTunnelOnTeardown',
        ]), 'edge desired cloudflare');
        cloudflare = {};
        for (const key of ['accountId', 'zoneId', 'tunnelId']) {
            if (input[key] !== undefined) {
                const value = String(input[key] || '').trim();
                if (!value || value.length > 256 || /\s/.test(value)) throw edgeError(`edge desired cloudflare.${key} is invalid`);
                cloudflare[key] = value;
            }
        }
        if (input.tunnelName !== undefined) {
            const value = String(input.tunnelName || '').trim();
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(value)) {
                throw edgeError('edge desired cloudflare.tunnelName is invalid');
            }
            cloudflare.tunnelName = value;
        }
        for (const key of ['tunnelTokenSecret', 'apiTokenSecret']) {
            if (input[key] !== undefined) cloudflare[key] = normalizeSecretHandle(input[key], `edge desired cloudflare.${key}`);
        }
        if (input.deleteTunnelOnTeardown !== undefined) {
            if (typeof input.deleteTunnelOnTeardown !== 'boolean') {
                throw edgeError('edge desired cloudflare.deleteTunnelOnTeardown must be a boolean');
            }
            cloudflare.deleteTunnelOnTeardown = input.deleteTunnelOnTeardown;
        }
    }

    let media;
    if (desired.media !== undefined) {
        const input = assertObject(desired.media, 'edge desired media');
        assertOnlyKeys(input, new Set(['publicIPv4', 'addressMode']), 'edge desired media');
        const publicIPv4 = normalizePublicMediaIPv4(input.publicIPv4);
        const addressMode = String(input.addressMode || '').trim();
        if (!['direct', 'nat-forward'].includes(addressMode)) {
            throw edgeError("edge desired media.addressMode must be 'direct' or 'nat-forward'");
        }
        media = { publicIPv4, addressMode };
    }

    let turn;
    if (desired.turn !== undefined) {
        const input = assertObject(desired.turn, 'edge desired turn');
        assertOnlyKeys(input, new Set(['urls', 'credentialMode', 'sharedSecret', 'credentialConsumers']), 'edge desired turn');
        const urls = uniqueStrings(input.urls, 'edge desired turn.urls');
        if (!urls.length || !urls.every((url) => /^turns?:[^\s]+$/i.test(url))) {
            throw edgeError('edge desired turn.urls must contain external TURN URLs');
        }
        const hasUdpLane = urls.some((url) => /^turn:[^?]+\?(?:[^#]*&)?transport=udp(?:&|$)/i.test(url));
        const hasTlsLane = urls.some((url) => /^turns:[^?]+\?(?:[^#]*&)?transport=tcp(?:&|$)/i.test(url));
        if (!hasUdpLane || !hasTlsLane) {
            throw edgeError('edge desired turn.urls must declare both external TURN/UDP and TURN/TLS lanes');
        }
        const credentialMode = String(input.credentialMode || '').trim();
        if (credentialMode !== 'turn-rest') throw edgeError("edge desired turn.credentialMode must be 'turn-rest'");
        turn = {
            urls,
            credentialMode,
            sharedSecret: normalizeSecretHandle(input.sharedSecret, 'edge desired turn.sharedSecret'),
            credentialConsumers: uniqueStrings(
                input.credentialConsumers,
                'edge desired turn.credentialConsumers',
                normalizeAgentReference,
            ),
        };
    }

    return {
        hosts,
        ...(cloudflare !== undefined ? { cloudflare } : {}),
        ...(media ? { media } : {}),
        ...(turn ? { turn } : {}),
    };
}

function validateRoutingShape(routing, manifests) {
    assertObject(routing, 'routing state');
    const routes = routing.routes === undefined ? {} : assertObject(routing.routes, 'routing.routes');
    for (const [routeKey, route] of Object.entries(routes)) {
        if (!routeKey || RESERVED_OBJECT_KEYS.has(routeKey)) throw edgeError(`routing route key '${routeKey}' is invalid`);
        assertObject(route, `routing route '${routeKey}'`);
        if (route.hostPort !== undefined) normalizeServicePort(route.hostPort, `routing.routes.${routeKey}.hostPort`);
        const manifest = manifests[routeKey];
        if (manifest) {
            assertObject(manifest, `manifest(${routeKey})`);
            if (Object.prototype.hasOwnProperty.call(manifest, 'httpServices')) {
                throw edgeError(`manifest(${routeKey}).httpServices is unsupported; use routerAccess.httpRoutes with agent-port convention paths`);
            }
        }
    }
}

function routeMatchesAgent(route, agentRef) {
    return `${String(route?.repo || '').trim()}/${String(route?.agent || '').trim()}` === agentRef;
}

function resolveAgentRoute(agentRef, routing) {
    const matches = Object.entries(routing.routes || {}).filter(([, route]) => (
        route && !route.disabled && routeMatchesAgent(route, agentRef)
    ));
    if (matches.length !== 1) {
        throw edgeError(`agent '${agentRef}' must resolve to exactly one enabled effective route`);
    }
    return { routeKey: matches[0][0], route: matches[0][1], agent: agentRef };
}

function resolveEnabledIdentity(routeSelection, agents) {
    const exactContainer = String(routeSelection.route?.container || '').trim();
    const records = Object.entries(agents || {}).filter(([containerName, record]) => {
        if (!isPlainObject(record) || record.type !== 'agent') return false;
        if (exactContainer && containerName === exactContainer) return true;
        return String(record.alias || '') === routeSelection.routeKey
            || (String(record.repoName || '') === String(routeSelection.route?.repo || '')
                && String(record.agentName || '') === String(routeSelection.route?.agent || ''));
    });
    const selected = exactContainer
        ? records.find(([containerName]) => containerName === exactContainer)
        : (records.length === 1 ? records[0] : null);
    if (!selected) throw edgeError(`agent '${routeSelection.agent}' has no unambiguous enabled instance identity`);
    const [containerName, record] = selected;
    const instanceId = String(record.instanceId || '').trim();
    const enableGeneration = String(record.enableGeneration || '').trim();
    if (!instanceId || !enableGeneration) {
        throw edgeError(`agent '${routeSelection.agent}' lacks current instanceId/enableGeneration`);
    }
    return {
        agentId: `agent:${routeSelection.agent}`,
        instanceId,
        enableGeneration,
        routeKey: routeSelection.routeKey,
        containerName,
    };
}

function publicationDisposition(desired) {
    const cloudflare = desired.cloudflare;
    const hostCount = Object.keys(desired.hosts).length;
    const existingRequired = ['accountId', 'zoneId', 'tunnelId', 'tunnelTokenSecret', 'apiTokenSecret'];
    const managedRequired = ['accountId', 'zoneId', 'tunnelName', 'apiTokenSecret'];
    const keys = cloudflare ? Object.keys(cloudflare) : [];
    const connectorOnly = Boolean(cloudflare)
        && keys.length === 1
        && keys[0] === 'tunnelTokenSecret'
        && hostCount > 0;
    const existingTunnel = Boolean(cloudflare)
        && keys.length === existingRequired.length
        && existingRequired.every((key) => Boolean(cloudflare[key]));
    const managedAllowed = new Set([...managedRequired, 'deleteTunnelOnTeardown']);
    const managedTunnel = Boolean(cloudflare)
        && keys.every((key) => managedAllowed.has(key))
        && managedRequired.every((key) => Boolean(cloudflare[key]));
    const apiManaged = existingTunnel || managedTunnel;
    const absent = cloudflare === undefined && hostCount === 0;
    if (absent) {
        return {
            mode: 'local-only',
            management: null,
            defaultState: 'ready',
            complete: true,
        };
    }
    if (connectorOnly || apiManaged) {
        return {
            mode: 'cloudflare',
            management: connectorOnly ? 'connector-only' : 'api-managed',
            defaultState: 'reconciling',
            complete: true,
        };
    }
    return {
        mode: 'error',
        management: null,
        defaultState: 'error',
        complete: false,
    };
}

function collectManifestHostNetworkCapabilities(routing, manifests, agents) {
    const capabilities = [];
    for (const [routeKey, route] of Object.entries(routing.routes || {})) {
        if (!route || route.disabled) continue;
        const manifest = manifests[routeKey];
        if (!manifest) continue;
        const agentRef = `${String(route.repo || '').trim()}/${String(route.agent || '').trim()}`;
        const identity = resolveEnabledIdentity({ routeKey, route, agent: agentRef }, agents);
        const record = agents?.[identity.containerName];
        const runtimeProfile = resolveManifestRuntimeProfile(manifest, {
            agentName: agentRef,
            persistedProfileName: record?.profile,
            fallbackProfileName: 'default',
            path: `manifest(${routeKey})`,
        });
        if (runtimeProfile.network.mode === 'host') capabilities.push(identity);
    }
    return capabilities;
}

function manifestEnableReference(entry) {
    const raw = entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry.agent ?? entry.ref ?? entry.spec ?? entry.name)
        : entry;
    const token = String(raw || '').trim().split(/\s+/).find((part) => (
        part && part.toLowerCase() !== 'no-wait'
    )) || '';
    if (!token) return '';
    const slashIndex = token.indexOf('/');
    const colonIndex = token.indexOf(':');
    if (slashIndex >= 0 && colonIndex > slashIndex) {
        return token.slice(0, colonIndex);
    }
    return token;
}

function routeAgentRecord(route, agents) {
    const direct = route?.container ? agents?.[route.container] : null;
    if (direct && direct.type === 'agent') return direct;
    const matches = Object.values(agents || {}).filter((record) => (
        record
        && record.type === 'agent'
        && record.repoName === route?.repo
        && record.agentName === route?.agent
    ));
    return matches.length === 1 ? matches[0] : null;
}

function manifestEnableEntriesForRoute(manifest, route, agents) {
    const entries = Array.isArray(manifest?.enable) ? [...manifest.enable] : [];
    const profile = String(routeAgentRecord(route, agents)?.profile || '').trim().toLowerCase();
    const profiles = manifest?.profiles && typeof manifest.profiles === 'object'
        ? manifest.profiles
        : {};
    const profileBlock = profiles[profile] || profiles.default;
    if (Array.isArray(profileBlock?.enable)) entries.push(...profileBlock.enable);
    return entries;
}

function resolveEnabledRouteKey(reference, routes, parentRoute) {
    const value = String(reference || '').trim();
    if (!value) return '';
    if (Object.hasOwn(routes, value) && routes[value] && !routes[value].disabled) return value;

    const separator = value.includes('/') ? '/' : (value.includes(':') ? ':' : '');
    let matches;
    if (separator) {
        const [repo, agent] = value.split(separator, 2);
        matches = Object.entries(routes).filter(([, route]) => (
            route
            && !route.disabled
            && route.repo === repo
            && route.agent === agent
        ));
    } else {
        matches = Object.entries(routes).filter(([, route]) => (
            route && !route.disabled && route.agent === value
        ));
        const sameRepo = matches.filter(([, route]) => route.repo === parentRoute?.repo);
        if (sameRepo.length === 1) matches = sameRepo;
    }
    return matches.length === 1 ? matches[0][0] : '';
}

function compileAgentMcpRouteClosure(rootRouteKey, routing, manifests, agents) {
    const routes = routing?.routes || {};
    const allowed = new Set();
    const pending = [rootRouteKey];
    while (pending.length) {
        const routeKey = pending.shift();
        if (allowed.has(routeKey)) continue;
        const route = routes[routeKey];
        if (!route || route.disabled) continue;
        allowed.add(routeKey);
        for (const entry of manifestEnableEntriesForRoute(manifests?.[routeKey], route, agents)) {
            const dependencyRouteKey = resolveEnabledRouteKey(
                manifestEnableReference(entry),
                routes,
                route,
            );
            if (dependencyRouteKey && !allowed.has(dependencyRouteKey)) {
                pending.push(dependencyRouteKey);
            }
        }
    }
    return [...allowed].sort();
}

function compileGeneration({ routing, policy, desired, agents, manifests }) {
    validatePolicy(policy);
    validateRoutingShape(routing, manifests);
    assertObject(agents, 'agents registry');
    const normalizedDesired = normalizeDesired(desired);
    const hostNetworkCapabilities = collectManifestHostNetworkCapabilities(routing, manifests, agents);
    const turnCredentialConsumers = (normalizedDesired.turn?.credentialConsumers || []).map((agentRef) => (
        resolveEnabledIdentity(resolveAgentRoute(agentRef, routing), agents)
    ));

    const routeDefaults = {};
    const policyNamespaces = [];
    for (const [routeKey, route] of Object.entries(routing.routes || {})) {
        if (!route || route.disabled) continue;
        routeDefaults[routeKey] = routeDefaultDecision(routing, agents, routeKey);
        policyNamespaces.push({
            id: `agent-root:${routeKey}`,
            kind: 'agent-root',
            routeKey,
            prefix: `/${encodeURIComponent(routeKey)}`,
        });
    }
    const manifestPolicyEntries = collectStrictManifestPolicyEntries(routing, manifests);
    const compiledPolicy = compileHttpRoutePolicy({
        entries: [
            ...policy.httpRoutes.map((entry) => ({ ...entry, source: String(entry.source || 'policy') })),
            ...manifestPolicyEntries,
        ],
        namespaces: policyNamespaces,
        routeDefaults,
    });
    const hosts = {};
    const surfaces = {};
    const agentMcpRoutes = {};
    for (const [hostname, entry] of Object.entries(normalizedDesired.hosts)) {
        const selectedRoute = resolveAgentRoute(entry.agent, routing);
        hosts[hostname] = {
            kind: 'agent-root',
            agent: entry.agent,
            routeKey: selectedRoute.routeKey,
        };
        surfaces[hostname] = [...(entry.routerSurfaces || [])];
        agentMcpRoutes[hostname] = surfaces[hostname].includes('agent-mcp')
            ? compileAgentMcpRouteClosure(
                selectedRoute.routeKey,
                routing,
                manifests,
                agents,
            )
            : [];
    }

    return {
        desired: normalizedDesired,
        compiled: {
            hosts,
            surfaces,
            agentMcpRoutes,
            policy: compiledPolicy,
            security: {
                hostNetworkCapabilities,
                turnCredentialConsumers,
            },
            publication: publicationDisposition(normalizedDesired),
        },
    };
}

function collectCapturedSources(paths) {
    const routingBytes = readExact(paths.routingFile, { label: 'routing.json' });
    const policyBytes = readExact(paths.policyFile, { label: 'policy-state.json' });
    const desiredBytes = readExact(paths.desiredFile, { label: 'edge desired state' });
    const agentsBytes = readExact(paths.agentsFile, { label: 'agents.json' });
    const routing = parseJsonBytes(routingBytes, 'routing.json');
    const policy = parseJsonBytes(policyBytes, 'policy-state.json');
    const desired = parseJsonBytes(desiredBytes, 'edge desired state');
    const agents = parseJsonBytes(agentsBytes, 'agents.json');
    const routerHostPort = selectedRouterHostPort();
    const routerHostPortBytes = Buffer.from(String(routerHostPort), 'utf8');
    const manifestBytes = {};
    const manifests = {};
    for (const [routeKey, route] of Object.entries(routing?.routes || {}).sort(([left], [right]) => left.localeCompare(right))) {
        const hostPath = String(route?.hostPath || '').trim();
        if (!hostPath) continue;
        const bytes = readExact(path.join(hostPath, 'manifest.json'), { label: `manifest(${routeKey})` });
        manifestBytes[routeKey] = bytes;
        manifests[routeKey] = parseJsonBytes(bytes, `manifest(${routeKey})`);
    }
    const semantic = compileGeneration({ routing, policy, desired, agents, manifests });
    const parts = [
        ['routing.json', routingBytes],
        ['policy-state.json', policyBytes],
        ['edge-desired.json', desiredBytes],
        ['agents.json', agentsBytes],
        ['router-host-port', routerHostPortBytes],
        ...Object.entries(manifestBytes).sort(([left], [right]) => left.localeCompare(right)).map(([routeKey, bytes]) => [`manifest:${routeKey}`, bytes]),
    ];
    return {
        generation: digestParts(parts),
        parts,
        routing,
        policy,
        desired: semantic.desired,
        agents,
        manifests,
        routerHostPort,
        compiled: semantic.compiled,
        bytes: { routingBytes, policyBytes, desiredBytes, agentsBytes, routerHostPortBytes, manifestBytes },
    };
}

function generationFile(paths, generation) {
    const hex = String(generation || '').replace(/^sha256:/, '');
    if (!/^[a-f0-9]{64}$/.test(hex)) throw edgeError('invalid edge generation id', 'EDGE_GENERATION_CORRUPT');
    return path.join(paths.generationsDir, `${hex}.json`);
}

function acquireApplyLock(paths, options = {}) {
    fs.mkdirSync(paths.edgeDir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const lockId = crypto.randomUUID();
        const record = {
            pid: process.pid,
            lockId,
            createdAt: new Date().toISOString(),
        };
        const tmp = writeDurableTemp(paths.applyLockFile, Buffer.from(JSON.stringify(record)), 0o600);
        let preserveCrashArtifact = false;
        let acquired = false;
        try {
            if (typeof options.testHooks?.afterApplyLockTempFsync === 'function') {
                try {
                    options.testHooks.afterApplyLockTempFsync({ paths, tmp, record: { ...record } });
                } catch (error) {
                    preserveCrashArtifact = true;
                    throw error;
                }
            }
            fs.linkSync(tmp, paths.applyLockFile);
            fsyncDirectory(paths.edgeDir);
            acquired = true;
            return () => {
                try {
                    const before = fs.lstatSync(paths.applyLockFile);
                    const current = JSON.parse(fs.readFileSync(paths.applyLockFile, 'utf8'));
                    const after = fs.lstatSync(paths.applyLockFile);
                    if (current?.lockId !== lockId || before.dev !== after.dev || before.ino !== after.ino) return;
                    fs.unlinkSync(paths.applyLockFile);
                    fsyncDirectory(paths.edgeDir);
                } catch (_) {}
            };
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            let stale = false;
            try {
                const before = fs.lstatSync(paths.applyLockFile);
                const document = JSON.parse(fs.readFileSync(paths.applyLockFile, 'utf8'));
                const pid = Number(document?.pid || 0);
                const existingLockId = String(document?.lockId || '');
                const createdAt = String(document?.createdAt || '');
                if (!Number.isSafeInteger(pid) || pid < 1
                    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(existingLockId)
                    || !createdAt || !Number.isFinite(Date.parse(createdAt))) {
                    throw new Error('invalid lock owner');
                }
                try {
                    process.kill(pid, 0);
                } catch (probeError) {
                    if (probeError?.code === 'ESRCH') stale = true;
                    else throw probeError;
                }
                if (stale) {
                    const after = fs.lstatSync(paths.applyLockFile);
                    if (before.dev !== after.dev || before.ino !== after.ino) stale = false;
                }
            } catch (_) {
                // An unreadable/invalid lock cannot be proven stale. Preserve it
                // and require operator inspection instead of racing another apply.
                stale = false;
            }
            if (stale && attempt === 0) {
                try {
                    fs.unlinkSync(paths.applyLockFile);
                    fsyncDirectory(paths.edgeDir);
                    continue;
                } catch (_) {}
            }
            throw edgeError('edge generation apply is already in progress', 'EDGE_GENERATION_BUSY');
        } finally {
            if (!preserveCrashArtifact) {
                try { removeDurableTemp(tmp); } catch (cleanupError) {
                    // An already-acquired lock remains authoritative even if a
                    // harmless unique temp artifact cannot be removed.
                    if (!acquired) throw cleanupError;
                }
            }
        }
    }
    throw edgeError('edge generation apply is already in progress', 'EDGE_GENERATION_BUSY');
}

function hasApplyLockCapability(paths, capability) {
    return Boolean(capability)
        && APPLY_LOCK_CAPABILITIES.get(capability) === paths.applyLockFile;
}

function acquireApplyLockCapability(paths, options = {}) {
    if (hasApplyLockCapability(paths, options.applyLockCapability)) {
        return {
            capability: options.applyLockCapability,
            release: () => {},
        };
    }
    const releaseLock = acquireApplyLock(paths, options);
    const capability = Object.freeze({});
    APPLY_LOCK_CAPABILITIES.set(capability, paths.applyLockFile);
    return {
        capability,
        release() {
            APPLY_LOCK_CAPABILITIES.delete(capability);
            releaseLock();
        },
    };
}

/**
 * Hold the edge apply lock across one complete candidate mutation and apply.
 * The opaque capability is process-local and path-bound; callers cannot turn
 * a boolean option into a lock bypass.
 */
export function withEdgeGenerationApplyLock(callback, options = {}) {
    if (typeof callback !== 'function') {
        throw edgeError('edge generation mutation requires a callback', 'EDGE_GENERATION_INVALID');
    }
    const paths = resolveEdgeGenerationPaths(options);
    const { capability, release } = acquireApplyLockCapability(paths, options);
    let result;
    try {
        assertPreparationLeaseForApply(paths, options.preparationLease);
        result = callback(capability);
    } catch (error) {
        release();
        throw error;
    }
    if (result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(() => {
            release();
        });
    }
    release();
    return result;
}

function readSelector(paths) {
    try {
        const selector = JSON.parse(fs.readFileSync(paths.activeSelectorFile, 'utf8'));
        if (!isPlainObject(selector) || selector.schemaVersion !== EDGE_GENERATION_SCHEMA_VERSION) return null;
        if (!['active', 'inactive'].includes(selector.state)) return null;
        const allowed = selector.state === 'active'
            ? new Set([
                'schemaVersion',
                'state',
                'generation',
                'publicationState',
                'activationId',
                'activatedAt',
                'selectorDigest',
            ])
            : new Set([
                'schemaVersion',
                'state',
                'generation',
                'previousGeneration',
                'reason',
                'activationId',
                'changedAt',
                'selectorDigest',
            ]);
        if (Object.keys(selector).some((key) => !allowed.has(key))) return null;
        if (selector.state === 'active' && !/^sha256:[a-f0-9]{64}$/.test(String(selector.generation || ''))) return null;
        if (selector.state === 'inactive'
            && ((selector.generation !== undefined
                && !/^sha256:[a-f0-9]{64}$/.test(String(selector.generation || '')))
                || (selector.previousGeneration
                    && !/^sha256:[a-f0-9]{64}$/.test(String(selector.previousGeneration))))) return null;
        const { selectorDigest, ...body } = selector;
        if (selectorDigest !== sourceDigest(Buffer.from(stableStringify(body)))) return null;
        return selector;
    } catch (_) {
        return null;
    }
}

function loadGenerationById(paths, generationId) {
    let document;
    try {
        document = JSON.parse(fs.readFileSync(generationFile(paths, generationId), 'utf8'));
    } catch (error) {
        throw edgeError(`previous edge routing generation is corrupt: ${error?.message || error}`, 'EDGE_GENERATION_CORRUPT');
    }
    return reconstructGeneration(document, {
        generation: generationId,
        publicationState: 'error',
    });
}

function selectedPreviousGeneration(paths, selector) {
    const generationId = selector?.state === 'active'
        ? selector.generation
        : selector?.previousGeneration;
    if (!generationId) return null;
    return loadGenerationById(paths, generationId);
}

function mediaAddressConfiguration(generation) {
    const media = generation?.desired?.media;
    return media
        ? Object.freeze({
            publicIPv4: media.publicIPv4,
            addressMode: media.addressMode,
        })
        : null;
}

function exactCapabilityOwner(generation, label) {
    const owners = generation?.compiled?.security?.hostNetworkCapabilities || [];
    if (owners.length !== 1) {
        throw edgeError(
            `${label} media configuration requires exactly one current host-network capability owner; found ${owners.length}`,
            'EDGE_MEDIA_OWNER_INVALID',
        );
    }
    return owners[0];
}

function sameCapabilityOwner(left, right) {
    return ['agentId', 'instanceId', 'enableGeneration', 'routeKey', 'containerName']
        .every((field) => left?.[field] === right?.[field]);
}

function mediaRestartOwner(previous, next) {
    if (!previous) return null;
    const before = mediaAddressConfiguration(previous);
    const after = mediaAddressConfiguration(next);
    if (stableStringify(before) === stableStringify(after)) return null;
    const owner = exactCapabilityOwner(next, 'selected');
    if (before) {
        const previousOwner = exactCapabilityOwner(previous, 'previous selected');
        if (!sameCapabilityOwner(previousOwner, owner)) {
            throw edgeError(
                'media address and host-network capability ownership cannot change in one coordinated apply',
                'EDGE_MEDIA_OWNER_INVALID',
            );
        }
    } else if (!(previous.compiled?.security?.hostNetworkCapabilities || [])
        .some((candidate) => sameCapabilityOwner(candidate, owner))) {
        // The first configuration for a newly selected capability owner is
        // consumed by its normal launch. There is no previously effective
        // owner to drain or restart.
        return null;
    }
    return owner;
}

function affectedSelectorIds(generation, owner) {
    const selectors = new Set([
        `runtime:${owner.containerName}`,
        `capability:${owner.agentId}:${owner.instanceId}:${owner.enableGeneration}`,
        `media:${owner.agentId}`,
        `agent-root:${owner.routeKey}`,
    ]);
    for (const [hostname, record] of Object.entries(generation.compiled.hosts || {})) {
        if (record?.routeKey === owner.routeKey) {
            selectors.add(`host:${hostname}`);
        }
    }
    return Object.freeze([...selectors].sort());
}

function selectorMatchesInactiveApply(paths, expected) {
    const current = readSelector(paths);
    return current?.state === 'inactive'
        && current.activationId === expected.activationId
        && current.previousGeneration === expected.previousGeneration
        && current.selectorDigest === expected.selectorDigest;
}

function selectInactiveCandidate(paths, expected, generationId, reason) {
    if (!selectorMatchesInactiveApply(paths, expected)) {
        throw edgeError('edge selector changed before inactive candidate selection', 'EDGE_GENERATION_RACE');
    }
    const selector = sealSelector({
        schemaVersion: EDGE_GENERATION_SCHEMA_VERSION,
        state: 'inactive',
        generation: generationId,
        previousGeneration: expected.previousGeneration || '',
        reason: String(reason || 'candidate-selected-inactive'),
        activationId: crypto.randomUUID(),
        changedAt: new Date().toISOString(),
    });
    atomicWrite(paths.activeSelectorFile, Buffer.from(JSON.stringify(selector, null, 2)), { mode: 0o600 });
    return deepFreeze(selector);
}

function createPreparedHostModeCapability(paths, selector, generation, owner) {
    const token = Object.freeze({});
    PREPARED_HOST_MODE_CAPABILITIES.set(token, Object.freeze({
        paths,
        selector,
        generation: generation.generation,
        owner: Object.freeze({ ...owner }),
    }));
    return token;
}

export function prepareHostModeCapabilityForInactiveGeneration(owner, options = {}) {
    const paths = resolveEdgeGenerationPaths(options);
    const selector = readSelector(paths);
    if (!selector || selector.state !== 'inactive' || !selector.generation) {
        throw edgeError('host network launch requires one selected inactive configuration generation', 'HOST_MODE_CAPABILITY_DENIED');
    }
    const generation = loadGenerationById(paths, selector.generation);
    const exact = (generation.compiled?.security?.hostNetworkCapabilities || []).find((entry) => (
        entry.agentId === String(owner?.agentId || '')
        && entry.instanceId === String(owner?.instanceId || '')
        && entry.enableGeneration === String(owner?.enableGeneration || '')
        && entry.routeKey === String(owner?.routeKey || '')
        && entry.containerName === String(owner?.containerName || '')
    ));
    if (!exact) {
        throw edgeError('inactive generation does not grant this exact host-network runtime owner', 'HOST_MODE_CAPABILITY_DENIED');
    }
    return createPreparedHostModeCapability(paths, selector, generation, exact);
}

function sealSelector(selector) {
    return {
        ...selector,
        selectorDigest: sourceDigest(Buffer.from(stableStringify(selector))),
    };
}

export function inactivateEdgeRoutingGeneration(reason = 'candidate-change', options = {}) {
    const paths = resolveEdgeGenerationPaths(options);
    const { release } = acquireApplyLockCapability(paths, options);
    try {
        const previous = readSelector(paths);
        const selector = sealSelector({
            schemaVersion: EDGE_GENERATION_SCHEMA_VERSION,
            state: 'inactive',
            ...(options.preserveSelectedGeneration === true
                && previous?.state === 'inactive'
                && previous.generation
                ? { generation: previous.generation }
                : {}),
            previousGeneration: previous?.state === 'active' ? previous.generation : previous?.previousGeneration || '',
            reason: String(reason || 'candidate-change'),
            activationId: crypto.randomUUID(),
            changedAt: new Date().toISOString(),
        });
        atomicWrite(paths.activeSelectorFile, Buffer.from(JSON.stringify(selector, null, 2)), { mode: 0o600 });
        return deepFreeze(selector);
    } finally {
        release();
    }
}

function sourceDigests(captured) {
    return {
        routing: sourceDigest(captured.bytes.routingBytes),
        policy: sourceDigest(captured.bytes.policyBytes),
        desired: sourceDigest(captured.bytes.desiredBytes),
        agents: sourceDigest(captured.bytes.agentsBytes),
        routerHostPort: sourceDigest(captured.bytes.routerHostPortBytes),
        manifests: Object.fromEntries(
            Object.entries(captured.bytes.manifestBytes).sort(([left], [right]) => left.localeCompare(right))
                .map(([key, bytes]) => [key, sourceDigest(bytes)]),
        ),
    };
}

function lifecycleRoutingProjection(routing) {
    const projected = structuredClone(routing);
    for (const route of Object.values(projected?.routes || {})) {
        if (!isPlainObject(route)) continue;
        delete route.hostPort;
    }
    return projected;
}

function lifecycleAgentProjection(agents) {
    return Object.fromEntries(Object.entries(agents || {})
        .filter(([, record]) => isPlainObject(record) && record.type === 'agent')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([containerName, record]) => [containerName, {
            type: 'agent',
            repoName: String(record.repoName || ''),
            agentName: String(record.agentName || ''),
            alias: String(record.alias || ''),
            instanceId: String(record.instanceId || ''),
            enableGeneration: String(record.enableGeneration || ''),
            authMode: String(record.auth?.mode || ''),
            profile: String(record.profile || ''),
            runMode: String(record.runMode || ''),
            projectPath: String(record.projectPath || ''),
            develRepo: String(record.develRepo || ''),
        }]));
}

function lifecycleBindingDigest(captured) {
    const digests = captured?.sourceDigests || sourceDigests(captured);
    return sourceDigest(Buffer.from(stableStringify({
        routing: lifecycleRoutingProjection(captured.routing),
        agents: lifecycleAgentProjection(captured.agents),
        policy: digests.policy,
        desired: digests.desired,
        routerHostPort: digests.routerHostPort,
        manifests: digests.manifests,
    })));
}

function lifecycleBindingChangeLabels(prepared, captured) {
    const labels = [];
    const preparedRouting = lifecycleRoutingProjection(prepared.routing);
    const capturedRouting = lifecycleRoutingProjection(captured.routing);
    if (stableStringify(preparedRouting) !== stableStringify(capturedRouting)) {
        labels.push('routing');
    }

    const preparedAgents = lifecycleAgentProjection(prepared.agents);
    const capturedAgents = lifecycleAgentProjection(captured.agents);
    const agentNames = new Set([
        ...Object.keys(preparedAgents),
        ...Object.keys(capturedAgents),
    ]);
    for (const containerName of Array.from(agentNames).sort()) {
        const before = preparedAgents[containerName];
        const after = capturedAgents[containerName];
        if (!before || !after) {
            labels.push(`agents[${containerName}]`);
            continue;
        }
        for (const field of Object.keys(before)) {
            if (before[field] !== after[field]) {
                labels.push(`agents[${containerName}].${field}`);
            }
        }
    }

    const capturedDigests = sourceDigests(captured);
    for (const source of ['policy', 'desired', 'routerHostPort']) {
        if (prepared.sourceDigests?.[source] !== capturedDigests[source]) {
            labels.push(source);
        }
    }
    const manifestKeys = new Set([
        ...Object.keys(prepared.sourceDigests?.manifests || {}),
        ...Object.keys(capturedDigests.manifests || {}),
    ]);
    for (const routeKey of Array.from(manifestKeys).sort()) {
        if (prepared.sourceDigests?.manifests?.[routeKey] !== capturedDigests.manifests?.[routeKey]) {
            labels.push(`manifests[${routeKey}]`);
        }
    }
    return labels;
}

function readPreparationLease(paths) {
    let before;
    try {
        before = fs.lstatSync(paths.preparationLeaseFile);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw edgeError(`edge preparation lease is unavailable: ${error?.message || error}`, 'EDGE_PREPARATION_CORRUPT');
    }
    if (!before.isFile() || before.isSymbolicLink() || before.size > 16 * 1024) {
        throw edgeError('edge preparation lease is not one exact bounded regular file', 'EDGE_PREPARATION_CORRUPT');
    }
    try {
        const lease = JSON.parse(fs.readFileSync(paths.preparationLeaseFile, 'utf8'));
        const after = fs.lstatSync(paths.preparationLeaseFile);
        const keys = Object.keys(lease || {}).sort();
        const expectedKeys = [
            'createdAt',
            'lifecycleBindingDigest',
            'pid',
            'preparedGeneration',
            'reason',
            'schemaVersion',
            'selectorActivationId',
            'selectorDigest',
            'transactionId',
        ].sort();
        if (before.dev !== after.dev || before.ino !== after.ino
            || !isPlainObject(lease)
            || stableStringify(keys) !== stableStringify(expectedKeys)
            || lease.schemaVersion !== EDGE_PREPARATION_LEASE_SCHEMA_VERSION
            || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(lease.transactionId || ''))
            || !/^sha256:[a-f0-9]{64}$/.test(String(lease.preparedGeneration || ''))
            || !/^sha256:[a-f0-9]{64}$/.test(String(lease.lifecycleBindingDigest || ''))
            || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(lease.selectorActivationId || ''))
            || !/^sha256:[a-f0-9]{64}$/.test(String(lease.selectorDigest || ''))
            || !Number.isSafeInteger(lease.pid) || lease.pid < 1
            || !String(lease.reason || '')
            || !Number.isFinite(Date.parse(String(lease.createdAt || '')))) {
            throw new Error('invalid preparation lease');
        }
        return deepFreeze({ ...lease });
    } catch (error) {
        if (error?.code === 'EDGE_PREPARATION_CORRUPT') throw error;
        throw edgeError('edge preparation lease is corrupt; explicit operator repair is required', 'EDGE_PREPARATION_CORRUPT');
    }
}

function normalizePreparationLease(value) {
    if (!isPlainObject(value)) return null;
    const transactionId = String(value.transactionId || '');
    const preparedGeneration = String(value.preparedGeneration || '');
    const binding = String(value.lifecycleBindingDigest || '');
    const selectorActivationId = String(value.selectorActivationId || '');
    const selectorDigest = String(value.selectorDigest || '');
    if (!transactionId || !preparedGeneration || !binding || !selectorActivationId || !selectorDigest) return null;
    return {
        transactionId,
        preparedGeneration,
        lifecycleBindingDigest: binding,
        selectorActivationId,
        selectorDigest,
    };
}

function createPreparationLease(paths, captured, reason) {
    if (readPreparationLease(paths)) {
        throw edgeError('another edge lifecycle preparation is already outstanding', 'EDGE_PREPARATION_BUSY');
    }
    const selector = readSelector(paths);
    if (selector?.state !== 'inactive'
        || selector.generation !== captured.generation
        || !selector.activationId
        || !selector.selectorDigest) {
        throw edgeError(
            'edge preparation requires the exact captured generation to remain selected and inactive',
            'EDGE_PREPARATION_RACE',
        );
    }
    const document = {
        schemaVersion: EDGE_PREPARATION_LEASE_SCHEMA_VERSION,
        transactionId: crypto.randomUUID(),
        preparedGeneration: captured.generation,
        lifecycleBindingDigest: lifecycleBindingDigest(captured),
        selectorActivationId: selector.activationId,
        selectorDigest: selector.selectorDigest,
        reason: String(reason || 'edge-generation-prepare-inactive'),
        pid: process.pid,
        createdAt: new Date().toISOString(),
    };
    installImmutableDurable(paths.preparationLeaseFile, Buffer.from(JSON.stringify(document, null, 2)), 0o600, {
        conflictMessage: 'another edge lifecycle preparation appeared concurrently',
        conflictCode: 'EDGE_PREPARATION_BUSY',
    });
    return deepFreeze({
        transactionId: document.transactionId,
        preparedGeneration: document.preparedGeneration,
        lifecycleBindingDigest: document.lifecycleBindingDigest,
        selectorActivationId: document.selectorActivationId,
        selectorDigest: document.selectorDigest,
    });
}

function assertPreparationLeaseForApply(paths, provided, { preparing = false } = {}) {
    const current = readPreparationLease(paths);
    if (preparing) {
        if (current) throw edgeError('another edge lifecycle preparation is already outstanding', 'EDGE_PREPARATION_BUSY');
        return null;
    }
    const normalized = normalizePreparationLease(provided);
    if (!current && !normalized) return null;
    if (!current) {
        throw edgeError('edge lifecycle preparation lease is stale or already committed', 'EDGE_PREPARATION_STALE');
    }
    if (!normalized
        || current.transactionId !== normalized.transactionId
        || current.preparedGeneration !== normalized.preparedGeneration
        || current.lifecycleBindingDigest !== normalized.lifecycleBindingDigest
        || current.selectorActivationId !== normalized.selectorActivationId
        || current.selectorDigest !== normalized.selectorDigest) {
        throw edgeError('edge lifecycle preparation is outstanding; unrelated apply is denied', 'EDGE_PREPARATION_BUSY');
    }
    return current;
}

function assertPreparedSelectorStillSelected(paths, lease) {
    if (!lease) return;
    const selector = readSelector(paths);
    if (selector?.state !== 'inactive'
        || selector.generation !== lease.preparedGeneration
        || selector.activationId !== lease.selectorActivationId
        || selector.selectorDigest !== lease.selectorDigest) {
        throw edgeError(
            'edge lifecycle preparation no longer owns the exact inactive selector; restart preparation',
            'EDGE_PREPARATION_STALE',
        );
    }
}

function removePreparationLease(paths, expected) {
    const current = readPreparationLease(paths);
    if (!current || current.transactionId !== expected?.transactionId) {
        throw edgeError('edge lifecycle preparation lease changed before commit', 'EDGE_PREPARATION_RACE');
    }
    fs.unlinkSync(paths.preparationLeaseFile);
    fsyncDirectory(paths.edgeDir);
}

function buildGenerationDocument(captured) {
    return {
        schemaVersion: EDGE_GENERATION_SCHEMA_VERSION,
        generation: captured.generation,
        sourceDigests: sourceDigests(captured),
        sources: {
            routing: captured.bytes.routingBytes.toString('base64'),
            policy: captured.bytes.policyBytes.toString('base64'),
            desired: captured.bytes.desiredBytes.toString('base64'),
            agents: captured.bytes.agentsBytes.toString('base64'),
            routerHostPort: captured.bytes.routerHostPortBytes.toString('base64'),
            manifests: Object.fromEntries(
                Object.entries(captured.bytes.manifestBytes).sort(([left], [right]) => left.localeCompare(right))
                    .map(([key, bytes]) => [key, bytes.toString('base64')]),
            ),
        },
        compiledDigest: compiledDigest(captured.compiled),
        compiled: captured.compiled,
    };
}

function decodeGenerationSources(document) {
    assertObject(document, 'generation document');
    assertOnlyKeys(document, new Set([
        'schemaVersion',
        'generation',
        'sourceDigests',
        'sources',
        'compiledDigest',
        'compiled',
    ]), 'generation document');
    const sources = assertObject(document.sources, 'generation sources');
    assertOnlyKeys(sources, new Set([
        'routing',
        'policy',
        'desired',
        'agents',
        'routerHostPort',
        'manifests',
    ]), 'generation sources');
    const manifestSources = assertObject(sources.manifests, 'generation manifest sources');
    const manifestBytes = Object.fromEntries(Object.entries(manifestSources).sort(([left], [right]) => left.localeCompare(right)).map(([routeKey, value]) => {
        if (!routeKey || RESERVED_OBJECT_KEYS.has(routeKey)) throw edgeError('generation manifest source key is invalid', 'EDGE_GENERATION_CORRUPT');
        return [routeKey, decodeCanonicalBase64(value, `generation manifest source '${routeKey}'`)];
    }));
    return {
        routingBytes: decodeCanonicalBase64(sources.routing, 'generation routing source'),
        policyBytes: decodeCanonicalBase64(sources.policy, 'generation policy source'),
        desiredBytes: decodeCanonicalBase64(sources.desired, 'generation desired source'),
        agentsBytes: decodeCanonicalBase64(sources.agents, 'generation agents source'),
        routerHostPortBytes: decodeCanonicalBase64(sources.routerHostPort, 'generation Router host-port source'),
        manifestBytes,
    };
}

function reconstructGeneration(document, selector) {
    if (document.schemaVersion !== EDGE_GENERATION_SCHEMA_VERSION || document.generation !== selector.generation) {
        throw edgeError('active edge routing generation schema or identity is invalid', 'EDGE_GENERATION_CORRUPT');
    }
    const bytes = decodeGenerationSources(document);
    const routing = parseJsonBytes(bytes.routingBytes, 'captured routing.json');
    const policy = parseJsonBytes(bytes.policyBytes, 'captured policy-state.json');
    const desiredInput = parseJsonBytes(bytes.desiredBytes, 'captured edge desired state');
    const agents = parseJsonBytes(bytes.agentsBytes, 'captured agents.json');
    let routerHostPort;
    try {
        routerHostPort = parseRouterHostPort(bytes.routerHostPortBytes.toString('utf8'), {
            source: 'captured Router host port',
        });
    } catch (error) {
        throw edgeError(`captured Router host port is invalid: ${error?.message || error}`, 'EDGE_GENERATION_CORRUPT');
    }
    const manifests = Object.fromEntries(Object.entries(bytes.manifestBytes).map(([routeKey, value]) => (
        [routeKey, parseJsonBytes(value, `captured manifest(${routeKey})`)]
    )));
    const expectedManifestKeys = Object.entries(routing?.routes || {})
        .filter(([, route]) => Boolean(String(route?.hostPath || '').trim()))
        .map(([routeKey]) => routeKey)
        .sort();
    if (stableStringify(expectedManifestKeys) !== stableStringify(Object.keys(manifests).sort())) {
        throw edgeError('active edge routing generation manifest source set is invalid', 'EDGE_GENERATION_CORRUPT');
    }
    let semantic;
    try {
        semantic = compileGeneration({
            routing,
            policy,
            desired: desiredInput,
            agents,
            manifests,
            routerHostPort,
        });
    } catch (error) {
        throw edgeError(`active edge routing generation semantics are invalid: ${error?.message || error}`, 'EDGE_GENERATION_CORRUPT');
    }
    const parts = [
        ['routing.json', bytes.routingBytes],
        ['policy-state.json', bytes.policyBytes],
        ['edge-desired.json', bytes.desiredBytes],
        ['agents.json', bytes.agentsBytes],
        ['router-host-port', bytes.routerHostPortBytes],
        ...Object.entries(bytes.manifestBytes).sort(([left], [right]) => left.localeCompare(right)).map(([routeKey, value]) => [`manifest:${routeKey}`, value]),
    ];
    if (digestParts(parts) !== selector.generation) {
        throw edgeError('active edge routing generation digest verification failed', 'EDGE_GENERATION_CORRUPT');
    }
    const expectedDigests = sourceDigests({ bytes });
    if (stableStringify(document.sourceDigests) !== stableStringify(expectedDigests)
        || document.compiledDigest !== compiledDigest(semantic.compiled)
        || stableStringify(document.compiled) !== stableStringify(semantic.compiled)) {
        throw edgeError('active edge routing generation semantic verification failed', 'EDGE_GENERATION_CORRUPT');
    }
    return {
        schemaVersion: EDGE_GENERATION_SCHEMA_VERSION,
        generation: selector.generation,
        publicationState: selector.publicationState,
        sourceDigests: expectedDigests,
        routing,
        policy,
        desired: semantic.desired,
        agents,
        manifests,
        routerHostPort,
        compiled: semantic.compiled,
    };
}

function selectPublicationState(compiled, requested) {
    const desired = compiled.publication;
    const state = requested === undefined ? desired.defaultState : String(requested || '').trim();
    if (!TOPOLOGY_STATES.has(state)) throw edgeError(`unsupported edge publication state '${state}'`);
    if (desired.mode === 'local-only' && state !== 'ready' && state !== 'error') {
        throw edgeError(`publication state '${state}' is impossible in local-only mode`);
    }
    if (desired.mode === 'cloudflare' && !['reconciling', 'ready', 'error'].includes(state)) {
        throw edgeError(`publication state '${state}' is impossible in Cloudflare mode`);
    }
    if (desired.mode === 'error' && state !== 'error') {
        throw edgeError('incomplete Cloudflare desired state must remain in error');
    }
    return state;
}

function topologyMedia(desired) {
    if (!desired.media && !desired.turn) return undefined;
    const media = {};
    if (desired.media) {
        media.publicIPv4 = desired.media.publicIPv4;
        media.addressMode = desired.media.addressMode;
        media.udpPort = 7882;
    }
    if (desired.turn) {
        media.turn = {
            urls: [...desired.turn.urls],
            credentialMode: desired.turn.credentialMode,
            credentialPath: '/api/edge/turn-credentials',
        };
    }
    return media;
}

function topologyConfigurationGeneration(generation) {
    // Hash only the stable, non-secret configuration consumers can observe.
    // Runtime targets, active locators, policy state, and publication readiness
    // are intentionally represented by the separate authorization/publication
    // generations below.
    const media = topologyMedia(generation.desired);
    const configuration = {
        ...(media ? { media } : {}),
    };
    return sourceDigest(Buffer.from(stableStringify(configuration)));
}

function writeTopologyForGeneration(paths, generation, publicationState, options = {}) {
    let previousPublication = 0;
    try {
        previousPublication = Number(JSON.parse(fs.readFileSync(paths.topologyCurrentFile, 'utf8')).publicationGeneration || 0);
    } catch (_) {}
    const media = topologyMedia(generation.desired);
    const topology = {
        configurationGeneration: topologyConfigurationGeneration(generation),
        // Router uses this private snapshot binding and never returns it from
        // the authenticated browser locator projection.
        authorizationGeneration: generation.generation,
        publicationGeneration: previousPublication + 1,
        state: publicationState,
        ...(media ? { media } : {}),
    };
    fs.mkdirSync(paths.topologyGenerationsDir, { recursive: true });
    const topologyName = `${generation.generation.replace(/^sha256:/, '')}-${topology.publicationGeneration}.json`;
    const immutable = path.join(paths.topologyGenerationsDir, topologyName);
    const output = Buffer.from(JSON.stringify(topology, null, 2));
    installImmutableDurable(immutable, output, 0o644, {
        conflictMessage: 'immutable edge topology file already exists with different bytes',
        conflictCode: 'EDGE_TOPOLOGY_INVALID',
        afterTempFsync: typeof options.testHooks?.afterTopologyTempFsync === 'function'
            ? ({ file, tmp }) => options.testHooks.afterTopologyTempFsync({
                paths,
                generation,
                topology,
                file,
                tmp,
            })
            : null,
    });
    atomicWrite(paths.topologyCurrentFile, output, { mode: 0o644 });
    return deepFreeze(topology);
}

export function applyEdgeRoutingGeneration(options = {}) {
    const paths = resolveEdgeGenerationPaths(options);
    const { capability: applyLockCapability, release } = acquireApplyLockCapability(paths, options);
    let transactionStarted = false;
    try {
        const expectedGeneration = options.expectedGeneration === undefined
            ? null
            : String(options.expectedGeneration || '');
        if (expectedGeneration !== null) {
            if (!/^sha256:[a-f0-9]{64}$/.test(expectedGeneration)) {
                throw edgeError('expected edge generation is invalid', 'EDGE_GENERATION_INVALID');
            }
            const beforeInactivation = collectCapturedSources(paths);
            if (beforeInactivation.generation !== expectedGeneration) {
                throw edgeError(
                    'edge routing sources no longer match the exact generation being committed',
                    'EDGE_GENERATION_RACE',
                );
            }
        }
        const preparationLease = assertPreparationLeaseForApply(paths, options.preparationLease, {
            preparing: options.createPreparationLease === true,
        });
        assertPreparedSelectorStillSelected(paths, preparationLease);
        const previous = selectedPreviousGeneration(paths, readSelector(paths));
        transactionStarted = true;
        let inactiveSelector = inactivateEdgeRoutingGeneration(options.reason || 'coordinated-apply', {
            ...options,
            applyLockCapability,
        });
        if (options.desiredCandidateFile !== undefined) {
            const candidateBytes = readDesiredCandidateFile(options.desiredCandidateFile);
            atomicWrite(paths.desiredFile, candidateBytes, { mode: 0o600 });
        }
        const captured = collectCapturedSources(paths);
        if (expectedGeneration !== null && captured.generation !== expectedGeneration) {
            throw edgeError(
                'edge routing sources changed before exact generation commit',
                'EDGE_GENERATION_RACE',
            );
        }
        const persisted = buildGenerationDocument(captured);
        const file = generationFile(paths, captured.generation);
        fs.mkdirSync(paths.generationsDir, { recursive: true });
        const output = Buffer.from(JSON.stringify(persisted, null, 2));
        installImmutableDurable(file, output, 0o600, {
            conflictMessage: 'immutable edge generation file already exists with different bytes',
            conflictCode: 'EDGE_GENERATION_CORRUPT',
            afterTempFsync: typeof options.testHooks?.afterGenerationTempFsync === 'function'
                ? ({ file: immutableFile, tmp }) => options.testHooks.afterGenerationTempFsync({
                    paths,
                    captured,
                    file: immutableFile,
                    tmp,
                })
                : null,
        });
        const recaptured = collectCapturedSources(paths);
        if (recaptured.generation !== captured.generation) {
            throw edgeError('edge routing sources changed during coordinated apply', 'EDGE_GENERATION_RACE');
        }
        const publicationState = selectPublicationState(captured.compiled, options.publicationState);
        const selector = sealSelector({
            schemaVersion: EDGE_GENERATION_SCHEMA_VERSION,
            state: 'active',
            generation: captured.generation,
            publicationState,
            activationId: crypto.randomUUID(),
            activatedAt: new Date().toISOString(),
        });
        const generation = deepFreeze({
            schemaVersion: EDGE_GENERATION_SCHEMA_VERSION,
            generation: captured.generation,
            publicationState,
            sourceDigests: sourceDigests(captured),
            routing: captured.routing,
            policy: captured.policy,
            desired: captured.desired,
            agents: captured.agents,
            manifests: captured.manifests,
            routerHostPort: captured.routerHostPort,
            compiled: captured.compiled,
        });
        // A validated immutable candidate remains the selected generation even
        // while authorization is inactive. Keep the last active generation
        // separately so a failed non-reloadable restart is required again on
        // repair rather than being mistaken for an already-applied config.
        inactiveSelector = selectInactiveCandidate(
            paths,
            inactiveSelector,
            captured.generation,
            options.reason || 'coordinated-apply',
        );
        if (options.activate === false) {
            const topology = writeTopologyForGeneration(paths, generation, 'error', options);
            const createdPreparationLease = options.createPreparationLease === true
                ? createPreparationLease(paths, captured, options.reason)
                : null;
            return {
                selector: inactiveSelector,
                generation,
                topology,
                paths,
                ...(createdPreparationLease ? { preparationLease: createdPreparationLease } : {}),
            };
        }
        if (preparationLease
            && preparationLease.lifecycleBindingDigest !== lifecycleBindingDigest(captured)) {
            let changed = [];
            try {
                changed = lifecycleBindingChangeLabels(
                    loadGenerationById(paths, preparationLease.preparedGeneration),
                    captured,
                );
            } catch (_) {}
            const detail = changed.length
                ? ` (changed: ${changed.slice(0, 12).join(', ')}${changed.length > 12 ? ', …' : ''})`
                : '';
            throw edgeError(
                `edge lifecycle sources or captured manifests changed after preparation${detail}; restart from a fresh inactive generation`,
                'EDGE_PREPARATION_SOURCE_CHANGED',
            );
        }
        let restartOwner = mediaRestartOwner(previous, generation);
        if (restartOwner && typeof options.isCapabilityRuntimeEffective === 'function') {
            const effective = options.isCapabilityRuntimeEffective(Object.freeze({
                generation: previous,
                owner: Object.freeze({ ...restartOwner }),
            }));
            if (effective !== true) restartOwner = null;
        }
        if (restartOwner) {
            if (typeof options.restartCapabilityRuntime !== 'function') {
                throw edgeError(
                    'media address configuration changed but no coordinated capability-runtime restart owner is installed',
                    'EDGE_TARGETED_RESTART_REQUIRED',
                );
            }
            // Publish the selected configuration as unavailable before asking
            // its exact runtime owner to drain. No active locator from the old
            // generation survives a failed drain or restart.
            writeTopologyForGeneration(paths, generation, 'error', options);
            const affectedSelectors = affectedSelectorIds(generation, restartOwner);
            const preparedHostModeCapability = createPreparedHostModeCapability(
                paths,
                inactiveSelector,
                generation,
                restartOwner,
            );
            const assertSelectorsInactive = (payload) => (
                payload?.containerName === restartOwner.containerName
                && stableStringify(payload?.affectedSelectors) === stableStringify(affectedSelectors)
                && selectorMatchesInactiveApply(paths, inactiveSelector)
            );
            try {
                options.restartCapabilityRuntime(Object.freeze({
                    generation,
                    owner: Object.freeze({ ...restartOwner }),
                    affectedSelectors,
                    assertSelectorsInactive,
                    preparedHostModeCapability,
                }));
            } finally {
                PREPARED_HOST_MODE_CAPABILITIES.delete(preparedHostModeCapability);
            }
            const afterRestart = collectCapturedSources(paths);
            if (afterRestart.generation !== captured.generation) {
                throw edgeError('edge routing sources changed during coordinated targeted restart', 'EDGE_GENERATION_RACE');
            }
            if (!selectorMatchesInactiveApply(paths, inactiveSelector)) {
                throw edgeError('edge selector changed during coordinated targeted restart', 'EDGE_GENERATION_RACE');
            }
        }
        const topology = writeTopologyForGeneration(paths, generation, publicationState, options);
        if (typeof options.testHooks?.beforeSelectorCommit === 'function') {
            options.testHooks.beforeSelectorCommit({ paths, generation, topology, selector });
        }
        // The selector is the transaction's sole authorization commit point and
        // must be written last. A crash at any earlier phase therefore leaves the
        // already-installed inactive selector authoritative on restart.
        if (!selectorMatchesInactiveApply(paths, inactiveSelector)) {
            throw edgeError('edge selector changed before authorization commit', 'EDGE_GENERATION_RACE');
        }
        if (preparationLease) removePreparationLease(paths, preparationLease);
        atomicWrite(paths.activeSelectorFile, Buffer.from(JSON.stringify(selector, null, 2)), { mode: 0o600 });
        return { selector: deepFreeze(selector), generation, topology, paths };
    } catch (error) {
        if (transactionStarted) {
            inactivateEdgeRoutingGeneration(error?.code || 'apply-failed', {
                ...options,
                applyLockCapability,
                preserveSelectedGeneration: true,
            });
        }
        throw error;
    } finally {
        release();
    }
}

/**
 * Validate and durably install one exact candidate without authorizing it.
 * Runtime replacement/startup uses this phase before physical mutation; a
 * later coordinated apply is the only operation that can commit an active
 * selector after target and readiness checks have succeeded.
 */
export function prepareEdgeRoutingGeneration(options = {}) {
    return applyEdgeRoutingGeneration({
        ...options,
        activate: false,
        createPreparationLease: true,
        publicationState: 'error',
        reason: options.reason || 'edge-generation-prepare-inactive',
    });
}

export function abortEdgeRoutingPreparation(preparationLease, options = {}) {
    const paths = resolveEdgeGenerationPaths(options);
    const { capability: applyLockCapability, release } = acquireApplyLockCapability(paths, options);
    try {
        const current = assertPreparationLeaseForApply(paths, preparationLease);
        if (!current) throw edgeError('no edge lifecycle preparation is outstanding', 'EDGE_PREPARATION_STALE');
        const selector = inactivateEdgeRoutingGeneration(
            options.reason || 'edge-lifecycle-preparation-aborted',
            { ...options, applyLockCapability, preserveSelectedGeneration: true },
        );
        removePreparationLease(paths, current);
        return { selector, paths };
    } finally {
        release();
    }
}

export function applyEdgeDesiredStateFile(candidateFile, options = {}) {
    return applyEdgeRoutingGeneration({
        ...options,
        reason: options.reason || 'operator-edge-desired-apply',
        desiredCandidateFile: candidateFile,
    });
}

export function loadActiveEdgeRoutingGeneration(options = {}) {
    const paths = resolveEdgeGenerationPaths(options);
    const selector = readSelector(paths);
    if (!selector || selector.state !== 'active' || !selector.generation || !selector.activationId
        || !TOPOLOGY_STATES.has(selector.publicationState)) {
        throw edgeError('edge routing generation is inactive', 'EDGE_GENERATION_INACTIVE');
    }
    let document;
    try {
        document = JSON.parse(fs.readFileSync(generationFile(paths, selector.generation), 'utf8'));
    } catch (error) {
        throw edgeError(`active edge routing generation is corrupt: ${error?.message || error}`, 'EDGE_GENERATION_CORRUPT');
    }
    let generation;
    try {
        generation = reconstructGeneration(document, selector);
    } catch (error) {
        if (error?.code === 'EDGE_GENERATION_CORRUPT') throw error;
        throw edgeError(`active edge routing generation is corrupt: ${error?.message || error}`, 'EDGE_GENERATION_CORRUPT');
    }
    if (generation.routerHostPort !== selectedRouterHostPort()) {
        throw edgeError(
            'active edge routing generation was compiled for a different physical Router host port; coordinated apply is required',
            'EDGE_GENERATION_RUNTIME_MISMATCH',
        );
    }
    return deepFreeze({ selector, generation, paths });
}

/**
 * Prove that the mutable lifecycle inputs still contain the exact bytes used
 * by the active generation. Callers use this under the edge apply lock before
 * beginning a fail-closed mutation after asynchronous runtime work.
 */
export function assertActiveEdgeRoutingSourcesCurrent(options = {}) {
    const active = loadActiveEdgeRoutingGeneration(options);
    const captured = collectCapturedSources(active.paths);
    if (captured.generation !== active.selector.generation) {
        throw edgeError(
            'edge routing sources changed since the active generation was selected',
            'EDGE_GENERATION_SOURCE_CHANGED',
        );
    }
    return active;
}

/**
 * Validate the post-runtime route/registry candidate against the lifecycle
 * inputs used to launch the runtime, while allowing only the route locator and
 * runtime-only registry metadata excluded by lifecycleBindingDigest().
 * Returning the exact candidate digest lets the subsequent coordinated apply
 * reject any source race before it can publish a different generation.
 */
export function captureEdgeRoutingLifecycleMutationGeneration(active, options = {}) {
    const expected = active?.generation || active;
    if (!expected?.generation || !expected?.sourceDigests) {
        throw edgeError(
            'edge lifecycle mutation requires one validated active generation',
            'EDGE_GENERATION_INVALID',
        );
    }
    const paths = active?.paths || resolveEdgeGenerationPaths(options);
    const captured = collectCapturedSources(paths);
    if (lifecycleBindingDigest(captured) !== lifecycleBindingDigest(expected)) {
        throw edgeError(
            'edge lifecycle sources changed during runtime route activation',
            'EDGE_GENERATION_SOURCE_CHANGED',
        );
    }
    return captured.generation;
}

/**
 * Return the validated selector even while authorization is inactive. This is
 * intentionally narrower than loading a generation: coordinators use it only
 * to prove that a retry still refers to the exact selected candidate (or, for
 * an inactivated active generation, its exact predecessor).
 */
export function readEdgeRoutingSelection(options = {}) {
    const paths = resolveEdgeGenerationPaths(options);
    const selector = readSelector(paths);
    if (!selector) {
        throw edgeError('edge routing selector is missing or corrupt', 'EDGE_GENERATION_CORRUPT');
    }
    return deepFreeze({ selector, paths });
}

export function captureEdgeRoutingLease(options = {}) {
    const active = loadActiveEdgeRoutingGeneration(options);
    const generationId = active.selector.generation;
    const activationId = active.selector.activationId;
    return Object.freeze({
        id: generationId,
        activationId,
        snapshot: active.generation,
        commit() {
            try {
                const current = loadActiveEdgeRoutingGeneration(options);
                return current.selector.generation === generationId && current.selector.activationId === activationId;
            } catch (_) {
                return false;
            }
        },
        isCurrent() {
            try {
                const current = loadActiveEdgeRoutingGeneration(options);
                return current.selector.generation === generationId && current.selector.activationId === activationId;
            } catch (_) {
                return false;
            }
        },
    });
}

export function readCurrentEdgeTopology(options = {}) {
    const paths = resolveEdgeGenerationPaths(options);
    let document;
    try {
        document = JSON.parse(fs.readFileSync(paths.topologyCurrentFile, 'utf8'));
    } catch (error) {
        throw edgeError(`edge topology is unavailable: ${error?.message || error}`, 'EDGE_TOPOLOGY_INVALID');
    }
    if (!isPlainObject(document)
        || !TOPOLOGY_STATES.has(document.state)
        || !Number.isSafeInteger(document.publicationGeneration) || document.publicationGeneration < 1
        || !/^sha256:[a-f0-9]{64}$/.test(String(document.configurationGeneration || ''))
        || !/^sha256:[a-f0-9]{64}$/.test(String(document.authorizationGeneration || ''))) {
        throw edgeError('edge topology has an unsupported or invalid schema', 'EDGE_TOPOLOGY_INVALID');
    }
    return deepFreeze(document);
}

export function edgeRuntimeEnvironment(networkMode, options = {}) {
    const mode = String(networkMode || '').trim().toLowerCase();
    if (mode === 'none') return {};
    const paths = resolveEdgeGenerationPaths(options);
    const host = mode === 'host' ? '127.0.0.1' : 'host.containers.internal';
    return {
        PLOINKY_EDGE_TOPOLOGY_FILE: mode === 'host' ? paths.topologyCurrentFile : EDGE_TOPOLOGY_CONTAINER_FILE,
        PLOINKY_ROUTER_URL: `http://${host}:8080`,
        PLOINKY_ROUTER_AUTHORITY: `127.0.0.1:${selectedRouterHostPort()}`,
        PLOINKY_INTERNAL_ROUTER_URL: `http://${host}:8081`,
    };
}

export function edgeTopologyMount(options = {}) {
    const paths = resolveEdgeGenerationPaths(options);
    return { source: paths.topologyDir, target: EDGE_TOPOLOGY_CONTAINER_DIR, readOnly: true };
}

export function assertHostModeGenerationCapability({
    agentId,
    instanceId,
    enableGeneration,
    routeKey,
    containerName,
}, options = {}) {
    const requestedOwner = Object.freeze({
        agentId: String(agentId || ''),
        instanceId: String(instanceId || ''),
        enableGeneration: String(enableGeneration || ''),
        routeKey: String(routeKey || ''),
        containerName: String(containerName || ''),
    });
    if (Object.values(requestedOwner).some((value) => !value)) {
        throw edgeError('host network mode requires a complete exact runtime owner', 'HOST_MODE_CAPABILITY_DENIED');
    }
    if (options.preparedCapability !== undefined) {
        const prepared = PREPARED_HOST_MODE_CAPABILITIES.get(options.preparedCapability);
        const matches = prepared
            && prepared.owner.agentId === requestedOwner.agentId
            && prepared.owner.instanceId === requestedOwner.instanceId
            && prepared.owner.enableGeneration === requestedOwner.enableGeneration
            && prepared.owner.routeKey === requestedOwner.routeKey
            && prepared.owner.containerName === requestedOwner.containerName
            && selectorMatchesInactiveApply(prepared.paths, prepared.selector);
        if (!matches) {
            throw edgeError('host network mode requires an exact prepared-generation capability', 'HOST_MODE_CAPABILITY_DENIED');
        }
        return prepared.generation;
    }
    const active = loadActiveEdgeRoutingGeneration(options);
    const matches = active.generation.compiled.security.hostNetworkCapabilities.some((entry) => (
        entry.agentId === requestedOwner.agentId
        && entry.instanceId === requestedOwner.instanceId
        && entry.enableGeneration === requestedOwner.enableGeneration
        && entry.routeKey === requestedOwner.routeKey
        && entry.containerName === requestedOwner.containerName
    ));
    if (!matches) throw edgeError('host network mode requires an exact active-generation capability', 'HOST_MODE_CAPABILITY_DENIED');
    return active.selector.generation;
}

export function currentEnabledAgentIdentity(snapshot, agentId) {
    const wanted = String(agentId || '').trim();
    for (const [containerName, record] of Object.entries(snapshot?.agents || {})) {
        if (!record || record.type !== 'agent') continue;
        const principal = `agent:${String(record.repoName || '').trim()}/${String(record.agentName || '').trim()}`;
        if (principal !== wanted) continue;
        return {
            agentId: principal,
            instanceId: String(record.instanceId || containerName),
            enableGeneration: String(record.enableGeneration || ''),
            routeKey: String(record.alias || record.agentName || ''),
        };
    }
    return null;
}

export function defaultEdgeDesiredStateBytes() {
    return Buffer.from(EMPTY_DESIRED_BYTES);
}

export default {
    abortEdgeRoutingPreparation,
    applyEdgeRoutingGeneration,
    captureEdgeRoutingLease,
    edgeRuntimeEnvironment,
    edgeTopologyMount,
    inactivateEdgeRoutingGeneration,
    initializeFreshEdgeRoutingSources,
    assertActiveEdgeRoutingSourcesCurrent,
    captureEdgeRoutingLifecycleMutationGeneration,
    loadActiveEdgeRoutingGeneration,
    readEdgeRoutingSelection,
    prepareEdgeRoutingGeneration,
    prepareHostModeCapabilityForInactiveGeneration,
    readCurrentEdgeTopology,
    resolveEdgeGenerationPaths,
    withEdgeGenerationApplyLock,
};
