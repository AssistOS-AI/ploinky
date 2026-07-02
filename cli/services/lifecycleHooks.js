import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { getRuntime } from './docker/common.js';
import { debugLog } from './utils.js';
import { getProfileConfig, getProfileEnvVars, getHookNames, getActiveProfile } from './profileService.js';
import { validateSecrets, getSecrets, createEnvWithSecrets, formatMissingSecretsError } from './secretInjector.js';
import { buildEnvMap } from './secretVars.js';
import { buildAgentIdentityEnv, stripReservedAgentEnv } from './agentIdentityEnv.js';
import { deriveAgentPrincipalId } from './agentIdentity.js';
import {
    initWorkspaceStructure,
    createAgentSymlinks,
    createAgentWorkDir
} from './workspaceStructure.js';
import { PLOINKY_WORKSPACE_ROOT } from './config.js';

function normalizeProfileEnv(env) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
        return {};
    }
    const normalized = {};
    for (const [key, value] of Object.entries(env)) {
        if (!key) continue;
        // Handle complex env specs with varName/default - skip these as they're handled by buildEnvFlags
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            // Complex spec like { varName: "...", default: "..." } - skip, handled elsewhere
            continue;
        }
        normalized[String(key)] = value === undefined ? '' : String(value);
    }
    return normalized;
}

function sanitizeMarkerPart(value) {
    const sanitized = String(value || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
    return sanitized || 'default';
}

const preinstallRunKeys = new Set();

function readManifest(agentPath) {
    try {
        const manifestPath = path.join(agentPath || '', 'manifest.json');
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (_) {
        return {};
    }
}

function buildLifecycleHookEnv({ agentName, repoName, profileName, profileConfig, agentPath, containerInfo = {} }) {
    const envVars = getProfileEnvVars(agentName, repoName, profileName || getActiveProfile(), containerInfo);
    const manifest = readManifest(agentPath);
    const manifestEnv = buildEnvMap(manifest, profileConfig, { agentName, repoName });
    const profileEnv = normalizeProfileEnv(profileConfig?.env);
    const secrets = profileConfig?.secrets ? getSecrets(profileConfig.secrets) : {};
    const merged = createEnvWithSecrets({ ...envVars, ...profileEnv, ...manifestEnv }, secrets);
    // Host lifecycle hooks run as the owning agent, so they receive that agent's
    // own per-agent identity + signing secret (DS013), asserted LAST — never the
    // shared key, and never an override from profile/manifest/secret config.
    stripReservedAgentEnv(merged);
    try {
        Object.assign(merged, buildAgentIdentityEnv(deriveAgentPrincipalId(repoName, agentName)));
    } catch (_) { }
    return merged;
}

function getPreinstallRunKey(agentName, repoName, profileName) {
    return [
        sanitizeMarkerPart(repoName || 'unknown'),
        sanitizeMarkerPart(agentName),
        sanitizeMarkerPart(profileName || 'default')
    ].join(':');
}

export function hasPreinstallRunInProcess(agentName, repoName, profileName) {
    return preinstallRunKeys.has(getPreinstallRunKey(agentName, repoName, profileName));
}

export function markPreinstallRunInProcess(agentName, repoName, profileName) {
    preinstallRunKeys.add(getPreinstallRunKey(agentName, repoName, profileName));
}

export function resetPreinstallRunInProcess() {
    preinstallRunKeys.clear();
}

/**
 * Determine if a hook value is an inline command rather than a script path.
 * Inline commands typically contain shell operators or are clearly not file paths.
 * @param {string} hookValue - The hook value from manifest
 * @returns {boolean}
 */
export function isInlineCommand(hookValue) {
    if (!hookValue || typeof hookValue !== 'string') {
        return false;
    }
    // Contains shell operators (&&, ||, |, ;, >, <, etc.)
    if (/[&|;<>]/.test(hookValue)) {
        return true;
    }
    // Starts with a common command (not a path)
    const commonCommands = ['apt-get', 'apt', 'npm', 'yarn', 'pnpm', 'pip', 'pip3', 'python', 'node', 'echo', 'mkdir', 'cp', 'mv', 'rm', 'chmod', 'chown', 'curl', 'wget', 'git', 'apk', 'yum', 'dnf', 'pacman'];
    const firstWord = hookValue.trim().split(/\s+/)[0];
    if (commonCommands.includes(firstWord)) {
        return true;
    }
    // Contains spaces but doesn't look like a path (no .sh, .bash, etc.)
    if (hookValue.includes(' ') && !hookValue.match(/\.(sh|bash|zsh|fish)$/i)) {
        return true;
    }
    return false;
}



/**
 * Execute a hook script on the host.
 * Supports both script paths and inline commands.
 * @param {string} scriptPath - Path to the script or inline command
 * @param {object} env - Environment variables to pass
 * @param {object} options - Options
 * @returns {{ success: boolean, message: string, output?: string }}
 */
export function executeHostHook(scriptPath, env = {}, options = {}) {
    const { cwd = process.cwd(), timeout = 300000 } = options;

    if (!scriptPath) {
        return { success: true, message: 'No hook script specified' };
    }

    const hookEnv = {
        ...process.env,
        ...env,
        PLOINKY_HOOK_TYPE: 'host'
    };

    // Host hooks run on the HOST BEFORE the container exists, so the container-only
    // PLOINKY_WORKSPACE_ROOT injection (see agentServiceManager/bwrapServiceManager)
    // has not happened yet. Provide it here so host hooks can resolve the workspace
    // root the same way containers do. An explicit value (caller-provided env or an
    // operator-exported process env) always wins.
    if (!hookEnv.PLOINKY_WORKSPACE_ROOT) {
        hookEnv.PLOINKY_WORKSPACE_ROOT = cwd;
    }

    // Check if this is an inline command
    if (isInlineCommand(scriptPath)) {
        try {
            debugLog(`[hook] Executing inline host hook: ${scriptPath}`);
            execSync(scriptPath, {
                cwd,
                env: hookEnv,
                stdio: 'inherit',
                shell: true,
                timeout
            });
            return { success: true, message: 'Hook executed successfully', output: '' };
        } catch (err) {
            return {
                success: false,
                message: `Hook execution failed: ${err.message}`,
                output: ''
            };
        }
    }

    // Script path handling
    const resolvedPath = path.isAbsolute(scriptPath) ? scriptPath : path.join(cwd, scriptPath);

    if (!fs.existsSync(resolvedPath)) {
        return { success: false, message: `Hook script not found: ${resolvedPath}` };
    }

    // Make script executable
    try {
        fs.chmodSync(resolvedPath, '755');
    } catch (_) {}

    try {
        debugLog(`[hook] Executing host hook: ${resolvedPath}`);
        // Use inherit for stdout/stderr so hook output is visible to user
        execSync(resolvedPath, {
            cwd,
            env: hookEnv,
            stdio: 'inherit',
            timeout
        });

        return { success: true, message: 'Hook executed successfully', output: '' };
    } catch (err) {
        return {
            success: false,
            message: `Hook execution failed: ${err.message}`,
            output: ''
        };
    }
}

/**
 * Execute a hook script inside a container.
 * @param {string} containerName - The container name
 * @param {string} script - The script content or command
 * @param {object} env - Environment variables to pass
 * @param {object} options - Options
 * @returns {{ success: boolean, message: string, output?: string }}
 */
export function executeContainerHook(containerName, script, env = {}, options = {}) {
    const { timeout = 300000, workdir = '/code' } = options;

    if (!script) {
        return { success: true, message: 'No hook script specified' };
    }

    const envFlags = [];
    for (const [key, value] of Object.entries(env)) {
        envFlags.push('-e', `${key}=${String(value ?? '')}`);
    }

    try {
        const runtime = getRuntime();
        debugLog(`[hook] Executing container hook in ${containerName}: ${script}`);
        const result = spawnSync(runtime, [
            'exec',
            ...envFlags,
            '-w',
            workdir,
            containerName,
            'sh',
            '-c',
            script
        ], {
            encoding: 'utf8',
            stdio: 'pipe',
            timeout
        });

        if (result.status === 0) {
            return { success: true, message: 'Hook executed successfully', output: result.stdout };
        }

        const output = `${result.stdout || ''}${result.stderr || ''}`;
        const errorMessage = result.error ? result.error.message : `command exited with ${result.status}`;
        return {
            success: false,
            message: `Hook execution failed: ${errorMessage}`,
            output
        };
    } catch (err) {
        return {
            success: false,
            message: `Hook execution failed: ${err.message}`,
            output: err.output ? err.output.toString() : ''
        };
    }
}

/**
 * Run the complete profile lifecycle for an agent.
 * Uses merged profile configuration (default + active profile).
 *
 * Hook execution order:
 * 1. preinstall [HOST] - Runs BEFORE container creation (can set ploinky vars)
 * 2. hosthook_aftercreation [HOST] - Runs after container creation
 * 3. install [CONTAINER] - Main installation
 * 4. postinstall [CONTAINER] - Runs after install
 * 5. hosthook_postinstall [HOST] - Runs after container postinstall completes
 *
 * Full Lifecycle order:
 * 1. Workspace Structure Init [HOST]
 * 2. Symbolic Links Creation [HOST]
 * 3. preinstall [HOST] - Profile setup, can run `ploinky var` commands
 * 4. Container Creation (handled externally) - env vars read from .secrets
 * 5. hosthook_aftercreation [HOST]
 * 6. Container Start (handled externally)
 * 7. Core Dependencies Installation [CONTAINER] (conditional)
 * 8. Agent Dependencies Installation [CONTAINER] (conditional)
 * 9. install [CONTAINER]
 * 10. postinstall [CONTAINER]
 * 11. hosthook_postinstall [HOST]
 * 12. Agent Ready
 *
 * @param {string} agentName - The agent name
 * @param {string} profileName - The profile name
 * @param {object} options - Options
 * @returns {{ success: boolean, steps: object[], errors: string[] }}
 */
export function runProfileLifecycle(agentName, profileName, options = {}) {
    const {
        containerName,
        agentPath,
        repoName,
        manifest,
        skipContainer = false,
        skipInstallHooks = false,  // Skip steps 6-10 if install already ran in temp container
        verbose = false
    } = options;

    const steps = [];
    const errors = [];
    const log = verbose ? console.log : debugLog;

    // Get profile configuration
    const profileConfig = getProfileConfig(`${repoName}/${agentName}`, profileName) || {};

    const containerInfo = {
        containerName,
        containerId: containerName // We use container name as ID for simplicity
    };

    // Validate secrets
    if (profileConfig.secrets && profileConfig.secrets.length > 0) {
        const secretValidation = validateSecrets(profileConfig.secrets);
        if (!secretValidation.valid) {
            errors.push(formatMissingSecretsError(secretValidation.missing, profileName));
            return { success: false, steps, errors };
        }
    }

    // Get manifest env and secrets for hooks.
    const hookEnv = buildLifecycleHookEnv({
        agentName,
        repoName,
        profileName,
        profileConfig,
        agentPath,
        containerInfo,
    });

    // Step 1: Workspace Structure Init [HOST]
    log('[lifecycle] Step 1: Initializing workspace structure...');
    try {
        initWorkspaceStructure();
        steps.push({ step: 1, name: 'workspace_init', success: true });
    } catch (err) {
        steps.push({ step: 1, name: 'workspace_init', success: false, error: err.message });
        errors.push(`Workspace init failed: ${err.message}`);
    }

    // Step 2: Symbolic Links Creation [HOST]
    log('[lifecycle] Step 2: Creating symbolic links...');
    try {
        if (agentPath) {
            createAgentSymlinks(agentName, repoName, agentPath);
            createAgentWorkDir(agentName);
        }
        steps.push({ step: 2, name: 'symlinks', success: true });
    } catch (err) {
        steps.push({ step: 2, name: 'symlinks', success: false, error: err.message });
        errors.push(`Symlink creation failed: ${err.message}`);
    }

    // Step 3: preinstall [HOST] - Already ran in runPreContainerLifecycle BEFORE container creation
    // We just record that it was done (or skipped if not defined)
    if (profileConfig.preinstall) {
        steps.push({ step: 3, name: 'preinstall', success: true, message: 'Already executed before container creation' });
    }

    // Steps 4-6 are handled externally (container creation and start)
    if (skipContainer) {
        return { success: errors.length === 0, steps, errors };
    }

    // Step 5: hosthook_aftercreation [HOST]
    if (profileConfig.hosthook_aftercreation) {
        log('[lifecycle] Step 5: Running hosthook_aftercreation...');
        const hookPath = path.join(agentPath || '', profileConfig.hosthook_aftercreation);
        const result = executeHostHook(hookPath, hookEnv, { cwd: agentPath });
        steps.push({ step: 5, name: 'hosthook_aftercreation', success: result.success, output: result.output });
        if (!result.success) {
            errors.push(`hosthook_aftercreation failed: ${result.message}`);
        }
    }

    // Container should be started by caller before calling post-start hooks

    // Steps 7-10: Install hooks (skip if already ran in temp container before main container start)
    if (!skipInstallHooks) {
        steps.push({
            step: 7,
            name: 'dependencies',
            success: true,
            message: 'Prepared dependency cache is managed before runtime start'
        });

        // Step 9: install [CONTAINER]
        if (profileConfig.install && containerName) {
            console.log(`[install] ${agentName}: ${profileConfig.install}`);
            const result = executeContainerHook(containerName, profileConfig.install, hookEnv);
            if (result.output) {
                console.log(result.output.trim());
            }
            steps.push({ step: 9, name: 'install', success: result.success, output: result.output });
            if (!result.success) {
                errors.push(`install hook failed: ${result.message}`);
            }
        }

        // Step 10: postinstall [CONTAINER]
        if (profileConfig.postinstall && containerName) {
            log('[lifecycle] Step 10: Running postinstall hook...');
            const result = executeContainerHook(containerName, profileConfig.postinstall, hookEnv);
            steps.push({ step: 10, name: 'postinstall', success: result.success, output: result.output });
            if (!result.success) {
                errors.push(`postinstall hook failed: ${result.message}`);
            }
        }
    } else {
        log('[lifecycle] Steps 7-9: Skipped (install already ran in temp container)');
        steps.push({ step: 7, name: 'dependencies', success: true, skipped: true });
        steps.push({ step: 9, name: 'install', success: true, skipped: true });

        // Step 10: postinstall [CONTAINER] - runs AFTER main container is up, not in temp container
        if (profileConfig.postinstall && containerName) {
            console.log(`[postinstall] ${agentName}: ${profileConfig.postinstall}`);
            const result = executeContainerHook(containerName, profileConfig.postinstall, hookEnv);
            if (result.output) {
                console.log(result.output.trim());
            }
            steps.push({ step: 10, name: 'postinstall', success: result.success, output: result.output });
            if (!result.success) {
                errors.push(`postinstall hook failed: ${result.message}`);
            }
        }
    }

    // Step 11: hosthook_postinstall [HOST]
    if (profileConfig.hosthook_postinstall) {
        console.log(`[hosthook_postinstall] Running for profile '${profileName}'...`);
        const hookPath = path.join(agentPath || '', profileConfig.hosthook_postinstall);
        console.log(`[hosthook_postinstall] Hook path: ${hookPath}`);
        const result = executeHostHook(hookPath, hookEnv, { cwd: agentPath });
        steps.push({ step: 11, name: 'hosthook_postinstall', success: result.success, output: result.output });
        if (result.output) {
            console.log(result.output.trim());
        }
        if (!result.success) {
            console.log(`[hosthook_postinstall] Warning: ${result.message}`);
            errors.push(`hosthook_postinstall failed: ${result.message}`);
        } else {
            console.log(`[hosthook_postinstall] Completed successfully`);
        }
    }

    // Step 12: Agent Ready
    steps.push({ step: 12, name: 'agent_ready', success: errors.length === 0 });

    return {
        success: errors.length === 0,
        steps,
        errors
    };
}

/**
 * Run only the pre-container steps of the lifecycle.
 * Steps: workspace init, symlinks, preinstall [HOST]
 * 
 * The preinstall hook runs on the HOST before container creation,
 * allowing it to set ploinky vars that will be available when the container is created.
 * 
 * @param {string} agentName - The agent name
 * @param {string} repoName - The repository name
 * @param {string} agentPath - Path to the agent directory
 * @param {string} profileName - The profile name (optional, defaults to active profile)
 * @returns {{ success: boolean, errors: string[] }}
 */
export function runPreContainerLifecycle(agentName, repoName, agentPath, profileName) {
    const errors = [];

    try {
        initWorkspaceStructure();
    } catch (err) {
        errors.push(`Workspace init failed: ${err.message}`);
    }

    try {
        createAgentSymlinks(agentName, repoName, agentPath);
        createAgentWorkDir(agentName);
    } catch (err) {
        errors.push(`Symlink creation failed: ${err.message}`);
    }

    // Run preinstall [HOST] hook - this runs BEFORE container creation.
    // Keep de-duplication in-process only. Persistent markers go stale across
    // destroy/start and can suppress hooks that regenerate required runtime
    // files, such as WebMeet's LiveKit configs.
    try {
        const profileConfig = getProfileConfig(`${repoName}/${agentName}`, profileName) || {};
        if (profileConfig.preinstall) {
            if (hasPreinstallRunInProcess(agentName, repoName, profileName)) {
                debugLog(`[lifecycle] Skipping preinstall [HOST] for ${agentName} (already run)`);
            } else {
                // For inline commands, pass as-is; for script paths, join with agentPath
                const hookValue = isInlineCommand(profileConfig.preinstall)
                    ? profileConfig.preinstall
                    : path.join(agentPath || '', profileConfig.preinstall);
                
                // Build environment for the hook.
                const hookEnv = buildLifecycleHookEnv({
                    agentName,
                    repoName,
                    profileName,
                    profileConfig,
                    agentPath,
                });
                
                debugLog(`[lifecycle] Running preinstall [HOST]: ${hookValue}`);
                const result = executeHostHook(hookValue, hookEnv, { cwd: PLOINKY_WORKSPACE_ROOT });
                if (!result.success) {
                    errors.push(`preinstall hook failed: ${result.message}`);
                } else {
                    markPreinstallRunInProcess(agentName, repoName, profileName);
                }
            }
        }
    } catch (err) {
        errors.push(`preinstall hook error: ${err.message}`);
    }

    return {
        success: errors.length === 0,
        errors
    };
}

/**
 * Run only the post-container-start steps of the lifecycle.
 * Steps: dependencies, install, postinstall, hosthook_postinstall
 * 
 * Note: preinstall now runs on HOST before container creation (see runPreContainerLifecycle)
 * 
 * @param {string} containerName - The container name
 * @param {string} agentName - The agent name
 * @param {string} profileName - The profile name
 * @param {object} options - Options
 * @returns {{ success: boolean, errors: string[] }}
 */
export function runPostStartLifecycle(containerName, agentName, profileName, options = {}) {
    const { repoName, agentPath, verbose = false } = options;
    const errors = [];
    const log = verbose ? console.log : debugLog;

    // Get profile configuration
    const profileConfig = getProfileConfig(`${repoName}/${agentName}`, profileName) || {};

    // Validate secrets
    if (profileConfig.secrets && profileConfig.secrets.length > 0) {
        const secretValidation = validateSecrets(profileConfig.secrets);
        if (!secretValidation.valid) {
            errors.push(formatMissingSecretsError(secretValidation.missing, profileName));
            return { success: false, errors };
        }
    }

    const hookEnv = buildLifecycleHookEnv({
        agentName,
        repoName,
        profileName,
        profileConfig,
        agentPath,
        containerInfo: { containerName },
    });

    log('[lifecycle] Dependency installation is handled by the prepared cache before runtime start.');

    // Container hooks (preinstall is a HOST hook, not a container hook)
    const hooks = ['install', 'postinstall'];
    for (const hookName of hooks) {
        if (profileConfig[hookName]) {
            log(`[lifecycle] Running ${hookName}...`);
            const result = executeContainerHook(containerName, profileConfig[hookName], hookEnv);
            if (!result.success) {
                errors.push(`${hookName}: ${result.message}`);
            }
        }
    }

    // Host postinstall hook
    if (profileConfig.hosthook_postinstall && agentPath) {
        log('[lifecycle] Running hosthook_postinstall...');
        const hookPath = path.join(agentPath, profileConfig.hosthook_postinstall);
        const result = executeHostHook(hookPath, hookEnv, { cwd: agentPath });
        if (!result.success) {
            errors.push(`hosthook_postinstall: ${result.message}`);
        }
    }

    return {
        success: errors.length === 0,
        errors
    };
}

/**
 * Print lifecycle summary.
 * @param {{ success: boolean, steps: object[], errors: string[] }} result - Lifecycle result
 */
export function printLifecycleSummary(result) {
    console.log('');
    console.log('Lifecycle Summary:');
    console.log('------------------');

    for (const step of result.steps) {
        const status = step.success ? '✓' : '✗';
        const name = step.name.replace(/_/g, ' ');
        console.log(`  ${status} Step ${step.step}: ${name}`);
        if (step.error) {
            console.log(`      Error: ${step.error}`);
        }
    }

    console.log('');
    if (result.success) {
        console.log('All lifecycle steps completed successfully.');
    } else {
        console.log('Lifecycle completed with errors:');
        for (const error of result.errors) {
            console.log(`  - ${error}`);
        }
    }
}
