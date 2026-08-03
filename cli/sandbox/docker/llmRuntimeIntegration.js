import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { loadCatalog } from './llmArchitectureCatalog.js';
import { selectArchitecture } from './llmArchitectureSelector.js';
import {
    buildEffectivePolicy,
    computeRuntimePolicyHash,
    emitRunArgs,
} from './containerRuntimePolicy.js';
import { detectHardware } from './hardwareDetection.js';
import { isSensitiveEnvVariableName } from '../../utils/security/secretVars.js';

const SAFE_AGENT_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function isLlmRuntimeManifest(manifest, profileConfig) {
    const profileFlag = profileConfig?.llmRuntime?.enabled === true;
    const manifestFlag = manifest?.llmRuntime?.enabled === true;
    return Boolean(profileFlag || manifestFlag);
}

function extractManifestPolicy(manifest, profileConfig) {
    const profilePolicy = profileConfig?.llmRuntime?.runtimePolicy;
    const manifestPolicy = manifest?.llmRuntime?.runtimePolicy;
    return profilePolicy || manifestPolicy || null;
}

function safeIdentity({ agentName, alias }) {
    const candidate = String(alias || agentName || '').trim();
    if (!SAFE_AGENT_KEY_RE.test(candidate)) return null;
    return candidate;
}

function buildSelectedArchitectureState({ selection, hardware, policy, policyHash, manifestEnvNames, identity }) {
    const safeProbes = {};
    for (const [name, probe] of Object.entries(hardware?.probes || {})) {
        safeProbes[name] = { ok: Boolean(probe?.ok), timedOut: Boolean(probe?.timedOut) };
    }
    return {
        schemaVersion: 1,
        writtenAt: new Date().toISOString(),
        agent: {
            name: identity,
        },
        catalog: {
            id: selection.catalogId,
            ref: selection.catalogRef,
        },
        architecture: {
            id: selection.architectureId,
            platform: selection.platform,
            acceleratorFamily: selection.acceleratorFamily,
            imageId: selection.imageId,
            imageRef: selection.imageRef,
            imageDigest: selection.imageDigest,
            imageSource: selection.imageSource,
        },
        runtimePolicy: policy,
        runtimePolicyHash: policyHash,
        hardware: {
            runtime: hardware?.runtime || null,
            nodeArch: hardware?.nodeArch || null,
            nodePlatform: hardware?.nodePlatform || null,
            ociPlatform: hardware?.ociPlatform || null,
            acceleratorFamilies: Array.isArray(hardware?.acceleratorFamilies) ? hardware.acceleratorFamilies.slice() : [],
            probes: safeProbes,
        },
        explanation: selection.explanation || {},
        envExposed: Array.isArray(manifestEnvNames)
            ? manifestEnvNames.filter((name) => !isSensitiveEnvVariableName(name))
            : [],
    };
}

function ensureRuntimeStateDir(rootDir, identity) {
    const stateDir = path.join(rootDir, identity, 'runtime');
    fs.mkdirSync(stateDir, { recursive: true });
    return stateDir;
}

function ensureModelsDir(rootDir, identity) {
    const modelsDir = path.join(rootDir, identity, 'models');
    fs.mkdirSync(modelsDir, { recursive: true });
    return modelsDir;
}

function writeSelectedArchitectureFile(stateDir, payload) {
    const filePath = path.join(stateDir, 'selected-architecture.json');
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
    try { fs.chmodSync(filePath, 0o600); } catch (_) {}
    return filePath;
}

function computeReuseHash(parts) {
    const sorted = Object.keys(parts).sort().reduce((acc, key) => {
        acc[key] = parts[key];
        return acc;
    }, {});
    return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function prepareLlmStartup(input) {
    const {
        runtime,
        manifest,
        profileConfig,
        agentName,
        alias,
        env = process.env,
        agentWorkDirRoot,
        manifestEnvNames = [],
        envHash,
        effectiveNetwork = null,
        writeState = true,
        createDirectories = true,
        resolvedSelection = null,
        resolvedHardware = null,
        admittedRuntimePolicy = null,
        emitRuntimeArgs = true,
    } = input || {};

    if (!isLlmRuntimeManifest(manifest, profileConfig)) {
        return { enabled: false };
    }

    const identity = safeIdentity({ agentName, alias });
    if (!identity) {
        throw new Error(`[llm-runtime] ${agentName}: agent name/alias must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`);
    }

    const hardware = resolvedHardware || detectHardware({ runtime, env });
    const selection = resolvedSelection || (() => {
        const catalog = loadCatalog({ env });
        return selectArchitecture(catalog, hardware, {
            agentName,
            alias,
            env,
            allowExperimental: Boolean(profileConfig?.llmRuntime?.allowExperimental || manifest?.llmRuntime?.allowExperimental),
        });
    })();

    const policy = admittedRuntimePolicy
        ? buildEffectivePolicy({ overridePolicy: admittedRuntimePolicy }, { runtime })
        : buildEffectivePolicy({
            manifestPolicy: manifest?.llmRuntime?.runtimePolicy || null,
            catalogPolicy: selection.runtimePolicy,
            profilePolicy: profileConfig?.llmRuntime?.runtimePolicy || null,
            overridePolicy: null,
        }, { runtime });

    const policyHash = computeRuntimePolicyHash(policy);
    const runArgs = emitRuntimeArgs ? emitRunArgs(policy, { runtime }) : [];

    const statePayload = buildSelectedArchitectureState({
        selection,
        hardware,
        policy,
        policyHash,
        manifestEnvNames,
        identity,
    });
    let stateDir = null;
    if (writeState) {
        stateDir = ensureRuntimeStateDir(agentWorkDirRoot, identity);
        writeSelectedArchitectureFile(stateDir, statePayload);
    }
    const modelDir = createDirectories ? ensureModelsDir(agentWorkDirRoot, identity) : null;

    const reuseKey = {
        envHash: envHash || '',
        network: effectiveNetwork || null,
        architectureId: selection.architectureId,
        imageRef: selection.imageRef,
        imageDigest: selection.imageDigest || '',
        platform: selection.platform,
        policyHash,
        catalogId: selection.catalogId,
        catalogRef: selection.catalogRef,
    };
    const reuseHash = computeReuseHash(reuseKey);

    const labels = {
        'ploinky.llm.architecture': selection.architectureId,
        'ploinky.llm.catalog': selection.catalogId,
        'ploinky.llm.catalogref': selection.catalogRef,
        'ploinky.llm.policyhash': policyHash,
        'ploinky.llm.imagedigest': selection.imageDigest || '',
        'ploinky.reusehash': reuseHash,
    };

    return {
        enabled: true,
        identity,
        selection,
        hardware,
        policy,
        policyHash,
        runArgs,
        labels,
        reuseHash,
        stateDir,
        modelDir,
        imageRef: selection.imageRef,
        imageDigest: selection.imageDigest || null,
        platform: selection.platform,
        // Useful for tests:
        statePayload,
        reuseKey,
    };
}

function resolveLlmRuntimeAdmissionContext(input = {}) {
    const { manifest, profileConfig, runtime } = input;
    if (!isLlmRuntimeManifest(manifest, profileConfig)) {
        return Object.freeze({ catalogPolicy: null, catalogIdentity: null, startup: null });
    }
    if (runtime !== 'docker' && runtime !== 'podman') {
        const error = new Error(`LLM runtime catalog admission requires a container backend, received '${runtime || 'unknown'}'`);
        error.code = 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED';
        error.status = 422;
        throw error;
    }
    const startup = prepareLlmStartup({
        ...input,
        writeState: false,
        createDirectories: false,
        emitRuntimeArgs: false,
    });
    return Object.freeze({
        catalogPolicy: startup.selection?.runtimePolicy || null,
        catalogIdentity: Object.freeze({
            catalogId: String(startup.selection?.catalogId || ''),
            catalogRef: String(startup.selection?.catalogRef || ''),
            architectureId: String(startup.selection?.architectureId || ''),
            imageRef: String(startup.selection?.imageRef || ''),
            imageDigest: String(startup.selection?.imageDigest || ''),
        }),
        startup,
    });
}

export {
    isLlmRuntimeManifest,
    prepareLlmStartup,
    resolveLlmRuntimeAdmissionContext,
};
