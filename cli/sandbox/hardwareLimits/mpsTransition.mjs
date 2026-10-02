import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MpsError } from './mpsEligibility.mjs';
import { isMpsClientAlias, validateMpsDefault } from './mps.mjs';
import { findHardwareOutcome } from './errors.mjs';

/**
 * The coordination's own target completed or was not the failing client,
 * but other share clients of the cohort were not recreated. Only the
 * selected target's own failure is that target's outcome; this error carries
 * every client's result (mpsTransitionResults) and is a partial result, not
 * a refusal of the target.
 */
export class MpsPartialFailureError extends Error {
    constructor(message, { results = [], state = null } = {}) {
        super(message);
        this.name = 'MpsPartialFailureError';
        this.code = 'mps_partial_failure';
        this.status = 207;
        Object.defineProperty(this, 'mpsTransitionResults', { value: results, configurable: true });
        Object.defineProperty(this, 'mpsTransitionState', { value: state, configurable: true });
    }
}

function exactClient(value) {
    if (!value || typeof value.key !== 'string' || !value.key || Buffer.byteLength(value.key) > 1024 || typeof value.ref !== 'string' || !value.ref
        || typeof value.instanceId !== 'string' || !value.instanceId || typeof value.enableGeneration !== 'string' || !value.enableGeneration
        || (value.containerId !== null && value.containerId !== undefined && !/^[a-f0-9]{64}$/.test(value.containerId))
        || (Object.hasOwn(value, 'alias') && !isMpsClientAlias(value.alias))) throw new MpsError('MPS client identity is incomplete');
    if (value.share) validateMpsDefault(value.share);
    return value;
}
function clientProof({ key, ref, instanceId, enableGeneration, containerId, share, mpsGeneration }) { return { key, ref, instanceId, enableGeneration, containerId, share, mpsGeneration }; }
function clientIdentity(value) { return [value.key, value.instanceId, value.enableGeneration, value.containerId || ''].join('\0'); }
// One exact tuple keeps the alias any of its observations carries; two
// different aliases for the same tuple are an identity change.
function withAlias(previous, value) {
    if (!previous || !Object.hasOwn(previous, 'alias')) return value;
    if (!Object.hasOwn(value, 'alias')) return { ...value, alias: previous.alias };
    if (previous.alias !== value.alias) throw new MpsError('MPS exact client observations disagree on its alias', 'identity_changed');
    return value;
}
function uniqueClients(values) {
    if (!Array.isArray(values) || values.length > 256) throw new MpsError('MPS client cohort exceeds its bound');
    const map = new Map();
    for (const value of values) { exactClient(value); const key = clientIdentity(value); if (map.has(key) && !isDeepStrictEqual(clientProof(map.get(key)), clientProof(value))) throw new MpsError('MPS exact client observations conflict'); map.set(key, withAlias(map.get(key), value)); }
    return [...map.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export function resolveMpsServerDefault(configuredPolicies = []) {
    const policies = configuredPolicies.filter((value) => value?.share);
    if (!policies.length) return null;
    if (policies.length > 256) throw new MpsError('MPS policy cohort exceeds its bound');
    const identity = policies[0].share;
    for (const { share } of policies) {
        validateMpsDefault(share);
        for (const field of ['deviceUuid', 'driverVersion', 'wiringFingerprint']) if (share[field] !== identity[field]) throw new MpsError('MPS policies describe different GPU wiring');
    }
    return Object.freeze({ smPercent: Math.max(...policies.map((value) => value.share.smPercent)), memoryMiB: Math.max(...policies.map((value) => value.share.memoryMiB)), deviceUuid: identity.deviceUuid, driverVersion: identity.driverVersion, wiringFingerprint: identity.wiringFingerprint });
}

export function planMpsTransition({ oldClients = [], desiredClients = [], configuredPolicies = desiredClients, selectedKeys = [], state = null, observedDaemon = { state: 'gone' }, defaultsVerified = false } = {}) {
    const observedOld = uniqueClients([...oldClients, ...(state?.oldClients || [])]);
    const pendingCreated = (state?.pendingClients || []).filter((client) => client.phase === 'readiness' && client.share && /^[a-f0-9]{64}$/.test(String(client.containerId || ''))).map((client) => {
        if (client.mpsGeneration) return client;
        const observed = observedOld.find((value) => clientIdentity(value) === clientIdentity(client) && value.ref === client.ref && isDeepStrictEqual(value.share, client.share));
        if (!observed?.mpsGeneration) throw new MpsError('A pending created client lacks a verified MPS generation');
        return { ...client, mpsGeneration: observed.mpsGeneration };
    });
    const old = uniqueClients([...observedOld, ...pendingCreated]);
    const desired = uniqueClients(desiredClients);
    const keys = new Set(selectedKeys);
    const targetDefault = resolveMpsServerDefault(configuredPolicies);
    const needed = desired.some((value) => value.share);
    const generation = state?.daemonGeneration && state?.configurationGeneration ? `${state.daemonGeneration}:${state.configurationGeneration}` : '';
    // A drain receipt means that exact client no longer runs: it is not a
    // live client of any generation. A verified, owned daemon whose only
    // problem is that some clients were not recreated is healthy (§11.3:
    // reuse it); a retry recreates only what is missing.
    const drainedIds = new Set(state?.drainedClients || []);
    const live = old.filter((value) => !drainedIds.has(clientIdentity(value)));
    const clientFailuresOnly = state?.status === 'pending' && state?.lastProblem?.code === 'mps_client_failed';
    const healthy = observedDaemon.state === 'owned' && defaultsVerified === true && (state?.status === 'ready' || clientFailuresOnly);
    const defaultChanged = !isDeepStrictEqual(state?.serverDefault || null, targetDefault);
    const stale = live.some((value) => value.share && value.mpsGeneration !== generation);
    const unfinished = Boolean(state?.status === 'transitioning' || (state?.status === 'pending' && !clientFailuresOnly)
        || state?.pendingClients?.some((client) => client.phase !== 'readiness' && !(clientFailuresOnly && client.phase === 'pending')));
    const restart = needed && (!healthy || defaultChanged || stale || unfinished);
    const finalClear = !needed && !targetDefault && (old.some((value) => value.share) || state?.daemon);
    if (observedDaemon.state === 'foreign' || observedDaemon.state === 'unknown') {
        if (state?.daemon || state?.pipeDirectory || needed) throw new MpsError('MPS daemon identity is unknown or belongs to another process');
    }
    const cohort = restart || finalClear;
    const drain = old.filter((value) => value.share && (cohort || keys.has(value.key) && !isDeepStrictEqual(value.share, desired.find((entry) => entry.key === value.key)?.share)));
    const recreate = desired.filter((value) => {
        if (cohort) return Boolean(value.share || drain.some((entry) => entry.key === value.key));
        const previous = live.find((entry) => entry.key === value.key);
        return keys.has(value.key) && (!previous || !isDeepStrictEqual(previous.share, value.share)) || value.share && !previous;
    });
    return Object.freeze({ action: finalClear ? 'clear' : restart ? 'restart' : recreate.length ? 'clients' : 'reuse', oldClients: old, desiredClients: desired, drain, recreate, serverDefault: targetDefault, stopDaemon: Boolean((restart || finalClear) && state?.daemon && observedDaemon.state === 'owned'), startDaemon: restart && needed, generation, expandedKeys: recreate.filter((entry) => !keys.has(entry.key)).map((entry) => entry.key) });
}

/** The only mutation coordinator. Callers supply exact ownership-checked
 * drain/recreate operations and reuse their existing network capability. */
function* transitionSteps(input, { assertCapability, store, backend, drain, recreate, check = () => {}, tools, onResult = () => {}, onPlan = () => {} } = {}) {
    assertCapability(input.capability);
    check();
    const stored = input.state === undefined ? store.read() : input.state;
    const saved = stored || (tools && backend.discover ? backend.discover(tools) : null);
    const observation = saved?.daemon || saved?.pipeDirectory ? backend.observe(saved) : { state: 'gone' };
    const prior = saved && observation.state === 'owned' && observation.daemon ? { ...saved, daemon: observation.daemon } : saved;
    const plan = planMpsTransition({ ...input, state: prior, observedDaemon: observation, defaultsVerified: prior?.daemon ? backend.verify(prior) : false });
    onPlan(plan);
    if (plan.action === 'reuse') return { plan, state: prior, results: [] };
    const initialPending = [...(input.preservedPending || []), ...plan.recreate.map((client) => ({ ...client, phase: 'pending' }))];
    // A refused peer drained by an earlier attempt keeps its pending intent:
    // it is not in the recreate list, so a rebuilt journal would otherwise lose
    // it before this attempt can settle its outcome.
    const refusedKeys = new Set((input.refusedClients || []).map(({ client }) => client.key));
    const carriedPending = (prior?.pendingClients || []).filter((entry) => refusedKeys.has(entry.key) && entry.phase === 'pending' && !initialPending.some((value) => value.key === entry.key));
    let state = { ...(prior || { schema: 1, daemonGeneration: null, configurationGeneration: null, daemon: null, pipeDirectory: null, logDirectory: null }), transitionId: prior?.transitionId || crypto.randomUUID(), origin: String(input.origin || 'lifecycle').slice(0, 32), status: 'transitioning', oldClients: plan.oldClients, desiredClients: plan.desiredClients, pendingClients: [...initialPending, ...carriedPending], drainedClients: prior?.drainedClients || [], serverDefault: prior?.serverDefault || null, lastProblem: null };
    const save = () => store.write(state);
    save();
    const results = [];
    const failures = [];
    try {
        // No daemon mutation can happen until every owned old share client
        // has completed bounded route revocation and exact runtime drain.
        // Peers that cannot be recreated go first: when one cannot be proven
        // its recorded runtime, nothing else has been drained yet.
        const refusedIds = new Set((input.refusedClients || []).map(({ client }) => clientIdentity(client)));
        const drainOrder = [...plan.drain].sort((left, right) => Number(refusedIds.has(clientIdentity(right))) - Number(refusedIds.has(clientIdentity(left))));
        // A drained peer that cannot be recreated (its manifest or image is
        // no longer eligible) keeps its pending intent in the journal and
        // gets its own typed refusal; it never refuses the selected target.
        // The outcome is journaled and reported as soon as that peer is
        // down, so a later abort (an unprovable peer, a cancellation, lost
        // authorization, any other error) cannot lose it.
        const settledRefusals = new Set();
        const settleRefusedPeers = () => {
            for (const { client, outcome } of input.refusedClients || []) {
                if (settledRefusals.has(clientIdentity(client)) || !state.drainedClients.includes(clientIdentity(client))) continue;
                settledRefusals.add(clientIdentity(client));
                state.pendingClients = [...state.pendingClients.filter((entry) => entry.key !== client.key), { ...client, phase: 'pending' }];
                const result = { key: client.key, state: outcome.state, problem: outcome };
                failures.push({ client, error: Object.assign(new Error(outcome.reason), { hardwareOutcome: outcome }) });
                results.push(result); save(); onResult(result);
            }
        };
        // Peers drained by an earlier attempt of this transition are settled
        // first: a later abort in this attempt (an unprovable peer, a
        // cancellation) must not leave them without their outcome.
        settleRefusedPeers();
        for (const client of drainOrder) {
            if (state.drainedClients.includes(clientIdentity(client))) continue;
            check();
            yield () => drain(client, input.capability);
            state.drainedClients = [...new Set([...state.drainedClients, clientIdentity(client)])]; save();
            settleRefusedPeers();
        }
        if (plan.stopDaemon) { check(); backend.stop(state); state.daemon = null; state.daemonGeneration = null; state.configurationGeneration = null; save(); }
        if (plan.stopDaemon || observation.state === 'gone') {
            // Journal the terminated generation before its directories are
            // removed, so an interruption after cleanup recovers from 'gone'.
            state.daemon = null; state.daemonGeneration = null; state.configurationGeneration = null; save();
            if (backend.cleanup && state.pipeDirectory) { check(); backend.cleanup(state); }
            state.pipeDirectory = null; state.logDirectory = null; save();
        }
        if (plan.startDaemon) {
            check();
            const daemon = backend.start(plan.serverDefault, { tools, onState: (next) => { state = { ...state, ...next, status: 'transitioning', oldClients: plan.oldClients, desiredClients: plan.desiredClients, pendingClients: state.pendingClients, drainedClients: state.drainedClients }; save(); } });
            state = { ...state, ...daemon, status: 'transitioning', oldClients: plan.oldClients, desiredClients: plan.desiredClients, pendingClients: state.pendingClients, drainedClients: state.drainedClients }; save();
            if (!backend.verify(state)) throw new MpsError('MPS daemon lost its verified defaults before client create');
        }
        for (const client of plan.recreate) {
            check();
            const readyState = client.share ? { ...state, status: 'ready' } : null;
            let result;
            try {
                // A daemon that lost its defaults fails the client being
                // created, whatever the cause: only the selected target's own
                // failure becomes the target's outcome (plan 10.2); a peer's
                // is that peer's pending result and never the target's refusal.
                if (client.share && !backend.verify(state)) throw new MpsError('MPS daemon defaults changed before client create');
                result = yield () => recreate(client, readyState, input.capability);
            } catch (error) {
                // One client's failure is its own terminal outcome; the rest
                // of the cohort is still recreated. A cancelled, expired or
                // unauthorized operation still stops the whole transition.
                check();
                const observedState = store.read();
                const created = (observedState?.transitionId === state.transitionId && observedState?.daemonGeneration === state.daemonGeneration ? observedState.pendingClients || [] : [])
                    .filter((entry) => entry.key === client.key && entry.phase === 'readiness' && /^[a-f0-9]{64}$/.test(String(entry.containerId || '')));
                // A created candidate keeps its exact journaled identity for
                // recovery; an uncreated client stays a pending intent.
                if (created.length) state.pendingClients = [...state.pendingClients.filter((entry) => entry.key !== client.key), ...created];
                failures.push({ client, error });
                result = { key: client.key, state: 'pending', problem: findHardwareOutcome(error), error: String(error?.code || 'mps_client_failed').slice(0, 64), message: 'This exact GPU share client was not recreated; it stays inactive until retried.' };
                results.push(result); onResult(result);
                save();
                continue;
            }
            results.push(result); onResult(result);
            state.pendingClients = state.pendingClients.filter((entry) => entry.key !== client.key);
            if (result?.state === 'starting') state.pendingClients.push({ ...client, ...(result.client || {}), phase: 'readiness' });
            save();
        }
        if (failures.length) {
            // Every client had its own attempt. The cohort is incomplete: keep
            // the journal (old cohort, drain receipts, pending clients) so the
            // next coordination retries from observations. Daemon health is
            // reported separately (mpsStatus), so healthy clients stay up.
            state = { ...state, status: 'pending', serverDefault: plan.serverDefault,
                lastProblem: { code: 'mps_client_failed', message: `${failures.length} GPU share client(s) were not recreated; they stay inactive until retried.` } };
            save();
        } else {
            state = { ...state, status: state.daemon ? 'ready' : 'inactive', serverDefault: plan.serverDefault, oldClients: [], desiredClients: [], pendingClients: state.pendingClients, drainedClients: [], transitionId: null, lastProblem: null };
            save();
        }
    } catch (error) {
        // The exact lifecycle may have recorded a created candidate before
        // readiness failed. Retain that newer identity for crash recovery.
        const observedState = store.read();
        if (observedState?.transitionId === state.transitionId && observedState?.daemonGeneration === state.daemonGeneration) state = observedState;
        state = { ...state, status: 'pending', lastProblem: { code: String(error.code || 'mps_transition_failed').slice(0, 64), message: 'MPS transition is incomplete; inactive clients remain pending. Retry after repairing the reported prerequisite.' } };
        save();
        // Every abort carries the outcomes completed so far.
        if (error && typeof error === 'object' && !Object.hasOwn(error, 'mpsTransitionResults')) Object.defineProperty(error, 'mpsTransitionResults', { value: results, configurable: true });
        throw error;
    }
    // Only the selected target's own failure is that target's outcome. A
    // peer's failure is a partial result carrying every client's outcome
    // (each was also reported through onResult).
    if (failures.length) {
        const own = failures.find(({ client }) => (input.selectedKeys || []).includes(client.key));
        if (own) throw Object.defineProperty(own.error, 'mpsTransitionResults', { value: results, configurable: true });
        const detail = failures.map(({ client, error }) => `${client.key}: ${String(error?.message || error).slice(0, 256)}`).join('; ');
        throw new MpsPartialFailureError(`GPU share client(s) were not recreated and stay inactive until retried: ${detail}`.slice(0, 2048), { results, state });
    }
    return { plan, state, results };
}

export function runMpsTransition(input, dependencies) {
    const steps = transitionSteps(input, dependencies);
    let step = steps.next();
    while (!step.done) {
        try {
            const result = step.value();
            if (result?.then) throw new MpsError('Asynchronous lifecycle requires runMpsTransitionAsync');
            step = steps.next(result);
        } catch (error) { step = steps.throw(error); }
    }
    return step.value;
}

export async function runMpsTransitionAsync(input, dependencies) {
    const steps = transitionSteps(input, dependencies);
    let step = steps.next();
    while (!step.done) {
        try { step = steps.next(await step.value()); }
        catch (error) { step = steps.throw(error); }
    }
    return step.value;
}
