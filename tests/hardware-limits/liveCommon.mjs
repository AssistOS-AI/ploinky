// Shared identity proofs for the owned-fixture live harness: digests, the
// workspace receipt and marker, the exact task-owned host record names and
// the fixed container inspect format. Test-only; nothing here runs a process.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { requireTransport } from './liveProcess.mjs';

export const ID = /^[a-f0-9]{64}$/;
export const HASH = /^sha256:[a-f0-9]{64}$/;
export const RUN_ID = /^[a-f0-9]{32}$/;
export const OWNER_MARKER = '.ploinky-hwl-owner';
// The only host record directories cleanup may touch, each holding at most an
// INSTANCE.json record and an INSTANCE generation/store directory.
export const HOST_RECORD_DIRECTORIES = Object.freeze(['hardware-limits', 'gpu-grants', 'router-bindings']);
export const IMAGE_REF = /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;

export const digest = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
export const jsonDigest = value => digest(JSON.stringify(value));

export function keys(value, required, label, optional = []) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype
        || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
        || required.some(key => !Object.hasOwn(value, key))) throw new Error(`Invalid ${label} fields`);
}
export function absolute(value) {
    return typeof value === 'string' && value.length < 4096 && !value.includes('\0')
        && path.isAbsolute(value) && path.normalize(value) === value && !value.endsWith('/');
}
export function bounded(value, max = 4096) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
export function blocked(message) { return Object.assign(new Error(message), { code: 'LIVE_PREREQUISITE_MISSING' }); }

export function receipt(value) {
    keys(value, ['path', 'uid', 'dev', 'ino', 'marker'], 'workspace receipt');
    if (!absolute(value.path) || !Number.isSafeInteger(value.uid) || value.uid < 0
        || !/^\d+$/.test(value.dev) || !/^\d+$/.test(value.ino) || !RUN_ID.test(value.marker)) {
        throw new Error('Invalid workspace receipt');
    }
}

// The quarantine name is derived from the run ID alone, so a fresh process
// can find it from the manifest after a crash.
export function quarantinePath(workspacePath, runId) {
    if (!absolute(workspacePath) || !RUN_ID.test(runId)) throw new Error('Invalid quarantine input');
    return path.join(path.dirname(workspacePath), `.hwl-removing-${runId}`);
}

// The exact task-owned host record paths for one workspace instance. Cleanup
// never globs or matches substrings; it considers only these six names.
export function hostRecordPaths(home, instance) {
    if (!absolute(home) || !/^ploinky-box-[a-z0-9-]+-[a-f0-9]{12}$/.test(String(instance))) throw new Error('Invalid host record identity');
    const root = path.join(home, '.ploinky-box');
    return HOST_RECORD_DIRECTORIES.flatMap(directory => [path.join(root, directory, `${instance}.json`), path.join(root, directory, instance)]);
}

function readMarker(directory, uid) {
    const fd = fs.openSync(path.join(directory, OWNER_MARKER), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.size !== 32) throw new Error('Ownership marker changed');
        return fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
}

// Directory identity: a real, canonical directory with the recorded owner,
// device and inode, holding the exact 32-character owner marker.
export function assertOwnedDirectory(directory, { uid, dev, ino, marker }, { allowMissingMarker = false } = {}) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
        || stat.uid !== uid || String(stat.dev) !== dev || String(stat.ino) !== ino) throw new Error(`Owned directory identity changed: ${directory}`);
    try {
        if (readMarker(directory, uid) !== marker) throw new Error(`Ownership marker changed: ${directory}`);
    } catch (error) {
        if (!(allowMissingMarker && error.code === 'ENOENT' && fs.readdirSync(directory).length === 0)) throw error;
    }
    return stat;
}

export function assertWorkspace(profile) {
    const value = profile.workspace;
    const stat = fs.lstatSync(value.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(value.path) !== value.path
        || stat.uid !== value.uid || String(stat.dev) !== value.dev || String(stat.ino) !== value.ino) throw new Error('Workspace ownership changed');
    if (readMarker(value.path, value.uid) !== value.marker) throw new Error('Workspace ownership marker changed');
    const identity = buildWorkspaceIdentity(value.path);
    if (profile.box && (identity.instance !== profile.box.instance || identity.pathHash !== profile.box.pathHash)) throw new Error('Workspace instance changed');
    return identity;
}

export function liveSourceDigest(root) {
    if (fs.realpathSync(root) !== root) throw new Error('Noncanonical candidate source');
    const rows = []; let bytes = 0;
    function walk(directory) {
        for (const name of fs.readdirSync(directory).sort()) {
            if (name === '.git') continue;
            const file = path.join(directory, name); const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink()) throw new Error('Live candidate must freeze symlink dependencies');
            if (stat.isDirectory()) walk(file);
            else if (stat.isFile()) {
                bytes += stat.size;
                if (rows.length >= 50000 || bytes > 512 * 1024 * 1024) throw new Error('Live source digest bound exceeded');
                rows.push(path.relative(root, file) + '\0' + digest(fs.readFileSync(file)));
            } else throw new Error('Special file in live candidate');
        }
    }
    walk(root); return digest(rows.join('\n'));
}

// Go-template field names are the engine's Go struct names, not the JSON keys
// of `inspect`: the identifier is `.ID` (`.Id` fails on Podman 5.7 and 6.0 with
// "can't evaluate field Id in type interface {}").
export const INSPECT = '{"id":{{json .ID}},"created":{{json .Created}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"running":{{json .State.Running}},"pid":{{json .State.Pid}},"startedAt":{{json .State.StartedAt}},"conmonPid":{{json .State.ConmonPid}},"memory":{{json .HostConfig.Memory}},"memorySwap":{{json .HostConfig.MemorySwap}},"nanoCpus":{{json .HostConfig.NanoCpus}},"cpuQuota":{{json .HostConfig.CpuQuota}},"cpuPeriod":{{json .HostConfig.CpuPeriod}},"pidsLimit":{{json .HostConfig.PidsLimit}}}';
// Nested fixture agents additionally report their name and the image
// reference they were created from.
export const AGENT_INSPECT = INSPECT.replace('{"id":', '{"name":{{json .Name}},"imageName":{{json .ImageName}},"id":');

// The minimal, version-robust query that finds a container by identity
// without parsing an inspect document: `{{.ID}} {{.Names}}` per line.
export const PS_IDENTITY_FORMAT = '{{.ID}} {{.Names}}';
export const boxPsArgv = pathHash => ['container', 'ps', '--all', '--no-trunc', '--filter', `label=${BOX_LABELS.pathHash}=${pathHash}`, '--format', PS_IDENTITY_FORMAT];

export function checkedJson(result) { requireTransport(result); return JSON.parse(result.stdout); }

// The engine service identity: stable, secret-free facts that tell one engine
// service (and, for a remote client, its connection) from another. On a
// Podman machine `.Host` alone is only {arch, os, hostname: localhost...},
// which any other machine or engine can match. A missing required fact fails
// closed; volatile facts (memory, uptime, counts) are never included.
export const ENGINE_INFO_ARGV = Object.freeze(['info', '--format', '{{json .}}']);
export const ENGINE_CONNECTIONS_ARGV = Object.freeze(['system', 'connection', 'list', '--format', 'json']);
const incompleteIdentity = message => Object.assign(new Error(message), { code: 'ENGINE_IDENTITY_INCOMPLETE' });
const identityText = (value, label) => {
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 1024 || /[\0\n]/.test(value)) throw incompleteIdentity(`Engine service identity is missing ${label}`);
    return value;
};
export function engineIdentityFacts(info, connections = null) {
    const host = info?.host; const store = info?.store; const version = info?.version;
    const facts = {
        arch: identityText(host?.arch, 'host.arch'), os: identityText(host?.os, 'host.os'),
        hostname: identityText(host?.hostname, 'host.hostname'), kernel: identityText(host?.kernel, 'host.kernel'),
        engineVersion: identityText(version?.Version, 'version.Version'),
        graphRoot: identityText(store?.graphRoot, 'store.graphRoot'), runRoot: identityText(store?.runRoot, 'store.runRoot'),
        serviceSocket: identityText(host?.remoteSocket?.path, 'host.remoteSocket.path'),
        serviceIsRemote: host?.serviceIsRemote === true,
        id: host?.id === undefined || host?.id === null ? null : identityText(String(host.id), 'host.id'),
        connection: null,
    };
    if (facts.serviceIsRemote) {
        // A remote client talks to its default connection; exactly one must exist.
        const defaults = Array.isArray(connections) ? connections.filter(entry => entry?.Default === true) : [];
        if (defaults.length !== 1) throw incompleteIdentity('Engine service identity needs exactly one default remote connection');
        facts.connection = { name: identityText(defaults[0].Name, 'connection name'), uri: identityText(defaults[0].URI, 'connection URI') };
    }
    return facts;
}
export const engineIdentityDigest = (info, connections = null) => jsonDigest(engineIdentityFacts(info, connections));
// Observe the identity through one bounded command runner `run(kind, argv)`.
export async function observeEngineIdentity(run) {
    const info = checkedJson(await run('engine-identity', [...ENGINE_INFO_ARGV]));
    const connections = info?.host?.serviceIsRemote === true ? checkedJson(await run('engine-connection', [...ENGINE_CONNECTIONS_ARGV])) : null;
    return engineIdentityDigest(info, connections);
}

// Unix socket paths are bounded by the kernel's sun_path: 108 bytes on Linux,
// including the terminating NUL. The Box bind-mounts the workspace at the
// same path into its Linux kernel, where the CLI's lifecycle binds its Unix
// sockets (such as runtime-relay.sock); the host Box CLI binds none. Any
// socket the CLI derives from the workspace is at least WORKSPACE/NAME long,
// so a workspace that leaves no room for the shortest such path is refused
// before anything is created. A session scratch root is far too long; pin a
// short task-owned `workspaceParentRoot` (mac blocks) instead.
export const UNIX_SOCKET_PATH_LIMIT = 108;
export const WORKSPACE_SOCKET_NAME = 'runtime-relay.sock';
export function workspaceSocketProblem(workspacePath) {
    const socket = path.join(workspacePath, WORKSPACE_SOCKET_NAME);
    const bytes = Buffer.byteLength(socket);
    if (bytes < UNIX_SOCKET_PATH_LIMIT) return null;
    return `The workspace ${workspacePath} leaves no room for the CLI's Unix sockets: ${socket} is ${bytes} bytes, over the ${UNIX_SOCKET_PATH_LIMIT - 1}-byte limit. `
        + `Pin a workspaceParentRoot at least ${bytes - UNIX_SOCKET_PATH_LIMIT + 1} bytes shorter: a short, canonical, task-owned directory such as /private/tmp/<name>.`;
}

// The candidate's commands find the engine first on PATH, so the exact
// recorded engine binary is the one the candidate drives.
export function candidateEnv(profile, extra = {}) {
    const engineDirectory = path.dirname(profile.engine.path);
    const env = {
        PATH: [...new Set([engineDirectory, '/usr/local/bin', '/usr/bin', '/bin'])].join(':'),
        HOME: profile.host.home,
        TMPDIR: process.env.TMPDIR,
        ...extra,
    };
    if (profile.provision?.boxImage) env.PLOINKY_BOX_IMAGE = profile.provision.boxImage;
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    return env;
}
