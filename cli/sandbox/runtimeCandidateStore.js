import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PLOINKY_WORKSPACE_ROOT } from '../utils/config.js';
import { openVerifiedRegularFile, readVerifiedJsonObject } from '../utils/verifiedReadOnlyFile.js';
import { canonicalizeNetwork } from './networkContract.js';
import { normalizeAgentCgroupReservation, cleanupOwnedContainerCgroup } from './cgroupSubtree.mjs';

const MAX_BYTES = 32 * 1024;
const DESCRIPTOR_TARGET = '/run/ploinky/router-descriptor.json';

function candidateError(message) {
    const error = new Error(`runtime candidate receipt ${message}`);
    error.code = 'PLOINKY_RUNTIME_CANDIDATE_INVALID';
    return error;
}

function location(containerName, record, workspaceRoot) {
    const tuple = [containerName, record?.instanceId, record?.enableGeneration];
    if (tuple.some(value => typeof value !== 'string' || !value.trim() || value.length > 1024)) {
        throw candidateError('requires an exact name, instanceId and enableGeneration');
    }
    const name = `${crypto.createHash('sha256').update(JSON.stringify(tuple)).digest('hex')}.json`;
    const root = path.join(path.resolve(workspaceRoot), '.ploinky', 'run', 'runtime-candidates');
    return { root, name, file: path.join(root, name) };
}

function normalize(candidate) {
    const record = candidate?.registryRecord;
    if (!['docker', 'podman'].includes(candidate?.runtime)
        || !/^[a-f0-9]{64}$/.test(candidate?.containerId || '')
        || !/^[a-f0-9-]{36}$/i.test(candidate?.operationId || '')
        || record?.type !== 'agent'
        || typeof record.agentName !== 'string' || !record.agentName.trim() || record.agentName.length > 1024
        || typeof record.repoName !== 'string' || !record.repoName.trim() || record.repoName.length > 1024
        || (record.alias !== undefined && (typeof record.alias !== 'string' || record.alias.length > 1024))
        || record.containerId !== candidate.containerId
        || record.runtime !== candidate.runtime) {
        throw candidateError('requires its full container ID, runtime and registered agent identity');
    }
    const descriptorBinds = (record.config?.binds || []).filter(bind => bind?.target === DESCRIPTOR_TARGET);
    if (descriptorBinds.length > 1 || descriptorBinds.some(bind => !path.isAbsolute(bind.source || '') || bind.ro !== true)) {
        throw candidateError('has an ambiguous generated Router descriptor bind');
    }
    const lease = candidate.preparationLease;
    const leaseFields = ['transactionId', 'preparedGeneration', 'lifecycleBindingDigest', 'selectorActivationId', 'selectorDigest', 'mode', 'predecessorGeneration'];
    if (lease && (leaseFields.some(field => typeof lease[field] !== 'string')
        || !['replacement', 'additive', 'withdrawn'].includes(lease.mode))) {
        throw candidateError('has an invalid preparation lease');
    }
    return {
        schemaVersion: 1,
        operationId: candidate.operationId,
        containerName: candidate.containerName,
        containerId: candidate.containerId,
        predecessorContainerId: /^[a-f0-9]{64}$/.test(String(candidate.predecessorContainerId || ''))
            ? String(candidate.predecessorContainerId) : '',
        runtime: candidate.runtime,
        runtimeNetwork: canonicalizeNetwork(candidate.runtimeNetwork, { path: 'candidate.runtimeNetwork' }),
        registryRecord: {
            type: 'agent',
            agentName: record.agentName,
            repoName: record.repoName,
            ...(record.alias ? { alias: record.alias } : {}),
            containerId: candidate.containerId,
            runtime: candidate.runtime,
            instanceId: record.instanceId,
            enableGeneration: record.enableGeneration,
            ...(record.cgroupSubtree ? { cgroupSubtree: normalizeAgentCgroupReservation(record.cgroupSubtree, candidate.containerId) } : {}),
            config: { binds: descriptorBinds.map(bind => ({ source: bind.source, target: bind.target, ro: true, generatedRouterDescriptor: true })) },
        },
        preparationLease: lease ? Object.fromEntries(leaseFields.map(field => [field, lease[field]])) : null,
    };
}

// This is durable recovery evidence, not authority to remove a runtime. Every
// consumer must still inspect the exact ID and verify its workspace/agent tuple.
export function writeRuntimeCandidate(candidate, { workspaceRoot = PLOINKY_WORKSPACE_ROOT } = {}) {
    const document = normalize(candidate);
    const { root, file } = location(document.containerName, document.registryRecord, workspaceRoot);
    const bytes = Buffer.from(JSON.stringify(document));
    if (bytes.length > MAX_BYTES) throw candidateError('exceeds its byte limit');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        // Do not replace a previous launch's recovery evidence, even when the
        // attempted launch reused its registry tuple.
        fs.linkSync(temporary, file);
        const directory = fs.openSync(root, 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = readRuntimeCandidate(document.containerName, document.registryRecord, { workspaceRoot });
        if (!existing || JSON.stringify(existing) !== bytes.toString()) {
            throw candidateError('already belongs to a different launch; preserve it until exact cleanup');
        }
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    return Object.freeze(document);
}

export function readRuntimeCandidate(containerName, record, { workspaceRoot = PLOINKY_WORKSPACE_ROOT } = {}) {
    const { root, name } = location(containerName, record, workspaceRoot);
    const stored = readVerifiedJsonObject({ trustedRoot: root, relativeSegments: [name], byteLimit: MAX_BYTES });
    if (!stored) return null;
    const document = normalize(stored);
    if (stored.schemaVersion !== 1 || JSON.stringify(document) !== JSON.stringify(stored)
        || stored.containerName !== containerName
        || stored.registryRecord.instanceId !== record.instanceId
        || stored.registryRecord.enableGeneration !== record.enableGeneration
        || stored.registryRecord.type !== record.type
        || stored.registryRecord.repoName !== record.repoName
        || stored.registryRecord.agentName !== record.agentName
        || String(stored.registryRecord.alias || '') !== String(record.alias || '')
        || record.runtime && stored.runtime !== record.runtime) {
        throw candidateError('does not match its exact launch identity');
    }
    return stored;
}

// Call only after exact absence/removal, or publication of the complete record.
export function retireRuntimeCandidate(candidate, { workspaceRoot = PLOINKY_WORKSPACE_ROOT, cgroupCleanupOptions = {} } = {}) {
    const { root, name } = location(candidate.containerName, candidate.registryRecord, workspaceRoot);
    const stored = readRuntimeCandidate(candidate.containerName, candidate.registryRecord, { workspaceRoot });
    if (!stored) return false;
    if (stored.containerId !== candidate.containerId || stored.operationId !== candidate.operationId) {
        throw candidateError('changed before retirement');
    }
    if (stored.registryRecord.cgroupSubtree) {
        cleanupOwnedContainerCgroup({ containerId: stored.containerId, record: stored.registryRecord,
            ...cgroupCleanupOptions, workspaceRoot, removeEmpty: false });
    }
    const opened = openVerifiedRegularFile({ trustedRoot: root, relativeSegments: [name] });
    if (!opened) return false;
    try {
        const bytes = fs.readFileSync(opened.descriptor, 'utf8');
        const current = fs.lstatSync(opened.path);
        if (bytes !== JSON.stringify(stored) || current.dev !== opened.dev || current.ino !== opened.ino) {
            throw candidateError('changed before retirement');
        }
        fs.unlinkSync(opened.path);
    } finally {
        fs.closeSync(opened.descriptor);
    }
    return true;
}

export function retireAbsentCgroupCandidates(containerId, { workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    cgroupCleanupOptions = {} } = {}) {
    const root = path.join(workspaceRoot, '.ploinky/run/runtime-candidates');
    let names;
    try { names = fs.readdirSync(root).sort(); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (names.length > 512) throw candidateError('cleanup lookup exceeds its bound');
    for (const name of names) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const value = readVerifiedJsonObject({ trustedRoot: root, relativeSegments: [name], byteLimit: MAX_BYTES });
        if (value?.containerId === containerId && value.registryRecord?.cgroupSubtree) {
            retireRuntimeCandidate(value, { workspaceRoot, cgroupCleanupOptions });
        }
    }
}

// One permitted transition: commit the exact observed native identity to the
// reservation persisted before start. Callers hold the existing launch lock.
export function commitRuntimeCandidateCgroup(candidate, reservation, { workspaceRoot = PLOINKY_WORKSPACE_ROOT } = {}) {
    const stored = readRuntimeCandidate(candidate.containerName, candidate.registryRecord, { workspaceRoot });
    if (!stored || stored.containerId !== candidate.containerId || stored.operationId !== candidate.operationId
        || !stored.registryRecord.cgroupSubtree) throw candidateError('cgroup reservation no longer belongs to this launch');
    const previous = stored.registryRecord.cgroupSubtree;
    const observed = normalizeAgentCgroupReservation(reservation, stored.containerId);
    if (!observed.nativeRoot || JSON.stringify({ ...previous, nativeRoot: null }) !== JSON.stringify({ ...observed, nativeRoot: null })
        || previous.nativeRoot && JSON.stringify(previous.nativeRoot) !== JSON.stringify(observed.nativeRoot)) {
        throw candidateError('cgroup reservation changed its authority or committed root');
    }
    const updated = normalize({ ...stored, registryRecord: { ...stored.registryRecord, cgroupSubtree: observed } });
    const { root, name, file } = location(candidate.containerName, candidate.registryRecord, workspaceRoot);
    const opened = openVerifiedRegularFile({ trustedRoot: root, relativeSegments: [name] });
    if (!opened) throw candidateError('disappeared before committing its cgroup identity');
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
        if (fs.readFileSync(opened.descriptor, 'utf8') !== JSON.stringify(stored)) throw candidateError('changed during cgroup commit');
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(updated)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        const stat = fs.lstatSync(file);
        if (stat.dev !== opened.dev || stat.ino !== opened.ino) throw candidateError('identity changed during cgroup commit');
        fs.renameSync(temporary, file);
        const directory = fs.openSync(root, 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally {
        fs.closeSync(opened.descriptor);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return Object.freeze(updated);
}
