import fs from 'fs';
import path from 'path';
import { PLOINKY_DIR } from '../../utils/config.js';
import { debugLog } from '../../utils/utils.js';

const BWRAP_PIDS_DIR = path.join(PLOINKY_DIR, 'bwrap-pids');
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms) {
    Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}

function ensurePidDir() {
    if (!fs.existsSync(BWRAP_PIDS_DIR)) {
        fs.mkdirSync(BWRAP_PIDS_DIR, { recursive: true });
    }
}

function getPidFile(agentName) {
    return path.join(BWRAP_PIDS_DIR, `${agentName}.pid`);
}

function getBwrapPid(agentName) {
    const pidFile = getPidFile(agentName);
    if (!fs.existsSync(pidFile)) return 0;
    try {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        return Number.isFinite(pid) && pid > 0 ? pid : 0;
    } catch (_) {
        return 0;
    }
}

function saveBwrapPid(agentName, pid) {
    ensurePidDir();
    fs.writeFileSync(getPidFile(agentName), String(pid));
}

function clearBwrapPid(agentName) {
    const pidFile = getPidFile(agentName);
    try { fs.unlinkSync(pidFile); } catch (_) { }
}

function isBwrapProcessRunning(agentName) {
    const pid = getBwrapPid(agentName);
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        // Process doesn't exist — clean up stale PID file
        clearBwrapPid(agentName);
        return false;
    }
}

function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e?.code === 'EPERM';
    }
}

function sendSignalToBwrapEntry(entry, signal) {
    const { agentName, pid } = entry;
    try {
        process.kill(-pid, signal);
        console.log(`[bwrap] ${agentName}: sent ${signal} to process group ${pid}`);
        return true;
    } catch (e) {
        if (e?.code === 'ESRCH') {
            console.log(`[bwrap] ${agentName}: process ${pid} already exited`);
            clearBwrapPid(agentName);
            entry.stopped = true;
            return true;
        }
        // EPERM can happen when the process group signal is denied; try the root PID.
        try {
            process.kill(pid, signal);
            console.log(`[bwrap] ${agentName}: sent ${signal} to process ${pid}`);
            return true;
        } catch (e2) {
            if (e2?.code === 'ESRCH') {
                clearBwrapPid(agentName);
                entry.stopped = true;
                return true;
            }
            debugLog(`[bwrap] ${agentName}: kill failed: ${e2?.message || e2}`);
            return false;
        }
    }
}

function stopBwrapProcesses(agentNames, { signal = 'SIGTERM', timeout = 5000 } = {}) {
    if (!Array.isArray(agentNames) || !agentNames.length) return [];

    const entries = [];
    const seen = new Set();
    for (const agentName of agentNames) {
        if (!agentName || seen.has(agentName)) continue;
        seen.add(agentName);

        const pid = getBwrapPid(agentName);
        if (!pid) {
            debugLog(`[bwrap] ${agentName}: no PID file found`);
            continue;
        }
        entries.push({ agentName, pid, stopped: false });
    }

    for (const entry of entries) {
        sendSignalToBwrapEntry(entry, signal);
    }

    const deadline = Date.now() + Math.max(0, timeout);
    while (Date.now() < deadline) {
        let hasRunningProcesses = false;
        for (const entry of entries) {
            if (entry.stopped) continue;
            if (isPidAlive(entry.pid)) {
                hasRunningProcesses = true;
                continue;
            }
            console.log(`[bwrap] ${entry.agentName}: process ${entry.pid} exited`);
            clearBwrapPid(entry.agentName);
            entry.stopped = true;
        }
        if (!hasRunningProcesses) break;
        sleepMs(200);
    }

    for (const entry of entries) {
        if (entry.stopped) continue;
        console.log(`[bwrap] ${entry.agentName}: force killing process ${entry.pid}`);
        try { process.kill(-entry.pid, 'SIGKILL'); } catch (_) { }
        try { process.kill(entry.pid, 'SIGKILL'); } catch (_) { }
        clearBwrapPid(entry.agentName);
        entry.stopped = true;
    }

    return entries.filter((entry) => entry.stopped).map((entry) => entry.agentName);
}

function stopBwrapProcess(agentName, { signal = 'SIGTERM', timeout = 5000 } = {}) {
    return stopBwrapProcesses([agentName], { signal, timeout }).includes(agentName);
}

function stopAllBwrapProcesses() {
    if (!fs.existsSync(BWRAP_PIDS_DIR)) return [];
    const agentNames = fs.readdirSync(BWRAP_PIDS_DIR)
        .filter((file) => file.endsWith('.pid'))
        .map((file) => file.replace('.pid', ''));
    return stopBwrapProcesses(agentNames);
}

export {
    BWRAP_PIDS_DIR,
    getBwrapPid,
    saveBwrapPid,
    clearBwrapPid,
    isBwrapProcessRunning,
    stopBwrapProcesses,
    stopBwrapProcess,
    stopAllBwrapProcesses
};
