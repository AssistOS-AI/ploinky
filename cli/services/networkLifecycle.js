import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';

import { PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT } from './config.js';
import {
    NETWORK_SCHEMA_VERSION,
    deriveNetworkAlias,
    logicalNetworkAttachments,
    networkContractHash,
} from './networkContract.js';

export const NETWORK_LABELS = Object.freeze({
    managed: 'io.assistos.ploinky.managed',
    resource: 'io.assistos.ploinky.resource',
    schema: 'io.assistos.ploinky.network-schema',
    workspace: 'io.assistos.ploinky.workspace',
    logical: 'io.assistos.ploinky.logical',
});
export const NETWORK_GATEWAY_IMAGE = 'docker.io/assistos/ploinky-network-gateway:1@sha256:68c47ce93d16ea1a2d03944f7b50ce82e6f2f9a26b183d2c9c7fbabcc828fb7e';
export const NETWORK_GATEWAY_IMAGE_REF = NETWORK_GATEWAY_IMAGE;

const LOCK_PATH = path.join(PLOINKY_DIR, 'run', 'network.lock');
const LOCK_REAPER_SUFFIX = '.reaper';
export const NETWORK_LOCK_STALE_GRACE_MS = 5_000;
const ROUTER_SOCKET = path.join(PLOINKY_DIR, 'run', 'router.sock');
const MINIMAL_HOSTS = path.join(PLOINKY_DIR, 'run', 'managed-hosts');

function hash12(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

export function workspaceNetworkIdentity(workspaceRoot = PLOINKY_WORKSPACE_ROOT) {
    let canonical = path.resolve(workspaceRoot);
    try { canonical = fs.realpathSync.native(canonical); } catch (_) {}
    return { canonical, hash: hash12(canonical) };
}

export function physicalNetworkName(workspaceHash, logicalName) {
    return `ploinky-nw-${workspaceHash}-${hash12(logicalName)}`;
}

export function gatewayContainerName(workspaceHash) {
    return `ploinky-gw-${workspaceHash}`;
}

function expectedNetworkLabels(workspaceHash, logicalName) {
    return {
        [NETWORK_LABELS.managed]: '1',
        [NETWORK_LABELS.resource]: 'network',
        [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
        [NETWORK_LABELS.workspace]: workspaceHash,
        [NETWORK_LABELS.logical]: logicalName,
    };
}

function expectedGatewayLabels(workspaceHash) {
    return {
        [NETWORK_LABELS.managed]: '1',
        [NETWORK_LABELS.resource]: 'gateway',
        [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
        [NETWORK_LABELS.workspace]: workspaceHash,
    };
}

function firstRecord(raw, description) {
    let parsed;
    try { parsed = JSON.parse(String(raw || '')); } catch (error) {
        throw new Error(`${description} inspection returned malformed JSON: ${error.message}`);
    }
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!record || typeof record !== 'object') throw new Error(`${description} inspection returned no record`);
    return record;
}

function labelsOf(record) {
    return record.Labels || record.labels || record.Config?.Labels || {};
}

function exactRuntimeAliases(record, explicitAlias) {
    const implicitIdAlias = String(record?.Id || record?.ID || '').slice(0, 12);
    return [explicitAlias, ...(implicitIdAlias ? [implicitIdAlias] : [])].sort();
}

function semanticRuntimeAliases(record, aliases) {
    const implicitIdAlias = String(record?.Id || record?.ID || '').slice(0, 12);
    return [...(aliases || [])]
        .map(String)
        .filter((alias) => alias && alias !== implicitIdAlias)
        .sort();
}

function hasExactLabels(observed, expected) {
    const observedKeys = Object.keys(observed || {}).sort();
    const expectedKeys = Object.keys(expected).sort();
    return observedKeys.length === expectedKeys.length
        && observedKeys.every((key, index) => key === expectedKeys[index])
        && Object.entries(expected).every(([key, value]) => String(observed?.[key] ?? '') === value);
}

function assertExactLabels(name, observed, expected) {
    const observedKeys = Object.keys(observed || {}).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (observedKeys.length !== expectedKeys.length
        || observedKeys.some((key, index) => key !== expectedKeys[index])) {
        throw new Error(`resource '${name}' is foreign/unsupported: exact label keys expected '${expectedKeys.join(',')}', observed '${observedKeys.join(',')}'`);
    }
    for (const [key, value] of Object.entries(expected)) {
        if (String(observed?.[key] ?? '') !== value) {
            throw new Error(`resource '${name}' is foreign/unsupported: label ${key} expected '${value}', observed '${observed?.[key] ?? '<missing>'}'`);
        }
    }
}

function processAlive(pid) {
    if (!Number.isInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function readLockOwner(lockPath) {
    try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) { return null; }
}

function ownerAgeMs(owner, now = Date.now(), fallbackMtimeMs = now) {
    const created = Date.parse(String(owner?.createdAt || ''));
    return Math.max(0, now - (Number.isFinite(created) ? created : fallbackMtimeMs));
}

function lockSnapshot(filePath, now = Date.now()) {
    try {
        const stat = fs.statSync(filePath);
        const raw = fs.readFileSync(filePath, 'utf8');
        let owner = null;
        try { owner = JSON.parse(raw); } catch (_) {}
        return {
            owner,
            ageMs: ownerAgeMs(owner, now, stat.mtimeMs),
            fingerprint: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${raw}`,
        };
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function reapAbandonedFile(filePath, description, staleGraceMs, now) {
    const observed = lockSnapshot(filePath, now());
    if (!observed) return;
    if (observed.owner && processAlive(Number(observed.owner.pid))) {
        throw new Error(`${description} is already owned by pid ${observed.owner.pid}`);
    }
    if (observed.ageMs < staleGraceMs) {
        throw new Error(`${description} is unreadable or inside the stale-owner grace period`);
    }
    const confirmed = lockSnapshot(filePath, now());
    if (!confirmed || confirmed.fingerprint !== observed.fingerprint) {
        throw new Error(`${description} changed during stale-owner recovery`);
    }
    if (confirmed.owner && processAlive(Number(confirmed.owner.pid))) {
        throw new Error(`${description} became live during stale-owner recovery`);
    }
    fs.unlinkSync(filePath);
}

function releaseOwnedFile(filePath, token) {
    try {
        const current = readLockOwner(filePath);
        if (current?.token === token) fs.unlinkSync(filePath);
    } catch (_) {}
}

export function acquireNetworkLifecycleLock({
    lockPath = LOCK_PATH,
    staleGraceMs = NETWORK_LOCK_STALE_GRACE_MS,
    now = () => Date.now(),
} = {}) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const owner = { token, pid: process.pid, createdAt: new Date().toISOString() };
    const tryCreate = () => {
        try {
            fs.writeFileSync(lockPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
            return true;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            return false;
        }
    };
    if (!tryCreate()) {
        const reaperPath = `${lockPath}${LOCK_REAPER_SUFFIX}`;
        reapAbandonedFile(reaperPath, 'network lifecycle stale-owner recovery', staleGraceMs, now);
        const reaperToken = randomUUID();
        const reaperOwner = { token: reaperToken, pid: process.pid, createdAt: new Date().toISOString() };
        try {
            fs.writeFileSync(reaperPath, JSON.stringify(reaperOwner), { flag: 'wx', mode: 0o600 });
        } catch (error) {
            if (error?.code === 'EEXIST') throw new Error('network lifecycle stale-owner recovery is already in progress');
            throw error;
        }
        try {
            reapAbandonedFile(lockPath, 'network lifecycle lock', staleGraceMs, now);
            if (!tryCreate()) throw new Error('network lifecycle was acquired during stale-owner recovery');
        } finally {
            releaseOwnedFile(reaperPath, reaperToken);
        }
    }
    let released = false;
    return {
        token,
        owner,
        lockPath,
        release() {
            if (released) return;
            released = true;
            releaseOwnedFile(lockPath, token);
        },
    };
}

export function withNetworkLifecycleLock(callback, options = {}) {
    const lock = acquireNetworkLifecycleLock(options);
    try { return callback(lock); } finally { lock.release(); }
}

function defaultRun(runtime, args, options = {}) {
    const result = spawnSync(runtime, args, {
        encoding: 'utf8',
        stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    return {
        ok: result.status === 0 && !result.error,
        status: Number.isInteger(result.status) ? result.status : 1,
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || ''),
        error: result.error || null,
    };
}

function failure(result) {
    return String(result?.error?.message || result?.stderr || result?.stdout || `exit ${result?.status ?? 1}`).trim();
}

function missing(result) {
    return !result?.ok && /not found|no such|does not exist|no .* with name/i.test(`${result?.stderr || ''}\n${result?.stdout || ''}`);
}

function writeMinimalHostsFile(hostsPath = MINIMAL_HOSTS) {
    fs.mkdirSync(path.dirname(hostsPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(hostsPath, '127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n', { mode: 0o600 });
    return hostsPath;
}

export function createNetworkLifecycleAdapter({
    runtime,
    run = defaultRun,
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    lockPath = LOCK_PATH,
    routerSocket = ROUTER_SOCKET,
    minimalHosts = MINIMAL_HOSTS,
    gatewayImage = NETWORK_GATEWAY_IMAGE_REF,
    probeGateway,
} = {}) {
    if (!runtime) throw new Error('network lifecycle requires a container runtime');
    const identity = workspaceNetworkIdentity(workspaceRoot);
    const execute = (args, options) => run(runtime, args, options);
    let rootlessPodmanVerified = false;
    let selinuxEnabled = null;
    const inspectNetwork = (name) => {
        const result = execute(['network', 'inspect', name]);
        if (!result.ok) {
            if (missing(result)) return null;
            throw new Error(`cannot inspect network '${name}': ${failure(result)}`);
        }
        return firstRecord(result.stdout, `network '${name}'`);
    };
    const inspectContainer = (name) => {
        const result = execute(['container', 'inspect', name]);
        if (!result.ok) {
            if (missing(result)) return null;
            throw new Error(`cannot inspect container '${name}': ${failure(result)}`);
        }
        return firstRecord(result.stdout, `container '${name}'`);
    };

    function ensureRootlessPodman() {
        if (rootlessPodmanVerified) return;
        if (runtime !== 'podman') {
            throw new Error(`runtime '${runtime}' cannot prove the managed rootless bridge contract; rootless Podman is required`);
        }
        const result = execute(['info', '--format', '{{json .Host.Security.Rootless}}']);
        if (!result.ok || String(result.stdout || '').trim() !== 'true') {
            throw new Error(`runtime '${runtime}' cannot prove rootless Podman ownership; refusing managed network mutation`);
        }
        rootlessPodmanVerified = true;
    }

    function assertSupportedNetwork(record, name, labels) {
        assertExactLabels(name, labelsOf(record), labels);
        if (String(record.Driver || record.driver || '') !== 'bridge') {
            throw new Error(`managed network '${name}' has unexpected driver '${record.Driver || record.driver || '<missing>'}'`);
        }
        const internal = record.Internal ?? record.internal ?? false;
        const ipv6 = record.IPv6Enabled ?? record.ipv6_enabled ?? record.EnableIPv6 ?? false;
        const dns = record.DNSEnabled ?? record.dns_enabled ?? true;
        if (internal !== false || ipv6 !== false || dns !== true) {
            throw new Error(`managed network '${name}' has unsupported bridge isolation, IPv6, or DNS options`);
        }
        const options = record.Options || record.options || {};
        if (Object.keys(options).length > 0) {
            throw new Error(`managed network '${name}' has unsupported bridge options`);
        }
        const ipam = record.IPAM?.Driver || record.ipam_options?.driver || '';
        if (String(ipam) !== 'host-local') {
            throw new Error(`managed network '${name}' has unsupported IPAM driver '${ipam}'`);
        }
        const ipamOptions = record.IPAM?.Options || record.ipam_options || {};
        const optionKeys = Object.keys(ipamOptions).filter((key) => key !== 'driver');
        if (optionKeys.length > 0) throw new Error(`managed network '${name}' has unsupported IPAM options`);
        const subnets = record.Subnets || record.subnets || record.IPAM?.Config;
        if (!Array.isArray(subnets) || subnets.length !== 1) {
            throw new Error(`managed network '${name}' must have exactly one runtime-assigned IPv4 subnet`);
        }
        const subnet = subnets[0] || {};
        const cidr = String(subnet.Subnet || subnet.subnet || '');
        const gateway = String(subnet.Gateway || subnet.gateway || '');
        const keys = Object.keys(subnet).map((key) => key.toLowerCase());
        if (!/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(cidr)
            || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(gateway)
            || keys.some((key) => !['subnet', 'gateway'].includes(key))) {
            throw new Error(`managed network '${name}' has unsupported subnet or address-pool configuration`);
        }
    }

    function assertRouterSocket() {
        if (!fs.existsSync(routerSocket)) {
            throw new Error(`router gateway unavailable: Unix router listener is missing at ${routerSocket}`);
        }
        const socketStat = fs.lstatSync(routerSocket);
        if (!socketStat.isSocket()) throw new Error(`router gateway unavailable: ${routerSocket} is not a Unix socket`);
        if ((socketStat.mode & 0o777) !== 0o666) {
            throw new Error(`router gateway unavailable: ${routerSocket} must be exactly chmod 0666 for the numeric gateway user`);
        }
    }

    function inspectGatewayImage() {
        return execute(['image', 'inspect', gatewayImage]);
    }

    function ensureGatewayImageAvailable() {
        let image = inspectGatewayImage();
        if (image.ok) return;
        const pulled = execute(['pull', gatewayImage]);
        if (!pulled.ok) {
            throw new Error(`router gateway image '${gatewayImage}' is unavailable and exact pull failed: ${failure(pulled)}`);
        }
        image = inspectGatewayImage();
        if (!image.ok) throw new Error(`router gateway image '${gatewayImage}' remained unavailable after exact pull`);
    }

    function assertGatewayRecord(gateway, networks, needsLabelDisable, { requireRunning = true } = {}) {
        const name = gatewayContainerName(identity.hash);
        assertExactLabels(name, labelsOf(gateway), expectedGatewayLabels(identity.hash));
        if (String(gateway.Config?.Image || gateway.ImageName || '') !== gatewayImage) {
            throw new Error(`router gateway '${name}' has unexpected image '${gateway.Config?.Image || gateway.ImageName || '<missing>'}'`);
        }
        if (requireRunning && !(gateway.State?.Running === true || gateway.State?.Status === 'running')) {
            throw new Error(`router gateway '${name}' is not running`);
        }
        if (gateway.HostConfig?.Privileged === true) {
            throw new Error(`router gateway '${name}' is unsupported: privileged mode is forbidden`);
        }
        if (String(gateway.Config?.User || '') !== '65532:65532') {
            throw new Error(`router gateway '${name}' is unsupported: exact numeric user 65532:65532 is required`);
        }
        const entrypoint = gateway.Config?.Entrypoint;
        if (!Array.isArray(entrypoint) || entrypoint.length !== 1 || entrypoint[0] !== '/ploinky-network-gateway') {
            throw new Error(`router gateway '${name}' is unsupported: fixed entrypoint is required`);
        }
        if (Array.isArray(gateway.Config?.Cmd) && gateway.Config.Cmd.length > 0) {
            throw new Error(`router gateway '${name}' is unsupported: command arguments are forbidden`);
        }
        if (gateway.HostConfig?.ReadonlyRootfs !== true) {
            throw new Error(`router gateway '${name}' is unsupported: read-only root filesystem is required`);
        }
        const capDrop = (gateway.HostConfig?.CapDrop || []).map((value) => String(value).toUpperCase());
        if (capDrop.length !== 1 || capDrop[0] !== 'ALL') throw new Error(`router gateway '${name}' is unsupported: exact CapDrop=ALL is required`);
        if ((gateway.HostConfig?.CapAdd || []).length > 0) {
            throw new Error(`router gateway '${name}' is unsupported: added capabilities are forbidden`);
        }
        const securityOpts = (gateway.HostConfig?.SecurityOpt || []).map(String).sort();
        const expectedSecurity = ['no-new-privileges', ...(needsLabelDisable ? ['label=disable'] : [])].sort();
        if (JSON.stringify(securityOpts) !== JSON.stringify(expectedSecurity)) {
            throw new Error(`router gateway '${name}' is unsupported: exact security options are required`);
        }
        const sysctls = gateway.HostConfig?.Sysctls || {};
        if (Object.keys(sysctls).length !== 1 || String(sysctls['net.ipv4.ip_forward'] ?? '') !== '0') {
            throw new Error(`router gateway '${name}' is unsupported: exact IPv4 forwarding disablement is required`);
        }
        const published = gateway.HostConfig?.PortBindings || gateway.NetworkSettings?.Ports || {};
        if (Object.values(published).some((bindings) => Array.isArray(bindings) ? bindings.length > 0 : Boolean(bindings))) {
            throw new Error(`router gateway '${name}' is unsupported: published ports are forbidden`);
        }
        const mounts = gateway.Mounts || [];
        const configuredTmpfs = gateway.HostConfig?.Tmpfs || {};
        const tmpfsValue = String(configuredTmpfs['/tmp'] || '');
        const observedTmpfsOptions = tmpfsValue.split(',').filter(Boolean).sort();
        const expectedTmpfsOptions = ['rw', 'noexec', 'nosuid', 'nodev', 'mode=1777'].sort();
        const exactTmpfs = Object.keys(configuredTmpfs).length === 1
            && JSON.stringify(observedTmpfsOptions) === JSON.stringify(expectedTmpfsOptions);
        if (!exactTmpfs) throw new Error(`router gateway '${name}' is unsupported: exact private /tmp tmpfs is required`);
        const bindMounts = mounts.filter((mount) => mount?.Type !== 'tmpfs');
        if (bindMounts.length !== 1
            || bindMounts[0]?.Source !== routerSocket
            || bindMounts[0]?.Destination !== '/run/ploinky/router.sock'
            || bindMounts[0]?.RW === true) {
            throw new Error(`router gateway '${name}' is unsupported: router socket must be its sole read-only mount`);
        }
        const attached = gateway.NetworkSettings?.Networks || {};
        for (const [physicalName, networkRecord] of Object.entries(attached)) {
            const inspected = inspectNetwork(physicalName);
            if (!inspected) throw new Error(`router gateway '${name}' is attached to missing network '${physicalName}'`);
            const logicalName = String(labelsOf(inspected)?.[NETWORK_LABELS.logical] || '');
            if (!logicalName) throw new Error(`router gateway '${name}' is attached to unsupported network '${physicalName}' without a logical ownership label`);
            assertSupportedNetwork(inspected, physicalName, expectedNetworkLabels(identity.hash, logicalName));
            const aliases = [...(networkRecord?.Aliases || [])].map(String).sort();
            if (JSON.stringify(aliases) !== JSON.stringify(exactRuntimeAliases(gateway, 'ploinky-router'))) {
                throw new Error(`router gateway '${name}' has unsupported aliases on '${physicalName}'`);
            }
        }
        for (const network of networks || []) {
            if (!attached[network.name] && inspectNetwork(network.name)) {
                throw new Error(`router gateway '${name}' is missing desired network '${network.name}'`);
            }
        }
    }

    function defaultGatewayProbe(gateway) {
        const pid = Number(gateway.State?.Pid);
        if (!Number.isInteger(pid) || pid < 1) return { ok: false, stderr: 'gateway has no live container PID' };
        const script = `const net=require('node:net');const s=net.createConnection({host:process.argv[1],port:8080});`
            + `const t=setTimeout(()=>{s.destroy();process.exit(2)},3000);`
            + `s.on('connect',()=>s.write('GET /status HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n'));`
            + `s.on('data',()=>{clearTimeout(t);s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));`;
        // A rootless host process cannot generally route to the container bridge IP.
        // Enter the rootless user's namespace, then the gateway network namespace,
        // and exercise TCP 8080 -> the mounted Unix socket from loopback instead.
        const local = execute([
            'unshare', 'nsenter', '--target', String(pid), '--net',
            process.execPath, '-e', script, '127.0.0.1',
        ]);
        if (local.ok || !/remote podman client/i.test(failure(local))) return local;
        const remoteScript = "exec 3<>/dev/tcp/127.0.0.1/8080; "
            + "printf 'GET /status HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3; "
            + "IFS= read -r -t 3 line <&3; [[ $line == HTTP/* ]]";
        return execute([
            'machine', 'ssh', 'podman', 'unshare',
            'nsenter', '--target', String(pid), '--net',
            'bash', '-lc', remoteScript,
        ]);
    }

    function assertGatewayReady(gateway, networks) {
        const result = (probeGateway || defaultGatewayProbe)(gateway, networks);
        if (!result?.ok) throw new Error(`router gateway TCP 8080 to Unix socket probe failed: ${failure(result)}`);
    }

    function podmanSelinuxEnabled() {
        ensureRootlessPodman();
        if (selinuxEnabled !== null) return selinuxEnabled;
        const result = execute(['info', '--format', '{{json .Host.Security.SELinuxEnabled}}']);
        const value = String(result.stdout || '').trim();
        if (!result.ok || !['true', 'false'].includes(value)) {
            throw new Error(`runtime '${runtime}' cannot prove the SELinux state required by the gateway mount policy`);
        }
        selinuxEnabled = value === 'true';
        return selinuxEnabled;
    }

    function ensureNetwork(logicalName) {
        ensureRootlessPodman();
        const name = physicalNetworkName(identity.hash, logicalName);
        const labels = expectedNetworkLabels(identity.hash, logicalName);
        const existing = inspectNetwork(name);
        if (existing) {
            assertSupportedNetwork(existing, name, labels);
            return { name, logicalName, created: false };
        }
        const args = ['network', 'create', '--driver', 'bridge'];
        for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`);
        args.push(name);
        const created = execute(args);
        if (!created.ok) {
            const raced = inspectNetwork(name);
            if (!raced) throw new Error(`cannot create managed network '${name}': ${failure(created)}`);
            assertSupportedNetwork(raced, name, labels);
            return { name, logicalName, created: false };
        }
        const verified = inspectNetwork(name);
        if (!verified) throw new Error(`managed network '${name}' disappeared after creation`);
        assertSupportedNetwork(verified, name, labels);
        return { name, logicalName, created: true };
    }

    function ensureGateway(networks) {
        if (!Array.isArray(networks) || networks.length === 0) return null;
        const needsLabelDisable = podmanSelinuxEnabled();
        assertRouterSocket();
        const image = inspectGatewayImage();
        if (!image.ok) throw new Error(`router gateway image '${gatewayImage}' is unavailable; no fallback is permitted`);
        const name = gatewayContainerName(identity.hash);
        const labels = expectedGatewayLabels(identity.hash);
        let gateway = inspectContainer(name);
        let created = false;
        const connectionsCreated = [];
        try {
        if (!gateway) {
            const primary = networks.find((entry) => entry.primary) || networks[0];
            const args = [
                'run', '-d', '--name', name,
                '--network', primary.name, '--network-alias', 'ploinky-router',
                '--user', '65532:65532', '--entrypoint', '/ploinky-network-gateway',
                '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges',
                '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,mode=1777',
                '--sysctl', 'net.ipv4.ip_forward=0',
                '-v', `${routerSocket}:/run/ploinky/router.sock:ro`,
            ];
            if (needsLabelDisable) args.push('--security-opt', 'label=disable');
            for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`);
            args.push(gatewayImage);
            const started = execute(args);
            if (!started.ok) throw new Error(`router gateway startup failed: ${failure(started)}`);
            created = true;
            gateway = inspectContainer(name);
            if (!gateway) throw new Error(`router gateway '${name}' disappeared after startup`);
        } else {
            // Validate every existing attachment and immutable setting before
            // adding a missing attachment to a newly-created desired network.
            assertGatewayRecord(gateway, [], needsLabelDisable);
        }
        const attached = gateway.NetworkSettings?.Networks || {};
        for (const network of networks) {
            if (attached[network.name]) continue;
            const connected = execute(['network', 'connect', '--alias', 'ploinky-router', network.name, name]);
            if (!connected.ok && !/already.*(connected|exists)/i.test(failure(connected))) {
                throw new Error(`router gateway could not attach to '${network.name}': ${failure(connected)}`);
            }
            if (connected.ok) connectionsCreated.push(network.name);
        }
        const verified = inspectContainer(name);
        if (!verified) throw new Error(`router gateway '${name}' disappeared during verification`);
        assertGatewayRecord(verified, networks, needsLabelDisable);
        try {
            assertGatewayReady(verified, networks);
        } catch (probeError) {
            if (created) throw probeError;
            // A router restart replaces the Unix socket inode. A bind-mounted
            // exact socket cannot follow that replacement, so deliberately
            // replace only the exact-owned gateway after its immutable record
            // has passed validation and its end-to-end probe has failed.
            const removed = execute(['rm', '-f', name]);
            if (!removed.ok && !missing(removed)) {
                throw new Error(`${probeError.message}; could not remove unhealthy exact-owned gateway '${name}': ${failure(removed)}`);
            }
            const replacement = ensureGateway(networks);
            return { ...replacement, replaced: true };
        }
        return { name, created, connectionsCreated };
        } catch (error) {
            if (created) {
                const removed = execute(['rm', '-f', name]);
                if (!removed.ok && !missing(removed)) error.message += `; rollback preserved gateway '${name}': ${failure(removed)}`;
            } else {
                for (const networkName of [...connectionsCreated].reverse()) {
                    execute(['network', 'disconnect', networkName, name]);
                }
            }
            throw error;
        }
    }

    function preflight(network, canonicalAgentId, { instanceKey = canonicalAgentId } = {}) {
        const alias = deriveNetworkAlias(canonicalAgentId);
        const logical = logicalNetworkAttachments(network, canonicalAgentId, { instanceKey });
        if (network.mode === 'none') {
            return { mode: 'none', alias, args: ['--network', 'none'], attachments: [], routerEnv: {} };
        }
        if (network.mode === 'host') {
            return { mode: 'host', alias, args: ['--network', 'host'], attachments: [], routerEnv: null };
        }
        ensureRootlessPodman();
        const needsLabelDisable = podmanSelinuxEnabled();
        assertRouterSocket();
        const attachments = logical.map((entry) => {
            const name = physicalNetworkName(identity.hash, entry.name);
            const existing = inspectNetwork(name);
            if (existing) assertSupportedNetwork(existing, name, expectedNetworkLabels(identity.hash, entry.name));
            return { name, logicalName: entry.name, primary: entry.primary === true, existed: Boolean(existing) };
        });
        const existingGateway = inspectContainer(gatewayContainerName(identity.hash));
        if (existingGateway) {
            // Only networks which already exist can already be required. Missing
            // desired networks are created later, under the same transaction.
            assertGatewayRecord(existingGateway, attachments.filter((entry) => entry.existed), needsLabelDisable);
            assertGatewayReady(existingGateway, attachments.filter((entry) => entry.existed));
        }
        return {
            mode: network.mode,
            alias,
            attachments,
            routerEnv: {
                PLOINKY_ROUTER_PORT: '8080',
                PLOINKY_ROUTER_HOST: 'ploinky-router',
                PLOINKY_ROUTER_URL: 'http://ploinky-router:8080',
            },
            gatewayImageAvailable: inspectGatewayImage().ok,
        };
    }

    function rollbackResources(plan, error) {
        const gatewayPlan = plan?.gateway;
        if (gatewayPlan?.created) {
            const removed = execute(['rm', '-f', gatewayPlan.name]);
            if (!removed.ok && !missing(removed)) error.message += `; rollback preserved gateway '${gatewayPlan.name}': ${failure(removed)}`;
        } else {
            for (const networkName of [...(gatewayPlan?.connectionsCreated || [])].reverse()) {
                execute(['network', 'disconnect', networkName, gatewayPlan.name]);
            }
        }
        for (const entry of [...(plan?.created || [])].reverse()) {
            const removed = execute(['network', 'rm', entry.name]);
            if (!removed.ok && !missing(removed)) error.message += `; rollback preserved '${entry.name}': ${failure(removed)}`;
        }
    }

    function prepareFromPreflight(checked) {
        if (!['default', 'bridge'].includes(checked.mode)) return { ...checked, created: [] };
        const created = [];
        const plan = { ...checked, created, gateway: null };
        try {
            const attachments = checked.attachments.map((entry) => {
                const ensured = ensureNetwork(entry.logicalName);
                if (ensured.created) created.push(ensured);
                return { ...ensured, primary: entry.primary };
            });
            plan.attachments = attachments;
            plan.gateway = ensureGateway(attachments);
            const primary = attachments.find((entry) => entry.primary) || attachments[0];
            return Object.assign(plan, {
                args: [
                    '--network', primary.name,
                    '--network-alias', checked.alias,
                    '--hosts-file', writeMinimalHostsFile(minimalHosts),
                ],
            });
        } catch (error) {
            rollbackResources(plan, error);
            throw error;
        }
    }

    function prepare(network, canonicalAgentId, options = {}) {
        const checked = preflight(network, canonicalAgentId, options);
        if (['default', 'bridge'].includes(checked.mode) && !checked.gatewayImageAvailable) ensureGatewayImageAvailable();
        return prepareFromPreflight(checked);
    }

    function finalizeContainer(containerName, plan) {
        try {
            for (const attachment of plan.attachments?.filter((entry) => !entry.primary) || []) {
                const result = execute(['network', 'connect', '--alias', plan.alias, attachment.name, containerName]);
                if (!result.ok) throw new Error(`cannot attach '${containerName}' to '${attachment.name}': ${failure(result)}`);
            }
            if ((plan.attachments || []).length > 0) {
                const inspected = inspectContainer(containerName);
                for (const attachment of plan.attachments || []) {
                    const networkRecord = inspected?.NetworkSettings?.Networks?.[attachment.name];
                    if (!networkRecord) {
                        throw new Error(`container '${containerName}' network verification failed for '${attachment.name}'`);
                    }
                    const observedAliases = [...(networkRecord.Aliases || [])].map(String).sort();
                    if (JSON.stringify(observedAliases) !== JSON.stringify(exactRuntimeAliases(inspected, plan.alias))) {
                        throw new Error(`container '${containerName}' alias verification failed for '${attachment.name}'`);
                    }
                }
            }
            const started = execute(['start', containerName], { inherit: true });
            if (!started.ok) throw new Error(`cannot start '${containerName}': ${failure(started)}`);
        } catch (error) {
            execute(['rm', '-f', containerName]);
            throw error;
        }
    }

    function runManagedContainerTransaction({
        network,
        canonicalAgentId,
        instanceKey = canonicalAgentId,
        containerName,
        createContainer,
    }) {
        if (typeof createContainer !== 'function') throw new Error('managed container transaction requires createContainer');
        return withNetworkLifecycleLock(() => {
            // This entire read/validate/remove/create/start sequence is one lock
            // ownership epoch. In particular, unsupported legacy port/profile
            // input must have been parsed by the caller before entering it.
            const checked = preflight(network, canonicalAgentId, { instanceKey });
            if (!['default', 'bridge'].includes(checked.mode)) {
                throw new Error(`managed container transaction cannot run network mode '${checked.mode}'`);
            }
            // Pull the one exact pinned reference only after pure validation and
            // before any existing container, network, or gateway is mutated.
            if (!checked.gatewayImageAvailable) ensureGatewayImageAvailable();
            let plan = null;
            const previous = inspectContainer(containerName);
            const previousWasRunning = previous?.State?.Running === true || previous?.State?.Status === 'running';
            const backupName = `${containerName}-network-rollback-${randomUUID().slice(0, 12)}`;
            let backupCreated = false;
            let candidateCreationAttempted = false;
            try {
                if (previous) {
                    if (previousWasRunning) {
                        const stopped = execute(['stop', containerName]);
                        if (!stopped.ok) throw new Error(`cannot stop '${containerName}' for managed replacement: ${failure(stopped)}`);
                    }
                    const renamed = execute(['rename', containerName, backupName]);
                    if (!renamed.ok) throw new Error(`cannot preserve '${containerName}' for managed replacement: ${failure(renamed)}`);
                    backupCreated = true;
                }
                plan = prepareFromPreflight(checked);
                candidateCreationAttempted = true;
                createContainer(plan);
                finalizeContainer(containerName, plan);
                if (backupCreated) {
                    const committed = execute(['rm', '-f', backupName]);
                    if (!committed.ok && !missing(committed)) {
                        throw new Error(`cannot commit managed replacement by removing preserved '${backupName}': ${failure(committed)}`);
                    }
                    backupCreated = false;
                }
                return plan;
            } catch (error) {
                let candidate = null;
                try { candidate = inspectContainer(containerName); } catch (inspectError) {
                    error.message += `; rollback could not inspect candidate '${containerName}': ${inspectError.message}`;
                }
                const candidateLabels = labelsOf(candidate || {});
                if (candidateCreationAttempted
                    && candidate
                    && String(candidateLabels['io.assistos.ploinky.workspace'] || '') === identity.hash
                    && String(candidateLabels['io.assistos.ploinky.network-contract'] || '') === networkContractHash(network)) {
                    const removed = execute(['rm', '-f', containerName]);
                    if (!removed.ok && !missing(removed)) error.message += `; rollback could not remove candidate '${containerName}': ${failure(removed)}`;
                }
                if (plan) rollbackResources(plan, error);
                if (backupCreated) {
                    const restored = execute(['rename', backupName, containerName]);
                    if (!restored.ok) {
                        error.message += `; rollback could not restore preserved '${containerName}': ${failure(restored)}`;
                    } else if (previousWasRunning) {
                        const restarted = execute(['start', containerName]);
                        if (!restarted.ok) error.message += `; rollback could not restart preserved '${containerName}': ${failure(restarted)}`;
                    }
                } else if (previousWasRunning && previous && candidate) {
                    // Stop may have succeeded while rename failed.
                    execute(['start', containerName]);
                }
                throw error;
            }
        }, { lockPath });
    }

    function status() {
        const result = execute(['network', 'ls', '--format', 'json']);
        if (!result.ok) throw new Error(`cannot list networks: ${failure(result)}`);
        let records;
        try { records = JSON.parse(result.stdout || '[]'); } catch (error) { throw new Error(`network list returned malformed JSON: ${error.message}`); }
        if (!Array.isArray(records)) records = [records];
        const prefix = `ploinky-nw-${identity.hash}-`;
        const networks = records.filter((record) => (
            String(labelsOf(record)?.[NETWORK_LABELS.workspace] || '') === identity.hash
            || String(record.Name || record.name || '').startsWith(prefix)
        )).map((summary) => {
            const physicalName = String(summary.Name || summary.name || '');
            const inspected = inspectNetwork(physicalName) || summary;
            const labels = labelsOf(inspected);
            const logicalName = String(labels?.[NETWORK_LABELS.logical] || '');
            const expected = logicalName ? expectedNetworkLabels(identity.hash, logicalName) : null;
            const owned = Boolean(expected) && hasExactLabels(labels, expected);
            const containers = inspected.Containers || inspected.containers || {};
            const attachments = Object.entries(containers).map(([id, entry]) => {
                const containerName = String(entry?.Name || entry?.name || id);
                let container = null;
                try { container = inspectContainer(containerName); } catch (_) {}
                const containerLabels = labelsOf(container || {});
                const networkRecord = container?.NetworkSettings?.Networks?.[physicalName] || {};
                const isGateway = containerName === gatewayContainerName(identity.hash)
                    && containerLabels?.[NETWORK_LABELS.resource] === 'gateway';
                const isAgent = containerLabels?.[NETWORK_LABELS.workspace] === identity.hash;
                return {
                    containerName,
                    ownership: isGateway ? 'gateway' : (isAgent ? 'agent' : 'unknown'),
                    aliases: semanticRuntimeAliases(container, networkRecord.Aliases || entry?.Aliases || []),
                };
            }).sort((a, b) => a.containerName.localeCompare(b.containerName));
            return {
                logicalName,
                physicalName,
                ownership: owned ? 'owned' : 'foreign',
                driver: String(inspected.Driver || inspected.driver || ''),
                attachments,
            };
        }).sort((a, b) => a.physicalName.localeCompare(b.physicalName));

        const gatewayName = gatewayContainerName(identity.hash);
        const gatewayRecord = inspectContainer(gatewayName);
        let gateway = null;
        if (gatewayRecord) {
            const labels = labelsOf(gatewayRecord);
            const expected = expectedGatewayLabels(identity.hash);
            const owned = hasExactLabels(labels, expected);
            gateway = {
                name: gatewayName,
                ownership: owned ? 'owned' : 'foreign',
                image: String(gatewayRecord.Config?.Image || gatewayRecord.ImageName || ''),
                state: String(gatewayRecord.State?.Status || (gatewayRecord.State?.Running ? 'running' : 'unknown')),
                attachments: Object.entries(gatewayRecord.NetworkSettings?.Networks || {})
                    .map(([physicalName, entry]) => ({
                        physicalName,
                        aliases: semanticRuntimeAliases(gatewayRecord, entry?.Aliases || []),
                    }))
                    .sort((a, b) => a.physicalName.localeCompare(b.physicalName)),
            };
        }
        return {
            schemaVersion: NETWORK_SCHEMA_VERSION,
            workspaceHash: identity.hash,
            networks,
            gateway,
        };
    }

    function verifyContainerContract(containerName, network, canonicalAgentId, {
        instanceKey = canonicalAgentId,
        contractHash,
    } = {}) {
        const record = inspectContainer(containerName);
        if (!record) return false;
        const expectedHash = String(contractHash || '');
        const labels = labelsOf(record);
        if (String(labels['io.assistos.ploinky.workspace'] || '') !== identity.hash
            || !expectedHash
            || String(labels['io.assistos.ploinky.network-contract'] || '') !== expectedHash) {
            return false;
        }
        const alias = deriveNetworkAlias(canonicalAgentId);
        const expected = logicalNetworkAttachments(network, canonicalAgentId, { instanceKey })
            .map((entry) => physicalNetworkName(identity.hash, entry.name))
            .sort();
        const attached = record.NetworkSettings?.Networks || {};
        const observed = Object.keys(attached).sort();
        if (JSON.stringify(observed) !== JSON.stringify(expected)) return false;
        return expected.every((name) => {
            const aliases = [...(attached[name]?.Aliases || [])].map(String).sort();
            return JSON.stringify(aliases) === JSON.stringify(exactRuntimeAliases(record, alias));
        });
    }

    function pruneUnlocked() {
        ensureRootlessPodman();
        const report = { removed: [], preserved: [] };
        const records = status().networks;
        const removable = [];
        for (const record of records) {
            if (record.ownership !== 'owned') { report.preserved.push({ ...record, name: record.physicalName, reason: 'foreign' }); continue; }
            const inspected = inspectNetwork(record.physicalName);
            try {
                assertSupportedNetwork(inspected, record.physicalName, expectedNetworkLabels(identity.hash, record.logicalName));
            } catch (error) {
                report.preserved.push({ ...record, name: record.physicalName, reason: `unsupported: ${error.message}` });
                continue;
            }
            const containers = inspected?.Containers || inspected?.containers || {};
            const active = Object.keys(containers).filter((id) => {
                const name = containers[id]?.Name || containers[id]?.name || '';
                return name !== gatewayContainerName(identity.hash);
            });
            if (active.length) { report.preserved.push({ ...record, name: record.physicalName, reason: 'in-use' }); continue; }
            removable.push({ ...record, name: record.physicalName });
        }
        const gateway = gatewayContainerName(identity.hash);
        const gatewayRecord = inspectContainer(gateway);
        if (gatewayRecord) {
            assertGatewayRecord(gatewayRecord, [], podmanSelinuxEnabled(), { requireRunning: false });
            const allOwnedRemovable = records.filter((record) => record.ownership === 'owned').length === removable.length;
            if (allOwnedRemovable) execute(['rm', '-f', gateway]);
            else for (const record of removable) execute(['network', 'disconnect', record.name, gateway]);
        }
        for (const record of removable) {
            const removed = execute(['network', 'rm', record.name]);
            if (removed.ok || missing(removed)) report.removed.push(record.name);
            else report.preserved.push({ ...record, reason: failure(removed) });
        }
        if (status().networks.filter((record) => record.ownership === 'owned').length === 0) {
            const inspected = inspectContainer(gateway);
            if (inspected) {
                assertGatewayRecord(inspected, [], podmanSelinuxEnabled(), { requireRunning: false });
                execute(['rm', '-f', gateway]);
            }
        }
        return report;
    }

    function prune() {
        return withNetworkLifecycleLock(pruneUnlocked, { lockPath });
    }

    return {
        identity,
        preflight,
        prepare,
        finalizeContainer,
        runManagedContainerTransaction,
        verifyContainerContract,
        status,
        prune,
        ensureNetwork,
        ensureGateway,
    };
}
