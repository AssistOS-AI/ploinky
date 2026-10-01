import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';
import {
    admitManifestRuntimeCapabilities,
    hardwareRefusalOf,
    renderRuntimePolicyArgs,
    runtimeCapabilityDigest,
} from '../../cli/sandbox/runtimeCapabilities.js';
import { emitRunArgs } from '../../cli/sandbox/docker/containerRuntimePolicy.js';
import { HARDWARE_UNENFORCEABLE, formatHardwareOutcome } from '../../cli/sandbox/hardwareLimits/errors.mjs';
import { runContainerAuthorityProbe } from '../../cli/sandbox/routerAuthorityAttestation.js';

function inBox(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-admission-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const markerPath = path.join(root, 'ploinky-box');
    fs.writeFileSync(markerPath, BOX_MARKER_CONTENT);
    return { boxMarkerOptions: { markerPath }, workspaceRoot: root };
}

const PREPARED_ALL = Object.freeze({
    gate: 'on', prepared: true, backendReady: true, controllers: ['cpu', 'memory', 'pids'], storeState: 'valid',
});

function memoryManifest(extra = {}) {
    return { container: 'node:20-alpine', llmRuntime: { runtimePolicy: { resources: { memory: '512m' } } }, ...extra };
}

function refusalOf(fn) {
    try {
        fn();
    } catch (error) {
        assert.equal(error.code, HARDWARE_UNENFORCEABLE, error.message);
        assert.equal(error.name, 'HardwareLimitsError');
        return error.hardwareOutcome;
    }
    assert.fail('expected a hardware refusal');
    return null;
}

test('A.manifest-memory', (t) => {
    const box = inBox(t);
    const outcome = refusalOf(() => admitManifestRuntimeCapabilities(memoryManifest(), {
        ...box, agentId: 'demo/worker', instanceKey: 'ploinky_demo_worker_ws', runtimeKind: 'container', runtime: 'podman',
    }));
    assert.equal(outcome.state, 'refused');
    assert.equal(outcome.reasonCode, 'gate_off');
    assert.equal(outcome.key, 'ploinky_demo_worker_ws');
    assert.equal(outcome.ref, 'demo/worker');
    assert.deepEqual(outcome.requested, [{ field: 'memory', value: '512m', source: 'manifest' }]);
    assert.match(formatHardwareOutcome(outcome),
        /^Refused \(hardware limits\): demo\/worker \[ploinky_demo_worker_ws\] requests memory 512m \(manifest\)\. Hardware limits are off for this workspace\. On the host run PLOINKY_BOX_HARDWARE_LIMITS=on ploinky restart, or remove the declared limit\.$/);
    // The same refusal is recorded, not thrown, by metadata admission.
    const metadata = admitManifestRuntimeCapabilities(memoryManifest(), {
        ...box, agentId: 'demo/worker', instanceKey: 'ploinky_demo_worker_ws', runtime: 'podman', hardwareAdmission: 'metadata',
    });
    assert.deepEqual(hardwareRefusalOf(metadata), outcome);
});

test('A.catalog-cpu', (t) => {
    const box = inBox(t);
    const outcome = refusalOf(() => admitManifestRuntimeCapabilities({ container: 'node:20-alpine' }, {
        ...box, agentId: 'demo/llm', runtime: 'podman', catalogPolicy: { resources: { cpus: '2' } },
    }));
    assert.deepEqual(outcome.requested, [{ field: 'cpus', value: '2', source: 'catalog' }]);
});

test('A.profile-pids', (t) => {
    const box = inBox(t);
    const manifest = {
        container: 'node:20-alpine',
        profiles: { dev: { llmRuntime: { runtimePolicy: { resources: { pidsLimit: 64 } } } } },
    };
    const outcome = refusalOf(() => admitManifestRuntimeCapabilities(manifest, {
        ...box, agentId: 'demo/pids', runtime: 'podman', profileName: 'dev', profileConfig: manifest.profiles.dev,
    }));
    assert.deepEqual(outcome.requested, [{ field: 'pidsLimit', value: '64', source: 'profile' }]);
    assert.match(formatHardwareOutcome(outcome), /requests pidsLimit 64 \(selected profile\)/);
});

for (const [title, llmRuntime] of [
    ['A.lite-enabled-absent', { runtimePolicy: { resources: { memory: '256m', cpus: '1.5' } } }],
    ['A.lite-enabled-false', { enabled: false, runtimePolicy: { resources: { memory: '256m', cpus: '1.5' } } }],
]) {
    test(title, () => {
        const manifest = { container: 'node:20-alpine', network: { mode: 'host' }, llmRuntime };
        const outcome = refusalOf(() => admitManifestRuntimeCapabilities(manifest, {
            agentId: 'demo/lite', runtimeKind: 'bwrap', insideBox: false, network: { mode: 'host' },
        }));
        assert.equal(outcome.reasonCode, 'lite_sandbox');
        assert.deepEqual(outcome.requested.map((entry) => entry.field), ['memory', 'cpus']);
        assert.match(outcome.reason, /^This runtime cannot apply memory, cpus\.$/);
        assert.match(outcome.fix, /disable the lite sandbox before starting the container runtime/);
    });
}

test('A.outside-box-unchanged', () => {
    const admission = admitManifestRuntimeCapabilities(memoryManifest(), {
        agentId: 'demo/worker', runtime: 'podman', insideBox: false,
    });
    assert.equal(admission.hardwareEligibility, undefined, 'outside a Box nothing hardware-specific is recorded');
    const args = renderRuntimePolicyArgs(admission.descriptor, { runtime: 'podman' });
    assert.deepEqual(args, emitRunArgs(admission.descriptor.runtimePolicy, { runtime: 'podman' }));
    assert.ok(args.includes('--memory') && args[args.indexOf('--memory') + 1] === '512m');
});

test('A.unlimited-unchanged', (t) => {
    const box = inBox(t);
    const manifest = { container: 'node:20-alpine' };
    const gateOff = admitManifestRuntimeCapabilities(manifest, { ...box, agentId: 'demo/plain', runtime: 'podman' });
    const outside = admitManifestRuntimeCapabilities(manifest, { agentId: 'demo/plain', runtime: 'podman', insideBox: false });
    assert.equal(Object.prototype.hasOwnProperty.call(gateOff.descriptor, 'hardwareRequest'), false);
    assert.equal(gateOff.hardwareEligibility.state, 'eligible');
    assert.equal(gateOff.hardwareEligibility.refusal, null);
    assert.deepEqual(
        renderRuntimePolicyArgs(gateOff.descriptor, { runtime: 'podman' }),
        renderRuntimePolicyArgs(outside.descriptor, { runtime: 'podman' }),
    );
    // The descriptor digest does not depend on the admission mode.
    const metadata = admitManifestRuntimeCapabilities(manifest, {
        ...box, agentId: 'demo/plain', runtime: 'podman', hardwareAdmission: 'metadata',
    });
    assert.equal(runtimeCapabilityDigest(metadata.descriptor), runtimeCapabilityDigest(gateOff.descriptor));
});

test('A.helper-exempt', (t) => {
    const box = inBox(t);
    const admission = admitManifestRuntimeCapabilities(memoryManifest(), {
        ...box, agentId: 'demo/helper', runtime: 'podman', helper: true,
    });
    assert.equal(admission.hardwareEligibility, undefined, 'helpers are never refused by hardware admission');
    // The authority helper keeps its complete recorded argv.
    const calls = [];
    const runner = {
        run(command, args) {
            calls.push(args);
            if (args[0] === 'image' && args.includes('{{.Id}}')) return { status: 0, stdout: `sha256:${'a'.repeat(64)}` };
            if (args[0] === 'image') return { status: 0, stdout: '1000:1000' };
            if (args[0] === 'ps') return { status: 0, stdout: '' };
            return { status: 1, stdout: '', stderr: 'stop here' };
        },
    };
    assert.throws(() => runContainerAuthorityProbe({
        runtime: 'podman',
        plan: { alias: 'demo', attachments: [{ name: 'net', primary: true }], args: ['--add-host', 'host.containers.internal:10.0.0.1'] },
        image: 'demo:latest',
        intent: { requestAuthority: 'demo:7000', publicAuthority: 'demo.example:8080', physicalOrigin: 'http://router' },
        nonce: 'b'.repeat(32),
        registerObservation() {},
        consumeObservation() {},
        commandRunner: runner,
    }));
    const create = calls.find((args) => args[0] === 'create');
    assert.ok(create, 'helper create was attempted');
    const at = create.indexOf('--pids-limit');
    assert.deepEqual(create.slice(at, at + 6), ['--pids-limit', '32', '--memory', '64m', '--cpus', '0.25']);
    assert.equal(create.some((arg) => String(arg).startsWith('--cgroup')), false);
});

test('A.d4-limited-refused', (t) => {
    const box = inBox(t);
    const manifest = memoryManifest({ containerSecurity: { nestedPodman: true }, network: { mode: 'host' } });
    const outcome = refusalOf(() => admitManifestRuntimeCapabilities(manifest, {
        ...box, agentId: 'demo/capable', runtime: 'podman', network: { mode: 'host' }, hardwareContext: PREPARED_ALL,
    }));
    assert.equal(outcome.reasonCode, 'host_network_nested_podman');
    assert.equal(outcome.reason, 'This release cannot enforce this hardware limit for host networking with nestedPodman.');
});

test('A.d4-unlimited-baseline', (t) => {
    const box = inBox(t);
    const manifest = { container: 'node:20-alpine', containerSecurity: { nestedPodman: true }, network: { mode: 'host' } };
    const prepared = admitManifestRuntimeCapabilities(manifest, {
        ...box, agentId: 'demo/capable', runtime: 'podman', network: { mode: 'host' }, hardwareContext: PREPARED_ALL,
    });
    const gateOff = admitManifestRuntimeCapabilities(manifest, {
        ...box, agentId: 'demo/capable', runtime: 'podman', network: { mode: 'host' },
    });
    assert.equal(prepared.hardwareEligibility.state, 'eligible');
    assert.deepEqual(
        renderRuntimePolicyArgs(prepared.descriptor, { runtime: 'podman' }),
        renderRuntimePolicyArgs(gateOff.descriptor, { runtime: 'podman' }),
        'an unlimited capable host-network instance keeps the baseline argv',
    );
    assert.equal(runtimeCapabilityDigest(prepared.descriptor), runtimeCapabilityDigest(gateOff.descriptor));
});

function storedContext(entry, envelope = { cpus: 4, memoryBytes: 8 * 1024 * 1024 * 1024 }) {
    return { ...PREPARED_ALL, overrides: new Map([['demo/worker', entry]]), envelope };
}

test('A.stored-gpu-refused', (t) => {
    const box = inBox(t);
    // U4 fail-closed: a stored GPU share (any source) cannot be enforced in P1.
    for (const entry of [{ gpu: { smPercent: 50, vramPercent: 50 } }, { cpus: 1, gpu: { smPercent: 25, vramPercent: 30 } }]) {
        const outcome = refusalOf(() => admitManifestRuntimeCapabilities({ container: 'node:20-alpine' }, {
            ...box, agentId: 'demo/worker', instanceKey: 'ploinky_demo_worker_ws', runtime: 'podman', hardwareContext: storedContext(entry),
        }));
        assert.equal(outcome.reasonCode, 'gpu_sharing_unavailable');
        assert.match(outcome.reason, /^GPU sharing is not available in this release, so the stored GPU share cannot be enforced\.$/);
        assert.match(outcome.fix, /ploinky limits clear --agent demo\/worker on the host/);
        assert.deepEqual(outcome.requested.map((requested) => [requested.field, requested.source]), [['gpu', 'settings']]);
        // Metadata admission records the same refusal; nothing is rendered.
        const metadata = admitManifestRuntimeCapabilities({ container: 'node:20-alpine' }, {
            ...box, agentId: 'demo/worker', instanceKey: 'ploinky_demo_worker_ws', runtime: 'podman', hardwareContext: storedContext(entry), hardwareAdmission: 'metadata',
        });
        assert.equal(hardwareRefusalOf(metadata).reasonCode, 'gpu_sharing_unavailable');
        assert.equal(metadata.descriptor.hardwarePlacement, undefined);
    }
});

test('A.stored-cpus-above-envelope-refused', (t) => {
    const box = inBox(t);
    const admit = (envelope, hardwareAdmission = 'strict') => admitManifestRuntimeCapabilities({ container: 'node:20-alpine' }, {
        ...box, agentId: 'demo/worker', instanceKey: 'ploinky_demo_worker_ws', runtime: 'podman',
        hardwareContext: storedContext({ cpus: 3.5 }, envelope), hardwareAdmission,
    });
    // Within the current envelope the stored quota is rendered.
    const within = admit({ cpus: 4, memoryBytes: 8 * 1024 ** 3 });
    assert.deepEqual(renderRuntimePolicyArgs(within.descriptor, { runtime: 'podman' }).slice(0, 2), ['--cpus', '3.5']);
    // The envelope shrinks below the stored value: refused with a fix, never rendered.
    for (const envelope of [{ cpus: 2, memoryBytes: 8 * 1024 ** 3 }, null]) {
        const outcome = refusalOf(() => admit(envelope));
        assert.equal(outcome.reasonCode, 'exceeds_envelope');
        assert.match(outcome.reason, envelope ? /cpus 3\.5 exceeds the Box CPU envelope of 2/ : /the Box CPU envelope is unknown/);
        assert.match(outcome.fix, /ploinky limits clear --agent demo\/worker on the host\.$/);
        assert.deepEqual(outcome.requested, [{ field: 'cpus', value: '3.5', source: 'settings' }]);
        assert.equal(admit(envelope, 'metadata').descriptor.hardwarePlacement, undefined);
    }
});
