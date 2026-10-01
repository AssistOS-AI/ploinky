import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';
import {
    admitManifestRuntimeCapabilities,
    assertHardwareAdmissionCurrent,
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
import { assertInteractiveHardwareLimitsAbsent } from '../../cli/sandbox/docker/interactive.js';
import { preparedCgroupFs } from '../hardware-limits/fakeCgroupFs.mjs';

const ALL = Object.freeze(['cpu', 'memory', 'pids']);
const LIMITED = Object.freeze({ container: 'node:20-alpine', llmRuntime: { runtimePolicy: { resources: { memory: '512m', cpus: 0.5, pidsLimit: 128 } } } });
const UNLIMITED = Object.freeze({ container: 'node:20-alpine' });

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
        storeToken: { epoch: 'epoch-1', revision: 1 }, overrides, ...extra,
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
    // Agent create and start both go through the adapter.
    assert.match(source('cli/sandbox/docker/agentServiceManager.js'), /engineCommandArgs\(hardwareCommandPrefix\(runtimeAdmission\.descriptor\), createArgs\)/);
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
    return fake;
}

test('D.readback-mismatch', (t) => {
    const box = inBox(t);
    const descriptor = admit(box, LIMITED).descriptor;
    const exact = {
        'memory.max': String(512 * 1024 * 1024), 'memory.swap.max': '0', 'cpu.max': '50000 100000', 'pids.max': '128',
    };
    // The same refusal construction the launch path uses.
    const refuse = (reason) => new HardwareLimitsError(buildDirectRefusal({
        key: 'ploinky_demo_worker',
        ref: 'demo/worker',
        refusalParts: {
            reasonCode: 'unprepared',
            reason: `This Box is not prepared for hardware limits: ${reason}.`,
            fix: 'On the host run ploinky limits status, repair the reported prerequisite, then ploinky restart.',
            requested: descriptor.hardwareRequest,
        },
        inputFingerprint: '0'.repeat(64),
    }));
    const run = (fake, pid = 321) => verifyLaunchedHardwareLimits({
        descriptor, containerId: 'f'.repeat(64), fsApi: fake, refuse,
        query: () => ({ ok: true, stdout: `${pid}\n` }),
    });
    assert.equal(run(launchedFixture(exact)).verified, true);
    for (const [name, value] of [['memory.max', 'max'], ['memory.swap.max', 'max'], ['cpu.max', 'max 100000'], ['pids.max', '4096']]) {
        assert.throws(() => run(launchedFixture({ ...exact, [name]: value })), (error) => {
            assert.equal(findHardwareOutcome(error)?.code, HARDWARE_UNENFORCEABLE);
            assert.match(error.message, new RegExp(name.replace('.', '\\.')));
            return true;
        }, name);
    }
    // A process outside /ploinky/agents (inspect success alone is not proof).
    assert.throws(() => run(launchedFixture(exact), 654), /not under \/ploinky\/agents/);
    assert.throws(() => run(launchedFixture(exact), 999), /could not be observed/);
    // A disagreement removes the candidate through the existing exact cleanup.
    const manager = source('cli/sandbox/docker/agentServiceManager.js');
    const verify = manager.indexOf('verifyLaunchedHardwareLimits({');
    const cleanup = manager.indexOf('removeExactGenerationCandidate({', verify);
    assert.ok(verify > 0 && cleanup > verify);
    assert.ok(manager.slice(verify, cleanup).includes('} catch (error) {'));
});

test('D.precreate-change', (t) => {
    const box = inBox(t);
    const admission = admit(box, LIMITED);
    assert.doesNotThrow(() => assertHardwareAdmissionCurrent(admission, { hardwareContext: prepared() }));
    inputChanged(() => assertHardwareAdmissionCurrent(admission, { hardwareContext: prepared(new Map(), { controllers: ['cpu', 'pids'] }) }));
    inputChanged(() => assertHardwareAdmissionCurrent(admission, { hardwareContext: prepared(new Map([['demo/worker', { cpus: '0.25' }]])) }));
    inputChanged(() => assertHardwareAdmissionCurrent(admission, { hardwareContext: prepared(new Map(), { backendReady: false }) }));
    // The recheck sits immediately before the create spawn.
    const manager = source('cli/sandbox/docker/agentServiceManager.js');
    const check = manager.indexOf('assertHardwareAdmissionCurrent(runtimeAdmission);');
    const create = manager.indexOf('const res = spawnSync(runtime, createArgs', check);
    assert.ok(check > 0 && create > check);
    assert.equal(manager.slice(check, create).includes('spawnSync('), false);
});

test('D.prepublish-change', (t) => {
    const box = inBox(t);
    const admission = admit(box, LIMITED);
    inputChanged(() => assertHardwareAdmissionCurrent(admission, { hardwareContext: { gate: 'off', storeState: 'none' } }));
    inputChanged(() => assertHardwareAdmissionCurrent(admission, { hardwareContext: prepared(new Map(), { storeState: 'unreadable' }) }));
    // A second recheck follows the launched-limit readback and precedes the
    // candidate's return for route publication (failures reach exact cleanup).
    const manager = source('cli/sandbox/docker/agentServiceManager.js');
    const verify = manager.indexOf('verifyLaunchedHardwareLimits({');
    const recheck = manager.indexOf('assertHardwareAdmissionCurrent(runtimeAdmission);', verify);
    const cleanup = manager.indexOf('} catch (error) {', verify);
    assert.ok(verify > 0 && recheck > verify && cleanup > recheck);
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
    const llm = resolveLlmRuntimeAdmissionContext({ runtime: 'podman', manifest, profileConfig: null, agentName: 'llm', env });
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
    // Both reuse callers pass the admitted policy and the creation's resolved selection/hardware.
    const manager = source('cli/sandbox/docker/agentServiceManager.js');
    assert.match(manager, /resolvedSelection: serviceLlmAdmissionContext\.startup\?\.selection,\s+resolvedHardware: serviceLlmAdmissionContext\.startup\?\.hardware,\s+admittedRuntimePolicy: serviceAdmission\.descriptor\.runtimePolicy/);
    const util = source('cli/commands/workspaceUtil.js');
    assert.match(util, /admittedRuntimePolicy: admittedDescriptor\.runtimePolicy/);
    assert.match(util, /resolvedSelection: admitted\.llmStartup\.selection,\s+resolvedHardware: admitted\.llmStartup\.hardware/);
});

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
