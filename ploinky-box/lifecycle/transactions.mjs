import crypto from 'node:crypto';

import { BOX_LABELS } from '../constants.mjs';
import {
    inspectAndValidateDirectImage,
} from '../contract/image.mjs';
import {
    parseReleaseDescriptor,
    serializeReleaseDescriptor,
    validateReleaseImageInspection,
} from '../contract/release.mjs';
import { discoverBoxOwnership } from '../engine/discovery.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { preflightPublications } from '../ports.mjs';
import {
    ensureNamedVolumes,
    revalidateVolumeHandle,
    rollbackCreatedVolumes,
} from '../volumes.mjs';
import {
    buildOuterContainerDefinition,
    directContainerCreateSpec,
    removeContainerById,
    stopPloinkyLocalByContainerId,
    validateCreatedContainer,
    waitForReadySignal,
} from './container.mjs';
import { createOuterJournalStore } from './outerJournal.mjs';

function transactionError(message, cause, rollbackFailures = []) {
    const causeSuffix = cause?.message ? `: ${cause.message}` : '';
    const suffix = rollbackFailures.length > 0
        ? `; rollback failures: ${rollbackFailures.join('; ')}`
        : '';
    return new PloinkyBoxError(`${message}${causeSuffix}${suffix}`, {
        code: rollbackFailures.length > 0
            ? 'PLOINKY_BOX_TRANSACTION_ROLLBACK_FAILED'
            : 'PLOINKY_BOX_TRANSACTION_FAILED',
        cause,
    });
}

function cas(record) {
    return {
        generation: record.transaction.generation,
        containerId: record.container.id,
        revision: record.revision,
    };
}

function writeProgress(stderr, message) {
    stderr?.write?.(`[ploinky] ${message}\n`);
}

function exactRelease(value) {
    if (!value) {
        throw new PloinkyBoxError(
            'Managed outer Box creation requires one exact local release descriptor; mutable host pull is unsupported',
            { code: 'PLOINKY_RELEASE_DESCRIPTOR_REQUIRED' },
        );
    }
    return parseReleaseDescriptor(serializeReleaseDescriptor(value), {
        expectedControllerSourceSha: value.controllerSourceSha,
    });
}

function releaseFromHandle(container) {
    const serialized = String(container?.labels?.[BOX_LABELS.releaseDescriptor] || '');
    if (!serialized) {
        throw transactionError('Owned outer Box lacks an exact release descriptor');
    }
    return parseReleaseDescriptor(serialized);
}

function desiredFromHandle(identity, ownership, repositoryRoot) {
    const container = ownership.handles.container;
    const descriptor = releaseFromHandle(container);
    return Object.freeze({
        identity,
        hostPort: descriptor.routerHostPort,
        mediaHostPort: descriptor.mediaHostPort,
        imageRef: descriptor.boxImageId,
        imageId: descriptor.boxImageId,
        repositoryRoot,
        hostKind: ownership.engine.hostKind,
        releaseDescriptor: descriptor,
    });
}

function containerDefinition(record) {
    return {
        name: record.container.name,
        labels: record.container.labels,
        image: record.container.image,
        creation: record.container.creation,
    };
}

function candidateName(identity, generation) {
    const suffix = `-g-${generation.slice(0, 16)}`;
    return `${identity.instance.slice(0, 255 - suffix.length)}${suffix}`;
}

function makeIntent({
    identity,
    engine,
    definition,
    releaseDescriptor,
    predecessor,
}) {
    return {
        schemaVersion: 1,
        engine: {
            name: 'podman',
            identity: engine.identity,
            apiVersion: engine.apiVersion,
            hostKind: engine.hostKind,
            connection: { ...engine.connection },
        },
        workspace: {
            root: identity.workspaceRoot,
            owner: identity.instance,
            pathHash: identity.pathHash,
        },
        transaction: {
            id: `phase10x-${crypto.randomBytes(16).toString('hex')}`,
            generation: releaseDescriptor.releaseGeneration,
        },
        container: { ...definition, id: null },
        predecessor,
        createdResources: { container: false, volumes: [] },
        phase: 'intent',
        revision: 0,
    };
}

async function validateDirectReleaseImage(hostClient, kind, descriptor) {
    const imageId = kind === 'box' ? descriptor.boxImageId : descriptor.nodeImageId;
    const inspection = await hostClient.inspectImage(imageId);
    validateReleaseImageInspection(kind, inspection, descriptor);
    if (kind === 'box') await inspectAndValidateDirectImage(hostClient, imageId, imageId);
    return Object.freeze({ immutableId: imageId, inspection });
}

async function discoverOwned(identity, {
    platform,
    env,
    runner,
    hostClient,
    journalStore,
    discover,
}) {
    return discover(identity, {
        platform,
        env,
        runner,
        hostClient,
        outerJournal: journalStore,
    });
}

async function revalidateAllVolumes({
    engine,
    identity,
    handles,
    hostClient,
    lock,
}) {
    for (const key of ['workspace', 'containers', 'dependencies']) {
        await revalidateVolumeHandle(handles[key], {
            engine, identity, key, hostClient, lock,
        });
    }
}

function rollbackJournalFailure(store, journal, phase, rollbackFailures) {
    try {
        return store.update(cas(journal), { phase });
    } catch (error) {
        rollbackFailures.push(`journal ${phase}: ${error.message}`);
        return journal;
    }
}

async function rollbackCandidate({
    store,
    journal,
    hostClient,
    engine,
    identity,
    lock,
    volumeResult,
    candidateStarted,
    predecessor,
    restorePredecessorService,
    waitReady,
    afterRestore,
}) {
    const rollbackFailures = [];
    let current = rollbackJournalFailure(store, journal, 'rolling-back', rollbackFailures);
    let deletionProven = current.container.id === null;
    if (current.container.id) {
        try {
            if (candidateStarted) {
                await hostClient.stopContainer({
                    id: current.container.id,
                    timeout: 30,
                    journal: current,
                });
            }
            await removeContainerById(hostClient, current.container.id, current, { timeout: 30 });
            deletionProven = true;
        } catch (error) {
            deletionProven = false;
            rollbackFailures.push(`candidate deletion ambiguity: ${error.message}`);
            current = rollbackJournalFailure(store, current, 'deletion-ambiguous', rollbackFailures);
        }
    }
    if (!deletionProven) {
        return { journal: current, rollbackFailures, retained: true };
    }
    try {
        await rollbackCreatedVolumes({
            engine,
            identity,
            hostClient,
            lock,
            created: volumeResult?.created || [],
        });
        if (current.container.id === null && current.createdResources.volumes.length > 0) {
            current = store.update(cas(current), {
                createdResources: { container: false, volumes: [] },
                phase: 'rolling-back',
            });
        }
    } catch (error) {
        rollbackFailures.push(`volume rollback: ${error.message}`);
        current = rollbackJournalFailure(store, current, 'retaining-resources', rollbackFailures);
        return { journal: current, rollbackFailures, retained: true };
    }
    try {
        if (predecessor?.state === 'deleted') {
            if (typeof store.restorePredecessor !== 'function') {
                throw new Error('journal deleted-predecessor restoration is unavailable');
            }
            current = store.restorePredecessor(cas(current));
        } else if (predecessor) {
            const record = await hostClient.findContainerById(predecessor.id);
            if (!record) throw new Error('journaled predecessor is absent during rollback');
            const state = String(record.State ?? record.state ?? '').toLowerCase();
            const running = state === 'running';
            const stopped = ['configured', 'created', 'exited', 'stopped'].includes(state);
            if (!running && !stopped) {
                throw new Error(`journaled predecessor state is ambiguous (${state || 'unknown'})`);
            }
            if (predecessor.state === 'running' && !running) {
                await hostClient.startContainer({
                    id: predecessor.id,
                    journal: current,
                });
            } else if (predecessor.state === 'stopped' && running) {
                await hostClient.stopContainer({
                    id: predecessor.id,
                    timeout: 30,
                    journal: current,
                });
            }
            if (predecessor.state === 'running' && restorePredecessorService) {
                if (typeof waitReady !== 'function' || typeof afterRestore !== 'function') {
                    throw new Error(
                        'journaled predecessor service restoration is unavailable',
                    );
                }
                await waitReady(hostClient, predecessor.id, current);
                await afterRestore({
                    action: 'restored-predecessor',
                    containerId: predecessor.id,
                    hostClient,
                    journal: current,
                });
            }
            if (typeof store.restorePredecessor !== 'function') {
                throw new Error('journal predecessor restoration is unavailable');
            }
            current = store.restorePredecessor(cas(current));
        } else if (current.container.id === null) {
            if (typeof store.abandonIntent !== 'function') {
                throw new Error('journal intent abandonment is unavailable');
            }
            store.abandonIntent(cas(current));
        } else {
            store.retire(cas(current));
        }
    } catch (error) {
        rollbackFailures.push(`journal rollback: ${error.message}`);
        return { journal: current, rollbackFailures, retained: true };
    }
    return { journal: current, rollbackFailures, retained: false };
}

async function runContinuation(afterStart, context) {
    if (typeof afterStart !== 'function') {
        throw transactionError(
            'Outer Box transaction cannot commit before dependencies, edge, core, and final health verification',
        );
    }
    return afterStart(context);
}

export async function reconcileBoxContainer({
    identity,
    ownership,
    engine,
    runner,
    hostClient,
    lock,
    repositoryRoot,
    explicitPort,
    explicitMediaPort,
    localBoxImageId,
    releaseDescriptor,
    platform = process.platform,
    env = process.env,
    stderr = process.stderr,
    afterStart,
    afterRestore,
    outerJournal,
}, seams = {}) {
    lock.assertHeld(identity.instance);
    if (!['absent', 'owned'].includes(ownership?.state)) {
        throw transactionError(`Cannot mutate Box ownership state ${ownership?.state || 'unknown'}`);
    }
    if (explicitMediaPort !== undefined || localBoxImageId !== undefined) {
        throw new PloinkyBoxError(
            'Loose local Box image/media inputs are retired; use one release descriptor',
            { code: 'PLOINKY_RELEASE_DESCRIPTOR_REQUIRED' },
        );
    }
    if (!hostClient) throw transactionError('Structured Podman host transport is unavailable');
    const selectedRelease = exactRelease(releaseDescriptor);
    if (explicitPort !== undefined && explicitPort !== null
        && Number(explicitPort) !== selectedRelease.routerHostPort) {
        throw new PloinkyBoxError('Release descriptor owns the exact Router host port', {
            code: 'PLOINKY_RELEASE_DESCRIPTOR_INVALID',
        });
    }
    const dependencies = {
        discover: seams.discover || discoverBoxOwnership,
        preflight: seams.preflight || preflightPublications,
        validateImage: seams.validateImage || validateDirectReleaseImage,
        ensureVolumes: seams.ensureVolumes || ensureNamedVolumes,
        revalidateVolumes: seams.revalidateVolumes || revalidateAllVolumes,
        rollbackVolumes: seams.rollbackVolumes || rollbackCreatedVolumes,
        waitReady: seams.waitReady || waitForReadySignal,
    };
    const journalStore = outerJournal || createOuterJournalStore({
        workspaceRoot: identity.workspaceRoot,
    });
    let currentContainer = ownership.handles?.container || null;
    let currentJournal = ownership.journal || journalStore.read({ allowMissing: true });
    if (currentContainer
        && ['predecessor-deleting', 'predecessor-deleted'].includes(currentJournal?.phase)) {
        if (currentJournal.transaction.generation !== selectedRelease.releaseGeneration
            || !currentJournal.predecessor) {
            throw transactionError(
                'Interrupted replacement recovery requires its exact candidate generation and predecessor journal',
            );
        }
        if (currentJournal.phase === 'predecessor-deleting') {
            const predecessorRecord = await hostClient.findContainerById(
                currentJournal.predecessor.id,
            );
            if (predecessorRecord) {
                const predecessorState = String(
                    predecessorRecord.State ?? predecessorRecord.state ?? '',
                ).toLowerCase();
                if (!['configured', 'created', 'exited', 'stopped'].includes(predecessorState)) {
                    throw transactionError(
                        `Interrupted replacement predecessor state is ambiguous (${predecessorState || 'unknown'})`,
                    );
                }
                await removeContainerById(
                    hostClient,
                    currentJournal.predecessor.id,
                    currentJournal,
                    { timeout: 30 },
                );
            }
            if (typeof journalStore.markPredecessorDeleted !== 'function') {
                throw transactionError('Outer Box predecessor deletion publication is unavailable');
            }
            currentJournal = journalStore.markPredecessorDeleted(cas(currentJournal));
        }
        currentJournal = journalStore.commitCandidate(cas(currentJournal));
        let recoveredOwnership = await discoverOwned(identity, {
            platform, env, runner, hostClient, journalStore, discover: dependencies.discover,
        });
        const recovered = desiredFromHandle(identity, recoveredOwnership, repositoryRoot);
        validateCreatedContainer(recoveredOwnership, recovered);
        await dependencies.revalidateVolumes({
            engine,
            identity,
            handles: recoveredOwnership.handles.volumes,
            hostClient,
            lock,
        });
        const recoveredContainer = recoveredOwnership.handles.container;
        if (!recoveredContainer.runtime.running) {
            await hostClient.startContainer({
                id: recoveredContainer.id,
                journal: recoveredOwnership.journal,
            });
            await dependencies.waitReady(
                hostClient,
                recoveredContainer.id,
                recoveredOwnership.journal,
            );
        }
        await runContinuation(afterStart, {
            action: 'recovered',
            containerId: recoveredContainer.id,
            hostClient,
            journal: recoveredOwnership.journal,
            advance: async () => recoveredOwnership.journal,
        });
        recoveredOwnership = await discoverOwned(identity, {
            platform, env, runner, hostClient, journalStore, discover: dependencies.discover,
        });
        validateCreatedContainer(recoveredOwnership, recovered);
        return Object.freeze({
            action: 'recovered',
            ownership: recoveredOwnership,
            hostPort: recovered.hostPort,
            mediaHostPort: recovered.mediaHostPort,
            imageId: recovered.imageId,
            releaseGeneration: recovered.releaseDescriptor.releaseGeneration,
        });
    }
    if (currentContainer && (!currentJournal || currentJournal.phase !== 'committed')) {
        throw transactionError('Owned Box mutation requires one committed exact-generation journal');
    }
    if (!currentContainer && currentJournal
        && (!['container-deleted', 'retaining-resources'].includes(currentJournal.phase)
            || currentJournal.createdResources.container
            || !/^[a-f0-9]{64}$/.test(String(currentJournal.container.id || '')))) {
        throw transactionError(
            'Container-free Box mutation requires one exact deleted-generation journal',
        );
    }
    const old = currentContainer
        ? desiredFromHandle(identity, ownership, repositoryRoot)
        : null;
    if (old) {
        validateCreatedContainer(ownership, old);
        await dependencies.validateImage(hostClient, 'box', old.releaseDescriptor);
    }
    await dependencies.validateImage(hostClient, 'box', selectedRelease);
    await dependencies.validateImage(hostClient, 'node', selectedRelease);

    const requiresReplacement = Boolean(old)
        && old.releaseDescriptor.releaseGeneration !== selectedRelease.releaseGeneration;
    if (old && !requiresReplacement) {
        await dependencies.revalidateVolumes({
            engine,
            identity,
            handles: ownership.handles.volumes,
            hostClient,
            lock,
        });
        const startedForReuse = !currentContainer.runtime.running;
        try {
            if (startedForReuse) {
                writeProgress(stderr, `Starting existing Box container ${currentJournal.container.name}...`);
                await hostClient.startContainer({
                    id: currentContainer.id,
                    journal: currentJournal,
                });
                await dependencies.waitReady(hostClient, currentContainer.id, currentJournal);
            }
            await runContinuation(afterStart, {
                action: 'reused',
                containerId: currentContainer.id,
                hostClient,
                journal: currentJournal,
                advance: async () => currentJournal,
            });
            const finalOwnership = await discoverOwned(identity, {
                platform, env, runner, hostClient, journalStore, discover: dependencies.discover,
            });
            validateCreatedContainer(finalOwnership, old);
            return Object.freeze({
                action: 'reused',
                ownership: finalOwnership,
                hostPort: old.hostPort,
                mediaHostPort: old.mediaHostPort,
                imageId: old.imageId,
                releaseGeneration: old.releaseDescriptor.releaseGeneration,
            });
        } catch (error) {
            const rollbackFailures = [];
            if (startedForReuse) {
                try {
                    await hostClient.stopContainer({
                        id: currentContainer.id,
                        timeout: 30,
                        journal: currentJournal,
                    });
                } catch (rollbackError) {
                    rollbackFailures.push(`reused Box stop: ${rollbackError.message}`);
                }
            }
            throw transactionError('Existing Box reuse transaction failed', error, rollbackFailures);
        }
    }

    await dependencies.preflight({
        hostPort: selectedRelease.routerHostPort,
        mediaHostPort: selectedRelease.mediaHostPort,
        existingPublication: old
            ? { hostPort: old.hostPort, mediaHostPort: old.mediaHostPort }
            : null,
    });
    const definition = buildOuterContainerDefinition({
        identity,
        imageId: selectedRelease.boxImageId,
        imageRef: selectedRelease.boxImageId,
        hostPort: selectedRelease.routerHostPort,
        mediaHostPort: selectedRelease.mediaHostPort,
        repositoryRoot,
        hostKind: engine.hostKind,
        releaseDescriptor: selectedRelease,
        containerName: candidateName(identity, selectedRelease.releaseGeneration),
    });
    const predecessor = currentJournal ? {
        id: currentJournal.container.id,
        state: old
            ? (currentContainer.runtime.running ? 'running' : 'stopped')
            : 'deleted',
        transaction: currentJournal.transaction,
        revision: currentJournal.revision,
        container: containerDefinition(currentJournal),
        createdResources: currentJournal.createdResources,
    } : null;
    const intent = makeIntent({
        identity,
        engine,
        definition,
        releaseDescriptor: selectedRelease,
        predecessor,
    });
    let journal = currentJournal
        ? journalStore.replaceIntent(cas(currentJournal), intent)
        : journalStore.create(intent);
    let volumeResult = { handles: {}, created: [] };
    let candidateStarted = false;
    let predecessorDeleted = false;
    let predecessorDeleteAttempted = false;
    let predecessorQuiesceAttempted = false;
    let createAttempted = false;
    try {
        volumeResult = await dependencies.ensureVolumes({
            engine,
            identity,
            hostClient,
            lock,
            knownHandles: ownership.handles?.volumes || {},
        });
        journal = journalStore.update(cas(journal), {
            createdResources: {
                container: false,
                volumes: [...new Set([
                    ...(predecessor?.createdResources?.volumes || []),
                    ...volumeResult.created.map((entry) => entry.handle.name),
                ])],
            },
            phase: 'resources-created',
        });
        writeProgress(stderr, `Creating Box candidate ${journal.container.name}...`);
        createAttempted = true;
        const created = await hostClient.createContainer(directContainerCreateSpec(definition));
        journal = journalStore.publishContainerId(cas(journal), created.id);
        if (!Array.isArray(created.warnings) || created.warnings.length !== 0) {
            throw transactionError(
                'Direct Box creation returned warnings for the immutable creation tuple',
            );
        }
        // Close the Specgen named-volume no-create gap before starting. Any
        // missing-label implicit volume remains journaled and is never guessed
        // safe for cleanup.
        await dependencies.revalidateVolumes({
            engine,
            identity,
            handles: volumeResult.handles,
            hostClient,
            lock,
        });
        if (predecessor?.state === 'running') {
            journal = journalStore.update(cas(journal), {
                phase: 'predecessor-quiescing',
            });
            predecessorQuiesceAttempted = true;
            await stopPloinkyLocalByContainerId(hostClient, predecessor.id, journal);
            await hostClient.stopContainer({
                id: predecessor.id,
                timeout: 30,
                journal,
            });
            journal = journalStore.update(cas(journal), {
                phase: 'predecessor-quiesced',
            });
        }
        await hostClient.startContainer({ id: created.id, journal });
        candidateStarted = true;
        journal = journalStore.update(cas(journal), { phase: 'candidate-started' });
        await dependencies.waitReady(hostClient, created.id, journal);
        const advance = async (phase) => {
            journal = journalStore.update(cas(journal), { phase });
            return journal;
        };
        await runContinuation(afterStart, {
            action: old ? 'replaced' : 'created',
            containerId: created.id,
            hostClient,
            get journal() { return journal; },
            advance,
        });
        if (journal.phase !== 'health-verified') {
            throw transactionError('Outer Box continuation did not reach final health verification');
        }
        if (predecessor && predecessor.state !== 'deleted') {
            journal = journalStore.update(cas(journal), {
                phase: 'predecessor-deleting',
            });
            predecessorDeleteAttempted = true;
            await removeContainerById(hostClient, predecessor.id, journal, { timeout: 30 });
            predecessorDeleted = true;
            if (typeof journalStore.markPredecessorDeleted !== 'function') {
                throw transactionError('Outer Box predecessor deletion publication is unavailable');
            }
            journal = journalStore.markPredecessorDeleted(cas(journal));
        }
        if (typeof journalStore.commitCandidate !== 'function') {
            throw transactionError('Outer Box journal candidate commit is unavailable');
        }
        journal = journalStore.commitCandidate(cas(journal));
        const finalOwnership = await discoverOwned(identity, {
            platform, env, runner, hostClient, journalStore, discover: dependencies.discover,
        });
        const desired = {
            identity,
            hostPort: selectedRelease.routerHostPort,
            mediaHostPort: selectedRelease.mediaHostPort,
            imageId: selectedRelease.boxImageId,
            imageRef: selectedRelease.boxImageId,
            repositoryRoot,
            hostKind: engine.hostKind,
            releaseDescriptor: selectedRelease,
        };
        validateCreatedContainer(finalOwnership, desired);
        return Object.freeze({
            action: old ? 'replaced' : 'created',
            ownership: finalOwnership,
            hostPort: selectedRelease.routerHostPort,
            mediaHostPort: selectedRelease.mediaHostPort,
            imageId: selectedRelease.boxImageId,
            releaseGeneration: selectedRelease.releaseGeneration,
        });
    } catch (error) {
        const createdFromError = Array.isArray(error?.createdVolumes)
            ? [...error.createdVolumes]
            : [];
        const ambiguousVolumeNames = Array.isArray(error?.ambiguousVolumeNames)
            ? [...error.ambiguousVolumeNames]
            : [];
        if (createdFromError.length > 0 && volumeResult.created.length === 0) {
            volumeResult = {
                handles: Object.fromEntries(createdFromError.map((entry) => [entry.key, entry.handle])),
                created: createdFromError,
            };
        }
        if (journal.container.id === null
            && (createdFromError.length > 0 || ambiguousVolumeNames.length > 0)
            && journal.createdResources.volumes.length === 0) {
            const possibleNames = [...new Set([
                ...createdFromError.map((entry) => entry.handle.name),
                ...ambiguousVolumeNames,
            ])];
            try {
                journal = journalStore.update(cas(journal), {
                    createdResources: { container: false, volumes: possibleNames },
                    phase: 'resources-created',
                });
            } catch (journalError) {
                throw transactionError(
                    'Box resource creation failed and its ownership journal could not record possible resources',
                    error,
                    [journalError.message],
                );
            }
        }
        if (ambiguousVolumeNames.length > 0) {
            const rollbackFailures = [
                `ambiguous volume creation retained: ${ambiguousVolumeNames.join(', ')}`,
            ];
            journal = rollbackJournalFailure(
                journalStore, journal, 'rolling-back', rollbackFailures,
            );
            rollbackJournalFailure(
                journalStore, journal, 'retaining-resources', rollbackFailures,
            );
            throw transactionError(
                'Box container transaction retained resources after ambiguous volume creation',
                error,
                rollbackFailures,
            );
        }
        if (createAttempted && journal.container.id === null) {
            const rollbackFailures = ['ambiguous container creation retained by exact name and labels'];
            journal = rollbackJournalFailure(
                journalStore, journal, 'rolling-back', rollbackFailures,
            );
            rollbackJournalFailure(
                journalStore, journal, 'retaining-resources', rollbackFailures,
            );
            throw transactionError(
                'Box container create outcome is ambiguous; journal and volumes were retained',
                error,
                rollbackFailures,
            );
        }
        // Once predecessor deletion is proven, the fully health-verified
        // candidate is the only recoverable generation: commit it rather than
        // pretending the removed predecessor can be restored.
        if (predecessorDeleted) {
            try {
                if (journal.phase === 'predecessor-deleting') {
                    journal = journalStore.markPredecessorDeleted(cas(journal));
                }
                journalStore.commitCandidate(cas(journal));
            } catch {}
        }
        if (predecessorDeleteAttempted && !predecessorDeleted) {
            const rollbackFailures = [
                'predecessor deletion outcome is ambiguous; candidate and journal retained',
            ];
            rollbackJournalFailure(
                journalStore,
                journal,
                'deletion-ambiguous',
                rollbackFailures,
            );
            throw transactionError(
                'Box replacement retained its health-verified candidate after ambiguous predecessor deletion',
                error,
                rollbackFailures,
            );
        }
        const rollback = predecessorDeleted
            ? { rollbackFailures: ['predecessor was already proven deleted'], retained: true }
            : await rollbackCandidate({
                store: journalStore,
                journal,
                hostClient,
                engine,
                identity,
                lock,
                volumeResult,
                candidateStarted,
                predecessor,
                restorePredecessorService: predecessorQuiesceAttempted,
                waitReady: dependencies.waitReady,
                afterRestore,
            });
        throw transactionError('Box container transaction failed', error, rollback.rollbackFailures);
    }
}
