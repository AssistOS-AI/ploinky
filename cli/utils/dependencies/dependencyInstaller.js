import fs from 'fs';
import path from 'path';
import { GLOBAL_DEPS_PATH } from '../config.js';
import { debugLog } from '../utils.js';
import { remoteBranchExists } from '../repos.js';

/**
 * Merge global and agent package.json objects.
 * Agent dependencies override global for conflicts (plan §12.3).
 * Returns a NEW object; inputs are not mutated.
 *
 * @param {object} globalPackage - ploinky/globalDeps/package.json contents
 * @param {object|null} agentPackage - agent's own package.json contents, or null
 * @param {object} [options]
 * @param {string} [options.agentlibSpec] - Fixed local archive spec selected for the whole graph.
 * @returns {object} Merged package.json
 */
function mergePackageJson(globalPackage, agentPackage, { agentlibSpec = '' } = {}) {
    const merged = { ...globalPackage };
    const agent = agentPackage || {};

    merged.dependencies = {
        ...(globalPackage.dependencies || {}),
        ...(agent.dependencies || {}),
    };
    if (agentlibSpec) {
        // A bounded local start selects one archive for the whole graph. Apply
        // it after the agent merge so an agent manifest cannot choose another
        // AchillesAgentLib source.
        merged.dependencies.achillesAgentLib = agentlibSpec;
    }

    if (agent.devDependencies) {
        merged.devDependencies = {
            ...(globalPackage.devDependencies || {}),
            ...agent.devDependencies,
        };
    }

    if (agentlibSpec) {
        // npm may prefer the same package name from devDependencies or
        // optionalDependencies over dependencies. The bounded local archive
        // is the one source for the whole graph, so remove every competing
        // install-class declaration after all package merges. Clone first so
        // a caller's package object is never mutated through the shallow copy.
        for (const section of ['devDependencies', 'optionalDependencies', 'peerDependencies']) {
            const entries = merged[section];
            if (!entries || typeof entries !== 'object' || Array.isArray(entries)
                || !Object.prototype.hasOwnProperty.call(entries, 'achillesAgentLib')) {
                continue;
            }
            merged[section] = { ...entries };
            delete merged[section].achillesAgentLib;
        }
        const peerMeta = merged.peerDependenciesMeta;
        if (peerMeta && typeof peerMeta === 'object' && !Array.isArray(peerMeta)
            && Object.prototype.hasOwnProperty.call(peerMeta, 'achillesAgentLib')) {
            merged.peerDependenciesMeta = { ...peerMeta };
            delete merged.peerDependenciesMeta.achillesAgentLib;
        }
        for (const section of ['bundleDependencies', 'bundledDependencies']) {
            if (Array.isArray(merged[section])) {
                merged[section] = merged[section].filter((name) => name !== 'achillesAgentLib');
            }
        }
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
 * achillesAgentLib normally follows its remote default branch through the
 * unpinned spec in globalDeps/package.json. `PLOINKY_AGENTLIB_REF` (set by
 * `ploinky start` from the global --branch, or exported directly) points every
 * agent's achillesAgentLib at a different branch or source for a single deploy
 * without editing tracked files.
 *
 * A bare value (e.g. "my-feature") is treated as a branch
 * and swapped onto the existing dependency URL. A full npm spec (git+..., a
 * URL, github:, npm: or file:) is used verbatim.
 *
 * @param {object} pkg - Parsed globalDeps package.json (mutated in place).
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment to read the override from.
 * @returns {object} The same pkg object.
 */
function overrideGlobalDeps(pkg, env = process.env) {
    const ref = String(env.PLOINKY_AGENTLIB_REF || '').trim();
    if (!ref) {
        return pkg;
    }
    const deps = pkg.dependencies || (pkg.dependencies = {});
    const isFullSpec = /:\/\//.test(ref) || /^(git\+|github:|npm:|file:|https?:)/.test(ref);
    let value;
    if (isFullSpec) {
        value = ref;
    } else {
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

/**
 * The configured achillesAgentLib remote URL from globalDeps/package.json, stripped
 * of the npm `git+` scheme prefix and any `#ref`, suitable for `git ls-remote`.
 *
 * @returns {string|null}
 */
function configuredAgentlibUrl() {
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
 * If the branch exists on the achillesAgentLib remote, use it. Otherwise honor
 * the branch fallback policy: `default` keeps the unpinned dependency on its
 * remote default branch, while `fail` aborts. Called from `ploinky start` with
 * the parsed --branch policy.
 *
 * @param {object} branchPolicy - parsed --branch policy ({ branch, fallback, ... }).
 * @param {object} [opts]
 * @param {(url: string, branch: string) => boolean} [opts.branchExists] - remote-branch probe (injectable for tests).
 * @param {string} [opts.url] - achillesAgentLib remote URL (defaults to the configured globalDeps URL).
 * @returns {string|null} branch to use, or null to keep the unpinned default dependency spec.
 */
function resolveAgentlibBranchRef(branchPolicy, { branchExists = remoteBranchExists, url } = {}) {
    const branch = branchPolicy?.branch;
    if (!branch) {
        return null;
    }
    const remoteUrl = url === undefined ? configuredAgentlibUrl() : url;
    if (remoteUrl && branchExists(remoteUrl, branch)) {
        return branch;
    }
    if (branchPolicy?.fallback === 'fail') {
        throw new Error(
            `Branch '${branch}' not found on the achillesAgentLib remote (${remoteUrl || 'unknown'}); `
            + `aborting (--branch-fallback fail).`,
        );
    }
    return null;
}

export {
    readGlobalDepsPackage,
    overrideGlobalDeps,
    resolveAgentlibBranchRef,
    mergePackageJson,
};
