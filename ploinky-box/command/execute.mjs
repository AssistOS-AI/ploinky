import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { PloinkyBoxError } from '../errors.mjs';

const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/;
const SAFE_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const DEFAULT_DETACH_KEYS = 'ctrl-p,ctrl-q';

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

function exactCommandArguments(argv, { shell }) {
    if (!Array.isArray(argv) || argv.some((entry) => (
        typeof entry !== 'string' || entry.includes('\0')
    ))) {
        throw executeError(
            'Outer Box command arguments must be one exact NUL-free string array',
            'PLOINKY_BOX_HOST_CONTROL_INVALID',
        );
    }
    return shell ? ['/bin/bash', '-i'] : [...argv];
}

function exactExecutionIdentity(user, workdir) {
    if (!SAFE_USER.test(String(user || '')) || user === 'root') {
        throw executeError(
            'Outer Box execution requires one explicit non-root user',
            'PLOINKY_BOX_HOST_CONTROL_INVALID',
        );
    }
    if (typeof workdir !== 'string'
        || !path.posix.isAbsolute(workdir)
        || path.posix.normalize(workdir) !== workdir) {
        throw executeError(
            'Outer Box execution requires one canonical absolute working directory',
            'PLOINKY_BOX_HOST_CONTROL_INVALID',
        );
    }
}

function exactEnvironment(env) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
        throw executeError(
            'Outer Box execution environment must be an exact string map',
            'PLOINKY_BOX_HOST_CONTROL_INVALID',
        );
    }
    const selected = {};
    for (const [key, value] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
            || typeof value !== 'string'
            || key.includes('\0')
            || value.includes('\0')) {
            throw executeError(
                'Outer Box execution environment must be an exact NUL-free string map',
                'PLOINKY_BOX_HOST_CONTROL_INVALID',
            );
        }
        selected[key] = value;
    }
    return selected;
}

function positiveBoundedInteger(value, label, maximum) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw executeError(
            `Outer Box ${label} must be an integer in range 1..${maximum}`,
            'PLOINKY_BOX_HOST_CONTROL_INVALID',
        );
    }
    return value;
}

function exactInteractiveResult(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)
        || !Number.isSafeInteger(result.exitCode)
        || result.exitCode < 0 || result.exitCode > 255
        || typeof result.detached !== 'boolean') {
        throw executeError(
            'Podman interactive exec returned an invalid settlement',
            'PLOINKY_BOX_HOST_CONTROL_INVALID',
        );
    }
    return Object.freeze({
        exitCode: result.exitCode,
        detached: result.detached,
    });
}

/** Execute through a bounded source-closed libpod exec session transport. */
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
    stdin = null,
    interactive = false,
    shell = false,
    tty = interactive,
    rows = null,
    columns = null,
    detachKeys = DEFAULT_DETACH_KEYS,
    signal = null,
    inactivityTimeoutMs = 300_000,
    onSession = null,
} = {}) {
    if (!hostClient || typeof hostClient !== 'object') {
        throw executeError('The structured Podman host client is unavailable');
    }
    const selectedArgv = exactCommandArguments(argv, { shell });
    exactExecutionIdentity(user, workdir);
    const selectedBaseEnv = exactEnvironment(env);
    const selectedEnv = {
        ...selectedBaseEnv,
        ...(hostPort === null ? {} : { PLOINKY_ROUTER_HOST_PORT: String(hostPort) }),
    };
    if (interactive || shell || tty) {
        if (typeof hostClient.execContainerInteractive !== 'function') {
            throw executeError(
                'The structured Podman interactive exec transport is unavailable; no host CLI fallback is permitted',
            );
        }
        if (!interactive || tty !== true
            || !stdin || !stdout || !stderr
            || typeof stdout.write !== 'function'
            || typeof stderr.write !== 'function') {
            throw executeError(
                'Interactive outer Box execution requires exact TTY stdin, stdout, and stderr streams',
                'PLOINKY_BOX_HOST_CONTROL_INVALID',
            );
        }
        if (signal !== null && (typeof signal !== 'object'
            || typeof signal.addEventListener !== 'function')) {
            throw executeError(
                'Interactive outer Box cancellation requires an AbortSignal',
                'PLOINKY_BOX_HOST_CONTROL_INVALID',
            );
        }
        if (onSession !== null && typeof onSession !== 'function') {
            throw executeError(
                'Interactive outer Box session observer must be a function',
                'PLOINKY_BOX_HOST_CONTROL_INVALID',
            );
        }
        const result = await hostClient.execContainerInteractive({
            id: exactContainerId(containerId),
            argv: selectedArgv,
            user,
            workdir,
            env: selectedEnv,
            journal,
            tty: true,
            detachKeys,
            rows: positiveBoundedInteger(rows, 'terminal row count', 65_535),
            columns: positiveBoundedInteger(columns, 'terminal column count', 65_535),
            stdin,
            stdout,
            stderr,
            signal,
            timeoutMs: positiveBoundedInteger(timeoutMs, 'overall timeout', 1_800_000),
            inactivityTimeoutMs: positiveBoundedInteger(
                inactivityTimeoutMs,
                'inactivity timeout',
                3_600_000,
            ),
            maxOutputBytes: positiveBoundedInteger(
                maxOutputBytes,
                'output limit',
                512 * 1024 * 1024,
            ),
            onSession,
        });
        return exactInteractiveResult(result);
    }
    if (typeof hostClient.execContainer !== 'function') {
        throw executeError('The structured Podman host client is unavailable');
    }
    const result = await hostClient.execContainer({
        id: exactContainerId(containerId),
        argv: selectedArgv,
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
