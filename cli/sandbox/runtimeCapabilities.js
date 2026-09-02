import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { isInsideBox } from '../../ploinky-box/lib/boxMarker.mjs';
import { BOX_MARKER_PATH } from '../../ploinky-box/constants.mjs';
import { NESTED_PODMAN_SECCOMP_BOX_PATH } from '../../ploinky-box/seccomp.mjs';
import { PLOINKY_WORKSPACE_ROOT } from '../utils/config.js';
import {
    buildEffectivePolicy,
    canonicalize,
    emitRunArgs,
    validatePolicyShape,
} from './docker/containerRuntimePolicy.js';

export const RUNTIME_CAPABILITY_POLICY_VERSION = 'ploinky-runtime-capabilities-v1';
const ADMITTED_DESCRIPTORS = new WeakSet();

const CONTAINER_SECURITY_KEYS = new Set(['nestedPodman', 'privileged']);
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
    if (value.privileged === true && value.nestedPodman === true) {
        throw securityError(
            'manifest.containerSecurity.privileged and nestedPodman are mutually exclusive',
            context,
        );
    }
    return Object.freeze({
        privileged: value.privileged === true,
        nestedPodman: value.nestedPodman === true,
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
} = {}) {
    const validated = validateManifestRuntimeCapabilities(manifest, {
        agentId,
        path: agentId ? `manifest(${agentId})` : 'manifest',
    });
    const runtimePolicy = buildEffectivePolicy({
        manifestPolicy: manifest?.llmRuntime?.runtimePolicy || null,
        catalogPolicy,
        profilePolicy: profileConfig?.llmRuntime?.runtimePolicy || null,
        overridePolicy,
    }, { runtime });
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
    return deepFreeze(descriptor);
}

function unsupportedDimensions(descriptor, runtimeKind) {
    const unsupported = [];
    if (descriptor.capabilities.privileged) unsupported.push('privileged');
    if (runtimeKind !== 'container' && descriptor.capabilities.nestedPodman) {
        unsupported.push('nested-podman');
    }
    if (descriptor.capabilities.devices) unsupported.push('devices');
    if (descriptor.capabilities.cdi) unsupported.push('cdi');
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
    const unsupported = unsupportedDimensions(descriptor, runtimeKind);
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
        throw new RuntimeCapabilityError(
            `runtime capabilities are unsupported for ${box ? 'Ploinky Box' : runtimeKind}: ${unsupported.join(', ')}`,
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
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
} = {}) {
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
    const descriptor = resolveEffectiveRuntimeCapabilities(exactManifest, {
        agentId,
        profileName,
        profileConfig,
        network,
        runtime,
        catalogPolicy,
        catalogIdentity,
        overridePolicy,
        manifestDigest: exactDigest,
        workspaceRoot,
        boxContext,
    });
    assertRuntimeCapabilitiesAllowed(descriptor, {
        runtimeKind,
        insideBox: boxContext.insideBox,
    });
    ADMITTED_DESCRIPTORS.add(descriptor);
    return deepFreeze({
        schemaVersion: 1,
        manifestPath: String(manifestPath || ''),
        manifestDigest: exactDigest,
        agentId: String(agentId || ''),
        profileName: String(profileName || ''),
        runtimeKind,
        descriptor,
    });
}

export function assertRuntimeAdmissionCurrent(admission, {
    manifestBytes,
    profileName,
    runtimeKind,
    descriptor,
    boxMarkerOptions,
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
    return emitRunArgs(descriptor.runtimePolicy, { runtime });
}

export function runtimeCapabilityDigest(descriptor) {
    return stableDigest(descriptor);
}
