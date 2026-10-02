import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';
import {
    admitManifestRuntimeCapabilities,
    assertHardwareAdmissionCurrent,
    createHardwareLaunchGuard,
    hardwareCommandPrefix,
    hardwareLimitsHashOf,
    limitsHashReuseReason,
    renderRuntimePolicyArgs,
} from '../../cli/sandbox/runtimeCapabilities.js';
import {
    CGROUPFS_ENGINE_PREFIX,
    assertEnginePrefix,
    engineCommandArgs,
    withEnginePrefix,
} from '../../cli/sandbox/hardwareLimits/runtimeCommand.mjs';
import { verifyLaunchedHardwareLimits, verifyLeafLimits } from '../../cli/sandbox/hardwareLimits/delegation.mjs';
import { HARDWARE_UNENFORCEABLE, HardwareLimitsError, findHardwareOutcome } from '../../cli/sandbox/hardwareLimits/errors.mjs';
import { assertHardwareStateConfined } from '../../cli/sandbox/hardwareLimits/store.mjs';
import { buildDirectRefusal } from '../../cli/sandbox/hardwareLimits/requestedLimits.mjs';
import { prepareLlmStartup, resolveLlmRuntimeAdmissionContext } from '../../cli/sandbox/docker/llmRuntimeIntegration.js';
import { detectHardware } from '../../cli/sandbox/docker/hardwareDetection.js';
import { assertInteractiveHardwareLimitsAbsent } from '../../cli/sandbox/docker/interactive.js';
import { getRuntimeForAgent } from '../../cli/sandbox/docker/common.js';
import { preparedCgroupFs } from '../hardware-limits/fakeCgroupFs.mjs';

const ALL = Object.freeze(['cpu', 'memory', 'pids']);
const LIMITED = Object.freeze({ container: 'node:20-alpine', llmRuntime: { runtimePolicy: { resources: { memory: '512m', cpus: 0.5, pidsLimit: 128 } } } });
const UNLIMITED = Object.freeze({ container: 'node:20-alpine' });
// Fixed hardware facts: no probe command runs and no engine is inspected.
const OFFLINE_HARDWARE = detectHardware({ runtime: 'podman', arch: 'x64', probes: {}, podmanInspect: () => null });

function source(relative) {
    return fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
}

function inBox(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-drift-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const markerPath = path.join(root, 'ploinky-box');
    fs.writeFileSync(markerPath, BOX_MARKER_CONTENT);
    return { root, boxMarkerOptions: { markerPath }, workspaceRoot: root };
}

function prepared(overrides = new Map(), extra = {}) {
    return {
        gate: 'on', prepared: true, backendReady: true, controllers: [...ALL], storeState: 'valid',
        storeToken: { epoch: 'epoch-1', revision: 1 }, overrides,
        envelope: { cpus: 8, memoryBytes: 16 * 1024 * 1024 * 1024 }, ...extra,
    };
}

function admit(box, manifest, { agentId = 'demo/worker', hardwareContext = prepared(), ...rest } = {}) {
    return admitManifestRuntimeCapabilities(manifest, {
        boxMarkerOptions: box.boxMarkerOptions, workspaceRoot: box.workspaceRoot,
        agentId, runtime: 'podman', hardwareContext, ...rest,
    });
}

function inputChanged(fn) {
    assert.throws(fn, (error) => error?.code === 'PLOINKY_RUNTIME_INPUT_CHANGED');
}

test('D.memory-swap-equal', (t) => {
    const box = inBox(t);
    const args = renderRuntimePolicyArgs(admit(box, LIMITED).descriptor, { runtime: 'podman' });
    const at = args.indexOf('--memory');
    assert.deepEqual(args.slice(at, at + 4), ['--memory', '512m', '--memory-swap', '512m']);
    assert.equal(args.filter((arg) => arg === '--memory-swap').length, 1);
    // The leaf proof requires memory.max = X and memory.swap.max = 0.
    const expected = admit(box, LIMITED).descriptor.hardwarePlacement.expected;
    assert.equal(expected.memoryBytes, 512 * 1024 * 1024);
    const fake = preparedCgroupFs();
    fake.addGroup('/ploinky/agents', { uid: 1000 });
    fake.addGroup('/ploinky/agents/libpod-a', { uid: 1000 });
    const leaf = fake.groups.get('/ploinky/agents/libpod-a');
    leaf.values.set('memory.max', String(512 * 1024 * 1024));
    leaf.values.set('memory.swap.max', '0');
    assert.equal(verifyLeafLimits({ fsApi: fake, leaf: '/ploinky/agents/libpod-a', expected: { memoryBytes: expected.memoryBytes } }).ok, true);
    leaf.values.set('memory.swap.max', 'max');
    assert.equal(verifyLeafLimits({ fsApi: fake, leaf: '/ploinky/agents/libpod-a', expected: { memoryBytes: expected.memoryBytes } }).ok, false);
    // Without hardware placement (outside a Box) the existing argv is unchanged.
    const outside = admitManifestRuntimeCapabilities(LIMITED, { agentId: 'demo/worker', runtime: 'podman', insideBox: false });
    const outsideArgs = renderRuntimePolicyArgs(outside.descriptor, { runtime: 'podman' });
    assert.ok(outsideArgs.includes('--memory'));
    assert.equal(outsideArgs.includes('--memory-swap'), false);
});

test('D.cgroupfs-prefix', (t) => {
    const box = inBox(t);
    const descriptor = admit(box, LIMITED).descriptor;
    assert.deepEqual(hardwareCommandPrefix(descriptor), ['--cgroup-manager=cgroupfs']);
    for (const operation of ['create', 'start', 'exec', 'run']) {
        assert.deepEqual(engineCommandArgs(hardwareCommandPrefix(descriptor), [operation, 'x']), ['--cgroup-manager=cgroupfs', operation, 'x']);
    }
    for (const operation of ['rm', 'inspect', 'stop', 'ps']) {
        assert.deepEqual(engineCommandArgs(hardwareCommandPrefix(descriptor), [operation, 'x']), [operation, 'x']);
    }
    // An argument array, never an engine name with spaces; only the exact option.
    assert.throws(() => assertEnginePrefix(['--cgroup-manager=systemd']), /unsupported engine command prefix/);
    assert.throws(() => assertEnginePrefix(['podman --cgroup-manager=cgroupfs']), /unsupported engine command prefix/);
    assert.deepEqual(assertEnginePrefix(CGROUPFS_ENGINE_PREFIX), ['--cgroup-manager=cgroupfs']);
    const calls = [];
    withEnginePrefix((runtime, args) => calls.push([runtime, args]), CGROUPFS_ENGINE_PREFIX)('podman', ['start', 'id']);
    assert.deepEqual(calls, [['podman', ['--cgroup-manager=cgroupfs', 'start', 'id']]]);
    // Agent create goes through the launch guard: the recheck passes, then the
    // engine prefix precedes the create subcommand.
    const guard = createHardwareLaunchGuard(admit(box, LIMITED), { key: 'ploinky_demo_worker', ref: 'demo/worker', hardwareContext: prepared() });
    assert.deepEqual(guard.createArgs(['create', '--name', 'x', 'image']), ['--cgroup-manager=cgroupfs', 'create', '--name', 'x', 'image']);
    assert.deepEqual(guard.commandPrefix(), ['--cgroup-manager=cgroupfs']);
    const unlimited = createHardwareLaunchGuard(admit(box, UNLIMITED, { hardwareContext: { gate: 'off', storeState: 'none' } }), {
        key: 'ploinky_demo_worker', ref: 'demo/worker', hardwareContext: { gate: 'off', storeState: 'none' },
    });
    assert.deepEqual(unlimited.createArgs(['create', 'x']), ['create', 'x']);
    assert.match(source('cli/sandbox/networkLifecycle.js'), /engineCommandArgs\(commandPrefix, \['start', /);
});

test('D.exempt-prefix-absent', (t) => {
    const box = inBox(t);
    const cases = {
        gateOff: admit(box, UNLIMITED, { hardwareContext: { gate: 'off', storeState: 'none' } }),
        unprepared: admit(box, UNLIMITED, { hardwareContext: prepared(new Map(), { prepared: false, backendReady: false }) }),
        outsideBox: admitManifestRuntimeCapabilities(LIMITED, { agentId: 'demo/worker', runtime: 'podman', insideBox: false }),
        helper: admit(box, LIMITED, { helper: true }),
        d4Unlimited: admit(box, { ...UNLIMITED, containerSecurity: { nestedPodman: true }, network: { mode: 'host' } }, { network: { mode: 'host' } }),
    };
    for (const [name, admission] of Object.entries(cases)) {
        assert.deepEqual(hardwareCommandPrefix(admission.descriptor), [], name);
        assert.equal(hardwareLimitsHashOf(admission.descriptor), '', name);
        const args = renderRuntimePolicyArgs(admission.descriptor, { runtime: 'podman' });
        assert.equal(args.some((arg) => String(arg).startsWith('--cgroup')), false, name);
        assert.equal(args.some((arg) => String(arg).startsWith('ploinky.limitshash=')), false, name);
        assert.deepEqual(engineCommandArgs(hardwareCommandPrefix(admission.descriptor), ['create', 'x']), ['create', 'x'], name);
    }
});

function launchedFixture(values) {
    const fake = preparedCgroupFs();
    fake.addGroup('/ploinky/agents', { uid: 1000 });
    fake.addGroup('/ploinky/agents/libpod-abc', { uid: 1000 });
    fake.addGroup('/ploinky/system', { uid: 1000 });
    fake.addGroup('/ploinky/system/libpod-def', { uid: 1000 });
    for (const [name, value] of Object.entries(values)) fake.groups.get('/ploinky/agents/libpod-abc').values.set(name, value);
    fake.placePid(321, '/ploinky/agents/libpod-abc');
    fake.placePid(654, '/ploinky/system/libpod-def');
    fake.readlinkSync = (target) => {
        if (target === '/proc/self/ns/cgroup') return 'cgroup:[1000]';
        if (target === '/proc/321/ns/cgroup' && fake.pidGroup.has(321)) return 'cgroup:[2000]';
        const error = new Error('namespace is absent');
        error.code = 'ENOENT';
        throw error;
    };
    return fake;
}

function launchGuard(box, manifest = LIMITED, { hardwareContext = prepared(), fake } = {}) {
    const admission = admit(box, manifest);
    return createHardwareLaunchGuard(admission, {
        key: 'ploinky_demo_worker', ref: 'demo/worker', hardwareContext, fsApi: fake,
        query: (_command, args) => (args.includes('{{.State.Pid}}') ? launchGuard.inspect : { ok: false, stdout: '' }),
    });
}
launchGuard.inspect = { ok: true, stdout: '321\n' };

function withInspect(result, fn) {
    const previous = launchGuard.inspect;
    launchGuard.inspect = result;
    try { return fn(); } finally { launchGuard.inspect = previous; }
}

const EXACT_LEAF = Object.freeze({
    'memory.max': String(512 * 1024 * 1024), 'memory.swap.max': '0', 'cpu.max': '50000 100000', 'pids.max': '128',
});

test('D.readback-mismatch', (t) => {
    const box = inBox(t);
    const launched = (fake) => launchGuard(box, LIMITED, { fake }).afterLaunch({ containerId: 'f'.repeat(64) });
    assert.equal(launched(launchedFixture(EXACT_LEAF)), undefined, 'the exact leaf is accepted');
    // An observed mismatch is a typed hardware refusal for this exact instance.
    for (const [name, value] of [['memory.max', 'max'], ['memory.max', String(256 * 1024 * 1024)], ['memory.swap.max', 'max'], ['cpu.max', 'max 100000'], ['pids.max', '4096']]) {
        assert.throws(() => launched(launchedFixture({ ...EXACT_LEAF, [name]: value })), (error) => {
            const outcome = findHardwareOutcome(error);
            assert.equal(outcome?.code, HARDWARE_UNENFORCEABLE);
            assert.equal(outcome.key, 'ploinky_demo_worker');
            assert.match(error.message, new RegExp(name.replace('.', '\\.')));
            return true;
        }, `${name}=${value}`);
    }
    // A process outside /ploinky/agents is a refusal too (inspect success alone is not proof).
    const outside = launchedFixture(EXACT_LEAF);
    outside.placePid(321, '/ploinky/system/libpod-def');
    assert.throws(() => launched(outside), (error) => /not under \/ploinky\/agents/.test(error.message) && findHardwareOutcome(error)?.code === HARDWARE_UNENFORCEABLE);
    // R1: a process that is not running, or whose PID is not visible, is an
    // ordinary start failure: no hardware outcome, no "not prepared" text.
    for (const [label, inspect] of [
        ['exited (pid 0)', { ok: true, stdout: '0\n' }],
        ['inspect failed', { ok: false, stdout: '' }],
        ['pid not visible', { ok: true, stdout: '999\n' }],
    ]) {
        withInspect(inspect, () => assert.throws(() => launched(launchedFixture(EXACT_LEAF)), (error) => {
            assert.equal(findHardwareOutcome(error), null, label);
            assert.equal(error.code, 'PLOINKY_AGENT_NOT_RUNNING', label);
            assert.doesNotMatch(error.message, /not prepared/, label);
            return true;
        }, label));
    }
});

test('D.readback-private-namespace', (t) => {
    const box = inBox(t);
    for (const [label, readlink] of [
        ['shared namespace', () => 'cgroup:[1000]'],
        ['malformed namespace', () => 'unknown'],
        ['unreadable namespace', () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; }],
    ]) {
        const fake = launchedFixture(EXACT_LEAF);
        fake.readlinkSync = readlink;
        assert.throws(() => launchGuard(box, LIMITED, { fake }).afterLaunch({ containerId: 'f'.repeat(64) }), (error) => {
            assert.equal(findHardwareOutcome(error)?.code, HARDWARE_UNENFORCEABLE, label);
            assert.match(error.message, /namespace/, label);
            return true;
        });
    }
    const fake = launchedFixture(EXACT_LEAF);
    const readlink = fake.readlinkSync;
    let reads = 0;
    fake.readlinkSync = (target) => target === '/proc/321/ns/cgroup' && ++reads > 1 ? 'cgroup:[3000]' : readlink(target);
    assert.throws(() => launchGuard(box, LIMITED, { fake }).afterLaunch({ containerId: 'f'.repeat(64) }), /namespace changed/);
});

test('D.readback-namespace-process-exit', (t) => {
    const box = inBox(t);
    const fake = launchedFixture(EXACT_LEAF);
    const readlink = fake.readlinkSync;
    let agentReads = 0;
    fake.readlinkSync = (target) => {
        if (target === '/proc/321/ns/cgroup' && ++agentReads === 2) fake.pidGroup.delete(321);
        return readlink(target);
    };
    assert.throws(() => launchGuard(box, LIMITED, { fake }).afterLaunch({ containerId: 'f'.repeat(64) }), (error) => {
        assert.equal(error.code, 'PLOINKY_AGENT_NOT_RUNNING');
        assert.equal(findHardwareOutcome(error), null);
        return true;
    });
});

test('D.readback-page-rounding', (t) => {
    const box = inBox(t);
    // R2: the kernel rounds memory.max down to its page size.
    for (const [declared, expectedBytes, readback] of [
        ['100000000', 100000000, '99999744'],
        ['1000k', 1024000, '1024000'],
    ]) {
        const manifest = { container: 'node:20-alpine', llmRuntime: { runtimePolicy: { resources: { memory: declared } } } };
        const admission = admit(box, manifest);
        assert.equal(admission.descriptor.hardwarePlacement.expected.memoryBytes, expectedBytes);
        const fake = launchedFixture({ 'memory.max': readback, 'memory.swap.max': '0' });
        assert.equal(launchGuard(box, manifest, { fake }).afterLaunch({ containerId: 'f'.repeat(64) }), undefined, declared);
        // The limits hash stays the same across restarts (declared bytes, not the readback).
        assert.equal(hardwareLimitsHashOf(admit(box, manifest).descriptor), hardwareLimitsHashOf(admission.descriptor));
    }
    // A genuinely different value is refused: larger, more than the page rounding below, or not page aligned.
    const manifest = { container: 'node:20-alpine', llmRuntime: { runtimePolicy: { resources: { memory: '100000000' } } } };
    for (const readback of ['100000256', '99934208', '99999745', String(64 * 1024 * 1024)]) {
        const fake = launchedFixture({ 'memory.max': readback, 'memory.swap.max': '0' });
        assert.throws(() => launchGuard(box, manifest, { fake }).afterLaunch({ containerId: 'f'.repeat(64) }),
            (error) => findHardwareOutcome(error)?.code === HARDWARE_UNENFORCEABLE, readback);
    }
});

test('D.readback-swap-accounting', (t) => {
    const box = inBox(t);
    // R3: no memory.swap.max at all means swap accounting is unavailable.
    const fake = launchedFixture({ 'memory.max': String(512 * 1024 * 1024), 'cpu.max': '50000 100000', 'pids.max': '128' });
    assert.throws(() => launchGuard(box, LIMITED, { fake }).afterLaunch({ containerId: 'f'.repeat(64) }), (error) => {
        const outcome = findHardwareOutcome(error);
        assert.equal(outcome.code, HARDWARE_UNENFORCEABLE);
        assert.equal(outcome.reasonCode, 'controller_unavailable');
        assert.match(outcome.reason, /^Swap accounting is unavailable: the agent cgroup has no memory\.swap\.max/);
        assert.match(outcome.fix, /swap accounting .* then run ploinky restart/);
        assert.doesNotMatch(error.message, /memory\.swap\.max is null/);
        return true;
    });
});

test('D.precreate-change', (t) => {
    const box = inBox(t);
    const admission = admit(box, LIMITED);
    const guard = (hardwareContext) => createHardwareLaunchGuard(admission, { key: 'ploinky_demo_worker', ref: 'demo/worker', hardwareContext });
    // Unchanged inputs yield the prefixed create argv.
    assert.deepEqual(guard(prepared()).createArgs(['create', 'x']), ['--cgroup-manager=cgroupfs', 'create', 'x']);
    // Any changed hardware input refuses before a create argv exists.
    for (const changed of [
        prepared(new Map(), { controllers: ['cpu', 'pids'] }),
        prepared(new Map([['demo/worker', { cpus: '0.25' }]])),
        prepared(new Map(), { backendReady: false }),
    ]) {
        let argv = null;
        inputChanged(() => { argv = guard(changed).createArgs(['create', 'x']); });
        assert.equal(argv, null, 'no create argv for a stale admission');
    }
});

test('D.prepublish-change', (t) => {
    const box = inBox(t);
    const admission = admit(box, LIMITED);
    const guard = (hardwareContext, fake) => createHardwareLaunchGuard(admission, {
        key: 'ploinky_demo_worker', ref: 'demo/worker', hardwareContext, fsApi: fake,
        query: () => ({ ok: true, stdout: '321\n' }),
    });
    assert.equal(guard(prepared(), launchedFixture(EXACT_LEAF)).afterLaunch({ containerId: 'f'.repeat(64) }), undefined);
    // The leaf is correct, but the inputs changed before publication.
    inputChanged(() => guard({ gate: 'off', storeState: 'none' }, launchedFixture(EXACT_LEAF)).afterLaunch({ containerId: 'f'.repeat(64) }));
    inputChanged(() => guard(prepared(new Map(), { storeState: 'unreadable' }), launchedFixture(EXACT_LEAF)).afterLaunch({ containerId: 'f'.repeat(64) }));
    // The readback runs first: a mismatched leaf is reported as the refusal.
    assert.throws(() => guard({ gate: 'off', storeState: 'none' }, launchedFixture({ ...EXACT_LEAF, 'pids.max': '7' })).afterLaunch({ containerId: 'f'.repeat(64) }),
        (error) => findHardwareOutcome(error)?.code === HARDWARE_UNENFORCEABLE);
    // K4: an adopted runtime is read back too (a leftover container with a
    // matching limits-hash label is never proof), then rechecked.
    assert.equal(guard(prepared(), launchedFixture(EXACT_LEAF)).afterLaunch({ containerId: 'f'.repeat(64), adopted: true }), undefined);
    assert.throws(() => guard(prepared(), launchedFixture({ ...EXACT_LEAF, 'memory.max': 'max' })).afterLaunch({ containerId: 'f'.repeat(64), adopted: true }),
        (error) => findHardwareOutcome(error)?.code === HARDWARE_UNENFORCEABLE && /memory\.max is max/.test(error.message));
    inputChanged(() => guard({ gate: 'off', storeState: 'none' }, launchedFixture(EXACT_LEAF)).afterLaunch({ containerId: 'f'.repeat(64), adopted: true }));
});

test('D.managed-reuse', (t) => {
    const box = inBox(t);
    for (const mode of ['default', 'bridge']) {
        const descriptor = admit(box, LIMITED, { network: { mode } }).descriptor;
        const label = hardwareLimitsHashOf(descriptor);
        assert.match(label, /^[a-f0-9]{64}$/);
        assert.equal(limitsHashReuseReason(descriptor, label), null, mode);
        assert.equal(limitsHashReuseReason(descriptor, ''), 'limitsHashChanged', mode);
        assert.equal(limitsHashReuseReason(descriptor, 'f'.repeat(64)), 'limitsHashChanged', mode);
    }
    assert.match(source('cli/sandbox/docker/agentServiceManager.js'), /limitsHashReuseReason\(serviceAdmission\.descriptor, getContainerLabel\(containerName, LIMITS_HASH_LABEL\)\)/);
});

test('D.host-none-reuse', (t) => {
    const box = inBox(t);
    for (const mode of ['host', 'none']) {
        const descriptor = admit(box, LIMITED, { network: { mode } }).descriptor;
        const label = hardwareLimitsHashOf(descriptor);
        assert.equal(limitsHashReuseReason(descriptor, label), null, mode);
        assert.equal(limitsHashReuseReason(descriptor, undefined), 'limitsHashChanged', mode);
    }
    // Host/none share the managed comparison in ensureAgentService (one function, one descriptor).
    const manager = source('cli/sandbox/docker/agentServiceManager.js');
    assert.equal(manager.match(/limitsHashReuseReason\(/g).length, 1);
});

test('D.graph-reuse', (t) => {
    const box = inBox(t);
    // Graph reuse uses metadata admission; its hash equals the strict creation hash.
    const strict = admit(box, LIMITED);
    const metadata = admit(box, LIMITED, { hardwareAdmission: 'metadata' });
    assert.equal(hardwareLimitsHashOf(metadata.descriptor), hardwareLimitsHashOf(strict.descriptor));
    assert.equal(limitsHashReuseReason(metadata.descriptor, hardwareLimitsHashOf(strict.descriptor)), null);
    const util = source('cli/commands/workspaceUtil.js');
    assert.match(util, /limitsHashReuseReason\(admittedDescriptor, getContainerLabelImpl\(existing\.key, LIMITS_HASH_LABEL\)\)/);
    assert.equal(util.includes('hardwareLimitsHashOf('), false, 'graph reuse uses the shared comparison only');
});

function llmCatalog(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-drift-llm-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const catalogRoot = path.join(root, 'catalog');
    fs.mkdirSync(path.join(catalogRoot, 'architectures'), { recursive: true });
    fs.mkdirSync(path.join(catalogRoot, 'images'), { recursive: true });
    fs.writeFileSync(path.join(catalogRoot, 'catalog.json'), JSON.stringify({
        schemaVersion: 1, catalogId: 'test/catalog', defaultFallback: 'cpu-amd64',
        architectures: [{ id: 'cpu-amd64', path: 'architectures/cpu-amd64.json' }],
        images: [{ id: 'cpu-amd64', path: 'images/cpu-amd64.json' }],
    }));
    fs.writeFileSync(path.join(catalogRoot, 'architectures/cpu-amd64.json'), JSON.stringify({
        id: 'cpu-amd64', status: 'stable', platform: 'linux/amd64', accelerator: { family: 'cpu' },
        match: { requiredProbes: [] }, image: 'cpu-amd64',
        runtimePolicy: { platform: 'linux/amd64', resources: { memory: '4g', cpus: '2', pidsLimit: 512 }, ipc: 'default' },
        engineDefaults: { enginePort: 8080, runtimePort: 9000 },
    }));
    fs.writeFileSync(path.join(catalogRoot, 'images/cpu-amd64.json'), JSON.stringify({ id: 'cpu-amd64', ref: 'reg.example.com/llm-cpu-amd64:dev', platform: 'linux/amd64' }));
    return { root, env: { PLOINKY_LLM_ARCHITECTURES_PATH: catalogRoot, PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64' } };
}

test('D.llm-admitted-policy-reuse', (t) => {
    const box = inBox(t);
    const { root, env } = llmCatalog(t);
    const manifest = { container: 'node:20-alpine', llmRuntime: { enabled: true } };
    const llm = resolveLlmRuntimeAdmissionContext({ runtime: 'podman', manifest, profileConfig: null, agentName: 'llm', env, resolvedHardware: OFFLINE_HARDWARE });
    // A stored administrator override (cpus 1.5) is the final policy layer.
    const admission = admit(box, manifest, {
        agentId: 'demo/llm', catalogPolicy: llm.catalogPolicy, catalogIdentity: llm.catalogIdentity,
        hardwareContext: prepared(new Map([['demo/llm', { cpus: '1.5' }]])),
    });
    assert.equal(admission.descriptor.runtimePolicy.resources.cpus, '1.5');
    const probe = (extra) => prepareLlmStartup({
        runtime: 'podman', manifest, profileConfig: null, agentName: 'llm', env, agentWorkDirRoot: root,
        manifestEnvNames: [], envHash: 'envhash', effectiveNetwork: null, writeState: false, createDirectories: false,
        resolvedSelection: llm.startup.selection, resolvedHardware: llm.startup.hardware, ...extra,
    });
    const creation = probe({ admittedRuntimePolicy: admission.descriptor.runtimePolicy });
    const reuse = probe({ admittedRuntimePolicy: admission.descriptor.runtimePolicy });
    assert.equal(reuse.reuseHash, creation.reuseHash);
    assert.equal(reuse.policyHash, creation.policyHash);
    // Without the admitted policy the probe would hash a different policy and restart every start.
    assert.notEqual(probe({}).reuseHash, creation.reuseHash);
    // The production graph reuse caller passes the admitted policy and the
    // creation's resolved selection/hardware, so a stored override does not
    // restart the LLM agent; a runtime created without them is replaced.
    const graph = graphReuse(t, box, {
        hardwareContext: serializable(prepared(new Map([['demo/llm', { cpus: '1.5' }]]))),
        llmEnv: env,
        agents: [
            { key: 'ploinky_demo_llm', ref: 'demo/llm', manifest },
            { key: 'ploinky_demo_llm_legacy', ref: 'demo/llm', manifest, running: { admitted: false } },
        ],
    });
    assert.deepEqual(graph.probes.ploinky_demo_llm, ['admittedRuntimePolicy', 'resolvedHardware', 'resolvedSelection']);
    assert.equal(graph.results.ploinky_demo_llm, '', 'creation and graph reuse agree');
    assert.equal(graph.results.ploinky_demo_llm_legacy, 'llmReuseHashChanged');
});

// Run the production graph reuse decision in a fresh process bound to a
// temporary workspace (persisted Router port, data paths).
function graphReuse(t, box, spec) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-graph-reuse-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.ploinky', 'routing.json'), JSON.stringify({ port: 8080, routes: {} }));
    const specPath = path.join(workspace, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify({ markerPath: box.boxMarkerOptions.markerPath, ...spec }));
    const probe = fileURLToPath(new URL('../hardware-limits/graphReuseProbe.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [probe, specPath], {
        cwd: workspace,
        encoding: 'utf8',
        env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspace },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').pop());
}

function serializable(context) {
    return { ...context, overrides: Object.fromEntries(context.overrides) };
}

const EDITED = Object.freeze({
    memory: { container: 'node:20-alpine', llmRuntime: { runtimePolicy: { resources: { memory: '768m', cpus: 0.5, pidsLimit: 128 } } } },
    pids: { container: 'node:20-alpine', llmRuntime: { runtimePolicy: { resources: { memory: '512m', cpus: 0.5, pidsLimit: 256 } } } },
});

for (const field of ['memory', 'pids']) {
    test(`D.${field}-only-change-replaces-one`, (t) => {
        const box = inBox(t);
        // Two running non-LLM limited agents; only the first agent's declared
        // ${field} changes. Exactly that agent is replaced; the other is reused.
        const graph = graphReuse(t, box, {
            hardwareContext: serializable(prepared()),
            agents: [
                { key: 'ploinky_demo_changed', ref: 'demo/changed', manifest: EDITED[field], running: { manifest: LIMITED } },
                { key: 'ploinky_demo_same', ref: 'demo/same', manifest: LIMITED },
            ],
        });
        assert.deepEqual(graph.results, { ploinky_demo_changed: 'limitsHashChanged', ploinky_demo_same: '' });
        // The same change as a stored policy (memory) is covered as well.
        if (field === 'memory') {
            const stored = graphReuse(t, box, {
                hardwareContext: serializable(prepared(new Map([['demo/changed', { memoryPercent: 10 }]]))),
                agents: [
                    { key: 'ploinky_demo_changed', ref: 'demo/changed', manifest: LIMITED, running: { hardwareContext: serializable(prepared()) } },
                    { key: 'ploinky_demo_same', ref: 'demo/same', manifest: LIMITED, running: { hardwareContext: serializable(prepared()) } },
                ],
            });
            assert.deepEqual(stored.results, { ploinky_demo_changed: 'limitsHashChanged', ploinky_demo_same: '' });
        }
    });
}

test('D.one-replace-then-reuse', (t) => {
    const box = inBox(t);
    const before = admit(box, LIMITED).descriptor;
    const changed = admit(box, LIMITED, { hardwareContext: prepared(new Map([['demo/worker', { cpus: '0.25' }]])) }).descriptor;
    const runningLabel = hardwareLimitsHashOf(before);
    // The stored change replaces the runtime once...
    assert.equal(limitsHashReuseReason(changed, runningLabel), 'limitsHashChanged');
    // ...and the replacement (labelled with the new hash) is then reused.
    const replacementLabel = hardwareLimitsHashOf(changed);
    const again = admit(box, LIMITED, { hardwareContext: prepared(new Map([['demo/worker', { cpus: '0.25' }]]), { storeToken: { epoch: 'epoch-1', revision: 2 } }) }).descriptor;
    assert.equal(limitsHashReuseReason(again, replacementLabel), null);
    // A configured change resolving to identical rendered values does not replace.
    const same = admit(box, LIMITED, { hardwareContext: prepared(new Map([['demo/worker', { cpus: '0.50' }]])) }).descriptor;
    assert.equal(limitsHashReuseReason(same, runningLabel), null);
});

test('D.unrelated-token-no-replace', (t) => {
    const box = inBox(t);
    const admission = admit(box, LIMITED);
    const unrelated = prepared(new Map([['other/agent', { cpus: '1' }]]), { storeToken: { epoch: 'epoch-1', revision: 9 } });
    const after = admit(box, LIMITED, { hardwareContext: unrelated });
    assert.equal(hardwareLimitsHashOf(after.descriptor), hardwareLimitsHashOf(admission.descriptor));
    assert.equal(limitsHashReuseReason(after.descriptor, hardwareLimitsHashOf(admission.descriptor)), null);
    // Nor does it make this agent's admission stale.
    assert.doesNotThrow(() => assertHardwareAdmissionCurrent(admission, { hardwareContext: unrelated }));
});

test('D.unprepared-empty-hash', (t) => {
    const box = inBox(t);
    const unprepared = admit(box, UNLIMITED, { hardwareContext: prepared(new Map(), { prepared: false, backendReady: false }) });
    assert.equal(hardwareLimitsHashOf(unprepared.descriptor), '');
    // A runtime created before hardware placement (no label) is reused while unprepared.
    assert.equal(limitsHashReuseReason(unprepared.descriptor, ''), null);
    assert.equal(limitsHashReuseReason(unprepared.descriptor, undefined), null);
    // A limited request in an unprepared Box is refused, never rendered without placement.
    const refused = admit(box, LIMITED, { hardwareContext: prepared(new Map(), { prepared: false, backendReady: false }), hardwareAdmission: 'metadata' });
    assert.equal(refused.hardwareEligibility.state, 'refused');
    assert.equal(refused.hardwareEligibility.refusal.reasonCode, 'unprepared');
    assert.equal(hardwareLimitsHashOf(refused.descriptor), '');
});

test('D.private-mount-boundaries', (t) => {
    const box = inBox(t);
    const privatePaths = ['/run/ploinky/hardware-limits', '/run/ploinky', '/run', '/etc/ploinky-box-hardware-limits.json', '/run/ploinky/mps/pipe', '/run/ploinky-mps-pipe'];
    for (const hostPath of privatePaths) {
        for (const hardwareAdmission of ['strict', 'metadata']) {
            assert.throws(() => admit(box, { ...UNLIMITED, volumes: { [hostPath]: '/data' } }, { hardwareAdmission }), /unsupported|outside|host mount|hostMounts/i, `${hostPath} ${hardwareAdmission}`);
            assert.throws(() => admit(box, { ...UNLIMITED, profiles: { dev: { volumes: { [hostPath]: '/data' } } } }, { profileName: 'dev', profileConfig: { volumes: { [hostPath]: '/data' } }, hardwareAdmission }), /unsupported|outside|host mount|hostMounts/i, `profile ${hostPath}`);
        }
    }
    // A workspace alias (symlink) to a private path is not a managed source.
    fs.symlinkSync('/run', path.join(box.root, 'run-alias'));
    assert.throws(() => admit(box, { ...UNLIMITED, volumes: { 'run-alias/ploinky/hardware-limits': '/data' } }), /unsupported|outside|host mount|hostMounts/i);
    // The host control state never overlaps a writable workspace/cache source.
    const home = path.join(box.root, 'home');
    fs.mkdirSync(path.join(home, '.ploinky-box'), { recursive: true });
    assert.throws(() => assertHardwareStateConfined({ workspaceRoot: home, homeDirectory: home }), /overlaps writable Box source/);
    assert.throws(() => assertHardwareStateConfined({ workspaceRoot: path.join(box.root, 'ws'), dataPaths: { cache: path.join(home, '.ploinky-box', 'hardware-limits', 'x') }, homeDirectory: home }), /overlaps writable Box source/);
    assert.throws(() => assertHardwareStateConfined({ workspaceRoot: '/run/ploinky-mps-pipe', homeDirectory: home }), /reserved MPS pipe path/);
    assert.equal(assertHardwareStateConfined({ workspaceRoot: path.join(box.root, 'ws'), homeDirectory: home }), true);
});

function refusalFrom(fn) {
    try {
        fn();
    } catch (error) {
        return findHardwareOutcome(error);
    }
    assert.fail('expected a hardware refusal');
}

test('D.interactive-reuse-refused', () => {
    const stored = { gate: 'on', prepared: true, backendReady: true, controllers: [...ALL], storeState: 'valid', overrides: new Map([['demo/shell', { cpus: '1' }]]) };
    const outcome = refusalFrom(() => assertInteractiveHardwareLimitsAbsent(UNLIMITED, {
        agentName: 'shell', repoName: 'demo', containerName: 'ploinky_demo_shell', insideBox: true, hardwareContext: stored,
    }));
    assert.equal(outcome.reasonCode, 'interactive_runtime');
    assert.match(outcome.reason, /^This runtime cannot apply cpus\.$/);
    assert.match(outcome.fix, /^Use the managed container lifecycle, or remove the limit\./);
    // Without limits the existing behavior is kept.
    assert.equal(assertInteractiveHardwareLimitsAbsent(UNLIMITED, {
        agentName: 'shell', repoName: 'demo', containerName: 'ploinky_demo_shell', insideBox: true, hardwareContext: { gate: 'on', storeState: 'valid', overrides: new Map() },
    }), undefined);
    // The guard runs before any reuse decision in both interactive paths.
    const interactive = source('cli/sandbox/docker/interactive.js');
    for (const entry of ['function runCommandInContainer(', 'function ensureAgentContainer(']) {
        const start = interactive.indexOf(entry);
        const guard = interactive.indexOf('assertInteractiveHardwareLimitsAbsent(manifest', start);
        const reuse = interactive.indexOf('containerExists(containerName)', start);
        assert.ok(start > 0 && guard > start && reuse > guard, entry);
    }
});

test('D.interactive-create-refused', () => {
    const outcome = refusalFrom(() => assertInteractiveHardwareLimitsAbsent(LIMITED, {
        agentName: 'shell', repoName: 'demo', containerName: 'ploinky_demo_shell', insideBox: true,
        hardwareContext: { gate: 'off', storeState: 'none' },
    }));
    assert.equal(outcome.code, HARDWARE_UNENFORCEABLE);
    assert.deepEqual(outcome.requested.map((entry) => entry.field), ['memory', 'cpus', 'pidsLimit']);
    assert.match(outcome.reason, /^This runtime cannot apply memory, cpus, pidsLimit\.$/);
    // Profile-declared limits are refused too.
    const profile = refusalFrom(() => assertInteractiveHardwareLimitsAbsent(UNLIMITED, {
        agentName: 'shell', repoName: 'demo', containerName: 'ploinky_demo_shell', insideBox: false,
        profileConfig: { llmRuntime: { runtimePolicy: { resources: { pidsLimit: 64 } } } },
    }));
    assert.deepEqual(profile.requested.map((entry) => entry.field), ['pidsLimit']);
});

// ---------------------------------------------------------------------------
// Fix round 2: the startAgentContainer launch order (K3, K4), the
// ensureAgentService LLM reuse caller (K3), readback liveness (K9) and
// interactive and lite-sandbox refusals (K8).

const serviceManager = await import('../../cli/sandbox/docker/agentServiceManager.js');

test('D.start-container-launch-order', (t) => {
    const box = inBox(t);
    const admission = admit(box, LIMITED);
    const run = ({ context = prepared(), fake = launchedFixture(EXACT_LEAF), adopted = false, afterCreate = () => {} } = {}) => {
        const events = [];
        const guard = createHardwareLaunchGuard(admission, {
            key: 'ploinky_demo_worker', ref: 'demo/worker', hardwareContext: context, fsApi: fake,
            query: (_command, args) => { events.push(`readback:${String(args.at(-1)).slice(0, 4)}`); return { ok: true, stdout: '321\n' }; },
        });
        let error = null;
        try {
            // The exact seam startAgentContainer launches through.
            serviceManager.runHardwareGuardedLaunch(guard, {
                placed: true,
                removeStaleLeaves: () => events.push('remove-stale-leaves'),
                buildCreateArgs: (plan) => { events.push(`build:${plan.mode}`); return ['create', '--name', 'ploinky_demo_worker', 'node:20-alpine']; },
                spawnCreate: (args) => { events.push(`create:${args.join(' ')}`); afterCreate(); return 'f'.repeat(64); },
                launch: (createContainer) => {
                    if (adopted) return { containerId: 'f'.repeat(64), adopted: true };
                    return { containerId: createContainer({ mode: 'host' }), adopted: false };
                },
            });
        } catch (caught) {
            error = caught;
        }
        return { events, error };
    };
    // createArgs prefix -> create -> afterLaunch readback -> currentness recheck.
    const ok = run();
    assert.equal(ok.error, null);
    assert.deepEqual(ok.events, ['build:host', 'remove-stale-leaves', 'create:--cgroup-manager=cgroupfs create --name ploinky_demo_worker node:20-alpine', 'readback:ffff', 'readback:ffff']);
    // The inputs are rechecked before create: a changed controller set
    // refuses with no create at all.
    const stale = run({ context: prepared(new Map(), { controllers: ['cpu', 'pids'] }) });
    assert.equal(stale.error?.code, 'PLOINKY_RUNTIME_INPUT_CHANGED');
    assert.deepEqual(stale.events, ['build:host']);
    // The leaf is read back after the create: a disagreement is a refusal.
    const mismatch = run({ fake: launchedFixture({ ...EXACT_LEAF, 'pids.max': '7' }) });
    assert.equal(findHardwareOutcome(mismatch.error)?.code, HARDWARE_UNENFORCEABLE);
    assert.deepEqual(mismatch.events.slice(-2), ['create:--cgroup-manager=cgroupfs create --name ploinky_demo_worker node:20-alpine', 'readback:ffff']);
    // The inputs are rechecked again after the readback, before return.
    const context = prepared();
    const changedAfter = run({ context, afterCreate: () => { context.controllers = ['cpu', 'pids']; } });
    assert.equal(changedAfter.error?.code, 'PLOINKY_RUNTIME_INPUT_CHANGED');
    assert.ok(changedAfter.events.includes('readback:ffff'), 'the readback ran before the recheck');
    // K4: an adopted runtime is read back too; a disagreeing leaf is refused.
    const adopted = run({ adopted: true, fake: launchedFixture({ ...EXACT_LEAF, 'memory.max': 'max' }) });
    assert.equal(findHardwareOutcome(adopted.error)?.code, HARDWARE_UNENFORCEABLE);
    assert.deepEqual(adopted.events, ['readback:ffff']);
    // Source pin (no engine-free seam exists for the rest of
    // startAgentContainer): it launches only through this seam, its engine
    // create runs only inside spawnCreate, and the guard is used nowhere else.
    const manager = source('cli/sandbox/docker/agentServiceManager.js');
    const start = manager.indexOf('function startAgentContainer(');
    const end = manager.indexOf('\nfunction ', start + 10);
    const body = manager.slice(start, end);
    assert.equal(body.match(/runHardwareGuardedLaunch\(hardwareLaunch, \{/g)?.length, 1);
    assert.equal(body.match(/spawnSync\(runtime, createArgs/g)?.length, 1);
    assert.ok(body.indexOf('spawnSync(runtime, createArgs') > body.indexOf('const spawnCreate = '));
    assert.equal(manager.match(/hardwareLaunch\.(createArgs|afterLaunch)\(/g)?.length, 2, 'only the seam calls the guard');
});

test('D.service-llm-reuse', (t) => {
    const box = inBox(t);
    const { root, env } = llmCatalog(t);
    const manifest = { container: 'node:20-alpine', llmRuntime: { enabled: true } };
    const llm = resolveLlmRuntimeAdmissionContext({ runtime: 'podman', manifest, profileConfig: null, agentName: 'llm', env, resolvedHardware: OFFLINE_HARDWARE });
    const admission = admit(box, manifest, {
        agentId: 'demo/llm', catalogPolicy: llm.catalogPolicy, catalogIdentity: llm.catalogIdentity,
        hardwareContext: prepared(new Map([['demo/llm', { cpus: '1.5' }]])),
    });
    const creation = (extra) => prepareLlmStartup({
        runtime: 'podman', manifest, profileConfig: null, agentName: 'llm', env, agentWorkDirRoot: root,
        manifestEnvNames: [], envHash: 'envhash', effectiveNetwork: null, writeState: false, createDirectories: false,
        resolvedSelection: llm.startup.selection, resolvedHardware: llm.startup.hardware, ...extra,
    });
    // ensureAgentService's own reuse caller, against a runtime's labels.
    const reuse = (labels) => serviceManager.serviceLlmReuseReason({
        runtime: 'podman', manifest, profileConfig: null, agentName: 'llm', containerName: 'ploinky_demo_llm',
        envHash: 'envhash', serviceAdmission: admission, serviceLlmAdmissionContext: llm, env, agentWorkDirRoot: root,
        getContainerLabelImpl: (_name, label) => labels[label] ?? '',
    });
    // A runtime created with the admitted policy (stored override included)
    // is reused; one created without it is replaced.
    assert.equal(reuse({ 'ploinky.reusehash': creation({ admittedRuntimePolicy: admission.descriptor.runtimePolicy }).reuseHash }), '');
    assert.equal(reuse({ 'ploinky.reusehash': creation({}).reuseHash }), 'llmReuseHashChanged');
});

test('D.readback-process-exit', (t) => {
    const box = inBox(t);
    const admission = admit(box, LIMITED);
    const verify = (fake, inspects) => createHardwareLaunchGuard(admission, {
        key: 'ploinky_demo_worker', ref: 'demo/worker', hardwareContext: prepared(), fsApi: fake,
        query: () => ({ ok: true, stdout: `${inspects.shift() ?? '0'}\n` }),
    }).afterLaunch({ containerId: 'f'.repeat(64) });
    // K9: the process exits mid-readback (its leaf disappears after
    // /proc/PID/cgroup was read): the ordinary not-running failure.
    const midRead = launchedFixture(EXACT_LEAF);
    midRead.hooks.beforeRead = (rel) => {
        if (rel === '/ploinky/agents/libpod-abc') {
            midRead.groups.delete(rel);
            midRead.pidGroup.delete(321);
        }
    };
    assert.throws(() => verify(midRead, ['321', '0']), (error) => {
        assert.equal(error.code, 'PLOINKY_AGENT_NOT_RUNNING');
        assert.equal(findHardwareOutcome(error), null);
        assert.match(error.message, /PID 321 exited during the readback/);
        return true;
    });
    // The leaf is already gone when the readback starts.
    const gone = launchedFixture(EXACT_LEAF);
    gone.groups.delete('/ploinky/agents/libpod-abc');
    assert.throws(() => verify(gone, ['321', '0']), (error) => error.code === 'PLOINKY_AGENT_NOT_RUNNING'
        && findHardwareOutcome(error) === null && !/swap accounting/i.test(error.message));
    // A live process whose leaf is missing is a refusal, never reported as
    // missing swap accounting.
    const missing = launchedFixture(EXACT_LEAF);
    missing.groups.delete('/ploinky/agents/libpod-abc');
    assert.throws(() => verify(missing, ['321', '321']), (error) => {
        const outcome = findHardwareOutcome(error);
        assert.equal(outcome?.code, HARDWARE_UNENFORCEABLE);
        assert.notEqual(outcome.reasonCode, 'controller_unavailable');
        assert.doesNotMatch(error.message, /swap accounting/i);
        assert.match(error.message, /the agent cgroup \/ploinky\/agents\/libpod-abc is absent/);
        return true;
    });
    // The leaf is present without memory.swap.max: swap accounting reason.
    const noSwap = launchedFixture({ 'memory.max': String(512 * 1024 * 1024), 'cpu.max': '50000 100000', 'pids.max': '128' });
    assert.throws(() => verify(noSwap, ['321', '321']), (error) => findHardwareOutcome(error)?.reasonCode === 'controller_unavailable'
        && /^Swap accounting is unavailable/.test(findHardwareOutcome(error).reason));
});

test('D.interactive-stored-gpu-refused', () => {
    // K8: interactive create/reuse refuses a stored GPU-only entry with the
    // same reason and fix as admission.
    const context = { gate: 'on', prepared: true, backendReady: true, controllers: [...ALL], storeState: 'valid', overrides: new Map([['demo/shell', { gpu: { smPercent: 40, vramPercent: 30 } }]]) };
    const outcome = refusalFrom(() => assertInteractiveHardwareLimitsAbsent(UNLIMITED, {
        agentName: 'shell', repoName: 'demo', containerName: 'ploinky_demo_shell', insideBox: true, hardwareContext: context,
    }));
    assert.equal(outcome.reasonCode, 'gpu_sharing_unavailable');
    assert.equal(outcome.reason, 'This agent has no active, qualified Box GPU grant.');
    assert.match(outcome.fix, /^Clear the GPU share in Settings, or run ploinky limits clear --agent demo\/shell on the host/);
    assert.deepEqual(outcome.requested, [{ field: 'gpu', value: '40/30 percent', source: 'settings' }]);
});

test('D.interactive-stored-replaces-declared', () => {
    // K8: a stored cpus value replaces the manifest's in the refusal.
    const context = { gate: 'on', storeState: 'valid', overrides: new Map([['demo/shell', { cpus: 3 }]]) };
    const outcome = refusalFrom(() => assertInteractiveHardwareLimitsAbsent(LIMITED, {
        agentName: 'shell', repoName: 'demo', containerName: 'ploinky_demo_shell', insideBox: true, hardwareContext: context,
    }));
    assert.equal(outcome.reasonCode, 'interactive_runtime');
    assert.deepEqual(outcome.requested.map((entry) => [entry.field, entry.value, entry.source]),
        [['memory', '512m', 'manifest'], ['cpus', '3', 'settings'], ['pidsLimit', '128', 'manifest']]);
});

test('D.lite-sandbox-runs-as-container-in-box', (t) => {
    // K8 evidence: inside a Box every agent, lite-sandbox ones included, runs
    // in the nested container runtime (getRuntimeForAgent), so a declared or
    // stored limit gets container admission, never a bwrap/seatbelt bypass.
    const box = inBox(t);
    let runtime;
    try {
        runtime = getRuntimeForAgent({ container: 'node:20-alpine', 'lite-sandbox': true }, { boxMarkerPath: box.boxMarkerOptions.markerPath });
    } catch (error) {
        // A Box without nested Podman fails closed; it never falls back to a sandbox.
        assert.equal(error.code, 'PLOINKY_BOX_PODMAN_REQUIRED');
        runtime = 'podman';
    }
    assert.equal(runtime, 'podman', 'inside a Box a lite-sandbox agent runs in the nested container runtime');
    const outcome = refusalFrom(() => admit(box, { container: 'node:20-alpine', 'lite-sandbox': true }, {
        runtimeKind: 'container', hardwareContext: prepared(new Map([['demo/worker', { cpus: '9' }]])),
    }));
    assert.equal(outcome.reasonCode, 'exceeds_envelope', 'a stored limit is admitted as a container limit');
});
