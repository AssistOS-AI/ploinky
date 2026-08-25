import fs from 'fs';
import path from 'path';
import { GLOBAL_DEPS_PATH } from '../config.js';
import { assertNoReservedAgentLibDependency } from './agentLibLink.js';

/**
 * Merge global and agent package.json objects.
 * Agent dependencies override global for conflicts (plan §12.3).
 * Returns a NEW object; inputs are not mutated.
 *
 * achillesAgentLib is reserved: it is provided as a direct-mounted source, not
 * as an npm dependency, so an agent that declares it is rejected here — before
 * npm runs — rather than being allowed to shadow the framework source.
 *
 * @param {object} globalPackage - ploinky/globalDeps/package.json contents
 * @param {object|null} agentPackage - agent's own package.json contents, or null
 * @returns {object} Merged package.json
 */
function mergePackageJson(globalPackage, agentPackage) {
    const merged = { ...globalPackage };
    const agent = assertNoReservedAgentLibDependency(agentPackage || {}, 'agent package.json');

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
 * agent's npm-installed core dependencies (mcp-sdk). achillesAgentLib is
 * deliberately absent: it is direct-mounted from the selected workspace source
 * and linked into each cache instead of installed. The file is copied into each
 * agent's workspace package.json at install time and then read from there on
 * every container start.
 *
 * There is deliberately NO hardcoded fallback here — if this file is
 * missing, the deployment is broken and we want to fail loudly rather
 * than silently ship a stale template that has drifted from the real
 * one.
 *
 * @returns {object} The parsed global package.json
 * @throws {Error} if globalDeps/package.json cannot be read
 */
function readGlobalDepsPackage() {
    const globalPackagePath = path.join(GLOBAL_DEPS_PATH, 'package.json');
    if (!fs.existsSync(globalPackagePath)) {
        throw new Error(
            `ploinky globalDeps package.json not found at ${globalPackagePath}. `
            + `This file is required — it defines the core npm dependencies `
            + `(mcp-sdk) that every agent installs on setup.`
        );
    }
    return assertNoReservedAgentLibDependency(
        JSON.parse(fs.readFileSync(globalPackagePath, 'utf8')),
        globalPackagePath,
    );
}

export {
    readGlobalDepsPackage,
    mergePackageJson,
};
