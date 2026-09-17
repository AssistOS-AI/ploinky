import { assertWebttyWorkspaceRoot } from './cwd.mjs';

export const WEBTTY_SHELL_PROMPT = '$PWD $ ';

const FIXED_BASE_ENVIRONMENT = Object.freeze({
    HOME: '/home/podman',
    USER: 'podman',
    LOGNAME: 'podman',
    PATH: '/opt/ploinky/bin:/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
});

const FIXED_SHELL_ENVIRONMENT = Object.freeze({
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    PS1: WEBTTY_SHELL_PROMPT,
});

const WORKSPACE_ROOT_KEY = 'PLOINKY_WORKSPACE_ROOT';

export const WORKER_ENVIRONMENT_KEYS = Object.freeze(
    [...Object.keys(FIXED_BASE_ENVIRONMENT), WORKSPACE_ROOT_KEY].sort(),
);
export const SHELL_ENVIRONMENT_KEYS = Object.freeze(
    [...WORKER_ENVIRONMENT_KEYS, ...Object.keys(FIXED_SHELL_ENVIRONMENT)].sort(),
);

function copyFrozen(environment) {
    return Object.freeze(Object.fromEntries(Object.entries(environment)));
}

// The only dynamic value is the explicit trusted workspace root. It is never
// read from the inherited environment.
function workerEnvironment(workspaceRoot) {
    return { ...FIXED_BASE_ENVIRONMENT, [WORKSPACE_ROOT_KEY]: assertWebttyWorkspaceRoot(workspaceRoot) };
}

function shellEnvironment(workspaceRoot) {
    return { ...workerEnvironment(workspaceRoot), ...FIXED_SHELL_ENVIRONMENT };
}

// The first argument is accepted so callers can make the scrubbing boundary
// explicit. No inherited value is copied: Router carries workspace secrets.
export function buildWorkerEnvironment(_inheritedEnvironment = process.env, { workspaceRoot } = {}) {
    return copyFrozen(workerEnvironment(workspaceRoot));
}

export function buildShellEnvironment(_inheritedEnvironment = process.env, { workspaceRoot } = {}) {
    return copyFrozen(shellEnvironment(workspaceRoot));
}

export function assertExactShellEnvironment(environment, { workspaceRoot } = {}) {
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
        throw environmentError();
    }
    let expectedEnvironment;
    try {
        expectedEnvironment = shellEnvironment(workspaceRoot);
    } catch (_) {
        throw environmentError();
    }
    const keys = Object.keys(environment).sort();
    if (keys.length !== SHELL_ENVIRONMENT_KEYS.length
        || keys.some((key, index) => key !== SHELL_ENVIRONMENT_KEYS[index])) {
        throw environmentError();
    }
    for (const [key, expected] of Object.entries(expectedEnvironment)) {
        if (environment[key] !== expected) throw environmentError();
    }
    return copyFrozen(environment);
}

function environmentError() {
    const error = new Error('WebTTY shell environment is not the fixed allowlist');
    error.code = 'WEBTTY_ENVIRONMENT_INVALID';
    return error;
}
