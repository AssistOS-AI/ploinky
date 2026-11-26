import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BOX_IMAGE_REFERENCE } from '../../ploinky-box/constants.mjs';
import { parseOuterArguments } from '../../ploinky-box/command/parse.mjs';
import { createQuiescenceGate } from '../../ploinky-box/hostState/quiescence.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { containerCreateArgs } from '../../ploinky-box/lifecycle/container.mjs';
import { reconcileBoxContainer } from '../../ploinky-box/lifecycle/transactions.mjs';
import { inspectWorkspaceDataPaths } from '../../ploinky-box/workspace-data.mjs';
import { resolveBoxDataSources } from '../../ploinky-box/hostState/confinement.mjs';
import { createMutationLockManager } from '../../ploinky-box/locks.mjs';
import { nestedPodmanSeccompProfilePath } from '../../ploinky-box/seccomp.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { OUTER_IMAGE_ID_FIXTURE, imageAgentLibFixture, agentLibFixture } from '../helpers/agentlibFixture.mjs';
import { handleFromCreateArgs } from '../helpers/hostStateFixture.mjs';
import { initializeWorkspaceMasterKey, readWorkspaceMasterKey } from '../../ploinky-box/entrypoint/initialize-workspace.mjs';
import { deriveSubkeyFromSeed } from '../../cli/utils/security/masterKey.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = Object.freeze({ dependencies: 'd'.repeat(64), images: 'f'.repeat(64) });
const ENGINE = Object.freeze({ name: 'podman', identity: 'engine', hostKind: 'native-linux' });
const silent = { write() { return true; } };

function treeDigest(target) {
    const hash = crypto.createHash('sha256');
    const visit = (current) => {
        let stat;
        try { stat = fs.lstatSync(current); } catch (_) { hash.update('absent'); return; }
        hash.update(`${path.relative(target, current)}:${stat.mode}:`);
        if (stat.isDirectory()) for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
        else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(current));
        else hash.update(fs.readFileSync(current));
    };
    visit(target);
    return hash.digest('hex');
}

// A workspace with a stub engine. `old` is an owned Box created with the
// current contract (or none); data directories are real.
async function world(t, { old = 'running', dataPaths = false, localAgentLib = false, prepare = () => {} } = {}) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-gate-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const checkout = path.join(base, 'checkout');
    const seccomp = nestedPodmanSeccompProfilePath(checkout);
    fs.mkdirSync(path.dirname(seccomp), { recursive: true });
    fs.copyFileSync(new URL('../../ploinky-box/seccomp/podman-nested-pid-fallback.json', import.meta.url), seccomp);
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    const workspace = path.join(base, 'W');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.data'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.data', '.layout.json'), '{"version":4}');
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    if (dataPaths) for (const target of Object.values(identity.dataPaths)) fs.mkdirSync(target, { recursive: true });
    prepare(identity, workspace);
    const lock = await createMutationLockManager().acquire(identity.instance, { workspaceRoot: workspace });
    t.after(() => { try { lock.release(); } catch (_) {} });
    const agentLib = localAgentLib ? agentLibFixture(identity.workspaceRoot) : imageAgentLibFixture();
    const render = (fingerprints, cidfile, dataSources = undefined) => containerCreateArgs({
        identity, dataFingerprints: fingerprints, dataSources, agentLib, imageId: OUTER_IMAGE_ID_FIXTURE, imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 18080, repositoryRoot: checkout, cidfile,
    });
    const calls = [];
    let current = null;
    if (old) {
        const fingerprints = dataPaths ? inspectWorkspaceDataPaths({ identity }).fingerprints : DATA;
        const sources = dataPaths ? resolveBoxDataSources(identity).sources : undefined;
        current = handleFromCreateArgs(render(fingerprints, path.join(base, 'old.cid'), sources), 'e'.repeat(64));
        current.runtime.running = old === 'running';
        current.runtime.status = old === 'running' ? 'running' : 'exited';
    }
    const initial = current;
    const runner = {
        run(_command, args) {
            calls.push(`run:${args.slice(0, 2).join(' ')}`);
            if (args[1] === 'stop') current.runtime.running = false;
            if (args[1] === 'rm') current = null;
            if (args[1] === 'start') current.runtime.running = true;
            if (args[1] === 'create') {
                const cidfile = args[args.indexOf('--cidfile') + 1];
                fs.writeFileSync(cidfile, `${'a'.repeat(64)}\n`, { mode: 0o600 });
                current = handleFromCreateArgs(args, 'a'.repeat(64));
                current.runtime.running = false;
            }
        },
        query: () => ({ ok: true, status: 0, stdout: '' }),
        stream: async () => ({ ok: true, status: 0, stdout: '', stderr: '' }),
    };
    const seams = {
        preflight: async (options) => ({ ...options, recheckAfterRelease: { tcp: false, udp: false } }),
        recheckReleased: async () => {},
        validateImage: () => ({ immutableId: OUTER_IMAGE_ID_FIXTURE }),
        validateExistingImage: (_engine, imageId) => ({ immutableId: imageId }),
        probeAgentLib: () => ({ supplyingImageId: agentLib.supplyingImageId }),
        stopPloinkyLocal: () => { calls.push('stop-local'); },
        startAndWaitReady: async (engine, id, selectedRunner) => selectedRunner.run(engine.name, ['container', 'start', id]),
        discover: () => (current ? { state: 'owned', handles: { container: current } } : { state: 'absent', handles: null }),
        retireStartLock() {},
        retireEdgePreparation() {},
        materializeGpu() {},
        token: (kind) => (kind === 'candidate' ? '1'.repeat(24) : '2'.repeat(24)),
    };
    const options = (extra = {}) => ({
        identity, ownership: initial ? { state: 'owned', handles: { container: initial } } : { state: 'absent', handles: null },
        engine: ENGINE, runner, lock, repositoryRoot: checkout, agentLib, imageRef: BOX_IMAGE_REFERENCE, imagePolicy: 'preserve',
        explicitPort: 18080, stdout: silent, stderr: silent, ...extra,
    });
    return { base, outside, workspace, identity, lock, calls, seams, options, current: () => current };
}

// A running host bwrap agent of the workspace: its launch record, and a fake
// /proc/41/stat with the start identity the record holds.
function hostAgentGate(workspace) {
    const directory = path.join(workspace, '.ploinky', 'bwrap-pids');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'agent.pid'), JSON.stringify({
        schemaVersion: 3, hostStateMasked: true, pid: 41, runtimeKey: 'agent', processIdentity: 'linux-proc:4100',
    }));
    const fsApi = {
        ...fs,
        readFileSync(target, ...rest) {
            if (target === '/proc/41/stat') return `41 (bwrap) S ${Array(18).fill('0').join(' ')} 4100 0 0`;
            return fs.readFileSync(target, ...rest);
        },
    };
    return createQuiescenceGate({ platform: 'linux', fsApi, kill: () => {} });
}

test('I5: a running host agent refuses `restart` while the old Box still runs; it is never stopped', async (t) => {
    const w = await world(t, { old: 'running' });
    const gate = hostAgentGate(w.workspace);
    w.seams.quiescence = ({ identity, excludeContainerIds }) => {
        w.calls.push(excludeContainerIds.length ? `quiescence-pre:${excludeContainerIds.join()}` : 'quiescence');
        return gate.assert(identity, { view: [], excludeContainerIds });
    };
    await assert.rejects(reconcileBoxContainer(w.options({ recoverDataPaths: true }), w.seams), (error) => {
        assert.equal(error.cause?.code, 'PLOINKY_BOX_HOST_RUNTIME_ACTIVE');
        assert.match(error.message, /process 41: its launch record .*agent\.pid names a running agent/);
        assert.equal(error.boxRollback.action, 'preserved');
        assert.equal(error.boxRollback.oldStopAttempted, false, 'no recovery is needed: the Box was never stopped');
        return true;
    });
    assert.deepEqual(w.calls, [`quiescence-pre:${'e'.repeat(64)}`]);
    assert.equal(w.current().runtime.running, true, 'the old Box still runs');
    assert.equal(fs.existsSync(w.identity.boxDataRoot), false);
});

test('N8d(1): a host agent that appears after the old Box stops is refused by the full scan; nothing is created under .ploinky/box', async (t) => {
    const w = await world(t, { old: 'running' });
    const gate = hostAgentGate(w.workspace);
    w.seams.quiescence = ({ identity, excludeContainerIds }) => {
        if (excludeContainerIds.length) {
            w.calls.push('quiescence-pre');
            return [];
        }
        w.calls.push('quiescence');
        return gate.assert(identity, { view: [] });
    };
    await assert.rejects(reconcileBoxContainer(w.options({ recoverDataPaths: true }), w.seams), (error) => {
        assert.equal(error.cause?.code, 'PLOINKY_BOX_HOST_RUNTIME_ACTIVE');
        assert.equal(error.boxRollback.action, 'preserved', 'the stopped old Box is kept, not removed');
        assert.equal(error.boxRollback.oldStopAttempted, true);
        return true;
    });
    assert.deepEqual(w.calls, ['quiescence-pre', 'stop-local', 'run:container stop', 'quiescence']);
    assert.equal(fs.existsSync(w.identity.boxDataRoot), false, 'no data path was created');
    assert.notEqual(w.current(), null, 'the old Box was not removed');
});

test('N8d(2): with the Box running and a data directory gone, `start` refuses and creates nothing; `restart` recreates it', async (t) => {
    const w = await world(t, { old: 'running', dataPaths: true });
    fs.rmSync(w.identity.dataPaths.images, { recursive: true });
    w.seams.quiescence = ({ excludeContainerIds }) => { w.calls.push(excludeContainerIds.length ? 'quiescence-pre' : 'quiescence'); return []; };
    await assert.rejects(reconcileBoxContainer(w.options(), w.seams), { code: 'PLOINKY_BOX_DATA_PATH_MISSING', message: /Run `ploinky restart`/ });
    assert.deepEqual(w.calls, []);
    assert.equal(fs.existsSync(w.identity.dataPaths.images), false);
    const replaced = await reconcileBoxContainer(w.options({ recoverDataPaths: true }), w.seams);
    assert.equal(replaced.action, 'replaced');
    assert.deepEqual(w.calls.slice(0, 5), ['quiescence-pre', 'stop-local', 'run:container stop', 'quiescence', 'run:container rm']);
    assert.equal(fs.statSync(w.identity.dataPaths.images).isDirectory(), true, 'recreated only after the gate');
});

test('N8d(3): the filesystem that creates data paths is never consulted for a mkdir outside the quiescent path', async (t) => {
    for (const scenario of ['refused', 'passed']) {
        const w = await world(t, { old: null });
        let quiescent = false;
        const early = [];
        const watched = (target) => String(target).startsWith(w.identity.anchorPath) || String(target).startsWith(w.outside);
        w.seams.fsApi = {
            ...fs,
            mkdirSync(target, ...rest) {
                if (watched(target) && !quiescent) early.push(String(target));
                return fs.mkdirSync(target, ...rest);
            },
        };
        const before = treeDigest(w.outside);
        w.seams.quiescence = () => {
            if (scenario === 'refused') throw Object.assign(new Error('a host agent runs'), { code: 'PLOINKY_BOX_HOST_RUNTIME_ACTIVE' });
            quiescent = true;
            return [];
        };
        const run = reconcileBoxContainer(w.options(), w.seams);
        if (scenario === 'refused') {
            await assert.rejects(run, (error) => error.cause?.code === 'PLOINKY_BOX_HOST_RUNTIME_ACTIVE');
            assert.equal(fs.existsSync(w.identity.boxDataRoot), false);
        } else {
            assert.equal((await run).action, 'created');
            assert.equal(fs.statSync(w.identity.dataPaths.dependencies).isDirectory(), true);
        }
        assert.deepEqual(early, [], `${scenario}: no data path mkdir before the gate passed`);
        assert.equal(treeDigest(w.outside), before);
    }
});

test('N8d(4): a host launch started after the scan waits on the workspace lock until the transaction ends', async (t) => {
    const w = await world(t, { old: null });
    const events = path.join(w.base, 'launch-events.jsonl');
    const url = pathToFileURL(path.join(projectRoot, 'cli/sandbox/hostLaunchExclusion.js')).href;
    let child;
    let exited;
    let launchedAt = 0;
    w.seams.quiescence = async () => {
        w.calls.push('quiescence');
        // Right after the scan, a host-runtime launch of the same workspace
        // starts in another process and asks for the workspace lock.
        const script = `
            import fs from 'node:fs';
            const { withHostLaunchExclusion } = await import(${JSON.stringify(url)});
            fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({ event: 'asking', t: Date.now() }) + '\\n');
            withHostLaunchExclusion(() => {
                fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({ event: 'launched', t: Date.now() }) + '\\n');
            }, { workspaceRoot: ${JSON.stringify(w.workspace)}, insideBox: () => false });
        `;
        launchedAt = Date.now();
        child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        exited = new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
        // Give it time to reach the lock; it must still be waiting.
        for (let waited = 0; waited < 5000 && !fs.existsSync(events); waited += 50) await delay(50);
        await delay(400);
        return [];
    };
    const result = await reconcileBoxContainer(w.options(), w.seams);
    assert.equal(result.action, 'created');
    const read = () => (fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
    assert.equal(read().some((entry) => entry.event === 'launched'), false, 'the launch has not started while the transaction runs');
    for (const target of Object.values(w.identity.dataPaths)) {
        assert.ok(fs.realpathSync(target).startsWith(`${fs.realpathSync(w.workspace)}/`), 'data path created inside W');
    }
    await delay(200);
    const releasedAt = Date.now();
    w.lock.release();
    const { code, stderr } = await exited;
    assert.equal(code, 0, stderr);
    const launched = read().find((entry) => entry.event === 'launched');
    assert.ok(launched && launched.t >= releasedAt, `launched ${launched?.t} after release ${releasedAt} (asked at ${launchedAt})`);
});

test('starting a stopped Box re-binds its recorded sources, so it runs behind the gate and the recorded-source check', async (t) => {
    const w = await world(t, { old: 'stopped', dataPaths: true });
    w.seams.quiescence = () => { w.calls.push('quiescence'); throw Object.assign(new Error('a host agent runs'), { code: 'PLOINKY_BOX_HOST_RUNTIME_ACTIVE' }); };
    await assert.rejects(reconcileBoxContainer(w.options(), w.seams), (error) => error.cause?.code === 'PLOINKY_BOX_HOST_RUNTIME_ACTIVE');
    assert.deepEqual(w.calls, ['quiescence'], 'the stopped Box was not started');
    // With the gate passing, a recorded source that now resolves elsewhere refuses the start.
    w.calls.length = 0;
    w.seams.quiescence = () => { w.calls.push('quiescence'); return []; };
    const moved = `${w.identity.dataPaths.images}-moved`;
    fs.renameSync(w.identity.dataPaths.images, moved);
    fs.symlinkSync(w.outside, w.identity.dataPaths.images);
    await assert.rejects(reconcileBoxContainer(w.options(), w.seams), (error) => error.cause?.code === 'PLOINKY_BOX_DATA_PATH_ESCAPES'
        || error.code === 'PLOINKY_BOX_DATA_PATH_ESCAPES');
    assert.equal(w.calls.includes('run:container start'), false);
    fs.unlinkSync(w.identity.dataPaths.images);
    fs.renameSync(moved, w.identity.dataPaths.images);
    const reused = await reconcileBoxContainer(w.options(), w.seams);
    assert.equal(reused.action, 'reused');
    assert.deepEqual(w.calls.slice(-2), ['quiescence', 'run:container start']);
});

test('starting a stopped Box refuses a recorded source re-pointed while the data path keeps its identity', async (t) => {
    // The Box was created from `.ploinky/box/images -> ../../cache/img`, so it
    // recorded `W/cache/img`. Then `cache/img` moves to `cache/img2`, a link
    // to an outside directory takes its name, and the data path link is
    // re-pointed to `img2`: the data path still names the labelled directory,
    // but starting the Box would bind the outside one.
    const w = await world(t, {
        old: 'stopped',
        dataPaths: true,
        prepare(identity, workspace) {
            fs.mkdirSync(path.join(workspace, 'cache', 'img'), { recursive: true });
            fs.rmSync(identity.dataPaths.images, { recursive: true });
            fs.symlinkSync('../../cache/img', identity.dataPaths.images);
        },
    });
    const recorded = w.current().runtime.mounts.find((mount) => mount.destination === '/home/podman/.local/share/ploinky-images');
    assert.equal(recorded.source, path.join(w.workspace, 'cache', 'img'));
    fs.renameSync(path.join(w.workspace, 'cache', 'img'), path.join(w.workspace, 'cache', 'img2'));
    fs.symlinkSync(w.outside, path.join(w.workspace, 'cache', 'img'));
    fs.unlinkSync(w.identity.dataPaths.images);
    fs.symlinkSync('../../cache/img2', w.identity.dataPaths.images);
    w.seams.quiescence = () => { w.calls.push('quiescence'); return []; };
    const before = treeDigest(w.outside);
    await assert.rejects(reconcileBoxContainer(w.options(), w.seams), (error) => (error.cause?.code ?? error.code) === 'PLOINKY_BOX_DATA_PATH_ESCAPES');
    assert.equal(w.calls.includes('run:container start'), false, 'the stopped Box was not started');
    assert.equal(treeDigest(w.outside), before);
});

test('the supervisor runs every reconciliation behind its host-state guard\'s quiescence gate', async (t) => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-gate-supervisor-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const workspace = path.join(base, 'W');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const asked = [];
    const supervisor = createBoxSupervisor({
        hostStateGuard: {
            beforeLock() {},
            underLock() { return {}; },
            quiescence(context) { asked.push(context.identity.instance); throw Object.assign(new Error('active'), { code: 'PLOINKY_BOX_HOST_RUNTIME_ACTIVE' }); },
        },
        resolveIdentity: () => identity,
        launchCwd: workspace,
        discover: () => ({ state: 'absent', engine: ENGINE, handles: null }),
        selectAgentLib: async () => ({ selection: imageAgentLibFixture() }),
        reconcile: async (options) => options.quiescence({ identity: options.identity, engine: options.engine, runner: options.runner }),
        runner: { run() {} },
        stdout: silent,
        stderr: silent,
    });
    await assert.rejects(supervisor.prepareBoxForCommand(), { code: 'PLOINKY_BOX_HOST_RUNTIME_ACTIVE' });
    assert.deepEqual(asked, [identity.instance]);
});

test('only restart may recreate a Box whose data directory went missing while it ran', async (t) => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-gate-recover-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const workspace = path.join(base, 'W');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const seen = {};
    const supervisorFor = (name) => createBoxSupervisor({
        hostStateGuard: { beforeLock() {}, underLock() { return {}; }, quiescence() { return []; } },
        resolveIdentity: () => identity,
        launchCwd: workspace,
        discover: () => ({ state: 'absent', engine: ENGINE, handles: null }),
        selectAgentLib: async () => ({ selection: imageAgentLibFixture() }),
        captureCoreStartArgv: () => null,
        reconcile: async (options) => {
            seen[name] = options.recoverDataPaths === true;
            throw Object.assign(new Error('stop after reconcile input'), { code: 'FIXTURE_STOP' });
        },
        runner: { run() {}, query: () => ({ ok: false }) },
        stdout: silent,
        stderr: silent,
    });
    await assert.rejects(supervisorFor('start').runStartTransaction(['start', 'explorer']));
    await assert.rejects(supervisorFor('restart').runRestartTransaction(['restart']));
    await assert.rejects(supervisorFor('prepare').prepareBoxForCommand());
    assert.deepEqual(seen, { start: false, restart: true, prepare: false });
});

test('--allow-host-process takes one process ID per use before the command and is never forwarded', () => {
    const parsed = parseOuterArguments(['--allow-host-process', '41', '--allow-host-process', '977', 'start', 'explorer']);
    assert.deepEqual(parsed.allowHostProcesses, [41, 977]);
    assert.equal(parsed.command, 'start');
    assert.equal(parsed.forwardingArgv.includes('--allow-host-process'), false);
    assert.equal(parsed.forwardingArgv.includes('41'), false);
    assert.deepEqual(parseOuterArguments(['start']).allowHostProcesses, []);
    for (const argv of [['--allow-host-process'], ['--allow-host-process', 'x', 'start'], ['--allow-host-process', '0', 'start'],
        ['--allow-host-process', '-1', 'start'], ['--allow-host-process=41', 'start']]) {
        assert.throws(() => parseOuterArguments(argv), { code: 'PLOINKY_BOX_ARGUMENT_INVALID' }, argv.join(' '));
    }
});

test('I4: limits clear keeps its any-ownership authorization and runs as a restricting transaction', async (t) => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-limits-clear-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const workspace = path.join(base, 'W');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    for (const state of ['unknown', 'foreign']) {
        const policies = [];
        const supervisor = createBoxSupervisor({
            hostStateGuard: {
                beforeLock(_identity, { policy } = {}) { policies.push(`before:${policy}`); },
                underLock(_identity, _lock, _ownership, { policy }) { policies.push(`under:${policy}`); return {}; },
                quiescence() { assert.fail('limits clear needs no gate'); },
            },
            resolveIdentity: () => identity,
            launchCwd: workspace,
            discover: () => ({ state, message: `engine ${state}` }),
            runner: { run() { throw new Error('runner'); }, query: () => ({ ok: false }) },
            stdout: silent,
            stderr: silent,
        });
        const result = await supervisor.runLimitsClearTransaction({ all: true });
        assert.equal(result.all, true, state);
        assert.deepEqual(policies, ['under:restrict'], state);
    }
});


function writeRecoveryProd(workspace, value, payload = { version: 1, secrets: { PROD: value } }) {
    fs.mkdirSync(path.join(workspace, '.ploinky', 'data'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(workspace, '.data', 'dpu-data'), { recursive: true, mode: 0o700 });
    initializeWorkspaceMasterKey({ workspaceRoot: workspace });
    const seed = readWorkspaceMasterKey({ workspaceRoot: workspace }).key;
    const key = deriveSubkeyFromSeed(seed, 'storage/secrets');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
    key.fill(0);
    fs.writeFileSync(path.join(workspace, '.ploinky', 'data', '.secrets'), packed, { mode: 0o600 });
}

for (const recovery of ['data', 'local']) {
    test(`whole restart passively checks stored PROD before ${recovery} recovery`, async t => {
        const w = await world(t, { old: 'running', dataPaths: true, localAgentLib: recovery === 'local' });
        writeRecoveryProd(w.workspace, 'false');
        const current = w.current();
        if (recovery === 'data') {
            fs.renameSync(w.identity.dataPaths.images, `${w.identity.dataPaths.images}-old`);
        } else {
            const mount = current.runtime.mounts.find(m => m.destination === '/opt/ploinky-agentlib');
            fs.writeFileSync(path.join(mount.source, 'changed-file'), 'changed');
        }
        const calls = [];
        const ownership = { state: 'owned', engine: ENGINE, handles: { container: current } };
        const supervisor = createBoxSupervisor({
            hostStateGuard: { beforeLock() {}, underLock() { return {}; }, quiescence() { return []; } },
            resolveIdentity: () => w.identity, launchCwd: w.workspace, repositoryRoot: path.join(w.base, 'checkout'),
            lockManager: { acquire: async () => ({ ...w.lock, release() {} }) }, discover: () => ownership,
            runner: { run() { calls.push('mutate'); }, query: () => ({ ok: true, stdout: JSON.stringify({ initialized: true }) }) },
            validateExistingImage: () => ({ immutableId: OUTER_IMAGE_ID_FIXTURE }),
            selectAgentLib: async () => { calls.push('selected'); throw new Error('recovery reached'); },
            stdout: silent, stderr: silent,
        });
        await assert.rejects(supervisor.runStartTransaction(['start', 'explorer']), { code: 'PLOINKY_BOX_PROFILE_PREFLIGHT_FAILED' });
        assert.deepEqual(calls, []);
        await assert.rejects(supervisor.runRestartTransaction(['restart']), /recovery reached/);
        assert.deepEqual(calls, ['selected']);
        writeRecoveryProd(w.workspace, 'true');
        calls.length = 0;
        await assert.rejects(supervisor.runRestartTransaction(['restart']), { code: 'PLOINKY_BOX_PROFILE_RECOVERY_REQUIRED' });
        assert.deepEqual(calls, []);
        if (recovery === 'data') {
            writeRecoveryProd(w.workspace, 'false');
            fs.symlinkSync(`${w.identity.dataPaths.images}-old`, w.identity.dataPaths.images);
            await assert.rejects(supervisor.runRestartTransaction(['restart']), { code: 'PLOINKY_BOX_PROFILE_PREFLIGHT_FAILED' });
            assert.deepEqual(calls, []);
        }
    });
}

test('passive recovery refuses corrupt, linked and invalid production stores', async t => {
    const { assertNonProductionRecovery } = await import('../../ploinky-box/profileRecoveryPreflight.mjs');
    const w = await world(t, { old: 'running' });
    writeRecoveryProd(w.workspace, 'false');
    const store = path.join(w.workspace, '.ploinky', 'data', '.secrets');
    assert.doesNotThrow(() => assertNonProductionRecovery(w.workspace));
    writeRecoveryProd(w.workspace, 'not-a-boolean');
    assert.throws(() => assertNonProductionRecovery(w.workspace), { code: 'PLOINKY_BOX_PROFILE_RECOVERY_REQUIRED' });
    fs.writeFileSync(store, 'corrupt');
    assert.throws(() => assertNonProductionRecovery(w.workspace), { code: 'PLOINKY_BOX_PROFILE_RECOVERY_REQUIRED' });
    fs.unlinkSync(store);
    fs.symlinkSync(path.join(w.workspace, '.data', '.layout.json'), store);
    assert.throws(() => assertNonProductionRecovery(w.workspace), { code: 'PLOINKY_BOX_PROFILE_RECOVERY_REQUIRED' });
});


test('passive recovery rejects authenticated malformed envelopes and incomplete migration', async t => {
    const { assertNonProductionRecovery } = await import('../../ploinky-box/profileRecoveryPreflight.mjs');
    const w = await world(t, { old: 'running' });
    for (const payload of [{ version: 2, secrets: {} }, { version: 1, secrets: [] }, { version: 1, secrets: { PROD: false } }]) {
        writeRecoveryProd(w.workspace, undefined, payload);
        assert.throws(() => assertNonProductionRecovery(w.workspace), { code: 'PLOINKY_BOX_PROFILE_RECOVERY_REQUIRED' });
    }
    const store = path.join(w.workspace, '.ploinky', 'data', '.secrets');
    fs.unlinkSync(store);
    fs.unlinkSync(path.join(w.workspace, '.data', 'dpu-data', 'master-key'));
    fs.writeFileSync(path.join(w.workspace, '.ploinky', 'data', 'master-key'), 'legacy');
    assert.throws(() => assertNonProductionRecovery(w.workspace), { code: 'PLOINKY_BOX_PROFILE_RECOVERY_REQUIRED' });
    fs.unlinkSync(path.join(w.workspace, '.ploinky', 'data', 'master-key'));
    assert.doesNotThrow(() => assertNonProductionRecovery(w.workspace));
    fs.writeFileSync(path.join(w.workspace, '.ploinky', '.secrets'), 'retired');
    assert.throws(() => assertNonProductionRecovery(w.workspace), { code: 'PLOINKY_BOX_PROFILE_RECOVERY_REQUIRED' });
});
