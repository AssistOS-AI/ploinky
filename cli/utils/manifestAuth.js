function authDirectives(value) {
    if (Array.isArray(value)) return value.flatMap(authDirectives);
    if (typeof value !== 'string') return [];
    return value.split(/[,\n;]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

export function resolveManifestAuthMode(manifest) {
    const directives = authDirectives(manifest?.ploinky);
    if (directives.some((entry) => /^pwd(?:\s|$)/.test(entry)) || Object.hasOwn(manifest || {}, 'pwd')) {
        throw new Error('Local password authentication is no longer supported; declare an SSO provider.');
    }
    if (Object.hasOwn(manifest?.routerAccess || {}, 'localAuthRoles')) {
        throw new Error('routerAccess.localAuthRoles is unsupported; authenticated identities must supply the required capability.');
    }
    if (directives.includes('sso enable')) {
        if (manifest?.guest === true) {
            throw new Error('Manifest SSO authentication cannot be combined with guest authentication.');
        }
        return 'sso';
    }
    if (manifest?.guest === true) return 'guest';
    return 'none';
}

export function resolveAgentAuthPolicy(manifest, configuredPolicy) {
    const manifestMode = resolveManifestAuthMode(manifest);
    // A declared identity provider is mandatory for this application's users.
    // Saved settings cannot select a different credential store or disable it.
    if (manifestMode === 'sso') return { mode: 'sso' };
    if (!configuredPolicy) return { mode: manifestMode };
    const mode = String(configuredPolicy.mode || 'none').trim().toLowerCase();
    if (mode === 'local' || mode === 'pwd') {
        throw new Error('Local password authentication is no longer supported; declare an SSO provider.');
    }
    if (!['none', 'guest', 'sso'].includes(mode)) {
        throw new Error(`Unknown auth mode '${configuredPolicy.mode}'. Allowed: none | guest | sso`);
    }
    return { ...configuredPolicy, mode };
}
