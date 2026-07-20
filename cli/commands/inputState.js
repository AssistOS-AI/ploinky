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

export function prepareForExternalCommand() {
    const rl = activeInterface;
    if (!rl || !rl.input) {
        // No interactive session; nothing special to do.
        return () => {};
    }
    const inputStream = rl.input;
    let restored = false;
    let pausedRl = false;
    let pausedInput = false;
    let previousRawMode = null;
    let hasRawMode = false;

    suspend();
    if (rl && typeof rl.pause === 'function') {
        rl.pause();
        pausedRl = true;
    } else if (inputStream && typeof inputStream.pause === 'function') {
        inputStream.pause();
        pausedInput = true;
    }

    if (inputStream && typeof inputStream.setRawMode === 'function') {
        const isRaw = Boolean(inputStream.isRaw);
        previousRawMode = isRaw;
        hasRawMode = true;
        if (isRaw) {
            try {
                inputStream.setRawMode(false);
            } catch (_) {
                /* noop */
            }
        }
    }

    return () => {
        if (restored) return;
        restored = true;
        if (hasRawMode && typeof inputStream.setRawMode === 'function' && previousRawMode !== null) {
            try {
                inputStream.setRawMode(previousRawMode);
            } catch (_) {
                /* noop */
            }
        }
        if (pausedRl && typeof rl?.resume === 'function') {
            rl.resume();
            try {
                rl.prompt();
            } catch (_) {
                /* noop */
            }
        } else if (pausedInput && typeof inputStream?.resume === 'function') {
            inputStream.resume();
        }
        resume();
    };
}
