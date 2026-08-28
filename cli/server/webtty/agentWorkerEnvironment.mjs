const FIXED_AGENT_WORKER_ENVIRONMENT = Object.freeze({
    HOME: '/home/podman',
    USER: 'podman',
    LOGNAME: 'podman',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
});

export const AGENT_WORKER_ENVIRONMENT_KEYS = Object.freeze(
    Object.keys(FIXED_AGENT_WORKER_ENVIRONMENT).sort(),
);

function environmentError() {
    const error = new Error('WebTTY agent worker environment is not the fixed allowlist');
    error.code = 'WEBTTY_AGENT_ENVIRONMENT_INVALID';
    return error;
}

function frozenCopy(environment) {
    return Object.freeze(Object.fromEntries(Object.entries(environment)));
}

// The inherited environment is accepted only to make the scrubbing boundary
// explicit at call sites. Router credentials and workspace secrets are never
// copied into the Podman worker.
export function buildAgentWorkerEnvironment(_inheritedEnvironment = process.env) {
    return frozenCopy(FIXED_AGENT_WORKER_ENVIRONMENT);
}

export function assertExactAgentWorkerEnvironment(environment) {
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
        throw environmentError();
    }
    const keys = Object.keys(environment).sort();
    if (keys.length !== AGENT_WORKER_ENVIRONMENT_KEYS.length
        || keys.some((key, index) => key !== AGENT_WORKER_ENVIRONMENT_KEYS[index])) {
        throw environmentError();
    }
    for (const [key, expected] of Object.entries(FIXED_AGENT_WORKER_ENVIRONMENT)) {
        if (environment[key] !== expected) throw environmentError();
    }
    return frozenCopy(environment);
}
