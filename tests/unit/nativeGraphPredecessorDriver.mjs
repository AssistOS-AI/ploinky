// Child-process driver for nativeGraphPredecessor.test.mjs (not a test file).
// Usage: node nativeGraphPredecessorDriver.mjs <scenario> [json-argument]
// Runs one scenario through production entry points against the workspace in
// PLOINKY_WORKSPACE_ROOT and prints one JSON result line.
//
// Process safety: every process a scenario signals is a short-lived child that
// this driver spawned itself (it also exits on its own after 25 s). Signals
// are never sent to any other PID, and each scenario kills its children on
// the way out.

import { spawn, spawnSync } from 'node:child_process';
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const root = process.env.PLOINKY_WORKSPACE_ROOT;
const [scenario, rawArgument] = process.argv.slice(2);
const argument = rawArgument ? JSON.parse(rawArgument) : {};
const REAL_KILL = process.kill.bind(process);
const REAL_EXEC_FILE_SYNC = cp.execFileSync;
const REAL_READ_FILE_SYNC = fs.readFileSync;
const cli = (relative) => import(new URL(`../../cli/${relative}`, import.meta.url).href);

const KEY = 'ploinky_demo_background_ws_deadbeef';
const PREDECESSOR = Object.freeze({ instanceId: 'old-instance', enableGeneration: 'old-enable' });
const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(sleepArray, 0, 0, ms);

// ---------------------------------------------------------------- children

const children = new Set();
function spawnChild() {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 25000);'], {
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
    children.add(child.pid);
    return child.pid;
}
function killChildren() {
    for (const pid of children) {
        try { REAL_KILL(-pid, 'SIGKILL'); } catch (_) { /* gone */ }
        try { REAL_KILL(pid, 'SIGKILL'); } catch (_) { /* gone */ }
    }
}
process.on('exit', killChildren);

function psState(pid) {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
    return String(result.stdout || '').trim();
}
// Alive means a live process, not a zombie that nobody reaped.
function isAlive(pid) {
    try {
        REAL_KILL(pid, 0);
    } catch (error) {
        if (error?.code === 'ESRCH') return false;
    }
    const state = psState(pid);
    return Boolean(state) && !state.startsWith('Z');
}
function waitFor(predicate, ms = 3000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        sleepSync(20);
    }
    return predicate();
}

function installKillSpy({ deny = false } = {}) {
    const signals = [];
    process.kill = (pid, signal) => {
        if (signal === 0 || signal === undefined) return REAL_KILL(pid, signal);
        signals.push({ pid, signal });
        if (deny) {
            const error = new Error('operation not permitted');
            error.code = 'EPERM';
            throw error;
        }
        return REAL_KILL(pid, signal);
    };
    return { signals, restore() { process.kill = REAL_KILL; } };
}

// -------------------------------------------------------------------- state

const pidFile = (fleet, key) => path.join(fleet.BWRAP_PIDS_DIR, `${key}.pid`);
const pidRecord = (fleet, key) => {
    try { return JSON.parse(fs.readFileSync(pidFile(fleet, key), 'utf8')); } catch (_) { return null; }
};

function receiptFiles() {
    const dir = path.join(root, '.ploinky', 'run', 'runtime-predecessors');
    return fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name))
        : [];
}

function engineCalls() {
    const log = process.env.NATIVE_ENGINE_LOG;
    return log && fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
}

function graphNode({ id = 'demo/background', agent = 'background', repo = 'demo', manifest } = {}) {
    return {
        id,
        repoName: repo,
        shortAgentName: agent,
        alias: '',
        agentRef: `${repo}/${agent}`,
        enableSpec: `${repo}/${agent} global`,
        profile: 'default',
        isStatic: false,
        manifest: manifest || { 'lite-sandbox': true, network: { mode: 'none' } },
    };
}

function nativeRecord(runtime, overrides = {}) {
    return {
        type: 'agent',
        repoName: 'demo',
        agentName: 'background',
        runtime,
        runMode: 'global',
        projectPath: root,
        profile: 'default',
        envHash: 'fixture-env-hash',
        ...PREDECESSOR,
        ...overrides,
    };
}

// Runs the production ensureGraphNodesEnabled over one or more nodes. Every
// collaborator that touches the Router, the registry file or the edge
// generation is a recording stub; the removal dispatch, the receipt store and
// the process observation are the production defaults unless overridden.
async function runGraph({ nodes, registry, options = {}, spyRemoval = false, removalExtra = {}, hooks = {} }) {
    const { ensureGraphNodesEnabled, removeGraphContainerForRecreate } = await cli('commands/workspaceUtil.js');
    const events = [];
    const state = { persisted: null };
    const stubs = {
        inactivateGeneration() { events.push('inactive'); },
        loadRouting() {
            const routes = {};
            for (const node of nodes) {
                routes[node.shortAgentName] = {
                    container: KEY, repo: node.repoName, agent: node.shortAgentName, hostPort: 43001,
                };
            }
            return { routes };
        },
        saveRouting() { events.push('routing-saved'); },
        retireNoWaitMarkers() { events.push('markers-retired'); },
        saveAgents(map) {
            events.push('registry-saved');
            state.persisted = structuredClone(map);
            if (hooks.crashAfterRegistrySave) throw hooks.crashAfterRegistrySave;
        },
        prepareAgentEnableBatch() {
            events.push('prepared');
            return { plans: [], preparedGeneration: { selector: { state: 'inactive' } } };
        },
        executionRecordOptions: { workspaceRoot: root },
        ...(spyRemoval ? {
            removeAgentContainerForRecreate(containerName, label, record, removalOptions) {
                if (hooks.crashBeforeRemoval) throw hooks.crashBeforeRemoval;
                events.push(`remove:${label}`);
                return removeGraphContainerForRecreate(containerName, label, record, { ...removalOptions, ...removalExtra });
            },
        } : {}),
        ...options,
    };
    try {
        const result = ensureGraphNodesEnabled(
            { nodes: new Map(nodes.map((node) => [node.id, node])) },
            registry,
            stubs,
        );
        return { ok: true, changed: [...result.changedContainers], events, persisted: state.persisted };
    } catch (error) {
        return {
            ok: false,
            code: error?.code || null,
            causeCode: error?.cause?.code || null,
            message: String(error?.message || error),
            events,
            persisted: state.persisted,
        };
    }
}

const record = (value) => value && {
    pid: value.pid, instanceId: value.instanceId, enableGeneration: value.enableGeneration,
};

// ---------------------------------------------------------------- scenarios

const scenarios = {
    // The stopped-runtime restaging that production ensureGraphNodesEnabled
    // performs, with the real receipt store, the real removal dispatch and no
    // stubbed liveness. A stub engine records any container-engine call.
    async restage() {
        const { runtime, live = false } = argument;
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        const registry = { [KEY]: nativeRecord(runtime) };
        let pid = null;
        if (live) {
            pid = spawnChild();
            fleet.saveBwrapPid(KEY, pid, PREDECESSOR);
        }
        const bystander = spawnChild();
        fleet.saveBwrapPid('ploinky_demo_bystander_ws_deadbeef', bystander, { instanceId: 'by-instance', enableGeneration: 'by-enable' });
        const spy = installKillSpy();
        const outcome = await runGraph({
            nodes: [graphNode()],
            registry,
            spyRemoval: true,
            options: {
                runtimeReplacementOptions: {
                    getRuntimeForAgentImpl: () => runtime,
                    ...(live ? { isSandboxRunningImpl: () => true, computeEnvHashImpl: () => 'changed-env-hash' } : {}),
                },
            },
        });
        spy.restore();
        const result = {
            ...outcome,
            registryTuple: record(registry[KEY]),
            receiptsLeft: receiptFiles().length,
            engineCalls: engineCalls(),
            signals: spy.signals,
            predecessorAlive: pid ? isAlive(pid) : null,
            predecessorRecord: pid ? record(pidRecord(fleet, KEY)) : null,
            bystanderAlive: isAlive(bystander),
            bystanderRecord: Boolean(pidRecord(fleet, 'ploinky_demo_bystander_ws_deadbeef')),
        };
        killChildren();
        return result;
    },

    // Alias and same-short-name regression for native additional startup.
    async 'extra-startup'() {
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        const workspaceUtil = await cli('commands/workspaceUtil.js');
        const { partitionAdditionalStartupAgents } = await cli('utils/runtime/manifestStartup.js');
        const { runtime } = argument;
        const keys = {
            repoA: 'ploinky_repoa_agent_ws_deadbeef',
            repoB: 'ploinky_repob_agent_ws_deadbeef',
            alias: 'ploinky_repoa_agent_alias_ws_deadbeef',
            // A record whose own key is its short agent name.
            shortName: 'agent',
        };
        const tuple = (name) => ({ instanceId: `${name}-instance`, enableGeneration: `${name}-generation` });
        const records = {
            [keys.repoA]: { type: 'agent', repoName: 'repoa', agentName: 'agent', runtime, ...tuple('a') },
            [keys.repoB]: { type: 'agent', repoName: 'repob', agentName: 'agent', runtime, ...tuple('b') },
            [keys.alias]: { type: 'agent', repoName: 'repoa', agentName: 'agent', alias: 'alias', runtime, ...tuple('alias') },
        };
        const live = { [keys.repoA]: spawnChild(), [keys.alias]: spawnChild() };
        fleet.saveBwrapPid(keys.repoA, live[keys.repoA], tuple('a'));
        fleet.saveBwrapPid(keys.alias, live[keys.alias], tuple('alias'));
        const running = {};
        const errors = {};
        for (const [name, key] of Object.entries(keys)) {
            if (!records[key]) continue;
            try { running[name] = workspaceUtil.isRegistryRuntimeRunning(key, records[key]); } catch (error) { errors[name] = error.code || error.message; }
        }
        // The same alias key under another tuple is not the running runtime.
        let staleTuple = null;
        try {
            staleTuple = workspaceUtil.isRegistryRuntimeRunning(keys.alias, { ...records[keys.alias], enableGeneration: 'alias-replaced' });
        } catch (error) { errors.staleTuple = error.code || error.message; }
        const partition = partitionAdditionalStartupAgents({
            registry: records,
            names: Object.keys(records),
            graphRegistryNames: new Set(),
            loadManifest: () => ({ startup: 'manual' }),
            isRuntimeRunning: workspaceUtil.isRegistryRuntimeRunning,
        });
        const result = {
            running,
            staleTuple,
            errors,
            active: partition.activeManual.map((entry) => entry.name).sort(),
            inactive: partition.inactiveManual.map((entry) => entry.name).sort(),
            keys,
        };
        killChildren();
        return result;
    },

    // Baseline guards written with global patches only, so the same scenarios
    // run unmodified against the starting commit.
    async 'legacy-denied-signals'() {
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        const key = 'ploinky_demo_denied_ws_deadbeef';
        const pid = spawnChild();
        fleet.saveBwrapPid(key, pid, PREDECESSOR);
        const spy = installKillSpy({ deny: true });
        let stopped;
        try {
            stopped = fleet.stopBwrapProcess(key, { timeout: 300 });
        } finally {
            spy.restore();
        }
        const result = {
            stopped,
            signals: spy.signals.map((entry) => entry.signal),
            recordKept: Boolean(pidRecord(fleet, key)),
            alive: isAlive(pid),
        };
        killChildren();
        return result;
    },

    async 'legacy-identity-failure'() {
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        const key = 'ploinky_demo_probe_ws_deadbeef';
        const pid = spawnChild();
        fleet.saveBwrapPid(key, pid, PREDECESSOR);
        const before = pidRecord(fleet, key);
        // The identity probe becomes unavailable: /proc is unreadable and `ps`
        // fails. Neither is evidence that the process is gone.
        cp.execFileSync = (command, ...rest) => {
            if (command === 'ps') throw new Error('ps unavailable');
            return REAL_EXEC_FILE_SYNC(command, ...rest);
        };
        fs.readFileSync = (file, ...rest) => {
            if (typeof file === 'string' && file.startsWith('/proc/') && file.endsWith('/stat')) {
                const error = new Error('permission denied');
                error.code = 'EACCES';
                throw error;
            }
            return REAL_READ_FILE_SYNC(file, ...rest);
        };
        syncBuiltinESMExports();
        const spy = installKillSpy();
        let running;
        let stopped;
        try {
            running = fleet.isBwrapProcessRunning(key, PREDECESSOR);
            stopped = fleet.stopBwrapProcess(key, { expectedIdentity: PREDECESSOR, timeout: 200 });
        } finally {
            spy.restore();
            cp.execFileSync = REAL_EXEC_FILE_SYNC;
            fs.readFileSync = REAL_READ_FILE_SYNC;
            syncBuiltinESMExports();
        }
        const result = {
            running,
            stopped,
            signals: spy.signals.map((entry) => entry.signal),
            recordKept: JSON.stringify(pidRecord(fleet, key)) === JSON.stringify(before),
            alive: isAlive(pid),
        };
        killChildren();
        return result;
    },
};


// Replaces the PID record of `key` with another valid tuple for the same
// process, as a concurrent owner would.
function rewritePidRecord(fleet, key, change) {
    const file = pidFile(fleet, key);
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, `${JSON.stringify({ ...current, ...change })}\n`, { mode: 0o600 });
}

const view = (observed) => ({
    state: observed.state,
    reason: observed.reason,
    hasRecord: Boolean(observed.record),
});

const STOP_VIEW = (result) => ({ state: result.state, reason: result.reason });

function deniedKillOps(calls) {
    return {
        kill(pid, signal) {
            if (signal === 0) return REAL_KILL(pid, 0);
            calls.push({ pid, signal });
            const error = new Error('operation not permitted');
            error.code = 'EPERM';
            throw error;
        },
    };
}

Object.assign(scenarios, {
    // A-M1: the structured observation. It never deletes anything.
    async 'observe-matrix'() {
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        const key = (name) => `ploinky_demo_${name}_ws_deadbeef`;
        const tuple = { instanceId: 'i1', enableGeneration: 'g1' };
        const other = { instanceId: 'x1', enableGeneration: 'y1' };
        const out = {};
        out.noDirectory = view(fleet.observeSandboxRuntime(key('nodir')));
        fs.mkdirSync(fleet.BWRAP_PIDS_DIR, { recursive: true, mode: 0o700 });
        out.noRecord = view(fleet.observeSandboxRuntime(key('none')));

        const live = spawnChild();
        fleet.saveBwrapPid(key('live'), live, tuple);
        out.liveExact = view(fleet.observeSandboxRuntime(key('live'), { expectedIdentity: tuple }));
        out.liveForeign = view(fleet.observeSandboxRuntime(key('live'), { expectedIdentity: other }));
        out.liveUntyped = view(fleet.observeSandboxRuntime(key('live')));

        const reused = spawnChild();
        fleet.saveBwrapPid(key('reused'), reused, tuple);
        rewritePidRecord(fleet, key('reused'), { processIdentity: `${pidRecord(fleet, key('reused')).processIdentity}-reused` });
        out.pidReuse = view(fleet.observeSandboxRuntime(key('reused'), { expectedIdentity: tuple }));
        out.pidReuseRecordKept = Boolean(pidRecord(fleet, key('reused')));

        // A zombie nobody reaped still answers kill(pid, 0) and still has its
        // start time: only its state says it is gone.
        const zombie = spawnChild();
        fleet.saveBwrapPid(key('zombie'), zombie, tuple);
        REAL_KILL(zombie, 'SIGKILL');
        out.zombieState = waitFor(() => psState(zombie).startsWith('Z'), 5000) ? 'Z' : psState(zombie);
        let signalable = true;
        try { REAL_KILL(zombie, 0); } catch (_) { signalable = false; }
        out.zombieStillSignalable = signalable;
        out.zombie = view(fleet.observeSandboxRuntime(key('zombie'), { expectedIdentity: tuple }));
        out.zombieRecordKept = Boolean(pidRecord(fleet, key('zombie')));

        // A record whose process exited and was reaped.
        const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
        fs.writeFileSync(pidFile(fleet, key('exited')), `${JSON.stringify({
            schemaVersion: 2, runtimeKey: key('exited'), pid: Number(gone.stdout), processIdentity: 'ps-lstart:gone', ...tuple,
        })}\n`, { mode: 0o600 });
        out.exitedPid = view(fleet.observeSandboxRuntime(key('exited'), { expectedIdentity: tuple }));

        fs.writeFileSync(pidFile(fleet, key('invalid')), '{"pid": 1}\n', { mode: 0o600 });
        out.invalidRecord = view(fleet.observeSandboxRuntime(key('invalid')));
        fs.writeFileSync(pidFile(fleet, key('legacy')), String(live), { mode: 0o600 });
        out.legacyRecord = view(fleet.observeSandboxRuntime(key('legacy')));
        fs.symlinkSync(pidFile(fleet, key('live')), pidFile(fleet, key('link')));
        out.symlinkRecord = view(fleet.observeSandboxRuntime(key('link')));
        fs.mkdirSync(pidFile(fleet, key('directory')));
        out.directoryRecord = view(fleet.observeSandboxRuntime(key('directory')));

        const unavailable = {
            readProcStat() { throw new Error('procfs unreadable'); },
            runPs() { throw new Error('ps unavailable'); },
        };
        out.probeFailure = view(fleet.observeSandboxRuntime(key('live'), { expectedIdentity: tuple, ops: unavailable }));
        out.epermStillExact = view(fleet.observeSandboxRuntime(key('live'), {
            expectedIdentity: tuple,
            ops: { kill(pid, signal) { if (signal === 0) { const e = new Error('eperm'); e.code = 'EPERM'; throw e; } return REAL_KILL(pid, signal); } },
        }));
        out.signalProbeError = view(fleet.observeSandboxRuntime(key('live'), {
            expectedIdentity: tuple,
            ops: { kill() { const e = new Error('io'); e.code = 'EIO'; throw e; } },
        }));
        out.filesAfter = fs.readdirSync(fleet.BWRAP_PIDS_DIR).sort();
        out.keys = ['live', 'reused', 'zombie', 'exited', 'invalid', 'legacy', 'link', 'directory'].map(key);
        killChildren();
        return out;
    },

    // A-T: termination postconditions.
    async 'stop-matrix'() {
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        const key = (name) => `ploinky_demo_${name}_ws_deadbeef`;
        const tuple = { instanceId: 'i1', enableGeneration: 'g1' };
        const out = {};
        const bind = (name, pid = spawnChild()) => { fleet.saveBwrapPid(key(name), pid, tuple); return pid; };

        // 1. A real stop: the process is observed gone before anything is claimed.
        let pid = bind('stop');
        let result = fleet.stopExactSandboxProcess(key('stop'), tuple, { timeout: 2000 });
        out.stop = STOP_VIEW(result);
        out.stopRecordGone = !pidRecord(fleet, key('stop'));
        out.stopZombieSignalable = (() => { try { REAL_KILL(pid, 0); return true; } catch (_) { return false; } })();
        out.stopAlive = isAlive(pid);

        // 2. Every signal denied.
        pid = bind('denied');
        let calls = [];
        result = fleet.stopExactSandboxProcess(key('denied'), tuple, { timeout: 100, ops: deniedKillOps(calls) });
        out.denied = STOP_VIEW(result);
        out.deniedSignals = calls.map((entry) => `${entry.signal}:${entry.pid < 0 ? 'group' : 'leader'}`);
        out.deniedRecordKept = Boolean(pidRecord(fleet, key('denied')));
        out.deniedAlive = isAlive(pid);

        // 3. Signals are accepted but the process survives, on a fake clock.
        pid = bind('survivor');
        calls = [];
        const clock = { now: 0 };
        result = fleet.stopExactSandboxProcess(key('survivor'), tuple, {
            timeout: 200,
            killTimeout: 200,
            ops: {
                kill(target, signal) { if (signal === 0) return REAL_KILL(target, 0); calls.push({ pid: target, signal }); return true; },
                sleep(ms) { clock.now += ms; },
                now() { return clock.now; },
            },
        });
        out.survivor = STOP_VIEW(result);
        out.survivorSignals = [...new Set(calls.map((entry) => entry.signal))];
        out.survivorRecordKept = Boolean(pidRecord(fleet, key('survivor')));
        out.survivorAlive = isAlive(pid);

        // 4. Identity inspection unavailable: nothing is signalled.
        pid = bind('unavailable');
        calls = [];
        result = fleet.stopExactSandboxProcess(key('unavailable'), tuple, {
            timeout: 100,
            ops: {
                readProcStat() { throw new Error('procfs unreadable'); },
                runPs() { throw new Error('ps unavailable'); },
                kill(target, signal) { if (signal !== 0) calls.push({ pid: target, signal }); return REAL_KILL(target, signal); },
            },
        });
        out.unavailable = STOP_VIEW(result);
        out.unavailableSignals = calls.length;
        out.unavailableRecordKept = Boolean(pidRecord(fleet, key('unavailable')));
        out.unavailableAlive = isAlive(pid);

        // 5. A foreign tuple is refused untouched.
        pid = bind('foreign');
        calls = [];
        result = fleet.stopExactSandboxProcess(key('foreign'), { instanceId: 'x1', enableGeneration: 'y1' }, {
            timeout: 100,
            ops: { kill(target, signal) { if (signal !== 0) calls.push({ pid: target, signal }); return REAL_KILL(target, signal); } },
        });
        out.foreign = STOP_VIEW(result);
        out.foreignSignals = calls.length;
        out.foreignRecordKept = Boolean(pidRecord(fleet, key('foreign')));
        out.foreignAlive = isAlive(pid);

        // 6. The group signal fails with ESRCH: the leader is signalled next.
        pid = bind('leader');
        calls = [];
        result = fleet.stopExactSandboxProcess(key('leader'), tuple, {
            timeout: 2000,
            ops: {
                kill(target, signal) {
                    if (signal !== 0) calls.push({ pid: target, signal });
                    if (signal !== 0 && target < 0) { const e = new Error('no such process group'); e.code = 'ESRCH'; throw e; }
                    return REAL_KILL(target, signal);
                },
            },
        });
        out.leader = STOP_VIEW(result);
        out.leaderSignals = calls.map((entry) => `${entry.signal}:${entry.pid < 0 ? 'group' : 'leader'}`);
        out.leaderAlive = isAlive(pid);

        // 7. PID reuse: a stale record never grants a signal.
        pid = bind('reused');
        rewritePidRecord(fleet, key('reused'), { processIdentity: `${pidRecord(fleet, key('reused')).processIdentity}-reused` });
        calls = [];
        result = fleet.stopExactSandboxProcess(key('reused'), tuple, {
            timeout: 100,
            ops: { kill(target, signal) { if (signal !== 0) calls.push({ pid: target, signal }); return REAL_KILL(target, signal); } },
        });
        out.reused = STOP_VIEW(result);
        out.reusedSignals = calls.length;
        out.reusedStaleRecordRemoved = !pidRecord(fleet, key('reused'));
        out.reusedAlive = isAlive(pid);

        // 8. The record is replaced between observation and the first signal.
        pid = bind('replaced');
        calls = [];
        let fired = false;
        const replaceOnce = (real) => (target) => {
            const value = real(target);
            if (!fired) {
                fired = true;
                rewritePidRecord(fleet, key('replaced'), { instanceId: 'replaced-instance' });
            }
            return value;
        };
        result = fleet.stopExactSandboxProcess(key('replaced'), tuple, {
            timeout: 100,
            ops: {
                readProcStat: replaceOnce((target) => REAL_READ_FILE_SYNC(`/proc/${target}/stat`, 'utf8')),
                runPs: replaceOnce((target) => REAL_EXEC_FILE_SYNC('ps', ['-p', String(target), '-o', 'stat=', '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })),
                kill(target, signal) { if (signal !== 0) calls.push({ pid: target, signal }); return REAL_KILL(target, signal); },
            },
        });
        out.replaced = STOP_VIEW(result);
        out.replacedSignals = calls.length;
        out.replacedRecordInstance = pidRecord(fleet, key('replaced'))?.instanceId;
        out.replacedAlive = isAlive(pid);

        // 9. A batch: each key gets its own outcome.
        const pidA = bind('batch-a');
        const pidB = bind('batch-b');
        const pidC = spawnChild();
        fleet.saveBwrapPid(key('batch-c'), pidC, { instanceId: 'other-1', enableGeneration: 'other-2' });
        const stoppedKeys = fleet.stopBwrapProcesses([key('batch-a'), key('batch-b'), key('batch-c'), key('batch-missing')], {
            timeout: 2000,
            expectedIdentities: new Map([[key('batch-c'), tuple]]),
        });
        out.batchStopped = stoppedKeys.sort();
        out.batchAlive = { a: isAlive(pidA), b: isAlive(pidB), c: isAlive(pidC) };
        out.batchForeignRecordKept = Boolean(pidRecord(fleet, key('batch-c')));
        out.keys = ['batch-a', 'batch-b', 'batch-c'].map(key);
        killChildren();
        return out;
    },
});


const SUCCESSOR = Object.freeze({ instanceId: 'new-instance', enableGeneration: 'new-enable' });
const CONTAINER_ID = 'a'.repeat(64);

async function bindLive(fleet, key, tuple) {
    const pid = spawnChild();
    fleet.saveBwrapPid(key, pid, tuple);
    return pid;
}

// Breaks only the identity probe, the way an unreadable /proc and a missing
// `ps` would. Restore with the returned function.
function breakIdentityProbe() {
    cp.execFileSync = (command, ...rest) => {
        if (command === 'ps') throw new Error('ps unavailable');
        return REAL_EXEC_FILE_SYNC(command, ...rest);
    };
    fs.readFileSync = (file, ...rest) => {
        if (typeof file === 'string' && file.startsWith('/proc/') && file.endsWith('/stat')) {
            const error = new Error('permission denied');
            error.code = 'EACCES';
            throw error;
        }
        return REAL_READ_FILE_SYNC(file, ...rest);
    };
    syncBuiltinESMExports();
    return () => {
        cp.execFileSync = REAL_EXEC_FILE_SYNC;
        fs.readFileSync = REAL_READ_FILE_SYNC;
        syncBuiltinESMExports();
    };
}

const receiptViews = () => receiptFiles().map((file) => {
    const document = JSON.parse(REAL_READ_FILE_SYNC(file, 'utf8'));
    return {
        runtime: document.predecessor.runtime,
        process: document.predecessor.process || null,
        predecessor: { instanceId: document.predecessor.instanceId, enableGeneration: document.predecessor.enableGeneration },
        successor: document.successor,
    };
});

const removalLabels = (events) => events.filter((entry) => entry.startsWith('remove:')).map((entry) => entry.slice('remove:'.length));

Object.assign(scenarios, {
    // Healthy and unchanged: the same tuple and process are reused, with no
    // stop, no receipt and no signal.
    async unchanged() {
        const { runtime } = argument;
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        const { writeRuntimePredecessor } = await cli('sandbox/runtimePredecessorStore.js');
        const registry = { [KEY]: nativeRecord(runtime, { envHash: 'same-env-hash' }) };
        const pid = await bindLive(fleet, KEY, PREDECESSOR);
        const before = pidRecord(fleet, KEY);
        let receiptWrites = 0;
        const spy = installKillSpy();
        const outcome = await runGraph({
            nodes: [graphNode()],
            registry,
            spyRemoval: true,
            options: {
                runtimeReplacementOptions: { getRuntimeForAgentImpl: () => runtime, computeEnvHashImpl: () => 'same-env-hash' },
                writeRuntimePredecessorImpl(receipt) { receiptWrites += 1; return writeRuntimePredecessor(receipt); },
            },
        });
        spy.restore();
        const result = {
            ...outcome,
            registryTuple: record(registry[KEY]),
            receiptWrites,
            receiptsLeft: receiptFiles().length,
            removals: removalLabels(outcome.events),
            signals: spy.signals,
            alive: isAlive(pid),
            pidRecordIntact: JSON.stringify(pidRecord(fleet, KEY)) === JSON.stringify(before),
        };
        killChildren();
        return result;
    },

    // Termination denied during staging, then a clean recovery start.
    async 'graph-denied'() {
        const { runtime } = argument;
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        const registry = { [KEY]: nativeRecord(runtime) };
        const pid = await bindLive(fleet, KEY, PREDECESSOR);
        const before = pidRecord(fleet, KEY);
        const options = { runtimeReplacementOptions: { getRuntimeForAgentImpl: () => runtime, computeEnvHashImpl: () => 'changed-env-hash' } };
        const denied = installKillSpy({ deny: true });
        const first = await runGraph({ nodes: [graphNode()], registry, options, spyRemoval: true });
        denied.restore();
        const afterFailure = {
            ok: first.ok,
            code: first.code,
            events: first.events,
            receipts: receiptViews(),
            alive: isAlive(pid),
            pidRecordIntact: JSON.stringify(pidRecord(fleet, KEY)) === JSON.stringify(before),
            signals: denied.signals.map((entry) => entry.signal),
        };
        const recovery = installKillSpy();
        const second = await runGraph({ nodes: [graphNode()], registry: structuredClone(first.persisted), options, spyRemoval: true });
        recovery.restore();
        const result = {
            first: afterFailure,
            persistedTuple: record(first.persisted?.[KEY]),
            second: {
                ok: second.ok,
                message: second.message,
                labels: removalLabels(second.events),
                receiptsLeft: receiptFiles().length,
                alive: isAlive(pid),
                pidRecordGone: !pidRecord(fleet, KEY),
                signals: recovery.signals.map((entry) => entry.signal),
            },
        };
        killChildren();
        return result;
    },

    // An owner that cannot be verified refuses the whole graph before it
    // inactivates, rotates or signals anything.
    async 'graph-unknown'() {
        const { runtime } = argument;
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        const pid = await bindLive(fleet, KEY, PREDECESSOR);
        const before = pidRecord(fleet, KEY);
        const restoreProbe = breakIdentityProbe();
        const spy = installKillSpy();
        const results = {};
        try {
            // Production liveness: the unverifiable owner is not "stopped".
            results.liveness = await runGraph({
                nodes: [graphNode()],
                registry: { [KEY]: nativeRecord(runtime) },
                options: { runtimeReplacementOptions: { getRuntimeForAgentImpl: () => runtime } },
            });
            // A replacement is already decided: capture still refuses.
            results.capture = await runGraph({
                nodes: [graphNode()],
                registry: { [KEY]: nativeRecord(runtime) },
                options: { runtimeReplacementReason: () => 'sandboxRuntimeStopped' },
            });
        } finally {
            spy.restore();
            restoreProbe();
        }
        const result = {
            liveness: { ok: results.liveness.ok, code: results.liveness.code, events: results.liveness.events },
            capture: { ok: results.capture.ok, code: results.capture.code, events: results.capture.events },
            receiptsLeft: receiptFiles().length,
            signals: spy.signals,
            alive: isAlive(pid),
            pidRecordIntact: JSON.stringify(pidRecord(fleet, KEY)) === JSON.stringify(before),
        };
        killChildren();
        return result;
    },

    // The exact removal dispatch against each state of the runtime slot.
    async 'removal-slots'() {
        const { runtime } = argument;
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        const store = await cli('sandbox/runtimePredecessorStore.js');
        const { removeGraphContainerForRecreate } = await cli('commands/workspaceUtil.js');
        const key = (name) => `ploinky_demo_${name}_ws_deadbeef`;
        const receiptFor = (name, process) => store.writeRuntimePredecessor({
            containerName: key(name),
            successor: SUCCESSOR,
            predecessor: { ...nativeRecord(runtime), ...(process ? { process } : {}) },
        });
        const remove = (name, receipt) => {
            try {
                const value = removeGraphContainerForRecreate(key(name), `workspaceGraph:demo:${name}`, nativeRecord(runtime), { predecessorReceipt: receipt });
                return { ok: true, value };
            } catch (error) {
                return { ok: false, code: error.code, message: error.message };
            }
        };
        const out = { pids: {} };
        const spy = installKillSpy();

        // PID reuse: the record's process is a different process now.
        let pid = await bindLive(fleet, key('reused'), PREDECESSOR);
        out.pids.reused = pid;
        rewritePidRecord(fleet, key('reused'), { processIdentity: `${pidRecord(fleet, key('reused')).processIdentity}-reused` });
        out.reused = { ...remove('reused', receiptFor('reused')), alive: isAlive(pid), staleRecordRemoved: !pidRecord(fleet, key('reused')) };

        // The slot holds another tuple (a newer successor): the predecessor is absent.
        pid = await bindLive(fleet, key('successor'), SUCCESSOR);
        out.pids.successor = pid;
        const successorRecord = pidRecord(fleet, key('successor'));
        out.successor = { ...remove('successor', receiptFor('successor')), alive: isAlive(pid), recordIntact: JSON.stringify(pidRecord(fleet, key('successor'))) === JSON.stringify(successorRecord) };

        // The PID record carries the predecessor tuple but not the captured process.
        pid = await bindLive(fleet, key('mismatch'), PREDECESSOR);
        out.pids.mismatch = pid;
        const mismatchRecord = pidRecord(fleet, key('mismatch'));
        out.mismatch = {
            ...remove('mismatch', receiptFor('mismatch', { pid: pid + 1, processIdentity: 'linux-proc:1' })),
            alive: isAlive(pid),
            recordIntact: JSON.stringify(pidRecord(fleet, key('mismatch'))) === JSON.stringify(mismatchRecord),
        };

        // The exact captured process: it is stopped, and only then the proof retired.
        pid = await bindLive(fleet, key('exact'), PREDECESSOR);
        out.pids.exact = pid;
        const exactRecord = pidRecord(fleet, key('exact'));
        out.exact = {
            ...remove('exact', receiptFor('exact', { pid, processIdentity: exactRecord.processIdentity })),
            alive: isAlive(pid),
            recordGone: !pidRecord(fleet, key('exact')),
        };

        // No record at all.
        out.absent = remove('absent', receiptFor('absent'));

        spy.restore();
        out.signals = spy.signals.map((entry) => ({ pid: entry.pid, signal: entry.signal }));
        out.receiptsLeft = receiptViews().length;
        out.mismatchReceiptKept = receiptViews().some((view) => view.process?.processIdentity === 'linux-proc:1');
        killChildren();
        return out;
    },
});


// Container-engine collaborators of the removal dispatch, recording calls.
function containerRemovalDeps(calls, { live }) {
    return {
        containerExistsImpl: () => live,
        getRuntimeImpl: () => 'podman',
        inspectExactContainerImpl: () => null,
        clearLivenessStateImpl: () => {},
        removeExactRegisteredContainerImpl(name, rec) {
            calls.push({ name, containerId: rec.containerId });
            return { removed: true, state: 'removed' };
        },
    };
}

const containerRecord = (overrides = {}) => ({
    type: 'agent',
    repoName: 'demo',
    agentName: 'background',
    runtime: 'podman',
    containerId: CONTAINER_ID,
    runMode: 'global',
    projectPath: root,
    profile: 'default',
    envHash: 'fixture-env-hash',
    ...PREDECESSOR,
    ...overrides,
});

const throwingProbes = () => ({
    isSandboxRunningImpl() { throw new Error('a sandbox probe ran'); },
    containerExistsImpl() { throw new Error('a container probe ran'); },
    isContainerRunningImpl() { throw new Error('a container probe ran'); },
});

Object.assign(scenarios, {
    // A-S/A-G: the predecessor record's runtime selects the probe and the
    // removal; the successor's backend only selects the launch.
    async 'backend-switch'() {
        const { runtime, from, live } = argument;
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        const bystander = await bindLive(fleet, 'ploinky_demo_bystander_ws_deadbeef', { instanceId: 'by-instance', enableGeneration: 'by-enable' });
        const containerCalls = [];
        let pid = null;
        let registry;
        let removalExtra;
        let reasonOptions;
        if (from === 'native') {
            registry = { [KEY]: nativeRecord(runtime) };
            if (live) pid = await bindLive(fleet, KEY, PREDECESSOR);
            reasonOptions = { getRuntimeForAgentImpl: () => 'podman', ...throwingProbes() };
            removalExtra = {
                containerExistsImpl() { throw new Error('a native predecessor must not reach the container engine'); },
                inspectExactContainerImpl() { throw new Error('a native predecessor must not reach the container engine'); },
                removeExactRegisteredContainerImpl() { throw new Error('a native predecessor must not reach the container engine'); },
            };
        } else {
            registry = { [KEY]: containerRecord() };
            reasonOptions = { getRuntimeForAgentImpl: () => runtime, ...throwingProbes() };
            removalExtra = {
                ...containerRemovalDeps(containerCalls, { live: Boolean(live) }),
                removeExactSandboxPredecessorImpl() { throw new Error('a container predecessor must not reach the native removal'); },
            };
        }
        const spy = installKillSpy();
        const outcome = await runGraph({
            nodes: [graphNode()],
            registry,
            spyRemoval: true,
            removalExtra,
            options: { runtimeReplacementOptions: reasonOptions },
        });
        spy.restore();
        const result = {
            ok: outcome.ok,
            code: outcome.code,
            message: outcome.message,
            labels: removalLabels(outcome.events),
            receiptsLeft: receiptFiles().length,
            registryTuple: record(registry[KEY]),
            containerCalls,
            engineCalls: engineCalls(),
            signals: spy.signals.map((entry) => entry.signal),
            predecessorAlive: pid ? isAlive(pid) : null,
            predecessorRecordGone: from === 'native' ? !pidRecord(fleet, KEY) : null,
            bystanderAlive: isAlive(bystander),
        };
        killChildren();
        return result;
    },

    // A crash at each transition, then the next start from what survived.
    async crash() {
        const { runtime, stage, live, to } = argument;
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        const { writeRuntimePredecessor } = await cli('sandbox/runtimePredecessorStore.js');
        const crash = new Error('simulated crash');
        crash.code = 'SIMULATED_CRASH';
        const original = { [KEY]: nativeRecord(runtime) };
        const pid = live ? await bindLive(fleet, KEY, PREDECESSOR) : null;
        const bystander = await bindLive(fleet, 'ploinky_demo_bystander_ws_deadbeef', { instanceId: 'by-instance', enableGeneration: 'by-enable' });
        const reasonOptions = to === 'container'
            ? { getRuntimeForAgentImpl: () => 'podman' }
            : { getRuntimeForAgentImpl: () => runtime, computeEnvHashImpl: () => 'changed-env-hash' };
        const options = { runtimeReplacementOptions: reasonOptions };
        const hooks = {};
        const removalExtra = {};
        const phaseOne = { ...options };
        if (stage === 'receipt') phaseOne.writeRuntimePredecessorImpl = (receipt) => { writeRuntimePredecessor(receipt); throw crash; };
        if (stage === 'registry') hooks.crashAfterRegistrySave = crash;
        if (stage === 'removal') hooks.crashBeforeRemoval = crash;
        if (stage === 'terminated') removalExtra.retireRuntimePredecessorImpl = () => { throw crash; };
        const spyOne = installKillSpy();
        const first = await runGraph({ nodes: [graphNode()], registry: structuredClone(original), options: phaseOne, spyRemoval: true, hooks, removalExtra });
        spyOne.restore();
        const afterCrash = {
            code: first.code,
            receipts: receiptViews().length,
            alive: pid ? isAlive(pid) : null,
            persistedTuple: record(first.persisted?.[KEY]),
            signals: spyOne.signals.map((entry) => entry.signal),
        };
        const spyTwo = installKillSpy();
        const second = await runGraph({
            nodes: [graphNode()],
            registry: structuredClone(first.persisted || original),
            options,
            spyRemoval: true,
        });
        spyTwo.restore();
        const result = {
            afterCrash,
            recovery: {
                ok: second.ok,
                message: second.message,
                labels: removalLabels(second.events),
                receiptsLeft: receiptFiles().length,
                alive: pid ? isAlive(pid) : null,
                pidRecordGone: !pidRecord(fleet, KEY),
                signals: spyTwo.signals.map((entry) => entry.signal),
                engineCalls: engineCalls(),
                bystanderAlive: isAlive(bystander),
            },
        };
        killChildren();
        return result;
    },

    // Mixed graph: each predecessor is removed by its own backend.
    async mixed() {
        const { runtime, containerChanged } = argument;
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        const containerKey = 'ploinky_demo_worker_ws_deadbeef';
        const nativeNode = graphNode();
        const containerNode = graphNode({ id: 'demo/worker', agent: 'worker' });
        const registry = {
            [KEY]: nativeRecord(runtime),
            [containerKey]: containerRecord({ agentName: 'worker' }),
        };
        const pid = await bindLive(fleet, KEY, PREDECESSOR);
        const containerCalls = [];
        const spy = installKillSpy();
        const outcome = await runGraph({
            nodes: [nativeNode, containerNode],
            registry,
            spyRemoval: true,
            removalExtra: {
                ...containerRemovalDeps(containerCalls, { live: true }),
            },
            options: {
                runtimeReplacementReason(plan) {
                    if (plan.node.id === nativeNode.id) return 'envHashChanged';
                    return containerChanged ? 'runtimeStopped' : '';
                },
            },
        });
        spy.restore();
        const result = {
            ok: outcome.ok,
            message: outcome.message,
            labels: removalLabels(outcome.events),
            changed: outcome.changed,
            nativeAlive: isAlive(pid),
            containerCalls,
            containerTuple: record(registry[containerKey]),
            nativeTuple: record(registry[KEY]),
            receiptRuntimes: receiptViews().map((view) => view.runtime || 'none'),
            engineCalls: engineCalls(),
            signals: spy.signals.map((entry) => entry.signal),
            keys: { native: KEY, container: containerKey },
        };
        killChildren();
        return result;
    },

    // A-S: how the replacement reason chooses its probe.
    async reasons() {
        const { runtime } = argument;
        const otherNative = runtime === 'seatbelt' ? 'bwrap' : 'seatbelt';
        const cases = {
            nativeToOtherNative: { record: nativeRecord(runtime), options: { getRuntimeForAgentImpl: () => otherNative, ...throwingProbes() } },
            nativeToContainer: { record: nativeRecord(runtime), options: { getRuntimeForAgentImpl: () => 'podman', ...throwingProbes() } },
            containerToNative: { record: containerRecord(), options: { getRuntimeForAgentImpl: () => runtime, ...throwingProbes() } },
            nativeStopped: { record: nativeRecord(runtime), options: { getRuntimeForAgentImpl: () => runtime } },
            unlaunchedToNative: { record: nativeRecord(runtime, { runtime: undefined }), options: { getRuntimeForAgentImpl: () => runtime } },
            containerMissing: {
                record: containerRecord(),
                options: { getRuntimeForAgentImpl: () => 'podman', containerExistsImpl: () => false },
            },
        };
        const out = {};
        for (const [name, entry] of Object.entries(cases)) {
            const containerCalls = [];
            const registry = { [KEY]: entry.record };
            const outcome = await runGraph({
                nodes: [graphNode()],
                registry,
                spyRemoval: true,
                removalExtra: containerRemovalDeps(containerCalls, { live: false }),
                options: { runtimeReplacementOptions: entry.options },
            });
            out[name] = { ok: outcome.ok, message: outcome.message, labels: removalLabels(outcome.events) };
            // Leave nothing behind for the next case.
            for (const file of receiptFiles()) fs.unlinkSync(file);
        }
        return out;
    },
});


Object.assign(scenarios, {
    // `ploinky stop` and `destroy`: slot-wide operator stops that never report
    // a native runtime stopped or removed unless its exit was observed.
    async 'operator-stop'() {
        const { runtime, deny } = argument;
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        const containerFleet = await cli('sandbox/docker/containerFleet.js');
        const key = (name) => `ploinky_demo_${name}_ws_deadbeef`;
        const tuple = (name) => ({ instanceId: `${name}-i`, enableGeneration: `${name}-g` });
        const names = ['live', 'stopped', 'unverifiable'];
        const agents = {};
        for (const name of argument.runtimeless ? ['live', 'unverifiable'] : names) {
            agents[key(name)] = {
                type: 'agent', repoName: 'demo', agentName: name, ...(argument.runtimeless ? {} : { runtime }), ...tuple(name),
            };
        }
        fs.writeFileSync(path.join(root, '.ploinky', 'agents.json'), JSON.stringify(agents));
        const pids = { live: await bindLive(fleet, key('live'), tuple('live')) };
        pids.unverifiable = await bindLive(fleet, key('unverifiable'), tuple('unverifiable'));
        fs.writeFileSync(pidFile(fleet, key('unverifiable')), '{"pid": 1}\n');
        const unverifiableBytes = fs.readFileSync(pidFile(fleet, key('unverifiable')), 'utf8');

        const preserved = [];
        const spy = installKillSpy({ deny: Boolean(deny) });
        const stopped = argument.destroy ? null : containerFleet.stopConfiguredAgents({ fast: true });
        const removed = argument.destroy
            ? containerFleet.stopAndRemoveMany(Object.keys(agents), {
                fast: true,
                onPreserved: (entry) => preserved.push({ name: entry.name, touched: entry.runtimeTouched }),
            })
            : null;
        spy.restore();
        const result = {
            stopped,
            removed,
            preserved,
            signals: [...new Set(spy.signals.map((entry) => entry.signal))],
            liveAlive: isAlive(pids.live),
            liveRecordKept: Boolean(pidRecord(fleet, key('live'))),
            unverifiableAlive: isAlive(pids.unverifiable),
            unverifiableRecordIntact: fs.readFileSync(pidFile(fleet, key('unverifiable')), 'utf8') === unverifiableBytes,
            keys: Object.fromEntries(names.map((name) => [name, key(name)])),
            names: Object.fromEntries(names.map((name) => [name, name])),
        };
        killChildren();
        return result;
    },
});


Object.assign(scenarios, {
    // Linux only: identity and state come from /proc, with `ps` unusable.
    async procfs() {
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        const key = 'ploinky_demo_procfs_ws_deadbeef';
        const tuple = { instanceId: 'i', enableGeneration: 'g' };
        const pid = spawnChild();
        fleet.saveBwrapPid(key, pid, tuple);
        const restore = breakIdentityProbe();
        const out = {};
        try {
            // Only the `ps` fallback and the EACCES on /proc are broken by this
            // helper; restore /proc reading so only `ps` stays unavailable.
            fs.readFileSync = REAL_READ_FILE_SYNC;
            syncBuiltinESMExports();
            out.identity = pidRecord(fleet, key).processIdentity;
            out.stat = REAL_READ_FILE_SYNC(`/proc/${pid}/stat`, 'utf8').split(')').pop().trim().split(/\s+/)[0];
            out.live = fleet.observeSandboxRuntime(key, { expectedIdentity: tuple }).state;
            REAL_KILL(pid, 'SIGKILL');
            out.zombieSeen = waitFor(() => {
                try { return REAL_READ_FILE_SYNC(`/proc/${pid}/stat`, 'utf8').split(')').pop().trim().startsWith('Z'); } catch (_) { return false; }
            }, 5000);
            const gone = fleet.observeSandboxRuntime(key, { expectedIdentity: tuple });
            out.afterKill = { state: gone.state, reason: gone.reason };
        } finally {
            restore();
        }
        killChildren();
        return out;
    },
});


Object.assign(scenarios, {
    // A prepared record that names no runtime (legacy, or never finalized)
    // while a native process of its exact tuple exists, staged by the real
    // graph with the real removal dispatch.
    async 'runtimeless-graph'() {
        const { runtime, mode, enableSandbox } = argument;
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        if (enableSandbox) {
            fs.writeFileSync(path.join(root, '.ploinky', 'agents.json'), JSON.stringify({ _config: { sandbox: { disableHostRuntimes: false } } }));
        }
        const registry = { [KEY]: nativeRecord(runtime, { runtime: undefined }) };
        delete registry[KEY].runtime;
        let pid = null;
        if (mode !== 'absent') {
            pid = await bindLive(fleet, KEY, PREDECESSOR);
            if (mode === 'stale') {
                REAL_KILL(pid, 'SIGKILL');
                waitFor(() => !isAlive(pid), 3000);
            }
        }
        const bystander = await bindLive(fleet, 'ploinky_demo_bystander_ws_deadbeef', { instanceId: 'by-instance', enableGeneration: 'by-enable' });
        const desiredContainer = mode === 'to-container';
        const reasonOptions = {
            ...(enableSandbox ? {} : { getRuntimeForAgentImpl: () => (desiredContainer ? 'podman' : runtime) }),
            ...(mode === 'unchanged' ? { computeEnvHashImpl: () => 'fixture-env-hash' } : { computeEnvHashImpl: () => 'changed-env-hash' }),
        };
        const stageNode = graphNode(enableSandbox ? {
            // With the host sandbox really enabled, the admitted manifest is a host-network one.
            manifest: { 'lite-sandbox': true, start: 'node index.js', network: { mode: 'host' }, readiness: { protocol: 'none' } },
        } : {});
        const spy = installKillSpy({ deny: mode === 'denied' });
        const outcome = await runGraph({
            nodes: [stageNode],
            registry,
            spyRemoval: true,
            options: { runtimeReplacementOptions: reasonOptions },
        });
        spy.restore();
        // A denied stop keeps the proof and the process; the next start recovers it.
        let denied = null;
        let recovery = null;
        let registryAfter = registry;
        if (mode === 'denied') {
            denied = {
                ok: outcome.ok,
                code: outcome.code,
                receipts: receiptViews(),
                alive: isAlive(pid),
                recordKept: Boolean(pidRecord(fleet, KEY)),
            };
            registryAfter = structuredClone(outcome.persisted);
            const second = installKillSpy();
            recovery = await runGraph({
                nodes: [stageNode],
                registry: registryAfter,
                spyRemoval: true,
                options: { runtimeReplacementOptions: reasonOptions },
            });
            second.restore();
            recovery = { ok: recovery.ok, message: recovery.message, signals: second.signals.map((entry) => entry.signal) };
        }
        // The slot must not stay occupied for the successor.
        let slotAfter;
        try {
            slotAfter = fleet.resolveSandboxSlotForStart(KEY, {
                successor: { instanceId: registryAfter[KEY].instanceId, enableGeneration: registryAfter[KEY].enableGeneration },
                expectedPredecessor: null,
            }).kind;
        } catch (error) {
            slotAfter = error.code;
        }
        const result = {
            denied,
            recovery,
            slotAfter,
            ok: outcome.ok,
            code: outcome.code,
            message: outcome.message,
            events: outcome.events,
            labels: removalLabels(outcome.events),
            receiptsLeft: receiptFiles().length,
            registryTuple: record(registry[KEY]),
            signals: spy.signals.map((entry) => entry.signal),
            alive: pid ? isAlive(pid) : null,
            pidRecordGone: !pidRecord(fleet, KEY),
            engineCalls: engineCalls(),
            bystanderAlive: isAlive(bystander),
        };
        killChildren();
        return result;
    },

    // The default liveness of the Seatbelt shared-link guard.
    async 'seatbelt-consumers'() {
        const fleet = await cli('sandbox/bwrap/bwrapFleet.js');
        const { liveSeatbeltSourceConsumers } = await cli('sandbox/seatbelt/seatbeltServiceManager.js');
        const sourceDir = path.join(root, 'source');
        const key = (name) => `ploinky_demo_${name}_ws_deadbeef`;
        const tuple = (name) => ({ instanceId: `${name}-i`, enableGeneration: `${name}-g` });
        const record = (name) => ({
            runtime: 'seatbelt', ...tuple(name), config: { binds: [{ source: sourceDir, target: sourceDir }] },
        });
        const agents = Object.fromEntries(['exact', 'foreign', 'unverifiable', 'absent', 'stale'].map((name) => [key(name), record(name)]));
        const live = {
            exact: await bindLive(fleet, key('exact'), tuple('exact')),
            foreign: await bindLive(fleet, key('foreign'), { instanceId: 'newer-i', enableGeneration: 'newer-g' }),
            unverifiable: await bindLive(fleet, key('unverifiable'), tuple('unverifiable')),
            stale: await bindLive(fleet, key('stale'), tuple('stale')),
        };
        fs.writeFileSync(pidFile(fleet, key('unverifiable')), '{"pid": 1}\n');
        REAL_KILL(live.stale, 'SIGKILL');
        waitFor(() => !isAlive(live.stale), 3000);
        const consumers = liveSeatbeltSourceConsumers(path.join(sourceDir, 'node_modules'), {
            loadAgents: () => agents,
            store: { listReaderReceipts: () => [] },
        });
        const result = { consumers: consumers.sort(), keys: Object.fromEntries(Object.keys(agents).map((k) => [k.split('_')[2], k])) };
        killChildren();
        return result;
    },
});

const handler = scenarios[scenario];
if (!handler) {
    console.error(`unknown scenario ${scenario}`);
    process.exit(64);
}
try {
    const result = await handler();
    console.log(JSON.stringify(result));
} finally {
    killChildren();
}
