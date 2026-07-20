let suspended = false;
let activeInterface = null;

export function isSuspended() {
    return suspended;
}

export function suspend() {
    suspended = true;
}

export function resume() {
    suspended = false;
}

export function registerInterface(rl) {
    activeInterface = rl || null;
}

export function getInterface() {
    return activeInterface;
}

export function prepareForExternalCommand({ promptOnRestore = false } = {}) {
    const rl = activeInterface;
    if (!rl || !rl.input) return () => {};
    const inputStream = rl.input;
    let restored = false;
    const previousRawMode = typeof inputStream.setRawMode === 'function'
        ? Boolean(inputStream.isRaw)
        : null;

    suspend();
    if (typeof rl.pause === 'function') rl.pause();
    else if (typeof inputStream.pause === 'function') inputStream.pause();
    if (previousRawMode === true) {
        try {
            inputStream.setRawMode(false);
        } catch (_) {
            /* noop */
        }
    }

    return () => {
        if (restored) return;
        restored = true;
        try {
            if (previousRawMode !== null) {
                try {
                    inputStream.setRawMode(previousRawMode);
                } catch (_) {
                    /* noop */
                }
            }
            if (typeof rl.resume === 'function') rl.resume();
            else if (typeof inputStream.resume === 'function') inputStream.resume();
        } finally {
            resume();
        }
        if (promptOnRestore && typeof rl.prompt === 'function') rl.prompt();
    };
}
