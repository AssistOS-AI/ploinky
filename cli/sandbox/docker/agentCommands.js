import { spawnSync } from 'child_process';
import { flagsToArgs, getRuntime, waitForContainerRunning } from './common.js';
import { buildAgentShellArgs } from './agentShell.js';

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

function launchAgentSidecar({ containerName, agentCommand, agentName }) {
    const command = (agentCommand || '').trim();
    if (!command) return;
    if (!waitForContainerRunning(containerName, 40, 250)) {
        throw new Error(`[start] ${agentName || containerName}: container not running; cannot launch agent command.`);
    }
    const runtime = getRuntime();
    // Manifest agent entries are shell commands in every execution mode. Keep
    // that contract for start+agent containers as well: direct argv splitting
    // turns operators such as `&&` into inert arguments and can silently exit
    // before the AgentServer process is launched.
    const execArgs = buildAgentSidecarExecArgs(containerName, command);
    const execRes = spawnSync(runtime, execArgs, { stdio: 'inherit' });
    if (execRes.status !== 0) {
        throw new Error(`[start] ${agentName || containerName}: failed to launch start command (exit ${execRes.status}).`);
    }
    console.log(`[start] ${agentName || containerName}: agent command launched.`);
}

function buildAgentSidecarExecArgs(containerName, command) {
    const normalizedContainer = String(containerName || '').trim();
    const normalizedCommand = String(command || '').trim();
    if (!normalizedContainer || !normalizedCommand) return [];
    return ['exec', '-d', normalizedContainer, ...buildAgentShellArgs(normalizedCommand)];
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
