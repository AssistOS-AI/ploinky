import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

// Each builder owns a fresh scope, including builders called after a mutation.
export function runWithRepositoryResolutionScope(fn) {
    const scope = { active: true, values: new Map() };
    return storage.run(scope, () => {
        try {
            const result = fn();
            if (result && typeof result.then === 'function') {
                return Promise.resolve(result).finally(() => { scope.active = false; scope.values.clear(); });
            }
            scope.active = false;
            scope.values.clear();
            return result;
        } catch (error) {
            scope.active = false;
            scope.values.clear();
            throw error;
        }
    });
}

export function memoizeRepositoryRead(kind, key, read) {
    const scope = storage.getStore();
    if (!scope?.active) return read();
    let values = scope.values.get(kind);
    if (!values) scope.values.set(kind, values = new Map());
    if (!values.has(key)) values.set(key, read());
    return values.get(key);
}
