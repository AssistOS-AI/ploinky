// Trusted runtime-evidence adapter for the full legacy mask-completeness
// predicate (frozen T0 §11, amendment A1.1 step 5). It turns an owned global
// Podman agent that was already proven exact into the adapter evidence block
// the full legacy predicate consumes, and defines the one reviewed
// baseline observed by G-L (nested Podman 5.8.2 / crun 1.27.1).
//
// Why an adapter: `podman inspect` omits HostConfig.MaskedPaths and
// ReadonlyPaths for ordinary agents (unknown, never known-empty). The
// effective lists are in the exact-instance OCI spec at inspect's
// OCIConfigPath. The spec has no self-identifying field, so the binding is the
// full 64-hex container ID in that path, plus a re-read of inspect after the
// spec was read.
//
// Every failure returns null (the caller maps it to the typed
// `unverifiable_security_evidence` refusal). Nothing read from the engine or
// the spec is ever placed in a diagnostic.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readContainerId } from './legacyAgentAdoptionGuard.mjs';

export const MAX_OCI_SPEC_BYTES = 256 * 1024;
const OCI_CONFIG_PATH = /^\/(?:[^/\0]+\/)*overlay-containers\/([0-9a-f]{64})\/userdata\/config\.json$/;
const POSITIVE_SEMVER = /^\d+\.\d+\.\d+$/;
const ENGINE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// Required masked entries: the 12 common entries of both G-L platforms. The
// observed amd64 list adds per-CPU thermal_throttle entries; the baseline is a
// required subset and extra masked entries are more restrictive (acceptable).
const BASELINE_MASKED_PATHS = Object.freeze([
    '/proc/acpi', '/proc/kcore', '/proc/keys', '/proc/latency_stats', '/proc/sched_debug',
    '/proc/scsi', '/proc/timer_list', '/proc/timer_stats', '/sys/devices/virtual/powercap',
    '/sys/firmware', '/sys/fs/selinux', '/proc/interrupts',
]);
const BASELINE_READONLY_PATHS = Object.freeze([
    '/proc/asound', '/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger',
]);

// Engine-created mounts that appear in the OCI spec but not in inspect
// `Mounts`, as exact (type, destination) pairs observed by G-L on both
// platforms. Only the `proc` mount at /proc and the `sysfs` mount at /sys may
// sit above baseline paths: they are the engine's own proc and sys views, the
// very views whose masked/read-only paths the spec lists. The darwin-only rhsm
// secret bind is accepted, never required. Any other spec mount that inspect
// does not list makes the evidence unverifiable.
const SUBSTRATE_MOUNTS = Object.freeze([
    ['proc', '/proc'], ['sysfs', '/sys'], ['tmpfs', '/dev'], ['devpts', '/dev/pts'],
    ['mqueue', '/dev/mqueue'], ['cgroup', '/sys/fs/cgroup'], ['bind', '/dev/shm'],
    ['bind', '/run/podman-init'], ['bind', '/run/.containerenv'], ['bind', '/etc/hostname'],
    ['bind', '/etc/resolv.conf'], ['bind', '/etc/hosts'], ['bind', '/run/secrets/rhsm'],
].map(([type, destination]) => Object.freeze({ type, destination })));

/**
 * The one reviewed baseline. `runtimeVersion` names the engine pair, and
 * `configIdentity` is the evidence-source identity derived by
 * `deriveConfigIdentity` (OCI spec location kind, OCI runtime name and
 * version, spec `ociVersion`): a different spec generation or low-level
 * runtime cannot reuse these lists. `profileDigest` hashes the required lists.
 * A Box image that changes Podman or crun needs a new reviewed entry here.
 */
export const REVIEWED_LEGACY_BASELINES = Object.freeze([Object.freeze({
    runtimeFamily: 'podman',
    runtimeVersion: 'podman 5.8.2; crun 1.27.1',
    configIdentity: 'podman-userdata-config-v1:crun-1.27.1:oci-1.2.1',
    profileDigest: createHash('sha256').update(JSON.stringify({
        version: 1, maskedPaths: BASELINE_MASKED_PATHS, readonlyPaths: BASELINE_READONLY_PATHS,
    })).digest('hex'),
    maskedPaths: BASELINE_MASKED_PATHS,
    readonlyPaths: BASELINE_READONLY_PATHS,
})]);

export function deriveConfigIdentity({ ociRuntimeName, ociRuntimeVersion, ociVersion }) {
    return `podman-userdata-config-v1:${ociRuntimeName}-${ociRuntimeVersion}:oci-${ociVersion}`;
}

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Bounded, no-follow regular-file read; null on any problem. */
export function readBoundedFile(file, limit = MAX_OCI_SPEC_BYTES) {
    let fd = null;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > limit) return null;
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < buffer.length) {
            const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
            if (count <= 0) return null;
            offset += count;
        }
        return buffer.toString('utf8');
    } catch (_) {
        return null;
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* nothing to recover */ } }
    }
}

/**
 * One bounded `podman info --format json` read. Not cached: a stale answer
 * must not vouch for a later engine. Returns only the three reviewed scalars.
 */
export function readPodmanVersions(engine, { run = spawnSync } = {}) {
    try {
        const reply = run(engine, ['info', '--format', 'json'], { encoding: 'utf8', timeout: 10_000,
            maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
        if (!reply || reply.error || reply.signal || reply.status !== 0) return null;
        const info = JSON.parse(String(reply.stdout || ''));
        const podman = info?.version?.Version;
        const ociRuntimeName = info?.host?.ociRuntime?.name;
        const firstLine = String(info?.host?.ociRuntime?.version ?? '').split('\n', 1)[0];
        const crun = /^crun version (\d+\.\d+\.\d+)$/.exec(firstLine);
        if (typeof podman !== 'string' || !POSITIVE_SEMVER.test(podman) || typeof ociRuntimeName !== 'string'
            || !ENGINE_NAME.test(ociRuntimeName) || !crun) return null;
        return { podman, ociRuntimeName, ociRuntimeVersion: crun[1] };
    } catch (_) {
        return null;
    }
}

function specMountView(mount) {
    if (!isPlain(mount) || typeof mount.destination !== 'string' || !mount.destination.startsWith('/')
        || typeof mount.type !== 'string' || !isStringArray(mount.options ?? [])) return null;
    const options = mount.options ?? [];
    const ro = options.includes('ro');
    if (ro && options.includes('rw')) return null;
    return { destination: mount.destination, type: mount.type, readOnly: ro };
}

/**
 * Collect the OCI evidence for one inspected, already ownership-proven
 * Podman instance. `record` is the inspect record; `deps.reinspect(runtime, id)`
 * must return a fresh inspect record. Returns
 * `{ evidence, baseline }` or null (fail closed).
 */
export function collectPodmanOciEvidence({ runtime, record } = {}, {
    reinspect, readFile = readBoundedFile, readVersions = readPodmanVersions,
    baselines = REVIEWED_LEGACY_BASELINES,
} = {}) {
    try {
        if (runtime !== 'podman' || typeof reinspect !== 'function' || !isPlain(record)) return null;
        const id = readContainerId(record);
        const specPath = record.OCIConfigPath;
        if (!id || typeof specPath !== 'string' || path.posix.normalize(specPath) !== specPath) return null;
        const bound = OCI_CONFIG_PATH.exec(specPath);
        if (!bound || bound[1] !== id) return null;
        const versions = readVersions(runtime);
        if (!versions || record.OCIRuntime !== versions.ociRuntimeName) return null;
        const text = readFile(specPath, MAX_OCI_SPEC_BYTES);
        if (typeof text !== 'string' || text.length === 0) return null;
        const spec = JSON.parse(text);
        if (!isPlain(spec) || typeof spec.ociVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(spec.ociVersion)
            || !isPlain(spec.linux) || !Array.isArray(spec.mounts)) return null;
        // The instance must be the same one after the spec was read.
        const again = reinspect(runtime, id);
        if (!isPlain(again) || readContainerId(again) !== id || again.OCIConfigPath !== specPath
            || again.OCIRuntime !== record.OCIRuntime) return null;

        const configIdentity = deriveConfigIdentity({ ociRuntimeName: versions.ociRuntimeName,
            ociRuntimeVersion: versions.ociRuntimeVersion, ociVersion: spec.ociVersion });
        const runtimeVersion = `podman ${versions.podman}; ${versions.ociRuntimeName} ${versions.ociRuntimeVersion}`;
        const baseline = baselines.find((item) => item.runtimeFamily === runtime
            && item.runtimeVersion === runtimeVersion && item.configIdentity === configIdentity);
        if (!baseline) return null;

        // Mounts. Inspect `Mounts` and the spec must describe the same user
        // mounts with the same read-only meaning; engine-created extras must be
        // reviewed substrate pairs. Only the agreeing set goes into the
        // evidence, so the predicate compares like with like.
        if (!Array.isArray(record.Mounts)) return null;
        const inspectedMounts = new Map();
        for (const mount of record.Mounts) {
            if (!isPlain(mount) || typeof mount.Destination !== 'string' || typeof mount.RW !== 'boolean'
                || inspectedMounts.has(mount.Destination)) return null;
            inspectedMounts.set(mount.Destination, !mount.RW);
        }
        const views = spec.mounts.map(specMountView);
        if (views.some((view) => view === null)) return null;
        const matched = [];
        const seen = new Set();
        for (const view of views) {
            if (inspectedMounts.has(view.destination)) {
                if (seen.has(view.destination) || inspectedMounts.get(view.destination) !== view.readOnly) return null;
                seen.add(view.destination);
                matched.push({ destination: view.destination, readOnly: view.readOnly });
            } else if (!SUBSTRATE_MOUNTS.some((item) => item.type === view.type && item.destination === view.destination)) {
                return null;
            }
        }
        if (seen.size !== inspectedMounts.size) return null;

        return Object.freeze({
            baseline,
            evidence: {
                runtimeFamily: runtime,
                runtimeVersion,
                configIdentity,
                nullMeansEmpty: { securityOpt: false, maskedPaths: false, readonlyPaths: false },
                oci: { containerId: id, configIdentity, maskedPaths: spec.linux.maskedPaths,
                    readonlyPaths: spec.linux.readonlyPaths, mounts: matched },
            },
        });
    } catch (_) {
        return null;
    }
}
