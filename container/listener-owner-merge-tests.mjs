import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeOuterListenerOwners } from './listener-owner-merge.mjs';

function socket({
    protocol = 'tcp', state = 'LISTEN', local = '127.0.0.1:7980', peer = '0.0.0.0:*',
    inode = '1024', cookie = '10', owners = [], extended = '',
} = {}) {
    const users = owners.length ? ` users:(${owners.map(([name, pid, fd]) => `(${JSON.stringify(name)},pid=${pid},fd=${fd})`).join(',')})` : '';
    return `${protocol} ${state} 0 4096 ${local} ${peer}${users} ino:${inode} sk:${cookie} ${extended}`.trim();
}

function merge(ownerBefore, ownerUnshare = ownerBefore, ownerAfter = ownerBefore) {
    return mergeOuterListenerOwners({ ownerBefore, ownerUnshare, ownerAfter });
}

const owned = () => socket({ owners: [['egress', 30015, 9]] });

test('complementary parent and child user namespaces produce complete same-socket owners', () => {
    const router = { local: '0.0.0.0:8080', inode: '2076423', cookie: '19' };
    const egress = { local: '127.0.0.1:7980', inode: '2157593', cookie: '1020' };
    const before = [socket({ ...router, owners: [['MainThread', 522, 23]], extended: 'uid:1000' }), socket(egress)].join('\n');
    const unshare = [socket({ ...egress, owners: [['egress', 30015, 9]], extended: 'uid:1001' }), socket(router)].join('\n');
    const result = merge(before, unshare);
    assert.deepEqual(result.map(row => [row.port, row.socketInode, row.socketCookie, row.ownerProcesses, row.ownerPids]), [
        [8080, '2076423', '19', ['MainThread'], [522]],
        [7980, '2157593', '1020', ['egress'], [30015]],
    ]);
    assert.deepEqual(result[1].owners, [{ name: 'egress', pid: 30015, fd: 9 }]);
    assert.equal(result[1].ownerObservations.length, 3);
    assert.match(result[1].ownerObservations[1].raw, /pid=30015,fd=9/);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result[1].owners));
});

test('exact owner tuples are unioned and deduplicated across overlapping visibility', () => {
    const before = socket({ owners: [['parent', 10, 3]] });
    const middle = socket({ owners: [['child', 20, 4], ['parent', 10, 3], ['parent', 10, 3]] });
    const [row] = merge(before, middle);
    assert.deepEqual(row.owners, [{ name: 'parent', pid: 10, fd: 3 }, { name: 'child', pid: 20, fd: 4 }]);
    assert.deepEqual(row.ownerPids, [10, 20]);
    assert.deepEqual(row.ownerProcesses, ['parent', 'child']);
});

test('SO_REUSEPORT sockets sharing one endpoint remain distinct kernel sockets', () => {
    const text = [owned(), socket({ inode: '1025', cookie: '11', owners: [['other', 123, 4]] })].join('\n');
    const rows = merge(text);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].port, rows[1].port);
    assert.notEqual(rows[0].socketInode, rows[1].socketInode);
    assert.deepEqual(rows.map(row => row.ownerPids), [[30015], [123]]);
});

test('outer ownership merge requires all three successful observations', () => {
    for (const absent of ['ownerBefore', 'ownerUnshare', 'ownerAfter']) {
        const values = { ownerBefore: owned(), ownerUnshare: owned(), ownerAfter: owned() };
        delete values[absent];
        assert.throws(() => mergeOuterListenerOwners(values), /three successful ss observations/);
    }
});

test('extended socket identity must be present, unique, valid and nonzero', () => {
    for (const line of [
        owned().replace(' ino:1024', ''),
        owned().replace(' sk:10', ''),
        owned().replace('ino:1024', 'ino:0'),
        owned().replace('ino:1024', 'ino:1.5'),
        owned().replace('sk:10', 'sk:0'),
        owned().replace('sk:10', 'sk:unknown'),
        owned() + ' ino:1024',
        owned() + ' sk:10',
    ]) {
        assert.throws(() => merge(line), /socket (ino|sk)/);
    }
    const large = socket({ inode: '9007199254740993123', cookie: 'ffffffffffffffff', owners: [['node', 5, 7]] });
    assert.equal(merge(large)[0].socketInode, '9007199254740993123');
});

test('duplicate rows cannot manufacture or collapse an accepted socket count', () => {
    for (const view of [0, 1, 2]) {
        const inputs = [owned(), owned(), owned()];
        inputs[view] += '\n' + owned();
        assert.throws(() => merge(...inputs), /repeats one kernel socket identity/);
    }
});

test('socket creation, disappearance and replacement reject a mixed generation', () => {
    for (const changed of [
        '',
        owned() + '\n' + socket({ inode: '1025', cookie: '11', owners: [['node', 4, 2]] }),
        owned().replace('ino:1024', 'ino:2024'),
        owned().replace('sk:10', 'sk:20'),
    ]) {
        assert.throws(() => merge(owned(), changed), /socket generation changed/);
        assert.throws(() => merge(owned(), owned(), changed), /socket generation changed/);
    }
});

test('same kernel identity cannot change its protocol, state or either endpoint', () => {
    for (const changed of [
        owned().replace('tcp ', 'udp '),
        owned().replace('LISTEN ', 'UNCONN '),
        owned().replace('127.0.0.1:7980', '0.0.0.0:7980'),
        owned().replace('127.0.0.1:7980', '127.0.0.1:7981'),
        owned().replace('0.0.0.0:*', '192.0.2.1:1234'),
    ]) assert.throws(() => merge(owned(), changed), /socket generation changed/);
});

test('primary owner identity must remain unchanged around the unshare view', () => {
    for (const changed of [
        socket(),
        owned().replace('pid=30015', 'pid=30016'),
        owned().replace('fd=9', 'fd=10'),
        owned().replace('"egress"', '"rogue"'),
    ]) assert.throws(() => merge(owned(), owned(), changed), /process ownership changed/);
});

test('inaccessible owners in both contexts never pass as empty attribution', () => {
    assert.throws(() => merge(socket()), /no owner PID\/process/);
});

test('one PID cannot have conflicting process names across owner contexts', () => {
    assert.throws(() => merge(owned(), owned().replace('"egress"', '"rogue"')), /conflicting process names/);
});

test('malformed owner tuples do not contribute partial attribution', () => {
    for (const bad of [
        owned().replace('pid=30015', 'pid=0'),
        owned().replace('fd=9', 'fd=-1'),
        owned().replace('pid=30015', 'pid=9007199254740993'),
        owned().replace('fd=9', 'fd=9007199254740993'),
        owned().replace('fd=9))', 'fd=9),)'),
        owned().replace('fd=9', 'fd=9,unknown=1'),
        owned().replace('users:', 'broken: users:'),
        owned() + ' users:(("hidden",pid=777,fd=4))',
    ]) assert.throws(() => merge(bad), /malformed socket owner|invalid socket owner/);
});


test('one process descriptor cannot refer to two sockets in the merged snapshot', () => {
    const before = [owned(), socket({ inode: '1025', cookie: '11' })].join('\n');
    const middle = [socket(), socket({ inode: '1025', cookie: '11', owners: [['egress', 30015, 9]] })].join('\n');
    assert.throws(() => merge(before, middle), /descriptor 9 refers to different sockets/);
});
