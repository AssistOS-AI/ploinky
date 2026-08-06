import crypto from 'node:crypto';
import fs from 'node:fs';

import { BOX_IMAGE_REFERENCE } from '../constants.mjs';
import { validateContainerConfiguration } from '../contract/container.mjs';
import {
    inspectAndValidateReleaseImage,
    parseReleaseDescriptor,
    serializeReleaseDescriptor,
} from '../contract/release.mjs';
import {
    inspectAndValidateExistingImage,
    inspectAndValidateImage,
} from '../contract/image.mjs';
import { discoverBoxOwnership } from '../engine/discovery.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { preflightPublications, resolveEffectiveHostPort } from '../ports.mjs';
import {
    ensureNamedVolumes,
    rollbackCreatedVolumes,
} from '../volumes.mjs';
import {
    containerCreateArgs,
    readContainerIdFromCidfile,
    removeContainerById,
    revalidateAllVolumes,
    secureCidfilePath,
    stopPloinkyLocalByContainerId,
    validateCreatedContainer,
    waitForReadyLine,
} from './container.mjs';

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

function oldDesired(identity, ownership, repositoryRoot, engine) {
    const container = ownership.handles.container;
    const hostPort = Number(container.labels['io.assistos.ploinky-box.router-host-port']);
    const mediaHostPort = Number(container.labels['io.assistos.ploinky-box.media-host-port']);
    const imageRef = container.labels['io.assistos.ploinky-box.image-ref'];
    const imageId = container.runtime.imageId;
    const serializedRelease = String(
        container.labels['io.assistos.ploinky-box.release-descriptor'] || '',
    );
    const releaseDescriptor = serializedRelease
        ? parseReleaseDescriptor(serializedRelease)
        : null;
    const desired = {
        identity,
        hostPort,
        mediaHostPort,
        imageRef,
        imageId,
        repositoryRoot,
        hostKind: engine.hostKind,
        ...(releaseDescriptor ? { releaseDescriptor } : {}),
    };
    validateContainerConfiguration(container, desired);
    return Object.freeze(desired);
}

function cleanCidfile(cidfile, fsApi) {
    try { fsApi.unlinkSync(cidfile); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

function writeProgress(stderr, message) {
    stderr?.write?.(`[ploinky] ${message}\n`);
}

async function pullBoxImage(engine, imageRef, runner, {
    stdout = process.stdout,
    stderr = process.stderr,
    timeoutMs = 1_800_000,
} = {}) {
    writeProgress(stderr, `Pulling Box image ${imageRef}...`);
    if (typeof runner.stream !== 'function') {
        runner.run(engine.name, ['pull', imageRef]);
        return;
    }
    const result = await runner.stream(engine.name, ['pull', imageRef], {
        timeoutMs,
        stdout,
        stderr,
    });
    if (!result.ok) {
        throw new PloinkyBoxError(
            `Box image pull failed with status ${result.status}`,
            { code: 'PLOINKY_BOX_IMAGE_PULL_FAILED', cause: result.error || undefined },
        );
    }
}

async function createAndStart({
    engine,
    identity,
    image,
    imageRef,
    hostPort,
    mediaHostPort,
    repositoryRoot,
    runner,
    lock,
    volumeHandles,
    discover,
    waitReady,
    revalidateVolumes,
    readCidfile,
    fsApi,
    token,
    stdout,
    stderr,
    releaseDescriptor,
}) {
    lock.assertHeld(identity.instance);
    revalidateVolumes({ engine, identity, handles: volumeHandles, runner, lock });
    const cidfile = secureCidfilePath(lock, token);
    cleanCidfile(cidfile, fsApi);
    writeProgress(stderr, `Creating Box container ${identity.instance}...`);
    runner.run(engine.name, containerCreateArgs({
        identity,
        imageId: image.immutableId,
        imageRef,
        hostPort,
        mediaHostPort,
        repositoryRoot,
        cidfile,
        hostKind: engine.hostKind,
        releaseDescriptor,
    }));
    let containerId;
    try {
        containerId = readCidfile(cidfile, { fsApi });
    } catch (cidfileError) {
        const recovered = discover(identity, { runner });
        const recoveredHandle = recovered?.state === 'owned'
            ? recovered.handles?.container
            : null;
        if (!recoveredHandle || recoveredHandle.runtime?.imageId !== image.immutableId) {
            throw cidfileError;
        }
        containerId = recoveredHandle.id;
    } finally {
        cleanCidfile(cidfile, fsApi);
    }
    writeProgress(stderr, `Starting Box container ${identity.instance}; streaming startup logs...`);
    runner.run(engine.name, ['container', 'start', containerId]);
    await waitReady(engine, containerId, runner, { stdout, stderr });
    const finalOwnership = discover(identity, { runner });
    const handle = validateCreatedContainer(finalOwnership, {
        identity,
        hostPort,
        mediaHostPort,
        imageId: image.immutableId,
        imageRef,
        repositoryRoot,
        hostKind: engine.hostKind,
        releaseDescriptor,
    });
    if (handle.id !== containerId) {
        throw transactionError('Created Box immutable ID changed during final validation');
    }
    return { containerId, ownership: finalOwnership };
}

async function restoreOldContainer({
    engine,
    identity,
    old,
    runner,
    lock,
    volumeHandles,
    dependencies,
    stdout,
    stderr,
}) {
    return createAndStart({
        engine,
        identity,
        image: { immutableId: old.imageId },
        imageRef: old.imageRef,
        hostPort: old.hostPort,
        mediaHostPort: old.mediaHostPort,
        repositoryRoot: old.repositoryRoot,
        runner,
        lock,
        volumeHandles,
        discover: dependencies.discover,
        waitReady: dependencies.waitReady,
        revalidateVolumes: dependencies.revalidateVolumes,
        readCidfile: dependencies.readCidfile,
        fsApi: dependencies.fsApi,
        token: dependencies.token('restore'),
        stdout,
        stderr,
        releaseDescriptor: old.releaseDescriptor || null,
    });
}

export async function reconcileBoxContainer({
    identity,
    ownership,
    engine,
    runner,
    lock,
    repositoryRoot,
    explicitPort,
    explicitMediaPort,
    localBoxImageId,
    releaseDescriptor = null,
    imageRef = BOX_IMAGE_REFERENCE,
    platform = process.platform,
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    admitNodeImage = null,
}, seams = {}) {
    lock.assertHeld(identity.instance);
    if (!['absent', 'owned'].includes(ownership?.state)) {
        throw transactionError(`Cannot mutate Box ownership state ${ownership?.state || 'unknown'}`);
    }
    const dependencies = {
        discover: seams.discover || ((selectedIdentity) => discoverBoxOwnership(selectedIdentity, {
            platform, env, runner,
        })),
        preflight: seams.preflight || preflightPublications,
        validateImage: seams.validateImage || inspectAndValidateImage,
        validateExistingImage: seams.validateExistingImage || inspectAndValidateExistingImage,
        validateReleaseImage: seams.validateReleaseImage || inspectAndValidateReleaseImage,
        ensureVolumes: seams.ensureVolumes || ensureNamedVolumes,
        rollbackVolumes: seams.rollbackVolumes || rollbackCreatedVolumes,
        revalidateVolumes: seams.revalidateVolumes || revalidateAllVolumes,
        removeContainer: seams.removeContainer || removeContainerById,
        stopPloinkyLocal: seams.stopPloinkyLocal || stopPloinkyLocalByContainerId,
        waitReady: seams.waitReady || waitForReadyLine,
        readCidfile: seams.readCidfile || readContainerIdFromCidfile,
        fsApi: seams.fsApi || fs,
        token: seams.token || (() => crypto.randomBytes(12).toString('hex')),
        admitNodeImage: seams.admitNodeImage || admitNodeImage,
    };
    let selectedRelease = null;
    if (releaseDescriptor) {
        selectedRelease = parseReleaseDescriptor(serializeReleaseDescriptor(releaseDescriptor), {
            expectedControllerSourceSha: releaseDescriptor.controllerSourceSha,
        });
    }
    if (localBoxImageId !== undefined && localBoxImageId !== null) {
        throw new PloinkyBoxError(
            'Loose local Box image admission is retired; use one release descriptor',
            { code: 'PLOINKY_RELEASE_DESCRIPTOR_REQUIRED' },
        );
    }
    if (explicitMediaPort !== undefined && explicitMediaPort !== null) {
        throw new PloinkyBoxError(
            'Loose media-port admission is retired; use one release descriptor',
            { code: 'PLOINKY_RELEASE_DESCRIPTOR_REQUIRED' },
        );
    }
    const selectedLocalImageId = selectedRelease?.boxImageId || null;
    const desiredImageRef = selectedRelease?.boxImageId || imageRef;
    if (selectedRelease
        && explicitPort !== undefined && explicitPort !== null
        && Number(explicitPort) !== selectedRelease.routerHostPort) {
        throw new PloinkyBoxError(
            'Release descriptor owns the exact Router and media host ports',
            { code: 'PLOINKY_RELEASE_DESCRIPTOR_INVALID' },
        );
    }
    const portPlan = resolveEffectiveHostPort({
        explicitPort: selectedRelease?.routerHostPort ?? explicitPort,
        explicitMediaPort: selectedRelease?.mediaHostPort,
        ownership,
    });
    const currentContainer = ownership.handles?.container || null;
    const old = currentContainer ? oldDesired(identity, ownership, repositoryRoot, engine) : null;
    if (old) {
        dependencies.validateExistingImage(engine.name, old.imageId, old.imageRef, runner);
        if (old.releaseDescriptor) {
            dependencies.validateReleaseImage(engine.name, 'box', old.releaseDescriptor, runner);
            dependencies.validateReleaseImage(engine.name, 'node', old.releaseDescriptor, runner);
        }
    }
    const requiresReplacement = Boolean(old) && (
        old.hostPort !== portPlan.hostPort
        || old.mediaHostPort !== portPlan.mediaHostPort
        || old.imageRef !== desiredImageRef
        || (selectedLocalImageId !== null && old.imageId !== selectedLocalImageId)
        || (selectedRelease !== null
            && old.releaseDescriptor?.releaseGeneration !== selectedRelease.releaseGeneration)
    );
    if (old && !requiresReplacement) {
        dependencies.revalidateVolumes({
            engine,
            identity,
            handles: ownership.handles.volumes,
            runner,
            lock,
        });
        const startedForReuse = !currentContainer.runtime.running;
        try {
            if (startedForReuse) {
                writeProgress(stderr, `Starting existing Box container ${identity.instance}; streaming startup logs...`);
                runner.run(engine.name, ['container', 'start', currentContainer.id]);
                await dependencies.waitReady(engine, currentContainer.id, runner, { stdout, stderr });
            }
            if (old.releaseDescriptor) {
                if (typeof dependencies.admitNodeImage !== 'function') {
                    throw transactionError('Release Node image admission is unavailable');
                }
                await dependencies.admitNodeImage(
                    engine,
                    currentContainer.id,
                    old.releaseDescriptor,
                    runner,
                    { stdout, stderr },
                );
            }
            const finalOwnership = dependencies.discover(identity, { runner });
            validateCreatedContainer(finalOwnership, old);
            return Object.freeze({
                action: 'reused',
                ownership: finalOwnership,
                hostPort: old.hostPort,
                mediaHostPort: old.mediaHostPort,
                imageId: old.imageId,
                releaseGeneration: old.releaseDescriptor?.releaseGeneration || null,
            });
        } catch (error) {
            const rollbackFailures = [];
            if (startedForReuse) {
                try {
                    runner.run(engine.name, [
                        'container', 'stop', '--time', '30', currentContainer.id,
                    ]);
                } catch (rollbackError) {
                    rollbackFailures.push(`reused Box stop: ${rollbackError.message}`);
                }
            }
            throw transactionError('Existing Box reuse transaction failed', error, rollbackFailures);
        }
    }

    await dependencies.preflight({
        hostPort: portPlan.hostPort,
        mediaHostPort: portPlan.mediaHostPort,
        existingPublication: portPlan.existingPublication,
    });
    if (selectedLocalImageId === null) {
        await pullBoxImage(engine, imageRef, runner, { stdout, stderr });
    } else {
        writeProgress(stderr, `Validating release Box image ${selectedLocalImageId} without pulling...`);
    }
    const selectedImageRef = selectedLocalImageId || imageRef;
    if (selectedRelease) {
        dependencies.validateReleaseImage(engine.name, 'box', selectedRelease, runner);
        dependencies.validateReleaseImage(engine.name, 'node', selectedRelease, runner);
    }
    const image = dependencies.validateImage(engine.name, selectedImageRef, runner, {
        identity,
        releaseDescriptor: selectedRelease,
    });
    if (selectedLocalImageId !== null && image.immutableId !== selectedLocalImageId) {
        throw new PloinkyBoxError(
            'Release Box image inspection did not return the descriptor image ID',
            { code: 'PLOINKY_RELEASE_IMAGE_STALE' },
        );
    }
    let volumeResult;
    try {
        volumeResult = dependencies.ensureVolumes({
            engine,
            identity,
            runner,
            lock,
            knownHandles: ownership.handles?.volumes || {},
        });
    } catch (error) {
        const rollbackFailures = [];
        if (error.createdVolumes?.length) {
            try {
                dependencies.rollbackVolumes({
                    engine, identity, runner, lock, created: error.createdVolumes,
                });
            } catch (rollbackError) {
                rollbackFailures.push(rollbackError.message);
            }
        }
        throw transactionError('Named-volume preparation failed', error, rollbackFailures);
    }

    let candidateId = '';
    let oldRemoved = false;
    try {
        if (old) {
            if (currentContainer.runtime.running) {
                dependencies.stopPloinkyLocal(engine, currentContainer.id, runner);
                runner.run(engine.name, ['container', 'stop', '--time', '30', currentContainer.id]);
            }
            dependencies.removeContainer(engine, currentContainer.id, runner);
            oldRemoved = true;
        }
        const created = await createAndStart({
            engine,
            identity,
            image,
            imageRef: desiredImageRef,
            hostPort: portPlan.hostPort,
            mediaHostPort: portPlan.mediaHostPort,
            repositoryRoot,
            runner,
            lock,
            volumeHandles: volumeResult.handles,
            discover: dependencies.discover,
            waitReady: dependencies.waitReady,
            revalidateVolumes: dependencies.revalidateVolumes,
            readCidfile: dependencies.readCidfile,
            fsApi: dependencies.fsApi,
            token: dependencies.token('candidate'),
            stdout,
            stderr,
            releaseDescriptor: selectedRelease,
        });
        candidateId = created.containerId;
        if (selectedRelease) {
            if (typeof dependencies.admitNodeImage !== 'function') {
                throw new Error('Release Node image admission is unavailable');
            }
            await dependencies.admitNodeImage(
                engine,
                candidateId,
                selectedRelease,
                runner,
                { stdout, stderr },
            );
        }
        return Object.freeze({
            action: old ? 'replaced' : 'created',
            ownership: created.ownership,
            hostPort: portPlan.hostPort,
            mediaHostPort: portPlan.mediaHostPort,
            imageId: image.immutableId,
            releaseGeneration: selectedRelease?.releaseGeneration || null,
        });
    } catch (error) {
        const rollbackFailures = [];
        if (!candidateId && (!old || oldRemoved)) {
            const recovered = dependencies.discover(identity, { runner });
            const candidate = recovered?.state === 'owned'
                ? recovered.handles?.container
                : null;
            if (candidate?.runtime?.imageId === image.immutableId) {
                candidateId = candidate.id;
            }
        }
        if (candidateId) {
            try { dependencies.removeContainer(engine, candidateId, runner); } catch (removeError) {
                rollbackFailures.push(`candidate removal: ${removeError.message}`);
            }
        }
        if (oldRemoved) {
            try {
                const restored = await restoreOldContainer({
                    engine,
                    identity,
                    old,
                    runner,
                    lock,
                    volumeHandles: volumeResult.handles,
                    dependencies,
                    stdout,
                    stderr,
                });
                if (old.releaseDescriptor) {
                    if (typeof dependencies.admitNodeImage !== 'function') {
                        throw new Error('Prior release Node image admission is unavailable');
                    }
                    await dependencies.admitNodeImage(
                        engine,
                        restored.containerId,
                        old.releaseDescriptor,
                        runner,
                        { stdout, stderr },
                    );
                }
            } catch (restoreError) {
                rollbackFailures.push(`old Box restoration: ${restoreError.message}`);
            }
        } else if (!old && volumeResult.created.length > 0) {
            try {
                dependencies.rollbackVolumes({
                    engine, identity, runner, lock, created: volumeResult.created,
                });
            } catch (volumeError) {
                rollbackFailures.push(`named volumes: ${volumeError.message}`);
            }
        }
        throw transactionError('Box container transaction failed', error, rollbackFailures);
    }
}
