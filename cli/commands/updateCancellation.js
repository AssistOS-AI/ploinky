import { FOREGROUND_SIGNALS } from './foregroundCommand.js';

// Operator cancellation of one `ploinky update`.
//
// The host cancels an in-Box update with SIGTERM and escalates to SIGKILL
// only after a grace period; an operator stops a direct update with Ctrl+C.
// Node's default action for either signal ends the process at once, before
// any `finally` runs, so a writer holding a checkout lock or the workspace
// lease would leave it behind and never publish its report. Once an update
// holds the lease it owns these signals instead and stops at its next
// checkpoint: a step that already started finishes and releases its own
// locks, and no later step starts. Before that, while it still waits for the
// lease, a signal keeps its default action.
//
// Repository updates run synchronously, and a signal listener runs only when
// the event loop turns, so every checkpoint first lets pending signals reach
// it. A signal the update received but never reported as a cancellation keeps
// its default action when the update hands the signals back.

export const UPDATE_CANCELLED_CODE = 'PLOINKY_UPDATE_CANCELLED';

export class UpdateCancelledError extends Error {
    constructor(signal, stage, records = []) {
        super(`Update cancelled by ${signal} before ${stage}; no later update step was started. `
            + 'Run `ploinky update` again to continue.');
        this.name = 'UpdateCancelledError';
        this.code = UPDATE_CANCELLED_CODE;
        this.signal = signal;
        this.records = records;
    }
}

// A signal listener runs in the event loop's poll phase. From inside that
// phase one setImmediate resumes before the next poll; a second one resumes
// only after it.
function deliverPendingSignals() {
    return new Promise(resolve => setImmediate(() => setImmediate(resolve)));
}

export function createUpdateCancellation({ processRef = process, signals = FOREGROUND_SIGNALS } = {}) {
    let received = '';
    const listeners = new Map();
    return {
        /** Take the signals over from their default action. */
        arm() {
            if (listeners.size) return;
            for (const signal of signals) {
                const listener = () => {
                    if (!received) received = signal;
                };
                listeners.set(signal, listener);
                processRef.on(signal, listener);
            }
        },
        /** The first signal received, after every pending signal was delivered. */
        async signalReceived() {
            await deliverPendingSignals();
            return received;
        },
        /** Throws UpdateCancelledError, carrying the records so far, once a signal was received. */
        async checkpoint(stage, records = []) {
            await deliverPendingSignals();
            if (received) throw new UpdateCancelledError(received, stage, [...records]);
        },
        /**
         * Hand the signals back. A received signal that `reported` does not
         * account for is raised again once nothing else listens for it, so it
         * still ends the process as it would have without the update.
         */
        async dispose({ reported = false } = {}) {
            if (!listeners.size) return;
            await deliverPendingSignals();
            for (const [signal, listener] of listeners) {
                try { processRef.removeListener(signal, listener); } catch (_) {}
            }
            listeners.clear();
            if (received && !reported && processRef.listenerCount(received) === 0) {
                processRef.kill(processRef.pid, received);
            }
        },
    };
}
