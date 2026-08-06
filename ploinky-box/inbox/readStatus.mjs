#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProcessRunner } from '../process.mjs';
import { serializeCloudflarePublicationStatus } from '../cloudflared/status.mjs';
import {
    collectServiceOwnersReadOnly,
    isSandboxOwnerRunning,
} from '../../cli/sandbox/bwrap/bwrapFleet.js';
import { collectProviderTaskOwnersReadOnly } from '../../cli/sandbox/providerTaskOwnership.js';
import { loadActiveEdgeRoutingGeneration } from '../../cli/sandbox/edgeGeneration.js';
import { NETWORK_LABELS } from '../../cli/sandbox/networkLifecycle.js';

const LOCAL_CLOUDFLARE_STATUS = serializeCloudflarePublicationStatus({
    mode: 'local-only',
    management: null,
    state: 'unstarted',
    connectorState: 'absent',
});

function readRegular(target, fsApi) {
    const stat = fsApi.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('not a regular file');
    return fsApi.readFileSync(target, 'utf8');
}

function readJson(target, fsApi, warnings) {
    try {
        const value = JSON.parse(readRegular(target, fsApi));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        return value;
    } catch (error) {
        if (error.code !== 'ENOENT') warnings.push(`${path.basename(target)} is unreadable`);
        return null;
    }
}

function readCloudflarePublicationStatus(ploinkyRoot, fsApi, warnings) {
    const runRoot = path.join(ploinkyRoot, 'run');
    const statusPath = path.join(runRoot, 'cloudflare-publication-status.json');
    try {
        const runStats = fsApi.lstatSync(runRoot);
        if (!runStats.isDirectory() || runStats.isSymbolicLink()) {
            throw new Error('run is not a real directory');
        }
        const value = JSON.parse(readRegular(statusPath, fsApi));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        return serializeCloudflarePublicationStatus(value);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            warnings.push('cloudflare-publication-status.json is unreadable');
        }
        return LOCAL_CLOUDFLARE_STATUS;
    }
}

function exactText(value) {
    return typeof value === 'string'
        && value !== ''
        && value === value.trim()
        && Buffer.byteLength(value, 'utf8') <= 4096
        && !/[\u0000-\u001f\u007f]/u.test(value);
}

function effectiveInstance(runtimeKey, record) {
    return exactText(record?.alias) ? record.alias : runtimeKey;
}

function runtimeStatusName(record) {
    return record.runtime === 'podman' ? 'container' : record.runtime;
}

function canonicalWorkspaceWorkdir(value) {
    return exactText(value)
        && path.posix.isAbsolute(value)
        && path.posix.normalize(value) === value
        && (value === '/workspace' || value.startsWith('/workspace/'));
}

function exactActiveReadiness(active, runtimeKey, record, running) {
    if (!running || active?.selector?.state !== 'active'
        || active?.selector?.publicationState !== 'ready') return false;
    const selected = active?.generation?.agents?.[runtimeKey];
    return selected?.type === 'agent'
        && selected.runtime === record.runtime
        && selected.instanceId === record.instanceId
        && selected.enableGeneration === record.enableGeneration
        && String(selected.releaseGeneration || '') === String(record.releaseGeneration || '');
}

function exactReleaseGeneration(value) {
    const selected = String(value || '');
    return selected === '' || /^[a-f0-9]{64}$/.test(selected);
}

function exactContainerRecord(runtimeKey, record, containerId) {
    return record?.type === 'agent'
        && record.runtime === 'podman'
        && /^[a-f0-9]{64}$/.test(containerId)
        && exactText(record.instanceId)
        && exactText(record.enableGeneration)
        && exactReleaseGeneration(record.releaseGeneration)
        && canonicalWorkspaceWorkdir(record.projectPath)
        // Container HOME is selected canonically by runtime key. If a newer
        // record stores the derived key explicitly, it must be exact.
        && (record.homeKey === undefined || record.homeKey === runtimeKey);
}

function sanitizedOwnedLogPath(ploinkyRoot, value, {
    role = 'service',
    instanceId = '',
    taskId = '',
} = {}) {
    if (!exactText(value) || !path.isAbsolute(value) || path.normalize(value) !== value) return '';
    const logsRoot = path.join(ploinkyRoot, 'logs');
    const relative = path.relative(logsRoot, value);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) return '';
    if (role === 'provider-task') {
        if (!exactText(instanceId) || !exactText(taskId)) return '';
        const expected = path.join(
            logsRoot,
            'agents',
            instanceId,
            'tasks',
            `${taskId}-provider.log`,
        );
        if (value !== expected) return '';
    } else if (relative.split(path.sep).includes('tasks')) {
        return '';
    }
    return value;
}

function expectedHomeKey(runtimeKey, record) {
    return record.runtime === 'podman' ? runtimeKey : record.homeKey;
}

function sandboxIdentityMatches(runtimeKey, record, owner) {
    return Boolean(owner
        && owner.runtimeKey === runtimeKey
        && owner.instanceId === record.instanceId
        && owner.enableGeneration === record.enableGeneration
        && String(owner.releaseGeneration || '') === String(record.releaseGeneration || '')
        && owner.homeKey === expectedHomeKey(runtimeKey, record)
        && exactText(owner.ownerKey)
        && exactText(owner.processIdentity)
        && exactText(owner.workdir));
}

function sandboxStatusEntry(
    ploinkyRoot,
    runtimeKey,
    record,
    owner,
    state,
    authenticatedReady = false,
) {
    return Object.freeze({
        runtime: runtimeStatusName(record),
        role: owner.role,
        effectiveInstance: effectiveInstance(runtimeKey, record),
        generation: owner.enableGeneration,
        releaseGeneration: String(record.releaseGeneration || ''),
        state,
        ownerKey: owner.ownerKey,
        processIdentity: owner.processIdentity,
        workdir: owner.workdir,
        homeKey: owner.homeKey,
        readiness: state === 'running' && authenticatedReady && owner.readiness === 'ready'
            ? 'ready'
            : 'not-ready',
        logPath: sanitizedOwnedLogPath(ploinkyRoot, owner.logPath, {
            role: owner.role,
            instanceId: owner.instanceId,
            taskId: owner.taskId,
        }),
        ...(owner.role === 'provider-task' ? {
            taskId: owner.taskId,
            provider: owner.provider,
        } : {}),
    });
}

function matchingProviderTaskOwners(ploinkyRoot, owners, runtimeKey, record) {
    const runtimeKind = runtimeStatusName(record);
    return owners.filter((owner) => (
        owner.role === 'provider-task'
        && sandboxIdentityMatches(runtimeKey, record, owner)
        && (owner.runtimeKind === runtimeKind || owner.runtime === runtimeKind)
        && exactText(owner.taskId)
        && exactText(owner.provider)
        && sanitizedOwnedLogPath(ploinkyRoot, owner.logPath, {
            role: 'provider-task',
            instanceId: owner.instanceId,
            taskId: owner.taskId,
        }) !== ''
    ));
}

function configuredSandboxStatusEntry(ploinkyRoot, runtimeKey, record) {
    return Object.freeze({
        runtime: runtimeStatusName(record),
        role: 'service',
        effectiveInstance: effectiveInstance(runtimeKey, record),
        generation: exactText(record.enableGeneration) ? record.enableGeneration : '',
        releaseGeneration: String(record.releaseGeneration || ''),
        state: 'stopped',
        ownerKey: '',
        processIdentity: '',
        workdir: exactText(record.projectPath) ? record.projectPath : '',
        homeKey: exactText(record.homeKey) ? record.homeKey : '',
        readiness: 'not-ready',
        logPath: sanitizedOwnedLogPath(ploinkyRoot, record.logPath),
    });
}

function containerStatusEntry(runtimeKey, record, containerId, state, authenticatedReady = false) {
    const running = state === 'running';
    return Object.freeze({
        runtime: 'container',
        role: 'service',
        effectiveInstance: effectiveInstance(runtimeKey, record),
        generation: exactText(record.enableGeneration) ? record.enableGeneration : '',
        releaseGeneration: String(record.releaseGeneration || ''),
        state,
        ownerKey: exactText(containerId) ? `container:${containerId}` : '',
        processIdentity: exactText(containerId) ? `container:${containerId}` : '',
        workdir: exactText(record.projectPath) ? record.projectPath : '',
        homeKey: runtimeKey,
        readiness: running && authenticatedReady ? 'ready' : 'not-ready',
        logPath: /^[a-f0-9]{64}$/.test(containerId) ? `podman://${containerId}` : '',
    });
}

export function readInboxStatus({
    workspaceRoot = '/workspace',
    fsApi = fs,
    runner = createProcessRunner(),
    collectSandboxOwners = collectProviderTaskOwnersReadOnly,
    collectSandboxServiceOwners = collectServiceOwnersReadOnly,
    readSandboxServiceOwner,
    inspectSandboxServiceOwner = (owner) => isSandboxOwnerRunning(owner.ownerKey, owner),
    loadActiveGeneration = (options) => loadActiveEdgeRoutingGeneration(options),
} = {}) {
    const root = path.resolve(workspaceRoot);
    const ploinkyRoot = path.join(root, '.ploinky');
    const warnings = [];
    let marker;
    try { marker = fsApi.lstatSync(ploinkyRoot); } catch (error) {
        if (error.code === 'ENOENT') {
            return Object.freeze({
                state: 'not-initialized',
                initialized: false,
                routingConfigured: false,
                trackedAgents: 0,
                runningAgents: 0,
                runtimes: Object.freeze([]),
                cloudflarePublication: LOCAL_CLOUDFLARE_STATUS,
                warnings: Object.freeze([]),
            });
        }
        throw error;
    }
    if (marker.isSymbolicLink() || !marker.isDirectory()) {
        return Object.freeze({
            state: 'invalid-initialization', initialized: false,
            routingConfigured: false, trackedAgents: 0, runningAgents: 0,
            runtimes: Object.freeze([]),
            cloudflarePublication: LOCAL_CLOUDFLARE_STATUS,
            warnings: Object.freeze(['.ploinky is not a real directory']),
        });
    }
    const routing = readJson(path.join(ploinkyRoot, 'routing.json'), fsApi, warnings);
    const agents = readJson(path.join(ploinkyRoot, 'agents.json'), fsApi, warnings) || {};
    let activeGeneration = null;
    try { activeGeneration = loadActiveGeneration({ workspaceRoot: root }); } catch (_) {}
    const cloudflarePublication = readCloudflarePublicationStatus(ploinkyRoot, fsApi, warnings);
    const tracked = Object.entries(agents).filter(([, record]) => (
        record && ['agent', 'agentCore'].includes(record.type)
    ));
    let runningAgents = 0;
    const runtimes = [];
    let sandboxOwners = [];
    let sandboxServiceOwners = new Map();
    if (tracked.length > 0) {
        try {
            sandboxOwners = collectSandboxOwners() || [];
            if (!Array.isArray(sandboxOwners)) throw new Error('not an owner list');
        } catch {
            warnings.push('sandbox ownership state is unreadable');
            sandboxOwners = [];
        }
        if (typeof readSandboxServiceOwner !== 'function') {
            try {
                const owners = collectSandboxServiceOwners() || [];
                if (!Array.isArray(owners)) throw new Error('not a service owner list');
                sandboxServiceOwners = new Map(owners.map((owner) => [owner.runtimeKey, owner]));
            } catch {
                warnings.push('sandbox service ownership state is unreadable');
            }
        }
    }
    const readExactSandboxServiceOwner = typeof readSandboxServiceOwner === 'function'
        ? readSandboxServiceOwner
        : (runtimeKey) => sandboxServiceOwners.get(runtimeKey) || null;
    for (const [recordedName, record] of tracked) {
        if (record.runtime === 'bwrap' || record.runtime === 'seatbelt') {
            const matchingOwners = sandboxOwners.filter((owner) => (
                sandboxIdentityMatches(recordedName, record, owner)
            ));
            let serviceOwner = null;
            try {
                serviceOwner = readExactSandboxServiceOwner(recordedName);
                if (!sandboxIdentityMatches(recordedName, record, serviceOwner)
                    || serviceOwner.role !== 'service') serviceOwner = null;
            } catch {
                warnings.push(`${recordedName} sandbox service ownership is unreadable`);
            }
            let serviceRunning = false;
            let serviceReady = false;
            if (serviceOwner) {
                try {
                    serviceRunning = inspectSandboxServiceOwner(serviceOwner) === true;
                } catch {
                    warnings.push(`${recordedName} sandbox service identity is unverified`);
                }
                serviceReady = exactActiveReadiness(
                    activeGeneration,
                    recordedName,
                    record,
                    serviceRunning,
                );
                if (serviceRunning) runningAgents += 1;
                runtimes.push(sandboxStatusEntry(
                    ploinkyRoot,
                    recordedName,
                    record,
                    serviceOwner,
                    serviceRunning ? 'running' : 'failed',
                    serviceReady,
                ));
            } else {
                warnings.push(`${recordedName} lacks an exact sandbox service owner`);
                runtimes.push(configuredSandboxStatusEntry(ploinkyRoot, recordedName, record));
            }
            for (const owner of matchingProviderTaskOwners(
                ploinkyRoot,
                matchingOwners,
                recordedName,
                record,
            )) {
                if (!serviceRunning) warnings.push(`${recordedName} has an unverified provider-task owner`);
                runtimes.push(sandboxStatusEntry(
                    ploinkyRoot,
                    recordedName,
                    record,
                    owner,
                    !serviceReady || owner.state === 'failed' ? 'failed' : 'running',
                    serviceReady,
                ));
            }
            continue;
        }
        const containerId = String(record.containerId || '').trim().toLowerCase();
        if (!exactContainerRecord(recordedName, record, containerId)) {
            warnings.push(`${recordedName} lacks a complete nested-Podman identity`);
            if (/^[a-f0-9]{64}$/.test(containerId)) {
                runtimes.push(containerStatusEntry(
                    recordedName,
                    record,
                    containerId,
                    'failed',
                ));
            }
            continue;
        }
        const inspected = runner.query('podman', ['container', 'inspect', containerId]);
        if (!inspected.ok) {
            warnings.push(`${recordedName} disappeared during status inspection`);
            runtimes.push(containerStatusEntry(
                recordedName,
                record,
                containerId,
                'failed',
            ));
            continue;
        }
        try {
            const values = JSON.parse(inspected.stdout);
            const value = Array.isArray(values) && values.length === 1 ? values[0] : null;
            const id = String(value?.Id ?? value?.ID ?? '').toLowerCase();
            const name = String(value?.Name ?? '').replace(/^\//, '');
            const labels = value?.Config?.Labels || value?.Labels || {};
            const exactReleaseOwnership = String(labels[NETWORK_LABELS.releaseGeneration] || '')
                === String(record.releaseGeneration || '')
                && (!record.releaseGeneration || (
                    labels[NETWORK_LABELS.managed] === '1'
                    && labels[NETWORK_LABELS.resource] === 'agent'
                    && String(labels[NETWORK_LABELS.instanceId] || '') === record.instanceId
                    && String(labels[NETWORK_LABELS.enableGeneration] || '') === record.enableGeneration
                ));
            if (id !== containerId || name !== recordedName || !exactReleaseOwnership) {
                warnings.push(`${recordedName} changed identity during status inspection`);
                runtimes.push(containerStatusEntry(
                    recordedName,
                    record,
                    containerId,
                    'failed',
                ));
            } else if (value?.State?.Running === true || value?.State?.Status === 'running') {
                runningAgents += 1;
                const containerReady = exactActiveReadiness(
                    activeGeneration,
                    recordedName,
                    record,
                    true,
                );
                runtimes.push(containerStatusEntry(
                    recordedName,
                    record,
                    containerId,
                    'running',
                    containerReady,
                ));
                for (const owner of matchingProviderTaskOwners(
                    ploinkyRoot,
                    sandboxOwners,
                    recordedName,
                    record,
                )) {
                    runtimes.push(sandboxStatusEntry(
                        ploinkyRoot,
                        recordedName,
                        record,
                        owner,
                        !containerReady || owner.state === 'failed' ? 'failed' : 'running',
                        containerReady,
                    ));
                }
            } else {
                runtimes.push(containerStatusEntry(
                    recordedName,
                    record,
                    containerId,
                    'stopped',
                ));
            }
        } catch {
            warnings.push(`${recordedName} returned malformed status`);
            runtimes.push(containerStatusEntry(
                recordedName,
                record,
                containerId,
                'failed',
            ));
        }
    }
    return Object.freeze({
        state: 'initialized',
        initialized: true,
        routingConfigured: Boolean(routing),
        trackedAgents: tracked.length,
        runningAgents,
        runtimes: Object.freeze(runtimes),
        cloudflarePublication,
        warnings: Object.freeze(warnings),
    });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    process.stdout.write(`${JSON.stringify(readInboxStatus())}\n`);
}
