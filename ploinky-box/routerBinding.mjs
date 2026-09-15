// Public Router publication selected by `ploinky bind`.
//
// A binding is BIND_ADDRESS:HOST_TCP_PORT:8080. The address is where the
// physical host listens: loopback (the default), the IPv4 wildcard, or one
// IPv4 address assigned to this host. It is never a client allowlist. The
// in-Box target is always the public Router listener on 8080.
//
// The saved preference is authoritative host state. Nested agents receive the
// writable workspace bind, and the Box user namespace maps their writes to the
// host user, so ownership checks cannot distinguish an agent-written
// `.ploinky` file. The record therefore lives in the host-only `~/.ploinky-box`
// state root, which is never mounted into the Box.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BOX_ROUTER_CONTAINER_PORT } from './constants.mjs';
import { PloinkyBoxError } from './errors.mjs';
import { isContainerInterface, isUsableHostIpv4 } from './hostNetwork.mjs';
import {
    PUBLIC_ROUTER_HOSTS_MAX_ENTRIES,
    normalizePublicRouterHost,
    parsePublicRouterHosts,
    serializePublicRouterHosts,
} from '../cli/utils/publicRouterHosts.mjs';

export const ROUTER_BIND_LOOPBACK = '127.0.0.1';
export const ROUTER_BIND_WILDCARD = '0.0.0.0';
export const ROUTER_PRIVATE_CONTAINER_PORT = 8081;
export const ROUTER_BINDING_STATE_DIRECTORY = 'router-bindings';
export const ROUTER_BINDING_STATE_VERSION = 1;
export const ROUTER_BINDING_STATE_MAX_BYTES = 4096;

const MAPPING_USAGE = 'BIND_ADDRESS:HOST_TCP_PORT:IN_BOX_ROUTER_PORT (for example 0:8083:8080)';
const RECORD_KEYS = Object.freeze([
    'address',
    'containerPort',
    'hostPort',
    'instance',
    'pathHash',
    'version',
    'workspaceRoot',
]);

function bindError(message, code = 'PLOINKY_BOX_BIND_INVALID') {
    return new PloinkyBoxError(message, { code });
}

function stateError(message, cause) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_ROUTER_BINDING_STATE_INVALID', cause });
}

function quoted(value) {
    const text = String(value);
    return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}...` : text);
}

function canonicalIpv4(value) {
    if (!/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value)) return false;
    return value.split('.').every((octet) => Number(octet) <= 255);
}

function parseMappingPort(value, field) {
    if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535) {
        throw bindError(`bind ${field} ${quoted(value)} must be a decimal integer in the range 1..65535`);
    }
    return Number(value);
}

/**
 * Validate one bind address literal. `0` is shorthand for the wildcard.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeRouterBindAddress(value) {
    const text = String(value ?? '');
    const address = text === '0' ? ROUTER_BIND_WILDCARD : text;
    if (!canonicalIpv4(address)) {
        throw bindError(
            `bind BIND_ADDRESS ${quoted(text)} must be 0, 0.0.0.0, 127.0.0.1, or a canonical IPv4 address `
            + 'assigned to this host; host names are not resolved and IPv6 is not supported',
        );
    }
    if (address !== ROUTER_BIND_WILDCARD && address !== ROUTER_BIND_LOOPBACK && !isUsableHostIpv4(address)) {
        throw bindError(
            `bind BIND_ADDRESS ${address} cannot publish the Router; use 0.0.0.0, 127.0.0.1, `
            + 'or a usable IPv4 address assigned to this host',
        );
    }
    return address;
}

/**
 * Freeze one binding into its exact value. The target is always the public
 * Router listener; the private 8081 listener and agent ports are never valid.
 *
 * @param {{ address: string, hostPort: number }} binding
 * @returns {Readonly<{ address: string, hostPort: number, containerPort: number }>}
 */
export function normalizeRouterBinding(binding) {
    const address = normalizeRouterBindAddress(binding?.address);
    const hostPort = binding?.hostPort;
    if (!Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
        throw bindError('bind HOST_TCP_PORT must be an integer in the range 1..65535');
    }
    if (binding.containerPort !== undefined && binding.containerPort !== BOX_ROUTER_CONTAINER_PORT) {
        throw bindError(`bind IN_BOX_ROUTER_PORT must be ${BOX_ROUTER_CONTAINER_PORT}`);
    }
    return Object.freeze({ address, hostPort, containerPort: BOX_ROUTER_CONTAINER_PORT });
}

/**
 * Parse BIND_ADDRESS:HOST_TCP_PORT:IN_BOX_ROUTER_PORT without host inspection.
 *
 * @param {string} value
 */
export function parseRouterBindingMapping(value) {
    if (typeof value !== 'string' || value === '') {
        throw bindError(`bind mapping must be ${MAPPING_USAGE}`);
    }
    const fields = value.split(':');
    if (fields.length !== 3) {
        throw bindError(
            `bind mapping ${quoted(value)} must have exactly three fields: ${MAPPING_USAGE}; `
            + 'IPv6 addresses are not supported',
        );
    }
    const [addressField, hostPortField, containerPortField] = fields;
    const address = normalizeRouterBindAddress(addressField);
    const hostPort = parseMappingPort(hostPortField, 'HOST_TCP_PORT');
    const containerPort = parseMappingPort(containerPortField, 'IN_BOX_ROUTER_PORT');
    if (containerPort !== BOX_ROUTER_CONTAINER_PORT) {
        const reason = containerPort === ROUTER_PRIVATE_CONTAINER_PORT
            ? `${ROUTER_PRIVATE_CONTAINER_PORT} is the private Router listener and is never published`
            : 'agent and service ports are never published directly';
        throw bindError(
            `bind IN_BOX_ROUTER_PORT must be ${BOX_ROUTER_CONTAINER_PORT}, the public Router port; ${reason}`,
        );
    }
    return normalizeRouterBinding({ address, hostPort });
}

export function isLoopbackRouterBinding(binding) {
    return binding?.address === ROUTER_BIND_LOOPBACK;
}

export function isWildcardRouterBinding(binding) {
    return binding?.address === ROUTER_BIND_WILDCARD;
}

/**
 * The publication recorded on a Box: its bind address and exact trusted outer
 * hosts. Loopback carries no host list; every other address carries one, and a
 * specific address must trust itself.
 *
 * @returns {Readonly<{ address: string, hosts: readonly string[]|null }>}
 */
export function normalizeRouterPublication(binding) {
    const address = normalizeRouterBindAddress(binding?.address);
    const hosts = binding?.hosts ?? null;
    if (address === ROUTER_BIND_LOOPBACK) {
        if (hosts !== null) throw bindError('A loopback Router binding carries no trusted outer hosts');
        return Object.freeze({ address, hosts: null });
    }
    if (!Array.isArray(hosts)) {
        throw bindError(`Router binding ${address} requires its trusted outer host list`);
    }
    const canonical = parsePublicRouterHosts(serializePublicRouterHosts(hosts));
    if (address !== ROUTER_BIND_WILDCARD && !canonical.includes(address)) {
        throw bindError(`Router binding ${address} must trust its own address as an outer host`);
    }
    return Object.freeze({ address, hosts: canonical });
}

function interfaceEntries(interfaces) {
    return Object.entries(interfaces || {}).flatMap(([name, entries]) => (
        (entries || [])
            .filter((entry) => entry && (entry.family === 'IPv4' || entry.family === 4))
            .map((entry) => ({ name, address: String(entry.address || '').trim(), internal: entry.internal === true }))
    ));
}

/** Every IPv4 address currently assigned to this host, loopback included. */
export function listHostIpv4Addresses({ interfaces = os.networkInterfaces() } = {}) {
    return Object.freeze([...new Set(interfaceEntries(interfaces)
        .map((entry) => entry.address)
        .filter(canonicalIpv4))].sort());
}

/**
 * Reject a specific address that does not belong to this physical host.
 *
 * @returns {Readonly<object>} the normalized binding
 */
export function assertRouterBindingAssignable(binding, { interfaces = os.networkInterfaces() } = {}) {
    const normalized = normalizeRouterBinding(binding);
    if (isLoopbackRouterBinding(normalized) || isWildcardRouterBinding(normalized)) return normalized;
    const assigned = interfaceEntries(interfaces)
        .some((entry) => !entry.internal && entry.address === normalized.address);
    if (!assigned) {
        throw bindError(
            `bind BIND_ADDRESS ${normalized.address} is not assigned to a network interface on this host; `
            + 'use an address of this machine (not the browser machine), 0.0.0.0, or 127.0.0.1',
            'PLOINKY_BOX_BIND_ADDRESS_UNASSIGNED',
        );
    }
    return normalized;
}

function hostnameAliases(hostname) {
    const full = normalizePublicRouterHost(String(hostname || ''));
    // A machine still named after loopback has no useful network name.
    if (!full || isUsableHostIpv4(full) || full.split('.')[0] === 'localhost') return [];
    const short = full.split('.')[0];
    return [full, short, `${short}.local`].filter((name) => normalizePublicRouterHost(name));
}

/**
 * The exact outer Host names the Router may trust for a binding.
 *
 * A specific binding trusts its own address; the wildcard trusts every usable
 * IPv4 address on a host interface other than container bridges. Both add this
 * machine's host names. Loopback needs no alias and returns null, preserving the
 * legacy Box environment.
 *
 * @returns {readonly string[]|null}
 */
export function deriveRouterBindingHosts(binding, {
    interfaces = os.networkInterfaces(),
    hostname = os.hostname(),
} = {}) {
    const normalized = normalizeRouterBinding(binding);
    if (isLoopbackRouterBinding(normalized)) return null;
    const addresses = isWildcardRouterBinding(normalized)
        ? interfaceEntries(interfaces)
            .filter((entry) => !entry.internal && !isContainerInterface(entry.name) && isUsableHostIpv4(entry.address))
            .map((entry) => entry.address)
        : [normalized.address];
    const unique = [...new Set([...addresses, ...hostnameAliases(hostname)])];
    if (unique.length > PUBLIC_ROUTER_HOSTS_MAX_ENTRIES) {
        throw bindError(
            `This host has ${unique.length} candidate Router host names, more than the `
            + `${PUBLIC_ROUTER_HOSTS_MAX_ENTRIES} allowed; bind one specific IPv4 address instead`,
        );
    }
    return parsePublicRouterHosts(serializePublicRouterHosts(unique));
}

/** Two bindings are identical only with identical trusted hosts. */
export function sameRouterBinding(left, right) {
    return Boolean(left && right)
        && left.address === right.address
        && left.hostPort === right.hostPort
        && JSON.stringify(left.hosts ?? null) === JSON.stringify(right.hosts ?? null);
}

/**
 * The authority the in-Box core reports and health presents. A specific
 * address is reachable only through itself; loopback and the wildcard are
 * reachable through loopback on this host.
 */
export function routerBindingPublicAuthority(binding) {
    const normalized = normalizeRouterBinding(binding);
    const host = isLoopbackRouterBinding(normalized) || isWildcardRouterBinding(normalized)
        ? ROUTER_BIND_LOOPBACK
        : normalized.address;
    return `${host}:${normalized.hostPort}`;
}

/**
 * Host-side health connections for a binding. The wildcard is a listen address,
 * so it is probed through loopback and, when present, one trusted host address
 * so the outer Host policy is proven as well as the listener.
 *
 * @returns {ReadonlyArray<{ hostname: string, authority: string }>}
 */
export function routerBindingProbeTargets(binding, hosts = binding?.hosts ?? null) {
    const normalized = normalizeRouterBinding(binding);
    const target = (hostname) => Object.freeze({ hostname, authority: `${hostname}:${normalized.hostPort}` });
    if (isLoopbackRouterBinding(normalized)) return Object.freeze([target(ROUTER_BIND_LOOPBACK)]);
    if (!isWildcardRouterBinding(normalized)) return Object.freeze([target(normalized.address)]);
    const hostAddress = (hosts || []).find((host) => isUsableHostIpv4(host));
    return Object.freeze([
        target(ROUTER_BIND_LOOPBACK),
        ...(hostAddress ? [target(hostAddress)] : []),
    ]);
}

/** Browser URLs worth printing; never the wildcard itself. */
export function routerBindingBrowserUrls(binding, hosts = binding?.hosts ?? null) {
    const normalized = normalizeRouterBinding(binding);
    const url = (host) => `http://${host}:${normalized.hostPort}/`;
    if (isLoopbackRouterBinding(normalized)) return Object.freeze([url(ROUTER_BIND_LOOPBACK)]);
    if (!isWildcardRouterBinding(normalized)) return Object.freeze([url(normalized.address)]);
    return Object.freeze([
        ...(hosts || []).filter((host) => isUsableHostIpv4(host)).map(url),
        url(ROUTER_BIND_LOOPBACK),
    ]);
}

export function describeRouterBinding(binding) {
    const normalized = normalizeRouterBinding(binding);
    return `${normalized.address}:${normalized.hostPort} -> public Router ${BOX_ROUTER_CONTAINER_PORT}/tcp`;
}

function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function exactIdentity(identity) {
    const instance = String(identity?.instance || '');
    if (!/^ploinky-box-[a-z0-9-]+-[a-f0-9]{12}$/.test(instance)
        || !/^[a-f0-9]{12}$/.test(String(identity?.pathHash || ''))
        || !path.isAbsolute(String(identity?.workspaceRoot || ''))) {
        throw stateError('Router binding state requires the exact workspace identity');
    }
    return identity;
}

function realpathOfNearestExisting(target, fsApi) {
    const missing = [];
    let current = target;
    while (true) {
        try {
            return path.join(fsApi.realpathSync(current), ...missing);
        } catch (error) {
            const parent = path.dirname(current);
            if (error?.code !== 'ENOENT' || parent === current) throw error;
            // Resolve a dangling directory alias too: its host-only target may
            // be created later, after the Box has already mounted its parent.
            try {
                if (fsApi.lstatSync(current).isSymbolicLink()) {
                    const destination = path.resolve(parent, fsApi.readlinkSync(current));
                    return path.join(realpathOfNearestExisting(destination, fsApi), ...missing);
                }
            } catch (linkError) {
                if (linkError?.code !== 'ENOENT') throw linkError;
            }
            missing.unshift(path.basename(current));
            current = parent;
        }
    }
}

function containsPath(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative));
}

function directoryIdentity(target, fsApi) {
    try {
        const stat = fsApi.statSync(target);
        return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function ancestorDirectoryIdentities(target, fsApi) {
    const identities = new Set();
    for (let current = target; ; current = path.dirname(current)) {
        const identity = directoryIdentity(current, fsApi);
        if (identity) identities.add(identity);
        if (path.dirname(current) === current) return identities;
    }
}

/**
 * Keep host control state outside every writable Box mount, including cache
 * directory symlinks and bind-mount aliases that realpath cannot distinguish.
 * Check the reserved path even before the first binding record exists.
 */
export function assertRouterBindingStateConfined(identity, {
    homeDirectory = os.homedir(),
    fsApi = fs,
} = {}) {
    exactIdentity(identity);
    const stateRoot = path.join(path.resolve(homeDirectory), '.ploinky-box');
    const protectedPaths = [stateRoot, path.join(stateRoot, ROUTER_BINDING_STATE_DIRECTORY)]
        .map((target) => realpathOfNearestExisting(target, fsApi));
    const protectedAncestors = protectedPaths.map((target) => ancestorDirectoryIdentities(target, fsApi));
    const protectedIdentities = protectedPaths.map((target) => directoryIdentity(target, fsApi)).filter(Boolean);
    for (const source of [identity.workspaceRoot, ...Object.values(identity.dataPaths || {})]) {
        const writable = realpathOfNearestExisting(source, fsApi);
        const writableIdentity = directoryIdentity(writable, fsApi);
        const writableAncestors = ancestorDirectoryIdentities(writable, fsApi);
        if (protectedPaths.some((target) => containsPath(writable, target) || containsPath(target, writable))
            || (writableIdentity && protectedAncestors.some((ancestors) => ancestors.has(writableIdentity)))
            || protectedIdentities.some((entry) => writableAncestors.has(entry))) {
            throw stateError(
                `Router binding state ${stateRoot} overlaps writable Box source ${source}, where agents can write it; `
                + 'choose a workspace and cache paths outside the host control-state directory',
            );
        }
    }
}

/**
 * Host-only, per-workspace saved Router binding.
 *
 * @param {{ homeDirectory?: string, fsApi?: typeof fs }} [options]
 */
export function createRouterBindingStore({
    homeDirectory = os.homedir(),
    fsApi = fs,
} = {}) {
    const stateRoot = path.join(path.resolve(homeDirectory), '.ploinky-box');
    const directory = path.join(stateRoot, ROUTER_BINDING_STATE_DIRECTORY);

    function targetFor(identity) {
        return path.join(directory, `${exactIdentity(identity).instance}.json`);
    }

    function assertPrivateDirectory(target, stat) {
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw stateError(`Router binding state path is not a real directory: ${target}`);
        }
        const uid = currentUid();
        if (uid !== null && stat.uid !== uid) {
            throw stateError(`Router binding state directory is not owned by the current user: ${target}`);
        }
        if ((stat.mode & 0o022) !== 0) {
            throw stateError(`Router binding state directory must not be group- or world-writable: ${target}`);
        }
    }

    function existingDirectories() {
        for (const target of [stateRoot, directory]) {
            let stat;
            try {
                stat = fsApi.lstatSync(target);
            } catch (error) {
                if (error?.code === 'ENOENT') return false;
                throw stateError(`Unable to inspect Router binding state directory: ${target}`, error);
            }
            assertPrivateDirectory(target, stat);
        }
        return true;
    }

    function ensureDirectories() {
        for (const target of [stateRoot, directory]) {
            try {
                fsApi.mkdirSync(target, { mode: 0o700 });
            } catch (error) {
                if (error?.code !== 'EEXIST') {
                    throw stateError(`Unable to create Router binding state directory: ${target}`, error);
                }
            }
            const stat = fsApi.lstatSync(target);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw stateError(`Router binding state path is not a real directory: ${target}`);
            }
            const uid = currentUid();
            if (uid !== null && stat.uid !== uid) {
                throw stateError(`Router binding state directory is not owned by the current user: ${target}`);
            }
            fsApi.chmodSync(target, 0o700);
        }
    }

    function assertConfined(identity) {
        return assertRouterBindingStateConfined(identity, { homeDirectory, fsApi });
    }

    function normalizeRecord(identity, record) {
        if (!record || typeof record !== 'object' || Array.isArray(record)
            || Object.getPrototypeOf(record) !== Object.prototype
            || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(RECORD_KEYS)) {
            throw stateError('Saved Router binding has an unsupported schema');
        }
        if (record.version !== ROUTER_BINDING_STATE_VERSION) {
            throw stateError(`Saved Router binding version ${quoted(record.version)} is unsupported`);
        }
        if (record.instance !== identity.instance
            || record.pathHash !== identity.pathHash
            || record.workspaceRoot !== identity.workspaceRoot) {
            throw stateError('Saved Router binding belongs to another workspace');
        }
        if (record.containerPort !== BOX_ROUTER_CONTAINER_PORT || typeof record.address !== 'string') {
            throw stateError('Saved Router binding does not target the public Router port');
        }
        try {
            return normalizeRouterBinding({ address: record.address, hostPort: record.hostPort });
        } catch (error) {
            throw stateError(`Saved Router binding is invalid: ${error.message}`, error);
        }
    }

    /**
     * @returns {Readonly<object>|null} null when no preference was saved
     */
    function read(identity) {
        const target = targetFor(identity);
        assertConfined(identity);
        if (!existingDirectories()) return null;
        let descriptor;
        try {
            descriptor = fsApi.openSync(
                target,
                fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW | fsApi.constants.O_NONBLOCK,
            );
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw stateError(`Saved Router binding must be a readable non-symlink file: ${target}`, error);
        }
        try {
            const before = fsApi.fstatSync(descriptor);
            if (!before.isFile() || before.nlink !== 1) {
                throw stateError(`Saved Router binding must be one non-linked regular file: ${target}`);
            }
            const uid = currentUid();
            if (uid !== null && before.uid !== uid) {
                throw stateError(`Saved Router binding must be owned by the current user: ${target}`);
            }
            if ((before.mode & 0o077) !== 0) {
                throw stateError(`Saved Router binding must be private to the current user (mode 0600): ${target}`);
            }
            if (before.size > ROUTER_BINDING_STATE_MAX_BYTES) {
                throw stateError(`Saved Router binding exceeds ${ROUTER_BINDING_STATE_MAX_BYTES} bytes: ${target}`);
            }
            const bytes = fsApi.readFileSync(descriptor);
            const after = fsApi.fstatSync(descriptor);
            if (bytes.length !== before.size || after.size !== before.size
                || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
                throw stateError(`Saved Router binding changed while being read: ${target}`);
            }
            let record;
            try {
                record = JSON.parse(bytes.toString('utf8'));
            } catch (error) {
                throw stateError(`Saved Router binding is not valid JSON: ${target}`, error);
            }
            return normalizeRecord(identity, record);
        } finally {
            fsApi.closeSync(descriptor);
        }
    }

    function assertLock(identity, lock) {
        if (typeof lock?.assertHeld !== 'function') {
            throw stateError('Saving the Router binding requires the workspace mutation lock');
        }
        lock.assertHeld(identity.instance);
    }

    function write(identity, binding, lock) {
        exactIdentity(identity);
        assertLock(identity, lock);
        const normalized = normalizeRouterBinding(binding);
        assertConfined(identity);
        ensureDirectories();
        assertConfined(identity);
        const target = targetFor(identity);
        try {
            const existing = fsApi.lstatSync(target);
            if (!existing.isFile() || existing.isSymbolicLink()) {
                throw stateError(`Refusing to replace a non-regular Router binding state path: ${target}`);
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        const record = {
            version: ROUTER_BINDING_STATE_VERSION,
            instance: identity.instance,
            pathHash: identity.pathHash,
            workspaceRoot: identity.workspaceRoot,
            address: normalized.address,
            hostPort: normalized.hostPort,
            containerPort: BOX_ROUTER_CONTAINER_PORT,
        };
        const temporary = path.join(directory, `.${identity.instance}.${crypto.randomUUID()}.tmp`);
        let descriptor;
        try {
            descriptor = fsApi.openSync(
                temporary,
                fsApi.constants.O_WRONLY | fsApi.constants.O_CREAT | fsApi.constants.O_EXCL
                    | fsApi.constants.O_NOFOLLOW,
                0o600,
            );
            fsApi.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
            fsApi.fsyncSync(descriptor);
            fsApi.closeSync(descriptor);
            descriptor = undefined;
            lock.assertHeld(identity.instance);
            assertConfined(identity);
            fsApi.renameSync(temporary, target);
        } finally {
            if (descriptor !== undefined) fsApi.closeSync(descriptor);
            try { fsApi.unlinkSync(temporary); } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        }
        return normalized;
    }

    function clear(identity, lock) {
        exactIdentity(identity);
        assertLock(identity, lock);
        assertConfined(identity);
        if (!existingDirectories()) return false;
        const target = targetFor(identity);
        let stat;
        try {
            stat = fsApi.lstatSync(target);
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw stateError(`Unable to inspect saved Router binding: ${target}`, error);
        }
        if (!stat.isFile() && !stat.isSymbolicLink()) {
            throw stateError(`Refusing to remove a non-regular Router binding state path: ${target}`);
        }
        fsApi.unlinkSync(target);
        return true;
    }

    /** Put back exactly the preference captured before a failed mutation. */
    function restore(identity, previous, lock) {
        if (previous) write(identity, previous, lock);
        else clear(identity, lock);
    }

    return Object.freeze({ directory, pathFor: targetFor, assertConfined, read, write, clear, restore });
}
