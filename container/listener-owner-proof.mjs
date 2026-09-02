import fs from 'node:fs';
import { parseOwnerAwareSsOutput } from './listener-owner-merge.mjs';

function requireValue(value, message) {
    if (!value) throw new Error(`listener owner proof ${message}`);
}

function positivePid(value) {
    requireValue(Number.isSafeInteger(value) && value > 0, 'has an invalid PID');
    return value;
}

function validNamespace(value) {
    requireValue(typeof value === 'string' && /^pid:\[[1-9][0-9]*]$/.test(value), 'has an invalid PID namespace');
    return value;
}

function decimal(value, label) {
    requireValue(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value), `has an invalid ${label}`);
    return value;
}

function requestedProcesses(request) {
    requireValue(Array.isArray(request?.inits) && Array.isArray(request?.owners), 'request is malformed');
    const processes = new Map();
    const get = (pid) => {
        positivePid(pid);
        if (!processes.has(pid)) processes.set(pid, { pid, names: new Set(), namespaces: new Set(), descriptors: new Map() });
        return processes.get(pid);
    };
    for (const init of request.inits) get(init.pid).namespaces.add(validNamespace(init.pidNamespace));
    for (const owner of request.owners) {
        const process = get(owner.pid);
        requireValue(typeof owner.name === 'string' && owner.name.length > 0, 'request has an invalid process name');
        process.names.add(owner.name);
        requireValue(Number.isSafeInteger(owner.fd) && owner.fd >= 0, 'request has an invalid descriptor');
        const inode = decimal(owner.socketInode, 'socket inode');
        requireValue(inode !== '0', 'request has a zero socket inode');
        const previous = process.descriptors.get(owner.fd);
        requireValue(previous === undefined || previous === inode, 'descriptor refers to different sockets');
        process.descriptors.set(owner.fd, inode);
    }
    for (const process of processes.values()) {
        requireValue(process.names.size <= 1 && process.namespaces.size <= 1, 'request has conflicting process identities');
    }
    return processes;
}

function statIdentity(text, expectedPid) {
    const opening = text.indexOf('(');
    const closing = text.lastIndexOf(')');
    requireValue(opening > 0 && closing > opening, `PID ${expectedPid} has malformed proc stat`);
    const pid = Number(text.slice(0, opening).trim());
    const fields = text.slice(closing + 1).trim().split(/\s+/);
    requireValue(pid === expectedPid && fields.length >= 20, `PID ${expectedPid} has malformed proc stat identity`);
    return { pid, name: text.slice(opening + 1, closing), startTimeTicks: decimal(fields[19], 'process start time') };
}

/** Read only safe process identity fields; no command lines or environments enter evidence. */
export function readSocketOwnerProofBatch(request, { procRoot = '/proc', fsImpl = fs } = {}) {
    const processes = requestedProcesses(request);
    const outerPidNamespace = validNamespace(fsImpl.readlinkSync(`${procRoot}/self/ns/pid`));
    const result = [];
    for (const expected of [...processes.values()].sort((left, right) => left.pid - right.pid)) {
        const root = `${procRoot}/${expected.pid}`;
        const first = statIdentity(fsImpl.readFileSync(`${root}/stat`, 'utf8'), expected.pid);
        const namespace = validNamespace(fsImpl.readlinkSync(`${root}/ns/pid`));
        const descriptors = [...expected.descriptors].sort(([left], [right]) => left - right).map(([fd, socketInode]) => {
            const target = fsImpl.readlinkSync(`${root}/fd/${fd}`);
            requireValue(target === `socket:[${socketInode}]`, `PID ${expected.pid} descriptor ${fd} changed socket inode`);
            return { fd, socketInode };
        });
        for (const { fd, socketInode } of descriptors) {
            requireValue(fsImpl.readlinkSync(`${root}/fd/${fd}`) === `socket:[${socketInode}]`,
                `PID ${expected.pid} descriptor ${fd} changed while observed`);
        }
        requireValue(fsImpl.readlinkSync(`${root}/ns/pid`) === namespace, `PID ${expected.pid} changed PID namespace`);
        const last = statIdentity(fsImpl.readFileSync(`${root}/stat`, 'utf8'), expected.pid);
        requireValue(JSON.stringify(first) === JSON.stringify(last), `PID ${expected.pid} changed process generation`);
        requireValue(!expected.names.size || expected.names.has(first.name), `PID ${expected.pid} process name differs from ss`);
        requireValue(!expected.namespaces.size || expected.namespaces.has(namespace), `PID ${expected.pid} init namespace changed`);
        result.push({ ...first, pidNamespace: namespace, descriptors });
    }
    return { outerPidNamespace, processes: result };
}

export function parseSocketOwnerProofBatch(stdout, request) {
    const value = JSON.parse(String(stdout));
    validNamespace(value?.outerPidNamespace);
    const expected = requestedProcesses(request);
    requireValue(Array.isArray(value?.processes) && value.processes.length === expected.size, 'response has a different PID set');
    const seen = new Set();
    const processes = value.processes.map((process) => {
        const required = expected.get(positivePid(process.pid));
        requireValue(required && !seen.has(process.pid), 'response repeats or invents a PID');
        seen.add(process.pid);
        decimal(process.startTimeTicks, 'process start time');
        validNamespace(process.pidNamespace);
        requireValue(typeof process.name === 'string' && process.name.length > 0, 'response has no process name');
        requireValue(!required.names.size || required.names.has(process.name), `PID ${process.pid} process name differs from ss`);
        requireValue(!required.namespaces.size || required.namespaces.has(process.pidNamespace), `PID ${process.pid} init namespace changed`);
        requireValue(Array.isArray(process.descriptors) && process.descriptors.length === required.descriptors.size,
            `PID ${process.pid} response has a different descriptor set`);
        const seenDescriptors = new Set();
        const descriptors = process.descriptors.map(({ fd, socketInode }) => {
            requireValue(!seenDescriptors.has(fd) && required.descriptors.get(fd) === socketInode,
                `PID ${process.pid} response has a changed or duplicate descriptor`);
            seenDescriptors.add(fd);
            return Object.freeze({ fd, socketInode });
        }).sort((left, right) => left.fd - right.fd);
        return Object.freeze({ pid: process.pid, name: process.name, startTimeTicks: process.startTimeTicks,
            pidNamespace: process.pidNamespace, descriptors: Object.freeze(descriptors) });
    }).sort((left, right) => left.pid - right.pid);
    return Object.freeze({ outerPidNamespace: value.outerPidNamespace, processes: Object.freeze(processes) });
}

function ownerKey(owner) {
    return JSON.stringify([owner.name, owner.pid, owner.fd]);
}

function socketKey(record) {
    return JSON.stringify([record.namespace, record.protocol, record.socketInode, record.socketCookie]);
}

function socketState(record) {
    return JSON.stringify([record.state, record.bindAddress, record.port, record.peerEndpoint,
        record.owners.map(ownerKey).sort()]);
}

function assertSameSockets(before, after) {
    const expected = new Map(before.map(record => [socketKey(record), socketState(record)]));
    requireValue(expected.size === before.length && after.length === before.length,
        'socket set changed while process ownership was observed');
    const seen = new Set();
    for (const record of after) {
        const key = socketKey(record);
        requireValue(!seen.has(key) && expected.get(key) === socketState(record),
            'socket generation, endpoint, or owner set changed while process ownership was observed');
        seen.add(key);
    }
}

function targetsForRecords(records, nested) {
    const targets = new Map();
    const descriptorSockets = new Map();
    for (const record of records) {
        requireValue(Array.isArray(record.owners) && record.owners.length > 0, 'socket has no exact owner descriptors');
        let directOwners = new Set();
        if (!nested) {
            const direct = record.ownerObservations?.find(observation => observation.context === 'owner-before');
            requireValue(direct, 'outer socket lacks its original owner context');
            directOwners = new Set(parseOwnerAwareSsOutput(direct.raw, { namespace: 'outer' })[0].owners.map(ownerKey));
        }
        for (const owner of record.owners) {
            const context = nested || !directOwners.has(ownerKey(owner)) ? 'unshare' : 'owner';
            const target = { ...owner, socketInode: record.socketInode, context };
            const key = JSON.stringify([owner.pid, owner.fd]);
            const previousSocket = descriptorSockets.get(key);
            requireValue(previousSocket === undefined || previousSocket === socketKey(record),
                'descriptor refers to different socket generations');
            descriptorSockets.set(key, socketKey(record));
            const previous = targets.get(key);
            requireValue(!previous || JSON.stringify(previous) === JSON.stringify(target), 'descriptor has conflicting socket observations');
            targets.set(key, target);
        }
    }
    return [...targets.values()];
}

/** Observe socket and process identities twice without adopting a stale global PID census. */
export function collectCoherentSocketOwners({ capture, observe, containers, containerName = null }) {
    const relevant = containerName ? containers.filter(container => container.name === containerName)
        : containers.filter(container => container.namespace === 'outer');
    requireValue(!containerName || relevant.length === 1, 'nested namespace does not identify exactly one container');
    const first = capture();
    const targets = targetsForRecords(first, Boolean(containerName));
    const contexts = [...new Set(targets.map(target => target.context))];
    if (!contexts.length) contexts.push(containerName ? 'unshare' : 'owner');
    const requests = contexts.map(context => ({ context, request: {
        inits: relevant.map(container => ({ pid: container.initPid, pidNamespace: container.pidNamespace })),
        owners: targets.filter(target => target.context === context).map(({ context: _, ...owner }) => owner),
    } }));
    const proofBefore = requests.map(({ context, request }) => observe(context, request));
    const last = capture();
    assertSameSockets(first, last);
    const proofAfter = requests.map(({ context, request }) => observe(context, request));
    requireValue(JSON.stringify(proofBefore) === JSON.stringify(proofAfter), 'process generation, PID namespace, or descriptor changed between observations');
    const outerNamespaces = new Set(proofBefore.map(proof => proof.outerPidNamespace));
    requireValue(outerNamespaces.size === 1, 'observation contexts do not share the outer PID namespace');
    const outerNamespace = [...outerNamespaces][0];
    const byNamespace = new Map();
    for (const container of relevant) {
        requireValue(container.pidNamespace !== outerNamespace && !byNamespace.has(container.pidNamespace),
            'managed containers have shared or duplicate PID namespaces');
        byNamespace.set(container.pidNamespace, container);
    }
    const membership = new Map(relevant.map(container => [container.id, new Set([container.initPid])]));
    const proofs = targets.map((target) => {
        const index = requests.findIndex(request => request.context === target.context);
        const process = proofBefore[index].processes.find(process => process.pid === target.pid);
        requireValue(process, `PID ${target.pid} has no process observation`);
        const container = byNamespace.get(process.pidNamespace);
        requireValue(container || (!containerName && process.pidNamespace === outerNamespace),
            `PID ${target.pid} belongs to a foreign PID namespace`);
        if (container) membership.get(container.id).add(target.pid);
        return Object.freeze({ ...target, startTimeTicks: process.startTimeTicks, pidNamespace: process.pidNamespace });
    });
    const lastByKey = new Map(last.map(record => [socketKey(record), record]));
    const listeners = first.map((record) => Object.freeze({
        ...record,
        ownerPids: Object.freeze([...new Set(record.owners.map(owner => owner.pid))]),
        ownerProcesses: Object.freeze([...new Set(record.owners.map(owner => owner.name))]),
        ownerProofs: Object.freeze(proofs.filter(proof => record.owners.some(owner => ownerKey(owner) === ownerKey(proof)))),
        ownerVerificationAfter: Object.freeze(lastByKey.get(socketKey(record)).ownerObservations
            || [Object.freeze({ context: 'unshare', raw: lastByKey.get(socketKey(record)).raw })]),
    }));
    return { listeners: Object.freeze(listeners), memberships: membership };
}
