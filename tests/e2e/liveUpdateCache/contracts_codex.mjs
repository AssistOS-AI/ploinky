import { isDeepStrictEqual } from 'node:util';

export const PHASE_CAPS_MS = Object.freeze({
    U0: 300000, U1: 180000, U2: 300000, U3: 600000,
    U4: 1320000, U5: 840000, U6: 3300000, U7: 1320000,
    U7b: 600000, U7c: 1800000, U8: 1800000, U9: 600000,
});
export const REQUIRED_PHASES = Object.freeze(Object.keys(PHASE_CAPS_MS));
export const REQUIRED_GATES = Object.freeze(['Copilot', 'OnlyOffice', 'WebMeet']);
export const TOTAL_CAP_MS = Object.values(PHASE_CAPS_MS).reduce((sum, value) => sum + value, 0);
export const BOX_MAX_AGE_MS = 1800000;
export const IMAGE_MAX_AGE_MS = 14400000;

function need(condition, code) {
    if (!condition) {
        const error = new Error(code);
        error.code = code;
        throw error;
    }
}

const integer = value => Number.isSafeInteger(value) && value >= 0;
const word = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,511}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const absolutePath = value => typeof value === 'string' && value.startsWith('/') && value.length <= 4096
    && !/[\0\r\n]/.test(value) && !value.split('/').some(part => part === '.' || part === '..');

function exactObject(value, keys, code) {
    need(value && Object.getPrototypeOf(value) === Object.prototype, code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    need(Reflect.ownKeys(descriptors).length === keys.length && keys.every(key => descriptors[key]
        && Object.hasOwn(descriptors[key], 'value')), code);
}

function date(value) {
    const match = typeof value === 'string' && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/.exec(value);
    need(match, 'timestamp-invalid');
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    need(month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
        && hour <= 23 && minute <= 59 && second <= 59, 'timestamp-invalid');
    if (match[7] !== 'Z') {
        const offsetHour = Number(match[7].slice(1, 3)), offsetMinute = Number(match[7].slice(4, 6));
        need(offsetHour <= 14 && offsetMinute <= 59 && (offsetHour !== 14 || offsetMinute === 0), 'timestamp-invalid');
    }
    const result = Date.parse(value);
    need(Number.isFinite(result), 'timestamp-invalid');
    return result;
}

export function assertRequiredPhases(phases) {
    need(Array.isArray(phases) && isDeepStrictEqual(phases, REQUIRED_PHASES), 'required-phases-invalid');
    return true;
}

export function assertPhaseReceipts({ runId, receipts }) {
    need(word(runId) && Array.isArray(receipts) && receipts.length === REQUIRED_PHASES.length, 'phase-receipts-incomplete');
    let previousFinish = 0;
    for (let index = 0; index < receipts.length; index += 1) {
        const receipt = receipts[index];
        need(receipt?.phase === REQUIRED_PHASES[index] && receipt.runId === runId
            && receipt.status === 'PASS' && receipt.closed === true && receipt.uncertain === false
            && integer(receipt.startedMs) && integer(receipt.finishedMs) && receipt.startedMs >= previousFinish
            && receipt.finishedMs >= receipt.startedMs
            && receipt.finishedMs - receipt.startedMs <= PHASE_CAPS_MS[receipt.phase]
            && hash(receipt.evidenceSha256), 'phase-receipt-invalid');
        previousFinish = receipt.finishedMs;
    }
    need(previousFinish - receipts[0].startedMs <= TOTAL_CAP_MS, 'acceptance-budget-expired');
    return true;
}

export function admitRemainingSchedule({ firstPhase, remainingMs, finalReserveMs = 0 }) {
    const index = REQUIRED_PHASES.indexOf(firstPhase);
    need(index >= 0 && integer(remainingMs) && integer(finalReserveMs), 'schedule-invalid');
    const requiredMs = REQUIRED_PHASES.slice(index).reduce((sum, phase) => sum + PHASE_CAPS_MS[phase], finalReserveMs);
    need(Number.isSafeInteger(requiredMs) && remainingMs >= requiredMs, 'schedule-insufficient');
    return requiredMs;
}

export function admitCanonicalFreshness({ nowMs, boxStartedAt, imageCreatedAt, remainingWorkMs, enforceImageAge = true }) {
    need(integer(nowMs) && integer(remainingWorkMs) && typeof enforceImageAge === 'boolean', 'freshness-input-invalid');
    const boxAge = nowMs - date(boxStartedAt);
    need(boxAge >= 0 && boxAge + remainingWorkMs <= BOX_MAX_AGE_MS, 'box-freshness-insufficient');
    if (enforceImageAge) {
        const imageAge = nowMs - date(imageCreatedAt);
        need(imageAge >= 0 && imageAge + remainingWorkMs <= IMAGE_MAX_AGE_MS, 'image-freshness-insufficient');
    }
    return true;
}

function candidate(value) {
    exactObject(value, ['imageId', 'repositories'], 'candidate-invalid');
    need(hash(value.imageId) && Array.isArray(value.repositories) && value.repositories.length > 0
        && value.repositories.length <= 128, 'candidate-invalid');
    const names = new Set();
    for (const repo of value.repositories) {
        exactObject(repo, ['name', 'commit', 'pushedCommit', 'branch', 'upstream', 'clean', 'detached'], 'repository-invalid');
        need(word(repo.name) && !names.has(repo.name) && commit(repo.commit) && repo.commit === repo.pushedCommit
            && word(repo.branch) && repo.upstream === `origin/${repo.branch}`
            && repo.clean === true && repo.detached === false, 'repository-not-pinned');
        names.add(repo.name);
    }
    return { imageId: value.imageId, repositories: [...value.repositories].sort((a, b) => a.name.localeCompare(b.name)) };
}

export function assertSameCandidate(expected, observed) {
    need(isDeepStrictEqual(candidate(expected), candidate(observed)), 'candidate-epoch-mismatch');
    return true;
}

export function assertLiveBefore({ expected, observed }) {
    exactObject(expected, ['workspace', 'box', 'candidate', 'requiredGraph', 'publications', 'sourceMounts', 'engineIdentity', 'activeGeneration'], 'live-expectation-invalid');
    const expectedCandidate = candidate(expected.candidate);
    exactObject(expected.workspace, ['path', 'dev', 'ino', 'uid'], 'workspace-binding-invalid');
    need(absolutePath(expected.workspace.path) && /^\/(?:[^/]+\/)*work\/testExplorerFresh$/.test(expected.workspace.path)
        && !expected.workspace.path.split('/').some(part => part === '.' || part === '..')
        && ['dev', 'ino', 'uid'].every(key => integer(expected.workspace[key]))
        && expected.workspace.ino > 0 && expected.workspace.uid > 0, 'workspace-binding-invalid');
    exactObject(expected.box, ['id', 'imageId', 'startedAt'], 'box-binding-invalid');
    need(hash(expected.box.id) && hash(expected.box.imageId) && expected.box.imageId === expectedCandidate.imageId,
        'box-binding-invalid');
    date(expected.box.startedAt);
    need(word(expected.publications) && word(expected.sourceMounts) && word(expected.engineIdentity)
        && word(expected.activeGeneration), 'live-expectation-invalid');
    need(observed?.hostPlatform === 'linux' && observed.engine === 'podman' && observed.rootless === true,
        'runtime-host-unqualified');
    need(observed.running === true && observed.initialized === true && observed.activeGeneration === expected.activeGeneration
        && observed.pendingActivation === false && observed.recoveryBarrier === false, 'workspace-not-live');
    need(isDeepStrictEqual(observed.workspace, expected.workspace) && isDeepStrictEqual(observed.box, expected.box)
        && observed.publications === expected.publications && observed.sourceMounts === expected.sourceMounts
        && observed.engineIdentity === expected.engineIdentity, 'live-binding-mismatch');
    assertSameCandidate(expected.candidate, observed.candidate);
    need(Array.isArray(expected.requiredGraph) && expected.requiredGraph.length > 0 && Array.isArray(observed.graph)
        && observed.graph.length === expected.requiredGraph.length, 'graph-invalid');
    const declared = new Set();
    for (const policy of expected.requiredGraph) {
        exactObject(policy, ['name', 'noWait', 'externalHealthRequired'], 'graph-policy-invalid');
        need(word(policy.name) && !declared.has(policy.name) && typeof policy.noWait === 'boolean'
            && typeof policy.externalHealthRequired === 'boolean', 'graph-policy-invalid');
        declared.add(policy.name);
    }
    const names = new Set();
    for (const entry of observed.graph) {
        need(word(entry.name) && !names.has(entry.name), 'graph-invalid');
        names.add(entry.name);
    }
    for (const policy of expected.requiredGraph) {
        const entry = observed.graph.find(item => item.name === policy.name);
        need(entry && entry.graphGeneration === expected.activeGeneration && entry.running === true
            && word(entry.runtimeId) && word(entry.instanceId) && word(entry.enableGeneration)
            && (!policy.externalHealthRequired || entry.externalHealth === true) && entry.ready === true
            && (!policy.noWait || entry.noWaitState === 'running'), 'graph-not-ready');
    }
    return true;
}

function cacheSnapshot(value) {
    exactObject(value, ['runtimeId', 'instanceId', 'enableGeneration', 'objectId', 'selectorId', 'payloadSha256'], 'cache-snapshot-invalid');
    need(['runtimeId', 'instanceId', 'enableGeneration', 'objectId', 'selectorId'].every(key => word(value[key]))
        && hash(value.payloadSha256), 'cache-snapshot-invalid');
    return value;
}

export function assertWarmReuse(before, after) {
    need(isDeepStrictEqual(cacheSnapshot(before), cacheSnapshot(after)), 'warm-reuse-mismatch');
    return true;
}

export function assertDependencyReplacement({ before, after, expectedA, expectedB, predecessor }) {
    need(commit(expectedA.commit) && commit(expectedB.commit) && expectedA.commit !== expectedB.commit
        && hash(expectedA.markerSha256) && hash(expectedB.markerSha256)
        && expectedA.markerSha256 !== expectedB.markerSha256, 'fixture-replacement-invalid');
    need(word(before.version) && before.version === after.version && word(before.objectId)
        && word(after.objectId) && before.objectId !== after.objectId
        && before.payloadSha256 !== after.payloadSha256, 'replacement-not-observed');
    for (const [value, expected] of [[before, expectedA], [after, expectedB]]) {
        need(value.sourceCommit === expected.commit && value.lockCommit === expected.commit
            && value.provenanceCommit === expected.commit && value.markerSha256 === expected.markerSha256
            && hash(value.payloadSha256), 'installed-replacement-mismatch');
    }
    if (predecessor !== null) need(predecessor?.objectId === before.objectId
        && predecessor.payloadSha256 === before.payloadSha256, 'predecessor-mutated');
    return true;
}

function reader(value) {
    exactObject(value, ['live', 'runtimeId', 'instanceId', 'enableGeneration', 'objectId', 'mountSource',
        'mountReadOnly', 'readerReceipt', 'payloadSha256'], 'reader-proof-invalid');
    need(value.live === true && value.mountReadOnly === true && hash(value.payloadSha256)
        && ['runtimeId', 'instanceId', 'enableGeneration', 'objectId'].every(key => word(value[key]))
        && absolutePath(value.mountSource),
    'reader-not-live');
    exactObject(value.readerReceipt, ['runtimeId', 'instanceId', 'enableGeneration', 'objectId'], 'reader-receipt-invalid');
    need(['runtimeId', 'instanceId', 'enableGeneration', 'objectId'].every(key => value.readerReceipt[key] === value[key]),
        'reader-receipt-mismatch');
    return value;
}

export function assertRetainedReader({ before, during, after, gc }) {
    need(isDeepStrictEqual(reader(before), reader(during)) && isDeepStrictEqual(reader(before), reader(after)),
        'reader-changed-during-gc');
    need(gc?.outcome === 'collected' && gc.engineKnown === true && gc.registryKnown === true
        && gc.writersKnown === true && gc.selectedReaderProtected === true
        && gc.selectedObjectId === before.objectId && integer(gc.retainedCount) && gc.retainedCount > 0,
    'ordinary-gc-not-proven');
    return true;
}

export function assertOptionalFailureActivation({ exitCode, beforeGeneration, afterGeneration, activation, graphReady, writerQuiescent }) {
    need(exitCode === 1 && word(beforeGeneration) && word(afterGeneration) && beforeGeneration !== afterGeneration
        && activation === 'restarted' && graphReady === true && writerQuiescent === true, 'optional-live-activation-missing');
    return true;
}

export function assertDeferredFailure({ exitCode, beforeGeneration, afterGeneration, activation, pending, writerQuiescent }) {
    need(exitCode === 1 && word(beforeGeneration) && beforeGeneration === afterGeneration
        && activation === 'deferred' && pending === true && writerQuiescent === true, 'required-deferral-missing');
    return true;
}

export function assertFunctionalToReleaseBoundary({ functional, release }) {
    need(functional?.complete === true && functional.writerQuiescent === true && functional.cleanupComplete === true
        && functional.copiesVerified === true && functional.browserGateCredit === 0, 'functional-epoch-unsettled');
    need(release?.fresh === true && release.workspaceRecreated === true && word(functional.boxId) && word(release.boxId)
        && functional.boxId !== release.boxId && date(release.startedAt) > date(functional.finishedAt)
        && word(functional.workspaceIdentity) && word(release.workspaceIdentity)
        && functional.workspaceIdentity !== release.workspaceIdentity, 'release-fixture-not-fresh');
    assertSameCandidate(functional.candidate, release.candidate);
    return true;
}

function assertReleaseEpoch(expected, observed) {
    need(word(expected?.boxId) && word(expected.workspaceIdentity), 'release-epoch-invalid');
    date(expected.startedAt);
    need(observed?.boxId === expected.boxId && observed.startedAt === expected.startedAt
        && observed.workspaceIdentity === expected.workspaceIdentity, 'canonical-gate-stale');
    assertSameCandidate(expected.candidate, observed.candidate);
}

export function assertCanonicalGateResults({ release, gates }) {
    need(Array.isArray(gates) && gates.length === REQUIRED_GATES.length, 'canonical-gates-incomplete');
    const runIds = new Set();
    let previousFinish = date(release?.startedAt);
    for (let index = 0; index < gates.length; index += 1) {
        const gate = gates[index];
        need(gate?.name === REQUIRED_GATES[index] && word(gate.runId) && !runIds.has(gate.runId)
            && gate.discovered === 1 && gate.passed === 1 && gate.failed === 0 && gate.skipped === 0
            && gate.retries === 0 && gate.ignoredErrors === 0 && gate.closed === true,
        'canonical-gate-invalid');
        assertReleaseEpoch(release, gate.before);
        assertReleaseEpoch(release, gate.after);
        need(date(gate.startedAt) >= previousFinish && date(gate.finishedAt) >= date(gate.startedAt),
            'canonical-gate-stale');
        previousFinish = date(gate.finishedAt);
        runIds.add(gate.runId);
    }
    return true;
}
