import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import http from 'http';

import { createContainerMonitor, startContainerMonitor, stopContainerMonitor, clearContainerTargets } from './containerMonitor.js';
import { appendLog } from './utils/logger.js';
import { LOGS_DIR, PLOINKY_DIR } from '../utils/config.js';
import { inspectWorkspaceStartLock } from '../utils/runtime/maintenanceLocks.js';
import { parseRouterPort } from '../sandbox/routerPort.js';
import { isInsideBox } from '../../ploinky-box/lib/boxMarker.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOST_CONTAINER_SNAPSHOT_INTERVAL_MS = 0;
const BOX_CONTAINER_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

export function resolveContainerSnapshotIntervalMs({
    insideBox = false,
    configured = process.env.PLOINKY_CONTAINER_SNAPSHOT_INTERVAL_MS,
} = {}) {
    const parsed = Number(configured);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    return insideBox
        ? BOX_CONTAINER_SNAPSHOT_INTERVAL_MS
        : HOST_CONTAINER_SNAPSHOT_INTERVAL_MS;
}

const insideBox = isInsideBox();

// Configuration
const CONFIG = {
    SERVER_SCRIPT: path.join(__dirname, 'RoutingServer.js'),
    LOG_DIR: LOGS_DIR,
    ROUTER_LOG: path.join(LOGS_DIR, 'router.log'),
    PROCESS_LOG: path.join(LOGS_DIR, 'watchdog.log'),
    
    // Restart configuration
    MAX_RESTARTS_IN_WINDOW: 5,        // Max restarts allowed in time window
    RESTART_WINDOW_MS: 60000,          // Time window (60 seconds)
    INITIAL_BACKOFF_MS: 1000,          // Initial backoff (1 second)
    MAX_BACKOFF_MS: 30000,             // Max backoff (30 seconds)
    BACKOFF_MULTIPLIER: 2,             // Exponential backoff multiplier

    // Health check configuration
    HEALTH_CHECK_ENABLED: process.env.HEALTH_CHECK_ENABLED !== 'false',
    HEALTH_CHECK_INTERVAL_MS: 30000,   // Check every 30 seconds
    HEALTH_CHECK_TIMEOUT_MS: 5000,     // 5 second timeout
    HEALTH_CHECK_FAILURES_THRESHOLD: 3, // Restart after 3 consecutive failures
    HEALTH_SOCKET: process.env.PLOINKY_ROUTER_HEALTH_SOCKET
        || path.join(PLOINKY_DIR, 'run', 'router-health.sock'),

    // Process configuration
    PORT: parseRouterPort(process.env.PORT || '8080', { source: 'Watchdog PORT' }),
    NODE_OPTIONS: process.env.NODE_OPTIONS || '',

    // Container monitoring
    CONTAINER_CHECK_INTERVAL_MS: 5000, // Advance supervision every 5 seconds.
    // Nested rootless Podman has one practical control-plane lane. Cache the
    // shared Box inventory for the semantic-probe interval so probe scheduling
    // stays responsive without repeatedly stalling live agent traffic. Host
    // runtimes retain one fresh inventory snapshot per monitor tick.
    CONTAINER_SNAPSHOT_INTERVAL_MS: resolveContainerSnapshotIntervalMs({ insideBox }),
    CONTAINER_SNAPSHOT_RETRY_INITIAL_MS: 15000,
    CONTAINER_SNAPSHOT_RETRY_MAX_MS: 60000,
};

const IS_TEST_MODE = process.env.PLOINKY_WATCHDOG_TEST_MODE === '1';
const testLogBuffer = [];

function createInitialState() {
    return {
        childProcess: null,
        restartHistory: [],
        consecutiveFailures: 0,
        currentBackoff: CONFIG.INITIAL_BACKOFF_MS,
        isShuttingDown: false,
        healthCheckFailures: 0,
        healthCheckTimer: null,
        totalRestarts: 0,
        lastStartTime: null,
        circuitBreakerTripped: false,
        containerMonitor: null,
        pendingHealthCheckRestart: false, // True when Watchdog initiated a restart via health check
        healthCheckWorkspaceStartDeferred: false,
    };
}

// State management
const state = createInitialState();

// Safe console write helper (ignores EIO/EPIPE errors)
function safeConsole(method, ...args) {
    try {
        console[method](...args);
    } catch (_) {
        // Ignore EIO/EPIPE errors
    }
}

// Ensure log directory exists
function ensureLogDirectory() {
    try {
        fs.mkdirSync(CONFIG.LOG_DIR, { recursive: true });
    } catch (err) {
        safeConsole('error', '[ProcessManager] Failed to create log directory:', err.message);
    }
}

function getRouterNodeExecutable() {
    return process.execPath || 'node';
}

function appendRouterProcessOutput(streamName, chunk) {
    if (IS_TEST_MODE || !chunk) {
        return;
    }
    try {
        ensureLogDirectory();
        fs.appendFileSync(CONFIG.ROUTER_LOG, chunk);
    } catch (err) {
        log('error', 'router_output_log_failed', {
            stream: streamName,
            error: err?.message || String(err)
        });
    }
}

// Logging function
function log(level, event, data = {}) {
    const logEntry = {
        ts: new Date().toISOString(),
        level,
        event,
        pid: state.childProcess?.pid || null,
        managerPid: process.pid,
        ...data
    };
    
    const logLine = JSON.stringify(logEntry);
    const consolePrefix = `[Watchdog:${level.toUpperCase()}]`;

    if (IS_TEST_MODE) {
        testLogBuffer.push(logEntry);
    }
    
    if (!IS_TEST_MODE) {
        // Console output with color (wrapped in try-catch to handle EIO/EPIPE)
        try {
            switch (level) {
                case 'fatal':
                case 'error':
                    console.error(consolePrefix, event, data);
                    break;
                case 'warn':
                    console.warn(consolePrefix, event, data);
                    break;
                case 'info':
                    console.log(consolePrefix, event, data);
                    break;
                case 'debug':
                    if (process.env.DEBUG) {
                        console.log(consolePrefix, event, data);
                    }
                    break;
            }
        } catch (_) {
            // Ignore EIO/EPIPE errors - stdout/stderr may be broken
        }
    }
    
    if (!IS_TEST_MODE) {
        // Write to log file
        try {
            ensureLogDirectory();
            fs.appendFileSync(CONFIG.PROCESS_LOG, logLine + '\n');
        } catch (err) {
            safeConsole('error', '[Watchdog] Failed to write log:', err.message);
        }
    }
}

function ensureContainerMonitor() {
    if (!state.containerMonitor) {
        state.containerMonitor = createContainerMonitor({
            config: CONFIG,
            log,
            isShuttingDown: () => state.isShuttingDown
        });
    }
}

ensureContainerMonitor();

// Clean old restart history entries
function cleanRestartHistory() {
    const now = Date.now();
    state.restartHistory = state.restartHistory.filter(
        timestamp => now - timestamp < CONFIG.RESTART_WINDOW_MS
    );
}

// Check if circuit breaker should trip
function checkCircuitBreaker() {
    cleanRestartHistory();
    
    if (state.restartHistory.length >= CONFIG.MAX_RESTARTS_IN_WINDOW) {
        state.circuitBreakerTripped = true;
        log('fatal', 'circuit_breaker_tripped', {
            restarts: state.restartHistory.length,
            windowMs: CONFIG.RESTART_WINDOW_MS,
            message: `Server crashed ${state.restartHistory.length} times in ${CONFIG.RESTART_WINDOW_MS / 1000} seconds`
        });
        return true;
    }
    
    return false;
}

// Calculate next backoff delay
function calculateBackoff() {
    const backoff = Math.min(
        state.currentBackoff,
        CONFIG.MAX_BACKOFF_MS
    );
    
    // Exponential backoff for next time
    state.currentBackoff = Math.min(
        state.currentBackoff * CONFIG.BACKOFF_MULTIPLIER,
        CONFIG.MAX_BACKOFF_MS
    );
    
    return backoff;
}

// Reset backoff on successful long-running process
function resetBackoff() {
    state.currentBackoff = CONFIG.INITIAL_BACKOFF_MS;
    state.consecutiveFailures = 0;
    state.healthCheckFailures = 0;
}

// Health check function
function buildHealthCheckRequestOptions(port = CONFIG.PORT, env = process.env) {
    const publicAuthority = String(env.PLOINKY_PUBLIC_AUTHORITY || '').trim();
    return {
        hostname: '127.0.0.1',
        port,
        path: '/health',
        headers: {
            Host: publicAuthority || `127.0.0.1:${port}`,
        },
    };
}

async function performHealthCheck() {
    if (!CONFIG.HEALTH_CHECK_ENABLED || state.isShuttingDown) {
        return true;
    }
    
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            req.destroy();
            resolve(false);
        }, CONFIG.HEALTH_CHECK_TIMEOUT_MS);

        const req = http.get({
            socketPath: CONFIG.HEALTH_SOCKET,
            path: '/health',
            method: 'GET',
        }, (res) => {
            clearTimeout(timeout);
            
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const health = JSON.parse(data);
                    const isHealthy = res.statusCode === 200 && health.status === 'healthy';
                    resolve(isHealthy);
                } catch (err) {
                    resolve(false);
                }
            });
        });
        
        req.on('error', () => {
            clearTimeout(timeout);
            resolve(false);
        });
    });
}

function inspectHealthCheckWorkspaceStart(inspectWorkspaceStartLockImpl) {
    try {
        return inspectWorkspaceStartLockImpl();
    } catch (error) {
        log('error', 'health_check_workspace_start_inspection_failed', {
            error: error?.message || String(error),
        });
        return { active: false, stale: false, lock: null };
    }
}

function deferHealthCheckForWorkspaceStart(workspaceStart) {
    state.healthCheckFailures = 0;
    if (state.healthCheckWorkspaceStartDeferred) return;
    state.healthCheckWorkspaceStartDeferred = true;
    log('info', 'health_check_deferred_workspace_start', {
        ownerPid: workspaceStart?.lock?.ownerPid || null,
        expiresAt: workspaceStart?.lock?.expiresAt || null,
    });
}

function resumeHealthCheckAfterWorkspaceStart() {
    if (!state.healthCheckWorkspaceStartDeferred) return;
    state.healthCheckWorkspaceStartDeferred = false;
    log('info', 'health_check_resumed_workspace_start');
}

async function runHealthCheckTick({
    performHealthCheckImpl = performHealthCheck,
    inspectWorkspaceStartLockImpl = inspectWorkspaceStartLock,
    appendLogImpl = appendLog,
} = {}) {
    if (state.isShuttingDown || !state.childProcess || state.pendingHealthCheckRestart) {
        return;
    }

    const checkedChild = state.childProcess;
    const workspaceStartBeforeCheck = inspectHealthCheckWorkspaceStart(inspectWorkspaceStartLockImpl);
    if (workspaceStartBeforeCheck.active) {
        deferHealthCheckForWorkspaceStart(workspaceStartBeforeCheck);
        return;
    }
    resumeHealthCheckAfterWorkspaceStart();

    const isHealthy = await performHealthCheckImpl();

    // A health response from a superseded Router must not mutate the current
    // process's counters or terminate the replacement process.
    if (state.isShuttingDown
        || state.childProcess !== checkedChild
        || state.pendingHealthCheckRestart) {
        return;
    }

    // Workspace startup can begin while the asynchronous health request is in
    // flight. Recheck the exact lease before consuming a failure so startup
    // load cannot be mistaken for a dead Router.
    const workspaceStartAfterCheck = inspectHealthCheckWorkspaceStart(inspectWorkspaceStartLockImpl);
    if (workspaceStartAfterCheck.active) {
        deferHealthCheckForWorkspaceStart(workspaceStartAfterCheck);
        return;
    }
    resumeHealthCheckAfterWorkspaceStart();

    if (isHealthy) {
        if (state.healthCheckFailures > 0) {
            log('info', 'health_check_recovered', {
                previousFailures: state.healthCheckFailures
            });
        }
        state.healthCheckFailures = 0;
        return;
    }

    state.healthCheckFailures++;
    log('warn', 'health_check_failed', {
        consecutiveFailures: state.healthCheckFailures,
        threshold: CONFIG.HEALTH_CHECK_FAILURES_THRESHOLD
    });

    if (state.healthCheckFailures < CONFIG.HEALTH_CHECK_FAILURES_THRESHOLD) {
        return;
    }

    state.pendingHealthCheckRestart = true;
    log('error', 'health_check_threshold_exceeded', {
        failures: state.healthCheckFailures,
        action: 'restarting_process'
    });

    const pid = checkedChild.pid;
    appendLogImpl('process_signal', {
        action: 'health_check_kill',
        pid,
        signal: 'SIGTERM',
        reason: 'health_check_threshold_exceeded',
        failures: state.healthCheckFailures,
        source: 'Watchdog.healthCheck'
    });
    checkedChild.kill('SIGTERM');
}

// Start health check monitoring
function startHealthCheckMonitoring() {
    if (!CONFIG.HEALTH_CHECK_ENABLED) {
        return;
    }
    
    stopHealthCheckMonitoring();
    
    state.healthCheckTimer = setInterval(() => {
        runHealthCheckTick().catch((error) => {
            log('error', 'health_check_tick_failed', {
                error: error?.message || String(error),
            });
        });
    }, CONFIG.HEALTH_CHECK_INTERVAL_MS);
}

// Stop health check monitoring
function stopHealthCheckMonitoring() {
    if (state.healthCheckTimer) {
        clearInterval(state.healthCheckTimer);
        state.healthCheckTimer = null;
    }
}

function resetManagerState() {
    stopHealthCheckMonitoring();
    clearContainerTargets(state.containerMonitor);
    const initial = createInitialState();
    for (const key of Object.keys(initial)) {
        state[key] = initial[key];
    }
    ensureContainerMonitor();
}

function getTestLogs() {
    return testLogBuffer.slice();
}

function clearTestLogs() {
    testLogBuffer.length = 0;
}

// Spawn the server process
function spawnServer() {
    if (state.circuitBreakerTripped) {
        log('fatal', 'spawn_blocked_circuit_breaker', {
            message: 'Circuit breaker is tripped. Manual intervention required.'
        });
        safeConsole('error', '\n========================================');
        safeConsole('error', 'CRITICAL: Circuit breaker tripped!');
        safeConsole('error', `Server crashed ${CONFIG.MAX_RESTARTS_IN_WINDOW} times in ${CONFIG.RESTART_WINDOW_MS / 1000} seconds.`);
        safeConsole('error', 'Manual intervention required. Check logs at:', CONFIG.PROCESS_LOG);
        safeConsole('error', '========================================\n');
        process.exit(100);
    }
    
    state.lastStartTime = Date.now();
    
    log('info', 'spawning_server', {
        script: CONFIG.SERVER_SCRIPT,
        attempt: state.totalRestarts + 1,
        backoff: state.currentBackoff
    });
    
    // Don't pass PLOINKY_ROUTER_PID_FILE to the child - that file stores
    // the Watchdog PID, not the RoutingServer PID
    const { PLOINKY_ROUTER_PID_FILE, ...restEnv } = process.env;
    const env = {
        ...restEnv,
        MANAGED_BY_PROCESS_MANAGER: 'true',
        PORT: String(CONFIG.PORT),
    };
    
    const nodeExecutable = getRouterNodeExecutable();
    const child = spawn(nodeExecutable, [CONFIG.SERVER_SCRIPT], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        detached: false
    });
    
    state.childProcess = child;
    
    log('info', 'server_spawned', {
        pid: child.pid,
        nodeExecutable,
        totalRestarts: state.totalRestarts
    });

    child.stdout?.on('data', chunk => appendRouterProcessOutput('stdout', chunk));
    child.stderr?.on('data', chunk => appendRouterProcessOutput('stderr', chunk));
    
    // Handle process exit
    child.on('exit', (code, signal) => {
        handleProcessExit(code, signal);
    });
    
    child.on('error', (err) => {
        log('error', 'spawn_error', {
            error: err.message,
            code: err.code
        });
    });
    
    // Start health monitoring and restart container monitor after a brief delay
    setTimeout(() => {
        if (!state.isShuttingDown && state.childProcess === child) {
            startHealthCheckMonitoring();
            // Restart container monitor (may have been stopped during restart)
            if (state.containerMonitor) {
                startContainerMonitor(state.containerMonitor);
            }
        }
    }, 10000); // Wait 10 seconds for server to start
}

// Handle process exit
function handleProcessExit(code, signal) {
    stopHealthCheckMonitoring();
    
    const uptime = state.lastStartTime ? Date.now() - state.lastStartTime : 0;
    const uptimeSeconds = Math.floor(uptime / 1000);
    
    log('warn', 'process_exited', {
        exitCode: code,
        signal,
        uptime,
        uptimeSeconds,
        wasExpected: state.isShuttingDown
    });
    
    state.childProcess = null;
    
    // If we're shutting down, don't restart
    if (state.isShuttingDown) {
        log('info', 'shutdown_complete', { exitCode: code });
        process.exit(code || 0);
        return;
    }
    
    // Check if this was a successful run (uptime > 60 seconds)
    if (uptime > 60000) {
        log('info', 'successful_run_detected', {
            uptimeSeconds,
            message: 'Resetting backoff and failure counters'
        });
        resetBackoff();
    }
    
    // Determine if we should restart
    const shouldRestart = determineShouldRestart(code, signal);
    
    if (!shouldRestart) {
        log('info', 'restart_skipped', { exitCode: code, signal });
        process.exit(code || 0);
        return;
    }
    
    // Record restart attempt
    state.restartHistory.push(Date.now());
    state.consecutiveFailures++;
    state.totalRestarts++;
    
    // Check circuit breaker
    if (checkCircuitBreaker()) {
        return; // Will exit with code 100
    }
    
    // Calculate backoff
    const backoff = calculateBackoff();

    log('info', 'scheduling_restart', {
        backoffMs: backoff,
        consecutiveFailures: state.consecutiveFailures,
        totalRestarts: state.totalRestarts,
        recentRestarts: state.restartHistory.length
    });

    // Stop container monitor to prevent its sync operations from blocking the restart
    // This ensures the setTimeout callback executes promptly
    stopContainerMonitor(state.containerMonitor);

    // Restart after backoff
    setTimeout(() => {
        spawnServer();
    }, backoff);
}

// Determine if we should restart based on exit conditions
function determineShouldRestart(code, signal) {
    // If the Watchdog initiated the kill (health check), always restart
    if (state.pendingHealthCheckRestart) {
        state.pendingHealthCheckRestart = false;  // Clear the flag
        log('info', 'health_check_restart', {
            message: 'Watchdog-initiated kill (health check), restarting process'
        });
        return true;
    }

    // Clean exit (code 0) = no restart
    if (code === 0) {
        log('info', 'clean_exit', { message: 'Process exited cleanly, no restart needed' });
        return false;
    }
    
    // Port conflict or permission error (code 2) = no restart
    if (code === 2) {
        log('error', 'configuration_error', {
            exitCode: code,
            message: 'Configuration error (port conflict or permission). Fix required.'
        });
        return false;
    }
    
    // Fatal error that should not restart (code >= 100)
    if (code >= 100) {
        log('fatal', 'fatal_error_no_restart', {
            exitCode: code,
            message: 'Fatal error, manual intervention required'
        });
        return false;
    }
    
    // SIGTERM or SIGINT from external source = assume intentional, no restart
    if (signal === 'SIGTERM' || signal === 'SIGINT') {
        log('info', 'intentional_signal', {
            signal,
            message: 'Process received shutdown signal, no restart'
        });
        return false;
    }
    
    // All other exits = restart
    log('info', 'unexpected_exit', {
        exitCode: code,
        signal,
        message: 'Unexpected exit, will restart'
    });
    return true;
}

// Graceful shutdown of watchdog
function shutdownManager(signal) {
    if (state.isShuttingDown) {
        return;
    }
    
    state.isShuttingDown = true;
    log('info', 'watchdog_shutting_down', { signal });
    
    stopHealthCheckMonitoring();
    stopContainerMonitor(state.containerMonitor);
    
    if (state.childProcess) {
        const pid = state.childProcess.pid;
        const killSignal = signal || 'SIGTERM';
        log('info', 'stopping_child_process', { pid });
        appendLog('process_signal', {
            action: 'watchdog_shutdown',
            pid,
            signal: killSignal,
            reason: 'watchdog_received_signal',
            originalSignal: signal,
            source: 'Watchdog.shutdownManager'
        });

        // Forward the signal to the child
        state.childProcess.kill(killSignal);

        // Set a timeout to force kill
        setTimeout(() => {
            if (state.childProcess) {
                const forcePid = state.childProcess.pid;
                log('warn', 'force_killing_child', { pid: forcePid });
                appendLog('process_signal', {
                    action: 'watchdog_force_kill',
                    pid: forcePid,
                    signal: 'SIGKILL',
                    reason: 'graceful_shutdown_timeout',
                    source: 'Watchdog.shutdownManager'
                });
                state.childProcess.kill('SIGKILL');
                setTimeout(() => process.exit(0), 1000);
            }
        }, 15000); // 15 second timeout
    } else {
        process.exit(0);
    }
}

// Main startup
function main() {
    log('info', 'process_manager_starting', {
        serverScript: CONFIG.SERVER_SCRIPT,
        port: CONFIG.PORT,
        healthCheckEnabled: CONFIG.HEALTH_CHECK_ENABLED,
        maxRestartsInWindow: CONFIG.MAX_RESTARTS_IN_WINDOW,
        restartWindowSeconds: CONFIG.RESTART_WINDOW_MS / 1000
    });
    
    // Verify server script exists
    if (!fs.existsSync(CONFIG.SERVER_SCRIPT)) {
        log('fatal', 'server_script_not_found', {
            path: CONFIG.SERVER_SCRIPT,
            message: 'Server script does not exist'
        });
        safeConsole('error', `[Watchdog] FATAL: Server script not found: ${CONFIG.SERVER_SCRIPT}`);
        process.exit(1);
    }
    
    // Setup signal handlers
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT']) {
        process.on(signal, () => shutdownManager(signal));
    }
    
    // Handle watchdog errors
    process.on('uncaughtException', (error) => {
        // EPIPE/EIO errors occur when stdout/stderr is closed (e.g., watchdog killed).
        // Don't try to log these to console as it will cause more errors.
        // DON'T shutdown - the watchdog can continue monitoring with broken stdout.
        if (error?.code === 'EPIPE' || error?.code === 'EIO') {
            try {
                // Only log to file, skip console output
                appendLog('pipe_error', {
                    level: 'warn',
                    errorType: 'watchdog_uncaught_exception',
                    message: `${error.code} - stdout/stderr disconnected (continuing to run)`,
                    code: error.code,
                    pid: process.pid,
                    uptime: process.uptime()
                });
            } catch (_) { /* ignore */ }
            // Don't shutdown - just ignore and continue running
            return;
        }

        log('fatal', 'watchdog_uncaught_exception', {
            error: error.message,
            stack: error.stack
        });
        safeConsole('error', '[Watchdog] FATAL: Uncaught exception:', error);
        shutdownManager('SIGTERM');
    });

    process.on('unhandledRejection', (reason) => {
        log('error', 'watchdog_unhandled_rejection', {
            reason: String(reason)
        });
        safeConsole('error', '[Watchdog] Unhandled rejection:', reason);
    });
    
    // Log on exit
    process.on('exit', (code) => {
        log('info', 'watchdog_exiting', { exitCode: code });
    });
    
    // Start the server and monitoring
    ensureContainerMonitor();
    spawnServer();
    startContainerMonitor(state.containerMonitor);

    safeConsole('log', '\n========================================');
    safeConsole('log', 'Watchdog Started');
    safeConsole('log', '========================================');
    safeConsole('log', `Server script: ${CONFIG.SERVER_SCRIPT}`);
    safeConsole('log', `Port: ${CONFIG.PORT}`);
    safeConsole('log', `Health checks: ${CONFIG.HEALTH_CHECK_ENABLED ? 'Enabled' : 'Disabled'}`);
    safeConsole('log', `Max restarts: ${CONFIG.MAX_RESTARTS_IN_WINDOW} in ${CONFIG.RESTART_WINDOW_MS / 1000}s`);
    safeConsole('log', `Logs: ${CONFIG.PROCESS_LOG}`);
    safeConsole('log', '========================================\n');
}

// Start the process manager
if (!IS_TEST_MODE) {
    main();
}

export {
    CONFIG,
    state,
    resetManagerState,
    determineShouldRestart,
    calculateBackoff,
    resetBackoff,
    cleanRestartHistory,
    checkCircuitBreaker,
    getTestLogs,
    clearTestLogs,
    getRouterNodeExecutable,
    buildHealthCheckRequestOptions,
    performHealthCheck,
    runHealthCheckTick,
    IS_TEST_MODE as __IS_TEST_MODE
};
