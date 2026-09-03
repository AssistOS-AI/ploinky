import { parseSsOutput } from './listener-inventory.mjs';

function socketField(details, field, pattern) {
    const matches = [...details.matchAll(new RegExp(`(?:^|\\s)${field}:([^\\s]+)`, 'g'))];
    if (matches.length !== 1 || !pattern.test(matches[0][1])) {
        throw new Error(`outer listener has missing, duplicate, or invalid socket ${field}`);
    }
    const value = matches[0][1];
    const normalized = field === 'sk' ? BigInt(`0x${value}`) : BigInt(value);
    if (normalized === 0n) throw new Error(`outer listener has zero socket ${field}`);
    return normalized.toString(field === 'sk' ? 16 : 10);
}

function parseOwners(details) {
    if (!details.startsWith('users:')) {
        if (details.includes('users:')) throw new Error('outer listener has malformed socket owners');
        return { owners: [], extended: details };
    }
    const match = /^users:\(((?:\("(?:[^"\\]|\\.)*",pid=[1-9][0-9]*,fd=[0-9]+\),?)+)\)(?:\s|$)/.exec(details);
    if (!match) throw new Error('outer listener has malformed socket owners');
    const tuples = [...match[1].matchAll(/\(("(?:[^"\\]|\\.)*"),pid=([1-9][0-9]*),fd=([0-9]+)\)/g)];
    if (!tuples.length || tuples.map(tuple => tuple[0]).join(',') !== match[1]) {
        throw new Error('outer listener has malformed socket owner tuples');
    }
    const owners = tuples.map((tuple) => {
        const name = JSON.parse(tuple[1]);
        const pid = Number(tuple[2]);
        const fd = Number(tuple[3]);
        if (!name || /[\x00-\x1f\x7f]/.test(name) || !Number.isSafeInteger(pid) || !Number.isSafeInteger(fd)) {
            throw new Error('outer listener has invalid socket owner identity');
        }
        return Object.freeze({ name, pid, fd });
    });
    const extended = details.slice(match[0].length);
    if (extended.includes('users:')) throw new Error('outer listener has malformed socket owners');
    return { owners, extended };
}

function ownerKey(owner) {
    return JSON.stringify([owner.name, owner.pid, owner.fd]);
}

function ownerSet(owners) {
    return JSON.stringify([...new Set(owners.map(ownerKey))].sort());
}

function identityKey(record) {
    return JSON.stringify([record.namespace, record.protocol, record.socketInode, record.socketCookie]);
}

function endpointKey(record) {
    return JSON.stringify([record.state, record.bindAddress, record.port, record.peerEndpoint]);
}

function snapshot(stdout, label, options = { namespace: 'outer' }) {
    const records = new Map();
    for (const parsed of parseSsOutput(stdout, options)) {
        const { owners, extended } = parseOwners(parsed.processDetails);
        const record = Object.freeze({
            ...parsed,
            peerEndpoint: parsed.raw.split(/\s+/)[5],
            socketInode: socketField(extended, 'ino', /^[1-9][0-9]*$/),
            socketCookie: socketField(extended, 'sk', /^[0-9a-f]+$/i),
            owners: Object.freeze(owners),
        });
        const key = identityKey(record);
        if (records.has(key)) throw new Error(`${label} repeats one kernel socket identity`);
        records.set(key, record);
    }
    return records;
}

/** Parse exact kernel socket identities and process descriptors in one observation. */
export function parseOwnerAwareSsOutput(stdout, options) {
    return Object.freeze([...snapshot(stdout, 'listener snapshot', options).values()]);
}

function assertSameSockets(expected, observed, label) {
    if (expected.size !== observed.size || [...expected].some(([key, record]) => (
        !observed.has(key) || endpointKey(record) !== endpointKey(observed.get(key))
    ))) {
        throw new Error(`outer listener socket generation changed in ${label}`);
    }
}

/** Combine complementary owner visibility without combining distinct kernel sockets. */
export function mergeOuterListenerOwners({ ownerBefore, ownerUnshare, ownerAfter } = {}) {
    if (![ownerBefore, ownerUnshare, ownerAfter].every(value => typeof value === 'string')) {
        throw new Error('outer listener ownership requires three successful ss observations');
    }
    const before = snapshot(ownerBefore, 'owner-before');
    const unshare = snapshot(ownerUnshare, 'owner-unshare');
    const after = snapshot(ownerAfter, 'owner-after');
    assertSameSockets(before, unshare, 'owner-unshare');
    assertSameSockets(before, after, 'owner-after');
    const records = [];
    const processNames = new Map();
    const processDescriptors = new Map();
    for (const [key, first] of before) {
        const middle = unshare.get(key);
        const last = after.get(key);
        if (ownerSet(first.owners) !== ownerSet(last.owners)) {
            throw new Error('outer listener process ownership changed during collection');
        }
        const owners = new Map();
        for (const owner of [...first.owners, ...middle.owners]) {
            const previousName = processNames.get(owner.pid);
            if (previousName !== undefined && previousName !== owner.name) {
                throw new Error(`outer listener has conflicting process names for PID ${owner.pid}`);
            }
            processNames.set(owner.pid, owner.name);
            const descriptor = `${owner.pid}:${owner.fd}`;
            if (processDescriptors.has(descriptor) && processDescriptors.get(descriptor) !== key) {
                throw new Error(`outer listener PID ${owner.pid} descriptor ${owner.fd} refers to different sockets`);
            }
            processDescriptors.set(descriptor, key);
            owners.set(ownerKey(owner), owner);
        }
        if (!owners.size) throw new Error('outer listener has no owner PID/process in either observation context');
        const combined = [...owners.values()].sort((left, right) => left.pid - right.pid || left.fd - right.fd || left.name.localeCompare(right.name));
        records.push(Object.freeze({
            ...first,
            owners: Object.freeze(combined),
            ownerProcesses: Object.freeze([...new Set(combined.map(owner => owner.name))]),
            ownerPids: Object.freeze([...new Set(combined.map(owner => owner.pid))]),
            ownerObservations: Object.freeze([
                Object.freeze({ context: 'owner-before', raw: first.raw }),
                Object.freeze({ context: 'owner-unshare', raw: middle.raw }),
                Object.freeze({ context: 'owner-after', raw: last.raw }),
            ]),
        }));
    }
    return Object.freeze(records);
}
