import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    LEGACY_GUARD_DECISIONS,
    LEGACY_GUARD_ERROR_CODES,
    LEGACY_PROC_UNMASK_LABEL,
    NATIVE_GUARD_RUNTIMES,
    OWNED_AGENT_LABELS,
    RECOGNIZED_RUN_MODES,
    evaluateInterimLegacyMarkers,
    evaluateLegacyAgentAdoption,
    normalizeAgentSecurityEvidence,
    parseSecurityOption,
} from '../../cli/sandbox/legacyAgentAdoptionGuard.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/executionTarget/legacy-inspect-v1.json', import.meta.url), 'utf8'));

const clone = (value) => structuredClone(value);
const DECISION_KEYS = Object.freeze({
    'not-applicable': ['decision'],
    foreign: ['containerId', 'decision'],
    allow: ['containerId', 'decision', 'evidenceDigest'],
    refuse: ['code', 'containerId', 'decision', 'reason'],
    'interim-clear': ['containerId', 'decision'],
});
const DIRECTIVE = /recreate|remediat|cleanup|clean-up|stop|remove|delete|replace|restart|drift/i;

function deepFreeze(value) {
    if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) deepFreeze(value[key]);
        Object.freeze(value);
    }
    return value;
}

// Every decision has exactly its §11 key set and no lifecycle directive.
function assertDecision(decision, expected) {
    assert.equal(Object.isFrozen(decision), true);
    assert.equal(decision.decision, expected);
    assert.deepEqual(Object.keys(decision).sort(), DECISION_KEYS[expected]);
    for (const [key, value] of Object.entries(decision)) {
        assert.doesNotMatch(key, DIRECTIVE);
        if (key !== 'reason' && typeof value === 'string') assert.doesNotMatch(value, DIRECTIVE);
    }
    if (decision.reason) assert.doesNotMatch(decision.reason, DIRECTIVE);
    return decision;
}

function input(runtime, record, overrides = {}) {
    return {
        runtime,
        runMode: 'global',
        ownership: 'owned',
        record,
        expectedIdentity: clone(FIXTURE.expectedIdentity),
        baseline: clone(FIXTURE.baselines[runtime] || FIXTURE.baselines.docker),
        evidence: clone(FIXTURE.adapters[runtime] || FIXTURE.adapters.docker),
        ...overrides,
    };
}

const docker = () => clone(FIXTURE.records.dockerComplete);
const podman = () => clone(FIXTURE.records.podmanComplete);
const refusal = (decision, code) => {
    assertDecision(decision, 'refuse');
    assert.equal(decision.code, code);
    return decision;
};

test('the guard ownership labels equal the network identity labels', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'cli/sandbox/networkIdentity.js'), 'utf8');
    for (const [key, value] of Object.entries(OWNED_AGENT_LABELS)) {
        assert.match(source, new RegExp(`\\b${key}: '${value.replaceAll('.', '\\.')}'`), key);
    }
    for (const enumeration of [LEGACY_GUARD_ERROR_CODES, LEGACY_GUARD_DECISIONS]) assert.equal(Object.isFrozen(enumeration), true);
});

test('LEG-06 complete ordinary Docker and Podman records are allowed, without implying target qualification', () => {
    for (const [runtime, record] of [['docker', docker()], ['podman', podman()]]) {
        const frozen = deepFreeze(clone(record));
        const decision = assertDecision(evaluateLegacyAgentAdoption(input(runtime, frozen)), 'allow');
        assert.equal(decision.containerId, record.Id);
        assert.match(decision.evidenceDigest, /^[0-9a-f]{64}$/);
        assert.deepEqual(frozen, record, 'pure: the input record is unchanged');
        // Deterministic and bound to the evidence.
        assert.equal(evaluateLegacyAgentAdoption(input(runtime, clone(record))).evidenceDigest, decision.evidenceDigest);
    }
    // More restrictive protection is acceptable to this guard: a read-only path that is masked instead.
    const stricter = docker();
    stricter.HostConfig.ReadonlyPaths = stricter.HostConfig.ReadonlyPaths.filter((item) => item !== '/proc/bus');
    stricter.HostConfig.MaskedPaths.push('/proc/bus');
    assertDecision(evaluateLegacyAgentAdoption(input('docker', stricter)), 'allow');
});

test('LEG-01 a legacy procunmask label refuses regardless of value or label view', () => {
    for (const value of ['', 'false', '0', '1', 'true', 'stale-v0']) {
        for (const view of ['Config.Labels', 'Labels', 'labels']) {
            const record = docker();
            if (view === 'Config.Labels') record.Config.Labels[LEGACY_PROC_UNMASK_LABEL] = value;
            else record[view] = { ...record.Config.Labels, [LEGACY_PROC_UNMASK_LABEL]: value };
            if (view !== 'Config.Labels') record.Config.Labels[LEGACY_PROC_UNMASK_LABEL] = value;
            refusal(evaluateLegacyAgentAdoption(input('docker', record)), 'legacy_proc_unmask');
            refusal(evaluateInterimLegacyMarkers(record), 'legacy_proc_unmask');
        }
    }
    // Present only in a secondary view: the interim subset still refuses; the full guard refuses as inconsistent.
    const secondary = docker();
    secondary.Labels = { ...secondary.Config.Labels, [LEGACY_PROC_UNMASK_LABEL]: 'x' };
    refusal(evaluateInterimLegacyMarkers(secondary), 'legacy_proc_unmask');
    refusal(evaluateLegacyAgentAdoption(input('docker', secondary)), 'unverifiable_security_evidence');
});

test('LEG-02 any unmask or systempaths=unconfined option refuses with no label, both separators, any case', () => {
    const options = [
        'unmask=ALL', 'unmask=all', 'UNMASK=/proc/*', 'unmask=', 'unmask', 'unmask:ALL', 'Unmask:/proc/kcore',
        'systempaths=unconfined', 'systempaths:unconfined', 'SystemPaths=Unconfined', 'systempaths:UNCONFINED',
    ];
    for (const option of options) {
        for (const runtime of ['docker', 'podman']) {
            const record = runtime === 'docker' ? docker() : podman();
            record.HostConfig.SecurityOpt = ['no-new-privileges', option];
            refusal(evaluateLegacyAgentAdoption(input(runtime, record)), 'legacy_proc_unmask');
            refusal(evaluateInterimLegacyMarkers(record), 'legacy_proc_unmask');
        }
    }
    for (const option of ['seccomp=unconfined', 'label=disable', 'label:disable', 'no-new-privileges', 'systempaths=default']) {
        const record = docker();
        record.HostConfig.SecurityOpt = [option];
        assertDecision(evaluateLegacyAgentAdoption(input('docker', record)), 'allow');
        assertDecision(evaluateInterimLegacyMarkers(record), 'interim-clear');
    }
    assert.deepEqual(parseSecurityOption('seccomp={"a":"unmask:x"}'), { key: 'seccomp', value: '{"a":"unmask:x"}' });
    assert.equal(parseSecurityOption(''), null);
    assert.equal(parseSecurityOption(7), null);
});

test('LEG-03 Privileged:true refuses as privileged_agent', () => {
    for (const runtime of ['docker', 'podman']) {
        const record = runtime === 'docker' ? docker() : podman();
        record.HostConfig.Privileged = true;
        refusal(evaluateLegacyAgentAdoption(input(runtime, record)), 'privileged_agent');
        refusal(evaluateInterimLegacyMarkers(record), 'privileged_agent');
    }
});

test('LEG-04 a missing baseline mask or read-only path, or an overriding mount, is weakened_proc_policy', () => {
    const missingMask = docker();
    missingMask.HostConfig.MaskedPaths = missingMask.HostConfig.MaskedPaths.filter((item) => item !== '/proc/kcore');
    refusal(evaluateLegacyAgentAdoption(input('docker', missingMask)), 'weakened_proc_policy');
    const missingReadonly = docker();
    missingReadonly.HostConfig.ReadonlyPaths = missingReadonly.HostConfig.ReadonlyPaths.filter((item) => item !== '/proc/sys');
    refusal(evaluateLegacyAgentAdoption(input('docker', missingReadonly)), 'weakened_proc_policy');
    const emptied = docker();
    emptied.HostConfig.MaskedPaths = [];
    emptied.HostConfig.ReadonlyPaths = [];
    refusal(evaluateLegacyAgentAdoption(input('docker', emptied)), 'weakened_proc_policy');
    for (const mount of [
        { Destination: '/proc', RW: false },
        { Destination: '/proc/kcore', RW: false },
        { Destination: '/sys', RW: true },
        { Destination: '/proc/sys/kernel', RW: true },
        { Destination: '/', RW: false },
    ]) {
        const record = docker();
        record.Mounts.push({ Type: 'bind', Source: '/host', ...mount });
        refusal(evaluateLegacyAgentAdoption(input('docker', record)), 'weakened_proc_policy');
    }
    // A read-only mount below a read-only path is not weaker.
    const readOnlyBelow = docker();
    readOnlyBelow.Mounts.push({ Type: 'bind', Source: '/host', Destination: '/proc/sys/fs', RW: false });
    assertDecision(evaluateLegacyAgentAdoption(input('docker', readOnlyBelow)), 'allow');
    // Weakening seen through the exact-instance OCI observation on Podman.
    const evidence = clone(FIXTURE.adapters.podman);
    evidence.oci.maskedPaths = evidence.oci.maskedPaths.filter((item) => item !== '/sys/firmware');
    refusal(evaluateLegacyAgentAdoption(input('podman', podman(), { evidence })), 'weakened_proc_policy');
    // The interim subset does not judge mask completeness (G-L), so it stays clear.
    assertDecision(evaluateInterimLegacyMarkers(emptied), 'interim-clear');
});

test('LEG-05 missing, contradictory, stale or foreign-bound evidence is unverifiable, never a false or empty value', () => {
    const cases = {
        'privileged absent': (record) => { delete record.HostConfig.Privileged; },
        'privileged null': (record) => { record.HostConfig.Privileged = null; },
        'privileged string': (record) => { record.HostConfig.Privileged = 'false'; },
        'security options absent': (record) => { delete record.HostConfig.SecurityOpt; },
        'security option malformed': (record) => { record.HostConfig.SecurityOpt = [7]; },
        'security option empty string': (record) => { record.HostConfig.SecurityOpt = ['']; },
        'security options not a list': (record) => { record.HostConfig.SecurityOpt = 'unmask=ALL'; },
        'masked paths absent': (record) => { delete record.HostConfig.MaskedPaths; },
        'masked paths null': (record) => { record.HostConfig.MaskedPaths = null; },
        'read-only paths malformed': (record) => { record.HostConfig.ReadonlyPaths = [null]; },
        'mounts absent': (record) => { delete record.Mounts; },
        'mount malformed': (record) => { record.Mounts = [{ Destination: '/code' }]; },
        'label views disagree': (record) => { record.Labels = { ...record.Config.Labels, extra: 'x' }; },
        'label view not a string map': (record) => { record.Config.Labels['io.assistos.ploinky.instance-id'] = 7; },
        'host config not an object': (record) => { record.HostConfig = 'x'; },
        'container id missing': (record) => { delete record.Id; },
        'container id contradictory': (record) => { record.ID = 'e'.repeat(64); },
        'container id not canonical': (record) => { record.Id = record.Id.toUpperCase(); },
        'instance label of another instance': (record) => { record.Config.Labels['io.assistos.ploinky.instance-id'] = 'instance-old'; },
        'enable generation of another generation': (record) => { record.Config.Labels['io.assistos.ploinky.enable-generation'] = 'enable-old'; },
    };
    for (const [label, mutate] of Object.entries(cases)) {
        const record = docker();
        mutate(record);
        const decision = evaluateLegacyAgentAdoption(input('docker', record));
        assert.equal(decision.code, 'unverifiable_security_evidence', label);
        assertDecision(decision, 'refuse');
    }
    const docker2 = docker();
    const overrides = {
        'adapter without null semantics': { evidence: { ...clone(FIXTURE.adapters.docker), nullMeansEmpty: {} } },
        'adapter for another runtime version': { evidence: { ...clone(FIXTURE.adapters.docker), runtimeVersion: 'synthetic-docker-2' } },
        'baseline for another configuration': { baseline: { ...clone(FIXTURE.baselines.docker), configIdentity: 'config-other' } },
        'baseline of another runtime family': { baseline: clone(FIXTURE.baselines.podman) },
        'expected container differs': { expectedIdentity: { ...clone(FIXTURE.expectedIdentity), containerId: 'f'.repeat(64) } },
        'expected configuration differs': { expectedIdentity: { ...clone(FIXTURE.expectedIdentity), configIdentity: 'config-other' } },
        'no baseline': { baseline: undefined },
        'unknown ownership classification': { ownership: 'maybe' },
    };
    for (const [label, override] of Object.entries(overrides)) {
        const decision = evaluateLegacyAgentAdoption(input('docker', clone(docker2), override));
        assert.equal(decision.code, 'unverifiable_security_evidence', label);
    }
    const podmanCases = {
        'OCI observation of another container': (evidence) => { evidence.oci.containerId = 'e'.repeat(64); },
        'OCI observation of another configuration': (evidence) => { evidence.oci.configIdentity = 'config-old'; },
        'OCI observation missing': (evidence) => { evidence.oci = null; },
        'OCI observation contradicts inspect mounts': (evidence) => { evidence.oci.mounts = [{ destination: '/code', readOnly: true }]; },
        'OCI observation malformed': (evidence) => { evidence.oci = 'x'; },
    };
    for (const [label, mutate] of Object.entries(podmanCases)) {
        const evidence = clone(FIXTURE.adapters.podman);
        mutate(evidence);
        assert.equal(evaluateLegacyAgentAdoption(input('podman', podman(), { evidence })).code, 'unverifiable_security_evidence', label);
    }
    // A contradiction between an explicit inspect array and the OCI observation.
    const explicit = podman();
    explicit.HostConfig.MaskedPaths = ['/proc/kcore'];
    assert.equal(evaluateLegacyAgentAdoption(input('podman', explicit)).code, 'unverifiable_security_evidence');
    // An old network-only fixture lacks proc arrays: unverifiable, not evidence of unmasking.
    const historical = clone(FIXTURE.records.historicalNetworkOnly);
    refusal(evaluateLegacyAgentAdoption(input('podman', historical, { evidence: { ...clone(FIXTURE.adapters.podman), oci: null } })), 'unverifiable_security_evidence');
    assertDecision(evaluateInterimLegacyMarkers(historical), 'interim-clear');
});

test('normalization is tri-state: null is known-empty only where the adapter establishes it', () => {
    const record = docker();
    const known = normalizeAgentSecurityEvidence({ runtime: 'docker', record, evidence: FIXTURE.adapters.docker });
    assert.deepEqual(known.securityOpt, { state: 'known-empty', value: [] });
    const unknown = normalizeAgentSecurityEvidence({ runtime: 'docker', record, evidence: { ...FIXTURE.adapters.docker, nullMeansEmpty: {} } });
    assert.deepEqual(unknown.securityOpt, { state: 'unknown', value: null });
    delete record.HostConfig.Privileged;
    assert.deepEqual(normalizeAgentSecurityEvidence({ runtime: 'docker', record, evidence: FIXTURE.adapters.docker }).privileged, { state: 'unknown', value: null });
    delete record.HostConfig.MaskedPaths;
    assert.equal(normalizeAgentSecurityEvidence({ runtime: 'docker', record, evidence: FIXTURE.adapters.docker }).maskedPaths.state, 'unknown');
    assert.equal(Object.isFrozen(known.labels.value), true);
});

test('LEG-07 explicit native bwrap/seatbelt runtimes and recognized non-global or non-agent cases are not-applicable to this OCI guard', () => {
    const native = clone(FIXTURE.records.bwrapNative);
    for (const runtime of ['bwrap', 'seatbelt']) {
        for (const runMode of RECOGNIZED_RUN_MODES) {
            assertDecision(evaluateLegacyAgentAdoption(input(runtime, native, { runMode, baseline: undefined, evidence: undefined })), 'not-applicable');
        }
    }
    for (const overrides of [{ runMode: 'isolated' }, { runMode: 'devel' }, { ownership: 'outer-box' }, { ownership: 'unrelated' }]) {
        // Even with a legacy label, the outer Box and unrelated containers are outside this guard.
        const record = docker();
        record.Config.Labels[LEGACY_PROC_UNMASK_LABEL] = '1';
        assertDecision(evaluateLegacyAgentAdoption(input('docker', record, overrides)), 'not-applicable');
    }
});

test('A5.4 an unrecognized or missing runtime or run mode fails closed as unverifiable_security_evidence', () => {
    for (const runtime of ['native', 'Docker', 'containerd', '', undefined, null, 7]) {
        const decision = refusal(evaluateLegacyAgentAdoption(input(runtime, docker())), 'unverifiable_security_evidence');
        assert.equal(decision.containerId, FIXTURE.records.dockerComplete.Id, String(runtime));
    }
    for (const runMode of ['embedded', 'local', 'GLOBAL', '', undefined, null]) {
        refusal(evaluateLegacyAgentAdoption(input('docker', docker(), { runMode })), 'unverifiable_security_evidence');
        refusal(evaluateLegacyAgentAdoption(input('bwrap', clone(FIXTURE.records.bwrapNative), { runMode })), 'unverifiable_security_evidence');
    }
    refusal(evaluateLegacyAgentAdoption({}), 'unverifiable_security_evidence');
    assert.deepEqual(Object.keys(evaluateLegacyAgentAdoption(input(undefined, null))).sort(), ['code', 'containerId', 'decision', 'reason']);
});

test('the guard run modes and native runtimes are the pinned Ploinky spellings', () => {
    const agents = fs.readFileSync(path.join(REPO_ROOT, 'cli/utils/agents.js'), 'utf8');
    const match = /export const ENABLE_AGENT_MODES = Object\.freeze\(\[([^\]]*)\]\)/.exec(agents);
    assert.ok(match);
    assert.deepEqual(match[1].split(',').map((item) => item.trim().replace(/^'|'$/g, '')), [...RECOGNIZED_RUN_MODES]);
    assert.deepEqual([...NATIVE_GUARD_RUNTIMES], ['bwrap', 'seatbelt']);
});

test('LEG-08 a foreign exact-name container is foreign and untouched', () => {
    const foreign = clone(FIXTURE.records.foreignExactName);
    const frozen = deepFreeze(clone(foreign));
    const decision = assertDecision(evaluateLegacyAgentAdoption(input('docker', frozen, { ownership: 'foreign' })), 'foreign');
    assert.equal(decision.containerId, foreign.Id);
    // Claimed owned but labelled for another workspace: still foreign.
    assertDecision(evaluateLegacyAgentAdoption(input('docker', frozen)), 'foreign');
    const otherWorkspace = docker();
    otherWorkspace.Config.Labels['io.assistos.ploinky.workspace'] = 'ffffffffffff';
    otherWorkspace.Config.Labels[LEGACY_PROC_UNMASK_LABEL] = '1';
    assertDecision(evaluateLegacyAgentAdoption(input('docker', otherWorkspace)), 'foreign');
    assert.deepEqual(frozen, foreign);
});

test('A1.1 interim subset: definite markers refuse, absent fields do not, malformed shapes are unverifiable', () => {
    for (const record of [docker(), podman(), clone(FIXTURE.records.historicalNetworkOnly)]) {
        assertDecision(evaluateInterimLegacyMarkers(record), 'interim-clear');
    }
    const absent = docker();
    delete absent.HostConfig.Privileged;
    delete absent.HostConfig.SecurityOpt;
    absent.Config.Labels = null;
    assertDecision(evaluateInterimLegacyMarkers(absent), 'interim-clear');
    const malformed = {
        'labels not a string map': (record) => { record.Config.Labels = { a: 1 }; },
        'labels a list': (record) => { record.Labels = ['a']; },
        'security options not a list': (record) => { record.HostConfig.SecurityOpt = 'unmask=ALL'; },
        'security option not a string': (record) => { record.HostConfig.SecurityOpt = [{ unmask: 'ALL' }]; },
        'privileged not boolean': (record) => { record.HostConfig.Privileged = 'true'; },
        'privileged null': (record) => { record.HostConfig.Privileged = null; },
        'host config not an object': (record) => { record.HostConfig = []; },
    };
    for (const [label, mutate] of Object.entries(malformed)) {
        const record = docker();
        mutate(record);
        const decision = refusal(evaluateInterimLegacyMarkers(record), 'unverifiable_security_evidence');
        assert.match(decision.reason, /^interim /, label);
    }
    refusal(evaluateInterimLegacyMarkers(null), 'unverifiable_security_evidence');
    const marked = docker();
    marked.HostConfig.SecurityOpt = ['unmask=ALL'];
    const decision = refusal(evaluateInterimLegacyMarkers(marked), 'legacy_proc_unmask');
    assert.equal(decision.containerId, marked.Id);
    assert.match(decision.reason, /^interim definite-marker check: /);
    const noId = docker();
    delete noId.Id;
    noId.HostConfig.Privileged = true;
    assert.equal(refusal(evaluateInterimLegacyMarkers(noId), 'privileged_agent').containerId, null);
});

test('T1-09 every refusal and foreign decision carries no recreate, remediation, cleanup or stop directive', () => {
    const decisions = [];
    const variants = [
        (record) => { record.Config.Labels[LEGACY_PROC_UNMASK_LABEL] = '1'; },
        (record) => { record.HostConfig.SecurityOpt = ['unmask=ALL']; },
        (record) => { record.HostConfig.Privileged = true; },
        (record) => { record.HostConfig.MaskedPaths = []; },
        (record) => { delete record.HostConfig.Privileged; },
    ];
    for (const mutate of variants) {
        const record = docker();
        mutate(record);
        decisions.push(evaluateLegacyAgentAdoption(input('docker', record)));
        const interim = evaluateInterimLegacyMarkers(record);
        // Completeness gaps are not definite markers: the interim subset leaves them clear.
        if (interim.decision === 'interim-clear') assertDecision(interim, 'interim-clear');
        else decisions.push(interim);
    }
    decisions.push(evaluateLegacyAgentAdoption(input('docker', clone(FIXTURE.records.foreignExactName), { ownership: 'foreign' })));
    for (const decision of decisions) {
        assert.ok(['refuse', 'foreign'].includes(decision.decision));
        assertDecision(decision, decision.decision);
    }
    assert.deepEqual(new Set(decisions.filter((item) => item.code).map((item) => item.code)), new Set(Object.values(LEGACY_GUARD_ERROR_CODES)));
});
