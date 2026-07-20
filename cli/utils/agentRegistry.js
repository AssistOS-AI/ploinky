import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import * as reposSvc from './repos.js';
import { REPOS_DIR } from './config.js';
import { findAgent } from './utils.js';
import { deriveAgentPrincipalId } from './security/agentIdentity.js';

/**
 * agentRegistry.js
 *
 * Small installed-agent index for Ploinky core. This intentionally avoids the
 * older generic provider-negotiation model. Security-sensitive authorization is
 * enforced by router auth, invocation JWTs, and domain agents such as DPU.
 */

function toNonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function canonicalizeAgentRef(input) {
    const raw = toNonEmptyString(input);
    if (!raw) return '';
    return raw.replace(/\s+/g, ' ').replace(/^\.\//, '');
}

function splitRepoAgent(agentRef) {
    const clean = canonicalizeAgentRef(agentRef);
    if (!clean) return { repo: '', agent: '' };
    const parts = clean.split('/').filter(Boolean);
    if (parts.length >= 2) {
        return { repo: parts[0], agent: parts.slice(1).join('/') };
    }
    return { repo: '', agent: parts[0] || '' };
}

function readManifest(manifestPath) {
    try {
        const raw = fs.readFileSync(manifestPath, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
}

export function isSsoProviderManifest(manifest) {
    return Boolean(manifest && typeof manifest === 'object' && manifest.ssoProvider === true);
}

function normalizeRuntimeResources(rawRuntime) {
    if (!rawRuntime || typeof rawRuntime !== 'object') return {};
    const resources = resourcesFromRuntime(rawRuntime);
    const persistent = resources.persistentStorage && typeof resources.persistentStorage === 'object'
        ? resources.persistentStorage
        : null;
    const normalized = {};
    if (persistent) {
        const key = toNonEmptyString(persistent.key);
        const containerPath = toNonEmptyString(persistent.containerPath);
        if (key && containerPath) {
            normalized.persistentStorage = {
                key,
                containerPath,
                chmod: typeof persistent.chmod === 'number' ? persistent.chmod : null,
            };
        }
    }
    if (resources.env && typeof resources.env === 'object') {
        const envOut = {};
        for (const [envName, envValue] of Object.entries(resources.env)) {
            if (!envName) continue;
            envOut[String(envName)] = envValue == null ? '' : String(envValue);
        }
        if (Object.keys(envOut).length) normalized.env = envOut;
    }
    return normalized;
}

function resourcesFromRuntime(rawRuntime) {
    return rawRuntime.resources && typeof rawRuntime.resources === 'object'
        ? rawRuntime.resources
        : {};
}

function buildAgentDescriptor(repoName, agentName, manifest) {
    const runtimeResources = normalizeRuntimeResources(manifest?.runtime);
    const principalId = deriveAgentPrincipalId(repoName, agentName);
    return {
        repo: repoName,
        agent: agentName,
        agentRef: `${repoName}/${agentName}`,
        principalId,
        ssoProvider: isSsoProviderManifest(manifest),
        runtimeResources,
    };
}

function collectInstalledAgents() {
    const out = [];
    let repoNames = [];
    try {
        repoNames = reposSvc.getInstalledRepos(REPOS_DIR);
    } catch (_) {
        repoNames = [];
    }
    for (const repo of repoNames) {
        const repoPath = path.join(REPOS_DIR, repo);
        let entries;
        try {
            entries = fs.readdirSync(repoPath);
        } catch (_) {
            entries = [];
        }
        for (const entry of entries) {
            const agentDir = path.join(repoPath, entry);
            const manifestPath = path.join(agentDir, 'manifest.json');
            try {
                if (!fs.statSync(agentDir).isDirectory()) continue;
                if (!fs.existsSync(manifestPath)) continue;
            } catch (_) {
                continue;
            }
            const manifest = readManifest(manifestPath);
            let descriptor;
            try {
                descriptor = buildAgentDescriptor(repo, entry, manifest);
            } catch (err) {
                console.warn(`[agentRegistry] Skipping ${repo}/${entry}: ${err?.message || err}`);
                continue;
            }
            out.push({
                repo,
                agent: entry,
                agentPath: agentDir,
                manifestPath,
                manifest,
                descriptor,
            });
        }
    }
    return out;
}

export function buildAgentIndex() {
    const agents = new Map();
    const byPrincipal = new Map();
    const ssoProviders = [];
    for (const installed of collectInstalledAgents()) {
        const descriptor = { ...installed.descriptor, manifestPath: installed.manifestPath };
        agents.set(descriptor.agentRef, descriptor);
        if (descriptor.principalId) {
            byPrincipal.set(descriptor.principalId, descriptor);
        }
        if (descriptor.ssoProvider) {
            ssoProviders.push(descriptor);
        }
    }
    return { agents, byPrincipal, ssoProviders };
}

export function listSsoProviders() {
    return buildAgentIndex().ssoProviders;
}

export function resolveAgentDescriptor(agentRef) {
    const canonical = canonicalizeAgentRef(agentRef);
    if (!canonical) return null;
    const index = buildAgentIndex();
    if (index.agents.has(canonical)) return index.agents.get(canonical);
    try {
        const resolved = findAgent(canonical);
        const repoName = resolved.repo;
        const shortName = resolved.shortAgentName;
        const full = `${repoName}/${shortName}`;
        return index.agents.get(full) || null;
    } catch (_) {
        return null;
    }
}

export function getAgentDescriptorByPrincipal(principalId) {
    const clean = toNonEmptyString(principalId);
    if (!clean) return null;
    const index = buildAgentIndex();
    return index.byPrincipal.get(clean) || null;
}

export function canonicalJsonHash(obj) {
    const str = canonicalJsonStringify(obj);
    return crypto.createHash('sha256').update(str, 'utf8').digest('base64url');
}

function canonicalJsonStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJsonStringify).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(value[k])}`);
    return `{${parts.join(',')}}`;
}

export const __internal = {
    canonicalizeAgentRef,
    splitRepoAgent,
    canonicalJsonStringify,
    isSsoProviderManifest,
};
