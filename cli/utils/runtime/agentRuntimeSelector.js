export const CONTAINER_DECLARATION_REQUIRED_CODE = 'PLOINKY_CONTAINER_DECLARATION_REQUIRED';
export const LITE_SANDBOX_SELECTOR_INVALID_CODE = 'PLOINKY_LITE_SANDBOX_SELECTOR_INVALID';

export function hasValidLiteSandboxSelector(manifest) {
    return !Object.prototype.hasOwnProperty.call(manifest || {}, 'lite-sandbox')
        || typeof manifest['lite-sandbox'] === 'boolean';
}

export function assertValidLiteSandboxSelector(manifest, {
    agentId = '',
    path = 'manifest',
} = {}) {
    if (hasValidLiteSandboxSelector(manifest)) return;
    const error = new Error(`${path}.lite-sandbox must be boolean when present`);
    error.name = 'AgentRuntimeSelectorError';
    error.code = LITE_SANDBOX_SELECTOR_INVALID_CODE;
    error.status = 422;
    error.context = Object.freeze({
        agentId: String(agentId || ''),
        path: String(path || 'manifest'),
    });
    throw error;
}

export function isUsableContainerDeclaration(value) {
    return typeof value === 'string'
        && value.length > 0
        && value === value.trim()
        && !/[\s\0]/.test(value);
}

export function createContainerDeclarationRequiredError({
    agentId = '',
    path = 'manifest',
} = {}) {
    const error = new Error(
        `${path}.container must be a non-empty image reference when lite-sandbox is false or missing`,
    );
    error.name = 'AgentRuntimeSelectorError';
    error.code = CONTAINER_DECLARATION_REQUIRED_CODE;
    error.status = 422;
    error.context = Object.freeze({
        agentId: String(agentId || ''),
        path: String(path || 'manifest'),
    });
    return error;
}

export function requireUsableContainerDeclaration(manifest, options = {}) {
    if (!isUsableContainerDeclaration(manifest?.container)) {
        throw createContainerDeclarationRequiredError(options);
    }
    return manifest.container;
}
