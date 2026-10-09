import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ownedRegistration } from './owned_ids.mjs';
import { AcceptanceError, need, exact, LIMITS, word, absolute, validateManifest, readBoundedDescriptor, parseStrictJson } from './manifest.mjs';

export const OPERATIONS = Object.freeze(['normal-update', 'optional-negative', 'required-negative', 'settling-update']);
const PHASES = new Set(['host-ploinky', 'workspace-ploinky', 'agentlib', 'registered-repository', 'workspace-repository',
    'git-pin', 'default-skills', 'skills-manifest', 'marketplace', 'activation', 'command']);
const OUTCOMES = new Set(['changed', 'unchanged', 'skipped', 'deferred', 'failed', 'uncertain']);
const tuple = record => ({ phase: record.phase, id: record.id, outcome: record.outcome, required: record.required, code: record.code });
const sorted = rows => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const ADMITTED_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,200}$/;
// `admitted` is the vocabulary observed in the live deployment immediately before the update (git-pin ids, enabled
// registration keys, registered repository names); `lenient` checks only the shape of an operator file read before that
// observation exists. Neither relaxes exactness: the record set must still equal the update's records, with the
// expected errors and blockers exactly as stated.
export function validateExpectation(expected, manifest, { admitted = [], lenient = false } = {}) {
    exact(expected, ['errors', 'blockedBy', 'recordIds']);
    need(Array.isArray(admitted) && admitted.length <= 4096 && admitted.every(id => typeof id === 'string' && ADMITTED_ID.test(id)), 'update-expectation');
    const ids = new Set(['ploinky', 'achillesAgentLib', 'workspace-graph', 'update', 'update-transaction', 'host-ploinky',
        manifest.candidate.root, manifest.workspace.path, ...manifest.candidate.repositories.flatMap(repo => [repo.name, repo.path]),
        ...manifest.graph.map(entry => entry.name), ...admitted]);
    // The run's own repository record and the Git-pin record of its one dependency are expected in every real update.
    const owned = ownedRegistration(manifest); ids.add(owned.repoName); ids.add(owned.pinId);
    const scenario = manifest.negativeScopes.optional;
    for (const name of ['10-bad', '20-branch', '30-origin', '40-prune', '90-good']) ids.add(path.join(scenario, name));
    for (const [index, name] of ['detached', 'staged', 'unstaged', 'diverged', 'collision', 'branch', 'origin', 'later'].entries()) {
        ids.add(`${index === 7 ? 'ZZ' : 'AA'}UpdateE2E${index}-${name}-${manifest.runId}`);
    }
    // A default-skills record is named `<source repository>-><target repository>` over two known repositories.
    const skillsPair = id => { const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)->([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(id); return Boolean(match) && ids.has(match[1]) && ids.has(match[2]); };
    need(Array.isArray(expected.errors) && Array.isArray(expected.blockedBy) && Array.isArray(expected.recordIds)
        && expected.recordIds.length > 0 && expected.recordIds.length <= 1024 && new Set(expected.recordIds).size === expected.recordIds.length
        && expected.recordIds.every(id => ((word(id) || absolute(id)) && (ids.has(id) || (lenient && (ADMITTED_ID.test(id) || absolute(id))))) || skillsPair(id) || (lenient && /^[A-Za-z0-9][A-Za-z0-9._-]*->[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))), 'update-expectation');
    for (const row of [...expected.errors, ...expected.blockedBy]) {
        exact(row, ['phase', 'id', 'outcome', 'required', 'code']);
        need(PHASES.has(row.phase) && expected.recordIds.includes(row.id) && OUTCOMES.has(row.outcome) && row.outcome !== 'uncertain'
            && [true, false, null].includes(row.required) && typeof row.code === 'string' && row.code.length <= 96
            && (row.code === '' || /^[A-Za-z][A-Za-z0-9_-]*$/.test(row.code)) && !/^[a-f0-9]{24,}$/i.test(row.code), 'update-expectation-record');
    }
}

export function updateArguments(manifest, operation) {
    need(OPERATIONS.includes(operation), 'update-operation');
    return ['optional-negative', 'required-negative'].includes(operation)
        ? ['update', 'all', manifest.negativeScopes[operation === 'optional-negative' ? 'optional' : 'required']] : ['update'];
}

export function createStopLatch() {
    let reason = null;
    return Object.freeze({ stop(code) { reason ??= code; }, assertMayLaunch() { need(reason === null, 'launch-after-uncertainty'); },
        snapshot: () => ({ uncertain: reason !== null, reason }) });
}
const custodians = new WeakSet();
export function createOwnedCustody() {
    const records = [];
    const custody = Object.freeze({ retain(child, { operation, runId }) { records.push({ child, operation, runId, settled: false }); },
        settled(child) { const record = records.find(row => row.child === child); if (record) record.settled = true; },
        handles: () => records.map(row => row.child),
        snapshot: () => records.map(row => ({ pid: row.child?.pid ?? null, operation: row.operation, runId: row.runId, settled: row.settled })) });
    custodians.add(custody); return custody;
}

export function createDiscardOutput(maxBytes = LIMITS.outputBytes) {
    need(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= LIMITS.outputBytes, 'output-cap');
    let bytes = 0, failure = null;
    const write = chunk => { if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') { failure ??= 'output-shape'; return false; }
        bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + Buffer.byteLength(chunk)); if (bytes > maxBytes) failure ??= 'output-overflow'; return !failure; };
    return { output: { write }, errorOutput: { write }, snapshot: () => ({ bytes, failure }) };
}

export function projectNormalUpdate(observation, { manifest, operation, returnedCode, expected, admitted = [] }) {
    need(observation && !Object.hasOwn(observation, 'error') && observation.result, 'update-callback-error');
    validateExpectation(expected, manifest, { admitted });
    const result = observation.result;
    need(result.schema === 'ploinky-update-result' && result.version === 1 && Array.isArray(result.records)
        && result.records.length > 0 && result.records.length <= 1024 && isDeepStrictEqual(result.command, updateArguments(manifest, operation)), 'update-result-shape');
    const ids = new Set(expected.recordIds), seen = new Set(), records = [];
    for (const record of result.records) {
        need(record && PHASES.has(record.phase) && ids.has(record.id) && OUTCOMES.has(record.outcome)
            && [true, false, null].includes(record.required) && typeof record.code === 'string' && record.code.length <= 96
            && (record.code === '' || /^[A-Za-z][A-Za-z0-9_-]*$/.test(record.code)) && !/^[a-f0-9]{24,}$/i.test(record.code), 'update-record');
        const key = `${record.phase}:${record.id}`; need(!seen.has(key), 'update-record-duplicate'); seen.add(key);
        need(record.outcome !== 'uncertain', 'update-writer-uncertain'); records.push(tuple(record));
    }
    need(isDeepStrictEqual([...new Set(records.map(row => row.id))].sort(), [...expected.recordIds].sort()), 'update-records-incomplete');
    const errors = records.filter(record => record.outcome === 'failed');
    const blockedBy = records.filter(record => record.required !== false && !['changed', 'unchanged'].includes(record.outcome));
    const activationAllowed = blockedBy.length === 0, exitCode = errors.length || blockedBy.length ? 1 : 0;
    const status = exitCode ? activationAllowed ? 'partial' : 'failed' : records.some(record => !['changed', 'unchanged'].includes(record.outcome)) ? 'complete-with-skips' : 'complete';
    need(returnedCode === exitCode && result.exitCode === exitCode && result.activationAllowed === activationAllowed && result.status === status
        && observation.failed === (exitCode !== 0), 'update-return-disagreement');
    need(isDeepStrictEqual(sorted(errors), sorted(expected.errors)) && isDeepStrictEqual(sorted(blockedBy), sorted(expected.blockedBy)), 'update-unexpected-records');
    need(isDeepStrictEqual(sorted(result.errors), sorted(errors.map(({ required: _required, ...row }) => row)))
        && isDeepStrictEqual(sorted(result.blockedBy), sorted(blockedBy.map(({ required: _required, ...row }) => row))), 'update-derived-records');
    const negative = ['optional-negative', 'required-negative'].includes(operation);
    need(exitCode === (negative ? 1 : 0) && (negative || (expected.errors.length === 0 && expected.blockedBy.length === 0)), 'update-expected-exit');
    const scoped = negative ? manifest.negativeScopes[operation === 'optional-negative' ? 'optional' : 'required'] : null;
    const context = result.context;
    need(context?.schema === 'ploinky-update-context' && context.version === 1 && context.workspace?.instance === manifest.workspace.instance
        && context.workspace.workspaceRoot === manifest.workspace.path && context.request?.kind === 'all'
        && context.request.folder === scoped && context.request.folderPath === scoped
        && (scoped ? context.scope?.relative === scoped.slice(manifest.workspace.path.length + 1) && context.scope.boxPath === scoped : context.scope === null)
        && context.box?.containerId === manifest.box.id && context.box.engine === manifest.engine.identity
        && [manifest.box.imageId, `sha256:${manifest.box.imageId}`].includes(context.box.imageId), 'update-context-mismatch');
    const outcome = operation === 'required-negative' ? 'deferred' : 'restarted';
    need(result.activation?.outcome === outcome && observation.activation?.outcome === outcome
        && result.activation.activationAllowed === activationAllowed, 'update-activation-unproven');
    return { executionInterface: 'outer-cli-api', operation, fulfilled: true, returnedCode, callbackCount: 1,
        productWriterQuiescence: 'source-bound-normal-return', graphReadiness: 'UNPROVEN',
        result: { schema: result.schema, version: result.version, status, exitCode, activationAllowed, records,
            activation: { outcome }, context: { workspaceEqual: true, requestEqual: true, scopeEqual: true, boxEqual: true, engineEqual: true, imageEqual: true } } };
}

export async function invokeOuterApi({ manifest, operation, expected, admitted = [] }, { runOuterCli, output = createDiscardOutput(), latch = createStopLatch() }) {
    validateManifest(manifest); validateExpectation(expected, manifest, { admitted }); updateArguments(manifest, operation); latch.assertMayLaunch();
    manifest = structuredClone(manifest); expected = structuredClone(expected); admitted = structuredClone(admitted);
    need(typeof runOuterCli === 'function', 'runtime-adapters-unqualified');
    let count = 0, observation;
    const onUpdateResult = value => { count++; if (count === 1) observation = value; else latch.stop('update-callback-duplicate'); };
    try {
        // These are the only options: supervisor, engine, execution, source update and relaunch remain actual API defaults.
        const boundedStream = stream => ({ write(chunk) { const accepted = stream.write(chunk); if (output.snapshot().failure) latch.stop('output-overflow'); return accepted; } });
        const returnedCode = await runOuterCli(updateArguments(manifest, operation), { output: boundedStream(output.output), errorOutput: boundedStream(output.errorOutput), onUpdateResult });
        need(count === 1, count > 1 ? 'update-callback-duplicate' : 'update-callback-missing'); need(!output.snapshot().failure, 'output-overflow'); latch.assertMayLaunch();
        return { ...projectNormalUpdate(observation, { manifest, operation, returnedCode, expected, admitted }), output: output.snapshot() };
    } catch (error) { const code = error instanceof AcceptanceError ? error.code : 'update-api-exception'; latch.stop(code); throw new AcceptanceError(code); }
    finally { observation = null; }
}

// A descriptor pin does not bind Node's subsequent ESM path load or its dependency closure.
// Keep the actual import unavailable until that existing-module execution binding is independently qualified.
export async function loadPinnedOuterApi(manifest, { io = fs } = {}) {
    validateManifest(manifest);
    const filename = manifest.candidate.apiPath;
    need(io.realpathSync(filename) === filename, 'runtime-source-alias');
    const fd = io.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const before = io.fstatSync(fd); need(before.isFile() && before.size <= LIMITS.readBytes, 'runtime-source-shape');
        const bytes = readBoundedDescriptor(fd, LIMITS.readBytes, io), after = io.fstatSync(fd);
        need(before.dev === after.dev && before.ino === after.ino && before.size === after.size && bytes.length === before.size
            && createHash('sha256').update(bytes).digest('hex') === manifest.candidate.apiSha256, 'runtime-source-pin');
    } finally { io.closeSync(fd); }
    throw new AcceptanceError('runtime-import-binding-unproven');
}

function immutableSnapshot(value) {
    const copy = structuredClone(value);
    const freeze = item => { if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); } };
    freeze(copy); return copy;
}

export async function superviseOwnedUpdate({ manifest, operation, workerPath, workerInputPath, expected, admitted = [] }, adapters) {
    validateManifest(manifest); updateArguments(manifest, operation); validateExpectation(expected, manifest, { admitted });
    manifest = immutableSnapshot(manifest); expected = immutableSnapshot(expected);
    need(workerPath === path.join(manifest.candidate.root, 'tests/e2e/liveUpdateCache/execution.mjs')
        && workerInputPath === path.join(manifest.evidence.root, `${operation}_input_codex.json`), 'worker-fixed-paths');
    const { launch, register, current, now, delay, latch, custody } = adapters;
    need([launch, register, current, now, delay].every(value => typeof value === 'function') && latch && custodians.has(custody), 'ownership-adapters-unqualified');
    latch.assertMayLaunch();
    const deadline = now() + LIMITS.commandMs; let child, registration = null, closed = false, code = null, signal = null, result = null;
    const checkDeadline = () => need(now() < deadline, 'worker-deadline');
    let controlBytes = 0, control = Buffer.alloc(0), firstFailure = null;
    const streams = { stdout: { ended: false, closed: false }, stderr: { ended: false, closed: false }, control: { ended: false, closed: false } };
    const discarded = createDiscardOutput();
    const fail = reason => { firstFailure ??= reason; latch.stop(reason); };
    try {
        checkDeadline();
        child = launch(manifest.host.node.path, [workerPath, '--owned-update', workerInputPath, operation], {
            cwd: manifest.workspace.path, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
        custody.retain(child, { operation, runId: manifest.runId });
        // Keep the exact returned handle and observers before any fallible registration.
        child.on('error', () => fail('worker-error'));
        child.on('close', (exitCode, exitSignal) => { closed = true; code = exitCode; signal = exitSignal; });
        for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr], ['control', child.stdio?.[3]]]) {
            need(stream?.on, 'worker-channel-missing');
            stream.on('error', () => fail('worker-pipe-error'));
            stream.on('end', () => { streams[name].ended = true; }); stream.on('close', () => { streams[name].closed = true; });
            stream.on('data', chunk => {
                if (name !== 'control') { discarded.output.write(chunk); if (discarded.snapshot().failure) fail('output-overflow'); return; }
                controlBytes = Math.min(Number.MAX_SAFE_INTEGER, controlBytes + chunk.length);
                if (controlBytes > LIMITS.controlBytes) { control = Buffer.alloc(0); fail('worker-control-overflow'); return; }
                if (!firstFailure) control = Buffer.concat([control, chunk]);
            });
        }
        registration = register(child, { operation, runId: manifest.runId });
        checkDeadline();
        while (!closed) { if (now() >= deadline || firstFailure) { fail(firstFailure ?? 'worker-deadline'); break; } await delay(10); checkDeadline(); }
        const closeDeadline = Math.min(deadline, now() + LIMITS.closeMs);
        while ((!closed || !Object.values(streams).every(value => value.ended && value.closed)) && now() < closeDeadline) { await delay(10); checkDeadline(); }
        checkDeadline();
        need(closed && Object.values(streams).every(value => value.ended && value.closed), 'worker-close-unproven');
        need(current(registration) === null && signal === null && [0, 1, 2].includes(code), 'worker-incarnation-unsettled');
        checkDeadline();
        need(!firstFailure && !latch.snapshot().uncertain, firstFailure ?? 'worker-uncertain');
        let frame; try { frame = parseStrictJson(control, LIMITS.controlBytes); } catch { throw new AcceptanceError('worker-control-json'); }
        if (frame?.type === 'WORKER_FAILURE') {
            // A settled worker may report one fixed lowercase reason; it is never a pass and keeps the run latched.
            exact(frame, ['type', 'runId', 'operation', 'reason'], 'worker-result-binding');
            need(code === 2 && frame.runId === manifest.runId && frame.operation === operation && typeof frame.reason === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(frame.reason), 'worker-result-binding');
            throw new AcceptanceError(`worker-${frame.reason}`);
        }
        need([0, 1].includes(code), 'worker-incarnation-unsettled');
        exact(frame, ['type', 'runId', 'operation', 'proof']);
        need(frame.type === 'UPDATE_RESULT' && frame.runId === manifest.runId && frame.operation === operation
            && frame.proof?.fulfilled === true && frame.proof.callbackCount === 1 && frame.proof.returnedCode === code
            && frame.proof.executionInterface === 'outer-cli-api' && frame.proof.operation === operation, 'worker-result-binding');
        result = validatePublicWorkerProof(frame.proof, { operation, returnedCode: code, expected });
        need(result.output.bytes + discarded.snapshot().bytes <= LIMITS.outputBytes, 'output-overflow');
        checkDeadline();
        custody.settled(child);
        return { ...result, childClosed: true, pipesClosed: true, bytes: discarded.snapshot().bytes, controlBytes, uncertain: false };
    } catch (error) {
        const reason = error instanceof AcceptanceError ? error.code : 'worker-setup-failed'; fail(reason);
        return { executionInterface: 'outer-cli-api', operation, passed: false, reason, uncertain: true, resourceDisposition: 'HANDOFF_REQUIRED',
            retained: { pid: child?.pid ?? null, registered: registration !== null, childClosed: closed, pipesClosed: Object.values(streams).every(value => value.ended && value.closed) } };
    } finally { control.fill(0); control = Buffer.alloc(0); result = null; }
}

export function validatePublicWorkerProof(proof, { operation, returnedCode, expected }) {
    exact(proof, ['executionInterface', 'operation', 'fulfilled', 'returnedCode', 'callbackCount', 'productWriterQuiescence', 'graphReadiness', 'result', 'output']);
    exact(proof.result, ['schema', 'version', 'status', 'exitCode', 'activationAllowed', 'records', 'activation', 'context']);
    exact(proof.result.context, ['workspaceEqual', 'requestEqual', 'scopeEqual', 'boxEqual', 'engineEqual', 'imageEqual']);
    exact(proof.result.activation, ['outcome']); exact(proof.output, ['bytes', 'failure']);
    need(proof.executionInterface === 'outer-cli-api' && proof.operation === operation && proof.fulfilled === true && proof.callbackCount === 1
        && proof.returnedCode === returnedCode && proof.productWriterQuiescence === 'source-bound-normal-return' && proof.graphReadiness === 'UNPROVEN'
        && Object.values(proof.result.context).every(value => value === true) && proof.output.failure === null
        && Number.isSafeInteger(proof.output.bytes) && proof.output.bytes >= 0 && proof.output.bytes <= LIMITS.outputBytes, 'worker-public-proof');
    const records = proof.result.records;
    const seen = new Set();
    need(Array.isArray(records) && records.length > 0 && records.length <= 1024, 'worker-public-records');
    for (const record of records) { exact(record, ['phase', 'id', 'outcome', 'required', 'code']);
        need(PHASES.has(record.phase) && expected.recordIds.includes(record.id) && OUTCOMES.has(record.outcome) && record.outcome !== 'uncertain'
            && [true, false, null].includes(record.required) && typeof record.code === 'string' && record.code.length <= 96
            && (record.code === '' || /^[A-Za-z][A-Za-z0-9_-]*$/.test(record.code)) && !/^[a-f0-9]{24,}$/i.test(record.code), 'worker-public-record');
        const key = `${record.phase}:${record.id}`; need(!seen.has(key), 'worker-public-record-duplicate'); seen.add(key);
    }
    need(isDeepStrictEqual([...new Set(records.map(row => row.id))].sort(), [...expected.recordIds].sort()), 'worker-public-records-incomplete');
    const errors = records.filter(record => record.outcome === 'failed');
    const blocked = records.filter(record => record.required !== false && !['changed', 'unchanged'].includes(record.outcome));
    const allowed = blocked.length === 0, exit = errors.length || blocked.length ? 1 : 0;
    need(proof.result.schema === 'ploinky-update-result' && proof.result.version === 1 && proof.result.exitCode === exit && returnedCode === exit
        && exit === (['optional-negative', 'required-negative'].includes(operation) ? 1 : 0) && proof.result.activationAllowed === allowed
        && proof.result.status === (exit ? allowed ? 'partial' : 'failed' : records.some(row => !['changed', 'unchanged'].includes(row.outcome)) ? 'complete-with-skips' : 'complete')
        && isDeepStrictEqual(sorted(errors), sorted(expected.errors)) && isDeepStrictEqual(sorted(blocked), sorted(expected.blockedBy))
        && proof.result.activation.outcome === (operation === 'required-negative' ? 'deferred' : 'restarted'), 'worker-public-result');
    return proof;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    // The owned worker entry: all runtime proof and the hooked product import live in worker.mjs.
    const { workerMain } = await import('./worker.mjs');
    process.exitCode = await workerMain(process.argv.slice(2));
}
