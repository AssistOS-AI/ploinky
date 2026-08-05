import { spawnSync } from 'child_process';
import fs from 'fs';
import { normalizeLifecycleCommands } from './agentCommands.js';
import { waitForContainerRunning, isContainerRunning } from './common.js';
import {
    inspectExactPodmanRuntimeIdentity,
    requireExactPodmanRuntimeIdentity,
} from './exactPodmanRuntime.js';
import { SHARED_DIR } from '../../utils/config.js';


function ensureSharedHostDir() {
    const dir = SHARED_DIR;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return dir;
}

function runPostinstallHook(agentName, containerName, manifest, cwd, options = {}) {
    // Read postinstall from profiles.default
    const postinstallCmd = manifest?.profiles?.default?.postinstall;
    const commands = normalizeLifecycleCommands(postinstallCmd);
    if (!commands.length) return;
    const identity = requireExactPodmanRuntimeIdentity({
        runtime: options.runtime,
        containerName,
        containerId: options.containerId,
        instanceId: options.runtimeIdentity?.instanceId,
        enableGeneration: options.runtimeIdentity?.enableGeneration,
    });
    const inspectRuntimeIdentity = options.inspectRuntimeIdentity || inspectExactPodmanRuntimeIdentity;
    const waitForRunning = options.waitForContainerRunningImpl || waitForContainerRunning;
    const checkRunning = options.isContainerRunningImpl || isContainerRunning;
    const spawn = options.spawnSyncImpl || spawnSync;
    inspectRuntimeIdentity(identity);

    if (!waitForRunning(identity.containerId, 40, 250, { runtime: 'podman' })) {
        console.warn(`[postinstall] ${agentName}: container not running; skipping postinstall commands. Container may have exited immediately.`);
        return;
    }

    for (const cmd of commands) {
        // Check if container is still running before each command
        if (!checkRunning(identity.containerId, { runtime: 'podman' })) {
            console.warn(`[postinstall] ${agentName}: container exited before postinstall could complete. The agent may have crashed or exited. Skipping remaining postinstall commands.`);
            return;
        }
        console.log(`[postinstall] ${agentName}: cd '${cwd}' && ${cmd}`);
        const res = spawn('podman', ['exec', identity.containerId, 'sh', '-lc', `cd '${cwd}' && ${cmd}`], { stdio: 'inherit' });
        if (res.status !== 0) {
            // If exec failed because container exited, warn instead of failing
            if (!checkRunning(identity.containerId, { runtime: 'podman' })) {
                console.warn(`[postinstall] ${agentName}: container exited during postinstall. The agent may need configuration or has dependencies issues.`);
                return;
            }
            throw new Error(`[postinstall] ${agentName}: command exited with ${res.status}`);
        }
    }

    // Only restart if the container is not already running
    // The postinstall commands may have caused the container to become unstable
    if (!checkRunning(identity.containerId, { runtime: 'podman' })) {
        console.log(`[postinstall] ${agentName}: restarting container ${containerName}`);
        const restartRes = spawn('podman', ['restart', identity.containerId], { stdio: 'inherit' });
        if (restartRes.status !== 0) {
            // If restart fails, just warn - the container may have issues
            console.warn(`[postinstall] ${agentName}: restart failed with code ${restartRes.status}, container may need manual intervention`);
            return;
        }

        if (!waitForRunning(identity.containerId, 40, 250, { runtime: 'podman' })) {
            console.warn(`[postinstall] ${agentName}: container did not reach running state after restart.`);
            return;
        }
    } else {
        console.log(`[postinstall] ${agentName}: container ${containerName} is already running, skipping restart`);
    }
}

export {
    ensureSharedHostDir,
    runPostinstallHook
};
