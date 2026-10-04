// An offline model of the product's hardware policy store for the LIVE-C5 tests, layered over the fake engine world (fakeLiveEngine.mjs).
// Unlike the availability fake it models nothing about the store: the store, its lock, its CAS stamp, its barrier and the stale-lock recovery are the
// PRODUCT's own modules (cli/sandbox/hardwareLimits/store.mjs and storeLock.mjs) running over a real private directory, which stands for the one
// directory the host and the Box share. What is faked is only the glue around them:
//   - the Router's administrator route (state, set_agent_limits, clear_agent_limits) calls the product's setAgentLimits and clearAgentLimits in-process
//     with the same barrier check the route makes; a stopped Box answers nothing;
//   - the candidate's `limits clear --agent` runs the product's clearAgentLimits through withStaleStoreLockRecovery with the Box state the fake world
//     records, as runLimitsClear does; `stop` ends the Box and every program running in it (a held lock stays behind);
//   - the reviewed STORE_PROGRAM runs for real, as a node child process, on the host and "inside the Box" (the Box root is rewritten to the shared
//     directory and the product root to this repository), with holds shortened so the tests are quick.
// Faults (all default off): lostUpdate (the in-Box setter ignores the stamp), ignoreBarrier, stealLock (the in-Box writer removes a held lock),
// hostIgnoresBox (the host recovery sees the Box stopped while it runs), liveHostRecovered (a live holder is judged dead), hostClearNoop,
// deleteQuarantine, stopKeepsBoxChildren, boxUid, mutateProgram(domain, mode, lines, n) (n counts the runs of that domain and mode), lockDeadlineMs,
// adminDown, holdMs, adminTokenOffset (the route reports a stamp that is not the store's), setNoop (the route commits without writing), errorCodes (a map of
// product error codes to the codes the route answers), hostClearDelayMs (the host clear starts that much later), lostUpdateFrom (n: the in-Box setter ignores the
// stamp from its n-th write on), refuseButWrite (a stale setter is answered revision_conflict but writes anyway), hostClearNoopFrom (n: the host clear does nothing from
// its n-th call on and still exits 0), hostClearNoopAt / hostClearFailAt (n: only the n-th host clear does nothing and exits 0, or exits 1), deleteQuarantineFrom (n:
// from the n-th host clear on, the quarantined locks are removed), stopExit (the host stop exits with that status), hostIgnoresBarrier (the host clear does not see the
// barrier), rejectPost (n: the n-th in-Box write is answered 422), stopKeepsBoxRunning (the stop returns but the Box keeps running).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { HardwareStoreError, assertPolicyWritesAllowed, clearAgentLimits, hardwareStorePaths, initializeStore, readStoreSnapshot, setAgentLimits } from '../../cli/sandbox/hardwareLimits/store.mjs';
import { withStaleStoreLockRecovery } from '../../cli/sandbox/hardwareLimits/storeLock.mjs';
import { ADMIN_REQUEST } from './liveGpuCommands.mjs';
import { createDowngradeWorld, engineRecordFromHandle, rawInspectFromHandle, REPOSITORY } from './c5DriverWorld.mjs';
import { runDriver } from './liveStoreTransition.mjs';
import { tokenKey } from './liveStoreCommands.mjs';
import { FIXTURE_REPOSITORY } from './liveFixture.mjs';
import { STORE_PROGRAM } from './liveStoreCommands.mjs';

const ok = (stdout, extra = {}) => ({ status: 0, signal: null, stdout, stderr: '', timedOut: false, truncated: false, cancelled: false, errorCode: null, settlementForced: false, ...extra });
const failed = (stderr, status = 1) => ok('', { status, stderr });
const REPOSITORY_ROOT = fs.realpathSync(new URL('../..', import.meta.url).pathname);
const ENVELOPE = Object.freeze({ memoryBytes: 8 * 1024 ** 3, cpus: 4 });

// `lifecycle` (optional) turns on the actual-lifecycle model: { source, ports }. The Box the fake engine creates at `start` then carries the labels and
// mounts the product's own contract validators accept, and the driver (liveStoreTransition.mjs) runs for real, in-process, over the product's REAL
// supervisor, transition and store with a stub engine behind the supervisor's runner (c5DriverWorld.mjs). The fake engine's container table follows
// that world's after every driver run. Faults: lifecycle.world (faults of the stub engine), restartExit, restartReplacesBox, adminDownAfterRestart,
// beforeDriver(mode, context) and afterDriver(mode, context), driverTimeout (a mode), driverForcedSettlement (a mode).
export function createFakeStore({ base, workspace, home, faults = {}, lifecycle = null }) {
    // The workspace exists only once provisioning created it, so the identity and the paths are derived on first use.
    let derived = null;
    const context = () => {
        if (derived) return derived;
        const identity = buildWorkspaceIdentity(workspace);
        const hostPaths = hardwareStorePaths({ identity, context: 'host', homeDirectory: home });
        const boxPaths = Object.freeze({ ...hardwareStorePaths({ identity, context: 'box', boxRoot: hostPaths.storeRoot }), ...(faults.ignoreBarrier ? { barrierPath: path.join(hostPaths.storeRoot, 'no-barrier-here.json') } : {}) });
        derived = { identity, hostPaths, boxPaths };
        return derived;
    };
    const agentRef = `${FIXTURE_REPOSITORY}/s`;
    const model = { children: new Set(), counts: new Map(), posts: 0, clears: 0, calls: [], programs: [], boxChildren: new Set(), stops: 0, initialized: false, adminCalls: [], restarts: [], driverRuns: [], world: null };
    const lockDeadlineMs = faults.lockDeadlineMs ?? 250;

    // The host created the real store at the first gate-on start; the fake engine only wrote a stub in its place.
    function ensureStore() {
        if (model.initialized) return;
        const { identity, hostPaths } = context();
        fs.rmSync(hostPaths.storeRoot, { recursive: true, force: true });
        initializeStore({ paths: hostPaths, identity });
        model.initialized = true;
    }
    const worldState = () => JSON.parse(fs.readFileSync(base.statePath, 'utf8'));
    const boxRecord = state => Object.values(state.boxes).find(box => box.labels?.[BOX_LABELS.pathHash] === context().identity.pathHash) ?? null;
    const boxRunning = () => boxRecord(worldState())?.running === true;
    function stopBox() {
        const state = worldState();
        const record = boxRecord(state);
        if (record && !faults.stopKeepsBoxRunning) record.running = false;
        fs.writeFileSync(base.statePath, JSON.stringify(state));
        if (!faults.stopKeepsBoxChildren) for (const child of model.boxChildren) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ } }
        model.stops += 1;
    }

    // ---- the Router's administrator route ----
    const errorReply = error => ({ status: Number.isInteger(error?.status) ? error.status : 503, text: JSON.stringify({ ok: false, error: String(faults.errorCodes?.[error?.code] || error?.code || 'error'), message: String(error?.message || error).slice(0, 400), ...(error?.committed === true ? { committed: true, token: error.token } : {}) }) });
    function admin(method, bodyText) {
        ensureStore();
        const { identity, boxPaths } = context();
        model.adminCalls.push({ method, body: bodyText });
        if (method === 'GET') {
            const snapshot = readStoreSnapshot({ paths: boxPaths, identity });
            const token = faults.adminTokenOffset ? { ...snapshot.token, revision: snapshot.token.revision + faults.adminTokenOffset } : snapshot.token;
            return { status: 200, text: JSON.stringify({ ok: true, token, agents: [] }) };
        }
        let body;
        try { body = JSON.parse(bodyText); } catch { return { status: 400, text: JSON.stringify({ ok: false, error: 'invalid_json' }) }; }
        try {
            // The route checks the barrier before it does anything else.
            if (!faults.ignoreBarrier) assertPolicyWritesAllowed({ paths: boxPaths });
            if (faults.stealLock) fs.rmSync(path.join(boxPaths.storeRoot, 'write.lock'), { recursive: true, force: true });
            model.posts += 1;
            if (faults.rejectPost === model.posts) return { status: 422, text: JSON.stringify({ ok: false, error: 'invalid_limits', message: 'rejected by the model' }) };
            const expectedToken = faults.lostUpdate || (faults.lostUpdateFrom && model.posts >= faults.lostUpdateFrom) ? undefined : body.expectedToken;
            const common = { paths: boxPaths, identity, expectedToken, agentRef: body.agentRef, actor: { id: 'local:admin', name: 'admin' }, lockOptions: { deadlineMs: lockDeadlineMs }, beforeCommit: () => true };
            if (faults.setNoop && body.action === 'set_agent_limits') return { status: 200, text: JSON.stringify({ ok: true, token: readStoreSnapshot({ paths: boxPaths, identity }).token, committed: true, agents: [] }) };
            if (faults.refuseButWrite && body.action === 'set_agent_limits' && tokenKey(body.expectedToken) !== tokenKey(readStoreSnapshot({ paths: boxPaths, identity }).token)) {
                setAgentLimits({ ...common, expectedToken: undefined, limits: body.limits, installedRefs: new Set([agentRef]), capabilities: { gate: 'on', controllers: ['cpu', 'memory', 'pids'] }, envelope: ENVELOPE });
                return { status: 409, text: JSON.stringify({ ok: false, error: 'revision_conflict', message: 'The hardware policy changed since it was read; reload and retry.' }) };
            }
            const result = body.action === 'set_agent_limits'
                ? setAgentLimits({ ...common, limits: body.limits, installedRefs: new Set([agentRef]), capabilities: { gate: 'on', controllers: ['cpu', 'memory', 'pids'] }, envelope: ENVELOPE })
                : body.action === 'clear_agent_limits' ? clearAgentLimits(common) : null;
            if (!result) return { status: 400, text: JSON.stringify({ ok: false, error: 'unknown_action' }) };
            return { status: 200, text: JSON.stringify({ ok: true, token: result.token, committed: result.committed, agents: [] }) };
        } catch (error) { return errorReply(error); }
    }

    // ---- the candidate's `limits clear --agent` and `stop` ----
    function observeBox() {
        if (faults.hostIgnoresBox) return { state: 'stopped' };
        const record = boxRecord(worldState());
        return { state: !record ? 'absent' : record.running === true ? 'running' : 'stopped' };
    }
    async function hostClear(args) {
        if (faults.hostClearDelayMs) await new Promise(resolve => setTimeout(resolve, faults.hostClearDelayMs));
        ensureStore();
        const { identity, hostPaths } = context();
        const ref = args[args.indexOf('--agent') + 1];
        try {
            model.clears += 1;
            if (faults.hostClearFailAt === model.clears) return failed('The host clear failed (model).\n');
            const noop = faults.hostClearNoop || (faults.hostClearNoopFrom && model.clears >= faults.hostClearNoopFrom) || faults.hostClearNoopAt === model.clears;
            const clearPaths = faults.hostIgnoresBarrier ? { ...hostPaths, barrierPath: path.join(hostPaths.storeRoot, 'no-barrier-here.json') } : hostPaths;
            withStaleStoreLockRecovery(() => (noop ? { committed: true } : clearAgentLimits({ paths: clearPaths, identity, agentRef: ref, actor: { id: 'host', name: 'test' }, lockOptions: { deadlineMs: lockDeadlineMs } })), {
                storeRoot: hostPaths.storeRoot, hostLock: { assertHeld() {} }, instance: identity.instance, inspectBox: observeBox,
                ...(faults.liveHostRecovered ? { kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } } : {}),
            });
            if (faults.deleteQuarantine || (faults.deleteQuarantineFrom && model.clears >= faults.deleteQuarantineFrom)) for (const name of fs.readdirSync(hostPaths.storeRoot)) if (name.startsWith('write.lock.stale-')) fs.rmSync(path.join(hostPaths.storeRoot, name), { recursive: true, force: true });
            return ok(`Cleared the stored hardware limits of ${ref}.\n`);
        } catch (error) { return failed(`${String(error?.message || error)}\n`); }
    }

    // ---- the actual lifecycle ----
    const saveState = state => fs.writeFileSync(base.statePath, JSON.stringify(state));
    // The Box the fake engine just created, as the product's own contract validators see it. Called after a successful `start`.
    function adoptBox(options) {
        if (!lifecycle || model.world) return;
        ensureStore();
        const { identity } = context();
        const state = worldState();
        const record = boxRecord(state);
        const world = createDowngradeWorld({ root: path.join(home, '.c5-model'), workspace: { path: workspace }, home, identity, boxId: record.id, created: record.created,
            hostPort: lifecycle.ports.tcp, mediaHostPort: lifecycle.ports.udp, repositoryRoot: lifecycle.source, linkProduct: false, faults: lifecycle.world ?? {},
            ...(options?.env?.PLOINKY_BOX_IMAGE ? { imageRef: options.env.PLOINKY_BOX_IMAGE } : {}) });
        world.restoreHome();
        Object.assign(record, engineRecordFromHandle(world.oldHandle, { created: record.created }), { name: identity.instance, imageName: record.imageName });
        saveState(state);
        model.world = world;
    }
    // The world's container follows the fake engine's running state, and the engine follows the world's table.
    function syncWorldFromEngine() {
        const record = boxRecord(worldState());
        for (const entry of model.world.containers.values()) {
            const on = record?.running === true;
            entry.handle.runtime.running = on; entry.handle.runtime.status = on ? 'running' : 'exited';
            if (!on) entry.graphRunning = false;
        }
    }
    function syncEngineFromWorld() {
        const { identity } = context();
        const state = worldState();
        for (const [id, box] of Object.entries(state.boxes)) if (box.labels?.[BOX_LABELS.pathHash] === identity.pathHash) delete state.boxes[id];
        for (const [id, entry] of model.world.containers) {
            state.boxes[id] = { ...engineRecordFromHandle(entry.handle, { created: entry.created }), name: identity.instance, running: entry.handle.runtime.running };
        }
        saveState(state);
    }
    async function runLifecycleDriver(args, options) {
        if (!model.world) return failed('The lifecycle model has no Box to run over', 1);
        const params = JSON.parse(args[1]);
        syncWorldFromEngine();
        model.driverRuns.push({ mode: params.mode, expectedContainerId: params.expectedContainerId ?? null });
        const world = model.world;
        if (faults.beforeDriver) await faults.beforeDriver(params.mode, { world, context: context() });
        const run = await world.withHome(() => runDriver(params, { baseRunner: world.runner, supervisor: world.makeSupervisor, programRoot: REPOSITORY }));
        syncEngineFromWorld();
        const summary = { ...run.summary };
        const after = { params, summary, receiptPath: params.receiptPath, statePath: base.statePath };
        if (faults.afterDriver) await faults.afterDriver(params.mode, after);
        if (faults.driverTimeout === params.mode) return ok(`${JSON.stringify(summary)}\n`, { status: null, signal: 'SIGTERM', timedOut: true });
        if (faults.driverForcedSettlement === params.mode) return ok(`${JSON.stringify(summary)}\n`, { status: null, signal: 'SIGKILL', settlementForced: true });
        return ok(`${JSON.stringify(after.summary)}\n`, { status: after.exitCode ?? run.exitCode });
    }

    // ---- the reviewed program, for real ----
    function runProgram(domain, args, options) {
        const at = args.length - 1;
        const params = JSON.parse(args[at]);
        params.root = REPOSITORY_ROOT;
        if (domain === 'box') params.storeRoot = context().hostPaths.storeRoot;
        if (params.mode === 'hold' || params.mode === 'stale') params.holdMs = faults.holdMs ?? (params.holdMs >= 100000 ? 20000 : 1500);
        model.programs.push({ domain, mode: params.mode });
        const words = [...args.slice(0, at), JSON.stringify(params)];
        const child = spawn(process.execPath, words, { cwd: workspace, env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR ?? '/tmp' }, stdio: ['ignore', 'pipe', 'pipe'] });
        model.children.add(child);
        if (domain === 'box') model.boxChildren.add(child);
        let stdout = ''; let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const timer = setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, options.deadlineMs ?? 60000);
        return new Promise(resolve => child.on('close', (code, signal) => {
            clearTimeout(timer); model.boxChildren.delete(child); model.children.delete(child);
            let text = stdout;
            if (faults.mutateProgram || faults.boxUid !== undefined) {
                let lines = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
                if (faults.boxUid !== undefined && domain === 'box') lines = lines.map(line => (line.mode === 'inspect' ? { ...line, uid: faults.boxUid } : line));
                if (faults.mutateProgram) { const key = `${domain}:${params.mode}`; const n = (model.counts.get(key) ?? 0) + 1; model.counts.set(key, n); lines = faults.mutateProgram(domain, params.mode, lines, n) ?? lines; }
                text = lines.map(line => `${JSON.stringify(line)}\n`).join('');
            }
            resolve(ok(text, { status: signal ? null : code, signal, stderr }));
        }));
    }

    async function provider(binary, args, options = {}) {
        model.calls.push({ binary, args, cwd: options.cwd });
        const isBoxExec = args[0] === 'container' && args[1] === 'exec';
        // The full inspect document of one exact generation (no --format): what the product's own normalizer reads.
        if (lifecycle && model.world && args[0] === 'container' && args[1] === 'inspect' && !args.includes('--format') && args.length === 3) {
            const entry = model.world.containers.get(args[2]);
            const record = Object.values(worldState().boxes).find(box => box.id === args[2]);
            if (!entry || !record) return failed('no such container', 125);
            syncWorldFromEngine();
            return ok(JSON.stringify([rawInspectFromHandle(entry.handle, { created: entry.created })]));
        }
        if (isBoxExec && args.includes(ADMIN_REQUEST)) {
            if (!boxRunning() || faults.adminDown || (faults.adminDownAfterRestart && model.restarts.length)) return failed('Error: container is not running', 125);
            const at = args.indexOf(ADMIN_REQUEST);
            return ok(JSON.stringify(admin(args[at + 1], args[at + 2])));
        }
        if (isBoxExec && args.includes(STORE_PROGRAM)) {
            ensureStore();
            if (!boxRunning()) return failed('Error: container is not running', 125);
            return runProgram('box', args.slice(args.indexOf('--input-type=module')), options);
        }
        if (binary === base.node && args[0] === '--input-type=module' && args.includes(STORE_PROGRAM)) { ensureStore(); return runProgram('host', args, options); }
        if (binary === base.node && /ploinky-box\.mjs$/.test(args[0] ?? '')) {
            if (args[1] === 'limits' && args[2] === 'clear') return hostClear(args);
            if (args[1] === 'stop') { stopBox(); return faults.stopExit ? failed('The stop failed (model).\n', faults.stopExit) : ok('The Box was stopped.\n'); }
            if (lifecycle && args.includes('start') && !args.includes('restart')) {
                const result = await base.provider(binary, args, options);
                if (result.status === 0) adoptBox(options);
                return result;
            }
            if (lifecycle && args[1] === 'restart') {
                model.restarts.push({ gate: options.env?.PLOINKY_BOX_HARDWARE_LIMITS ?? null });
                if (faults.restartExit) return failed('The restart failed (model).\n', faults.restartExit);
                const state = worldState();
                const record = boxRecord(state);
                if (faults.restartReplacesBox) {
                    const id = crypto.createHash('sha256').update(`replaced-${record.id}`).digest('hex');
                    delete state.boxes[record.id];
                    state.boxes[id] = { ...record, id, created: '2026-10-04T09:09:09Z', running: true };
                } else if (record) record.running = true;
                saveState(state);
                return ok('The workspace restarted.\n');
            }
        }
        if (lifecycle && binary === base.node && /\/tests\/hardware-limits\/liveStoreTransition\.mjs$/.test(args[0] ?? '')) return runLifecycleDriver(args, options);
        return base.provider(binary, args, options);
    }
    return { provider, model, context, ensureStore, boxRunning, agentRef, admin };
}

export { HardwareStoreError };
