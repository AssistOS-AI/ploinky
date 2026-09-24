// Operator-granted GPU access for named agents in one workspace Box.
//
// `ploinky gpu grant --agent REPO/AGENT` records the operator decision
// in the host-only `~/.ploinky-box/gpu-grants/<instance>.json`, never in the
// workspace, because agents can write the workspace bind. Host discovery then
// derives the exact wiring for the outer Box: explicit `--device` nodes, one
// read-only bind per driver library (under its soname in
// `/usr/local/nvidia/lib64`), a read-only `nvidia-smi`, a hookless CDI spec at
// `/etc/cdi/ploinky-gpu.json` for the nested Podman, and a read-only grant
// marker that in-Box admission checks. The wiring is content addressed: its
// fingerprint names the generation directory holding the spec and marker, and
// it is recorded on the Box as a label. A changed fingerprint (a new grant or
// a driver update) is a Box replacement reason. When discovery fails the Box is
// wired only with a marker that says the grant is stale, so the rest of the
// workspace keeps running and only GPU-requesting agents fail admission.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    BOX_GPU_BIN_DIRECTORY,
    BOX_GPU_CDI_DEVICE,
    BOX_GPU_CDI_KIND,
    BOX_GPU_CDI_SPEC_PATH,
    BOX_GPU_LIBRARY_DIRECTORY,
    BOX_GPU_MARKER_PATH,
    BOX_LABELS,
    GPU_GRANT_STATE_DIRECTORY,
} from './constants.mjs';
import { PloinkyBoxError } from './errors.mjs';
import { assertRouterBindingStateConfined } from './routerBinding.mjs';
import {
    GPU_GRANT_MARKER_KIND,
    GPU_GRANT_MARKER_VERSION,
    normalizeGpuAgentSelector,
} from './lib/gpuGrantMarker.mjs';

export { GPU_GRANT_STATE_DIRECTORY };
export const GPU_GRANT_STATE_VERSION = 1;
export const GPU_GRANT_STATE_MAX_BYTES = 16 * 1024;
export const GPU_GRANT_VENDORS = Object.freeze(['nvidia']);

const BOX_BASE_DEVICES = Object.freeze(['/dev/fuse', '/dev/net/tun']);
const NVIDIA_DEVICE_NODES = Object.freeze(['/dev/nvidia0', '/dev/nvidiactl', '/dev/nvidia-uvm']);
// Measured on CUDA workloads: the driver API library, the PTX JIT that some
// runtimes load, and NVML for nvidia-smi are required. NVVM and gpucomp are
// bound when present.
const NVIDIA_REQUIRED_LIBRARIES = Object.freeze([
    'libcuda.so.1',
    'libnvidia-ptxjitcompiler.so.1',
    'libnvidia-ml.so.1',
]);
const NVIDIA_OPTIONAL_LIBRARIES = Object.freeze(['libnvidia-nvvm.so.4']);
const NVIDIA_SMI_CANDIDATES = Object.freeze([
    '/usr/bin/nvidia-smi',
    '/usr/local/bin/nvidia-smi',
    '/bin/nvidia-smi',
    '/usr/sbin/nvidia-smi',
]);
const LDCONFIG_CANDIDATES = Object.freeze(['/usr/sbin/ldconfig', '/sbin/ldconfig']);
const SONAME_RE = /^lib[A-Za-z0-9._+-]+\.so(?:\.[0-9]+)+$/;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const RECORD_KEYS = Object.freeze([
    'admitted',
    'agents',
    'instance',
    'pathHash',
    'vendor',
    'version',
    'workspaceRoot',
]);

function grantError(message, code = 'PLOINKY_BOX_GPU_GRANT_INVALID', cause) {
    return new PloinkyBoxError(message, { code, cause });
}

function discoveryError(message, cause) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_GPU_DISCOVERY_FAILED', cause });
}

function stateError(message, cause) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_GPU_GRANT_STATE_INVALID', cause });
}

function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function exactIdentity(identity) {
    const instance = String(identity?.instance || '');
    if (!/^ploinky-box-[a-z0-9-]+-[a-f0-9]{12}$/.test(instance)
        || !/^[a-f0-9]{12}$/.test(String(identity?.pathHash || ''))
        || !path.isAbsolute(String(identity?.workspaceRoot || ''))) {
        throw stateError('GPU grant state requires the exact workspace identity');
    }
    return identity;
}

/** The vendor a grant uses when --vendor is omitted: the only supported one. */
export function defaultGpuVendor(vendors = GPU_GRANT_VENDORS) {
    if (vendors.length === 1) return vendors[0];
    throw grantError(`Several GPU vendors are supported; choose one with --vendor; supported: ${vendors.join(', ')}`);
}

export function normalizeGpuVendor(value) {
    const vendor = String(value || '').trim().toLowerCase();
    if (!GPU_GRANT_VENDORS.includes(vendor)) {
        throw grantError(
            `Unsupported GPU vendor ${JSON.stringify(String(value || ''))}; supported: ${GPU_GRANT_VENDORS.join(', ')}`,
        );
    }
    return vendor;
}

export function normalizeGpuAgentSelectors(values) {
    if (!Array.isArray(values)) throw grantError('GPU grant agents must be a list of REPO/AGENT selectors');
    const normalized = [...new Set(values.map((value) => {
        try {
            return normalizeGpuAgentSelector(value);
        } catch (error) {
            throw grantError(error.message, 'PLOINKY_BOX_GPU_GRANT_INVALID', error);
        }
    }))].sort();
    if (normalized.length > 64) throw grantError('A GPU grant names at most 64 agents');
    return Object.freeze(normalized);
}

/** Operator decision: a vendor and the agents that may request the GPU. */
export function normalizeGpuGrant(grant) {
    if (!grant) return null;
    const agents = normalizeGpuAgentSelectors(grant.agents);
    if (agents.length === 0) throw grantError('A GPU grant names at least one agent (--agent REPO/AGENT)');
    return Object.freeze({ vendor: normalizeGpuVendor(grant.vendor), agents });
}

// ---------------------------------------------------------------------------
// Host discovery
// ---------------------------------------------------------------------------

function defaultReadLdconfig() {
    for (const candidate of LDCONFIG_CANDIDATES) {
        const result = spawnSync(candidate, ['-p'], { encoding: 'utf8', timeout: 10_000 });
        if (result.error?.code === 'ENOENT') continue;
        if (result.status !== 0) {
            throw discoveryError(`${candidate} -p failed with status ${result.status}`);
        }
        return String(result.stdout || '');
    }
    throw discoveryError('ldconfig was not found, so the NVIDIA driver libraries cannot be located');
}

/** Map each x86-64 soname to its first (highest-priority) ldconfig entry. */
export function parseLdconfigCache(output) {
    const entries = new Map();
    for (const line of String(output || '').split('\n')) {
        const match = /^\s*(\S+)\s+\(([^)]*)\)\s+=>\s+(\S+)\s*$/.exec(line);
        if (!match) continue;
        const [, soname, flags, target] = match;
        if (!flags.split(',').includes('x86-64') || !path.isAbsolute(target)) continue;
        if (!entries.has(soname)) entries.set(soname, target);
    }
    return entries;
}

export function parseNvidiaDriverVersion(text) {
    const match = /Kernel Module(?:\s+for\s+\S+)?\s+([0-9]+(?:\.[0-9]+)+)/.exec(String(text || ''));
    return match ? match[1] : null;
}

function deviceNumbers(rdev) {
    const value = BigInt(rdev);
    const major = Number(((value >> 8n) & 0xfffn) | ((value >> 32n) & ~0xfffn));
    const minor = Number((value & 0xffn) | ((value >> 12n) & ~0xffn));
    return { major, minor };
}

function describeFile(fsApi, source, label) {
    let real;
    try {
        real = fsApi.realpathSync(source);
    } catch (error) {
        throw discoveryError(`${label} ${source} cannot be resolved: ${error.code || error.message}`, error);
    }
    let stat;
    try {
        stat = fsApi.statSync(real);
        fsApi.accessSync(real, fs.constants.R_OK);
    } catch (error) {
        throw discoveryError(`${label} ${real} is not readable: ${error.code || error.message}`, error);
    }
    if (!stat.isFile()) throw discoveryError(`${label} ${real} is not a regular file`);
    return { source: real, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
}

/**
 * Discover the NVIDIA device nodes, driver libraries and nvidia-smi on this
 * host. Refuses, naming the item, when anything is missing, inaccessible to
 * this rootless user, or when the loaded kernel module and the userspace
 * libraries disagree (a driver updated but not yet rebooted).
 */
export function discoverNvidiaGpu({
    fsApi = fs,
    procVersionPath = '/proc/driver/nvidia/version',
    readLdconfig = defaultReadLdconfig,
    smiCandidates = NVIDIA_SMI_CANDIDATES,
} = {}) {
    let versionText;
    try {
        versionText = fsApi.readFileSync(procVersionPath, 'utf8');
    } catch (error) {
        throw discoveryError(
            `The NVIDIA kernel module is not loaded (${procVersionPath}: ${error.code || error.message})`,
            error,
        );
    }
    const driverVersion = parseNvidiaDriverVersion(versionText);
    if (!driverVersion) throw discoveryError(`Unable to read the NVIDIA kernel module version from ${procVersionPath}`);

    const devices = NVIDIA_DEVICE_NODES.map((devicePath) => {
        let stat;
        try {
            stat = fsApi.statSync(devicePath);
        } catch (error) {
            throw discoveryError(
                `NVIDIA device node ${devicePath} is missing (${error.code || error.message}); `
                + 'rootless Ploinky cannot create device nodes',
                error,
            );
        }
        if (!stat.isCharacterDevice()) throw discoveryError(`${devicePath} is not a character device`);
        try {
            fsApi.accessSync(devicePath, fs.constants.R_OK | fs.constants.W_OK);
        } catch (error) {
            throw discoveryError(
                `NVIDIA device node ${devicePath} is not readable and writable by this user (${error.code || error.message})`,
                error,
            );
        }
        return { path: devicePath, ...deviceNumbers(stat.rdev) };
    });

    const cache = parseLdconfigCache(readLdconfig());
    const versionedName = (source) => path.basename(source).endsWith(`.so.${driverVersion}`);
    const libraries = [];
    for (const soname of NVIDIA_REQUIRED_LIBRARIES) {
        const target = cache.get(soname);
        if (!target) throw discoveryError(`NVIDIA driver library ${soname} is not in the ldconfig cache`);
        const file = describeFile(fsApi, target, `NVIDIA driver library ${soname}`);
        if (!versionedName(file.source)) {
            throw discoveryError(
                `NVIDIA driver version mismatch: the kernel module is ${driverVersion} but ${soname} is `
                + `${path.basename(file.source)}; reboot after a driver update`,
            );
        }
        libraries.push({ soname, ...file });
    }
    for (const soname of [...NVIDIA_OPTIONAL_LIBRARIES, `libnvidia-gpucomp.so.${driverVersion}`]) {
        const target = cache.get(soname);
        if (!target) continue;
        const file = describeFile(fsApi, target, `NVIDIA driver library ${soname}`);
        if (!versionedName(file.source)) {
            throw discoveryError(
                `NVIDIA driver version mismatch: the kernel module is ${driverVersion} but ${soname} is `
                + `${path.basename(file.source)}; reboot after a driver update`,
            );
        }
        libraries.push({ soname, ...file });
    }

    const smi = smiCandidates.find((candidate) => {
        try {
            return fsApi.statSync(candidate).isFile();
        } catch {
            return false;
        }
    });
    if (!smi) throw discoveryError(`nvidia-smi was not found (checked ${smiCandidates.join(', ')})`);
    const tool = describeFile(fsApi, smi, 'nvidia-smi');

    return Object.freeze({
        vendor: 'nvidia',
        driverVersion,
        devices: Object.freeze(devices.map((entry) => Object.freeze(entry))),
        libraries: Object.freeze(libraries.map((entry) => Object.freeze(entry))),
        tools: Object.freeze([Object.freeze({ name: 'nvidia-smi', ...tool })]),
    });
}

export function discoverGpu(vendor, options = {}) {
    if (normalizeGpuVendor(vendor) === 'nvidia') return discoverNvidiaGpu(options);
    throw grantError(`Unsupported GPU vendor ${vendor}`);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function stateRootFor(homeDirectory) {
    return path.join(path.resolve(homeDirectory), '.ploinky-box');
}

export function gpuGrantDirectory(homeDirectory = os.homedir()) {
    return path.join(stateRootFor(homeDirectory), GPU_GRANT_STATE_DIRECTORY);
}

export function gpuGenerationDirectory(identity, fingerprint, homeDirectory = os.homedir()) {
    exactIdentity(identity);
    if (!FINGERPRINT_RE.test(String(fingerprint))) throw stateError('GPU wiring fingerprint is invalid');
    return path.join(gpuGrantDirectory(homeDirectory), identity.instance, fingerprint);
}

function singleLine(text, limit = 300) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export function renderBoxCdiSpec(discovery) {
    return `${JSON.stringify({
        cdiVersion: '0.6.0',
        kind: BOX_GPU_CDI_KIND,
        devices: [{
            name: BOX_GPU_CDI_DEVICE.split('=')[1],
            containerEdits: {
                deviceNodes: discovery.devices.map((device) => ({ path: device.path })),
            },
        }],
        containerEdits: {
            mounts: [
                ...discovery.libraries.map((library) => path.posix.join(BOX_GPU_LIBRARY_DIRECTORY, library.soname)),
                ...discovery.tools.map((tool) => path.posix.join(BOX_GPU_BIN_DIRECTORY, tool.name)),
            ].map((inBoxPath) => ({
                hostPath: inBoxPath,
                containerPath: inBoxPath,
                options: ['ro', 'nosuid', 'nodev', 'bind'],
            })),
        },
    }, null, 2)}\n`;
}

/**
 * Desired Box GPU wiring for one workspace, derived from the operator grant
 * and either a successful host discovery (active) or its failure (stale).
 * Returns null when there is no grant.
 */
export function buildGpuWiring({
    identity,
    grant,
    discovery = null,
    failure = null,
    homeDirectory = os.homedir(),
}) {
    exactIdentity(identity);
    const normalizedGrant = normalizeGpuGrant(grant);
    if (!normalizedGrant) return null;
    if (!discovery && !failure) throw grantError('GPU wiring requires a discovery result or its failure');
    const state = discovery ? 'active' : 'stale';
    const reason = discovery ? null : singleLine(failure?.message || failure);
    // The fingerprint binds the exact workspace, the operator decision and the
    // discovered driver files, so it names one generation of one workspace.
    const fingerprint = sha256(canonicalJson({
        version: 1,
        instance: identity.instance,
        pathHash: identity.pathHash,
        workspaceRoot: identity.workspaceRoot,
        vendor: normalizedGrant.vendor,
        agents: normalizedGrant.agents,
        state,
        reason,
        driverVersion: discovery?.driverVersion ?? null,
        devices: discovery?.devices ?? [],
        libraries: discovery?.libraries ?? [],
        tools: discovery?.tools ?? [],
    }));
    const generation = gpuGenerationDirectory(identity, fingerprint, homeDirectory);
    const specText = discovery ? renderBoxCdiSpec(discovery) : null;
    const markerText = `${JSON.stringify({
        version: GPU_GRANT_MARKER_VERSION,
        kind: GPU_GRANT_MARKER_KIND,
        instance: identity.instance,
        pathHash: identity.pathHash,
        workspaceRoot: identity.workspaceRoot,
        vendor: normalizedGrant.vendor,
        agents: normalizedGrant.agents,
        state,
        reason,
        fingerprint,
        cdiDevice: discovery ? BOX_GPU_CDI_DEVICE : null,
        specSha256: specText ? sha256(specText) : null,
    }, null, 2)}\n`;
    const specPath = path.join(generation, 'box.json');
    const markerPath = path.join(generation, 'marker.json');
    const mounts = [
        ...(discovery ? [
            ...discovery.libraries.map((library) => ({
                source: library.source,
                destination: path.posix.join(BOX_GPU_LIBRARY_DIRECTORY, library.soname),
            })),
            ...discovery.tools.map((tool) => ({
                source: tool.source,
                destination: path.posix.join(BOX_GPU_BIN_DIRECTORY, tool.name),
            })),
            { source: specPath, destination: BOX_GPU_CDI_SPEC_PATH },
        ] : []),
        { source: markerPath, destination: BOX_GPU_MARKER_PATH },
    ].sort((left, right) => left.destination.localeCompare(right.destination));
    return Object.freeze({
        fingerprint,
        state,
        reason,
        vendor: normalizedGrant.vendor,
        agents: normalizedGrant.agents,
        driverVersion: discovery?.driverVersion ?? null,
        devices: Object.freeze((discovery?.devices ?? []).map((device) => device.path)),
        mounts: Object.freeze(mounts.map((mount) => Object.freeze(mount))),
        files: Object.freeze([
            ...(specText ? [Object.freeze({ path: specPath, content: specText })] : []),
            Object.freeze({ path: markerPath, content: markerText }),
        ]),
    });
}

/** The operator grant plus a fresh discovery; discovery failure means stale. */
export function resolveGpuWiring(identity, grant, {
    discover = discoverGpu,
    homeDirectory = os.homedir(),
} = {}) {
    const normalizedGrant = normalizeGpuGrant(grant);
    if (!normalizedGrant) return null;
    try {
        return buildGpuWiring({
            identity,
            grant: normalizedGrant,
            discovery: discover(normalizedGrant.vendor),
            homeDirectory,
        });
    } catch (error) {
        if (error?.code !== 'PLOINKY_BOX_GPU_DISCOVERY_FAILED') throw error;
        return buildGpuWiring({ identity, grant: normalizedGrant, failure: error, homeDirectory });
    }
}

export function sameGpuWiring(left, right) {
    return (left?.fingerprint ?? null) === (right?.fingerprint ?? null);
}

export const GPU_WORKSPACE_FILE_MAX_BYTES = 1024 * 1024;

const WORKSPACE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

// Agents can write these workspace files, so anything that is not a small,
// non-symlink regular file holding JSON counts as absent.
function readWorkspaceJson(fsApi, target, maxBytes) {
    let descriptor;
    try {
        descriptor = fsApi.openSync(
            target,
            fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW | fsApi.constants.O_NONBLOCK,
        );
    } catch {
        return null;
    }
    try {
        const stat = fsApi.fstatSync(descriptor);
        if (!stat.isFile() || stat.size > maxBytes) return null;
        return JSON.parse(fsApi.readFileSync(descriptor, 'utf8'));
    } catch {
        return null;
    } finally {
        fsApi.closeSync(descriptor);
    }
}

function requestsCdiDevice(llmRuntime) {
    const devices = llmRuntime?.runtimePolicy?.devices;
    return Array.isArray(devices) && devices.some((entry) => entry?.type === 'cdi');
}

/**
 * Enabled agents, as REPO/AGENT, whose manifest or selected profile requests a
 * CDI device. Read from the workspace agent registry, the routing file (the
 * manifest directory of each route) and the manifests. Agents can write all of
 * these, so a caller may use the result only to refuse early; unreadable
 * entries are skipped and admission during the graph start stays the authority.
 */
export function enabledCdiRequestingAgents(workspaceRoot, {
    fsApi = fs,
    maxBytes = GPU_WORKSPACE_FILE_MAX_BYTES,
} = {}) {
    const stateDirectory = path.join(String(workspaceRoot || ''), '.ploinky');
    if (!path.isAbsolute(stateDirectory)) return [];
    const registry = readWorkspaceJson(fsApi, path.join(stateDirectory, 'agents.json'), maxBytes);
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return [];
    const routing = readWorkspaceJson(fsApi, path.join(stateDirectory, 'routing.json'), maxBytes);
    const routes = routing?.routes && typeof routing.routes === 'object' ? Object.values(routing.routes) : [];
    const requesting = new Set();
    for (const record of Object.values(registry)) {
        if (record?.type !== 'agent') continue;
        const repo = String(record.repoName || '');
        const agent = String(record.agentName || '');
        if (!WORKSPACE_NAME.test(repo) || !WORKSPACE_NAME.test(agent)) continue;
        const route = routes.find((entry) => entry?.repo === repo && entry?.agent === agent
            && typeof entry.hostPath === 'string' && path.isAbsolute(entry.hostPath));
        const agentDirectory = route ? route.hostPath : path.join(stateDirectory, 'repos', repo, agent);
        const manifest = readWorkspaceJson(fsApi, path.join(agentDirectory, 'manifest.json'), maxBytes);
        if (!manifest || typeof manifest !== 'object') continue;
        const profiles = manifest.profiles && typeof manifest.profiles === 'object' ? manifest.profiles : {};
        const profile = profiles[String(record.profile || 'default')];
        if (requestsCdiDevice(manifest.llmRuntime) || requestsCdiDevice(profile?.llmRuntime)) {
            requesting.add(`${repo}/${agent}`);
        }
    }
    return [...requesting].sort();
}

/** Container create arguments for a wiring: devices, read-only binds, label. */
export function gpuWiringCreateArgs(wiring) {
    if (!wiring) return Object.freeze({ devices: [], volumes: [], labels: {} });
    return Object.freeze({
        devices: wiring.devices.flatMap((device) => ['--device', device]),
        volumes: wiring.mounts.flatMap((mount) => ['--volume', `${mount.source}:${mount.destination}:ro`]),
        labels: { [BOX_LABELS.gpuGrant]: wiring.fingerprint },
    });
}

function isGpuMountDestination(destination) {
    return destination === BOX_GPU_CDI_SPEC_PATH
        || destination === BOX_GPU_MARKER_PATH
        || destination.startsWith(`${BOX_GPU_LIBRARY_DIRECTORY}/`)
        || destination.startsWith(`${BOX_GPU_BIN_DIRECTORY}/`);
}

function repeatedOptionValues(argv, option) {
    if (!Array.isArray(argv)) return null;
    const result = [];
    for (let index = 0; index < argv.length; index += 1) {
        const argument = String(argv[index]);
        if (argument === option) {
            if (index + 1 >= argv.length) return null;
            result.push(String(argv[index + 1]));
            index += 1;
        } else if (argument.startsWith(`${option}=`)) {
            result.push(argument.slice(option.length + 1));
        }
    }
    return result;
}

function wiringObservationError(message) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_PUBLICATION_INCOMPATIBLE' });
}

/**
 * Reconstruct the GPU wiring an owned Box records, from its own label, create
 * command and mounts, never from a fresh discovery: an old Box has to be
 * validated and, if needed, restored exactly as it was created.
 *
 * Only the GPU part is reconstructed here. Any other device or mount stays
 * for the Box contract's exact-set checks to reject with their own errors.
 *
 * @returns {Readonly<object>|null} null for a Box without a GPU grant label
 */
export function observeContainerGpuWiring(containerHandle, { homeDirectory = os.homedir(), identity = null } = {}) {
    const labels = containerHandle?.labels || {};
    const runtime = containerHandle?.runtime || {};
    if (!Object.hasOwn(labels, BOX_LABELS.gpuGrant)) return null;
    const recordedDevices = repeatedOptionValues(runtime.createCommand, '--device') || [];
    const extraDevices = recordedDevices
        .filter((device) => !BOX_BASE_DEVICES.includes(device) && /^\/dev\/nvidia[a-z0-9-]*$/.test(device));
    const gpuMounts = (Array.isArray(runtime.mounts) ? runtime.mounts : [])
        .filter((mount) => isGpuMountDestination(String(mount.destination || '')));
    const fingerprint = String(labels[BOX_LABELS.gpuGrant]);
    if (!FINGERPRINT_RE.test(fingerprint)) throw wiringObservationError('Owned Box GPU grant label is invalid');
    const instance = identity?.instance
        || (typeof containerHandle?.name === 'string' ? containerHandle.name : '');
    const generation = identity
        ? gpuGenerationDirectory(identity, fingerprint, homeDirectory)
        : null;
    const mounts = gpuMounts.map((mount) => {
        const destination = String(mount.destination);
        const source = String(mount.source || '');
        if (String(mount.type).toLowerCase() !== 'bind' || mount.rw === true || !path.isAbsolute(source)) {
            throw wiringObservationError(`Owned Box GPU mount ${destination} is not a read-only bind`);
        }
        if (destination.startsWith(`${BOX_GPU_LIBRARY_DIRECTORY}/`)
            && !SONAME_RE.test(path.posix.basename(destination))) {
            throw wiringObservationError(`Owned Box GPU library mount ${destination} is invalid`);
        }
        if (destination.startsWith(`${BOX_GPU_BIN_DIRECTORY}/`)
            && destination !== path.posix.join(BOX_GPU_BIN_DIRECTORY, 'nvidia-smi')) {
            throw wiringObservationError(`Owned Box GPU tool mount ${destination} is invalid`);
        }
        if (generation && destination === BOX_GPU_MARKER_PATH && source !== path.join(generation, 'marker.json')) {
            throw wiringObservationError('Owned Box GPU grant marker is not its generation marker');
        }
        if (generation && destination === BOX_GPU_CDI_SPEC_PATH && source !== path.join(generation, 'box.json')) {
            throw wiringObservationError('Owned Box GPU CDI spec is not its generation spec');
        }
        return Object.freeze({ source, destination });
    }).sort((left, right) => left.destination.localeCompare(right.destination));
    if (!mounts.some((mount) => mount.destination === BOX_GPU_MARKER_PATH)) {
        throw wiringObservationError('Owned Box GPU grant label has no grant marker mount');
    }
    const active = mounts.some((mount) => mount.destination === BOX_GPU_CDI_SPEC_PATH);
    if (!active && (extraDevices.length || mounts.length !== 1)) {
        throw wiringObservationError('Owned Box stale GPU grant still has GPU devices or libraries');
    }
    return Object.freeze({
        fingerprint,
        state: active ? 'active' : 'stale',
        instance,
        devices: Object.freeze(extraDevices),
        mounts: Object.freeze(mounts),
    });
}

// ---------------------------------------------------------------------------
// Host-only state: the grant record and the generation files
// ---------------------------------------------------------------------------

function assertLock(identity, lock) {
    if (typeof lock?.assertHeld !== 'function') {
        throw stateError('Changing GPU grant state requires the workspace mutation lock');
    }
    lock.assertHeld(identity.instance);
}

function ensurePrivateDirectory(fsApi, target) {
    try {
        fsApi.mkdirSync(target, { mode: 0o700 });
    } catch (error) {
        if (error?.code !== 'EEXIST') throw stateError(`Unable to create GPU grant state directory: ${target}`, error);
    }
    const stat = fsApi.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw stateError(`GPU grant state path is not a real directory: ${target}`);
    }
    const uid = currentUid();
    if (uid !== null && stat.uid !== uid) {
        throw stateError(`GPU grant state directory is not owned by the current user: ${target}`);
    }
    fsApi.chmodSync(target, 0o700);
}

function assertPrivateDirectoryIfPresent(fsApi, target) {
    let stat;
    try {
        stat = fsApi.lstatSync(target);
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw stateError(`Unable to inspect GPU grant state directory: ${target}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw stateError(`GPU grant state path is not a real directory: ${target}`);
    }
    const uid = currentUid();
    if (uid !== null && stat.uid !== uid) {
        throw stateError(`GPU grant state directory is not owned by the current user: ${target}`);
    }
    if ((stat.mode & 0o022) !== 0) {
        throw stateError(`GPU grant state directory must not be group- or world-writable: ${target}`);
    }
    return true;
}

function readPrivateFile(fsApi, target, maxBytes, label) {
    let descriptor;
    try {
        descriptor = fsApi.openSync(
            target,
            fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW | fsApi.constants.O_NONBLOCK,
        );
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw stateError(`${label} must be a readable non-symlink file: ${target}`, error);
    }
    try {
        const before = fsApi.fstatSync(descriptor);
        if (!before.isFile() || before.nlink !== 1) {
            throw stateError(`${label} must be one non-linked regular file: ${target}`);
        }
        const uid = currentUid();
        if (uid !== null && before.uid !== uid) throw stateError(`${label} must be owned by the current user: ${target}`);
        if ((before.mode & 0o077) !== 0) throw stateError(`${label} must be private to the current user (mode 0600): ${target}`);
        if (before.size > maxBytes) throw stateError(`${label} exceeds ${maxBytes} bytes: ${target}`);
        const bytes = fsApi.readFileSync(descriptor);
        const after = fsApi.fstatSync(descriptor);
        if (bytes.length !== before.size || after.size !== before.size
            || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
            throw stateError(`${label} changed while being read: ${target}`);
        }
        return bytes;
    } finally {
        fsApi.closeSync(descriptor);
    }
}

function writePrivateFileAtomically(fsApi, directory, target, content, beforeRename) {
    try {
        const existing = fsApi.lstatSync(target);
        if (!existing.isFile() || existing.isSymbolicLink()) {
            throw stateError(`Refusing to replace a non-regular GPU grant state path: ${target}`);
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    const temporary = path.join(directory, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
    let descriptor;
    try {
        descriptor = fsApi.openSync(
            temporary,
            fsApi.constants.O_WRONLY | fsApi.constants.O_CREAT | fsApi.constants.O_EXCL | fsApi.constants.O_NOFOLLOW,
            0o600,
        );
        fsApi.writeFileSync(descriptor, content);
        fsApi.fsyncSync(descriptor);
        fsApi.closeSync(descriptor);
        descriptor = undefined;
        beforeRename();
        fsApi.renameSync(temporary, target);
    } finally {
        if (descriptor !== undefined) fsApi.closeSync(descriptor);
        try { fsApi.unlinkSync(temporary); } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
}

/**
 * Host-only, per-workspace GPU grant record and generation files.
 *
 * @param {{ homeDirectory?: string, fsApi?: typeof fs }} [options]
 */
export function createGpuGrantStore({
    homeDirectory = os.homedir(),
    fsApi = fs,
} = {}) {
    const stateRoot = stateRootFor(homeDirectory);
    const directory = gpuGrantDirectory(homeDirectory);

    function targetFor(identity) {
        return path.join(directory, `${exactIdentity(identity).instance}.json`);
    }

    function instanceDirectory(identity) {
        return path.join(directory, exactIdentity(identity).instance);
    }

    function assertConfined(identity) {
        return assertRouterBindingStateConfined(identity, { homeDirectory, fsApi });
    }

    function normalizeAdmitted(value) {
        if (value === null) return null;
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['fingerprint', 'reason', 'state'])
            || !FINGERPRINT_RE.test(String(value.fingerprint))
            || !['active', 'stale'].includes(value.state)
            || (value.reason !== null && typeof value.reason !== 'string')) {
            throw stateError('Saved GPU grant has an invalid admitted wiring');
        }
        return Object.freeze({ fingerprint: value.fingerprint, state: value.state, reason: value.reason });
    }

    function normalizeRecord(identity, record) {
        exactIdentity(identity);
        if (!record || typeof record !== 'object' || Array.isArray(record)
            || Object.getPrototypeOf(record) !== Object.prototype
            || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(RECORD_KEYS)) {
            throw stateError('Saved GPU grant has an unsupported schema');
        }
        if (record.version !== GPU_GRANT_STATE_VERSION) {
            throw stateError(`Saved GPU grant version ${JSON.stringify(record.version)} is unsupported`);
        }
        if (record.instance !== identity.instance
            || record.pathHash !== identity.pathHash
            || record.workspaceRoot !== identity.workspaceRoot) {
            throw stateError('Saved GPU grant belongs to another workspace');
        }
        let grant;
        try {
            grant = normalizeGpuGrant({ vendor: record.vendor, agents: record.agents });
        } catch (error) {
            throw stateError(`Saved GPU grant is invalid: ${error.message}`, error);
        }
        return Object.freeze({ ...grant, admitted: normalizeAdmitted(record.admitted) });
    }

    /** @returns {Readonly<object>|null} null when the workspace has no grant */
    function read(identity) {
        const target = targetFor(identity);
        assertConfined(identity);
        if (!assertPrivateDirectoryIfPresent(fsApi, stateRoot)
            || !assertPrivateDirectoryIfPresent(fsApi, directory)) return null;
        const bytes = readPrivateFile(fsApi, target, GPU_GRANT_STATE_MAX_BYTES, 'Saved GPU grant');
        if (!bytes) return null;
        let record;
        try {
            record = JSON.parse(bytes.toString('utf8'));
        } catch (error) {
            throw stateError(`Saved GPU grant is not valid JSON: ${target}`, error);
        }
        return normalizeRecord(identity, record);
    }

    function write(identity, grant, lock, { admitted = null } = {}) {
        exactIdentity(identity);
        assertLock(identity, lock);
        const normalized = normalizeGpuGrant(grant);
        if (!normalized) throw stateError('Saving a GPU grant requires a vendor and agents');
        const admittedValue = normalizeAdmitted(admitted);
        assertConfined(identity);
        ensurePrivateDirectory(fsApi, stateRoot);
        ensurePrivateDirectory(fsApi, directory);
        assertConfined(identity);
        const record = {
            version: GPU_GRANT_STATE_VERSION,
            instance: identity.instance,
            pathHash: identity.pathHash,
            workspaceRoot: identity.workspaceRoot,
            vendor: normalized.vendor,
            agents: normalized.agents,
            admitted: admittedValue,
        };
        writePrivateFileAtomically(fsApi, directory, targetFor(identity), `${JSON.stringify(record)}\n`, () => {
            lock.assertHeld(identity.instance);
            assertConfined(identity);
        });
        return Object.freeze({ ...normalized, admitted: admittedValue });
    }

    function clear(identity, lock) {
        exactIdentity(identity);
        assertLock(identity, lock);
        assertConfined(identity);
        if (!assertPrivateDirectoryIfPresent(fsApi, stateRoot)
            || !assertPrivateDirectoryIfPresent(fsApi, directory)) return false;
        const target = targetFor(identity);
        let stat;
        try {
            stat = fsApi.lstatSync(target);
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw stateError(`Unable to inspect saved GPU grant: ${target}`, error);
        }
        if (!stat.isFile() && !stat.isSymbolicLink()) {
            throw stateError(`Refusing to remove a non-regular GPU grant state path: ${target}`);
        }
        fsApi.unlinkSync(target);
        return true;
    }

    /** Put back exactly the record captured before a failed mutation. */
    function restore(identity, previous, lock) {
        if (previous) write(identity, previous, lock, { admitted: previous.admitted ?? null });
        else clear(identity, lock);
    }

    /**
     * A kept wiring binds host driver files and device nodes that a driver
     * package upgrade can remove while the running Box still pins them. They
     * are checked before anything destructive, so a replacement is refused
     * instead of removing the old Box and then failing to create the new one.
     */
    function assertKeptHostSources(wiring) {
        const changed = (item, detail) => stateError(
            `GPU wiring ${wiring.fingerprint} binds ${item}, which ${detail}; the host driver changed. `
            + 'Run `ploinky restart` to rediscover the driver and regenerate the wiring.',
        );
        for (const mount of wiring.mounts) {
            if (mount.destination === BOX_GPU_MARKER_PATH || mount.destination === BOX_GPU_CDI_SPEC_PATH) continue;
            let stat;
            try {
                stat = fsApi.statSync(mount.source);
                fsApi.accessSync(mount.source, fs.constants.R_OK);
            } catch (error) {
                throw changed(mount.source, `is missing or unreadable (${error.code || error.message})`);
            }
            if (!stat.isFile()) throw changed(mount.source, 'is not a regular file');
        }
        for (const device of wiring.devices) {
            let stat;
            try {
                stat = fsApi.statSync(device);
            } catch (error) {
                throw changed(device, `is missing (${error.code || error.message})`);
            }
            if (!stat.isCharacterDevice()) throw changed(device, 'is not a character device');
        }
    }

    /**
     * Write a wiring's spec and marker into its content-addressed generation
     * directory. An existing generation must hold byte-identical files. A wiring
     * reconstructed from a Box (kept across a replacement) carries no file
     * contents: its generation must already exist, which pruning guarantees
     * while that Box exists, and it is only verified here.
     */
    function materialize(identity, wiring, lock) {
        if (!wiring) return;
        exactIdentity(identity);
        assertLock(identity, lock);
        assertConfined(identity);
        const generation = gpuGenerationDirectory(identity, wiring.fingerprint, homeDirectory);
        if (!Array.isArray(wiring.files)) {
            for (const mount of wiring.mounts) {
                if (mount.destination !== BOX_GPU_MARKER_PATH && mount.destination !== BOX_GPU_CDI_SPEC_PATH) continue;
                if (path.dirname(mount.source) !== generation) {
                    throw stateError(`GPU wiring file is outside its generation directory: ${mount.source}`);
                }
                if (!readPrivateFile(fsApi, mount.source, GPU_GRANT_STATE_MAX_BYTES, 'GPU wiring file')) {
                    throw stateError(
                        `GPU wiring file ${mount.source} is missing; run \`ploinky gpu grant\` or `
                        + '`ploinky restart` to regenerate the wiring',
                    );
                }
            }
            assertKeptHostSources(wiring);
            return;
        }
        for (const target of [stateRoot, directory, instanceDirectory(identity), generation]) {
            ensurePrivateDirectory(fsApi, target);
        }
        assertConfined(identity);
        for (const file of wiring.files) {
            if (path.dirname(file.path) !== generation) {
                throw stateError(`GPU wiring file escaped its generation directory: ${file.path}`);
            }
            const existing = readPrivateFile(fsApi, file.path, GPU_GRANT_STATE_MAX_BYTES, 'GPU wiring file');
            if (existing) {
                if (!existing.equals(Buffer.from(file.content))) {
                    throw stateError(`GPU wiring file does not match its fingerprint: ${file.path}`);
                }
                continue;
            }
            writePrivateFileAtomically(fsApi, generation, file.path, file.content, () => {
                lock.assertHeld(identity.instance);
                assertConfined(identity);
            });
        }
    }

    /** Remove every generation directory of this workspace except `keep`. */
    function prune(identity, keep, lock) {
        exactIdentity(identity);
        assertLock(identity, lock);
        assertConfined(identity);
        const root = instanceDirectory(identity);
        if (!assertPrivateDirectoryIfPresent(fsApi, stateRoot)
            || !assertPrivateDirectoryIfPresent(fsApi, directory)
            || !assertPrivateDirectoryIfPresent(fsApi, root)) return [];
        const kept = new Set([...keep].filter(Boolean));
        const removed = [];
        for (const entry of fsApi.readdirSync(root)) {
            if (kept.has(entry)) continue;
            const target = path.join(root, entry);
            const stat = fsApi.lstatSync(target);
            if (!FINGERPRINT_RE.test(entry) || stat.isSymbolicLink() || !stat.isDirectory()) {
                throw stateError(`Unexpected entry in GPU grant generations: ${target}`);
            }
            fsApi.rmSync(target, { recursive: true, force: true });
            removed.push(entry);
        }
        if (kept.size === 0 && fsApi.readdirSync(root).length === 0) fsApi.rmdirSync(root);
        return removed;
    }

    return Object.freeze({
        homeDirectory: path.resolve(homeDirectory),
        directory,
        pathFor: targetFor,
        assertConfined,
        validateRecord: normalizeRecord,
        read,
        write,
        clear,
        restore,
        materialize,
        prune,
    });
}
