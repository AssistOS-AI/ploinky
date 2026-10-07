import fs from 'fs';
import { listAgentRepositoryNames, resolveAgentRepositoryPath } from './agentRepositorySource.mjs';
import path from 'path';
import crypto from 'crypto';

import * as reposSvc from './repos.js';
import { REPOS_DIR } from './config.js';
import { findAgent } from './utils.js';
import { deriveAgentPrincipalId } from './security/agentIdentity.js';
import { parseQualifiedAgentReference } from './agentRegistryResolver.js';
import { resolveAgentTargetFromSnapshot } from './agentTargetResolver.js';

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
        repoNames = listAgentRepositoryNames();
    } catch (_) {
        repoNames = [];
    }
    for (const repo of repoNames) {
        const repoPath = resolveAgentRepositoryPath(repo);
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

// buildAgentIndex() scans every installed manifest on each call and keeps no
// state between calls. It serves CLI listings; request paths resolve one agent
// through describeAgent() instead, so no Router request pays for a full scan.
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

// The agent directory of one repo/agent: the active route's hostPath when the
// snapshot routes that exact repo and agent, else the agent under its one
// repository path. A route's repo is canonical by construction; without a
// route the repository must be a canonical repository name, as the installed
// index keys it, because a workspace checkout's folder name also resolves to
// a path but is not a principal name.
function resolveAgentDirectory(repoName, agentName, snapshot) {
    if (snapshot) {
        try {
            const target = resolveAgentTargetFromSnapshot(`${repoName}/${agentName}`, snapshot);
            if (target?.hostPath) return target.hostPath;
        } catch (_) {
            // Ambiguous routes: fall back to the repository path.
        }
    }
    try {
        if (!listAgentRepositoryNames().includes(repoName)) return '';
        return path.join(resolveAgentRepositoryPath(repoName), agentName);
    } catch (_) {
        return '';
    }
}

// Locate one agent's manifest without reading it: a directory stat and a
// manifest existence check under that agent's directory.
export function locateAgentManifest(repoName, agentName, { snapshot = null, agentDir = '' } = {}) {
    const repo = toNonEmptyString(repoName);
    const agent = toNonEmptyString(agentName);
    if (!repo || !agent) return null;
    const agentPath = toNonEmptyString(agentDir) || resolveAgentDirectory(repo, agent, snapshot);
    if (!agentPath) return null;
    const manifestPath = path.join(agentPath, 'manifest.json');
    try {
        if (!fs.statSync(agentPath).isDirectory()) return null;
        if (!fs.existsSync(manifestPath)) return null;
    } catch (_) {
        return null;
    }
    return { repo, agent, agentPath, manifestPath };
}

// One agent's descriptor, read fresh from that agent's manifest on every call.
export function describeAgent(repoName, agentName, { snapshot = null, agentDir = '' } = {}) {
    const located = locateAgentManifest(repoName, agentName, { snapshot, agentDir });
    if (!located) return null;
    const manifest = readManifest(located.manifestPath);
    try {
        return { ...buildAgentDescriptor(located.repo, located.agent, manifest), manifestPath: located.manifestPath };
    } catch (_) {
        return null;
    }
}

// Resolve one agent reference to its repo/agent pair without reading any
// manifest. A qualified reference names the pair; a bare reference resolves
// through the snapshot's routes and records. Without a snapshot, or when the
// snapshot has no target for a bare reference, the CLI's findAgent() lookup
// applies (Router callers pass a snapshot or qualified references).
function resolveAgentRefTarget(agentRef, snapshot) {
    const canonical = canonicalizeAgentRef(agentRef);
    if (!canonical) return null;
    const qualification = parseQualifiedAgentReference(canonical);
    if (qualification.qualified && !qualification.malformed) {
        return { repo: qualification.repoName, agent: qualification.agentName, agentDir: '' };
    }
    if (!qualification.qualified && snapshot) {
        let target = null;
        try {
            target = resolveAgentTargetFromSnapshot(canonical, snapshot);
        } catch (_) {
            return null;
        }
        if (target) return { repo: target.repo, agent: target.agent, agentDir: target.hostPath };
    }
    try {
        const resolved = findAgent(canonical);
        return { repo: resolved.repo, agent: resolved.shortAgentName, agentDir: '' };
    } catch (_) {
        return null;
    }
}

export function resolveAgentDescriptor(agentRef, { snapshot = null } = {}) {
    const target = resolveAgentRefTarget(agentRef, snapshot);
    if (!target) return null;
    return describeAgent(target.repo, target.agent, { snapshot, agentDir: target.agentDir });
}

export function resolveAgentManifestLocation(agentRef, { snapshot = null } = {}) {
    const target = resolveAgentRefTarget(agentRef, snapshot);
    if (!target) return null;
    return locateAgentManifest(target.repo, target.agent, { snapshot, agentDir: target.agentDir });
}

// Principals are always `agent:<repo>/<agent>`; anything else names no agent
// and is answered without I/O.
const AGENT_PRINCIPAL_PATTERN = /^agent:([^/:\s]+)\/([^/:\s]+)$/;

export function getAgentDescriptorByPrincipal(principalId, { snapshot = null } = {}) {
    const clean = toNonEmptyString(principalId);
    if (!clean) return null;
    const match = AGENT_PRINCIPAL_PATTERN.exec(clean);
    if (!match) return null;
    return describeAgent(match[1], match[2], { snapshot });
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
