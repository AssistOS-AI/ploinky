import fs from 'fs';
import path from 'path';
import { LOGS_DIR } from '../../utils/config.js';

const LOG_DIR = LOGS_DIR;
const LOG_PATH = path.join(LOG_DIR, 'router.log');
const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;

function ensureLogDirectory() {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch (_) {
        // Ignore logging directory errors to avoid crashing the server.
    }
}

function normalizeMaxPendingBytes(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0
        ? parsed
        : DEFAULT_MAX_PENDING_BYTES;
}

export function createAsyncLogWriter({
    fsApi = fs,
    logDir = LOG_DIR,
    logPath = LOG_PATH,
    maxPendingBytes = DEFAULT_MAX_PENDING_BYTES,
} = {}) {
    const byteLimit = normalizeMaxPendingBytes(maxPendingBytes);
    const pending = [];
    let pendingBytes = 0;
    let droppedRecords = 0;
    let scheduled = null;
    let flushPromise = null;

    function schedule() {
        if (scheduled || flushPromise) return;
        scheduled = setImmediate(() => {
            scheduled = null;
            void flush();
        });
        scheduled.unref?.();
    }

    function appendLine(line) {
        const normalized = String(line || '');
        const bytes = Buffer.byteLength(normalized);
        if (bytes > byteLimit) {
            droppedRecords += 1;
            schedule();
            return false;
        }
        while (pending.length > 0 && pendingBytes + bytes > byteLimit) {
            const removed = pending.shift();
            pendingBytes -= removed.bytes;
            droppedRecords += 1;
        }
        pending.push({ line: normalized, bytes });
        pendingBytes += bytes;
        schedule();
        return true;
    }

    async function flush() {
        if (flushPromise) return flushPromise;
        if (scheduled) {
            clearImmediate(scheduled);
            scheduled = null;
        }
        flushPromise = (async () => {
            try {
                await fsApi.promises.mkdir(logDir, { recursive: true });
                while (pending.length > 0 || droppedRecords > 0) {
                    const records = pending.splice(0);
                    pendingBytes = 0;
                    const dropped = droppedRecords;
                    droppedRecords = 0;
                    const droppedLine = dropped > 0
                        ? `${JSON.stringify({
                            ts: new Date().toISOString(),
                            level: 'warn',
                            type: 'router_log_records_dropped',
                            dropped,
                        })}\n`
                        : '';
                    await fsApi.promises.appendFile(
                        logPath,
                        droppedLine + records.map(record => record.line).join(''),
                    );
                }
            } catch (_) {
                // Diagnostics must never interrupt routing. A later record
                // schedules a fresh attempt after a transient write failure.
            }
        })().finally(() => {
            flushPromise = null;
            if (pending.length > 0 || droppedRecords > 0) schedule();
        });
        return flushPromise;
    }

    return {
        appendLine,
        flush,
        pendingState: () => ({
            pendingRecords: pending.length,
            pendingBytes,
            droppedRecords,
            flushing: Boolean(flushPromise),
        }),
    };
}

const routerLogWriter = createAsyncLogWriter();

export function appendLog(type, data = {}) {
    try {
        const record = JSON.stringify({
            ts: new Date().toISOString(),
            level: 'debug',
            type,
            ...data
        });
        routerLogWriter.appendLine(`${record}\n`);
    } catch (_) {
        // Ignore logging failures; diagnostics should not interrupt routing.
    }
}

export function flushPendingLogs() {
    return routerLogWriter.flush();
}

export function logBootEvent(action, details = {}) {
    appendLog('boot_operation', { action, ...details });
}

// Track if we're already in a crash logging to prevent EPIPE recursion
let isLoggingCrash = false;

// Safe console write that catches EPIPE errors
function safeConsoleError(...args) {
    try {
        console.error(...args);
    } catch (err) {
        // Ignore EPIPE and other write errors - stderr may be broken
        // This prevents EPIPE from triggering another uncaughtException
    }
}

export function logCrash(errorType, error, additionalData = {}) {
    // Prevent recursion: if we're already logging a crash and get another
    // error (like EPIPE), just bail out silently
    if (isLoggingCrash) {
        return;
    }
    isLoggingCrash = true;

    try {
        const errorDetails = {
            level: 'fatal',
            errorType,
            message: error?.message || String(error),
            stack: error?.stack || null,
            code: error?.code || null,
            pid: process.pid,
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            ...additionalData
        };

        try {
            ensureLogDirectory();
            const record = JSON.stringify({
                ts: new Date().toISOString(),
                type: 'crash',
                ...errorDetails
            });
            fs.appendFileSync(LOG_PATH, `${record}\n`);

            // Also write to stderr for immediate visibility (safely)
            safeConsoleError(`[CRASH] ${errorType}:`, error?.message || String(error));
            if (error?.stack) {
                safeConsoleError(error.stack);
            }
        } catch (_) {
            // Last resort: try to write to stderr (safely)
            safeConsoleError('[CRASH] Failed to log crash:', errorType, error);
        }
    } finally {
        isLoggingCrash = false;
    }
}

export function logMemoryUsage() {
    const usage = process.memoryUsage();
    appendLog('memory_usage', {
        rss: usage.rss,
        heapTotal: usage.heapTotal,
        heapUsed: usage.heapUsed,
        external: usage.external,
        arrayBuffers: usage.arrayBuffers,
        rssMB: Math.round(usage.rss / 1024 / 1024),
        heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024)
    });
}

export function logShutdown(reason, exitCode = 0, additionalData = {}) {
    const shutdownDetails = {
        level: exitCode === 0 ? 'info' : 'error',
        reason,
        exitCode,
        pid: process.pid,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        ...additionalData
    };
    
    try {
        ensureLogDirectory();
        const record = JSON.stringify({
            ts: new Date().toISOString(),
            type: 'shutdown',
            ...shutdownDetails
        });
        fs.appendFileSync(LOG_PATH, `${record}\n`);
        console.log(`[SHUTDOWN] ${reason} (exit code: ${exitCode})`);
    } catch (_) {
        console.error('[SHUTDOWN] Failed to log shutdown:', reason);
    }
}

export { LOG_DIR, LOG_PATH };
