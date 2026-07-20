import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { appendLog } from '../server/utils/logger.js';
import { DEPS_DIR, ROUTING_FILE, RUNNING_DIR } from '../utils/config.js';
import {
    addSessionContainer,
    cleanupSessionSet,
    destroyWorkspaceContainers
} from '../sandbox/docker/index.js';
import { debugLog } from '../utils/utils.js';

function registerSessionContainer(name) {
    try { addSessionContainer(name); } catch (_) { }
}

function cleanupSessionContainers() {
    try { cleanupSessionSet(); } catch (_) { }
}

function killRouterIfRunning() {
    try {
        const pidFile = path.join(RUNNING_DIR, 'router.pid');
        let stopped = false;
        let port = 8080;
        try {
            const routing = JSON.parse(fs.readFileSync(ROUTING_FILE, 'utf8')) || {};
            if (routing.port) port = parseInt(routing.port, 10) || port;
        } catch (_) { }

        const logRouterStop = (pid, signal, source) => {
            try {
                appendLog('server_stop', { pid, signal, source, port });
            } catch (_) { }
        };

        const findPids = () => {
            const pids = new Set();
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

        const isPortFree = () => {
            return findPids().length === 0;
        };

        if (fs.existsSync(pidFile)) {
            const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
            if (pid && !Number.isNaN(pid)) {
                try {
                    process.kill(pid, 'SIGTERM');
                    logRouterStop(pid, 'SIGTERM', 'pid_file');
                    console.log(`Stopped Router (pid ${pid}).`);
                    stopped = true;
                } catch (_) { }
            }
            try { fs.unlinkSync(pidFile); } catch (_) { }
        }

        if (!stopped) {
            const tryKill = (pid) => {
                if (!pid) return false;
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
                    try {
                        process.kill(pid, 'SIGKILL');
                        logRouterStop(pid, 'SIGKILL', 'port_scan');
                        console.log(`Killed Router (pid ${pid}).`);
                        stopped = true;
                    } catch (_) { }
                }
            }
        }

        // Wait for the port to be free after killing the process
        if (stopped) {
            const maxWait = 50; // 5 seconds max
            for (let i = 0; i < maxWait; i++) {
                if (isPortFree()) {
                    break;
                }
                // Synchronous sleep using Atomics
                const sleepArr = new Int32Array(new SharedArrayBuffer(4));
                Atomics.wait(sleepArr, 0, 0, 100);
            }
        }
    } catch (_) { }
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
    killRouterIfRunning,
    destroyAll,
    shutdownSession,
};
