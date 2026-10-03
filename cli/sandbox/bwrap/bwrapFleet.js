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
const SANDBOX_POLL_INTERVAL_MS = 50;
const SANDBOX_KILL_WAIT_MS = 3000;
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


// Process inspection and signalling go through this table so tests can inject
// denied signals, an unavailable identity probe or a fake clock without ever
// signalling a process they did not create. Every member is resolved at call
// time; production callers never pass `ops`.
const DEFAULT_PROCESS_OPS = Object.freeze({
    kill: (pid, signal) => process.kill(pid, signal),
    readProcStat: (pid) => fs.readFileSync(`/proc/${pid}/stat`, 'utf8'),
    runPs: (pid) => execFileSync('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    }),
    sleep: sleepMs,
    now: () => Date.now(),
});

function resolveProcessOps(ops) {
    return ops ? { ...DEFAULT_PROCESS_OPS, ...ops } : DEFAULT_PROCESS_OPS;
}

function parseProcStat(stat) {
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return null;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const state = String(fields[0] || '').trim();
    const startTicks = String(fields[19] || '').trim();
    return state && startTicks ? { state, identity: `linux-proc:${startTicks}` } : null;
}

function parsePsOutput(output) {
    const match = /^(\S+)\s+(.+)$/.exec(String(output || '').trim());
    return match
        ? { state: match[1], identity: `ps-lstart:${match[2].replace(/\s+/g, ' ')}` }
        : null;
}

// One bounded probe of a PID: `absent` (no such process, or only a zombie),
// `alive` (with its start identity) or `unknown`. A failed identity probe is
// never absence unless the PID itself is then reported gone.
function probeSandboxPid(pid, ops) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown', reason: 'invalid-pid' };
    const signalProbe = () => {
        try {
            ops.kill(pid, 0);
            return 'alive';
        } catch (error) {
            if (error?.code === 'ESRCH') return 'absent';
            if (error?.code === 'EPERM') return 'alive';
            return `error:${error?.code || 'unknown'}`;
        }
    };
    const first = signalProbe();
    if (first === 'absent') return { state: 'absent', reason: 'no-such-process' };
    if (first.startsWith('error:')) return { state: 'unknown', reason: `signal-probe-${first.slice(6)}` };
    let parsed = null;
    try { parsed = parseProcStat(ops.readProcStat(pid)); } catch (_) { parsed = null; }
    if (!parsed) {
        try { parsed = parsePsOutput(ops.runPs(pid)); } catch (_) { parsed = null; }
    }
    if (!parsed) {
        return signalProbe() === 'absent'
            ? { state: 'absent', reason: 'no-such-process' }
            : { state: 'unknown', reason: 'identity-probe-failed' };
    }
    if (/^[ZX]/.test(parsed.state)) {
        return { state: 'absent', reason: 'zombie', identity: parsed.identity };
    }
    return { state: 'alive', identity: parsed.identity };
}

function readProcessIdentity(pid, ops = DEFAULT_PROCESS_OPS) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return '';
    try {
        const stat = parseProcStat(ops.readProcStat(pid));
        if (stat) return stat.identity;
    } catch (_) { /* fall through to ps */ }
    try {
        return parsePsOutput(ops.runPs(pid))?.identity || '';
    } catch (_) {
        return '';
    }
}

function validPidRecord(parsed, normalized) {
    const pid = Number(parsed?.pid);
    return Boolean(parsed)
        && typeof parsed === 'object'
        && !Array.isArray(parsed)
        && JSON.stringify(Object.keys(parsed).sort()) === JSON.stringify(BWRAP_PID_RECORD_KEYS)
        && parsed.schemaVersion === BWRAP_PID_SCHEMA_VERSION
        && parsed.runtimeKey === normalized
        && typeof parsed.pid === 'number'
        && Number.isSafeInteger(pid)
        && pid > 0
        && typeof parsed.processIdentity === 'string'
        && Boolean(parsed.processIdentity)
        && typeof parsed.instanceId === 'string'
        && Boolean(parsed.instanceId)
        && parsed.instanceId === parsed.instanceId.trim()
        && typeof parsed.enableGeneration === 'string'
        && Boolean(parsed.enableGeneration)
        && parsed.enableGeneration === parsed.enableGeneration.trim();
}

// Reads the PID record without collapsing the failure modes: `absent` is only
// a verified missing record (ENOENT of a record inside a real directory), and
// a record that exists but cannot be trusted is `invalid` or `unreadable`.
function inspectPidRecord(runtimeKey) {
    const normalized = normalizeBwrapRuntimeKey(runtimeKey);
    let directory;
    try {
        directory = fs.lstatSync(BWRAP_PIDS_DIR);
    } catch (error) {
        if (error?.code === 'ENOENT') return { status: 'absent', reason: 'pid-directory-missing' };
        return { status: 'unreadable', reason: `pid-directory-${error?.code || 'unreadable'}` };
    }
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
        return { status: 'unreadable', reason: 'pid-directory-not-a-real-directory' };
    }
    const pidFile = getPidFile(normalized);
    let stat;
    try {
        stat = fs.lstatSync(pidFile);
    } catch (error) {
        if (error?.code === 'ENOENT') return { status: 'absent', reason: 'no-record' };
        return { status: 'unreadable', reason: `record-${error?.code || 'unreadable'}` };
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        return { status: 'unreadable', reason: 'record-not-a-regular-file' };
    }
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return { status: 'absent', reason: 'no-record' };
        return error instanceof SyntaxError
            ? { status: 'invalid', reason: 'record-unparseable' }
            : { status: 'unreadable', reason: `record-${error?.code || 'unreadable'}` };
    }
    if (!validPidRecord(parsed, normalized)) return { status: 'invalid', reason: 'record-schema-invalid' };
    return {
        status: 'valid',
        record: Object.freeze({
            runtimeKey: normalized,
            pid: Number(parsed.pid),
            processIdentity: parsed.processIdentity,
            instanceId: parsed.instanceId,
            enableGeneration: parsed.enableGeneration,
        }),
    };
}

function readBwrapPidRecord(runtimeKey) {
    const inspected = inspectPidRecord(runtimeKey);
    return inspected.status === 'valid' ? inspected.record : null;
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

function samePidRecord(left, right) {
    return Boolean(left && right)
        && left.runtimeKey === right.runtimeKey
        && left.pid === right.pid
        && left.processIdentity === right.processIdentity
        && left.instanceId === right.instanceId
        && left.enableGeneration === right.enableGeneration;
}

function clearBwrapPid(runtimeKey) {
    const pidFile = getPidFile(runtimeKey);
    try { fs.unlinkSync(pidFile); } catch (_) { }
}

// Compare-and-delete: the record goes only if it still is the one observed.
function clearBwrapPidIfExact(entry) {
    const current = readBwrapPidRecord(entry?.runtimeKey);
    if (!samePidRecord(current, entry)) return false;
    clearBwrapPid(entry.runtimeKey);
    return true;
}

function observation(state, record, reason) {
    return Object.freeze({ state, record: record || null, reason });
}

/**
 * Structured observation of the sandbox that owns one runtime key.
 *
 * `absent`: no record, or a record whose process is gone (exited, a zombie, or
 *   a reused PID with another start identity).
 * `live-exact`: the recorded process is alive; with `expectedIdentity` it also
 *   carries exactly that instanceId/enableGeneration.
 * `live-foreign`: the recorded process is alive under another tuple.
 * `unknown`: the record or the process could not be inspected. Never absence.
 *
 * It never deletes anything. `record` is returned for every state that found
 * one, so callers can compare-and-delete a stale record after `absent`.
 */
function observeSandboxRuntime(runtimeKey, { expectedIdentity = undefined, ops } = {}) {
    const key = normalizeBwrapRuntimeKey(runtimeKey);
    const expected = expectedIdentity === undefined
        ? undefined
        : normalizeSandboxRuntimeIdentity(expectedIdentity);
    const inspected = inspectPidRecord(key);
    if (inspected.status === 'absent') return observation('absent', null, inspected.reason);
    if (inspected.status !== 'valid') {
        return observation(
            'unknown',
            null,
            inspected.status === 'invalid' ? 'invalid-record' : 'record-unreadable',
        );
    }
    const record = inspected.record;
    const probe = probeSandboxPid(record.pid, resolveProcessOps(ops));
    if (probe.state === 'unknown') return observation('unknown', record, probe.reason);
    if (probe.state === 'absent') {
        return observation('absent', record, probe.reason === 'zombie' ? 'stale-record-zombie' : 'stale-record');
    }
    if (probe.identity !== record.processIdentity) {
        return observation('absent', record, 'stale-record-pid-reused');
    }
    return recordMatchesRuntimeIdentity(record, expected)
        ? observation('live-exact', record, 'live')
        : observation('live-foreign', record, 'foreign-tuple');
}

function slotError(runtimeKey, message, code) {
    const error = new Error(`sandbox runtime ${runtimeKey} ${message}`);
    error.code = code;
    return error;
}

function assertBwrapPidSlotAvailable(runtimeKey) {
    const normalized = normalizeBwrapRuntimeKey(runtimeKey);
    const observed = observeSandboxRuntime(normalized);
    if (observed.state === 'absent') {
        if (observed.record) clearBwrapPidIfExact(observed.record);
        return;
    }
    if (observed.state === 'unknown') {
        if (observed.reason === 'invalid-record') {
            throw slotError(
                normalized,
                `has an invalid or pre-v${BWRAP_PID_SCHEMA_VERSION} PID record; remove it only after confirming no sandbox process still owns the runtime`,
                'PLOINKY_SANDBOX_PID_RECORD_INVALID',
            );
        }
        throw slotError(
            normalized,
            `ownership could not be verified (${observed.reason}); refusing to replace its PID record`,
            'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS',
        );
    }
    throw slotError(normalized, 'is already bound to a live process', 'PLOINKY_SANDBOX_PID_SLOT_BUSY');
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
    let existingPresent = true;
    try { fs.lstatSync(existingFile); } catch (error) {
        if (error?.code === 'ENOENT') existingPresent = false;
    }
    if (existingPresent) {
        const observed = observeSandboxRuntime(normalized);
        if (observed.state === 'unknown') {
            throw observed.reason === 'invalid-record'
                ? slotError(
                    normalized,
                    `has an invalid or pre-v${BWRAP_PID_SCHEMA_VERSION} PID record; refusing to replace it`,
                    'PLOINKY_SANDBOX_PID_RECORD_INVALID',
                )
                : slotError(
                    normalized,
                    `ownership could not be verified (${observed.reason}); refusing to replace its PID record`,
                    'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS',
                );
        }
        if (observed.state === 'live-exact') {
            const existing = observed.record;
            if (
                existing.pid === numericPid
                && existing.processIdentity === processIdentity
                && existing.instanceId === identity.instanceId
                && existing.enableGeneration === identity.enableGeneration
            ) {
                return;
            }
            throw slotError(normalized, 'is already bound to a live process', 'PLOINKY_SANDBOX_PID_SLOT_BUSY');
        }
        if (observed.record) clearBwrapPidIfExact(observed.record);
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
            throw slotError(normalized, 'PID slot was claimed concurrently', 'PLOINKY_SANDBOX_PID_SLOT_BUSY');
        }
        fs.chmodSync(pidFile, 0o600);
    } finally {
        try { fs.unlinkSync(tempFile); } catch (_) { }
    }
}

// True only for a verified live process with the expected tuple. A stale
// record (exited, zombie, reused PID) is removed by compare-and-delete; an
// unknown observation leaves the record exactly as found.
function isBwrapProcessRunning(runtimeKey, expectedIdentity = undefined) {
    const observed = observeSandboxRuntime(runtimeKey, { expectedIdentity });
    if (observed.state === 'absent' && observed.record) clearBwrapPidIfExact(observed.record);
    return observed.state === 'live-exact';
}

// Whether the recorded process still is that exact process: `live`, `gone`
// (exited, a zombie, or a reused PID) or `unknown`.
function entryLiveness(entry, ops) {
    const probe = probeSandboxPid(entry.pid, ops);
    if (probe.state === 'unknown') return 'unknown';
    if (probe.state === 'absent') return 'gone';
    return probe.identity === entry.processIdentity ? 'live' : 'gone';
}

// The owner is compared again immediately before every signal: the record must
// still be the captured one and its process must still be that process.
function verifySandboxOwner(entry, ops) {
    const current = inspectPidRecord(entry.runtimeKey);
    const liveness = () => entryLiveness(entry, ops);
    if (current.status === 'absent' || (current.status === 'valid' && !samePidRecord(current.record, entry))) {
        return liveness() === 'gone' ? 'gone' : 'changed';
    }
    if (current.status !== 'valid') return 'unknown';
    return liveness();
}

function signalSandboxEntry(entry, signal, ops) {
    const owner = verifySandboxOwner(entry, ops);
    if (owner !== 'live') return { outcome: owner, reason: `owner-${owner}` };
    try {
        ops.kill(-entry.pid, signal);
        console.log(`[bwrap] ${entry.runtimeKey}: sent ${signal} to process group ${entry.pid}`);
        return { outcome: 'sent', reason: 'group' };
    } catch (groupError) {
        // ESRCH only proves no group is led by this PID; EPERM may be partial.
        // Either way the leader is signalled, after the owner is re-observed.
        const again = verifySandboxOwner(entry, ops);
        if (again !== 'live') return { outcome: again, reason: `owner-${again}` };
        try {
            ops.kill(entry.pid, signal);
            console.log(`[bwrap] ${entry.runtimeKey}: sent ${signal} to process ${entry.pid}`);
            return { outcome: 'sent', reason: 'leader' };
        } catch (leaderError) {
            if (leaderError?.code === 'ESRCH') {
                const last = verifySandboxOwner(entry, ops);
                return last === 'live'
                    ? { outcome: 'denied', reason: 'signal-not-delivered' }
                    : { outcome: last, reason: `owner-${last}` };
            }
            debugLog(`[bwrap] ${entry.runtimeKey}: kill failed: ${leaderError?.message || leaderError}`);
            return {
                outcome: 'denied',
                reason: `signal-denied-${leaderError?.code || groupError?.code || 'error'}`,
            };
        }
    }
}

function waitForSandboxExit(items, timeoutMs, ops) {
    const deadline = ops.now() + Math.max(0, timeoutMs);
    for (;;) {
        let waiting = false;
        for (const item of items) {
            if (item.exited) continue;
            const liveness = entryLiveness(item.entry, ops);
            if (liveness === 'gone') item.exited = true;
            else waiting = true;
        }
        if (!waiting) return;
        const remaining = deadline - ops.now();
        if (remaining <= 0) return;
        ops.sleep(Math.min(SANDBOX_POLL_INTERVAL_MS, remaining));
    }
}

function stopOutcome(state, reason, record = null) {
    return Object.freeze({ state, reason, record });
}

/**
 * Stops the exact sandboxes named by `requests` ({ runtimeKey, expectedIdentity }).
 *
 * Only a `live-exact` observation is ever signalled. A process is `stopped`
 * only once it is observed gone, and only then is its record removed, by
 * compare-and-delete. A foreign tuple is `refused` untouched; denied signals,
 * a survivor or an unknown observation are `failed` and keep their record.
 * Returns a Map of runtimeKey to { state: absent|stopped|refused|failed, reason, record }.
 */
function stopExactSandboxProcesses(requests, {
    signal = 'SIGTERM',
    timeout = 5000,
    killTimeout = SANDBOX_KILL_WAIT_MS,
    ops,
} = {}) {
    const resolvedOps = resolveProcessOps(ops);
    const results = new Map();
    const pending = [];
    for (const request of Array.isArray(requests) ? requests : []) {
        const runtimeKey = normalizeBwrapRuntimeKey(request?.runtimeKey);
        if (results.has(runtimeKey) || pending.some((item) => item.runtimeKey === runtimeKey)) continue;
        const observed = observeSandboxRuntime(runtimeKey, {
            expectedIdentity: request.expectedIdentity,
            ops: resolvedOps,
        });
        if (observed.state === 'absent') {
            if (observed.record) clearBwrapPidIfExact(observed.record);
            results.set(runtimeKey, stopOutcome('absent', observed.reason, observed.record));
        } else if (observed.state === 'unknown') {
            results.set(runtimeKey, stopOutcome('failed', `observation-unknown:${observed.reason}`, observed.record));
        } else if (observed.state === 'live-foreign') {
            results.set(runtimeKey, stopOutcome('refused', 'foreign-tuple', observed.record));
        } else {
            pending.push({ runtimeKey, entry: observed.record, exited: false });
        }
    }

    const fail = (item, reason) => {
        item.settled = true;
        results.set(item.runtimeKey, stopOutcome('failed', reason, item.entry));
    };
    for (const item of pending) {
        const sent = signalSandboxEntry(item.entry, signal, resolvedOps);
        if (sent.outcome === 'gone') item.exited = true;
        else if (sent.outcome !== 'sent') fail(item, sent.reason);
    }
    waitForSandboxExit(pending.filter((item) => !item.settled), timeout, resolvedOps);

    const survivors = pending.filter((item) => !item.settled && !item.exited);
    for (const item of survivors) {
        console.log(`[bwrap] ${item.runtimeKey}: force killing process ${item.entry.pid}`);
        const sent = signalSandboxEntry(item.entry, 'SIGKILL', resolvedOps);
        if (sent.outcome === 'gone') item.exited = true;
        else if (sent.outcome !== 'sent') fail(item, sent.reason);
    }
    waitForSandboxExit(survivors.filter((item) => !item.settled), killTimeout, resolvedOps);

    for (const item of pending) {
        if (item.settled) continue;
        const liveness = item.exited ? 'gone' : entryLiveness(item.entry, resolvedOps);
        if (liveness === 'gone') {
            clearBwrapPidIfExact(item.entry);
            console.log(`[bwrap] ${item.runtimeKey}: process ${item.entry.pid} exited`);
            results.set(item.runtimeKey, stopOutcome('stopped', 'exited', item.entry));
        } else {
            fail(item, liveness === 'live' ? 'still-alive-after-kill' : 'liveness-unknown-after-kill');
        }
    }
    return results;
}

function stopExactSandboxProcess(runtimeKey, expectedIdentity, options = {}) {
    const key = normalizeBwrapRuntimeKey(runtimeKey);
    return stopExactSandboxProcesses([{ runtimeKey: key, expectedIdentity }], options).get(key);
}

function stopBwrapProcesses(runtimeKeys, {
    signal = 'SIGTERM',
    timeout = 5000,
    expectedIdentities = undefined,
} = {}) {
    if (!Array.isArray(runtimeKeys) || !runtimeKeys.length) return [];
    const requests = runtimeKeys.map((requestedKey) => {
        const runtimeKey = normalizeBwrapRuntimeKey(requestedKey);
        return {
            runtimeKey,
            expectedIdentity: expectedIdentities instanceof Map
                ? expectedIdentities.get(runtimeKey)
                : undefined,
        };
    });
    const results = stopExactSandboxProcesses(requests, { signal, timeout });
    for (const [runtimeKey, result] of results) {
        if (result.state === 'refused' || result.state === 'failed') {
            debugLog(`[bwrap] ${runtimeKey}: not stopped (${result.state}: ${result.reason})`);
        }
    }
    return [...results].filter(([, result]) => result.state === 'stopped').map(([runtimeKey]) => runtimeKey);
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

// The exact tuple a registry record names, or null when it has none. Callers
// that replace a registered runtime pass it as `expectedPredecessor`.
function registeredRuntimeTuple(record) {
    const instanceId = typeof record?.instanceId === 'string' ? record.instanceId : '';
    const enableGeneration = typeof record?.enableGeneration === 'string' ? record.enableGeneration : '';
    if (!instanceId || !enableGeneration
        || instanceId !== instanceId.trim() || enableGeneration !== enableGeneration.trim()) {
        return null;
    }
    return Object.freeze({ instanceId, enableGeneration });
}

/**
 * Which backend owns the runtime a registry record describes. A record that
 * names a native runtime is native and one that names a container engine is a
 * container. A record that names no runtime (a prepared record that was never
 * finalized) selects nothing by itself: it is native only when the PID record
 * of its exact tuple proves a native owner (live, or stale for that tuple). An
 * unverifiable slot is `unknown`, never a container.
 * Returns { kind: 'native' | 'container' | 'unknown', observation }.
 */
function classifyRecordRuntime(runtimeKey, record, { ops } = {}) {
    const runtime = String(record?.runtime || '');
    if (runtime === 'seatbelt' || runtime === 'bwrap') return { kind: 'native', observation: null };
    if (runtime) return { kind: 'container', observation: null };
    const tuple = registeredRuntimeTuple(record);
    if (!tuple) return { kind: 'container', observation: null };
    const observed = observeSandboxRuntime(runtimeKey, { expectedIdentity: tuple, ops });
    if (observed.state === 'unknown') return { kind: 'unknown', observation: observed };
    const carriesTuple = observed.record
        && observed.record.instanceId === tuple.instanceId
        && observed.record.enableGeneration === tuple.enableGeneration;
    if (observed.state === 'live-exact' || (observed.state === 'absent' && carriesTuple)) {
        return { kind: 'native', observation: observed };
    }
    return { kind: 'container', observation: observed };
}

function normalizeExpectedPredecessor(expectedPredecessor) {
    if (expectedPredecessor === undefined || expectedPredecessor === null) return null;
    return normalizeSandboxRuntimeIdentity(expectedPredecessor);
}

/**
 * Decides what the slot of one runtime key holds for a launch of `successor`.
 * `empty`: nothing live. `successor`: the exact requested tuple. `predecessor`:
 * the tuple the caller named as `expectedPredecessor`. Any other live tuple, or
 * an unknown slot, throws before a signal is sent or a record is touched.
 */
function resolveSandboxSlotForStart(runtimeKey, { successor, expectedPredecessor = null, ops } = {}) {
    const key = normalizeBwrapRuntimeKey(runtimeKey);
    const wantedSuccessor = successor === undefined ? null : normalizeSandboxRuntimeIdentity(successor);
    const predecessor = normalizeExpectedPredecessor(expectedPredecessor);
    const observed = observeSandboxRuntime(key, { ops });
    if (observed.state === 'absent') return Object.freeze({ kind: 'empty', observation: observed });
    if (observed.state === 'unknown') {
        throw observed.reason === 'invalid-record'
            ? slotError(
                key,
                `has an invalid or pre-v${BWRAP_PID_SCHEMA_VERSION} PID record; remove it only after confirming no sandbox process still owns the runtime`,
                'PLOINKY_SANDBOX_PID_RECORD_INVALID',
            )
            : slotError(
                key,
                `ownership could not be verified (${observed.reason}); no signal was sent and its PID record was kept`,
                'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS',
            );
    }
    const record = observed.record;
    const matches = (identity) => Boolean(identity)
        && record.instanceId === identity.instanceId
        && record.enableGeneration === identity.enableGeneration;
    if (matches(wantedSuccessor)) return Object.freeze({ kind: 'successor', observation: observed });
    if (matches(predecessor)) return Object.freeze({ kind: 'predecessor', observation: observed });
    throw slotError(
        key,
        'is bound to a live process that is neither the requested successor nor the expected predecessor; no signal was sent',
        'PLOINKY_SANDBOX_PID_SLOT_BUSY',
    );
}

// A manager stop is only complete once the exact process is observed gone.
function stopExactSandboxOrThrow(runtimeKey, expectedIdentity, options = {}) {
    const result = stopExactSandboxProcess(runtimeKey, expectedIdentity, options);
    if (result.state === 'absent' || result.state === 'stopped') return result;
    const error = slotError(
        normalizeBwrapRuntimeKey(runtimeKey),
        `exact process could not be stopped (${result.state}: ${result.reason}); its PID record was kept`,
        'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS',
    );
    error.stopResult = result;
    throw error;
}

export {
    BWRAP_PIDS_DIR,
    BWRAP_PID_SCHEMA_VERSION,
    normalizeBwrapRuntimeKey,
    normalizeSandboxRuntimeIdentity,
    normalizeExpectedPredecessor,
    registeredRuntimeTuple,
    classifyRecordRuntime,
    assertBwrapPidSlotAvailable,
    getBwrapPid,
    saveBwrapPid,
    clearBwrapPid,
    clearBwrapPidIfExact,
    observeSandboxRuntime,
    resolveSandboxSlotForStart,
    isBwrapProcessRunning,
    stopExactSandboxProcess,
    stopExactSandboxProcesses,
    stopExactSandboxOrThrow,
    stopBwrapProcesses,
    stopBwrapProcess,
    stopAllBwrapProcesses
};
