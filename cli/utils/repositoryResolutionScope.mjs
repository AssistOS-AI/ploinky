import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
const PREPARATION_WORKERS = 2;

function valuesFor(map, kind) {
    if (!map.has(kind)) map.set(kind, new Map());
    return map.get(kind);
}

// Each builder owns a fresh scope, including builders called after a mutation.
export function runWithRepositoryResolutionScope(fn, { signal } = {}) {
    const scope = { active: true, values: new Map(), pending: new Map(), queue: [], jobs: new Set(), running: 0, controller: new AbortController() };
    const cancel = () => {
        scope.controller.abort();
        for (const task of scope.queue.splice(0)) task.resolve();
    };
    scope.cancel = cancel;
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const dispose = () => {
        scope.active = false;
        cancel();
        signal?.removeEventListener('abort', cancel);
        scope.values.clear();
        scope.pending.clear();
        return Promise.allSettled([...scope.jobs]);
    };
    return storage.run(scope, () => {
        try {
            const result = fn();
            if (result && typeof result.then === 'function') return Promise.resolve(result).finally(dispose);
            // Synchronous callers keep their return/throw contract. Any detached
            // preparation is cancelled; its terminal handlers still own cleanup.
            void dispose();
            return result;
        } catch (error) {
            void dispose();
            throw error;
        }
    });
}

export function memoizeRepositoryRead(kind, key, read) {
    const scope = storage.getStore();
    if (!scope?.active) return read();
    const resolved = scope.values.get(kind);
    if (resolved?.has(key)) return resolved.get(key);
    if (scope.controller.signal.aborted) return read();
    const values = valuesFor(scope.values, kind);
    values.set(key, read());
    return values.get(key);
}

export function repositoryReadScopeCancelled() {
    const scope = storage.getStore();
    return Boolean(scope && (!scope.active || scope.controller.signal.aborted));
}

function drain(scope) {
    while (scope.active && !scope.controller.signal.aborted && scope.running < PREPARATION_WORKERS && scope.queue.length) {
        const task = scope.queue.shift();
        scope.running += 1;
        const job = Promise.resolve().then(() => {
            if (scope.active && !scope.controller.signal.aborted) return task.read(task.key, scope.controller.signal);
        }).then(value => {
            if (scope.active && !scope.controller.signal.aborted) {
                const values = valuesFor(scope.values, task.kind);
                if (!values.has(task.key)) values.set(task.key, value);
            }
            task.resolve();
        }, error => {
            scope.cancel();
            task.reject(error);
        }).finally(() => {
            scope.running -= 1;
            scope.jobs.delete(job);
            drain(scope);
        });
        scope.jobs.add(job);
        void job.catch(error => { scope.cancel(); task.reject(error); });
    }
}

// Pending promises are separate from synchronous memo values. All preparation
// calls in this scope share one two-worker queue, even with different root spellings.
export async function prefetchRepositoryReads(kind, keys, read, { signal } = {}) {
    const scope = storage.getStore();
    if (!scope?.active) throw new Error('Repository preparation requires an active read scope.');
    const onAbort = () => scope.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
        if (scope.controller.signal.aborted) return;
        const values = valuesFor(scope.values, kind);
        const pending = valuesFor(scope.pending, kind);
        const tasks = [];
        for (const key of new Set(keys)) {
            if (values.has(key)) continue;
            if (!pending.has(key)) {
                pending.set(key, new Promise((resolve, reject) => scope.queue.push({ kind, key, read, resolve, reject })));
            }
            tasks.push(pending.get(key));
        }
        drain(scope);
        const results = await Promise.allSettled(tasks);
        // Join the terminal handlers as well as the identity promises.
        await Promise.allSettled([...scope.jobs]);
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
}
