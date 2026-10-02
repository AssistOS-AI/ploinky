import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readAgentRegistrySnapshot } from '../../utils/agentRegistrySnapshot.js';
import { findAgent } from '../../utils/utils.js';
import { resolveAgentRepositoryName } from '../../utils/agentRepositorySource.mjs';
import { resolveManifestRuntimeProfile } from '../../utils/runtime/profileService.js';
import { resolveManifestImage } from '../../utils/security/secretVars.js';
import { resolveRouterEndpoint } from '../routerPort.js';
import { assertNetworkLifecycleCapability, withNetworkLifecycleLockAsync } from '../networkLifecycle.js';
import { ensureAgentService, retireExactAgentRuntimePredecessor } from '../docker/agentServiceManager.js';
import { ensureImagePresent, getRuntime, getAgentContainerName } from '../docker/common.js';
import { resolveLlmRuntimeAdmissionContext } from '../docker/llmRuntimeIntegration.js';
import { drainTargetedContainer } from '../docker/targetedContainerLifecycle.js';
import { retireRuntimeRelaySocket } from '../docker/healthProbes.js';
import { prepareTargetedAgentRestart } from '../../commands/targetedAgentRestart.js';
import { readBoxHardwareContext } from './context.mjs';
import { readAppliedObservation } from './runtimeState.mjs';
import { assertKnownMpsClients, inspectMpsClient } from './mpsInventory.mjs';
import { HardwareStoreError } from './store.mjs';
import { HardwareLimitsError } from './errors.mjs';
import { buildDirectRefusal, hex64 } from './requestedLimits.mjs';
import { resolveStoredGpuShare } from './resolve.mjs';
import { createMpsStateStore, createMpsDaemonBackend } from './mps.mjs';
import { MpsError, inspectMpsImage } from './mpsEligibility.mjs';
import { inspectPreparedMpsImage } from './mpsStatus.mjs';
import { createMpsLaunch, readMpsLaunchForTracking, verifyMpsLaunch } from './mpsLaunch.mjs';
import { verifyMpsRuntimeObservation } from './mpsRuntimeObservation.mjs';
import { runMpsTransitionAsync } from './mpsTransition.mjs';
import { reconcileExactHardwareInstance, captureExactHardwareInstances, assertHardwareApplyInputs } from './reconcile.mjs';

function loadClientPlan(ref, record = {}) {
    const resolved = findAgent(ref);
    const manifest = JSON.parse(fs.readFileSync(resolved.manifestPath, 'utf8'));
    const profile = resolveManifestRuntimeProfile(manifest, { agentName: ref, profileName: record.profile || undefined });
    const runtime = getRuntime();
    const llm = resolveLlmRuntimeAdmissionContext({ runtime, manifest, profileConfig: profile.profileConfig, agentName: record.agentName || ref.split('/')[1], alias: record.alias, env: process.env });
    const image = llm.startup?.selection?.imageRef || resolveManifestImage(manifest, profile.profileConfig, { agentName: ref.split('/')[1], repoName: ref.split('/')[0] });
    return { manifest, profile, runtime, image, agentPath: path.dirname(resolved.manifestPath) };
}

async function coordinateMpsLifecycleImpl({ target, options = {}, launchTarget }, {
    readContext = readBoxHardwareContext, loadRegistry = readAgentRegistrySnapshot,
    readApplied = readAppliedObservation, loadPlan = loadClientPlan,
    prepareImage = ensureImagePresent, inspectImage = inspectPreparedMpsImage,
    store = createMpsStateStore(), backend = createMpsDaemonBackend(),
    network = withNetworkLifecycleLockAsync, assertCapability = assertNetworkLifecycleCapability,
    reconcile = reconcileExactHardwareInstance, beforePlan = () => {},
    observeClients = assertKnownMpsClients, drainClient = null, policyCheck = assertHardwareApplyInputs, resolveShare = resolveStoredGpuShare,
} = {}) {
    return network(async (capability) => {
        const context = readContext();
        const token = options.expectedToken === undefined ? context.storeToken : options.expectedToken;
        const check = () => {
            options.beforeHardwareMutation?.();
            if (options.isCancelled?.() || Date.now() >= (options.deadline || Infinity)) throw new HardwareStoreError('MPS lifecycle was cancelled or exceeded its deadline', { code: 'apply_timeout', status: 504 });
            if (options.authorize && options.authorize() !== true) throw new HardwareStoreError('MPS lifecycle authorization changed', { code: 'identity_changed', status: 409 });
            policyCheck(token, { origin: options.origin || 'cli' });
        };
        check();
        const registry = loadRegistry();
        const oldClients = [];
        const desiredClients = [];
        const plans = new Map();
        const images = new Map();
        const recordFor = new Map(Object.entries(registry).filter(([, record]) => record?.type === 'agent'));
        recordFor.set(target.key, target.record);
        for (const [key, record] of recordFor) {
            const ref = `${record.repoName}/${record.agentName}`;
            const applied = record.containerId ? readApplied(key, record.containerId) : null;
            const old = applied?.mpsGeneration && applied.instanceId === record.instanceId && applied.enableGeneration === record.enableGeneration;
            if (old) oldClients.push({ key, ref, instanceId: record.instanceId, enableGeneration: record.enableGeneration, containerId: record.containerId, share: applied.gpuShare, mpsGeneration: applied.mpsGeneration });
            const policy = context.overrides?.get(ref)?.gpu;
            if (key !== target.key && !old) continue;
            const plan = loadPlan(ref, key === target.key ? options.desiredRecord || record : record); plans.set(key, plan);
            const share = policy ? resolveShare(policy, context.gpu, ref) : null;
            if (share) {
                check(); prepareImage(plan.image, { runtime: plan.runtime });
                const inspected = inspectMpsImage({ image: plan.image, networkMode: plan.profile.network.mode }, { inspectImage: (image) => inspectImage(image, { runtime: plan.runtime }) });
                images.set(key, inspected.imageId);
            }
            desiredClients.push({ key, ref, instanceId: record.instanceId || options.instanceId || randomUUID(), enableGeneration: record.enableGeneration || options.enableGeneration || randomUUID(), containerId: record.containerId || null, share });
        }
        observeClients({ runtime: plans.get(target.key)?.runtime || 'podman', registry, state: store.read() });
        const configuredPolicies = [];
        for (const [ref, policy] of context.overrides || []) {
            if (!policy.gpu) continue;
            try {
                const share = resolveShare(policy.gpu, context.gpu, ref);
                const plan = loadPlan(ref);
                inspectMpsImage({ image: plan.image, networkMode: plan.profile.network.mode }, { inspectImage: (image) => inspectImage(image, { runtime: plan.runtime }) });
                configuredPolicies.push({ share });
            } catch (error) {
                if (ref === `${target.record.repoName}/${target.record.agentName}`) throw error;
            }
        }
        const selected = desiredClients.find((client) => client.key === target.key);
        if (selected?.share && !configuredPolicies.some((entry) => isDeepStrictEqual(entry.share, selected.share))) configuredPolicies.push({ share: selected.share });
        let targetResult;
        const result = await runMpsTransitionAsync({ oldClients, desiredClients, configuredPolicies, selectedKeys: [target.key], capability, origin: options.origin || 'lifecycle' }, {
            store, backend, assertCapability, tools: context.gpu?.grant?.mps, check,
            drain: async (client) => {
                check();
                const record = loadRegistry()[client.key];
                if (!record || record.instanceId !== client.instanceId || record.enableGeneration !== client.enableGeneration || record.containerId !== client.containerId) throw new HardwareStoreError('MPS cohort registry identity changed before drain', { code: 'identity_changed', status: 409 });
                if (drainClient) return drainClient(client, record, capability);
                const plan = plans.get(client.key) || loadPlan(client.ref, record);
                const observation = inspectMpsClient(client, { runtime: plan.runtime, network: plan.profile.network, alias: record.alias || '' });
                if (observation.state === 'absent') return;
                if (observation.state !== 'exact' || observation.id !== client.containerId) throw new HardwareStoreError('MPS cohort runtime ownership changed before drain', { code: 'identity_changed', status: 409 });
                if (observation.running === false) {
                    check();
                    retireExactAgentRuntimePredecessor({ containerName: client.key, containerId: client.containerId, registryRecord: record, runtimeNetwork: plan.profile.network }, { networkLifecycleCapability: capability });
                    return;
                }
                const transition = await prepareTargetedAgentRestart({ containerName: client.key, routeKey: record.alias || record.agentName, record, networkLifecycleCapability: capability });
                check();
                drainTargetedContainer(client.key, { ...transition.targetedRestart, runtime: plan.runtime, timeoutMs: Math.min(30_000, Math.max(1, (options.deadline || Date.now() + 30_000) - Date.now())), retireControlSocket: retireRuntimeRelaySocket });
                check();
                retireExactAgentRuntimePredecessor({ containerName: client.key, containerId: client.containerId, registryRecord: record, runtimeNetwork: plan.profile.network }, { networkLifecycleCapability: capability });
            },
            recreate: async (client, state) => {
                check();
                const capturedRecord = recordFor.get(client.key);
                const currentRecord = loadRegistry()[client.key];
                if (registry[client.key] && !isDeepStrictEqual(currentRecord, capturedRecord)) throw new HardwareStoreError('MPS exact client identity changed before recreate', { code: 'identity_changed', status: 409 });
                const mpsLaunch = createMpsLaunch({ key: client.key, share: client.share, state, imageId: images.get(client.key) || null });
                if (client.key === target.key) {
                    targetResult = await launchTarget({ ...options, mpsLaunch, mpsTransitionAction: 'clients', networkLifecycleCapability: capability });
                    if (targetResult?.state === 'applied') return targetResult;
                    if (targetResult?.mpsReady) return { key: client.key, observedKey: targetResult.containerName, state: 'applied', containerId: targetResult.containerId };
                    const launchedClient = { ...client, mpsGeneration: state ? `${state.daemonGeneration}:${state.configurationGeneration}` : '', key: targetResult.containerName, containerId: targetResult.containerId, instanceId: targetResult.registryRecord?.instanceId, enableGeneration: targetResult.registryRecord?.enableGeneration };
                    if (client.share) Object.defineProperty(targetResult, 'mpsReadiness', { value: { mpsLaunch, key: client.key, share: client.share, client: launchedClient }, configurable: true });
                    return { key: client.key, state: 'starting', containerId: targetResult.containerId, client: launchedClient };
                }
                const captured = captureExactHardwareInstances(loadRegistry(), [client.key])[0];
                return reconcile(captured, { ...options, expectedToken: token, mpsLaunch, networkLifecycleCapability: capability });
            },
            onPlan: (plan) => { beforePlan(plan); options.onMpsPlan?.(plan); if (!options.onMpsPlan && plan.expandedKeys.length) console.log(`[hardware-limits] GPU coordination also recreates: ${plan.expandedKeys.join(', ')}`); },
            onResult: (result) => options.onMpsResult?.(result),
        });
        if (!targetResult) {
            check();
            if (registry[target.key] && !isDeepStrictEqual(loadRegistry()[target.key], recordFor.get(target.key))) throw new HardwareStoreError('MPS exact target identity changed before reuse', { code: 'identity_changed', status: 409 });
            const mpsLaunch = createMpsLaunch({ key: target.key, share: selected?.share || null, state: result.state, imageId: images.get(target.key) || null });
            targetResult = await launchTarget({ ...options, mpsLaunch, networkLifecycleCapability: capability });
        }
        return targetResult;
    }, options.networkLifecycleCapability ? { capability: options.networkLifecycleCapability } : { waitMs: 60_000 });
}

async function ensureMpsAgentServiceImpl(agentName, manifest, agentPath, options = {}) {
    if (options.preparationLease) return ensureMpsGraphAgentService(agentName, manifest, agentPath, options);
    const repoName = resolveAgentRepositoryName(agentPath);
    const key = options.hardwareInstanceKey || options.containerName || getAgentContainerName(agentName, repoName);
    const record = readAgentRegistrySnapshot()[key] || options.preparedRegistryRecord || { type: 'agent', repoName, agentName, alias: options.alias || '', profile: options.profileName || '', instanceId: options.instanceId, enableGeneration: options.enableGeneration };
    return coordinateMpsLifecycle({ target: { key, record }, options, launchTarget: async (next) => {
        if (readAgentRegistrySnapshot()[key] && !options.preservePreparedRegistryRecord && !options.preparationLease && (next.mpsTransitionAction !== 'reuse' || options.forceRecreate)) {
            const result = await reconcileExactHardwareInstance(captureExactHardwareInstances(readAgentRegistrySnapshot(), [key])[0], next);
            return Object.defineProperty({ ...result.runtimeResult, requiresEdgeActivation: false }, 'mpsReady', { value: true });
        }
        return ensureAgentService(agentName, manifest, agentPath, next);
    } });
}

/** A prepared graph owns its routing transaction. This path only manages the
 * already-drained daemon and creates its one target under that graph's lease. */
export async function ensureMpsGraphAgentService(agentName, manifest, agentPath, options, {
    readContext = readBoxHardwareContext, loadRegistry = readAgentRegistrySnapshot,
    loadPlan = loadClientPlan, prepareImage = ensureImagePresent, inspectImage = inspectPreparedMpsImage,
    store = createMpsStateStore(), backend = createMpsDaemonBackend(), ensure = ensureAgentService,
    assertCapability = assertNetworkLifecycleCapability, policyCheck = assertHardwareApplyInputs,
    resolveShare = resolveStoredGpuShare, observeClients = assertKnownMpsClients,
} = {}) {
    assertCapability(options.networkLifecycleCapability);
    const context = readContext();
    const token = context.storeToken;
    const check = () => { options.beforeHardwareMutation?.(); policyCheck(token, { origin: options.origin || 'cli' }); };
    check();
    const repoName = resolveAgentRepositoryName(agentPath);
    const key = options.hardwareInstanceKey || options.containerName || getAgentContainerName(agentName, repoName);
    const record = options.preparedRegistryRecord || loadRegistry()[key];
    if (!record?.instanceId || !record?.enableGeneration) throw new MpsError('Prepared GPU target has no exact graph identity');
    const ref = `${repoName}/${agentName}`;
    const policy = context.overrides?.get(ref)?.gpu;
    const share = policy ? resolveShare(policy, context.gpu, ref) : null;
    const plan = loadPlan(ref, record);
    let imageId = null;
    if (share) {
        prepareImage(plan.image, { runtime: plan.runtime });
        imageId = inspectMpsImage({ image: plan.image, networkMode: plan.profile.network.mode }, { inspectImage: (image) => inspectImage(image, { runtime: plan.runtime }) }).imageId;
    }
    let state = store.read();
    observeClients({ runtime: plan.runtime, registry: loadRegistry(), state });
    const configured = [...context.overrides || []].filter(([, value]) => value.gpu).flatMap(([agentRef, value]) => {
        try { return [{ share: resolveShare(value.gpu, context.gpu, agentRef) }]; } catch (error) { if (agentRef === ref) throw error; return []; }
    });
    const { resolveMpsServerDefault } = await import('./mpsTransition.mjs');
    const serverDefault = resolveMpsServerDefault(configured);
    const identityOf = (client) => [client.key, client.instanceId, client.enableGeneration, client.containerId || ''].join('\0');
    const drained = new Set(state?.drainedClients || []);
    const allDrained = (state?.oldClients || []).every((client) => drained.has(identityOf(client)));
    const observation = state?.daemon || state?.pipeDirectory ? backend.observe(state) : { state: 'gone' };
    if (['foreign', 'unknown'].includes(observation.state)) throw new MpsError('Prepared graph cannot adopt an unknown MPS daemon');
    const defaultsChanged = !isDeepStrictEqual(state?.serverDefault || null, serverDefault);
    const mustRestart = Boolean(state?.graphNeedsTransition || defaultsChanged || (state?.daemon && !backend.verify(state)));
    if (mustRestart && state?.daemon && (!state.graphPrepared || !allDrained)) throw new MpsError('MPS cohort was not completely drained by graph preparation');
    if (mustRestart && state?.daemon) {
        check(); if (observation.state === 'owned') backend.stop(state);
        state = { ...state, daemon: null, daemonGeneration: null, configurationGeneration: null, status: 'pending' }; store.write(state);
    }
    if (mustRestart && state?.pipeDirectory) {
        check(); backend.cleanup(state);
        state = { ...state, pipeDirectory: null, logDirectory: null }; store.write(state);
    }
    if (share && !state?.daemon) {
        check();
        const previous = state || {};
        const daemon = backend.start(serverDefault, { tools: context.gpu?.grant?.mps, onState: (value) => { state = { ...previous, ...value, pendingClients: previous.pendingClients || [] }; store.write(state); } });
        state = { ...previous, ...daemon, pendingClients: previous.pendingClients || [], graphPrepared: false, graphNeedsTransition: false, oldClients: [], drainedClients: [] };
        store.write(state);
    }
    if (!share && !state?.daemon && state) {
        state = { ...state, status: 'inactive', serverDefault: null, graphPrepared: false, graphNeedsTransition: false, oldClients: [], drainedClients: [] }; store.write(state);
    }
    if (share && !backend.verify(state)) throw new MpsError('MPS defaults could not be verified for graph launch');
    const mpsLaunch = createMpsLaunch({ key, share, state: share ? { ...state, status: 'ready' } : null, imageId });
    check();
    if (share) {
        const pending = { key, ref, instanceId: record.instanceId, enableGeneration: record.enableGeneration, containerId: null, share, phase: 'launching' };
        state = { ...store.read(), status: 'ready', pendingClients: [...(store.read()?.pendingClients || []).filter((value) => value.key !== key), pending] };
        store.write(state);
    }
    let result;
    try { result = await ensure(agentName, manifest, agentPath, { ...options, mpsLaunch }); }
    catch (error) {
        if (share) store.write({ ...store.read(), status: 'pending', lastProblem: { code: String(error.code || 'client_launch_failed').slice(0, 64), message: 'Graph MPS client launch did not complete; its route remains inactive.' } });
        throw error;
    }
    if (share) {
        const client = { key: result.containerName, ref, instanceId: result.registryRecord?.instanceId, enableGeneration: result.registryRecord?.enableGeneration, containerId: result.containerId, share, mpsGeneration: `${state.daemonGeneration}:${state.configurationGeneration}`, phase: 'readiness' };
        state = { ...store.read(), pendingClients: [...(store.read()?.pendingClients || []).filter((value) => value.key !== client.key), client] };
        store.write(state);
        Object.defineProperty(result, 'mpsReadiness', { value: { mpsLaunch, key, share, client }, configurable: true });
    }
    return result;
}

async function acknowledgeMpsRuntimeReadyStrict(result, { store = createMpsStateStore(), backend = createMpsDaemonBackend(), loadRegistry = readAgentRegistrySnapshot } = {}) {
    if (!result?.mpsReadiness) return;
    const { mpsLaunch, key, share, client } = result.mpsReadiness;
    verifyMpsLaunch(mpsLaunch, key, share, { store, backend });
    const record = loadRegistry()[client.key];
    if (!record || record.containerId !== client.containerId || record.instanceId !== client.instanceId || record.enableGeneration !== client.enableGeneration) throw new MpsError('Ready MPS target no longer has its exact published identity');
    const state = store.read();
    store.write({ ...state, pendingClients: (state.pendingClients || []).filter((entry) => !(entry.key === client.key && entry.containerId === client.containerId && entry.instanceId === client.instanceId && entry.enableGeneration === client.enableGeneration)) });
}

function typedMpsFailure(error, target) {
    if (['identity_changed', 'revision_conflict', 'apply_timeout', 'hardware_limits_transition'].includes(error?.code)) return error;
    if (!(error instanceof MpsError) && error?.code !== 'gpu_sharing_unavailable' && error?.code !== 'image_preparation_required') return error;
    const ref = `${target.record.repoName}/${target.record.agentName}`;
    return new HardwareLimitsError(buildDirectRefusal({ key: target.key, ref, alias: target.record.alias || null,
        refusalParts: { reasonCode: 'gpu_sharing_unavailable', reason: String(error.message).slice(0, 1024),
            fix: `Inspect ploinky limits status, repair the GPU prerequisite, then restart the agent; or clear its GPU share in Settings or with ploinky limits clear --agent ${ref} on the host.`,
            requested: [{ field: 'gpu', value: 'configured MPS share', source: 'settings' }] },
        inputFingerprint: hex64({ ref, key: target.key, reason: error.message }),
    }));
}
export async function coordinateMpsLifecycle(input, dependencies) {
    try { return await coordinateMpsLifecycleImpl(input, dependencies); }
    catch (error) { throw typedMpsFailure(error, input.target); }
}
export async function ensureMpsAgentService(agentName, manifest, agentPath, options = {}) {
    try { return await ensureMpsAgentServiceImpl(agentName, manifest, agentPath, options); }
    catch (error) {
        const repoName = resolveAgentRepositoryName(agentPath);
        throw typedMpsFailure(error, { key: options.hardwareInstanceKey || options.containerName || getAgentContainerName(agentName, repoName), record: { repoName, agentName, alias: options.alias } });
    }
}

export async function finalizeMpsGraph({ networkLifecycleCapability } = {}, {
    readContext = readBoxHardwareContext, store = createMpsStateStore(), backend = createMpsDaemonBackend(),
    assertCapability = assertNetworkLifecycleCapability, policyCheck = assertHardwareApplyInputs,
} = {}) {
    assertCapability(networkLifecycleCapability);
    const context = readContext();
    if (context.gate !== 'on') return;
    let state = store.read();
    if (!state?.graphPrepared) return;
    const check = () => policyCheck(context.storeToken, { origin: 'cli' });
    check();
    if ([...context.overrides?.values() || []].some((entry) => entry.gpu)) {
        if (!state.graphNeedsTransition) store.write({ ...state, status: state.pendingClients?.some((client) => client.phase !== 'readiness') ? 'pending' : state.daemon && backend.verify(state) ? 'ready' : 'inactive', graphPrepared: false, oldClients: [], drainedClients: [], replacedKeys: [] });
        return;
    }
    const drained = new Set(state.drainedClients || []);
    if ((state.oldClients || []).some((client) => !drained.has([client.key, client.instanceId, client.enableGeneration, client.containerId || ''].join('\0')))) throw new MpsError('Final GPU clear has an undrained exact predecessor');
    const observed = state.daemon || state.pipeDirectory ? backend.observe(state) : { state: 'gone' };
    if (!['owned', 'gone'].includes(observed.state)) throw new MpsError('Final GPU clear cannot prove daemon ownership');
    state = { ...state, status: 'transitioning' }; store.write(state);
    if (state.daemon && observed.state === 'owned') { check(); backend.stop(state); }
    state = { ...state, daemon: null, daemonGeneration: null, configurationGeneration: null }; store.write(state);
    if (state.pipeDirectory) { check(); backend.cleanup(state); }
    check();
    store.write({ ...state, status: 'inactive', serverDefault: null, pipeDirectory: null, logDirectory: null,
        oldClients: [], drainedClients: [], pendingClients: [], desiredClients: [], graphPrepared: false,
        graphNeedsTransition: false, replacedKeys: [], lastProblem: null });
}

/** Prepare an enable transaction before it captures its additive route lease.
 * The target remains a journaled intent until that caller creates and readies it. */
export async function prepareMpsClientLaunch(target, options = {}) {
    const context = readBoxHardwareContext();
    const ref = `${target.record.repoName}/${target.record.agentName}`;
    const applied = target.record.containerId ? readAppliedObservation(target.key, target.record.containerId) : null;
    if (!context.overrides?.get(ref)?.gpu && !applied?.mpsGeneration) return null;
    let launch;
    await coordinateMpsLifecycle({ target, options, launchTarget: async (next) => {
        launch = next.mpsLaunch;
        return { containerName: target.key, containerId: null, registryRecord: target.record };
    } });
    return launch;
}

export function trackMpsRuntimePending(result, { mpsLaunch, key }, { store = createMpsStateStore() } = {}) {
    if (!mpsLaunch) return result;
    const launch = readMpsLaunchForTracking(mpsLaunch, key);
    if (!launch.share) return result;
    const record = result?.registryRecord;
    if (!record?.instanceId || !record?.enableGeneration || !/^[a-f0-9]{64}$/.test(result.containerId)) throw new MpsError('MPS client readiness requires its exact created identity');
    const client = { key: result.containerName, ref: `${record.repoName}/${record.agentName}`, instanceId: record.instanceId,
        enableGeneration: record.enableGeneration, containerId: result.containerId, share: launch.share, mpsGeneration: `${launch.state.daemonGeneration}:${launch.state.configurationGeneration}`, phase: 'readiness' };
    const state = store.read();
    if (state?.daemonGeneration !== launch.state?.daemonGeneration || state?.configurationGeneration !== launch.state?.configurationGeneration) throw new MpsError('MPS generation changed before readiness tracking');
    store.write({ ...state, pendingClients: [...(state.pendingClients || []).filter((entry) => entry.key !== key && entry.key !== client.key), client] });
    Object.defineProperty(result, 'mpsReadiness', { value: { mpsLaunch, key, share: launch.share, client }, configurable: true });
    return result;
}

export async function verifyMpsRuntimeReady(result, { store = createMpsStateStore(), backend = createMpsDaemonBackend(), verifyRuntime = verifyMpsRuntimeObservation } = {}) {
    if (!result?.mpsReadiness) return true;
    const { mpsLaunch, key, share, client } = result.mpsReadiness;
    const launch = verifyMpsLaunch(mpsLaunch, key, share, { store, backend });
    verifyRuntime({ containerId: client.containerId, imageId: launch.imageId, share, state: launch.state, runtime: result.registryRecord?.runtime || 'podman' });
    return true;
}

export async function acknowledgeMpsRuntimeReady(result, { report = () => console.warn('[hardware-limits] MPS readiness receipt remains pending; inspect ploinky limits status.'), ...dependencies } = {}) {
    try { await acknowledgeMpsRuntimeReadyStrict(result, dependencies); return { acknowledged: true }; }
    catch (_) { report(); return { acknowledged: false }; }
}
