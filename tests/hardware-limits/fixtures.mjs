// Test-only support for the hardware-limits verification runner: strict
// schemas, the required-case manifest, GPU idle-gate classification, owned
// short temporary directories and fail-safe cleanup ordering. Dependency-free
// Node ESM; nothing here opens an engine, SSH or network connection.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, BLOCKED: 2, SKIPPED: 3 });
export const DOCUMENT_SUFFIXES = Object.freeze(['claude', 'codex']);
const HEX128 = /^[0-9a-f]{32}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export class SchemaError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SchemaError';
        this.code = 'PLOINKY_HWL_SCHEMA_INVALID';
    }
}

function fail(label, message) {
    throw new SchemaError(`${label}: ${message}`);
}

function plainObject(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(label, 'expected object');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(label, 'expected plain object');
    return value;
}

function exactKeys(value, required, optional, label) {
    plainObject(value, label);
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) fail(label, `unknown key '${key}'`);
    }
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) fail(label, `missing key '${key}'`);
    }
}

function boundedString(value, label, max = 4095, { allowEmpty = false } = {}) {
    if (typeof value !== 'string') fail(label, 'expected string');
    if (!allowEmpty && !value) fail(label, 'must not be empty');
    if (Buffer.byteLength(value, 'utf8') > max) fail(label, `exceeds ${max} bytes`);
    return value;
}

function absolutePath(value, label) {
    boundedString(value, label, 4095);
    if (!path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0')) {
        fail(label, 'must be a normalized absolute path');
    }
    return value;
}

function nullable(value, check) {
    return value === null ? null : check(value);
}

function boundedArray(value, label, max) {
    if (!Array.isArray(value)) fail(label, 'expected array');
    if (value.length > max) fail(label, `exceeds ${max} entries`);
    return value;
}

function jsonBytes(value) {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function sha256Hex(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function randomRunId() {
    return crypto.randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// Configuration (schema 1, at most 128 KiB)

function validateRepoEntry(value, label, { candidateRequired = true } = {}) {
    exactKeys(value, [
        'baselineRevision', 'baselineExport', 'baselineStage', 'candidateRoot', 'sourceDigest', 'instructionDigests',
    ], [], label);
    if (!/^[0-9a-f]{40}$/.test(value.baselineRevision)) fail(`${label}.baselineRevision`, 'expected full hash');
    absolutePath(value.baselineExport, `${label}.baselineExport`);
    nullable(value.baselineStage, (v) => absolutePath(v, `${label}.baselineStage`));
    if (candidateRequired) absolutePath(value.candidateRoot, `${label}.candidateRoot`);
    else if (value.candidateRoot !== null) fail(`${label}.candidateRoot`, 'must be null for a read-only reference');
    if (!/^sha256:[0-9a-f]{64}$|^git-tree:[0-9a-f]{40}$/.test(value.sourceDigest)) {
        fail(`${label}.sourceDigest`, 'expected sha256 or git-tree digest');
    }
    plainObject(value.instructionDigests, `${label}.instructionDigests`);
    for (const [name, digest] of Object.entries(value.instructionDigests)) {
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) fail(`${label}.instructionDigests`, 'invalid name');
        if (!/^sha256:[0-9a-f]{64}$/.test(digest)) fail(`${label}.instructionDigests.${name}`, 'invalid digest');
    }
}

export function validateDependency(value, label = 'dependency') {
    exactKeys(value, ['name', 'realpath', 'revision', 'treeDigest'], [], label);
    if (!/^[A-Za-z0-9@._/-]{1,128}$/.test(value.name)) fail(`${label}.name`, 'invalid name');
    absolutePath(value.realpath, `${label}.realpath`);
    nullable(value.revision, (v) => {
        if (!/^[0-9a-f]{40}$/.test(v)) fail(`${label}.revision`, 'expected full hash or null');
        return v;
    });
    if (!/^sha256:[0-9a-f]{64}$|^git-tree:[0-9a-f]{40}$/.test(value.treeDigest)) {
        fail(`${label}.treeDigest`, 'expected digest');
    }
    return value;
}

export function validateConfig(value) {
    const label = 'config';
    if (jsonBytes(value) > 128 * 1024) fail(label, 'exceeds 128 KiB');
    exactKeys(value, [
        'schema', 'runId', 'createdAt', 'documentSuffix', 'node', 'repos', 'dependencies', 'evidenceRoot',
        'casesPath', 'casesDigest', 'engine', 'ssh',
    ], [], label);
    if (value.schema !== 1) fail(`${label}.schema`, 'unsupported schema');
    if (!HEX128.test(value.runId)) fail(`${label}.runId`, 'expected 128-bit hex');
    if (Number.isNaN(Date.parse(value.createdAt))) fail(`${label}.createdAt`, 'expected ISO time');
    if (!DOCUMENT_SUFFIXES.includes(value.documentSuffix)) fail(`${label}.documentSuffix`, 'expected claude or codex');
    exactKeys(value.node, ['absoluteExecutable', 'version'], [], `${label}.node`);
    absolutePath(value.node.absoluteExecutable, `${label}.node.absoluteExecutable`);
    boundedString(value.node.version, `${label}.node.version`, 64);
    exactKeys(value.repos, ['ploinky', 'explorer', 'localLlms', 'images'], [], `${label}.repos`);
    validateRepoEntry(value.repos.ploinky, `${label}.repos.ploinky`);
    validateRepoEntry(value.repos.explorer, `${label}.repos.explorer`);
    validateRepoEntry(value.repos.localLlms, `${label}.repos.localLlms`);
    validateRepoEntry(value.repos.images, `${label}.repos.images`, { candidateRequired: false });
    boundedArray(value.dependencies, `${label}.dependencies`, 32).forEach((entry, index) => {
        validateDependency(entry, `${label}.dependencies[${index}]`);
    });
    const names = value.dependencies.map((entry) => entry.name);
    if (new Set(names).size !== names.length) fail(`${label}.dependencies`, 'duplicate dependency name');
    absolutePath(value.evidenceRoot, `${label}.evidenceRoot`);
    absolutePath(value.casesPath, `${label}.casesPath`);
    if (!/^sha256:[0-9a-f]{64}$/.test(value.casesDigest)) fail(`${label}.casesDigest`, 'invalid digest');
    nullable(value.engine, (engine) => {
        exactKeys(engine, ['binary', 'kind', 'identity'], [], `${label}.engine`);
        absolutePath(engine.binary, `${label}.engine.binary`);
        if (!['podman'].includes(engine.kind)) fail(`${label}.engine.kind`, 'unsupported engine');
        boundedString(engine.identity, `${label}.engine.identity`, 1024);
        return engine;
    });
    nullable(value.ssh, (ssh) => {
        exactKeys(ssh, ['alias', 'argv', 'expectedHostKeyAlias', 'expectedAddress'], [], `${label}.ssh`);
        boundedString(ssh.alias, `${label}.ssh.alias`, 128);
        boundedArray(ssh.argv, `${label}.ssh.argv`, 64).forEach((arg, index) => boundedString(arg, `${label}.ssh.argv[${index}]`, 1024));
        boundedString(ssh.expectedHostKeyAlias, `${label}.ssh.expectedHostKeyAlias`, 255);
        boundedString(ssh.expectedAddress, `${label}.ssh.expectedAddress`, 255);
        return ssh;
    });
    const roots = [value.repos.ploinky, value.repos.explorer, value.repos.localLlms]
        .map((repo) => repo.candidateRoot);
    for (const root of roots) {
        if (root.startsWith(`${value.evidenceRoot}${path.sep}`) || root === value.evidenceRoot) {
            fail(label, 'candidate roots must be disjoint from the evidence root');
        }
    }
    return value;
}

// ---------------------------------------------------------------------------
// Required case manifest (at most 4096 entries and 1 MiB)

const P = 'ploinky';
const L = 'local-llms';
const X = 'explorer';

function leaves(repo, phase, file, names) {
    return names.map((name) => ({ id: name, phase, repo, file, name, kind: 'offline', requires: [], expected: 'pass' }));
}

export const T_FAULT_EFFECTS = Object.freeze([
    'snapshot', 'prepared-journal', 'barrier', 'inner-stop', 'outer-stop', 'old-remove', 'candidate-create',
    'cid-receipt', 'candidate-start', 'candidate-graph', 'reapply-stop', 'reapply-remove', 'reapply-create',
    'reapply-start', 'reapply-graph', 'rollback-create', 'rollback-prepare', 'rollback-graph',
    'desired-commit-intent', 'restored-commit-intent', 'desired-gate-write', 'restored-gate-write',
    'desired-gpu-record', 'restored-gpu-record', 'desired-router-record', 'restored-router-record',
    'barrier-remove', 'committed-receipt', 'rolledback-receipt',
]);
export const T_FAULT_SIDES = Object.freeze(['before', 'after']);
export const T_FAULT_KINDS = Object.freeze(['process-death', 'io-error']);
export const CONTROLLER_SUBSETS = Object.freeze([
    'none', 'cpu', 'memory', 'pids', 'cpu-memory', 'cpu-pids', 'memory-pids', 'cpu-memory-pids',
]);
export const S_VECTOR_ROWS = Object.freeze({
    cpu: 11,
    'ram-percent': 7,
    'ram-bytes': 3,
    'gpu-percent': 8,
    'gpu-bytes': 4,
    'declared-pids': 6,
    reference: 11,
    'store-size': 4,
    'http-size': 2,
    structure: 7,
    'private-paths': 6,
});
export const LL_RAM_PATHS = Object.freeze([
    'llama', 'ik-llama', 'lm-studio', 'ollama-auto', 'ollama-pinned', 'vllm', 'vllm-offload', 'tabby',
    'cpu-llama', 'cpu-ollama', 'unified-llama', 'unified-vllm',
]);
export const LL_RAM_VECTORS = Object.freeze([
    'zero', 'over-current', 'one-byte', 'reserve-minus-one', 'exact-reserve', 'reserve-plus-one',
    'missing-current', 'malformed-current', 'release-retry',
]);
// Path/vector pairs the baseline cannot dispatch are not generated (§18.3).
// Every listed path is dispatched by the baseline controller, so none is
// excluded; the set stays explicit so an exclusion is a reviewed edit.
export const LL_RAM_UNSUPPORTED = Object.freeze(new Set());

export function sVectorIds() {
    const ids = [];
    for (const [row, count] of Object.entries(S_VECTOR_ROWS)) {
        for (let index = 1; index <= count; index += 1) ids.push(`S.vector.${row}.${index}`);
    }
    return ids;
}

export function tFaultIds() {
    const ids = [];
    for (const effect of T_FAULT_EFFECTS) {
        for (const side of T_FAULT_SIDES) {
            for (const fault of T_FAULT_KINDS) ids.push(`T.fault.${effect}.${side}.${fault}`);
        }
    }
    return ids;
}

export function llRamIds() {
    const ids = [];
    for (const pathName of LL_RAM_PATHS) {
        for (const vector of LL_RAM_VECTORS) {
            const id = `LL-RAM.${pathName}.${vector}`;
            if (!LL_RAM_UNSUPPORTED.has(id)) ids.push(id);
        }
    }
    return ids;
}

export function buildRequiredCaseManifest() {
    const unit = (name) => `tests/unit/${name}`;
    const cases = [
        ...leaves(P, 's0', unit('hardwareLimitsVerification.test.mjs'), [
            'H.assertion-failure', 'H.import-failure', 'H.missing-file', 'H.signal', 'H.empty-stream',
            'H.truncated-stream', 'H.missing-required', 'H.required-skip', 'H.required-todo', 'H.removed-baseline',
            'H.complete-pass', 'H.cleanup-destroy-failure', 'H.cleanup-identity-failure',
            'H.cleanup-original-and-cleanup-errors', 'H.pid-12-34-not-123-934', 'H.pid-reuse', 'H.query-error',
            'H.malformed-pids', 'H.initial-busy', 'H.graphics-unknown-blocked', 'H.scratch-home', 'H.baseline-stage-hashes-without-stdin', 'H.baseline-stage-spawn-calls-never-use-stdin',
            'H.duplicate-leaf-title-under-two-parents', 'H.p3-explorer-sibling-is-the-configured-ploinky-candidate',
        ]),
        ...leaves(P, 's0', unit('hardwareLimitsFailureSignatures.test.mjs'), ['HS.proc-pid-normalization', 'HS.engine-spawn-guard-fails-a-suite-that-starts-an-engine']),
        ...leaves(P, 's0', unit('hardwareLimitsEngineGuard.test.mjs'), [
            'EG.shell-option-clusters-and-script-forms-are-refused', 'EG.wrapper-operands-are-analysed-as-invocations',
            'EG.absolute-guarded-paths-are-refused-wherever-they-appear', 'EG.option-forms-shell-string-and-fork-exec-path',
            'EG.login-shells-are-refused-outright', 'EG.environment-resets-and-explicit-environments-are-refused',
            'EG.a-fake-on-the-callers-path-grants-nothing-when-the-invocation-replaces-the-path',
            'EG.unlisted-wrappers-launchers-and-embedded-shells-are-analysed',
            'EG.the-seatbelt-and-bwrap-shapes-the-guard-analyses-are-the-production-shapes',
            'EG.system-binaries-are-not-refused-by-a-number-rounded-inode',
            'EG.a-node-child-is-guarded-through-the-inherited-environment-and-after-env-i',
            'EG.an-eval-worker-with-module-syntax-is-guarded',
            'EG.an-opted-in-login-shell-is-judged-by-name-alone',
            'EG.a-guarded-path-inside-a-longer-argument-is-not-a-command-for-an-unlisted-program',
            'EG.hidden-names-reach-the-path-stubs-through-every-environment-rewrite',
            'EG.descendants-and-worker-threads-are-guarded-through-an-explicit-environment',
            'EG.a-violating-child-killed-by-a-signal-still-fails-the-top-level-suite',
            'EG.a-bare-name-resolving-first-to-a-test-owned-fake-is-allowed', 'EG.the-top-level-removes-its-temporary-root-on-exit-and-on-sigterm',
            'EG.a-sigkilled-descendant-with-an-explicit-env-leaves-nothing-behind', 'EG.a-root-left-by-a-dead-owner-is-removed-by-the-next-top-level-guard',
        ]),
        ...leaves(P, 's0', unit('hardwareLimitsLiveHarness.test.mjs'), ['HLIVE.R16-inherited-pipe-grandchild-deadline']),
        ...leaves(P, 'p0', unit('hardwareLimitsAdmission.test.mjs'), [
            'A.manifest-memory', 'A.catalog-cpu', 'A.profile-pids', 'A.lite-enabled-absent', 'A.lite-enabled-false',
            'A.outside-box-unchanged', 'A.unlimited-unchanged', 'A.helper-exempt', 'A.d4-limited-refused',
            'A.d4-unlimited-baseline', 'A.stored-gpu-refused', 'A.stored-cpus-above-envelope-refused',
            'A.declared-cpus-with-an-unknown-envelope-is-refused-as-envelope-unknown',
            'A.declared-cpus-envelope-decision-is-part-of-that-agents-own-fingerprint',
            'A.an-envelope-change-across-a-declared-cpus-value-makes-the-admission-stale',
            'A.stored-envelope-unknown', 'A.stored-combined-lists-stored-values',
        ]),
        ...leaves(P, 'p0', unit('hardwareLimitsDeclaration.test.mjs'), [
            'HD.schema-manifest-and-profile-field', 'HD.unknown-key-refused', 'HD.gpu-key-refused',
            'HD.invalid-values-refused-like-resources',
            ...['manifest', 'profile'].flatMap((layer) => ['absent', 'false', 'true'].map((llm) => `HD.a0-${layer}-llm-${llm}`)),
            'HD.conflict-manifest-refused', 'HD.conflict-profile-refused', 'HD.equal-values-accepted-with-warning',
            'HD.deprecation-warning-once', 'HD.deprecation-warning-bounded', 'HD.stored-overrides-declared',
            'HD.profile-empty-default', 'HD.profile-partial-selected-override', 'HD.profile-old-default-neutral-selected',
            'HD.profile-neutral-default-old-selected', 'HD.profile-conflict-within-raw-profile',
            'HD.profile-other-llm-settings-unchanged', 'HD.parity-lite-sandbox', 'HD.parity-d4', 'HD.parity-gate-off',
            'HD.parity-unprepared-and-controller-missing', 'HD.parity-metadata-strict-and-launch', 'HD.parity-interactive',
            'HD.parity-graph-outcomes-and-blocked-dependants', 'HD.route-deprecated-declaration-note',
            'HD.interactive-caller-resolves-the-profile', 'HD.interactive-ensure-agent-container-resolves-the-profile', 'HD.long-requested-value-is-a-bounded-refusal',
            'HD.conflict-normalized-values-and-named-raw-layer', 'HD.deprecation-warning-sanitizes-the-agent-ref',
            'HD.unrepresentable-or-zero-limits-are-refused-on-every-path',
        ]),
        ...leaves(P, 'p0', unit('hardwareLimitsOutcomes.test.mjs'), [
            'O.prelock-preflight-refusal', 'O.locked-preflight-refusal', 'O.defensive-preflight-refusal',
            'O.batch-first-enable-refusal', 'O.digest-refusal-current', 'O.digest-input-change',
            'O.metadata-cannot-render', 'O.nonhardware-still-strict', 'O.blocking-diamond', 'O.blocking-transitive',
            'O.enabled-extra', 'O.alias-identity', 'O.optional-no-wait-parent-ready',
            'O.optional-eligibility-asynchronous', 'O.optional-child-blocking-grandchild',
            'O.explicit-status-wait-blocked', 'O.no-synthetic-optional-wait', 'O.cycle-wait-kind',
            'O.store-unknown-no-create', 'O.launch-refusal-blocks-dependants', 'O.launch-refusal-extra-contained',
            'O.launch-nonhardware-still-throws', 'O.service-preflight-refusal-contained', 'O.launch-refusal-ref-mapping',
            'O.launch-refusal-cleanup-failure-fails', 'O.managed-refusal-candidate-removed',
        ]),
        ...leaves(P, 'p0', unit('hardwareLimitsAvailability.test.mjs'), [
            'AV.http', 'AV.sse', 'AV.websocket', 'AV.mcp', 'AV.private-caller', 'AV.private-target',
            'AV.stale-generation', 'AV.logical-route-preserved', 'AV.unrelated-ready', 'AV.router-controls',
            'AV.explorer-optional-child-ready', 'AV.degraded-summary', 'AV.background-result-projection',
            'AV.individual-nonzero', 'AV.repair-closure',
        ]),
        ...leaves(P, 'p0', unit('noWaitWorker.test.mjs'), [
            'NW.refused-subtype', 'NW.blocked-subtype', 'NW.explicit-wait-cause', 'NW.optional-no-wait-contained',
        ]),
        ...leaves(P, 'p0', unit('noWaitAgentStartupState.test.mjs'), ['NW.bounded-invalid-status']),
        ...leaves(P, 'p0', unit('containerMonitorAdmission.test.mjs'), [
            'MON.refused-terminal', 'MON.blocked-terminal', 'MON.unchanged-no-retry', 'MON.repair-fingerprint',
        ]),
        ...leaves(P, 'p0', unit('containerMonitorRetryIdentity.test.mjs'), ['MON.unrelated-write-no-rearm', 'MON.a-failed-restart-releases-the-launching-mps-owner-of-its-result']),
        ...leaves(P, 'p0', unit('marketplaceEnableWorker.test.mjs'), [
            'E.cli-cause', 'E.marketplace-outbound', 'E.marketplace-inbound', 'E.bounded-secret-free',
            'E.max-ref-roundtrip', 'E.long-key-roundtrip',
        ]),
        ...leaves(P, 'p1', unit('ploinkyBoxHardwareLimitsGate.test.mjs'), [
            'G.parse', 'G.omitted-persists', 'G.invalid-no-mutation', 'G.u9-nonempty-no-mutation',
            'G.u9-corrupt-not-empty', 'G.generic-never-enabled-cli-creates-starts', 'G.generic-saved-off-absent-legacy',
            'G.generic-saved-on-inspect', 'G.generic-initialized-empty-inspect', 'G.generic-nonempty-inspect',
            'G.generic-unknown-refuses', 'G.off-byte-identical', 'G.bind-contract', 'G.store-directory-replaced',
            'G.targeted-gate-change', 'G.every-final-generation', 'G.status-on', 'G.status-off', 'G.status-absent',
            'G.status-unprepared', 'G.status-transition', 'G.status-refused-blocked', 'G.status-production-observed',
            'G.update-gate-before-host-source', 'G.pending-downgrade-blocks-bind-grant-revoke', 'G.u9-stale-store-lock',
            'G.downgrade-running-graph-restored', 'G.downgrade-stopped-graph-not-started',
            'G.preserved-recovery-keeps-gate-on', 'G.recovery-blocked-advice',
            'G.stale-lock-never-stolen-messages', 'G.update-recovers-stale-lock',
        ]),
        ...leaves(P, 'p1', unit('ploinkyBoxGpuGrant.test.mjs'), ['G.every-final-generation-gpu']),
        ...leaves(P, 'p1', unit('ploinkyBoxHardwareLimitsTransitions.test.mjs'), [
            'T.first-on-no-barrier', 'T.on-on-no-barrier', 'T.policy-write-before-barrier',
            'T.policy-write-after-barrier', 'T.reads-and-watchdog-during-barrier', 'T.apply-blocked',
            'T.interrupted-old-graph-stopped', 'T.optional-cold-child-pending-at-commit', 'T.old-stopped-remains-stopped',
            'T.rollforward-desired-records', 'T.rollforward-restored-records', 'T.ownerless-host-lock',
            'T.cid-outside-lock', 'T.foreign-id-blocked', 'T.stop-with-broken-store', 'T.destroy-receipt',
            'T.stopped-downgrade-graph-not-started',
            ...tFaultIds(),
        ]),
        ...leaves(P, 'p1', unit('hardwareLimitsStore.test.mjs'), [
            'S.cas', 'S.host-clear-race', 'S.live-lock-never-stolen', 'S.absent-never-initialized',
            'S.initialized-missing', 'S.symlink', 'S.hardlink', 'S.wrong-owner', 'S.nonregular', 'S.oversize',
            'S.unknown-key', 'S.selective-corrupt-refused', 'S.reset-new-epoch', 'S.old-token-rejected',
            'S.outbox-before-rename', 'S.outbox-after-rename', 'S.audit-failure-committed', 'S.audit-dedup',
            'S.private-path-overlap', 'S.orphan-clear', 'S.stale-lock-dead-holder-recovered',
            'S.stale-lock-never-stolen-unproven', 'S.clear-all-keeps-pending-audit', ...sVectorIds(),
        ]),
        ...leaves(P, 'p1', unit('cgroupDelegation.test.mjs'), [
            'CG.uid', 'CG.cgroup-v1', 'CG.readonly', 'CG.nsdelegate', 'CG.no-subprocess', 'CG.node-imports-only',
            'CG.writable-source-refused', 'CG.root-procs-owned-root', 'CG.core-owned-root', 'CG.only-ploinky-chowned',
            'CG.pid1-and-self-moved', 'CG.root-busy', 'CG.partial-retry', 'CG.idempotent-core-self',
            'CG.empty-controller-structural-success',
        ]),
        ...leaves(P, 'p1', unit('hardwareLimitsLiveHarness.test.mjs'), [
            'HLIVE.C1-core-conmon-and-persisted-gate', 'C1.layout-full-controllers-pass', 'C1.layout-partial-controllers-pass',
            'C1.observer-records-delegation-files-and-absence', 'C1.layout-root-owned-delegation-files-rejected',
            'C1.layout-root-owned-cgroup-threads-rejected', 'C1.layout-missing-cgroup-threads-rejected',
            'C1.layout-empty-subtree-control-rejected', 'C1.layout-claimed-controller-missing-rejected',
            'C1.layout-mode-without-owner-write-rejected', 'C1.layout-nonroot-root-or-core-procs-rejected',
            'C1.layout-reviewer-delegated-root-owned-files-rejected', 'C1.layout-mount-must-be-rw-cgroup2-nsdelegate',
            'C1.proof-unprepared-box-fails-unchanged', 'C1.proof-drifted-box-fails-unchanged',
            'C1.proof-wrong-delegation-fails-unchanged', 'C1.proof-full-controllers-pass-unchanged',
            'C1.proof-partial-controllers-pass-unchanged', 'C1.zero-agents-blocked-unchanged',
            'C1.empty-claim-with-available-controllers-fails-unchanged', 'C1.proof-agrees-with-production-already-check',
            'C1.layout-parent-delegation-files-rejected', 'C1.layout-parent-directory-mode-and-group-rejected',
            'C1.proof-parent-delegation-fails-unchanged', 'C1.proof-broken-delegation-with-missing-controller-fails-unchanged',
            'C1.proof-valid-partial-host-blocked-unchanged',
            'C1.layout-root-interface-files-owned-by-the-box-runtime-uid-pass', 'C1.layout-root-delegation-file-owned-by-1000-rejected',
            'C1.layout-root-interface-file-owned-by-another-uid-rejected', 'C1.layout-core-file-owned-by-1000-rejected',
            'C1.layout-core-interface-files-owned-by-1000-rejected', 'C1.layout-absent-delegation-files-rejected',
            'HLIVE.A1-oom-counter-moving-only-after-the-allocation-exits-passes',
            'HLIVE.A1-oom-counter-never-moving-fails-with-the-same-message',
            'HLIVE.A1-leaf-vanishing-after-exit-is-a-distinct-recorded-failure',
            'HLIVE.C2-counter-moving-only-after-the-pressure-exits-passes',
            'HLIVE.C2-counter-never-moving-fails-with-the-same-message',
            'HLIVE.C2-leaf-vanishing-after-exit-is-a-distinct-recorded-failure',
            'R7.listing-is-persisted-after-each-repeat-start-before-anything-else',
            'R7.start-output-tails-are-persisted-bounded-and-redacted-not-journaled',
            'R7.redaction-keeps-identities-and-drops-credentials',
            'R7.agent-recreated-by-the-repeat-start-is-reported-with-both-identities',
            'R7.agent-exited-is-reported-with-exit-code-and-oom-kill',
            'R7.agent-vanished-is-reported-when-no-container-of-that-name-remains',
            'R7.agent-loss-with-an-unreadable-nested-listing-is-unclassified-not-vanished',
            'R7.agent-present-but-uninspectable-is-an-engine-error-not-a-loss',
            'R7.identity-check-stays-strict-for-a-running-agent-with-another-creation-time',
        ]),
        ...leaves(P, 'p1', unit('hardwareLimitsRepeatStart.test.mjs'), [
            'RS.host-env-gate-repeat-and-saved-gate-repeat-select-the-same-wiring-and-rewrite-nothing',
            'RS.repeat-start-twice-replaces-no-limited-agent-when-the-env-hashes-are-equal',
            'RS.service-reuse-comparison-matches-the-creation-label',
            'RS.a-nested-backend-probe-failure-is-the-plan-defined-way-limited-agents-are-removed',
        ]),
        ...leaves(P, 'p1', unit('hardwareLimitsEnvHashConsistency.test.mjs'), [
            'EH.managed-repeat-start-reuses-every-unchanged-agent-on-the-environment-gate-and-the-saved-gate',
            'EH.none-repeat-start-reuses-every-unchanged-agent-on-a-first-and-a-second-repeat-start',
            'EH.none-label-the-creation-argv-renders-equals-the-hook-value-and-the-graph-recompute',
            'EH.managed-label-rewrite-renders-the-semantic-hash-exactly-once',
            'EH.managed-stable-env-change-replaces-one-agent-once-then-the-next-start-reuses-it',
            'EH.none-service-reuse-check-matches-the-creation-label-and-replaces-only-on-a-stable-change',
            'EH.managed-adoption-expectation-equals-the-label-the-graph-and-the-closure-agree-on',
            'EH.every-security-relevant-input-and-the-broker-flag-change-the-managed-hash',
            'EH.adoption-recomputes-the-same-generated-credential-env-for-an-unchanged-agent',
        ]),
        ...leaves(P, 'p1', unit('hardwareLimitsLiveProvision.test.mjs'), [
            'L1.provision-fixture-start-keeps-bounded-redacted-output-tails', 'L1.provision-failed-fixture-start-still-leaves-its-tails',
            'L1.provision-mac-c1-c2-success', 'L1.provision-apparatus-a1-staged-success',
            'L1.provision-failure-boundaries-clean-up', 'L1.fake-engine-templates-are-strict',
            'L1.provision-box-inspect-failure-still-records-and-cleans-the-box', 'L1.cleanup-refuses-a-box-that-does-not-match-the-recorded-identity',
            'L1.provision-port-collision-aborts',
            'L1.provision-refuses-preexisting-workspace', 'L1.provision-refuses-existing-host-record',
            'L1.provision-requires-separate-authorization', 'L1.stage-roundtrip-provision-and-cleanup',
            'L1.stage-payload-digest-mismatch-refuses', 'L1.stage-forced-settlement-preserves',
            'L1.stage-wrong-host-identity-refuses', 'L1.stage-fetched-manifest-digest-mismatch-refuses',
            'L1.cleanup-resume-before-destroy', 'L1.cleanup-resume-after-destroy-before-removal-intent',
            'L1.cleanup-resume-after-intent-before-rename', 'L1.cleanup-resume-after-rename-before-removal',
            'L1.cleanup-resume-after-removal-before-complete', 'L1.cleanup-preserves-quarantine-with-wrong-marker',
            'L1.cleanup-after-interrupted-provision-without-receipts', 'L1.cleanup-removes-exact-recorded-host-records',
            'L1.cleanup-refuses-unrecorded-host-record', 'L1.cleanup-refuses-changed-host-record-identity',
            'L1.cleanup-removes-the-host-record-directory-this-run-created-when-empty',
            'L1.cleanup-keeps-a-host-record-directory-that-existed-before-the-run',
            'L1.cleanup-keeps-a-run-created-host-record-directory-that-holds-something-else',
            'L1.evidence-names-use-the-configured-document-suffix', 'L1.engine-identity-requires-the-service-locality-fact',
            'L1.cleanup-final-inventory-change-fails',
            'L1.cleanup-unshare-for-subordinate-owned-files', 'L1.prepare-live-mac-cpu-concrete-manifest-and-summary',
            'L1.prepare-live-apparatus-cpu-concrete-manifest-and-summary', 'L1.prepare-live-other-blocks-stay-unsupported',
            'L1.prepare-live-refuses-mismatched-local-pins', 'L1.fixture-declares-hardware-limits',
            'L1.cli-provision-and-cleanup-run-real-processes-without-an-injected-provider', 'L1.engine-identity-strong-facts-fail-closed',
            'L1.workspace-socket-room-refused-early',
            'L1.fixture-plan-validation-requires-hardware-limits',
            'EV1.the-gpu-proof-case-evidence-and-diagnostics-are-kept-byte-identical-before-the-staging-root-is-removed',
            'EV1.an-interrupted-transfer-is-retried-and-a-failed-one-keeps-the-staging-until-a-retry-succeeds',
            'EV1.an-unexpected-name-a-symlink-an-oversized-file-and-a-corrupt-transfer-are-never-copied',
            'EV1.a-required-artifact-that-is-missing-keeps-the-staging-and-the-run-is-not-certified',
            'EV1.each-action-names-the-proof-its-pass-needs',
            'EV2.a-later-actions-changed-artifact-never-replaces-the-retained-one-and-both-validate-after-staging-removal',
            'EV2.retained-versions-are-bounded-private-and-never-rewritten',
            'R2D.the-stager-certifies-a-cleanup-only-with-a-proof-written-by-that-cleanup-for-this-run',
        ]),
        ...leaves(P, 'p1', unit('hardwareLimitsDeclaration.test.mjs'), [
            'HD.identity-hash-args-equal', 'HD.identity-migration-no-restart-graph', 'HD.identity-llm-reuse-callers',
            'CPU.declared-cpus-admits-two-decimals-in-both-fields-and-both-profile-positions',
            'CPU.declared-cpus-is-refused-above-the-envelope-and-never-clamped',
            'CPU.paths-without-placement-keep-their-base-validation',
            'CPU.admission-keeps-equal-values-equal-in-hash-and-rendered-argv',
            'CPU.administrator-cpus-keeps-the-plan-vector-0.05-minimum-and-two-decimals',
        ]),
        ...leaves(P, 'p1', unit('hardwareLimitsCpuQuota.test.mjs'), [
            'CPU.admission-accepts-up-to-two-decimals-and-canonicalizes',
            'CPU.admission-refuses-finer-precision-and-never-rounds',
            'CPU.readback-accepts-the-exact-quota-and-the-engine-truncation-only',
            'CPU.readback-accepts-every-two-decimal-value-as-podman-truncates-it',
        ]),
        ...leaves(P, 'p1', unit('hardwareLimitsDelegation.test.mjs'), [
            'DG.no-aggregate-write', 'DG.nonroot-parents', 'DG.runtime-contexts', 'DG.outer-inspect-runtime',
            'DG.helper-complete-flags', 'DG.helper-proof', 'DG.helper-peak-after-probe-before-cleanup',
            'DG.host-kind-podman-machine-macos-fix', 'DG.host-kind-native-linux-fix', 'DG.unprepared-kind-cgroup',
            'DG.unprepared-kind-runtime', 'DG.unprepared-kind-parents',
            ...CONTROLLER_SUBSETS.map((subset) => `DG.controllers.${subset}`),
        ]),
        ...leaves(P, 'p1', unit('hardwareLimitsDrift.test.mjs'), [
            'D.memory-swap-equal', 'D.cgroupfs-prefix', 'D.exempt-prefix-absent', 'D.readback-mismatch',
            'CPU.readback-accepts-the-exact-and-truncated-quota-and-records-the-admitted-value',
            'D.readback-page-rounding', 'D.readback-swap-accounting', 'D.readback-private-namespace', 'D.readback-namespace-process-exit', 'D.precreate-change', 'D.prepublish-change',
            'D.managed-reuse', 'D.host-none-reuse', 'D.graph-reuse',
            'D.llm-admitted-policy-reuse', 'D.one-replace-then-reuse', 'D.unrelated-token-no-replace',
            'D.unprepared-empty-hash', 'D.private-mount-boundaries', 'D.interactive-reuse-refused',
            'D.interactive-create-refused', 'D.memory-only-change-replaces-one', 'D.pids-only-change-replaces-one',
            'D.start-container-launch-order', 'D.service-llm-reuse', 'D.readback-process-exit',
            'D.interactive-stored-gpu-refused', 'D.interactive-stored-replaces-declared', 'D.lite-sandbox-runs-as-container-in-box',
        ]),
        ...leaves(P, 'p1', unit('hardwareLimitsServiceReuse.test.mjs'), [
            'D.service-host-none-readback-before-reuse', 'D.service-host-none-readback-failure-removes-exact-reuse',
            'D.service-reuse-cleanup-failure-is-loud',
        ]),
        ...leaves(L, 'p1-ram', 'local-llm/tests/ploinky-budget.test.mjs', [
            'LL.raw-cpu-fractions', 'LL.cpu-warning-provenance', 'LL.cap-once', 'LL.known-zero', 'LL.unknown-distinct',
            'LL.guard-read-failure', 'LL.unlimited-golden', 'LL.unified-physical-denominator',
        ]),
        ...leaves(L, 'p1-ram', 'local-llm/tests/ploinky-budget-admission.test.mjs', [
            'LL.controller-zero-no-launch', 'LL.controller-unknown-no-launch', 'LL.controller-release-retry',
            'LL.controller-limit-absent-admitted', 'LL.controller-limit-unreadable-no-launch',
            ...llRamIds(),
        ]),
        ...leaves(P, 'p2', unit('hardwareLimitsRoutes.test.mjs'), [
            'E.apply-outbound', 'E.apply-inbound', 'E.http-cause',
            'R.anonymous', 'R.nonadmin', 'R.guest', 'R.admin', 'R.origin', 'R.csrf', 'R.cross-session-csrf',
            'R.bearer-get', 'R.bearer-set', 'R.bearer-clear', 'R.bearer-apply', 'R.duplicate-authorization',
            'R.invalid-json', 'R.body-bound', 'R.unknown-action', 'R.unknown-target', 'R.pool-rejected',
            'R.cas-conflict', 'R.alias-canonical', 'R.two-aliases', 'R.alias-router', 'R.exact-key-only',
            'R.stale-identity', 'R.no-op', 'R.dedup', 'R.concurrent-entry-order', 'R.partial-apply',
            'R.barrier-apply-only',
            'R.unlimited-and-stopped-no-op', 'R.authority-under-store-lock', 'R.cooperative-timeout-releases-real-lease',
            'R.cli-token-recheck-before-create', 'R.authorization-after-lock-wait',
            'R.limits-state-unplaced-instance-matches-apply', 'R.apply-demoted-while-waiting-for-lock',
            'R.coordinated-client-pending-is-partial', 'R.metrics-monitor-not-started-on-import',
        ]),
        ...leaves(P, 'p2', unit('marketplacePublicAdmin.test.mjs'), ['R.hardware-limits-production-admin-wiring']),
        ...leaves(P, 'p2', unit('workspaceMetricsLimits.test.mjs'), [
            'M.memory-both-halves', 'M.cpu-fraction', 'M.separate-assurance', 'M.inspect-identity-cache',
            'M.no-full-environment', 'M.off-shape',
            'M.late-proof-and-generation-change',
        ]),
        ...leaves(P, 'p2', unit('preparedRuntimeCleanup.test.mjs'), [
            'R.promoted-ready-zero-port-clears-availability-and-keeps-proof',
            'R.ordinary-ready-repair-clears-availability',
        ]),
        ...leaves(P, 'p2', unit('networkLifecycle.test.mjs'), [
            'R.managed-policy-before-predecessor-stop-and-remove',
        ]),
        ...leaves(P, 'p2', unit('ploinkyBoxTransactions.test.mjs'), [
            'G.first-enable-rollback-policy', 'G.first-enable-reconcile-failure-policy',
        ]),
        ...leaves(X, 'p3', 'explorer/tests/unit/hardwareLimitsPanel.test.js', [
            'X.exact-payload', 'X.fresh-proof', 'X.conflict-keeps-edits', 'X.pending-applied',
            'X.refused-blocked-cause', 'X.optional-child-parent-ready', 'X.admin-only', 'X.link-only-administration',
            'X.gpu-best-effort-help', 'X.u13-disclosure',
        ]),
        ...leaves(X, 'p3', 'workspaceMonitorAgent/tests/currentSnapshot.test.mjs', [
            'X.monitor-old-shape', 'X.monitor-readonly',
        ]),
        ...leaves(X, 'p3', 'tests/smoke/lib/box-evidence.test.mjs', [
            'X.store-rw-marker-ro', 'X.hardware-unexpected-bind-rejected', 'X.tool-binds-ro',
        ]),
        // Round G1: the apparatus-mps executors, their gate, probe protocol, provisioning, cleanup and manifest.
        ...leaves(P, 'p4', unit('hardwareLimitsLiveGpu.test.mjs'), [
            'G1.gate-initial-idle-records-uuid-mode-and-memory',
            'G1.gate-initial-blocks-on-a-query-error-malformed-unsupported-wrong-device-mode-memory-or-any-process',
            'G1.gate-foreign-process-blocks-and-is-named',
            'G1.gate-owned-mps-processes-are-excluded-only-with-full-provenance',
            'G1.gate-an-owned-pid-without-its-provenance-tuple-blocks',
            'G1.gate-a-listed-process-that-vanished-is-re-queried-not-blamed',
            'G1.gate-free-memory-and-real-nvidia-smi-grammar',
            'G1.gate-a-foreign-process-appearing-mid-probe-aborts-the-probe-and-trips-the-gate',
            'G1.gate-only-reads-nvidia-smi-and-never-signals',
            'G1.probe-protocol-parses-complete-allocation-oom-and-bound-reports',
            'G1.probe-protocol-distinguishes-allocation-oom-from-initialization-and-protocol-errors',
            'G1.programs-and-argument-builders-take-only-validated-words',
            'G1.evidence-is-bounded-for-the-report-and-keeps-the-verdict',
            'G1.host-observer-reads-the-tuple-and-refuses-unsupported-grammar',
            'G1.provision-gpu-grants-before-the-first-start-and-records-the-host-records',
            'G1.provision-gpu-gate-busy-blocks-before-anything-is-created',
            'G1.provision-gpu-grant-failure-or-missing-wiring-is-blocked-and-cleans-up',
            'G1.provision-gpu-refuses-a-changed-nvidia-tool-or-probe-digest',
            'G1.cleanup-removes-the-recorded-grant-and-policy-records-and-keeps-the-gpu-grants-directory',
            'G1.P1-passes-daemon-defaults-host-uid-labels-and-minimal-environment',
            'G1.P1-is-blocked-when-a-prerequisite-is-missing-and-never-passes',
            'G1.P1-fails-on-a-wrong-uid-extra-environment-tool-bind-or-readonly-pipe',
            'G1.P2-passes-share-tighter-values-and-bypass-with-recorded-rounding',
            'G1.P2-a-bypass-that-allocates-at-or-below-the-cap-fails',
            'G1.P2-fails-when-the-share-does-not-cap-and-reports-probe-errors-with-their-step',
            'G1.P2-a-foreign-process-appearing-during-a-probe-blocks-and-starts-no-new-work',
            'G1.P3-passes-drain-before-quit-final-clear-host-clear-restart-and-an-owned-daemon-crash',
            'G1.P3-a-daemon-that-quits-before-its-clients-drain-fails',
            'G1.P3-fails-when-an-unrelated-cpu-agent-is-restarted',
            'G1.P3-the-crash-case-kills-only-an-owned-daemon-and-refuses-anything-it-cannot-prove',
            'G1.P4-records-the-accepted-control-mutation-the-pipe-comparison-and-reconciles',
            'G1.P4-a-denied-or-refused-control-command-is-recorded-and-does-not-upgrade-the-assurance',
            'G1.P4-is-blocked-when-a-helper-cannot-be-created-or-cannot-reach-the-daemon',
            'G1.live-run-passes-all-four-cases-then-cleans-up-with-the-gpu-observation',
            'G1.live-run-writes-evidence-before-it-asserts-and-cleans-up-in-finally',
            'G1.live-run-block-deadline-comes-from-the-manifest',
            'G1.manifest-plan-lists-every-gpu-operation-the-executors-perform',
            'G1.mps-observe-program-reads-the-state-the-daemon-facts-and-the-three-control-replies',
            'G1.mps-kill-program-refuses-everything-it-cannot-prove-and-signals-only-the-proven-daemon',
            'G1.administrator-request-program-authenticates-against-the-products-own-verifiers',
            'G1.gpu-plan-and-profile-validation-refuse-inconsistent-fixtures-and-pins',
            'G1.gate-an-ambiguous-process-inventory-is-unsupported-whichever-section-comes-first',
            'G1.P2-a-bypass-that-sees-fewer-sms-than-the-pinned-device-fails-and-keeps-the-evidence',
            'G1.P4-the-sm-observation-precedes-the-independent-memory-setter-and-is-not-confounded',
            'G1.P4-always-reconciles-the-owned-daemon-even-when-the-case-fails-or-is-blocked',
            'G1.gf1-a-missing-malformed-or-timed-out-final-gpu-observation-never-certifies-cleanup-or-a-pass',
            'G1.gf1-standalone-cleanup-needs-the-final-gpu-observation-and-a-retry-passes-once-it-works',
            'G1.gf1-an-owned-process-that-survives-the-destruction-fails-cleanup-and-is-not-signalled',
            'G1.gf1-a-gpu-fixture-whose-provisioning-failed-is-certified-clean-only-by-a-successful-final-observation',
            'G1.gf1-only-registered-gpu-processes-may-be-recorded-in-the-manifest',
            // Amendment A5: a recorded display process does not make the GPU busy.
            'A5.a-graphics-only-display-process-is-recorded-at-the-first-check-and-tolerated-after',
            'A5.a-recorded-display-process-is-blocked-when-it-gains-compute-grows-over-the-limit-or-its-pid-is-reused',
            'A5.a-process-that-was-not-recorded-at-the-first-check-is-never-tolerated-later',
            'A5.the-first-check-blocks-compute-an-oversized-or-unmeasured-process-a-second-graphics-process-and-an-unproven-identity',
            'A5.a-recorded-display-process-that-disappears-is-logged-and-never-fails',
            'A5.owned-pid-exclusion-and-foreign-blocking-are-unchanged-beside-a-tolerated-process',
            'A5.provision-records-the-tolerated-set-in-the-run-manifest-and-the-live-cases-keep-to-it',
            'A5.a-tolerated-process-that-gains-compute-after-provisioning-blocks-the-live-run-and-a-compute-process-blocks-provisioning',
            'A5.the-manifest-validates-the-tolerated-records-and-the-approval-summary-states-the-rule',
            // LIVE-P1 attempt 3: a failed MPS case keeps the daemon's state and logs, the Router and Watchdog tails and the Apply response.
            'Y2.a-failed-first-apply-keeps-the-mps-state-logs-router-tails-and-the-apply-response-before-cleanup',
            'Y2.the-daemons-logs-are-kept-redacted-and-bounded-when-a-daemon-exists',
            'Y2.an-unreadable-source-is-recorded-as-unavailable-and-never-hides-the-failure',
            'Y2.a-blocked-case-before-any-apply-says-so-and-a-failing-artifact-writer-is-recorded',
            'Y2.a-failed-or-blocked-mps-case-that-ran-requires-its-failure-evidence-and-a-missing-item-is-reported',
            'Y2.the-failure-evidence-program-reads-state-last-problem-and-bounded-logs-read-only',
            // LIVE-P1 attempt 3: the cleanup order lists the helper stop and the identity proof; the journal records both.
            'Y4.a-live-run-journals-the-helper-stop-and-the-identity-proof-in-the-plan-order',
            'Y4.a-standalone-cleanup-journals-the-helper-stop-as-skipped-with-its-reason-and-still-proves-identity',
            'Y4.a-failed-identity-proof-stays-at-intent-and-nothing-after-it-runs',
            'W1.the-runner-classifies-the-sm-reply-with-the-products-strict-decimal-grammar',
            'W2.a-p1-pass-copies-the-journaled-readback-into-its-case-artifact',
            'W3.a-share-client-recreated-by-image-id-passes-with-the-id-as-its-image-name',
            'W3.a-recreated-share-client-with-another-image-id-or-a-foreign-image-name-fails',
            'F2.a-recreated-share-client-from-a-foreign-image-id-fails-even-when-its-name-is-the-digest-reference',
            'U3.the-compliant-fixture-agent-drains-with-exit-zero-and-the-recreate-proceeds',
            'U3.a-fixture-agent-that-dies-on-sigterm-fails-apply-at-client-launch-with-the-targeted-drain-refusal',
            'R12c.a-failed-apply-reason-carries-the-parsed-cause-before-the-cut-response-text',
            'R12c.the-fake-daemon-answers-the-sm-default-in-the-captured-form-and-the-runner-accepts-it',
            'P3R.the-candidate-parser-refuses-ports-before-restart-as-live-attempt-7-saw-and-accepts-them-before-start',
            'P3R.every-candidate-argv-of-the-apparatus-mps-manifest-and-of-its-cases-is-accepted-and-restart-carries-no-port',
            'V3.p1-expects-the-rounded-default-and-the-exact-client-share',
            'V3.p1-fails-when-the-daemon-default-is-the-raw-share-instead-of-the-rounded-value',
            'V3.p3-raising-the-share-changes-the-default-from-2-to-3-gib-and-drains-before-the-quit',
            'V3.p4-the-reconciled-daemon-carries-the-rounded-default',
            'V3.p2-still-passes-when-the-driver-truncates-a-client-value-to-a-whole-gib',
        ]),
        ...leaves(P, 'p4', unit('hardwareLimitsLiveProvision.test.mjs'), ['G1.prepare-live-apparatus-mps-concrete-manifest-and-summary', 'P3R.every-candidate-argv-of-the-cpu-manifests-and-their-provisioning-is-accepted']),
        ...leaves(P, 'p4', unit('hardwareLimitsMps.test.mjs'), [
            'MP.disabled-bytes', 'MP.tools-not-cdi', 'MP.both-tools-ro', 'MP.tool-only-fingerprint',
            'MP.missing-tools-ordinary-grant', 'MP.uid-predicate', 'MP.network-predicate', 'MP.cold-image',
            'MP.immutable-image', 'MP.gb10-numeric-memory', 'MP.unknown-model', 'MP.control-readback',
            'MP.control-malformed', 'MP.timeout',
            'MP.stop-refuses-foreign-unknown-or-changed-daemon', 'MP.cleanup-journal-boundary-transition',
            'MP.cleanup-journal-boundary-finalize', 'MP.missing-generation-directories-need-the-proc-scan',
            'MP.cleanup-journal-boundary-intent-before-and-no-check-after-cleanup',
            'W1.the-sm-readback-accepts-a-zero-only-fraction-and-nothing-else',
        ]),
        ...leaves(P, 'p4', unit('hardwareLimitsMpsLifecycle.test.mjs'), [
            'MPL.first-apply', 'MPL.unchanged-reuse', 'MPL.own-share-only', 'MPL.full-cohort-drain-before-quit',
            'MPL.final-apply-clear', 'MPL.final-host-clear-restart', 'MPL.daemon-loss', 'MPL.core-crash-journal',
            'MPL.partial-retry', 'MPL.no-unrelated-stop', 'MPL.lock-reuse', 'MPL.generation-drift',
            'MPL.p6-peer-failure-recreates-the-rest-and-reports-a-ready-daemon', 'MPL.p6-selected-failure-still-recreates-the-cohort',
        ]),
        ...leaves(P, 'p4', unit('hardwareLimitsMpsIntegration.test.mjs'), [
            'MI.p7-peer-ineligible-image-or-missing-manifest-never-refuses-the-target',
            'MI.peer-failure-is-a-partial-result-and-apply-reports-207', 'MI.ineligible-peer-is-refused-reported-before-drain-and-journaled',
            'MI.retry-recreates-only-the-failed-client', 'MI.watchdog-retries-of-a-failing-client-cause-no-healthy-churn',
            'MI.graph-start-after-client-only-failure-keeps-the-daemon', 'MI.missing-manifest-peer-is-retired-by-its-recorded-identity',
            'MI.unprovable-peer-identity-fails-closed-with-every-outcome',
            'MI.graph-launch-failure-then-lifecycle-retry-recreates-only-the-failed-client',
            'MI.two-refused-peers-keep-the-stopped-peers-outcome-when-the-second-is-unprovable',
            'MI.a-repeated-apply-keeps-the-stopped-refused-peers-outcome-and-pending-entry',
            'MI.daemon-level-error-while-recreating-a-peer-is-not-the-targets-refusal', 'MI.a-still-refused-peer-is-reported-again-without-a-second-stop',
            'MI.recorded-peer-stop-failure-and-still-running-after-stop-fail-closed-with-outcomes',
            'MI.refused-peer-outcome-survives-a-cancellation-after-its-drain',
        ]),
        ...leaves(P, 'p4', unit('hardwareLimitsOutcomes.test.mjs'), ['O.mps-graph-refusal-starts-cpu-agents-and-explorer']),
        // LIVE-P1 attempt 3: an untyped Apply failure keeps its step, class, code and a bounded, secret-free message.
        ...leaves(P, 'p4', unit('hardwareLimitsApplyCause.test.mjs'), [
            'AC.the-first-share-names-each-failing-step-with-class-code-message-and-the-generic-fix',
            'AC.a-failed-transition-journals-its-cause-beside-the-generic-problem',
            'AC.the-cause-is-bounded-and-never-carries-a-secret',
            'AC.a-typed-hardware-refusal-keeps-its-own-reason-and-names-its-step-and-cause-beside-it',
            'AC.the-product-reconcile-names-launch-readiness-and-activation',
            'AC.a-failed-runtime-verification-of-a-share-client-is-the-verify-step',
            'AC.the-innermost-step-is-kept-and-values-that-are-not-errors-are-described',
            'AC.a-peer-that-was-not-recreated-reports-its-cause-in-the-partial-result',
            'AC.mps-control-and-daemon-start-failures-say-how-the-tool-failed',
            'AC.a-drifted-mounted-tool-is-a-typed-sharing-refusal-through-apply-not-a-generic-failure',
        ]),
        // LIVE-P1 attempt 4: Apply plans a profile-less manifest whose record carries the resolved 'default' profile.
        ...leaves(P, 'p4', unit('hardwareLimitsApplyPlan.test.mjs'), [
            'Z3b.apply-plans-a-profile-less-fixture-whose-record-carries-the-resolved-default-profile-and-reaches-the-launch',
            'Z3b.the-graph-planning-of-that-record-resolves-the-persisted-profile-and-an-unknown-one-is-still-refused',
            'Z3c.an-untyped-planning-failure-reports-the-planning-step',
        ]),
        // The MPS readback is conclusive: the reply is in the error, the cause, the journal and lastReadback.
        // P1U: the live fixture agents acknowledge a targeted drain with exit 0 (real processes, no engine).
        ...leaves(P, 'p4', unit('hardwareLimitsFixtureDrain.test.mjs'), [
            'P1U.the-fixture-manifest-carries-the-exec-form-agent-command-that-acknowledges-a-drain',
            'P1U.the-fixture-agent-exits-zero-without-a-signal-on-sigterm-in-the-sh-launch-form',
            'P1U.the-fixture-agent-exits-zero-without-a-signal-on-sigint-in-the-sh-launch-form',
            'P1U.the-fixture-agent-exits-zero-without-a-signal-on-sighup-in-the-sh-launch-form',
            'P1U.the-fixture-agent-exits-zero-without-a-signal-on-sigterm-in-the-bash-launch-form',
            'P1U.the-fixture-agent-exits-zero-without-a-signal-on-sigint-in-the-bash-launch-form',
            'P1U.the-fixture-agent-exits-zero-without-a-signal-on-sighup-in-the-bash-launch-form',
            'P1U.the-previous-fixture-agent-is-killed-by-sigterm-as-in-live-attempt-6-and-is-not-an-acknowledgement',
            'P1U.the-drain-exit-code-the-fakes-use-is-measured-from-the-real-process',
        ]),
        // M-MPS-05: the largest share is reporting only; a real default change still restarts the cohort.
        ...leaves(P, 'p4', unit('hardwareLimitsMpsDefaultIdentity.test.mjs'), [
            'M05.the-daemon-identity-fields-are-compared-and-the-reported-share-never-counts',
            'M05.a-client-change-inside-the-same-default-recreates-only-that-client-and-keeps-the-daemon-and-the-peer',
            'M05.a-real-default-change-still-drains-quits-and-restarts-the-cohort',
            'M05.graph-preparation-drains-only-the-changed-client-inside-the-same-default-and-the-cohort-across-a-real-change',
        ]),
        ...leaves(P, 'p4', unit('hardwareLimitsMpsGraphLaunch.test.mjs'), ['MGL.a-largest-share-change-inside-the-same-gib-keeps-the-daemon-and-updates-the-reported-share']),
        ...leaves(P, 'p4', unit('hardwareLimitsMpsReadback.test.mjs'), [
            'W2.an-unsupported-memory-reply-fails-closed-and-its-sanitized-text-reaches-the-error-the-cause-the-journal-and-the-readback',
            'W2.a-reply-with-control-bytes-and-two-hundred-characters-is-sanitized-and-truncated-everywhere',
            'W2.a-successful-readback-is-journaled-too-the-captured-fixture',
            'W2.every-reply-parse-error-carries-the-sanitized-reply-and-the-grammar-stays-strict',
            'F1.the-final-readiness-error-keeps-the-last-refused-reply-wherever-the-deadline-lands',
            'F1.a-deadline-with-no-refused-reply-is-reported-as-the-deadline-alone',
            'V1.the-server-default-memory-is-the-largest-share-rounded-up-to-a-whole-gib-and-keeps-the-share-it-came-from',
            'V1.a-memory-default-that-is-not-a-whole-gib-is-refused-by-the-daemon-configuration-and-start',
            'V2.the-captured-driver-replies-are-pinned-and-normalize-exactly-in-the-product-parser-and-the-runner-classifier',
            'V2.a-seventeen-percent-share-of-a-6144-mib-gpu-is-applied-with-a-2048-mib-default-read-back-as-2g-and-a-1044m-client-env',
            'V2.a-daemon-that-answers-1g-for-a-configured-2048-mib-is-still-refused-and-the-message-carries-both-replies',
            'M03.no-part-of-a-known-secret-in-a-reply-reaches-the-error-the-cause-the-journal-or-the-readback',
            'M03.the-excerpt-redacts-before-escaping-and-cutting-and-keeps-ordinary-replies-and-structured-secrets-bounded',
            'M03.a-reply-with-a-credential-and-the-literal-word-redacted-never-shows-the-raw-reply',
        ]),
        // LIVE-P1: a recreate by image ID keeps the dependency installer's identity.
        ...leaves(P, 'p4', unit('hardwareLimitsInstallerImage.test.mjs'), [
            'W4.a-start-by-reference-then-a-recreate-by-id-of-the-same-image-is-no-installer-change',
            'W4.a-different-image-still-reports-an-installer-change',
            'W4.the-dependency-preparation-sites-use-the-installer-identity-and-the-container-uses-the-launch-image',
        ]),
        // The MPS verification and ownership proofs keep their reasons.
        ...leaves(P, 'p4', unit('hardwareLimitsMpsReasons.test.mjs'), [
            'W5.the-ownership-proof-names-what-differed-for-every-refusal',
            'W5.an-unsafe-private-directory-names-uid-mode-link-or-realpath',
            'W5.an-unsafe-state-or-pid-file-names-what-differed',
            'W5.an-owned-server-check-names-what-differed',
            'W5.verify-keeps-its-boolean-and-reports-the-failing-step-and-reply',
            'W5.the-callers-pass-the-reason-into-their-typed-errors',
        ]),
        // The step an untyped Apply failure reports, through the real reconcile and the MPS lifecycle.
        ...leaves(P, 'p4', unit('hardwareLimitsApplyStepLabels.test.mjs'), [
            'W7.a-failure-inside-the-mps-coordination-is-the-coordination-step-not-planning',
            'W7.a-check-between-two-steps-is-not-credited-to-the-step-that-just-finished',
            'W8.prepare-and-commit-on-a-published-route-report-restart-preparation-and-activation',
            'W8.a-plan-failure-of-the-target-through-the-coordination-is-planning',
            'W8.a-plan-failure-of-a-client-being-drained-is-the-drain-step',
            'W8.a-plan-failure-in-the-graph-launch-is-planning',
        ]),
        // A cause stays readable: no product message trips the credential redactor.
        ...leaves(P, 'p4', unit('hardwareLimitsCauseReadable.test.mjs'), [
            'W9.the-reworded-lifecycle-and-store-messages-survive-the-cause-sanitizer-intact',
            'W9.no-error-text-of-the-hardware-limits-code-trips-the-sanitizer',
        ]),
        ...leaves(P, 'p4', unit('hardwareLimitsMpsCandidateRecovery.test.mjs'), [
            'MC.readiness-failure-then-retry-succeeds', 'MC.readiness-failure-leaving-the-candidate-removes-it-by-id',
            'MC.non-exact-candidate-is-refused-without-daemon-change', 'MC.crash-during-readiness-then-recovery',
            'MC.graph-start-after-failed-apply-starts-cpu-agents',
            'MG2.inventory-query-failure', 'MG2.unknown-labelled-container', 'MG2.journaled-non-member', 'MG2.registry-drift',
            'MG2.alias-mismatch', 'MG2.transaction-checks-still-fail-the-start',
            'MC.inflight-nowait-child-survives-apply-watchdog-and-graph', 'MC.crashed-launcher-leftover-is-still-settled',
            'MC.disabled-journaled-client-absent-completes-present-refuses', 'MC.graph-keeps-candidate-entry-until-its-removal-is-proven',
            'MC.shareless-nowait-target-survives-a-concurrent-apply-watchdog-and-graph', 'MC.shareless-target-owner-is-released-when-the-launch-fails',
            'MC.shareless-crashed-launcher-leftover-is-still-settled', 'MC.owner-in-a-worker-thread-of-this-process-is-live-for-every-thread',
            'MC.a-released-owner-of-a-worker-thread-is-gone-for-every-thread',
            'MC.owner-with-this-pid-and-another-token-is-gone-only-when-the-start-time-differs', 'MC.owner-whose-pid-was-reused-is-gone-by-start-time',
        ]),
        ...leaves(P, 'p4', unit('containerMonitorMpsGeneration.test.mjs'), [
            'MW.p4-save-new-share', 'MW.p4-clear-share', 'MW.p4-change-share', 'MW.p4-unchanged-share', 'MW.p4-daemon-lost',
            'MW.p4-generation-changed', 'MW.p4-cleared-share-daemon-lost', 'MW.p6c-healthy-client-is-not-restarted-after-another-client-failed',
        ]),
        ...leaves(P, 'p4', unit('hardwareLimitsMpsStatus.test.mjs'), ['M7.gb10-refusal-carries-the-unified-memory-text']),
        ...leaves(P, 'p4', unit('ploinkyBoxGpuGrant.test.mjs'), ['M6.restart-wires-mps-from-requested-gate', 'M6.update-wires-mps-from-requested-gate']),
        ...leaves(P, 'p4', unit('hardwareLimitsMpsGraph.test.mjs'), [
            'GRAPH.alias-journal-generated-by-real-coordinator-recovery', 'GRAPH.alias-fresh-registry-control',
            'GRAPH.alias-interrupted-router-cohort-journal-and-registry', 'GRAPH.alias-legacy-journal-enriched-from-exact-registry',
            'GRAPH.alias-journal-registry-mismatch-refused', 'GRAPH.alias-unaliased-client-unchanged',
            'GRAPH.alias-inspection-never-defaults-to-canonical', 'GRAPH.alias-journal-validator-legacy-and-bounds',
        ]),
        ...leaves(L, 'p5', 'local-llm/tests/ploinky-budget.test.mjs', [
            'LL.vllm-qualification-absent', 'LL.vllm-qualification-mismatch', 'LL.vllm-qualification-match',
            'LL.vllm-six-three-two', 'LL.vllm-over-cap-incompatible', 'LL.vllm-free-shortage-temporary',
            'LL.ollama-pinned-over-cap', 'LL.ollama-auto-free', 'LL.gpu-minimal-env-all-adapters', 'LL.cpu-no-mps-env',
            'LL.partial-mps-refused', 'LL.unified-share-refused', 'LL.gpu-unlimited-golden',
        ]),
        ...leaves(P, 'p4', unit('hardwareLimitsLiveLlm.test.mjs'), [
            // The L1 measurement needs real in-flight observations.
            'LLM1.L1-with-an-instant-generation-is-blocked-and-never-passes-while-a-long-enough-one-passes',
            'LLM1.the-analysis-needs-the-minimum-in-flight-samples-of-each-kind-and-counts-neither-before-nor-after',
            // The swap cap is part of the budget.
            'LLM2.the-swap-cap-must-be-exactly-zero-after-apply-and-in-every-sample',
            'LLM2.the-analysis-refuses-an-unlimited-nonzero-or-missing-swap-cap-in-any-sample',
            // Stage 1 judges how the calibration process ended.
            'LLM4.stage-one-rejects-every-abnormal-completion-whatever-the-document-says-and-keeps-a-normal-completion',
            // Stage 2 binds the host's tuple and the qualifying evidence to the stage 1 pin.
            'LLM3.stage-two-binds-the-hosts-tuple-and-the-qualifying-evidence-to-the-stage-one-pin',
            'LLM3.every-tuple-field-the-stage-one-pin-carries-is-bound-to-what-the-host-reports',
            'R2C.stage-two-blocks-on-the-real-flattened-refusal-and-on-the-old-detailed-one-and-fails-on-an-unrelated-error',
            'R2E.a-foreign-gpu-process-during-the-install-pause-aborts-the-install-wait-and-blocks',
            'R2E.a-model-load-that-does-not-finish-in-time-is-blocked-with-its-progress-for-l1-and-l3',
            'R2E.an-unreachable-model-source-is-blocked-and-a-pin-mismatch-or-a-runner-failure-is-a-failure',
            'R2E.the-stage-two-free-memory-threshold-is-the-admission-need-plus-slack-never-near-total-free-memory',
            'R2E.the-playground-decision-states-the-route-and-session-deviation-and-the-programs-use-exactly-that-route',
            'R2F.a-fast-model-meets-the-in-flight-minimums-through-the-sustained-load-and-the-window-is-recorded',
            'R2F.a-model-too-fast-to-measure-is-blocked-at-the-time-bound-and-at-the-request-bound-never-passed',
            'R2G.l1-records-the-pinned-id-and-the-name-of-the-start-instance-and-of-the-client-recreated-by-image-id',
            'R2G.a-recreated-client-from-a-foreign-image-id-fails-in-l1-including-one-named-with-the-digest-reference',
            'R2G.a-recreated-client-from-a-foreign-image-id-fails-in-l3-and-a-recreate-by-the-pinned-id-passes',
            'M04r.a-nonzero-exit-with-an-ok-document-is-not-accepted-while-status-zero-success-and-documented-blocker-reports-are',
            'M05llm.a-run-refused-for-unreadable-gpu-telemetry-keeps-its-own-cause-and-a-recovered-unqualified-preview-does-not-certify-it',
            'M06.cpu-ram-reads-that-return-after-their-request-settled-never-count-as-in-flight',
            'M06.gpu-rows-that-return-after-their-request-settled-never-count-as-in-flight',
            'M06.slow-reads-inside-a-long-request-and-fast-reads-inside-slow-requests-count-and-pass',
            'R12a.a-reduced-route-refusal-whose-later-preview-shows-another-reason-fails-and-so-does-a-refusal-with-an-active-deployment',
            'R12a.free-gpu-memory-between-the-old-share-threshold-and-the-admission-threshold-proceeds-and-less-than-the-admission-need-blocks',
            'R12b.the-approval-summary-says-an-unreachable-source-and-a-slow-model-load-are-blocked-and-a-mismatch-or-runner-exit-is-a-failure',
            'P3R.every-candidate-argv-of-the-local-llm-and-vllm-manifests-and-cases-is-accepted',
            'R2D.a-standalone-cleanup-writes-its-own-llm-cleanup-proof-and-the-live-runs-proof-is-not-accepted-for-it',
            'R2D.a-proof-another-action-or-run-left-or-one-that-lists-remaining-data-does-not-certify-a-cleanup',
            // The runner-environment check against local-llm's own launch environment.
            'R2B.secret-names-match-whole-underscore-words-and-the-products-own-emitted-names-are-allowed',
            'R2A.the-products-own-cuda-cache-variable-is-allowed-and-any-other-cuda-name-fails',
            'R2A.L1-and-L3-accept-the-runner-environment-local-llm-really-builds-and-refuse-a-foreign-cuda-name',
            'G2.provision-copies-the-local-llm-tree-pins-its-image-and-grants-the-gpu-before-the-start',
            'G2.provision-blocks-a-changed-tree-or-manifest-and-an-image-the-agent-was-not-created-from',
            'G2.L1-passes-budget-cgroup-runner-environment-uid-generation-text-and-digests',
            'G2.L1-fails-on-a-wrong-cap-an-extra-or-missing-cuda-variable-a-leaked-secret-a-root-runner-no-text-or-another-model',
            'G2.L1-is-blocked-when-the-box-envelope-or-the-data-or-the-route-or-the-gpu-cannot-support-it',
            'G2.L1-measures-cpu-memory-and-gpu-while-the-request-generates-and-records-the-evidence-first',
            'G2.L1-fails-when-the-cpu-use-exceeds-the-quota-memory-exceeds-the-cap-swap-is-used-the-kernel-kills-or-the-gpu-memory-exceeds-the-share',
            'G2.L1-passes-when-the-driver-lists-only-the-owned-mps-server-and-without-memory-peak-and-records-which-basis-it-used',
            'G2.L1-is-blocked-and-cleans-up-when-a-foreign-gpu-process-appears-while-the-model-generates',
            'G2.the-inference-analysis-fails-each-budget-breach-blocks-each-missing-measurement-and-allows-only-its-documented-tolerance',
            'G2.the-leaf-sample-program-reads-only-the-agent-leaf-files-and-refuses-another-path',
            'G2.L2-stops-saves-an-insufficient-budget-applies-verifies-the-cap-and-sees-the-run-refused-before-launch',
            'G2.L2-fails-when-the-run-is-accepted-launches-before-refusing-the-cap-is-wrong-or-the-reason-is-not-the-budget',
            'G2.L2-is-blocked-without-a-viable-insufficient-percentage-and-never-tests-the-old-model-or-an-unapplied-setting',
            'G2.vllm-step-zero-blocks-with-the-exact-prerequisite-and-never-passes',
            'G2.vllm-install-failure-pause-refusal-or-timeout-is-blocked-with-the-progress-and-never-passes',
            'G2.vllm-stage-one-calibrates-without-a-model-computes-the-tuple-and-proposes-the-reviewed-entry',
            'G2.vllm-stage-one-is-blocked-for-a-share-denominator-an-unsupported-device-or-an-unusable-proposal',
            'G2.vllm-stage-two-observes-vllm_mps_unqualified-before-the-data-entry-and-reports-it-blocked',
            'G2.vllm-stage-two-qualified-after-the-data-entry-starts-the-model-through-public-admission-and-gets-text',
            'G2.vllm-stage-two-fails-when-admitted-without-an-entry-refused-with-one-without-text-over-the-share-or-blocks-for-an-unfit-share',
            'G2.the-gate-tolerates-one-recorded-display-process-for-every-local-llm-block-and-blocks-the-rest',
            'G2.cleanup-inventories-and-removes-model-data-runner-caches-subordinate-owned-files-and-records-and-proves-it',
            'G2.cleanup-is-not-certified-while-the-owned-model-data-remains',
            'G2.manifest-plan-lists-every-llm-operation-the-executors-perform',
            'G2.the-tool-program-validates-resolves-the-agent-projects-the-reply-and-reports-a-refusal-as-data',
            'G2.the-agent-programs-read-runner-processes-and-image-files-without-leaking-arguments-or-values',
            'G2.validation-refuses-inconsistent-local-llm-pins-profiles-budgets-and-tool-words',
            'G2.prepare-live-apparatus-local-llm-pins-the-image-the-tree-and-the-models-and-writes-the-approval-summary',
            'G2.prepare-live-apparatus-vllm-stage-one-pins-the-lock-entry-and-asks-for-no-evidence',
            'G2.prepare-live-apparatus-vllm-stage-two-checks-the-evidence-with-the-candidates-digest-and-asks-production-whether-the-tuple-is-qualified',
        ]),
        ...leaves(P, 'p4', unit('ploinkyBoxGpuGrant.test.mjs'), [
            'P1X.restart-wires-mps-and-the-box-observes-the-gpu-with-the-loader-path',
            'P1X.a-failing-observation-names-its-cause-instead-of-a-generic-refusal',
            'P1X.control-mps-tool-discovery-failure-reaches-the-box-status-with-its-cause',
        ]),
        ...leaves(L, 'p5', 'local-llm/tests/vllm-mps-calibration.test.mjs', [
            'CAL.prerequisites-pass-and-report-the-entry-wheels-and-download-size',
            'CAL.prerequisites-block-without-a-vllm-entry-and-never-pass',
            'CAL.prerequisites-block-each-missing-requirement-with-its-evidence',
            'CAL.tuple-comes-from-the-production-functions-over-the-real-readings',
            'CAL.calibration-runs-bounded-queries-under-both-limits-compares-with-nvml-and-builds-the-production-argv',
            'CAL.the-denominator-is-classified-physical-share-or-unknown-from-the-two-limits',
            'CAL.a-share-denominator-or-a-failed-check-is-not-qualifiable-and-renders-no-entry',
            'CAL.stage-one-blocks-without-a-share-a-gpu-an-install-or-a-query-and-never-invents-a-document',
            'CAL.the-evidence-digest-is-canonical-and-covers-the-tuple-and-every-measurement',
            'CAL.the-rendered-entry-is-accepted-by-production-for-its-tuple-and-refused-after-any-change',
            'CAL.the-data-entry-edits-only-the-reviewed-list-and-production-then-qualifies-exactly-that-tuple',
            'CAL.the-command-line-prints-one-bounded-json-document-and-an-exit-code',
            'CAL.stage-one-never-writes-and-the-tool-only-reads-the-installed-package',
            'CAL.identities-are-compared-with-the-selected-lock-entry-and-any-mismatch-or-missing-identity-is-not-qualifiable',
            'CAL.the-identity-comparison-is-pure-and-names-a-lock-without-pins-or-cuda',
            'CAL.qualification-needs-the-reviewed-sizing-statements-of-the-locked-version-and-a-keyword-is-never-proof',
            'CAL.the-sizing-scan-is-complete-reports-where-each-statement-was-found-and-treats-unreadable-files-as-truncation',
            'CAL.a-commented-out-expression-is-not-a-statement-even-when-unsupported-statements-follow-it',
            'CAL.a-quoted-expression-is-not-a-statement-docstrings-and-triple-quoted-blocks-included',
            'CAL.a-real-statement-next-to-comments-and-strings-qualifies-with-its-original-line-number',
            'CAL.stripping-blanks-comments-and-literals-and-keeps-every-line',
        ]),
    ];
    const manifest = { schema: 1, cases };
    return validateCaseManifest(manifest);
}

export function validateCaseManifest(value) {
    const label = 'cases';
    if (jsonBytes(value) > 1024 * 1024) fail(label, 'exceeds 1 MiB');
    exactKeys(value, ['schema', 'cases'], [], label);
    if (value.schema !== 1) fail(`${label}.schema`, 'unsupported schema');
    boundedArray(value.cases, `${label}.cases`, 4096);
    const ids = new Set();
    const leafByFile = new Set();
    for (const [index, entry] of value.cases.entries()) {
        const entryLabel = `${label}.cases[${index}]`;
        exactKeys(entry, ['id', 'phase', 'repo', 'file', 'name', 'kind', 'requires', 'expected'], [], entryLabel);
        if (!SAFE_ID.test(entry.id)) fail(`${entryLabel}.id`, 'invalid id');
        if (ids.has(entry.id)) fail(`${entryLabel}.id`, `duplicate id '${entry.id}'`);
        ids.add(entry.id);
        if (!['s0', 'p0', 'p1', 'p1-ram', 'p2', 'p3', 'p4', 'p5'].includes(entry.phase)) fail(`${entryLabel}.phase`, 'unknown phase');
        if (!['ploinky', 'explorer', 'local-llms'].includes(entry.repo)) fail(`${entryLabel}.repo`, 'unknown repo');
        boundedString(entry.file, `${entryLabel}.file`, 512);
        if (path.isAbsolute(entry.file) || entry.file.split('/').includes('..') || entry.file.includes('\\')) {
            fail(`${entryLabel}.file`, 'unsafe relative path');
        }
        boundedString(entry.name, `${entryLabel}.name`, 1024);
        if (entry.kind !== 'offline' && entry.kind !== 'live') fail(`${entryLabel}.kind`, 'invalid kind');
        if (entry.expected !== 'pass') fail(`${entryLabel}.expected`, 'invalid expectation');
        boundedArray(entry.requires, `${entryLabel}.requires`, 64);
        const key = `${entry.repo}:${entry.file}::${entry.name}`;
        if (leafByFile.has(key)) fail(entryLabel, 'duplicate file/title association');
        leafByFile.add(key);
    }
    // Requirements must name known IDs and be acyclic.
    const byId = new Map(value.cases.map((entry) => [entry.id, entry]));
    for (const entry of value.cases) {
        for (const required of entry.requires) {
            if (!byId.has(required)) fail(label, `case '${entry.id}' requires unknown '${required}'`);
        }
    }
    const visiting = new Set();
    const done = new Set();
    const visit = (id) => {
        if (done.has(id)) return;
        if (visiting.has(id)) fail(label, `requirement cycle at '${id}'`);
        visiting.add(id);
        for (const required of byId.get(id).requires) visit(required);
        visiting.delete(id);
        done.add(id);
    };
    for (const id of byId.keys()) visit(id);
    return value;
}

// ---------------------------------------------------------------------------
// Native event records and suite evaluation

export function validateEventRecord(value, label = 'event') {
    exactKeys(value, ['schema', 'runId', 'childId', 'sequence', 'event', 'file', 'testId', 'parentId', 'payload'], [], label);
    if (value.schema !== 1) fail(`${label}.schema`, 'unsupported schema');
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) fail(`${label}.sequence`, 'invalid sequence');
    if (!['header', 'start', 'pass', 'fail', 'skip', 'todo', 'diagnostic', 'stream-complete'].includes(value.event)) {
        fail(`${label}.event`, 'unknown event');
    }
    boundedString(value.file, `${label}.file`, 1024, { allowEmpty: true });
    boundedString(value.testId, `${label}.testId`, 4096, { allowEmpty: true });
    nullable(value.parentId, (v) => boundedString(v, `${label}.parentId`, 4096));
    plainObject(value.payload, `${label}.payload`);
    return value;
}

// Parse the reporter output strictly. Any malformed line, wrong run/child,
// sequence gap, missing header or missing final stream-complete record is a
// hard harness failure, never a partial success.
export function parseEventStream(text, { runId, childId } = {}) {
    const problems = [];
    if (typeof text !== 'string' || !text.length) {
        return { complete: false, records: [], problems: ['event stream is empty'] };
    }
    const lines = text.split('\n');
    if (lines[lines.length - 1] !== '') problems.push('event stream ends without a newline (truncated)');
    const records = [];
    for (const [index, line] of lines.entries()) {
        if (!line) continue;
        let parsed;
        try {
            parsed = validateEventRecord(JSON.parse(line), `event[${index}]`);
        } catch (error) {
            problems.push(`event line ${index + 1} is invalid: ${error.message}`);
            continue;
        }
        if (runId !== undefined && parsed.runId !== runId) problems.push(`event line ${index + 1} belongs to another run`);
        if (childId !== undefined && parsed.childId !== childId) problems.push(`event line ${index + 1} belongs to another child`);
        if (parsed.sequence !== records.length + 1) problems.push(`event sequence gap at line ${index + 1}`);
        records.push(parsed);
    }
    if (!records.length || records[0].event !== 'header') problems.push('event stream has no header');
    const last = records[records.length - 1];
    const complete = Boolean(last && last.event === 'stream-complete'
        && last.payload?.recordsBefore === records.length - 1);
    if (!complete) problems.push('event stream has no final stream-complete record');
    return { complete: complete && problems.length === 0, records, problems };
}

// Classify one suite run. `required` is a list of case entries for this
// repository/phase; `baseline` (optional) is the prior inventory
// {tests: Map testId -> result}. Returns per-case results and a verdict.
export function evaluateSuiteRun({
    exitCode,
    signal,
    eventText,
    runId,
    childId,
    files = [],
    required = [],
    baseline = null,
    knownBaselineFailures = new Map(),
} = {}) {
    const problems = [];
    if (signal) problems.push(`test child terminated by signal ${signal}`);
    const stream = parseEventStream(eventText, { runId, childId });
    problems.push(...stream.problems);
    const leafResults = new Map();
    const parents = new Set();
    for (const record of stream.records) {
        if (record.parentId) parents.add(record.parentId);
    }
    const fileFailures = [];
    for (const record of stream.records) {
        if (!['pass', 'fail', 'skip', 'todo'].includes(record.event)) continue;
        if (record.payload.kind === 'suite') continue;
        if (record.event === 'fail' && record.payload.nesting === 0 && record.payload.name === record.file) {
            // node reports an import or discovery failure as a failed
            // top-level test named after the file itself.
            fileFailures.push(record);
            continue;
        }
        // Every result record has a unique full-path identity; a repeated one
        // cannot be attributed and is a harness problem, never a later pass.
        if (leafResults.has(record.testId)) {
            problems.push(`duplicate test identity: ${record.testId}`);
            const previous = leafResults.get(record.testId);
            if (previous.result === 'fail') continue;
        }
        leafResults.set(record.testId, { result: record.event, record });
    }
    for (const record of fileFailures) {
        problems.push(`test file failed to load or run: ${record.payload.name}: ${record.payload.error?.message || ''}`);
    }
    for (const file of files) {
        const discovered = [...leafResults.keys()].some((testId) => testId.startsWith(`${file}::`));
        if (!discovered) problems.push(`no tests were discovered in ${file}`);
    }
    const cases = [];
    for (const entry of required) {
        // A required case names its leaf title. It must resolve to exactly one
        // result record; the same title under two parents is ambiguous.
        const matches = [...leafResults.entries()].filter(([, { record }]) => record.file === entry.file && record.payload.name === entry.name);
        const [testId, observed] = matches.length === 1 ? matches[0] : [null, null];
        let result = 'missing';
        let reason = 'required leaf was not discovered';
        if (matches.length > 1) {
            result = 'fail';
            reason = `required case title is ambiguous: ${matches.length} results share it`;
        } else if (observed) {
            if (parents.has(testId)) {
                result = 'fail';
                reason = 'required case is a parent title, not a leaf';
            } else if (observed.result === 'pass') {
                result = 'pass';
                reason = '';
            } else if (observed.result === 'skip' || observed.result === 'todo') {
                result = 'fail';
                reason = `required case reported ${observed.result}`;
            } else {
                result = 'fail';
                reason = observed.record.payload.error?.message || 'assertion failure';
            }
        }
        cases.push({ id: entry.id, file: entry.file, name: entry.name, result, reason });
    }
    const newFailures = [];
    const baselineFailures = [];
    const failureSignatures = new Map();
    const provenDiagnostic = (error) => error && typeof error.category === 'string' && error.category.length > 0 && error.category.length <= 256
        && /^[a-f0-9]{64}$/.test(error.signature || '') && error.proofUnavailable !== true
        ? { category: error.category, signature: error.signature } : null;
    for (const [testId, { result, record }] of leafResults) {
        if (result !== 'fail') continue;
        const proof = provenDiagnostic(record.payload.error);
        failureSignatures.set(testId, proof);
        const prior = knownBaselineFailures instanceof Map ? provenDiagnostic(knownBaselineFailures.get(testId)) : null;
        const failure = { testId, message: record.payload.error?.message || '', ...(proof || {}) };
        if (proof && prior && proof.category === prior.category && proof.signature === prior.signature) baselineFailures.push(failure);
        else newFailures.push({ ...failure, reason: knownBaselineFailures.has(testId)
            ? proof && prior ? 'baseline failure diagnostic changed' : 'baseline failure diagnostic proof unavailable'
            : 'new failing test' });
    }
    const removed = [];
    const newlySkipped = [];
    if (baseline) {
        for (const [testId, previous] of baseline) {
            const current = leafResults.get(testId);
            if (!current) removed.push(testId);
            else if ((current.result === 'skip' || current.result === 'todo') && previous !== current.result) {
                newlySkipped.push(testId);
            }
        }
    }
    for (const testId of removed) problems.push(`baseline test removed: ${testId}`);
    for (const testId of newlySkipped) problems.push(`baseline test newly skipped: ${testId}`);
    const caseFailures = cases.filter((entry) => entry.result !== 'pass');
    if (exitCode !== 0 && newFailures.length === 0 && caseFailures.length === 0
        && baselineFailures.length === 0 && !signal) {
        problems.push(`test child exited ${exitCode} without a recorded failing test`);
    }
    const verdict = problems.length || caseFailures.length || newFailures.length ? 'FAIL' : 'PASS';
    return {
        verdict,
        streamComplete: stream.complete,
        problems,
        cases,
        newFailures,
        baselineFailures,
        failureSignatures,
        removed,
        newlySkipped,
        discovered: leafResults.size,
        completed: [...leafResults.values()].filter((entry) => entry.result !== 'todo').length,
        inventory: new Map([...leafResults].map(([testId, { result }]) => [testId, result])),
    };
}

// ---------------------------------------------------------------------------
// GPU idle gate (§15.5)

export function classifyGpuPidSet(observedPids, verifiedOwnedHostPids) {
    const foreign = observedPids.filter(pid => !verifiedOwnedHostPids.has(pid));
    return foreign.length
        ? { state: 'blocked', reason: 'gpu_busy', foreign }
        : { state: 'idle' };
}

// Parse `nvidia-smi --query-compute-apps=pid --format=csv,noheader` output.
// One positive safe integer per line; anything else blocks.
export function parseComputePidQuery(query) {
    if (!query || query.ok !== true || query.status !== 0 || query.signal || query.timedOut || query.truncated) {
        return { ok: false, reason: 'query_error' };
    }
    if (typeof query.stdout !== 'string') return { ok: false, reason: 'malformed_output' };
    const pids = [];
    for (const raw of query.stdout.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (!/^[1-9][0-9]{0,9}$/.test(line)) return { ok: false, reason: 'malformed_output' };
        const pid = Number(line);
        if (!Number.isSafeInteger(pid)) return { ok: false, reason: 'malformed_output' };
        pids.push(pid);
    }
    return { ok: true, pids };
}

// An owned process is excluded only when every identity fact is freshly
// re-observed: host boot ID, host PID, process start identity, cgroup ancestry
// beneath the exact task Box, and a registered MPS role.
export function verifyOwnedGpuProcess(record, observed, { bootId, boxCgroupPrefix } = {}) {
    if (!record || !observed) return false;
    if (!['mps-server', 'mps-client'].includes(record.role)) return false;
    if (!bootId || record.bootId !== bootId || observed.bootId !== bootId) return false;
    if (!Number.isSafeInteger(record.hostPid) || record.hostPid !== observed.hostPid) return false;
    if (!record.startIdentity || record.startIdentity !== observed.startIdentity) return false;
    if (!boxCgroupPrefix || typeof observed.cgroup !== 'string'
        || !(observed.cgroup === boxCgroupPrefix || observed.cgroup.startsWith(`${boxCgroupPrefix}/`))) {
        return false;
    }
    return true;
}

// Amendment A5 (decision D-A5-01): a recorded display process does not make the
// GPU busy. At the run's first gate check at most ONE foreign process (the
// user's "one recorded display process"), listed with type exactly `G`
// (graphics only), using at most GPU_TOLERATED_MAX_MIB MiB and with a proven
// host identity, is recorded as tolerated; a second one blocks. Every later check
// allows only that recorded process, with its recorded identity, type `G` and
// memory within the limit. Nothing else is tolerated, and a tolerated process
// is never touched.
export const GPU_TOLERATED_MAX = 1;
export const GPU_TOLERATED_MAX_MIB = 64;

// `processes` are the parsed inventory rows ({pid, type, name, memoryMiB}); with
// `tolerate` ({mode: 'record'|'subset', recorded}) they decide which foreign
// processes the rule tolerates. Without `tolerate` (the default) nothing is
// tolerated and the result is exactly the exact-membership classification.
export function evaluateGpuIdleGate({
    query,
    activity,
    owned = [],
    observe = () => null,
    bootId,
    boxCgroupPrefix,
    initial = false,
    processes = null,
    tolerate = null,
} = {}) {
    const parsed = parseComputePidQuery(query);
    if (!parsed.ok) return { state: 'blocked', reason: parsed.reason };
    if (!activity || activity.supported !== true) return { state: 'blocked', reason: 'activity_unknown' };
    if (Array.isArray(activity.foreign) && activity.foreign.length) {
        return { state: 'blocked', reason: 'gpu_busy', foreign: [...activity.foreign] };
    }
    const tolerating = Boolean(tolerate) && Array.isArray(processes);
    const withinLimit = (row) => row.type === 'G' && Number.isSafeInteger(row.memoryMiB) && row.memoryMiB >= 0 && row.memoryMiB <= GPU_TOLERATED_MAX_MIB;
    // The host identity of a listed PID, freshly observed: boot identity and /proc start time.
    const identityOf = (pid) => {
        let seen = null;
        try { seen = observe(pid); } catch { return null; }
        return seen && bootId && seen.bootId === bootId && seen.hostPid === pid && seen.startIdentity ? { bootId: seen.bootId, startIdentity: String(seen.startIdentity) } : null;
    };
    if (initial && !(tolerating && tolerate.mode === 'subset')) {
        if (!parsed.pids.length) return tolerating ? { state: 'idle', tolerated: [], vanished: [] } : { state: 'idle' };
        if (!tolerating || tolerate.mode !== 'record') return { state: 'blocked', reason: 'gpu_busy', foreign: parsed.pids };
        // The run's first check: record what the rule allows, or block naming what it does not.
        const refused = processes.filter((row) => !withinLimit(row));
        if (refused.length) return { state: 'blocked', reason: 'gpu_busy', foreign: refused.map((row) => row.pid), why: 'not_tolerable' };
        if (processes.length > GPU_TOLERATED_MAX) return { state: 'blocked', reason: 'gpu_busy', foreign: processes.map((row) => row.pid), why: 'too_many' };
        const tolerated = [];
        for (const row of processes) {
            const identity = identityOf(row.pid);
            if (!identity) return { state: 'blocked', reason: 'display_identity_unproved', hostPid: row.pid };
            tolerated.push({ kind: 'gpu-tolerated', hostPid: row.pid, bootId: identity.bootId, startIdentity: identity.startIdentity, name: row.name ?? null, type: 'G', memoryMiB: row.memoryMiB });
        }
        return { state: 'idle', tolerated, vanished: [] };
    }
    const verified = new Set();
    for (const record of owned) {
        if (!verifyOwnedGpuProcess(record, observe(record.hostPid), { bootId, boxCgroupPrefix })) {
            // Provenance could not be proved: exclude nothing and block.
            return { state: 'blocked', reason: 'owned_provenance_unproved', hostPid: record?.hostPid ?? null };
        }
        verified.add(record.hostPid);
    }
    if (!tolerating) return classifyGpuPidSet(parsed.pids, verified);
    const recorded = new Map((tolerate.recorded || []).map((record) => [record.hostPid, record]));
    const stillTolerated = new Set();
    const present = [];
    const changed = [];
    for (const row of processes) {
        if (verified.has(row.pid)) continue;
        const record = recorded.get(row.pid);
        if (!record) continue; // not recorded: left to the exact-membership classification below
        const identity = identityOf(row.pid);
        if (identity && identity.bootId === record.bootId && identity.startIdentity === String(record.startIdentity) && withinLimit(row)) {
            stillTolerated.add(row.pid); present.push(record);
        } else changed.push({ pid: row.pid, why: !identity || identity.bootId !== record.bootId || identity.startIdentity !== String(record.startIdentity) ? 'identity_changed' : row.type !== 'G' ? 'type_changed' : 'memory_over_limit' });
    }
    if (changed.length) return { state: 'blocked', reason: 'gpu_busy', foreign: changed.map((entry) => entry.pid), why: changed[0].why, changed };
    const result = classifyGpuPidSet(parsed.pids.filter((pid) => !stillTolerated.has(pid)), verified);
    if (result.state !== 'idle') return { ...result, why: 'not_recorded' };
    // A recorded process that is no longer listed is logged, never a failure.
    const listed = new Set(processes.map((row) => row.pid));
    return { state: 'idle', tolerated: present, vanished: [...recorded.keys()].filter((pid) => !listed.has(pid)) };
}

// ---------------------------------------------------------------------------
// Fail-safe cleanup ordering (§15.6)

export const CLEANUP_STEPS = Object.freeze([
    'stop-owned-work',
    'revalidate-identity',
    'candidate-gate-off',
    'destroy-box',
    'remove-host-records',
    'remove-workspace-tree',
    'verify-absent',
]);

// `operations` maps each step to a function returning {skipped?:boolean}.
// A failed identity revalidation or destruction stops every dependent
// deletion. Failures never erase the original failure.
export async function runCleanup(operations, { originalError = null } = {}) {
    const steps = [];
    const failures = [];
    const blockingSteps = new Set(['revalidate-identity', 'candidate-gate-off', 'destroy-box']);
    let stopped = false;
    for (const step of CLEANUP_STEPS) {
        if (stopped) {
            steps.push({ id: step, state: 'not-run', artifact: null });
            continue;
        }
        const operation = operations?.[step];
        if (typeof operation !== 'function') {
            steps.push({ id: step, state: 'not-applicable', artifact: null });
            continue;
        }
        try {
            const result = await operation();
            steps.push({ id: step, state: result?.skipped ? 'skipped' : 'complete', artifact: result?.artifact ?? null });
        } catch (error) {
            failures.push({ step, code: String(error?.code || ''), message: String(error?.message || error).slice(0, 1024) });
            steps.push({ id: step, state: 'failed', artifact: null });
            if (blockingSteps.has(step)) stopped = true;
        }
    }
    return {
        state: failures.length ? 'cleanup-required' : 'complete',
        steps,
        failures,
        originalError: originalError
            ? { code: String(originalError.code || ''), message: String(originalError.message || originalError).slice(0, 1024) }
            : null,
    };
}

// ---------------------------------------------------------------------------
// Owned short temporary directory (TMPDIR=.t inside a test root)

export function createOwnedShortTemp(testRoot, { name = '.t' } = {}) {
    const root = fs.realpathSync(testRoot);
    const target = path.join(root, name);
    try {
        fs.mkdirSync(target, { mode: 0o700 });
    } catch (error) {
        if (error?.code === 'EEXIST') {
            throw new SchemaError(`refusing existing unowned short temp directory ${target}`);
        }
        throw error;
    }
    const stat = fs.lstatSync(target);
    const marker = randomRunId();
    fs.writeFileSync(path.join(target, '.ploinky-hwl-owner'), marker, { mode: 0o600, flag: 'wx' });
    return Object.freeze({ path: target, dev: stat.dev, ino: stat.ino, marker });
}

export function removeOwnedShortTemp(handle) {
    let stat;
    try {
        stat = fs.lstatSync(handle.path);
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
    if (!stat.isDirectory() || stat.dev !== handle.dev || stat.ino !== handle.ino) {
        throw new SchemaError(`short temp directory ${handle.path} was replaced; not removing it`);
    }
    const marker = fs.readFileSync(path.join(handle.path, '.ploinky-hwl-owner'), 'utf8');
    if (marker !== handle.marker) throw new SchemaError(`short temp directory ${handle.path} has a foreign owner marker`);
    fs.rmSync(handle.path, { recursive: true, force: false });
    return true;
}

// ---------------------------------------------------------------------------
// Run manifest and report (§18.2)

export function validateRunManifest(value) {
    const label = 'run';
    if (jsonBytes(value) > 256 * 1024) fail(label, 'exceeds 256 KiB');
    // `toleratedProcesses` (amendment A5) records the display processes the idle gate
    // tolerated at the run's first check; only GPU blocks carry it.
    exactKeys(value, [
        'schema', 'runId', 'configDigest', 'casesDigest', 'block', 'target', 'state', 'workspace', 'ports',
        'deadlines', 'images', 'ownedBoxes', 'ownedProcesses', 'ownedPaths', 'preInventory', 'operations', 'cleanup',
    ], ['toleratedProcesses'], label);
    if (Object.prototype.hasOwnProperty.call(value, 'toleratedProcesses')) boundedArray(value.toleratedProcesses, `${label}.toleratedProcesses`, GPU_TOLERATED_MAX);
    if (value.schema !== 1) fail(`${label}.schema`, 'unsupported schema');
    if (!HEX128.test(value.runId)) fail(`${label}.runId`, 'expected 128-bit hex');
    for (const key of ['configDigest', 'casesDigest']) {
        if (!/^sha256:[0-9a-f]{64}$/.test(value[key])) fail(`${label}.${key}`, 'invalid digest');
    }
    if (!['mac-cpu', 'mac-adversarial', 'mac-explorer', 'apparatus-cpu', 'apparatus-mps', 'apparatus-local-llm',
        'apparatus-vllm'].includes(value.block)) {
        fail(`${label}.block`, 'unknown block');
    }
    if (!['proposed', 'running', 'cleanup-required', 'complete'].includes(value.state)) fail(`${label}.state`, 'invalid state');
    plainObject(value.target, `${label}.target`);
    plainObject(value.workspace, `${label}.workspace`);
    plainObject(value.ports, `${label}.ports`);
    plainObject(value.deadlines, `${label}.deadlines`);
    boundedArray(value.images, `${label}.images`, 32);
    for (const key of ['ownedBoxes', 'ownedProcesses', 'ownedPaths', 'operations']) {
        boundedArray(value[key], `${label}.${key}`, 1024);
    }
    plainObject(value.preInventory, `${label}.preInventory`);
    exactKeys(value.cleanup, ['state', 'steps', 'failures'], [], `${label}.cleanup`);
    if (Object.prototype.hasOwnProperty.call(value, 'approval')) fail(label, 'approval is never a manifest field');
    return value;
}

export function validateReport(value) {
    const label = 'report';
    if (jsonBytes(value) > 1024 * 1024) fail(label, 'exceeds 1 MiB');
    exactKeys(value, [
        'schema', 'runId', 'command', 'phase', 'verdict', 'exitCode', 'sources', 'environment', 'counts', 'cases',
        'suites', 'streamComplete', 'cleanup', 'artifacts',
    ], [], label);
    if (value.schema !== 1) fail(`${label}.schema`, 'unsupported schema');
    if (!['PASS', 'FAIL', 'BLOCKED', 'SKIPPED'].includes(value.verdict)) fail(`${label}.verdict`, 'invalid verdict');
    if (EXIT[value.verdict] !== value.exitCode) fail(`${label}.exitCode`, 'does not match verdict');
    return value;
}

// No-follow private atomic JSON write into an owned output directory.
export function writePrivateJson(target, value) {
    const directory = path.dirname(target);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SchemaError(`${directory} is not a real directory`);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new SchemaError(`${directory} is not owned by this user`);
    }
    const temporary = path.join(directory, `.${path.basename(target)}.${randomRunId()}.tmp`);
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW, 0o600);
    try {
        fs.writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        const existing = fs.lstatSync(target);
        if (!existing.isFile() || existing.isSymbolicLink()) {
            fs.unlinkSync(temporary);
            throw new SchemaError(`${target} exists and is not a regular file`);
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    fs.renameSync(temporary, target);
    return target;
}
