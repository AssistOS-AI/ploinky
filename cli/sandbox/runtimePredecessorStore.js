import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PLOINKY_WORKSPACE_ROOT } from '../utils/config.js';
import { openVerifiedRegularFile, readVerifiedJsonObject } from '../utils/verifiedReadOnlyFile.js';

// Workspace graph staging persists each rotated registry tuple before it
// removes the predecessor, and that record keeps the predecessor's container
// ID under the fresh tuple. A start that stops in between (a cancelled update's
// rollback, a failed removal) would leave the next start no proof of which
// tuple the still-present predecessor carries. This receipt, written before the
// rotated tuple and keyed by it, records the predecessor's own tuple.
//
// It is durable evidence, not authority to remove a runtime: every consumer
// still inspects the exact ID and verifies the workspace, managed labels and
// tuple the container itself carries.

const MAX_BYTES = 32 * 1024;
const DESCRIPTOR_TARGET = '/run/ploinky/router-descriptor.json';
const IMMUTABLE_ID = /^[a-f0-9]{64}$/;

function predecessorError(message) {
    const error = new Error(`runtime predecessor receipt ${message}`);
    error.code = 'PLOINKY_RUNTIME_PREDECESSOR_INVALID';
    return error;
}

const exactString = (value) => typeof value === 'string' && value.length > 0
    && value.length <= 1024 && value === value.trim();

export function hasCompleteRuntimeTuple(record) {
    return exactString(record?.instanceId) && exactString(record?.enableGeneration)
        && record.instanceId !== record.enableGeneration;
}

function location(containerName, successor, workspaceRoot) {
    if (!exactString(containerName) || !hasCompleteRuntimeTuple(successor)) {
        throw predecessorError('requires an exact name and rotated instanceId/enableGeneration');
    }
    const tuple = [containerName, successor.instanceId, successor.enableGeneration];
    const name = `${crypto.createHash('sha256').update(JSON.stringify(tuple)).digest('hex')}.json`;
    const root = path.join(path.resolve(workspaceRoot), '.ploinky', 'run', 'runtime-predecessors');
    return { root, name, file: path.join(root, name) };
}

function normalize({ containerName, successor, predecessor } = {}) {
    const containerId = String(predecessor?.containerId || '');
    const runtime = String(predecessor?.runtime || '');
    if (!exactString(containerName)
        || !hasCompleteRuntimeTuple(successor)
        || predecessor?.type !== 'agent'
        || !exactString(predecessor.agentName)
        || !exactString(predecessor.repoName)
        || (predecessor.alias !== undefined && predecessor.alias !== null
            && (typeof predecessor.alias !== 'string' || predecessor.alias.length > 1024))
        || !hasCompleteRuntimeTuple(predecessor)
        || [predecessor.instanceId, predecessor.enableGeneration]
            .some((value) => value === successor.instanceId || value === successor.enableGeneration)
        || (containerId && !IMMUTABLE_ID.test(containerId))
        || (runtime && !['docker', 'podman'].includes(runtime))) {
        throw predecessorError('requires an exact registered predecessor tuple distinct from its rotated tuple');
    }
    const binds = predecessor.config?.binds ?? [];
    if (!Array.isArray(binds)) throw predecessorError('has malformed registry binds');
    const descriptorBinds = binds.filter((bind) => (
        bind?.generatedRouterDescriptor === true || bind?.target === DESCRIPTOR_TARGET
    ));
    if (descriptorBinds.length > 1 || descriptorBinds.some((bind) => (
        bind.target !== DESCRIPTOR_TARGET || !path.isAbsolute(bind.source || '') || bind.ro !== true
    ))) {
        throw predecessorError('has an ambiguous generated Router descriptor bind');
    }
    return {
        schemaVersion: 1,
        containerName,
        successor: { instanceId: successor.instanceId, enableGeneration: successor.enableGeneration },
        predecessor: {
            type: 'agent',
            agentName: predecessor.agentName,
            repoName: predecessor.repoName,
            ...(predecessor.alias ? { alias: predecessor.alias } : {}),
            ...(containerId ? { containerId } : {}),
            ...(runtime ? { runtime } : {}),
            instanceId: predecessor.instanceId,
            enableGeneration: predecessor.enableGeneration,
            config: {
                binds: descriptorBinds.map((bind) => ({
                    source: bind.source, target: bind.target, ro: true, generatedRouterDescriptor: true,
                })),
            },
        },
    };
}

// Durable before it returns: the caller writes the rotated registry only after.
export function writeRuntimePredecessor(receipt, { workspaceRoot = PLOINKY_WORKSPACE_ROOT } = {}) {
    const document = normalize(receipt);
    const { root, file } = location(document.containerName, document.successor, workspaceRoot);
    const bytes = Buffer.from(JSON.stringify(document));
    if (bytes.length > MAX_BYTES) throw predecessorError('exceeds its byte limit');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.linkSync(temporary, file);
        const directory = fs.openSync(root, 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = readVerifiedJsonObject({ trustedRoot: root, relativeSegments: [path.basename(file)], byteLimit: MAX_BYTES });
        if (!existing || JSON.stringify(existing) !== bytes.toString()) {
            throw predecessorError('already records a different predecessor for this rotated tuple');
        }
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    return Object.freeze(document);
}

// The receipt left for the current registry record, or null. One that exists
// but does not bind to this exact record is refused, never ignored.
export function readRuntimePredecessor(containerName, record, { workspaceRoot = PLOINKY_WORKSPACE_ROOT } = {}) {
    if (!hasCompleteRuntimeTuple(record)) return null;
    const { root, name, file } = location(containerName, record, workspaceRoot);
    const stored = readVerifiedJsonObject({ trustedRoot: root, relativeSegments: [name], byteLimit: MAX_BYTES });
    if (!stored) return null;
    let document;
    try {
        document = normalize(stored);
    } catch (error) {
        throw predecessorError(`at ${file} is malformed: ${error.message}`);
    }
    const predecessor = document.predecessor;
    if (stored.schemaVersion !== 1 || JSON.stringify(document) !== JSON.stringify(stored)
        || document.containerName !== containerName
        || document.successor.instanceId !== record.instanceId
        || document.successor.enableGeneration !== record.enableGeneration
        || record.type !== 'agent'
        || predecessor.repoName !== record.repoName
        || predecessor.agentName !== record.agentName
        || String(predecessor.alias || '') !== String(record.alias || '')
        // The rotated record spreads the predecessor, so both name the same
        // container ID (or none, for a predecessor that was never published).
        || String(predecessor.containerId || '') !== String(record.containerId || '')
        || (record.runtime && predecessor.runtime && predecessor.runtime !== record.runtime)) {
        throw predecessorError(`at ${file} does not match the exact registered record of '${containerName}'`);
    }
    return Object.freeze(document);
}

// Call only after the exact predecessor was removed or reported absent, or
// once a later durable receipt carries the same predecessor.
export function retireRuntimePredecessor(receipt, { workspaceRoot = PLOINKY_WORKSPACE_ROOT } = {}) {
    const { root, name } = location(receipt?.containerName, receipt?.successor, workspaceRoot);
    const opened = openVerifiedRegularFile({ trustedRoot: root, relativeSegments: [name] });
    if (!opened) return false;
    try {
        const bytes = fs.readFileSync(opened.descriptor, 'utf8');
        const current = fs.lstatSync(opened.path);
        if (bytes !== JSON.stringify(normalize(receipt)) || current.dev !== opened.dev || current.ino !== opened.ino) {
            throw predecessorError('changed before retirement');
        }
        fs.unlinkSync(opened.path);
    } finally {
        fs.closeSync(opened.descriptor);
    }
    return true;
}
