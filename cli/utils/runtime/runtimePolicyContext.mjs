import { AsyncLocalStorage } from 'node:async_hooks';

const runtimePolicyEnvironment = new AsyncLocalStorage();

export function runWithRuntimePolicyEnvironment({ prod, workspaceProfile }, callback) {
    if (typeof prod !== 'boolean' || typeof workspaceProfile !== 'string' || !workspaceProfile.trim()) {
        throw new TypeError('Runtime policy environment requires prod and workspaceProfile');
    }
    return runtimePolicyEnvironment.run(Object.freeze({ prod, workspaceProfile }), callback);
}

export function currentRuntimePolicyEnvironment() {
    return runtimePolicyEnvironment.getStore();
}
