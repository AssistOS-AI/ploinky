const FIXED_BASE_ENVIRONMENT = Object.freeze({
    HOME: '/home/podman',
    USER: 'podman',
    LOGNAME: 'podman',
    PATH: '/opt/ploinky/bin:/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PLOINKY_WORKSPACE_ROOT: '/workspace',
});

const FIXED_SHELL_ENVIRONMENT = Object.freeze({
    ...FIXED_BASE_ENVIRONMENT,
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
});

export const WORKER_ENVIRONMENT_KEYS = Object.freeze(Object.keys(FIXED_BASE_ENVIRONMENT).sort());
export const SHELL_ENVIRONMENT_KEYS = Object.freeze(Object.keys(FIXED_SHELL_ENVIRONMENT).sort());

function copyFrozen(environment) {
    return Object.freeze(Object.fromEntries(Object.entries(environment)));
}

// The argument is accepted so callers can make the scrubbing boundary
// explicit. No inherited value is copied: Router carries workspace secrets.
export function buildWorkerEnvironment(_inheritedEnvironment = process.env) {
    return copyFrozen(FIXED_BASE_ENVIRONMENT);
}

export function buildShellEnvironment(_inheritedEnvironment = process.env) {
    return copyFrozen(FIXED_SHELL_ENVIRONMENT);
}

export function assertExactShellEnvironment(environment) {
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
        throw environmentError();
    }
    const keys = Object.keys(environment).sort();
    if (keys.length !== SHELL_ENVIRONMENT_KEYS.length
        || keys.some((key, index) => key !== SHELL_ENVIRONMENT_KEYS[index])) {
        throw environmentError();
    }
    for (const [key, expected] of Object.entries(FIXED_SHELL_ENVIRONMENT)) {
        if (environment[key] !== expected) throw environmentError();
    }
    return copyFrozen(environment);
}

function environmentError() {
    const error = new Error('WebTTY shell environment is not the fixed allowlist');
    error.code = 'WEBTTY_ENVIRONMENT_INVALID';
    return error;
}
