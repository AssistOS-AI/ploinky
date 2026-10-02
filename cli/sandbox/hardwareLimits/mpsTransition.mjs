import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MpsError } from './mpsEligibility.mjs';
import { validateMpsDefault } from './mps.mjs';

function exactClient(value) {
    if (!value || typeof value.key !== 'string' || !value.key || Buffer.byteLength(value.key) > 1024 || typeof value.ref !== 'string' || !value.ref
        || typeof value.instanceId !== 'string' || !value.instanceId || typeof value.enableGeneration !== 'string' || !value.enableGeneration
        || (value.containerId !== null && value.containerId !== undefined && !/^[a-f0-9]{64}$/.test(value.containerId))) throw new MpsError('MPS client identity is incomplete');
    if (value.share) validateMpsDefault(value.share);
    return value;
}
function clientProof({ key, ref, instanceId, enableGeneration, containerId, share, mpsGeneration }) { return { key, ref, instanceId, enableGeneration, containerId, share, mpsGeneration }; }
function clientIdentity(value) { return [value.key, value.instanceId, value.enableGeneration, value.containerId || ''].join('\0'); }
function uniqueClients(values) {
    if (!Array.isArray(values) || values.length > 256) throw new MpsError('MPS client cohort exceeds its bound');
    const map = new Map();
    for (const value of values) { exactClient(value); const key = clientIdentity(value); if (map.has(key) && !isDeepStrictEqual(clientProof(map.get(key)), clientProof(value))) throw new MpsError('MPS exact client observations conflict'); map.set(key, value); }
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
    const healthy = observedDaemon.state === 'owned' && defaultsVerified === true && state?.status === 'ready';
    const defaultChanged = !isDeepStrictEqual(state?.serverDefault || null, targetDefault);
    const stale = old.some((value) => value.share && value.mpsGeneration !== generation);
    const unfinished = Boolean(state?.status === 'transitioning' || state?.status === 'pending' || state?.pendingClients?.some((client) => client.phase !== 'readiness'));
    const restart = needed && (!healthy || defaultChanged || stale || unfinished);
    const finalClear = !needed && !targetDefault && (old.some((value) => value.share) || state?.daemon);
    if (observedDaemon.state === 'foreign' || observedDaemon.state === 'unknown') {
        if (state?.daemon || state?.pipeDirectory || needed) throw new MpsError('MPS daemon identity is unknown or belongs to another process');
    }
    const cohort = restart || finalClear;
    const drain = old.filter((value) => value.share && (cohort || keys.has(value.key) && !isDeepStrictEqual(value.share, desired.find((entry) => entry.key === value.key)?.share)));
    const recreate = desired.filter((value) => {
        if (cohort) return Boolean(value.share || drain.some((entry) => entry.key === value.key));
        const previous = old.find((entry) => entry.key === value.key);
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
    let state = { ...(prior || { schema: 1, daemonGeneration: null, configurationGeneration: null, daemon: null, pipeDirectory: null, logDirectory: null }), transitionId: prior?.transitionId || crypto.randomUUID(), origin: String(input.origin || 'lifecycle').slice(0, 32), status: 'transitioning', oldClients: plan.oldClients, desiredClients: plan.desiredClients, pendingClients: plan.recreate.map((client) => ({ ...client, phase: 'pending' })), drainedClients: prior?.drainedClients || [], serverDefault: prior?.serverDefault || null, lastProblem: null };
    const save = () => store.write(state);
    save();
    const results = [];
    try {
        // No daemon mutation can happen until every owned old share client
        // has completed bounded route revocation and exact runtime drain.
        for (const client of plan.drain) {
            if (state.drainedClients.includes(clientIdentity(client))) continue;
            check();
            yield () => drain(client, input.capability);
            state.drainedClients = [...new Set([...state.drainedClients, clientIdentity(client)])]; save();
        }
        if (plan.stopDaemon) { check(); backend.stop(state); state.daemon = null; state.daemonGeneration = null; state.configurationGeneration = null; save(); }
        if (plan.stopDaemon || observation.state === 'gone') {
            if (backend.cleanup && state.pipeDirectory) { check(); backend.cleanup(state); }
            state.daemon = null; state.daemonGeneration = null; state.configurationGeneration = null; state.pipeDirectory = null; state.logDirectory = null; save();
        }
        if (plan.startDaemon) {
            check();
            const daemon = backend.start(plan.serverDefault, { tools, onState: (next) => { state = { ...state, ...next, status: 'transitioning', oldClients: plan.oldClients, desiredClients: plan.desiredClients, pendingClients: state.pendingClients, drainedClients: state.drainedClients }; save(); } });
            state = { ...state, ...daemon, status: 'transitioning', oldClients: plan.oldClients, desiredClients: plan.desiredClients, pendingClients: state.pendingClients, drainedClients: state.drainedClients }; save();
            if (!backend.verify(state)) throw new MpsError('MPS daemon lost its verified defaults before client create');
        }
        for (const client of plan.recreate) {
            check();
            if (client.share && !backend.verify(state)) throw new MpsError('MPS daemon defaults changed before client create');
            const readyState = client.share ? { ...state, status: 'ready' } : null;
            const result = yield () => recreate(client, readyState, input.capability);
            results.push(result); onResult(result);
            state.pendingClients = state.pendingClients.filter((entry) => entry.key !== client.key);
            if (result?.state === 'starting') state.pendingClients.push({ ...client, ...(result.client || {}), phase: 'readiness' });
            save();
        }
        state = { ...state, status: state.daemon ? 'ready' : 'inactive', serverDefault: plan.serverDefault, oldClients: [], desiredClients: [], pendingClients: state.pendingClients, drainedClients: [], transitionId: null, lastProblem: null };
        save();
        return { plan, state, results };
    } catch (error) {
        // The exact lifecycle may have recorded a created candidate before
        // readiness failed. Retain that newer identity for crash recovery.
        const observedState = store.read();
        if (observedState?.transitionId === state.transitionId && observedState?.daemonGeneration === state.daemonGeneration) state = observedState;
        state = { ...state, status: 'pending', lastProblem: { code: String(error.code || 'mps_transition_failed').slice(0, 64), message: 'MPS transition is incomplete; inactive clients remain pending. Retry after repairing the reported prerequisite.' } };
        save(); throw error;
    }
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
