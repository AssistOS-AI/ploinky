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
            'H.malformed-pids', 'H.initial-busy', 'H.graphics-unknown-blocked',
        ]),
        ...leaves(P, 'p0', unit('hardwareLimitsAdmission.test.mjs'), [
            'A.manifest-memory', 'A.catalog-cpu', 'A.profile-pids', 'A.lite-enabled-absent', 'A.lite-enabled-false',
            'A.outside-box-unchanged', 'A.unlimited-unchanged', 'A.helper-exempt', 'A.d4-limited-refused',
            'A.d4-unlimited-baseline', 'A.stored-gpu-refused', 'A.stored-cpus-above-envelope-refused',
        ]),
        ...leaves(P, 'p0', unit('hardwareLimitsOutcomes.test.mjs'), [
            'O.prelock-preflight-refusal', 'O.locked-preflight-refusal', 'O.defensive-preflight-refusal',
            'O.batch-first-enable-refusal', 'O.digest-refusal-current', 'O.digest-input-change',
            'O.metadata-cannot-render', 'O.nonhardware-still-strict', 'O.blocking-diamond', 'O.blocking-transitive',
            'O.enabled-extra', 'O.alias-identity', 'O.optional-no-wait-parent-ready',
            'O.optional-eligibility-asynchronous', 'O.optional-child-blocking-grandchild',
            'O.explicit-status-wait-blocked', 'O.no-synthetic-optional-wait', 'O.cycle-wait-kind',
            'O.store-unknown-no-create', 'O.launch-refusal-blocks-dependants', 'O.launch-refusal-extra-contained',
            'O.launch-nonhardware-still-throws',
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
        ...leaves(P, 'p0', unit('containerMonitorRetryIdentity.test.mjs'), ['MON.unrelated-write-no-rearm']),
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
        ]),
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
        ...leaves(P, 'p1', unit('hardwareLimitsDelegation.test.mjs'), [
            'DG.no-aggregate-write', 'DG.nonroot-parents', 'DG.runtime-contexts', 'DG.outer-inspect-runtime',
            'DG.helper-complete-flags', 'DG.helper-proof', 'DG.helper-peak-after-probe-before-cleanup',
            'DG.host-kind-podman-machine-macos-fix', 'DG.host-kind-native-linux-fix', 'DG.unprepared-kind-cgroup',
            'DG.unprepared-kind-runtime', 'DG.unprepared-kind-parents',
            ...CONTROLLER_SUBSETS.map((subset) => `DG.controllers.${subset}`),
        ]),
        ...leaves(P, 'p1', unit('hardwareLimitsDrift.test.mjs'), [
            'D.memory-swap-equal', 'D.cgroupfs-prefix', 'D.exempt-prefix-absent', 'D.readback-mismatch',
            'D.readback-page-rounding', 'D.readback-swap-accounting', 'D.precreate-change', 'D.prepublish-change',
            'D.managed-reuse', 'D.host-none-reuse', 'D.graph-reuse',
            'D.llm-admitted-policy-reuse', 'D.one-replace-then-reuse', 'D.unrelated-token-no-replace',
            'D.unprepared-empty-hash', 'D.private-mount-boundaries', 'D.interactive-reuse-refused',
            'D.interactive-create-refused', 'D.memory-only-change-replaces-one', 'D.pids-only-change-replaces-one',
        ]),
        ...leaves(L, 'p1-ram', 'local-llm/tests/ploinky-budget.test.mjs', [
            'LL.raw-cpu-fractions', 'LL.cpu-warning-provenance', 'LL.cap-once', 'LL.known-zero', 'LL.unknown-distinct',
            'LL.guard-read-failure', 'LL.unlimited-golden', 'LL.unified-physical-denominator',
        ]),
        ...leaves(L, 'p1-ram', 'local-llm/tests/ploinky-budget-admission.test.mjs', [
            'LL.controller-zero-no-launch', 'LL.controller-unknown-no-launch', 'LL.controller-release-retry',
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
        ]),
        ...leaves(P, 'p2', unit('workspaceMetricsLimits.test.mjs'), [
            'M.memory-both-halves', 'M.cpu-fraction', 'M.separate-assurance', 'M.inspect-identity-cache',
            'M.no-full-environment', 'M.off-shape',
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
        ...leaves(P, 'p4', unit('hardwareLimitsMps.test.mjs'), [
            'MP.disabled-bytes', 'MP.tools-not-cdi', 'MP.both-tools-ro', 'MP.tool-only-fingerprint',
            'MP.missing-tools-ordinary-grant', 'MP.uid-predicate', 'MP.network-predicate', 'MP.cold-image',
            'MP.immutable-image', 'MP.gb10-numeric-memory', 'MP.unknown-model', 'MP.control-readback',
            'MP.control-malformed', 'MP.timeout',
        ]),
        ...leaves(P, 'p4', unit('hardwareLimitsMpsLifecycle.test.mjs'), [
            'MPL.first-apply', 'MPL.unchanged-reuse', 'MPL.own-share-only', 'MPL.full-cohort-drain-before-quit',
            'MPL.final-apply-clear', 'MPL.final-host-clear-restart', 'MPL.daemon-loss', 'MPL.core-crash-journal',
            'MPL.partial-retry', 'MPL.no-unrelated-stop', 'MPL.lock-reuse', 'MPL.generation-drift',
        ]),
        ...leaves(L, 'p5', 'local-llm/tests/ploinky-budget.test.mjs', [
            'LL.vllm-qualification-absent', 'LL.vllm-qualification-mismatch', 'LL.vllm-qualification-match',
            'LL.vllm-six-three-two', 'LL.vllm-over-cap-incompatible', 'LL.vllm-free-shortage-temporary',
            'LL.ollama-pinned-over-cap', 'LL.ollama-auto-free', 'LL.gpu-minimal-env-all-adapters', 'LL.cpu-no-mps-env',
            'LL.partial-mps-refused', 'LL.unified-share-refused', 'LL.gpu-unlimited-golden',
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
    knownBaselineFailures = new Set(),
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
        const testId = `${entry.file}::${entry.name}`;
        const observed = leafResults.get(testId);
        let result = 'missing';
        let reason = 'required leaf was not discovered';
        if (observed) {
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
    for (const [testId, { result, record }] of leafResults) {
        if (result !== 'fail') continue;
        if (knownBaselineFailures.has(testId)) baselineFailures.push({ testId, message: record.payload.error?.message || '' });
        else newFailures.push({ testId, message: record.payload.error?.message || '' });
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

export function evaluateGpuIdleGate({
    query,
    activity,
    owned = [],
    observe = () => null,
    bootId,
    boxCgroupPrefix,
    initial = false,
} = {}) {
    const parsed = parseComputePidQuery(query);
    if (!parsed.ok) return { state: 'blocked', reason: parsed.reason };
    if (!activity || activity.supported !== true) return { state: 'blocked', reason: 'activity_unknown' };
    if (Array.isArray(activity.foreign) && activity.foreign.length) {
        return { state: 'blocked', reason: 'gpu_busy', foreign: [...activity.foreign] };
    }
    if (initial) {
        return parsed.pids.length
            ? { state: 'blocked', reason: 'gpu_busy', foreign: parsed.pids }
            : { state: 'idle' };
    }
    const verified = new Set();
    for (const record of owned) {
        if (!verifyOwnedGpuProcess(record, observe(record.hostPid), { bootId, boxCgroupPrefix })) {
            // Provenance could not be proved: exclude nothing and block.
            return { state: 'blocked', reason: 'owned_provenance_unproved', hostPid: record?.hostPid ?? null };
        }
        verified.add(record.hostPid);
    }
    return classifyGpuPidSet(parsed.pids, verified);
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
    exactKeys(value, [
        'schema', 'runId', 'configDigest', 'casesDigest', 'block', 'target', 'state', 'workspace', 'ports',
        'deadlines', 'images', 'ownedBoxes', 'ownedProcesses', 'ownedPaths', 'preInventory', 'operations', 'cleanup',
    ], [], label);
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
