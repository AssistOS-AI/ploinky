// One owner for the process-wide foreground command and its signals.
//
// The REPL installs permanent SIGINT/SIGTERM handlers whose first action is
// `process.exit(0)`. A long-running command that registers its own handler
// later can therefore be killed before it cleans up its child, descriptor, or
// timers, and its exit code is lost. This coordinator makes the active command
// the owner of the signal: the REPL asks it first, and only acts itself when
// nothing is running.
//
// The abort signal it hands to a command is also what an internal transition --
// a startup-to-runtime log handoff, for instance -- must NOT use. Internal
// cancellation stays inside the command so it can never be reported as an
// operator interrupt.

export const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });
export const FOREGROUND_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);

export function createForegroundCommandCoordinator({
    processRef = process,
    signals = FOREGROUND_SIGNALS,
} = {}) {
    let active = null;
    let idleWaiters = [];

    function isActive() {
        return active !== null;
    }

    function currentSignal() {
        return active ? active.controller.signal : undefined;
    }

    function currentOperatorSignal() {
        return active?.receivedSignal || '';
    }

    // Returns true when an active command consumed the signal, so the caller
    // knows not to take its own shutdown path.
    function deliver(signal) {
        if (!active) return false;
        if (!active.receivedSignal) active.receivedSignal = signal;
        if (!active.controller.signal.aborted) active.controller.abort();
        return true;
    }

    // Internal cancellation (for example the private Box stdin-EOF channel)
    // aborts cleanup without manufacturing an operator signal exit code.
    function cancel() {
        if (!active) return false;
        if (!active.controller.signal.aborted) active.controller.abort();
        return true;
    }

    // Resolves once the active command has finished its own cleanup.
    function whenIdle() {
        if (!active) return Promise.resolve();
        return new Promise((resolve) => idleWaiters.push(resolve));
    }

    async function run(handler, { installSignalHandlers = true } = {}) {
        if (active) {
            throw new Error('one foreground command may be active at a time');
        }
        const controller = new AbortController();
        const state = { controller, receivedSignal: '' };
        active = state;

        const installed = new Map();
        if (installSignalHandlers) {
            for (const signal of signals) {
                const listener = () => deliver(signal);
                installed.set(signal, listener);
                processRef.on(signal, listener);
            }
        }

        try {
            const result = await handler({ signal: controller.signal });
            // The operator's intent decides the code even when the command
            // exits cleanly on its own cancellation path.
            if (state.receivedSignal) {
                return Object.freeze({
                    code: SIGNAL_EXIT_CODES[state.receivedSignal] ?? 1,
                    signal: state.receivedSignal,
                });
            }
            return Object.freeze({
                code: Number.isInteger(result) ? result : 0,
                signal: '',
            });
        } finally {
            // Handlers, then the active slot, are released exactly once even
            // when the handler threw.
            for (const [signal, listener] of installed) {
                try { processRef.removeListener(signal, listener); } catch (_) {}
            }
            installed.clear();
            active = null;
            const waiters = idleWaiters;
            idleWaiters = [];
            for (const resolve of waiters) resolve();
        }
    }

    return {
        run,
        deliver,
        cancel,
        isActive,
        currentSignal,
        currentOperatorSignal,
        whenIdle,
    };
}

// One process runs one foreground command at a time, so the entry points share
// this instance instead of threading a coordinator through every call site.
const sharedCoordinator = createForegroundCommandCoordinator();

export function getForegroundCommandCoordinator() {
    return sharedCoordinator;
}

export function activeForegroundSignal() {
    return sharedCoordinator.currentSignal();
}
