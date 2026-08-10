// Small guards around Node's asynchronous child-process spawn contract.

function spawnFailure(label, cause = null) {
    const error = new Error(`${label} failed to spawn`);
    error.code = 'CHILD_SPAWN_FAILED';
    if (cause) error.cause = cause;
    return error;
}

function exactChildPid(child) {
    return Number.isSafeInteger(child?.pid) && child.pid > 0 ? child.pid : null;
}

// Await the native `spawn` event rather than assuming that spawn() throws.
// The error listener deliberately remains after success so a later ChildProcess
// error cannot become an uncaught process-level exception after detachment.
export function waitForChildSpawn(child, {
    label = 'child process',
    onLateError = () => {},
} = {}) {
    if (!child || typeof child.once !== 'function') {
        return Promise.reject(spawnFailure(label));
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const onSpawn = () => {
            if (settled) return;
            const pid = exactChildPid(child);
            if (!pid) {
                settled = true;
                reject(spawnFailure(label));
                return;
            }
            settled = true;
            resolve(pid);
        };
        const onError = (cause) => {
            if (settled) {
                try { onLateError(cause); } catch (_) {}
                return;
            }
            settled = true;
            child.removeListener?.('spawn', onSpawn);
            reject(spawnFailure(label, cause));
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
    });
}

// Synchronous launch APIs cannot await `spawn`, but Node assigns a positive PID
// only after the OS launch succeeded. Install the error guard before checking
// that PID so a pending ENOENT/EACCES event is still consumed after the caller
// unwinds through its local cleanup path.
export function guardSpawnedChild(child, {
    label = 'child process',
    onError = () => {},
} = {}) {
    if (!child || typeof child.once !== 'function') throw spawnFailure(label);
    child.once('error', (cause) => {
        try { onError(cause); } catch (_) {}
    });
    const pid = exactChildPid(child);
    if (!pid) throw spawnFailure(label);
    return pid;
}
