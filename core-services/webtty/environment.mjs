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

// Interactive Bash reads `$HOME/.inputrc` even with --noprofile --norc. A
// profile HOME is written by its owner, so a profile shell reads the system
// readline file instead and loads no configuration from that HOME by itself.
export const WEBTTY_PROFILE_INPUTRC = '/etc/inputrc';

// An optional home profile changes only the interactive shell: HOME, INPUTRC
// and three generic profile variables. The worker environment never carries them.
export const SHELL_PROFILE_ENVIRONMENT_KEYS = Object.freeze([
    'INPUTRC',
    'PLOINKY_WEBTTY_PROFILE_ID',
    'PLOINKY_WEBTTY_PROFILE_LABEL',
    'PLOINKY_WEBTTY_PROFILE_PROVIDER',
]);
export const PROFILE_SHELL_ENVIRONMENT_KEYS = Object.freeze(
    [...SHELL_ENVIRONMENT_KEYS, ...SHELL_PROFILE_ENVIRONMENT_KEYS].sort(),
);
const PROFILE_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROFILE_LABEL_BYTES = 128;

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

function profileEnvironment(profile) {
    const { home, provider, id, label } = profile || {};
    let validHome = '';
    try { validHome = assertWebttyWorkspaceRoot(home); } catch (_) { validHome = ''; }
    if (!validHome || validHome === '/'
        || typeof provider !== 'string' || !PROFILE_PROVIDER.test(provider)
        || typeof id !== 'string' || !PROFILE_ID.test(id)
        || typeof label !== 'string' || !label || /[\u0000-\u001f\u007f]/.test(label)
        || Buffer.byteLength(label, 'utf8') > PROFILE_LABEL_BYTES) {
        throw environmentError();
    }
    return {
        HOME: validHome,
        INPUTRC: WEBTTY_PROFILE_INPUTRC,
        PLOINKY_WEBTTY_PROFILE_PROVIDER: provider,
        PLOINKY_WEBTTY_PROFILE_ID: id,
        PLOINKY_WEBTTY_PROFILE_LABEL: label,
    };
}

// The first argument is accepted so callers can make the scrubbing boundary
// explicit. No inherited value is copied: Router carries workspace secrets.
export function buildWorkerEnvironment(_inheritedEnvironment = process.env, { workspaceRoot } = {}) {
    return copyFrozen(workerEnvironment(workspaceRoot));
}

// `profile` is `{home, provider, id, label}`; without it the shell environment
// is exactly the fixed allowlist.
export function buildShellEnvironment(_inheritedEnvironment = process.env, { workspaceRoot, profile } = {}) {
    const base = shellEnvironment(workspaceRoot);
    return copyFrozen(profile === undefined ? base : { ...base, ...profileEnvironment(profile) });
}

// Without `home` only the fixed allowlist is accepted. With `home` (the
// worker's own revalidated profile HOME), exactly the allowlist plus the
// profile keys is accepted, and HOME must equal it.
export function assertExactShellEnvironment(environment, { workspaceRoot, home } = {}) {
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
        throw environmentError();
    }
    let expectedEnvironment;
    try {
        expectedEnvironment = shellEnvironment(workspaceRoot);
        if (home !== undefined) {
            expectedEnvironment = {
                ...expectedEnvironment,
                ...profileEnvironment({
                    home,
                    provider: environment.PLOINKY_WEBTTY_PROFILE_PROVIDER,
                    id: environment.PLOINKY_WEBTTY_PROFILE_ID,
                    label: environment.PLOINKY_WEBTTY_PROFILE_LABEL,
                }),
            };
        }
    } catch (_) {
        throw environmentError();
    }
    const expectedKeys = home === undefined ? SHELL_ENVIRONMENT_KEYS : PROFILE_SHELL_ENVIRONMENT_KEYS;
    const keys = Object.keys(environment).sort();
    if (keys.length !== expectedKeys.length
        || keys.some((key, index) => key !== expectedKeys[index])) {
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
