import { isDeepStrictEqual } from 'node:util';

import {
    BOX_LABELS,
    BOX_ROLES,
    BOX_VOLUME_KEYS,
} from './constants.mjs';
import { PloinkyBoxError } from './errors.mjs';

export const BOX_VOLUME_MOUNTS = Object.freeze({
    workspace: '/workspace',
    containers: '/home/podman/.local/share/containers',
    dependencies: '/opt/ploinky/node_modules',
});

const ROLE_BY_KEY = Object.freeze({
    workspace: BOX_ROLES.workspace,
    containers: BOX_ROLES.containers,
    dependencies: BOX_ROLES.dependencies,
});

function volumeError(message, code = 'PLOINKY_BOX_VOLUME_FAILED') {
    return new PloinkyBoxError(message, { code });
}

function assertLock(lock, identity) {
    if (!lock || typeof lock.assertHeld !== 'function') {
        throw volumeError('Named-volume mutation requires the Box mutation lock');
    }
    lock.assertHeld(identity.instance);
}

function expectedLabels(identity, key) {
    const role = ROLE_BY_KEY[key];
    if (!role || !identity.volumes[key]) throw volumeError(`Unknown Box volume key ${key}`);
    return Object.freeze({
        [BOX_LABELS.pathHash]: identity.pathHash,
        [BOX_LABELS.role]: role,
    });
}

function recordLabels(record) {
    const labels = record?.Labels ?? record?.labels ?? {};
    return labels && typeof labels === 'object' && !Array.isArray(labels) ? { ...labels } : {};
}

function exactVolumeRecord(records, identity, key, { allowMissing = false } = {}) {
    const name = identity.volumes[key];
    const matches = records.filter((record) => String(record?.Name ?? record?.name ?? '') === name);
    if (matches.length > 1) throw volumeError(`Duplicate exact named volume ${name}`);
    if (matches.length === 0) {
        if (allowMissing) return null;
        throw volumeError(`Named volume ${name} is missing`, 'PLOINKY_BOX_VOLUME_CHANGED');
    }
    const observed = recordLabels(matches[0]);
    const owned = Object.fromEntries(Object.entries(observed)
        .filter(([label]) => label.startsWith('io.assistos.ploinky-box.'))
        .sort());
    if (!isDeepStrictEqual(owned, expectedLabels(identity, key))) {
        throw volumeError(`Named volume ${name} is not exactly owned by this Box`);
    }
    return matches[0];
}

function handleFor(engine, identity, key, record) {
    return Object.freeze({
        kind: 'volume',
        engine: engine.name,
        engineIdentity: engine.identity,
        name: identity.volumes[key],
        role: ROLE_BY_KEY[key],
        labels: expectedLabels(identity, key),
        fingerprint: Object.freeze({
            driver: String(record?.Driver ?? record?.driver ?? ''),
            mountCount: Number(record?.MountCount ?? record?.mountCount ?? 0),
        }),
        pathHash: identity.pathHash,
    });
}

export async function revalidateVolumeHandle(handle, {
    engine,
    identity,
    key,
    hostClient,
    lock,
}) {
    assertLock(lock, identity);
    if (!handle || handle.name !== identity.volumes[key]
        || handle.engineIdentity !== engine.identity) {
        throw volumeError(
            `Named volume ${identity.volumes[key]} changed before mutation`,
            'PLOINKY_BOX_VOLUME_CHANGED',
        );
    }
    const labels = expectedLabels(identity, key);
    const selected = await hostClient.findVolume({ name: identity.volumes[key], labels });
    const record = exactVolumeRecord(selected ? [selected] : [], identity, key);
    return handleFor(engine, identity, key, record);
}

export async function ensureNamedVolumes({
    engine,
    identity,
    hostClient,
    lock,
    knownHandles = {},
}) {
    assertLock(lock, identity);
    const handles = {};
    const created = [];
    const ambiguousNames = [];
    try {
        for (const key of BOX_VOLUME_KEYS) {
            const labels = expectedLabels(identity, key);
            const selected = await hostClient.findVolume({
                name: identity.volumes[key], labels,
            });
            const before = exactVolumeRecord(selected ? [selected] : [], identity, key, {
                allowMissing: true,
            });
            if (before) {
                if (!knownHandles[key]) {
                    throw volumeError(
                        `Named volume ${identity.volumes[key]} exists without journal ownership proof`,
                        'PLOINKY_BOX_VOLUME_CHANGED',
                    );
                }
                handles[key] = await revalidateVolumeHandle(knownHandles[key], {
                    engine, identity, key, hostClient, lock,
                });
                continue;
            }
            ambiguousNames.push(identity.volumes[key]);
            await hostClient.createVolume({ name: identity.volumes[key], labels });
            const createdRecord = await hostClient.findVolume({ name: identity.volumes[key], labels });
            const after = exactVolumeRecord(createdRecord ? [createdRecord] : [], identity, key);
            handles[key] = handleFor(engine, identity, key, after);
            created.push(Object.freeze({ key, handle: handles[key] }));
            ambiguousNames.pop();
        }
    } catch (error) {
        Object.defineProperty(error, 'createdVolumes', {
            value: Object.freeze([...created]),
            enumerable: false,
        });
        Object.defineProperty(error, 'ambiguousVolumeNames', {
            value: Object.freeze([...ambiguousNames]),
            enumerable: false,
        });
        throw error;
    }
    return Object.freeze({
        handles: Object.freeze(handles),
        created: Object.freeze(created),
    });
}

async function removeExactUnusedVolume({ hostClient, identity, key, handle, transactionOwned }) {
    const labels = expectedLabels(identity, key);
    const selected = await hostClient.findVolume({ name: identity.volumes[key], labels });
    const record = exactVolumeRecord(selected ? [selected] : [], identity, key);
    const mountCount = Number(record?.MountCount ?? record?.mountCount);
    if (!Number.isSafeInteger(mountCount) || mountCount !== 0) {
        throw volumeError(`Named volume ${handle.name} is not proven unused`);
    }
    await hostClient.deleteVolume({
        name: handle.name,
        labels,
        transactionOwned,
        knownUnused: true,
    });
}

export async function rollbackCreatedVolumes({
    engine,
    identity,
    hostClient,
    lock,
    created,
}) {
    assertLock(lock, identity);
    const failures = [];
    for (const entry of [...created].reverse()) {
        try {
            await revalidateVolumeHandle(entry.handle, {
                engine, identity, key: entry.key, hostClient, lock,
            });
            await removeExactUnusedVolume({
                hostClient,
                identity,
                key: entry.key,
                handle: entry.handle,
                transactionOwned: true,
            });
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

export async function removeOwnedNamedVolumes({
    engine,
    identity,
    hostClient,
    lock,
    knownHandles,
    ownedVolumeNames = Object.values(identity.volumes),
    onDeleted = async () => {},
    recoverAbsentJournaled = false,
}) {
    assertLock(lock, identity);
    if (!Array.isArray(ownedVolumeNames)
        || new Set(ownedVolumeNames).size !== ownedVolumeNames.length
        || ownedVolumeNames.some((name) => !Object.values(identity.volumes).includes(name))
        || typeof onDeleted !== 'function'
        || typeof recoverAbsentJournaled !== 'boolean') {
        throw volumeError(
            'Cannot delete volumes outside the exact journal-owned set',
            'PLOINKY_BOX_VOLUME_SET_INCOMPLETE',
        );
    }
    const selectedKeys = BOX_VOLUME_KEYS.filter((key) => (
        ownedVolumeNames.includes(identity.volumes[key])
    ));
    if (!recoverAbsentJournaled && selectedKeys.some((key) => !knownHandles?.[key])) {
        throw volumeError(
            `Cannot delete an incomplete named-volume set for Box ${identity.instance}`,
            'PLOINKY_BOX_VOLUME_SET_INCOMPLETE',
        );
    }
    const records = new Map();
    const handles = new Map();
    for (const key of selectedKeys) {
        const labels = expectedLabels(identity, key);
        const selected = await hostClient.findVolume({
            name: identity.volumes[key], labels,
        });
        if (!selected) {
            if (!recoverAbsentJournaled) {
                throw volumeError(
                    `Named volume ${identity.volumes[key]} is missing`,
                    'PLOINKY_BOX_VOLUME_CHANGED',
                );
            }
            records.set(key, null);
            continue;
        }
        if (!knownHandles?.[key]) {
            throw volumeError(
                `Cannot delete an incomplete named-volume set for Box ${identity.instance}`,
                'PLOINKY_BOX_VOLUME_SET_INCOMPLETE',
            );
        }
        records.set(key, selected);
        handles.set(key, await revalidateVolumeHandle(knownHandles[key], {
            engine, identity, key, hostClient, lock,
        }));
    }
    for (const key of [...selectedKeys].reverse()) {
        if (records.get(key) === null) {
            // The direct delete route proves absence after success. An absent
            // still-journaled name is a recoverable crash window only when the
            // caller supplies the exact durable journal proof.
            await onDeleted({
                key,
                name: identity.volumes[key],
                recoveredAbsent: true,
            });
            continue;
        }
        const handle = handles.get(key);
        await removeExactUnusedVolume({
            hostClient,
            identity,
            key,
            handle,
            transactionOwned: true,
        });
        await onDeleted({ key, name: handle.name, recoveredAbsent: false });
    }
    return Object.freeze(selectedKeys.map((key) => identity.volumes[key]));
}
