import { spawnSync } from 'child_process';
import { flagsToArgs, getRuntime, waitForContainerRunning } from './common.js';

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
    const startArgs = splitCommandArgs(command);
    if (!startArgs.length) return;
    if (!waitForContainerRunning(containerName, 40, 250)) {
        throw new Error(`[start] ${agentName || containerName}: container not running; cannot launch agent command.`);
    }
    const runtime = getRuntime();
    const execArgs = ['exec', '-d', containerName, ...startArgs];
    const execRes = spawnSync(runtime, execArgs, { stdio: 'inherit' });
    if (execRes.status !== 0) {
        throw new Error(`[start] ${agentName || containerName}: failed to launch start command (exit ${execRes.status}).`);
    }
    console.log(`[start] ${agentName || containerName}: start command launched directly.`);
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
    launchAgentSidecar,
    normalizeLifecycleCommands,
    readManifestAgentCommand,
    readManifestStartCommand,
    splitCommandArgs
};
