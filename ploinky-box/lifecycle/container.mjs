import fs from 'node:fs';
import path from 'node:path';

import {
    BOX_DATA_FINGERPRINT_LABELS,
    BOX_DATA_KEYS,
    BOX_LABELS,
    BOX_MEDIA_PORT,
    BOX_READY_LINE,
    BOX_ROUTER_CONTAINER_PORT,
    BOX_ROUTER_HEALTH_SOCKET,
    BOX_ROLES,
    BOX_TMPFS,
    BOX_USERNS,
} from '../constants.mjs';
import {
    agentLibEnvArgs,
    agentLibLabels,
    agentLibMountArgs,
    normalizeBoxAgentLib,
} from '../contract/agentlib.mjs';
import { validateContainerConfiguration } from '../contract/container.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { nestedPodmanSeccompProfileContract } from '../seccomp.mjs';
import {
    revalidateWorkspaceDataPaths,
    workspaceDataMountArgs,
} from '../workspace-data.mjs';

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
    const deviceHint = /\/dev\/net\/tun (?:not present|is missing or inaccessible)/.test(text)
        ? '; /dev/net/tun must exist on the host and be accessible inside the Box for nested networking. Verify that Podman recorded both --device /dev/net/tun and --security-opt label=disable'
        : /\/dev\/fuse (?:not present|is missing or inaccessible)/.test(text)
            ? '; /dev/fuse must exist on the host and be accessible inside the Box for nested container storage. Verify that Podman recorded both --device /dev/fuse and --security-opt label=disable'
            : '';
    return `container logs: ${bounded}${deviceHint}`;
}

function writeLogDelta(output, currentValue, previousValue) {
    const current = String(currentValue || '');
    const previous = String(previousValue || '');
    if (!current || current === previous) return current;
    output?.write?.(current.slice(previous.length));
    return current;
}

function assertImmutableContainerId(containerId, action) {
    const value = String(containerId);
    if (!/^[a-f0-9]{12,64}$/.test(value)) {
        throw lifecycleError(`Refusing to ${action} without an immutable container ID`);
    }
    return value;
}

function tmpfsCreateArgument() {
    return `${BOX_TMPFS.destination}:${BOX_TMPFS.options.join(',')}`;
}

export function containerCreateArgs({
    identity,
    dataFingerprints,
    agentLib,
    imageId,
    imageRef,
    hostPort,
    mediaHostPort = BOX_MEDIA_PORT,
    repositoryRoot,
    cidfile,
    hostKind = 'native-linux',
}) {
    const source = path.resolve(repositoryRoot);
    const seccompProfile = nestedPodmanSeccompProfileContract(source);
    if (!agentLib) {
        throw lifecycleError('Container creation requires a selected achillesAgentLib source');
    }
    const agentLibContract = normalizeBoxAgentLib(agentLib);
    const labels = {
        [BOX_LABELS.pathHash]: identity.pathHash,
        [BOX_LABELS.role]: BOX_ROLES.container,
        [BOX_LABELS.imageRef]: imageRef,
        [BOX_LABELS.routerHostPort]: String(hostPort),
        [BOX_LABELS.mediaHostPort]: String(mediaHostPort),
        [BOX_LABELS.seccompFingerprint]: seccompProfile.fingerprint,
    };
    for (const key of BOX_DATA_KEYS) {
        const value = String(dataFingerprints?.[key] || '');
        if (!/^[a-f0-9]{64}$/.test(value)) {
            throw lifecycleError(`Container creation requires a valid ${key} directory fingerprint`);
        }
        labels[BOX_DATA_FINGERPRINT_LABELS[key]] = value;
    }
    Object.assign(labels, agentLibLabels(agentLibContract));
    return [
        'container', 'create',
        '--init',
        '--name', identity.instance,
        '--user', 'podman',
        '--userns', BOX_USERNS,
        '--device', '/dev/fuse',
        '--device', '/dev/net/tun',
        '--security-opt', 'unmask=ALL',
        '--security-opt', 'label=disable',
        '--security-opt', `seccomp=${seccompProfile.path}`,
        '--publish', `127.0.0.1:${hostPort}:${BOX_ROUTER_CONTAINER_PORT}/tcp`,
        '--publish', `0.0.0.0:${mediaHostPort}:${BOX_MEDIA_PORT}/udp`,
        '--tmpfs', tmpfsCreateArgument(),
        '--volume', `${source}:/opt/ploinky:ro`,
        '--volume', `${identity.workspaceRoot}:/workspace`,
        ...workspaceDataMountArgs(identity),
        // The AgentLib binds come last so the read-only alias shadow lands on
        // top of the writable /workspace bind that also exposes that path.
        ...agentLibMountArgs(agentLibContract),
        ...agentLibEnvArgs(agentLibContract),
        '--env', 'PLOINKY_PUBLIC_BIND=0.0.0.0',
        '--env', `PLOINKY_PUBLIC_AUTHORITY=127.0.0.1:${hostPort}`,
        '--env', 'PLOINKY_PRIVATE_BIND=0.0.0.0',
        '--env', `PLOINKY_ROUTER_HEALTH_SOCKET=${BOX_ROUTER_HEALTH_SOCKET}`,
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

export function revalidateBoxDataPaths({ identity, lock, fsApi }) {
    return revalidateWorkspaceDataPaths({ identity, lock, fsApi });
}

export function removeContainerById(engine, containerId, runner) {
    const id = assertImmutableContainerId(containerId, 'remove a container');
    runner.run(engine.name, ['container', 'rm', '-f', id]);
}

export function stopPloinkyLocalByContainerId(engine, containerId, runner) {
    const id = assertImmutableContainerId(containerId, 'relay ploinky-local stop');
    runner.run(engine.name, [
        'container', 'exec',
        '--user', 'podman',
        '--workdir', '/workspace',
        id,
        '/opt/ploinky/bin/ploinky-local',
        'stop',
    ]);
}

export function captureContainerLogBaseline(engine, containerId, runner) {
    const id = assertImmutableContainerId(containerId, 'capture container logs');
    const logs = runner.query(engine.name, ['container', 'logs', id]);
    if (!logs?.ok) {
        throw lifecycleError(
            `Could not capture Box container logs before start; ${containerLogDiagnostic(logs)}`,
            'PLOINKY_BOX_LOG_BASELINE_FAILED',
            logs?.error,
        );
    }
    return Object.freeze({
        stdout: String(logs.stdout || ''),
        stderr: String(logs.stderr || ''),
    });
}

function validateLogBaseline(logBaseline) {
    if (!logBaseline
        || typeof logBaseline !== 'object'
        || typeof logBaseline.stdout !== 'string'
        || typeof logBaseline.stderr !== 'string') {
        throw lifecycleError(
            'Box readiness requires an exact pre-start log baseline',
            'PLOINKY_BOX_LOG_BASELINE_INVALID',
        );
    }
    return {
        stdout: logBaseline.stdout,
        stderr: logBaseline.stderr,
    };
}

function logHistoryDrift(stream) {
    throw lifecycleError(
        `Box container ${stream} log history drifted from the pre-start baseline`,
        'PLOINKY_BOX_LOG_HISTORY_DRIFT',
    );
}

export async function waitForReadyLine(engine, containerId, runner, {
    readyLine = BOX_READY_LINE,
    logBaseline,
    timeoutMs = 60_000,
    intervalMs = 100,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    stdout = process.stdout,
    stderr = process.stderr,
} = {}) {
    const id = assertImmutableContainerId(containerId, 'wait for container readiness');
    const baseline = validateLogBaseline(logBaseline);
    const deadline = Date.now() + timeoutMs;
    let emittedStdout = '';
    let emittedStderr = '';
    let lastCurrentLogs = null;

    function readCurrentBootLogs() {
        const logs = runner.query(engine.name, ['container', 'logs', id]);
        if (!logs?.ok) return { ok: false, result: logs };
        const cumulativeStdout = String(logs.stdout || '');
        const cumulativeStderr = String(logs.stderr || '');
        if (!cumulativeStdout.startsWith(baseline.stdout)) logHistoryDrift('stdout');
        if (!cumulativeStderr.startsWith(baseline.stderr)) logHistoryDrift('stderr');
        const currentStdout = cumulativeStdout.slice(baseline.stdout.length);
        const currentStderr = cumulativeStderr.slice(baseline.stderr.length);
        if (!currentStdout.startsWith(emittedStdout)) logHistoryDrift('stdout');
        if (!currentStderr.startsWith(emittedStderr)) logHistoryDrift('stderr');
        emittedStdout = writeLogDelta(stdout, currentStdout, emittedStdout);
        emittedStderr = writeLogDelta(stderr, currentStderr, emittedStderr);
        lastCurrentLogs = { stdout: currentStdout, stderr: currentStderr };
        return { ok: true, logs: lastCurrentLogs };
    }

    while (Date.now() <= deadline) {
        const logs = readCurrentBootLogs();
        const state = runner.query(engine.name, [
            'container', 'inspect', '--format', '{{.State.Status}}', id,
        ]);
        const status = state?.ok ? String(state.stdout || '').trim().toLowerCase() : '';
        if (state?.ok && !['created', 'running'].includes(status)) {
            const finalLogs = readCurrentBootLogs();
            const diagnostics = finalLogs.ok
                ? finalLogs.logs
                : logs.ok
                    ? logs.logs
                    : finalLogs.result;
            throw lifecycleError(
                `Box container entered ${status || 'an unknown terminal state'} before ${readyLine}; `
                + containerLogDiagnostic(diagnostics),
            );
        }
        if (state?.ok
            && status === 'running'
            && logs.ok
            && logs.logs.stdout.split(/\r?\n/).includes(readyLine)) {
            return;
        }
        await delay(intervalMs);
    }
    const finalLogs = readCurrentBootLogs();
    const diagnostics = finalLogs.ok ? finalLogs.logs : lastCurrentLogs || finalLogs.result;
    throw lifecycleError(
        `Timed out waiting for exact ready line: ${readyLine}; ${containerLogDiagnostic(diagnostics)}`,
        'PLOINKY_BOX_READY_TIMEOUT',
    );
}

export async function startContainerAndWaitReady(engine, containerId, runner, options = {}) {
    const id = assertImmutableContainerId(containerId, 'start a container');
    const logBaseline = captureContainerLogBaseline(engine, id, runner);
    runner.run(engine.name, ['container', 'start', id]);
    await waitForReadyLine(engine, id, runner, { ...options, logBaseline });
}

export function validateCreatedContainer(ownership, desired) {
    if (ownership?.state !== 'owned' || !ownership.handles?.container) {
        throw lifecycleError('Created Box could not be rediscovered as owned');
    }
    const container = ownership.handles.container;
    validateContainerConfiguration(container, desired);
    if (container.runtime?.running !== true) {
        throw lifecycleError('Box container is not running after readiness validation');
    }
    return container;
}
