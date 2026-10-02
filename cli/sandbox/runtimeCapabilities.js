import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { isInsideBox } from '../../ploinky-box/lib/boxMarker.mjs';
import { readBoxGpuGrant } from '../../ploinky-box/lib/gpuGrantMarker.mjs';
import {
    BOX_GPU_CDI_DEVICE,
    BOX_GPU_CDI_SPEC_PATH,
    BOX_GPU_MARKER_PATH,
    BOX_MARKER_PATH,
} from '../../ploinky-box/constants.mjs';
import { NESTED_PODMAN_SECCOMP_BOX_PATH } from '../../ploinky-box/seccomp.mjs';
import { PLOINKY_WORKSPACE_ROOT } from '../utils/config.js';
import {
    buildEffectivePolicy,
    canonicalize,
    emitRunArgs,
    validatePolicyShape,
} from './docker/containerRuntimePolicy.js';
import { HardwareLimitsError } from './hardwareLimits/errors.mjs';
import {
    buildDirectRefusal,
    captureHardwareContext,
    evaluateHardwareEligibility,
    hasHardwareRequest,
    requestedHardwareLimits,
} from './hardwareLimits/requestedLimits.mjs';
import {
    AGENT_PLACEMENT,
    LIMITS_HASH_LABEL,
    declaredMemoryBytes,
    limitsHash,
    resolveStoredOverride,
} from './hardwareLimits/resolve.mjs';
import { verifyLaunchedHardwareLimits } from './hardwareLimits/delegation.mjs';
import { engineCommandArgs } from './hardwareLimits/runtimeCommand.mjs';
import { writeAppliedObservation } from './hardwareLimits/runtimeState.mjs';
import { verifyMpsLaunch } from './hardwareLimits/mpsLaunch.mjs';
import { verifyMpsRuntimeObservation } from './hardwareLimits/mpsRuntimeObservation.mjs';

export const RUNTIME_CAPABILITY_POLICY_VERSION = 'ploinky-runtime-capabilities-v1';
const ADMITTED_DESCRIPTORS = new WeakSet();

const CONTAINER_SECURITY_KEYS = new Set(['gpu', 'nestedPodman', 'privileged', 'shmSize']);
// An agent's own /dev/shm size (every agent has its own IPC namespace): whole
// MiB or GiB, from 1m to 16g.
const SHM_SIZE_RE = /^[1-9][0-9]{0,5}[mg]$/;
const MAX_SHM_MIB = 16 * 1024;

function shmSizeMiB(value) {
    return Number(value.slice(0, -1)) * (value.endsWith('g') ? 1024 : 1);
}
const DIRECT_CAPABILITY_FIELDS = new Set([
    'nestedPodman',
    'privileged',
    'devices',
    'device',
    'cdi',
    'gpu',
    'gpus',
    'ipc',
    'pid',
    'uts',
    'userns',
    'securityOpt',
    'securityOptions',
    'rawArgs',
    'extraArgs',
    'dockerArgs',
    'podmanArgs',
    'mounts',
    'binds',
    'hostMounts',
    'sockets',
    'socket',
    'daemon',
    'daemons',
    'capAdd',
    'capDrop',
]);

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function stableDigest(value) {
    const bytes = Buffer.from(JSON.stringify(canonicalize(value)), 'utf8');
    return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function statField(stat, key) {
    const value = stat?.[key];
    return value === undefined ? '' : String(value);
}

function captureBoxContext({ boxMarkerOptions, insideBox } = {}) {
    if (insideBox !== undefined) {
        return deepFreeze({
            insideBox: Boolean(insideBox),
            markerPath: '<explicit>',
            markerIdentity: `explicit:${Boolean(insideBox)}`,
            source: 'explicit',
        });
    }
    const markerOptions = boxMarkerOptions || {};
    const fsApi = markerOptions.fsApi || fs;
    const markerPath = String(
        markerOptions.markerPath
        || BOX_MARKER_PATH,
    );
    const box = isInsideBox({ ...markerOptions, markerPath });
    if (!box) {
        return deepFreeze({
            insideBox: false,
            markerPath,
            markerIdentity: 'absent',
            source: 'strict-marker',
        });
    }
    const stat = fsApi.lstatSync(markerPath);
    const bytes = fsApi.readFileSync(markerPath);
    return deepFreeze({
        insideBox: true,
        markerPath,
        markerIdentity: stableDigest({
            dev: statField(stat, 'dev'),
            ino: statField(stat, 'ino'),
            mode: statField(stat, 'mode'),
            nlink: statField(stat, 'nlink'),
            size: statField(stat, 'size'),
            mtimeNs: statField(stat, 'mtimeNs') || statField(stat, 'mtimeMs'),
            content: manifestBytesDigest(bytes),
        }),
        source: 'strict-marker',
    });
}

// The host GPU grant as seen from inside the Box: the read-only marker plus
// the CDI spec it names. Captured only inside a Box; paths are recorded so the
// pre-launch revalidation reads exactly the same files.
function captureGpuGrantContext({ insideBox, workspaceRoot, gpuGrantOptions } = {}) {
    if (!insideBox) return null;
    const markerPath = String(gpuGrantOptions?.markerPath || BOX_GPU_MARKER_PATH);
    const specPath = String(gpuGrantOptions?.specPath || BOX_GPU_CDI_SPEC_PATH);
    const grant = readBoxGpuGrant({
        workspaceRoot,
        markerPath,
        specPath,
        ...(gpuGrantOptions?.fsApi ? { fsApi: gpuGrantOptions.fsApi } : {}),
    });
    return deepFreeze({ ...grant, markerPath, specPath, workspaceRoot: String(workspaceRoot || '') });
}

// A CDI request is admitted inside a Box only as the one granted device, for
// an agent the Box's GPU wiring names (by the operator's grant or its own
// manifest declaration, D14), while that wiring is active. Each refusal says
// what to run on the host.
function evaluateGpuGrant(context, runtimePolicy, agentId, { declared = false } = {}) {
    if (!context) return null;
    const devices = Array.isArray(runtimePolicy?.devices) ? runtimePolicy.devices : [];
    const cdi = devices.filter((entry) => entry?.type === 'cdi');
    if (cdi.length === 0) return null;
    const agent = agentId || 'REPO/AGENT';
    const grantCommand = `\`ploinky gpu grant --agent ${agent}\``;
    const notApplied = 'GPU not applied to this Box yet; on the host run `ploinky start` '
        + '(`ploinky gpu status` shows whether the host has a usable GPU)';
    let refusal = null;
    if (!context.present) {
        refusal = declared
            ? notApplied
            : `this workspace has no GPU grant for ${agent}; on the host run ${grantCommand}`;
    } else if (!context.valid) {
        refusal = `the Box GPU grant marker is invalid (${context.problem})`;
    } else if (devices.length !== 1 || cdi[0].value !== BOX_GPU_CDI_DEVICE) {
        refusal = `a GPU grant admits only the single device ${BOX_GPU_CDI_DEVICE}`;
    } else if (context.denied?.includes(agentId)) {
        refusal = `GPU access for ${agent} was revoked by the operator; on the host run ${grantCommand}`;
    } else if (context.workspaceDenied === true && !context.agents.includes(agentId)) {
        refusal = 'GPU access was revoked for this workspace by the operator; on the host run '
            + `\`ploinky gpu grant\` to restore manifest defaults, or ${grantCommand}`;
    } else if (context.state === 'stale') {
        refusal = `GPU grant stale: ${context.reason}; fix the host GPU driver, then run \`ploinky restart\` on the host`;
    } else if (!context.agents.includes(agentId)) {
        refusal = declared
            ? notApplied
            : `the Box GPU grant does not name ${agent}; on the host run ${grantCommand}`;
    }
    return {
        markerPath: context.markerPath,
        specPath: context.specPath,
        workspaceRoot: context.workspaceRoot,
        present: context.present === true,
        digest: context.digest || null,
        fingerprint: context.fingerprint || null,
        state: context.state || null,
        admitted: refusal === null,
        refusal,
    };
}

export function manifestBytesDigest(bytes) {
    const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ''), 'utf8');
    return `sha256:${crypto.createHash('sha256').update(source).digest('hex')}`;
}

export class RuntimeCapabilityError extends Error {
    constructor(message, {
        code = 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED',
        status = 422,
        cause,
        context = {},
    } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'RuntimeCapabilityError';
        this.code = code;
        this.status = status;
        this.context = deepFreeze({ ...context });
    }
}

function securityError(message, context = {}) {
    return new RuntimeCapabilityError(message, {
        code: 'PLOINKY_MANIFEST_SECURITY_INVALID',
        context,
    });
}

function validateContainerSecurityBlock(value, context) {
    if (value === undefined) {
        return Object.freeze({
            privileged: false,
            nestedPodman: false,
        });
    }
    if (!isPlainObject(value)) {
        throw securityError('manifest.containerSecurity must be a plain object', context);
    }
    for (const key of Object.keys(value)) {
        if (!CONTAINER_SECURITY_KEYS.has(key)) {
            throw securityError(`manifest.containerSecurity contains unsupported field '${key}'`, context);
        }
    }
    if (value.privileged !== undefined && typeof value.privileged !== 'boolean') {
        throw securityError('manifest.containerSecurity.privileged must be boolean', context);
    }
    if (value.nestedPodman !== undefined && typeof value.nestedPodman !== 'boolean') {
        throw securityError('manifest.containerSecurity.nestedPodman must be boolean', context);
    }
    if (value.gpu !== undefined && typeof value.gpu !== 'boolean') {
        throw securityError('manifest.containerSecurity.gpu must be boolean', context);
    }
    if (value.shmSize !== undefined && (typeof value.shmSize !== 'string' || !SHM_SIZE_RE.test(value.shmSize)
        || shmSizeMiB(value.shmSize) > MAX_SHM_MIB)) {
        throw securityError('manifest.containerSecurity.shmSize must be a size such as 512m or 2g, from 1m to 16g', context);
    }
    if (value.privileged === true && value.nestedPodman === true) {
        throw securityError(
            'manifest.containerSecurity.privileged and nestedPodman are mutually exclusive',
            context,
        );
    }
    return Object.freeze({
        privileged: value.privileged === true,
        nestedPodman: value.nestedPodman === true,
        // Only when declared, so every other agent's descriptor is unchanged.
        ...(value.gpu === true ? { gpu: true } : {}),
        ...(value.shmSize !== undefined ? { shmSize: value.shmSize } : {}),
    });
}

function profileEntries(manifest) {
    if (manifest.profiles === undefined) return [];
    if (!isPlainObject(manifest.profiles)) {
        throw securityError('manifest.profiles must be a plain object');
    }
    return Object.entries(manifest.profiles);
}

function rejectDirectCapabilityFields(value, label, context, { allowProfileMountModes = false } = {}) {
    if (!isPlainObject(value)) return;
    for (const key of Object.keys(value)) {
        if (allowProfileMountModes && key === 'mounts') continue;
        if (DIRECT_CAPABILITY_FIELDS.has(key)) {
            throw securityError(`${label}.${key} is not a supported runtime capability field`, context);
        }
    }
}

function validateLlmRuntimeBlock(value, label, context) {
    if (value === undefined) return;
    if (!isPlainObject(value)) {
        throw securityError(`${label} must be a plain object`, context);
    }
    const allowed = new Set(['enabled', 'allowExperimental', 'runtimePolicy']);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw securityError(`${label} contains unsupported field '${key}'`, context);
        }
    }
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
        throw securityError(`${label}.enabled must be boolean`, context);
    }
    if (value.allowExperimental !== undefined && typeof value.allowExperimental !== 'boolean') {
        throw securityError(`${label}.allowExperimental must be boolean`, context);
    }
    if (value.runtimePolicy !== undefined) {
        validatePolicyShape(value.runtimePolicy, `${label}.runtimePolicy`);
    }
}

function validateVolumesBlock(value, label, context) {
    if (value === undefined) return;
    if (!isPlainObject(value)) {
        throw securityError(`${label} must be a plain object`, context);
    }
}

export function validateManifestRuntimeCapabilities(manifest, {
    agentId = '',
    path = 'manifest',
} = {}) {
    if (!isPlainObject(manifest)) {
        throw securityError(`${path} must be a plain object`, { agentId, path });
    }
    const context = { agentId: String(agentId || ''), path: String(path || 'manifest') };
    rejectDirectCapabilityFields(manifest, path, context);
    const containerSecurity = validateContainerSecurityBlock(manifest.containerSecurity, context);
    validateLlmRuntimeBlock(manifest.llmRuntime, `${path}.llmRuntime`, context);
    validateVolumesBlock(manifest.volumes, `${path}.volumes`, context);
    for (const [profileName, profile] of profileEntries(manifest)) {
        if (!isPlainObject(profile)) {
            throw securityError(`${path}.profiles.${profileName} must be a plain object`, context);
        }
        if (Object.prototype.hasOwnProperty.call(profile, 'containerSecurity')) {
            throw new RuntimeCapabilityError(
                `${path}.profiles.${profileName}.containerSecurity is unsupported; containerSecurity is root-only`,
                {
                    code: 'PLOINKY_MANIFEST_SECURITY_PROFILE_UNSUPPORTED',
                    context: { ...context, profileName },
                },
            );
        }
        rejectDirectCapabilityFields(profile, `${path}.profiles.${profileName}`, {
            ...context,
            profileName,
        }, { allowProfileMountModes: true });
        validateLlmRuntimeBlock(
            profile.llmRuntime,
            `${path}.profiles.${profileName}.llmRuntime`,
            { ...context, profileName },
        );
        validateVolumesBlock(
            profile.volumes,
            `${path}.profiles.${profileName}.volumes`,
            { ...context, profileName },
        );
    }
    return deepFreeze({
        policyVersion: RUNTIME_CAPABILITY_POLICY_VERSION,
        containerSecurity,
    });
}

export function isManagedManifestVolumeSource(source, {
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
} = {}) {
    if (path.isAbsolute(source)) return false;
    const root = path.resolve(workspaceRoot);
    const resolved = path.resolve(root, source);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    let cursor = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        try {
            if (fs.lstatSync(cursor).isSymbolicLink()) return false;
        } catch (error) {
            if (error?.code === 'ENOENT') break;
            throw error;
        }
    }
    try {
        const realRoot = fs.realpathSync.native(root);
        let existing = resolved;
        while (!fs.existsSync(existing) && existing !== root) existing = path.dirname(existing);
        const realExisting = fs.realpathSync.native(existing);
        const realRelative = path.relative(realRoot, realExisting);
        return realRelative !== '..'
            && !realRelative.startsWith(`..${path.sep}`)
            && !path.isAbsolute(realRelative);
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

function normalizeVolumes(volumes, { workspaceRoot = PLOINKY_WORKSPACE_ROOT } = {}) {
    if (volumes === undefined) return [];
    return Object.entries(volumes).sort(([left], [right]) => left.localeCompare(right)).map(([source, target]) => ({
        source: String(source),
        target: typeof target === 'string' ? target : String(target?.target || ''),
        managed: isManagedManifestVolumeSource(String(source), { workspaceRoot }),
    }));
}

export function resolveEffectiveRuntimeCapabilities(manifest, {
    agentId = '',
    profileName = '',
    profileConfig = null,
    network = null,
    runtime = '',
    catalogPolicy = null,
    catalogIdentity = null,
    overridePolicy = null,
    manifestDigest = '',
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    boxContext = null,
    gpuGrantContext = null,
} = {}) {
    const validated = validateManifestRuntimeCapabilities(manifest, {
        agentId,
        path: agentId ? `manifest(${agentId})` : 'manifest',
    });
    const policySources = {
        manifestPolicy: manifest?.llmRuntime?.runtimePolicy || null,
        catalogPolicy,
        profilePolicy: profileConfig?.llmRuntime?.runtimePolicy || null,
        overridePolicy,
    };
    let runtimePolicy = buildEffectivePolicy(policySources, { runtime });
    // The exact memory/cpus/pidsLimit request and its declaring layer, kept
    // whether or not llmRuntime.enabled is set (plan §8.1, R10).
    const hardwareRequest = requestedHardwareLimits(policySources);
    // `containerSecurity.shmSize` sizes the agent's own /dev/shm. The
    // operator's runtime policy wins: a size it sets, and host IPC, where a
    // size cannot apply (outside a Box; a Box refuses host IPC).
    if (validated.containerSecurity.shmSize && runtimePolicy.resources?.shmSize === undefined
        && runtimePolicy.ipc !== 'host') {
        runtimePolicy = validatePolicyShape({
            ...runtimePolicy,
            resources: { ...(runtimePolicy.resources || {}), shmSize: validated.containerSecurity.shmSize },
        }, 'effective.runtimePolicy', { runtime }) || {};
    }
    // `containerSecurity.gpu` (D14, amended) attaches the one GPU device when
    // this Box's wiring names the agent; otherwise the agent starts without
    // it and is told why. An explicit CDI request in the runtime policy stays
    // on the strict operator path below.
    const declaresGpu = validated.containerSecurity.gpu === true;
    const requestsCdi = Array.isArray(runtimePolicy.devices)
        && runtimePolicy.devices.some((entry) => entry?.type === 'cdi');
    let gpuAttach = null;
    if (declaresGpu && !requestsCdi) {
        const probe = evaluateGpuGrant(gpuGrantContext, { devices: [{ type: 'cdi', value: BOX_GPU_CDI_DEVICE }] },
            String(agentId || ''), { declared: true });
        const attached = probe?.admitted === true;
        gpuAttach = {
            attached,
            reason: attached ? null : (probe?.refusal || 'this agent is not running in a Ploinky Box, so no GPU is attached'),
        };
        if (attached) {
            runtimePolicy = validatePolicyShape({
                ...runtimePolicy,
                devices: [...(runtimePolicy.devices || []), { type: 'cdi', value: BOX_GPU_CDI_DEVICE }],
            }, 'effective.runtimePolicy', { runtime }) || {};
        }
    }
    const networkMode = String(network?.mode || profileConfig?.network?.mode || manifest?.network?.mode || 'managed')
        .trim().toLowerCase() || 'managed';
    const volumes = normalizeVolumes({
        ...(manifest?.volumes || {}),
        ...(profileConfig?.volumes || {}),
    }, { workspaceRoot });
    const capabilities = {
        privileged: validated.containerSecurity.privileged,
        nestedPodman: validated.containerSecurity.nestedPodman,
        devices: Array.isArray(runtimePolicy.devices) ? runtimePolicy.devices.length : 0,
        cdi: Array.isArray(runtimePolicy.devices)
            ? runtimePolicy.devices.filter((entry) => entry?.type === 'cdi').length
            : 0,
        gpu: Boolean(runtimePolicy.gpus),
        hostIpc: runtimePolicy.ipc === 'host',
        securityOptions: Array.isArray(runtimePolicy.securityOpt) ? runtimePolicy.securityOpt.length : 0,
        hostNetwork: networkMode === 'host',
        unmanagedHostMounts: volumes.filter((entry) => entry.managed === false).length,
        llmRuntime: manifest?.llmRuntime?.enabled === true || profileConfig?.llmRuntime?.enabled === true,
    };
    const descriptor = {
        schemaVersion: 1,
        policyVersion: RUNTIME_CAPABILITY_POLICY_VERSION,
        agentId: String(agentId || ''),
        profileName: String(profileName || ''),
        manifestDigest: String(manifestDigest || '') || stableDigest(manifest),
        containerSecurity: validated.containerSecurity,
        runtimePolicy,
        catalogIdentity: catalogIdentity ? canonicalize(catalogIdentity) : null,
        boxContext: boxContext ? canonicalize(boxContext) : null,
        network: { mode: networkMode },
        volumes,
        capabilities,
    };
    // Present only for a CDI request made inside a Box, so the descriptors of
    // every other agent are unchanged.
    const gpuGrant = evaluateGpuGrant(gpuGrantContext, runtimePolicy, descriptor.agentId, { declared: declaresGpu });
    if (gpuGrant) descriptor.gpuGrant = canonicalize(gpuGrant);
    if (gpuAttach) descriptor.gpuAttach = canonicalize(gpuAttach);
    // Present only when a hardware limit is requested, so the descriptors of
    // every unlimited agent are unchanged.
    if (hardwareRequest.length) descriptor.hardwareRequest = canonicalize(hardwareRequest);
    return deepFreeze(descriptor);
}

function hardwareRefusalIdentity(descriptor, { instanceKey, alias }) {
    return {
        key: String(instanceKey || descriptor.agentId || ''),
        ref: descriptor.agentId,
        alias: alias ? String(alias) : null,
    };
}

// Hardware eligibility for an admitted descriptor (plan §9.1). Strict
// admission throws a typed refusal; metadata admission records it so graph
// staging can continue for unrelated agents. Outside the hardware boundary
// (a container outside a Box, or an internal helper) nothing is recorded.
function admitHardwareEligibility(descriptor, {
    context,
    instanceKey,
    alias,
    helper,
    overrideProblem = null,
}) {
    const eligibility = evaluateHardwareEligibility(descriptor, context, { helper, overrideProblem });
    if (!eligibility.applicable) return null;
    const refusal = eligibility.state === 'refused'
        ? buildDirectRefusal({
            ...hardwareRefusalIdentity(descriptor, { instanceKey, alias }),
            refusalParts: eligibility.refusalParts,
            inputFingerprint: eligibility.inputFingerprint,
        })
        : null;
    return deepFreeze({
        schema: 1,
        state: eligibility.state,
        inputFingerprint: eligibility.inputFingerprint,
        refusal,
    });
}

function unsupportedDimensions(descriptor, runtimeKind, box = false) {
    const unsupported = [];
    // The operator's Box GPU grant admits exactly one CDI device and nothing
    // else: host devices, --gpus, host IPC and security options stay refused.
    const gpuGranted = box === true && runtimeKind === 'container' && descriptor.gpuGrant?.admitted === true;
    if (descriptor.capabilities.privileged) unsupported.push('privileged');
    if (runtimeKind !== 'container' && descriptor.capabilities.nestedPodman) {
        unsupported.push('nested-podman');
    }
    if (descriptor.capabilities.devices && !gpuGranted) unsupported.push('devices');
    if (descriptor.capabilities.cdi && !gpuGranted) unsupported.push('cdi');
    if (descriptor.capabilities.gpu) unsupported.push('gpu');
    if (descriptor.capabilities.hostIpc) unsupported.push('host-ipc');
    if (descriptor.capabilities.securityOptions) unsupported.push('security-options');
    if (descriptor.capabilities.unmanagedHostMounts) {
        unsupported.push('host-mounts');
    }
    if (runtimeKind !== 'container' && descriptor.capabilities.llmRuntime) {
        unsupported.push('llm-runtime-container-policy');
    }
    return unsupported;
}

export function assertRuntimeCapabilitiesAllowed(descriptor, {
    runtimeKind = 'container',
    boxMarkerOptions,
    insideBox,
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
} = {}) {
    if (!descriptor || descriptor.policyVersion !== RUNTIME_CAPABILITY_POLICY_VERSION) {
        throw new RuntimeCapabilityError('runtime capability descriptor is missing or stale', {
            code: 'PLOINKY_RUNTIME_INPUT_CHANGED',
        });
    }
    let box = insideBox;
    if (box === undefined) box = isInsideBox(boxMarkerOptions);
    const unsupported = unsupportedDimensions(descriptor, runtimeKind, box);
    if (!box && descriptor.capabilities.nestedPodman) unsupported.push('nested-podman-outside-box');
    // Host networking is not an ordinary Box capability: the runtime boundary
    // separately requires an exact prepared or active generation grant before
    // it can render `--network host`.  Keep it in the immutable descriptor so
    // that grant is bound to the admitted bytes, but do not reject it during
    // graph admission before the generation authority exists.
    if (box && runtimeKind !== 'container' && descriptor.capabilities.hostNetwork) {
        unsupported.push('box-host-sandbox');
    }
    if (runtimeKind !== 'container' && descriptor.capabilities.hostNetwork !== true) {
        unsupported.push('isolated-network-host-sandbox');
    }
    if ((box || runtimeKind !== 'container' || descriptor.capabilities.nestedPodman) && unsupported.length) {
        const gpuRefusal = unsupported.includes('cdi') && descriptor.gpuGrant?.refusal
            ? `; ${descriptor.gpuGrant.refusal}`
            : '';
        throw new RuntimeCapabilityError(
            `runtime capabilities are unsupported for ${box ? 'Ploinky Box' : runtimeKind}: ${unsupported.join(', ')}${gpuRefusal}`,
            {
                context: {
                    agentId: descriptor.agentId,
                    profileName: descriptor.profileName,
                    runtimeKind,
                    unsupported,
                },
            },
        );
    }
    return descriptor;
}

export function admitManifestRuntimeCapabilities(manifest, {
    manifestBytes,
    manifestPath = '',
    agentId = '',
    profileName = '',
    profileConfig = null,
    network = null,
    runtime = '',
    runtimeKind = 'container',
    catalogPolicy = null,
    catalogIdentity = null,
    overridePolicy = null,
    boxMarkerOptions,
    insideBox,
    gpuGrantOptions,
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    hardwareAdmission = 'strict',
    hardwareContext,
    instanceKey = '',
    alias = '',
    helper = false,
} = {}) {
    if (hardwareAdmission !== 'strict' && hardwareAdmission !== 'metadata') {
        throw new RuntimeCapabilityError(`unsupported hardware admission mode '${hardwareAdmission}'`, {
            code: 'PLOINKY_RUNTIME_INPUT_CHANGED',
        });
    }
    let exactManifest = manifest;
    if (manifestBytes !== undefined) {
        try {
            exactManifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
        } catch (cause) {
            throw new RuntimeCapabilityError('manifest bytes are not valid JSON', {
                code: 'PLOINKY_RUNTIME_INPUT_CHANGED',
                cause,
                context: { agentId: String(agentId || '') },
            });
        }
        if (!isDeepStrictEqual(exactManifest, manifest)) {
            throw new RuntimeCapabilityError('manifest object does not match the exact admitted bytes', {
                code: 'PLOINKY_RUNTIME_INPUT_CHANGED',
                context: { agentId: String(agentId || '') },
            });
        }
    }
    const exactDigest = manifestBytes === undefined
        ? stableDigest(exactManifest)
        : manifestBytesDigest(manifestBytes);
    const boxContext = captureBoxContext({ boxMarkerOptions, insideBox });
    const hardwareFacts = captureHardwareContext({ insideBox: boxContext.insideBox, runtimeKind, hardwareContext });
    // A stored administrator override is the final policy layer (plan §3
    // Overrides): its fields replace the declared ones; unspecified fields keep
    // their declared values.
    let effectiveOverride = overridePolicy;
    let overrideProblem = null;
    let hardwareGpu = null;
    const storedOverride = effectiveOverride === null && !helper && hardwareFacts.gate === 'on'
        ? hardwareFacts.overrides.get(String(agentId || '')) || null
        : null;
    if (storedOverride) {
        const resolved = resolveStoredOverride(storedOverride, hardwareFacts.envelope, { ref: String(agentId || 'REPO/AGENT'), gpu: hardwareFacts.gpu });
        hardwareGpu = resolved.gpu || null;
        if (resolved.problem) overrideProblem = resolved.problem;
        else effectiveOverride = hardwareGpu ? { ...(resolved.policy || {}), devices: [{ type: 'cdi', value: BOX_GPU_CDI_DEVICE }] } : resolved.policy;
    }
    let descriptor = resolveEffectiveRuntimeCapabilities(exactManifest, {
        agentId,
        profileName,
        profileConfig,
        network,
        runtime,
        catalogPolicy,
        catalogIdentity,
        overridePolicy: effectiveOverride,
        manifestDigest: exactDigest,
        workspaceRoot,
        boxContext,
        gpuGrantContext: captureGpuGrantContext({
            insideBox: boxContext.insideBox,
            workspaceRoot,
            gpuGrantOptions,
        }),
    });
    if (hardwareGpu) descriptor = deepFreeze({ ...descriptor, hardwareGpu, hardwareRequest: [...(descriptor.hardwareRequest || []), { field: 'gpu', value: `${hardwareGpu.smPercent}/${hardwareGpu.vramPercent} percent`, source: 'settings' }] });
    // Every non-hardware capability error stays strict in both modes.
    assertRuntimeCapabilitiesAllowed(descriptor, {
        runtimeKind,
        insideBox: boxContext.insideBox,
    });
    const hardwareEligibility = admitHardwareEligibility(descriptor, {
        context: hardwareFacts,
        instanceKey,
        alias,
        helper,
        overrideProblem,
    });
    if (hardwareEligibility?.state === 'refused' && hardwareAdmission === 'strict') {
        throw new HardwareLimitsError(hardwareEligibility.refusal);
    }
    const placement = hardwareEligibility?.state === 'eligible'
        ? hardwarePlacementFor(descriptor, hardwareFacts, runtimeKind)
        : null;
    if (placement || storedOverride) {
        descriptor = deepFreeze({
            ...descriptor,
            // The exact stored entry this admission used: a later change to
            // this agent's own override makes the admission stale.
            ...(storedOverride ? { hardwareOverride: canonicalize({ ...storedOverride }) } : {}),
            ...(placement ? { hardwarePlacement: canonicalize(placement) } : {}),
        });
    }
    // Only strict admission grants launch authority. A metadata descriptor can
    // be checked for currentness but can never render runtime arguments.
    if (hardwareAdmission === 'strict') ADMITTED_DESCRIPTORS.add(descriptor);
    return deepFreeze({
        schemaVersion: 1,
        manifestPath: String(manifestPath || ''),
        manifestDigest: exactDigest,
        agentId: String(agentId || ''),
        profileName: String(profileName || ''),
        runtimeKind,
        descriptor,
        ...(hardwareEligibility ? { hardwareEligibility } : {}),
    });
}

/**
 * Prepared gate-on agents run under /ploinky/agents in a private cgroup
 * namespace with enabled cgroups; the unlimited D4 combination (host network
 * plus nestedPodman) and every unprepared Box keep the baseline argv.
 */
function hardwarePlacementFor(descriptor, context, runtimeKind) {
    if (runtimeKind !== 'container' || context.gate !== 'on' || !context.prepared || !context.backendReady) return null;
    const requested = Array.isArray(descriptor.hardwareRequest) ? descriptor.hardwareRequest : [];
    if (descriptor.capabilities?.hostNetwork && descriptor.capabilities?.nestedPodman && !hasHardwareRequest(requested)) return null;
    const resources = descriptor.runtimePolicy?.resources || {};
    const resolved = {
        // Canonical decimal: 0.5 and 0.50 are the same rendered quota.
        cpus: resources.cpus === undefined ? null : String(Number(resources.cpus)),
        memoryBytes: resources.memory === undefined ? null : declaredMemoryBytes(resources.memory),
        pidsLimit: resources.pidsLimit === undefined ? null : Number(resources.pidsLimit),
    };
    return {
        ...AGENT_PLACEMENT,
        enginePrefix: ['--cgroup-manager=cgroupfs'],
        hardSwap: true,
        expected: resolved,
        limitsHash: limitsHash({ resolved, placement: AGENT_PLACEMENT, hardSwap: true, gpu: descriptor.hardwareGpu || null }),
    };
}

// The engine-level prefix for create/start/exec of a hardware-placed agent;
// empty for every other invocation so its command form is unchanged.
export function hardwareCommandPrefix(descriptor) {
    const prefix = descriptor?.hardwarePlacement?.enginePrefix;
    return Array.isArray(prefix) ? [...prefix] : [];
}

export function hardwareLimitsHashOf(descriptor) {
    return String(descriptor?.hardwarePlacement?.limitsHash || '');
}

// The one limits-hash comparison shared by managed adoption, host/none reuse
// and graph reuse: 'limitsHashChanged' when the runtime's label differs from
// the admitted descriptor's hash (both empty without hardware placement).
export function limitsHashReuseReason(descriptor, observedLabel) {
    return hardwareLimitsHashOf(descriptor) === String(observedLabel || '') ? null : 'limitsHashChanged';
}

// The refusal recorded by a metadata admission, or null.
export function hardwareRefusalOf(admission) {
    return admission?.hardwareEligibility?.state === 'refused' ? admission.hardwareEligibility.refusal : null;
}

/**
 * The hardware steps of one managed agent launch, in their required order
 * (plan §8.1, §8.3): immediately before create, recheck the admission's
 * hardware inputs and add the engine prefix; after create/start, read the
 * actual leaf back (an observed mismatch is a typed refusal; a process that
 * is not running is an ordinary failure) and recheck the inputs again before
 * the candidate can be returned for route publication. The caller's existing
 * catch removes the candidate through its exact ownership checks.
 */
export function createHardwareLaunchGuard(runtimeAdmission, {
    key,
    ref,
    alias = null,
    runtime = 'podman',
    query,
    hardwareContext,
    fsApi,
    cgroupRoot,
    procRoot,
    instanceId,
    enableGeneration,
    recordApplied = writeAppliedObservation,
    observationKey = key,
    mpsLaunch,
    mpsVerification,
} = {}) {
    const descriptor = runtimeAdmission.descriptor;
    const recheck = () => assertHardwareAdmissionCurrent(runtimeAdmission, { hardwareContext });
    return Object.freeze({
        createArgs(args) {
            recheck();
            return engineCommandArgs(hardwareCommandPrefix(descriptor), args);
        },
        commandPrefix() {
            return hardwareCommandPrefix(descriptor);
        },
        // An adopted runtime is read back too: a leftover container carrying
        // a matching limits-hash label is never proof that its leaf holds the
        // admitted limits (plan §8.1: an inspect field alone is not proof).
        afterLaunch({ containerId }) {
            let readback = null;
            if (descriptor.hardwarePlacement) {
                readback = verifyLaunchedHardwareLimits({
                    descriptor,
                    containerId,
                    runtime,
                    query,
                    ...(fsApi ? { fsApi } : {}),
                    ...(cgroupRoot ? { cgroupRoot } : {}),
                    ...(procRoot ? { procRoot } : {}),
                    refuse: (detail, parts = null) => new HardwareLimitsError(buildDirectRefusal({
                        key,
                        ref,
                        alias,
                        refusalParts: {
                            reasonCode: parts?.reasonCode || 'unprepared',
                            reason: parts?.reason || `This Box is not prepared for hardware limits: ${detail}.`,
                            fix: parts?.fix || 'On the host run ploinky limits status, repair the reported prerequisite, then ploinky restart.',
                            requested: descriptor.hardwareRequest || [],
                        },
                        inputFingerprint: runtimeAdmission.hardwareEligibility?.inputFingerprint || '0'.repeat(64),
                    })),
                });
            }
            recheck();
            const mps = descriptor.hardwareGpu ? verifyMpsLaunch(mpsLaunch, key, descriptor.hardwareGpu, mpsVerification) : null;
            if (mps) verifyMpsRuntimeObservation({ containerId, imageId: mps.imageId, share: descriptor.hardwareGpu, state: mps.state, runtime, ...(query ? { query } : {}) });
            if (readback && instanceId && enableGeneration) {
                const cpu = String(readback.observed['cpu.max'] || '').split(/\s+/);
                recordApplied({
                    key: observationKey, containerId, instanceId, enableGeneration,
                    limitsHash: descriptor.hardwarePlacement.limitsHash,
                    cpus: cpu.length === 2 && cpu[0] !== 'max' ? Number(cpu[0]) / Number(cpu[1]) : null,
                    memoryBytes: readback.observed['memory.max'] && readback.observed['memory.max'] !== 'max' ? Number(readback.observed['memory.max']) : null,
                    cgroupNamespace: readback.cgroupNamespace, leaf: readback.leaf,
                    ...(mps ? { imageId: mps.imageId, gpuShare: descriptor.hardwareGpu, mpsGeneration: `${mps.state.daemonGeneration}:${mps.state.configurationGeneration}` } : {}),
                });
            }
        },
    });
}

export function assertRuntimeAdmissionCurrent(admission, {
    manifestBytes,
    profileName,
    runtimeKind,
    descriptor,
    boxMarkerOptions,
    gpuGrantOptions,
    hardwareContext,
} = {}) {
    if (!admission || admission.schemaVersion !== 1 || !admission.descriptor) {
        throw new RuntimeCapabilityError('runtime admission is missing or invalid', {
            code: 'PLOINKY_RUNTIME_INPUT_CHANGED',
        });
    }
    if (manifestBytes !== undefined && manifestBytesDigest(manifestBytes) !== admission.manifestDigest) {
        throw new RuntimeCapabilityError('manifest bytes changed after runtime admission', {
            code: 'PLOINKY_RUNTIME_INPUT_CHANGED',
            context: { agentId: admission.agentId },
        });
    }
    if (profileName !== undefined && String(profileName || '') !== admission.profileName) {
        throw new RuntimeCapabilityError('selected profile changed after runtime admission', {
            code: 'PLOINKY_RUNTIME_INPUT_CHANGED',
            context: { agentId: admission.agentId },
        });
    }
    if (runtimeKind !== undefined && String(runtimeKind) !== admission.runtimeKind) {
        throw new RuntimeCapabilityError('runtime backend changed after admission', {
            code: 'PLOINKY_RUNTIME_INPUT_CHANGED',
            context: { agentId: admission.agentId },
        });
    }
    if (descriptor !== undefined
        && runtimeCapabilityDigest(descriptor) !== runtimeCapabilityDigest(admission.descriptor)) {
        throw new RuntimeCapabilityError('effective runtime capabilities changed after admission', {
            code: 'PLOINKY_RUNTIME_INPUT_CHANGED',
            context: { agentId: admission.agentId },
        });
    }
    const admittedBoxContext = admission.descriptor.boxContext;
    if (admittedBoxContext?.source === 'strict-marker') {
        const currentBoxContext = captureBoxContext({
            boxMarkerOptions: boxMarkerOptions || { markerPath: admittedBoxContext.markerPath },
        });
        if (stableDigest(currentBoxContext) !== stableDigest(admittedBoxContext)) {
            throw new RuntimeCapabilityError('Ploinky Box marker context changed after admission', {
                code: 'PLOINKY_RUNTIME_INPUT_CHANGED',
                context: { agentId: admission.agentId },
            });
        }
    }
    // A GPU-admitted launch rereads the grant marker and CDI spec immediately
    // before it runs: a revoked, stale, or replaced grant stops it here.
    const admittedGpuGrant = admission.descriptor.gpuGrant;
    if (admittedGpuGrant) {
        const current = evaluateGpuGrant(captureGpuGrantContext({
            insideBox: true,
            workspaceRoot: admittedGpuGrant.workspaceRoot,
            gpuGrantOptions: {
                markerPath: admittedGpuGrant.markerPath,
                specPath: admittedGpuGrant.specPath,
                ...(gpuGrantOptions?.fsApi ? { fsApi: gpuGrantOptions.fsApi } : {}),
            },
        }), admission.descriptor.runtimePolicy, admission.descriptor.agentId);
        if (stableDigest(current) !== stableDigest(admittedGpuGrant)) {
            throw new RuntimeCapabilityError('Ploinky Box GPU grant changed after admission', {
                code: 'PLOINKY_RUNTIME_INPUT_CHANGED',
                context: { agentId: admission.agentId },
            });
        }
    }
    assertHardwareAdmissionCurrent(admission, { hardwareContext });
    return admission;
}

/**
 * The hardware part of currentness, rechecked immediately before create and
 * again before a launched candidate can be published. A refused record is as
 * current-checkable as an eligible one: any change to the hardware inputs
 * (gate, preparation, controllers, this agent's stored entry or the request
 * itself) makes the admission stale. Another agent's policy revision does not.
 */
export function assertHardwareAdmissionCurrent(admission, { hardwareContext } = {}) {
    const admittedHardware = admission?.hardwareEligibility;
    if (admittedHardware) {
        const freshContext = captureHardwareContext({
            insideBox: admission.descriptor.boxContext?.insideBox === true,
            runtimeKind: admission.runtimeKind,
            hardwareContext,
        });
        const freshOverride = freshContext.gate === 'on' ? freshContext.overrides.get(admission.descriptor.agentId) || null : null;
        // Recompute the admission's override problem from the same inputs so a
        // refused over-envelope entry stays current while nothing changed.
        const overrideProblem = freshOverride
            ? resolveStoredOverride(freshOverride, freshContext.envelope, { ref: String(admission.descriptor.agentId || 'REPO/AGENT'), gpu: freshContext.gpu }).problem
            : null;
        const current = evaluateHardwareEligibility(admission.descriptor, freshContext, { overrideProblem });
        const admittedOverride = admission.descriptor.hardwareOverride || null;
        if (stableDigest(freshOverride ? canonicalize({ ...freshOverride }) : null) !== stableDigest(admittedOverride)) {
            throw new RuntimeCapabilityError('this agent\'s stored hardware limits changed after admission', {
                code: 'PLOINKY_RUNTIME_INPUT_CHANGED',
                context: { agentId: admission.agentId },
            });
        }
        if (!current.applicable || current.inputFingerprint !== admittedHardware.inputFingerprint) {
            throw new RuntimeCapabilityError('hardware-limit inputs changed after admission', {
                code: 'PLOINKY_RUNTIME_INPUT_CHANGED',
                context: { agentId: admission.agentId },
            });
        }
    }
    return admission;
}

export function renderContainerSecurityArgs(descriptor) {
    if (!descriptor || descriptor.policyVersion !== RUNTIME_CAPABILITY_POLICY_VERSION
        || !ADMITTED_DESCRIPTORS.has(descriptor) || !Object.isFrozen(descriptor)) {
        throw new RuntimeCapabilityError('container arguments require an admitted runtime capability descriptor', {
            code: 'PLOINKY_RUNTIME_INPUT_CHANGED',
        });
    }
    if (descriptor.containerSecurity.privileged) return ['--privileged'];
    if (!descriptor.containerSecurity.nestedPodman) return [];
    return [
        '--cap-add', 'SYS_ADMIN',
        '--cap-add', 'NET_ADMIN',
        '--device', '/dev/fuse',
        '--device', '/dev/net/tun',
        '--security-opt', 'label=disable',
        '--security-opt', `seccomp=${NESTED_PODMAN_SECCOMP_BOX_PATH}`,
    ];
}

export function renderRuntimePolicyArgs(descriptor, { runtime } = {}) {
    if (!descriptor || descriptor.policyVersion !== RUNTIME_CAPABILITY_POLICY_VERSION
        || !ADMITTED_DESCRIPTORS.has(descriptor) || !Object.isFrozen(descriptor)) {
        throw new RuntimeCapabilityError('runtime policy arguments require an admitted capability descriptor', {
            code: 'PLOINKY_RUNTIME_INPUT_CHANGED',
        });
    }
    const args = emitRunArgs(descriptor.runtimePolicy, { runtime });
    const placement = descriptor.hardwarePlacement;
    if (placement) {
        // Every rendered agent memory limit has an equal memory-and-swap
        // limit so swap cannot extend the cap (leaf memory.swap.max = 0).
        const memoryIndex = args.indexOf('--memory');
        if (memoryIndex >= 0) args.splice(memoryIndex + 2, 0, '--memory-swap', args[memoryIndex + 1]);
        args.push(
            `--cgroups=${placement.cgroups}`,
            `--cgroupns=${placement.cgroupns}`,
            `--cgroup-parent=${placement.cgroupParent}`,
            '--label', `${LIMITS_HASH_LABEL}=${placement.limitsHash}`,
        );
    }
    // A manifest-declared GPU agent learns whether it got the device and, if
    // not, what to run on the host (D14).
    if (descriptor.gpuAttach) {
        args.push('--env', `PLOINKY_GPU_STATUS=${descriptor.gpuAttach.attached ? 'attached' : 'unavailable'}`);
        if (!descriptor.gpuAttach.attached) args.push('--env', `PLOINKY_GPU_REASON=${descriptor.gpuAttach.reason}`);
    }
    return args;
}

export function runtimeCapabilityDigest(descriptor) {
    return stableDigest(descriptor);
}
