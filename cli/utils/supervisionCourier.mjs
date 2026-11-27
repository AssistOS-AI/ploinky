import fs from 'node:fs';
import crypto from 'node:crypto';
import { supervisedPaths } from './supervisionWorkspace.mjs';

// The courier is the only part of a supervised session that writes into a
// terminal on its own: it reports results and a worker that has gone quiet.
// Task delivery belongs exclusively to the supervisor through worker_send. It never writes a
// task file, never closes a terminal and never derives task state from history files.
export const SUPERVISION_COURIER_DEFAULTS = Object.freeze({
    intervalMs: 2_000,
    activityMs: 15_000,
    stallMs: 600_000,
});

export function createSupervisionCourier({
    folder,
    pairId = '',
    workerTerminalId,
    notifySupervisor,
    readResults = folder => {
        try { return fs.readFileSync(supervisedPaths(folder).results, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
    },
    activity,
    onStatus = () => {},
    now = () => Date.now(),
    intervalMs = SUPERVISION_COURIER_DEFAULTS.intervalMs,
    activityMs = SUPERVISION_COURIER_DEFAULTS.activityMs,
    stallMs = SUPERVISION_COURIER_DEFAULTS.stallMs,
    setTimer = (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer = timer => clearTimeout(timer),
} = {}) {
    let stopped = true;
    let timer = null;
    let monitoring = false;
    let alertedActivity = null;
    let deliveredAt = now();
    let lastActivityCheck = 0;
    let status = '';
    let lastError = '';
    let resultHash = null;
    let inFlight = null;

    const publish = (value) => {
        if (value === status) return;
        status = value;
        try { onStatus(value); } catch (_) { /* A display failure never stops delivery. */ }
    };

    async function sent() {
        monitoring = true;
        deliveredAt = now();
        alertedActivity = null;
        // Existing history is not a report about the newly sent instructions.
        try { resultHash = crypto.createHash('sha256').update(await readResults(folder)).digest('hex'); }
        catch { resultHash = null; }
        publish('instructions delivered by supervisor through MCP');
    }

    async function checkActivity() {
        if (typeof activity !== 'function') return;
        const row = await activity(workerTerminalId);
        if (!row) { publish('the worker terminal is not running'); return; }
        if (!monitoring || typeof notifySupervisor !== 'function') return;
        // Input, resize and attach activity cannot postpone an output-silence alarm.
        // An older server without this field cannot provide a reliable output clock.
        if (!Object.hasOwn(row, 'lastOutputAt')) { publish('worker output monitoring requires an updated terminal server'); return; }
        const lastOutput = Math.max(deliveredAt, Number.isFinite(row.lastOutputAt) ? row.lastOutputAt : deliveredAt);
        const silence = now() - lastOutput;
        if (silence < stallMs || alertedActivity === lastOutput) return;
        const minutes = Math.max(1, Math.floor(silence / 60_000));
        await notifySupervisor(`[worker status] No worker terminal output for ${minutes} minutes after instructions were sent. `
            + 'Inspect results.md, the current code and any available worker status to determine whether it is blocked or still working. '
            + 'Silence alone is not proof of a block. If it is blocked, interrupt its current execution through an available worker control, '
            + 'then append the corrective instructions to tasks.md and send a different approach through worker_send. If no worker control is available, ask the user to interrupt it. '
            + 'Report your findings and action to the user.');
        alertedActivity = lastOutput;
        publish(`worker silent for ${minutes}m, supervisor notified`);
    }

    // One pass over the results file and the worker's activity. A manual pass runs
    // even after `stop()`; only the scheduled loop stops.
    async function checkResults() {
        if (!notifySupervisor || !monitoring) return;
        const text = await readResults(folder);
        const hash = crypto.createHash('sha256').update(text).digest('hex');
        if (resultHash === null) { resultHash = hash; return; }
        if (hash === resultHash) return;
        await notifySupervisor('[worker results] results.md history changed. Read the new entries, report progress to the user, and inspect the actual code and tests. Historical entries do not establish the current task state. Send any corrective instructions through worker_send and append them to tasks.md.');
        resultHash = hash;
    }

    async function pass() {
        try {
            await checkResults();
            if (now() - lastActivityCheck >= activityMs) {
                lastActivityCheck = now();
                await checkActivity();
            }
            lastError = '';
        } catch (error) {
            const message = error?.message || String(error);
            if (message !== lastError) publish(`delivery failed: ${message}`);
            lastError = message;
        }
    }

    function once() {
        if (!inFlight) inFlight = pass().finally(() => { inFlight = null; });
        return inFlight;
    }

    async function tick() {
        if (stopped) return;
        await once();
        if (!stopped) timer = setTimer(() => { void tick(); }, intervalMs);
        timer?.unref?.();
    }

    return {
        pairId,
        sent,
        start() {
            if (!stopped) return;
            stopped = false;
            void tick();
        },
        stop() {
            stopped = true;
            if (timer) clearTimer(timer);
            timer = null;
        },
        status: () => status,
        once,
        tick,
        get stopped() { return stopped; },
    };
}
