import { spawnSync } from 'node:child_process';

import { sanitizeGitDiagnostic } from '../gitCommand.js';

// Bounded, noninteractive Git execution for update transactions. Every
// command runs as `git -C <checkout> ...` with a closed stdin, a timeout and a
// scrubbed environment, and its output is captured rather than inherited so a
// caller can classify the result from structured evidence.

export const DEFAULT_LOCAL_TIMEOUT_MS = 60_000;
export const DEFAULT_NETWORK_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const SCRUBBED_GIT_ENV = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_PREFIX',
];

/**
 * Environment for a Git child. Repository-selection variables inherited from
 * a hook or wrapper are removed so `-C <checkout>` alone selects the target.
 * Credential prompts are disabled; a batch-mode SSH command is added only when
 * neither the environment nor the repository already selects an SSH command,
 * because `GIT_SSH_COMMAND` would override a configured `core.sshCommand`.
 */
export function buildGitEnvironment(baseEnv = process.env, { sshConfigured = false } = {}) {
    const env = { ...baseEnv };
    for (const name of SCRUBBED_GIT_ENV) delete env[name];
    env.GIT_TERMINAL_PROMPT = '0';
    if (!sshConfigured && !env.GIT_SSH_COMMAND && !env.GIT_SSH) {
        env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
    }
    return env;
}

/**
 * Run one Git command. Never throws for a nonzero exit; the caller decides.
 *
 * @returns {{ ok: boolean, status: number|null, signal: string|null,
 *   stdout: string, stderr: string, error: string, timedOut: boolean, argv: string[] }}
 */
export function runGit(repoPath, args, {
    env = process.env,
    timeoutMs = DEFAULT_LOCAL_TIMEOUT_MS,
    maxBuffer = DEFAULT_MAX_BUFFER,
    sshConfigured = false,
    spawn = spawnSync,
} = {}) {
    const argv = ['-C', repoPath, ...args];
    const result = spawn('git', argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildGitEnvironment(env, { sshConfigured }),
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer,
        encoding: 'utf8',
    }) || {};
    const timedOut = result.error?.code === 'ETIMEDOUT';
    return {
        ok: !result.error && result.status === 0,
        status: typeof result.status === 'number' ? result.status : null,
        signal: result.signal || null,
        stdout: String(result.stdout || ''),
        stderr: sanitizeGitDiagnostic(String(result.stderr || '')).trim(),
        error: result.error ? sanitizeGitDiagnostic(result.error.message) : '',
        timedOut,
        argv,
    };
}

export function describeGitFailure(result) {
    const command = sanitizeGitDiagnostic(['git', ...(result?.argv || [])].join(' '));
    let reason;
    if (result?.timedOut) reason = 'timed out';
    else if (result?.error) reason = result.error;
    else if (result?.signal) reason = `terminated by ${result.signal}`;
    else reason = `exited with status ${result?.status}`;
    const detail = result?.stderr ? `\n${result.stderr.slice(-4000)}` : '';
    return `${command}: ${reason}${detail}`;
}
