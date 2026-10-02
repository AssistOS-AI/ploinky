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
//   - Amendment A5 (D-A5-01): ONE display process present at the run's FIRST gate
//     check (type exactly G, at most 64 MiB, a proven host identity, not owned) is
//     recorded as tolerated; every later check allows only that process, with the
//     same identity, type G and memory within the limit. A recorded process that
//     disappears is logged. It is never touched or signalled.
//   - It never changes the compute mode and never signals any process.
import { blocked } from './liveCommon.mjs';
import { parseGpuInventory, parseGpuMemory, parseGpuUtilization, requireGpuIdle } from './liveGpu.mjs';
import { requireTransport } from './liveProcess.mjs';
import { cgroupWithin, createHostProc } from './liveGpuHost.mjs';
import { GPU_TOLERATED_MAX, GPU_TOLERATED_MAX_MIB } from './fixtures.mjs';

// `nvidia-smi -q -x -i UUID`: one device, the full XML inventory.
export const gpuQueryArgv = uuid => ['-q', '-x', '-i', uuid];
export const GPU_GATE_REASONS = Object.freeze([
    'query_error', 'unsupported_output', 'device_or_mode_mismatch', 'activity_unknown', 'gpu_busy', 'owned_provenance_unproved',
    'insufficient_free_memory', 'foreign_process_appeared', 'unexpected_device_memory', 'display_identity_unproved',
]);

// The record of one tolerated display process (amendment A5), as the run
// manifest keeps it.
export const GPU_TOLERATED_KEYS = Object.freeze(['kind', 'hostPid', 'bootId', 'startIdentity', 'name', 'type', 'memoryMiB']);
export function isToleratedRecord(value) {
    return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype && value.kind === 'gpu-tolerated'
        && Object.keys(value).length === GPU_TOLERATED_KEYS.length && GPU_TOLERATED_KEYS.every(key => Object.hasOwn(value, key))
        && Number.isSafeInteger(value.hostPid) && value.hostPid > 0 && typeof value.bootId === 'string' && value.bootId.length > 0 && value.bootId.length <= 64
        && /^[0-9]+$/.test(String(value.startIdentity)) && (value.name === null || (typeof value.name === 'string' && value.name.length <= 256))
        && value.type === 'G' && Number.isSafeInteger(value.memoryMiB) && value.memoryMiB >= 0 && value.memoryMiB <= GPU_TOLERATED_MAX_MIB;
}

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

// `tolerated` is the set the run recorded at its first check (amendment A5), from the
// manifest; `recordTolerated` makes THIS gate's initial check that first check, which
// records what the rule allows and reports each record through `onTolerate`.
export function createGpuGate({
    query, uuid, host, boxPrefix, expectedMemoryMiB = null, intervalMs = 2000, retryMs = 100, onRegister = () => {},
    tolerated = [], recordTolerated = false, onTolerate = () => {},
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
} = {}) {
    if (typeof query !== 'function' || !/^GPU-[a-fA-F0-9-]{8,64}$/.test(String(uuid)) || !host || typeof boxPrefix !== 'string' || !boxPrefix.startsWith('/')) {
        throw new Error('The GPU gate needs its query, device UUID, host observer and Box cgroup prefix');
    }
    if (!Array.isArray(tolerated) || tolerated.length > GPU_TOLERATED_MAX || !tolerated.every(isToleratedRecord)) throw new Error('The tolerated display processes of the run are invalid');
    const toleratedSet = new Map(tolerated.map(record => [record.hostPid, record]));
    const vanishedEver = new Set();
    const registry = new Map();
    const daemons = new Set();
    const leaves = new Set();
    const history = [];
    let tripped = null;
    let baseline = null;

    const guarded = async label => {
        let result;
        try { result = await query(); } catch (error) { throw gpuBlocked('query_error', { message: error.message }); }
        try { return { result, inventory: parseGpuInventory(result, uuid), memory: parseGpuMemory(result), utilization: parseGpuUtilization(result) }; }
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
        // The registration is durable: the owner persists it into the run manifest
        // with its full tuple, so a resumed cleanup can prove the process is gone.
        onRegister({ ...record, cgroup: observed.cgroup, ppid: observed.ppid });
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
    // Every check records the tolerated set that was present (A5) and, when a recorded
    // process is no longer listed, that it vanished: logged, never a failure.
    const remember = (label, inventory, memory, owned, outcome = null) => {
        for (const pid of outcome?.vanished || []) vanishedEver.add(pid);
        history.push({
            label, at: now(), listed: inventory.processes.map(value => value.pid), owned: owned.map(value => value.hostPid), freeMiB: memory.freeMiB, usedMiB: memory.usedMiB,
            tolerated: (outcome?.tolerated || []).map(record => record.hostPid), ...(outcome?.vanished?.length ? { vanished: [...outcome.vanished] } : {}),
        });
        if (history.length > 200) history.shift();
    };
    const toleration = mode => ({ mode, recorded: [...toleratedSet.values()] });

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
            let outcome;
            try {
                outcome = await requireGpuIdle({
                    query: async () => result, expectedUuid: uuid, initial: true, observe: pid => host.observe(pid), bootId: host.bootId(),
                    tolerate: toleration(recordTolerated ? 'record' : 'subset'),
                });
            } catch (error) {
                throw gpuBlocked(classify(error.message), { message: error.message, listed: inventory.processes.map(value => value.pid), ...(error.detail?.why ? { why: error.detail.why } : {}), ...(error.detail?.foreign ? { foreign: error.detail.foreign } : {}) });
            }
            // The first check records what the rule tolerates; the record is durable.
            if (recordTolerated) for (const record of outcome.tolerated) { toleratedSet.set(record.hostPid, record); onTolerate({ ...record }); }
            baseline = Object.freeze({ uuid: inventory.uuid, computeMode: 'Default', memory, at: now(), bootId: host.bootId(), tolerated: outcome.tolerated.map(record => ({ ...record })) });
            remember('initial', inventory, memory, [], outcome);
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
            let outcome;
            try {
                outcome = await requireGpuIdle({
                    query: async () => result, expectedUuid: uuid, initial: false, owned,
                    // `owned` holds only PIDs the inventory lists, so a dead
                    // registered process never blocks, and a listed PID whose
                    // tuple changed (a reused PID) does.
                    observe: pid => host.observe(pid), bootId, boxCgroupPrefix: boxPrefix, tolerate: toleration('subset'),
                });
            } catch (error) {
                const reason = classify(error.message);
                const foreign = error.detail?.foreign || inventory.processes.map(value => value.pid).filter(pid => !owned.some(record => record.hostPid === pid) && !toleratedSet.has(pid));
                remember(label, inventory, memory, owned);
                // What the host knows of each unexpected PID, so a refusal can be
                // diagnosed without another query (bounded; observation only).
                const facts = foreign.slice(0, 8).map(pid => {
                    try { const seen = host.observe(pid); return seen ? { pid, ppid: seen.ppid, cgroup: seen.cgroup, uid: seen.uid?.effective, start: seen.startIdentity } : { pid, gone: true }; } catch { return { pid, unreadable: true }; }
                });
                throw gpuBlocked(reason === 'unsupported_output' ? 'owned_provenance_unproved' : reason, { message: error.message, label, listed: inventory.processes.map(value => value.pid), foreign, foreignFacts: facts, ...(error.detail?.why ? { why: error.detail.why } : {}) });
            }
            remember(label, inventory, memory, owned, outcome);
            if (minFreeMiB && memory.freeMiB < minFreeMiB) throw gpuBlocked('insufficient_free_memory', { message: `${memory.freeMiB} MiB free, ${minFreeMiB} MiB needed`, label });
            return { inventory, memory, utilization: query_.utilization, owned: owned.map(value => value.hostPid), tolerated: outcome.tolerated.map(record => record.hostPid), vanished: outcome.vanished };
        },
        // Run `task(signal)` while the GPU is re-queried every interval. A
        // foreign user starts no new work: the gate trips, the task's signal
        // aborts its owned client command and the failure is the gate's. The
        // owned clients themselves are stopped only by cleanup.
        // `onCheck(checked)` receives each passing re-query (the same result `check` returns), for
        // measurements taken at the gate's own cadence.
        async monitor(task, { every = intervalMs, onCheck = null } = {}) {
            const controller = new AbortController();
            let finished = false; let value; let failure = null;
            const running = Promise.resolve().then(() => task(controller.signal)).then(result => { value = result; }, error => { failure = error; }).finally(() => { finished = true; });
            while (!finished) {
                await Promise.race([running, sleep(every)]);
                if (finished) break;
                let checked;
                try { checked = await gate.check('monitor'); }
                catch (error) {
                    tripped = error.gate?.reason === 'gpu_busy' ? gpuBlocked('foreign_process_appeared', { ...error.gate, message: error.message }) : error;
                    controller.abort();
                    await running;
                    throw tripped;
                }
                if (onCheck) onCheck(checked);
            }
            await running;
            if (failure) throw failure;
            return value;
        },
        // The tolerated display processes of the run (A5), recorded at its first check.
        get tolerated() { return [...toleratedSet.values()].map(record => ({ ...record })); },
        summary() {
            return { baseline, tolerated: [...toleratedSet.values()].map(record => ({ ...record })), vanishedTolerated: [...vanishedEver], checks: history.length, tripped: tripped ? tripped.gate : null, registered: [...registry.values()].map(value => ({ role: value.role, hostPid: value.hostPid, bootId: value.bootId, startIdentity: value.startIdentity })), last: history.at(-1) || null };
        },
    };
    return gate;
}

// ---------------------------------------------------------------------------
// The final GPU observation that certifies a GPU block's cleanup. Cleanup is
// complete only when this SUCCEEDS: a failed, timed-out or malformed query, a
// device or compute mode that is not the pinned one, or a registered owned
// process that still exists with its recorded tuple all fail it. It reads only:
// it never signals a process, owned or not. The registrations it checks are the
// run manifest's own `ownedProcesses` records, so a resumed cleanup in a new
// process proves the same thing as the run that registered them.
export const GPU_PROCESS_RECORD_KEYS = Object.freeze(['kind', 'role', 'hostPid', 'bootId', 'startIdentity', 'cgroup', 'ppid']);
export function isGpuProcessRecord(value) {
    return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype && value.kind === 'gpu-process'
        && Object.keys(value).length === GPU_PROCESS_RECORD_KEYS.length && GPU_PROCESS_RECORD_KEYS.every(key => Object.hasOwn(value, key))
        && ['mps-server', 'mps-client'].includes(value.role) && Number.isSafeInteger(value.hostPid) && value.hostPid > 0
        && typeof value.bootId === 'string' && value.bootId.length > 0 && value.bootId.length <= 64
        && /^[0-9]+$/.test(String(value.startIdentity)) && typeof value.cgroup === 'string' && value.cgroup.length <= 1024 && Number.isSafeInteger(value.ppid);
}
export async function finalGpuObservation({ gpu, run, host, query, artifacts = () => {}, now = Date.now }) {
    const observation = { at: now(), uuid: gpu.uuid, processes: null, computeMode: null, memory: null, registered: 0, survivors: [], error: null };
    const fail = message => {
        observation.error = message;
        try { artifacts('gpu-final-observation', observation); } catch { /* the failure below is the verdict */ }
        throw Object.assign(new Error(`The final GPU observation failed, so cleanup is not certified: ${message}`), { code: 'LIVE_GPU_FINAL_OBSERVATION' });
    };
    let result;
    try { result = await query(); requireTransport(result); } catch (error) { fail(`the nvidia-smi query did not complete (${String(error?.message || error).slice(0, 200)})`); }
    let inventory; let memory;
    try { inventory = parseGpuInventory(result, gpu.uuid); memory = parseGpuMemory(result); } catch (error) { fail(`the reply is unsupported or not the pinned device in Default mode (${String(error?.message || error).slice(0, 200)})`); }
    observation.processes = inventory.processes.map(value => value.pid);
    observation.computeMode = 'Default';
    observation.memory = memory;
    const records = (run.ownedProcesses || []).filter(isGpuProcessRecord);
    observation.registered = records.length;
    for (const record of records) {
        let seen = null;
        try { seen = host.observe(record.hostPid); } catch (error) { fail(`a registered process cannot be re-observed (${String(error?.message || error).slice(0, 120)})`); }
        // Still the very process that was registered: PID, boot and start identity all match.
        if (seen && seen.bootId === record.bootId && seen.startIdentity === String(record.startIdentity)) {
            observation.survivors.push({ role: record.role, hostPid: record.hostPid, listed: observation.processes.includes(record.hostPid) });
        }
    }
    try { artifacts('gpu-final-observation', observation); } catch { /* evidence only */ }
    if (observation.survivors.length) {
        throw Object.assign(new Error(`An owned GPU process survived the destruction of its Box: ${observation.survivors.map(value => `${value.role} ${value.hostPid}`).join(', ')}; it was not signalled`), { code: 'LIVE_GPU_OWNED_SURVIVOR' });
    }
    return observation;
}

// The GPU block's cleanup proof, shared by every cleanup path (normal, standalone,
// resumed, provisioning failure): a SUCCESSFUL final observation of the GPU through
// the pinned nvidia-smi. `artifacts` keeps the evidence.
export function gpuCleanupProof({ run, profile, processProvider, signal, hostProc, artifacts = () => {} }) {
    return finalGpuObservation({
        gpu: profile.gpu, run, host: hostProc || createHostProc(), artifacts,
        query: () => processProvider(profile.gpu.smi.path, gpuQueryArgv(profile.gpu.uuid), {
            cwd: profile.host.home, env: { PATH: '/usr/bin:/bin', HOME: profile.host.home }, deadlineMs: 30000, maxBytes: 1048576, signal,
        }),
    });
}
