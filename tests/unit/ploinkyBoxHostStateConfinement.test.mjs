import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { discoverEngineView } from '../../ploinky-box/engine/discovery.mjs';
import { hardwareStorePaths } from '../../cli/sandbox/hardwareLimits/store.mjs';
import {
    assertCreateArgsConfined,
    assertRecordedDataSourcesConfined,
    resolveBoxDataSources,
} from '../../ploinky-box/hostState/confinement.mjs';
import { createHostStateGuard } from '../../ploinky-box/hostState/guard.mjs';
import { assertNotNestedWorkspace, boxWorkspaceBindSource } from '../../ploinky-box/hostState/nested.mjs';
import { buildWorkspaceIdentity, workspacePathHash } from '../../ploinky-box/identity.mjs';
import { hasHostStateComponent } from '../../ploinky-box/hostState/paths.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';

function scratch(t) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-confine-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    return base;
}

function workspaceAt(base, name) {
    const workspace = path.join(base, name);
    fs.mkdirSync(path.join(workspace, '.ploinky', 'box'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.ploinky-box', 'empty'), { recursive: true });
    return buildWorkspaceIdentity(workspace, { markerFound: true });
}

function treeDigest(target) {
    const hash = crypto.createHash('sha256');
    const visit = (current) => {
        let stat;
        try { stat = fs.lstatSync(current); } catch (_) { hash.update(`${current}:absent`); return; }
        hash.update(`${path.relative(target, current)}:${stat.mode}:`);
        if (stat.isDirectory()) for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
        else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(current));
        else hash.update(fs.readFileSync(current));
    };
    visit(target);
    return hash.digest('hex');
}

function boxContainer(workspaceRoot, { running = true, name = 'ploinky-box-other', pathHash = workspacePathHash(workspaceRoot) } = {}) {
    return {
        id: crypto.createHash('sha256').update(workspaceRoot).digest('hex'),
        name,
        running,
        labels: { [BOX_LABELS.role]: 'box', [BOX_LABELS.pathHash]: pathHash },
        mounts: [
            { type: 'bind', source: workspaceRoot, destination: workspaceRoot, rw: true },
            { type: 'bind', source: `${workspaceRoot}/.ploinky-box/empty`, destination: `${workspaceRoot}/.ploinky-box`, rw: false },
        ],
    };
}

test('a confined data path resolves inside the workspace and the engine receives its resolved location', (t) => {
    const base = scratch(t);
    const identity = workspaceAt(base, 'ws');
    assert.deepEqual(resolveBoxDataSources(identity).sources, identity.dataPaths, 'plain directories keep their spelling');
    fs.mkdirSync(path.join(identity.workspaceRoot, 'cache', 'images'), { recursive: true });
    fs.symlinkSync('../../cache/images', identity.dataPaths.images);
    const { sources } = resolveBoxDataSources(identity);
    assert.equal(sources.images, path.join(identity.workspaceRoot, 'cache', 'images'), 'the link is resolved, never handed to the engine');
});

test('N8: a data path aliasing this workspace\'s .ploinky-box is refused', (t) => {
    const base = scratch(t);
    const identity = workspaceAt(base, 'ws');
    fs.symlinkSync('../../.ploinky-box', identity.dataPaths.dependencies);
    assert.throws(() => resolveBoxDataSources(identity), { code: 'PLOINKY_BOX_HOST_STATE_OVERLAP' });
    fs.unlinkSync(identity.dataPaths.dependencies);
    // A case- or NFKC-folded spelling of the same name is refused too.
    fs.mkdirSync(path.join(identity.workspaceRoot, 'x', '.PLOINKY-BOX'), { recursive: true });
    fs.symlinkSync('../../x/.PLOINKY-BOX', identity.dataPaths.dependencies);
    assert.throws(() => resolveBoxDataSources(identity), { code: 'PLOINKY_BOX_HOST_STATE_OVERLAP' });
});

test('N8b: a data path into another workspace\'s .ploinky-box is refused and that tree is unchanged', (t) => {
    const base = scratch(t);
    const wsA = workspaceAt(base, 'wsA');
    const record = path.join(wsA.hostStateRoot, 'router-bindings', `${wsA.instance}.json`);
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, '{"address":"127.0.0.1"}\n');
    const wsB = workspaceAt(base, 'wsB');
    // Inside wsB, so only the folded-name rule can catch it.
    fs.mkdirSync(path.join(wsB.workspaceRoot, 'nested'), { recursive: true });
    fs.symlinkSync(wsA.hostStateRoot, path.join(wsB.workspaceRoot, 'nested', '.ploinky-box'));
    fs.symlinkSync('../../nested/.ploinky-box', wsB.dataPaths.images);
    const before = treeDigest(wsA.hostStateRoot);
    assert.throws(() => resolveBoxDataSources(wsB), (error) => ['PLOINKY_BOX_HOST_STATE_OVERLAP', 'PLOINKY_BOX_DATA_PATH_ESCAPES'].includes(error.code));
    fs.unlinkSync(wsB.dataPaths.images);
    fs.symlinkSync(wsA.hostStateRoot, wsB.dataPaths.images);
    assert.throws(() => resolveBoxDataSources(wsB), (error) => ['PLOINKY_BOX_HOST_STATE_OVERLAP', 'PLOINKY_BOX_DATA_PATH_ESCAPES'].includes(error.code));
    assert.equal(treeDigest(wsA.hostStateRoot), before);
});

test('N8c: escaping, sibling, parent, own-root and checkout targets are refused before any mkdir', (t) => {
    const base = scratch(t);
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    const wsA = workspaceAt(base, 'wsA');
    const wsB = workspaceAt(base, 'wsB');
    const checkout = path.join(wsB.workspaceRoot, '.runtime', 'ploinky');
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    const cases = [
        ['.ploinky/box -> /outside', () => {
            fs.rmSync(wsB.boxDataRoot, { recursive: true });
            fs.symlinkSync(outside, wsB.boxDataRoot);
        }, 'PLOINKY_BOX_DATA_PATH_ESCAPES'],
        ['images -> sibling root', () => fs.symlinkSync(wsA.workspaceRoot, wsB.dataPaths.images), 'PLOINKY_BOX_DATA_PATH_ESCAPES'],
        ['images -> parent of sibling', () => fs.symlinkSync(base, wsB.dataPaths.images), 'PLOINKY_BOX_DATA_PATH_ESCAPES'],
        ['images -> own root', () => fs.symlinkSync(wsB.workspaceRoot, wsB.dataPaths.images), 'PLOINKY_BOX_DATA_PATH_ESCAPES'],
        ['images -> checkout', () => fs.symlinkSync(checkout, wsB.dataPaths.images), 'PLOINKY_BOX_HOST_STATE_OVERLAP'],
        ['images -> a sibling created after', () => fs.symlinkSync(path.join(base, 'wsLater'), wsB.dataPaths.images), 'PLOINKY_BOX_DATA_PATH_ESCAPES'],
    ];
    const trees = () => [outside, wsA.workspaceRoot, checkout].map(treeDigest);
    for (const [label, plant, code] of cases) {
        const before = trees();
        plant();
        assert.throws(() => resolveBoxDataSources(wsB, { repositoryRoot: checkout }), { code }, label);
        assert.deepEqual(trees(), before, `${label}: nothing outside changed`);
        // Restore the plain layout for the next case.
        fs.rmSync(wsB.boxDataRoot, { recursive: true, force: true });
        fs.mkdirSync(wsB.boxDataRoot, { recursive: true });
    }
    // The sibling created after wsB's link was planted: still refused once it exists.
    fs.symlinkSync(path.join(base, 'wsLater'), wsB.dataPaths.images);
    workspaceAt(base, 'wsLater');
    assert.throws(() => resolveBoxDataSources(wsB), { code: 'PLOINKY_BOX_DATA_PATH_ESCAPES' });
});

test('a data path that contains another Box\'s workspace is refused', (t) => {
    const base = scratch(t);
    const ws = workspaceAt(base, 'ws');
    const inner = path.join(ws.workspaceRoot, 'cache', 'inner');
    fs.mkdirSync(inner, { recursive: true });
    fs.symlinkSync('../../cache', ws.dataPaths.images);
    assert.throws(() => resolveBoxDataSources(ws, { view: [boxContainer(inner)] }), /contains the workspace .*inner of Box/);
});

test('the check before create admits only the workspace bind, the resolved data sources and the exact hardware store', (t) => {
    const base = scratch(t);
    const ws = workspaceAt(base, 'ws');
    const { sources } = resolveBoxDataSources(ws);
    const store = hardwareStorePaths({ identity: ws }).storeRoot;
    const argv = (extra = []) => [
        '--volume', `/repo:/opt/ploinky:ro`,
        '--volume', `${ws.workspaceRoot}:${ws.workspaceRoot}`,
        '--volume', `${ws.workspaceRoot}/.ploinky-box/empty:${ws.workspaceRoot}/.ploinky-box:ro`,
        '--volume', `${sources.dependencies}:/opt/ploinky/node_modules`,
        '--volume', `${sources.images}:/home/podman/.local/share/ploinky-images`,
        ...extra,
    ];
    assert.doesNotThrow(() => assertCreateArgsConfined(ws, argv(['--volume', `${store}:/run/ploinky/hardware-limits`]), { dataSources: sources }));
    assert.throws(() => assertCreateArgsConfined(ws, argv(['--volume', `${ws.hostStateRoot}/gpu-grants:/x`]), { dataSources: sources }),
        { code: 'PLOINKY_BOX_DATA_PATH_ESCAPES' });
    assert.throws(() => assertCreateArgsConfined(ws, argv(['--volume', `${base}:/x:rw`]), { dataSources: sources }),
        { code: 'PLOINKY_BOX_DATA_PATH_ESCAPES' });
    // A swap after preparation is caught right before create, also when the
    // new target stays inside the workspace.
    fs.mkdirSync(path.join(ws.workspaceRoot, 'elsewhere'));
    fs.rmSync(ws.dataPaths.images, { recursive: true, force: true });
    fs.symlinkSync('../../elsewhere', ws.dataPaths.images);
    assert.throws(() => assertCreateArgsConfined(ws, argv(), { dataSources: sources }), { code: 'PLOINKY_BOX_WORKSPACE_DATA_CHANGED' });
    fs.unlinkSync(ws.dataPaths.images);
    fs.mkdirSync(path.join(base, 'outside'));
    fs.rmSync(ws.dataPaths.images, { recursive: true, force: true });
    fs.symlinkSync(path.join(base, 'outside'), ws.dataPaths.images);
    assert.throws(() => assertCreateArgsConfined(ws, argv(), { dataSources: sources }),
        (error) => ['PLOINKY_BOX_DATA_PATH_ESCAPES', 'PLOINKY_BOX_WORKSPACE_DATA_CHANGED'].includes(error.code));
});

test('starting a stopped Box refuses a recorded data source that now resolves elsewhere', (t) => {
    const base = scratch(t);
    const ws = workspaceAt(base, 'ws');
    fs.mkdirSync(path.join(ws.workspaceRoot, 'cache', 'img'), { recursive: true });
    const recorded = path.join(ws.workspaceRoot, 'cache', 'img');
    const container = { runtime: { mounts: [{ source: recorded, destination: '/home/podman/.local/share/ploinky-images', rw: true }] } };
    const options = { dataDestinations: ['/home/podman/.local/share/ploinky-images'] };
    assert.doesNotThrow(() => assertRecordedDataSourcesConfined(ws, container, options));
    fs.renameSync(recorded, `${recorded}2`);
    fs.mkdirSync(path.join(base, 'outside'));
    fs.symlinkSync(path.join(base, 'outside'), recorded);
    assert.throws(() => assertRecordedDataSourcesConfined(ws, container, options), { code: 'PLOINKY_BOX_DATA_PATH_ESCAPES' });
    fs.unlinkSync(recorded);
    fs.symlinkSync('img2', recorded);
    assert.throws(() => assertRecordedDataSourcesConfined(ws, container, options), { code: 'PLOINKY_BOX_WORKSPACE_DATA_CHANGED' });
});

test('N7: an outer Box refuses an inner workspace and an inner Box refuses an outer one; a bare skeleton never does', (t) => {
    const base = scratch(t);
    const outer = workspaceAt(base, 'W');
    const inner = workspaceAt(outer.workspaceRoot, 'sub');
    assert.throws(() => assertNotNestedWorkspace(inner, [boxContainer(outer.workspaceRoot)]),
        (error) => error.code === 'PLOINKY_BOX_NESTED_WORKSPACE' && error.message.includes(`${outer.workspaceRoot} (container ploinky-box-other) contains this workspace`));
    assert.throws(() => assertNotNestedWorkspace(outer, [boxContainer(inner.workspaceRoot)]),
        (error) => error.code === 'PLOINKY_BOX_NESTED_WORKSPACE' && error.message.includes('lies inside this workspace'));
    // A stopped Box counts: it binds the same tree when started.
    assert.throws(() => assertNotNestedWorkspace(inner, [boxContainer(outer.workspaceRoot, { running: false })]), { code: 'PLOINKY_BOX_NESTED_WORKSPACE' });
    // Variant: only a bare `.ploinky-box` skeleton in W and no Box.
    assert.doesNotThrow(() => assertNotNestedWorkspace(inner, []));
    // Its own Box and unrelated Boxes do not count.
    assert.doesNotThrow(() => assertNotNestedWorkspace(inner, [boxContainer(inner.workspaceRoot), boxContainer(path.join(base, 'other'))]));
    // A non-Box container that binds W is the quiescence gate's business, not this one.
    const plain = { ...boxContainer(outer.workspaceRoot), labels: {} };
    assert.equal(boxWorkspaceBindSource(plain), null);
    assert.doesNotThrow(() => assertNotNestedWorkspace(inner, [plain]));
});

test('the diagnose fixture Box of this workspace is exempt from its nested check; a look-alike is not', (t) => {
    const base = scratch(t);
    const ws = workspaceAt(base, 'W');
    const fixtureRoot = path.join(ws.workspaceRoot, '.ploinky-diagnose-a1b2c3', 'workspace');
    fs.mkdirSync(fixtureRoot, { recursive: true });
    assert.doesNotThrow(() => assertNotNestedWorkspace(ws, [boxContainer(fixtureRoot)]));
    assert.throws(() => assertNotNestedWorkspace(ws, [boxContainer(fixtureRoot, { pathHash: '0'.repeat(12) })]),
        { code: 'PLOINKY_BOX_NESTED_WORKSPACE' });
    const other = path.join(ws.workspaceRoot, 'diagnose', 'workspace');
    fs.mkdirSync(other, { recursive: true });
    assert.throws(() => assertNotNestedWorkspace(ws, [boxContainer(other)]), { code: 'PLOINKY_BOX_NESTED_WORKSPACE' });
});

test('N7 through the supervisor: the nested refusal lands before the lock writes anything into the workspace', async (t) => {
    const base = scratch(t);
    const checkout = path.join(base, 'checkout');
    fs.mkdirSync(checkout);
    const outer = path.join(base, 'W');
    const inner = path.join(outer, 'sub');
    fs.mkdirSync(path.join(inner, '.ploinky'), { recursive: true });
    const identity = buildWorkspaceIdentity(inner, { markerFound: true });
    const supervisor = createBoxSupervisor({
        hostStateGuard: createHostStateGuard({ repositoryRoot: checkout, observeEngine: () => [boxContainer(outer)], gate: { assert() {} } }),
        resolveIdentity: () => identity,
        launchCwd: inner,
        repositoryRoot: checkout,
        discover: () => ({ state: 'absent', engine: { name: 'podman', identity: 'engine' }, handles: null }),
        runner: { run() { assert.fail('no engine mutation'); } },
        stdout: { write() {} },
        stderr: { write() {} },
    });
    await assert.rejects(supervisor.prepareBoxForCommand(), { code: 'PLOINKY_BOX_NESTED_WORKSPACE' });
    assert.equal(fs.existsSync(identity.hostStateRoot), false, 'no .ploinky-box was created in the inner workspace');
});

test('the engine view lists every container with its mounts and fails closed on an inexact answer', () => {
    const ids = ['a'.repeat(64), 'b'.repeat(64)];
    const record = (id, running) => ({
        Id: id, Name: `/${id.slice(0, 4)}`, State: { Running: running, Status: running ? 'running' : 'exited' },
        Config: { Labels: { [BOX_LABELS.role]: 'box' } },
        Mounts: [{ Type: 'bind', Source: '/w', Destination: '/w', RW: true }],
    });
    let inspectCalls = 0;
    const runner = (failInspectOnce = false) => ({
        query(_engine, args) {
            if (args[0] === 'ps') return { ok: true, stdout: `${ids.join('\n')}\n` };
            inspectCalls += 1;
            if (failInspectOnce && inspectCalls === 1) return { ok: false, stdout: '', stderr: 'no such container' };
            return { ok: true, stdout: JSON.stringify([record(ids[0], true), record(ids[1], false)]) };
        },
    });
    const view = discoverEngineView({ name: 'podman' }, runner());
    assert.deepEqual(view.map((entry) => [entry.name, entry.running, entry.mounts[0].rw]), [['aaaa', true, true], ['bbbb', false, true]]);
    inspectCalls = 0;
    assert.equal(discoverEngineView({ name: 'podman' }, runner(true)).length, 2, 'a container removed mid-listing is listed again');
    assert.throws(() => discoverEngineView({ name: 'podman' }, { query: () => ({ ok: false }) }), { code: 'PLOINKY_BOX_DISCOVERY_FAILED' });
    assert.throws(() => discoverEngineView({ name: 'podman' }, {
        query: (_engine, args) => (args[0] === 'ps' ? { ok: true, stdout: `${ids[0]}\n` } : { ok: true, stdout: JSON.stringify([{ Id: ids[0], State: {} }]) }),
    }), { code: 'PLOINKY_BOX_DISCOVERY_FAILED' });
    assert.deepEqual(discoverEngineView({ name: 'podman' }, { query: () => ({ ok: true, stdout: '' }) }), []);
});

test('a host-state component is exactly a name that folds to .ploinky-box, never a prefix or suffix', () => {
    for (const name of ['.ploinky-box', '.PLOINKY-BOX', '.Ploinky-Box', '.ploinKy-box', '.ploinky-box.', '.ploinky-box ']) {
        assert.equal(hasHostStateComponent(`/w/${name}/x`), true, JSON.stringify(name));
    }
    for (const name of ['.ploinky-box-mcp-sdk.json', '.ploinky-box-dependencies.json', '.ploinky-box.anything', 'x.ploinky-box', '.ploinky-boxes', '.ploinky']) {
        assert.equal(hasHostStateComponent(`/w/${name}/x`), false, name);
    }
});
