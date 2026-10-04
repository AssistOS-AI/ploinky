// Shared identity proofs for the owned-fixture live harness: digests, the
// workspace receipt and marker, the exact task-owned host record names and
// the fixed container inspect format. Test-only; nothing here runs a process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { requireTransport } from './liveProcess.mjs';
import { LIMITS_HASH_LABEL } from '../../cli/sandbox/hardwareLimits/resolve.mjs';

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
// The owned Box's privilege and publication contract, evidence only (never an identity check): its labels and image, whether it is
// privileged, its added and dropped capabilities, security options, init, network and user-namespace modes, devices and configured
// publications. Every HostConfig field here is one the engine's own inspect reports; a failing query is recorded, not a provisioning failure.
export const BOX_CONTRACT_INSPECT = '{"id":{{json .ID}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"privileged":{{json .HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"init":{{json .HostConfig.Init}},"networkMode":{{json .HostConfig.NetworkMode}},"usernsMode":{{json .HostConfig.UsernsMode}},"devices":{{json .HostConfig.Devices}},"publications":{{json .HostConfig.PortBindings}}}';

// Evidence-only nested container query. Its State fields (Status, FinishedAt,
// ExitCode, OOMKilled) are Podman's Go struct names but have not yet been
// proved on a real engine, so no gating inspect uses them: a template failure
// here is recorded as evidence and can never fail a case by itself.
export const NESTED_CONTAINER_INSPECT = '{"id":{{json .ID}},"name":{{json .Name}},"created":{{json .Created}},"image":{{json .Image}},"imageName":{{json .ImageName}},"labels":{{json .Config.Labels}},"status":{{json .State.Status}},"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}},"exitCode":{{json .State.ExitCode}},"oomKilled":{{json .State.OOMKilled}}}';
export const NESTED_LIST_FORMAT = '{{.ID}}';
export const MAX_NESTED_LISTED = 16;
export const MAX_TAIL_BYTES = 8192;

// Output of candidate and engine commands may carry credentials, so persisted
// tails pass through this one redactor first: secret-named assignments and
// JSON members, bearer and basic credentials, JWTs and URL userinfo. Container
// IDs and digests are evidence and are never touched.
const SECRET_NAME = '[A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|AUTH|COOKIE|SESSION)[A-Za-z0-9_.-]*';
export function redactDiagnostic(text) {
    return String(text ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?')
        // Credentials with a scheme word first, so a secret-named header such as
        // `Authorization: Bearer TOKEN` cannot stop at the scheme word.
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
        .replace(new RegExp(`(\\b${SECRET_NAME})(\\s*[=:]\\s*)(?!(?:Bearer|Basic) \\[redacted\\])("[^"\\n]*"|'[^'\\n]*'|[^\\s,;"']+)`, 'gi'), '$1$2[redacted]')
        .replace(new RegExp(`("${SECRET_NAME}"\\s*:\\s*)"[^"\\n]*"`, 'gi'), '$1"[redacted]"')
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]')
        .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@');
}
// The last `maxBytes` bytes of the redacted text on a character boundary, with
// the count of bytes dropped from the front.
export function boundedTail(text, maxBytes = MAX_TAIL_BYTES) {
    const redacted = redactDiagnostic(text);
    const bytes = Buffer.from(redacted, 'utf8');
    if (bytes.length <= maxBytes) return { text: redacted, droppedBytes: 0 };
    let start = bytes.length - maxBytes;
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
    return { text: bytes.subarray(start).toString('utf8'), droppedBytes: start };
}
// What is kept of one finished command: its transport flags and the bounded,
// redacted tails of both streams.
export function commandTails(result, { maxBytes = MAX_TAIL_BYTES } = {}) {
    const out = boundedTail(result?.stdout, maxBytes);
    const err = boundedTail(result?.stderr, maxBytes);
    return {
        status: result?.status ?? null, signal: result?.signal ?? null, timedOut: Boolean(result?.timedOut), truncated: Boolean(result?.truncated),
        cancelled: Boolean(result?.cancelled), errorCode: result?.errorCode ?? null, settlementForced: Boolean(result?.settlementForced),
        stdoutTail: out.text, stdoutDroppedBytes: out.droppedBytes, stderrTail: err.text, stderrDroppedBytes: err.droppedBytes,
    };
}
// A run-artifact path beside the run manifest, carrying the manifest's own
// document suffix exactly once before the extension.
export function artifactPathFor(runPath, name) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(name))) throw new Error('Invalid artifact name');
    const match = /(_claude|_codex)?\.json$/.exec(runPath);
    return `${runPath.replace(/(?:_claude|_codex)?\.json$/, '')}_${name}${match?.[1] || ''}.json`;
}

// What a failed MPS case (LIVE-P1 to LIVE-P4) leaves before its Box is destroyed:
// the owned daemon's state and control and server logs, the Router and Watchdog
// tails of the Apply window and the Apply response. They are written for every
// failure, with the reason an item could not be read, so the stager can require them.
export const FAILURE_EVIDENCE_SUFFIXES = Object.freeze(['mps-state', 'mps-logs', 'router-logs', 'apply-response']);
export const FAILURE_EVIDENCE_CASE = /^LIVE-P[0-9]+$/;
export const failureEvidenceNames = caseId => {
    if (!FAILURE_EVIDENCE_CASE.test(String(caseId))) return [];
    return FAILURE_EVIDENCE_SUFFIXES.map(suffix => `gpu-${String(caseId).toLowerCase()}-${suffix}`);
};
// One nested container as evidence: identity, lifecycle state, why it stopped
// and the limits hash label it was created with. Never the other labels.
export function nestedContainerEvidence(value) {
    const text = (field, max = 256) => (typeof field === 'string' ? field.slice(0, max) : null);
    return {
        id: text(value?.id, 64), name: text(value?.name), created: text(value?.created, 128), image: text(value?.image, 128), imageName: text(value?.imageName),
        status: text(value?.status, 64), running: typeof value?.running === 'boolean' ? value.running : null,
        startedAt: text(value?.startedAt, 128), finishedAt: text(value?.finishedAt, 128),
        exitCode: Number.isSafeInteger(value?.exitCode) ? value.exitCode : null, oomKilled: typeof value?.oomKilled === 'boolean' ? value.oomKilled : null,
        limitsHash: text(value?.labels?.[LIMITS_HASH_LABEL], 128),
    };
}

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
        // Whether the service is local or remote must be stated: an engine
        // that does not report it is never assumed local.
        serviceIsRemote: typeof host?.serviceIsRemote === 'boolean' ? host.serviceIsRemote : (() => { throw incompleteIdentity('Engine service identity is missing host.serviceIsRemote'); })(),
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
// Observe the identity through one bounded command runner `run(kind, argv)`. `info` is the one fresh engine document the digest was
// computed from, so a caller that needs the product's own engine identity binds it to the SAME observation.
export async function observeEngineFacts(run) {
    const info = checkedJson(await run('engine-identity', [...ENGINE_INFO_ARGV]));
    // The facts check below fails closed when the locality is not reported.
    const connections = info?.host?.serviceIsRemote === true ? checkedJson(await run('engine-connection', [...ENGINE_CONNECTIONS_ARGV])) : null;
    return { info, connections, digest: engineIdentityDigest(info, connections) };
}
export async function observeEngineIdentity(run) {
    return (await observeEngineFacts(run)).digest;
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

// The foreign-workspace guard (release plan C7). Another session owns
// ~/work/testExplorerFresh and ~/cleanup-repair-claude-20261002 and its Box
// `ploinky-box-testexplorerfresh-*`. No live block may place a workspace, a
// stage or its working directory under either directory, or derive a Box with
// that name. Every preflight runs this BEFORE any mutation and refuses.
export const FOREIGN_WORKSPACE_DIRECTORIES = Object.freeze(['work/testExplorerFresh', 'cleanup-repair-claude-20261002']);
export const FOREIGN_BOX_NAME = /^ploinky-box-testexplorerfresh-/i;
// The real path of `target`, or of its nearest existing ancestor plus the rest
// (a path that does not exist yet is judged where it would be created).
function resolvedPath(target) {
    const absolutePath = path.resolve(String(target));
    let existing = absolutePath; const rest = [];
    for (;;) {
        try { return path.join(fs.realpathSync(existing), ...rest.reverse()); } catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return absolutePath; }
        const parent = path.dirname(existing);
        if (parent === existing) return absolutePath;
        rest.push(path.basename(existing)); existing = parent;
    }
}
const insideDirectory = (candidate, directory) => candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
// `homes` are the home directories the foreign directories hang under (the
// pinned host home and this process's own). `paths` is every workspace, stage
// or working directory the run would touch; `names` every derived Box or
// instance name. Returns the problem text, or null.
export function foreignWorkspaceProblem({ homes = [], paths = [], names = [] } = {}) {
    const roots = new Set();
    for (const home of homes) {
        if (typeof home !== 'string' || !path.isAbsolute(home)) continue;
        for (const directory of FOREIGN_WORKSPACE_DIRECTORIES) {
            const root = path.join(path.resolve(home), directory);
            roots.add(root); roots.add(resolvedPath(root));
        }
    }
    for (const entry of paths) {
        if (typeof entry !== 'string' || !entry) continue;
        for (const candidate of new Set([path.resolve(entry), resolvedPath(entry)])) {
            for (const root of roots) {
                if (insideDirectory(candidate, root)) return `Foreign-workspace guard: ${entry} is under ${root}, which another session owns; this block refuses to touch it`;
            }
        }
    }
    for (const name of names) {
        if (typeof name === 'string' && FOREIGN_BOX_NAME.test(name.replace(/^\//, ''))) return `Foreign-workspace guard: the Box name ${name} matches the other session's ploinky-box-testexplorerfresh-* Box; this block refuses to derive it`;
    }
    return null;
}
export function assertNoForeignWorkspace(input) {
    const problem = foreignWorkspaceProblem(input);
    if (problem) throw blocked(problem);
}
// The guard inputs of a live action over an execution profile: the pinned and
// the process's own home, every path the profile names, the working directory
// and the Box instance names.
export function foreignGuardInput(run, profileInput, extraPaths = []) {
    const profile = profileInput || {};
    const workspace = profile.workspace?.path || profile.provision?.workspace?.path || null;
    return {
        homes: [profile.host?.home, process.env.HOME, os.homedir()].filter(Boolean),
        paths: [workspace, profile.provision?.workspace?.parent, profile.source?.root, profile.candidate?.path, run?.target?.stage?.root, process.cwd(), ...extraPaths].filter(Boolean),
        names: [run?.workspace?.instance, profile.box?.instance].filter(Boolean),
    };
}
