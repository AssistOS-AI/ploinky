import { spawnSync } from 'child_process';
import { flagsToArgs, waitForContainerRunning } from './common.js';
import {
    inspectExactPodmanRuntimeIdentity,
    requireExactPodmanRuntimeIdentity,
} from './exactPodmanRuntime.js';

const DEFAULT_AGENT_ENTRY = 'sh /Agent/server/AgentServer.sh';

function readManifestStartCommand(manifest) {
    if (!manifest) return '';
    const value = manifest.start;
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return trimmed;
}

function readManifestAgentCommand(manifest) {
    if (!manifest) return { raw: '', resolved: DEFAULT_AGENT_ENTRY };
    const rawValue = ((manifest.agent && String(manifest.agent)) || (manifest.commands && manifest.commands.run) || '').trim();
    return {
        raw: rawValue,
        resolved: rawValue || DEFAULT_AGENT_ENTRY
    };
}

function splitCommandArgs(command) {
    const trimmed = typeof command === 'string' ? command.trim() : '';
    if (!trimmed) return [];
    return flagsToArgs([trimmed]);
}

function launchAgentSidecar({
    containerName,
    containerId,
    runtime,
    runtimeIdentity,
    agentCommand,
    agentName,
    waitForContainerRunningImpl = waitForContainerRunning,
    inspectRuntimeIdentity = inspectExactPodmanRuntimeIdentity,
    spawnSyncImpl = spawnSync,
}) {
    const command = (agentCommand || '').trim();
    if (!command) return;
    const identity = requireExactPodmanRuntimeIdentity({
        runtime,
        containerName,
        containerId,
        instanceId: runtimeIdentity?.instanceId,
        enableGeneration: runtimeIdentity?.enableGeneration,
    });
    inspectRuntimeIdentity(identity);
    if (!waitForContainerRunningImpl(identity.containerId, 40, 250, { runtime: 'podman' })) {
        throw new Error(`[start] ${agentName || containerName}: container not running; cannot launch agent command.`);
    }
    // Manifest agent entries are shell commands in every execution mode. Keep
    // that contract for start+agent containers as well: direct argv splitting
    // turns operators such as `&&` into inert arguments and can silently exit
    // before the AgentServer process is launched.
    const execArgs = buildAgentSidecarExecArgs(identity.containerId, command);
    const execRes = spawnSyncImpl('podman', execArgs, { stdio: 'inherit' });
    if (execRes.status !== 0) {
        throw new Error(`[start] ${agentName || containerName}: failed to launch start command (exit ${execRes.status}).`);
    }
    console.log(`[start] ${agentName || containerName}: agent command launched.`);
}

function buildAgentSidecarExecArgs(containerId, command) {
    const normalizedContainer = String(containerId || '');
    const normalizedCommand = String(command || '').trim();
    if (!/^[a-f0-9]{64}$/.test(normalizedContainer) || !normalizedCommand) return [];
    return ['exec', '-d', normalizedContainer, 'sh', '-lc', normalizedCommand];
}

function normalizeLifecycleCommands(entry) {
    if (Array.isArray(entry)) {
        return entry
            .filter((cmd) => typeof cmd === 'string')
            .map((cmd) => cmd.trim())
            .filter(Boolean);
    }
    if (typeof entry === 'string') {
        const trimmed = entry.trim();
        return trimmed ? [trimmed] : [];
    }
    return [];
}

export {
    DEFAULT_AGENT_ENTRY,
    buildAgentSidecarExecArgs,
    launchAgentSidecar,
    normalizeLifecycleCommands,
    readManifestAgentCommand,
    readManifestStartCommand,
    splitCommandArgs
};
