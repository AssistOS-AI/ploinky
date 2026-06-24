import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { getRuntime } from './docker/common.js';
import { GLOBAL_DEPS_PATH } from './config.js';
import { getAgentWorkDir, getAgentCodePath, getRepoAgentCodePath } from './workspaceStructure.js';
import { debugLog } from './utils.js';
import { remoteBranchExists } from './repos.js';

/**
 * Execute a command inside a running container.
 * @param {string} containerName - The container name
 * @param {string} command - The command to execute
 * @param {object} options - Options for execSync
 * @returns {string} Command output
 */
function dockerExec(containerName, command, options = {}) {
    const runtime = getRuntime();
    const cmd = `${runtime} exec ${containerName} sh -c "${command.replace(/"/g, '\\"')}"`;
    debugLog(`dockerExec: ${cmd}`);
    return execSync(cmd, { stdio: options.stdio || 'pipe', ...options }).toString().trim();
}

/**
 * Write a file inside a running container using stdin.
 * @param {string} containerName - The container name
 * @param {string} filePath - Path to write inside the container
 * @param {string} content - Content to write
 */
function writeFileInContainer(containerName, filePath, content) {
    const runtime = getRuntime();
    const cmd = `${runtime} exec -i ${containerName} sh -c "cat > ${filePath}"`;
    debugLog(`dockerExec: ${cmd}`);
    execSync(cmd, { input: content });
}

/**
 * Ensure git is available in the container for npm installs.
 * @param {string} containerName - The container name
 * @param {Function} log - Logger function
 * @returns {{ success: boolean, message: string }}
 */
function ensureGitAvailable(containerName, log = debugLog) {
    try {
        dockerExec(containerName, 'git --version');
        return { success: true, message: 'git available' };
    } catch (_) {}

    const installers = [
        { name: 'apk', check: 'command -v apk', command: 'apk add --no-cache git' },
        { name: 'apt-get', check: 'command -v apt-get', command: 'apt-get update && apt-get install -y git' },
    ];

    for (const installer of installers) {
        try {
            dockerExec(containerName, installer.check);
        } catch (_) {
            continue;
        }

        try {
            log(`[deps] Installing git via ${installer.name}...`);
            dockerExec(containerName, installer.command, { maxBuffer: 1024 * 1024 * 10 });
            return { success: true, message: `git installed via ${installer.name}` };
        } catch (err) {
            log(`[deps] git install via ${installer.name} failed: ${err.message}`);
        }
    }

    return { success: false, message: 'git is required to install dependencies but could not be installed' };
}

/**
 * Ensure native build tools are available for node-gyp modules.
 * @param {string} containerName - The container name
 * @param {Function} log - Logger function
 * @returns {{ success: boolean, message: string }}
 */
function ensureBuildTools(containerName, log = debugLog) {
    const requiredCommands = ['python3', 'make', 'g++'];
    const missing = [];

    for (const command of requiredCommands) {
        try {
            dockerExec(containerName, `command -v ${command}`);
        } catch (_) {
            missing.push(command);
        }
    }

    if (!missing.length) {
        return { success: true, message: 'build tools available' };
    }

    const installers = [
        { name: 'apk', check: 'command -v apk', command: 'apk add --no-cache python3 make g++' },
        { name: 'apt-get', check: 'command -v apt-get', command: 'apt-get update && apt-get install -y python3 make g++' },
    ];

    for (const installer of installers) {
        try {
            dockerExec(containerName, installer.check);
        } catch (_) {
            continue;
        }

        try {
            log(`[deps] Installing build tools via ${installer.name}...`);
            dockerExec(containerName, installer.command, { maxBuffer: 1024 * 1024 * 10 });
            return { success: true, message: `build tools installed via ${installer.name}` };
        } catch (err) {
            log(`[deps] build tool install via ${installer.name} failed: ${err.message}`);
        }
    }

    return { success: false, message: `Missing build tools: ${missing.join(', ')}` };
}

/**
 * Check if a file exists inside the container.
 * @param {string} containerName - The container name
 * @param {string} filePath - Path to check inside container
 * @returns {boolean}
 */
function fileExistsInContainer(containerName, filePath) {
    try {
        dockerExec(containerName, `test -f ${filePath} && echo "yes"`);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Check if a directory exists inside the container.
 * @param {string} containerName - The container name
 * @param {string} dirPath - Path to check inside container
 * @returns {boolean}
 */
function dirExistsInContainer(containerName, dirPath) {
    try {
        dockerExec(containerName, `test -d ${dirPath} && echo "yes"`);
        return true;
    } catch (_) {
        return false;
    }
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
 * Setup the agent working directory on the host.
 * @param {string} agentName - The agent name
 * @returns {string} The path to the agent working directory
 */
function setupAgentWorkDir(agentName) {
    const workDir = getAgentWorkDir(agentName);
    if (!fs.existsSync(workDir)) {
        fs.mkdirSync(workDir, { recursive: true });
    }
    return workDir;
}

function getInstalledPackageStampPath(agentName) {
    return path.join(getAgentWorkDir(agentName), '.ploinky-install-package.json');
}

function filesHaveSameContent(firstPath, secondPath) {
    try {
        if (!fs.existsSync(firstPath) || !fs.existsSync(secondPath)) {
            return false;
        }
        return fs.readFileSync(firstPath, 'utf8') === fs.readFileSync(secondPath, 'utf8');
    } catch (_) {
        return false;
    }
}

function writeInstalledPackageStamp(agentName, packagePath) {
    if (!packagePath || !fs.existsSync(packagePath)) {
        return false;
    }
    const stampPath = getInstalledPackageStampPath(agentName);
    fs.copyFileSync(packagePath, stampPath);
    return true;
}

/**
 * Check if npm install needs to be run.
 * @param {string} containerName - The container name
 * @param {string} agentName - The agent name
 * @returns {{ needsInstall: boolean, reason: string }}
 */
function needsReinstall(containerName, agentName) {
    // Check if package.json exists in /code
    if (!fileExistsInContainer(containerName, '/code/package.json')) {
        return { needsInstall: false, reason: 'No package.json found in /code' };
    }

    // Check if node_modules exists
    if (!dirExistsInContainer(containerName, '/code/node_modules')) {
        return { needsInstall: true, reason: 'node_modules directory does not exist' };
    }

    // Check if node_modules is empty
    try {
        const output = dockerExec(containerName, 'ls /code/node_modules 2>/dev/null | head -1');
        if (!output) {
            return { needsInstall: true, reason: 'node_modules directory is empty' };
        }
    } catch (_) {
        return { needsInstall: true, reason: 'Cannot read node_modules directory' };
    }

    return { needsInstall: false, reason: 'Dependencies already installed' };
}

/**
 * Resolve the host path to an agent's package.json.
 * @param {string} agentName - The agent name
 * @param {string|null} [repoName] - Optional repository name for repo-scoped resolution
 * @param {string} [agentPath] - Optional agent root path
 * @returns {string|null} The package.json path or null if not found
 */
function resolveAgentPackagePath(agentName, repoName = null, agentPath = null) {
    const candidates = [
        agentPath ? path.join(agentPath, 'code', 'package.json') : null,
        agentPath ? path.join(agentPath, 'package.json') : null,
        repoName ? path.join(getRepoAgentCodePath(repoName, agentName), 'package.json') : null,
        path.join(getAgentCodePath(agentName), 'package.json'),
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

/**
 * Check if npm install needs to be run based on host filesystem state.
 * @param {string} agentName - The agent name
 * @param {object} [options] - Options
 * @param {string} [options.agentPath] - Optional agent root path
 * @param {string} [options.packagePath] - Optional resolved package.json path
 * @returns {{ needsInstall: boolean, reason: string }}
 */
function needsHostInstall(agentName, options = {}) {
    const { repoName = null, agentPath, packagePath } = options;
    const resolvedPackagePath = packagePath || resolveAgentPackagePath(agentName, repoName, agentPath);

    if (!resolvedPackagePath) {
        return { needsInstall: false, reason: 'No package.json found' };
    }

    const nodeModulesPath = path.join(getAgentWorkDir(agentName), 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
        return { needsInstall: true, reason: 'node_modules directory does not exist' };
    }

    try {
        const entries = fs.readdirSync(nodeModulesPath);
        if (!entries.length) {
            return { needsInstall: true, reason: 'node_modules directory is empty' };
        }
    } catch (_) {
        return { needsInstall: true, reason: 'Cannot read node_modules directory' };
    }

    const requiredCoreModulePath = path.join(nodeModulesPath, 'mcp-sdk');
    if (!fs.existsSync(requiredCoreModulePath)) {
        return { needsInstall: true, reason: 'mcp-sdk is missing from node_modules' };
    }

    const stampPath = getInstalledPackageStampPath(agentName);
    if (!fs.existsSync(stampPath)) {
        return { needsInstall: true, reason: 'Installed package stamp is missing' };
    }

    if (!filesHaveSameContent(resolvedPackagePath, stampPath)) {
        return { needsInstall: true, reason: 'package.json changed since the last successful install' };
    }

    return { needsInstall: false, reason: 'Dependencies already installed' };
}

/**
 * Run npm install in a container at the specified working directory.
 * @param {string} containerName - The container name
 * @param {string} workDir - Working directory (host path accessible in container via CWD mount)
 * @param {function} log - Logging function
 * @returns {{ success: boolean, message: string }}
 */
function runNpmInstallInContainer(containerName, workDir, log = debugLog) {
    try {
        const runtime = getRuntime();
        log(`[deps] Running npm install in ${workDir}...`);
        execSync(`${runtime} exec -w "${workDir}" ${containerName} npm install --no-package-lock`, {
            stdio: 'inherit',
            timeout: 600000 // 10 minute timeout
        });
        return { success: true, message: 'npm install completed' };
    } catch (err) {
        console.error(`[deps] npm install failed: ${err.message}`);
        return { success: false, message: `npm install failed: ${err.message}` };
    }
}

/**
 * Install dependencies inside a running container.
 * Uses CWD mount to write directly to host filesystem at $CWD/.ploinky/agents/<agent>/.
 *
 * This follows the spec:
 * 1. Copy core package.json (2 global deps) to $CWD/.ploinky/agents/<agent>/package.json
 * 2. Run npm install in $CWD/.ploinky/agents/<agent>/
 * 3. If agent has package.json in /code, merge and run npm install again
 *
 * @param {string} containerName - The container name
 * @param {string} agentName - The agent name
 * @param {object} options - Options
 * @returns {{ success: boolean, message: string }}
 */
function installDependencies(containerName, agentName, options = {}) {
    const { force = false, verbose = false } = options;
    const log = verbose ? console.log : debugLog;

    const agentWorkDir = getAgentWorkDir(agentName);
    const nodeModulesPath = path.join(agentWorkDir, 'node_modules');
    const mcpSdkPath = path.join(nodeModulesPath, 'mcp-sdk');
    const hasCoreModules = fs.existsSync(mcpSdkPath);

    // Check if agent has package.json in source
    const hasAgentPackage = fileExistsInContainer(containerName, '/code/package.json');

    // Use cached if available
    if (!force && hasCoreModules && !hasAgentPackage) {
        log(`[deps] Using cached core node_modules for ${agentName}`);
        return { success: true, message: 'Using cached core node_modules' };
    }

    try {
        // Ensure agent work dir exists inside container (via CWD mount)
        dockerExec(containerName, `mkdir -p "${agentWorkDir}"`);

        // Step 1: Copy core package.json and install (2 global deps)
        if (!hasCoreModules || force) {
            log(`[deps] Installing core dependencies for ${agentName}...`);
            const corePackage = readGlobalDepsPackage();
            const corePackagePath = path.join(agentWorkDir, 'package.json');

            // Copy core package.json inside container
            writeFileInContainer(containerName, corePackagePath, JSON.stringify(corePackage, null, 2));

            const coreResult = runNpmInstallInContainer(containerName, agentWorkDir, log);
            if (!coreResult.success) {
                return coreResult;
            }
            writeInstalledPackageStamp(agentName, corePackagePath);
        }

        // Step 2: If agent has package.json, copy from /code and install (adds to existing node_modules)
        if (hasAgentPackage) {
            log(`[deps] Installing agent dependencies for ${agentName}...`);

            const agentPackagePath = path.join(agentWorkDir, 'package.json');
            // Copy agent's package.json from /code to agent work dir inside container
            dockerExec(containerName, `cp /code/package.json "${agentPackagePath}"`);

            const agentResult = runNpmInstallInContainer(containerName, agentWorkDir, log);
            if (!agentResult.success) {
                return agentResult;
            }
            writeInstalledPackageStamp(agentName, agentPackagePath);
        }

        log(`[deps] Dependencies installed successfully for ${agentName}`);
        return { success: true, message: 'Dependencies installed successfully' };

    } catch (err) {
        console.error(`[deps] Failed to install dependencies for ${agentName}: ${err.message}`);
        return { success: false, message: `Installation failed: ${err.message}` };
    }
}

/**
 * Install core dependencies only (without agent dependencies).
 * All operations run inside the container via CWD mount.
 *
 * @param {string} containerName - The container name
 * @param {string} agentName - The agent name
 * @returns {{ success: boolean, message: string }}
 */
function installCoreDependencies(containerName, agentName) {
    try {
        debugLog(`[deps] Installing core dependencies for ${agentName}...`);

        const agentWorkDir = getAgentWorkDir(agentName);

        // Ensure agent work dir exists inside container
        dockerExec(containerName, `mkdir -p "${agentWorkDir}"`);

        // Copy core package.json inside container
        const corePackage = readGlobalDepsPackage();
        const corePackagePath = path.join(agentWorkDir, 'package.json');
        writeFileInContainer(containerName, corePackagePath, JSON.stringify(corePackage, null, 2));

        // Run npm install inside container
        const result = runNpmInstallInContainer(containerName, agentWorkDir, debugLog);
        if (result.success) {
            writeInstalledPackageStamp(agentName, corePackagePath);
        }
        return result;
    } catch (err) {
        return { success: false, message: `Core installation failed: ${err.message}` };
    }
}

/**
 * Install agent-specific dependencies.
 * Copies agent's package.json from /code and runs npm install (adds to existing node_modules).
 * All operations run inside the container via CWD mount.
 *
 * @param {string} containerName - The container name
 * @param {string} agentName - The agent name
 * @returns {{ success: boolean, message: string }}
 */
function installAgentDependencies(containerName, agentName) {
    // Check if agent has a package.json
    if (!fileExistsInContainer(containerName, '/code/package.json')) {
        return { success: true, message: 'No agent package.json found' };
    }

    try {
        debugLog(`[deps] Installing agent dependencies for ${agentName}...`);

        const agentWorkDir = getAgentWorkDir(agentName);

        // Ensure agent work dir exists inside container
        dockerExec(containerName, `mkdir -p "${agentWorkDir}"`);

        // Copy agent's package.json from /code to agent work dir inside container
        const agentPackagePath = path.join(agentWorkDir, 'package.json');
        dockerExec(containerName, `cp /code/package.json "${agentPackagePath}"`);

        // Run npm install inside container (adds to existing node_modules)
        const result = runNpmInstallInContainer(containerName, agentWorkDir, debugLog);
        if (result.success) {
            writeInstalledPackageStamp(agentName, agentPackagePath);
        }
        return result;
    } catch (err) {
        return { success: false, message: `Agent installation failed: ${err.message}` };
    }
}

/**
 * Sync node_modules from source repo to agent working directory.
 * This ensures that any modules in the source repo (like achillesAgentLib subdirectories)
 * are properly copied to the agent's node_modules.
 *
 * @param {string} agentName - The agent name
 * @param {string} sourceCodePath - Path to the source code (with node_modules)
 * @param {object} options - Options
 * @param {boolean} [options.verbose=false] - Enable verbose logging
 * @returns {{ synced: boolean, modules: string[], errors: string[] }}
 */
function syncSourceNodeModules(agentName, sourceCodePath, options = {}) {
    const { verbose = false } = options;
    const log = verbose ? console.log : debugLog;

    const sourceNodeModules = path.join(sourceCodePath, 'node_modules');
    const agentWorkDir = getAgentWorkDir(agentName);
    const agentNodeModules = path.join(agentWorkDir, 'node_modules');

    const result = { synced: false, modules: [], errors: [] };

    // Check if source has node_modules
    if (!fs.existsSync(sourceNodeModules)) {
        log(`[deps-sync] ${agentName}: No source node_modules at ${sourceNodeModules}`);
        return result;
    }

    // Ensure agent node_modules exists
    if (!fs.existsSync(agentNodeModules)) {
        fs.mkdirSync(agentNodeModules, { recursive: true });
    }

    try {
        const sourceModules = fs.readdirSync(sourceNodeModules);

        for (const moduleName of sourceModules) {
            // Skip hidden files and package-lock
            if (moduleName.startsWith('.') || moduleName === 'package-lock.json') {
                continue;
            }

            const sourceModulePath = path.join(sourceNodeModules, moduleName);
            const agentModulePath = path.join(agentNodeModules, moduleName);

            // Skip if not a directory
            if (!fs.statSync(sourceModulePath).isDirectory()) {
                continue;
            }

            try {
                if (!fs.existsSync(agentModulePath)) {
                    // Module doesn't exist in agent, copy entirely
                    log(`[deps-sync] ${agentName}: Copying missing module ${moduleName}`);
                    if (typeof fs.cpSync === 'function') {
                        fs.cpSync(sourceModulePath, agentModulePath, { recursive: true });
                    } else {
                        execSync(`cp -a "${sourceModulePath}" "${agentModulePath}"`);
                    }
                    result.modules.push(moduleName);
                } else {
                    // Module exists, sync any missing subdirectories
                    const syncedSubdirs = syncModuleSubdirectories(
                        moduleName,
                        sourceModulePath,
                        agentModulePath,
                        log
                    );
                    if (syncedSubdirs.length > 0) {
                        result.modules.push(`${moduleName}/${syncedSubdirs.join(', ')}`);
                    }
                }
            } catch (err) {
                result.errors.push(`${moduleName}: ${err.message}`);
            }
        }

        result.synced = result.modules.length > 0;
        if (result.synced) {
            log(`[deps-sync] ${agentName}: Synced modules: ${result.modules.join(', ')}`);
        }

    } catch (err) {
        result.errors.push(`Failed to read source node_modules: ${err.message}`);
    }

    return result;
}

/**
 * Sync subdirectories of a module that might be missing in the target.
 * This handles cases like achillesAgentLib where subdirectories like
 * CodeGenerationSkillsSubsystem might not be present after npm install.
 *
 * @param {string} moduleName - The module name (for logging)
 * @param {string} sourcePath - Source module path
 * @param {string} targetPath - Target module path
 * @param {Function} log - Logger function
 * @returns {string[]} List of synced subdirectory names
 */
function syncModuleSubdirectories(moduleName, sourcePath, targetPath, log = debugLog) {
    const synced = [];

    try {
        const sourceEntries = fs.readdirSync(sourcePath);

        for (const entry of sourceEntries) {
            // Skip hidden files, node_modules, and common non-essential files
            if (entry.startsWith('.') ||
                entry === 'node_modules' ||
                entry === 'package-lock.json') {
                continue;
            }

            const sourceEntryPath = path.join(sourcePath, entry);
            const targetEntryPath = path.join(targetPath, entry);

            // Only sync directories
            if (!fs.statSync(sourceEntryPath).isDirectory()) {
                continue;
            }

            if (!fs.existsSync(targetEntryPath)) {
                log(`[deps-sync] Copying missing subdir ${moduleName}/${entry}`);
                if (typeof fs.cpSync === 'function') {
                    fs.cpSync(sourceEntryPath, targetEntryPath, { recursive: true });
                } else {
                    execSync(`cp -a "${sourceEntryPath}" "${targetEntryPath}"`);
                }
                synced.push(entry);
            } else {
                // Recursively check subdirectories for modules like achillesAgentLib
                // that have deeply nested structure
                const nestedSynced = syncModuleSubdirectories(
                    `${moduleName}/${entry}`,
                    sourceEntryPath,
                    targetEntryPath,
                    log
                );
                if (nestedSynced.length > 0) {
                    synced.push(...nestedSynced.map(s => `${entry}/${s}`));
                }
            }
        }
    } catch (err) {
        log(`[deps-sync] Error syncing ${moduleName} subdirs: ${err.message}`);
    }

    return synced;
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
 * achillesAgentLib at a different branch or source for a single deploy without
 * editing tracked files.
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
 * Best-effort, mirroring per-repo branch resolution: if the branch exists on the
 * achillesAgentLib remote, use it; otherwise honor the branch fallback
 * (`default` → null so the pinned #master is kept, `fail` → throw). Called from
 * `ploinky start` with the parsed --branch policy.
 *
 * @param {object} branchPolicy - parsed --branch policy ({ branch, fallback, ... }).
 * @param {object} [opts]
 * @param {(url: string, branch: string) => boolean} [opts.branchExists] - remote-branch probe (injectable for tests).
 * @param {string} [opts.url] - achillesAgentLib remote URL (defaults to the pinned globalDeps URL).
 * @returns {string|null} branch to use, or null to keep the pinned default.
 */
function resolveAgentlibBranchRef(branchPolicy, { branchExists = remoteBranchExists, url } = {}) {
    const branch = branchPolicy?.branch;
    if (!branch) {
        return null;
    }
    const remoteUrl = url === undefined ? pinnedAgentlibUrl() : url;
    if (remoteUrl && branchExists(remoteUrl, branch)) {
        return branch;
    }
    if (branchPolicy.fallback === 'fail') {
        throw new Error(
            `Branch '${branch}' not found on the achillesAgentLib remote (${remoteUrl || 'unknown'}); `
            + `aborting (--branch-fallback fail).`,
        );
    }
    return null;
}

export {
    dockerExec,
    fileExistsInContainer,
    dirExistsInContainer,
    readGlobalDepsPackage,
    overrideGlobalDeps,
    resolveAgentlibBranchRef,
    mergePackageJson,
    setupAgentWorkDir,
    needsReinstall,
    needsHostInstall,
    installDependencies,
    installCoreDependencies,
    installAgentDependencies,
    syncSourceNodeModules,
    syncModuleSubdirectories,
    getInstalledPackageStampPath,
    writeInstalledPackageStamp,
};
