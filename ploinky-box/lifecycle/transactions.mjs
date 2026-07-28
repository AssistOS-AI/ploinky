import crypto from 'node:crypto';
import fs from 'node:fs';

import { BOX_IMAGE_REFERENCE } from '../constants.mjs';
import { validateContainerConfiguration } from '../contract/container.mjs';
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
    const imageRef = container.labels['io.assistos.ploinky-box.image-ref'];
    const imageId = container.runtime.imageId;
    const desired = {
        identity,
        hostPort,
        imageRef,
        imageId,
        repositoryRoot,
        hostKind: engine.hostKind,
    };
    validateContainerConfiguration(container, desired);
    return Object.freeze(desired);
}

function cleanCidfile(cidfile, fsApi) {
    try { fsApi.unlinkSync(cidfile); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

async function createAndStart({
    engine,
    identity,
    image,
    imageRef,
    hostPort,
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
}) {
    lock.assertHeld(identity.instance);
    revalidateVolumes({ engine, identity, handles: volumeHandles, runner, lock });
    const cidfile = secureCidfilePath(lock, token);
    cleanCidfile(cidfile, fsApi);
    runner.run(engine.name, containerCreateArgs({
        identity,
        imageId: image.immutableId,
        imageRef,
        hostPort,
        repositoryRoot,
        cidfile,
        hostKind: engine.hostKind,
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
    runner.run(engine.name, ['container', 'start', containerId]);
    await waitReady(engine, containerId, runner);
    const finalOwnership = discover(identity, { runner });
    const handle = validateCreatedContainer(finalOwnership, {
        identity,
        hostPort,
        imageId: image.immutableId,
        imageRef,
        repositoryRoot,
        hostKind: engine.hostKind,
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
}) {
    return createAndStart({
        engine,
        identity,
        image: { immutableId: old.imageId },
        imageRef: old.imageRef,
        hostPort: old.hostPort,
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
    imageRef = BOX_IMAGE_REFERENCE,
    platform = process.platform,
    env = process.env,
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
        ensureVolumes: seams.ensureVolumes || ensureNamedVolumes,
        rollbackVolumes: seams.rollbackVolumes || rollbackCreatedVolumes,
        revalidateVolumes: seams.revalidateVolumes || revalidateAllVolumes,
        removeContainer: seams.removeContainer || removeContainerById,
        stopPloinkyLocal: seams.stopPloinkyLocal || stopPloinkyLocalByContainerId,
        waitReady: seams.waitReady || waitForReadyLine,
        readCidfile: seams.readCidfile || readContainerIdFromCidfile,
        fsApi: seams.fsApi || fs,
        token: seams.token || (() => crypto.randomBytes(12).toString('hex')),
    };
    const portPlan = resolveEffectiveHostPort({ explicitPort, ownership });
    const currentContainer = ownership.handles?.container || null;
    const old = currentContainer ? oldDesired(identity, ownership, repositoryRoot, engine) : null;
    if (old) {
        dependencies.validateExistingImage(engine.name, old.imageId, old.imageRef, runner);
    }
    const requiresReplacement = Boolean(old) && (
        old.hostPort !== portPlan.hostPort || old.imageRef !== imageRef
    );
    if (old && !requiresReplacement) {
        dependencies.revalidateVolumes({
            engine,
            identity,
            handles: ownership.handles.volumes,
            runner,
            lock,
        });
        if (!currentContainer.runtime.running) {
            runner.run(engine.name, ['container', 'start', currentContainer.id]);
            await dependencies.waitReady(engine, currentContainer.id, runner);
        }
        const finalOwnership = dependencies.discover(identity, { runner });
        validateCreatedContainer(finalOwnership, old);
        return Object.freeze({ action: 'reused', ownership: finalOwnership, hostPort: old.hostPort });
    }

    await dependencies.preflight({
        hostPort: portPlan.hostPort,
        existingPublication: portPlan.existingPublication,
    });
    runner.run(engine.name, ['pull', imageRef]);
    const image = dependencies.validateImage(engine.name, imageRef, runner);
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
            imageRef,
            hostPort: portPlan.hostPort,
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
        });
        candidateId = created.containerId;
        return Object.freeze({
            action: old ? 'replaced' : 'created',
            ownership: created.ownership,
            hostPort: portPlan.hostPort,
            imageId: image.immutableId,
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
                await restoreOldContainer({
                    engine,
                    identity,
                    old,
                    runner,
                    lock,
                    volumeHandles: volumeResult.handles,
                    dependencies,
                });
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
