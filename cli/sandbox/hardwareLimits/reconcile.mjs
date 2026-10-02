import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withWorkspaceMutationLease, withMaintenanceLock } from '../../utils/runtime/maintenanceLocks.js';
import { withNetworkLifecycleLock, createNetworkLifecycleAdapter } from '../networkLifecycle.js';
import { networkContractHash } from '../networkContract.js';
import { readAgentRegistrySnapshot } from '../../utils/agentRegistrySnapshot.js';
import { findAgent } from '../../utils/utils.js';
import { resolveManifestRuntimeProfile } from '../../utils/runtime/profileService.js';
import { resolveRouterEndpoint } from '../routerPort.js';
import { ensureAgentService, retireExactAgentRuntimePredecessor } from '../docker/agentServiceManager.js';
import { getRuntimeForAgent, isSandboxRuntime, getContainerLabel, getRuntime } from '../docker/common.js';
import { resolveLlmRuntimeAdmissionContext } from '../docker/llmRuntimeIntegration.js';
import { admitManifestRuntimeCapabilities, hardwareLimitsHashOf } from '../runtimeCapabilities.js';
import { waitForManifestReadiness, activatePreparedRuntimeAfterReadiness, cleanupFailedPreparedRuntime, admitWorkspaceGraphRuntimeCapabilities } from '../../commands/workspaceUtil.js';
import { prepareTargetedAgentRestart, commitTargetedAgentRestart, cleanupFailedTargetedAgentRestart } from '../../commands/targetedAgentRestart.js';
import { readRoutingConfig, mergeRoutingConfig } from '../../server/routingFile.js';
import { buildAvailabilityProjection, markRouteHardwareUnavailable } from '../../server/hardwareAvailability.mjs';
import { findHardwareOutcome, assertRepresentableIdentity, HardwareLimitsError } from './errors.mjs';
import { blockingEdgesFromGraph, classifyAvailability } from './outcomes.mjs';
import { resolveWorkspaceDependencyGraph, effectiveInstanceKey } from '../../utils/workspaceDependencyGraph.js';
import { readBoxHardwareContext } from './context.mjs';
import { readBoxHardwareMarker } from '../../../ploinky-box/lib/hardwareLimitsMarker.mjs';
import { hardwareStorePaths, readStoreSnapshot, validateStoreToken, assertPolicyWritesAllowed, HardwareStoreError } from './store.mjs';
import { readAppliedObservation } from './runtimeState.mjs';
import { verifyLaunchedHardwareLimits } from './delegation.mjs';
import { hasMpsLaunch } from './mpsLaunch.mjs';
import { coordinateMpsLifecycle, trackMpsRuntimePending, verifyMpsRuntimeReady, acknowledgeMpsRuntimeReady, releaseMpsRuntimeOwner } from './mpsLifecycle.mjs';
import { readMpsStatus, inspectPreparedMpsImage } from './mpsStatus.mjs';
import { inspectMpsImage } from './mpsEligibility.mjs';
import { createMpsStateStore } from './mps.mjs';
import { verifyMpsRuntimeObservation } from './mpsRuntimeObservation.mjs';
import { resolveManifestImage } from '../../utils/security/secretVars.js';
import { inApplyStep, describeApplyCause, formatApplyCause } from './applyCause.mjs';

const APPLY_FAILED_FIX = 'This exact instance was not applied. Reload its state and retry.';
function failure(code, message, status = 409) { return new HardwareStoreError(message, { code, status }); }

export function captureExactHardwareInstances(registry, keys) {
    return [...new Set(keys)].map((key) => {
        if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 1024) throw failure('invalid_limits', 'Apply requires a representable exact registry key.', 400);
        const record = Object.hasOwn(registry, key) ? registry[key] : null;
        if (record?.type !== 'agent') throw failure('unknown_container', `No registered agent has exact key ${key}.`, 404);
        assertRepresentableIdentity({ key, ref: `${record.repoName}/${record.agentName}`, alias: record.alias || null });
        if (!record.instanceId || !record.enableGeneration) throw failure('identity_changed', `The runtime identity for ${key} is incomplete.`);
        return Object.freeze({ key, record: structuredClone(record) });
    });
}

export function assertExactHardwareInstance(captured, registry) {
    const current = Object.hasOwn(registry, captured.key) ? registry[captured.key] : null;
    if (current?.type !== 'agent' || !isDeepStrictEqual(current, captured.record)) throw failure('identity_changed', `The exact registry identity for ${captured.key} changed before Apply.`);
    return current;
}

export function expandHardwareRecoveryKeys(keys, registry, routing) {
    const expanded = new Set(keys);
    let changed = true;
    while (changed) {
        changed = false;
        for (const route of Object.values(routing.routes || {})) {
            const value = route?.hardwareAvailability;
            const record = registry[value?.key];
            if (value?.state !== 'blocked' || record?.type !== 'agent' || value.instanceId !== record.instanceId || value.enableGeneration !== record.enableGeneration) continue;
            const cause = value.problem;
            if (expanded.has(cause?.rootCause?.key) || expanded.has(cause?.blockedBy?.key)) {
                if (!expanded.has(value.key)) { expanded.add(value.key); changed = true; }
            }
        }
    }
    const ordered = [];
    const visited = new Set();
    const visit = (key) => {
        if (visited.has(key)) return;
        visited.add(key);
        const route = Object.values(routing.routes || {}).find((value) => value?.hardwareAvailability?.key === key);
        const prerequisite = route?.hardwareAvailability?.problem?.blockedBy?.key;
        if (expanded.has(prerequisite)) visit(prerequisite);
        ordered.push(key);
    };
    for (const key of [...expanded].sort()) visit(key);
    return ordered;
}

function defaultPolicy() {
    readBoxHardwareContext({ refreshBackend: true });
    const marker = readBoxHardwareMarker();
    if (!marker.present) return { paths: null, identity: null, token: null };
    if (!marker.valid) throw failure('store_unreadable', 'The hardware marker cannot be read safely.', 503);
    const identity = { instance: marker.marker.instance, pathHash: marker.marker.pathHash, workspaceRoot: marker.marker.workspaceRoot };
    const paths = hardwareStorePaths({ identity, context: 'box' });
    const snapshot = readStoreSnapshot({ paths, identity });
    if (snapshot.status !== 'valid' || snapshot.storeId !== marker.marker.storeId) throw failure('store_unreadable', 'The bound hardware policy store cannot be read safely.', 503);
    return { paths, identity, token: snapshot.token };
}

export function assertHardwareApplyInputs(expectedToken, { origin = 'apply', readPolicy = defaultPolicy, assertWrites = assertPolicyWritesAllowed } = {}) {
    const policy = readPolicy();
    if (origin === 'apply') {
        if (!policy.paths) throw failure('hardware_limits_off', 'Hardware Apply requires a wired Ploinky Box.');
        assertWrites({ paths: policy.paths });
    }
    if (expectedToken !== undefined && !isDeepStrictEqual(expectedToken === null ? null : validateStoreToken(expectedToken), policy.token)) throw failure('revision_conflict', 'The hardware policy changed during reconciliation; completed instances remain applied. Reload and retry pending instances.');
    return policy;
}

function readPlan(captured, { hardwareAdmission = 'strict' } = {}) {
    const ref = `${captured.record.repoName}/${captured.record.agentName}`;
    const resolved = findAgent(ref);
    const bytes = fs.readFileSync(resolved.manifestPath);
    const manifest = JSON.parse(bytes.toString('utf8'));
    const profileResolution = resolveManifestRuntimeProfile(manifest, { agentName: ref, profileName: captured.record.profile || undefined });
    const registry = readAgentRegistrySnapshot();
    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: ref, registry, rootAlias: captured.record.alias || '', rootProfile: captured.record.profile || '' });
    const admissions = admitWorkspaceGraphRuntimeCapabilities(graph, { registry });
    const byNode = new Map(admissions.map((value) => [value.nodeId, value]));
    const edges = blockingEdgesFromGraph(graph, (nodeId) => byNode.get(nodeId)?.key);
    const outcomes = classifyAvailability({
        nodes: admissions.map((value) => ({ key: value.key, ref: value.admission.agentId, alias: value.alias, refusal: value.hardwareRefusal })), edges,
    });
    const ownOutcome = outcomes.get(captured.key)?.outcome;
    const runtime = getRuntimeForAgent(manifest);
    const llm = isSandboxRuntime(runtime) ? {} : resolveLlmRuntimeAdmissionContext({ runtime, manifest, profileConfig: profileResolution.profileConfig, agentName: captured.record.agentName, alias: captured.record.alias, env: process.env });
    const runtimeAdmission = admitManifestRuntimeCapabilities(manifest, {
        manifestBytes: bytes, manifestPath: resolved.manifestPath, agentId: ref,
        profileName: profileResolution.resolvedProfileName, profileConfig: profileResolution.profileConfig,
        network: profileResolution.network, runtime, runtimeKind: isSandboxRuntime(runtime) ? runtime : 'container',
        catalogPolicy: llm.catalogPolicy, catalogIdentity: llm.catalogIdentity,
        instanceKey: captured.key, alias: captured.record.alias || '', hardwareAdmission: 'metadata',
    });
    const image = runtimeAdmission.descriptor.hardwareGpu ? llm.startup?.selection?.imageRef || resolveManifestImage(manifest, profileResolution.profileConfig, { agentName: captured.record.agentName, repoName: captured.record.repoName }) : null;
    return { ref, resolved, manifest, bytes, profileResolution, runtime, runtimeAdmission, image, hardwareOutcome: ownOutcome, agentPath: path.dirname(resolved.manifestPath), routerEndpoint: resolveRouterEndpoint(profileResolution.network.mode) };
}

export function hardwareApplyIsUnchanged(captured, plan, {
    loadRouting = readRoutingConfig,
    inspect = () => createNetworkLifecycleAdapter({ runtime: getRuntime() }).inspectContainerContract(captured.key, plan.profileResolution.network, captured.record.agentName, {
        instanceKey: effectiveInstanceKey(captured.record.repoName, captured.record.agentName, captured.record.alias || ''),
        contractHash: networkContractHash(plan.profileResolution.network), instanceId: captured.record.instanceId, enableGeneration: captured.record.enableGeneration, requireRuntimeIdentity: true,
    }),
    readApplied = readAppliedObservation, readLabel = getContainerLabel, verifyLimits = verifyLaunchedHardwareLimits,
    fsApi = fs, cgroupRoot = '/sys/fs/cgroup', procRoot = '/proc',
    query = (command, args, { timeoutMs = 10_000 } = {}) => {
        const reply = spawnSync(command, args, { encoding: 'utf8', timeout: Math.min(timeoutMs, 10_000), maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: reply.status === 0 && !reply.error && !reply.signal, stdout: String(reply.stdout || '') };
    },
    readMps = readMpsStatus, verifyMps = (_captured, currentPlan, containerId) => {
        const prepared = inspectMpsImage({ image: currentPlan.image, networkMode: currentPlan.profileResolution.network.mode }, { inspectImage: (image) => inspectPreparedMpsImage(image, { runtime: currentPlan.runtime }) });
        return verifyMpsRuntimeObservation({ containerId, imageId: prepared.imageId, share: currentPlan.runtimeAdmission.descriptor.hardwareGpu, state: createMpsStateStore().read(), runtime: currentPlan.runtime });
    },
} = {}) {
    if (Object.values(loadRouting().routes || {}).some((route) => route?.container === captured.key && route.hardwareAvailability)) return false;
    const hash = hardwareLimitsHashOf(plan.runtimeAdmission.descriptor);
    const observed = inspect();
    if (observed?.state !== 'exact' || observed.id !== captured.record.containerId || observed.running !== true) return false;
    if (!hash) return !plan.hardwareOutcome && !(plan.runtimeAdmission.descriptor.hardwareRequest?.length) && !readLabel(captured.key, 'ploinky.limitshash');
    const applied = readApplied(captured.key, captured.record.containerId);
    try { verifyLimits({ descriptor: plan.runtimeAdmission.descriptor, containerId: observed.id, runtime: plan.runtime || getRuntime(), query, fsApi, cgroupRoot, procRoot, refuse: (detail) => failure('hardware_limits_drift', String(detail).slice(0, 2048)) }); } catch (_) { return false; }
    if (plan.runtimeAdmission.descriptor.hardwareGpu) {
        if (!applied?.mpsGeneration || applied.mpsGeneration !== readMps().mpsGeneration || readLabel(captured.key, 'ploinky.mpsgeneration') !== applied.mpsGeneration) return false;
        try { verifyMps(captured, plan, observed.id); } catch (_) { return false; }
    }
    return Boolean(hash && applied && applied.instanceId === captured.record.instanceId && applied.enableGeneration === captured.record.enableGeneration && applied.limitsHash === hash
        && readLabel(captured.key, 'ploinky.limitshash') === hash);
}

export async function reconcileExactHardwareInstance(captured, {
    origin = 'cli', expectedToken = undefined, networkLifecycleCapability = null,
    deadline = Date.now() + 15 * 60 * 1000,
    authorize = () => true, isCancelled = () => false, mpsLaunch = null, onMpsPlan = () => {}, onMpsResult = () => {},
} = {}, {
    loadRegistry = readAgentRegistrySnapshot, loadPlan = readPlan, readPolicy = defaultPolicy,
    policyCheck = assertHardwareApplyInputs, maintenance = withMaintenanceLock, network = withNetworkLifecycleLock,
    prepare = prepareTargetedAgentRestart, ensure = ensureAgentService, readiness = waitForManifestReadiness,
    commit = commitTargetedAgentRestart, activate = activatePreparedRuntimeAfterReadiness,
    cleanupTargeted = cleanupFailedTargetedAgentRestart, cleanupPrepared = cleanupFailedPreparedRuntime,
    loadRouting = readRoutingConfig, publishUnavailable = mergeRoutingConfig,
    retireUnavailable = retireExactAgentRuntimePredecessor,
} = {}) {
    let capturedToken = expectedToken;
    const checkPolicy = () => {
        if (isCancelled() || Date.now() >= deadline) throw failure('apply_timeout', `The deadline for ${captured.key} expired.`, 504);
        if (authorize() !== true) throw failure('identity_changed', 'The authenticated routing authority changed before mutation.');
        if (capturedToken === undefined) capturedToken = readPolicy().token;
        policyCheck(capturedToken, { origin, readPolicy });
        return true;
    };
    const check = () => {
        checkPolicy();
        assertExactHardwareInstance(captured, loadRegistry());
    };
    const maintain = hasMpsLaunch(mpsLaunch) && networkLifecycleCapability ? (_key, _options, callback) => callback() : maintenance;
    return maintain(captured.key, { operation: origin === 'apply' ? 'hardware-apply' : 'restart' }, () => network(async (capability) => {
        check();
        let result = null;
        let transition = null;
        let plan = null;
        try {
            plan = inApplyStep('planning', () => loadPlan(captured));
            if (plan.hardwareOutcome) throw new HardwareLimitsError(plan.hardwareOutcome);
            const priorMps = readAppliedObservation(captured.key, captured.record.containerId);
            if (!hasMpsLaunch(mpsLaunch) && (plan.runtimeAdmission?.descriptor?.hardwareGpu || priorMps?.mpsGeneration)) {
                return await coordinateMpsLifecycle({ target: captured, options: { origin, expectedToken: capturedToken, deadline, authorize, isCancelled, onMpsPlan, onMpsResult, networkLifecycleCapability: capability },
                    launchTarget: (next) => reconcileExactHardwareInstance(captured, next) });
            }
            const routeKey = captured.record.alias || captured.record.agentName;
            const route = loadRouting().routes?.[routeKey];
            if (!isSandboxRuntime(plan.runtime) && route && !route.hardwareAvailability) {
                check();
                transition = await inApplyStep('restart-preparation', () => prepare({ containerName: captured.key, routeKey, repoName: captured.record.repoName, shortAgentName: captured.record.agentName, record: captured.record, networkLifecycleCapability: capability }));
            }
            // Preparation can rotate the registry. Revalidate its own exact
            // successor before create, while token/barrier checks stay fresh.
            checkPolicy();
            const gpuClient = Boolean(plan.runtimeAdmission?.descriptor?.hardwareGpu);
            result = await inApplyStep(gpuClient ? 'client-launch' : 'runtime-launch', () => ensure(captured.record.agentName, plan.manifest, plan.agentPath, {
                containerName: captured.key, alias: captured.record.alias, forceRecreate: true, forceRecreateReason: 'hardware limits reconciliation',
                hardwareInstanceKey: captured.key,
                profileName: plan.profileResolution.resolvedProfileName, profileResolution: plan.profileResolution,
                routerEndpoint: plan.routerEndpoint, runtimeAdmission: plan.runtimeAdmission,
                networkLifecycleCapability: capability,
                ...(transition ? { instanceId: transition.identity.instanceId, enableGeneration: transition.identity.enableGeneration, targetedRestart: transition.targetedRestart } : {}),
                beforeHardwareMutation: checkPolicy,
                mpsLaunch,
            }));
            if (mpsLaunch && gpuClient) inApplyStep('client-launch', () => trackMpsRuntimePending(result, { mpsLaunch, key: captured.key }));
            await inApplyStep('readiness', () => readiness({ key: captured.key, label: captured.record.agentName, kind: 'reinstall', manifest: plan.manifest, route: { container: result.containerName, hostPort: result.hostPort || 0 } }, { deadline, beforeProbe: checkPolicy }));
            checkPolicy();
            await inApplyStep('verify', () => verifyMpsRuntimeReady(result));
            await inApplyStep('activation', () => (transition
                ? commit({ transition, result, agentPath: plan.agentPath, alias: captured.record.alias || '', networkLifecycleCapability: capability })
                : activate({ result, routeKey, repoName: captured.record.repoName, shortAgentName: captured.record.agentName, agentPath: plan.agentPath, alias: captured.record.alias || '', networkLifecycleCapability: capability })));
            await acknowledgeMpsRuntimeReady(result);
            return Object.defineProperty({ key: captured.key, observedKey: result.containerName, instanceId: result.registryRecord?.instanceId, enableGeneration: result.registryRecord?.enableGeneration, containerId: result.containerId, state: 'applied', problem: null }, 'runtimeResult', { value: result });
        } catch (error) {
            releaseMpsRuntimeOwner(result);
            if (transition) cleanupTargeted(result, error);
            else cleanupPrepared(result, error, 'hardware-reconcile-failed');
            const problem = findHardwareOutcome(error);
            if (problem && problem.key === captured.key) {
                checkPolicy();
                const current = loadRegistry()[captured.key];
                if (current?.instanceId && current?.enableGeneration) {
                    const projection = buildAvailabilityProjection({ outcome: problem, instanceId: current.instanceId, enableGeneration: current.enableGeneration });
                    await publishUnavailable((routing) => {
                        for (const [routeKey, route] of Object.entries(routing.routes || {})) if (route?.container === captured.key) routing.routes[routeKey] = markRouteHardwareUnavailable(route, projection);
                        return routing;
                    }, { reason: 'hardware-apply-refused', networkLifecycleCapability: capability });
                    if (plan && captured.record.containerId && current.containerId === captured.record.containerId) {
                        checkPolicy();
                        try {
                            retireUnavailable({ containerName: captured.key, containerId: captured.record.containerId, registryRecord: captured.record, runtimeNetwork: plan.profileResolution.network }, { networkLifecycleCapability: capability });
                        } catch (cleanupError) {
                            throw failure('hardware_cleanup_failed', `The refused instance ${captured.key} has inactive routes, but exact runtime cleanup failed. Repair ownership and restart on the host.`, 503);
                        }
                    }
                }
            }
            throw error;
        }
    }, networkLifecycleCapability ? { capability: networkLifecycleCapability } : {}));
}

export async function applyHardwareLimits({ expectedToken, containers }, {
    lease = withWorkspaceMutationLease, loadRegistry = readAgentRegistrySnapshot, loadRouting = readRoutingConfig,
    readPolicy = defaultPolicy, policyCheck = assertHardwareApplyInputs, loadPlan = readPlan,
    isUnchanged = hardwareApplyIsUnchanged, reconcile = reconcileExactHardwareInstance,
    onPlan = () => {}, onResult = () => {}, operationTimeoutMs = 15 * 60 * 1000,
    authorize = () => true, isCancelled = () => false, operationDeadline = null,
} = {}) {
    const token = validateStoreToken(expectedToken);
    const deadline = operationDeadline ?? Date.now() + operationTimeoutMs;
    const check = () => {
        if (isCancelled() || Date.now() >= deadline) throw failure('apply_timeout', 'Hardware Apply was cancelled at its deadline; completed instances remain applied.', 504);
        if (authorize() !== true) throw failure('identity_changed', 'The authenticated routing authority changed before Apply.');
        return policyCheck(token, { readPolicy });
    };
    return lease({ operation: 'hardware-apply', waitTimeoutMs: Math.min(operationTimeoutMs, 60_000) }, async () => {
        check();
        const registry = loadRegistry();
        const requested = containers.length ? containers : Object.entries(registry).filter(([, record]) => record?.type === 'agent').map(([key]) => key);
        captureExactHardwareInstances(registry, requested);
        const keys = expandHardwareRecoveryKeys(requested, registry, loadRouting());
        const captured = captureExactHardwareInstances(registry, keys);
        const expandedContainers = keys.filter((key) => !requested.includes(key));
        onPlan({ containers: keys, expandedContainers });
        const results = [];
        const recordResult = (result) => {
            const index = results.findIndex((entry) => entry.key === result.key);
            if (index >= 0) results[index] = result; else results.push(result);
            onResult(result);
        };
        const onMpsPlan = (plan) => {
            for (const key of plan.expandedKeys || []) {
                if (!keys.includes(key)) { keys.push(key); expandedContainers.push(key); }
            }
            onPlan({ containers: [...keys], expandedContainers: [...expandedContainers] });
        };
        for (const instance of captured) {
            if (results.some((result) => result.key === instance.key && result.state === 'applied')) continue;
            try {
                check();
                assertExactHardwareInstance(instance, loadRegistry());
                const plan = loadPlan(instance, { hardwareAdmission: 'metadata' });
                const result = !plan.hardwareOutcome && isUnchanged(instance, plan)
                    ? { key: instance.key, observedKey: instance.key, state: 'unchanged', problem: null }
                    : await reconcile(instance, { origin: 'apply', expectedToken: token, deadline, authorize, isCancelled, onMpsPlan, onMpsResult: recordResult });
                recordResult(result);
            } catch (error) {
                // GPU coordination finished its target but did not recreate
                // some peers: a partial result (207) whose per-agent results
                // name the pending and refused clients. The target is not
                // refused by a peer's failure.
                if (error?.code === 'mps_partial_failure') {
                    for (const entry of [...(error.mpsTransitionResults || []), ...(error.targetResult?.state === 'applied' ? [error.targetResult] : [])]) {
                        if (entry?.key && !results.some((value) => value.key === entry.key && (value.state === 'applied' || value.state === entry.state))) recordResult(entry);
                    }
                    continue;
                }
                const problem = findHardwareOutcome(error);
                // An untyped failure keeps its cause (step, class, code and a
                // bounded secret-free message); the generic text stays the fix.
                const cause = problem ? undefined : describeApplyCause(error, 'apply');
                const result = { key: problem?.key || instance.key, state: problem?.state || 'pending', problem, error: problem?.code || String(error?.code || 'apply_failed'),
                    message: cause ? `Apply stopped at ${formatApplyCause(cause)}` : undefined, ...(cause ? { cause, fix: APPLY_FAILED_FIX } : {}) };
                if (!results.some((entry) => entry.key === result.key && entry.state === 'applied')) recordResult(result);
                if (problem?.key && problem.key !== instance.key) return { ok: false, status: 207, token, expandedContainers, results, pendingContainers: keys.filter((key) => !results.some((entry) => entry.key === key)) };
                if (!problem) return { ok: false, status: error?.status || 409, error: result.error, message: result.message, cause: result.cause, token, expandedContainers, results, pendingContainers: keys.filter((key) => !results.some((result) => result.key === key)) };
            }
        }
        const problems = results.filter((result) => result.problem);
        // A coordinated GPU client that was not recreated is a partial result.
        const pending = results.filter((result) => !result.problem && result.state === 'pending').map((result) => result.key);
        return { ok: problems.length === 0 && pending.length === 0, status: problems.length ? (results.length === 1 ? problems[0].problem.state === 'blocked' ? 424 : 422 : 207) : pending.length ? 207 : 200, token, expandedContainers, results, pendingContainers: pending };
    });
}
