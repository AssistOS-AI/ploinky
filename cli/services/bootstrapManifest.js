import fs from 'fs';
import path from 'path';
import * as repos from './repos.js';
import { enableAgent } from './agents.js';
import { findAgent } from './utils.js';
import { loadAgents, saveAgents } from './workspace.js';
import { isSsoProviderManifest } from './agentRegistry.js';
import { PLOINKY_DIR } from './config.js';
import { getActiveProfile } from './profileService.js';

export function parseEnableDirective(entry) {
    if (entry === null || entry === undefined) return null;
    if (typeof entry === 'object' && !Array.isArray(entry)) {
        const rawSpec = entry.agent ?? entry.ref ?? entry.spec ?? entry.name;
        const parsed = parseEnableDirective(rawSpec);
        if (!parsed) return null;
        const alias = entry.alias ?? entry.as ?? parsed.alias;
        const profile = typeof entry.profile === 'string' && entry.profile.trim()
            ? entry.profile.trim().toLowerCase()
            : undefined;
        const noWait = entry.noWait === true || entry['no-wait'] === true || parsed.noWait;
        const result = {
            spec: parsed.spec,
            alias,
            noWait,
        };
        if (profile) result.profile = profile;
        return result;
    }
    const raw = typeof entry === 'string' ? entry : String(entry || '').trim();
    const trimmed = raw.trim();
    if (!trimmed) return null;
    let tokens = trimmed.split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;

    // `no-wait` is an edge-local modifier and can appear anywhere in the
    // directive. Strip every occurrence before parsing alias/spec so the
    // remaining tokens form a clean agent reference.
    let noWait = false;
    tokens = tokens.filter((token) => {
        if (token.toLowerCase() === 'no-wait') {
            noWait = true;
            return false;
        }
        return true;
    });

    const aliasIndex = tokens.findIndex(token => token.toLowerCase() === 'as');
    let alias;
    if (aliasIndex !== -1) {
        if (aliasIndex + 1 >= tokens.length) {
            throw new Error(`manifest enable entry '${entry}' is missing alias name after "as"`);
        }
        alias = tokens[aliasIndex + 1];
        tokens.splice(aliasIndex);
    }

    const spec = tokens.join(' ').trim();
    if (!spec) {
        throw new Error(`manifest enable entry '${entry}' is missing agent reference`);
    }
    return { spec, alias, noWait };
}

function firstEnableSpecToken(spec) {
    return String(spec || '').trim().split(/\s+/).filter(Boolean)[0] || '';
}

function isPrefixedAgentToken(token) {
    return String(token || '').includes('/') || String(token || '').includes(':');
}

function hasSameRepoBareAgent(repoName, agentName) {
    const repo = String(repoName || '').trim();
    const agent = String(agentName || '').trim();
    if (!repo || !agent) return false;
    return fs.existsSync(path.join(PLOINKY_DIR, 'repos', repo, agent, 'manifest.json'));
}

export function qualifyEnableSpecForRepo(spec, repoName) {
    const raw = String(spec || '').trim();
    const repo = String(repoName || '').trim();
    if (!raw || !repo) return raw;

    const tokens = raw.split(/\s+/).filter(Boolean);
    if (!tokens.length || isPrefixedAgentToken(tokens[0])) {
        return raw;
    }
    if (!hasSameRepoBareAgent(repo, tokens[0])) {
        return raw;
    }
    return [`${repo}/${tokens[0]}`, ...tokens.slice(1)].join(' ');
}

function parsePloinkyDirectives(rawValue) {
    if (Array.isArray(rawValue)) {
        return rawValue.flatMap((item) => parsePloinkyDirectives(item)).filter(Boolean);
    }
    if (typeof rawValue !== 'string') {
        return [];
    }
    return rawValue
        .split(/[,\n;]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
}

function resolveManifestAuthMode(manifest) {
    const ploinkyDirectives = parsePloinkyDirectives(manifest?.ploinky);
    if (ploinkyDirectives.includes('pwd enable')) {
        return 'local';
    }
    if (ploinkyDirectives.includes('sso enable')) {
        return 'sso';
    }
    return 'none';
}

function agentRefFromEnableSpec(spec) {
    const raw = String(spec || '').trim();
    if (!raw) return '';
    const token = firstEnableSpecToken(raw);
    const slashIndex = token.indexOf('/');
    const colonIndex = token.indexOf(':');
    if (slashIndex !== -1 && colonIndex > slashIndex) {
        return token.slice(0, colonIndex).trim();
    }
    return token;
}

function manifestForDirective(parsedDirective) {
    const spec = String(parsedDirective?.spec || '').trim();
    if (!spec) return null;
    const agentRef = agentRefFromEnableSpec(spec);
    if (!agentRef) return null;
    try {
        const resolved = findAgent(agentRef);
        if (!resolved || !resolved.manifestPath) return null;
        return JSON.parse(fs.readFileSync(resolved.manifestPath, 'utf8'));
    } catch (_) {
        return null;
    }
}

function shouldEnableDirectiveForManifest(parsedDirective, manifest) {
    const spec = String(parsedDirective?.spec || '').trim();
    if (!spec) return false;
    const depManifest = manifestForDirective(parsedDirective);
    if (depManifest && isSsoProviderManifest(depManifest)) {
        return resolveManifestAuthMode(manifest) === 'sso';
    }
    return true;
}

function isStrictBranchPolicy(branchPolicy) {
    return branchPolicy?.fallback === 'fail'
        && (Boolean(branchPolicy.branch) || Object.keys(branchPolicy.repoBranches || {}).length > 0);
}

function errorMessage(err) {
    return err && err.message ? err.message : String(err);
}

export function manifestEnableEntries(manifest, profileOverride = '') {
    const entries = [];
    if (Array.isArray(manifest?.enable)) {
        entries.push(...manifest.enable);
    }
    try {
        const activeProfile = profileOverride || getActiveProfile();
        const profiles = manifest?.profiles || {};
        // Agents that do not declare the active semantic profile still use their
        // default profile dependency contract.
        const profileBlock = profiles[activeProfile] || profiles.default;
        if (profileBlock && Array.isArray(profileBlock.enable)) {
            entries.push(...profileBlock.enable);
        }
    } catch (_) {}
    return entries;
}

function ensurePrefixedRepoInstalled(spec, branchPolicy, {
    stdio = 'inherit',
    logError = console.error,
    activate = true,
} = {}) {
    if (!spec || typeof spec !== 'string') return;
    const slashIdx = spec.indexOf('/');
    const colonIdx = spec.indexOf(':');
    const sepIdx = slashIdx > 0 ? slashIdx : (colonIdx > 0 ? colonIdx : -1);
    if (sepIdx < 1) return;

    const repoName = spec.slice(0, sepIdx);
    const repoPath = path.join(PLOINKY_DIR, 'repos', repoName);
    const source = repos.resolveRepoSource(repoName);
    if (fs.existsSync(repoPath)) {
        if (activate) {
            repos.enableRepo(repoName, {
                branch: source?.branch || null,
                branchPolicy,
                stdio,
            });
        }
        return;
    }
    if (!source?.url) {
        if (isStrictBranchPolicy(branchPolicy)) {
            throw new Error(`No URL configured for repo '${repoName}'.`);
        }
        return;
    }

    try {
        repos.ensureRepoInstalled(repoName, source.url, {
            branchPolicy,
            branch: source.branch,
            stdio,
        });
        if (activate) {
            repos.enableRepo(repoName, {
                branch: source.branch,
                branchPolicy,
                stdio,
            });
        }
    } catch (err) {
        if (isStrictBranchPolicy(branchPolicy)) {
            throw new Error(`Auto-install repo '${repoName}' failed: ${errorMessage(err)}`);
        }
        logError(`[manifest] Auto-install repo '${repoName}' failed: ${errorMessage(err)}`);
    }
}

function repoNameFromManifestPath(manifestPath) {
    const reposRoot = path.join(PLOINKY_DIR, 'repos');
    const repoPath = path.dirname(path.dirname(path.resolve(manifestPath)));
    const relative = path.relative(reposRoot, repoPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return '';
    }
    return relative.split(path.sep).filter(Boolean)[0] || '';
}

function readManifestTarget(agentNameOrPath) {
    let manifest;
    let manifestPath;
    let repoName = '';
    if (agentNameOrPath.endsWith('.json')) {
        manifestPath = agentNameOrPath;
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        repoName = repoNameFromManifestPath(manifestPath);
    } else {
        const resolved = findAgent(agentRefFromEnableSpec(agentNameOrPath) || agentNameOrPath);
        manifestPath = resolved.manifestPath;
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        repoName = resolved.repo || repoNameFromManifestPath(manifestPath);
    }
    return { manifest, manifestPath, repoName };
}

function findEnabledDirectiveRecord(parsedDirective) {
    const agentRef = agentRefFromEnableSpec(parsedDirective?.spec);
    if (!agentRef) return null;
    let resolved;
    try {
        resolved = findAgent(agentRef);
    } catch (_) {
        return null;
    }
    const alias = typeof parsedDirective?.alias === 'string' && parsedDirective.alias.trim()
        ? parsedDirective.alias.trim()
        : '';
    const agents = loadAgents();
    for (const [key, record] of Object.entries(agents || {})) {
        if (key === '_config' || !record || record.type !== 'agent') continue;
        if (record.repoName !== resolved.repo || record.agentName !== resolved.shortAgentName) continue;
        if (alias) {
            if (record.alias === alias) {
                return { agents, key, record };
            }
            continue;
        }
        if (!record.alias) {
            return { agents, key, record };
        }
    }
    return null;
}

function ensureDirectiveEnabled(parsedDirective) {
    const existing = findEnabledDirectiveRecord(parsedDirective);
    if (existing) {
        const profile = typeof parsedDirective?.profile === 'string' && parsedDirective.profile.trim()
            ? parsedDirective.profile.trim().toLowerCase()
            : '';
        if (profile && existing.record.profile !== profile) {
            existing.record.profile = profile;
            existing.agents[existing.key] = existing.record;
            saveAgents(existing.agents);
        }
        return;
    }
    enableAgent(parsedDirective.spec, undefined, undefined, parsedDirective.alias, undefined, {
        profile: parsedDirective.profile,
    });
}

async function applyManifestDirectivesInternal(agentNameOrPath, {
    branchPolicy,
    profile = '',
    visited,
    enableAgents = true,
    stdio = 'inherit',
    logError = console.error,
} = {}) {
    const { manifest, manifestPath, repoName } = readManifestTarget(agentNameOrPath);
    const visitKey = `${path.resolve(manifestPath)}::${profile || ''}`;
    if (visited.has(visitKey)) {
        return;
    }
    visited.add(visitKey);

    const r = manifest.repos;
    if (r && typeof r === 'object') {
        for (const [name, value] of Object.entries(r)) {
            try {
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    const manifestBranch = value.branch || null;
                    const resolvedBranch = repos.resolveBranchForRepo(
                        name,
                        { branch: manifestBranch },
                        branchPolicy,
                    );
                    repos.ensureRepoInstalled(name, value.url, {
                        branchPolicy,
                        branch: resolvedBranch,
                        stdio,
                    });
                    if (enableAgents) {
                        repos.enableRepo(name, {
                            branch: resolvedBranch,
                            branchPolicy,
                            stdio,
                        });
                    }
                } else {
                    repos.ensureRepoInstalled(name, value, {
                        branchPolicy,
                        stdio,
                    });
                    if (enableAgents) {
                        repos.enableRepo(name, {
                            branchPolicy,
                            stdio,
                        });
                    }
                }
            } catch (err) {
                if (isStrictBranchPolicy(branchPolicy)) {
                    throw new Error(`[manifest repos] Failed to install repo '${name}': ${errorMessage(err)}`);
                }
                logError(`[manifest repos] Failed to install repo '${name}': ${errorMessage(err)}`);
            }
        }
    }

    const en = manifestEnableEntries(manifest, profile);
    if (Array.isArray(en)) {
        for (const rawEntry of en) {
            try {
                const parsed = parseEnableDirective(rawEntry);
                if (!parsed) continue;
                const qualified = {
                    ...parsed,
                    spec: qualifyEnableSpecForRepo(parsed.spec, repoName),
                };
                ensurePrefixedRepoInstalled(qualified.spec, branchPolicy, {
                    stdio,
                    logError,
                    activate: enableAgents,
                });
                if (!shouldEnableDirectiveForManifest(qualified, manifest)) {
                    continue;
                }
                if (enableAgents) {
                    ensureDirectiveEnabled(qualified);
                }
                const childRef = agentRefFromEnableSpec(qualified.spec);
                if (childRef) {
                    await applyManifestDirectivesInternal(childRef, {
                        branchPolicy,
                        profile: qualified.profile || profile || '',
                        visited,
                        enableAgents,
                        stdio,
                        logError,
                    });
                }
            } catch (err) {
                const message = errorMessage(err);
                if (isStrictBranchPolicy(branchPolicy)) {
                    throw new Error(`[manifest enable] Failed to enable agent '${rawEntry}': ${message}`);
                }
                logError(`[manifest enable] Failed to ${enableAgents ? 'enable' : 'prepare'} agent '${rawEntry}': ${message}`);
            }
        }
    }
}

export async function applyManifestDirectives(agentNameOrPath, { branchPolicy } = {}) {
    return applyManifestDirectivesInternal(agentNameOrPath, {
        branchPolicy,
        visited: new Set(),
    });
}

export async function prepareManifestRepositories(agentNameOrPath, {
    branchPolicy,
    profile = '',
    stdio = 'ignore',
    logError = () => {},
} = {}) {
    return applyManifestDirectivesInternal(agentNameOrPath, {
        branchPolicy,
        profile,
        visited: new Set(),
        enableAgents: false,
        stdio,
        logError,
    });
}
