import fs from 'fs';
import path from 'path';
import { appendLog, logCrash, logShutdown } from './logger.js';

const PID_FILE = process.env.PLOINKY_ROUTER_PID_FILE || null;
const GRACEFUL_SHUTDOWN_TIMEOUT = 10000; // 10 seconds

let isShuttingDown = false;

/**
 * Ensure PID file is created
 */
function ensurePidFile() {
    if (!PID_FILE) return;
    try {
        fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
        fs.writeFileSync(PID_FILE, String(process.pid));
    } catch (_) { }
}

/**
 * Clear PID file
 */
function clearPidFile() {
    if (!PID_FILE) return;
    try {
        fs.unlinkSync(PID_FILE);
    } catch (err) {
        if (err && err.code !== 'ENOENT') {
            console.warn(`Failed to remove router pid file: ${PID_FILE}`);
        }
    }
}

/**
 * Graceful shutdown handler
 */
function resolveServerPort(server) {
    try {
        const address = server.address();
        if (!address) return null;
        if (typeof address === 'object' && address !== null) {
            return address.port ?? null;
        }
        if (typeof address === 'string') {
            const parsed = Number.parseInt(address.split(':').pop(), 10);
            return Number.isNaN(parsed) ? null : parsed;
        }
        return null;
    } catch (_) {
        return null;
    }
}

function closeWebchatSessions(globalState) {
    try {
        const webchat = globalState?.webchat;
        if (!webchat) {
            return;
        }
        if (webchat.runtimes instanceof Map) {
            for (const [runtimeKey, runtime] of webchat.runtimes.entries()) {
                if (runtime?.subscribers instanceof Map) {
                    for (const subscriber of runtime.subscribers.values()) {
                        try { subscriber.res.end(); } catch (_) { }
                        try { subscriber.res.destroy?.(); } catch (_) { }
                    }
                    runtime.subscribers.clear();
                }
                try {
                    if (typeof runtime?.tty?.dispose === 'function') runtime.tty.dispose();
                    else if (typeof runtime?.tty?.kill === 'function') runtime.tty.kill();
                } catch (_) { }
                webchat.runtimes.delete(runtimeKey);
            }
        }
        if (!(webchat.sessions instanceof Map)) return;
        for (const [sid, session] of webchat.sessions.entries()) {
            if (!session || !(session.tabs instanceof Map)) {
                continue;
            }
            for (const [tabId, tab] of session.tabs.entries()) {
                if (!tab) {
                    continue;
                }
                try {
                    if (tab.sseRes) {
                        try { tab.sseRes.end(); } catch (_) { }
                        try { tab.sseRes.destroy?.(); } catch (_) { }
                    }
                } catch (_) { }
                try {
                    if (tab.tty) {
                        if (typeof tab.tty.dispose === 'function') {
                            tab.tty.dispose();
                        } else if (typeof tab.tty.kill === 'function') {
                            tab.tty.kill();
                        }
                    }
                } catch (_) { }
                session.tabs.delete(tabId);
            }
        }
    } catch (err) {
        console.error('[SHUTDOWN] Failed closing webchat sessions:', err?.message || err);
    }
}

function createGracefulShutdown(server, globalState, agentSessionStore) {
    return function gracefulShutdown(signal, exitCode = 0) {
        if (isShuttingDown) {
            console.log('[SHUTDOWN] Already shutting down...');
            return;
        }
        isShuttingDown = true;

        const shutdownReason = signal ? `Signal: ${signal}` : 'Unknown';
        logShutdown(shutdownReason, exitCode, { signal });
        console.log(`[SHUTDOWN] Initiating graceful shutdown (${shutdownReason})...`);

        // Set forced exit timeout
        const forceExitTimer = setTimeout(() => {
            console.error('[SHUTDOWN] Forced exit after timeout');
            logShutdown('forced_exit_timeout', 1, { originalReason: shutdownReason });
            clearPidFile();
            process.exit(1);
        }, GRACEFUL_SHUTDOWN_TIMEOUT);

        // Attempt graceful shutdown
        closeWebchatSessions(globalState);
        server.close((err) => {
            clearTimeout(forceExitTimer);

            const resolvedPort = resolveServerPort(server);
            let port = resolvedPort;
            if (port == null) {
                const envPort = Number.parseInt(process.env.PORT || '', 10);
                port = Number.isNaN(envPort) ? null : envPort;
            }

            if (err) {
                console.error('[SHUTDOWN] Error during server close:', err.message);
                logShutdown('server_close_error', 1, { error: err.message, originalReason: shutdownReason });
            } else {
                console.log('[SHUTDOWN] Server closed successfully');
            }

            const stopPayload = {
                port: port ?? null,
                signal: signal || null,
                pid: process.pid,
                uptime: process.uptime()
            };
            appendLog('server_stop', stopPayload);

            // Clean up resources
            try {
                // Close all active sessions
                for (const [key, state] of Object.entries(globalState)) {
                    if (state.sessions instanceof Map) {
                        state.sessions.clear();
                    }
                }
                // Clear agent sessions
                agentSessionStore.clear();
            } catch (cleanupErr) {
                console.error('[SHUTDOWN] Error during cleanup:', cleanupErr.message);
            }

            clearPidFile();
            process.exit(exitCode);
        });

        // Stop accepting new connections immediately
        server.unref();
    };
}

/**
 * Setup all process lifecycle handlers
 */
function setupProcessLifecycle(server, globalState, agentSessionStore) {
    ensurePidFile();

    const gracefulShutdown = createGracefulShutdown(server, globalState, agentSessionStore);

    // Exit handler
    process.on('exit', (code) => {
        clearPidFile();
        if (!isShuttingDown) {
            logShutdown('process_exit', code);
        }
    });

    // Signal handlers
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGQUIT']) {
        process.on(sig, () => {
            gracefulShutdown(sig, 0);
        });
    }

    // Global error handlers
    process.on('uncaughtException', (error, origin) => {
        // EPIPE/EIO errors occur when stdout/stderr is closed (e.g., watchdog killed).
        // Don't try to log these to console as it will cause more errors.
        // DON'T exit - the server can continue handling requests with broken stdout.
        // If we exit with code 0, the watchdog interprets it as "clean shutdown" and stops.
        if (error?.code === 'EPIPE' || error?.code === 'EIO') {
            try {
                // Only log to file, skip console output
                appendLog('pipe_error', {
                    level: 'warn',
                    errorType: 'uncaughtException',
                    message: `${error.code} - stdout/stderr disconnected (continuing to run)`,
                    code: error.code,
                    origin,
                    pid: process.pid,
                    uptime: process.uptime()
                });
            } catch (_) { /* ignore */ }
            // Don't exit - just ignore and continue running
            // The server can still handle HTTP requests even with broken stdout/stderr
            return;
        }

        logCrash('uncaughtException', error, { origin });
        // Use try-catch for console in case stderr is broken
        try {
            console.error('[FATAL] Uncaught Exception:', error);
            console.error('Origin:', origin);
        } catch (_) { /* ignore EPIPE */ }

        // Exit with error code to trigger restart
        // gracefulShutdown('uncaughtException', 1);
    });

    process.on('unhandledRejection', (reason, promise) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        logCrash('unhandledRejection', error, {
            reason: String(reason),
            promiseString: String(promise)
        });
        console.error('[FATAL] Unhandled Promise Rejection:', reason);
        console.error('Promise:', promise);

        // Exit with error code to trigger restart
        gracefulShutdown('unhandledRejection', 1);
    });

    process.on('warning', (warning) => {
        appendLog('process_warning', {
            name: warning.name,
            message: warning.message,
            stack: warning.stack
        });
        console.warn('[WARNING]', warning.name + ':', warning.message);
    });

    return {
        gracefulShutdown,
        isShuttingDown: () => isShuttingDown
    };
}

export {
    ensurePidFile,
    clearPidFile,
    setupProcessLifecycle
};
