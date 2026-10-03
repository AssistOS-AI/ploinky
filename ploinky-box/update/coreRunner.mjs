import { spawn } from 'node:child_process';

import { sanitizeReason } from '../../cli/commands/updateOutcome.js';

// Update-specific bounded runner for the in-Box `ploinky-local update`.
//
// Unlike the generic bounded runner it never throws on a nonzero exit: the
// structured report is a separate file and is judged on its own. It owns one
// engine exec client in its own process group, streams subordinate output to
// the operator, keeps only bounded tails for diagnostics, and cancels with a
// finite TERM -> KILL escalation on timeout, output limit or operator signal.
//
// Stopping the host exec client is not proof that the in-Box writer stopped.
// After any abnormal end the runner asks the engine whether processes that
// carry this operation's nonce still run in the Box, escalates against them,
// and reports quiescence as `confirmed` only when the engine says so.

export const UPDATE_RUNNER_DEFAULTS = Object.freeze({
    timeoutMs: 1_800_000,
    termGraceMs: 10_000,
    killGraceMs: 5_000,
    outputLimitBytes: 64 * 1024 * 1024,
    tailBytes: 16 * 1024,
    probeIntervalMs: 500,
});

function appendTail(tail, chunk, limit) {
    const next = Buffer.concat([tail, chunk]);
    return next.length > limit ? next.subarray(next.length - limit) : next;
}

const delay = (ms, setTimeoutImpl) => new Promise(resolve => setTimeoutImpl(resolve, ms));

/**
 * @param {object} options
 * @param {string} options.command engine executable
 * @param {string[]} options.args engine exec arguments
 * @param {(opts: {nonce: string}) => Promise<{ok: boolean, pids?: number[], detail?: string}>|{ok: boolean, pids?: number[], detail?: string}} [options.probe]
 *   engine query for in-Box processes of this operation; `ok: true, pids: []` confirms quiescence
 * @param {(pids: number[], signal: string) => unknown} [options.killInBox]
 */
export async function runUpdateExec({
    command,
    args,
    env,
    nonce,
    stdout = process.stdout,
    stderr = process.stderr,
    probe = null,
    killInBox = null,
    spawnImpl = spawn,
    killGroup = (pid, signal) => process.kill(-pid, signal),
    processRef = process,
    forwardedSignals = ['SIGINT', 'SIGTERM'],
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    timeoutMs = UPDATE_RUNNER_DEFAULTS.timeoutMs,
    termGraceMs = UPDATE_RUNNER_DEFAULTS.termGraceMs,
    killGraceMs = UPDATE_RUNNER_DEFAULTS.killGraceMs,
    outputLimitBytes = UPDATE_RUNNER_DEFAULTS.outputLimitBytes,
    tailBytes = UPDATE_RUNNER_DEFAULTS.tailBytes,
    probeIntervalMs = UPDATE_RUNNER_DEFAULTS.probeIntervalMs,
    probeOnSuccess = false,
} = {}) {
    const client = await new Promise((resolve) => {
        let child;
        let settled = false;
        let cause = 'exited';
        let escalation = null;
        let termTimer = null;
        let killTimer = null;
        let deadline = null;
        let outputBytes = 0;
        let tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        const handlers = new Map();
        const cleanup = () => {
            for (const [signal, handler] of handlers) {
                try { processRef.removeListener(signal, handler); } catch (_) {}
            }
            handlers.clear();
            for (const timer of [deadline, termTimer, killTimer]) if (timer !== null) clearTimeoutImpl(timer);
            deadline = termTimer = killTimer = null;
        };
        const settle = (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({
                ...value,
                cause,
                escalation,
                pid: child?.pid ?? null,
                outputBytes,
                tails: {
                    stdout: sanitizeReason(tails.stdout.toString('utf8'), { limit: tailBytes }),
                    stderr: sanitizeReason(tails.stderr.toString('utf8'), { limit: tailBytes }),
                },
            });
        };
        const signalGroup = (signal) => {
            try {
                killGroup(child.pid, signal);
            } catch (_) {
                try { child.kill(signal); } catch (__) {}
            }
        };
        const cancel = (reason) => {
            if (settled || escalation) return;
            cause = reason;
            escalation = 'SIGTERM';
            signalGroup('SIGTERM');
            termTimer = setTimeoutImpl(() => {
                termTimer = null;
                if (settled) return;
                escalation = 'SIGKILL';
                signalGroup('SIGKILL');
                killTimer = setTimeoutImpl(() => {
                    killTimer = null;
                    // The client did not even exit after SIGKILL; stop waiting
                    // and leave the quiescence question to the engine probe.
                    settle({ clientExited: false, status: null, signal: null });
                }, killGraceMs);
            }, termGraceMs);
        };

        try {
            child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env, detached: true });
        } catch (error) {
            cause = 'spawn-error';
            settle({ clientExited: true, status: null, signal: null, error: sanitizeReason(error?.message) });
            return;
        }
        const onData = (name, target) => (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            outputBytes += buffer.length;
            tails = { ...tails, [name]: appendTail(tails[name], buffer, tailBytes) };
            if (outputBytes > outputLimitBytes) {
                cancel('output-limit');
                return;
            }
            try { target?.write?.(buffer); } catch (_) {}
        };
        child.stdout?.on?.('data', onData('stdout', stdout));
        child.stderr?.on?.('data', onData('stderr', stderr));
        child.once('error', (error) => {
            if (escalation) return;
            cause = 'spawn-error';
            settle({ clientExited: true, status: null, signal: null, error: sanitizeReason(error?.message) });
        });
        child.once('close', (code, signal) => {
            settle({
                clientExited: true,
                status: Number.isInteger(code) ? code : null,
                signal: signal || null,
            });
        });
        for (const signal of forwardedSignals) {
            const handler = () => cancel(`signal:${signal}`);
            handlers.set(signal, handler);
            processRef.on(signal, handler);
        }
        deadline = setTimeoutImpl(() => {
            deadline = null;
            cancel('timeout');
        }, timeoutMs);
    });

    // Engine failures can exit normally while an exec'd process survives a
    // lost connection. Only a successful client may use this shortcut. Update
    // also probes after success so detached Git/hook writers cannot escape.
    const normalExit = client.cause === 'exited' && client.clientExited && client.status === 0
        && !client.signal && !probeOnSuccess;
    let quiescence;
    if (normalExit) {
        quiescence = { state: 'confirmed', method: 'exec-exit-status' };
    } else if (client.cause === 'spawn-error' && client.pid === null) {
        quiescence = { state: 'confirmed', method: 'never-started' };
    } else {
        quiescence = await proveQuiescence({
            nonce, probe, killInBox, termGraceMs, killGraceMs, probeIntervalMs, setTimeoutImpl,
        });
    }
    // A descendant that survived the command may have changed inputs after
    // the completion report. Even successful termination cannot verify that
    // report's snapshot; the caller must block admission and report uncertainty.
    const outlivedCommand = client.cause === 'exited'
        && String(quiescence.method).startsWith('engine-probe-after-');
    return Object.freeze({ ...client,
        ...(outlivedCommand ? { cause: 'writer-outlived-command' } : {}),
        quiescence: Object.freeze(quiescence) });
}

async function proveQuiescence({ nonce, probe, killInBox, termGraceMs, killGraceMs, probeIntervalMs, setTimeoutImpl }) {
    if (typeof probe !== 'function') {
        return { state: 'uncertain', method: 'none', detail: 'no engine probe is available to prove the in-Box writer stopped' };
    }
    const observe = async () => {
        try {
            const observed = await probe({ nonce });
            return observed?.ok === true
                ? { ok: true, pids: (observed.pids || []).map(Number).filter(Number.isInteger) }
                : { ok: false, detail: sanitizeReason(observed?.detail || 'engine probe failed', { limit: 500 }) };
        } catch (error) {
            return { ok: false, detail: sanitizeReason(error?.message || String(error), { limit: 500 }) };
        }
    };
    const waitUntilGone = async (graceMs) => {
        let waited = 0;
        let observed = await observe();
        while (observed.ok && observed.pids.length && waited < graceMs) {
            await delay(Math.min(probeIntervalMs, graceMs - waited), setTimeoutImpl);
            waited += probeIntervalMs;
            observed = await observe();
        }
        return observed;
    };
    let observed = await observe();
    if (!observed.ok) return { state: 'uncertain', method: 'engine-probe', detail: observed.detail };
    if (!observed.pids.length) return { state: 'confirmed', method: 'engine-probe' };
    for (const [signal, graceMs] of [['TERM', termGraceMs], ['KILL', killGraceMs]]) {
        try {
            await killInBox?.(observed.pids, signal);
        } catch (_) {}
        observed = await waitUntilGone(graceMs);
        if (!observed.ok) return { state: 'uncertain', method: 'engine-probe', detail: observed.detail };
        if (!observed.pids.length) return { state: 'confirmed', method: `engine-probe-after-${signal}` };
    }
    return {
        state: 'uncertain',
        method: 'engine-probe',
        detail: `in-Box processes ${observed.pids.join(', ')} of this update still run after TERM and KILL`,
        pids: observed.pids,
    };
}

// Scans /proc inside the Box for processes that carry this operation's exact
// nonce in their environment. It runs as the same Box user as the writer.
export const IN_BOX_NONCE_PROBE_SCRIPT = [
    "const fs=require('fs');const needle=Buffer.from(process.argv[1]);const pids=[];",
    "for(const e of fs.readdirSync('/proc')){if(!/^\\d+$/.test(e)||Number(e)===process.pid)continue;",
    "let b;try{b=fs.readFileSync('/proc/'+e+'/environ');}catch{continue;}",
    "if(b.toString('latin1').split('\\0').includes(needle.toString('latin1')))pids.push(Number(e));}",
    'process.stdout.write(JSON.stringify(pids));',
].join('');

/**
 * The writers of one engine-exec'd operation, from a snapshot of the Box's
 * processes (`{ pid, ppid, pgid, comm, marked }`, `marked` = carries the
 * operation marker in its environment).
 *
 * A graph restart leaves the graph running: the Watchdog and Router, detached
 * no-wait workers and the engine's conmon, fuse-overlayfs, rootlessport, pasta
 * and aardvark-dns processes all inherit the marker, and each leads its own
 * live process group. They are the result of the operation, not its writers,
 * and must never be signalled. The writers are the command the engine exec'd
 * (it leads its own group and has no parent inside the Box's pid namespace)
 * and every process still in that group, including engine clients waiting on
 * a container, whether or not they kept the marker. After that command died,
 * its group has no live leader. Podman's rootless pause process (catatonit)
 * also runs in a group whose leader has exited, but it holds the user
 * namespace of every nested container and is never a writer.
 */
export function selectOperationWriters(table) {
    const live = new Set(table.map(row => row.pid));
    const groups = new Set();
    for (const row of table) {
        if (!row.marked || row.comm === 'catatonit') continue;
        if ((row.pid === row.pgid && row.ppid === 0) || !live.has(row.pgid)) groups.add(row.pgid);
    }
    return table.filter(row => groups.has(row.pgid) && row.comm !== 'catatonit')
        .map(row => row.pid).sort((a, b) => a - b);
}

// Lists the writers of a graph restart (see selectOperationWriters) instead of
// every process that inherited its marker.
export const IN_BOX_OPERATION_WRITERS_PROBE_SCRIPT = [
    `const selectOperationWriters=${selectOperationWriters.toString()};`,
    "const fs=require('fs');const marker=process.argv[1];const table=[];",
    "for(const e of fs.readdirSync('/proc')){if(!/^\\d+$/.test(e)||Number(e)===process.pid)continue;",
    "let stat;try{stat=fs.readFileSync('/proc/'+e+'/stat','latin1');}catch{continue;}",
    "const close=stat.lastIndexOf(')');const fields=stat.slice(close+2).split(' ');",
    "let environ='';try{environ=fs.readFileSync('/proc/'+e+'/environ','latin1');}catch{}",
    "table.push({pid:Number(e),ppid:Number(fields[1]),pgid:Number(fields[2]),",
    "comm:stat.slice(stat.indexOf('(')+1,close),marked:environ.split('\\0').includes(marker)});}",
    'process.stdout.write(JSON.stringify(selectOperationWriters(table)));',
].join('');
