import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { PLOINKY_DIR } from '../../utils/config.js';
import { debugLog } from '../../utils/utils.js';

const BWRAP_PIDS_DIR = path.join(PLOINKY_DIR, 'bwrap-pids');
const BWRAP_PID_SCHEMA_VERSION = 2;
const BWRAP_PID_RECORD_KEYS = Object.freeze([
    'enableGeneration',
    'instanceId',
    'pid',
    'processIdentity',
    'runtimeKey',
    'schemaVersion',
]);
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms) {
    Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}

function ensurePidDir() {
    if (!fs.existsSync(BWRAP_PIDS_DIR)) {
        fs.mkdirSync(BWRAP_PIDS_DIR, { recursive: true, mode: 0o700 });
    }
}

function normalizeBwrapRuntimeKey(runtimeKey) {
    const normalized = String(runtimeKey || '').trim();
    if (!normalized || normalized.length > 255 || !/^[A-Za-z0-9_.-]+$/.test(normalized)) {
        throw new Error('sandbox runtime key must be an exact safe container name');
    }
    return normalized;
}

function normalizeSandboxRuntimeIdentity(identity) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
        throw new Error('sandbox runtime identity requires exact instanceId and enableGeneration');
    }
    const rawInstanceId = typeof identity.instanceId === 'string' ? identity.instanceId : '';
    const rawEnableGeneration = typeof identity.enableGeneration === 'string'
        ? identity.enableGeneration
        : '';
    const instanceId = rawInstanceId.trim();
    const enableGeneration = rawEnableGeneration.trim();
    if (
        !instanceId
        || !enableGeneration
        || instanceId !== rawInstanceId
        || enableGeneration !== rawEnableGeneration
    ) {
        throw new Error('sandbox runtime identity requires exact instanceId and enableGeneration');
    }
    return Object.freeze({ instanceId, enableGeneration });
}

function getPidFile(runtimeKey) {
    return path.join(BWRAP_PIDS_DIR, `${normalizeBwrapRuntimeKey(runtimeKey)}.pid`);
}

function readProcessIdentity(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return '';
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const commandEnd = stat.lastIndexOf(')');
        if (commandEnd < 0) return '';
        const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
        const startTicks = String(fields[19] || '').trim();
        return startTicks ? `linux-proc:${startTicks}` : '';
    } catch (_) {
        try {
            const startedAt = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            }).trim().replace(/\s+/g, ' ');
            return startedAt ? `ps-lstart:${startedAt}` : '';
        } catch (_) {
            return '';
        }
    }
}

function readBwrapPidRecord(runtimeKey) {
    const normalized = normalizeBwrapRuntimeKey(runtimeKey);
    const pidFile = getPidFile(normalized);
    if (!fs.existsSync(pidFile)) return null;
    try {
        const stat = fs.lstatSync(pidFile);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
        const parsed = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
        const pid = Number(parsed?.pid);
        if (
            !parsed
            || typeof parsed !== 'object'
            || Array.isArray(parsed)
            || JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(BWRAP_PID_RECORD_KEYS)
            || parsed.schemaVersion !== BWRAP_PID_SCHEMA_VERSION
            || parsed?.runtimeKey !== normalized
            || typeof parsed?.pid !== 'number'
            || !Number.isSafeInteger(pid)
            || pid <= 0
            || typeof parsed?.processIdentity !== 'string'
            || !parsed.processIdentity
            || typeof parsed?.instanceId !== 'string'
            || !parsed.instanceId
            || parsed.instanceId !== parsed.instanceId.trim()
            || typeof parsed?.enableGeneration !== 'string'
            || !parsed.enableGeneration
            || parsed.enableGeneration !== parsed.enableGeneration.trim()
        ) {
            return null;
        }
        return Object.freeze({
            runtimeKey: normalized,
            pid,
            processIdentity: parsed.processIdentity,
            instanceId: parsed.instanceId,
            enableGeneration: parsed.enableGeneration,
        });
    } catch (_) {
        return null;
    }
}

function hasInvalidBwrapPidRecord(runtimeKey) {
    const normalized = normalizeBwrapRuntimeKey(runtimeKey);
    const pidFile = getPidFile(normalized);
    try {
        fs.lstatSync(pidFile);
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
    return readBwrapPidRecord(normalized) === null;
}

function hasBwrapPidRecord(runtimeKey) {
    const pidFile = getPidFile(runtimeKey);
    try {
        fs.lstatSync(pidFile);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

function recordMatchesRuntimeIdentity(record, expectedIdentity) {
    if (expectedIdentity === undefined) return true;
    const expected = normalizeSandboxRuntimeIdentity(expectedIdentity);
    return record?.instanceId === expected.instanceId
        && record?.enableGeneration === expected.enableGeneration;
}

function getBwrapPid(runtimeKey, expectedIdentity = undefined) {
    const record = readBwrapPidRecord(runtimeKey);
    return record && recordMatchesRuntimeIdentity(record, expectedIdentity) ? record.pid : 0;
}

function assertBwrapPidSlotAvailable(runtimeKey) {
    const normalized = normalizeBwrapRuntimeKey(runtimeKey);
    const pidFile = getPidFile(normalized);
    if (!fs.existsSync(pidFile)) return;
    const record = readBwrapPidRecord(normalized);
    if (!record) {
        const error = new Error(
            `sandbox runtime ${normalized} has an invalid or pre-v${BWRAP_PID_SCHEMA_VERSION} PID record; remove it only after confirming no sandbox process still owns the runtime`,
        );
        error.code = 'PLOINKY_SANDBOX_PID_RECORD_INVALID';
        throw error;
    }
    if (isExactBwrapProcess(record) || isBwrapProcessGroupAlive(record.pid)) {
        const error = new Error(`sandbox runtime ${normalized} is already bound to a live process`);
        error.code = 'PLOINKY_SANDBOX_PID_SLOT_BUSY';
        throw error;
    }
    clearBwrapPid(normalized);
}

function saveBwrapPid(runtimeKey, pid, runtimeIdentity) {
    const normalized = normalizeBwrapRuntimeKey(runtimeKey);
    const identity = normalizeSandboxRuntimeIdentity(runtimeIdentity);
    const numericPid = Number(pid);
    const processIdentity = readProcessIdentity(numericPid);
    if (!Number.isSafeInteger(numericPid) || numericPid <= 0 || !processIdentity) {
        throw new Error(`cannot bind sandbox runtime ${normalized} to a live process identity`);
    }
    const existingFile = getPidFile(normalized);
    if (fs.existsSync(existingFile)) {
        const existing = readBwrapPidRecord(normalized);
        if (!existing) {
            const error = new Error(
                `sandbox runtime ${normalized} has an invalid or pre-v${BWRAP_PID_SCHEMA_VERSION} PID record; refusing to replace it`,
            );
            error.code = 'PLOINKY_SANDBOX_PID_RECORD_INVALID';
            throw error;
        }
        if (isExactBwrapProcess(existing) || isBwrapProcessGroupAlive(existing.pid)) {
            if (isExactBwrapProcess(existing)
                && existing.pid === numericPid
                && existing.processIdentity === processIdentity
                && existing.instanceId === identity.instanceId
                && existing.enableGeneration === identity.enableGeneration
            ) {
                return;
            }
            const error = new Error(`sandbox runtime ${normalized} is already bound to a live process`);
            error.code = 'PLOINKY_SANDBOX_PID_SLOT_BUSY';
            throw error;
        }
        clearBwrapPid(normalized);
    }
    ensurePidDir();
    const pidFile = getPidFile(normalized);
    const tempFile = path.join(
        BWRAP_PIDS_DIR,
        `.${normalized}.${process.pid}.${Date.now()}.tmp`,
    );
    const payload = `${JSON.stringify({
        schemaVersion: BWRAP_PID_SCHEMA_VERSION,
        runtimeKey: normalized,
        pid: numericPid,
        processIdentity,
        instanceId: identity.instanceId,
        enableGeneration: identity.enableGeneration,
    })}\n`;
    try {
        fs.writeFileSync(tempFile, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        try {
            // A hard-link publish is atomic and never replaces an ownership
            // record created by a concurrent launcher.
            fs.linkSync(tempFile, pidFile);
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            const busy = new Error(`sandbox runtime ${normalized} PID slot was claimed concurrently`);
            busy.code = 'PLOINKY_SANDBOX_PID_SLOT_BUSY';
            throw busy;
        }
        fs.chmodSync(pidFile, 0o600);
    } finally {
        try { fs.unlinkSync(tempFile); } catch (_) { }
    }
}

function clearBwrapPid(runtimeKey) {
    const pidFile = getPidFile(runtimeKey);
    try { fs.unlinkSync(pidFile); } catch (_) { }
}

function isExactBwrapProcess(record) {
    if (!record) return false;
    try {
        process.kill(record.pid, 0);
    } catch (error) {
        if (error?.code !== 'EPERM') return false;
    }
    return readProcessIdentity(record.pid) === record.processIdentity;
}

function isBwrapProcessGroupAlive(pid) {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

function isBwrapProcessRunning(runtimeKey, expectedIdentity = undefined) {
    const record = readBwrapPidRecord(runtimeKey);
    if (!isExactBwrapProcess(record)) {
        if (record && isBwrapProcessGroupAlive(record.pid)) {
            return recordMatchesRuntimeIdentity(record, expectedIdentity);
        }
        // A stale or PID-reused record never grants ownership of the process.
        if (record) clearBwrapPid(runtimeKey);
        return false;
    }
    return recordMatchesRuntimeIdentity(record, expectedIdentity);
}

function isPidAlive(entry) {
    return isExactBwrapProcess(entry) || isBwrapProcessGroupAlive(entry.pid);
}

function samePidRecord(left, right) {
    return Boolean(left && right)
        && left.runtimeKey === right.runtimeKey
        && left.pid === right.pid
        && left.processIdentity === right.processIdentity
        && left.instanceId === right.instanceId
        && left.enableGeneration === right.enableGeneration;
}

function clearBwrapPidIfExact(entry) {
    const current = readBwrapPidRecord(entry?.runtimeKey);
    if (!samePidRecord(current, entry)) return false;
    clearBwrapPid(entry.runtimeKey);
    return true;
}

function sendSignalToBwrapEntry(entry, signal) {
    const { runtimeKey, pid } = entry;
    if (!isExactBwrapProcess(entry)) {
        if (isBwrapProcessGroupAlive(pid)) {
            // The leader disappeared after its identity was captured, but a
            // descendant still owns the group. Retain the record and fail
            // closed rather than claiming that the sandbox has stopped.
            return false;
        }
        clearBwrapPidIfExact(entry);
        entry.stopped = true;
        return true;
    }
    try {
        process.kill(-pid, signal);
        console.log(`[bwrap] ${runtimeKey}: sent ${signal} to process group ${pid}`);
        return true;
    } catch (e) {
        if (e?.code === 'ESRCH') {
            console.log(`[bwrap] ${runtimeKey}: process ${pid} already exited`);
            clearBwrapPidIfExact(entry);
            entry.stopped = true;
            return true;
        }
        // EPERM can happen when the process group signal is denied; try the root PID.
        try {
            if (!isExactBwrapProcess(entry)) {
                clearBwrapPidIfExact(entry);
                entry.stopped = true;
                return true;
            }
            process.kill(pid, signal);
            console.log(`[bwrap] ${runtimeKey}: sent ${signal} to process ${pid}`);
            return true;
        } catch (e2) {
            if (e2?.code === 'ESRCH') {
                clearBwrapPidIfExact(entry);
                entry.stopped = true;
                return true;
            }
            debugLog(`[bwrap] ${runtimeKey}: kill failed: ${e2?.message || e2}`);
            return false;
        }
    }
}

function stopBwrapProcesses(runtimeKeys, {
    signal = 'SIGTERM',
    timeout = 5000,
    expectedIdentities = undefined,
} = {}) {
    if (!Array.isArray(runtimeKeys) || !runtimeKeys.length) return [];

    const entries = [];
    const seen = new Set();
    for (const requestedKey of runtimeKeys) {
        const runtimeKey = normalizeBwrapRuntimeKey(requestedKey);
        if (seen.has(runtimeKey)) continue;
        seen.add(runtimeKey);

        const record = readBwrapPidRecord(runtimeKey);
        const exactLeader = isExactBwrapProcess(record);
        const orphanedGroup = Boolean(record && !exactLeader
            && isBwrapProcessGroupAlive(record.pid));
        if (!record || (!exactLeader && !orphanedGroup)) {
            debugLog(`[bwrap] ${runtimeKey}: no exact live PID record found`);
            if (record) clearBwrapPid(runtimeKey);
            continue;
        }
        const expectedIdentity = expectedIdentities instanceof Map
            ? expectedIdentities.get(runtimeKey)
            : undefined;
        if (expectedIdentity !== undefined && !recordMatchesRuntimeIdentity(record, expectedIdentity)) {
            debugLog(`[bwrap] ${runtimeKey}: exact generation does not own the live PID record`);
            continue;
        }
        entries.push({
            ...record,
            stopped: false,
            terminationBlocked: orphanedGroup,
        });
    }

    for (const entry of entries) {
        sendSignalToBwrapEntry(entry, signal);
    }

    const deadline = Date.now() + Math.max(0, timeout);
    while (Date.now() < deadline) {
        let hasRunningProcesses = false;
        for (const entry of entries) {
            if (entry.stopped || entry.terminationBlocked) continue;
            if (isPidAlive(entry)) {
                hasRunningProcesses = true;
                continue;
            }
            console.log(`[bwrap] ${entry.runtimeKey}: process ${entry.pid} exited`);
            clearBwrapPidIfExact(entry);
            entry.stopped = true;
        }
        if (!hasRunningProcesses) break;
        sleepMs(200);
    }

    for (const entry of entries) {
        if (entry.stopped || entry.terminationBlocked) continue;
        if (isExactBwrapProcess(entry) || isBwrapProcessGroupAlive(entry.pid)) {
            console.log(`[bwrap] ${entry.runtimeKey}: force killing process ${entry.pid}`);
            try { process.kill(-entry.pid, 'SIGKILL'); } catch (_) { }
            if (isExactBwrapProcess(entry)) {
                try { process.kill(entry.pid, 'SIGKILL'); } catch (_) { }
            }
        }
        // Never erase the only process-identity evidence while that exact
        // sandbox leader is still alive. Strict source-transition callers use
        // the retained record to fail closed instead of reporting a successful
        // stop after a rejected or ineffective SIGKILL.
        if (isExactBwrapProcess(entry) || isBwrapProcessGroupAlive(entry.pid)) continue;
        clearBwrapPidIfExact(entry);
        entry.stopped = true;
    }

    return entries.filter((entry) => entry.stopped).map((entry) => entry.runtimeKey);
}

function stopBwrapProcess(runtimeKey, {
    signal = 'SIGTERM',
    timeout = 5000,
    expectedIdentity = undefined,
} = {}) {
    const normalized = normalizeBwrapRuntimeKey(runtimeKey);
    const expectedIdentities = expectedIdentity === undefined
        ? undefined
        : new Map([[normalized, normalizeSandboxRuntimeIdentity(expectedIdentity)]]);
    return stopBwrapProcesses([normalized], { signal, timeout, expectedIdentities }).includes(normalized);
}

function stopAllBwrapProcesses() {
    if (!fs.existsSync(BWRAP_PIDS_DIR)) return [];
    const runtimeKeys = fs.readdirSync(BWRAP_PIDS_DIR)
        .filter((file) => file.endsWith('.pid'))
        .map((file) => file.slice(0, -'.pid'.length));
    return stopBwrapProcesses(runtimeKeys);
}

export {
    BWRAP_PIDS_DIR,
    BWRAP_PID_SCHEMA_VERSION,
    normalizeBwrapRuntimeKey,
    normalizeSandboxRuntimeIdentity,
    assertBwrapPidSlotAvailable,
    getBwrapPid,
    saveBwrapPid,
    clearBwrapPid,
    hasBwrapPidRecord,
    hasInvalidBwrapPidRecord,
    isBwrapProcessRunning,
    stopBwrapProcesses,
    stopBwrapProcess,
    stopAllBwrapProcesses
};
