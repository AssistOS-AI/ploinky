// Durable gate-on to gate-off downgrade (plan §6.2-§6.4).
//
// Only an actual downgrade of an observed gate-on Box uses this protocol. Each
// effect has a preceding durable intent and a following observation; the
// write barrier freezes policy writes and Apply (never reads, admission or
// watchdog restarts) until the operation commits or rolls back. A fresh
// process recovers from the journal and current observations only; it never
// reuses an earlier process's closures. Once a commit intent is durable,
// recovery completes that result and never chooses the opposite one.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PloinkyBoxError } from './errors.mjs';
import { ensurePrivateDirectory, fsyncDirectory, readPrivateFile, writePrivateFileAtomically } from './privateStateFiles.mjs';
import {
    beginDowngradeBarrier,
    hardwareStateRoot,
    hardwareStorePaths,
    readBarrier,
    removeDowngradeBarrier,
} from '../cli/sandbox/hardwareLimits/store.mjs';

export const JOURNAL_SCHEMA = 'ploinky.hardware-downgrade/v1';
export const JOURNAL_MAX_BYTES = 256 * 1024;
export const SNAPSHOT_MAX_BYTES = 1024 * 1024;
export const GRAPH_RESULT_MAX_BYTES = 64 * 1024;
export const MAX_ATTEMPTS = 8;
export const PHASES = Object.freeze([
    'prepared', 'barrier-installed', 'old-stopped', 'old-absent', 'candidate-created', 'candidate-started',
    'candidate-verified', 'commit-decided', 'host-state-committed', 'committed', 'rollback-started',
    'rollback-verified', 'rolled-back', 'recovery-blocked', 'aborted-by-destroy',
]);
export const TERMINAL_PHASES = Object.freeze(['committed', 'rolled-back', 'aborted-by-destroy']);
const OPERATIONS = ['start', 'restart', 'update', 'bind', 'gpu-grant', 'gpu-revoke'];
const JOURNAL_KEYS = ['schema', 'operationId', 'operation', 'identity', 'owner', 'fromEnabled', 'toEnabled', 'phase',
    'nextAction', 'policyToken', 'old', 'desired', 'attempts', 'hostRecords', 'commitIntent', 'lastProblem'];
const HEX32 = /^[0-9a-f]{32}$/;
const REF = /^sha256-[0-9a-f]{64}$/;
const STATE_FILES = Object.freeze({
    subject: 'hardware transition state',
    stateError: (message, cause) => new PloinkyBoxError(message, { code: 'PLOINKY_BOX_HARDWARE_TRANSITION_INVALID', cause }),
});

export class SimulatedProcessDeath extends Error {
    constructor(boundary) {
        super(`simulated process death at ${boundary}`);
        this.name = 'SimulatedProcessDeath';
        this.boundary = boundary;
    }
}

function transitionError(message, code = 'PLOINKY_BOX_HARDWARE_TRANSITION_FAILED', cause) {
    return new PloinkyBoxError(message, { code, cause });
}

function randomHex() {
    return crypto.randomBytes(16).toString('hex');
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((out, key) => {
            out[key] = canonical(value[key]);
            return out;
        }, {});
    }
    return value;
}

export function digestOf(value) {
    return `sha256-${crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Journal store: ~/.ploinky-box/hardware-limits/INSTANCE/transitions/

export function createTransitionStore({ identity, homeDirectory = os.homedir(), fsApi = fs }) {
    const directory = path.join(hardwareStateRoot(homeDirectory), identity.instance, 'transitions');

    function ensure() {
        fsApi.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
        ensurePrivateDirectory(fsApi, directory, STATE_FILES);
    }

    function journalPath(operationId) {
        if (!HEX32.test(String(operationId))) throw transitionError('transition operation ID is invalid');
        return path.join(directory, `${operationId}.json`);
    }

    function writeJson(target, value, maxBytes) {
        const bytes = `${JSON.stringify(value)}\n`;
        if (Buffer.byteLength(bytes) > maxBytes) throw transitionError(`${path.basename(target)} exceeds ${maxBytes} bytes`);
        ensure();
        writePrivateFileAtomically(fsApi, directory, target, bytes, () => {}, STATE_FILES);
        fsyncDirectory(fsApi, directory);
    }

    function readJson(target, maxBytes, label) {
        const bytes = readPrivateFile(fsApi, target, maxBytes, label, STATE_FILES);
        if (bytes === null) return null;
        return JSON.parse(bytes.toString('utf8'));
    }

    return Object.freeze({
        directory,
        writeJournal(journal) {
            validateJournal(journal, identity);
            writeJson(journalPath(journal.operationId), journal, JOURNAL_MAX_BYTES);
        },
        readJournal(operationId) {
            const value = readJson(journalPath(operationId), JOURNAL_MAX_BYTES, 'Hardware transition journal');
            return value === null ? null : validateJournal(value, identity);
        },
        listPending() {
            let names = [];
            try {
                names = fsApi.readdirSync(directory).filter((name) => /^[0-9a-f]{32}\.json$/.test(name)).sort();
            } catch (error) {
                if (error?.code === 'ENOENT') return [];
                throw error;
            }
            return names.map((name) => this.readJournal(name.slice(0, 32)))
                .filter((journal) => journal && !TERMINAL_PHASES.includes(journal.phase));
        },
        writeSnapshot(value, maxBytes = SNAPSHOT_MAX_BYTES) {
            const ref = digestOf(value);
            writeJson(path.join(directory, `${ref}.json`), value, maxBytes);
            return ref;
        },
        readSnapshot(ref) {
            if (!REF.test(String(ref))) throw transitionError('snapshot reference is invalid', 'PLOINKY_BOX_HARDWARE_RECOVERY_BLOCKED');
            const value = readJson(path.join(directory, `${ref}.json`), SNAPSHOT_MAX_BYTES, 'Hardware transition snapshot');
            if (value === null) throw transitionError(`snapshot ${ref} is missing`, 'PLOINKY_BOX_HARDWARE_RECOVERY_BLOCKED');
            if (digestOf(value) !== ref) throw transitionError(`snapshot ${ref} does not match its digest`, 'PLOINKY_BOX_HARDWARE_RECOVERY_BLOCKED');
            return value;
        },
        // Operation-owned create receipts live beside the journal, never in
        // the transient host-lock directory.
        receiptPath(attemptId) {
            if (!HEX32.test(String(attemptId))) throw transitionError('create attempt ID is invalid');
            ensure();
            return path.join(directory, `${attemptId}.cid`);
        },
        readReceipt(attemptId) {
            try {
                const value = fsApi.readFileSync(this.receiptPath(attemptId), 'utf8').trim();
                return /^[a-f0-9]{12,64}$/.test(value) ? value : null;
            } catch (error) {
                if (error?.code === 'ENOENT') return null;
                throw error;
            }
        },
    });
}

function plain(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateJournal(value, identity = null) {
    if (!plain(value)) throw transitionError('transition journal must be an object');
    const keys = Object.keys(value);
    for (const key of keys) if (!JOURNAL_KEYS.includes(key)) throw transitionError(`transition journal has unknown key '${key}'`);
    for (const key of JOURNAL_KEYS) if (!keys.includes(key)) throw transitionError(`transition journal is missing '${key}'`);
    if (value.schema !== JOURNAL_SCHEMA) throw transitionError('transition journal has an unsupported schema');
    if (!HEX32.test(value.operationId)) throw transitionError('transition journal operation ID is invalid');
    if (!OPERATIONS.includes(value.operation)) throw transitionError('transition journal operation is unsupported');
    if (!PHASES.includes(value.phase)) throw transitionError('transition journal phase is unsupported');
    if (value.fromEnabled !== true || value.toEnabled !== false) throw transitionError('only a gate-on to gate-off downgrade is journaled');
    if (identity && (value.identity?.instance !== identity.instance || value.identity?.pathHash !== identity.pathHash
        || value.identity?.workspaceRoot !== identity.workspaceRoot)) {
        throw transitionError('transition journal belongs to another workspace identity', 'PLOINKY_BOX_HARDWARE_RECOVERY_BLOCKED');
    }
    if (!Array.isArray(value.attempts) || value.attempts.length > MAX_ATTEMPTS) throw transitionError('transition journal attempts are invalid');
    if (!Array.isArray(value.hostRecords) || value.hostRecords.length > 128) throw transitionError('transition journal host records are invalid');
    for (const ref of [value.old?.configurationRef, value.old?.graphRef, value.desired?.configurationRef]) {
        if (!REF.test(String(ref))) throw transitionError('transition journal snapshot reference is invalid');
    }
    if (value.commitIntent !== null && !['desired-off', 'restored-old'].includes(value.commitIntent?.result)) {
        throw transitionError('transition journal commit intent is invalid');
    }
    return value;
}

// ---------------------------------------------------------------------------
// Transaction

/**
 * A downgrade context bundles the durable store, the effects that act on the
 * engine and host records, and the policy store paths. `faults` (tests only)
 * injects a process death or an I/O failure at named effect boundaries.
 */
function contextFor({ identity, homeDirectory, transitionStore, effects, faults = {}, now = () => new Date() }) {
    const store = transitionStore || createTransitionStore({ identity, homeDirectory });
    const policyPaths = hardwareStorePaths({ identity, homeDirectory });
    function boundary(effect, side) {
        const fault = faults[`${effect}.${side}`];
        if (!fault) return;
        if (fault === 'process-death') throw new SimulatedProcessDeath(`${effect}.${side}`);
        if (fault === 'io-error') {
            const error = new Error(`injected I/O failure at ${effect}.${side}`);
            error.code = 'EIO';
            throw error;
        }
    }
    async function act(effect, fn) {
        boundary(effect, 'before');
        const result = await fn();
        boundary(effect, 'after');
        return result;
    }
    return { identity, homeDirectory, store, effects, policyPaths, boundary, act, now };
}

function persist(ctx, journal, changes) {
    Object.assign(journal, changes);
    ctx.store.writeJournal(journal);
    return journal;
}

async function intent(ctx, journal, nextAction, effect, fn) {
    persist(ctx, journal, { nextAction });
    return ctx.act(effect, fn);
}

function isDeath(error) {
    return error instanceof SimulatedProcessDeath;
}

/**
 * Run one downgrade of an observed gate-on Box to a gate-off Box.
 *
 * effects:
 *   inspectBox() -> {id, running, configurationHash} | null
 *   stopGraph(id), stopBox(id), removeBox(id)
 *   createBox(configuration, {receiptPath, attemptId}) -> id (writes receiptPath)
 *   startBox(id), prepareBox(id, configuration)
 *   startGraph(id, graphSnapshot) -> {state, optionalPendingKeys}
 *   verifyBox(id, configuration) -> boolean
 *   readHostRecord(name), writeHostRecord(name, value)
 */
export async function runHardwareDowngrade({
    identity,
    operation,
    oldContainerId,
    oldConfiguration,
    desiredConfiguration,
    graphSnapshot,
    oldWasRunning,
    oldGraphRunning,
    hostRecords,
    reapplyConfiguration = null,
    homeDirectory = os.homedir(),
    transitionStore,
    effects,
    faults,
    now,
}) {
    const ctx = contextFor({ identity, homeDirectory, transitionStore, effects, faults, now });
    if (!/^[a-f0-9]{12,64}$/.test(String(oldContainerId || ''))) {
        throw transitionError('a downgrade requires the exact immutable ID of the observed gate-on Box');
    }
    const operationId = randomHex();
    // Prepare: capture and fsync the old and desired snapshots before any
    // destructive action.
    const journal = await ctx.act('snapshot', async () => ({
        schema: JOURNAL_SCHEMA,
        operationId,
        operation,
        identity: {
            instance: identity.instance,
            pathHash: identity.pathHash,
            workspaceRoot: identity.workspaceRoot,
            workspaceFingerprint: digestOf({ root: identity.workspaceRoot, pathHash: identity.pathHash }),
            engineIdentity: String(effects.engineIdentity || ''),
            hostKind: String(effects.hostKind || 'native-linux'),
        },
        owner: { hostname: os.hostname().slice(0, 255), pid: process.pid, startedAt: ctx.now().toISOString() },
        fromEnabled: true,
        toEnabled: false,
        phase: 'prepared',
        nextAction: null,
        policyToken: null,
        old: {
            configurationRef: ctx.store.writeSnapshot(oldConfiguration),
            graphRef: ctx.store.writeSnapshot(graphSnapshot),
            wasRunning: Boolean(oldWasRunning),
            graphWasRunning: Boolean(oldGraphRunning),
            containerId: String(oldContainerId || ''),
        },
        desired: {
            configurationRef: ctx.store.writeSnapshot(desiredConfiguration),
            graphRef: ctx.store.writeSnapshot(graphSnapshot),
            ...(reapplyConfiguration ? { reapplyConfigurationRef: ctx.store.writeSnapshot(reapplyConfiguration) } : {}),
        },
        attempts: [],
        hostRecords: hostRecords.map((record) => ({ name: record.name, old: record.old, next: record.next, written: false })),
        commitIntent: null,
        lastProblem: null,
    }));
    await ctx.act('prepared-journal', async () => ctx.store.writeJournal(journal));
    try {
        await forwardToDecision(ctx, journal);
    } catch (error) {
        if (isDeath(error)) throw error;
        // Before a durable decision every failure rolls back.
        persist(ctx, journal, { lastProblem: { code: String(error.code || 'ERROR'), message: String(error.message).slice(0, 512), action: journal.nextAction?.kind || null } });
        await rollback(ctx, journal);
        throw transitionError(`The gate-off transition failed and the gate-on Box was restored: ${error.message}`, 'PLOINKY_BOX_HARDWARE_TRANSITION_ROLLED_BACK', error);
    }
    await completeDecision(ctx, journal);
    return Object.freeze({ operationId, phase: journal.phase, containerId: journal.commitIntent.finalContainerId });
}

async function forwardToDecision(ctx, journal) {
    const { effects } = ctx;
    // Install the barrier: the store must be authoritatively empty.
    const receipt = await intent(ctx, journal, { kind: 'install-barrier' }, 'barrier', async () => beginDowngradeBarrier({
        paths: ctx.policyPaths, identity: ctx.identity, operationId: journal.operationId,
    }));
    persist(ctx, journal, { policyToken: receipt.token, phase: 'barrier-installed', nextAction: null });
    // Stop the exact old graph and Box when running.
    if (journal.old.wasRunning) {
        if (journal.old.graphWasRunning) {
            await intent(ctx, journal, { kind: 'stop-graph', exactContainerId: journal.old.containerId }, 'inner-stop',
                async () => effects.stopGraph(journal.old.containerId));
        }
        await intent(ctx, journal, { kind: 'stop-box', exactContainerId: journal.old.containerId }, 'outer-stop',
            async () => effects.stopBox(journal.old.containerId));
    }
    persist(ctx, journal, { phase: 'old-stopped', nextAction: null });
    await intent(ctx, journal, { kind: 'remove-old', exactContainerId: journal.old.containerId }, 'old-remove',
        async () => effects.removeBox(journal.old.containerId));
    if (effects.inspectBox()?.id === journal.old.containerId) throw transitionError('the old Box was not removed');
    persist(ctx, journal, { phase: 'old-absent', nextAction: null });
    let candidateId = await createVerifiedCandidate(ctx, journal, journal.desired.configurationRef, 'candidate');
    if (journal.desired.reapplyConfigurationRef) {
        // One internal GPU reapply: replace the first candidate with the
        // newly resolved immutable target; the old snapshot remains the
        // rollback target.
        await intent(ctx, journal, { kind: 'reapply-stop', exactContainerId: candidateId }, 'reapply-stop',
            async () => effects.stopBox(candidateId));
        await intent(ctx, journal, { kind: 'reapply-remove', exactContainerId: candidateId }, 'reapply-remove',
            async () => effects.removeBox(candidateId));
        candidateId = await createVerifiedCandidate(ctx, journal, journal.desired.reapplyConfigurationRef, 'reapply');
    }
    // Decide: verify the final candidate, the absence of old writers, barrier
    // ownership and the empty policy; then fsync the commit intent.
    const configurationRef = journal.desired.reapplyConfigurationRef || journal.desired.configurationRef;
    const configuration = ctx.store.readSnapshot(configurationRef);
    if (!effects.verifyBox(candidateId, configuration)) throw transitionError('the gate-off candidate failed final verification');
    const barrier = readBarrier({ paths: ctx.policyPaths });
    if (!barrier || barrier.malformed || barrier.barrier.operationId !== journal.operationId) {
        throw transitionError('the downgrade barrier is no longer owned by this operation');
    }
    await ctx.act('desired-commit-intent', async () => persist(ctx, journal, {
        commitIntent: {
            result: 'desired-off',
            finalAttemptId: journal.attempts[journal.attempts.length - 1].attemptId,
            finalContainerId: candidateId,
            configurationRef,
            graphResultRef: journal.attempts[journal.attempts.length - 1].graphResultRef ?? null,
            hostRecordsHash: digestOf(journal.hostRecords.map((record) => [record.name, record.next])),
        },
        phase: 'commit-decided',
        nextAction: null,
    }));
}

async function createVerifiedCandidate(ctx, journal, configurationRef, stage) {
    const { effects } = ctx;
    if (journal.attempts.length >= MAX_ATTEMPTS) {
        persist(ctx, journal, { phase: 'recovery-blocked' });
        throw transitionError('the downgrade exceeded its bounded create attempts', 'PLOINKY_BOX_HARDWARE_RECOVERY_BLOCKED');
    }
    const configuration = ctx.store.readSnapshot(configurationRef);
    const attemptId = randomHex();
    const receiptPath = ctx.store.receiptPath(attemptId);
    journal.attempts.push({ attemptId, stage, configurationRef, contractHash: digestOf(configuration), observedId: null, graphResultRef: null });
    const createEffect = stage === 'reapply' ? 'reapply-create' : 'candidate-create';
    await intent(ctx, journal, { kind: 'create', attemptId, exactContainerId: null, configurationRef, receiptName: path.basename(receiptPath) },
        createEffect, async () => effects.createBox(configuration, { receiptPath, attemptId }));
    const id = await ctx.act(stage === 'reapply' ? 'reapply-receipt' : 'cid-receipt', async () => {
        const observed = ctx.store.readReceipt(attemptId);
        if (!observed) throw transitionError('the create receipt has no immutable container ID');
        return observed;
    });
    journal.attempts[journal.attempts.length - 1].observedId = id;
    persist(ctx, journal, { phase: 'candidate-created', nextAction: null });
    await intent(ctx, journal, { kind: 'start', attemptId, exactContainerId: id }, stage === 'reapply' ? 'reapply-start' : 'candidate-start',
        async () => effects.startBox(id));
    persist(ctx, journal, { phase: 'candidate-started', nextAction: null });
    if (!journal.old.graphWasRunning) {
        // The graph was not running before the downgrade: it is not started,
        // so there is no graph result for this attempt.
        persist(ctx, journal, { phase: 'candidate-verified', nextAction: null });
        return id;
    }
    const graph = ctx.store.readSnapshot(journal.desired.graphRef);
    const result = await intent(ctx, journal, { kind: 'graph', attemptId, exactContainerId: id }, stage === 'reapply' ? 'reapply-graph' : 'candidate-graph',
        async () => effects.startGraph(id, graph));
    if (!['ready', 'starting', 'degraded'].includes(result?.state)) throw transitionError('the gate-off graph did not reach a settled state');
    const graphResult = {
        schema: 1,
        finalBoxId: id,
        state: result.state,
        requiredReady: true,
        optionalPendingKeys: (result.optionalPendingKeys || []).slice(0, 32),
        optionalPendingCount: (result.optionalPendingKeys || []).length,
        refusedCount: Number(result.refusedCount || 0),
        blockedCount: Number(result.blockedCount || 0),
        observedAt: ctx.now().toISOString(),
    };
    journal.attempts[journal.attempts.length - 1].graphResultRef = ctx.store.writeSnapshot(graphResult, GRAPH_RESULT_MAX_BYTES);
    persist(ctx, journal, { phase: 'candidate-verified', nextAction: null });
    return id;
}

// After a durable desired-off decision: write the exact desired host records,
// then open writers and finish. Never reversed.
async function completeDecision(ctx, journal) {
    for (const record of journal.hostRecords) {
        if (record.written) continue;
        await intent(ctx, journal, { kind: 'write-record', name: record.name }, `desired-${recordEffect(record.name)}`,
            async () => ctx.effects.writeHostRecord(record.name, record.next));
        record.written = true;
        persist(ctx, journal, {});
    }
    persist(ctx, journal, { phase: 'host-state-committed', nextAction: null });
    await intent(ctx, journal, { kind: 'remove-barrier' }, 'barrier-remove', async () => removeDowngradeBarrier({
        paths: ctx.policyPaths, identity: ctx.identity, operationId: journal.operationId,
    }));
    await ctx.act('committed-receipt', async () => persist(ctx, journal, { phase: 'committed', nextAction: null }));
}

function recordEffect(name) {
    if (name === 'gate') return 'gate-write';
    if (name === 'gpu') return 'gpu-record';
    if (name === 'router') return 'router-record';
    return `${name}-record`;
}

/**
 * Restore the old gate-on generation exactly: remove only operation-owned
 * candidates, recreate (or restart) the old configuration, prepare it before
 * its graph, restore its prior running/graph state, then complete the
 * restored-old decision.
 */
async function rollback(ctx, journal) {
    const { effects } = ctx;
    if (journal.commitIntent?.result === 'desired-off') {
        throw transitionError('a durable desired-off decision is never rolled back', 'PLOINKY_BOX_HARDWARE_RECOVERY_BLOCKED');
    }
    if (journal.phase === 'prepared' && !readBarrier({ paths: ctx.policyPaths })) {
        // Nothing destructive happened: abort cleanly.
        persist(ctx, journal, { phase: 'rolled-back', nextAction: null });
        return;
    }
    if (journal.commitIntent?.result !== 'restored-old') {
        persist(ctx, journal, { phase: 'rollback-started', nextAction: null });
        const oldConfiguration = ctx.store.readSnapshot(journal.old.configurationRef);
        const graph = ctx.store.readSnapshot(journal.old.graphRef);
        const attemptById = new Map(journal.attempts
            .map((attempt) => [attempt.observedId || ctx.store.readReceipt(attempt.attemptId), attempt])
            .filter(([id]) => Boolean(id)));
        let observed = effects.inspectBox();
        let restoredId = journal.old.containerId;
        let restarted = false;
        if (observed && observed.id !== journal.old.containerId) {
            const attempt = attemptById.get(observed.id);
            if (!attempt) {
                persist(ctx, journal, { phase: 'recovery-blocked', lastProblem: { code: 'FOREIGN_BOX', message: `Box ${observed.id} is not owned by this transition`, action: 'rollback' } });
                throw transitionError(`Recovery is blocked: Box ${observed.id} is not owned by this transition`, 'PLOINKY_BOX_HARDWARE_RECOVERY_BLOCKED');
            }
            if (attempt.stage === 'rollback') {
                // An earlier interrupted rollback already recreated the old
                // configuration: resume with that exact Box, never recreate.
                restoredId = observed.id;
                attempt.observedId = observed.id;
                persist(ctx, journal, {});
            } else {
                const candidateId = observed.id;
                await intent(ctx, journal, { kind: 'remove-candidate', exactContainerId: candidateId }, 'rollback-remove',
                    async () => effects.removeBox(candidateId));
                observed = effects.inspectBox();
            }
        }
        if (!observed) {
            const attemptId = randomHex();
            const receiptPath = ctx.store.receiptPath(attemptId);
            journal.attempts.push({ attemptId, stage: 'rollback', configurationRef: journal.old.configurationRef, contractHash: digestOf(oldConfiguration), observedId: null, graphResultRef: null });
            await intent(ctx, journal, { kind: 'create', attemptId, exactContainerId: null, configurationRef: journal.old.configurationRef, receiptName: path.basename(receiptPath) },
                'rollback-create', async () => effects.createBox(oldConfiguration, { receiptPath, attemptId }));
            restoredId = ctx.store.readReceipt(attemptId);
            if (!restoredId) {
                persist(ctx, journal, { phase: 'recovery-blocked' });
                throw transitionError('Recovery is blocked: the restored Box create has no receipt', 'PLOINKY_BOX_HARDWARE_RECOVERY_BLOCKED');
            }
            journal.attempts[journal.attempts.length - 1].observedId = restoredId;
            persist(ctx, journal, {});
            observed = { id: restoredId, running: false };
        }
        // A recreated or restarted generation always needs its graph back.
        if (restoredId !== journal.old.containerId && journal.old.wasRunning && !effects.graphRunning?.(restoredId)) restarted = true;
        if (journal.old.wasRunning) {
            if (!effects.inspectBox()?.running) {
                await intent(ctx, journal, { kind: 'start', exactContainerId: restoredId }, 'rollback-start', async () => effects.startBox(restoredId));
                restarted = true;
            }
            // Every restored or restarted gate-on generation is prepared
            // before its graph (idempotent for a running Box).
            await intent(ctx, journal, { kind: 'prepare', exactContainerId: restoredId }, 'rollback-prepare',
                async () => effects.prepareBox(restoredId, oldConfiguration));
            if (journal.old.graphWasRunning && (restarted || !effects.graphRunning?.(restoredId))) {
                await intent(ctx, journal, { kind: 'graph', exactContainerId: restoredId }, 'rollback-graph',
                    async () => effects.startGraph(restoredId, graph));
            }
        }
        if (!effects.verifyBox(restoredId, oldConfiguration)) {
            persist(ctx, journal, { phase: 'recovery-blocked' });
            throw transitionError('Recovery is blocked: the restored Box does not match its recorded configuration', 'PLOINKY_BOX_HARDWARE_RECOVERY_BLOCKED');
        }
        persist(ctx, journal, { phase: 'rollback-verified', nextAction: null });
        await ctx.act('restored-commit-intent', async () => persist(ctx, journal, {
            commitIntent: {
                result: 'restored-old',
                finalAttemptId: journal.attempts[journal.attempts.length - 1]?.attemptId || null,
                finalContainerId: restoredId,
                configurationRef: journal.old.configurationRef,
                graphResultRef: null,
                hostRecordsHash: digestOf(journal.hostRecords.map((record) => [record.name, record.old])),
            },
        }));
    }
    for (const record of journal.hostRecords) {
        await intent(ctx, journal, { kind: 'write-record', name: record.name }, `restored-${recordEffect(record.name)}`,
            async () => effects.writeHostRecord(record.name, record.old));
    }
    await intent(ctx, journal, { kind: 'remove-barrier' }, 'barrier-remove', async () => removeDowngradeBarrier({
        paths: ctx.policyPaths, identity: ctx.identity, operationId: journal.operationId, requireEmpty: false,
    }));
    await ctx.act('rolledback-receipt', async () => persist(ctx, journal, { phase: 'rolled-back', nextAction: null }));
}

/**
 * Fresh-process recovery of every pending downgrade, before the next outer
 * state-changing operation (caller holds the host workspace lock).
 */
export async function recoverHardwareDowngrades({ identity, homeDirectory = os.homedir(), transitionStore, effects, faults, now }) {
    const ctx = contextFor({ identity, homeDirectory, transitionStore, effects, faults, now });
    const results = [];
    for (const journal of ctx.store.listPending()) {
        if (journal.phase === 'recovery-blocked') {
            results.push({ operationId: journal.operationId, phase: journal.phase });
            continue;
        }
        try {
            if (journal.commitIntent?.result === 'desired-off') {
                await rollForward(ctx, journal);
            } else {
                await recoverWithoutDecision(ctx, journal);
            }
        } catch (error) {
            if (isDeath(error)) throw error;
            if (error?.code === 'PLOINKY_BOX_HARDWARE_RECOVERY_BLOCKED') {
                results.push({ operationId: journal.operationId, phase: 'recovery-blocked', error: error.message });
                continue;
            }
            throw error;
        }
        results.push({ operationId: journal.operationId, phase: journal.phase });
    }
    return results;
}

async function rollForward(ctx, journal) {
    const { effects } = ctx;
    const intentRecord = journal.commitIntent;
    const configuration = ctx.store.readSnapshot(intentRecord.configurationRef);
    const observed = effects.inspectBox();
    if (!observed || observed.id !== intentRecord.finalContainerId) {
        persist(ctx, journal, { phase: 'recovery-blocked', lastProblem: { code: 'TARGET_MISSING', message: 'the decided gate-off Box is not present', action: 'roll-forward' } });
        throw transitionError('Recovery is blocked: the decided gate-off Box is not present', 'PLOINKY_BOX_HARDWARE_RECOVERY_BLOCKED');
    }
    if (!observed.running && journal.old.wasRunning) {
        await intent(ctx, journal, { kind: 'start', exactContainerId: observed.id }, 'recovery-start', async () => effects.startBox(observed.id));
    }
    // Restore the graph only when it was running before and is not observed now.
    if (journal.old.graphWasRunning && !effects.graphRunning?.(observed.id)) {
        const graph = ctx.store.readSnapshot(journal.desired.graphRef);
        await intent(ctx, journal, { kind: 'graph', exactContainerId: observed.id }, 'recovery-graph', async () => effects.startGraph(observed.id, graph));
    }
    if (!effects.verifyBox(observed.id, configuration)) {
        persist(ctx, journal, { phase: 'recovery-blocked' });
        throw transitionError('Recovery is blocked: the decided gate-off Box does not match its configuration', 'PLOINKY_BOX_HARDWARE_RECOVERY_BLOCKED');
    }
    await completeDecision(ctx, journal);
}

async function recoverWithoutDecision(ctx, journal) {
    // Validate every recorded prerequisite before acting.
    ctx.store.readSnapshot(journal.old.configurationRef);
    ctx.store.readSnapshot(journal.old.graphRef);
    ctx.store.readSnapshot(journal.desired.configurationRef);
    if (journal.phase === 'prepared' && journal.nextAction === null && !readBarrier({ paths: ctx.policyPaths })) {
        persist(ctx, journal, { phase: 'rolled-back' });
        return;
    }
    // A create intent whose receipt is missing while an unattributed Box
    // exists is ambiguous: never duplicate a create or delete by name.
    const observed = ctx.effects.inspectBox();
    const known = new Set([journal.old.containerId, ...journal.attempts.map((attempt) => attempt.observedId || ctx.store.readReceipt(attempt.attemptId)).filter(Boolean)]);
    if (observed && !known.has(observed.id)) {
        persist(ctx, journal, { phase: 'recovery-blocked', lastProblem: { code: 'FOREIGN_BOX', message: `Box ${observed.id} is not owned by this transition`, action: 'recover' } });
        throw transitionError(`Recovery is blocked: Box ${observed.id} is not owned by this transition`, 'PLOINKY_BOX_HARDWARE_RECOVERY_BLOCKED');
    }
    // Apparent candidate success is not a durable decision: roll back.
    await rollback(ctx, journal);
}

/** Explicit destroy: record the aborted operation and remove its barrier. */
export function abortHardwareDowngradesForDestroy({ identity, homeDirectory = os.homedir(), transitionStore }) {
    const store = transitionStore || createTransitionStore({ identity, homeDirectory });
    const policyPaths = hardwareStorePaths({ identity, homeDirectory });
    const aborted = [];
    for (const journal of store.listPending()) {
        removeDowngradeBarrier({ paths: policyPaths, identity, operationId: journal.operationId, requireEmpty: false });
        journal.phase = 'aborted-by-destroy';
        journal.nextAction = null;
        store.writeJournal(journal);
        aborted.push(journal.operationId);
    }
    return aborted;
}
