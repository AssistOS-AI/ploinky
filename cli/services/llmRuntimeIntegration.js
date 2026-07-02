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
const LLM_STARTUP_CONTRACT = Object.freeze({
    version: 2,
    mounts: Object.freeze(['/workspace', '/models', '/runtime']),
    env: Object.freeze({
        HF_HOME: '/models/hf-cache',
        PLOINKY_MODELS_DIR: '/models/artifacts',
        PLOINKY_DERIVED_DIR: '/models/derived',
        PLOINKY_RUNTIME_DIR: '/runtime',
        PLOINKY_LAUNCHERS_DIR: '/workspace/modelLaunchers',
        PLOINKY_MCP_PORT: '9000',
        PLOINKY_INFERENCE_PORT: '8080',
        PLOINKY_INVOCATION_AUTH_MODULE: '/Agent/lib/invocationAuth.mjs',
        PLOINKY_REQUEST_HASH_MODULE: '/Agent/lib/requestHash.mjs',
    }),
    publish: Object.freeze([
        Object.freeze({ hostIp: '127.0.0.1', containerPort: 9000, protocol: 'tcp' }),
        Object.freeze({ hostIp: '127.0.0.1', containerPort: 8080, protocol: 'tcp' }),
    ]),
});

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

function ensureDirectoryMode(dir, mode) {
    fs.mkdirSync(dir, { recursive: true, mode });
    try { fs.chmodSync(dir, mode); } catch (_) {}
    return dir;
}

function tempFilePath(filePath) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return path.join(dir, `.${base}.tmp-${nonce}`);
}

function safeFileWrite(filePath, bytes, mode = 0o600) {
    ensureDirectoryMode(path.dirname(filePath), 0o700);
    const tmpPath = tempFilePath(filePath);
    let fd = null;
    let cleanupTmp = false;
    try {
        fd = fs.openSync(tmpPath, 'wx', mode);
        cleanupTmp = true;
        fs.writeFileSync(fd, bytes, { encoding: 'utf8' });
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmpPath, filePath);
        cleanupTmp = false;
        try { fs.chmodSync(filePath, mode); } catch (_) {}
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (_) {}
        }
        if (cleanupTmp) {
            try { fs.unlinkSync(tmpPath); } catch (_) {}
        }
    }
}

function safeJsonWrite(filePath, payload) {
    safeFileWrite(filePath, `${JSON.stringify(payload, null, 2)}\n`, 0o600);
}

function buildEngineInventory(selection, imageRecord = null) {
    const defaults = selection?.engineDefaults || {};
    const runtimePort = Number(defaults.runtimePort) || 9000;
    const enginePort = Number(defaults.enginePort) || 8080;
    return {
        engines: Array.isArray(imageRecord?.engines) ? imageRecord.engines.slice() : [],
        mcp: { containerPort: runtimePort },
        inference: { containerPort: enginePort },
    };
}

function buildSelectedArchitectureState({ selection, hardware, policy, policyHash, identity, imageRecord }) {
    const safeProbes = {};
    for (const [name, probe] of Object.entries(hardware?.probes || {})) {
        safeProbes[name] = { ok: Boolean(probe?.ok), timedOut: Boolean(probe?.timedOut) };
    }
    const engineInventory = buildEngineInventory(selection, imageRecord);
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
        resourcePolicy: policy?.resources || {},
        engineInventory,
        hardware: {
            runtime: hardware?.runtime || null,
            nodeArch: hardware?.nodeArch || null,
            nodePlatform: hardware?.nodePlatform || null,
            ociPlatform: hardware?.ociPlatform || null,
            acceleratorFamilies: Array.isArray(hardware?.acceleratorFamilies) ? hardware.acceleratorFamilies.slice() : [],
            probes: safeProbes,
        },
        explanation: selection.explanation || {},
    };
}

function ensureRuntimeStateDir(rootDir, identity) {
    const stateDir = path.join(rootDir, identity, 'runtime');
    return ensureDirectoryMode(stateDir, 0o700);
}

function ensureModelsDir(rootDir, identity) {
    const modelsDir = path.join(rootDir, identity, 'models');
    return ensureDirectoryMode(modelsDir, 0o700);
}

function writeSelectedArchitectureFile(stateDir, payload) {
    const filePath = path.join(stateDir, 'selected-architecture.json');
    safeJsonWrite(filePath, payload);
    return filePath;
}

function buildRuntimeLockfilePayload(statePayload) {
    return {
        schemaVersion: 1,
        writtenAt: statePayload.writtenAt,
        architecture: {
            id: statePayload.architecture.id,
            platform: statePayload.architecture.platform,
        },
        image: {
            ref: statePayload.architecture.imageRef,
            digest: statePayload.architecture.imageDigest || null,
        },
        runtimePolicyHash: statePayload.runtimePolicyHash,
        resourcePolicy: statePayload.resourcePolicy || {},
        engineInventory: statePayload.engineInventory || {},
    };
}

function writeRuntimeLockfile(stateDir, payload) {
    const filePath = path.join(stateDir, 'llm-runtime-lock.json');
    safeJsonWrite(filePath, payload);
    return filePath;
}

function computeReuseHash(parts) {
    const sorted = Object.keys(parts).sort().reduce((acc, key) => {
        acc[key] = parts[key];
        return acc;
    }, {});
    return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function cloneStartupContract() {
    return {
        version: LLM_STARTUP_CONTRACT.version,
        mounts: LLM_STARTUP_CONTRACT.mounts.slice(),
        env: { ...LLM_STARTUP_CONTRACT.env },
        publish: LLM_STARTUP_CONTRACT.publish.map((mapping) => ({ ...mapping })),
    };
}

function buildImageRunRef(selection) {
    if (!selection?.imageRef) return '';
    return selection.imageDigest ? `${selection.imageRef}@${selection.imageDigest}` : selection.imageRef;
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
    const imageRunRef = buildImageRunRef(selection);

    const policy = buildEffectivePolicy({
        manifestPolicy: extractManifestPolicy(manifest, profileConfig),
        catalogPolicy: selection.runtimePolicy,
        profilePolicy: null,
        overridePolicy: null,
    }, { runtime });

    const policyHash = computeRuntimePolicyHash(policy);
    const runArgs = emitRunArgs(policy, { runtime });
    const selectedImageRecord = catalog.images?.get?.(selection.imageId) || null;

    const statePayload = buildSelectedArchitectureState({
        selection,
        hardware,
        policy,
        policyHash,
        identity,
        imageRecord: selectedImageRecord,
    });
    let stateDir = null;
    if (writeState) {
        stateDir = ensureRuntimeStateDir(agentWorkDirRoot, identity);
        writeSelectedArchitectureFile(stateDir, statePayload);
        writeRuntimeLockfile(stateDir, buildRuntimeLockfilePayload(statePayload));
    }
    const modelDir = ensureModelsDir(agentWorkDirRoot, identity);

    const reuseKey = {
        startupContractVersion: LLM_STARTUP_CONTRACT.version,
        startupContract: cloneStartupContract(),
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
        imageRunRef,
        platform: selection.platform,
        // Useful for tests:
        statePayload,
        reuseKey,
    };
}

export {
    LLM_STARTUP_CONTRACT,
    isLlmRuntimeManifest,
    prepareLlmStartup,
};
