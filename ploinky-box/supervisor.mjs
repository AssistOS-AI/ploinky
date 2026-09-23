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
import { AGENTLIB_ERROR_CODES, agentLibError } from '../agentlib/contract.mjs';
import { PLOINKY_UPDATED_WORKSPACE_CHECKOUT_ENV } from '../cli/commands/ploinkyUpdateScope.js';
import {
    fingerprintSource,
    sourceIdEquals,
    sourceIdHash,
} from '../agentlib/fingerprint.mjs';
import { canonicalWorkspaceRoot, localCandidateExists, localCandidatePath, managedRootPath, writeActiveDescriptor } from '../agentlib/source.mjs';
import fsPromisesFree from 'node:fs';
import {
    agentLibBoxEnv,
    agentLibContractFromContainer,
    normalizeBoxAgentLib,
} from './contract/agentlib.mjs';
import {
    observeContainerRouterBinding,
    validateContainerConfiguration,
    validateContainerPublications,
} from './contract/container.mjs';
import { IMAGE_OBSERVATION_UNAVAILABLE, inspectAndValidateExistingImage } from './contract/image.mjs';
import { assertBoxWorkspaceRoot, boxWorkspaceExecOptions } from './contract/workspace-root.mjs';
import { discoverBoxOwnership } from './engine/discovery.mjs';
import {
    readWorkspaceEdgeDesired,
    stageWorkspaceEdgeDesired,
} from './edgeDesired.mjs';
import { PloinkyBoxError } from './errors.mjs';
import { agentLibPinPolicy } from './agentlib-pin.mjs';
import { loadBoxAgentLibImage, revalidateContainerAgentLib } from './image-agentlib.mjs';
import {
    HOST_REACHABLE_IPV4_ENV,
    detectHostReachableIpv4,
    isUsableHostIpv4,
} from './hostNetwork.mjs';
import { resolveWorkspaceIdentity } from './identity.mjs';
import { retireDestroyedBoxNoWaitMarkers } from './noWaitCleanup.mjs';
import { createMutationLockManager, withWorkspaceMutationLock } from './locks.mjs';
import { parseHostPort } from './ports.mjs';
import { buildEngineProcessEnvironment, createProcessRunner } from './process.mjs';
import { updateWorkspacePloinkySource } from './command/hostUpdate.mjs';
import {
    removeContainerById,
    stopPloinkyLocalByContainerId,
} from './lifecycle/container.mjs';
import { reconcileBoxContainer } from './lifecycle/transactions.mjs';
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
    resolveHostReachableIpv4 = detectHostReachableIpv4,
    readEdgeDesired = readWorkspaceEdgeDesired,
    stageEdgeDesired = stageWorkspaceEdgeDesired,
    healthCheck = checkBoxHealth,
    selectAgentLib = selectWorkspaceAgentLibSource,
    loadAgentLibImage = loadBoxAgentLibImage,
    updateAgentLib = updateWorkspaceAgentLibSource,
    updateWorkspacePloinky = updateWorkspacePloinkySource,
    commitAgentLibSelection = writeActiveDescriptor,
    revalidateAgentLibSource = defaultRevalidateAgentLibSource,
    retireDestroyedMarkers = retireDestroyedBoxNoWaitMarkers,
    destroyBoxCache = removeWorkspaceDataPaths,
    destroyManagedAgentLib = removeManagedAgentLibState,
    inspectBoxData = inspectWorkspaceDataPaths,
    captureCoreStartArgv = captureConfiguredCoreStartArgv,
    routerBindingStore = createRouterBindingStore(),
    readNetworkInterfaces = () => os.networkInterfaces(),
    readHostname = () => os.hostname(),
    stdout = process.stdout,
    stderr = process.stderr,
} = {}) {
    function inspect(identity) {
        return discover(identity, runner, platform, env);
    }

    // Creating a missing Box pulls its reference, so select the bundle from
    // that pull rather than from whatever local tag an earlier pull left.
    // An existing Box is reused or replaced without a selection-time pull.
    // The bundled commit is compared with this checkout's lock inside the loader.
    function imageBundleLoader(ownership, imageRef = resolveBoxImageReference(env)) {
        return () => loadAgentLibImage({
            engine: ownership.engine, imageRef, runner, stdout, stderr, refresh: ownership.state === 'absent',
            pinPolicy: agentLibPinPolicy(env), repositoryRoot,
        });
    }

    // Bind never pulls: an image bundle may come only from a local image.
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
                pinPolicy: agentLibPinPolicy(env), repositoryRoot,
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

    async function prepareBoxForCommand({
        explicitPort,
        explicitMediaPort,
        branchPolicy = null,
        imageRef = resolveBoxImageReference(env),
    } = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            // An existing Box keeps its publication for ad hoc commands; only a
            // Box created here needs the saved binding.
            const routerBinding = ownership.handles?.container
                ? null
                : selectSavedRouterBinding(identity, explicitPort).desired;
            // The source is selected before Box reconciliation so the mount
            // contract can be part of the Box's immutable identity.
            const { selection } = await selectAgentLib({
                workspaceRoot: identity.workspaceRoot,
                branchPolicy,
                loadImageBundle: imageBundleLoader(ownership, imageRef),
            });
            const prepared = await reconcile({
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
        if (restoreGraph && outerRollback?.agentLib && failures.length === 0) {
            try {
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
            } catch (restoreError) {
                failures.push(`prior graph restoration: ${restoreError.message}`);
            }
        } else if (restoreStopped && outerRollback?.containerId && failures.length === 0) {
            try {
                stopRestoredBox(identity, ownership.engine, outerRollback.containerId);
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
        if (failures.length) {
            throw supervisorError(
                `${error.message}; rollback failures: ${failures.join('; ')}`,
                'PLOINKY_BOX_TRANSACTION_ROLLBACK_FAILED',
            );
        }
        throw error;
    }

    async function completeGraphAdmission({
        identity,
        lock,
        prepared,
        selection,
        requireHealth = true,
        skillScopeEnv = null,
        priorSkillScopeEnv = null,
        routerBindingUpdate = null,
    }) {
        if (requireHealth) await healthCheck(prepared.hostPort, { routerBinding: prepared.routerBinding });
        revalidateAgentLibSource(selection, {
            engine: prepared.ownership.engine,
            containerId: prepared.ownership.handles.container.id,
            runner,
        });
        commitAgentLibSelection(identity.workspaceRoot, selection);
        if (skillScopeEnv) writeGraphSkillScope(identity, skillScopeEnv, lock);
        try {
            if (routerBindingUpdate) routerBindingStore.write(identity, routerBindingUpdate.next, lock);
            prepared.finalize?.();
        } catch (error) {
            if (skillScopeEnv) writeGraphSkillScope(identity, priorSkillScopeEnv, lock);
            if (routerBindingUpdate) {
                try {
                    routerBindingStore.restore(identity, routerBindingUpdate.previous, lock);
                } catch (restoreError) {
                    error.message = `${error.message}; saved Router binding restoration: ${restoreError.message}`;
                }
            }
            throw error;
        }
    }

    async function reconcileConfiguredGraph(options, { priorCoreStartArgv, priorSkillScopeEnv }) {
        const priorRunning = options.ownership.handles?.container?.runtime?.running === true;
        try {
            return await reconcile(options);
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
            });
        }
    }

    async function runStartTransaction(coreArgs = [], options = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            const skillScopeEnv = buildHostSkillScope(identity.workspaceRoot, launchCwd);
            const priorCoreStartArgv = captureCoreStartArgv(identity);
            const priorSkillScopeEnv = readGraphSkillScope(identity);
            const { saved: savedBinding, desired: routerBinding } = selectSavedRouterBinding(
                identity,
                options.explicitPort,
            );
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
                imageRef: options.imageRef || resolveBoxImageReference(env),
                platform,
                env,
                stdout,
                stderr,
            }, { priorCoreStartArgv, priorSkillScopeEnv });
            const containerId = prepared.ownership.handles.container.id;
            let graphMutated = false;
            try {
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
                await completeGraphAdmission({
                    identity, lock, ownership, prepared, selection, containerId, skillScopeEnv, priorSkillScopeEnv,
                    routerBindingUpdate: savedRouterBindingUpdate(savedBinding, prepared),
                });
                reportRouterBinding(prepared.routerBinding);
                return Object.freeze({
                    identity, ...prepared, containerId, agentLib: selection,
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
        });
    }

    async function runRestartTransaction(coreArgs = ['restart'], options = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            const skillScopeEnv = buildHostSkillScope(identity.workspaceRoot, launchCwd);
            const priorCoreStartArgv = captureCoreStartArgv(identity);
            const priorSkillScopeEnv = readGraphSkillScope(identity);
            const { desired: routerBinding } = selectSavedRouterBinding(identity);
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
                imageRef: options.imageRef || resolveBoxImageReference(env),
                platform,
                env,
                stdout,
                stderr,
            }, { priorCoreStartArgv, priorSkillScopeEnv });
            const containerId = prepared.ownership.handles.container.id;
            let graphMutated = false;
            try {
                await ensureBoxDependencies(ownership.engine, containerId, runner, { workspaceRoot: identity.workspaceRoot, stdout, stderr });
                const effectiveArgs = prepared.action === 'replaced' && coreArgs.length > 1
                    ? ['restart']
                    : coreArgs;
                const hostReachableIpv4 = await resolveHostReachableIpv4({ platform });
                graphMutated = true;
                await runCoreCommand(
                    ownership.engine,
                    containerId,
                    effectiveArgs,
                    prepared.hostPort,
                    prepared.mediaHostPort,
                    runner,
                    { workspaceRoot: identity.workspaceRoot, stdout, stderr, hostReachableIpv4, agentLib: selection, skillScopeEnv },
                );
                await completeGraphAdmission({
                    identity, lock, ownership, prepared, selection, containerId, skillScopeEnv, priorSkillScopeEnv,
                });
                reportRouterBinding(prepared.routerBinding);
                return Object.freeze({
                    identity, ...prepared, containerId, agentLib: selection,
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
        return lockedMutation(async (identity, lock, ownership) => {
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

    async function runUpdateTransaction(coreArgs = ['update'], options = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            const skillScopeEnv = buildHostSkillScope(identity.workspaceRoot, launchCwd);
            const priorCoreStartArgv = captureCoreStartArgv(identity);
            const priorSkillScopeEnv = readGraphSkillScope(identity);
            const { desired: routerBinding } = selectSavedRouterBinding(identity);
            const workspacePloinky = await updateWorkspacePloinky({
                identity,
                lock,
                repositoryRoot,
                updateScopeRoot: options.updateScopeRoot || identity.workspaceRoot,
            });
            const { selection, changed, previous } = await updateAgentLib({
                workspaceRoot: identity.workspaceRoot,
                branchPolicy: options.branchPolicy || null,
                insideBox: false,
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
                imageRef: options.imageRef || resolveBoxImageReference(env),
                platform,
                env,
                stdout,
                stderr,
            }, { priorCoreStartArgv, priorSkillScopeEnv });
            const containerId = prepared.ownership.handles.container.id;
            let graphMutated = false;
            try {
                await ensureBoxDependencies(ownership.engine, containerId, runner, { workspaceRoot: identity.workspaceRoot, stdout, stderr });
                await runCoreCommand(
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
                        agentLib: selection,
                        skillScopeEnv,
                        updateExcludedRepoPath: workspacePloinky?.boxRepoPath || '',
                    },
                );
                if (options.restartAfterUpdate === true) {
                    const hostReachableIpv4 = await resolveHostReachableIpv4({ platform });
                    graphMutated = true;
                    await runCoreCommand(
                        ownership.engine,
                        containerId,
                        ['restart'],
                        prepared.hostPort,
                        prepared.mediaHostPort,
                        runner,
                        { workspaceRoot: identity.workspaceRoot, stdout, stderr, hostReachableIpv4, agentLib: selection, skillScopeEnv },
                    );
                }
                await completeGraphAdmission({
                    identity,
                    lock,
                    ownership,
                    prepared,
                    selection,
                    containerId,
                    requireHealth: options.restartAfterUpdate === true,
                    skillScopeEnv: options.restartAfterUpdate === true ? skillScopeEnv : null,
                    priorSkillScopeEnv,
                });
                if (options.restartAfterUpdate === true) reportRouterBinding(prepared.routerBinding);
                return Object.freeze({
                    identity, ...prepared, containerId, agentLib: selection,
                    changed, previous, workspacePloinky,
                });
            } catch (error) {
                await rollbackPreparedGraph({
                    identity,
                    prepared,
                    ownership,
                    containerId,
                    error,
                    stopGraph: graphMutated,
                    restoreGraph: options.restartAfterUpdate === true
                        && Boolean(prepared.previousAgentLib)
                        && Boolean(priorCoreStartArgv)
                        && (graphMutated || prepared.action === 'replaced'),
                    restoreCoreArgv: priorCoreStartArgv,
                    restoreSkillScopeEnv: priorSkillScopeEnv,
                });
            }
        });
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
    }) {
        const outcome = error?.boxRollback;
        const engine = ownership.engine;
        const failures = [];
        let recoveredContainerId = '';
        if (outcome?.action === 'restored') {
            recoveredContainerId = outcome.containerId;
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
                } else {
                    const restarted = await reconcile({
                        identity,
                        ownership: observed,
                        engine,
                        runner,
                        lock,
                        repositoryRoot,
                        agentLib: outcome.agentLib,
                        routerBinding: outcome.routerBinding,
                        imageRef: String(handle.labels?.[BOX_LABELS.imageRef] || ''),
                        imagePolicy: 'preserve',
                        platform,
                        env,
                        stdout,
                        stderr,
                    });
                    restarted.finalize?.();
                    recoveredContainerId = restarted.ownership.handles.container.id;
                }
            } catch (recoverError) {
                failures.push(`previous Box recovery: ${recoverError.message}`);
            }
        }
        if (recoveredContainerId && priorGraphRunning) {
            try {
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
        if (failures.length) {
            throw supervisorError(
                `${error.message}; rollback failures: ${failures.join('; ')}`,
                'PLOINKY_BOX_TRANSACTION_ROLLBACK_FAILED',
            );
        }
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
            // Every rejection happens before the Box, graph, or preference changes.
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
                prepared = await reconcile({
                    identity,
                    ownership,
                    engine,
                    runner,
                    lock,
                    repositoryRoot,
                    agentLib: selection,
                    routerBinding,
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

    async function runDestroyTransaction(expectedContainerId, { deleteCache = false } = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            const container = ownership.handles?.container;
            if (!container && expectedContainerId) {
                throw supervisorError('Box changed before destroy; nothing was removed');
            }
            if (!container && !deleteCache) {
                retireDestroyedMarkers({ identity, lock });
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

    return Object.freeze({
        prepareBoxForCommand,
        runStartTransaction,
        runRestartTransaction,
        runTargetedRestartTransaction,
        runUpdateTransaction,
        runBindTransaction,
        runStopTransaction,
        runDestroyTransaction,
        inspectBoxStatus,
        planDryRun,
        planBindDryRun,
    });
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
