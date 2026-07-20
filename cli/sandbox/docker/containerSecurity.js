function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readContainerSecurityBlock(source) {
    if (!isPlainObject(source)) return null;
    const security = source.containerSecurity;
    if (!isPlainObject(security)) return null;
    return security;
}

export function resolveContainerSecurity(manifest, profileConfig) {
    const profileSecurity = readContainerSecurityBlock(profileConfig);
    const rootSecurity = readContainerSecurityBlock(manifest);
    const source = profileSecurity || rootSecurity || {};
    return {
        privileged: source.privileged === true,
    };
}

export function buildContainerSecurityArgs(containerSecurity) {
    if (!containerSecurity || containerSecurity.privileged !== true) {
        return [];
    }
    return ['--privileged'];
}
