import { buildHostSkillScope } from './skillScope.mjs';
import { readGraphSkillScope, validateGraphSkillScope, writeGraphSkillScope } from './graphSkillScope.mjs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import {
    BOX_LABELS,
    BOX_MEDIA_PORT,
    BOX_ROUTER_CONTAINER_PORT,
    resolveBoxImageReference,
} from './constants.mjs';
import {
    selectWorkspaceAgentLibSource,
    updateWorkspaceAgentLibSource,
} from './agentlib-source.mjs';
import { AGENTLIB_ERROR_CODES, agentLibError, agentLibIdentity } from '../agentlib/contract.mjs';
import { PLOINKY_UPDATED_WORKSPACE_CHECKOUT_ENV } from '../cli/commands/ploinkyUpdateScope.js';
import {
    fingerprintSource,
    sourceIdEquals,
    sourceIdHash,
} from '../agentlib/fingerprint.mjs';
import {
    canonicalWorkspaceRoot,
    localCandidateExists,
    localCandidatePath,
    managedRootPath,
    readActiveDescriptorText,
    restoreActiveDescriptorText,
    writeActiveDescriptor,
} from '../agentlib/source.mjs';
import {
    formatUpdateRequestArgs,
    mapUpdateScope,
    parseUpdateRequest,
    resolveUpdateFolderScope,
    withDefaultUpdateFolder,
    UpdateRequestError,
} from '../cli/commands/updateRequest.js';
import fsPromisesFree from 'node:fs';
import {
    agentLibBoxEnv,
    agentLibContractFromContainer,
    normalizeBoxAgentLib,
} from './contract/agentlib.mjs';
import {
    assertBoxPloinkySource,
    observeContainerRouterBinding,
    validateContainerConfiguration,
    validateContainerPublications,
} from './contract/container.mjs';
import { IMAGE_OBSERVATION_UNAVAILABLE, inspectAndValidateExistingImage } from './contract/image.mjs';
import {
    assertBoxWorkspaceRoot,
    boxWorkspaceExecOptions,
    relativeBoxWorkspacePath,
} from './contract/workspace-root.mjs';
import { discoverBoxOwnership, listWorkspaceContainers } from './engine/discovery.mjs';
import {
    readWorkspaceEdgeDesired,
    stageWorkspaceEdgeDesired,
} from './edgeDesired.mjs';
import { PloinkyBoxError } from './errors.mjs';
import {
    buildGpuWiring,
    createGpuGrantStore,
    declaredGpuAgents,
    defaultGpuVendor,
    discoverGpu,
    effectiveGpuAccess,
    enabledCdiRequestingAgents,
    normalizeGpuAgentSelectors,
    normalizeGpuDecision,
    normalizeGpuVendor,
    normalizeGpuGrant,
    observeContainerGpuWiring,
    resolveDesiredGpuWiring,
    resolveGpuWiring,
    sameGpuWiring,
} from './gpuGrant.mjs';
import { loadBoxAgentLibImage, revalidateContainerAgentLib } from './image-agentlib.mjs';
import {
    HOST_REACHABLE_IPV4_ENV,
    detectHostReachableIpv4,
    isUsableHostIpv4,
} from './hostNetwork.mjs';
import { resolveWorkspaceIdentity } from './identity.mjs';
import {
    GENERIC_INSPECT_ONLY_MESSAGE,
    createHardwareGateStore,
    observeContainerHardwareWiring,
    observeHostLimitsFacts,
    parseHardwareGateValue,
    readHardwareStateClass,
    readLimitsStatus,
    resolveDesiredHardwareWiring,
    runLimitsClear,
    selectHardwareGate,
    HARDWARE_GATE_ENV,
} from './hardwareLimitsGate.mjs';
import {
    assertGateOffStoreEmpty,
    assertHardwareStateConfined,
    hardwareStorePaths,
    initializeStore as initializeHardwareStore,
    peekGateOffStoreEmpty,
} from '../cli/sandbox/hardwareLimits/store.mjs';
import { withStaleStoreLockRecovery } from '../cli/sandbox/hardwareLimits/storeLock.mjs';
import { retireDestroyedBoxNoWaitMarkers } from './noWaitCleanup.mjs';
import { createMutationLockManager, withWorkspaceMutationLock } from './locks.mjs';
import { parseHostPort } from './ports.mjs';
import { stripBranchPolicyArgs } from '../agentlib/branchPolicy.mjs';
import { buildEngineProcessEnvironment, createProcessRunner } from './process.mjs';
import { updateWorkspacePloinkySource } from './command/hostUpdate.mjs';
import {
    containerCreateArgs,
    removeContainerById,
    startContainerAndWaitReady,
    stopPloinkyLocalByContainerId,
} from './lifecycle/container.mjs';
import { observeBoxConfiguration, reconcileBoxContainer } from './lifecycle/transactions.mjs';
import { prepareBoxGeneration, verifyBoxRuntime } from './hardwareLimits/status.mjs';
import {
    abortHardwareDowngradesForDestroy,
    createTransitionStore,
    downgradeRecoveryAdvice,
    recoverHardwareDowngrades,
    runHardwareDowngrade,
} from './hardwareLimitsTransition.mjs';
import { listUnresolvedAdmissions, runJournaledAdmission } from './update/admission.mjs';
import { updateHostStateForLockManager } from './update/hostState.mjs';
import { IN_BOX_NONCE_PROBE_SCRIPT, IN_BOX_OPERATION_WRITERS_PROBE_SCRIPT, runUpdateExec } from './update/coreRunner.mjs';
import {
    HOST_EXCLUSIONS_INTENT_KIND,
    recoverInterruptedHostExclusions,
    refreshDeferredHostExclusions,
} from './update/hostExclusions.mjs';
import {
    UPDATE_REPORT_CONTEXT_ENV,
    UPDATE_REPORT_NONCE_ENV,
    createOperationRecord,
    createUpdateReportNonce,
    decideUpdateStatus,
    readUpdateReport,
    removeUpdateReport,
} from '../cli/commands/updateOutcome.js';
import { commandErrorRecord } from '../cli/commands/updateRecords.js';
import { UpdateCancelledError, createUpdateCancellation } from '../cli/commands/updateCancellation.js';
import {
    ROUTER_BIND_WILDCARD,
    assertRouterBindingAssignable,
    createRouterBindingStore,
    deriveRouterBindingHosts,
    describeRouterBinding,
    isLoopbackRouterBinding,
    isWildcardRouterBinding,
    routerBindingBrowserUrls,
    routerBindingProbeTargets,
    routerBindingPublicAuthority,
    sameRouterBinding,
} from './routerBinding.mjs';
import { serializeCloudflarePublicationStatus } from './cloudflared/status.mjs';
import {
    inspectWorkspaceDataPaths,
    removeWorkspaceDataPaths,
} from './workspace-data.mjs';

function supervisorError(message, code = 'PLOINKY_BOX_SUPERVISOR_FAILED') {
    return new PloinkyBoxError(message, { code });
}

export function captureConfiguredCoreStartArgv(identity, { fsApi = fsPromisesFree } = {}) {
    const rawWorkspaceRoot = String(identity?.workspaceRoot || '');
    if (!rawWorkspaceRoot || !path.isAbsolute(rawWorkspaceRoot)) {
        throw supervisorError('Prior graph capture requires an exact workspace root');
    }
    const workspaceRoot = path.resolve(rawWorkspaceRoot);
    const routingPath = path.join(workspaceRoot, '.ploinky', 'routing.json');
    let routing;
    try {
        const stat = fsApi.lstatSync(routingPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw supervisorError('The prior graph routing configuration is not a regular file');
        }
        routing = JSON.parse(fsApi.readFileSync(routingPath, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error instanceof PloinkyBoxError) throw error;
        throw supervisorError(`Could not capture the prior graph start configuration: ${error.message}`);
    }
    // routing.json is the graph source of truth and survives a failed runtime
    // candidate even if a stale registry writer drops agents.json._config.
    const staticAgent = String(routing?.static?.agent || '').trim();
    const staticPort = Number(routing?.port);
    if (!staticAgent && !routing?.static) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(staticAgent)) {
        throw supervisorError('The prior graph static agent is invalid');
    }
    if (!Number.isSafeInteger(staticPort) || staticPort !== BOX_ROUTER_CONTAINER_PORT) {
        throw supervisorError(
            `The prior graph must use the Box Router port ${BOX_ROUTER_CONTAINER_PORT}`,
        );
    }
    return Object.freeze(['start', staticAgent, String(staticPort)]);
}

function assertMutableOwnership(ownership) {
    if (!['absent', 'owned'].includes(ownership?.state)) {
        throw supervisorError(
            ownership?.message || `Box ownership is ${ownership?.state || 'unknown'}`,
            `PLOINKY_BOX_${String(ownership?.state || 'unknown').toUpperCase()}`,
        );
    }
    return ownership;
}

function defaultDiscovery(identity, runner, platform, env) {
    return discoverBoxOwnership(identity, { runner, platform, env });
}

/**
 * Remove the workspace-owned managed AgentLib state.
 *
 * Scoped to `.ploinky/agentlib`, which Ploinky created and owns. A local
 * `<workspace>/achillesAgentLib` checkout belongs to the user and is never
 * deleted or mutated, so it is deliberately out of range here.
 *
 * @param {string} workspaceRoot
 * @returns {readonly string[]} the paths removed
 */
function removeManagedAgentLibState(workspaceRoot, fsApi = fsPromisesFree) {
    const target = managedRootPath(workspaceRoot, fsApi);
    const expected = path.join(canonicalWorkspaceRoot(workspaceRoot, fsApi), '.ploinky', 'agentlib');
    if (target !== expected) {
        throw supervisorError(
            `Refusing to delete managed AgentLib state outside ${expected}`,
            'PLOINKY_BOX_AGENTLIB_CLEANUP_REFUSED',
        );
    }
    try {
        if (!fsApi.lstatSync(target).isDirectory()) {
            throw supervisorError(
                `Managed AgentLib state at ${target} is not a real directory; nothing was removed`,
                'PLOINKY_BOX_AGENTLIB_CLEANUP_REFUSED',
            );
        }
    } catch (error) {
        if (error?.code === 'ENOENT') return Object.freeze([]);
        throw error;
    }
    fsApi.rmSync(target, { recursive: true, force: true });
    return Object.freeze([target]);
}

/** The one comparable value of a selection's identity: a local fingerprint or the supplying image ID. */
function agentLibIdentityToken(selection) {
    const identity = agentLibIdentity(selection, { provenance: false });
    return identity ? (identity.fingerprint ?? identity.supplyingImageId ?? null) : null;
}

/**
 * Prove the selected source is still exactly the one the graph was admitted for.
 *
 * A local checkout is outside Ploinky's locks, so a developer edit during
 * startup is detectable only here. It is a hard failure: declaring readiness
 * would claim one fingerprint for a graph that loaded another.
 */
function defaultRevalidateAgentLibSource(selection, context) {
    if (selection.mode === 'image') {
        if (localCandidateExists(localCandidatePath(selection.workspaceRoot))) {
            throw agentLibError(AGENTLIB_ERROR_CODES.sourceChanged,
                'A local AchillesAgentLib source appeared during startup; run the command again.');
        }
        return revalidateContainerAgentLib(selection, context);
    }
    const { fingerprint, sourceId } = fingerprintSource(selection.sourceDir);
    if (!sourceIdEquals(sourceId, selection.sourceId)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.sourceChanged,
            `The achillesAgentLib source at ${selection.sourceDir} was replaced during startup; `
            + 'the deployment was not declared ready.',
        );
    }
    if (fingerprint !== selection.contentFingerprint) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.sourceChanged,
            `The achillesAgentLib source at ${selection.sourceDir} changed during startup `
            + `(${selection.contentFingerprint.slice(0, 12)} -> ${fingerprint.slice(0, 12)}); `
            + 'the deployment was not declared ready. Run the command again.',
        );
    }
    return selection;
}

/**
 * Prove that an existing Box still exposes the exact AgentLib generation it
 * was admitted with. Targeted restarts deliberately do not select or advance
 * source: the replacement agent must load the same mounted bytes as its peers.
 */
function revalidateMountedAgentLibSource(selection, context) {
    if (selection.mode === 'image') return revalidateContainerAgentLib(selection, context);
    const { fingerprint, sourceId } = fingerprintSource(selection.sourceDir);
    if (sourceIdHash(sourceId) !== selection.sourceIdHash) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.sourceChanged,
            `The mounted achillesAgentLib source at ${selection.sourceDir} was replaced; `
            + 'the targeted restart was refused. Run a full `ploinky restart`.',
        );
    }
    if (fingerprint !== selection.fingerprint) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.sourceChanged,
            `The mounted achillesAgentLib source at ${selection.sourceDir} changed `
            + `(${selection.fingerprint.slice(0, 12)} -> ${fingerprint.slice(0, 12)}); `
            + 'the targeted restart was refused. Run a full `ploinky restart`.',
        );
    }
    return selection;
}

// D14 first start: the in-Box no-wait workers outlive the start that launched
// them. They pull images (bounded by the in-Box image pull timeout, 30 minutes)
// and then take the edge-generation lock to publish their agent, which the
// graph stop of a Box replacement also needs. The host waits for them, a little
// longer than that pull bound, before replacing the Box.
const NO_WAIT_WORKER_SCRIPT = '/opt/ploinky/cli/commands/noWaitWorker.js';
const NO_WAIT_SETTLE_TIMEOUT_MS = 31 * 60 * 1000;
const NO_WAIT_POLL_MS = 5000;
// Engine statuses that name a stopped Box container (no process can run).
const STOPPED_BOX_STATUSES = new Set(['exited', 'stopped', 'created', 'configured', 'initialized', 'dead']);

export function createBoxSupervisor({
    runner = createProcessRunner({ env: buildEngineProcessEnvironment() }),
    lockManager = createMutationLockManager(),
    resolveIdentity = () => resolveWorkspaceIdentity(),
    discover = defaultDiscovery,
    platform = process.platform,
    env = process.env,
    launchCwd = process.cwd(),
    repositoryRoot = path.resolve(import.meta.dirname, '..'),
    reconcile = reconcileBoxContainer,
    validateExistingImage = inspectAndValidateExistingImage,
    validateContainer = validateContainerConfiguration,
    startCore = runBoundedCoreStart,
    runCoreCommand = runBoundedCoreCommand,
    runUpdateCore = runBoundedUpdateCommand,
    runRestartCore = runBoundedRestartCommand,
    refreshHostExclusions = refreshDeferredHostExclusions,
    recoverHostExclusions = recoverInterruptedHostExclusions,
    createCancellation = () => createUpdateCancellation(),
    readReport = readUpdateReport,
    removeReport = removeUpdateReport,
    createReportNonce = createUpdateReportNonce,
    probeUpdateQuiescence = ({ engine, containerId, nonce, marker, runner: selectedRunner }) => (
        probeInBoxUpdateProcesses(engine, containerId, selectedRunner, nonce, { marker })
    ),
    resolveHostReachableIpv4 = detectHostReachableIpv4,
    readEdgeDesired = readWorkspaceEdgeDesired,
    stageEdgeDesired = stageWorkspaceEdgeDesired,
    healthCheck = checkBoxHealth,
    selectAgentLib = selectWorkspaceAgentLibSource,
    loadAgentLibImage = loadBoxAgentLibImage,
    updateAgentLib = updateWorkspaceAgentLibSource,
    updateWorkspacePloinky = updateWorkspacePloinkySource,
    commitAgentLibSelection = writeActiveDescriptor,
    readAgentLibActive = readActiveDescriptorText,
    restoreAgentLibActive = restoreActiveDescriptorText,
    revalidateAgentLibSource = defaultRevalidateAgentLibSource,
    retireDestroyedMarkers = retireDestroyedBoxNoWaitMarkers,
    destroyBoxCache = removeWorkspaceDataPaths,
    destroyManagedAgentLib = removeManagedAgentLibState,
    inspectBoxData = inspectWorkspaceDataPaths,
    captureCoreStartArgv = captureConfiguredCoreStartArgv,
    routerBindingStore = createRouterBindingStore(),
    updateHostState = updateHostStateForLockManager(lockManager),
    gpuGrantStore = createGpuGrantStore(),
    hardwareGateStore = createHardwareGateStore(),
    // Bounded, idempotent preparation of each created/restored/restarted
    // gate-on generation before graph work (plan U5/U11, §7).
    prepareHardwareGeneration = async ({ identity, engine, containerId, runner: preparationRunner }) => prepareBoxGeneration({
        engine,
        containerId,
        runner: preparationRunner,
        repositoryRoot,
        writableSources: [identity.workspaceRoot, ...Object.values(identity.dataPaths || {})],
    }),
    discoverGpuDevices = discoverGpu,
    // MPS tool discovery for gate-on GPU wiring; the GPU module's default.
    discoverGpuMpsTools = undefined,
    scanGpuAgents = declaredGpuAgents,
    countNoWaitWorkers = null,
    waitDelay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = () => Date.now(),
    readNetworkInterfaces = () => os.networkInterfaces(),
    readHostname = () => os.hostname(),
    stdout = process.stdout,
    stderr = process.stderr,
} = {}) {
    function inspect(identity) {
        return discover(identity, runner, platform, env);
    }

    // Creating a missing Box pulls its reference, so select the supplying image
    // from that pull rather than from whatever local tag an earlier pull left.
    // An existing Box is reused or replaced without a selection-time pull.
    function imageBundleLoader(ownership, imageRef = resolveBoxImageReference(env)) {
        return () => loadAgentLibImage({
            engine: ownership.engine, imageRef, runner, stdout, stderr, refresh: ownership.state === 'absent',
        });
    }

    // Bind never pulls: the supplying image may come only from a local image.
    function localImageBundleLoader(ownership, imageRef) {
        return () => {
            const inspected = runner.query(ownership.engine.name, ['image', 'inspect', imageRef]);
            if (!inspected?.ok) {
                throw supervisorError(
                    `The Box image ${imageRef} is not available locally and bind never pulls images; `
                    + 'run `ploinky start` first',
                    'PLOINKY_BOX_BIND_IMAGE_UNAVAILABLE',
                );
            }
            return loadAgentLibImage({
                engine: ownership.engine, imageRef, runner, stdout, stderr, allowPull: false,
            });
        };
    }

    /**
     * Resolve a requested binding against this physical host: the address must
     * be assigned here, and the trusted outer Host names come only from this
     * host's interfaces and name.
     */
    function hostRouterBinding(binding) {
        const interfaces = readNetworkInterfaces();
        const normalized = assertRouterBindingAssignable(binding, { interfaces });
        const hosts = deriveRouterBindingHosts(normalized, { interfaces, hostname: readHostname() });
        return Object.freeze({ address: normalized.address, hostPort: normalized.hostPort, hosts });
    }

    // A saved binding is authoritative for graph lifecycle commands. A later
    // explicit --port keeps the saved address and replaces only the port.
    function selectSavedRouterBinding(identity, explicitPort) {
        const saved = routerBindingStore.read(identity);
        if (!saved) return Object.freeze({ saved: null, desired: null });
        const hasExplicitPort = explicitPort !== undefined && explicitPort !== null && explicitPort !== '';
        const hostPort = hasExplicitPort ? parseHostPort(explicitPort) : saved.hostPort;
        return Object.freeze({ saved, desired: hostRouterBinding({ address: saved.address, hostPort }) });
    }

    function savedRouterBindingUpdate(saved, prepared) {
        if (!saved || !prepared?.routerBinding) return null;
        const next = Object.freeze({ address: prepared.routerBinding.address, hostPort: prepared.hostPort });
        return next.address === saved.address && next.hostPort === saved.hostPort
            ? null
            : Object.freeze({ next, previous: saved });
    }

    function reportRouterBinding(binding) {
        if (!binding?.address || isLoopbackRouterBinding(binding)) return;
        for (const line of formatRouterBindingLines(binding)) stdout?.write?.(`[ploinky] ${line}\n`);
    }

    // The saved GPU grant is authoritative for graph lifecycle commands: every
    // start, restart and update rediscovers the host driver, so a driver update
    // replaces the Box with regenerated wiring, and a failed discovery wires
    // only a stale-grant marker instead of stopping the whole workspace.
    function selectSavedGpuWiring(identity, mpsEnabled = hardwareGateStore.read(identity)?.enabled === true) {
        const saved = gpuGrantStore.read(identity);
        // D14: manifests of the installed repos may declare GPU access; the
        // operator's grants and denies apply on top.
        const declared = scanGpuAgents(identity.workspaceRoot);
        const desired = resolveDesiredGpuWiring(identity, saved, declared, {
            discover: discoverGpuDevices,
            ...(discoverGpuMpsTools ? { discoverMps: discoverGpuMpsTools } : {}),
            homeDirectory: gpuGrantStore.homeDirectory,
                mpsEnabled,
        });
        if (desired?.state === 'stale') {
            stderr?.write?.(
                `[ploinky] GPU grant stale: ${desired.reason}; the Box starts without GPU devices and `
                + 'GPU-requesting agents fail admission; fix the host GPU driver, then run `ploinky restart`\n',
            );
        } else if (!desired) {
            const access = effectiveGpuAccess(saved, declared);
            if (access.agents.length) {
                stderr?.write?.(
                    `[ploinky] GPU access is declared by ${access.agents.join(', ')}, but this host has no usable `
                    + 'GPU; the Box starts without GPU devices and those agents start without the GPU '
                    + '(`ploinky gpu status` shows why)\n',
                );
            }
        }
        return Object.freeze({ saved, desired, declared });
    }

    // The saved hardware-limits gate (plan §6.1). An environment value is
    // parsed before any mutation; only start/restart/update apply it. A
    // gate-off create, replacement or start first proves that no hardware
    // limit is stored (U9): unknown or unreadable contents refuse too.
    function selectHardwareGateForOperation(identity, operation, lock = null) {
        const gate = selectHardwareGate({ identity, gateStore: hardwareGateStore, env, operation });
        if (gate.note) stderr?.write?.(`[ploinky] Note: ${gate.note}\n`);
        if (!gate.enabled) {
            const paths = hardwareStorePaths({ identity, homeDirectory: hardwareGateStore.homeDirectory });
            try {
                // A stale store lock is recovered only with its holder proven
                // dead and this Box observed stopped or absent (§5.2).
                withStaleStoreLockRecovery(() => assertGateOffStoreEmpty({ paths, identity }), {
                    storeRoot: paths.storeRoot, hostLock: lock, instance: identity.instance,
                    inspectBox: () => observeBoxState(identity),
                });
            } catch (error) {
                throw supervisorError(error.message, error.code === 'stored_limits_present'
                    ? 'PLOINKY_BOX_HARDWARE_LIMITS_STORED'
                    : error.code === 'store_busy' ? 'PLOINKY_BOX_HARDWARE_STORE_BUSY' : 'PLOINKY_BOX_HARDWARE_STATE_INVALID');
            }
        } else {
            assertHardwareStateConfined({
                workspaceRoot: identity.workspaceRoot,
                dataPaths: identity.dataPaths,
                homeDirectory: hardwareGateStore.homeDirectory,
            });
        }
        return gate;
    }

    // The exact wiring for the selected gate; null for gate off. Gate-on
    // initializes the host store before the first gate-on Box exists.
    function hardwareWiringFor(identity, enabled, ownership) {
        return resolveDesiredHardwareWiring({
            identity,
            enabled,
            hostKind: ownership?.engine?.hostKind || 'native-linux',
            homeDirectory: hardwareGateStore.homeDirectory,
            initializeStore: initializeHardwareStore,
        });
    }

    // The exact Box's observed state for stale-lock recovery: absent, stopped,
    // paused or running. A paused Box is not stopped: a writer inside it may
    // still hold the lock (§5.2). Anything not positively owned, and any
    // engine status that does not name a stopped container, is unknown.
    function observeBoxState(identity) {
        const observed = inspect(identity);
        if (observed?.state === 'absent') return Object.freeze({ state: 'absent' });
        const container = observed?.state === 'owned' ? observed.handles?.container : null;
        if (!container) return Object.freeze({ state: 'unknown' });
        const runtime = container.runtime || {};
        const status = String(runtime.status || '').trim().toLowerCase();
        if (runtime.running === true || status === 'running') return Object.freeze({ state: 'running', id: container.id });
        if (status === 'paused') return Object.freeze({ state: 'paused', id: container.id });
        if (STOPPED_BOX_STATUSES.has(status)) return Object.freeze({ state: 'stopped', id: container.id });
        return Object.freeze({ state: 'unknown', id: container.id });
    }

    // A pending gate-on to gate-off transition must be recovered (by the next
    // start/restart/update) before any other outer state-changing operation;
    // bind and GPU grant/revoke refuse instead of mutating (§6.3 line 420).
    // The advice follows the journal's real phase.
    function assertNoPendingHardwareTransition(identity, operation) {
        const pending = createTransitionStore({ identity, homeDirectory: hardwareGateStore.homeDirectory }).listPending();
        if (!pending.length) return;
        const [journal] = pending;
        const advice = journal.phase === 'recovery-blocked'
            ? `${downgradeRecoveryAdvice(journal)} Then retry ploinky ${operation}.`
            : `Run ploinky restart on the host to complete recovery, then retry ploinky ${operation}.`;
        throw supervisorError(
            `A gate-on to gate-off hardware transition is pending (operation ${journal.operationId}, phase ${journal.phase}). `
            + `${advice} No Box mutation was performed.`,
            'PLOINKY_BOX_HARDWARE_TRANSITION_PENDING',
        );
    }

    // Observed in-Box graph state: true/false, or null when the running Box's
    // status cannot be read.
    function observeGraphRunning(identity, engine, containerId) {
        const inbox = readInboxStatus(engine, containerId, identity.workspaceRoot);
        if (!inbox) return null;
        return inbox.initialized === true && inbox.routingConfigured === true
            && Number.isSafeInteger(inbox.runningAgents) && inbox.runningAgents > 0;
    }

    function observedHardwareWiring(identity, ownership) {
        const container = ownership?.handles?.container || null;
        return container ? observeContainerHardwareWiring(container, { identity, homeDirectory: hardwareGateStore.homeDirectory }) : null;
    }

    // Saved-state wiring for bind and GPU grant/revoke, which never apply an
    // environment value: a replacement keeps the saved gate.
    function savedHardwareWiring(identity, ownership, lock = null) {
        const gate = selectHardwareGateForOperation(identity, 'saved', lock);
        return { gate, hardware: hardwareWiringFor(identity, gate.enabled, ownership) };
    }

    // Every gate-on generation is prepared before graph work: each created,
    // replaced, restored or reused-and-restarted Box. A failed preparation is
    // not fatal to the core: limited agents are refused and unrelated agents
    // still start (plan §7.2).
    async function prepareGateOnGeneration(identity, engine, containerId, hardware) {
        if (!hardware) return null;
        try {
            const result = await prepareHardwareGeneration({ identity, engine, containerId, runner, hardware, stderr });
            if (result?.structurallyPrepared !== true) {
                stderr?.write?.(`[ploinky] Hardware limits: this Box is not prepared (${result?.reason || 'unknown reason'}); `
                    + 'agents requesting limits will be refused. Run `ploinky limits status`.\n');
            }
            return result;
        } catch (error) {
            stderr?.write?.(`[ploinky] Hardware limits: Box preparation failed (${error.message}); agents requesting limits will be refused.\n`);
            return Object.freeze({ structurallyPrepared: false, reason: error.message });
        }
    }

    // Real engine effects for the durable downgrade (plan §6.3). Every action
    // names an exact immutable container ID.
    function downgradeEffects(identity, lock, engine) {
        const handleOf = (id) => {
            const observed = inspect(identity);
            const container = observed?.state === 'owned' ? observed.handles?.container : null;
            return container && container.id === id ? container : null;
        };
        return {
            engineIdentity: engine.identity,
            hostKind: engine.hostKind || 'native-linux',
            inspectBox() {
                const observed = inspect(identity);
                const container = observed?.state === 'owned' ? observed.handles?.container : null;
                return container ? { id: container.id, running: container.runtime?.running === true } : null;
            },
            stopGraph(id) { stopPloinkyLocalByContainerId(engine, id, runner, { workspaceRoot: identity.workspaceRoot }); },
            stopBox(id) { runner.run(engine.name, ['container', 'stop', '--time', '30', id]); },
            removeBox(id) { removeContainerById(engine, id, runner); },
            createBox(configuration, { receiptPath }) {
                runner.run(engine.name, containerCreateArgs({
                    ...configuration,
                    identity,
                    cidfile: receiptPath,
                    imageId: configuration.imageId,
                }));
            },
            async startBox(id) { await startContainerAndWaitReady(engine, id, runner, { stdout, stderr }); },
            async prepareBox(id, configuration) { await prepareGateOnGeneration(identity, engine, id, configuration.hardware); },
            async startGraph(id, graph) {
                const container = handleOf(id);
                const configuration = container ? observeBoxConfiguration(identity, inspect(identity), repositoryRoot, engine) : null;
                if (!configuration) throw supervisorError('The downgrade candidate is not the exact owned Box');
                if (!Array.isArray(graph.coreArgv) || !graph.coreArgv.length) {
                    throw supervisorError('The prior graph start configuration was not captured, so it cannot be restored');
                }
                await ensureBoxDependencies(engine, id, runner, { workspaceRoot: identity.workspaceRoot, stdout, stderr });
                await restorePriorGraph({
                    identity, engine, containerId: id, hostPort: configuration.hostPort, mediaHostPort: configuration.mediaHostPort,
                    agentLib: configuration.agentLib, routerBinding: configuration.routerBinding,
                    coreArgv: graph.coreArgv, skillScopeEnv: graph.skillScopeEnv || null,
                });
                // Ready only when observed: the in-Box status must show the graph.
                const running = observeGraphRunning(identity, engine, id);
                return { state: running === true ? 'ready' : 'starting', optionalPendingKeys: [] };
            },
            graphRunning(id) {
                // A stopped or recreated, not yet started Box runs no graph.
                if (handleOf(id)?.runtime?.running !== true) return false;
                const running = observeGraphRunning(identity, engine, id);
                if (running === null) {
                    throw supervisorError(`The running Box ${String(id).slice(0, 12)} status could not be read, so its graph state is unknown; retry the host command`);
                }
                return running;
            },
            verifyBox(id, configuration) {
                const container = handleOf(id);
                if (!container) return false;
                try {
                    validateContainer(container, { ...configuration, identity });
                    return true;
                } catch {
                    return false;
                }
            },
            readHostRecord(name) { return name === 'gate' ? hardwareGateStore.read(identity)?.enabled === true : undefined; },
            writeHostRecord(name, value) { if (name === 'gate') hardwareGateStore.write(identity, value, lock); },
        };
    }

    // Recover any pending downgrade first, then journal an actual gate-on to
    // gate-off downgrade. First enable and on-to-on use no barrier.
    async function settleHardwareTransitions(identity, lock, ownership, gate, operation) {
        const homeDirectory = hardwareGateStore.homeDirectory;
        const store = createTransitionStore({ identity, homeDirectory });
        if (store.listPending().length) {
            const engine = ownership.engine;
            const results = await recoverHardwareDowngrades({ identity, homeDirectory, transitionStore: store, effects: downgradeEffects(identity, lock, engine) });
            const blocked = results.find((result) => result.phase === 'recovery-blocked');
            if (blocked) {
                throw supervisorError(`A gate-on to gate-off transition needs manual recovery (${blocked.operationId}): ${blocked.error || 'recovery-blocked'}. `
                    + 'Its journal and barrier were preserved; inspect `ploinky limits status`.', 'PLOINKY_BOX_HARDWARE_RECOVERY_BLOCKED');
            }
            ownership = inspect(identity);
        }
        if (gate.enabled || !observedHardwareWiring(identity, ownership)) return ownership;
        const container = ownership.handles.container;
        const engine = ownership.engine;
        const observed = observeBoxConfiguration(identity, ownership, repositoryRoot, engine);
        const { running: _running, ...oldConfiguration } = observed;
        const coreArgv = captureCoreStartArgv(identity);
        // Restore the graph afterwards only if it is observed running now.
        const oldWasRunning = container.runtime?.running === true;
        let oldGraphRunning = false;
        if (oldWasRunning) {
            oldGraphRunning = observeGraphRunning(identity, engine, container.id);
            if (oldGraphRunning === null) {
                throw supervisorError('The running gate-on Box status could not be read, so its graph state cannot be restored after '
                    + 'the gate-off transition; retry when the Box has finished starting', 'PLOINKY_BOX_HARDWARE_TRANSITION_STATUS_UNAVAILABLE');
            }
            if (oldGraphRunning && !coreArgv) {
                throw supervisorError('The running graph start configuration was not captured, so it cannot be restored after the '
                    + 'gate-off transition', 'PLOINKY_BOX_HARDWARE_TRANSITION_STATUS_UNAVAILABLE');
            }
        }
        stderr?.write?.('[ploinky] Turning hardware limits off: replacing the gate-on Box through a recoverable transition...\n');
        await runHardwareDowngrade({
            identity,
            operation,
            oldContainerId: container.id,
            oldConfiguration: JSON.parse(JSON.stringify(oldConfiguration)),
            desiredConfiguration: JSON.parse(JSON.stringify({ ...oldConfiguration, hardware: null, gpu: selectSavedGpuWiring(identity, false).desired })),
            graphSnapshot: { schema: 1, coreArgv: coreArgv ? [...coreArgv] : [], skillScopeEnv: readGraphSkillScope(identity) || null },
            oldWasRunning,
            oldGraphRunning,
            hostRecords: [{ name: 'gate', old: true, next: false }],
            homeDirectory,
            effects: downgradeEffects(identity, lock, engine),
        });
        return inspect(identity);
    }

    // The admitted record always comes from the desired wiring that was passed
    // to reconciliation. Reconciliation reuses a Box only when its fingerprint
    // equals that wiring's, so this is the Box's wiring too, but unlike a
    // wiring observed from the Box it carries the stale reason.
    function admittedGpuWiring(wiring) {
        return wiring ? { fingerprint: wiring.fingerprint, state: wiring.state, reason: wiring.reason ?? null } : null;
    }

    function savedGpuGrantUpdate(saved, desiredGpu, prepared) {
        if (!saved || desiredGpu === undefined) return null;
        if ((prepared?.gpu?.fingerprint ?? null) !== (desiredGpu?.fingerprint ?? null)) {
            throw supervisorError('The Box GPU wiring does not match the desired GPU grant wiring');
        }
        const admitted = admittedGpuWiring(desiredGpu);
        return saved.admitted?.fingerprint === admitted?.fingerprint
            ? null
            : Object.freeze({ next: saved, admitted, previous: saved });
    }

    // Generation files are only ever removed after the Box that names them is
    // gone; failing to prune never fails the committed transaction.
    function pruneGpuGenerations(identity, lock, keep) {
        try {
            gpuGrantStore.prune(identity, keep ? [keep.fingerprint] : [], lock);
        } catch (error) {
            stderr?.write?.(`[ploinky] Could not prune old GPU grant generations: ${error.message}\n`);
        }
    }

    function readInboxStatus(engine, containerId, workspaceRoot) {
        const inbox = runner.query(engine.name, [
            'container', 'exec',
            '--user', 'podman',
            ...boxWorkspaceExecOptions(workspaceRoot),
            containerId,
            '/usr/local/bin/node',
            '/opt/ploinky/ploinky-box/inbox/readStatus.mjs',
        ]);
        if (!inbox?.ok) return null;
        try {
            return JSON.parse(String(inbox.stdout || '').trim());
        } catch {
            return null;
        }
    }

    function currentRouterPublication(container) {
        const publication = validateContainerPublications(
            container,
            parseHostPort(container.labels?.[BOX_LABELS.routerHostPort], { source: 'owned Box host-port label' }),
            parseHostPort(container.labels?.[BOX_LABELS.mediaHostPort], { source: 'owned Box media host-port label' }),
        );
        return Object.freeze({
            address: publication.address,
            hostPort: publication.hostPort,
            hosts: publication.hosts,
            mediaHostPort: publication.mediaHostPort,
        });
    }

    async function lockedMutation(execute, authorize = assertMutableOwnership) {
        return withWorkspaceMutationLock({
            resolveIdentity,
            lockManager,
            beforeAnchor(identity) {
                // The selected path is also the Box mount and working directory;
                // an unmountable path fails before the workspace is anchored.
                assertBoxWorkspaceRoot(identity.workspaceRoot);
                return authorize(inspect(identity));
            },
            execute,
        });
    }

    async function reconcileSafely(options) {
        return reconcile({
            ...options,
            assertGateOffRestore: () => {
                const { identity, lock } = options;
                lock.assertHeld(identity.instance);
                const state = observeBoxState(identity);
                if (state.state !== 'absent') {
                    throw supervisorError('Cannot restore gate-off wiring until candidate Box writers are proven absent. Run PLOINKY_BOX_HARDWARE_LIMITS=on ploinky restart.', 'PLOINKY_BOX_HARDWARE_ROLLBACK_BLOCKED');
                }
                const paths = hardwareStorePaths({ identity, homeDirectory: hardwareGateStore.homeDirectory });
                return withStaleStoreLockRecovery(() => assertGateOffStoreEmpty({ paths, identity }), {
                    storeRoot: paths.storeRoot, hostLock: lock, instance: identity.instance,
                    inspectBox: () => observeBoxState(identity),
                });
            },
        });
    }

    async function prepareBoxForCommand({
        explicitPort,
        explicitMediaPort,
        branchPolicy = null,
        imageRef = resolveBoxImageReference(env),
    } = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            // U16: with hardware state (saved on gate, initialized store or
            // stored entries, or unknown metadata) a generic command only uses
            // an already-running compatible Box; it never creates, starts,
            // repairs or replaces one. Other workspaces keep today's behavior.
            if (env?.[HARDWARE_GATE_ENV] !== undefined && String(env[HARDWARE_GATE_ENV]).trim() !== '') {
                parseHardwareGateValue(env[HARDWARE_GATE_ENV]);
                stderr?.write?.(`[ploinky] Note: ${HARDWARE_GATE_ENV} is set; only start, restart and update apply it\n`);
            }
            const hardwareState = readHardwareStateClass({
                identity, gateStore: hardwareGateStore, homeDirectory: hardwareGateStore.homeDirectory,
            });
            if (hardwareState.hasHardwareState) {
                return inspectOnlyGenericBox(identity, ownership, hardwareState);
            }
            // An existing Box keeps its publication for ad hoc commands; only a
            // Box created here needs the saved binding.
            const routerBinding = ownership.handles?.container
                ? null
                : selectSavedRouterBinding(identity, explicitPort).desired;
            // Likewise an existing Box keeps its GPU wiring: replacing it here
            // would leave the graph down, because ad hoc commands never
            // restore it. Only a Box created here takes the saved grant.
            const gpu = ownership.handles?.container
                ? undefined
                : selectSavedGpuWiring(identity).desired;
            // The source is selected before Box reconciliation so the mount
            // contract can be part of the Box's immutable identity.
            const { selection } = await selectAgentLib({
                workspaceRoot: identity.workspaceRoot,
                branchPolicy,
                loadImageBundle: imageBundleLoader(ownership, imageRef),
            });
            const prepared = await reconcileSafely({
                identity,
                ownership,
                engine: ownership.engine,
                runner,
                lock,
                repositoryRoot,
                agentLib: selection,
                explicitPort,
                explicitMediaPort,
                routerBinding,
                gpu,
                imageRef,
                platform,
                env,
                stdout,
                stderr,
            });
            const containerId = prepared.ownership.handles.container.id;
            try {
                await ensureBoxDependencies(ownership.engine, containerId, runner, { workspaceRoot: identity.workspaceRoot, stdout, stderr });
                prepared.finalize?.();
                return Object.freeze({
                    identity, ...prepared, containerId, engine: ownership.engine, agentLib: selection,
                });
            } catch (error) {
                await rollbackPreparedGraph({
                    identity, prepared, ownership, containerId, error,
                    stopGraph: false,
                    restoreGraph: false,
                });
            }
        });
    }

    // Adopt only an already-running, compatible, initialized Box for a
    // generic command in a workspace with hardware state (plan U16).
    function inspectOnlyGenericBox(identity, ownership, hardwareState) {
        const status = inspectBoxStatus();
        const container = status.ownership?.handles?.container;
        const engine = status.ownership?.engine;
        if (status.identity?.instance !== identity.instance
            || status.state !== 'running-initialized'
            || !container?.id || !engine?.name
            || ownership.handles?.container?.id !== container.id
            || ownership.engine?.identity !== engine.identity) {
            throw supervisorError(
                `${GENERIC_INSPECT_ONLY_MESSAGE} (state: ${status.state || 'unknown'}; ${hardwareState.reason})`,
                'PLOINKY_BOX_HARDWARE_INSPECT_ONLY',
            );
        }
        const selection = agentLibContractFromContainer(container);
        const hostPort = Number(container.labels?.[BOX_LABELS.routerHostPort]);
        const mediaHostPort = Number(container.labels?.[BOX_LABELS.mediaHostPort]);
        return Object.freeze({
            identity,
            action: 'adopted',
            ownership: status.ownership,
            containerId: container.id,
            engine,
            hostPort,
            mediaHostPort,
            routerBinding: Object.freeze({ ...observeContainerRouterBinding(container), hostPort }),
            agentLib: selection,
            hardware: observedHardwareWiring(identity, status.ownership),
        });
    }

    async function restorePriorGraph({
        identity,
        engine,
        containerId,
        hostPort,
        mediaHostPort,
        agentLib,
        routerBinding,
        coreArgv,
        skillScopeEnv,
    }) {
        if (!Array.isArray(coreArgv) || coreArgv[0] !== 'start') {
            throw new Error('the prior graph start configuration was not captured');
        }
        const validatedSkillScope = validateGraphSkillScope(identity, skillScopeEnv);
        revalidateMountedAgentLibSource(agentLib, { engine, containerId, runner });
        const hostReachableIpv4 = await resolveHostReachableIpv4({ platform });
        await runCoreCommand(
            engine,
            containerId,
            coreArgv,
            hostPort,
            mediaHostPort,
            runner,
            {
                workspaceRoot: identity.workspaceRoot,
                stdout,
                stderr,
                hostReachableIpv4,
                agentLib,
                skillScopeEnv: validatedSkillScope,
            },
        );
        await healthCheck(hostPort, { routerBinding });
    }

    // Return a restored Box to the stopped state it had before a failed bind.
    function stopRestoredBox(identity, engine, containerId) {
        try {
            stopPloinkyLocalByContainerId(engine, containerId, runner, { workspaceRoot: identity.workspaceRoot });
        } finally {
            runner.run(engine.name, ['container', 'stop', '--time', '30', containerId]);
        }
    }

    async function rollbackPreparedGraph({
        identity,
        prepared,
        ownership,
        containerId,
        error,
        stopGraph,
        restoreGraph,
        restoreCoreArgv = null,
        restoreSkillScopeEnv = null,
        restoreStopped = false,
        afterRollback = null,
        priorGraphActive = false,
    }) {
        const failures = [];
        let candidateStopError = null;
        if (stopGraph) {
            try {
                stopPloinkyLocalByContainerId(ownership.engine, containerId, runner, {
                    workspaceRoot: identity.workspaceRoot,
                });
            } catch (stopError) {
                candidateStopError = stopError;
            }
        }
        let outerRollback = null;
        try {
            outerRollback = await prepared.rollback?.();
        } catch (rollbackError) {
            failures.push(`outer Box rollback: ${rollbackError.message}`);
        }
        // Successful removal proves the candidate is quiescent even when its
        // inner stop failed (for example, because the Box already exited).
        if (candidateStopError && !['restored', 'candidate-removed'].includes(outerRollback?.action)) {
            failures.push(`candidate graph stop: ${candidateStopError.message}`);
        }
        let graphRestored = false;
        let stoppedBoxRestored = false;
        if (restoreGraph && outerRollback?.agentLib && failures.length === 0) {
            try {
                // A restored gate-on generation is prepared before its graph
                // is restored (§6.5 Rollback restoration, U11).
                await prepareGateOnGeneration(identity, ownership.engine, outerRollback.containerId, outerRollback.hardware ?? null);
                await restorePriorGraph({
                    identity,
                    engine: ownership.engine,
                    containerId: outerRollback.containerId,
                    hostPort: outerRollback.hostPort,
                    mediaHostPort: outerRollback.mediaHostPort,
                    agentLib: outerRollback.agentLib,
                    routerBinding: outerRollback.routerBinding,
                    coreArgv: restoreCoreArgv,
                    skillScopeEnv: restoreSkillScopeEnv,
                });
                graphRestored = true;
            } catch (restoreError) {
                failures.push(`prior graph restoration: ${restoreError.message}`);
            }
        } else if (restoreStopped && outerRollback?.containerId && failures.length === 0) {
            try {
                stopRestoredBox(identity, ownership.engine, outerRollback.containerId);
                stoppedBoxRestored = true;
            } catch (stopError) {
                failures.push(`prior stopped Box restoration: ${stopError.message}`);
            }
        }
        if (afterRollback) {
            try {
                await afterRollback();
            } catch (stateError) {
                failures.push(stateError.message);
            }
        }
        // Name what actually happened: a prior graph that was rebuilt and
        // passed its checks, an untouched prior graph, or a disrupted graph
        // that was not rebuilt and needs manual recovery.
        const graphDisrupted = Boolean(stopGraph) || (priorGraphActive && prepared?.action === 'replaced');
        let outcome = 'preserved';
        if (failures.length || error?.admission?.outcome === 'recovery-required') {
            outcome = 'recovery-required';
        } else if (graphRestored) {
            outcome = 'restored';
        } else if (graphDisrupted) {
            outcome = 'recovery-required';
        } else if (stoppedBoxRestored || outerRollback?.action === 'restored') {
            outcome = 'restored';
        }
        const activation = Object.freeze({
            outcome,
            graphMutated: Boolean(stopGraph),
            boxRollback: outerRollback?.action || null,
        });
        if (failures.length) {
            const failure = supervisorError(
                `${error.message}; rollback failures: ${failures.join('; ')}`,
                'PLOINKY_BOX_TRANSACTION_ROLLBACK_FAILED',
            );
            failure.activation = activation;
            if (error?.admission) failure.admission = error.admission;
            throw failure;
        }
        if (error && typeof error === 'object') error.activation = activation;
        throw error;
    }

    /**
     * Admit a ready candidate graph. Health and exact AgentLib identity are
     * proven first; the metadata writes then happen inside the journaled error
     * boundary, and `finalize` is the last step, so rollback authority lasts
     * until settlement. Pending targeted activation is cleared only afterwards,
     * and a failure to clear it is a warning, never a rollback.
     */
    async function completeGraphAdmission({
        identity,
        lock,
        prepared,
        selection,
        requireHealth = true,
        skillScopeEnv = null,
        routerBindingUpdate = null,
        operation = 'admission',
        source = null,
        activated = true,
        gpuGrantUpdate = null,
        hardwareGate = null,
    }) {
        if (requireHealth) await healthCheck(prepared.hostPort, { routerBinding: prepared.routerBinding });
        revalidateAgentLibSource(selection, {
            engine: prepared.ownership.engine,
            containerId: prepared.ownership.handles.container.id,
            runner,
        });
        const items = [{
            name: 'agentlib-active',
            read: () => readAgentLibActive(identity.workspaceRoot),
            write: () => commitAgentLibSelection(identity.workspaceRoot, selection),
            restore: prior => restoreAgentLibActive(identity.workspaceRoot, prior),
        }];
        if (skillScopeEnv) {
            items.push({
                name: 'graph-skill-scope',
                read: () => readGraphSkillScope(identity),
                write: () => writeGraphSkillScope(identity, skillScopeEnv, lock),
                restore: prior => writeGraphSkillScope(identity, prior, lock),
            });
        }
        if (routerBindingUpdate) {
            items.push({
                name: 'router-binding',
                read: () => routerBindingStore.read(identity),
                write: () => routerBindingStore.write(identity, routerBindingUpdate.next, lock),
                restore: prior => routerBindingStore.restore(identity, prior, lock),
            });
        }
        if (gpuGrantUpdate) {
            // The admitted wiring is recorded only after the health check, as
            // the router binding is.
            items.push({
                name: 'gpu-grant',
                read: () => gpuGrantStore.read(identity),
                write: () => gpuGrantStore.write(identity, gpuGrantUpdate.next, lock, { admitted: gpuGrantUpdate.admitted }),
                restore: prior => gpuGrantStore.restore(identity, prior, lock),
            });
        }
        if (hardwareGate?.persist) {
            // The selected gate is recorded inside the journaled boundary, last, so a failing write is rolled back with the
            // other candidate metadata before settlement and can never reach a rollback after it.
            items.push({
                name: 'hardware-gate',
                read: () => hardwareGateStore.read(identity),
                write: () => hardwareGateStore.write(identity, hardwareGate.enabled, lock),
                restore: prior => hardwareGateStore.restore(identity, prior, lock),
            });
        }
        const admitted = await runJournaledAdmission({
            identity,
            store: updateHostState,
            operation,
            source: {
                containerId: prepared.ownership.handles.container.id,
                boxAction: prepared.action || null,
                previousAgentLib: prepared.previousAgentLib?.sourceIdHash || null,
                candidateAgentLib: agentLibIdentityToken(selection),
                ...(source || {}),
            },
            items,
            validate: async () => {
                lock.assertHeld(identity.instance);
                prepared.validate?.();
            },
            settle: async () => {
                lock.assertHeld(identity.instance);
                prepared.finalize?.();
            },
        });
        if (gpuGrantUpdate) pruneGpuGenerations(identity, lock, prepared.gpu);
        const warnings = [...admitted.warnings];
        // Only an actual whole-graph activation satisfies a pending one.
        if (activated) {
            try {
                updateHostState.remove('update-pending', identity.instance);
            } catch (error) {
                warnings.push(`the pending activation record could not be cleared: ${error.message}`);
            }
        }
        return Object.freeze({ ...admitted, warnings: Object.freeze(warnings) });
    }

    // Reporting after settlement never reaches a rollback path.
    function reportSettled(binding, warnings = []) {
        try {
            for (const warning of warnings) stderr?.write?.(`[ploinky] Warning: ${warning}\n`);
            reportRouterBinding(binding);
        } catch (error) {
            try {
                stderr?.write?.(`[ploinky] Warning: the settled result could not be reported: ${error.message}\n`);
            } catch (_) {}
        }
    }

    async function reconcileConfiguredGraph(options, { priorCoreStartArgv, priorSkillScopeEnv, priorGraphActive = false }) {
        const priorRunning = options.ownership.handles?.container?.runtime?.running === true;
        try {
            return await reconcileSafely(options);
        } catch (error) {
            await recoverFailedGraphReconcile({
                identity: options.identity,
                lock: options.lock,
                ownership: options.ownership,
                error,
                priorRunning,
                priorGraphRunning: priorRunning && Boolean(priorCoreStartArgv),
                priorCoreStartArgv,
                priorSkillScopeEnv,
                priorGraphActive: priorGraphActive || (priorRunning && Boolean(priorCoreStartArgv)),
            });
        }
    }

    async function runStartTransaction(coreArgs = [], options = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            await assertNoUpdateRecoveryBarrier(identity, ownership);
            const hardwareGate = selectHardwareGateForOperation(identity, 'start', lock);
            ownership = await settleHardwareTransitions(identity, lock, ownership, hardwareGate, 'start');
            const hardware = hardwareWiringFor(identity, hardwareGate.enabled, ownership);
            const skillScopeEnv = buildHostSkillScope(identity.workspaceRoot, launchCwd);
            const priorCoreStartArgv = captureCoreStartArgv(identity);
            const priorSkillScopeEnv = readGraphSkillScope(identity);
            const { saved: savedBinding, desired: routerBinding } = selectSavedRouterBinding(
                identity,
                options.explicitPort,
            );
            const { saved: savedGpuGrant, desired: gpu } = selectSavedGpuWiring(identity, hardwareGate.enabled);
            const { selection } = await selectAgentLib({
                workspaceRoot: identity.workspaceRoot,
                branchPolicy: options.branchPolicy || null,
                loadImageBundle: imageBundleLoader(ownership, options.imageRef || resolveBoxImageReference(env)),
            });
            const prepared = await reconcileConfiguredGraph({
                identity,
                ownership,
                engine: ownership.engine,
                runner,
                lock,
                repositoryRoot,
                agentLib: selection,
                explicitPort: options.explicitPort,
                explicitMediaPort: options.explicitMediaPort,
                routerBinding,
                gpu,
                hardware,
                imageRef: options.imageRef || resolveBoxImageReference(env),
                platform,
                env,
                stdout,
                stderr,
            }, { priorCoreStartArgv, priorSkillScopeEnv });
            const containerId = prepared.ownership.handles.container.id;
            let graphMutated = false;
            let admission = null;
            try {
                await prepareGateOnGeneration(identity, ownership.engine, containerId, prepared.hardware);
                await ensureBoxDependencies(ownership.engine, containerId, runner, { workspaceRoot: identity.workspaceRoot, stdout, stderr });
                const edgeDesired = readEdgeDesired(identity);
                if (edgeDesired) {
                    stageEdgeDesired({
                        candidate: edgeDesired,
                        engine: ownership.engine,
                        containerId,
                        runner,
                        workspaceRoot: identity.workspaceRoot,
                    });
                }
                const hostReachableIpv4 = await resolveHostReachableIpv4({ platform });
                graphMutated = true;
                await startCore(
                    ownership.engine,
                    containerId,
                    coreArgs,
                    prepared.hostPort,
                    prepared.mediaHostPort,
                    runner,
                    {
                        workspaceRoot: identity.workspaceRoot,
                        stdout,
                        stderr,
                        hostReachableIpv4,
                        agentLib: selection,
                        skillScopeEnv,
                        routerBinding: prepared.routerBinding,
                    },
                );
                admission = await completeGraphAdmission({
                    identity, lock, prepared, selection, skillScopeEnv,
                    routerBindingUpdate: savedRouterBindingUpdate(savedBinding, prepared),
                    gpuGrantUpdate: savedGpuGrantUpdate(savedGpuGrant, gpu, prepared),
                    operation: 'start',
                    hardwareGate,
                });
            } catch (error) {
                await rollbackPreparedGraph({
                    identity,
                    prepared,
                    ownership,
                    containerId,
                    error,
                    stopGraph: graphMutated,
                    restoreGraph: Boolean(prepared.previousAgentLib)
                        && Boolean(priorCoreStartArgv)
                        && (graphMutated || prepared.action === 'replaced'),
                    restoreCoreArgv: priorCoreStartArgv,
                    restoreSkillScopeEnv: priorSkillScopeEnv,
                });
            }
            reportSettled(prepared.routerBinding, admission?.warnings);
            const gpuReapplied = await reapplyDeclaredGpu(identity, lock, prepared.gpu);
            return Object.freeze({
                identity, ...prepared, containerId, agentLib: selection,
                ...(gpuReapplied ? { gpuReapplied } : {}),
            });
        });
    }

    async function runRestartTransaction(coreArgs = ['restart'], options = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            await assertNoUpdateRecoveryBarrier(identity, ownership);
            const hardwareGate = selectHardwareGateForOperation(identity, 'restart', lock);
            ownership = await settleHardwareTransitions(identity, lock, ownership, hardwareGate, 'restart');
            const hardware = hardwareWiringFor(identity, hardwareGate.enabled, ownership);
            const skillScopeEnv = buildHostSkillScope(identity.workspaceRoot, launchCwd);
            const priorCoreStartArgv = captureCoreStartArgv(identity);
            const priorSkillScopeEnv = readGraphSkillScope(identity);
            const { desired: routerBinding } = selectSavedRouterBinding(identity);
            const { saved: savedGpuGrant, desired: gpu } = selectSavedGpuWiring(identity, hardwareGate.enabled);
            const { selection } = await selectAgentLib({
                workspaceRoot: identity.workspaceRoot,
                branchPolicy: options.branchPolicy || null,
                loadImageBundle: imageBundleLoader(ownership, options.imageRef || resolveBoxImageReference(env)),
            });
            const prepared = await reconcileConfiguredGraph({
                identity,
                ownership,
                engine: ownership.engine,
                runner,
                lock,
                repositoryRoot,
                agentLib: selection,
                routerBinding,
                gpu,
                hardware,
                imageRef: options.imageRef || resolveBoxImageReference(env),
                platform,
                env,
                stdout,
                stderr,
            }, { priorCoreStartArgv, priorSkillScopeEnv });
            const containerId = prepared.ownership.handles.container.id;
            let graphMutated = false;
            let admission = null;
            try {
                await prepareGateOnGeneration(identity, ownership.engine, containerId, prepared.hardware);
                await ensureBoxDependencies(ownership.engine, containerId, runner, { workspaceRoot: identity.workspaceRoot, stdout, stderr });
                const effectiveArgs = prepared.action === 'replaced' && coreArgs.length > 1
                    ? ['restart']
                    : coreArgs;
                const hostReachableIpv4 = await resolveHostReachableIpv4({ platform });
                graphMutated = true;
                // The exec client ending never ends the in-Box restart, so it
                // runs under the bounded restart discipline an update uses.
                await executeBoundedRestart({
                    identity, engine: ownership.engine, containerId, prepared, selection, skillScopeEnv, hostReachableIpv4,
                    coreArgv: effectiveArgs,
                });
                admission = await completeGraphAdmission({
                    identity, lock, prepared, selection, skillScopeEnv, operation: 'restart',
                    gpuGrantUpdate: savedGpuGrantUpdate(savedGpuGrant, gpu, prepared),
                    hardwareGate,
                });
            } catch (error) {
                // A Box whose restart writer may still run is never rolled back.
                if (error?.skipRollback) throw error;
                await rollbackPreparedGraph({
                    identity,
                    prepared,
                    ownership,
                    containerId,
                    error,
                    stopGraph: graphMutated,
                    restoreGraph: Boolean(prepared.previousAgentLib)
                        && Boolean(priorCoreStartArgv)
                        && (graphMutated || prepared.action === 'replaced'),
                    restoreCoreArgv: priorCoreStartArgv,
                    restoreSkillScopeEnv: priorSkillScopeEnv,
                });
            }
            reportSettled(prepared.routerBinding, admission?.warnings);
            const gpuReapplied = await reapplyDeclaredGpu(identity, lock, prepared.gpu);
            return Object.freeze({
                identity, ...prepared, containerId, agentLib: selection,
                ...(gpuReapplied ? { gpuReapplied } : {}),
            });
        });
    }

    async function runTargetedRestartTransaction(coreArgs) {
        const restartIndex = Array.isArray(coreArgs) ? coreArgs.indexOf('restart') : -1;
        if (restartIndex < 0 || restartIndex >= coreArgs.length - 1) {
            throw supervisorError(
                'Targeted restart requires `restart AGENT`',
                'PLOINKY_BOX_ARGUMENT_INVALID',
            );
        }
        // A gate request that differs from the running Box's wiring needs the
        // outer reconciliation; it is announced and runs as a whole restart
        // with the U9 guard. The same gate keeps the exact Box.
        const requestedGate = parseHardwareGateValue(env?.[HARDWARE_GATE_ENV]);
        if (requestedGate !== undefined) {
            const identity = resolveIdentity();
            const observed = inspect(identity);
            const boxGateOn = Boolean(observedHardwareWiring(identity, observed));
            if (boxGateOn !== requestedGate) {
                stderr?.write?.(`[ploinky] ${HARDWARE_GATE_ENV}=${requestedGate ? 'on' : 'off'} changes the Box hardware-limits gate; `
                    + 'reconciling the outer Box, so the whole workspace graph restarts instead of only the named agent.\n');
                return runRestartTransaction(['restart']);
            }
        }
        return lockedMutation(async (identity, lock, ownership) => {
            await assertNoUpdateRecoveryBarrier(identity, ownership);
            const skillScopeEnv = buildHostSkillScope(identity.workspaceRoot, launchCwd);
            const status = inspectBoxStatus();
            const container = status.ownership?.handles?.container;
            const engine = status.ownership?.engine;
            if (status.identity?.instance !== identity.instance
                || status.state !== 'running-initialized'
                || !container?.id
                || !engine?.name
                || ownership.handles?.container?.id !== container.id
                || ownership.engine?.identity !== engine.identity) {
                throw supervisorError(
                    'Targeted restart requires the exact owned Box to be running and initialized '
                    + `(state: ${status.state || 'unknown'}). Run \`ploinky start AGENT\` first.`,
                    'PLOINKY_BOX_TARGETED_RESTART_UNAVAILABLE',
                );
            }

            // inspectBoxStatus validated the image, container contract, mounts,
            // and ports without comparing them to today's default image tag.
            // Reconstruct the generation from those observed mounts and labels
            // so this path can neither pull nor replace the outer Box.
            const selection = agentLibContractFromContainer(container);
            revalidateMountedAgentLibSource(selection, { engine, containerId: container.id, runner });
            const hostPort = Number(container.labels?.[BOX_LABELS.routerHostPort]);
            const mediaHostPort = Number(container.labels?.[BOX_LABELS.mediaHostPort]);
            const routerBinding = Object.freeze({ ...observeContainerRouterBinding(container), hostPort });
            // Retained .ploinky metadata also marks a newly recreated Box as
            // initialized. Prove its Router is ready before Core can drain routes.
            try {
                await healthCheck(hostPort, { routerBinding, readinessTimeoutMs: 0 });
            } catch (_) {
                throw supervisorError(
                    'Targeted restart requires the exact owned Box to have a ready Router. '
                    + 'Run `ploinky start AGENT` first.',
                    'PLOINKY_BOX_TARGETED_RESTART_UNAVAILABLE',
                );
            }
            // Revalidate (idempotently) the preparation of a gate-on Box.
            await prepareGateOnGeneration(identity, engine, container.id, observedHardwareWiring(identity, status.ownership));
            const hostReachableIpv4 = await resolveHostReachableIpv4({ platform });
            await runCoreCommand(
                engine,
                container.id,
                coreArgs,
                hostPort,
                mediaHostPort,
                runner,
                { workspaceRoot: identity.workspaceRoot, stdout, stderr, hostReachableIpv4, agentLib: selection, skillScopeEnv },
            );

            // Manual engine operations are outside the workspace lock. Refuse
            // to declare a different Box ready if one appeared while Core
            // restarted the target.
            const revalidated = inspect(identity);
            if (revalidated.state !== 'owned'
                || revalidated.engine?.identity !== engine.identity
                || revalidated.handles?.container?.id !== container.id
                || revalidated.handles.container.runtime?.running !== true) {
                throw supervisorError(
                    'The outer Box changed during the targeted restart; readiness was not declared',
                    'PLOINKY_BOX_TARGETED_RESTART_CHANGED',
                );
            }
            await healthCheck(hostPort, { routerBinding });
            revalidateMountedAgentLibSource(selection, { engine, containerId: container.id, runner });
            return Object.freeze({
                identity,
                action: 'targeted-restart',
                ownership: revalidated,
                containerId: container.id,
                engine,
                hostPort,
                mediaHostPort,
                routerBinding,
                agentLib: selection,
            });
        });
    }

    // Running/configured state is sampled from ownership observed under the
    // exact workspace lock, never from a status read taken before it.
    function sampleGraphActivity(identity, ownership) {
        const container = ownership?.state === 'owned' ? ownership.handles?.container : null;
        if (!container?.id || container.runtime?.running !== true) {
            return Object.freeze({ running: false, initialized: false, routingConfigured: false, active: false });
        }
        const inbox = typeof runner.query === 'function'
            ? readInboxStatus(ownership.engine, container.id, identity.workspaceRoot)
            : null;
        const initialized = inbox?.initialized === true;
        const routingConfigured = inbox?.routingConfigured === true;
        return Object.freeze({
            running: true,
            initialized,
            routingConfigured,
            active: initialized && routingConfigured,
            // A running Box whose core state cannot be read may still serve a
            // graph; its activation is deferred rather than declared unneeded.
            undetermined: inbox === null,
        });
    }

    function updatePlan(coreArgs, options) {
        let request = options.request || null;
        const argv = Array.isArray(coreArgs) ? coreArgs.map(String) : [];
        const debug = options.debug === true || argv.some(argument => ['--debug', '-d'].includes(argument));
        if (!request) {
            const tail = stripBranchPolicyArgs(argv).filter(argument => !['--debug', '-d'].includes(argument));
            if (tail[0] !== 'update') {
                throw supervisorError('Update transactions require an update command', 'PLOINKY_BOX_ARGUMENT_INVALID');
            }
            try {
                request = parseUpdateRequest(tail.slice(1), { cwd: launchCwd });
            } catch (error) {
                if (error instanceof UpdateRequestError) {
                    throw new PloinkyBoxError(error.message, { code: 'PLOINKY_BOX_ARGUMENT_INVALID', cause: error });
                }
                throw error;
            }
        }
        if (!['all', 'repos', 'repo'].includes(request?.kind)) {
            throw supervisorError('Unsupported update request', 'PLOINKY_BOX_ARGUMENT_INVALID');
        }
        return Object.freeze({
            request,
            debug,
            branchPolicy: options.branchPolicy || null,
            branchPolicyArgs: Object.freeze([...(options.branchPolicyArgs || [])].map(String)),
            scope: options.scope || null,
            updateScopeRoot: options.updateScopeRoot || null,
            hostRecords: Object.freeze([...(options.hostRecords || [])]),
            imageRef: options.imageRef || resolveBoxImageReference(env),
        });
    }

    // Re-resolve the folder against the exact locked workspace and map its
    // canonical-relative path onto the Box workspace mount spelling.
    function lockedUpdateScope(identity, plan) {
        const request = withDefaultUpdateFolder(plan.request, launchCwd, identity.workspaceRoot);
        if (!request.folderPath) return null;
        let fresh;
        try {
            fresh = resolveUpdateFolderScope(request.folderPath, identity.workspaceRoot);
        } catch (error) {
            throw new PloinkyBoxError(error.message, {
                code: error?.code === 'PLOINKY_UPDATE_SCOPE_OUTSIDE' || error?.code === 'PLOINKY_UPDATE_SCOPE_MISSING'
                    || error?.code === 'PLOINKY_UPDATE_SCOPE_UNMAPPABLE'
                    ? error.code
                    : 'PLOINKY_UPDATE_SCOPE_UNMAPPABLE',
                cause: error,
            });
        }
        if (plan.scope && (plan.scope.relative !== fresh.relative
            || plan.scope.canonicalFolder !== fresh.canonicalFolder)) {
            throw new PloinkyBoxError(
                `update: folder '${plan.request.folder}' changed while waiting for the workspace lock; nothing was updated`,
                { code: 'PLOINKY_UPDATE_SCOPE_CHANGED' },
            );
        }
        const boxPath = mapUpdateScope(fresh.relative, identity.workspaceRoot);
        // The mapped path must be a clean path inside the Box workspace mount.
        relativeBoxWorkspacePath(identity.workspaceRoot, boxPath);
        return Object.freeze({ ...fresh, boxPath });
    }

    function updateCoreArgv(plan, scope) {
        return Object.freeze([
            ...(plan.debug ? ['--debug'] : []),
            ...formatUpdateRequestArgs(plan.request, { folderPath: scope?.boxPath || null }),
            // Targeted forms keep forwarding branch policy to the in-Box core,
            // as the generic route did; the full form consumes it here.
            ...(plan.request.kind === 'all' ? [] : plan.branchPolicyArgs),
        ]);
    }

    function recordPendingActivation(identity, { request, coreArgv, reason, blockedBy = [] }) {
        const previous = updateHostState.read('update-pending', identity.instance);
        const entries = Array.isArray(previous?.entries) ? previous.entries.slice(-19) : [];
        entries.push({
            request,
            coreArgv: [...coreArgv],
            reason,
            blockedBy: JSON.parse(JSON.stringify(blockedBy)),
            recordedAt: new Date().toISOString(),
        });
        const record = {
            schema: 'ploinky-update-pending-activation',
            version: 1,
            instance: identity.instance,
            workspaceRoot: identity.workspaceRoot,
            reason,
            entries,
        };
        updateHostState.write('update-pending', identity.instance, record);
        return record;
    }

    function pendingActivation(identity, details, warnings) {
        try {
            recordPendingActivation(identity, details);
        } catch (error) {
            warnings.push(`the pending activation record could not be written: ${error.message}`);
        }
    }

    // A previous update whose in-Box writer could not be proven stopped blocks
    // every new graph mutation until the engine confirms it ended. A dead host
    // process is never taken as that proof.
    // Returns '' when the durable barrier was written, otherwise why not.
    function isRecoveryBarrier(barrier, identity) {
        return barrier?.schema === 'ploinky-update-recovery' && barrier.version === 1
            && barrier.instance === identity.instance && barrier.workspaceRoot === identity.workspaceRoot
            && /^[a-f0-9]{64}$/.test(String(barrier.containerId || ''))
            && typeof barrier.nonce === 'string' && barrier.nonce.length > 0;
    }

    function recordRecoveryBarrier(identity, { operation, containerId, nonce, marker, cause, detail, reportPath = null }) {
        try {
            updateHostState.write('update-recovery', identity.instance, {
                schema: 'ploinky-update-recovery',
                version: 1,
                operation,
                instance: identity.instance,
                workspaceRoot: identity.workspaceRoot,
                containerId,
                nonce,
                marker,
                cause,
                detail,
                reportPath,
                createdAt: new Date().toISOString(),
            });
            return '';
        } catch (writeError) {
            return writeError?.message || String(writeError);
        }
    }

    /**
     * Restart the graph (a workspace `restart` or an update's activation) with
     * the same bounded discipline as the in-Box update: finite TERM -> KILL
     * escalation, an engine proof that the restart writer stopped, and a
     * durable recovery barrier (with no rollback) when that proof is missing.
     * Signals are held as for the in-Box update; the failure of a restart that
     * did not end normally reports one, and after a normal end one keeps its
     * default action.
     */
    async function executeBoundedRestart({ identity, engine, containerId, prepared, selection, skillScopeEnv,
        hostReachableIpv4, coreArgv = ['restart'] }) {
        const operationId = createReportNonce();
        const marker = `${UPDATE_OPERATION_ENV}=${operationId}`;
        const signals = createCancellation();
        let reported = true;
        signals.arm();
        try {
            const run = await runRestartCore(
                engine,
                containerId,
                coreArgv,
                prepared.hostPort,
                prepared.mediaHostPort,
                runner,
                {
                    workspaceRoot: identity.workspaceRoot,
                    stdout,
                    stderr,
                    hostReachableIpv4,
                    agentLib: selection,
                    skillScopeEnv,
                    operationId,
                },
            );
            const cause = run?.cause || 'unknown';
            if (run?.quiescence?.state !== 'confirmed') {
                const detail = String(run?.quiescence?.detail || 'in-Box quiescence was not confirmed');
                const barrierProblem = recordRecoveryBarrier(identity, {
                    operation: 'restart', containerId, nonce: operationId, marker, cause, detail,
                });
                const error = new PloinkyBoxError(
                    `The in-Box graph restart ended abnormally (${cause}) and the engine could not confirm that it `
                    + `stopped (${detail}). `
                    + (barrierProblem
                        ? `No durable recovery record could be written (${barrierProblem}); run \`ploinky stop\` `
                            + 'before any other mutation. '
                        : 'A recovery record now blocks new mutations until it is confirmed stopped. ')
                    + 'The workspace graph state is unknown.',
                    { code: 'PLOINKY_BOX_UPDATE_QUIESCENCE_UNCERTAIN' },
                );
                error.activation = Object.freeze({ outcome: 'recovery-required', graphMutated: true, boxRollback: null });
                error.skipRollback = true;
                throw error;
            }
            if (cause !== 'exited' || run.signal || run.status !== 0) {
                const tail = String(run?.tails?.stderr || run?.tails?.stdout || '').trim().split('\n').slice(-3).join(' | ');
                throw supervisorError(
                    `In-box restart failed (${cause}${run?.signal ? `, ${run.signal}` : ''}`
                    + `${Number.isInteger(run?.status) ? `, status ${run.status}` : ''})${tail ? `: ${tail}` : ''}`,
                    'PLOINKY_BOX_UPDATE_RESTART_FAILED',
                );
            }
            reported = false;
            return run;
        } finally {
            await signals.dispose({ reported });
        }
    }

    async function assertNoUpdateRecoveryBarrier(identity, ownership) {
        const barrier = updateHostState.read('update-recovery', identity.instance);
        if (!barrier) return [];
        if (!isRecoveryBarrier(barrier, identity)) {
            // A record this writer did not produce cannot name the writer to
            // probe. Only a stopped or absent Box proves no in-Box writer runs.
            const container = ownership?.handles?.container || null;
            if (!container || container.runtime?.running === false) {
                updateHostState.remove('update-recovery', identity.instance);
                return ['a malformed update recovery record was cleared because the Box is stopped'];
            }
            const error = new PloinkyBoxError(
                'The update recovery record for this workspace is malformed, so no earlier in-Box update can be '
                + 'proven stopped; no new mutation was started. Run `ploinky stop`, then run the command again.',
                { code: 'PLOINKY_BOX_UPDATE_RECOVERY_REQUIRED' },
            );
            error.activation = Object.freeze({ outcome: 'preserved', graphMutated: false, boxRollback: null });
            throw error;
        }
        let observed;
        try {
            observed = await probeUpdateQuiescence({
                engine: ownership.engine,
                containerId: barrier.containerId,
                nonce: barrier.nonce,
                marker: barrier.marker || null,
                runner,
            });
        } catch (error) {
            observed = { ok: false, detail: error.message };
        }
        const earlier = barrier.operation === 'restart' ? 'graph restart' : 'update';
        if (observed?.ok === true && !(observed.pids || []).length) {
            updateHostState.remove('update-recovery', identity.instance);
            return [`an earlier ${earlier} (${String(barrier.nonce).slice(0, 8)}) that could not be proven stopped `
                + 'is now confirmed stopped by the engine; its recovery record was cleared'];
        }
        const error = new PloinkyBoxError(
            `An earlier ${earlier} in this workspace may still be running inside the Box `
            + `(${barrier.cause}${barrier.detail ? `: ${barrier.detail}` : ''}); no new mutation was started. `
            + 'Wait for it to finish or run `ploinky stop`, then run the command again.',
            { code: 'PLOINKY_BOX_UPDATE_RECOVERY_REQUIRED' },
        );
        error.activation = Object.freeze({ outcome: 'preserved', graphMutated: false, boxRollback: null });
        throw error;
    }

    function uncertainCoreRecord(id, code, reason, details = null) {
        return createOperationRecord({
            phase: 'activation', id, outcome: 'uncertain', attempted: true, required: true, code, reason, details,
        });
    }

    // Private host record of the folders whose locks a host exclusion refresh
    // of this workspace may hold.
    function exclusionsIntent(identity) {
        return {
            read: () => updateHostState.read(HOST_EXCLUSIONS_INTENT_KIND, identity.instance),
            write: record => updateHostState.write(HOST_EXCLUSIONS_INTENT_KIND, identity.instance, record),
            remove: () => updateHostState.remove(HOST_EXCLUSIONS_INTENT_KIND, identity.instance),
        };
    }

    /**
     * The host refresh holds folder locks that only this host can prove
     * released, so it owns SIGINT/SIGTERM instead of dying with them: a signal
     * stops it before its next folder, and the update ends with a `cancelled`
     * record that blocks activation. A signal after that decision keeps its
     * default action.
     */
    async function refreshExclusionsOwningSignals(identity, folders) {
        const cancellation = createCancellation();
        cancellation.arm();
        let signal = '';
        try {
            const records = [...await refreshHostExclusions({
                folders, identity, env, cancellation, intent: exclusionsIntent(identity),
            })];
            signal = await cancellation.signalReceived();
            if (signal) {
                records.push(commandErrorRecord(new UpdateCancelledError(signal, 'the host finished this update'), { code: 'cancelled' }));
            }
            return records;
        } finally {
            await cancellation.dispose({ reported: Boolean(signal) });
        }
    }

    /**
     * Run the in-Box update with a fresh nonce and expected context, then
     * judge its one structured report. A nonzero exit keeps a complete
     * report; a missing or invalid report, a signal, a timeout, an output
     * limit or an exit status that disagrees with the report is uncertain.
     * An in-Box writer that cannot be proven stopped leaves a durable
     * recovery barrier and ends the transaction without further mutation.
     *
     * The exec client ending does not end the in-Box writer, and a dead host
     * leaves the next mutation nothing to wait for. So the host holds
     * SIGINT/SIGTERM from the in-Box start until the engine proved the writer
     * stopped or the barrier is durable; the proof is bounded. A signal held
     * there is reported by the run's cause when it cancelled the exec client,
     * by the recovery error, or else by a `cancelled` record that blocks
     * activation. One that arrives after a confirmed proof keeps its default
     * action.
     */
    async function executeCoreUpdate({ identity, prepared, engine, containerId, coreArgv, selection, skillScopeEnv,
        updateExcludedRepoPath = '', context }) {
        const nonce = createReportNonce();
        const reportContext = JSON.parse(JSON.stringify(context));
        const ploinkyDir = path.join(identity.workspaceRoot, '.ploinky');
        const signals = createCancellation();
        let diagnostics;
        let report;
        let cancelledBy = '';
        let reported = true;
        signals.arm();
        try {
            const run = await runUpdateCore(
                engine,
                containerId,
                coreArgv,
                prepared.hostPort,
                prepared.mediaHostPort,
                runner,
                {
                    workspaceRoot: identity.workspaceRoot,
                    stdout,
                    stderr,
                    agentLib: selection,
                    skillScopeEnv,
                    updateExcludedRepoPath,
                    reportNonce: nonce,
                    reportContext,
                },
            );
            diagnostics = {
                cause: run?.cause || 'unknown',
                status: Number.isInteger(run?.status) ? run.status : null,
                signal: run?.signal || null,
                escalation: run?.escalation || null,
                tails: run?.tails || null,
            };
            report = readReport(ploinkyDir, nonce, { expectedContext: reportContext });
            let quiescence = run?.quiescence;
            // An invalid completion report cannot use a client exit as evidence
            // that its writers stopped, including with injected runner adapters.
            if (!report.ok && quiescence?.state === 'confirmed') {
                let observed;
                try {
                    observed = await probeUpdateQuiescence({ engine, containerId, nonce,
                        marker: `${UPDATE_REPORT_NONCE_ENV}=${nonce}`, runner });
                } catch (error) { observed = { ok: false, detail: error.message }; }
                quiescence = observed?.ok === true && Array.isArray(observed.pids) && !observed.pids.length
                    ? { state: 'confirmed', method: 'engine-probe' }
                    : { state: 'uncertain', detail: observed?.detail || 'the update report is invalid and writers may still run' };
            }
            if (quiescence?.state !== 'confirmed') {
                const barrierProblem = recordRecoveryBarrier(identity, {
                    operation: 'update',
                    containerId,
                    nonce,
                    marker: `${UPDATE_REPORT_NONCE_ENV}=${nonce}`,
                    cause: diagnostics.cause,
                    detail: String(quiescence?.detail || 'in-Box quiescence was not confirmed'),
                    reportPath: path.join(ploinkyDir, 'running', 'update-reports', `${nonce}.json`),
                });
                const error = new PloinkyBoxError(
                    `The in-Box update ended abnormally (${diagnostics.cause}) and the engine could not confirm that it `
                    + `stopped (${quiescence?.detail || 'no proof'}). `
                    + (barrierProblem
                        ? `No durable recovery record could be written (${barrierProblem}); do not start another update `
                            + 'until the Box is stopped with `ploinky stop`. '
                        : 'A recovery record now blocks new mutations. ')
                    + 'Its report and artifacts were retained.',
                    { code: 'PLOINKY_BOX_UPDATE_QUIESCENCE_UNCERTAIN' },
                );
                error.activation = Object.freeze({ outcome: 'recovery-required', graphMutated: false, boxRollback: null });
                error.updateRecords = Object.freeze([
                    uncertainCoreRecord('in-box-update-runner', 'quiescence-unconfirmed', error.message, diagnostics),
                ]);
                // Nothing may touch a Box whose writer may still be running.
                error.skipRollback = true;
                throw error;
            }
            const signal = await signals.signalReceived();
            if (signal && diagnostics.cause !== `signal:${signal}`) cancelledBy = signal;
            reported = Boolean(signal);
        } finally {
            await signals.dispose({ reported });
        }
        const records = [];
        if (report.ok) {
            records.push(...report.result.records);
            // The in-Box core cannot see the host user's Git excludes view;
            // refresh the exclusions it deferred here, still under the lock.
            records.push(...await refreshExclusionsOwningSignals(identity, report.result.deferredExclusionFolders));
        } else {
            records.push(uncertainCoreRecord('in-box-update-report', report.code, report.reason));
        }
        if (diagnostics.cause !== 'exited' || diagnostics.signal || diagnostics.status === null) {
            records.push(uncertainCoreRecord(
                'in-box-update-runner',
                diagnostics.cause === 'exited' ? 'signal' : diagnostics.cause,
                `the in-Box update did not exit normally (${diagnostics.cause}${diagnostics.signal ? `, ${diagnostics.signal}` : ''})`,
                diagnostics,
            ));
        } else if (report.ok && diagnostics.status !== report.result.exitCode) {
            records.push(uncertainCoreRecord(
                'in-box-update-runner',
                'exit-status-mismatch',
                `the in-Box update exited ${diagnostics.status} but reported ${report.result.exitCode}`,
                diagnostics,
            ));
        }
        if (cancelledBy) {
            records.push(commandErrorRecord(new UpdateCancelledError(cancelledBy, 'activation'), { code: 'cancelled' }));
        }
        try {
            removeReport(ploinkyDir, nonce);
        } catch (_) {}
        return { records, report: report.ok ? report.result : null, reportContext, run: diagnostics };
    }

    // Map a canonical host checkout path onto the Box spelling of the same
    // workspace; a path outside the workspace has no Box spelling.
    function boxPathForCheckout(identity, checkoutPath) {
        if (!checkoutPath) return '';
        try {
            const scope = resolveUpdateFolderScope(checkoutPath, identity.workspaceRoot);
            const boxPath = mapUpdateScope(scope.relative, identity.workspaceRoot);
            relativeBoxWorkspacePath(identity.workspaceRoot, boxPath);
            return boxPath;
        } catch (_) {
            return '';
        }
    }

    // A verified Git writer reports a preserved or failed checkout as an
    // operation record. Keep its evidence under this phase and requirement.
    function gitWriterRecord(record, phase, required, fallbackId) {
        return createOperationRecord({
            phase,
            id: String(record?.id || fallbackId),
            outcome: record?.outcome || 'uncertain',
            attempted: typeof record?.attempted === 'boolean' ? record.attempted : record?.outcome !== 'skipped',
            required,
            code: record?.code || '',
            reason: record?.reason || '',
            before: record?.before ?? null,
            after: record?.after ?? null,
            details: record?.details ?? null,
        });
    }

    function workspacePloinkyRecord(result) {
        if (!result) return null;
        if (result.deferredToCore) return null;
        // The workspace Ploinky checkout is a required graph input.
        if (result.record && !['changed', 'unchanged'].includes(result.record.outcome)) {
            return gitWriterRecord(result.record, 'workspace-ploinky', true, result.repoPath || 'workspace-ploinky');
        }
        const evidence = { repoPath: result.repoPath || null };
        if (result.skipped) {
            const code = result.duplicateOfHost ? 'duplicate-of-host'
                : result.scopeExcluded ? 'scope-excluded' : 'not-applicable';
            return createOperationRecord({
                phase: 'workspace-ploinky', id: String(result.repoPath || 'workspace-ploinky'), outcome: 'skipped',
                required: false, code, reason: result.reason || '', before: evidence,
            });
        }
        return createOperationRecord({
            phase: 'workspace-ploinky',
            id: String(result.repoPath || 'workspace-ploinky'),
            outcome: result.updated ? 'changed' : 'unchanged',
            required: true,
            before: { ...evidence, revision: result.before || null },
            after: { ...evidence, revision: result.after || null },
        });
    }

    function agentLibRecord({ selection, changed, previous }) {
        return createOperationRecord({
            phase: 'agentlib',
            id: 'achillesAgentLib',
            outcome: changed ? 'changed' : 'unchanged',
            required: true,
            before: agentLibIdentity(previous, { provenance: false }),
            after: agentLibIdentity(selection, { provenance: false }),
        });
    }

    function activationRecord(outcome, reason = '') {
        const mapped = {
            restarted: 'changed',
            'not-required': 'unchanged',
            deferred: 'deferred',
            restored: 'deferred',
            'recovery-required': 'uncertain',
        }[outcome] || 'uncertain';
        return createOperationRecord({
            phase: 'activation',
            id: 'workspace-graph',
            outcome: mapped,
            attempted: outcome === 'restarted',
            required: false,
            code: outcome,
            reason,
        });
    }

    // `box.workspaceContainers`, read under the workspace lock just before the
    // in-Box update starts, lets its checkout locks prove that an owner from
    // another Box container of this workspace no longer runs.
    function updateContext({ identity, plan, scope, coreArgv, prepared, containerId, engine, source }) {
        return {
            schema: 'ploinky-update-context',
            version: 1,
            workspace: { instance: identity.instance, workspaceRoot: identity.workspaceRoot },
            request: plan.request,
            coreArgv: [...coreArgv],
            scope: scope ? { relative: scope.relative, boxPath: scope.boxPath } : null,
            box: {
                containerId,
                engine: engine.identity,
                action: prepared.action || null,
                imageId: prepared.imageId || null,
                workspaceContainers: listWorkspaceContainers(engine, identity, runner),
            },
            source,
        };
    }

    /**
     * Run every `ploinky update` form inside one workspace mutation
     * transaction. The full form updates sources, reconciles the Box, runs the
     * in-Box update and restarts and admits the graph only when the graph was
     * active under the lock and every required input was verified. Repository
     * forms run the in-Box command in the same transaction, never replace a
     * Box, and defer activation instead of restarting the whole graph.
     */
    async function runUpdateTransaction(coreArgs = ['update'], options = {}) {
        const plan = updatePlan(coreArgs, options);
        return lockedMutation(async (identity, lock, ownership) => {
            const barrierWarnings = await assertNoUpdateRecoveryBarrier(identity, ownership);
            // The update-recovery barrier comes first, then the hardware-limits gate. The full form applies the gate request and
            // settles a pending or requested gate-on to gate-off transition (it reconciles the Box); the targeted forms never
            // replace a Box, so they follow the saved gate and refuse while a downgrade is pending.
            const hardwareGate = selectHardwareGateForOperation(identity, plan.request.kind === 'all' ? 'update' : 'saved', lock);
            if (plan.request.kind === 'all') ownership = await settleHardwareTransitions(identity, lock, ownership, hardwareGate, 'update');
            else assertNoPendingHardwareTransition(identity, 'update');
            const scope = lockedUpdateScope(identity, plan);
            const coreArgv = updateCoreArgv(plan, scope);
            const priorCoreStartArgv = captureCoreStartArgv(identity);
            const activity = sampleGraphActivity(identity, ownership);
            const unresolvedAdmissions = listUnresolvedAdmissions(updateHostState, identity);
            const context = { identity, lock, ownership, plan, scope, coreArgv, priorCoreStartArgv, activity, hardwareGate };
            // Locks that an interrupted host exclusion refresh left are
            // released, when provably its own, before the in-Box step meets them.
            const exclusionRecovery = recoverHostExclusions({ intent: exclusionsIntent(identity), identity, env });
            let result;
            try {
                result = plan.request.kind === 'all'
                    ? await runFullUpdate(context)
                    : await runTargetedUpdate(context);
            } catch (error) {
                if (exclusionRecovery.records.length && error && typeof error === 'object') {
                    error.updateRecords = Object.freeze([...exclusionRecovery.records, ...(error.updateRecords || [])]);
                }
                throw error;
            }
            const records = Object.freeze([...exclusionRecovery.records, ...result.records]);
            return Object.freeze({
                ...result,
                records,
                decision: decideUpdateStatus(records),
                warnings: Object.freeze([...barrierWarnings, ...exclusionRecovery.warnings, ...result.warnings]),
                request: plan.request,
                coreArgv,
                unresolvedAdmissions,
            });
        });
    }

    async function runFullUpdate({ identity, lock, ownership, plan, scope, coreArgv, priorCoreStartArgv, activity, hardwareGate }) {
        const skillScopeEnv = buildHostSkillScope(identity.workspaceRoot, launchCwd);
        const priorSkillScopeEnv = readGraphSkillScope(identity);
        const hardware = hardwareWiringFor(identity, hardwareGate.enabled, ownership);
        const { desired: routerBinding } = selectSavedRouterBinding(identity);
        const { saved: savedGpuGrant, desired: gpu } = selectSavedGpuWiring(identity, hardwareGate.enabled);
        let workspacePloinky;
        try {
            workspacePloinky = await updateWorkspacePloinky({
                identity,
                lock,
                repositoryRoot,
                updateScopeRoot: scope?.canonicalFolder || plan.updateScopeRoot || identity.workspaceRoot,
            });
        } catch (error) {
            // A preserved (dirty, diverged, detached) or failed checkout is a
            // named result, not an abort; any other failure still aborts.
            if (!error?.record) throw error;
            const repoPath = error.repoPath || error.record.details?.checkout?.path || error.record.id || null;
            workspacePloinky = Object.freeze({
                found: true,
                updated: false,
                skipped: error.record.outcome === 'skipped',
                reason: error.record.reason || error.message,
                repoPath,
                // The in-Box update must not pull the same checkout again.
                boxRepoPath: error.boxRepoPath || boxPathForCheckout(identity, repoPath),
                record: error.record,
            });
        }
        const { selection, changed, previous } = await updateAgentLib({
            workspaceRoot: identity.workspaceRoot,
            branchPolicy: plan.branchPolicy,
            insideBox: false,
            loadImageBundle: imageBundleLoader(ownership, plan.imageRef),
        });
        const prepared = await reconcileConfiguredGraph({
            identity,
            ownership,
            engine: ownership.engine,
            runner,
            lock,
            repositoryRoot,
            agentLib: selection,
            routerBinding,
            gpu,
            hardware,
            imageRef: plan.imageRef,
            platform,
            env,
            stdout,
            stderr,
        }, { priorCoreStartArgv, priorSkillScopeEnv, priorGraphActive: activity.active });
        const containerId = prepared.ownership.handles.container.id;
        const sourceSnapshot = {
            skillScopes: {
                prior: priorSkillScopeEnv?.PLOINKY_SKILL_SCOPE || null,
                proposed: skillScopeEnv.PLOINKY_SKILL_SCOPE,
                priorRequired: activity.active || activity.undetermined,
            },
            workspacePloinky: workspacePloinky
                ? {
                    repoPath: workspacePloinky.repoPath || null,
                    before: workspacePloinky.before || null,
                    after: workspacePloinky.after || null,
                    updated: workspacePloinky.updated === true,
                    skipped: workspacePloinky.skipped === true,
                    delegatedBoxRepoPath: workspacePloinky.delegatedBoxRepoPath || null,
                }
                : null,
            agentLib: {
                changed: Boolean(changed),
                ...agentLibIdentity(selection, { provenance: false }),
            },
        };
        const inputRecords = [
            ...plan.hostRecords,
            ...[workspacePloinkyRecord(workspacePloinky)].filter(Boolean),
            agentLibRecord({ selection, changed, previous }),
        ];
        const warnings = [];
        let graphMutated = false;
        let restart = false;
        let admission;
        let core;
        let decision;
        let outcome;
        try {
            await prepareGateOnGeneration(identity, ownership.engine, containerId, prepared.hardware);
            await ensureBoxDependencies(ownership.engine, containerId, runner, { workspaceRoot: identity.workspaceRoot, stdout, stderr });
            core = await executeCoreUpdate({
                identity,
                prepared,
                engine: ownership.engine,
                containerId,
                coreArgv,
                selection,
                skillScopeEnv,
                updateExcludedRepoPath: workspacePloinky?.boxRepoPath || '',
                context: updateContext({
                    identity, plan, scope, coreArgv, prepared, containerId, engine: ownership.engine, source: sourceSnapshot,
                }),
            });
            if (workspacePloinky?.deferredToCore) {
                const delegatedPath = path.resolve(workspacePloinky.delegatedBoxRepoPath);
                const index = core.records.findIndex(record => (
                    ['registered-repository', 'workspace-repository'].includes(record.phase)
                    && path.resolve(record.details?.checkout?.path || record.id) === delegatedPath
                ));
                const record = index >= 0
                    ? gitWriterRecord(core.records[index], 'workspace-ploinky', true, delegatedPath)
                    : createOperationRecord({ phase: 'workspace-ploinky', id: delegatedPath,
                        outcome: 'uncertain', required: true, code: 'workspace-ploinky-result-missing',
                        reason: 'the in-Box update did not verify the selected workspace Ploinky checkout' });
                if (index >= 0) core.records[index] = record;
                else core.records.push(record);
                workspacePloinky = { ...workspacePloinky, deferredToCore: false, record,
                    updated: record.outcome === 'changed', skipped: record.outcome === 'skipped',
                    before: record.before?.head || null, after: record.after?.head || null,
                    reason: record.reason };
                sourceSnapshot.workspacePloinky = { ...sourceSnapshot.workspacePloinky,
                    before: workspacePloinky.before, after: workspacePloinky.after,
                    updated: workspacePloinky.updated, outcome: record.outcome };
            }
            inputRecords.push(...core.records);
            decision = decideUpdateStatus(inputRecords);
            restart = activity.active && decision.activationAllowed;
            // Unverified required inputs block both a graph restart and the
            // admission of the candidate AgentLib selection and metadata, with
            // or without an active graph; the prior selection stays in force.
            const blocked = !decision.activationAllowed;
            if (blocked && prepared.action === 'replaced') {
                // The replacement already stopped the old Box (and any active
                // graph); the candidate is not admitted. Try to reconstruct the
                // previous Box and, if one was active, its graph instead.
                try {
                    await rollbackPreparedGraph({
                        identity,
                        prepared,
                        ownership,
                        containerId,
                        error: supervisorError('Activation was blocked by unverified required update inputs',
                            'PLOINKY_BOX_UPDATE_ACTIVATION_BLOCKED'),
                        stopGraph: false,
                        restoreGraph: activity.active && Boolean(prepared.previousAgentLib) && Boolean(priorCoreStartArgv),
                        restoreCoreArgv: priorCoreStartArgv,
                        restoreSkillScopeEnv: priorSkillScopeEnv,
                        restoreStopped: ownership.handles?.container?.runtime?.running !== true,
                        priorGraphActive: activity.active,
                    });
                } catch (rollbackError) {
                    outcome = rollbackError?.activation?.outcome || 'recovery-required';
                    if (rollbackError?.code === 'PLOINKY_BOX_TRANSACTION_ROLLBACK_FAILED') {
                        warnings.push(rollbackError.message);
                    }
                }
            } else if (blocked) {
                lock.assertHeld(identity.instance);
                prepared.finalize?.();
                outcome = 'deferred';
            } else {
                if (restart) {
                    // Revalidate the exact Box immediately before the graph mutation.
                    lock.assertHeld(identity.instance);
                    prepared.validate?.();
                    const hostReachableIpv4 = await resolveHostReachableIpv4({ platform });
                    graphMutated = true;
                    await executeBoundedRestart({
                        identity, engine: ownership.engine, containerId, prepared, selection, skillScopeEnv, hostReachableIpv4,
                    });
                }
                admission = await completeGraphAdmission({
                    identity,
                    lock,
                    prepared,
                    selection,
                    requireHealth: restart,
                    skillScopeEnv: restart ? skillScopeEnv : null,
                    operation: 'update',
                    activated: restart,
                    source: { coreArgv: [...coreArgv], ...sourceSnapshot },
                    // Without a restart there is no health proof to record against.
                    gpuGrantUpdate: restart ? savedGpuGrantUpdate(savedGpuGrant, gpu, prepared) : null,
                    hardwareGate,
                });
                outcome = restart ? 'restarted' : (activity.undetermined ? 'deferred' : 'not-required');
            }
        } catch (error) {
            if (error?.skipRollback) throw error;
            // Keep the verified input outcomes in the final host result; the
            // host prepends its own records itself.
            if (error && typeof error === 'object' && !error.updateRecords) {
                error.updateRecords = Object.freeze(inputRecords.slice(plan.hostRecords.length));
            }
            await rollbackPreparedGraph({
                identity,
                prepared,
                ownership,
                containerId,
                error,
                stopGraph: graphMutated,
                restoreGraph: activity.active
                    && Boolean(prepared.previousAgentLib)
                    && Boolean(priorCoreStartArgv)
                    && (graphMutated || prepared.action === 'replaced'),
                restoreCoreArgv: priorCoreStartArgv,
                restoreSkillScopeEnv: priorSkillScopeEnv,
                priorGraphActive: activity.active,
            });
        }
        if (restart) reportSettled(prepared.routerBinding);
        const gpuReapplied = restart ? await reapplyDeclaredGpu(identity, lock, prepared.gpu) : null;
        warnings.push(...(admission?.warnings || []));
        if (outcome === 'deferred' || !decision.activationAllowed) {
            pendingActivation(identity, {
                request: plan.request,
                coreArgv,
                blockedBy: decision.blockedBy,
                reason: decision.activationAllowed
                    ? 'The Box was running but its workspace graph state could not be read; '
                        + 'updated sources may require activation.'
                    : 'Activation was blocked because required update inputs were not verified.',
            }, warnings);
        }
        const activationReason = decision.activationAllowed ? ''
            : `blocked by ${decision.blockedBy.map(entry => `${entry.phase} ${entry.id}`).join(', ')}`;
        return {
            identity, ...prepared, containerId, agentLib: selection,
            changed, previous, workspacePloinky,
            ...(gpuReapplied ? { gpuReapplied } : {}),
            report: core.report,
            reportContext: core.reportContext,
            run: core.run,
            records: [...inputRecords, activationRecord(outcome, activationReason)],
            activation: Object.freeze({
                outcome,
                sampled: activity,
                activationAllowed: decision.activationAllowed,
                blockedBy: decision.blockedBy,
            }),
            warnings: Object.freeze(warnings),
        };
    }

    async function runTargetedUpdate({ identity, lock, ownership, plan, scope, coreArgv, priorCoreStartArgv, activity, hardwareGate }) {
        const skillScopeEnv = buildHostSkillScope(identity.workspaceRoot, launchCwd);
        const priorSkillScopeEnv = readGraphSkillScope(identity);
        // Only a Box created here needs the saved binding; an existing Box keeps
        // its publication. Replacement is refused before any Box mutation.
        const routerBinding = ownership.handles?.container
            ? null
            : selectSavedRouterBinding(identity).desired;
        const gpu = ownership.handles?.container
            ? undefined
            : selectSavedGpuWiring(identity, hardwareGate.enabled).desired;
        const { selection } = await selectAgentLib({
            workspaceRoot: identity.workspaceRoot,
            branchPolicy: null,
            loadImageBundle: imageBundleLoader(ownership, plan.imageRef),
        });
        // A failed reuse or start returns the Box to its prior running state
        // through the same recovery as graph commands. The refusal to replace
        // happens before any Box mutation.
        const prepared = await reconcileConfiguredGraph({
            identity,
            ownership,
            engine: ownership.engine,
            runner,
            lock,
            repositoryRoot,
            agentLib: selection,
            routerBinding,
            gpu,
            // An existing Box keeps its hardware-limits wiring; a Box created here takes the saved gate.
            hardware: ownership.handles?.container ? undefined : hardwareWiringFor(identity, hardwareGate.enabled, ownership),
            imageRef: plan.imageRef,
            allowReplacement: false,
            platform,
            env,
            stdout,
            stderr,
        }, { priorCoreStartArgv, priorSkillScopeEnv: null });
        if (prepared.action === 'replaced') {
            // Defense in depth for reconcilers that ignore the refusal option.
            await rollbackPreparedGraph({
                identity, prepared, ownership, containerId: prepared.ownership.handles.container.id,
                error: supervisorError(
                    'A targeted update must not replace the existing Box; run `ploinky update` or `ploinky restart`',
                    'PLOINKY_BOX_REPLACEMENT_REFUSED',
                ),
                stopGraph: false,
                restoreGraph: false,
            });
        }
        const containerId = prepared.ownership.handles.container.id;
        try {
            await prepareGateOnGeneration(identity, ownership.engine, containerId, prepared.hardware);
            await ensureBoxDependencies(ownership.engine, containerId, runner, { workspaceRoot: identity.workspaceRoot, stdout, stderr });
            prepared.finalize?.();
        } catch (error) {
            await rollbackPreparedGraph({
                identity, prepared, ownership, containerId, error,
                stopGraph: false,
                restoreGraph: false,
            });
        }
        lock.assertHeld(identity.instance);
        let core;
        try {
            core = await executeCoreUpdate({
                identity,
                prepared,
                engine: ownership.engine,
                containerId,
                coreArgv,
                selection,
                skillScopeEnv,
                context: updateContext({
                    identity, plan, scope, coreArgv, prepared, containerId, engine: ownership.engine,
                    source: { skillScopes: {
                        prior: priorSkillScopeEnv?.PLOINKY_SKILL_SCOPE || null,
                        proposed: skillScopeEnv.PLOINKY_SKILL_SCOPE,
                        priorRequired: activity.active || activity.undetermined,
                    }, agentLib: { changed: false, ...agentLibIdentity(selection, { provenance: false }) } },
                }),
            });
        } catch (error) {
            if (error && typeof error === 'object' && !error.activation) {
                error.activation = Object.freeze({ outcome: 'preserved', graphMutated: false, boxRollback: null });
            }
            throw error;
        }
        const inputRecords = [...plan.hostRecords, ...core.records];
        const decision = decideUpdateStatus(inputRecords);
        const warnings = [];
        let outcome = 'not-required';
        if (activity.active || activity.undetermined) {
            outcome = 'deferred';
            pendingActivation(identity, {
                request: plan.request,
                coreArgv,
                blockedBy: decision.blockedBy,
                reason: activity.active
                    ? 'A targeted update ran while the workspace graph was active; updated sources may require activation.'
                    : 'A targeted update ran while the workspace graph state could not be read; '
                        + 'updated sources may require activation.',
            }, warnings);
        }
        return {
            identity, ...prepared, containerId, agentLib: selection,
            report: core.report,
            reportContext: core.reportContext,
            run: core.run,
            records: [...inputRecords, activationRecord(outcome, 'targeted update forms never restart the whole graph')],
            activation: Object.freeze({
                outcome,
                sampled: activity,
                activationAllowed: decision.activationAllowed,
                blockedBy: decision.blockedBy,
            }),
            warnings: Object.freeze(warnings),
        };
    }

    // A failed reconcile has already restored or preserved the outer Box.
    // Return the exact previous Box, graph, and running state from its outcome.
    async function recoverFailedGraphReconcile({
        identity,
        lock,
        ownership,
        error,
        priorRunning,
        priorGraphRunning,
        priorCoreStartArgv,
        priorSkillScopeEnv,
        priorGraphActive = false,
    }) {
        const outcome = error?.boxRollback;
        let graphRestored = false;
        const engine = ownership.engine;
        const failures = [];
        let recoveredContainerId = '';
        // The recovered generation's hardware-limits wiring, and whether that
        // generation has already been prepared here (§6.5, U11).
        let recoveredHardware = null;
        let recoveredPrepared = false;
        // The outcome carries the previous Box's own wiring: null only for a
        // gate-off Box. Without the field, undefined keeps the Box's own
        // wiring; it is never replaced by a gate-off Box here (U9).
        const previousHardware = outcome && Object.hasOwn(outcome, 'hardware') ? outcome.hardware : undefined;
        if (outcome?.action === 'restored') {
            recoveredContainerId = outcome.containerId;
            recoveredHardware = previousHardware ?? null;
        } else if (outcome?.action === 'preserved' && (outcome.oldStopAttempted || outcome.oldStartAttempted)) {
            // The graceful stop or removal failed part way. Bring the exact
            // previous Box back through the normal reuse lifecycle.
            try {
                const observed = inspect(identity);
                const handle = observed?.state === 'owned' ? observed.handles?.container : null;
                if (!handle || handle.id !== outcome.containerId
                    || observed.engine?.identity !== engine.identity) {
                    throw new Error('the previous Box changed after the failed replacement');
                }
                if (!priorRunning) {
                    // A reused Box can start before its readiness proof fails.
                    // Return it to stopped without trying to start it again.
                    if (handle.runtime?.running === true) recoveredContainerId = handle.id;
                } else if (handle.runtime?.running === true) {
                    // Finish an interrupted graph stop before restarting the graph.
                    if (priorGraphRunning) {
                        stopPloinkyLocalByContainerId(engine, handle.id, runner, { workspaceRoot: identity.workspaceRoot });
                    }
                    recoveredContainerId = handle.id;
                    recoveredHardware = observedHardwareWiring(identity, observed);
                } else {
                    const restarted = await reconcileSafely({
                        identity,
                        ownership: observed,
                        engine,
                        runner,
                        lock,
                        repositoryRoot,
                        agentLib: outcome.agentLib,
                        routerBinding: outcome.routerBinding,
                        // Bring the previous Box back with its own GPU and
                        // hardware-limits wiring.
                        gpu: outcome.gpu,
                        hardware: previousHardware,
                        imageRef: String(handle.labels?.[BOX_LABELS.imageRef] || ''),
                        imagePolicy: 'preserve',
                        platform,
                        env,
                        stdout,
                        stderr,
                    });
                    restarted.finalize?.();
                    recoveredContainerId = restarted.ownership.handles.container.id;
                    recoveredHardware = restarted.hardware ?? null;
                    // A restored gate-on generation is prepared before its graph.
                    await prepareGateOnGeneration(identity, engine, recoveredContainerId, recoveredHardware);
                    recoveredPrepared = true;
                }
            } catch (recoverError) {
                failures.push(`previous Box recovery: ${recoverError.message}`);
            }
        }
        if (recoveredContainerId && priorGraphRunning) {
            try {
                // A restored or restarted gate-on generation is prepared
                // before its graph is restored (§6.5 Rollback restoration).
                if (!recoveredPrepared) await prepareGateOnGeneration(identity, engine, recoveredContainerId, recoveredHardware);
                await restorePriorGraph({
                    identity,
                    engine,
                    containerId: recoveredContainerId,
                    hostPort: outcome.hostPort,
                    mediaHostPort: outcome.mediaHostPort,
                    agentLib: outcome.agentLib,
                    routerBinding: outcome.routerBinding,
                    coreArgv: priorCoreStartArgv,
                    skillScopeEnv: priorSkillScopeEnv,
                });
                graphRestored = true;
            } catch (restoreError) {
                failures.push(`prior graph restoration: ${restoreError.message}`);
            }
        } else if (recoveredContainerId && !priorRunning) {
            try {
                stopRestoredBox(identity, engine, recoveredContainerId);
            } catch (stopError) {
                failures.push(`prior stopped Box restoration: ${stopError.message}`);
            }
        }
        // The old graph was disrupted when its Box was stopped or recreated.
        const graphDisrupted = priorGraphActive
            && (outcome?.action === 'restored' || outcome?.oldStopAttempted === true);
        let activationOutcome = 'preserved';
        if (failures.length || outcome?.action === 'failed') activationOutcome = 'recovery-required';
        else if (graphRestored) activationOutcome = 'restored';
        else if (graphDisrupted) activationOutcome = 'recovery-required';
        else if (recoveredContainerId || outcome?.action === 'restored') activationOutcome = 'restored';
        const activation = Object.freeze({
            outcome: activationOutcome,
            graphMutated: false,
            boxRollback: outcome?.action || null,
        });
        if (failures.length) {
            const failure = supervisorError(
                `${error.message}; rollback failures: ${failures.join('; ')}`,
                'PLOINKY_BOX_TRANSACTION_ROLLBACK_FAILED',
            );
            failure.activation = activation;
            throw failure;
        }
        if (error && typeof error === 'object') error.activation = activation;
        throw error;
    }

    /**
     * Publish the public Router on a selected host address and port.
     *
     * The configured graph, its skill scope, the current image, AgentLib
     * generation, and media port are preserved. A changed publication replaces
     * the Box through the normal lifecycle, then the graph restarts and is
     * health-checked through the new address before the preference is saved.
     * A stopped graph is started. Any failure restores the previous
     * publication, graph and running state, and saved preference.
     */
    async function runBindTransaction(mapping = null) {
        return lockedMutation(async (identity, lock, ownership) => {
            await assertNoUpdateRecoveryBarrier(identity, ownership);
            // Every rejection happens before the Box, graph, or preference changes.
            assertNoPendingHardwareTransition(identity, 'bind');
            selectHardwareGateForOperation(identity, 'bind', lock);
            const priorCoreStartArgv = captureCoreStartArgv(identity);
            if (!priorCoreStartArgv) {
                throw supervisorError(
                    'ploinky bind requires a configured workspace graph to expose; run `ploinky start AGENT` first',
                    'PLOINKY_BOX_BIND_GRAPH_REQUIRED',
                );
            }
            const priorSkillScopeEnv = validateGraphSkillScope(identity, readGraphSkillScope(identity));
            const savedBinding = routerBindingStore.read(identity);
            const engine = ownership.engine;
            const container = ownership.handles?.container || null;
            const current = container ? currentRouterPublication(container) : null;
            const routerBinding = hostRouterBinding(mapping ?? {
                address: ROUTER_BIND_WILDCARD,
                hostPort: current?.hostPort ?? savedBinding?.hostPort ?? BOX_ROUTER_CONTAINER_PORT,
            });
            const priorRunning = container?.runtime?.running === true;
            let priorGraphRunning = false;
            if (priorRunning) {
                const inbox = readInboxStatus(engine, container.id, identity.workspaceRoot);
                if (!inbox) {
                    throw supervisorError(
                        'The running Box status could not be read, so its graph state cannot be restored after a '
                        + 'failed bind; retry when the Box has finished starting',
                        'PLOINKY_BOX_BIND_STATUS_UNAVAILABLE',
                    );
                }
                // Initialization and routing are persisted configuration. An
                // ad hoc command can start only the outer Box after `stop`.
                priorGraphRunning = inbox.initialized === true && inbox.routingConfigured === true
                    && Number.isSafeInteger(inbox.runningAgents) && inbox.runningAgents > 0;
            }
            const imageRef = container
                ? String(container.labels?.[BOX_LABELS.imageRef] || '')
                : resolveBoxImageReference(env);
            let selection;
            if (container) {
                // Keep the mounted AgentLib generation; bind never advances it.
                selection = agentLibContractFromContainer(container);
                if (selection.mode !== 'image' || priorRunning) {
                    revalidateMountedAgentLibSource(selection, { engine, containerId: container.id, runner });
                }
            } else {
                ({ selection } = await selectAgentLib({
                    workspaceRoot: identity.workspaceRoot,
                    branchPolicy: null,
                    loadImageBundle: localImageBundleLoader(ownership, imageRef),
                }));
            }
            stderr?.write?.(
                `[ploinky] Applying Router binding ${describeRouterBinding(routerBinding)}; `
                + 'the Box and workspace graph restart briefly if the publication changes...\n',
            );
            let prepared;
            try {
                prepared = await reconcileSafely({
                    identity,
                    ownership,
                    engine,
                    runner,
                    lock,
                    repositoryRoot,
                    agentLib: selection,
                    routerBinding,
                    // Bind changes only the publication: an existing Box keeps
                    // its GPU wiring, and only a new Box takes the saved grant.
                    gpu: container ? undefined : selectSavedGpuWiring(identity).desired,
                    // Likewise the hardware-limits wiring follows the saved gate.
                    hardware: container ? undefined : savedHardwareWiring(identity, ownership, lock).hardware,
                    imageRef,
                    imagePolicy: 'preserve',
                    platform,
                    env,
                    stdout,
                    stderr,
                });
            } catch (error) {
                await recoverFailedGraphReconcile({
                    identity,
                    lock,
                    ownership,
                    error,
                    priorRunning,
                    priorGraphRunning,
                    priorCoreStartArgv,
                    priorSkillScopeEnv,
                });
            }
            const containerId = prepared.ownership.handles.container.id;
            const graphAlreadyRunning = prepared.action === 'reused' && priorGraphRunning;
            let graphMutated = false;
            let bindingWriteAttempted = false;
            try {
                if (!graphAlreadyRunning) {
                    await prepareGateOnGeneration(identity, engine, containerId, prepared.hardware);
                    await ensureBoxDependencies(engine, containerId, runner, { workspaceRoot: identity.workspaceRoot, stdout, stderr });
                    const hostReachableIpv4 = await resolveHostReachableIpv4({ platform });
                    graphMutated = true;
                    await startCore(
                        engine,
                        containerId,
                        priorCoreStartArgv,
                        prepared.hostPort,
                        prepared.mediaHostPort,
                        runner,
                        {
                            workspaceRoot: identity.workspaceRoot,
                            stdout,
                            stderr,
                            hostReachableIpv4,
                            agentLib: selection,
                            skillScopeEnv: priorSkillScopeEnv,
                            routerBinding: prepared.routerBinding,
                        },
                    );
                }
                await healthCheck(prepared.hostPort, { routerBinding: prepared.routerBinding });
                if (container) {
                    revalidateMountedAgentLibSource(selection, { engine, containerId, runner });
                } else {
                    revalidateAgentLibSource(selection, { engine, containerId, runner });
                    commitAgentLibSelection(identity.workspaceRoot, selection);
                }
                bindingWriteAttempted = true;
                routerBindingStore.write(identity, routerBinding, lock);
                prepared.finalize?.();
                return Object.freeze({
                    identity,
                    action: prepared.action === 'reused'
                        ? (graphMutated ? 'graph-started' : 'unchanged')
                        : prepared.action,
                    containerId,
                    hostPort: prepared.hostPort,
                    mediaHostPort: prepared.mediaHostPort,
                    routerBinding: prepared.routerBinding,
                    previousRouterBinding: current
                        ? Object.freeze({ address: current.address, hostPort: current.hostPort, hosts: current.hosts })
                        : null,
                    savedRouterBinding: savedBinding,
                    graphStarted: graphMutated,
                    agentLib: selection,
                });
            } catch (error) {
                await rollbackPreparedGraph({
                    identity,
                    prepared,
                    ownership,
                    containerId,
                    error,
                    stopGraph: graphMutated,
                    restoreGraph: priorGraphRunning && (graphMutated || prepared.action === 'replaced'),
                    restoreCoreArgv: priorCoreStartArgv,
                    restoreSkillScopeEnv: priorSkillScopeEnv,
                    restoreStopped: Boolean(container) && !priorRunning,
                    afterRollback: bindingWriteAttempted
                        ? () => {
                            try {
                                routerBindingStore.restore(identity, savedBinding, lock);
                            } catch (restoreError) {
                                throw new Error(`saved Router binding restoration: ${restoreError.message}`);
                            }
                        }
                        : null,
                });
            }
        });
    }

    const describeGpuGrant = describeGpuDecision;

    // What stays in force after a failed change: the saved grant, or, when no
    // record exists, the GPU wiring the Box itself still carries.
    function describePreviousGpu(saved, boxGpu) {
        if (saved || !boxGpu) return `the previous GPU grant (${describeGpuGrant(saved)})`;
        return `the Box GPU wiring ${boxGpu.fingerprint} (${boxGpu.state})`;
    }

    function observedBoxGpu(container, identity) {
        try {
            return container ? observeContainerGpuWiring(container, { identity }) : null;
        } catch {
            return null;
        }
    }

    // A failed change never reports success while the previous GPU access
    // remains; rollback failures, if any, are appended by the rollback.
    function gpuChangeError(verb, saved, error, boxGpu = null) {
        const wrapped = new PloinkyBoxError(
            `${verb === 'start' ? 'applying the GPU agents after start' : `ploinky gpu ${verb}`} did not complete; `
            + `${describePreviousGpu(saved, boxGpu)} `
            + `is still in force: ${error.message}`,
            { code: error?.code || 'PLOINKY_BOX_GPU_GRANT_FAILED', cause: error },
        );
        if (error?.boxRollback) wrapped.boxRollback = error.boxRollback;
        return wrapped;
    }

    /**
     * A revoke restarts the graph without GPU access for the agents it removes.
     * An enabled agent that requests the GPU would then fail admission, and the
     * transaction would replace the Box twice to restore it; refuse before any
     * Box change instead. The graph start remains the authority for anything
     * this workspace-file check cannot read.
     */
    function assertNoEnabledAgentLosesGpu(identity, effectiveAgents) {
        const stranded = enabledCdiRequestingAgents(identity.workspaceRoot)
            .filter((agentId) => !effectiveAgents.includes(agentId));
        if (!stranded.length) return;
        const one = stranded.length === 1;
        throw supervisorError(
            `The enabled agent${one ? '' : 's'} ${stranded.join(', ')} request${one ? 's' : ''} the GPU, and `
            + `ploinky gpu revoke would restart the workspace graph without a grant for ${one ? 'it' : 'them'}, so `
            + `${one ? 'its' : 'their'} start would fail admission. Disable ${one ? 'it' : 'them'} first with `
            + `${stranded.map((agentId) => `\`ploinky disable agent ${agentId}\``).join(' and ')} and revoke again, `
            + 'or remove the Box with `ploinky destroy` and run `ploinky gpu revoke` again, which then only clears '
            + 'the saved grant. Nothing was changed',
            'PLOINKY_BOX_GPU_AGENTS_ENABLED',
        );
    }

    // The number of no-wait workers running in the Box, or null when it
    // cannot be read.
    function countBoxNoWaitWorkers(engine, containerId) {
        if (countNoWaitWorkers) return countNoWaitWorkers(engine, containerId);
        const result = runner.query(engine.name, [
            'container', 'exec', '--user', 'podman', containerId,
            '/usr/bin/pgrep', '-c', '-f', NO_WAIT_WORKER_SCRIPT,
        ]);
        const text = String(result?.stdout || '').trim();
        // pgrep exits 1 when nothing matches, still printing the count 0.
        if (!/^\d+$/.test(text) || !(result?.ok || (result?.status === 1 && text === '0'))) return null;
        return Number(text);
    }

    async function waitForNoWaitLaunches(identity) {
        const ownership = inspect(identity);
        const container = ownership.handles?.container;
        if (!container) return { settled: true };
        const deadline = now() + NO_WAIT_SETTLE_TIMEOUT_MS;
        let announced = false;
        for (;;) {
            const count = countBoxNoWaitWorkers(ownership.engine, container.id);
            if (count === 0) return { settled: true };
            if (count === null) return { settled: false, reason: 'could not count the no-wait agent launches in the Box' };
            if (now() >= deadline) {
                return {
                    settled: false,
                    reason: `${count} no-wait agent ${count === 1 ? 'launch is' : 'launches are'} still running after `
                        + `${Math.round(NO_WAIT_SETTLE_TIMEOUT_MS / 60000)} minutes`,
                };
            }
            if (!announced) {
                stderr?.write?.(
                    `[ploinky] Waiting for ${count} no-wait agent ${count === 1 ? 'launch' : 'launches'} (image pulls) `
                    + 'to finish before replacing the Box to apply the GPU agents...\n',
                );
                announced = true;
            }
            await waitDelay(Math.min(NO_WAIT_POLL_MS, Math.max(0, deadline - now())));
        }
    }

    /**
     * D14 first start: the in-Box start or restart may just have installed
     * repos whose manifests declare GPU access, after the host prepared the
     * Box. When the effective set now differs from the wiring the Box was
     * prepared with, replace the Box once through the grant transaction, after
     * the start's no-wait launches have finished (their image pulls, and the
     * edge-generation lock the graph stop also needs). A failure, or launches
     * that outlast the bound, are reported and leave the workspace running
     * without it.
     */
    async function reapplyDeclaredGpu(identity, lock, preparedGpu) {
        let selected;
        try {
            selected = selectSavedGpuWiring(identity);
        } catch (error) {
            stderr?.write?.(`[ploinky] Could not re-check the GPU agents: ${error.message}\n`);
            return null;
        }
        if (sameGpuWiring(selected.desired, preparedGpu)) return null;
        const launches = await waitForNoWaitLaunches(identity);
        if (!launches.settled) {
            stderr?.write?.(
                `[ploinky] The installed manifests change the GPU agents, but ${launches.reason}; the workspace keeps `
                + 'running without that GPU wiring; run `ploinky start` again once they finish.\n',
            );
            return null;
        }
        stderr?.write?.('[ploinky] The installed manifests change the GPU agents; replacing the Box once to apply them...\n');
        try {
            return await applyGpuGrantChange({
                identity,
                lock,
                ownership: inspect(identity),
                saved: selected.saved,
                next: selected.saved,
                gpu: selected.desired,
                verb: 'start',
                declared: selected.declared,
            });
        } catch (error) {
            stderr?.write?.(
                `[ploinky] ${error.message}; the workspace keeps running without that GPU wiring. `
                + 'Run `ploinky start` again to retry.\n',
            );
            return null;
        }
    }

    /**
     * Apply a changed GPU grant, modelled on bind. The configured graph, its
     * skill scope, image, AgentLib generation and publication are kept. A
     * changed wiring replaces the Box through the normal lifecycle, the graph
     * restarts and passes its health check, and only then is the grant record
     * written. Any failure restores the previous Box, graph, running state and
     * record. Without a Box, the record alone is saved for the next creation.
     */
    async function applyGpuGrantChange({ identity, lock, ownership, saved, next, gpu, verb, declared = [] }) {
        const container = ownership.handles?.container || null;
        const previousBoxGpu = saved ? null : observedBoxGpu(container, identity);
        const saveDecision = (admitted) => {
            if (next) gpuGrantStore.write(identity, next, lock, { admitted });
            else gpuGrantStore.clear(identity, lock);
        };
        if (!container) {
            saveDecision(null);
            if (!next) pruneGpuGenerations(identity, lock, null);
            return Object.freeze({
                identity, verb, action: 'saved', grant: next, previousGrant: saved,
                gpu, previousGpu: null, containerId: null, graphStarted: false,
                access: effectiveGpuAccess(next, declared),
            });
        }
        const priorCoreStartArgv = captureCoreStartArgv(identity);
        if (!priorCoreStartArgv) {
            // With no graph to restart, a decision that leaves the Box's wiring
            // exactly as it is (content addressed) only updates the record.
            const current = observedBoxGpu(container, identity);
            if (sameGpuWiring(current, gpu) && (current || !container.labels?.[BOX_LABELS.gpuGrant])) {
                saveDecision(admittedGpuWiring(gpu));
                return Object.freeze({
                    identity, verb, action: 'unchanged', grant: next, previousGrant: saved,
                    gpu, previousGpu: current, containerId: container.id, graphStarted: false,
                    access: effectiveGpuAccess(next, declared),
                });
            }
            // Removing GPU access must not require starting agents first: without
            // a Box, a revoke only clears the saved grant.
            throw supervisorError(
                verb === 'revoke'
                    ? 'ploinky gpu revoke replaces the Box and must restart and health-check the workspace graph, '
                        + 'and none is configured; either run `ploinky start AGENT` and revoke again, or remove the Box '
                        + 'with `ploinky destroy` and run `ploinky gpu revoke` again, which then only clears the saved grant'
                    : `ploinky gpu ${verb} requires a configured workspace graph to restart and health-check; `
                        + 'run `ploinky start AGENT` first',
                'PLOINKY_BOX_GPU_GRAPH_REQUIRED',
            );
        }
        if (verb === 'revoke') assertNoEnabledAgentLosesGpu(identity, gpu?.agents ?? []);
        const priorSkillScopeEnv = validateGraphSkillScope(identity, readGraphSkillScope(identity));
        const engine = ownership.engine;
        const priorRunning = container.runtime?.running === true;
        let priorGraphRunning = false;
        if (priorRunning) {
            const inbox = readInboxStatus(engine, container.id, identity.workspaceRoot);
            if (!inbox) {
                throw supervisorError(
                    'The running Box status could not be read, so its graph state cannot be restored after a '
                    + `failed gpu ${verb}; retry when the Box has finished starting`,
                    'PLOINKY_BOX_GPU_STATUS_UNAVAILABLE',
                );
            }
            priorGraphRunning = inbox.initialized === true && inbox.routingConfigured === true
                && Number.isSafeInteger(inbox.runningAgents) && inbox.runningAgents > 0;
        }
        const imageRef = String(container.labels?.[BOX_LABELS.imageRef] || '');
        // Keep the mounted AgentLib generation; a grant change never advances it.
        const selection = agentLibContractFromContainer(container);
        if (selection.mode !== 'image' || priorRunning) {
            revalidateMountedAgentLibSource(selection, { engine, containerId: container.id, runner });
        }
        const previousGpu = observeContainerGpuWiring(container, { identity });
        stderr?.write?.(
            `[ploinky] Applying GPU grant ${describeGpuGrant(next)}; `
            + 'the Box and workspace graph restart briefly if the GPU wiring changes...\n',
        );
        let prepared;
        try {
            prepared = await reconcileSafely({
                identity,
                ownership,
                engine,
                runner,
                lock,
                repositoryRoot,
                agentLib: selection,
                // An existing Box keeps its publication and ports.
                routerBinding: null,
                gpu,
                // A GPU change keeps the Box's hardware-limits wiring.
                hardware: container ? undefined : savedHardwareWiring(identity, ownership, lock).hardware,
                imageRef,
                imagePolicy: 'preserve',
                platform,
                env,
                stdout,
                stderr,
            });
        } catch (error) {
            await recoverFailedGraphReconcile({
                identity,
                lock,
                ownership,
                error: gpuChangeError(verb, saved, error, previousBoxGpu),
                priorRunning,
                priorGraphRunning,
                priorCoreStartArgv,
                priorSkillScopeEnv,
            });
        }
        const containerId = prepared.ownership.handles.container.id;
        const graphAlreadyRunning = prepared.action === 'reused' && priorGraphRunning;
        let graphMutated = false;
        let recordWriteAttempted = false;
        try {
            if (!graphAlreadyRunning) {
                await prepareGateOnGeneration(identity, engine, containerId, prepared.hardware);
                await ensureBoxDependencies(engine, containerId, runner, { workspaceRoot: identity.workspaceRoot, stdout, stderr });
                const hostReachableIpv4 = await resolveHostReachableIpv4({ platform });
                graphMutated = true;
                await startCore(
                    engine,
                    containerId,
                    priorCoreStartArgv,
                    prepared.hostPort,
                    prepared.mediaHostPort,
                    runner,
                    {
                        workspaceRoot: identity.workspaceRoot,
                        stdout,
                        stderr,
                        hostReachableIpv4,
                        agentLib: selection,
                        skillScopeEnv: priorSkillScopeEnv,
                        routerBinding: prepared.routerBinding,
                    },
                );
            }
            await healthCheck(prepared.hostPort, { routerBinding: prepared.routerBinding });
            revalidateMountedAgentLibSource(selection, { engine, containerId, runner });
            if ((prepared.gpu?.fingerprint ?? null) !== (gpu?.fingerprint ?? null)) {
                throw supervisorError('The Box GPU wiring does not match the requested GPU grant wiring');
            }
            recordWriteAttempted = true;
            saveDecision(admittedGpuWiring(gpu));
            prepared.finalize?.();
        } catch (error) {
            await rollbackPreparedGraph({
                identity,
                prepared,
                ownership,
                containerId,
                error: gpuChangeError(verb, saved, error, previousBoxGpu),
                stopGraph: graphMutated,
                restoreGraph: priorGraphRunning && (graphMutated || prepared.action === 'replaced'),
                restoreCoreArgv: priorCoreStartArgv,
                restoreSkillScopeEnv: priorSkillScopeEnv,
                restoreStopped: !priorRunning,
                afterRollback: recordWriteAttempted
                    ? () => {
                        try {
                            gpuGrantStore.restore(identity, saved, lock);
                        } catch (restoreError) {
                            throw new Error(`saved GPU grant restoration: ${restoreError.message}`);
                        }
                    }
                    : null,
            });
        }
        pruneGpuGenerations(identity, lock, gpu);
        return Object.freeze({
            identity,
            verb,
            action: prepared.action === 'reused'
                ? (graphMutated ? 'graph-started' : 'unchanged')
                : prepared.action,
            grant: next,
            previousGrant: saved,
            gpu: prepared.gpu,
            previousGpu,
            containerId,
            graphStarted: graphMutated,
            access: effectiveGpuAccess(next, declared),
        });
    }

    /**
     * `gpu grant --agent X` adds X to the operator's grants and lifts any deny
     * of X; `gpu grant` alone lifts the workspace deny so manifest defaults
     * apply again (D14). When anything then asks for the GPU, discovery must
     * succeed now; it names any missing or mismatched item.
     */
    async function runGpuGrantTransaction({ vendor, agents = [] } = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            await assertNoUpdateRecoveryBarrier(identity, ownership);
            assertNoPendingHardwareTransition(identity, 'gpu grant');
            selectHardwareGateForOperation(identity, 'gpu-grant', lock);
            const saved = gpuGrantStore.read(identity);
            const requestedVendor = normalizeGpuVendor(vendor ?? saved?.vendor ?? defaultGpuVendor());
            const requested = normalizeGpuAgentSelectors(agents);
            if (saved && saved.vendor !== requestedVendor) {
                throw supervisorError(
                    `This workspace already grants the ${saved.vendor} GPU; run \`ploinky gpu revoke\` first`,
                    'PLOINKY_BOX_GPU_GRANT_INVALID',
                );
            }
            const next = normalizeGpuDecision({
                vendor: requestedVendor,
                agents: [...(saved?.agents || []), ...requested],
                denied: (saved?.denied || []).filter((agent) => !requested.includes(agent)),
                workspaceDenied: requested.length ? saved?.workspaceDenied === true : false,
            });
            const declared = scanGpuAgents(identity.workspaceRoot);
            const gpu = resolveDesiredGpuWiring(identity, next, declared, {
                discover: discoverGpuDevices,
                ...(discoverGpuMpsTools ? { discoverMps: discoverGpuMpsTools } : {}),
                homeDirectory: gpuGrantStore.homeDirectory,
                mpsEnabled: hardwareGateStore.read(identity)?.enabled === true,
                strict: true,
            });
            return applyGpuGrantChange({ identity, lock, ownership, saved, next, gpu, verb: 'grant', declared });
        });
    }

    /**
     * `gpu revoke --agent X` withdraws X's grant and denies X even when its
     * manifest declares the GPU; `gpu revoke` alone withdraws every grant and
     * turns manifest defaults off for the whole workspace (D14). Denies persist
     * in the host-only record until `gpu grant` lifts them.
     */
    async function runGpuRevokeTransaction({ agents = [] } = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            await assertNoUpdateRecoveryBarrier(identity, ownership);
            assertNoPendingHardwareTransition(identity, 'gpu revoke');
            selectHardwareGateForOperation(identity, 'gpu-revoke', lock);
            const saved = gpuGrantStore.read(identity);
            const selectors = normalizeGpuAgentSelectors(agents);
            const next = normalizeGpuDecision(selectors.length ? {
                vendor: saved?.vendor,
                agents: (saved?.agents || []).filter((agent) => !selectors.includes(agent)),
                denied: [...(saved?.denied || []), ...selectors],
                workspaceDenied: saved?.workspaceDenied === true,
            } : {
                vendor: saved?.vendor,
                agents: [],
                denied: saved?.denied || [],
                workspaceDenied: true,
            });
            const declared = scanGpuAgents(identity.workspaceRoot);
            const gpu = resolveDesiredGpuWiring(identity, next, declared, {
                discover: discoverGpuDevices,
                ...(discoverGpuMpsTools ? { discoverMps: discoverGpuMpsTools } : {}),
                homeDirectory: gpuGrantStore.homeDirectory,
                mpsEnabled: hardwareGateStore.read(identity)?.enabled === true,
            });
            // A per-agent revoke must not strip GPU wiring that a lost record
            // left on the Box for other agents. Wiring that the manifests alone
            // explain is not such a leftover.
            const container = ownership.handles?.container || null;
            const current = container ? observeContainerGpuWiring(container, { identity }) : null;
            const manifestOnly = () => {
                try {
                    return resolveDesiredGpuWiring(identity, null, declared, {
                        discover: discoverGpuDevices,
                        ...(discoverGpuMpsTools ? { discoverMps: discoverGpuMpsTools } : {}),
                        homeDirectory: gpuGrantStore.homeDirectory,
                mpsEnabled: hardwareGateStore.read(identity)?.enabled === true,
                    });
                } catch {
                    return null;
                }
            };
            if (!saved && selectors.length && current && !sameGpuWiring(current, gpu)
                && !sameGpuWiring(current, manifestOnly())) {
                throw supervisorError(
                    'No GPU grant is recorded for this workspace, but the Box carries GPU wiring from an earlier '
                    + 'grant; run `ploinky gpu revoke` without --agent to remove it, or '
                    + '`ploinky gpu grant --agent REPO/AGENT` to record the agents that keep it',
                    'PLOINKY_BOX_GPU_GRANT_INVALID',
                );
            }
            return applyGpuGrantChange({ identity, lock, ownership, saved, next, gpu, verb: 'revoke', declared });
        });
    }

    /** Read-only GPU grant status: record, host discovery, and Box wiring. */
    function inspectGpuGrant() {
        const identity = resolveIdentity();
        const ownership = inspect(identity);
        const saved = gpuGrantStore.read(identity);
        const container = ownership.state === 'owned' ? ownership.handles?.container || null : null;
        let boxGpu = null;
        let boxProblem = null;
        if (container) {
            try {
                boxGpu = observeContainerGpuWiring(container, { identity });
            } catch (error) {
                boxProblem = error.message;
            }
        }
        let host;
        try {
            const discovered = discoverGpuDevices(saved?.vendor || defaultGpuVendor());
            host = Object.freeze({
                available: true,
                vendor: discovered.vendor,
                driverVersion: discovered.driverVersion,
                devices: discovered.devices.map((device) => device.path),
                libraries: discovered.libraries.map((library) => library.soname),
            });
        } catch (error) {
            host = Object.freeze({ available: false, reason: error.message });
        }
        const declared = scanGpuAgents(identity.workspaceRoot);
        const access = effectiveGpuAccess(saved, declared);
        const desired = resolveDesiredGpuWiring(identity, saved, declared, {
            discover: discoverGpuDevices,
            ...(discoverGpuMpsTools ? { discoverMps: discoverGpuMpsTools } : {}),
            homeDirectory: gpuGrantStore.homeDirectory,
                mpsEnabled: hardwareGateStore.read(identity)?.enabled === true,
        });
        return Object.freeze({
            identity,
            ownership: ownership.state,
            box: container ? (container.runtime?.running ? 'running' : 'stopped') : 'absent',
            grant: saved,
            access,
            host,
            boxGpu,
            boxProblem,
            desired,
            pendingReplacement: Boolean(container) && !boxProblem && !sameGpuWiring(boxGpu, desired),
        });
    }

    /**
     * Before any outer mutation of `update` (including the host source update
     * and relaunch): parse the gate and run the U9 stored-limits check
     * (§3 Gate parsing, §6.1). This check is lock-free and read-only (one
     * consistent store snapshot), so it never takes the store lock without
     * the host workspace lock first (§5.2 host order). The update transaction
     * repeats the authoritative check under the workspace lock, with the same
     * stale-lock recovery as start and restart, before any Box mutation.
     */
    function preflightHardwareGate(operation = 'update') {
        const identity = resolveIdentity();
        const gate = selectHardwareGate({ identity, gateStore: hardwareGateStore, env, operation });
        if (!gate.enabled) {
            const paths = hardwareStorePaths({ identity, homeDirectory: hardwareGateStore.homeDirectory });
            try {
                peekGateOffStoreEmpty({ paths, identity });
            } catch (error) {
                throw supervisorError(error.message, error.code === 'stored_limits_present'
                    ? 'PLOINKY_BOX_HARDWARE_LIMITS_STORED'
                    : 'PLOINKY_BOX_HARDWARE_STATE_INVALID');
            }
        } else {
            assertHardwareStateConfined({
                workspaceRoot: identity.workspaceRoot,
                dataPaths: identity.dataPaths,
                homeDirectory: hardwareGateStore.homeDirectory,
            });
        }
        return Object.freeze({ enabled: gate.enabled, source: gate.source });
    }

    /** Read-only hardware-limits status; never initializes state or prepares a Box. */
    function inspectLimitsStatus() {
        const identity = resolveIdentity();
        const ownership = inspect(identity);
        const container = ownership?.handles?.container || null;
        return readLimitsStatus({
            identity,
            gateStore: hardwareGateStore,
            env,
            // The host's own read-only engine and exact-Box runtime checks.
            hostFacts: observeHostLimitsFacts({
                engine: ownership?.engine,
                containerId: container?.id || null,
                query: typeof runner?.query === 'function' ? runner.query.bind(runner) : null,
                verifyRuntime: verifyBoxRuntime,
            }),
            observedBox: container
                ? {
                    state: container.runtime?.running ? 'running' : 'stopped',
                    wiring: container.labels?.[BOX_LABELS.hardwareLimits] || null,
                    // A stopped Box has no prepared generation; a running
                    // one's in-Box preparation is not observable from here.
                    prepared: container.runtime?.running ? null : false,
                    preparedReason: container.runtime?.running
                        ? 'in-Box preparation is not observed from the host'
                        : 'the Box is not running',
                }
                : { state: 'absent', wiring: null, prepared: false, preparedReason: 'no Box exists' },
        });
    }

    /** Host recovery: clear one agent's stored limits or every entry. No router needed. */
    async function runLimitsClearTransaction({ agentRef = null, all = false } = {}) {
        return lockedMutation(async (identity, lock) => {
            const result = runLimitsClear({
                identity, lock, agentRef, all, homeDirectory: hardwareGateStore.homeDirectory,
                inspectBox: () => observeBoxState(identity),
            });
            return Object.freeze({ identity, agentRef, all, ...result });
        }, (ownership) => ownership);
    }

    async function runStopTransaction() {
        return lockedMutation(async (identity, lock, ownership) => {
            const container = ownership.handles?.container;
            if (!container) {
                return Object.freeze({ identity, action: 'absent' });
            }
            if (container.runtime.running) {
                let localStopError = null;
                try {
                    stopPloinkyLocalByContainerId(ownership.engine, container.id, runner, {
                        workspaceRoot: identity.workspaceRoot,
                    });
                } catch (error) {
                    localStopError = error;
                } finally {
                    runner.run(ownership.engine.name, [
                        'container', 'stop', '--time', '30', container.id,
                    ]);
                }
                if (localStopError) {
                    throw supervisorError(
                        `Outer Box stopped after ploinky-local stop reported: ${localStopError.message}`,
                    );
                }
            }
            return Object.freeze({ identity, action: 'stopped', containerId: container.id });
        });
    }

    // An explicit destroy settles a pending downgrade only after the owned Box
    // is proven gone (removed here, or already absent): record
    // aborted-by-destroy and remove its barrier. The saved gate and policy
    // follow destroy's contract.
    function closePendingDowngradesAfterDestroy(identity) {
        try {
            abortHardwareDowngradesForDestroy({ identity, homeDirectory: hardwareGateStore.homeDirectory });
        } catch (error) {
            stderr?.write?.(`[ploinky] A pending hardware transition could not be closed (${error.message}); its journal was kept for recovery.\n`);
        }
    }

    async function runDestroyTransaction(expectedContainerId, { deleteCache = false } = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            const container = ownership.handles?.container;
            if (!container && expectedContainerId) {
                throw supervisorError('Box changed before destroy; nothing was removed');
            }
            if (!container && !deleteCache) {
                retireDestroyedMarkers({ identity, lock });
                closePendingDowngradesAfterDestroy(identity);
                return Object.freeze({ identity, action: 'absent' });
            }
            if (container && (!expectedContainerId || container.id !== expectedContainerId)) {
                throw supervisorError('Box changed before destroy; nothing was removed');
            }
            if (container) {
                // Quiesce nested agents before the outer Box disappears. If the
                // inner stop fails we still stop the outer Box to halt further
                // mutation, then fail without removing anything, leaving a
                // stopped Box and its cache data intact for inspection and retry.
                if (container.runtime.running) {
                    let innerStopError = null;
                    try {
                        stopPloinkyLocalByContainerId(ownership.engine, container.id, runner, {
                            workspaceRoot: identity.workspaceRoot,
                        });
                    } catch (error) {
                        innerStopError = error;
                    } finally {
                        runner.run(ownership.engine.name, [
                            'container', 'stop', '--time', '30', container.id,
                        ]);
                    }
                    if (innerStopError) {
                        throw supervisorError(
                            'Outer Box stopped after ploinky-local stop reported: '
                            + `${innerStopError.message}; nothing was removed`,
                        );
                    }
                    // Revalidate exact ownership rather than the broad mutable
                    // state: destroy is the recovery path, so it must not be
                    // blocked by an incidentally incompatible resource set.
                    const revalidated = inspect(identity);
                    if (revalidated.handles?.container?.id !== container.id
                        || revalidated.engine?.identity !== ownership.engine.identity) {
                        throw supervisorError(
                            'Box changed while stopping; nothing was removed',
                        );
                    }
                }
                removeContainerById(ownership.engine, container.id, runner);
            }
            retireDestroyedMarkers({ identity, lock });
            closePendingDowngradesAfterDestroy(identity);
            // Cache deletion is explicit and runs only after the outer Box is
            // proven gone, so a failed stop or removal always retains the data.
            const deletedPaths = deleteCache
                ? destroyBoxCache({ identity, lock })
                : Object.freeze([]);
            // Workspace-owned managed AgentLib state may go with the cache, but
            // only once the Box is proven absent. A user-owned local checkout is
            // never touched: it is outside `.ploinky` entirely.
            const deletedAgentLibPaths = deleteCache && !container
                ? destroyManagedAgentLib(identity.workspaceRoot)
                : Object.freeze([]);
            return Object.freeze({
                identity,
                action: container ? 'destroyed' : 'deleted-cache',
                containerId: container?.id || null,
                deletedCache: deleteCache,
                deletedPaths,
                deletedAgentLibPaths,
            });
        });
    }

    function inspectBoxStatus() {
        const identity = resolveIdentity();
        const ownership = inspect(identity);
        if (ownership.state !== 'owned') {
            return Object.freeze({ identity, ownership, state: ownership.state });
        }
        const container = ownership.handles?.container;
        if (!container) {
            return Object.freeze({ identity, ownership, state: 'absent' });
        }
        try {
            const imageRef = container.labels?.[BOX_LABELS.imageRef];
            const image = validateExistingImage(
                ownership.engine.name,
                container.runtime?.imageId,
                imageRef,
                runner,
            );
            const dataState = validateContainer === validateContainerConfiguration
                ? inspectBoxData({ identity })
                : null;
            validateContainer(container, {
                identity,
                dataFingerprints: dataState?.fingerprints,
                agentLib: agentLibContractFromContainer(container),
                hostPort: Number(container.labels?.[BOX_LABELS.routerHostPort]),
                mediaHostPort: Number(container.labels?.[BOX_LABELS.mediaHostPort]),
                imageId: image.immutableId,
                imageRef,
                repositoryRoot,
                hostKind: ownership.engine.hostKind,
            });
        } catch (error) {
            return Object.freeze({
                identity,
                ownership,
                state: error?.code === IMAGE_OBSERVATION_UNAVAILABLE ? 'unknown' : 'incompatible',
                detail: String(error.message || 'Owned Box image is incompatible'),
            });
        }
        let routerBinding = null;
        try {
            routerBinding = Object.freeze({
                ...observeContainerRouterBinding(container),
                hostPort: parseHostPort(container.labels?.[BOX_LABELS.routerHostPort]),
            });
        } catch {
            routerBinding = null;
        }
        if (!container.runtime.running) {
            return Object.freeze({ identity, ownership, state: 'stopped', routerBinding });
        }
        const inbox = runner.query(ownership.engine.name, [
            'container', 'exec',
            '--user', 'podman',
            ...boxWorkspaceExecOptions(identity.workspaceRoot),
            container.id,
            '/usr/local/bin/node',
            '/opt/ploinky/ploinky-box/inbox/readStatus.mjs',
        ]);
        if (!inbox.ok) {
            return Object.freeze({
                identity,
                ownership,
                state: 'running-transient',
                inbox: null,
                routerBinding,
            });
        }
        try {
            const parsed = JSON.parse(String(inbox.stdout || '').trim());
            const allowlisted = Object.freeze({
                state: String(parsed.state || 'unknown'),
                initialized: parsed.initialized === true,
                routingConfigured: parsed.routingConfigured === true,
                trackedAgents: Number(parsed.trackedAgents) || 0,
                runningAgents: Number(parsed.runningAgents) || 0,
                cloudflarePublication: serializeCloudflarePublicationStatus(
                    parsed.cloudflarePublication,
                ),
                warnings: Object.freeze(Array.isArray(parsed.warnings)
                    ? parsed.warnings.map(String)
                    : []),
            });
            return Object.freeze({
                identity,
                ownership,
                state: allowlisted.initialized ? 'running-initialized' : 'running-uninitialized',
                inbox: allowlisted,
                routerBinding,
            });
        } catch {
            return Object.freeze({
                identity,
                ownership,
                state: 'running-transient',
                inbox: null,
                routerBinding,
            });
        }
    }

    function planDryRun(options = {}) {
        const { identity, ownership } = inspectBoxStatus();
        return Object.freeze({
            identity: identity.instance,
            ownership: ownership.state,
            desiredImage: options.imageRef || resolveBoxImageReference(env),
            desiredHostPort: options.explicitPort || null,
            desiredMediaHostPort: options.explicitMediaPort || null,
            mutationPerformed: false,
        });
    }

    /**
     * Read-only bind plan. It validates exactly what apply would reject before
     * mutation, without locks, anchors, probes, or engine changes.
     */
    function planBindDryRun(mapping = null) {
        const identity = resolveIdentity();
        const ownership = assertMutableOwnership(inspect(identity));
        const container = ownership.handles?.container || null;
        const graphArgv = captureCoreStartArgv(identity);
        if (!graphArgv) {
            throw supervisorError(
                'ploinky bind requires a configured workspace graph to expose; run `ploinky start AGENT` first',
                'PLOINKY_BOX_BIND_GRAPH_REQUIRED',
            );
        }
        const current = container ? currentRouterPublication(container) : null;
        const savedBinding = routerBindingStore.read(identity);
        const routerBinding = hostRouterBinding(mapping ?? {
            address: ROUTER_BIND_WILDCARD,
            hostPort: current?.hostPort ?? savedBinding?.hostPort ?? BOX_ROUTER_CONTAINER_PORT,
        });
        const mappingText = (binding) => (
            binding ? `${binding.address}:${binding.hostPort}:${BOX_ROUTER_CONTAINER_PORT}` : null
        );
        const unchangedPublication = Boolean(current) && sameRouterBinding(current, routerBinding);
        const mediaHostPort = current?.mediaHostPort ?? BOX_MEDIA_PORT;
        return Object.freeze({
            command: 'bind',
            identity: identity.instance,
            ownership: ownership.state,
            box: container ? (container.runtime?.running ? 'running' : 'stopped') : 'absent',
            graph: graphArgv.slice(1, 2)[0],
            currentMapping: mappingText(current),
            savedMapping: mappingText(savedBinding),
            requestedMapping: mappingText(routerBinding),
            publications: Object.freeze([
                `${routerBinding.address}:${routerBinding.hostPort}:${BOX_ROUTER_CONTAINER_PORT}/tcp`,
                `0.0.0.0:${mediaHostPort}:${BOX_MEDIA_PORT}/udp`,
            ]),
            trustedHosts: routerBinding.hosts || [],
            browserUrls: routerBindingBrowserUrls(routerBinding),
            boxAction: !container ? 'create' : (unchangedPublication ? 'reuse' : 'replace'),
            image: container
                ? `preserve ${container.runtime?.imageId || 'the current image'}`
                : `use local ${resolveBoxImageReference(env)} without pulling`,
            mutationPerformed: false,
        });
    }

    /**
     * Read-only view of host update state for this workspace: a pending
     * activation and a recovery barrier. It never probes, locks, or clears.
     */
    function inspectUpdateState(identity = resolveIdentity()) {
        const read = (kind) => {
            try {
                return { record: updateHostState.read(kind, identity.instance), error: null };
            } catch (error) {
                return { record: null, error: error.message };
            }
        };
        const pending = read('update-pending');
        const recovery = read('update-recovery');
        return Object.freeze({
            pendingActivation: pending.record,
            recoveryBarrier: recovery.record,
            errors: Object.freeze([pending.error, recovery.error].filter(Boolean)),
        });
    }

    /**
     * Read-only preflight for a full update, before the host self-update pulls
     * this command's checkout: an owned Box that runs Ploinky from another
     * checkout refuses here, so a command that will be refused changes no
     * source. Anything short of that positive evidence is left to the locked
     * reconciliation, which remains the authoritative check.
     */
    function assertUpdateSourceMatchesBox(identity = resolveIdentity()) {
        let ownership;
        try {
            ownership = inspect(identity);
        } catch (_) {
            return;
        }
        if (ownership?.state !== 'owned') return;
        assertBoxPloinkySource(ownership.handles?.container?.runtime, repositoryRoot);
    }

    return Object.freeze({
        resolveWorkspaceIdentity: () => resolveIdentity(),
        inspectUpdateState,
        assertUpdateSourceMatchesBox,
        prepareBoxForCommand,
        runStartTransaction,
        runRestartTransaction,
        runTargetedRestartTransaction,
        runUpdateTransaction,
        runBindTransaction,
        runGpuGrantTransaction,
        runGpuRevokeTransaction,
        inspectGpuGrant,
        inspectLimitsStatus,
        preflightHardwareGate,
        runLimitsClearTransaction,
        runStopTransaction,
        runDestroyTransaction,
        inspectBoxStatus,
        planDryRun,
        planBindDryRun,
    });
}

function shortFingerprint(wiring) {
    return wiring?.fingerprint ? wiring.fingerprint.slice(0, 12) : '';
}

function describeWiring(wiring) {
    if (!wiring) return 'none';
    if (wiring.state === 'stale') {
        return `stale ${shortFingerprint(wiring)}${wiring.reason ? ` (${wiring.reason})` : ''}`;
    }
    if (wiring.state === 'revoked') return `revoked ${shortFingerprint(wiring)} (marker only)`;
    return `active ${shortFingerprint(wiring)}`;
}

/** The operator record: grants, per-agent denies and the workspace deny (D14). */
function describeGpuDecision(decision) {
    if (!decision) return 'none';
    const parts = [];
    if (decision.agents?.length) parts.push(`${decision.vendor} for ${decision.agents.join(', ')}`);
    if (decision.denied?.length) parts.push(`denied ${decision.denied.join(', ')}`);
    if (decision.workspaceDenied) parts.push('manifest defaults revoked for this workspace');
    return parts.join('; ') || 'none';
}

function describeGpuAccess(access) {
    if (!access?.agents?.length) return 'none';
    return access.sources.map((entry) => `${entry.agent} (${entry.sources.join(' + ')})`).join(', ');
}

export function formatGpuGrantResult(result) {
    const lines = [`GPU grant for ${result.identity.instance}: ${describeGpuDecision(result.grant)}`];
    if (result.access) lines.push(`GPU agents: ${describeGpuAccess(result.access)}`);
    if (result.action === 'saved') {
        lines.push('No Box exists yet; the next `ploinky start` applies it.');
    } else {
        lines.push(`Box ${result.action}; GPU wiring ${describeWiring(result.gpu)}`);
    }
    return `${lines.join('\n')}\n`;
}

export function formatGpuGrantStatus(status) {
    const lines = [
        `Workspace identity: ${status.identity.instance}`,
        `GPU grant: ${describeGpuDecision(status.grant)}`,
        ...(status.access ? [`GPU agents: ${describeGpuAccess(status.access)}`] : []),
        ...(status.access?.declared?.length
            ? [`Manifest GPU declarations: ${status.access.declared.join(', ')}`]
            : []),
        status.host.available
            ? `Host GPU: ${status.host.vendor} driver ${status.host.driverVersion}; devices ${status.host.devices.join(', ')}; `
                + `libraries ${status.host.libraries.join(', ')}`
            : `Host GPU: unavailable (${status.host.reason})`,
        `Box: ${status.box}${status.boxProblem
            ? `; GPU wiring is invalid (${status.boxProblem})`
            : status.box === 'absent' ? '' : `; GPU wiring ${describeWiring(status.boxGpu)}`}`,
    ];
    if (status.grant || status.desired || status.boxGpu) lines.push(`Desired GPU wiring: ${describeWiring(status.desired)}`);
    if (status.pendingReplacement) {
        lines.push('The next `ploinky start` or `ploinky restart` replaces the Box to apply the desired GPU wiring.');
    }
    return `${lines.join('\n')}\n`;
}

export async function ensureBoxDependencies(engine, containerId, runner, {
    workspaceRoot,
    stdout = process.stdout,
    stderr = process.stderr,
    timeoutMs = 1_800_000,
} = {}) {
    const args = [
        'container', 'exec',
        '--user', 'podman',
        ...boxWorkspaceExecOptions(workspaceRoot),
        containerId,
        '/opt/ploinky/bin/ploinky-install-deps',
    ];
    stderr?.write?.('[ploinky] Verifying and installing Box dependencies...\n');
    if (typeof runner.stream !== 'function') {
        runner.run(engine.name, args);
        return;
    }
    const result = await runner.stream(engine.name, args, { timeoutMs, stdout, stderr });
    if (!result.ok) {
        throw supervisorError(`Box dependency installation failed with status ${result.status}`);
    }
}

/**
 * Human-readable effective binding and connectable URLs. The wildcard is shown
 * as the listen address but never offered as a browser destination.
 */
export function formatRouterBindingLines(binding) {
    if (!binding?.address) return [];
    let description;
    let urls;
    try {
        description = describeRouterBinding(binding);
        urls = routerBindingBrowserUrls(binding);
    } catch {
        return [];
    }
    const lines = [`Router binding: ${description}`];
    for (const url of urls) lines.push(`Open ${url}`);
    if (Array.isArray(binding.hosts) && binding.hosts.length > 0) {
        lines.push(`Trusted Router host names: ${binding.hosts.join(', ')}`);
    }
    if (isWildcardRouterBinding(binding) && !(binding.hosts || []).some((host) => isUsableHostIpv4(host))) {
        lines.push('Warning: no non-loopback IPv4 address was detected on this host');
    }
    return lines;
}

export function formatBindResult(result) {
    const actions = {
        replaced: 'The Box was recreated with the new Router publication and the workspace graph was restarted.',
        created: 'The Box was created with the Router publication and the workspace graph was started.',
        'graph-started': 'The Router publication was already in place; the stopped workspace graph was started.',
        unchanged: 'The Router binding was already effective; nothing was restarted.',
    };
    const lines = [actions[result?.action] || `Bind completed (${String(result?.action || 'unknown')}).`];
    lines.push(...formatRouterBindingLines(result?.routerBinding));
    if (result?.mediaHostPort) {
        const media = `Media publication: 0.0.0.0:${result.mediaHostPort} -> ${BOX_MEDIA_PORT}/udp`;
        lines.push(result.action === 'created' ? media : `${media} (unchanged)`);
    }
    lines.push(isLoopbackRouterBinding(result?.routerBinding)
        ? 'Router access is local-only (loopback).'
        : 'Router traffic is plain HTTP, and the bind address is not a client access rule.');
    return `${lines.join('\n')}\n`;
}

export function formatUpdateStateLines(state) {
    const lines = [];
    const pending = state?.pendingActivation;
    if (pending) {
        const entries = Array.isArray(pending.entries) ? pending.entries : [];
        const blocked = entries.flatMap(entry => entry?.blockedBy || [])
            .map(entry => `${entry.phase} ${entry.id} (${entry.code || entry.outcome})`);
        lines.push(`Pending activation: ${pending.reason || 'updated sources may require activation'} `
            + `(${entries.length} update${entries.length === 1 ? '' : 's'} recorded; last at `
            + `${entries.at(-1)?.recordedAt || 'unknown time'}). Run \`ploinky restart\` to activate them.`);
        if (blocked.length) lines.push(`Pending activation was blocked by: ${[...new Set(blocked)].join('; ')}.`);
    }
    const barrier = state?.recoveryBarrier;
    if (barrier) {
        lines.push(`Update recovery required: an earlier ${barrier.operation || 'update'} may still be running in the Box `
            + `(${barrier.cause || 'unknown cause'}${barrier.detail ? `: ${barrier.detail}` : ''}). `
            + 'New updates, starts, restarts and binds are blocked until the engine confirms it stopped; '
            + 'after `ploinky stop` the next such command confirms and clears it.');
    }
    for (const error of state?.errors || []) lines.push(`Update state could not be read: ${error}`);
    return lines;
}

export function formatBoxStatus(status) {
    const lines = [
        `Ploinky Box: ${status.state}`,
        `Workspace identity: ${status.identity.instance}`,
    ];
    lines.push(...formatRouterBindingLines(status.routerBinding));
    if (status.inbox) {
        lines.push(`Core initialized: ${status.inbox.initialized ? 'yes' : 'no'}`);
        lines.push(`Routing configured: ${status.inbox.routingConfigured ? 'yes' : 'no'}`);
        lines.push(`Tracked agents: ${status.inbox.trackedAgents}`);
        lines.push(`Running agents: ${status.inbox.runningAgents}`);
        lines.push(`Cloudflare mode: ${status.inbox.cloudflarePublication.mode}`);
        lines.push(`Cloudflare management: ${status.inbox.cloudflarePublication.management || 'none'}`);
        lines.push(`Cloudflare publication: ${status.inbox.cloudflarePublication.state}`);
        lines.push(`Cloudflare connector: ${status.inbox.cloudflarePublication.connectorState}`);
        lines.push(`Cloudflare hosts: ${status.inbox.cloudflarePublication.hostnames.length}`);
        for (const warning of status.inbox.warnings) lines.push(`Warning: ${warning}`);
    } else if (status.detail || status.ownership?.message) {
        lines.push(`Detail: ${status.detail || status.ownership.message}`);
    }
    return `${lines.join('\n')}\n`;
}

function boundedCoreEnvironment(
    hostPort,
    mediaHostPort,
    agentLib,
    hostReachableIpv4 = '',
    updateExcludedRepoPath = '',
    skillScopeEnv = {},
) {
    if (!agentLib) {
        throw supervisorError('Bounded core command requires the selected achillesAgentLib contract');
    }
    const agentLibEnvironment = agentLibBoxEnv(normalizeBoxAgentLib(agentLib));
    return [
        'container', 'exec',
        ...Object.entries(skillScopeEnv).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
        '--env', `PLOINKY_ROUTER_HOST_PORT=${hostPort}`,
        '--env', `PLOINKY_MEDIA_HOST_PORT=${mediaHostPort}`,
        ...(hostReachableIpv4
            ? ['--env', `${HOST_REACHABLE_IPV4_ENV}=${hostReachableIpv4}`]
            : []),
        ...(updateExcludedRepoPath
            ? ['--env', `${PLOINKY_UPDATED_WORKSPACE_CHECKOUT_ENV}=${updateExcludedRepoPath}`]
            : []),
        ...Object.entries(agentLibEnvironment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    ];
}

export async function runBoundedCoreCommand(
    engine,
    containerId,
    coreArgv,
    hostPort,
    mediaHostPort,
    runner,
    {
        workspaceRoot,
        stdout = process.stdout,
        stderr = process.stderr,
        timeoutMs = 1_800_000,
        hostReachableIpv4 = '',
        agentLib = null,
        updateExcludedRepoPath = '',
        skillScopeEnv = {},
    } = {},
) {
    const normalizedHostReachableIpv4 = String(hostReachableIpv4 || '').trim();
    if (normalizedHostReachableIpv4 && !isUsableHostIpv4(normalizedHostReachableIpv4)) {
        throw supervisorError(
            `${HOST_REACHABLE_IPV4_ENV} must be a usable canonical literal IPv4 address`,
            'PLOINKY_BOX_HOST_REACHABLE_IPV4_INVALID',
        );
    }
    const result = await runner.stream(engine.name, [
        ...boundedCoreEnvironment(
            hostPort,
            mediaHostPort,
            agentLib,
            normalizedHostReachableIpv4,
            updateExcludedRepoPath,
            skillScopeEnv,
        ),
        '--user', 'podman',
        ...boxWorkspaceExecOptions(workspaceRoot),
        containerId,
        '/opt/ploinky/bin/ploinky-local',
        ...coreArgv,
    ], { timeoutMs, stdout, stderr });
    if (!result.ok) {
        throw supervisorError(`In-box ${coreArgv[0] || 'command'} failed with status ${result.status}`);
    }
    return result;
}

/**
 * Ask the engine whether processes of one update operation still run in the
 * Box. A stopped or removed Box cannot run them; anything the engine cannot
 * answer is reported as not proven. An in-Box update leaves nothing running,
 * so every process that carries its nonce is a writer. A graph restart leaves
 * the graph running with its marker, so only the restart's own process group
 * counts (see selectOperationWriters).
 */
export function probeInBoxUpdateProcesses(engine, containerId, runner, nonce, { marker = null } = {}) {
    const inspected = runner.query(engine.name, ['container', 'inspect', '--format', '{{.State.Running}}', containerId]);
    if (!inspected?.ok) {
        return /no such (container|object)/i.test(String(inspected?.stderr || ''))
            ? { ok: true, pids: [], detail: 'the Box container no longer exists' }
            : { ok: false, detail: `Box inspection failed: ${String(inspected?.stderr || inspected?.status || '').trim()}` };
    }
    if (String(inspected.stdout || '').trim() === 'false') return { ok: true, pids: [], detail: 'the Box is stopped' };
    const listed = runner.query(engine.name, [
        'container', 'exec', '--user', 'podman', containerId,
        '/usr/local/bin/node', '-e',
        String(marker || '').startsWith(`${UPDATE_OPERATION_ENV}=`) ? IN_BOX_OPERATION_WRITERS_PROBE_SCRIPT : IN_BOX_NONCE_PROBE_SCRIPT,
        marker || `${UPDATE_REPORT_NONCE_ENV}=${nonce}`,
    ]);
    if (!listed?.ok) return { ok: false, detail: `in-Box process listing failed: ${String(listed?.stderr || '').trim()}` };
    try {
        const pids = JSON.parse(String(listed.stdout || '').trim());
        return Array.isArray(pids) ? { ok: true, pids } : { ok: false, detail: 'in-Box process listing was malformed' };
    } catch {
        return { ok: false, detail: 'in-Box process listing was malformed' };
    }
}

/**
 * Update-specific bounded core command. It carries the report nonce and the
 * expected context, never throws on a nonzero exit (the report is judged
 * separately), and proves in-Box quiescence after any abnormal end.
 */
export async function runBoundedUpdateCommand(
    engine,
    containerId,
    coreArgv,
    hostPort,
    mediaHostPort,
    runner,
    {
        workspaceRoot,
        stdout = process.stdout,
        stderr = process.stderr,
        hostReachableIpv4 = '',
        agentLib = null,
        updateExcludedRepoPath = '',
        skillScopeEnv = {},
        reportNonce,
        reportContext,
        env = buildEngineProcessEnvironment(),
        runnerOptions = {},
    } = {},
) {
    if (!/^[0-9a-f]{32}$/.test(String(reportNonce || '')) || !reportContext) {
        throw supervisorError('The update runner requires a report nonce and context', 'PLOINKY_BOX_UPDATE_REPORT_INVALID');
    }
    const args = [
        ...boundedCoreEnvironment(
            hostPort,
            mediaHostPort,
            agentLib,
            String(hostReachableIpv4 || '').trim(),
            updateExcludedRepoPath,
            skillScopeEnv,
        ),
        '--env', `${UPDATE_REPORT_NONCE_ENV}=${reportNonce}`,
        '--env', `${UPDATE_REPORT_CONTEXT_ENV}=${JSON.stringify(reportContext)}`,
        '--user', 'podman',
        ...boxWorkspaceExecOptions(workspaceRoot),
        containerId,
        '/opt/ploinky/bin/ploinky-local',
        ...coreArgv,
    ];
    return runUpdateExec({
        command: engine.name,
        args,
        env,
        nonce: reportNonce,
        probeOnSuccess: true,
        stdout,
        stderr,
        probe: ({ nonce }) => probeInBoxUpdateProcesses(engine, containerId, runner, nonce),
        killInBox: (pids, signal) => runner.query(engine.name, [
            'container', 'exec', '--user', 'podman', containerId, 'kill', `-${signal}`, ...pids.map(String),
        ]),
        ...runnerOptions,
    });
}

// Marks the in-Box graph restart run by an update so the engine can prove
// whether its writers still run after the client ended abnormally. The graph
// it started inherits the marker too and is left running.
export const UPDATE_OPERATION_ENV = 'PLOINKY_UPDATE_OPERATION';

/**
 * The `restart` subprocess of an update, under the same bounded discipline as
 * the in-Box update. Unlike the generic runner it returns every end, including
 * a nonzero status, with its cause, bounded tails and quiescence proof.
 */
export async function runBoundedRestartCommand(
    engine,
    containerId,
    coreArgv,
    hostPort,
    mediaHostPort,
    runner,
    {
        workspaceRoot,
        stdout = process.stdout,
        stderr = process.stderr,
        hostReachableIpv4 = '',
        agentLib = null,
        skillScopeEnv = {},
        operationId,
        env = buildEngineProcessEnvironment(),
        runnerOptions = {},
    } = {},
) {
    if (!/^[0-9a-f]{32}$/.test(String(operationId || ''))) {
        throw supervisorError('The update restart runner requires an operation id', 'PLOINKY_BOX_UPDATE_REPORT_INVALID');
    }
    const normalizedHostReachableIpv4 = String(hostReachableIpv4 || '').trim();
    if (normalizedHostReachableIpv4 && !isUsableHostIpv4(normalizedHostReachableIpv4)) {
        throw supervisorError(
            `${HOST_REACHABLE_IPV4_ENV} must be a usable canonical literal IPv4 address`,
            'PLOINKY_BOX_HOST_REACHABLE_IPV4_INVALID',
        );
    }
    const marker = `${UPDATE_OPERATION_ENV}=${operationId}`;
    const args = [
        ...boundedCoreEnvironment(hostPort, mediaHostPort, agentLib, normalizedHostReachableIpv4, '', skillScopeEnv),
        '--env', marker,
        '--user', 'podman',
        ...boxWorkspaceExecOptions(workspaceRoot),
        containerId,
        '/opt/ploinky/bin/ploinky-local',
        ...coreArgv,
    ];
    return runUpdateExec({
        command: engine.name,
        args,
        env,
        nonce: operationId,
        stdout,
        stderr,
        probe: () => probeInBoxUpdateProcesses(engine, containerId, runner, operationId, { marker }),
        killInBox: (pids, signal) => runner.query(engine.name, [
            'container', 'exec', '--user', 'podman', containerId, 'kill', `-${signal}`, ...pids.map(String),
        ]),
        ...runnerOptions,
    });
}

export async function runBoundedCoreStart(
    engine,
    containerId,
    coreArgv,
    hostPort,
    mediaHostPort,
    runner,
    {
        workspaceRoot,
        stdout = process.stdout,
        stderr = process.stderr,
        timeoutMs = 1_800_000,
        hostReachableIpv4 = '',
        agentLib = null,
        skillScopeEnv = {},
        routerBinding = null,
    } = {},
) {
    if (!Array.isArray(coreArgv) || !coreArgv.includes('start')) {
        throw supervisorError('Bounded core start requires normalized start argv');
    }
    const result = await runBoundedCoreCommand(
        engine,
        containerId,
        coreArgv,
        hostPort,
        mediaHostPort,
        runner,
        { workspaceRoot, stdout, stderr, timeoutMs, hostReachableIpv4, agentLib, skillScopeEnv },
    );
    // Core reports the Box public authority: loopback for loopback and
    // wildcard bindings, or the selected address for a specific binding.
    const authority = routerBinding?.address
        ? routerBindingPublicAuthority({ address: routerBinding.address, hostPort: Number(hostPort) })
        : `127.0.0.1:${hostPort}`;
    const externalRouter = `http://${authority}`;
    const outputLines = String(result.stdout || '').split(/\r?\n/);
    if (!outputLines.includes(`[start] Router: ${externalRouter}`)) {
        throw supervisorError(`In-box start did not report the public Router URL ${externalRouter}`);
    }
    if (Number(hostPort) !== 8080
        && outputLines.includes('[start] Router: http://127.0.0.1:8080')) {
        throw supervisorError('In-box start advertised its internal-only Router URL');
    }
    return result.status;
}

export function checkBoxHealth(hostPort, {
    routerBinding = null,
    httpGet,
    timeoutMs = 5_000,
    readinessTimeoutMs = 1_800_000,
    retryDelayMs = 1_000,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
    const deadline = Date.now() + readinessTimeoutMs;
    // A specific binding may not listen on loopback, so health connects through
    // the published address and presents its exact authority.
    const targets = routerBinding?.address
        ? routerBindingProbeTargets({
            address: routerBinding.address,
            hostPort: Number(hostPort),
            hosts: routerBinding.hosts ?? null,
        })
        : [{ hostname: '127.0.0.1', authority: `127.0.0.1:${hostPort}` }];

    async function checkUntilReady(target) {
        const result = await checkOnce(target);
        if (result.ready) return true;
        if (!result.retryable) {
            throw supervisorError(result.message);
        }
        if (Date.now() >= deadline) {
            throw supervisorError(
                `Public Box health did not become ready within ${readinessTimeoutMs}ms: ${result.message}`,
            );
        }
        await delay(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())));
        return checkUntilReady(target);
    }

    function checkOnce(target) {
        return new Promise((resolve, reject) => {
            const selectedGet = httpGet || http.get;
            try {
                const request = selectedGet({
                    hostname: target.hostname,
                    port: Number(hostPort),
                    path: '/health',
                    headers: { Host: target.authority },
                }, (response) => {
                    let body = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => { body += chunk; });
                response.on('end', () => {
                    if (response.statusCode === 302 && body === 'Authentication required') {
                        try {
                            const location = new URL(
                                String(response.headers?.location || ''),
                                `http://${target.authority}`,
                            );
                            if (location.pathname === '/auth/login'
                                && location.searchParams.get('returnTo') === '/health') {
                                resolve({ ready: true });
                                return;
                            }
                        } catch (_) {}
                    }
                    try {
                        const health = JSON.parse(body);
                            if (response.statusCode === 200 && health.status === 'healthy') {
                                resolve({ ready: true });
                                return;
                            }
                            // The active Router protects /health even when workspace auth is disabled.
                            if (response.statusCode === 401 && health.ok === false
                                && health.error?.code === 'AUTH_REQUIRED'
                                && Object.keys(health).length === 2
                                && Object.keys(health.error).length === 1) {
                                resolve({ ready: true });
                                return;
                            }
                            const transitionCode = String(health.error || '');
                            if (response.statusCode === 503
                                && [
                                    'EDGE_GENERATION_INACTIVE',
                                    'EDGE_GENERATION_RUNTIME_MISMATCH',
                                    'edge_generation_changed',
                                ].includes(transitionCode)) {
                                resolve({
                                    ready: false,
                                    retryable: true,
                                    message: `edge generation is not ready (${transitionCode})`,
                                });
                                return;
                            }
                            resolve({
                                ready: false,
                                retryable: false,
                                message: `Public Box health check was unhealthy (HTTP ${response.statusCode})`
                                    + (target.authority === `127.0.0.1:${hostPort}` ? '' : ` through ${target.authority}`),
                            });
                        } catch (error) {
                            resolve({
                                ready: false,
                                retryable: false,
                                message: 'Public Box health response was malformed',
                            });
                        }
                    });
                });
                request.setTimeout(timeoutMs, () => request.destroy(new Error('health timeout')));
                request.on('error', (error) => resolve({
                    ready: false,
                    retryable: ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.code)
                        || error?.message === 'health timeout',
                    message: `Public Box health check failed: ${error.message}`,
                }));
            } catch (error) {
                reject(supervisorError(`Public Box health check failed: ${error.message}`));
            }
            });
    }

    return (async () => {
        for (const target of targets) await checkUntilReady(target);
        return true;
    })();
}

export const defaultBoxSupervisor = createBoxSupervisor;
