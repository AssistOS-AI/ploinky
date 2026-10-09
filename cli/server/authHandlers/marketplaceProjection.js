// Role-gated projection of marketplace payloads. Local filesystem locations
// (checkout sources, manifest paths) are administrator metadata: every other
// principal receives the same records without them. Projections never mutate
// their input, so a payload object can never carry one caller's view to another.

// A URL that names a remote Git origin. Anything else (absolute or relative
// paths, file: URLs, home-relative paths) is a local location.
const REMOTE_GIT_URL = /^(?:(?:https?|ssh|git):\/\/[^\s/]|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)[^\s])/i;

export function remoteUrlOrEmpty(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return REMOTE_GIT_URL.test(text) ? text : '';
}

export function projectSkillSource(skillSource) {
    if (!skillSource || typeof skillSource !== 'object') return skillSource;
    const { source, ...rest } = skillSource; // eslint-disable-line no-unused-vars
    return rest;
}

// Repository source record (name, url, source, origin, kind, warnings).
export function projectRepositorySource(record) {
    if (!record || typeof record !== 'object') return record;
    const { source, ...rest } = record; // eslint-disable-line no-unused-vars
    return { ...rest, ...('url' in rest ? { url: remoteUrlOrEmpty(rest.url) } : {}) };
}

// One entry of the marketplace repositories payload.
export function projectMarketplaceRepository(repository) {
    if (!repository || typeof repository !== 'object') return repository;
    return {
        ...repository,
        url: remoteUrlOrEmpty(repository.url),
        repositorySource: projectRepositorySource(repository.repositorySource),
        ...('skillSource' in repository ? { skillSource: projectSkillSource(repository.skillSource) } : {}),
    };
}

// One entry of the marketplace agents payload. statusDetail is free text from
// the background-startup worker's error message and can embed local paths.
export function projectMarketplaceAgent(agent) {
    if (!agent || typeof agent !== 'object') return agent;
    const { manifestPath, statusDetail, ...rest } = agent; // eslint-disable-line no-unused-vars
    return rest;
}
