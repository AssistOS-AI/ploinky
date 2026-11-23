// Stand-ins for the physical effects of the lifecycle commands. The caller
// records the durable receipt and workspace lease at each boundary.
let observe;
let container;
let prepare;
export function observeEffects(observer, canaryContainer, prepareSources) {
    observe = observer;
    container = canaryContainer;
    prepare = prepareSources;
}
export function killRouterIfRunning() { observe('killRouterIfRunning'); }
export function stopConfiguredAgents() { observe('stopConfiguredAgents'); return []; }
export function destroyWorkspaceContainers() { observe('destroyWorkspaceContainers'); return []; }
export function destroyAll() { observe('destroyAll'); }
export function stopAndRemove(name) { observe('stopAndRemove:' + name); return [name]; }
export function containerExists() { return false; }
export function inspectCanaryContainer(runtime, id) {
    observe('inspectCanaryContainer');
    return runtime === 'podman' && container?.Id === id ? container : null;
}
export function removeCanaryContainer(name, record, { rolloutId }) {
    if (name !== 'primary__canary' || record.containerId !== container?.Id || rolloutId !== 'rollout') {
        throw new Error('fixture expected the exact canary removal');
    }
    observe('removeCanaryContainer');
    container = null;
    return { removed: true };
}
export function prepareDefaultBootRepositories() {
    observe('prepareDefaultBootRepositories');
    if (!prepare) throw new Error('fixture reached start repository preparation');
}
export function prepareManifestRepositories() { return prepare(); }
export function updateRepoResult() {
    observe('updateRepoResult');
    throw new Error('fixture reached repository update');
}
