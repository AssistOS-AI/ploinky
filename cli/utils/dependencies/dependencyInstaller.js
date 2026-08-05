import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { GLOBAL_DEPS_PATH } from '../config.js';
import { debugLog } from '../utils.js';

const IMMUTABLE_GIT_COMMIT = /^[0-9a-f]{40}$/;
function isImmutableGitSource(source) {
    const meaningfulPathSegment = (segment) => /^[A-Za-z0-9._~-]+$/.test(segment)
        && /[A-Za-z0-9]/.test(segment)
        && segment !== '.' && segment !== '..';
    if (/^github:/.test(source)) {
        const match = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(source);
        if (!match) return false;
        const repository = match[2].endsWith('.git') ? match[2].slice(0, -4) : match[2];
        return meaningfulPathSegment(match[1]) && meaningfulPathSegment(repository);
    }
    const rawUrl = source.startsWith('git+') ? source.slice(4) : source;
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch (_) {
        return false;
    }
    const hostname = parsed.hostname;
    const hostnameIsMeaningful = /^\[[0-9A-Fa-f:]+\]$/.test(hostname)
        || hostname.split('.').every((label) => (
            /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
        ));
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    if (pathSegments.length > 0 && pathSegments.at(-1).endsWith('.git')) {
        pathSegments[pathSegments.length - 1] = pathSegments.at(-1).slice(0, -4);
    }
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)
        || !hostname || !hostnameIsMeaningful || parsed.pathname.includes('%')
        || pathSegments.length === 0 || !pathSegments.every(meaningfulPathSegment)
        || parsed.search || parsed.hash) {
        return false;
    }
    return source.startsWith('git+') || parsed.protocol === 'git:';
}

function assertImmutableAgentlibDependency(spec, label) {
    const value = String(spec || '').trim();
    const firstHashIdx = value.indexOf('#');
    const hashIdx = value.lastIndexOf('#');
    const commit = hashIdx >= 0 ? value.slice(hashIdx + 1) : '';
    const source = hashIdx >= 0 ? value.slice(0, hashIdx) : '';
    if (
        hashIdx <= 0
        || firstHashIdx !== hashIdx
        || !isImmutableGitSource(source)
        || !IMMUTABLE_GIT_COMMIT.test(commit)
    ) {
        throw new Error(`${label} must use an immutable 40-hex commit.`);
    }
    return value;
}

/**
 * Merge global and agent package.json objects.
 * Agent dependencies override global for conflicts (plan §12.3).
 * Returns a NEW object; inputs are not mutated.
 *
 * @param {object} globalPackage - ploinky/globalDeps/package.json contents
 * @param {object|null} agentPackage - agent's own package.json contents, or null
 * @returns {object} Merged package.json
 */
function mergePackageJson(globalPackage, agentPackage) {
    const merged = { ...globalPackage };
    const agent = agentPackage || {};

    merged.dependencies = {
        ...(globalPackage.dependencies || {}),
        ...(agent.dependencies || {}),
    };

    if (agent.devDependencies) {
        merged.devDependencies = {
            ...(globalPackage.devDependencies || {}),
            ...agent.devDependencies,
        };
    }

    if (agent.scripts) {
        merged.scripts = agent.scripts;
    }

    if (agent.name) {
        merged.name = agent.name;
    }

    return merged;
}

/**
 * Read the global dependencies package.json.
 *
 * `globalDeps/package.json` is the single source of truth for every
 * agent's core dependencies (achillesAgentLib, mcp-sdk). It is copied
 * into each agent's workspace package.json
 * at install time and then read from there on every container start.
 *
 * There is deliberately NO hardcoded fallback here — if this file is
 * missing, the deployment is broken and we want to fail loudly rather
 * than silently ship a stale template that has drifted from the real
 * one.
 *
 * @returns {object} The parsed global package.json
 * @throws {Error} if globalDeps/package.json cannot be read
 */
function readGlobalDepsPackage(env = process.env) {
    const globalPackagePath = path.join(GLOBAL_DEPS_PATH, 'package.json');
    if (!fs.existsSync(globalPackagePath)) {
        throw new Error(
            `ploinky globalDeps package.json not found at ${globalPackagePath}. `
            + `This file is required — it defines the core dependencies `
            + `(achillesAgentLib, mcp-sdk) that every `
            + `agent installs on setup.`
        );
    }
    const pkg = JSON.parse(fs.readFileSync(globalPackagePath, 'utf8'));
    return overrideGlobalDeps(pkg, env);
}

/**
 * Apply deploy-time overrides to the global dependency set.
 *
 * achillesAgentLib is normally pinned to a fixed git ref in
 * globalDeps/package.json. `PLOINKY_AGENTLIB_REF` (set by `ploinky start` from
 * the global --branch, or exported directly) points every agent's
 * achillesAgentLib at a resolved immutable commit for a single deploy without
 * editing tracked files.
 *
 * A bare immutable commit is swapped onto the existing dependency URL. A full
 * npm git spec is used verbatim only when its ref is also an immutable commit.
 * Moving branch/tag refs and local sources are rejected before cache/install.
 *
 * @param {object} pkg - Parsed globalDeps package.json (mutated in place).
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment to read the override from.
 * @returns {object} The same pkg object.
 */
function overrideGlobalDeps(pkg, env = process.env) {
    const deps = pkg.dependencies || (pkg.dependencies = {});
    assertImmutableAgentlibDependency(
        deps.achillesAgentLib,
        'The tracked achillesAgentLib dependency',
    );

    const ref = String(env.PLOINKY_AGENTLIB_REF || '').trim();
    if (!ref) {
        return pkg;
    }
    const isFullSpec = /:\/\//.test(ref) || /^(git\+|github:|npm:|file:|https?:)/.test(ref);
    let value;
    if (isFullSpec) {
        value = assertImmutableAgentlibDependency(
            ref,
            'PLOINKY_AGENTLIB_REF',
        );
    } else {
        if (!IMMUTABLE_GIT_COMMIT.test(ref)) {
            throw new Error('PLOINKY_AGENTLIB_REF must be an immutable 40-hex commit or a git spec pinned to one.');
        }
        const current = String(deps.achillesAgentLib || '');
        const hashIdx = current.indexOf('#');
        const base = hashIdx >= 0 ? current.slice(0, hashIdx) : current;
        value = base ? `${base}#${ref}` : ref;
    }
    if (deps.achillesAgentLib !== value) {
        debugLog(`[deps] achillesAgentLib override active: ${value}`);
    }
    deps.achillesAgentLib = value;
    return pkg;
}

function resolveRemoteAgentlibBranch(remoteUrl, branch, lsRemote) {
    if (!remoteUrl) {
        return null;
    }
    const expectedRef = `refs/heads/${branch}`;
    const result = lsRemote(
        'git',
        ['ls-remote', '--exit-code', '--heads', remoteUrl, expectedRef],
        {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    if (result?.error || result?.status !== 0) {
        return null;
    }
    const matches = String(result.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .filter(([commit, ref]) => IMMUTABLE_GIT_COMMIT.test(commit) && ref === expectedRef);
    if (matches.length !== 1) {
        return null;
    }
    return matches[0][0];
}

/**
 * The pinned achillesAgentLib remote URL from globalDeps/package.json, stripped
 * of the npm `git+` scheme prefix and any `#ref`, suitable for `git ls-remote`.
 *
 * @returns {string|null}
 */
function pinnedAgentlibUrl() {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(GLOBAL_DEPS_PATH, 'package.json'), 'utf8'));
        const dep = String(raw?.dependencies?.achillesAgentLib || '');
        let url = dep.replace(/^git\+/, '');
        const hashIdx = url.indexOf('#');
        if (hashIdx >= 0) {
            url = url.slice(0, hashIdx);
        }
        return url || null;
    } catch (_) {
        return null;
    }
}

/**
 * Resolve the achillesAgentLib ref implied by a global --branch policy.
 *
 * Resolve the exact requested remote branch to its current immutable commit. A
 * missing or mismatched ref is always fatal: remote HEAD/default output never
 * substitutes for the requested branch, and npm never receives a moving ref.
 * Called from `ploinky start` with the parsed --branch policy.
 *
 * @param {object} branchPolicy - parsed --branch policy ({ branch, fallback, ... }).
 * @param {object} [opts]
 * @param {typeof spawnSync} [opts.lsRemote] - `git ls-remote` runner (injectable for tests).
 * @param {string} [opts.url] - achillesAgentLib remote URL (defaults to the pinned globalDeps URL).
 * @returns {string|null} immutable commit to use, or null when no branch was requested.
 */
function resolveAgentlibBranchRef(branchPolicy, { lsRemote = spawnSync, url } = {}) {
    const branch = branchPolicy?.branch;
    if (!branch) {
        return null;
    }
    const remoteUrl = url === undefined ? pinnedAgentlibUrl() : url;
    const commit = resolveRemoteAgentlibBranch(remoteUrl, branch, lsRemote);
    if (commit) {
        return commit;
    }
    const fallback = branchPolicy?.fallback || 'default';
    throw new Error(
        `Branch '${branch}' not found on the achillesAgentLib remote (${remoteUrl || 'unknown'}); `
        + `refusing AgentLib dependency fallback (requested --branch-fallback ${fallback}).`,
    );
}

export {
    readGlobalDepsPackage,
    overrideGlobalDeps,
    resolveAgentlibBranchRef,
    mergePackageJson,
};
