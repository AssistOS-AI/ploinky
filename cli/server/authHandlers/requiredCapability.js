export const REQUIRED_CAPABILITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function normalizeRequiredCapability(value) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return REQUIRED_CAPABILITY_PATTERN.test(normalized) ? normalized : null;
}

export function requiredCapabilityFromManifest(manifest) {
    return normalizeRequiredCapability(manifest?.routerAccess?.requiredCapability);
}

export function normalizeLocalAuthRoles(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 64
        || value.some((role) => typeof role !== 'string' || !REQUIRED_CAPABILITY_PATTERN.test(role))) return null;
    return [...new Set(value)];
}

export function evaluateRequiredCapability(manifest, user, { authMode } = {}) {
    const requiredCapability = requiredCapabilityFromManifest(manifest);
    if (requiredCapability === null) {
        return { ok: false, error: 'required_capability_invalid' };
    }
    if (!requiredCapability) return { ok: true };
    const localAuthRoles = normalizeLocalAuthRoles(manifest?.routerAccess?.localAuthRoles);
    if (localAuthRoles === null) {
        return { ok: false, error: 'local_auth_roles_invalid' };
    }
    // Only the router's verified authentication channel can select this
    // explicit compatibility policy. User/provider claims never select it.
    if (authMode === 'local'
        && Array.isArray(user?.roles) && localAuthRoles.some((role) => user.roles.includes(role))) {
        return { ok: true, requiredCapability };
    }
    const capabilities = Array.isArray(user?.capabilities)
        ? user.capabilities.map(String)
        : [];
    if (!capabilities.includes(requiredCapability)) {
        return {
            ok: false,
            error: 'required_capability_missing',
            requiredCapability,
        };
    }
    return { ok: true, requiredCapability };
}

export function evaluateRequiredCapabilities(manifests, user, options = {}) {
    const requiredCapabilities = [];
    for (const manifest of Array.isArray(manifests) ? manifests : []) {
        const decision = evaluateRequiredCapability(manifest, user, options);
        if (!decision.ok) return decision;
        if (decision.requiredCapability && !requiredCapabilities.includes(decision.requiredCapability)) {
            requiredCapabilities.push(decision.requiredCapability);
        }
    }
    return { ok: true, requiredCapabilities };
}
