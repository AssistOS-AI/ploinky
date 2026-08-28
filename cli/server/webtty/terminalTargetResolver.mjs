import { execFile as execFileDefault } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { buildAgentWorkerEnvironment } from './agentWorkerEnvironment.mjs';
import {
    exactPodmanInspectAbsent,
    parseExactPodmanInspectEnvelope,
} from './agentRuntime.mjs';
import { WEBTTY_AGENT_PROTOCOL_LIMITS } from './agentWorkerProtocol.mjs';
import { resolveWorkspaceDirectory } from '../../../core-services/webtty/cwd.mjs';
import {
    assertExactContainerOwnership,
    IMMUTABLE_CONTAINER_ID,
} from '../../sandbox/docker/containerOwnership.js';
import { NETWORK_LABELS, workspaceNetworkIdentity } from '../../sandbox/networkIdentity.js';

export const TERMINAL_TARGET_DISCOVERY_LIMITS = Object.freeze({
    candidates: 63,
    concurrency: 4,
    inspectTimeoutMs: 2_000,
    overallTimeoutMs: 3_000,
    inspectOutputBytes: 1024 * 1024,
});

// Phase 0 admitted only the Box-local persistent Podman exec backend. Docker
// records remain valid workspace runtime records, but they are not terminal
// targets until that exact local provider receives its own admission proof.
const DEFAULT_SUPPORTED_RUNTIMES = Object.freeze(['podman']);
const DISPLAY_TEXT_LIMITS = Object.freeze({ label: 128, detail: 256, cwdDisplay: 4 * 1024 });
const PROJECTED_OWNERSHIP_LABELS = new Set(Object.values(NETWORK_LABELS));
const CONTAINER_USER = /^(?:[0-9]+|[A-Za-z_][A-Za-z0-9_-]*)(?::(?:[0-9]+|[A-Za-z_][A-Za-z0-9_-]*))?$/;
const PODMAN = '/usr/bin/podman';

function targetError(code, message = code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isSystemicProviderInvocationFailure(error, output) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes(String(error?.code || ''))) return true;
    const text = String(output || '').toLowerCase();
    return text.includes('cannot connect to podman')
        || text.includes('failed to connect to podman')
        || text.includes('unable to connect to podman')
        || text.includes('runtime database not found');
}

function exactText(value) {
    return typeof value === 'string' && value === value.trim() && value ? value : '';
}

function isSegmentContained(root, candidate, separator = '/') {
    if (root === separator) return candidate.startsWith(separator);
    return candidate === root || candidate.startsWith(`${root}${separator}`);
}

function normalizeContainerDestination(value) {
    if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) return '';
    if (!path.posix.isAbsolute(value) || value.startsWith('//')) return '';
    const normalized = path.posix.normalize(value).replace(/\/$/, '') || '/';
    if (!path.posix.isAbsolute(normalized) || normalized.includes('/../')) return '';
    return normalized;
}

function projectLabels(labels) {
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return Object.freeze({});
    const projected = {};
    for (const [name, value] of Object.entries(labels)) {
        if (PROJECTED_OWNERSHIP_LABELS.has(name) && typeof value === 'string') {
            projected[name] = value;
        }
    }
    return Object.freeze(projected);
}

function projectMount(mount) {
    if (!mount || typeof mount !== 'object' || Array.isArray(mount)) return null;
    const destination = normalizeContainerDestination(mount.Destination ?? mount.destination);
    const type = exactText(mount.Type ?? mount.type).toLowerCase();
    if (!destination || !type) return null;
    const sourceValue = mount.Source ?? mount.source;
    const nameValue = mount.Name ?? mount.name;
    return Object.freeze({
        type,
        source: typeof sourceValue === 'string' ? sourceValue : '',
        destination,
        rw: typeof (mount.RW ?? mount.rw) === 'boolean' ? (mount.RW ?? mount.rw) : null,
        name: typeof nameValue === 'string' ? nameValue : '',
    });
}

export function projectTerminalContainerInspect(raw) {
    const inspected = Array.isArray(raw) ? raw[0] : raw;
    if (!inspected || typeof inspected !== 'object' || Array.isArray(inspected)) {
        throw targetError('WEBTTY_TARGET_INSPECT_INVALID', 'terminal target inspection returned no object');
    }
    const rawMounts = inspected.Mounts ?? inspected.mounts;
    if (!Array.isArray(rawMounts)) {
        throw targetError('WEBTTY_TARGET_INSPECT_INVALID', 'terminal target inspection omitted mounts');
    }
    const mounts = rawMounts.map(projectMount);
    if (mounts.some((mount) => mount === null)) {
        throw targetError('WEBTTY_TARGET_INSPECT_INVALID', 'terminal target inspection contained a malformed mount');
    }
    const state = exactText(inspected?.State?.Status ?? inspected?.state?.status).toLowerCase();
    return Object.freeze({
        id: exactText(inspected.Id ?? inspected.ID ?? inspected.id),
        name: exactText(inspected.Name ?? inspected.name).replace(/^\//, ''),
        running: (inspected?.State?.Running ?? inspected?.state?.running) === true,
        state,
        labels: projectLabels(inspected?.Config?.Labels ?? inspected.Labels ?? inspected.labels),
        init: (inspected?.HostConfig?.Init ?? inspected?.hostConfig?.init ?? inspected.init) === true,
        networkMode: exactText(
            inspected?.HostConfig?.NetworkMode ?? inspected?.hostConfig?.networkMode ?? inspected.networkMode,
        ),
        user: exactText(inspected?.Config?.User ?? inspected?.config?.user) || '0:0',
        mounts: Object.freeze(mounts),
    });
}

export function inspectExactTerminalContainer(runtime, containerId, {
    execFileImpl = execFileDefault,
    signal,
    timeoutMs = TERMINAL_TARGET_DISCOVERY_LIMITS.inspectTimeoutMs,
    maxOutputBytes = TERMINAL_TARGET_DISCOVERY_LIMITS.inspectOutputBytes,
} = {}) {
    if (!DEFAULT_SUPPORTED_RUNTIMES.includes(runtime) || !IMMUTABLE_CONTAINER_ID.test(containerId)) {
        return Promise.reject(targetError('WEBTTY_TARGET_IDENTITY_INVALID'));
    }
    return new Promise((resolve, reject) => {
        execFileImpl(PODMAN, ['container', 'inspect', containerId], {
            cwd: '/tmp',
            env: buildAgentWorkerEnvironment(),
            encoding: 'utf8',
            timeout: Math.min(timeoutMs, TERMINAL_TARGET_DISCOVERY_LIMITS.inspectTimeoutMs),
            maxBuffer: Math.min(maxOutputBytes, TERMINAL_TARGET_DISCOVERY_LIMITS.inspectOutputBytes),
            killSignal: 'SIGKILL',
            signal,
            windowsHide: true,
        }, (error, stdout, stderr) => {
            if (error) {
                const output = `${String(stderr || '')}\n${String(stdout || '')}`;
                const absent = exactPodmanInspectAbsent({
                    status: Number.isInteger(error.code) ? error.code : null,
                    signal: error.signal || null,
                    errorCode: !Number.isInteger(error.code) ? String(error.code || '') : null,
                    stdout,
                    stderr,
                }, containerId);
                reject(targetError(
                    absent
                        ? 'WEBTTY_TARGET_IDENTITY_STALE'
                        : isSystemicProviderInvocationFailure(error, output)
                            ? 'WEBTTY_TARGET_PROVIDER_UNAVAILABLE'
                            : 'WEBTTY_TARGET_INSPECT_FAILED',
                ));
                return;
            }
            if (Buffer.byteLength(String(stdout || ''), 'utf8') > maxOutputBytes) {
                reject(targetError('WEBTTY_TARGET_INSPECT_OVERSIZED'));
                return;
            }
            try {
                const inspected = parseExactPodmanInspectEnvelope(
                    stdout,
                    containerId,
                    function inspectError() { return targetError('WEBTTY_TARGET_INSPECT_INVALID'); },
                );
                resolve(projectTerminalContainerInspect(inspected));
            } catch (_) {
                reject(targetError('WEBTTY_TARGET_INSPECT_INVALID'));
            }
        });
    });
}

async function realDirectory(source, fsApi) {
    if (typeof source !== 'string' || !path.isAbsolute(source)) return null;
    try {
        const real = await fsApi.promises.realpath(source);
        const stat = await fsApi.promises.stat(real);
        return stat.isDirectory() ? real : null;
    } catch (error) {
        if (error?.code === 'WEBTTY_TARGET_PROVIDER_UNAVAILABLE') throw error;
        return null;
    }
}

function mappedDestination(sourceReal, destination, selectedReal) {
    if (!isSegmentContained(sourceReal, selectedReal, path.sep)) return '';
    const relative = path.relative(sourceReal, selectedReal);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return '';
    const suffix = relative ? relative.split(path.sep).join('/') : '';
    const translated = path.posix.resolve(destination, suffix);
    return isSegmentContained(destination, translated) ? translated : '';
}

function mostSpecificMounts(mounts, translated) {
    const matching = mounts.filter((mount) => isSegmentContained(mount.destination, translated));
    if (!matching.length) return [];
    const longest = Math.max(...matching.map((mount) => mount.destination.length));
    return matching.filter((mount) => mount.destination.length === longest);
}

export async function translateWorkspaceDirectoryToMount(selectedDirectory, mounts, {
    fsApi = fs,
} = {}) {
    if (typeof selectedDirectory !== 'string' || !path.isAbsolute(selectedDirectory) || !Array.isArray(mounts)) {
        return null;
    }
    const sourceCandidates = [];
    for (const mount of mounts) {
        if (!mount || mount.type !== 'bind') continue;
        const sourceReal = await realDirectory(mount.source, fsApi);
        if (!sourceReal || !isSegmentContained(sourceReal, selectedDirectory, path.sep)) continue;
        if (typeof mount.rw !== 'boolean') return null;
        const translatedCwd = mappedDestination(sourceReal, mount.destination, selectedDirectory);
        if (translatedCwd) sourceCandidates.push({ mount, sourceReal, translatedCwd });
    }
    if (!sourceCandidates.length) return null;
    const longestSource = Math.max(...sourceCandidates.map((candidate) => candidate.sourceReal.length));
    const strongest = sourceCandidates.filter((candidate) => candidate.sourceReal.length === longestSource);
    const destinations = new Set(strongest.map((candidate) => candidate.translatedCwd));
    if (destinations.size !== 1) return null;
    const translatedCwd = strongest[0].translatedCwd;

    const effectiveMounts = mostSpecificMounts(mounts, translatedCwd);
    if (!effectiveMounts.length || effectiveMounts.some((mount) => mount.type !== 'bind')) return null;
    const effectiveMappings = [];
    for (const mount of effectiveMounts) {
        if (typeof mount.rw !== 'boolean') return null;
        const sourceReal = await realDirectory(mount.source, fsApi);
        if (!sourceReal) return null;
        const mapped = mappedDestination(sourceReal, mount.destination, selectedDirectory);
        if (mapped !== translatedCwd) return null;
        effectiveMappings.push({ mount, sourceReal });
    }
    const accessValues = new Set(effectiveMappings.map(({ mount }) => mount.rw ? 'rw' : 'ro'));
    if (accessValues.size !== 1) return null;
    return Object.freeze({
        translatedCwd,
        access: [...accessValues][0],
        sourceRealPath: effectiveMappings[0].sourceReal,
    });
}

function directoryIdentity(absolutePath, fsApi) {
    let stat;
    try {
        stat = fsApi.statSync(absolutePath, { bigint: true });
    } catch (_) {
        throw targetError('WEBTTY_TARGET_DIRECTORY_STALE');
    }
    if (!stat.isDirectory()) throw targetError('WEBTTY_TARGET_DIRECTORY_STALE');
    return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function resolveDirectory(requested, { directoryResolver, fsApi }) {
    const resolved = directoryResolver(requested);
    return Object.freeze({
        ...resolved,
        identity: directoryIdentity(resolved.absolutePath, fsApi),
    });
}

function sameDirectory(left, right) {
    return left.relativePath === right.relativePath
        && left.absolutePath === right.absolutePath
        && left.identity.dev === right.identity.dev
        && left.identity.ino === right.identity.ino;
}

function routeSnapshot(routePlan) {
    const snapshot = routePlan?.snapshot;
    const lease = routePlan?.lease;
    if (!snapshot || !lease || lease.snapshot !== snapshot || typeof lease.isCurrent !== 'function') {
        throw targetError('WEBTTY_TARGET_GENERATION_STALE');
    }
    if (lease.isCurrent() !== true) throw targetError('WEBTTY_TARGET_GENERATION_STALE');
    return snapshot;
}

export function terminalTargetRouteBinding(routePlan) {
    routeSnapshot(routePlan);
    const host = exactText(routePlan?.host || routePlan?.hostSelection?.host);
    const hostRouteKey = exactText(routePlan?.hostSelection?.record?.routeKey) || 'control';
    const generation = exactText(routePlan?.lease?.id);
    const activationId = exactText(routePlan?.lease?.activationId);
    if (!host || !generation || !activationId) throw targetError('WEBTTY_TARGET_GENERATION_STALE');
    return Object.freeze({ host, hostRouteKey, generation, activationId });
}

function exactCandidate(containerName, record, supportedRuntimes) {
    const runtime = exactText(record?.runtime);
    const containerId = exactText(record?.containerId);
    const instanceId = exactText(record?.instanceId);
    const enableGeneration = exactText(record?.enableGeneration);
    const repoName = exactText(record?.repoName);
    const agentName = exactText(record?.agentName);
    if (record?.type !== 'agent' || !supportedRuntimes.has(runtime)
        || !IMMUTABLE_CONTAINER_ID.test(containerId) || !exactText(containerName)
        || !instanceId || !enableGeneration || !repoName || !agentName) return null;
    if (record.containerName !== undefined && record.containerName !== containerName) return null;
    return Object.freeze({
        runtime,
        containerId,
        containerName,
        instanceId,
        enableGeneration,
        repoName,
        agentName,
        record,
    });
}

function displayText(value, field) {
    if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)
        || Buffer.byteLength(value, 'utf8') > DISPLAY_TEXT_LIMITS[field]) {
        throw targetError('WEBTTY_TARGET_DISPLAY_INVALID');
    }
    return value;
}

function boxTarget(directory) {
    const cwdDisplay = directory.relativePath ? `/workspace/${directory.relativePath}` : '/workspace';
    return Object.freeze({
        kind: 'box',
        directory,
        label: 'Ploinky Box',
        detail: 'Workspace runtime',
        access: 'rw',
        cwdDisplay,
    });
}

function safeAgentDisplay(candidate, mapping) {
    return Object.freeze({
        label: displayText(candidate.agentName, 'label'),
        detail: displayText(`${candidate.repoName}/${candidate.agentName}`, 'detail'),
        cwdDisplay: displayText(mapping.translatedCwd, 'cwdDisplay'),
    });
}

function assertOwnedInspection(candidate, raw, workspaceHash) {
    const inspected = raw?.id && raw?.labels && Array.isArray(raw?.mounts)
        ? raw
        : projectTerminalContainerInspect(raw);
    assertExactContainerOwnership(
        candidate.containerName,
        candidate.record,
        {
            Id: inspected.id,
            Name: inspected.name,
            Config: { Labels: inspected.labels },
            HostConfig: { Init: inspected.init },
        },
        candidate.containerId,
        workspaceHash,
    );
    if (inspected.id !== candidate.containerId || inspected.name !== candidate.containerName || !inspected.running) {
        throw targetError('WEBTTY_TARGET_IDENTITY_STALE');
    }
    if (!CONTAINER_USER.test(inspected.user)
        || Buffer.byteLength(inspected.user) > WEBTTY_AGENT_PROTOCOL_LIMITS.maxTargetUserBytes) {
        throw targetError('WEBTTY_TARGET_USER_INVALID');
    }
    return inspected;
}

async function resolveOneAgent(candidate, directory, context) {
    if (context.signal?.aborted) return null;
    if (context.isTargetQuarantined(candidate)) return null;
    let raw;
    try {
        raw = await context.inspectContainer(candidate.runtime, candidate.containerId, {
            signal: context.signal,
            timeoutMs: context.inspectTimeoutMs,
            maxOutputBytes: context.inspectOutputBytes,
        });
        const inspected = assertOwnedInspection(candidate, raw, context.workspaceHash);
        const mapping = await translateWorkspaceDirectoryToMount(
            directory.absolutePath,
            inspected.mounts,
            { fsApi: context.fsApi },
        );
        if (!mapping) return null;
        const display = safeAgentDisplay(candidate, mapping);
        return Object.freeze({
            kind: 'agent',
            directory,
            runtime: candidate.runtime,
            containerId: candidate.containerId,
            containerName: candidate.containerName,
            instanceId: candidate.instanceId,
            enableGeneration: candidate.enableGeneration,
            repoName: candidate.repoName,
            agentName: candidate.agentName,
            targetUser: inspected.user,
            translatedCwd: mapping.translatedCwd,
            access: mapping.access,
            ...display,
        });
    } catch (error) {
        if (error?.code === 'WEBTTY_TARGET_PROVIDER_UNAVAILABLE') throw error;
        return null;
    }
}

async function mapConcurrent(items, limit, mapper, { signal, output = new Array(items.length).fill(null) } = {}) {
    let next = 0;
    async function worker() {
        while (next < items.length) {
            if (signal?.aborted) return;
            const index = next;
            next += 1;
            output[index] = await mapper(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return output;
}

class InspectionConcurrencyGate {
    constructor(limit) {
        this.limit = limit;
        this.active = 0;
        this.queue = [];
    }

    run(operation, { signal } = {}) {
        if (signal?.aborted) {
            return Promise.reject(targetError('WEBTTY_TARGET_INSPECT_ABORTED'));
        }
        return new Promise((resolve, reject) => {
            const entry = {
                operation,
                resolve,
                reject,
                signal,
                started: false,
                cancelled: false,
                onAbort: null,
            };
            entry.onAbort = () => {
                if (entry.started || entry.cancelled) return;
                entry.cancelled = true;
                reject(targetError('WEBTTY_TARGET_INSPECT_ABORTED'));
                this.drain();
            };
            signal?.addEventListener('abort', entry.onAbort, { once: true });
            this.queue.push(entry);
            this.drain();
        });
    }

    drain() {
        while (this.active < this.limit && this.queue.length) {
            const entry = this.queue.shift();
            if (entry.cancelled || entry.signal?.aborted) {
                entry.signal?.removeEventListener('abort', entry.onAbort);
                if (!entry.cancelled) entry.reject(targetError('WEBTTY_TARGET_INSPECT_ABORTED'));
                continue;
            }
            entry.started = true;
            entry.signal?.removeEventListener('abort', entry.onAbort);
            this.active += 1;
            Promise.resolve()
                .then(entry.operation)
                .then(entry.resolve, entry.reject)
                .finally(() => {
                    this.active -= 1;
                    this.drain();
                });
        }
    }
}

function sameAgentIdentity(target, candidate) {
    return target.runtime === candidate.runtime
        && target.containerId === candidate.containerId
        && target.containerName === candidate.containerName
        && target.instanceId === candidate.instanceId
        && target.enableGeneration === candidate.enableGeneration
        && target.repoName === candidate.repoName
        && target.agentName === candidate.agentName;
}

function disambiguateAgentDisplays(targets) {
    const totals = new Map();
    for (const target of targets) {
        const key = `${target.label}\0${target.detail}`;
        totals.set(key, (totals.get(key) || 0) + 1);
    }
    const seen = new Map();
    return targets.map((target) => {
        const key = `${target.label}\0${target.detail}`;
        if (totals.get(key) === 1) return target;
        const ordinal = (seen.get(key) || 0) + 1;
        seen.set(key, ordinal);
        return Object.freeze({
            ...target,
            detail: displayText(`${target.detail} · target ${ordinal}`, 'detail'),
        });
    });
}

export class TerminalTargetResolver {
    constructor({
        directoryResolver = (requested) => resolveWorkspaceDirectory(requested),
        inspectContainer = inspectExactTerminalContainer,
        workspaceIdentity = workspaceNetworkIdentity,
        supportedRuntimes = DEFAULT_SUPPORTED_RUNTIMES,
        isTargetQuarantined = () => false,
        fsApi = fs,
        limits = TERMINAL_TARGET_DISCOVERY_LIMITS,
    } = {}) {
        this.directoryResolver = directoryResolver;
        this.inspectContainer = inspectContainer;
        this.workspaceIdentity = workspaceIdentity;
        this.supportedRuntimes = new Set(supportedRuntimes);
        this.isTargetQuarantined = isTargetQuarantined;
        this.fsApi = fsApi;
        const configuredLimits = { ...TERMINAL_TARGET_DISCOVERY_LIMITS, ...limits };
        const configuredConcurrency = Number.isSafeInteger(configuredLimits.concurrency)
            ? configuredLimits.concurrency
            : TERMINAL_TARGET_DISCOVERY_LIMITS.concurrency;
        configuredLimits.concurrency = Math.max(
            1,
            Math.min(TERMINAL_TARGET_DISCOVERY_LIMITS.concurrency, configuredConcurrency),
        );
        this.limits = Object.freeze(configuredLimits);
        this.inspectionGate = new InspectionConcurrencyGate(this.limits.concurrency);
    }

    inspectWithGate(runtime, containerId, options = {}) {
        return this.inspectionGate.run(
            () => this.inspectContainer(runtime, containerId, options),
            { signal: options.signal },
        );
    }

    async discover({ routePlan, requestedDirectory, agentProviderAvailable = true } = {}) {
        const snapshot = routeSnapshot(routePlan);
        const directory = resolveDirectory(requestedDirectory, this);
        const box = boxTarget(directory);
        if (!agentProviderAvailable) {
            routeSnapshot(routePlan);
            return Object.freeze({
                directory,
                agentTargetsAvailable: false,
                targets: Object.freeze([box]),
            });
        }
        const workspaceHash = exactText(this.workspaceIdentity()?.hash);
        if (!workspaceHash) {
            routeSnapshot(routePlan);
            return Object.freeze({ directory, agentTargetsAvailable: false, targets: Object.freeze([box]) });
        }
        const candidates = Object.entries(snapshot.agents || {})
            .map(([name, record]) => exactCandidate(name, record, this.supportedRuntimes))
            .filter(Boolean)
            .sort((left, right) => left.agentName.localeCompare(right.agentName, 'en', { sensitivity: 'base' })
                || left.repoName.localeCompare(right.repoName, 'en', { sensitivity: 'base' })
                || left.containerName.localeCompare(right.containerName, 'en'))
            .slice(0, this.limits.candidates);
        const controller = new AbortController();
        const partialResults = new Array(candidates.length).fill(null);
        let budgetTimer;
        const budget = new Promise((resolve) => {
            budgetTimer = setTimeout(() => {
                controller.abort();
                resolve(partialResults.slice());
            }, this.limits.overallTimeoutMs);
            budgetTimer.unref?.();
        });
        let resolved;
        try {
            resolved = await Promise.race([
                mapConcurrent(candidates, this.limits.concurrency, (candidate) => resolveOneAgent(candidate, directory, {
                    inspectContainer: (runtime, containerId, options) => (
                        this.inspectWithGate(runtime, containerId, options)
                    ),
                    inspectTimeoutMs: this.limits.inspectTimeoutMs,
                    inspectOutputBytes: this.limits.inspectOutputBytes,
                    signal: controller.signal,
                    workspaceHash,
                    isTargetQuarantined: this.isTargetQuarantined,
                    fsApi: this.fsApi,
                }), { signal: controller.signal, output: partialResults }),
                budget,
            ]);
        } catch (error) {
            if (error?.code !== 'WEBTTY_TARGET_PROVIDER_UNAVAILABLE') throw error;
            resolved = null;
        } finally {
            clearTimeout(budgetTimer);
            controller.abort();
        }
        routeSnapshot(routePlan);
        if (resolved === null) {
            return Object.freeze({
                directory,
                agentTargetsAvailable: false,
                targets: Object.freeze([box]),
            });
        }
        const agents = disambiguateAgentDisplays(resolved.filter(Boolean));
        return Object.freeze({
            directory,
            agentTargetsAvailable: true,
            targets: Object.freeze([box, ...agents]),
        });
    }

    async revalidate({ routePlan, target, agentProviderAvailable = true } = {}) {
        const snapshot = routeSnapshot(routePlan);
        if (!target || !['box', 'agent'].includes(target.kind) || !target.directory) {
            throw targetError('WEBTTY_TARGET_STALE');
        }
        let directory;
        try {
            directory = resolveDirectory(target.directory.relativePath, this);
        } catch (error) {
            if (error?.code === 'WEBTTY_TARGET_PROVIDER_UNAVAILABLE') throw error;
            throw targetError('WEBTTY_TARGET_STALE');
        }
        if (!sameDirectory(directory, target.directory)) throw targetError('WEBTTY_TARGET_STALE');
        if (target.kind === 'box') {
            routeSnapshot(routePlan);
            return boxTarget(directory);
        }
        if (!agentProviderAvailable) throw targetError('WEBTTY_TARGET_PROVIDER_UNAVAILABLE');
        const candidate = exactCandidate(target.containerName, snapshot.agents?.[target.containerName], this.supportedRuntimes);
        if (!candidate || !sameAgentIdentity(target, candidate) || this.isTargetQuarantined(candidate)) {
            throw targetError('WEBTTY_TARGET_STALE');
        }
        const workspaceHash = exactText(this.workspaceIdentity()?.hash);
        if (!workspaceHash) throw targetError('WEBTTY_TARGET_PROVIDER_UNAVAILABLE');
        let raw;
        try {
            raw = await this.inspectWithGate(candidate.runtime, candidate.containerId, {
                timeoutMs: this.limits.inspectTimeoutMs,
                maxOutputBytes: this.limits.inspectOutputBytes,
            });
            const inspected = assertOwnedInspection(candidate, raw, workspaceHash);
            const mapping = await translateWorkspaceDirectoryToMount(directory.absolutePath, inspected.mounts, {
                fsApi: this.fsApi,
            });
            if (!mapping || inspected.user !== target.targetUser
                || mapping.translatedCwd !== target.translatedCwd || mapping.access !== target.access) {
                throw targetError('WEBTTY_TARGET_STALE');
            }
            routeSnapshot(routePlan);
            return Object.freeze({ ...target, directory });
        } catch (error) {
            if (error?.code === 'WEBTTY_TARGET_PROVIDER_UNAVAILABLE') throw error;
            throw targetError('WEBTTY_TARGET_STALE');
        }
    }
}
