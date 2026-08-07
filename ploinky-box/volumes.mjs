import {
    BOX_LABELS,
    BOX_ROLES,
    BOX_VOLUME_KEYS,
} from './constants.mjs';
import { PloinkyBoxError } from './errors.mjs';
import {
    inspectOwnedVolumeHandle,
    volumeHandleMatches,
} from './engine/discovery.mjs';

export const BOX_VOLUME_MOUNTS = Object.freeze({
    images: '/home/podman/.local/share/ploinky-images',
    dependencies: '/opt/ploinky/node_modules',
});

const ROLE_BY_KEY = Object.freeze({
    images: BOX_ROLES.images,
    dependencies: BOX_ROLES.dependencies,
});

function volumeError(message, code = 'PLOINKY_BOX_VOLUME_FAILED') {
    return new PloinkyBoxError(message, { code });
}

function volumeName(identity, key) {
    return identity.volumes[key] || '';
}

export function volumeCreateArgs(identity, key) {
    const name = identity.volumes[key];
    const role = ROLE_BY_KEY[key];
    if (!name || !role) {
        throw volumeError(`Unknown Box volume key ${key}`);
    }
    return [
        'volume',
        'create',
        '--label', `${BOX_LABELS.pathHash}=${identity.pathHash}`,
        '--label', `${BOX_LABELS.role}=${role}`,
        name,
    ];
}

export function volumeMountArgs(identity) {
    return BOX_VOLUME_KEYS.flatMap((key) => [
        '--volume',
        `${identity.volumes[key]}:${BOX_VOLUME_MOUNTS[key]}:U`,
    ]);
}

function assertLock(lock, identity) {
    if (!lock || typeof lock.assertHeld !== 'function') {
        throw volumeError('Named-volume mutation requires the Box mutation lock');
    }
    lock.assertHeld(identity.instance);
}

export function revalidateVolumeHandle(handle, {
    engine,
    identity,
    key,
    runner,
    lock,
}) {
    assertLock(lock, identity);
    const current = inspectOwnedVolumeHandle(engine, identity, key, runner);
    if (current.state !== 'owned' || !volumeHandleMatches(handle, current.handle)) {
        throw volumeError(
            `Named volume ${volumeName(identity, key)} changed before mutation`,
            'PLOINKY_BOX_VOLUME_CHANGED',
        );
    }
    return current.handle;
}

export function ensureNamedVolumes({
    engine,
    identity,
    runner,
    lock,
    knownHandles = {},
}) {
    assertLock(lock, identity);
    const handles = {};
    const created = [];
    try {
        for (const key of BOX_VOLUME_KEYS) {
            const known = knownHandles[key];
            if (known) {
                handles[key] = revalidateVolumeHandle(known, {
                    engine, identity, key, runner, lock,
                });
                continue;
            }
            const before = inspectOwnedVolumeHandle(engine, identity, key, runner);
            if (before.state === 'owned') {
                handles[key] = before.handle;
                continue;
            }
            if (before.state !== 'absent') {
                throw volumeError(
                    before.message || `Cannot safely inspect named volume ${identity.volumes[key]}`,
                );
            }
            runner.run(engine.name, volumeCreateArgs(identity, key));
            const after = inspectOwnedVolumeHandle(engine, identity, key, runner);
            if (after.state !== 'owned') {
                throw volumeError(
                    `Named volume ${identity.volumes[key]} was not safely owned after creation`,
                );
            }
            handles[key] = after.handle;
            created.push(Object.freeze({ key, handle: after.handle }));
        }
    } catch (error) {
        Object.defineProperty(error, 'createdVolumes', {
            value: Object.freeze([...created]),
            enumerable: false,
        });
        throw error;
    }
    return Object.freeze({
        handles: Object.freeze(handles),
        created: Object.freeze(created),
    });
}

export function rollbackCreatedVolumes({
    engine,
    identity,
    runner,
    lock,
    created,
}) {
    assertLock(lock, identity);
    const failures = [];
    for (const entry of [...created].reverse()) {
        try {
            revalidateVolumeHandle(entry.handle, {
                engine,
                identity,
                key: entry.key,
                runner,
                lock,
            });
            runner.run(engine.name, ['volume', 'rm', entry.handle.name]);
        } catch (error) {
            failures.push({ key: entry.key, message: error.message });
        }
    }
    if (failures.length > 0) {
        throw volumeError(
            `Named-volume rollback failed: ${failures.map(({ key, message }) => `${key}: ${message}`).join('; ')}`,
            'PLOINKY_BOX_VOLUME_ROLLBACK_FAILED',
        );
    }
}

export function removeOwnedNamedVolumes({
    engine,
    identity,
    runner,
    lock,
    knownHandles,
}) {
    assertLock(lock, identity);
    const handles = {};
    for (const key of BOX_VOLUME_KEYS) {
        const known = knownHandles?.[key];
        if (known) {
            handles[key] = revalidateVolumeHandle(known, {
                engine, identity, key, runner, lock,
            });
            continue;
        }
        const current = inspectOwnedVolumeHandle(engine, identity, key, runner);
        if (current.state !== 'absent') {
            throw volumeError(
                `Named volume ${volumeName(identity, key)} changed before mutation`,
                'PLOINKY_BOX_VOLUME_CHANGED',
            );
        }
    }

    const ordered = BOX_VOLUME_KEYS
        .filter((key) => Boolean(handles[key]))
        .map((key) => [key, handles[key]]);
    for (const [key, recordedHandle] of ordered) {
        const handle = revalidateVolumeHandle(recordedHandle, {
            engine, identity, key, runner, lock,
        });
        runner.run(engine.name, ['volume', 'rm', handle.name]);
        const after = inspectOwnedVolumeHandle(engine, identity, key, runner);
        if (after.state !== 'absent') {
            throw volumeError(
                `Named volume ${handle.name} still exists after deletion`,
                'PLOINKY_BOX_VOLUME_REMOVE_FAILED',
            );
        }
    }
    return Object.freeze(ordered.map(([, handle]) => handle.name));
}
