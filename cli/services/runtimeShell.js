import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { isPloinkyBoxRuntime } from './docker/common.js';
import * as inputState from './inputState.js';
import { formatOuterRuntimeBanner } from './layerIdentification.js';

const MANAGED_ERROR =
    "cli: parameterless 'cli' requires the managed Ploinky runtime. "
    + "Run it through the host 'ploinky cli' command.";
const TTY_ERROR = "cli: parameterless 'cli' requires an interactive terminal.";

export function validateOuterRuntimeShell({
    markerPath = '/etc/ploinky-box',
    stdin = process.stdin,
    stdout = process.stdout,
    isManagedRuntimeImpl = isPloinkyBoxRuntime,
} = {}) {
    if (!isManagedRuntimeImpl(markerPath)) throw new Error(MANAGED_ERROR);
    if (!stdin.isTTY || !stdout.isTTY) throw new Error(TTY_ERROR);
}

export function runOuterRuntimeShell({
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    markerPath = '/etc/ploinky-box',
    spawnSyncImpl = spawnSync,
    prepareForExternalCommandImpl = inputState.prepareForExternalCommand,
    isManagedRuntimeImpl = isPloinkyBoxRuntime,
    runtimeName = env.PLOINKY_RUNTIME_NAME || os.hostname(),
    user = os.userInfo().username,
    log = console.log,
} = {}) {
    validateOuterRuntimeShell({ markerPath, stdin, stdout, isManagedRuntimeImpl });
    for (const line of formatOuterRuntimeBanner({ runtimeName, user })) log(line);
    const restore = prepareForExternalCommandImpl({ promptOnRestore: false })
        || (() => {});
    try {
        const result = spawnSyncImpl('/bin/bash', [], {
            cwd: '/workspace',
            stdio: 'inherit',
            env,
        });
        if (result.error) throw result.error;
        if (typeof result.status === 'number') return result.status;
        if (result.signal) return 128 + (os.constants.signals[result.signal] ?? 15);
        return 1;
    } finally {
        restore();
    }
}
