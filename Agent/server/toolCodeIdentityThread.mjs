// Code identity walks on a worker thread (see toolCodeIdentity.mjs and
// toolWorkerPool.mjs).
//
// A walk stats every entry under the code roots with synchronous fs calls;
// run on the AgentServer's main thread it blocks every request for its whole
// duration. Here the walk runs on one worker thread: the main thread only
// posts a request and receives the hash. The thread runs createCodeIdentity
// with the same inputs AgentServer would use (agentServerIdentityInputs), so
// the stamped set is identical; per-pool inputs (the pool name and its
// resolved command) travel with every request, because functions cannot
// cross threads.
//
// Every request carries an id. A reply is accepted only from the current
// thread and only for a request that is still pending; anything else (a reply
// after its request timed out, a reply for another id, a message from a
// thread that was replaced) is dropped. A request that gets no reply within
// `timeoutMs`, a thread error and a thread exit reject every pending request
// and terminate the thread; the next request starts a new one. A rejection is
// an identity error for the pool, which sends its calls to the spawn fallback.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
    agentServerIdentityInputs,
    createCodeIdentity,
    formatIdentityMeasures,
    poolCommandFiles,
} from './toolCodeIdentity.mjs';

const THREAD_MARKER = 'ploinky.toolCodeIdentityThread';
export const DEFAULT_IDENTITY_THREAD_TIMEOUT_MS = 10_000;

// Thread side: one identity (with its directory-listing cache) per thread.
if (!isMainThread && workerData?.[THREAD_MARKER] === true) {
    const offsetMs = Number(workerData.clockOffsetMs) || 0;
    let measures = [];
    const identity = createCodeIdentity({
        roots: workerData.roots,
        extraFiles: workerData.extraFiles,
        settleMs: workerData.settleMs,
        maxEntries: workerData.maxEntries,
        now: () => Date.now() + offsetMs,
        onMeasure: ({ index, ms, entries }) => measures.push({ index, ms, entries }),
    });
    parentPort.on('message', (request) => {
        const id = request?.id;
        measures = [];
        try {
            const value = identity(Array.isArray(request?.extraFiles) ? request.extraFiles : []);
            parentPort.postMessage({ id, ok: true, identity: value, measures });
        } catch (error) {
            parentPort.postMessage({ id, ok: false, error: String(error?.message || error) });
        }
    });
}

/**
 * A main-thread client for identity walks on a worker thread.
 *
 * @param {object} options
 * @param {string[]} options.roots, options.extraFiles, options.settleMs, options.maxEntries as for createCodeIdentity
 * @param {number} [options.clockOffsetMs] added to the thread's wall clock (tests)
 * @param {number} [options.timeoutMs] per request
 * @param {URL|string} [options.threadUrl] thread entry (tests)
 * @returns {{
 *   read: (extraFiles?: string[], meta?: object) => Promise<{ identity: string, measures: object[] }>,
 *   start: () => void, stats: () => object, terminate: () => Promise<void>,
 * }}
 */
export function createCodeIdentityThread({
    roots,
    extraFiles = [],
    settleMs,
    maxEntries,
    clockOffsetMs = 0,
    timeoutMs = DEFAULT_IDENTITY_THREAD_TIMEOUT_MS,
    threadUrl = new URL(import.meta.url),
} = {}) {
    if (!Array.isArray(roots) || roots.length === 0) throw new TypeError('createCodeIdentityThread requires roots');
    const data = {
        [THREAD_MARKER]: true,
        roots: [...roots],
        extraFiles: [...extraFiles],
        settleMs,
        maxEntries,
        clockOffsetMs,
    };
    const counters = { spawned: 0, requests: 0, timeouts: 0, crashes: 0, dropped: 0 };
    const pending = new Map();
    let thread = null;
    let nextId = 1;
    let closed = false;

    const rejectPending = (reason) => {
        for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(new Error(reason));
        }
        pending.clear();
    };

    // Stop using `current`: fail what it owes and terminate it.
    const discard = (current, reason) => {
        if (thread !== current) return;
        thread = null;
        rejectPending(reason);
        current.terminate().catch(() => {});
    };

    const spawnThread = () => {
        const current = new Worker(threadUrl, { workerData: data });
        counters.spawned += 1;
        // Pending requests keep the process alive through their timers.
        current.unref();
        current.on('message', (reply) => {
            const entry = thread === current ? pending.get(reply?.id) : undefined;
            if (!entry) {
                counters.dropped += 1;
                return;
            }
            pending.delete(reply.id);
            clearTimeout(entry.timer);
            if (reply.ok === true && typeof reply.identity === 'string') {
                entry.resolve({ identity: reply.identity, measures: Array.isArray(reply.measures) ? reply.measures : [] });
            } else {
                entry.reject(new Error(typeof reply?.error === 'string' ? reply.error : 'identity thread reply is invalid'));
            }
        });
        current.on('error', (error) => {
            if (thread === current) counters.crashes += 1;
            discard(current, `identity thread failed: ${error?.message || error}`);
        });
        current.on('exit', (code) => {
            if (thread === current) counters.crashes += 1;
            discard(current, `identity thread exited (code ${code})`);
        });
        thread = current;
        return current;
    };

    const read = (callExtraFiles = [], meta = {}) => {
        if (closed) return Promise.reject(new Error('identity thread is closed'));
        let current;
        try {
            current = thread || spawnThread();
        } catch (error) {
            return Promise.reject(error);
        }
        const id = nextId++;
        counters.requests += 1;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!pending.has(id)) return;
                counters.timeouts += 1;
                discard(current, `identity thread did not answer within ${timeoutMs}ms`);
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            try {
                current.postMessage({ ...meta, id, extraFiles: [...callExtraFiles] });
            } catch (error) {
                discard(current, `identity thread request failed: ${error?.message || error}`);
            }
        });
    };

    return {
        read,
        // Start the thread ahead of the first request, so that request only posts a message.
        start() {
            if (!closed && !thread) spawnThread();
        },
        stats: () => ({ ...counters, pending: pending.size, running: thread !== null }),
        // Idempotent; safe before the thread ever started.
        async terminate() {
            closed = true;
            const current = thread;
            thread = null;
            rejectPending('identity thread is closed');
            if (current) await current.terminate().catch(() => {});
        },
    };
}

/**
 * The AgentServer identity (createAgentServerCodeIdentity) walked on a thread.
 * `codeIdentity(poolName)` resolves `{ identity, roots }` (roots: a timing
 * summary) and sends the pool name and its resolved command with the request.
 */
export function createAgentServerCodeIdentityThread({
    codeDir,
    agentLibRoot,
    configPath = null,
    manifestPath = null,
    poolCommand = () => null,
    env = process.env,
    ...options
} = {}) {
    const { roots, labels, extraFiles } = agentServerIdentityInputs({
        codeDir,
        ...(agentLibRoot === undefined ? {} : { agentLibRoot }),
        configPath,
        manifestPath,
        env,
    });
    const client = createCodeIdentityThread({ roots, extraFiles, ...options });
    const codeIdentity = (poolName) => {
        const command = poolCommand(poolName);
        return client.read(poolCommandFiles(command), {
            poolName: typeof poolName === 'string' ? poolName : null,
            command: typeof command === 'string' ? command : null,
        }).then((reply) => ({ identity: reply.identity, roots: formatIdentityMeasures(reply.measures, labels) }));
    };
    return { codeIdentity, start: client.start, stats: client.stats, terminate: client.terminate };
}
