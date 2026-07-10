import fs from 'node:fs';
import path from 'node:path';
import {
    formatPortRange,
    intervalsOverlap,
    manifestClaimsEqual,
    parseManifestOpenPortSpec,
} from './publish-spec.mjs';

const EXPLORER_PUBLIC_AGENT = 'explorer';
const EXPLORER_ROOT_REF = 'AchillesIDE/explorer';
const DEFAULT_PROFILE = 'default';
const MODE_TOKENS = new Set(['global', 'isolated', 'devel', 'no-wait']);
const REPO_DIR_ALIASES = new Map([
    ['AchillesIDE', 'AssistOSExplorer'],
    ['AssistOSExplorer', 'AssistOSExplorer'],
]);

export function planBoxPublishesForStart({ startPlan, sourceDir, workspaceRoot = path.dirname(sourceDir) } = {}) {
    if (!isExplorerStart(startPlan)) {
        return { publishes: [], graph: [] };
    }

    const workspaceProfile = normalizeProfileName(startPlan?.profile) || DEFAULT_PROFILE;
    const graph = [];
    const publishes = [];
    const seenNodes = new Set();
    const claims = [];

    visitAgent(EXPLORER_ROOT_REF, {
        profile: workspaceProfile,
        profileExplicit: false,
        workspaceProfile,
        alias: '',
        fromRepo: '',
        workspaceRoot,
        graph,
        publishes,
        seenNodes,
        claims,
    });

    return { publishes, graph };
}

export function publishTarget(spec) {
    return parseOpenPortPublishSpec(spec).target;
}

export function parseOpenPortPublishSpec(spec) {
    return parseManifestOpenPortSpec(spec);
}

function isExplorerStart(startPlan) {
    if (!startPlan?.hasAgent) return false;
    const agent = String(startPlan?.agent || '').trim();
    return agent === EXPLORER_PUBLIC_AGENT
        || agent === EXPLORER_ROOT_REF
        || agent === 'AssistOSExplorer/explorer';
}

function visitAgent(ref, state) {
    const resolved = resolveAgentRef(ref, state.fromRepo, state.workspaceRoot);
    const manifest = readManifest(resolved.manifestPath);
    const profile = pickProfile(manifest, state.profile, resolved.ref, {
        explicit: state.profileExplicit,
    });
    const alias = normalizeAlias(state.alias);
    const nodeKey = effectiveNodeKey(resolved.ref, profile, alias);
    if (state.seenNodes.has(nodeKey)) {
        return;
    }
    state.seenNodes.add(nodeKey);

    const profileConfig = mergeProfileConfig(manifest, profile);

    state.graph.push({
        ref: resolved.ref,
        profile,
        alias,
        instanceKey: nodeKey,
        manifestPath: resolved.manifestPath,
    });

    for (const spec of collectOpenPorts(profileConfig, resolved.ref)) {
        const parsed = parseOpenPortPublishSpec(spec);
        const claim = {
            ...parsed,
            ownerRef: resolved.ref,
            profile,
            alias,
            nodeKey,
        };
        let duplicate = false;
        for (const existing of state.claims) {
            if (existing.protocol !== claim.protocol || !intervalsOverlap(existing.boxSide, claim.boxSide)) {
                continue;
            }
            if (existing.nodeKey === claim.nodeKey && manifestClaimsEqual(existing, claim)) {
                duplicate = true;
                break;
            }
            throw new Error(formatClaimConflict(existing, claim));
        }
        if (duplicate) continue;
        state.claims.push(claim);
        state.publishes.push(parsed.spec);
    }

    for (const entry of manifestEnableEntries(manifest, profile)) {
        const directive = parseEnableDirective(entry);
        const childRef = resolveAgentRef(directive.spec, resolved.repo, state.workspaceRoot);
        visitAgent(childRef.ref, {
            ...state,
            profile: directive.profile || state.workspaceProfile,
            profileExplicit: Boolean(directive.profile),
            alias: directive.alias || '',
            fromRepo: childRef.repo,
        });
    }
}

function collectOpenPorts(profileConfig, ref) {
    const ports = profileConfig?.openPorts;
    if (ports === undefined || ports === null) {
        return [];
    }
    const values = Array.isArray(ports) ? ports : [ports];
    return values.map((value) => {
        if (typeof value !== 'string' || !value.trim()) {
            throw new Error(`agent ${ref} has malformed openPorts entry`);
        }
        return value.trim();
    });
}

function manifestEnableEntries(manifest, profile) {
    const entries = [];
    if (Array.isArray(manifest?.enable)) {
        entries.push(...manifest.enable);
    }
    const profiles = manifest?.profiles || {};
    const profileBlock = profiles[profile] || profiles[DEFAULT_PROFILE];
    if (Array.isArray(profileBlock?.enable)) {
        entries.push(...profileBlock.enable);
    }
    return entries;
}

function parseEnableDirective(entry) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const parsed = parseEnableDirective(entry.agent ?? entry.ref ?? entry.spec ?? entry.name);
        const profile = normalizeProfileName(entry.profile);
        const alias = normalizeAlias(entry.alias ?? entry.as ?? parsed.alias);
        return {
            ...parsed,
            profile,
            alias,
        };
    }

    const raw = String(entry || '').trim();
    if (!raw) {
        throw new Error('manifest enable entry is missing agent reference');
    }
    let tokens = raw.split(/\s+/).filter(Boolean);
    if (!tokens.length) {
        throw new Error(`manifest enable entry '${raw}' is missing agent reference`);
    }
    tokens = tokens.filter((token) => token.toLowerCase() !== 'no-wait');
    const aliasIndex = tokens.findIndex((token) => token.toLowerCase() === 'as');
    let alias = '';
    if (aliasIndex !== -1) {
        if (aliasIndex + 1 >= tokens.length) {
            throw new Error(`manifest enable entry '${raw}' is missing alias name after "as"`);
        }
        alias = normalizeAlias(tokens[aliasIndex + 1]);
        tokens = tokens.slice(0, aliasIndex);
    }
    if (!tokens.length || tokens.every((token) => MODE_TOKENS.has(token.toLowerCase()))) {
        throw new Error(`manifest enable entry '${raw}' is missing agent reference`);
    }
    return {
        spec: tokens.join(' '),
        profile: '',
        alias,
    };
}

function resolveAgentRef(spec, currentRepo, workspaceRoot) {
    const token = firstAgentToken(spec);
    if (!token) {
        throw new Error(`manifest enable entry '${spec}' is missing agent reference`);
    }

    const qualified = qualifySameRepoBareRef(token, currentRepo, workspaceRoot);
    if (qualified) {
        return qualified;
    }

    if (token.includes('/')) {
        const [repoToken, agentName] = token.split('/', 2);
        return resolveQualifiedRef(repoToken, agentName, workspaceRoot);
    }

    throw new Error(`missing manifest for enabled agent ${token}`);
}

function qualifySameRepoBareRef(agentName, currentRepo, workspaceRoot) {
    const repo = canonicalRepoName(currentRepo);
    if (!repo || !agentName || agentName.includes('/')) {
        return null;
    }
    const repoDir = repoDirName(repo);
    const manifestPath = path.join(workspaceRoot, repoDir, agentName, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        return null;
    }
    return {
        repo,
        ref: `${repo}/${agentName}`,
        manifestPath,
    };
}

function resolveQualifiedRef(repoToken, agentName, workspaceRoot) {
    const repo = canonicalRepoName(repoToken);
    const repoDir = repoDirName(repo);
    const manifestPath = path.join(workspaceRoot, repoDir, agentName, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`missing manifest for enabled agent ${repo}/${agentName}`);
    }
    return {
        repo,
        ref: `${repo}/${agentName}`,
        manifestPath,
    };
}

function pickProfile(manifest, requestedProfile, ref, { explicit = false } = {}) {
    const profiles = manifest?.profiles || {};
    const normalized = normalizeProfileName(requestedProfile);
    if (!normalized) {
        return DEFAULT_PROFILE;
    }
    if (!Object.prototype.hasOwnProperty.call(profiles, normalized)) {
        if (!explicit) {
            return DEFAULT_PROFILE;
        }
        const available = Object.keys(profiles).sort();
        throw new Error(
            `profile ${normalized} is not defined by ${ref}; available profiles: ${available.join(', ') || '(none)'}`,
        );
    }
    return normalized;
}

function mergeProfileConfig(manifest, profile) {
    const profiles = manifest?.profiles || {};
    const base = isPlainObject(profiles[DEFAULT_PROFILE]) ? profiles[DEFAULT_PROFILE] : {};
    const selected = profile !== DEFAULT_PROFILE && isPlainObject(profiles[profile]) ? profiles[profile] : {};
    const merged = deepMerge(base, selected);
    if (Object.prototype.hasOwnProperty.call(selected, 'openPorts')) {
        merged.openPorts = selected.openPorts;
    }
    return merged;
}

function deepMerge(base, override) {
    const result = { ...base };
    for (const [key, value] of Object.entries(override || {})) {
        if (isPlainObject(value) && isPlainObject(result[key])) {
            result[key] = deepMerge(result[key], value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readManifest(manifestPath) {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function canonicalRepoName(repoName) {
    const raw = String(repoName || '').trim();
    if (!raw) {
        return '';
    }
    return REPO_DIR_ALIASES.has(raw) && raw !== 'AssistOSExplorer'
        ? 'AchillesIDE'
        : (raw === 'AssistOSExplorer' ? 'AchillesIDE' : raw);
}

function repoDirName(repoName) {
    return REPO_DIR_ALIASES.get(repoName) || repoName;
}

function normalizeProfileName(profile) {
    return String(profile || '').trim().toLowerCase();
}

function normalizeAlias(alias) {
    return String(alias || '').trim();
}

function effectiveNodeKey(ref, profile, alias) {
    return alias ? `${ref}#${profile}#alias:${alias}` : `${ref}#${profile}#canonical`;
}

function formatClaimConflict(existing, claim) {
    const overlapStart = Math.max(existing.boxSide.start, claim.boxSide.start);
    const overlapEnd = Math.min(existing.boxSide.end, claim.boxSide.end);
    const overlap = formatPortRange({ start: overlapStart, end: overlapEnd });
    return `overlapping openPorts box-side socket ${overlap}/${claim.protocol}: ${describeClaim(existing)} conflicts with ${describeClaim(claim)}`;
}

function describeClaim(claim) {
    const identity = claim.alias ? `alias ${claim.alias}` : 'canonical instance';
    return `${claim.ownerRef} (profile ${claim.profile}, ${identity}, ${claim.bindClass} bind ${claim.hostIp || '(engine default)'}) declares '${claim.raw}' (box ${formatPortRange(claim.boxSide)} -> private ${formatPortRange(claim.privateContainer)})`;
}

function firstAgentToken(spec) {
    return String(spec || '').trim().split(/\s+/).filter(Boolean)[0] || '';
}
