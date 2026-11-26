import fs from 'node:fs';
import crypto from 'node:crypto';
import { supervisedPaths } from './supervisionWorkspace.mjs';
import { stallNudge, taskDelivery } from './supervisionRoles.mjs';
import { readTaskRevision } from './supervisionWorkspace.mjs';

// The courier is the only part of a supervised session that writes into a
// terminal on its own: it turns a new revision of `tasks.md` into a prompt for
// the worker, and it reports a worker that has gone quiet. It never writes a
// task file, never closes a terminal and never decides that a revision is done.
export const SUPERVISION_COURIER_DEFAULTS = Object.freeze({
    intervalMs: 2_000,
    activityMs: 15_000,
    stallMs: 300_000,
});

export function createSupervisionCourier({
    folder,
    pairId = '',
    workerTerminalId,
    readRevision = readTaskRevision,
    deliver,
    notifySupervisor,
    readResults = folder => {
        try { return fs.readFileSync(supervisedPaths(folder).results, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
    },
    activity,
    onStatus = () => {},
    onDelivered = () => {},
    startRev = null,
    now = () => Date.now(),
    intervalMs = SUPERVISION_COURIER_DEFAULTS.intervalMs,
    activityMs = SUPERVISION_COURIER_DEFAULTS.activityMs,
    stallMs = SUPERVISION_COURIER_DEFAULTS.stallMs,
    setTimer = (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer = timer => clearTimeout(timer),
} = {}) {
    if (typeof deliver !== 'function') throw new Error('A supervision courier needs a delivery channel');
    let stopped = true;
    let timer = null;
    let currentRev = Number.isSafeInteger(startRev) && startRev >= 0 ? startRev : null;
    let nudgedRev = null;
    let lastActivityCheck = 0;
    let status = '';
    let lastError = '';
    let resultHash = '';
    let inFlight = null;

    const publish = (value) => {
        if (value === status) return;
        status = value;
        try { onStatus(value); } catch (_) { /* A display failure never stops delivery. */ }
    };

    async function checkRevision() {
        const { rev, missing } = await readRevision(folder);
        if (missing) { publish('tasks.md does not exist yet'); return; }
        if (rev === null) { publish('tasks.md has no rev: line, nothing delivered'); return; }
        if (currentRev !== null && rev <= currentRev) return;
        await deliver(taskDelivery(rev));
        currentRev = rev;
        try { onDelivered(rev); } catch (_) { /* the record is a convenience, not the delivery */ }
        publish(`rev ${rev} delivered to the worker`);
    }

    async function checkActivity() {
        if (typeof activity !== 'function') return;
        const row = await activity(workerTerminalId);
        if (!row) { publish('the worker terminal is not running'); return; }
        if (currentRev === null || nudgedRev === currentRev) return;
        const silence = now() - (Number.isFinite(row.lastActivityAt) ? row.lastActivityAt : now());
        if (silence < stallMs) return;
        const minutes = Math.max(1, Math.round(silence / 60_000));
        await deliver(stallNudge(minutes));
        if (notifySupervisor) await notifySupervisor(`[worker status] Worker terminal silent for ${minutes} minutes on rev ${currentRev}. Inspect results.md and report progress or blockers to the user.`);
        nudgedRev = currentRev;
        publish(`worker silent for ${minutes}m, one nudge sent`);
    }

    // One pass over the task file and the worker's activity. A manual pass runs
    // even after `stop()`; only the scheduled loop stops.
    async function checkResults() {
        if (!notifySupervisor || currentRev === null) return;
        const text = await readResults(folder);
        if (!text || !text.includes(`rev: ${currentRev}`)) return;
        const hash = crypto.createHash('sha256').update(text).digest('hex');
        if (hash === resultHash) return;
        await notifySupervisor(`[worker results] results.md changed for rev ${currentRev}. Read it, report progress to the user, and review the actual diff and tests before accepting completion. Request corrections through a new tasks.md revision if needed.`);
        resultHash = hash;
    }

    async function pass() {
        try {
            await checkRevision();
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
        deliveredRev: () => currentRev,
        once,
        tick,
        get stopped() { return stopped; },
    };
}
