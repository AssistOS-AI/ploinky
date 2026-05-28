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

const SAFE_AGENT_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const REDACTED_ENV_NAMES = new Set([
    'HF_TOKEN',
    'HUGGINGFACE_TOKEN',
    'HUGGINGFACEHUB_API_TOKEN',
]);

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

function redactedEnvForRecord(env, manifest, profileConfig) {
    if (!env || typeof env !== 'object') return {};
    const allowed = new Set();
    const collect = (envSpec) => {
        if (!Array.isArray(envSpec)) return;
        for (const entry of envSpec) {
            const name = typeof entry === 'string' ? entry : entry?.name;
            if (typeof name === 'string' && name) allowed.add(name);
        }
    };
    collect(manifest?.env);
    collect(profileConfig?.env);
    const out = {};
    for (const name of allowed) {
        if (REDACTED_ENV_NAMES.has(name)) continue;
        if (Object.prototype.hasOwnProperty.call(env, name)) {
            out[name] = env[name];
        }
    }
    return out;
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
        envExposed: Array.isArray(manifestEnvNames) ? manifestEnvNames.filter((name) => !REDACTED_ENV_NAMES.has(name)) : [],
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
    } = input || {};

    if (!isLlmRuntimeManifest(manifest, profileConfig)) {
        return { enabled: false };
    }

    const identity = safeIdentity({ agentName, alias });
    if (!identity) {
        throw new Error(`[llm-runtime] ${agentName}: agent name/alias must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`);
    }

    const catalog = loadCatalog({ env });
    const hardware = detectHardware({ runtime, env });
    const selection = selectArchitecture(catalog, hardware, {
        agentName,
        alias,
        env,
        allowExperimental: Boolean(profileConfig?.llmRuntime?.allowExperimental || manifest?.llmRuntime?.allowExperimental),
    });

    const policy = buildEffectivePolicy({
        manifestPolicy: extractManifestPolicy(manifest, profileConfig),
        catalogPolicy: selection.runtimePolicy,
        profilePolicy: null,
        overridePolicy: null,
    }, { runtime });

    const policyHash = computeRuntimePolicyHash(policy);
    const runArgs = emitRunArgs(policy, { runtime });

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
    const modelDir = ensureModelsDir(agentWorkDirRoot, identity);

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

export {
    isLlmRuntimeManifest,
    prepareLlmStartup,
    redactedEnvForRecord,
};
