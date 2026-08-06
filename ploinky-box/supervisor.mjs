import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

import { BOX_IMAGE_REFERENCE, BOX_LABELS } from './constants.mjs';
import { IMAGE_CONTRACT, inspectAndValidateDirectImage } from './contract/image.mjs';
import {
    RELEASE_DESCRIPTOR_ENV,
    parseReleaseDescriptor,
    serializeReleaseDescriptor,
    validateReleaseControllerAdmission,
    validateReleaseImageInspection,
} from './contract/release.mjs';
import { discoverBoxOwnership } from './engine/discovery.mjs';
import {
    readWorkspaceEdgeDesired,
    stageWorkspaceEdgeDesired,
} from './edgeDesired.mjs';
import { PloinkyBoxError } from './errors.mjs';
import { resolveWorkspaceIdentity } from './identity.mjs';
import { createMutationLockManager, withWorkspaceMutationLock } from './locks.mjs';
import { buildEngineProcessEnvironment, createProcessRunner } from './process.mjs';
import { executeBoxCommand } from './command/execute.mjs';
import {
    removeContainerById,
    stopPloinkyLocalByContainerId,
} from './lifecycle/container.mjs';
import { reconcileBoxContainer } from './lifecycle/transactions.mjs';
import { serializeCloudflarePublicationStatus } from './cloudflared/status.mjs';
import { removeOwnedNamedVolumes } from './volumes.mjs';
import { createOuterJournalStore } from './lifecycle/outerJournal.mjs';

function supervisorError(message, code = 'PLOINKY_BOX_SUPERVISOR_FAILED') {
    return new PloinkyBoxError(message, { code });
}

function assertJournalOwnsCompleteVolumeSet(journal, identity) {
    const expected = Object.values(identity.volumes).sort();
    const owned = [...(journal?.createdResources?.volumes || [])].sort();
    if (expected.length !== 3
        || owned.length !== expected.length
        || owned.some((name, index) => name !== expected[index])) {
        throw supervisorError(
            'Named-volume deletion requires the complete journal-owned transaction volume set',
            'PLOINKY_BOX_VOLUME_OWNERSHIP_INCOMPLETE',
        );
    }
}

function assertJournalOwnsValidVolumeSubset(journal, identity) {
    const expected = new Set(Object.values(identity.volumes));
    const owned = journal?.createdResources?.volumes;
    if (!Array.isArray(owned)
        || new Set(owned).size !== owned.length
        || owned.some((name) => !expected.has(name))) {
        throw supervisorError(
            'Named-volume deletion journal contains an invalid resource set',
            'PLOINKY_BOX_VOLUME_OWNERSHIP_INCOMPLETE',
        );
    }
    return owned;
}

function proveStoppedOuterContainment(container, journal) {
    const state = String(container?.runtime?.status || '').toLowerCase();
    const creation = journal?.container?.creation;
    if (container?.runtime?.running
        || !['configured', 'created', 'exited', 'stopped'].includes(state)
        || Number(container?.runtime?.pid || 0) !== 0
        || !creation
        || !Array.isArray(creation.dependencies)
        || creation.dependencies.length !== 0
        || creation.autoRemove !== false) {
        throw supervisorError(
            'Stopped outer Box containment is ambiguous; destroy retained it',
            'PLOINKY_BOX_CONTAINMENT_AMBIGUOUS',
        );
    }
    // A proven stopped standalone container has no live PID namespace and thus
    // cannot contain a surviving nested runtime.  This is the stopped-state
    // counterpart to the explicit ploinky-local stop/inbox proof above.
    return true;
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const digest = crypto.createHash('sha256');
        const input = fs.createReadStream(filePath);
        input.on('error', reject);
        digest.on('error', reject);
        digest.on('finish', () => resolve(digest.digest('hex')));
        input.pipe(digest);
    });
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

function defaultDiscovery(identity, runner, platform, env, hostClient, outerJournal) {
    return discoverBoxOwnership(identity, {
        runner, platform, env, hostClient, outerJournal,
    });
}

const INBOX_RUNTIME_KINDS = new Set(['bwrap', 'seatbelt', 'container']);
const INBOX_RUNTIME_ROLES = new Set(['service', 'provider-task']);
const INBOX_RUNTIME_STATES = new Set(['running', 'stopped', 'failed']);
const INBOX_READINESS_STATES = new Set(['ready', 'not-ready']);
const INBOX_SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const INBOX_LOG_ROOT = '/workspace/.ploinky/logs';

function boundedInboxText(value, { allowEmpty = false, maxBytes = 4096 } = {}) {
    return typeof value === 'string'
        && value === value.trim()
        && (allowEmpty || value !== '')
        && Buffer.byteLength(value, 'utf8') <= maxBytes
        && !/[\u0000-\u001f\u007f]/u.test(value)
        ? value
        : null;
}

function safeInboxSegment(value) {
    return typeof value === 'string'
        && value !== '.'
        && value !== '..'
        && INBOX_SAFE_SEGMENT.test(value);
}

function canonicalInboxPath(value) {
    return typeof value === 'string'
        && path.posix.isAbsolute(value)
        && path.posix.normalize(value) === value;
}

function exactInboxWorkdir(runtime, role, workdir) {
    if (!canonicalInboxPath(workdir) || workdir === '/') return false;
    const workspaceContained = workdir === '/workspace' || workdir.startsWith('/workspace/');
    if (role === 'provider-task') return workdir !== '/workspace' && workspaceContained;
    if (runtime === 'container') return workspaceContained;
    return workdir === '/code';
}

function exactInboxFileLog(logPath, role, taskId) {
    if (logPath === '') return role === 'service';
    if (!canonicalInboxPath(logPath)) return false;
    const relative = path.posix.relative(INBOX_LOG_ROOT, logPath);
    if (!relative || relative === '..' || relative.startsWith('../')
        || path.posix.isAbsolute(relative)) return false;
    const segments = relative.split('/');
    if (role === 'provider-task') {
        return safeInboxSegment(taskId)
            && segments.length === 4
            && segments[0] === 'agents'
            && safeInboxSegment(segments[1])
            && segments[2] === 'tasks'
            && segments[3] === `${taskId}-provider.log`;
    }
    return !segments.includes('tasks');
}

function allowlistInboxRuntime(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const runtime = INBOX_RUNTIME_KINDS.has(value.runtime) ? value.runtime : null;
    const role = INBOX_RUNTIME_ROLES.has(value.role) ? value.role : null;
    const state = INBOX_RUNTIME_STATES.has(value.state) ? value.state : null;
    const readiness = INBOX_READINESS_STATES.has(value.readiness) ? value.readiness : null;
    const effectiveInstance = boundedInboxText(value.effectiveInstance, { maxBytes: 255 });
    const generation = boundedInboxText(value.generation, { allowEmpty: true, maxBytes: 255 });
    const ownerKey = boundedInboxText(value.ownerKey, { allowEmpty: true, maxBytes: 512 });
    const processIdentity = boundedInboxText(value.processIdentity, { allowEmpty: true, maxBytes: 512 });
    const workdir = boundedInboxText(value.workdir, { allowEmpty: true });
    const homeKey = boundedInboxText(value.homeKey, { allowEmpty: true, maxBytes: 255 });
    const logPath = boundedInboxText(value.logPath, { allowEmpty: true });
    const taskId = role === 'provider-task'
        ? boundedInboxText(value.taskId, { maxBytes: 255 })
        : null;
    const provider = role === 'provider-task'
        ? boundedInboxText(value.provider, { maxBytes: 64 })
        : null;
    const containerIdentity = /^container:([a-f0-9]{64})$/.exec(processIdentity || '');
    const exactContainerServiceLog = runtime === 'container' && role === 'service'
        && containerIdentity
        && ownerKey === processIdentity
        && logPath === `podman://${containerIdentity[1]}`;
    const exactFileLog = exactInboxFileLog(logPath, role, taskId);
    const requiresExactOwnership = state === 'running'
        || readiness === 'ready'
        || role === 'provider-task';
    const exactOwnership = generation !== ''
        && ownerKey !== ''
        && processIdentity !== ''
        && exactInboxWorkdir(runtime, role, workdir)
        && safeInboxSegment(homeKey);
    const readinessConsistent = readiness !== 'ready' || state === 'running';
    if (!runtime || !role || !state || !readiness || !effectiveInstance
        || generation === null || ownerKey === null || processIdentity === null
        || workdir === null || homeKey === null || logPath === null
        || !readinessConsistent
        || (requiresExactOwnership && !exactOwnership)
        || (runtime === 'container' && role === 'service'
            ? !exactContainerServiceLog
            : !exactFileLog)) {
        return null;
    }
    const result = {
        runtime,
        role,
        effectiveInstance,
        generation,
        state,
        ownerKey,
        processIdentity,
        workdir,
        homeKey,
        readiness,
        logPath,
    };
    if (role === 'provider-task') {
        if (!safeInboxSegment(taskId) || !safeInboxSegment(provider)) return null;
        result.taskId = taskId;
        result.provider = provider;
    }
    return Object.freeze(result);
}

function allowlistInboxPayload(parsed) {
    const suppliedRuntimes = Array.isArray(parsed?.runtimes) ? parsed.runtimes : [];
    const runtimes = suppliedRuntimes.slice(0, 1024).map(allowlistInboxRuntime);
    const invalidRuntimeEntries = runtimes.filter((value) => value === null).length
        + Math.max(0, suppliedRuntimes.length - 1024);
    return Object.freeze({
        state: String(parsed?.state || 'unknown'),
        initialized: parsed?.initialized === true,
        routingConfigured: parsed?.routingConfigured === true,
        trackedAgents: Number(parsed?.trackedAgents) || 0,
        runningAgents: Number(parsed?.runningAgents) || 0,
        runtimes: Object.freeze(runtimes.filter(Boolean)),
        invalidRuntimeEntries,
        cloudflarePublication: serializeCloudflarePublicationStatus(
            parsed?.cloudflarePublication,
        ),
        warnings: Object.freeze([
            ...(Array.isArray(parsed?.warnings)
                ? parsed.warnings.slice(0, 256).map(() => 'inner lifecycle warning')
                : []),
            ...(invalidRuntimeEntries > 0
                ? [`inner runtime status rejected: ${invalidRuntimeEntries} invalid entries`]
                : []),
        ]),
    });
}

async function queryBoxInbox(hostClient, containerId, journal) {
    if (!hostClient || typeof hostClient.execContainer !== 'function') {
        return Object.freeze({ ok: false, inbox: null });
    }
    let result;
    try {
        result = await hostClient.execContainer({
            id: containerId,
            argv: [
        '/usr/local/bin/node',
        '/opt/ploinky/ploinky-box/inbox/readStatus.mjs',
            ],
            user: 'podman',
            workdir: '/workspace',
            env: {},
            journal,
            timeoutMs: 10_000,
            maxOutputBytes: 4 * 1024 * 1024,
        });
    } catch {
        return Object.freeze({ ok: false, inbox: null });
    }
    if (result.exitCode !== 0) return Object.freeze({ ok: false, inbox: null });
    try {
        const parsed = JSON.parse(String(result.stdout || '').trim());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return Object.freeze({ ok: false, inbox: null });
        }
        return Object.freeze({ ok: true, inbox: allowlistInboxPayload(parsed) });
    } catch {
        return Object.freeze({ ok: false, inbox: null });
    }
}

function describeRuntimeSurvivor(runtime) {
    const task = runtime.role === 'provider-task' ? ` ${runtime.taskId}` : '';
    return `${runtime.runtime} ${runtime.role} ${runtime.effectiveInstance}${task} ${runtime.state}`;
}

export function createBoxSupervisor({
    runner = createProcessRunner({ env: buildEngineProcessEnvironment() }),
    hostClient = null,
    lockManager = createMutationLockManager(),
    resolveIdentity = () => resolveWorkspaceIdentity(),
    discover = defaultDiscovery,
    platform = process.platform,
    env = process.env,
    repositoryRoot = path.resolve(import.meta.dirname, '..'),
    reconcile = reconcileBoxContainer,
    validateReleaseAdmission = validateReleaseControllerAdmission,
    admitNodeImage = admitReleaseNodeImage,
    startCore = runBoundedCoreStart,
    readEdgeDesired = readWorkspaceEdgeDesired,
    stageEdgeDesired = stageWorkspaceEdgeDesired,
    healthCheck = checkBoxHealth,
    destroyNamedVolumes = removeOwnedNamedVolumes,
    stdout = process.stdout,
    stderr = process.stderr,
} = {}) {
    async function inspect(identity) {
        const journal = discover === defaultDiscovery
            ? createOuterJournalStore({ workspaceRoot: identity.workspaceRoot })
            : null;
        return discover(identity, runner, platform, env, hostClient, journal);
    }

    function directClient(ownership) {
        const selected = hostClient || ownership?.hostClient;
        if (!selected || typeof selected.listContainers !== 'function') {
            throw supervisorError(
                'Structured Podman host transport is unavailable for this selected machine socket',
                'PLOINKY_BOX_HOST_TRANSPORT_UNAVAILABLE',
            );
        }
        return selected;
    }

    function admitMutationRelease(requested, ownership) {
        let descriptor = requested || null;
        if (!descriptor) {
            const serialized = String(
                ownership?.handles?.container?.labels?.[BOX_LABELS.releaseDescriptor] || '',
            );
            if (serialized) descriptor = parseReleaseDescriptor(serialized);
        }
        if (descriptor) validateReleaseAdmission(descriptor, { repositoryRoot });
        return descriptor;
    }

    async function lockedMutation(execute) {
        return withWorkspaceMutationLock({
            resolveIdentity,
            lockManager,
            async beforeAnchor(identity) {
                return assertMutableOwnership(await inspect(identity));
            },
            execute,
        });
    }

    async function continueManagedStart({
        identity,
        ownership,
        descriptor,
        coreArgs,
        hostPort,
        context,
    }) {
        const client = directClient(ownership);
        const { containerId, advance } = context;
        await verifyBoxCapabilities(client, containerId, context.journal);
        await admitNodeImage(client, containerId, descriptor, context.journal, {
            stdout, stderr,
        });
        await ensureBoxDependencies(client, containerId, context.journal, { stdout, stderr });
        await advance('dependencies-installed');
        const edgeDesired = readEdgeDesired(identity);
        if (edgeDesired) {
            await stageEdgeDesired({
                candidate: edgeDesired,
                containerId,
                hostClient: client,
                journal: context.journal,
            });
        }
        await advance('edge-staged');
        await startCore(client, containerId, coreArgs, hostPort, context.journal, {
            stdout,
            stderr,
            releaseDescriptor: descriptor,
        });
        await advance('core-started');
        await healthCheck(hostPort);
        await advance('health-verified');
    }

    async function prepareBoxForCommand({
        explicitPort,
        releaseDescriptor,
        imageRef = BOX_IMAGE_REFERENCE,
        ...retired
    } = {}) {
        if (Object.hasOwn(retired, 'explicitMediaPort') || Object.hasOwn(retired, 'localBoxImageId')) {
            throw supervisorError('Loose local image/media inputs are retired; use one release descriptor');
        }
        return lockedMutation(async (identity, lock, ownership) => {
            const admittedRelease = admitMutationRelease(releaseDescriptor, ownership);
            const container = ownership.handles?.container;
            if (!container || !container.runtime.running || ownership.journal?.phase !== 'committed') {
                throw supervisorError(
                    'Preparing an interactive Box cannot create or start a generation without a complete managed start transaction; run `ploinky start` first',
                    'PLOINKY_BOX_START_REQUIRED',
                );
            }
            if (explicitPort !== undefined && Number(explicitPort)
                !== Number(container.labels?.[BOX_LABELS.routerHostPort])) {
                throw supervisorError('Prepared Box port does not match its committed generation');
            }
            if (admittedRelease && admittedRelease.releaseGeneration
                !== container.labels?.[BOX_LABELS.releaseGeneration]) {
                throw supervisorError('Prepared Box release does not match its committed generation');
            }
            const descriptor = admittedRelease || parseReleaseDescriptor(
                String(container.labels?.[BOX_LABELS.releaseDescriptor] || ''),
            );
            const client = directClient(ownership);
            await admitNodeImage(client, container.id, descriptor, ownership.journal, {
                stdout, stderr,
            });
            await ensureBoxDependencies(client, container.id, ownership.journal, { stdout, stderr });
            return Object.freeze({
                identity,
                ownership,
                containerId: container.id,
                engine: ownership.engine,
                hostClient: client,
                journal: ownership.journal,
                hostPort: descriptor.routerHostPort,
                imageId: descriptor.boxImageId,
                action: 'reused',
            });
        });
    }

    async function runStartTransaction(coreArgs = [], options = {}) {
        if (Object.hasOwn(options, 'explicitMediaPort')
            || Object.hasOwn(options, 'localBoxImageId')
            || Object.hasOwn(options, 'agentlibRef')) {
            throw supervisorError('Loose release inputs are retired; use one release descriptor');
        }
        return lockedMutation(async (identity, lock, ownership) => {
            const admittedRelease = admitMutationRelease(options.releaseDescriptor, ownership);
            if (!admittedRelease) {
                throw supervisorError('Managed Box start requires one exact release descriptor');
            }
            const client = directClient(ownership);
            const predecessorDescriptor = ownership.handles?.container
                ? parseReleaseDescriptor(String(
                    ownership.handles.container.labels?.[BOX_LABELS.releaseDescriptor] || '',
                ))
                : null;
            const prepared = await reconcile({
                identity,
                ownership,
                engine: ownership.engine,
                runner,
                hostClient: client,
                lock,
                repositoryRoot,
                explicitPort: options.explicitPort,
                releaseDescriptor: admittedRelease,
                imageRef: options.imageRef || BOX_IMAGE_REFERENCE,
                platform,
                env,
                stdout,
                stderr,
                ...(reconcile === reconcileBoxContainer
                    ? { outerJournal: createOuterJournalStore({ workspaceRoot: identity.workspaceRoot }) }
                    : {}),
                afterStart: (context) => continueManagedStart({
                    identity,
                    ownership,
                    descriptor: admittedRelease,
                    coreArgs,
                    hostPort: admittedRelease.routerHostPort,
                    context,
                }),
                afterRestore: predecessorDescriptor
                    ? (context) => continueManagedStart({
                        identity,
                        ownership,
                        descriptor: predecessorDescriptor,
                        coreArgs,
                        hostPort: predecessorDescriptor.routerHostPort,
                        context: {
                            ...context,
                            advance: async () => context.journal,
                        },
                    })
                    : null,
            });
            const containerId = prepared.ownership.handles.container.id;
            return Object.freeze({
                identity, ...prepared, containerId, hostClient: client,
                journal: prepared.ownership.journal,
            });
        });
    }

    async function runStopTransaction() {
        return lockedMutation(async (identity, lock, ownership) => {
            const container = ownership.handles?.container;
            if (!container) {
                return Object.freeze({ identity, action: 'absent' });
            }
            if (container.runtime.running) {
                const client = directClient(ownership);
                let localStopError = null;
                let cleanupVerificationError = null;
                let survivors = [];
                try {
                    await stopPloinkyLocalByContainerId(client, container.id, ownership.journal);
                } catch (error) {
                    localStopError = error;
                }
                try {
                    const checked = await queryBoxInbox(client, container.id, ownership.journal);
                    if (!checked.ok || checked.inbox.invalidRuntimeEntries > 0) {
                        cleanupVerificationError = new Error('inner cleanup verification was unavailable');
                    } else {
                        survivors = checked.inbox.runtimes.filter((runtime) => runtime.ownerKey !== '');
                    }
                } finally {
                    await client.stopContainer({
                        id: container.id,
                        timeout: 30,
                        journal: ownership.journal,
                    });
                }
                if (localStopError || cleanupVerificationError || survivors.length > 0) {
                    const detail = [
                        ...(localStopError ? ['ploinky-local stop failed'] : []),
                        ...(cleanupVerificationError ? ['inner cleanup verification failed'] : []),
                        ...(survivors.length > 0
                            ? [`exact inner survivors: ${survivors.map(describeRuntimeSurvivor).join(', ')}`]
                            : []),
                    ].join('; ');
                    throw supervisorError(
                        `Outer Box stopped after ${detail}`,
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
            if (!container && !volumes) {
                return Object.freeze({ identity, action: 'absent' });
            }
            if (!container && !deleteVolumes) {
                return Object.freeze({ identity, action: 'absent-retained-volumes' });
            }
            if (container && (!expectedContainerId || container.id !== expectedContainerId)) {
                throw supervisorError('Box changed after destroy confirmation; nothing was removed');
            }
            if (container) {
                const client = directClient(ownership);
                let containmentError = null;
                if (container.runtime.running) {
                    try {
                        await stopPloinkyLocalByContainerId(client, container.id, ownership.journal);
                        const checked = await queryBoxInbox(client, container.id, ownership.journal);
                        if (!checked.ok || checked.inbox.invalidRuntimeEntries > 0
                            || checked.inbox.runtimes.some((runtime) => runtime.ownerKey !== '')) {
                            throw new Error('inner containment could not be proven empty');
                        }
                    } catch (error) {
                        containmentError = error;
                    } finally {
                        await client.stopContainer({
                            id: container.id, timeout: 30, journal: ownership.journal,
                        });
                    }
                } else {
                    proveStoppedOuterContainment(container, ownership.journal);
                }
                if (containmentError) {
                    throw supervisorError(
                        `Outer Box was stopped but destroy retained it because ${containmentError.message}`,
                    );
                }
                const store = createOuterJournalStore({ workspaceRoot: identity.workspaceRoot });
                let journal = store.update({
                    generation: ownership.journal.transaction.generation,
                    containerId: ownership.journal.container.id,
                    revision: ownership.journal.revision,
                }, { phase: 'destroying' });
                await removeContainerById(client, container.id, journal, { timeout: 30 });
                if (typeof store.markContainerDeleted !== 'function') {
                    throw supervisorError('Outer Box journal deletion publication is unavailable');
                }
                journal = store.markContainerDeleted({
                    generation: journal.transaction.generation,
                    containerId: journal.container.id,
                    revision: journal.revision,
                });
                let deletedVolumes = Object.freeze([]);
                if (deleteVolumes) {
                    try {
                        assertJournalOwnsCompleteVolumeSet(journal, identity);
                        deletedVolumes = await destroyNamedVolumes({
                            engine: ownership.engine,
                            identity,
                            hostClient: client,
                            lock,
                            knownHandles: volumes,
                            ownedVolumeNames: [...journal.createdResources.volumes],
                            recoverAbsentJournaled: true,
                            onDeleted: async ({ name }) => {
                                if (typeof store.markVolumeDeleted !== 'function') {
                                    throw supervisorError(
                                        'Outer Box volume deletion publication is unavailable',
                                    );
                                }
                                journal = store.markVolumeDeleted({
                                    generation: journal.transaction.generation,
                                    containerId: journal.container.id,
                                    revision: journal.revision,
                                }, name);
                            },
                        });
                    } catch (error) {
                        try {
                            journal = store.update({
                                generation: journal.transaction.generation,
                                containerId: journal.container.id,
                                revision: journal.revision,
                            }, { phase: 'retaining-resources' });
                        } catch {}
                        throw error;
                    }
                }
                if (deleteVolumes && journal.createdResources.volumes.length !== 0) {
                    throw supervisorError(
                        'Named-volume deletion completed without emptying its ownership journal',
                    );
                }
                if (journal.createdResources.volumes.length === 0) {
                    store.retire({
                        generation: journal.transaction.generation,
                        containerId: journal.container.id,
                        revision: journal.revision,
                    });
                }
                return Object.freeze({
                    identity,
                    action: deleteVolumes ? 'destroyed' : 'destroyed-retained-volumes',
                    containerId: container.id,
                    deletedVolumes,
                });
            }
            const client = directClient(ownership);
            const store = createOuterJournalStore({ workspaceRoot: identity.workspaceRoot });
            let journal = ownership.journal;
            if (!journal
                || journal.createdResources.container
                || !['container-deleted', 'retaining-resources'].includes(journal.phase)) {
                throw supervisorError(
                    'Retained-volume deletion requires one exact deleted-generation journal',
                );
            }
            const ownedVolumeNames = assertJournalOwnsValidVolumeSubset(journal, identity);
            let deletedVolumes;
            try {
                deletedVolumes = await destroyNamedVolumes({
                    engine: ownership.engine,
                    identity,
                    hostClient: client,
                    lock,
                    knownHandles: volumes,
                    ownedVolumeNames: [...ownedVolumeNames],
                    recoverAbsentJournaled: true,
                    onDeleted: async ({ name }) => {
                        if (typeof store.markVolumeDeleted !== 'function') {
                            throw supervisorError(
                                'Outer Box volume deletion publication is unavailable',
                            );
                        }
                        journal = store.markVolumeDeleted({
                            generation: journal.transaction.generation,
                            containerId: journal.container.id,
                            revision: journal.revision,
                        }, name);
                    },
                });
            } catch (error) {
                if (journal.phase === 'container-deleted') {
                    try {
                        journal = store.update({
                            generation: journal.transaction.generation,
                            containerId: journal.container.id,
                            revision: journal.revision,
                        }, { phase: 'retaining-resources' });
                    } catch {}
                }
                throw error;
            }
            if (journal.createdResources.volumes.length !== 0) {
                throw supervisorError(
                    'Retained-volume deletion completed without emptying its ownership journal',
                );
            }
            store.retire({
                generation: journal.transaction.generation,
                containerId: journal.container.id,
                revision: journal.revision,
            });
            return Object.freeze({
                identity, action: 'deleted-retained-volumes', containerId: null,
                deletedVolumes,
            });
        });
    }

    async function inspectBoxStatus() {
        const identity = resolveIdentity();
        const ownership = await inspect(identity);
        if (ownership.state !== 'owned') {
            return Object.freeze({ identity, ownership, state: ownership.state });
        }
        const container = ownership.handles?.container;
        if (!container) {
            return Object.freeze({ identity, ownership, state: 'absent-retained-volumes' });
        }
        let releaseDescriptor = null;
        const serializedRelease = String(container.labels?.[BOX_LABELS.releaseDescriptor] || '');
        if (serializedRelease) {
            try {
                releaseDescriptor = parseReleaseDescriptor(serializedRelease);
                if (container.labels?.[BOX_LABELS.releaseGeneration]
                    !== releaseDescriptor.releaseGeneration) {
                    throw new Error('release generation label mismatch');
                }
                validateReleaseAdmission(releaseDescriptor, { repositoryRoot });
                validateReleaseImageInspection(
                    'box',
                    await directClient(ownership).inspectImage(releaseDescriptor.boxImageId),
                    releaseDescriptor,
                );
            } catch (error) {
                return Object.freeze({
                    identity,
                    ownership,
                    state: 'incompatible',
                    detail: `Owned Box release is incompatible: ${error.message}`,
                });
            }
        }
        try {
            await inspectAndValidateDirectImage(
                directClient(ownership),
                container.runtime?.imageId,
                container.labels?.[BOX_LABELS.imageRef],
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
            return Object.freeze({ identity, ownership, state: 'stopped', releaseDescriptor });
        }
        const checkedInbox = await queryBoxInbox(
            directClient(ownership), container.id, ownership.journal,
        );
        if (!checkedInbox.ok) {
            return Object.freeze({
                identity,
                ownership,
                state: 'running-transient',
                inbox: null,
                releaseDescriptor,
            });
        }
        try {
            const allowlisted = checkedInbox.inbox;
            return Object.freeze({
                identity,
                ownership,
                state: allowlisted.initialized ? 'running-initialized' : 'running-uninitialized',
                inbox: allowlisted,
                releaseDescriptor,
            });
        } catch {
            return Object.freeze({
                identity,
                ownership,
                state: 'running-transient',
                inbox: null,
                releaseDescriptor,
            });
        }
    }

    async function planDryRun(options = {}) {
        if (Object.hasOwn(options, 'explicitMediaPort') || Object.hasOwn(options, 'localBoxImageId')) {
            throw supervisorError('Loose local image/media inputs are retired; use one release descriptor');
        }
        const { identity, ownership } = await inspectBoxStatus();
        return Object.freeze({
            identity: identity.instance,
            ownership: ownership.state,
            desiredImage: BOX_IMAGE_REFERENCE,
            desiredReleaseGeneration: options.releaseDescriptor?.releaseGeneration || null,
            desiredLocalImageId: options.releaseDescriptor?.boxImageId || null,
            desiredHostPort: options.releaseDescriptor?.routerHostPort
                || options.explicitPort
                || null,
            desiredMediaHostPort: options.releaseDescriptor?.mediaHostPort || null,
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
        async executeCommand(prepared, argv, options = {}) {
            const result = await executeBoxCommand({
                hostClient: prepared.hostClient || directClient(prepared.ownership),
                containerId: prepared.containerId,
                journal: prepared.journal || prepared.ownership?.journal,
                argv,
                hostPort: prepared.hostPort,
                stdout,
                stderr,
                ...options,
            });
            return result.exitCode;
        },
    });
}

export async function verifyBoxCapabilities(hostClient, containerId, journal) {
    const names = [...IMAGE_CONTRACT.requiredBinaries, ...IMAGE_CONTRACT.networkHelpers];
    const script = [
        'set -eu',
        ...IMAGE_CONTRACT.requiredBinaries.map((name) => (
            name.startsWith('/') ? `test -x ${JSON.stringify(name)}` : `command -v ${JSON.stringify(name)} >/dev/null`
        )),
        `for helper in ${IMAGE_CONTRACT.networkHelpers.map((name) => JSON.stringify(name)).join(' ')}; do command -v "$helper" >/dev/null && exit 0; done`,
        'exit 97',
    ].join('\n');
    const result = await hostClient.execContainer({
        id: containerId,
        argv: ['/bin/bash', '-ceu', script],
        user: 'podman',
        workdir: '/workspace',
        env: {},
        journal,
        timeoutMs: 60_000,
        maxOutputBytes: 1024 * 1024,
    });
    if (result.exitCode !== 0) {
        throw supervisorError(
            `Box capability admission failed with status ${result.exitCode}; temporary host run is forbidden`,
            'PLOINKY_BOX_IMAGE_PROBE_FAILED',
        );
    }
    return Object.freeze(names);
}

function parseNestedImageInspect(result, descriptor) {
    let parsed;
    try {
        parsed = JSON.parse(String(result.stdout || ''));
    } catch (cause) {
        throw supervisorError(`Nested exact Node image inspection is malformed: ${cause.message}`);
    }
    const records = Array.isArray(parsed) ? parsed : [parsed];
    if (records.length !== 1) {
        throw supervisorError('Nested exact Node image inspection must contain one record');
    }
    return validateReleaseImageInspection('node', records[0], descriptor);
}

async function inspectNestedReleaseNodeImage(hostClient, containerId, descriptor, journal) {
    const result = await hostClient.execContainer({
        id: containerId,
        argv: ['podman', 'image', 'inspect', descriptor.nodeImageId],
        user: 'podman',
        workdir: '/workspace',
        env: {},
        journal,
        timeoutMs: 60_000,
        maxOutputBytes: 4 * 1024 * 1024,
    });
    if (result.exitCode !== 0) {
        const diagnostic = `${result?.stderr || ''}\n${result?.stdout || ''}`;
        if (/(?:image.*(?:not known|not found|does not exist)|no such image)/i.test(diagnostic)) {
            return null;
        }
        throw supervisorError('Nested runtime could not inspect the exact release Node image');
    }
    return parseNestedImageInspect(result, descriptor);
}

export async function admitReleaseNodeImage(engine, containerId, descriptor, runner, {
    stdout = process.stdout,
    stderr = process.stderr,
    timeoutMs = 1_800_000,
} = {}) {
    const hostClient = engine;
    const journal = runner;
    if (!/^[a-f0-9]{64}$/.test(String(containerId || ''))) {
        throw supervisorError('Release Node image admission requires the exact Box container ID');
    }
    if (!hostClient || typeof hostClient.inspectImage !== 'function'
        || typeof hostClient.exportImageToFile !== 'function'
        || typeof hostClient.putFileArchive !== 'function') {
        throw supervisorError('Release Node image admission requires the structured host transport');
    }
    validateReleaseImageInspection(
        'node', await hostClient.inspectImage(descriptor.nodeImageId), descriptor,
    );
    const existing = await inspectNestedReleaseNodeImage(
        hostClient, containerId, descriptor, journal,
    );
    if (existing) return existing;
    stderr?.write?.(`[ploinky] Admitting exact release Node image ${descriptor.nodeImageId} into Box ${containerId}...\n`);
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-node-admission-'));
    fs.chmodSync(temporaryRoot, 0o700);
    const archiveName = `node-${descriptor.nodeImageId.slice(0, 32)}.oci`;
    const hostArchive = path.join(temporaryRoot, archiveName);
    const boxDirectory = '/workspace/.ploinky/data/node-admission';
    const boxArchive = `${boxDirectory}/${archiveName}`;
    try {
        await hostClient.exportImageToFile(descriptor.nodeImageId, hostArchive, {
            maxBytes: 2 ** 31 - 1,
        });
        const hostDigest = await sha256File(hostArchive);
        const prepare = await hostClient.execContainer({
            id: containerId,
            argv: ['mkdir', '-p', boxDirectory],
            user: 'podman',
            workdir: '/workspace',
            env: {},
            journal,
            timeoutMs: 60_000,
        });
        if (prepare.exitCode !== 0) throw supervisorError('Nested image staging directory creation failed');
        await hostClient.putFileArchive({
            id: containerId,
            path: boxDirectory,
            name: archiveName,
            sourcePath: hostArchive,
            journal,
            maxBytes: 2 ** 31 - 1,
        });
        const stagedDigest = await hostClient.execContainer({
            id: containerId,
            argv: ['sha256sum', boxArchive],
            user: 'podman',
            workdir: '/workspace',
            env: {},
            journal,
            timeoutMs: 60_000,
        });
        if (stagedDigest.exitCode !== 0
            || String(stagedDigest.stdout).trim().split(/\s+/u)[0] !== hostDigest) {
            throw supervisorError('Nested image archive checksum verification failed');
        }
        const loaded = await hostClient.execContainer({
            id: containerId,
            argv: ['podman', 'image', 'load', '-i', boxArchive],
            user: 'podman',
            workdir: '/workspace',
            env: {},
            journal,
            timeoutMs,
            maxOutputBytes: 16 * 1024 * 1024,
        });
        if (loaded.exitCode !== 0) {
            throw supervisorError(`Exact release Node image admission failed with status ${loaded.exitCode}`);
        }
    } finally {
        try {
            await hostClient.execContainer({
                id: containerId,
                argv: ['rm', '-f', boxArchive],
                user: 'podman',
                workdir: '/workspace',
                env: {},
                journal,
                timeoutMs: 60_000,
            });
        } catch {}
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
    const admitted = await inspectNestedReleaseNodeImage(
        hostClient, containerId, descriptor, journal,
    );
    if (!admitted) throw supervisorError('Exact release Node image is missing after nested admission');
    return admitted;
}

export async function ensureBoxDependencies(engine, containerId, runner, {
    stdout = process.stdout,
    stderr = process.stderr,
    timeoutMs = 1_800_000,
} = {}) {
    const hostClient = engine;
    const journal = runner;
    const args = [
        '/opt/ploinky/bin/ploinky-install-deps',
    ];
    stderr?.write?.('[ploinky] Verifying and installing Box dependencies...\n');
    const result = await hostClient.execContainer({
        id: containerId,
        argv: args,
        user: 'podman',
        workdir: '/workspace',
        env: {},
        journal,
        timeoutMs,
        maxOutputBytes: 16 * 1024 * 1024,
    });
    if (result.stdout) stdout?.write?.(result.stdout);
    if (result.stderr) stderr?.write?.(result.stderr);
    if (result.exitCode !== 0) {
        throw supervisorError(`Box dependency installation failed with status ${result.exitCode}`);
    }
}

export function formatBoxStatus(status) {
    const lines = [
        `Ploinky Box: ${status.state}`,
        `Workspace identity: ${status.identity.instance}`,
    ];
    if (status.releaseDescriptor) {
        lines.push(`Release generation: ${status.releaseDescriptor.releaseGeneration}`);
        lines.push(`Node image: ${status.releaseDescriptor.nodeImageId}`);
    }
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
        for (const runtime of status.inbox.runtimes) {
            const task = runtime.role === 'provider-task' ? ` task=${runtime.taskId}` : '';
            const log = runtime.logPath ? ` log=${runtime.logPath}` : '';
            lines.push(`Runtime: ${runtime.runtime} ${runtime.role} ${runtime.effectiveInstance} ${runtime.state}${task}${log}`);
        }
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
        releaseDescriptor,
    } = {},
) {
    const hostClient = engine;
    const journal = runner;
    if (!Array.isArray(coreArgv) || !coreArgv.includes('start')) {
        throw supervisorError('Bounded core start requires normalized start argv');
    }
    const serializedRelease = releaseDescriptor
        ? serializeReleaseDescriptor(releaseDescriptor)
        : '';
    const result = await hostClient.execContainer({
        id: containerId,
        argv: [
        '/opt/ploinky/bin/ploinky-local',
        ...coreArgv,
        ],
        user: 'podman',
        workdir: '/workspace',
        env: {
            PLOINKY_ROUTER_HOST_PORT: String(hostPort),
            ...(releaseDescriptor ? { [RELEASE_DESCRIPTOR_ENV]: serializedRelease } : {}),
        },
        journal,
        timeoutMs,
        maxOutputBytes: 16 * 1024 * 1024,
    });
    if (result.stdout) stdout?.write?.(result.stdout);
    if (result.stderr) stderr?.write?.(result.stderr);
    if (result.exitCode !== 0) {
        throw supervisorError(`In-box start failed with status ${result.exitCode}`);
    }
    const externalDashboard = `http://127.0.0.1:${hostPort}/dashboard`;
    if (!String(result.stdout || '').includes(`[start] Dashboard: ${externalDashboard}`)) {
        throw supervisorError(`In-box start did not report the public Dashboard URL ${externalDashboard}`);
    }
    if (Number(hostPort) !== 8080
        && String(result.stdout || '').includes('[start] Dashboard: http://127.0.0.1:8080/dashboard')) {
        throw supervisorError('In-box start advertised its internal-only Dashboard URL');
    }
    return result.exitCode;
}

export function checkBoxHealth(hostPort, {
    httpGet,
    timeoutMs = 5_000,
    readinessTimeoutMs = 1_800_000,
    retryDelayMs = 1_000,
    maxResponseBytes = 64 * 1024,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
    if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs <= 0
        || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
        throw supervisorError('Public Box health bounds are invalid');
    }
    const deadline = Date.now() + readinessTimeoutMs;

    async function checkUntilReady() {
        while (true) {
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
        }
    }

    function checkOnce() {
        return new Promise((resolve) => {
            const selectedGet = httpGet || http.get;
            const remainingMs = Math.max(1, deadline - Date.now());
            const requestBudgetMs = Math.min(timeoutMs, remainingMs);
            let settled = false;
            let overallTimer;
            let request;
            const settle = (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(overallTimer);
                resolve(value);
            };
            try {
                request = selectedGet({
                    hostname: '127.0.0.1',
                    port: Number(hostPort),
                    path: '/health',
                    headers: { Host: `127.0.0.1:${hostPort}` },
                }, (response) => {
                    let body = '';
                    let bodyBytes = 0;
                    response.setEncoding('utf8');
                    response.on('data', (chunk) => {
                        if (settled) return;
                        bodyBytes += Buffer.byteLength(chunk, 'utf8');
                        if (bodyBytes > maxResponseBytes) {
                            response.destroy?.();
                            request?.destroy?.();
                            settle({
                                ready: false,
                                retryable: false,
                                message: 'Public Box health response exceeded its size limit',
                            });
                            return;
                        }
                        body += chunk;
                    });
                    response.on('error', (error) => settle({
                        ready: false,
                        retryable: true,
                        message: `Public Box health response failed: ${error.message}`,
                    }));
                    response.on('end', () => {
                        if (settled) return;
                        if (response.statusCode === 302 && body === 'Authentication required') {
                            try {
                                const location = new URL(
                                    String(response.headers?.location || ''),
                                    `http://127.0.0.1:${hostPort}`,
                                );
                                if (location.pathname === '/auth/login'
                                    && location.searchParams.get('returnTo') === '/health') {
                                    settle({ ready: true });
                                    return;
                                }
                            } catch (_) {}
                        }
                        try {
                            const health = JSON.parse(body);
                            if (response.statusCode === 200 && health.status === 'healthy') {
                                settle({ ready: true });
                                return;
                            }
                            const transitionCode = String(health.error || '');
                            if (response.statusCode === 503
                                && [
                                    'EDGE_GENERATION_INACTIVE',
                                    'EDGE_GENERATION_RUNTIME_MISMATCH',
                                    'edge_generation_changed',
                                ].includes(transitionCode)) {
                                settle({
                                    ready: false,
                                    retryable: true,
                                    message: `edge generation is not ready (${transitionCode})`,
                                });
                                return;
                            }
                            settle({
                                ready: false,
                                retryable: false,
                                message: `Public Box health check was unhealthy (HTTP ${response.statusCode})`,
                            });
                        } catch (error) {
                            settle({
                                ready: false,
                                retryable: false,
                                message: 'Public Box health response was malformed',
                            });
                        }
                    });
                });
                request.setTimeout?.(requestBudgetMs, () => request.destroy?.(new Error('health timeout')));
                request.on?.('error', (error) => settle({
                    ready: false,
                    retryable: ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.code)
                        || error?.message === 'health timeout',
                    message: `Public Box health check failed: ${error.message}`,
                }));
                overallTimer = setTimeout(() => {
                    request?.destroy?.(new Error('health deadline'));
                    settle({
                        ready: false,
                        retryable: true,
                        message: 'Public Box health request exceeded its bounded deadline',
                    });
                }, requestBudgetMs);
            } catch (error) {
                settle({
                    ready: false,
                    retryable: false,
                    message: `Public Box health check failed: ${error.message}`,
                });
            }
        });
    }

    return checkUntilReady();
}

export const defaultBoxSupervisor = createBoxSupervisor;
