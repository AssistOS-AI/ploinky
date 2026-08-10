import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { appendLog } from '../server/utils/logger.js';
import { DEPS_DIR, RUNNING_DIR } from '../utils/config.js';
import {
    addSessionContainer,
    cleanupSessionSet,
    destroyWorkspaceContainers
} from '../sandbox/docker/index.js';
import { debugLog } from '../utils/utils.js';
import {
    INITIAL_ROUTER_PORT,
    resolvePersistedRouterPort,
} from '../sandbox/routerPort.js';

function registerSessionContainer(name) {
    try { addSessionContainer(name); } catch (_) { }
}

function cleanupSessionContainers() {
    try { cleanupSessionSet(); } catch (_) { }
}

// Watchdog permits 15s for graceful child shutdown, then allows another 1s
// after SIGKILL before exiting. Keep margin for process and port observation.
const ROUTER_SHUTDOWN_TIMEOUT_MS = 20_000;
const ROUTER_SHUTDOWN_POLL_MS = 100;

function sleepSynchronously(milliseconds) {
    const sleepArr = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sleepArr, 0, 0, milliseconds);
}

function killRouterIfRunning({ strict = false } = {}) {
    try {
        const pidFile = path.join(RUNNING_DIR, 'router.pid');
        const pidFileExists = fs.existsSync(pidFile);
        let stopped = false;
        let port = null;
        let portResolutionError = null;
        let persistedPid = null;
        let persistedPidValid = false;
        const targetedPids = new Set();
        try {
            port = resolvePersistedRouterPort();
        } catch (error) {
            portResolutionError = error;
            // Managed Routers listen on exactly 8080. In strict mode, probe
            // that fixed port even when persisted configuration is absent or
            // malformed. A listener found without persisted authority is not
            // killed by port alone, but it must block the source transition.
            if (strict) port = INITIAL_ROUTER_PORT;
        }

        const isPidAlive = (pid) => {
            try {
                process.kill(pid, 0);
                return true;
            } catch (error) {
                return error?.code === 'EPERM';
            }
        };

        const logRouterStop = (pid, signal, source) => {
            try {
                appendLog('server_stop', { pid, signal, source, port });
            } catch (_) { }
        };

        const findPids = () => {
            const pids = new Set();
            if (!port) return [];
            try {
                const out = execSync(`lsof -t -i :${port} -sTCP:LISTEN`, { stdio: 'pipe' }).toString();
                out.split(/\s+/).filter(Boolean).forEach(x => { const n = parseInt(x, 10); if (!Number.isNaN(n)) pids.add(n); });
            } catch (_) { }
            if (!pids.size) {
                try {
                    const out = execSync('ss -ltnp', { stdio: 'pipe' }).toString();
                    out.split(/\n+/).forEach(line => {
                        if (line.includes(`:${port}`) && line.includes('pid=')) {
                            const m = line.match(/pid=(\d+)/);
                            if (m) { const n = parseInt(m[1], 10); if (!Number.isNaN(n)) pids.add(n); }
                        }
                    });
                } catch (_) { }
            }
            return Array.from(pids);
        };

        if (pidFileExists) {
            const persistedPidText = fs.readFileSync(pidFile, 'utf8').trim();
            if (/^[1-9]\d*$/.test(persistedPidText)) {
                persistedPid = Number(persistedPidText);
                persistedPidValid = Number.isSafeInteger(persistedPid);
            }
        }

        const initialListenerPids = findPids();
        if (strict && pidFileExists && !persistedPidValid) {
            const error = new Error(
                `Router Watchdog pidfile is invalid; refusing a port-only shutdown: ${pidFile}`,
            );
            error.code = 'PLOINKY_ROUTER_PID_AUTHORITY_INVALID';
            throw error;
        }
        if (
            strict
            && initialListenerPids.length > 0
            && (!persistedPidValid || !isPidAlive(persistedPid))
        ) {
            const error = new Error(
                'A managed Router listener exists without a live persisted Watchdog PID; refusing a port-only shutdown',
            );
            error.code = 'PLOINKY_ROUTER_PID_AUTHORITY_MISSING';
            throw error;
        }

        if (persistedPidValid) {
            const pid = persistedPid;
            if (pid) {
                // Track the claimed owner before signalling it. Permission
                // failures and other rejected signals must remain visible to
                // strict callers instead of being mistaken for a completed
                // shutdown when no persisted port is available.
                targetedPids.add(pid);
                try {
                    process.kill(pid, 'SIGTERM');
                    logRouterStop(pid, 'SIGTERM', 'pid_file');
                    console.log(`Stopped Router (pid ${pid}).`);
                    stopped = true;
                } catch (_) { }
            }
        }

        if (!stopped && !portResolutionError) {
            const tryKill = (pid) => {
                if (!pid) return false;
                targetedPids.add(pid);
                try {
                    process.kill(pid, 'SIGTERM');
                    logRouterStop(pid, 'SIGTERM', 'port_scan');
                    console.log(`Stopped Router (port ${port}, pid ${pid}).`);
                    return true;
                } catch (_) { return false; }
            };

            const pids = findPids();
            for (const pid of pids) {
                if (tryKill(pid)) { stopped = true; }
            }
            if (!stopped && pids.length) {
                for (const pid of pids) {
                    targetedPids.add(pid);
                    try {
                        process.kill(pid, 'SIGKILL');
                        logRouterStop(pid, 'SIGKILL', 'port_scan');
                        console.log(`Killed Router (pid ${pid}).`);
                        stopped = true;
                    } catch (_) { }
                }
            }
        }

        // A source transition depends on this command being a real barrier, not
        // merely on SIGTERM having been accepted. Wait for both the Watchdog PID
        // and its Router listener to disappear before reporting success.
        const remainingPids = waitForRouterQuiescence({
            targetedPids,
            isPidAlive,
            findPids,
        });
        if (remainingPids.length > 0) {
            const error = new Error(
                `Router processes remain after shutdown: ${remainingPids.join(', ')}`,
            );
            error.code = 'PLOINKY_ROUTER_QUIESCENCE_FAILED';
            throw error;
        }
        if (pidFileExists) {
            try { fs.unlinkSync(pidFile); } catch (_) { }
        }
        return { stopped, remainingPids: [] };
    } catch (error) {
        if (strict) throw error;
        debugLog(`Router shutdown was incomplete: ${error?.message || error}`);
        return { stopped: false, error };
    }
}

function waitForRouterQuiescence({
    targetedPids,
    isPidAlive,
    findPids,
    timeoutMs = ROUTER_SHUTDOWN_TIMEOUT_MS,
    pollMs = ROUTER_SHUTDOWN_POLL_MS,
    now = Date.now,
    sleep = sleepSynchronously,
}) {
    const remainingPids = () => [...new Set([
        ...[...targetedPids].filter(isPidAlive),
        ...findPids(),
    ])];
    const deadline = now() + timeoutMs;
    let remaining = remainingPids();
    while (remaining.length > 0) {
        const remainingWaitMs = deadline - now();
        if (remainingWaitMs <= 0) break;
        sleep(Math.min(pollMs, remainingWaitMs));
        remaining = remainingPids();
    }
    return remaining;
}

async function destroyAll() {
    try {
        const list = destroyWorkspaceContainers({ fast: true });
        if (list.length) {
            console.log('Removed containers:');
            list.forEach(n => console.log(` - ${n}`));
        }

        try {
            fs.rmSync(DEPS_DIR, { recursive: true, force: true });
            console.log('Cleared dependency cache: .ploinky/deps');
            console.log('Preserved agent data: .data');
        } catch (err) {
            console.error(`Failed to clear .ploinky/deps: ${err.message}`);
        }

        console.log(`Destroyed ${list.length} containers from this workspace.`);
    }
    catch (e) { console.error('Destroy failed:', e.message); }
}

async function shutdownSession() {
    try { cleanupSessionContainers(); } catch (e) { debugLog('shutdown error:', e.message); }
    console.log('Shutdown completed for current session containers.');
}

export {
    registerSessionContainer,
    cleanupSessionContainers,
    waitForRouterQuiescence,
    killRouterIfRunning,
    destroyAll,
    shutdownSession,
};
