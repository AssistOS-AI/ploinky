import { spawnSync } from 'node:child_process';

import { PloinkyBoxError } from './errors.mjs';

const ENGINE_ENV_ALLOWLIST = Object.freeze([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'DBUS_SESSION_BUS_ADDRESS',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'TERM',
]);

export function buildEngineProcessEnvironment(env = process.env) {
    return Object.fromEntries(ENGINE_ENV_ALLOWLIST
        .filter((name) => env[name] !== undefined)
        .map((name) => [name, String(env[name])]));
}

export function runProcess(command, args, {
    cwd,
    encoding = 'buffer',
    env,
} = {}) {
    if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
        throw new TypeError('Process arguments must be an array of strings');
    }

    const result = spawnSync(command, args, {
        cwd,
        encoding: encoding === 'buffer' ? null : encoding,
        env,
        maxBuffer: 16 * 1024 * 1024,
    });

    if (result.error) {
        throw new PloinkyBoxError(`Unable to execute ${command}`, {
            code: 'PLOINKY_BOX_PROCESS_START_FAILED',
            cause: result.error,
        });
    }
    if (result.status !== 0) {
        const stderr = Buffer.isBuffer(result.stderr)
            ? result.stderr.toString('utf8')
            : String(result.stderr ?? '');
        throw new PloinkyBoxError(
            `${command} exited with status ${result.status}${stderr ? `: ${stderr.trim()}` : ''}`,
            { code: 'PLOINKY_BOX_PROCESS_FAILED' },
        );
    }

    return result.stdout;
}

export function queryProcess(command, args, {
    cwd,
    env,
    input,
    timeoutMs = 10_000,
} = {}) {
    if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
        throw new TypeError('Process arguments must be an array of strings');
    }
    const result = spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        env,
        input,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
    });
    return {
        ok: result.status === 0 && !result.error,
        status: Number.isInteger(result.status) ? result.status : 1,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error || null,
        signal: result.signal || null,
    };
}

export function createProcessRunner(options = {}) {
    return {
        query(command, args, queryOptions = {}) {
            return queryProcess(command, args, {
                ...options,
                ...queryOptions,
            });
        },
        run(command, args, runOptions = {}) {
            return runProcess(command, args, {
                ...options,
                ...runOptions,
            });
        },
    };
}
