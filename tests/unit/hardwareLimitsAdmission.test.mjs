import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';
import {
    admitManifestRuntimeCapabilities,
    assertHardwareAdmissionCurrent,
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
        assert.match(outcome.reason, /^This agent has no active, qualified Box GPU grant\.$/);
        assert.match(outcome.fix, /ploinky limits clear --agent demo\/worker on the host/);
        // Every stored field is listed with its stored value (K8).
        assert.deepEqual(outcome.requested.map((requested) => [requested.field, requested.source]),
            entry.cpus === undefined ? [['gpu', 'settings']] : [['cpus', 'settings'], ['gpu', 'settings']]);
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
    const envelope = { cpus: 2, memoryBytes: 8 * 1024 ** 3 };
    const outcome = refusalOf(() => admit(envelope));
    assert.equal(outcome.reasonCode, 'exceeds_envelope');
    assert.match(outcome.reason, /cpus 3\.5 exceeds the Box CPU envelope of 2/);
    assert.match(outcome.fix, /ploinky limits clear --agent demo\/worker on the host\.$/);
    assert.deepEqual(outcome.requested, [{ field: 'cpus', value: '3.5', source: 'settings' }]);
    assert.equal(admit(envelope, 'metadata').descriptor.hardwarePlacement, undefined);
});

test('A.stored-envelope-unknown', (t) => {
    // K8: an UNKNOWN envelope has its own reason code, never exceeds_envelope.
    const box = inBox(t);
    for (const [entry, field, value] of [[{ cpus: 3.5 }, 'cpus', '3.5'], [{ memoryPercent: 25 }, 'memory', '25%']]) {
        const outcome = refusalOf(() => admitManifestRuntimeCapabilities({ container: 'node:20-alpine' }, {
            ...box, agentId: 'demo/worker', instanceKey: 'ploinky_demo_worker_ws', runtime: 'podman',
            hardwareContext: storedContext(entry, null),
        }));
        assert.equal(outcome.reasonCode, 'envelope_unknown', field);
        assert.match(outcome.reason, /^The Box resource envelope is unknown, so the stored hardware limit cannot be resolved: the Box (CPU|memory) envelope is unknown\.$/, field);
        assert.match(outcome.fix, /^On the host run ploinky limits status, repair the reported prerequisite, then ploinky restart; or clear the stored limit/, field);
        assert.deepEqual(outcome.requested, [{ field, value, source: 'settings' }], field);
    }
});

test('A.stored-combined-lists-stored-values', (t) => {
    // K8: a combined cpus + GPU refusal lists the stored cpus, not the
    // manifest's declared value it overrides.
    const box = inBox(t);
    const outcome = refusalOf(() => admitManifestRuntimeCapabilities({
        container: 'node:20-alpine', llmRuntime: { runtimePolicy: { resources: { cpus: 0.5, memory: '512m' } } },
    }, {
        ...box, agentId: 'demo/worker', instanceKey: 'ploinky_demo_worker_ws', runtime: 'podman',
        hardwareContext: storedContext({ cpus: 2, gpu: { smPercent: 25, vramPercent: 30 } }),
    }));
    assert.equal(outcome.reasonCode, 'gpu_sharing_unavailable');
    assert.deepEqual(outcome.requested, [
        { field: 'memory', value: '512m', source: 'manifest' },
        { field: 'cpus', value: '2', source: 'settings' },
        { field: 'gpu', value: '25/30 percent', source: 'settings' },
    ]);
});

// --- A declared cpus value and the Box CPU envelope -------------------------
// A declared value is never admitted against an unknown envelope, and the
// agent's own envelope decision is part of its input fingerprint (so the
// Watchdog's re-arm and the launch-time currentness check see it), while no
// other agent's fingerprint carries the envelope.
const envelopeOf = (cpus) => (cpus === null ? undefined : { cpus, memoryBytes: 8 * 1024 ** 3 });
function declaredAdmission(box, { declare = { cpus: '4' }, envelope, mode = 'metadata', agentId = 'demo/cpu', context = {} } = {}) {
    const hardwareContext = { ...PREPARED_ALL, ...context, ...(envelope === undefined ? {} : { envelope }) };
    return admitManifestRuntimeCapabilities({ container: 'node:20-alpine', hardwareLimits: declare }, {
        ...box, agentId, instanceKey: `ploinky_${agentId.replace('/', '_')}_ws`, runtime: 'podman', hardwareAdmission: mode, hardwareContext,
    });
}
const fingerprintOf = (admission) => admission.hardwareEligibility.inputFingerprint;

test('A.declared-cpus-with-an-unknown-envelope-is-refused-as-envelope-unknown', (t) => {
    const box = inBox(t);
    const refused = declaredAdmission(box, { envelope: undefined });
    assert.equal(refused.hardwareEligibility.state, 'refused');
    const outcome = refusalOf(() => declaredAdmission(box, { envelope: undefined, mode: 'strict' }));
    assert.equal(outcome.reasonCode, 'envelope_unknown');
    assert.deepEqual(outcome.requested, [{ field: 'cpus', value: '4', source: 'manifest' }]);
    assert.match(outcome.reason, /^The Box CPU envelope is unknown, so the cpus value 4 declared in the manifest cannot be checked against it\.$/);
    assert.match(outcome.fix, /^On the host run ploinky limits status, repair the reported prerequisite, then ploinky restart; or remove the declared cpus limit in the manifest\.$/);
    // A value that cannot be quota-exact keeps its own refusal; a known envelope admits.
    assert.equal(declaredAdmission(box, { envelope: envelopeOf(8) }).hardwareEligibility.state, 'eligible');
    assert.equal(refusalOf(() => declaredAdmission(box, { declare: { cpus: '999999999.99' }, envelope: undefined, mode: 'strict' })).reasonCode, 'envelope_unknown');
    assert.equal(refusalOf(() => declaredAdmission(box, { declare: { cpus: '999999999.99' }, envelope: envelopeOf(8), mode: 'strict' })).reasonCode, 'exceeds_envelope');
    // Only a declared cpus value depends on the envelope.
    assert.equal(declaredAdmission(box, { declare: { memory: '512m' }, envelope: undefined }).hardwareEligibility.state, 'eligible');
    // An unprepared Box reports its own state, not the envelope.
    assert.equal(refusalOf(() => declaredAdmission(box, { envelope: undefined, mode: 'strict', context: { prepared: false, backendReady: false, unpreparedKind: 'placement' } })).reasonCode, 'unprepared');
});

test('A.declared-cpus-envelope-decision-is-part-of-that-agents-own-fingerprint', (t) => {
    const box = inBox(t);
    const cpu = (envelope) => fingerprintOf(declaredAdmission(box, { envelope }));
    const within = cpu(envelopeOf(8));
    const exceeds = cpu(envelopeOf(2));
    const unknown = cpu(undefined);
    assert.equal(new Set([within, exceeds, unknown]).size, 3, 'eligible, exceeds and unknown are three different decisions');
    // A change that does not cross the declared value changes nothing.
    assert.equal(cpu(envelopeOf(16)), within);
    assert.equal(cpu(envelopeOf(4)), within);
    // The refusal's fingerprint is the re-arm key: it differs from the one a grown Box produces.
    const refusal = refusalOf(() => declaredAdmission(box, { envelope: envelopeOf(2), mode: 'strict' }));
    assert.equal(refusal.reasonCode, 'exceeds_envelope');
    assert.equal(refusal.inputFingerprint, exceeds);
    assert.notEqual(refusal.inputFingerprint, within, 'a Box that grew past the declared value re-arms the refused agent');
    // No other agent's fingerprint carries the envelope.
    for (const declare of [{ memory: '512m' }, { pidsLimit: 64 }]) {
        const other = (envelope) => fingerprintOf(declaredAdmission(box, { declare, envelope, agentId: 'demo/other' }));
        assert.equal(other(envelopeOf(8)), other(envelopeOf(2)), JSON.stringify(declare));
        assert.equal(other(envelopeOf(8)), other(undefined), JSON.stringify(declare));
    }
    // Outside a prepared gate-on Box the envelope is not an input at all.
    const off = (envelope) => fingerprintOf(declaredAdmission(box, { envelope, context: { gate: 'off', prepared: false, backendReady: false } }));
    assert.equal(off(envelopeOf(8)), off(envelopeOf(2)));
});

test('A.an-envelope-change-across-a-declared-cpus-value-makes-the-admission-stale', (t) => {
    const box = inBox(t);
    const admitted = declaredAdmission(box, { envelope: envelopeOf(8), mode: 'strict' });
    const context = (cpus) => ({ ...PREPARED_ALL, ...(envelopeOf(cpus) ? { envelope: envelopeOf(cpus) } : {}) });
    // Crossing the declared value, in either direction, is stale before create or publication.
    for (const crossing of [2, null]) {
        assert.throws(() => assertHardwareAdmissionCurrent(admitted, { hardwareContext: context(crossing) }),
            { code: 'PLOINKY_RUNTIME_INPUT_CHANGED', message: /hardware-limit inputs changed after admission/ }, String(crossing));
    }
    // Moving within the decision keeps it current.
    assert.doesNotThrow(() => assertHardwareAdmissionCurrent(admitted, { hardwareContext: context(16) }));
    assert.doesNotThrow(() => assertHardwareAdmissionCurrent(admitted, { hardwareContext: context(8) }));
    // An agent that declares no cpus is never made stale by the envelope.
    const memory = declaredAdmission(box, { declare: { memory: '512m' }, envelope: envelopeOf(8), mode: 'strict', agentId: 'demo/other' });
    for (const crossing of [2, null]) assert.doesNotThrow(() => assertHardwareAdmissionCurrent(memory, { hardwareContext: context(crossing) }));
});
