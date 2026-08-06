import { spawnSync } from 'node:child_process';

import { PloinkyBoxError } from '../errors.mjs';

const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/;

function executeError(message, code = 'PLOINKY_BOX_HOST_CONTROL_UNSUPPORTED') {
    return new PloinkyBoxError(message, { code });
}

function exactContainerId(value) {
    const id = String(value || '');
    if (!FULL_CONTAINER_ID.test(id)) {
        throw executeError(
            'Outer Box control requires the full 64-hex journal-owned container ID',
            'PLOINKY_BOX_HOST_CONTROL_INVALID',
        );
    }
    return id;
}

/**
 * Execute a bounded, non-interactive command through the source-closed libpod
 * exec session transport. The outer controller deliberately has no ordinary
 * remote Podman CLI fallback.
 */
export async function executeBoxCommand({
    hostClient,
    containerId,
    journal,
    argv,
    hostPort = null,
    user = 'podman',
    workdir = '/workspace',
    env = {},
    input = null,
    timeoutMs = 1_800_000,
    maxOutputBytes = 16 * 1024 * 1024,
    stdout = null,
    stderr = null,
    interactive = false,
    shell = false,
} = {}) {
    if (!hostClient || typeof hostClient.execContainer !== 'function') {
        throw executeError('The structured Podman host client is unavailable');
    }
    if (!Array.isArray(argv) || argv.some((entry) => typeof entry !== 'string')) {
        throw executeError(
            'Outer Box command arguments must be one exact string array',
            'PLOINKY_BOX_HOST_CONTROL_INVALID',
        );
    }
    if (interactive || shell) {
        throw executeError(
            'Interactive outer Box sessions require a source-closed streaming TTY protocol; no host CLI fallback is permitted',
        );
    }
    const selectedEnv = {
        ...env,
        ...(hostPort === null ? {} : { PLOINKY_ROUTER_HOST_PORT: String(hostPort) }),
    };
    const result = await hostClient.execContainer({
        id: exactContainerId(containerId),
        argv,
        user,
        workdir,
        env: selectedEnv,
        input,
        timeoutMs,
        maxOutputBytes,
        journal,
    });
    if (result.stdout) stdout?.write?.(result.stdout);
    if (result.stderr) stderr?.write?.(result.stderr);
    return result;
}

// Kept for local/in-Box forwarding only. Production outer host control uses
// executeBoxCommand above and never invokes a container engine CLI.
export function executeProcess(command, args, {
    env = process.env,
    stdio = 'inherit',
} = {}) {
    const result = spawnSync(command, args, { stdio, env });
    if (result.error) throw result.error;
    return result.status ?? 1;
}
