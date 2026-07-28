import fs from 'node:fs';
import path from 'node:path';

import {
    BOX_LABELS,
    BOX_MEDIA_PORT,
    BOX_READY_LINE,
    BOX_ROUTER_CONTAINER_PORT,
    BOX_ROLES,
} from '../constants.mjs';
import { validateContainerConfiguration } from '../contract/container.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { revalidateVolumeHandle, volumeMountArgs } from '../volumes.mjs';

function lifecycleError(message, code = 'PLOINKY_BOX_LIFECYCLE_FAILED', cause) {
    return new PloinkyBoxError(message, { code, cause });
}

function containerLogDiagnostic(logs, limit = 2048) {
    const text = [logs?.stdout, logs?.stderr]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .join('\n')
        .replace(/\s+/g, ' ');
    if (!text) return 'container logs were empty';
    const bounded = text.length <= limit ? text : `…${text.slice(-limit)}`;
    return `container logs: ${bounded}`;
}

export function containerCreateArgs({
    identity,
    imageId,
    imageRef,
    hostPort,
    repositoryRoot,
    cidfile,
    hostKind = 'native-linux',
}) {
    const source = path.resolve(repositoryRoot);
    const labels = {
        [BOX_LABELS.pathHash]: identity.pathHash,
        [BOX_LABELS.role]: BOX_ROLES.container,
        [BOX_LABELS.imageRef]: imageRef,
        [BOX_LABELS.routerHostPort]: String(hostPort),
    };
    return [
        'container', 'create',
        '--init',
        '--name', identity.instance,
        '--user', 'podman',
        '--device', '/dev/fuse',
        '--device', '/dev/net/tun',
        '--security-opt', 'unmask=ALL',
        ...(hostKind === 'podman-machine' ? ['--security-opt', 'label=disable'] : []),
        '--publish', `127.0.0.1:${hostPort}:${BOX_ROUTER_CONTAINER_PORT}/tcp`,
        '--publish', `0.0.0.0:${BOX_MEDIA_PORT}:${BOX_MEDIA_PORT}/udp`,
        '--volume', `${source}:/opt/ploinky:ro`,
        ...volumeMountArgs(identity),
        '--env', 'PLOINKY_PUBLIC_BIND=0.0.0.0',
        '--env', `PLOINKY_PUBLIC_AUTHORITY=127.0.0.1:${hostPort}`,
        '--env', 'PLOINKY_PRIVATE_BIND=0.0.0.0',
        ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
        '--cidfile', cidfile,
        imageId,
    ];
}

export function secureCidfilePath(lock, attemptToken) {
    if (!lock?.path || !/^[a-f0-9]{16,64}$/.test(attemptToken)) {
        throw lifecycleError('Container creation requires a valid locked cidfile path');
    }
    const candidate = path.join(lock.path, `candidate-${attemptToken}.cid`);
    if (path.dirname(candidate) !== path.resolve(lock.path)) {
        throw lifecycleError('Container cidfile escaped the mutation lock directory');
    }
    return candidate;
}

export function readContainerIdFromCidfile(cidfile, { fsApi = fs } = {}) {
    let stat;
    let value;
    try {
        stat = fsApi.lstatSync(cidfile);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
            throw lifecycleError('Container cidfile is not a private regular file');
        }
        value = fsApi.readFileSync(cidfile, 'utf8').trim();
    } catch (error) {
        if (error instanceof PloinkyBoxError) throw error;
        throw lifecycleError('Container cidfile is missing after creation', 'PLOINKY_BOX_CIDFILE_INVALID', error);
    }
    if (!/^[a-f0-9]{12,64}$/.test(value)) {
        throw lifecycleError('Container cidfile is corrupt after creation', 'PLOINKY_BOX_CIDFILE_INVALID');
    }
    return value;
}

export function revalidateAllVolumes({ engine, identity, handles, runner, lock }) {
    for (const key of ['workspace', 'containers', 'dependencies']) {
        revalidateVolumeHandle(handles[key], { engine, identity, key, runner, lock });
    }
}

export function removeContainerById(engine, containerId, runner) {
    if (!/^[a-f0-9]{12,64}$/.test(String(containerId))) {
        throw lifecycleError('Refusing to remove a container without an immutable ID');
    }
    runner.run(engine.name, ['container', 'rm', '-f', '--volumes', String(containerId)]);
}

export function stopPloinkyLocalByContainerId(engine, containerId, runner) {
    if (!/^[a-f0-9]{12,64}$/.test(String(containerId))) {
        throw lifecycleError('Refusing to relay ploinky-local stop without an immutable container ID');
    }
    runner.run(engine.name, [
        'container', 'exec',
        '--user', 'podman',
        '--workdir', '/workspace',
        String(containerId),
        '/opt/ploinky/bin/ploinky-local',
        'stop',
    ]);
}

export async function waitForReadyLine(engine, containerId, runner, {
    readyLine = BOX_READY_LINE,
    timeoutMs = 60_000,
    intervalMs = 100,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        const logs = runner.query(engine.name, ['container', 'logs', containerId]);
        if (logs.ok && String(logs.stdout || '').split(/\r?\n/).includes(readyLine)) {
            return;
        }
        const state = runner.query(engine.name, [
            'container', 'inspect', '--format', '{{.State.Status}}', containerId,
        ]);
        if (state.ok && !['created', 'running'].includes(String(state.stdout || '').trim())) {
            const finalLogs = runner.query(engine.name, ['container', 'logs', containerId]);
            throw lifecycleError(
                `Box container exited before ${readyLine}; ${containerLogDiagnostic(finalLogs)}`,
            );
        }
        await delay(intervalMs);
    }
    const logs = runner.query(engine.name, ['container', 'logs', containerId]);
    throw lifecycleError(
        `Timed out waiting for exact ready line: ${readyLine}; ${containerLogDiagnostic(logs)}`,
        'PLOINKY_BOX_READY_TIMEOUT',
    );
}

export function validateCreatedContainer(ownership, desired) {
    if (ownership?.state !== 'owned' || !ownership.handles?.container) {
        throw lifecycleError('Created Box could not be rediscovered as owned');
    }
    validateContainerConfiguration(ownership.handles.container, desired);
    return ownership.handles.container;
}
