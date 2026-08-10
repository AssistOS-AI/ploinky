import { SIGNAL_EXIT_CODES } from './foregroundCommand.js';

// One idempotent owner for REPL termination. All paths that really close the
// process cancel an active logs command and await its child/descriptor cleanup
// before touching readline or exiting.
export function createReplLifecycleController({
    foreground,
    cleanupSessions = () => {},
    deregisterInput = () => {},
    restoreTTY = () => {},
    closeReadline = () => {},
    exitProcess = (code) => process.exit(code),
} = {}) {
    if (!foreground) throw new Error('REPL lifecycle requires a foreground coordinator');

    let shutdownPromise = null;
    let selectedExitCode = 0;

    function isShuttingDown() {
        return shutdownPromise !== null;
    }

    function shutdown(exitCode = 0) {
        if (shutdownPromise) return shutdownPromise;
        selectedExitCode = Number.isInteger(exitCode) ? exitCode : 0;
        shutdownPromise = (async () => {
            if (foreground.isActive()) {
                foreground.cancel();
                await foreground.whenIdle();
            }
            try { await cleanupSessions(); } catch (_) {}
            try { deregisterInput(); } catch (_) {}
            try { restoreTTY(); } catch (_) {}
            try { closeReadline(); } catch (_) {}
            exitProcess(selectedExitCode);
            return selectedExitCode;
        })();
        return shutdownPromise;
    }

    function handleSignal(signal) {
        if (foreground.deliver(signal)) {
            const firstSignal = foreground.currentOperatorSignal();
            if (firstSignal === 'SIGTERM') {
                return shutdown(SIGNAL_EXIT_CODES.SIGTERM);
            }
            // A first SIGINT owns this command even if another signal arrives
            // during cleanup. It returns to the prompt rather than turning a
            // later signal in the same race into a REPL shutdown.
            return Promise.resolve(null);
        }
        // Before this coordinator existed, an idle/non-log Ctrl+C followed
        // the REPL's ordinary clean shutdown path. Preserve that behavior;
        // SIGTERM remains an externally observable 143.
        return shutdown(signal === 'SIGINT' ? 0 : (SIGNAL_EXIT_CODES[signal] ?? 1));
    }

    return Object.freeze({
        handleSignal,
        isShuttingDown,
        selectedExitCode: () => selectedExitCode,
        shutdown,
    });
}
