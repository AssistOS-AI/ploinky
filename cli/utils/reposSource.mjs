// Where agent and skill repositories come from.
//
// `dev` (the default) prefers a matching checkout at the workspace root over
// `.ploinky/repos/<repository>`. `prod` ignores workspace checkouts entirely,
// so only the managed copies under `.ploinky/repos` are ever resolved, listed,
// installed or run. A production deployment uses it so that a checkout an
// agent can write through its workspace mount never becomes the source of a
// running agent.
//
// The host reads PLOINKY_REPOS_SOURCE on `start`, `restart` and `update` and
// records it in the Box environment, which every in-Box process inherits. It
// therefore takes effect only after one of those commands recreates the Box.

export const REPOS_SOURCE_ENV = 'PLOINKY_REPOS_SOURCE';
export const REPOS_SOURCE_DEV = 'dev';
export const REPOS_SOURCE_PROD = 'prod';
const REPOS_SOURCES = new Set([REPOS_SOURCE_DEV, REPOS_SOURCE_PROD]);

// An unset or empty value is `undefined` (no selection); any other value must
// name a supported source exactly, so a typo never silently means `dev`.
export function parseReposSource(value) {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    if (text === '') return undefined;
    if (!REPOS_SOURCES.has(text)) {
        throw new Error(`${REPOS_SOURCE_ENV} must be '${REPOS_SOURCE_DEV}' or '${REPOS_SOURCE_PROD}', not '${text}'`);
    }
    return text;
}

// The source this process resolves repositories from.
export function activeReposSource(env = process.env) {
    return parseReposSource(env?.[REPOS_SOURCE_ENV]) || REPOS_SOURCE_DEV;
}

export function workspaceCheckoutsAllowed(env = process.env) {
    return activeReposSource(env) === REPOS_SOURCE_DEV;
}
