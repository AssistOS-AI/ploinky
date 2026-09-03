import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mergeOuterListenerOwners, parseOwnerAwareSsOutput } from './listener-owner-merge.mjs';
import { collectCoherentSocketOwners, parseSocketOwnerProofBatch, readSocketOwnerProofBatch } from './listener-owner-proof.mjs';

const CONTAINER = Object.freeze({ id: 'onlyoffice-id', name: 'onlyoffice', initPid: 100,
    pidNamespace: 'pid:[2000]', namespace: 'nested:onlyoffice', pids: [100, 101] });
const REQUEST = Object.freeze({ inits: [{ pid: 100, pidNamespace: 'pid:[2000]' }],
    owners: [{ name: 'nginx', pid: 200, fd: 6, socketInode: '123' }] });

function procStat(pid, name, start = '4307869') {
    return `${pid} (${name}) S ${Array(18).fill('0').join(' ')} ${start} 0 0\n`;
}

function procFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-owner-proc-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const link = (target, name) => { fs.mkdirSync(path.dirname(name), { recursive: true }); fs.symlinkSync(target, name); };
    link('pid:[1000]', `${root}/self/ns/pid`);
    const add = (pid, name, namespace, descriptors = {}) => {
        fs.mkdirSync(`${root}/${pid}`, { recursive: true });
        fs.writeFileSync(`${root}/${pid}/stat`, procStat(pid, name));
        link(namespace, `${root}/${pid}/ns/pid`);
        for (const [fd, inode] of Object.entries(descriptors)) link(`socket:[${inode}]`, `${root}/${pid}/fd/${fd}`);
    };
    add(100, 'tini', 'pid:[2000]');
    add(200, 'nginx', 'pid:[2000]', { 6: '123' });
    return { root, add, observe: (_context, request) => {
        const proof = readSocketOwnerProofBatch(request, { procRoot: root });
        return parseSocketOwnerProofBatch(JSON.stringify(proof), request);
    } };
}

function socket({ port = 8000, inode = '123', cookie = 'abc', owners = [['nginx', 200, 6]] } = {}) {
    const users = owners.length ? ` users:(${owners.map(([name, pid, fd]) => `(${JSON.stringify(name)},pid=${pid},fd=${fd})`).join(',')})` : '';
    return `tcp LISTEN 0 511 0.0.0.0:${port} 0.0.0.0:*${users} ino:${inode} sk:${cookie}`;
}

function nested(text = socket()) {
    return parseOwnerAwareSsOutput(text, { namespace: 'nested:onlyoffice', containerName: 'onlyoffice' });
}

function collect(fixture, { capture = () => nested(), observe = fixture.observe, containers = [CONTAINER], containerName = 'onlyoffice' } = {}) {
    return collectCoherentSocketOwners({ capture, observe, containers, containerName });
}

test('proc proof reads exact start time, namespace and socket descriptors without private process fields', t => {
    const fixture = procFixture(t);
    const proof = fixture.observe('unshare', REQUEST);
    assert.deepEqual(proof, { outerPidNamespace: 'pid:[1000]', processes: [
        { pid: 100, name: 'tini', startTimeTicks: '4307869', pidNamespace: 'pid:[2000]', descriptors: [] },
        { pid: 200, name: 'nginx', startTimeTicks: '4307869', pidNamespace: 'pid:[2000]', descriptors: [{ fd: 6, socketInode: '123' }] },
    ] });
    const withPrivateFields = JSON.parse(JSON.stringify(proof));
    withPrivateFields.processes[1].cmdline = 'secret';
    withPrivateFields.environment = 'secret';
    assert.equal(JSON.stringify(parseSocketOwnerProofBatch(JSON.stringify(withPrivateFields), REQUEST)).includes('secret'), false);
});

test('newly born listener worker gains only directly verified container membership', t => {
    const fixture = procFixture(t);
    const calls = [];
    const result = collect(fixture, { capture: () => { calls.push('ss'); return nested(); },
        observe: (context, request) => { calls.push(context); return fixture.observe(context, request); } });
    assert.deepEqual(calls, ['ss', 'unshare', 'ss', 'unshare']);
    assert.deepEqual([...result.memberships.get(CONTAINER.id)], [100, 200]);
    assert.equal(result.memberships.get(CONTAINER.id).has(101), false);
    assert.deepEqual(result.listeners[0].ownerProofs, [{ name: 'nginx', pid: 200, fd: 6, socketInode: '123',
        context: 'unshare', startTimeTicks: '4307869', pidNamespace: 'pid:[2000]' }]);
    assert.match(result.listeners[0].ownerVerificationAfter[0].raw, /ino:123 sk:abc/);
});

test('foreign owner namespace is rejected even when the old census contained its PID', t => {
    const fixture = procFixture(t);
    fs.unlinkSync(`${fixture.root}/200/ns/pid`);
    fs.symlinkSync('pid:[3000]', `${fixture.root}/200/ns/pid`);
    assert.throws(() => collect(fixture, { containers: [{ ...CONTAINER, pids: [100, 200] }] }), /foreign PID namespace/);
});

for (const code of ['EACCES', 'ENOENT']) {
    test(`unreadable socket owner fails closed on ${code} without retry`, t => {
        const fixture = procFixture(t);
        let reads = 0;
        const fsImpl = { ...fs, readlinkSync(name) {
            if (name.endsWith('/200/fd/6')) { reads++; throw Object.assign(new Error(code), { code }); }
            return fs.readlinkSync(name);
        } };
        assert.throws(() => readSocketOwnerProofBatch(REQUEST, { procRoot: fixture.root, fsImpl }), { code });
        assert.equal(reads, 1);
    });
}

test('descriptor reuse while proc proof is read fails closed', t => {
    const fixture = procFixture(t);
    let reads = 0;
    const fsImpl = { ...fs, readlinkSync(name) {
        if (name.endsWith('/200/fd/6') && ++reads === 2) return 'socket:[124]';
        return fs.readlinkSync(name);
    } };
    assert.throws(() => readSocketOwnerProofBatch(REQUEST, { procRoot: fixture.root, fsImpl }), /descriptor 6 changed while observed/);
});

test('PID reuse during proc proof and between socket observations fails closed', t => {
    const fixture = procFixture(t);
    let reads = 0;
    const fsImpl = { ...fs, readFileSync(name, encoding) {
        if (name.endsWith('/200/stat') && ++reads === 2) return procStat(200, 'nginx', '4307870');
        return fs.readFileSync(name, encoding);
    } };
    assert.throws(() => readSocketOwnerProofBatch(REQUEST, { procRoot: fixture.root, fsImpl }), /changed process generation/);
    let captures = 0;
    assert.throws(() => collect(fixture, { capture() {
        if (++captures === 2) fs.writeFileSync(`${fixture.root}/200/stat`, procStat(200, 'nginx', '4307870'));
        return nested();
    } }), /process generation, PID namespace, or descriptor changed between observations/);
    assert.equal(captures, 2);
});

test('namespace changes, mismatched comm and incorrect descriptor inode are rejected', t => {
    const fixture = procFixture(t);
    let namespaces = 0;
    const fsImpl = { ...fs, readlinkSync(name) {
        if (name.endsWith('/200/ns/pid') && ++namespaces === 2) return 'pid:[3000]';
        return fs.readlinkSync(name);
    } };
    assert.throws(() => readSocketOwnerProofBatch(REQUEST, { procRoot: fixture.root, fsImpl }), /changed PID namespace/);
    fs.writeFileSync(`${fixture.root}/200/stat`, procStat(200, 'foreign'));
    assert.throws(() => fixture.observe('unshare', REQUEST), /process name differs from ss/);
    fs.writeFileSync(`${fixture.root}/200/stat`, procStat(200, 'nginx'));
    fs.unlinkSync(`${fixture.root}/200/fd/6`);
    fs.symlinkSync('socket:[124]', `${fixture.root}/200/fd/6`);
    assert.throws(() => fixture.observe('unshare', REQUEST), /changed socket inode/);
});

test('socket cookie, endpoint, inode, owner and socket-set churn cannot form an accepted snapshot', t => {
    const fixture = procFixture(t);
    for (const changed of [socket({ cookie: 'def' }), socket({ port: 8001 }), socket({ inode: '124' }),
        socket({ owners: [['nginx', 201, 6]] }), '']) {
        let captures = 0;
        assert.throws(() => collect(fixture, { capture: () => nested(++captures === 1 ? socket() : changed) }), /socket .*changed/);
        assert.equal(captures, 2);
    }
});

test('one descriptor cannot prove two sockets with the same inode but different cookies', t => {
    const fixture = procFixture(t);
    assert.throws(() => collect(fixture, { capture: () => nested(`${socket()}\n${socket({ port: 8001, cookie: 'def' })}`) }),
        /descriptor refers to different socket generations/);
});

test('outer complementary owner contexts prove exact native and managed memberships', t => {
    const fixture = procFixture(t);
    fixture.add(300, 'MainThread', 'pid:[1000]', { 8: '124' });
    const direct = [socket({ owners: [] }), socket({ port: 8080, inode: '124', cookie: 'def', owners: [['MainThread', 300, 8]] })].join('\n');
    const child = [socket(), socket({ port: 8080, inode: '124', cookie: 'def', owners: [] })].join('\n');
    const seen = [];
    const result = collect(fixture, { containers: [{ ...CONTAINER, namespace: 'outer' }], containerName: null,
        capture: () => mergeOuterListenerOwners({ ownerBefore: direct, ownerUnshare: child, ownerAfter: direct }),
        observe(context, request) { seen.push([context, request.owners.map(owner => owner.pid)]); return fixture.observe(context, request); },
    });
    assert.deepEqual(seen, [['unshare', [200]], ['owner', [300]], ['unshare', [200]], ['owner', [300]]]);
    assert.deepEqual([...result.memberships.get(CONTAINER.id)], [100, 200]);
    assert.deepEqual(result.listeners.map(row => row.ownerProofs[0].context), ['unshare', 'owner']);
});

test('response parser rejects invented, duplicated, absent and changed identity fields', t => {
    const fixture = procFixture(t);
    const valid = readSocketOwnerProofBatch(REQUEST, { procRoot: fixture.root });
    for (const mutate of [
        proof => proof.processes.pop(),
        proof => { proof.processes[1] = proof.processes[0]; },
        proof => { proof.processes[1].pid = 999; },
        proof => { proof.processes[1].startTimeTicks = 4307869; },
        proof => { proof.processes[0].pidNamespace = 'pid:[999]'; },
        proof => { proof.processes[1].descriptors[0].socketInode = '124'; },
        proof => { proof.processes[1].descriptors[0].fd = 7; },
    ]) {
        const proof = structuredClone(valid);
        mutate(proof);
        assert.throws(() => parseSocketOwnerProofBatch(JSON.stringify(proof), REQUEST), /listener owner proof/);
    }
});
