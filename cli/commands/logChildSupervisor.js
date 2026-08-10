export function logChildCleanupError(message) {
    const error = new Error(message);
    error.code = 'LOG_CHILD_CLEANUP_FAILED';
    return error;
}

export function superviseLogChild(child, {
    signal,
    termTimeoutMs = 2_000,
    killTimeoutMs = 1_000,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
} = {}) {
    let settled = false;
    let terminationReason = null;
    let termTimer = null;
    let killTimer = null;
    let onAbort = null;
    let resolveCompletion;
    let rejectCompletion;

    const cleanup = () => {
        if (termTimer !== null) clearTimeoutImpl(termTimer);
        if (killTimer !== null) clearTimeoutImpl(killTimer);
        termTimer = null;
        killTimer = null;
        if (onAbort) signal?.removeEventListener?.('abort', onAbort);
        onAbort = null;
        child.removeListener?.('error', onError);
        child.removeListener?.('close', onClose);
    };
    const settle = (finish, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        finish(value);
    };
    const destroyPipes = () => {
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
            try { stream?.destroy?.(); } catch (_) {}
        }
    };
    const send = (name) => {
        try { child.kill?.(name); } catch (_) {}
    };
    const terminate = (reason) => {
        if (settled || terminationReason) return;
        terminationReason = reason || 'termination';
        send('SIGTERM');
        // A test double can close synchronously from kill(), and a native
        // child can close before this turn schedules its escalation. Never
        // leave an orphaned timer behind after completion already won.
        if (settled) return;
        termTimer = setTimeoutImpl(() => {
            if (settled) return;
            send('SIGKILL');
            if (settled) return;
            killTimer = setTimeoutImpl(() => {
                if (settled) return;
                destroyPipes();
                try { child.unref?.(); } catch (_) {}
                settle(
                    rejectCompletion,
                    logChildCleanupError('runtime log child did not close after SIGTERM and SIGKILL'),
                );
            }, killTimeoutMs);
        }, termTimeoutMs);
    };
    const onError = (error) => {
        // Before cancellation an error is the spawn/runtime failure. Once
        // termination starts, kill delivery itself may emit an error. That
        // must not tear down the escalation timers while the child can still
        // be alive; close or the bounded cleanup failure remains terminal.
        if (terminationReason) return;
        settle(rejectCompletion, error);
    };
    const onClose = (code, closeSignal) => settle(resolveCompletion, {
        code,
        closeSignal,
        terminationReason,
    });

    const completion = new Promise((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
        child.on('error', onError);
        child.once('close', onClose);
        if (signal) {
            onAbort = () => terminate('abort');
            if (signal.aborted) onAbort();
            else signal.addEventListener?.('abort', onAbort, { once: true });
        }
    });
    return Object.freeze({ completion, terminate });
}
