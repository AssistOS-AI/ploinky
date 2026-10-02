// The GPU idle gate executor (plan §15.5). It builds on liveGpu.mjs
// (parseGpuInventory, requireGpuIdle) and fixtures.mjs (evaluateGpuIdleGate);
// it adds the pieces a live run needs around them: the initial gate with its
// recorded baseline, a fresh query before every later GPU operation, owned
// MPS process registration with freshly verified provenance, the free-memory
// check and monitoring during a long probe.
//
// Rules this module keeps:
//   - A query error, unsupported or malformed output, a wrong device or a
//     non-Default compute mode, an unsupported activity inventory and any
//     foreign process are BLOCKED (code LIVE_PREREQUISITE_MISSING), never PASS.
//   - A listed PID is excluded only when it is a REGISTERED test MPS server or
//     client and its tuple (boot identity, host PID, process start identity,
//     cgroup ancestry beneath the exact task Box) is freshly re-observed. A
//     bare PID, UID or name is never enough.
//   - Once a foreign process has appeared the gate is tripped: no later check
//     passes, so no new work starts; the only thing left to do is cleanup.
//   - It never changes the compute mode and never signals any process.
import { blocked } from './liveCommon.mjs';
import { parseGpuInventory, parseGpuMemory, requireGpuIdle } from './liveGpu.mjs';
import { cgroupWithin } from './liveGpuHost.mjs';

// `nvidia-smi -q -x -i UUID`: one device, the full XML inventory.
export const gpuQueryArgv = uuid => ['-q', '-x', '-i', uuid];
export const GPU_GATE_REASONS = Object.freeze([
    'query_error', 'unsupported_output', 'device_or_mode_mismatch', 'activity_unknown', 'gpu_busy', 'owned_provenance_unproved',
    'insufficient_free_memory', 'foreign_process_appeared', 'unexpected_device_memory',
]);

export function gpuBlocked(reason, detail = {}) {
    return Object.assign(blocked(`GPU idle gate blocked: ${reason}${detail.message ? ` (${String(detail.message).slice(0, 200)})` : ''}`), { gate: { ...detail, reason } });
}

// Map a parser or gate failure to its reason. Anything unrecognised is an
// unsupported output: the gate never guesses.
function classify(message) {
    const text = String(message);
    if (/Live command failed/.test(text)) return 'query_error';
    if (/GPU device or compute mode mismatch/.test(text)) return 'device_or_mode_mismatch';
    if (/GPU activity inventory unavailable|Unknown GPU activity grammar/.test(text)) return 'activity_unknown';
    if (/GPU idle gate blocked: (\w+)/.test(text)) return /GPU idle gate blocked: (\w+)/.exec(text)[1];
    return 'unsupported_output';
}

export function createGpuGate({
    query, uuid, host, boxPrefix, expectedMemoryMiB = null, intervalMs = 2000, retryMs = 100,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
} = {}) {
    if (typeof query !== 'function' || !/^GPU-[a-fA-F0-9-]{8,64}$/.test(String(uuid)) || !host || typeof boxPrefix !== 'string' || !boxPrefix.startsWith('/')) {
        throw new Error('The GPU gate needs its query, device UUID, host observer and Box cgroup prefix');
    }
    const registry = new Map();
    const daemons = new Set();
    const leaves = new Set();
    const history = [];
    let tripped = null;
    let baseline = null;

    const guarded = async label => {
        let result;
        try { result = await query(); } catch (error) { throw gpuBlocked('query_error', { message: error.message }); }
        try { return { result, inventory: parseGpuInventory(result, uuid), memory: parseGpuMemory(result) }; }
        catch (error) { throw gpuBlocked(classify(error.message), { message: error.message, label }); }
    };
    const tuple = (role, observed) => ({ role, hostPid: observed.hostPid, bootId: observed.bootId, startIdentity: observed.startIdentity });
    // Registration verifies on the spot: the process is observed now, its
    // cgroup is beneath the exact Box and the role's own placement holds.
    function register(hostPid, role) {
        const observed = host.observe(hostPid);
        if (!observed || !cgroupWithin(observed.cgroup, boxPrefix)) throw gpuBlocked('owned_provenance_unproved', { hostPid, role, message: 'the process is not provably beneath the exact Box' });
        const record = tuple(role, observed);
        registry.set(hostPid, record);
        return record;
    }
    // A listed PID that is not registered may still be owned: a child of a
    // registered MPS daemon placed in /ploinky/core (the server the daemon
    // spawns on demand), or a process inside a registered owned agent leaf.
    function discover(pid) {
        const observed = host.observe(pid);
        if (!observed || !cgroupWithin(observed.cgroup, boxPrefix)) return null;
        const parent = registry.get(observed.ppid);
        // The parent daemon is re-observed: a reused PID is not a registered daemon.
        const parentNow = parent && daemons.has(observed.ppid) ? host.observe(observed.ppid) : null;
        if (parentNow && parentNow.startIdentity === parent.startIdentity && parentNow.bootId === parent.bootId
            && observed.cgroup === `${boxPrefix}/ploinky/core`) return register(pid, 'mps-server');
        for (const leaf of leaves) if (cgroupWithin(observed.cgroup, leaf)) return register(pid, 'mps-client');
        return null;
    }
    const remember = (label, inventory, memory, owned) => {
        history.push({ label, at: now(), listed: inventory.processes.map(value => value.pid), owned: owned.map(value => value.hostPid), freeMiB: memory.freeMiB, usedMiB: memory.usedMiB });
        if (history.length > 200) history.shift();
    };

    const gate = {
        get baseline() { return baseline; },
        get tripped() { return tripped; },
        history,
        // Registered owned MPS control daemons: the parent of every server the
        // gate may exclude. Never a name or a UID rule.
        registerDaemon(hostPid) { const record = register(hostPid, 'mps-server'); daemons.add(hostPid); return record; },
        registerServer(hostPid) { return register(hostPid, 'mps-server'); },
        registerClient(hostPid) { return register(hostPid, 'mps-client'); },
        registerLeaf(leaf) {
            if (typeof leaf !== 'string' || !cgroupWithin(leaf, boxPrefix) || leaf === boxPrefix) throw new Error('An owned leaf must be beneath the exact Box cgroup');
            leaves.add(leaf);
        },
        // The initial gate: a clean, supported, empty inventory of the expected
        // device in Default mode. Records UUID, compute mode and memory.
        async initial() {
            const { result, inventory, memory } = await guarded('initial');
            if (expectedMemoryMiB !== null && memory.totalMiB !== expectedMemoryMiB) throw gpuBlocked('unexpected_device_memory', { message: `${memory.totalMiB} MiB reported, ${expectedMemoryMiB} MiB pinned` });
            try { await requireGpuIdle({ query: async () => result, expectedUuid: uuid, initial: true }); }
            catch (error) { throw gpuBlocked(classify(error.message), { message: error.message, listed: inventory.processes.map(value => value.pid) }); }
            baseline = Object.freeze({ uuid: inventory.uuid, computeMode: 'Default', memory, at: now(), bootId: host.bootId() });
            remember('initial', inventory, memory, []);
            return baseline;
        },
        // Before every later GPU operation: query again; exclude only owned,
        // freshly verified PIDs.
        async check(label, { minFreeMiB = 0 } = {}) {
            if (tripped) throw tripped;
            // A process the inventory listed may exit before the host can be asked
            // about it (the MPS server leaves a moment after its last client). Such
            // a vanished PID is not evidence of foreign activity: the inventory is
            // read again, a few times at most; a PID that stays listed is judged.
            let query_ = await guarded(label);
            for (let attempt = 0; attempt < 3 && query_.inventory.processes.some(({ pid }) => { try { return host.observe(pid) === null; } catch { return false; } }); attempt += 1) {
                await sleep(retryMs);
                query_ = await guarded(label);
            }
            const { result, inventory, memory } = query_;
            const owned = [];
            for (const { pid } of inventory.processes) {
                const record = registry.get(pid) || discover(pid);
                if (record) owned.push(record);
            }
            const bootId = host.bootId();
            try {
                await requireGpuIdle({
                    query: async () => result, expectedUuid: uuid, initial: false, owned,
                    // `owned` holds only PIDs the inventory lists, so a dead
                    // registered process never blocks, and a listed PID whose
                    // tuple changed (a reused PID) does.
                    observe: pid => host.observe(pid), bootId, boxCgroupPrefix: boxPrefix,
                });
            } catch (error) {
                const reason = classify(error.message);
                const foreign = inventory.processes.map(value => value.pid).filter(pid => !owned.some(record => record.hostPid === pid));
                remember(label, inventory, memory, owned);
                // What the host knows of each unexpected PID, so a refusal can be
                // diagnosed without another query (bounded; observation only).
                const facts = foreign.slice(0, 8).map(pid => {
                    try { const seen = host.observe(pid); return seen ? { pid, ppid: seen.ppid, cgroup: seen.cgroup, uid: seen.uid?.effective, start: seen.startIdentity } : { pid, gone: true }; } catch { return { pid, unreadable: true }; }
                });
                throw gpuBlocked(reason === 'unsupported_output' ? 'owned_provenance_unproved' : reason, { message: error.message, label, listed: inventory.processes.map(value => value.pid), foreign, foreignFacts: facts });
            }
            remember(label, inventory, memory, owned);
            if (minFreeMiB && memory.freeMiB < minFreeMiB) throw gpuBlocked('insufficient_free_memory', { message: `${memory.freeMiB} MiB free, ${minFreeMiB} MiB needed`, label });
            return { inventory, memory, owned: owned.map(value => value.hostPid) };
        },
        // Run `task(signal)` while the GPU is re-queried every interval. A
        // foreign user starts no new work: the gate trips, the task's signal
        // aborts its owned client command and the failure is the gate's. The
        // owned clients themselves are stopped only by cleanup.
        async monitor(task, { every = intervalMs } = {}) {
            const controller = new AbortController();
            let finished = false; let value; let failure = null;
            const running = Promise.resolve().then(() => task(controller.signal)).then(result => { value = result; }, error => { failure = error; }).finally(() => { finished = true; });
            while (!finished) {
                await Promise.race([running, sleep(every)]);
                if (finished) break;
                try { await gate.check('monitor'); }
                catch (error) {
                    tripped = error.gate?.reason === 'gpu_busy' ? gpuBlocked('foreign_process_appeared', { ...error.gate, message: error.message }) : error;
                    controller.abort();
                    await running;
                    throw tripped;
                }
            }
            await running;
            if (failure) throw failure;
            return value;
        },
        summary() {
            return { baseline, checks: history.length, tripped: tripped ? tripped.gate : null, registered: [...registry.values()].map(value => ({ role: value.role, hostPid: value.hostPid, bootId: value.bootId, startIdentity: value.startIdentity })), last: history.at(-1) || null };
        },
    };
    return gate;
}
