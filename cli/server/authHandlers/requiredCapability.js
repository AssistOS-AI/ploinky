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

export function evaluateRequiredCapability(manifest, user) {
    const requiredCapability = requiredCapabilityFromManifest(manifest);
    if (requiredCapability === null) {
        return { ok: false, error: 'required_capability_invalid' };
    }
    if (!requiredCapability) return { ok: true };
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

export function evaluateRequiredCapabilities(manifests, user) {
    const requiredCapabilities = [];
    for (const manifest of Array.isArray(manifests) ? manifests : []) {
        const decision = evaluateRequiredCapability(manifest, user);
        if (!decision.ok) return decision;
        if (decision.requiredCapability && !requiredCapabilities.includes(decision.requiredCapability)) {
            requiredCapabilities.push(decision.requiredCapability);
        }
    }
    return { ok: true, requiredCapabilities };
}
