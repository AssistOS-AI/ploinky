// Apple-only offline facts. These tests never invoke a container engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { APPLE_DEVICE_INSPECT, APPLE_RENDER_FACTS, assertAppleDeviceArguments, assertAppleRenderFacts,
    observeAppleDevices, projectAppleDeviceInspect, readAppleRenderFacts } from '../hardware-limits/liveModelDevices.mjs';
import { assertModelContainer } from '../hardware-limits/liveModelCases.mjs';

const renderNode = '/dev/dri/renderD128';
const canary = 'SECRET-APPLE-CANARY';
const clone = value => structuredClone(value);
// Values captured on the selected rootless libkrun Apple fixture. Synthetic
// immutable IDs/PIDs below bind the offline observations to a single lifetime.
const node = { path: renderNode, character: true, symlink: false, rdev: 57984, mode: 8630,
    uid: 65534, gid: 65534, read: true, write: true };
const cdi = { cdiVersion: '0.6.0', kind: 'ploinky.local/gpu', devices: [{ name: 'all', containerEdits: { deviceNodes: [{ path: renderNode }] } }] };
const argumentsFor = role => role === 'box' ? ['/dev/fuse', '/dev/net/tun', renderNode] : ['ploinky.local/gpu=all'];
const container = role => ({ id: (role === 'box' ? '1' : '2').repeat(64), image: 'a'.repeat(64),
    pid: role === 'box' ? 11 : 22, created: '2026-10-13T05:38:58Z', running: true, devices: [] });
const inspect = role => ({ ...container(role), createCommand: ['podman', 'create', '--env', `TOKEN=${canary}`,
    ...argumentsFor(role).flatMap(device => ['--device', device]), 'image'], env: [canary] });
const facts = role => ({ renderNodes: [clone(node)], cdi: role === 'box'
    ? { device: 'ploinky.local/gpu=all', deviceNodes: [{ path: renderNode }] } : null });
const transport = stdout => ({ stdout: JSON.stringify(stdout), status: 0, signal: null, errorCode: null,
    timedOut: false, truncated: false, cancelled: false, settlementForced: false });

test('Apple captured empty inspected devices require exact recorded arguments', () => {
    const box = projectAppleDeviceInspect(inspect('box'));
    assertModelContainer({ ...box, mounts: [] }, { profile: { model: { profile: 'apple', apple: { renderNode } } }, role: 'box' });
    for (const role of ['box', 'agent']) {
        const value = projectAppleDeviceInspect(inspect(role));
        assertAppleDeviceArguments(value, { renderNode, role });
        const expected = role === 'box' ? argumentsFor(role) : [renderNode];
        const filled = { ...value, devices: expected.map(name => ({ PathOnHost: name, PathInContainer: name, CgroupPermissions: 'rwm' })) };
        assertAppleDeviceArguments(filled, { renderNode, role });
        for (const mutate of [v => { v.devices = null; }, v => { delete v.devices; }, v => { v.recordedDevices = []; },
            v => { v.recordedDevices.push(renderNode); }, v => { v.recordedDevices[0] = '/dev/dri/renderD129'; },
            v => { v.recordedDevices[0] += ':r'; }, v => { v.recordedDevices.reverse(); if (role === 'agent') v.recordedDevices = null; }]) {
            const bad = clone(value); mutate(bad); assert.throws(() => assertAppleDeviceArguments(bad, { renderNode, role }));
        }
        for (const mutate of [v => { v.devices.push(v.devices[0]); }, v => { v.devices[0].PathInContainer += '9'; },
            v => { v.devices[0].CgroupPermissions = 'rw'; }, v => { delete v.devices[0].CgroupPermissions; },
            v => { v.devices[0].PathOnHost = '/dev/null'; }]) {
            const bad = clone(filled); mutate(bad); assert.throws(() => assertAppleDeviceArguments(bad, { renderNode, role }));
        }
        const joined = inspect(role); joined.createCommand = argumentsFor(role).map(value => `--device=${value}`);
        assertAppleDeviceArguments(projectAppleDeviceInspect(joined), { renderNode, role });
    }
    assert.throws(() => projectAppleDeviceInspect({ createCommand: ['--device'] }));
    assert.throws(() => projectAppleDeviceInspect({ createCommand: null }));
    assert.ok(!JSON.stringify(box).includes(canary));
});

function fakeIo(patch = {}) {
    let nodeReads = 0;
    const stat = { dev: 1, ino: 2, ...node, isCharacterDevice: () => true, isSymbolicLink: () => false };
    const bytes = Buffer.from(JSON.stringify(patch.cdi ?? cdi));
    return {
        constants: { R_OK: 4, W_OK: 2, O_RDONLY: 0, O_NOFOLLOW: 256 },
        lstatSync: name => name === '/dev/dri' ? { isDirectory: () => true, isSymbolicLink: () => false }
            : { ...stat, ...(patch.stat || {}), ...(nodeReads++ > 0 ? patch.after : {}) },
        readdirSync: () => patch.names ?? ['renderD128'],
        accessSync: (name, mode) => { assert.equal(name, renderNode); assert.equal(mode, 6); if (patch.denied) throw Error(canary); },
        openSync: (name, flags) => { assert.equal(name, '/etc/cdi/ploinky-gpu.json'); assert.equal(flags, 256); return 42; },
        fstatSync: () => ({ isFile: () => true, size: bytes.length }), readFileSync: () => bytes, closeSync: () => {},
    };
}

test('Apple render probe observes singleton character access and exact hookless CDI mapping', () => {
    assert.deepEqual(readAppleRenderFacts(fakeIo(), renderNode, true), facts('box'));
    assert.deepEqual(readAppleRenderFacts(fakeIo(), renderNode, false), facts('agent'));
    for (const patch of [{ names: [] }, { names: ['renderD128', 'renderD129'] }, { names: ['renderD128evil'] },
        { stat: { isCharacterDevice: () => false } }, { stat: { isSymbolicLink: () => true } }, { denied: true },
        { after: { ino: 999 } }, { after: { rdev: 999 } }, { after: { mode: 0 } }]) {
        assert.throws(() => readAppleRenderFacts(fakeIo(patch), renderNode, true));
    }
    for (const mutate of [v => { v.kind = 'foreign/gpu'; }, v => { v.devices[0].name = 'other'; },
        v => { v.devices.push(v.devices[0]); }, v => { v.devices[0].containerEdits.deviceNodes.push({ path: '/dev/dri/renderD129' }); },
        v => { v.devices[0].containerEdits.deviceNodes[0].path = '/dev/null'; },
        v => { v.devices[0].containerEdits.deviceNodes[0].hostPath = '/dev/null'; },
        v => { v.devices[0].containerEdits.hooks = [{ path: canary }]; }, v => { v.containerEdits = { hooks: [] }; }]) {
        const bad = clone(cdi); mutate(bad); assert.throws(() => readAppleRenderFacts(fakeIo({ cdi: bad }), renderNode, true));
    }
});

test('Apple emitted probe suppresses filesystem error secrets', () => {
    let stdout = ''; let stderr = '';
    const proc = { argv: ['node', renderNode, 'box'], stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } };
    vm.runInNewContext(APPLE_RENDER_FACTS, { require: () => fakeIo({ denied: true }), process: proc });
    assert.equal(proc.exitCode, 1); assert.equal(stdout, ''); assert.equal(stderr, 'Apple render observation rejected');
    assert.ok(!stderr.includes(canary));
});

test('Apple render metadata false or unknown fails closed', () => {
    for (const field of ['character', 'read', 'write']) for (const value of [false, null, undefined, 1, 'true']) {
        const bad = facts('agent'); bad.renderNodes[0][field] = value;
        assert.throws(() => assertAppleRenderFacts(bad, { renderNode, role: 'agent' }));
    }
    for (const patch of [{ symlink: true }, { symlink: undefined }, { rdev: 0 }, { mode: 0o100666 }, { uid: -1 }]) {
        const bad = facts('agent'); Object.assign(bad.renderNodes[0], patch);
        assert.throws(() => assertAppleRenderFacts(bad, { renderNode, role: 'agent' }));
    }
});

function observer(mutate = () => {}) {
    const calls = [];
    const engine = async (name, args, options) => {
        calls.push({ name, args, options });
        assert.equal(options.journal, false); assert.equal(options.maxBytes, 65536); assert.equal(options.deadlineMs, 30000);
        const role = name.includes('-box-') ? 'box' : 'agent';
        const value = name.endsWith('-devices') ? inspect(role) : facts(role);
        if (name.endsWith('-devices')) assert.ok(args.includes(APPLE_DEVICE_INSPECT));
        else assert.ok(args.includes(APPLE_RENDER_FACTS));
        const result = transport(value); mutate({ name, result, value, count: calls.length });
        return result;
    };
    return { calls, run: () => observeAppleDevices({ engine, core: ['container', 'exec', '--user', 'podman', container('box').id],
        nested: ['container', 'exec', '--user', 'podman', container('box').id, 'podman', '--cgroup-manager=cgroupfs'],
        box: container('box'), agent: container('agent'), renderNode }) };
}

test('Apple observation binds both namespaces and does not retain secret canaries', async () => {
    const observed = observer(({ name, result, value }) => {
        if (!name.endsWith('-devices')) value.untrusted = canary;
        result.stdout = JSON.stringify(value);
    });
    const proof = await observed.run(); assert.equal(observed.calls.length, 6);
    assert.equal(proof.box.renderNodes[0].rdev, proof.agent.renderNodes[0].rdev);
    assert.ok(!JSON.stringify(proof).includes(canary));
    assert.ok(!JSON.stringify(proof).includes('createCommand'));
    assert.deepEqual(proof.box.recordedDevices, argumentsFor('box'));
});

test('Apple observation refuses identity changes, device mismatch and incomplete transport', async () => {
    for (const key of ['id', 'image', 'created', 'pid', 'running']) {
        await assert.rejects(observer(({ result, value, count }) => {
            if (count === 5) { value[key] = key === 'pid' ? 99 : key === 'running' ? false : 'changed'; result.stdout = JSON.stringify(value); }
        }).run(), /identity changed/);
    }
    await assert.rejects(observer(({ result, value, count }) => {
        if (count === 4) { value.renderNodes[0].rdev += 1; result.stdout = JSON.stringify(value); }
    }).run(), /identity differs/);
    for (const key of ['timedOut', 'truncated', 'cancelled', 'settlementForced']) for (const value of [true, undefined]) {
        await assert.rejects(observer(({ result }) => { result[key] = value; }).run());
    }
    for (const patch of [{ status: 1 }, { errorCode: 'EACCES' }, { signal: 'SIGTERM' }, { stdout: '{' + canary }, { stdout: 'x'.repeat(65537) }]) {
        await assert.rejects(observer(({ result }) => Object.assign(result, patch)).run(), error => !error.message.includes(canary));
    }
});
