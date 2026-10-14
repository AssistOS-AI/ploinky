// The Box envelope reaches readMpsStatus at both production call sites that build the GPU status: readBoxHardwareContext
// (Apply, launch, admission) and the route context (GET and POST). Without it the qualified GB10 is never eligible
// ("Box memory envelope unknown"), and the unit tests that inject getContext or readMpsStatus cannot see that.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';

const originalEnv = { PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT };
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-ctxenv-')));
const workspace = path.join(root, 'workspace');
const home = path.join(root, 'home');
fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
fs.mkdirSync(home);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
fs.writeFileSync(path.join(root, 'ploinky-box'), BOX_MARKER_CONTENT);

const imp = (relative) => import(new URL(relative, import.meta.url).href);
const { buildWorkspaceIdentity } = await imp('../../ploinky-box/identity.mjs');
const { resolveDesiredHardwareWiring } = await imp('../../ploinky-box/hardwareLimitsGate.mjs');
const { hardwareStorePaths, initializeStore, readStoreSnapshot, setAgentLimits } = await imp('../../cli/sandbox/hardwareLimits/store.mjs');
const { readBoxHardwareContext, resetHardwareContextCacheForTests } = await imp('../../cli/sandbox/hardwareLimits/context.mjs');
const { observeMpsGpu } = await imp('../../cli/sandbox/hardwareLimits/mpsEligibility.mjs');
const { readMpsStatus } = await imp('../../cli/sandbox/hardwareLimits/mpsStatus.mjs');
const { readDefaultHardwareContext } = await imp('../../cli/server/authHandlers/hardwareLimitsRoutes.mjs');
const { preparedCgroupFs } = await imp('../hardware-limits/fakeCgroupFs.mjs');

test.after(() => {
    if (originalEnv.PLOINKY_WORKSPACE_ROOT === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = originalEnv.PLOINKY_WORKSPACE_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
});

const MIB = 1048576;
const CGROUP = '/sys/fs/cgroup';
// MemTotal 8388609 kB is 8192 MiB plus 1024 bytes: the share basis must be rounded down to whole MiB.
const MEM_TOTAL_BYTES = 8388609 * 1024;
const EXPECTED_BASIS = Math.floor(MEM_TOTAL_BYTES / MIB) * MIB;
const SERVED = new Map([['/proc/meminfo', 'MemTotal:     8388609 kB\n'], [`${CGROUP}/memory.max`, 'max\n'], [`${CGROUP}/cpu.max`, 'max 100000\n']]);
function compositeFs(fake) {
    const routed = new Set(['readFileSync', 'lstatSync', 'mkdirSync', 'writeFileSync', 'readdirSync', 'rmdirSync']);
    return new Proxy(fs, {
        get(target, property) {
            if (!routed.has(property)) return target[property];
            return (first, ...rest) => {
                const value = typeof first === 'string' ? first : '';
                if (property === 'readFileSync' && SERVED.has(value)) return SERVED.get(value);
                if (value === CGROUP || value.startsWith(`${CGROUP}/`) || value.startsWith('/proc/')) return fake[property](first, ...rest);
                return target[property](first, ...rest);
            };
        },
    });
}

// A stubbed qualified GB10 observation (PCI 0x2E1210DE, driver 580.178.04), through the real status reader.
const UUID = 'GPU-12345678-1234-1234-1234-123456789012';
const query = (_command, args) => ({ status: 0, stderr: '', stdout: args.some((arg) => arg.includes('pci.device_id')) ? '0x2E1210DE, ATS\n' : `0, ${UUID}, NVIDIA GB10, [N/A], 580.178.04\n` });
const grant = { valid: true, state: 'active', fingerprint: 'wiring', agents: ['demo/worker'], mps: { control: { source: '/private/tool' } } };
const qualifiedReadMps = (calls) => (args) => { calls.push(args); return readMpsStatus({ ...args, readGrant: () => grant, observeGpu: () => observeMpsGpu({ query }), readState: () => null }); };

test('CE.readBoxHardwareContext passes the Box envelope to the GPU status', () => {
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const wiring = resolveDesiredHardwareWiring({ identity, enabled: true, hostKind: 'podman-machine', homeDirectory: home, initializeStore });
    const paths = hardwareStorePaths({ identity, homeDirectory: home });
    assert.equal(paths.storeRoot, wiring.storeRoot);
    // A stored GPU entry is what makes the context read the GPU status at all.
    const stored = setAgentLimits({
        paths, identity, expectedToken: readStoreSnapshot({ paths, identity }).token, agentRef: 'demo/worker', limits: { gpu: { smPercent: 50, vramPercent: 25 } },
        actor: { id: 'admin', name: 'Admin' }, installedRefs: new Set(['demo/worker']), envelope: { cpus: 8, memoryBytes: MEM_TOTAL_BYTES },
        capabilities: { gate: 'on', controllers: ['cpu', 'memory', 'pids'], gpu: { eligible: true, memoryModel: 'unified', shareBasis: { kind: 'unified-pool', bytes: EXPECTED_BASIS } } },
    });
    assert.ok(stored);
    resetHardwareContextCacheForTests();
    const calls = [];
    const context = readBoxHardwareContext({
        fsApi: compositeFs(preparedCgroupFs({ controllers: ['cpu', 'memory', 'pids'] })), markerPath: wiring.markerPath, storeRoot: wiring.storeRoot,
        query: () => ({ ok: true, stdout: JSON.stringify({ host: { ociRuntime: { name: 'crun' }, cgroupManager: 'cgroupfs' } }) }),
        readMps: qualifiedReadMps(calls),
    });
    assert.equal(context.envelope.memoryBytes, MEM_TOTAL_BYTES);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].envelope.memoryBytes, MEM_TOTAL_BYTES);
    assert.equal(context.gpu.eligible, true);
    assert.equal(context.gpu.shareBasis.bytes, EXPECTED_BASIS);
    assert.notEqual(EXPECTED_BASIS, MEM_TOTAL_BYTES);
});

test('CE.the route context passes the Box envelope to the GPU status', () => {
    const marker = { valid: true, marker: { instance: 'ploinky-box-demo-0123456789ab', pathHash: '0123456789ab', workspaceRoot: workspace } };
    const calls = [];
    const context = readDefaultHardwareContext({ refreshBackend: true }, {
        inBox: () => true, readMarker: () => marker, readMps: qualifiedReadMps(calls),
        readContext: (options) => { assert.deepEqual(options, { refreshBackend: true }); return { gate: 'on', envelope: { cpus: 8, memoryBytes: MEM_TOTAL_BYTES } }; },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].workspaceRoot, workspace);
    assert.equal(calls[0].envelope.memoryBytes, MEM_TOTAL_BYTES);
    assert.equal(context.gpu.eligible, true);
    assert.equal(context.gpu.shareBasis.bytes, EXPECTED_BASIS);
    assert.equal(context.paths.context, 'box');
    assert.equal(context.identity.instance, marker.marker.instance);
    // An unreadable envelope stays unknown rather than being invented: the GPU is then not eligible.
    const unknown = readDefaultHardwareContext({}, { inBox: () => true, readMarker: () => marker, readMps: qualifiedReadMps([]), readContext: () => ({ gate: 'on', envelope: null }) });
    assert.equal(unknown.gpu.eligible, false);
    assert.equal(unknown.gpu.reason, 'Box memory envelope unknown');
    // The gate off and outside the Box keep their behaviour.
    assert.equal(readDefaultHardwareContext({}, { inBox: () => true, readMarker: () => marker, readContext: () => ({ gate: 'off' }), readMps: () => assert.fail('no GPU status with the gate off') }).identity, null);
    assert.throws(() => readDefaultHardwareContext({}, { inBox: () => false }), { code: 'not_in_box' });
});
