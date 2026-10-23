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
import { OUTER_IMAGE_ID_FIXTURE, imageAgentLibFixture } from '../helpers/agentlibFixture.mjs';
import { handleFromCreateArgs } from '../helpers/hostStateFixture.mjs';

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
async function world(t, { old = 'running', dataPaths = false, prepare = () => {} } = {}) {
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
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    if (dataPaths) for (const target of Object.values(identity.dataPaths)) fs.mkdirSync(target, { recursive: true });
    prepare(identity, workspace);
    const lock = await createMutationLockManager().acquire(identity.instance, { workspaceRoot: workspace });
    t.after(() => { try { lock.release(); } catch (_) {} });
    const agentLib = imageAgentLibFixture();
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

// A host bwrap agent of the workspace, seen through a fake Linux /proc.
function hostAgentGate(workspace) {
    const real = fs.realpathSync(workspace);
    const own = `21 1 0:40 / / rw - ext4 /dev/root rw\n22 21 0:50 ${real} ${real} rw - ext4 /dev/w rw`;
    const agent = `900 899 0:40 / / ro - ext4 /dev/root rw\n901 900 0:50 ${real} ${real} rw - ext4 /dev/w rw`;
    const fsApi = {
        ...fs,
        readdirSync: (target, ...rest) => (target === '/proc' ? ['41'] : fs.readdirSync(target, ...rest)),
        readFileSync(target, ...rest) {
            if (target === '/proc/self/mountinfo') return own;
            if (target === '/proc/41/status') return 'Uid:\t1000\t1000\t1000\t1000\n';
            if (target === '/proc/41/mountinfo') return agent;
            if (target === '/proc/41/cmdline') return 'bwrap\0--bind\0';
            return fs.readFileSync(target, ...rest);
        },
    };
    return createQuiescenceGate({ platform: 'linux', fsApi, uid: 1000, selfPid: 10 });
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
        assert.match(error.message, /process 41 \(bwrap --bind\)/);
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
