import path from 'node:path';
import http from 'node:http';

import { BOX_IMAGE_REFERENCE, BOX_LABELS } from './constants.mjs';
import { inspectAndValidateExistingImage } from './contract/image.mjs';
import { discoverBoxOwnership } from './engine/discovery.mjs';
import {
    readWorkspaceEdgeDesired,
    stageWorkspaceEdgeDesired,
} from './edgeDesired.mjs';
import { PloinkyBoxError } from './errors.mjs';
import { resolveWorkspaceIdentity } from './identity.mjs';
import { createMutationLockManager, withWorkspaceMutationLock } from './locks.mjs';
import { buildEngineProcessEnvironment, createProcessRunner } from './process.mjs';
import {
    removeContainerById,
    stopPloinkyLocalByContainerId,
} from './lifecycle/container.mjs';
import { reconcileBoxContainer } from './lifecycle/transactions.mjs';
import { serializeCloudflarePublicationStatus } from './cloudflared/status.mjs';
import { removeOwnedNamedVolumes } from './volumes.mjs';

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
    startCore = runBoundedCoreStart,
    readEdgeDesired = readWorkspaceEdgeDesired,
    stageEdgeDesired = stageWorkspaceEdgeDesired,
    healthCheck = checkBoxHealth,
    destroyNamedVolumes = removeOwnedNamedVolumes,
    stdout = process.stdout,
    stderr = process.stderr,
} = {}) {
    function inspect(identity) {
        return discover(identity, runner, platform, env);
    }

    async function lockedMutation(execute) {
        return withWorkspaceMutationLock({
            resolveIdentity,
            lockManager,
            beforeAnchor(identity) {
                return assertMutableOwnership(inspect(identity));
            },
            execute,
        });
    }

    async function prepareBoxForCommand({
        explicitPort,
        imageRef = BOX_IMAGE_REFERENCE,
    } = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            const prepared = await reconcile({
                identity,
                ownership,
                engine: ownership.engine,
                runner,
                lock,
                repositoryRoot,
                explicitPort,
                imageRef,
                platform,
                env,
                stdout,
                stderr,
            });
            const containerId = prepared.ownership.handles.container.id;
            await ensureBoxDependencies(ownership.engine, containerId, runner, { stdout, stderr });
            return Object.freeze({ identity, ...prepared, containerId, engine: ownership.engine });
        });
    }

    async function runStartTransaction(coreArgs = [], options = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            const prepared = await reconcile({
                identity,
                ownership,
                engine: ownership.engine,
                runner,
                lock,
                repositoryRoot,
                explicitPort: options.explicitPort,
                imageRef: options.imageRef || BOX_IMAGE_REFERENCE,
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
            await startCore(
                ownership.engine,
                containerId,
                coreArgs,
                prepared.hostPort,
                runner,
                { stdout, stderr },
            );
            await healthCheck(prepared.hostPort);
            return Object.freeze({ identity, ...prepared, containerId });
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

    async function runDestroyTransaction(expectedContainerId, { deleteVolumes = false } = {}) {
        return lockedMutation(async (identity, lock, ownership) => {
            const container = ownership.handles?.container;
            const volumes = ownership.handles?.volumes;
            if (!container && expectedContainerId) {
                throw supervisorError('Box changed before destroy; nothing was removed');
            }
            if (!container && !deleteVolumes) {
                return Object.freeze({ identity, action: 'absent' });
            }
            if (container && (!expectedContainerId || container.id !== expectedContainerId)) {
                throw supervisorError('Box changed after destroy confirmation; nothing was removed');
            }
            if (container) {
                removeContainerById(ownership.engine, container.id, runner);
            }
            const deletedVolumes = deleteVolumes
                ? destroyNamedVolumes({
                    engine: ownership.engine,
                    identity,
                    runner,
                    lock,
                    knownHandles: volumes,
                })
                : Object.freeze([]);
            return Object.freeze({
                identity,
                action: container ? 'destroyed' : 'deleted-retained-volumes',
                containerId: container?.id || null,
                deletedVolumes,
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
            return Object.freeze({ identity, ownership, state: 'absent-retained-volumes' });
        }
        try {
            validateExistingImage(
                ownership.engine.name,
                container.runtime?.imageId,
                container.labels?.[BOX_LABELS.imageRef],
                runner,
            );
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
            desiredImage: BOX_IMAGE_REFERENCE,
            desiredHostPort: options.explicitPort || null,
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
    runner,
    {
        stdout = process.stdout,
        stderr = process.stderr,
        timeoutMs = 1_800_000,
    } = {},
) {
    if (!Array.isArray(coreArgv) || !coreArgv.includes('start')) {
        throw supervisorError('Bounded core start requires normalized start argv');
    }
    const result = await runner.stream(engine.name, [
        'container', 'exec',
        '--env', `PLOINKY_ROUTER_HOST_PORT=${hostPort}`,
        '--user', 'podman',
        '--workdir', '/workspace',
        containerId,
        '/opt/ploinky/bin/ploinky-local',
        ...coreArgv,
    ], { timeoutMs, stdout, stderr });
    if (!result.ok) {
        throw supervisorError(`In-box start failed with status ${result.status}`);
    }
    const externalDashboard = `http://127.0.0.1:${hostPort}/dashboard`;
    if (!String(result.stdout || '').includes(`[start] Dashboard: ${externalDashboard}`)) {
        throw supervisorError(`In-box start did not report the public Dashboard URL ${externalDashboard}`);
    }
    if (Number(hostPort) !== 8080
        && String(result.stdout || '').includes('[start] Dashboard: http://127.0.0.1:8080/dashboard')) {
        throw supervisorError('In-box start advertised its internal-only Dashboard URL');
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
