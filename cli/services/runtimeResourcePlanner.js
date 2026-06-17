import fs from 'fs';
import path from 'path';

import { PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT } from './config.js';
import { ensurePersistentSecret, resolveVarValue } from './secretVars.js';
import { deriveAgentSecret } from './masterKey.js';

/**
 * runtimeResourcePlanner.js
 *
 * Turns the manifest's declarative `runtime.resources.*` block into a plan the
 * container/bwrap managers can consume without knowing about any specific
 * provider implementation.
 *
 * Supported resources:
 *   - persistentStorage: per-agent writable host dir mounted at containerPath,
 *     optionally chmod'd. Host dir lives under
 *     <workspace>/.ploinky/data/<key>/ by default, overridable by env
 *     "PLOINKY_RESOURCE_<KEY>_HOST" (for compatibility with existing setups
 *     such as DPU_DATA_ROOT).
 *   - env: declarative environment variables supporting template placeholders:
 *       {{PLOINKY_WORKSPACE_ROOT}}
 *       {{STORAGE_CONTAINER_PATH}}   (only when persistentStorage declared)
 *       {{STORAGE_HOST_PATH}}
 *       {{secret:<NAME>}}            (ensurePersistentSecret)
 *       {{generatedSecret:<NAME>}}            (per-agent generated secret)
 *       {{var:<NAME>}}               (resolveVarValue / process.env)
 *
 * The plan is pure: planRuntimeResources reads the manifest only. Applying
 * the plan (creating host dirs, setting env) is done by the caller.
 */

const DEFAULT_DATA_ROOT = path.join(PLOINKY_DIR, 'data');

function toNonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function resolveDataRootForKey(key) {
    const upper = String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const envOverride = process.env[`PLOINKY_RESOURCE_${upper}_HOST`];
    if (envOverride && envOverride.trim()) {
        return path.resolve(envOverride.trim());
    }
    if (key === 'dpu-data' && process.env.DPU_DATA_ROOT) {
        // Back-compat alias so existing DPU installs keep working until the
        // operator explicitly renames it.
        return path.resolve(process.env.DPU_DATA_ROOT);
    }
    return path.join(DEFAULT_DATA_ROOT, String(key || 'default'));
}

function expandTemplate(raw, { hostPath, containerPath, useHostStoragePath = false, agentName = '', repoName = '' }) {
    if (typeof raw !== 'string') return raw == null ? '' : String(raw);
    return raw.replace(/\{\{([^}]+)\}\}/g, (match, exprRaw) => {
        const expr = String(exprRaw).trim();
        if (!expr) return '';
        if (expr === 'PLOINKY_WORKSPACE_ROOT') return PLOINKY_WORKSPACE_ROOT || '';
        if (expr === 'STORAGE_CONTAINER_PATH') return useHostStoragePath ? hostPath || '' : containerPath || '';
        if (expr === 'STORAGE_HOST_PATH') return hostPath || '';
        if (expr.startsWith('secret:')) {
            const name = expr.slice('secret:'.length).trim();
            if (!name) return '';
            try {
                return ensurePersistentSecret(name);
            } catch (_) {
                return '';
            }
        }
        if (expr.startsWith('derivedMasterSecret:')) {
            const error = new Error(
                'The {{derivedMasterSecret:NAME}} runtime-resource template has been removed. '
                + 'Use {{generatedSecret:NAME}} for agent-owned generated secrets.'
            );
            error.code = 'PLOINKY_LEGACY_DERIVED_MASTER_TEMPLATE';
            throw error;
        }
        if (expr.startsWith('generatedSecret:')) {
            const name = expr.slice('generatedSecret:'.length).trim();
            if (!name) return '';
            try {
                return deriveAgentSecret({ repoName, agentName, name });
            } catch (_) {
                return '';
            }
        }
        if (expr.startsWith('var:')) {
            const name = expr.slice('var:'.length).trim();
            if (!name) return '';
            return resolveVarValue(name) || process.env[name] || '';
        }
        return match;
    });
}

export function planRuntimeResources(manifest, options = {}) {
    const runtime = manifest && typeof manifest === 'object' ? manifest.runtime : null;
    const resources = runtime && typeof runtime === 'object' ? runtime.resources : null;
    if (!resources || typeof resources !== 'object') {
        return { persistentStorage: null, env: {} };
    }
    const plan = { persistentStorage: null, env: {} };

    if (resources.persistentStorage && typeof resources.persistentStorage === 'object') {
        const ps = resources.persistentStorage;
        const key = toNonEmptyString(ps.key);
        const containerPath = toNonEmptyString(ps.containerPath);
        if (key && containerPath) {
            const hostPath = resolveDataRootForKey(key);
            plan.persistentStorage = {
                key,
                hostPath,
                containerPath,
                chmod: typeof ps.chmod === 'number' ? ps.chmod : null
            };
        }
    }

    const rawEnv = resources.env && typeof resources.env === 'object' ? resources.env : {};
    const ctx = {
        hostPath: plan.persistentStorage?.hostPath || '',
        containerPath: plan.persistentStorage?.containerPath || '',
        useHostStoragePath: options.useHostStoragePath === true,
        agentName: options.agentName || '',
        repoName: options.repoName || '',
    };
    for (const [name, rawValue] of Object.entries(rawEnv)) {
        if (!name) continue;
        plan.env[String(name)] = expandTemplate(rawValue, ctx);
    }

    return plan;
}

export function ensurePersistentStorageHostDir(plan) {
    const ps = plan?.persistentStorage;
    if (!ps) return null;
    if (!fs.existsSync(ps.hostPath)) {
        fs.mkdirSync(ps.hostPath, { recursive: true });
    }
    if (typeof ps.chmod === 'number') {
        try { fs.chmodSync(ps.hostPath, ps.chmod); } catch (_) {}
    }
    return ps.hostPath;
}

/**
 * Apply the resource env plan to an existing env accumulator.
 *
 * - For docker/podman, pass a string array (already-formatted -e flags are
 *   produced elsewhere); instead we return a plain env map and let callers
 *   merge it.
 * - For bwrap, callers feed the map directly into --setenv.
 */
export function applyRuntimeResourceEnv(plan) {
    return plan?.env ? { ...plan.env } : {};
}
