export function evaluateRequiredCapability(record, user) {
    const required = String(record?.routerAccess?.requiredCapability || '').trim();
    if (!required) return { ok: true };
    const capabilities = Array.isArray(user?.capabilities) ? user.capabilities : [];
    if (capabilities.includes(required)) return { ok: true };
    return { ok: false, code: 'CAPABILITY_REQUIRED', required };
}
