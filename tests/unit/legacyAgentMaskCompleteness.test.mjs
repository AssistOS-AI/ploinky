import '../helpers/isolatedWorkspaceRoot.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    assertLegacyAgentConfinement, assertInterimLifecycleMutation, inspectInterimAgentLifecycle,
    FULL_MASK_COMPLETENESS_ACTIVE,
} from '../../cli/sandbox/legacyAgentLifecycleGuard.mjs';
import { normalizeAgentSecurityEvidence } from '../../cli/sandbox/legacyAgentAdoptionGuard.mjs';
import {
    collectPodmanOciEvidence, readBoundedFile, readPodmanVersions, REVIEWED_LEGACY_BASELINES,
    MAX_OCI_SPEC_BYTES,
} from '../../cli/sandbox/legacyAgentRuntimeEvidence.mjs';
import { GL_FIXTURES, GL_PLATFORMS, glObservation, glCollectorDeps } from './helpers/legacyGlObservations.mjs';
import { lifecycleHarness, syntheticConfinementCollector } from './helpers/legacyAgentLifecycleHarness.mjs';

const CODE = 'PLOINKY_LEGACY_AGENT_REFUSED';
const UNVERIFIABLE = 'unverifiable_security_evidence';
const WEAKENED = 'weakened_proc_policy';
const LABEL = 'io.assistos.ploinky';

// Run the combined guard against one G-L platform with optional mutations of
// the inspect record, the OCI spec, the `podman info` answer and the
// collector dependencies. Nothing touches an engine or a real spec file.
function confine(platform, { inspect, spec, info, deps, registry, args, active = true } = {}) {
    const observed = glObservation(platform);
    inspect?.(observed.inspect); spec?.(observed.spec); info?.(observed.info);
    const record = observed.inspect;
    const labels = record.Config.Labels;
    const registryRecord = { instanceId: labels[`${LABEL}.instance-id`], enableGeneration: labels[`${LABEL}.enable-generation`],
        ...registry };
    const collectorDeps = glCollectorDeps(observed, typeof deps === 'function' ? deps(observed) : deps);
    return assertLegacyAgentConfinement({ runtime: 'podman', runMode: 'global', containerName: 'agent',
        containerId: GL_FIXTURES[platform].inspect.Id, record, registryRecord, ...args }, {
        active, workspaceIdentity: () => ({ hash: labels[`${LABEL}.workspace`] }),
        collectEvidence: (input) => collectPodmanOciEvidence(input, collectorDeps),
    });
}

function refused(call, code) {
    assert.throws(call, (error) => {
        assert.equal(error.code, CODE);
        assert.equal(error.result.decision, 'refuse');
        assert.equal(error.result.code, code);
        // Diagnostics never carry engine or spec data.
        assert.doesNotMatch(error.message, /overlay-containers|thermal_throttle|\/proc\/|SECRET/);
        assert.deepEqual(Object.keys(error.result).sort(), ['code', 'containerId', 'decision', 'reason']);
        return true;
    });
}

const addMount = (destination, { rw = true, type = 'bind' } = {}) => ({
    inspect: (i) => i.Mounts.push({ Type: type, Destination: destination, RW: rw }),
    spec: (s) => s.mounts.push({ destination, type, options: ['rbind', rw ? 'rw' : 'ro'] }),
});
const both = (...parts) => ({
    inspect: (i) => parts.forEach((p) => p.inspect?.(i)),
    spec: (s) => parts.forEach((p) => p.spec?.(s)),
});

test('baseline is a reviewed subset of both observed platforms and its digest is a 64-hex profile digest', () => {
    const [baseline] = REVIEWED_LEGACY_BASELINES;
    assert.equal(REVIEWED_LEGACY_BASELINES.length, 1);
    assert.equal(baseline.runtimeFamily, 'podman');
    assert.equal(baseline.runtimeVersion, 'podman 5.8.2; crun 1.27.1');
    assert.match(baseline.profileDigest, /^[0-9a-f]{64}$/);
    assert.equal(baseline.maskedPaths.length, 12);
    const [darwin, amd64] = GL_PLATFORMS.map((name) => GL_FIXTURES[name].spec.linux.maskedPaths);
    assert.deepEqual([...baseline.maskedPaths].sort(), darwin.filter((item, i) => darwin.indexOf(item) === i && amd64.includes(item)).sort());
    assert.ok(amd64.some((item) => item.endsWith('/thermal_throttle')) && !darwin.some((item) => item.endsWith('/thermal_throttle')));
    for (const name of GL_PLATFORMS) {
        for (const item of baseline.readonlyPaths) assert.ok(GL_FIXTURES[name].spec.linux.readonlyPaths.includes(item));
    }
});

// ------------------------------------------------------------------ LEG-06

for (const platform of GL_PLATFORMS) {
    test(`LEG-06: real ${platform} G-L observation is allowed; inspect omits the proc arrays`, () => {
        const { inspect } = GL_FIXTURES[platform];
        assert.equal(Object.hasOwn(inspect.HostConfig, 'MaskedPaths'), false);
        assert.equal(Object.hasOwn(inspect.HostConfig, 'ReadonlyPaths'), false);
        const result = confine(platform);
        assert.equal(result.decision, 'allow');
        assert.equal(result.containerId, inspect.Id);
        assert.match(result.evidenceDigest, /^[0-9a-f]{64}$/);
        assert.deepEqual(Object.keys(result).sort(), ['containerId', 'decision', 'evidenceDigest']);
    });
}

test('LEG-06: extra masked entries and a read-only path that is masked instead are acceptable', () => {
    assert.equal(confine('linuxAmd64').decision, 'allow');
    const result = confine('darwinArm64', { spec: (s) => {
        s.linux.readonlyPaths = s.linux.readonlyPaths.filter((item) => item !== '/proc/irq');
        s.linux.maskedPaths.push('/proc/irq', '/proc/extra');
    } });
    assert.equal(result.decision, 'allow');
});

test('LEG-06: a read-only user mount over a read-only baseline path is not an override', () => {
    assert.equal(confine('darwinArm64', addMount('/proc/sys', { rw: false })).decision, 'allow');
});

test('inspect omission is unknown, never known-empty', () => {
    const { inspect } = glObservation('darwinArm64');
    const facts = normalizeAgentSecurityEvidence({ runtime: 'podman', record: inspect, evidence: undefined });
    assert.equal(facts.maskedPaths.state, 'unknown');
    assert.equal(facts.readonlyPaths.state, 'unknown');
    // And a spec that does not state the arrays leaves them unknown: refusal, not allow.
    refused(() => confine('darwinArm64', { spec: (s) => { delete s.linux.maskedPaths; } }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { spec: (s) => { delete s.linux.readonlyPaths; } }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { spec: (s) => { s.linux.maskedPaths = null; } }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { spec: (s) => { s.linux.readonlyPaths = [7]; } }), UNVERIFIABLE);
});

// ------------------------------------------------------------------ LEG-04

for (const baselineMasked of REVIEWED_LEGACY_BASELINES[0].maskedPaths) {
    test(`LEG-04: missing masked baseline path ${baselineMasked} is weakened_proc_policy`, () => {
        for (const platform of GL_PLATFORMS) {
            refused(() => confine(platform, { spec: (s) => {
                s.linux.maskedPaths = s.linux.maskedPaths.filter((item) => item !== baselineMasked);
            } }), WEAKENED);
        }
    });
}

for (const baselineReadonly of REVIEWED_LEGACY_BASELINES[0].readonlyPaths) {
    test(`LEG-04: missing read-only baseline path ${baselineReadonly} is weakened_proc_policy`, () => {
        refused(() => confine('darwinArm64', { spec: (s) => {
            s.linux.readonlyPaths = s.linux.readonlyPaths.filter((item) => item !== baselineReadonly);
        } }), WEAKENED);
    });
}

test('LEG-04: empty known lists are weakened, not unknown', () => {
    refused(() => confine('darwinArm64', { spec: (s) => { s.linux.maskedPaths = [s.linux.maskedPaths[0]]; } }), WEAKENED);
    refused(() => confine('darwinArm64', { spec: (s) => { s.linux.readonlyPaths = []; } }), WEAKENED);
});

for (const [label, mount] of [
    ['a writable bind over a masked path', addMount('/proc/acpi')],
    ['a writable tmpfs over a masked path', addMount('/sys/firmware', { type: 'tmpfs' })],
    ['a writable bind over a read-only path', addMount('/proc/sys')],
    ['a bind over a path below a masked path', addMount('/proc/acpi/child')],
    ['a read-only bind over a masked path', addMount('/proc/kcore', { rw: false })],
    ['a bind over the root', addMount('/', { rw: false })],
]) {
    test(`LEG-04: ${label} is weakened_proc_policy`, () => {
        refused(() => confine('darwinArm64', mount), WEAKENED);
    });
}

test('LEG-04: a mount stacked on the engine proc or sys view cannot be classified and fails closed', () => {
    refused(() => confine('darwinArm64', addMount('/proc')), UNVERIFIABLE);
    refused(() => confine('darwinArm64', addMount('/sys')), UNVERIFIABLE);
});

// ------------------------------------------------------------------ LEG-05

test('LEG-05: a spec path whose ID is another instance is unverifiable', () => {
    const other = 'b'.repeat(64);
    refused(() => confine('darwinArm64', { inspect: (i) => { i.OCIConfigPath = i.OCIConfigPath.replace(i.Id, other); } }), UNVERIFIABLE);
});

for (const [label, change] of [
    ['missing OCIConfigPath', (i) => { delete i.OCIConfigPath; }],
    ['non-string OCIConfigPath', (i) => { i.OCIConfigPath = 7; }],
    ['relative path', (i) => { i.OCIConfigPath = 'overlay-containers/x/userdata/config.json'; }],
    ['dot-dot path', (i) => { i.OCIConfigPath = i.OCIConfigPath.replace('/tmp/', '/tmp/../tmp/'); }],
    ['wrong file name', (i) => { i.OCIConfigPath = i.OCIConfigPath.replace('config.json', 'other.json'); }],
    ['short ID segment', (i) => { i.OCIConfigPath = i.OCIConfigPath.replace(i.Id, i.Id.slice(0, 12)); }],
    ['OCIRuntime that differs from the engine', (i) => { i.OCIRuntime = 'runc'; }],
]) {
    test(`LEG-05: ${label} is unverifiable`, () => {
        refused(() => confine('darwinArm64', { inspect: change }), UNVERIFIABLE);
    });
}

for (const [label, deps] of [
    ['unreadable spec', { readFile: () => null }],
    ['throwing reader', { readFile: () => { throw new Error('SECRET'); } }],
    ['empty spec', { readFile: () => '' }],
    ['malformed JSON', { readFile: () => '{"linux":' }],
    ['array spec', { readFile: () => '[]' }],
    ['spec without linux', { readFile: () => JSON.stringify({ ociVersion: '1.2.1', mounts: [] }) }],
    ['spec without mounts', { readFile: () => JSON.stringify({ ociVersion: '1.2.1', linux: {} }) }],
    ['spec without ociVersion', { readFile: () => JSON.stringify({ linux: {}, mounts: [] }) }],
    ['unknown podman version', (o) => ({ readVersions: () => ({ podman: '5.9.0', ociRuntimeName: 'crun', ociRuntimeVersion: '1.27.1' }) })],
    ['unknown crun version', () => ({ readVersions: () => ({ podman: '5.8.2', ociRuntimeName: 'crun', ociRuntimeVersion: '1.28.0' }) })],
    ['unknown OCI runtime name', () => ({ readVersions: () => ({ podman: '5.8.2', ociRuntimeName: 'runc', ociRuntimeVersion: '1.27.1' }) })],
    ['unreadable version', { readVersions: () => null }],
    ['re-inspect that fails', { reinspect: () => { throw new Error('SECRET'); } }],
    ['re-inspect that finds nothing', { reinspect: () => null }],
]) {
    test(`LEG-05: ${label} is unverifiable`, () => {
        refused(() => confine('darwinArm64', { deps }), UNVERIFIABLE);
    });
}

test('LEG-05: a spec of another OCI version needs its own reviewed baseline', () => {
    refused(() => confine('darwinArm64', { spec: (s) => { s.ociVersion = '1.3.0'; } }), UNVERIFIABLE);
});

test('LEG-05: the instance must be the same after the spec was read', () => {
    refused(() => confine('darwinArm64', { deps: (o) => ({ reinspect: () => ({ ...o.inspect, Id: 'c'.repeat(64) }) }) }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { deps: (o) => ({ reinspect: () => ({ ...o.inspect,
        OCIConfigPath: o.inspect.OCIConfigPath.replace('/tmp/', '/var/tmp/') }) }) }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { deps: (o) => ({ reinspect: () => ({ ...o.inspect, OCIRuntime: 'runc' }) }) }), UNVERIFIABLE);
});

test('LEG-05: mount evidence that inspect and the spec disagree on is unverifiable', () => {
    refused(() => confine('darwinArm64', { spec: (s) => s.mounts.push({ destination: '/extra', type: 'bind', options: ['rbind'] }) }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { inspect: (i) => i.Mounts.push({ Type: 'bind', Destination: '/missing', RW: true }) }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { inspect: (i) => { i.Mounts[0].RW = !i.Mounts[0].RW; } }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { spec: (s) => s.mounts.push({ destination: '/Agent', type: 'bind', options: ['ro'] }) }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { spec: (s) => { s.mounts[0].options = ['ro', 'rw']; } }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { spec: (s) => { s.mounts.push(null); } }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { inspect: (i) => { i.Mounts = null; } }), UNVERIFIABLE);
    // An engine-created substrate mount of the wrong type is not the reviewed substrate.
    refused(() => confine('darwinArm64', { spec: (s) => { s.mounts.find((m) => m.destination === '/proc').type = 'bind'; } }), UNVERIFIABLE);
});

test('LEG-05: a spec that contradicts an explicit inspect array is unverifiable', () => {
    refused(() => confine('darwinArm64', { inspect: (i) => { i.HostConfig.MaskedPaths = ['/proc/acpi']; } }), UNVERIFIABLE);
    const observed = glObservation('darwinArm64');
    const result = confine('darwinArm64', { inspect: (i) => {
        i.HostConfig.MaskedPaths = observed.spec.linux.maskedPaths;
        i.HostConfig.ReadonlyPaths = observed.spec.linux.readonlyPaths;
    } });
    assert.equal(result.decision, 'allow');
});

test('LEG-05: Privileged and SecurityOpt must be proved, and other runtimes have no baseline', () => {
    refused(() => confine('darwinArm64', { inspect: (i) => { delete i.HostConfig.Privileged; } }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { inspect: (i) => { delete i.HostConfig.SecurityOpt; } }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { inspect: (i) => { i.HostConfig.SecurityOpt = null; } }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { args: { runtime: 'docker' } }), UNVERIFIABLE);
});

test('LEG-05: expected identity comes from the registry record and the workspace, not the instance labels', () => {
    refused(() => confine('darwinArm64', { registry: { instanceId: 'another-instance' } }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { registry: { enableGeneration: 'another-generation' } }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { registry: { instanceId: undefined } }), UNVERIFIABLE);
    refused(() => confine('darwinArm64', { args: { registryRecord: undefined } }), UNVERIFIABLE);
    assert.throws(() => assertLegacyAgentConfinement({ runtime: 'podman', runMode: 'global', containerName: 'agent',
        containerId: GL_FIXTURES.darwinArm64.inspect.Id, record: glObservation('darwinArm64').inspect,
        registryRecord: { instanceId: GL_FIXTURES.darwinArm64.inspect.Config.Labels[`${LABEL}.instance-id`],
            enableGeneration: GL_FIXTURES.darwinArm64.inspect.Config.Labels[`${LABEL}.enable-generation`] } },
    { active: true, workspaceIdentity: () => ({ hash: 'another-workspace' }),
        collectEvidence: (input) => collectPodmanOciEvidence(input, glCollectorDeps(glObservation('darwinArm64'))) }),
    (error) => error.code === CODE);
    // A collector that fails or throws is the typed refusal.
    for (const collectEvidence of [() => null, () => { throw new Error('SECRET'); }]) {
        const { inspect } = glObservation('darwinArm64');
        assert.throws(() => assertLegacyAgentConfinement({ runtime: 'podman', runMode: 'global', containerName: 'agent',
            containerId: inspect.Id, record: inspect, registryRecord: {} },
        { active: true, collectEvidence, workspaceIdentity: () => ({ hash: 'x' }) }),
        (error) => error.code === CODE && error.result.code === UNVERIFIABLE && !/SECRET/.test(error.message));
    }
});

// ------------------------------------------------------------------ order and applicability

test('interim markers refuse first, even when the OCI evidence would also be unverifiable', () => {
    const broken = { readFile: () => null };
    refused(() => confine('darwinArm64', { deps: broken, inspect: (i) => { i.Config.Labels['ploinky.procunmask'] = ''; } }), 'legacy_proc_unmask');
    refused(() => confine('darwinArm64', { deps: broken, inspect: (i) => { i.HostConfig.SecurityOpt = ['unmask=ALL']; } }), 'legacy_proc_unmask');
    refused(() => confine('darwinArm64', { deps: broken, inspect: (i) => { i.HostConfig.Privileged = true; } }), 'privileged_agent');
    // The marker is also refused when the OCI evidence is perfect.
    refused(() => confine('darwinArm64', { inspect: (i) => { i.Config.Labels['ploinky.procunmask'] = 'false'; } }), 'legacy_proc_unmask');
});

test('native runtimes and non-global modes stay not-applicable and never reach the collector', () => {
    const collectEvidence = () => assert.fail('collector reached');
    const { inspect } = glObservation('darwinArm64');
    for (const runtime of ['bwrap', 'seatbelt']) {
        assert.equal(assertLegacyAgentConfinement({ runtime, runMode: 'global', containerName: 'agent',
            containerId: inspect.Id, record: inspect }, { active: true, collectEvidence }).decision, 'not-applicable');
    }
    for (const runMode of [undefined, 'isolated', 'devel']) {
        assert.equal(assertLegacyAgentConfinement({ runtime: 'podman', runMode, containerName: 'agent',
            containerId: inspect.Id, record: inspect }, { active: true, collectEvidence }).decision, 'not-applicable');
    }
});

test('the activation constant is reviewed false, and while false the guard is the interim subset without engine access', () => {
    assert.equal(FULL_MASK_COMPLETENESS_ACTIVE, false);
    const { inspect } = glObservation('darwinArm64');
    delete inspect.OCIConfigPath;
    const result = assertLegacyAgentConfinement({ runtime: 'podman', runMode: 'global', containerName: 'agent',
        containerId: inspect.Id, record: inspect }, { collectEvidence: () => assert.fail('collector reached') });
    assert.equal(result.decision, 'interim-clear');
});

// ------------------------------------------------------------------ lifecycle wiring

test('lifecycle preflight and mutation revalidation run the full predicate at the same call sites', () => {
    const f = lifecycleHarness();
    const [name, registryRecord] = ['agent', f.registry.agent];
    const inspected = f.containers.get(registryRecord.containerId);
    inspected.HostConfig.Privileged = false;
    inspected.HostConfig.SecurityOpt = [];
    const dependencies = { ...f.dependencies, active: true, collectEvidence: syntheticConfinementCollector };
    const input = { containerName: name, registryRecord, runtime: 'podman' };
    assert.equal(inspectInterimAgentLifecycle(input, dependencies).state, 'exact');
    // Absent OCI evidence: refused at preflight and at mutation revalidation.
    const none = { ...dependencies, collectEvidence: () => null };
    assert.throws(() => inspectInterimAgentLifecycle(input, none), (e) => e.code === CODE && e.result.code === UNVERIFIABLE);
    const mutation = { record: registryRecord, inspected, containerId: registryRecord.containerId, containerName: name, runtime: 'podman' };
    assert.equal(assertInterimLifecycleMutation(mutation, { active: true, collectEvidence: syntheticConfinementCollector,
        workspaceIdentity: f.dependencies.workspaceIdentity }).decision, 'allow');
    assert.throws(() => assertInterimLifecycleMutation(mutation, { active: true, collectEvidence: () => null }),
        (e) => e.code === CODE && e.result.code === UNVERIFIABLE);
    // A registry record naming another instance is refused even with perfect evidence.
    assert.throws(() => assertInterimLifecycleMutation({ ...mutation, record: { ...registryRecord, instanceId: 'other' } },
        { active: true, collectEvidence: syntheticConfinementCollector, workspaceIdentity: f.dependencies.workspaceIdentity }),
    (e) => e.code === CODE && e.result.code === UNVERIFIABLE);
    // Not-active default leaves the interim behavior.
    assert.equal(assertInterimLifecycleMutation(mutation).decision, 'interim-clear');
});

// ------------------------------------------------------------------ adapter units

test('readBoundedFile reads a regular file within the bound and refuses links, directories and oversize files', (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-oci-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, '{"a":1}');
    assert.equal(readBoundedFile(file), '{"a":1}');
    fs.symlinkSync(file, path.join(root, 'link.json'));
    assert.equal(readBoundedFile(path.join(root, 'link.json')), null);
    assert.equal(readBoundedFile(root), null);
    assert.equal(readBoundedFile(path.join(root, 'missing.json')), null);
    fs.writeFileSync(path.join(root, 'big.json'), 'x'.repeat(MAX_OCI_SPEC_BYTES + 1));
    assert.equal(readBoundedFile(path.join(root, 'big.json')), null);
    assert.equal(readBoundedFile(file, 3), null);
});

test('readPodmanVersions parses only the reviewed scalars from one bounded info call', () => {
    const info = { version: { Version: '5.8.2' }, host: { ociRuntime: { name: 'crun', version: 'crun version 1.27.1\ncommit: abc' } } };
    const calls = [];
    const run = (command, args, options) => { calls.push({ command, args, options }); return { status: 0, stdout: JSON.stringify(info) }; };
    assert.deepEqual(readPodmanVersions('podman', { run }), { podman: '5.8.2', ociRuntimeName: 'crun', ociRuntimeVersion: '1.27.1' });
    assert.deepEqual(calls[0].args, ['info', '--format', 'json']);
    assert.ok(calls[0].options.timeout <= 10_000 && calls[0].options.maxBuffer <= 4 * 1024 * 1024);
    for (const bad of [
        { status: 1, stdout: '' }, { status: 0, stdout: 'x' }, { status: 0, stdout: '{}', error: new Error('x') },
        { status: 0, stdout: JSON.stringify({ ...info, version: { Version: '5.8' } }) },
        { status: 0, stdout: JSON.stringify({ ...info, host: { ociRuntime: { name: 'crun', version: 'runc version 1.27.1' } } }) },
        { status: 0, stdout: JSON.stringify({ ...info, host: { ociRuntime: { name: 'crun', version: 'crun version 1.27.1-rc1' } } }) },
        { status: 0, stdout: JSON.stringify({ ...info, host: { ociRuntime: { name: 'a/b', version: 'crun version 1.27.1' } } }) },
    ]) assert.equal(readPodmanVersions('podman', { run: () => bad }), null);
    assert.equal(readPodmanVersions('podman', { run: () => { throw new Error('x'); } }), null);
});
