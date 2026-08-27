import crypto from 'node:crypto';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import {
    BOX_DATA_FINGERPRINT_LABELS,
    BOX_DATA_KEYS,
    BOX_IMAGE_REFERENCE,
    BOX_LABELS,
} from '../constants.mjs';
import {
    agentLibContractFromContainer,
    agentLibSelectionChanged,
    normalizeBoxAgentLib,
} from '../contract/agentlib.mjs';
import { validateContainerConfiguration } from '../contract/container.mjs';
import {
    inspectAndValidateExistingImage,
    inspectAndValidateImage,
} from '../contract/image.mjs';
import { discoverBoxOwnership } from '../engine/discovery.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { fingerprintSource, sourceIdHash } from '../../agentlib/fingerprint.mjs';
import { preflightPublications, resolveEffectiveHostPort } from '../ports.mjs';
import {
    ensureWorkspaceDataPaths,
    inspectWorkspaceDataPaths,
} from '../workspace-data.mjs';
import {
    containerCreateArgs,
    readContainerIdFromCidfile,
    removeContainerById,
    revalidateBoxDataPaths,
    secureCidfilePath,
    startContainerAndWaitReady,
    stopPloinkyLocalByContainerId,
    validateCreatedContainer,
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
    // The AgentLib contract is reconstructed from the observed mount plus the
    // Box labels, never from the caller's new selection: an existing Box has to
    // prove which source it actually has before it can be reused.
    const container = ownership.handles.container;
    const hostPort = Number(container.labels[BOX_LABELS.routerHostPort]);
    const mediaHostPort = Number(container.labels[BOX_LABELS.mediaHostPort]);
    const imageRef = container.labels[BOX_LABELS.imageRef];
    const imageId = container.runtime.imageId;
    const dataFingerprints = Object.freeze(Object.fromEntries(BOX_DATA_KEYS.map((key) => [
        key,
        String(container.labels?.[BOX_DATA_FINGERPRINT_LABELS[key]] || ''),
    ])));
    const agentLib = agentLibContractFromContainer(container);
    const desired = {
        identity,
        hostPort,
        mediaHostPort,
        imageRef,
        imageId,
        repositoryRoot,
        hostKind: engine.hostKind,
        dataFingerprints,
        agentLib,
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
    agentLib,
    runner,
    lock,
    discover,
    startAndWaitReady,
    revalidateDataPaths,
    readCidfile,
    fsApi,
    token,
    stdout,
    stderr,
}) {
    lock.assertHeld(identity.instance);
    const dataState = revalidateDataPaths({ identity, lock, fsApi });
    const cidfile = secureCidfilePath(lock, token);
    cleanCidfile(cidfile, fsApi);
    writeProgress(stderr, `Creating Box container ${identity.instance}...`);
    runner.run(engine.name, containerCreateArgs({
        identity,
        dataFingerprints: dataState.fingerprints,
        agentLib,
        imageId: image.immutableId,
        imageRef,
        hostPort,
        mediaHostPort,
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
    writeProgress(stderr, `Starting Box container ${identity.instance}; streaming startup logs...`);
    await startAndWaitReady(engine, containerId, runner, { stdout, stderr });
    const finalOwnership = discover(identity, { runner });
    const handle = validateCreatedContainer(finalOwnership, {
        identity,
        hostPort,
        mediaHostPort,
        imageId: image.immutableId,
        imageRef,
        repositoryRoot,
        hostKind: engine.hostKind,
        dataFingerprints: dataState.fingerprints,
        agentLib,
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
    dependencies,
    stdout,
    stderr,
}) {
    const observedSource = fingerprintSource(old.agentLib.sourceDir, { fsApi: dependencies.fsApi });
    if (observedSource.fingerprint !== old.agentLib.fingerprint
        || sourceIdHash(observedSource.sourceId) !== old.agentLib.sourceIdHash) {
        throw transactionError(
            `Refusing to restore the old Box because its achillesAgentLib source at ${old.agentLib.sourceDir} changed`,
        );
    }
    return createAndStart({
        engine,
        identity,
        image: { immutableId: old.imageId },
        imageRef: old.imageRef,
        hostPort: old.hostPort,
        mediaHostPort: old.mediaHostPort,
        repositoryRoot: old.repositoryRoot,
        agentLib: old.agentLib,
        runner,
        lock,
        discover: dependencies.discover,
        startAndWaitReady: dependencies.startAndWaitReady,
        revalidateDataPaths: dependencies.revalidateDataPaths,
        readCidfile: dependencies.readCidfile,
        fsApi: dependencies.fsApi,
        token: dependencies.token('restore'),
        stdout,
        stderr,
    });
}

export async function reconcileBoxContainer({
    identity,
    ownership,
    engine,
    runner,
    lock,
    repositoryRoot,
    agentLib,
    explicitPort,
    explicitMediaPort,
    imageRef = BOX_IMAGE_REFERENCE,
    platform = process.platform,
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
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
        ensureDataPaths: seams.ensureDataPaths || ensureWorkspaceDataPaths,
        inspectDataPaths: seams.inspectDataPaths || inspectWorkspaceDataPaths,
        revalidateDataPaths: seams.revalidateDataPaths || revalidateBoxDataPaths,
        removeContainer: seams.removeContainer || removeContainerById,
        stopPloinkyLocal: seams.stopPloinkyLocal || stopPloinkyLocalByContainerId,
        startAndWaitReady: seams.startAndWaitReady || startContainerAndWaitReady,
        readCidfile: seams.readCidfile || readContainerIdFromCidfile,
        fsApi: seams.fsApi || fs,
        token: seams.token || (() => crypto.randomBytes(12).toString('hex')),
    };
    if (!agentLib) {
        throw transactionError('Box reconciliation requires a selected achillesAgentLib source');
    }
    const desiredAgentLib = normalizeBoxAgentLib(agentLib);
    const portPlan = resolveEffectiveHostPort({ explicitPort, explicitMediaPort, ownership });
    const currentContainer = ownership.handles?.container || null;
    const old = currentContainer ? oldDesired(identity, ownership, repositoryRoot, engine) : null;
    if (old) {
        dependencies.validateExistingImage(engine.name, old.imageId, old.imageRef, runner);
    }
    let currentDataState = null;
    if (old) {
        try {
            currentDataState = dependencies.inspectDataPaths({
                identity,
                fsApi: dependencies.fsApi,
            });
        } catch {
            // Missing, unsafe, or non-writable bind sources require replacement.
            // Preparation below revalidates the precise cause before removing
            // the existing Box, so unsafe parents still fail without mutation.
            currentDataState = null;
        }
    }
    const dataPathsChanged = Boolean(old) && (
        !currentDataState
        || !isDeepStrictEqual(currentDataState.fingerprints, old.dataFingerprints)
    );
    const requiresReplacement = Boolean(old) && (
        old.hostPort !== portPlan.hostPort
        || old.mediaHostPort !== portPlan.mediaHostPort
        || old.imageRef !== imageRef
        || dataPathsChanged
        // A changed source directory, mode, identity, or fingerprint must never
        // leave the old inode mounted in a reused Box.
        || agentLibSelectionChanged(old.agentLib, desiredAgentLib)
    );
    if (old && !requiresReplacement) {
        // Reuse is valid only while the host directories are the exact bind
        // sources captured at creation. Revalidation immediately before start
        // rejects any later parent or directory substitution.
        dependencies.revalidateDataPaths({ identity, lock, fsApi: dependencies.fsApi });
        if (!currentContainer.runtime.running) {
            writeProgress(stderr, `Starting existing Box container ${identity.instance}; streaming startup logs...`);
            await dependencies.startAndWaitReady(
                engine,
                currentContainer.id,
                runner,
                { stdout, stderr },
            );
        }
        const finalOwnership = dependencies.discover(identity, { runner });
        const finalHandle = validateCreatedContainer(finalOwnership, old);
        if (finalHandle.id !== currentContainer.id) {
            throw transactionError('Reused Box immutable ID changed during final validation');
        }
        return Object.freeze({
            action: 'reused',
            ownership: finalOwnership,
            hostPort: old.hostPort,
            mediaHostPort: old.mediaHostPort,
            previousAgentLib: old.agentLib,
            finalize() {},
            async rollback() {
                // Reuse did not replace an outer resource. The supervisor owns
                // stopping any partially restarted inner graph.
                return Object.freeze({
                    action: 'reused-preserved',
                    ownership: finalOwnership,
                    containerId: currentContainer.id,
                    hostPort: old.hostPort,
                    mediaHostPort: old.mediaHostPort,
                    agentLib: old.agentLib,
                });
            },
        });
    }

    await dependencies.preflight({
        hostPort: portPlan.hostPort,
        mediaHostPort: portPlan.mediaHostPort,
        existingPublication: portPlan.existingPublication,
    });
    await pullBoxImage(engine, imageRef, runner, { stdout, stderr });
    const image = dependencies.validateImage(engine.name, imageRef, runner);
    try {
        dependencies.ensureDataPaths({ identity, lock, fsApi: dependencies.fsApi });
    } catch (error) {
        throw transactionError('Workspace Box data preparation failed', error);
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
            mediaHostPort: portPlan.mediaHostPort,
            repositoryRoot,
            agentLib: desiredAgentLib,
            runner,
            lock,
            discover: dependencies.discover,
            startAndWaitReady: dependencies.startAndWaitReady,
            revalidateDataPaths: dependencies.revalidateDataPaths,
            readCidfile: dependencies.readCidfile,
            fsApi: dependencies.fsApi,
            token: dependencies.token('candidate'),
            stdout,
            stderr,
        });
        candidateId = created.containerId;
        let settled = false;
        const finalize = () => { settled = true; };
        const rollback = async () => {
            lock.assertHeld(identity.instance);
            if (settled) return Object.freeze({ action: 'already-settled' });
            settled = true;
            const failures = [];
            const observed = dependencies.discover(identity, { runner });
            const observedId = observed?.state === 'owned'
                ? observed.handles?.container?.id
                : null;
            if (observedId && observedId !== candidateId) {
                throw transactionError(
                    `Box changed before candidate rollback (${observedId} != ${candidateId})`,
                );
            }
            if (observedId === candidateId) {
                try { dependencies.removeContainer(engine, candidateId, runner); } catch (error) {
                    failures.push(`candidate removal: ${error.message}`);
                }
            }
            let restored = null;
            if (oldRemoved) {
                try {
                    restored = await restoreOldContainer({
                        engine,
                        identity,
                        old,
                        runner,
                        lock,
                        dependencies,
                        stdout,
                        stderr,
                    });
                } catch (error) {
                    failures.push(`old Box restoration: ${error.message}`);
                }
            }
            if (failures.length) {
                throw transactionError('Box post-reconcile rollback failed', null, failures);
            }
            return Object.freeze(oldRemoved ? {
                action: 'restored',
                ownership: restored.ownership,
                containerId: restored.containerId,
                hostPort: old.hostPort,
                mediaHostPort: old.mediaHostPort,
                agentLib: old.agentLib,
            } : { action: 'candidate-removed' });
        };
        return Object.freeze({
            action: old ? 'replaced' : 'created',
            ownership: created.ownership,
            hostPort: portPlan.hostPort,
            mediaHostPort: portPlan.mediaHostPort,
            imageId: image.immutableId,
            previousAgentLib: old?.agentLib || null,
            finalize,
            rollback,
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
                    dependencies,
                    stdout,
                    stderr,
                });
            } catch (restoreError) {
                rollbackFailures.push(`old Box restoration: ${restoreError.message}`);
            }
        }
        // The workspace-backed cache directories are durable state, not
        // transaction-owned resources: a failed create never rolls them back.
        throw transactionError('Box container transaction failed', error, rollbackFailures);
    }
}
