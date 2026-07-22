import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { buildEngineProcessEnvironment } from '../process.mjs';

function signalExitCode(signal) {
    const number = os.constants.signals[signal];
    return Number.isInteger(number) ? 128 + number : 1;
}

export function buildContainerExecArgs(containerId, commandArgv, {
    interactive = false,
    inputIsTty = false,
    outputIsTty = false,
    shell = false,
} = {}) {
    const args = ['container', 'exec'];
    if (interactive && inputIsTty && outputIsTty) {
        args.push('--interactive', '--tty');
    }
    args.push(
        '--user', 'podman',
        '--workdir', '/workspace',
        containerId,
        shell ? '/bin/bash' : '/opt/ploinky/bin/ploinky-local',
        ...commandArgv,
    );
    return args;
}

export function executeProcess(command, args, {
    env = buildEngineProcessEnvironment(),
    spawnSyncImpl = spawnSync,
} = {}) {
    const result = spawnSyncImpl(command, args, {
        stdio: 'inherit',
        env,
    });
    if (Number.isInteger(result.status)) return result.status;
    if (result.signal) return signalExitCode(result.signal);
    return 1;
}
