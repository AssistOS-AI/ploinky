// Shared identity proofs for the owned-fixture live harness: digests, the
// workspace receipt and marker, the exact task-owned host record names and
// the fixed container inspect format. Test-only; nothing here runs a process.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

export const INSPECT = '{"id":{{json .Id}},"created":{{json .Created}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"running":{{json .State.Running}},"pid":{{json .State.Pid}},"startedAt":{{json .State.StartedAt}},"conmonPid":{{json .State.ConmonPid}},"memory":{{json .HostConfig.Memory}},"memorySwap":{{json .HostConfig.MemorySwap}},"nanoCpus":{{json .HostConfig.NanoCpus}},"cpuQuota":{{json .HostConfig.CpuQuota}},"cpuPeriod":{{json .HostConfig.CpuPeriod}},"pidsLimit":{{json .HostConfig.PidsLimit}}}';
// Nested fixture agents additionally report their name and the image
// reference they were created from.
export const AGENT_INSPECT = INSPECT.replace('{"id":', '{"name":{{json .Name}},"imageName":{{json .ImageName}},"id":');

export function checkedJson(result) { requireTransport(result); return JSON.parse(result.stdout); }

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
