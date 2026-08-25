import path from 'node:path';
import http from 'node:http';

import {
    BOX_LABELS,
    resolveBoxImageReference,
} from './constants.mjs';
import { selectWorkspaceAgentLibSource } from './agentlib-source.mjs';
import { AGENTLIB_ERROR_CODES, agentLibError } from '../agentlib/contract.mjs';
import { fingerprintSource, sourceIdEquals } from '../agentlib/fingerprint.mjs';
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
    resolveHostReachableIpv4 = detectHostReachableIpv4,
    readEdgeDesired = readWorkspaceEdgeDesired,
    stageEdgeDesired = stageWorkspaceEdgeDesired,
    healthCheck = checkBoxHealth,
    selectAgentLib = selectWorkspaceAgentLibSource,
    commitAgentLibSelection = writeActiveDescriptor,
    revalidateAgentLibSource = defaultRevalidateAgentLibSource,
    destroyBoxCache = removeWorkspaceDataPaths,
    destroyManagedAgentLib = removeManagedAgentLibState,
    inspectBoxData = inspectWorkspaceDataPaths,
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
            await ensureBoxDependencies(ownership.engine, containerId, runner, { stdout, stderr });
            return Object.freeze({
                identity, ...prepared, containerId, engine: ownership.engine, agentLib: selection,
            });
        });
    }

    async function runStartTransaction(coreArgs = [], options = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
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
            await healthCheck(prepared.hostPort);
            // The selection is revalidated against the host source only after
            // the whole graph is ready. A source that changed while startup was
            // in progress means the admitted graph does not match any single
            // selection, so readiness is refused and nothing is committed.
            revalidateAgentLibSource(selection);
            // Atomic commit last: `active.json` records what is actually running.
            commitAgentLibSelection(identity.workspaceRoot, selection);
            return Object.freeze({ identity, ...prepared, containerId, agentLib: selection });
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
    const normalizedHostReachableIpv4 = String(hostReachableIpv4 || '').trim();
    if (normalizedHostReachableIpv4 && !isUsableHostIpv4(normalizedHostReachableIpv4)) {
        throw supervisorError(
            `${HOST_REACHABLE_IPV4_ENV} must be a usable canonical literal IPv4 address`,
            'PLOINKY_BOX_HOST_REACHABLE_IPV4_INVALID',
        );
    }
    if (!agentLib) {
        throw supervisorError('Bounded core start requires the selected achillesAgentLib contract');
    }
    // The in-Box core reads the source only through the reserved environment,
    // which names the stable mount path rather than any host path.
    const agentLibEnvironment = agentLibBoxEnv(normalizeBoxAgentLib(agentLib));
    const runtimeEnvironment = [
        'container', 'exec',
        '--env', `PLOINKY_ROUTER_HOST_PORT=${hostPort}`,
        '--env', `PLOINKY_MEDIA_HOST_PORT=${mediaHostPort}`,
        ...(normalizedHostReachableIpv4
            ? ['--env', `${HOST_REACHABLE_IPV4_ENV}=${normalizedHostReachableIpv4}`]
            : []),
        ...Object.entries(agentLibEnvironment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    ];
    const result = await runner.stream(engine.name, [
        ...runtimeEnvironment,
        '--user', 'podman',
        '--workdir', '/workspace',
        containerId,
        '/opt/ploinky/bin/ploinky-local',
        ...coreArgv,
    ], { timeoutMs, stdout, stderr });
    if (!result.ok) {
        throw supervisorError(`In-box start failed with status ${result.status}`);
    }
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
