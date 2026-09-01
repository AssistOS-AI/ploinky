import path from 'node:path';
import http from 'node:http';

import {
    BOX_LABELS,
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
import { canonicalWorkspaceRoot, managedRootPath, writeActiveDescriptor } from '../agentlib/source.mjs';
import fsPromisesFree from 'node:fs';
import {
    agentLibBoxEnv,
    agentLibContractFromContainer,
    normalizeBoxAgentLib,
} from './contract/agentlib.mjs';
import { validateContainerConfiguration } from './contract/container.mjs';
import { inspectAndValidateExistingImage } from './contract/image.mjs';
import { discoverBoxOwnership } from './engine/discovery.mjs';
import {
    readWorkspaceEdgeDesired,
    stageWorkspaceEdgeDesired,
} from './edgeDesired.mjs';
import { PloinkyBoxError } from './errors.mjs';
import {
    HOST_REACHABLE_IPV4_ENV,
    detectHostReachableIpv4,
    isUsableHostIpv4,
} from './hostNetwork.mjs';
import { resolveWorkspaceIdentity } from './identity.mjs';
import { createMutationLockManager, withWorkspaceMutationLock } from './locks.mjs';
import { buildEngineProcessEnvironment, createProcessRunner } from './process.mjs';
import { updateWorkspacePloinkySource } from './command/hostUpdate.mjs';
import {
    removeContainerById,
    stopPloinkyLocalByContainerId,
} from './lifecycle/container.mjs';
import { reconcileBoxContainer } from './lifecycle/transactions.mjs';
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
function defaultRevalidateAgentLibSource(selection) {
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
function revalidateMountedAgentLibSource(selection) {
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
    updateAgentLib = updateWorkspaceAgentLibSource,
    updateWorkspacePloinky = updateWorkspacePloinkySource,
    commitAgentLibSelection = writeActiveDescriptor,
    revalidateAgentLibSource = defaultRevalidateAgentLibSource,
    destroyBoxCache = removeWorkspaceDataPaths,
    destroyManagedAgentLib = removeManagedAgentLibState,
    inspectBoxData = inspectWorkspaceDataPaths,
    captureCoreStartArgv = captureConfiguredCoreStartArgv,
    stdout = process.stdout,
    stderr = process.stderr,
} = {}) {
    function inspect(identity) {
        return discover(identity, runner, platform, env);
    }

    async function lockedMutation(execute, authorize = assertMutableOwnership) {
        return withWorkspaceMutationLock({
            resolveIdentity,
            lockManager,
            beforeAnchor(identity) {
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
            // The source is selected before Box reconciliation so the mount
            // contract can be part of the Box's immutable identity.
            const { selection } = await selectAgentLib({
                workspaceRoot: identity.workspaceRoot,
                branchPolicy,
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
                imageRef,
                platform,
                env,
                stdout,
                stderr,
            });
            const containerId = prepared.ownership.handles.container.id;
            try {
                await ensureBoxDependencies(ownership.engine, containerId, runner, { stdout, stderr });
                prepared.finalize?.();
                return Object.freeze({
                    identity, ...prepared, containerId, engine: ownership.engine, agentLib: selection,
                });
            } catch (error) {
                await rollbackPreparedGraph({
                    prepared, ownership, containerId, error,
                    stopGraph: false,
                    restoreGraph: false,
                });
            }
        });
    }

    async function rollbackPreparedGraph({
        prepared,
        ownership,
        containerId,
        error,
        stopGraph,
        restoreGraph,
        restoreCoreArgv = null,
    }) {
        const failures = [];
        if (stopGraph) {
            try {
                stopPloinkyLocalByContainerId(ownership.engine, containerId, runner);
            } catch (stopError) {
                failures.push(`candidate graph stop: ${stopError.message}`);
            }
        }
        let outerRollback = null;
        try {
            outerRollback = await prepared.rollback?.();
        } catch (rollbackError) {
            failures.push(`outer Box rollback: ${rollbackError.message}`);
        }
        if (restoreGraph && outerRollback?.agentLib && failures.length === 0) {
            try {
                if (!Array.isArray(restoreCoreArgv) || restoreCoreArgv[0] !== 'start') {
                    throw new Error('the prior graph start configuration was not captured');
                }
                const prior = outerRollback.agentLib;
                const observed = fingerprintSource(prior.sourceDir);
                if (observed.fingerprint !== prior.fingerprint
                    || sourceIdHash(observed.sourceId) !== prior.sourceIdHash) {
                    throw new Error('the prior achillesAgentLib source changed during rollback');
                }
                const hostReachableIpv4 = await resolveHostReachableIpv4({ platform });
                await runCoreCommand(
                    ownership.engine,
                    outerRollback.containerId,
                    restoreCoreArgv,
                    outerRollback.hostPort,
                    outerRollback.mediaHostPort,
                    runner,
                    {
                        stdout,
                        stderr,
                        hostReachableIpv4,
                        agentLib: prior,
                    },
                );
                await healthCheck(outerRollback.hostPort);
            } catch (restoreError) {
                failures.push(`prior graph restoration: ${restoreError.message}`);
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
        prepared,
        selection,
        requireHealth = true,
    }) {
        if (requireHealth) await healthCheck(prepared.hostPort);
        revalidateAgentLibSource(selection);
        commitAgentLibSelection(identity.workspaceRoot, selection);
        prepared.finalize?.();
    }

    async function runStartTransaction(coreArgs = [], options = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            const priorCoreStartArgv = captureCoreStartArgv(identity);
            const { selection } = await selectAgentLib({
                workspaceRoot: identity.workspaceRoot,
                branchPolicy: options.branchPolicy || null,
            });
            const prepared = await reconcile({
                identity,
                ownership,
                engine: ownership.engine,
                runner,
                lock,
                repositoryRoot,
                agentLib: selection,
                explicitPort: options.explicitPort,
                explicitMediaPort: options.explicitMediaPort,
                imageRef: options.imageRef || resolveBoxImageReference(env),
                platform,
                env,
                stdout,
                stderr,
            });
            const containerId = prepared.ownership.handles.container.id;
            let graphMutated = false;
            try {
                await ensureBoxDependencies(ownership.engine, containerId, runner, { stdout, stderr });
                const edgeDesired = readEdgeDesired(identity);
                if (edgeDesired) {
                    stageEdgeDesired({
                        candidate: edgeDesired,
                        engine: ownership.engine,
                        containerId,
                        runner,
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
                        stdout,
                        stderr,
                        hostReachableIpv4,
                        agentLib: selection,
                    },
                );
                await completeGraphAdmission({
                    identity, ownership, prepared, selection, containerId,
                });
                return Object.freeze({
                    identity, ...prepared, containerId, agentLib: selection,
                });
            } catch (error) {
                await rollbackPreparedGraph({
                    prepared,
                    ownership,
                    containerId,
                    error,
                    stopGraph: graphMutated,
                    restoreGraph: Boolean(prepared.previousAgentLib)
                        && Boolean(priorCoreStartArgv)
                        && (graphMutated || prepared.action === 'replaced'),
                    restoreCoreArgv: priorCoreStartArgv,
                });
            }
        });
    }

    async function runRestartTransaction(coreArgs = ['restart'], options = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            const priorCoreStartArgv = captureCoreStartArgv(identity);
            const { selection } = await selectAgentLib({
                workspaceRoot: identity.workspaceRoot,
                branchPolicy: options.branchPolicy || null,
            });
            const prepared = await reconcile({
                identity,
                ownership,
                engine: ownership.engine,
                runner,
                lock,
                repositoryRoot,
                agentLib: selection,
                imageRef: options.imageRef || resolveBoxImageReference(env),
                platform,
                env,
                stdout,
                stderr,
            });
            const containerId = prepared.ownership.handles.container.id;
            let graphMutated = false;
            try {
                await ensureBoxDependencies(ownership.engine, containerId, runner, { stdout, stderr });
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
                    { stdout, stderr, hostReachableIpv4, agentLib: selection },
                );
                await completeGraphAdmission({
                    identity, ownership, prepared, selection, containerId,
                });
                return Object.freeze({
                    identity, ...prepared, containerId, agentLib: selection,
                });
            } catch (error) {
                await rollbackPreparedGraph({
                    prepared,
                    ownership,
                    containerId,
                    error,
                    stopGraph: graphMutated,
                    restoreGraph: Boolean(prepared.previousAgentLib)
                        && Boolean(priorCoreStartArgv)
                        && (graphMutated || prepared.action === 'replaced'),
                    restoreCoreArgv: priorCoreStartArgv,
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
            revalidateMountedAgentLibSource(selection);
            const hostPort = Number(container.labels?.[BOX_LABELS.routerHostPort]);
            const mediaHostPort = Number(container.labels?.[BOX_LABELS.mediaHostPort]);
            const hostReachableIpv4 = await resolveHostReachableIpv4({ platform });
            await runCoreCommand(
                engine,
                container.id,
                coreArgs,
                hostPort,
                mediaHostPort,
                runner,
                { stdout, stderr, hostReachableIpv4, agentLib: selection },
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
            await healthCheck(hostPort);
            revalidateMountedAgentLibSource(selection);
            return Object.freeze({
                identity,
                action: 'targeted-restart',
                ownership: revalidated,
                containerId: container.id,
                engine,
                hostPort,
                mediaHostPort,
                agentLib: selection,
            });
        });
    }

    async function runUpdateTransaction(coreArgs = ['update'], options = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            const priorCoreStartArgv = captureCoreStartArgv(identity);
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
            });
            const prepared = await reconcile({
                identity,
                ownership,
                engine: ownership.engine,
                runner,
                lock,
                repositoryRoot,
                agentLib: selection,
                imageRef: options.imageRef || resolveBoxImageReference(env),
                platform,
                env,
                stdout,
                stderr,
            });
            const containerId = prepared.ownership.handles.container.id;
            let graphMutated = false;
            try {
                await ensureBoxDependencies(ownership.engine, containerId, runner, { stdout, stderr });
                await runCoreCommand(
                    ownership.engine,
                    containerId,
                    coreArgs,
                    prepared.hostPort,
                    prepared.mediaHostPort,
                    runner,
                    {
                        stdout,
                        stderr,
                        agentLib: selection,
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
                        { stdout, stderr, hostReachableIpv4, agentLib: selection },
                    );
                }
                await completeGraphAdmission({
                    identity,
                    ownership,
                    prepared,
                    selection,
                    containerId,
                    requireHealth: options.restartAfterUpdate === true,
                });
                return Object.freeze({
                    identity, ...prepared, containerId, agentLib: selection,
                    changed, previous, workspacePloinky,
                });
            } catch (error) {
                await rollbackPreparedGraph({
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
                    stopPloinkyLocalByContainerId(ownership.engine, container.id, runner);
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
                        stopPloinkyLocalByContainerId(ownership.engine, container.id, runner);
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
                state: 'incompatible',
                detail: String(error.message || 'Owned Box image is incompatible'),
            });
        }
        if (!container.runtime.running) {
            return Object.freeze({ identity, ownership, state: 'stopped' });
        }
        const inbox = runner.query(ownership.engine.name, [
            'container', 'exec',
            '--user', 'podman',
            '--workdir', '/workspace',
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
            });
        } catch {
            return Object.freeze({
                identity,
                ownership,
                state: 'running-transient',
                inbox: null,
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

    return Object.freeze({
        prepareBoxForCommand,
        runStartTransaction,
        runRestartTransaction,
        runTargetedRestartTransaction,
        runUpdateTransaction,
        runStopTransaction,
        runDestroyTransaction,
        inspectBoxStatus,
        planDryRun,
    });
}

export async function ensureBoxDependencies(engine, containerId, runner, {
    stdout = process.stdout,
    stderr = process.stderr,
    timeoutMs = 1_800_000,
} = {}) {
    const args = [
        'container', 'exec',
        '--user', 'podman',
        '--workdir', '/workspace',
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

export function formatBoxStatus(status) {
    const lines = [
        `Ploinky Box: ${status.state}`,
        `Workspace identity: ${status.identity.instance}`,
    ];
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
) {
    if (!agentLib) {
        throw supervisorError('Bounded core command requires the selected achillesAgentLib contract');
    }
    const agentLibEnvironment = agentLibBoxEnv(normalizeBoxAgentLib(agentLib));
    return [
        'container', 'exec',
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
        stdout = process.stdout,
        stderr = process.stderr,
        timeoutMs = 1_800_000,
        hostReachableIpv4 = '',
        agentLib = null,
        updateExcludedRepoPath = '',
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
        ),
        '--user', 'podman',
        '--workdir', '/workspace',
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
        stdout = process.stdout,
        stderr = process.stderr,
        timeoutMs = 1_800_000,
        hostReachableIpv4 = '',
        agentLib = null,
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
        { stdout, stderr, timeoutMs, hostReachableIpv4, agentLib },
    );
    const externalRouter = `http://127.0.0.1:${hostPort}`;
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
    httpGet,
    timeoutMs = 5_000,
    readinessTimeoutMs = 1_800_000,
    retryDelayMs = 1_000,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
    const deadline = Date.now() + readinessTimeoutMs;

    async function checkUntilReady() {
        const result = await checkOnce();
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
        return checkUntilReady();
    }

    function checkOnce() {
        return new Promise((resolve, reject) => {
            const selectedGet = httpGet || http.get;
            try {
                const request = selectedGet({
                    hostname: '127.0.0.1',
                    port: Number(hostPort),
                    path: '/health',
                    headers: { Host: `127.0.0.1:${hostPort}` },
                }, (response) => {
                    let body = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => { body += chunk; });
                response.on('end', () => {
                    if (response.statusCode === 302 && body === 'Authentication required') {
                        try {
                            const location = new URL(
                                String(response.headers?.location || ''),
                                `http://127.0.0.1:${hostPort}`,
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
                                message: `Public Box health check was unhealthy (HTTP ${response.statusCode})`,
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

    return checkUntilReady();
}

export const defaultBoxSupervisor = createBoxSupervisor;
