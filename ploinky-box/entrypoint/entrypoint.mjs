#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NETWORK_SCHEMA_VERSION } from '../../cli/sandbox/networkContract.js';
import {
    BOX_MARKER_CONTENT,
    BOX_READY_LINE,
} from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { createProcessRunner } from '../process.mjs';
import { initializeWorkspaceMasterKey } from './initialize-workspace.mjs';
import { installPinnedDependencies } from './install-dependencies.mjs';
import { configureBoxTransport } from './transport.mjs';

function entrypointError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_ENTRYPOINT_FAILED',
        cause,
    });
}

export function formatEntrypointFailure(error, { limit = 2048 } = {}) {
    const messages = [];
    const seen = new Set();
    let current = error;
    while (current && typeof current === 'object' && !seen.has(current) && messages.length < 4) {
        seen.add(current);
        const message = String(current.message || '')
            .trim()
            .replace(/\s+/g, ' ');
        if (message && messages.at(-1) !== message) messages.push(message);
        current = current.cause;
    }
    const diagnostic = messages.join('; cause: ') || 'unknown Box entrypoint failure';
    return diagnostic.length <= limit
        ? diagnostic
        : `${diagnostic.slice(0, Math.max(0, limit - 1))}…`;
}

function rooted(root, productionPath) {
    const selectedRoot = path.resolve(root);
    return selectedRoot === '/'
        ? productionPath
        : path.join(selectedRoot, productionPath.replace(/^\/+/, ''));
}

export function entrypointPaths(root = '/') {
    return Object.freeze({
        marker: rooted(root, '/etc/ploinky-box'),
        workspace: rooted(root, '/workspace'),
        dependencies: rooted(root, '/opt/ploinky/node_modules'),
        ploinky: rooted(root, '/opt/ploinky/bin/ploinky'),
        nestedStore: rooted(root, '/home/podman/.local/share/containers'),
        transport: rooted(root, '/run/ploinky/box-transport.json'),
        containersConf: rooted(root, '/home/podman/.config/containers/containers.conf'),
        tmp: rooted(root, '/tmp'),
    });
}

export function verifyEntrypointMarker(markerPath, fsApi = fs) {
    let stat;
    let bytes;
    try {
        stat = fsApi.lstatSync(markerPath);
        bytes = fsApi.readFileSync(markerPath);
    } catch (error) {
        throw entrypointError(`Unable to read Box marker ${markerPath}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
        || !bytes.equals(Buffer.from(BOX_MARKER_CONTENT))) {
        throw entrypointError('Box marker has invalid content');
    }
}

function assertDirectory(target, { writable = false } = {}, fsApi = fs) {
    const stat = fsApi.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw entrypointError(`Required mount target is not a real directory: ${target}`);
    }
    if (writable) fsApi.accessSync(target, fsApi.constants.W_OK);
}

const MANAGED_CONTAINER_LABELS = Object.freeze({
    managed: 'io.assistos.ploinky.managed',
    resource: 'io.assistos.ploinky.resource',
    schema: 'io.assistos.ploinky.network-schema',
    workspace: 'io.assistos.ploinky.workspace',
    contract: 'io.assistos.ploinky.network-contract',
    instanceId: 'io.assistos.ploinky.instance-id',
    enableGeneration: 'io.assistos.ploinky.enable-generation',
    releaseGeneration: 'io.assistos.ploinky.release-generation',
});
const REMOVABLE_RETAINED_STATES = new Set(['configured', 'created', 'exited', 'stopped']);

function readEntrypointAgentRegistry(workspaceRoot, fsApi) {
    const target = path.join(workspaceRoot, '.ploinky', 'agents.json');
    let stat;
    let bytes;
    try {
        stat = fsApi.lstatSync(target);
        bytes = fsApi.readFileSync(target);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw entrypointError('Unable to read the retained agent registry', error);
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
        || bytes.length > 1024 * 1024) {
        throw entrypointError('Retained agent registry must be one bounded regular file');
    }
    try {
        const registry = JSON.parse(bytes.toString('utf8'));
        if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
            throw new Error('expected an object');
        }
        return registry;
    } catch (error) {
        throw entrypointError('Retained agent registry is malformed', error);
    }
}

function parseSingleContainerInspection(result, containerId) {
    if (!result?.ok) {
        throw entrypointError(`Unable to inspect retained managed container ${containerId}`);
    }
    let records;
    try {
        records = JSON.parse(String(result.stdout || ''));
    } catch (error) {
        throw entrypointError(`Retained managed container inspection is malformed for ${containerId}`, error);
    }
    if (!Array.isArray(records) || records.length !== 1
        || !records[0] || typeof records[0] !== 'object') {
        throw entrypointError(`Retained managed container inspection is not singular for ${containerId}`);
    }
    return records[0];
}

export function retireStoppedManagedContainers(paths, {
    fsApi = fs,
    runner = createProcessRunner(),
} = {}) {
    const registry = readEntrypointAgentRegistry(paths.workspace, fsApi);
    if (!registry) return Object.freeze([]);
    const listed = runner.query('podman', [
        'container', 'ps', '--all', '--quiet', '--no-trunc',
        '--filter', 'label=io.assistos.ploinky.managed=1',
    ]);
    if (!listed.ok) {
        throw entrypointError('Unable to enumerate retained Ploinky-managed containers');
    }
    const containerIds = String(listed.stdout || '')
        .split(/\r?\n/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    const workspaceHash = crypto.createHash('sha256')
        .update(fsApi.realpathSync(paths.workspace))
        .digest('hex')
        .slice(0, 12);
    const removed = [];
    for (const containerId of containerIds) {
        if (!/^[a-f0-9]{64}$/.test(containerId)) {
            throw entrypointError('Retained managed container enumeration returned a non-immutable ID');
        }
        const record = parseSingleContainerInspection(
            runner.query('podman', ['container', 'inspect', containerId]),
            containerId,
        );
        const observedId = String(record.Id ?? record.ID ?? '').trim().toLowerCase();
        const observedName = String(record.Name || '').replace(/^\//, '');
        const registered = registry[observedName];
        const labels = record.Config?.Labels || record.Labels || {};
        const ploinkyLabelKeys = Object.keys(labels)
            .filter((key) => key.startsWith('io.assistos.ploinky.'));
        const legacyHelperOwnership = !registered
            && observedId === containerId
            && labels[MANAGED_CONTAINER_LABELS.managed] === '1'
            && ploinkyLabelKeys.length === 1;
        const registeredInstanceId = String(registered?.instanceId || '');
        const registeredEnableGeneration = String(registered?.enableGeneration || '');
        const registeredReleaseGeneration = String(registered?.releaseGeneration || '');
        const registeredContainerId = String(registered?.containerId || '').trim().toLowerCase();
        const observedInstanceId = String(labels[MANAGED_CONTAINER_LABELS.instanceId] || '');
        const observedEnableGeneration = String(
            labels[MANAGED_CONTAINER_LABELS.enableGeneration] || '',
        );
        const observedReleaseGeneration = String(
            labels[MANAGED_CONTAINER_LABELS.releaseGeneration] || '',
        );
        const validRegisteredReleaseGeneration = registeredReleaseGeneration === ''
            || /^[a-f0-9]{64}$/.test(registeredReleaseGeneration);
        const exactReleaseOwnership = validRegisteredReleaseGeneration
            && observedReleaseGeneration === registeredReleaseGeneration;
        const hasRegisteredLifecycleOwnership = Boolean(
            registeredInstanceId && registeredEnableGeneration,
        );
        const exactLifecycleOwnership = hasRegisteredLifecycleOwnership
            && observedInstanceId === registeredInstanceId
            && observedEnableGeneration === registeredEnableGeneration;
        // A stopped predecessor can have no lifecycle labels (older runtime)
        // or a complete stale pair after the registry staged its successor.
        // Partial or mixed pairs remain ownership drift and fail closed.
        const absentLifecycleOwnership = hasRegisteredLifecycleOwnership
            && observedInstanceId === ''
            && observedEnableGeneration === '';
        const staleLifecycleOwnership = hasRegisteredLifecycleOwnership
            && observedInstanceId !== ''
            && observedEnableGeneration !== ''
            && observedInstanceId !== registeredInstanceId
            && observedEnableGeneration !== registeredEnableGeneration;
        const ownershipMismatches = [
            observedId === containerId || 'container-id',
            Boolean(registered) || 'registry-record',
            ['agent', 'agentCore'].includes(registered?.type) || 'registry-type',
            registered?.runtime === 'podman' || 'registry-runtime',
            registeredContainerId === containerId || 'registry-container-id',
            labels[MANAGED_CONTAINER_LABELS.managed] === '1' || 'managed-label',
            labels[MANAGED_CONTAINER_LABELS.resource] === 'agent' || 'resource-label',
            labels[MANAGED_CONTAINER_LABELS.schema] === NETWORK_SCHEMA_VERSION || 'schema-label',
            labels[MANAGED_CONTAINER_LABELS.workspace] === workspaceHash || 'workspace-label',
            /^[a-f0-9]{64}$/.test(String(labels[MANAGED_CONTAINER_LABELS.contract] || ''))
                || 'contract-label',
            exactReleaseOwnership || 'release-ownership-label',
            (
                exactLifecycleOwnership
                || absentLifecycleOwnership
                || staleLifecycleOwnership
            )
                || 'lifecycle-ownership-labels',
        ].filter((value) => value !== true);
        const stagedPredecessorOwnership = staleLifecycleOwnership
            && /^[a-f0-9]{64}$/.test(registeredContainerId)
            && ownershipMismatches.length === 1
            && ownershipMismatches[0] === 'registry-container-id';
        if (
            ownershipMismatches.length > 0
            && !legacyHelperOwnership
            && !stagedPredecessorOwnership
        ) {
            throw entrypointError(
                `Retained managed container ${containerId} does not match its exact registry ownership (${ownershipMismatches.join(', ')})`,
            );
        }
        const retainedState = String(record.State?.Status || '').toLowerCase();
        if (record.State?.Running === true || !REMOVABLE_RETAINED_STATES.has(retainedState)) {
            throw entrypointError(
                `Retained managed container ${containerId} is not in an exact non-running removable state`,
            );
        }
        runner.run('podman', ['container', 'rm', containerId]);
        removed.push(containerId);
    }
    return Object.freeze(removed);
}

export function validateEntrypointMounts(paths, fsApi = fs) {
    try {
        assertDirectory(paths.workspace, { writable: true }, fsApi);
        assertDirectory(paths.dependencies, { writable: true }, fsApi);
        assertDirectory(paths.nestedStore, { writable: true }, fsApi);
        const source = fsApi.lstatSync(paths.ploinky);
        if (source.isSymbolicLink() || !source.isFile()) {
            throw entrypointError(`Ploinky source entrypoint is not a regular file: ${paths.ploinky}`);
        }
        fsApi.accessSync(paths.ploinky, fsApi.constants.R_OK | fsApi.constants.X_OK);
    } catch (error) {
        if (error instanceof PloinkyBoxError) throw error;
        throw entrypointError('Required Box mount is missing or not writable by podman', error);
    }
}

export function resetTransientNestedRuntime(paths, {
    fsApi = fs,
    uid = typeof process.getuid === 'function' ? process.getuid() : 0,
} = {}) {
    for (const name of [`storage-run-${uid}`, `podman-run-${uid}`]) {
        const target = path.join(paths.tmp, name);
        fsApi.rmSync(target, { recursive: true, force: true });
    }
}

export function prepareEntrypoint({
    root = '/',
    fsApi = fs,
    runner = createProcessRunner(),
    initialize = initializeWorkspaceMasterKey,
    configureTransport = configureBoxTransport,
    resetRuntime = resetTransientNestedRuntime,
    retireContainers = retireStoppedManagedContainers,
    installDependencies = installPinnedDependencies,
    transportOptions = {},
} = {}) {
    const paths = entrypointPaths(root);
    verifyEntrypointMarker(paths.marker, fsApi);
    validateEntrypointMounts(paths, fsApi);
    initialize({ workspaceRoot: paths.workspace, fsApi });
    const transport = configureTransport({
        runner,
        transportFile: paths.transport,
        containersConf: paths.containersConf,
        fsApi,
        ...transportOptions,
    });
    resetRuntime(paths, { fsApi });
    retireContainers(paths, { fsApi, runner });
    installDependencies({
        targetRoot: paths.dependencies,
        markerPath: paths.marker,
        fsApi,
        runner,
    });
    return Object.freeze({ paths, transport });
}

export function runEntrypoint({
    output = process.stdout,
    selfCheck = () => {},
    ...options
} = {}) {
    const prepared = prepareEntrypoint(options);
    selfCheck(prepared);
    output.write(`${BOX_READY_LINE}\n`);
    return prepared;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        const prepareOnly = process.argv.slice(2).includes('--prepare-only');
        if (prepareOnly) prepareEntrypoint();
        else runEntrypoint();
    } catch (error) {
        process.stderr.write(`[ploinky-box] SELF-CHECK FAILED: ${formatEntrypointFailure(error)}\n`);
        process.exitCode = 1;
    }
}
