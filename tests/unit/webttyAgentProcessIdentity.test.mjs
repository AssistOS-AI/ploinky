import assert from 'node:assert/strict';
import test from 'node:test';

import {
    agentCleanupScopeAbsent,
    captureAgentCleanupScope,
    agentShellMarkerArgument,
    captureAgentInnerProcessIdentity,
    captureAgentSessionSnapshot,
    listAgentMarkerProcesses,
    listAgentRecordedNamespaceMarkerProcesses,
    listAgentSessionMembers,
    fixedAgentShellWrapperArgv,
    fixedAgentInteractiveShellArgv,
    parseAgentLinuxProcCmdline,
    parseAgentLinuxProcStat,
    readAgentBoxProcessIdentity,
    readAgentCleanupProcessIdentity,
    revalidateAgentInnerProcessIdentity,
    signalExactAgentSessionSnapshot,
} from '../../cli/server/webtty/agentProcessIdentity.mjs';

const MARKER = 'marker_abcdefghijklmnopqrstuvwx';
const MARKER_ARGUMENT = `ploinky-webtty-marker:${MARKER}`;
const BASH_WRAPPER_ARGV = fixedAgentShellWrapperArgv(MARKER, '/bin/bash');
const SH_WRAPPER_ARGV = fixedAgentShellWrapperArgv(MARKER, '/bin/sh');
const BASH_INTERACTIVE_ARGV = fixedAgentInteractiveShellArgv('/bin/bash');
const SH_INTERACTIVE_ARGV = fixedAgentInteractiveShellArgv('/bin/sh');

function procStat(pid, { pgrp = pid, session = pid, start = pid * 10, state = 'S' } = {}) {
    const fields = [state, 1, pgrp, session, 34816, pgrp];
    while (fields.length < 19) fields.push(0);
    fields.push(start);
    return `${pid} (bash worker) ${fields.join(' ')} 0\n`;
}

function identity({
    pid,
    start = pid * 10,
    namespace = 'pid:[9001]',
    nspid = [pid, pid - 1000],
    nspgid = [pid, pid - 1000],
    nssid = [pid, pid - 1000],
    innerUid = 0,
    argv = [],
    parentPid = 1,
} = {}) {
    return Object.freeze({
        pid,
        state: 'S',
        startToken: `linux-proc:${start}`,
        parentPid,
        processGroupId: pid,
        sessionId: pid,
        pidNamespace: namespace,
        nspid: Object.freeze(nspid),
        nspgid: Object.freeze(nspgid),
        nssid: Object.freeze(nssid),
        innerUid,
        argv: Object.freeze(argv),
    });
}

function directoryEntries(...pids) {
    return pids.map((pid) => ({ name: String(pid), isDirectory: () => true }));
}

function cleanupFixture() {
    const init = identity({ pid: 5001, nspid: [5001, 1] });
    const wrapper = identity({ pid: 5002, parentPid: 5001, nspid: [5002, 42],
        nspgid: [5002, 42], nssid: [5002, 42], argv: BASH_WRAPPER_ARGV });
    const privateInit = identity({ pid: 5003, parentPid: 5002, namespace: 'pid:[9010]', nspid: [5003, 43, 1] });
    const child = identity({ pid: 5004, parentPid: 5003, namespace: 'pid:[9010]', nspid: [5004, 44, 2] });
    const records = new Map([init, wrapper, privateInit, child].map((entry) => [entry.pid, entry]));
    const record = { boxPid: wrapper.pid, boxStartToken: wrapper.startToken,
        boxProcessGroupId: wrapper.processGroupId, boxSessionId: wrapper.sessionId,
        pidNamespace: wrapper.pidNamespace, nspid: wrapper.nspid, innerPid: 42,
        innerProcessGroupId: 42, innerSessionId: 42, innerUid: 0, innerStartToken: wrapper.startToken,
        containerInitBoxPid: init.pid, containerInitStartToken: init.startToken };
    const options = { fsApi: { readdir: async () => directoryEntries(...records.keys()) },
        readIdentity: async (pid) => records.get(pid) || null,
        readAnchorIdentity: async (pid) => {
            const current = records.get(pid);
            if (!current) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
            return current;
        } };
    return { records, record, options, init, wrapper, privateInit, child };
}

test('a denied first member cannot leave a later independently verified member unsignalled', async () => {
    for (const code of ['EACCES', 'EPERM']) {
        const members = [identity({ pid: 5002 }), identity({ pid: 5003 })];
        const attempted = [];
        const outcomes = [];
        await assert.rejects(signalExactAgentSessionSnapshot(members, 'SIGTERM', {
            readIdentity: async (pid) => members.find((entry) => entry.pid === pid),
            signalImpl: (pid) => {
                attempted.push(pid);
                if (pid === 5002) throw Object.assign(new Error('denied'), { code });
            },
            onSignalResult: (result) => outcomes.push(result),
        }), { code });
        assert.deepEqual(attempted, [5002, 5003]);
        assert.deepEqual(outcomes.map((entry) => entry.outcome), ['denied', 'sent']);
    }
});

test('signal continuation never waives changed member identities or unrelated signal errors', async () => {
    const members = [identity({ pid: 5002 }), identity({ pid: 5003 }), identity({ pid: 5004 })];
    for (const scenario of ['changed-after-denial', 'unrelated-error']) {
        const attempted = [];
        await assert.rejects(signalExactAgentSessionSnapshot(members, 'SIGTERM', {
            readIdentity: async (pid) => {
                const current = members.find((entry) => entry.pid === pid);
                return pid === 5003 && scenario === 'changed-after-denial'
                    ? { ...current, startToken: 'linux-proc:99999' } : current;
            },
            signalImpl: (pid) => {
                attempted.push(pid);
                if (pid === 5002) throw Object.assign(new Error('failed'), {
                    code: scenario === 'unrelated-error' ? 'EINVAL' : 'EACCES',
                });
            },
        }), scenario === 'unrelated-error' ? { code: 'EINVAL' } : { category: 'session-member-changed' });
        assert.deepEqual(attempted, [5002]);
    }
});

test('cleanup captures native descendants and private namespace PID 1 without granting signals', async () => {
    const f = cleanupFixture();
    const scope = await captureAgentCleanupScope(f.record, f.options);
    assert.deepEqual(scope.descendants.map((entry) => entry.pid), [5002, 5003, 5004]);
    assert.deepEqual(scope.privateNamespaces, ['pid:[9010]']);
    assert.deepEqual(scope.namespaceInits.map((entry) => entry.pid), [5003]);
    assert.equal(await agentCleanupScopeAbsent(scope, f.options), false);
    for (const pid of [5002, 5003, 5004]) f.records.delete(pid);
    assert.equal(await agentCleanupScopeAbsent(scope, f.options), true);
});

test('cleanup capture retains stable private zombies until they positively disappear', async (t) => {
    for (const role of ['private-init', 'private-child']) {
        await t.test(role, async () => {
            const f = cleanupFixture();
            const zombie = role === 'private-init' ? f.privateInit : f.child;
            f.records.set(zombie.pid, { ...zombie, state: 'Z' });
            if (role === 'private-init') f.records.delete(f.child.pid);
            const scope = await captureAgentCleanupScope(f.record, f.options);
            assert.equal(scope.descendants.find(value => value.pid === zombie.pid)?.state, 'Z');
            if (role === 'private-init') assert.equal(scope.namespaceInits[0].state, 'Z');
            for (const member of scope.descendants) if (member.pid !== zombie.pid) f.records.delete(member.pid);
            assert.equal(await agentCleanupScopeAbsent(scope, f.options), false, 'a surviving zombie is still present');
            f.records.delete(zombie.pid);
            assert.equal(await agentCleanupScopeAbsent(scope, f.options), true);
        });
    }
});

test('stable zombie capture never admits the wrapper, container init or same-namespace members', async (t) => {
    const mutations = {
        wrapper: f => f.records.set(f.wrapper.pid, { ...f.wrapper, state: 'Z' }),
        'container-init': f => f.records.set(f.init.pid, { ...f.init, state: 'Z' }),
        'same-namespace-child': f => f.records.set(5005, { ...identity({ pid: 5005,
            parentPid: f.wrapper.pid, nspid: [5005, 45] }), state: 'Z' }),
        'private-depth-not-deeper': f => f.records.set(f.privateInit.pid,
            { ...f.privateInit, state: 'Z', nspid: [f.privateInit.pid, 1] }),
        'private-namespace-without-init': f => f.records.set(f.privateInit.pid,
            { ...f.privateInit, state: 'Z', nspid: [f.privateInit.pid, 43, 2] }),
    };
    for (const [name, mutate] of Object.entries(mutations)) {
        await t.test(name, async () => {
            const f = cleanupFixture(); mutate(f);
            await assert.rejects(captureAgentCleanupScope(f.record, f.options), error =>
                /^WEBTTY_AGENT_PROCESS_IDENTITY_(?:STALE|UNPROVEN)$/.test(error.code));
        });
    }
});

test('private zombie capture rejects state transitions and any changed identity component', async (t) => {
    const mutations = {
        'live-to-zombie': value => ({ ...value, state: 'Z' }),
        'zombie-to-live': value => ({ ...value, state: 'S' }),
        pid: value => ({ ...value, pid: 5999 }),
        birth: value => ({ ...value, startToken: 'linux-proc:99999' }),
        parent: value => ({ ...value, parentPid: 1 }),
        namespace: value => ({ ...value, pidNamespace: 'pid:[9999]' }),
        nspid: value => ({ ...value, nspid: [value.pid, 99, 1] }),
        'malformed-nspid': value => ({ ...value, nspid: [value.pid, 0] }),
    };
    for (const [name, mutate] of Object.entries(mutations)) {
        await t.test(name, async () => {
            const f = cleanupFixture(); f.records.delete(f.child.pid);
            f.records.set(f.privateInit.pid, { ...f.privateInit, state: name === 'live-to-zombie' ? 'S' : 'Z' });
            const originalRead = f.options.readIdentity;
            let reads = 0;
            f.options.readIdentity = async pid => {
                const value = await originalRead(pid);
                return pid === f.privateInit.pid && ++reads === 2 ? mutate(value) : value;
            };
            await assert.rejects(captureAgentCleanupScope(f.record, f.options), { category: 'cleanup-scope-changed' });
        });
    }
});

test('complete namespace scan vetoes an uncaptured setsid/reparented private child', async () => {
    const f = cleanupFixture();
    const scope = await captureAgentCleanupScope(f.record, f.options);
    for (const pid of [5002, 5003, 5004]) f.records.delete(pid);
    f.records.set(5010, identity({ pid: 5010, parentPid: 1, namespace: 'pid:[9010]',
        nspid: [5010, 50, 3], nssid: [5010, 50, 3] }));
    assert.equal(await agentCleanupScopeAbsent(scope, f.options), false);
});

test('cleanup scope rejects missing intermediaries, missing or duplicate private init and changed topology', async () => {
    for (const mutate of [
        (f) => f.records.delete(5003),
        (f) => f.records.set(5003, identity({ pid: 5003, parentPid: 5002,
            namespace: 'pid:[9010]', nspid: [5003, 43, 2] })),
        (f) => f.records.set(5005, identity({ pid: 5005, parentPid: 5002,
            namespace: 'pid:[9010]', nspid: [5005, 45, 1] })),
        (f) => f.records.set(5004, identity({ pid: 5004, parentPid: 5003,
            namespace: 'pid:[9010]', nspid: [5004, 44] })),
    ]) {
        const f = cleanupFixture();
        mutate(f);
        await assert.rejects(captureAgentCleanupScope(f.record, f.options));
    }
});

test('cleanup absence rejects PID reuse, namespace init replacement and target init replacement', async () => {
    for (const pid of [5001, 5003, 5004]) {
        const f = cleanupFixture();
        const scope = await captureAgentCleanupScope(f.record, f.options);
        const original = f.records.get(pid);
        for (const removed of [5002, 5003, 5004]) f.records.delete(removed);
        f.records.set(pid, { ...original, startToken: 'linux-proc:99999' });
        await assert.rejects(agentCleanupScopeAbsent(scope, f.options), { category: 'cleanup-process-replaced' });
    }
});

test('cleanup absence never turns persistent read failures or incomplete scans into absence', async () => {
    for (const code of ['EACCES', 'EIO', 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE']) {
        const f = cleanupFixture();
        const scope = await captureAgentCleanupScope(f.record, f.options);
        await assert.rejects(agentCleanupScopeAbsent(scope, { ...f.options,
            readIdentity: async () => { throw Object.assign(new Error('unknown'), { code }); } }), { code });
    }
    const f = cleanupFixture();
    const scope = await captureAgentCleanupScope(f.record, f.options);
    for (const pid of [5002, 5003, 5004]) f.records.delete(pid);
    await assert.rejects(agentCleanupScopeAbsent(scope, { ...f.options,
        fsApi: { readdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } }),
    { code: 'EACCES' });
});

test('absence reader accepts only initial missing stat, preserves partial-read errors and detects parent changes', async () => {
    const missing = Object.assign(new Error('gone'), { code: 'ENOENT' });
    assert.equal(await readAgentCleanupProcessIdentity(5002, {
        fsApi: { readFile: async () => { throw missing; } },
    }), null);
    await assert.rejects(readAgentCleanupProcessIdentity(5002, { fsApi: {
        readFile: async () => Buffer.from(procStat(5002)),
        readlink: async () => { throw missing; },
    } }), { code: 'ENOENT' });
    let stats = 0;
    await assert.rejects(readAgentCleanupProcessIdentity(5002, { fsApi: {
        readFile: async (file) => Buffer.from(file.endsWith('status') ? 'NSpid:\t5002\t42\n'
            : procStat(5002).replace(' S 1 ', ++stats === 1 ? ' S 1 ' : ' S 2 ')),
        readlink: async () => 'pid:[9001]',
    } }), { category: 'cleanup-process-changed' });
});

test('Linux proc parser uses the last parenthesis and exact start token', () => {
    assert.deepEqual(parseAgentLinuxProcStat(procStat(4242), 4242), {
        pid: 4242,
        state: 'S',
        parentPid: 1,
        processGroupId: 4242,
        sessionId: 4242,
        startToken: 'linux-proc:42420',
    });
    assert.throws(() => parseAgentLinuxProcStat(procStat(4242), 4243));
    assert.throws(() => parseAgentLinuxProcStat('4242 malformed', 4242));
});

test('inner readiness is anchored to the exact container PID namespace', async () => {
    const init = identity({ pid: 5001, nspid: [5001, 1], nspgid: [5001, 1], nssid: [5001, 1] });
    const wrapper = identity({
        pid: 5002,
        argv: BASH_WRAPPER_ARGV,
        innerUid: 1000,
        nspid: [5002, 42],
        nspgid: [5002, 42],
        nssid: [5002, 42],
    });
    const shell = identity({
        pid: 5003,
        parentPid: 5002,
        argv: BASH_INTERACTIVE_ARGV,
        innerUid: 1000,
        nspid: [5003, 43],
        nspgid: [5003, 43],
        nssid: [5003, 42],
    });
    const unrelated = identity({
        pid: 6002,
        namespace: 'pid:[9002]',
        nspid: [6002, 43],
        nspgid: [6002, 43],
        nssid: [6002, 42],
    });
    const records = new Map([[5001, init], [5002, wrapper], [5003, shell], [6002, unrelated]]);
    const fsApi = { readdir: async () => directoryEntries(...records.keys()) };
    const readIdentity = async (pid) => records.get(pid);
    const captured = await captureAgentInnerProcessIdentity({
        containerInitBoxPid: 5001,
        inner: {
            pid: 43,
            processGroupId: 43,
            sessionId: 42,
            uid: 1000,
            startToken: 'linux-proc:50030',
        },
        marker: MARKER,
    }, { fsApi, readIdentity });
    assert.equal(captured.boxPid, 5002);
    assert.equal(captured.innerPid, 42);
    assert.equal(captured.innerUid, 1000);
    assert.equal(captured.pidNamespace, 'pid:[9001]');
    await revalidateAgentInnerProcessIdentity(captured, { fsApi, readIdentity });

    records.set(5001, identity({
        pid: 5001,
        start: 99999,
        nspid: [5001, 1],
        nspgid: [5001, 1],
        nssid: [5001, 1],
    }));
    await assert.rejects(
        () => revalidateAgentInnerProcessIdentity(captured, { fsApi, readIdentity }),
        (error) => error.code === 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE',
    );
});

test('selected sh fallback requires the exact sh wrapper and persists that session anchor', async () => {
    const init = identity({ pid: 5001, nspid: [5001, 1], nspgid: [5001, 1], nssid: [5001, 1] });
    const wrapper = identity({
        pid: 5002,
        argv: SH_WRAPPER_ARGV,
        innerUid: 1000,
        nspid: [5002, 42],
        nspgid: [5002, 42],
        nssid: [5002, 42],
    });
    const child = identity({
        pid: 5003,
        parentPid: 5002,
        argv: SH_INTERACTIVE_ARGV,
        innerUid: 1000,
        nspid: [5003, 43],
        nspgid: [5003, 43],
        nssid: [5003, 42],
    });
    const records = new Map([[5001, init], [5002, wrapper], [5003, child]]);
    const options = {
        fsApi: { readdir: async () => directoryEntries(...records.keys()) },
        readIdentity: async (pid) => records.get(pid),
    };
    const request = {
        containerInitBoxPid: 5001,
        inner: {
            pid: 43,
            processGroupId: 43,
            sessionId: 42,
            uid: 1000,
            startToken: 'linux-proc:50030',
        },
        marker: MARKER,
    };
    const captured = await captureAgentInnerProcessIdentity({
        ...request,
        shellPath: '/bin/sh',
    }, options);
    assert.equal(captured.boxPid, 5002);
    assert.equal(captured.innerPid, 42);
    await assert.rejects(
        () => captureAgentInnerProcessIdentity({
            ...request,
            shellPath: '/bin/bash',
        }, options),
        (error) => error.category === 'marker-correlation',
    );
});

test('readiness rejects a same-session child with a forged parent or interactive argv', async () => {
    const init = identity({ pid: 5001, nspid: [5001, 1], nspgid: [5001, 1], nssid: [5001, 1] });
    const wrapper = identity({
        pid: 5002,
        argv: BASH_WRAPPER_ARGV,
        innerUid: 1000,
        nspid: [5002, 42],
        nspgid: [5002, 42],
        nssid: [5002, 42],
    });
    const child = identity({
        pid: 5003,
        parentPid: 5002,
        argv: BASH_INTERACTIVE_ARGV,
        innerUid: 1000,
        nspid: [5003, 43],
        nspgid: [5003, 43],
        nssid: [5003, 42],
    });
    const request = {
        containerInitBoxPid: 5001,
        inner: {
            pid: 43,
            processGroupId: 43,
            sessionId: 42,
            uid: 1000,
            startToken: 'linux-proc:50030',
        },
        marker: MARKER,
        shellPath: '/bin/bash',
    };
    for (const forgedChild of [
        { ...child, parentPid: 4999 },
        { ...child, argv: ['/bin/bash', '--noprofile', '--norc', '-i'] },
    ]) {
        const records = new Map([[5001, init], [5002, wrapper], [5003, forgedChild]]);
        await assert.rejects(
            () => captureAgentInnerProcessIdentity(request, {
                fsApi: { readdir: async () => directoryEntries(...records.keys()) },
                readIdentity: async (pid) => records.get(pid),
            }),
            (error) => error.category === 'inner-topology',
        );
    }
});

test('ambiguous same-namespace inner PID evidence fails closed', async () => {
    const init = identity({ pid: 5001, nspid: [5001, 1], nspgid: [5001, 1], nssid: [5001, 1] });
    const records = new Map([
        [5001, init],
        [5002, identity({ pid: 5002, nspid: [5002, 42], nspgid: [5002, 42], nssid: [5002, 42] })],
        [5003, identity({ pid: 5003, nspid: [5003, 42], nspgid: [5003, 42], nssid: [5003, 42] })],
    ]);
    await assert.rejects(
        () => captureAgentInnerProcessIdentity({
            containerInitBoxPid: 5001,
            inner: {
                pid: 42,
                processGroupId: 42,
                sessionId: 42,
                uid: 0,
                startToken: 'linux-proc:50020',
            },
            marker: 'marker_abcdefghijklmnopqrstuvwx',
        }, {
            fsApi: { readdir: async () => directoryEntries(...records.keys()) },
            readIdentity: async (pid) => records.get(pid),
        }),
        (error) => error.category === 'inner-process-ambiguity',
    );
});

test('proc discovery is entry-bounded before reading candidate identities', async () => {
    let identityReads = 0;
    const init = identity({ pid: 5001, nspid: [5001, 1], nspgid: [5001, 1], nssid: [5001, 1] });
    await assert.rejects(
        () => captureAgentInnerProcessIdentity({
            containerInitBoxPid: 5001,
            inner: {
                pid: 42,
                processGroupId: 42,
                sessionId: 42,
                uid: 0,
                startToken: 'linux-proc:50020',
            },
            marker: 'marker_abcdefghijklmnopqrstuvwx',
        }, {
            fsApi: { readdir: async () => directoryEntries(...Array.from({ length: 8_193 }, (_, i) => i + 2)) },
            readIdentity: async () => { identityReads += 1; return init; },
        }),
        (error) => error.code === 'WEBTTY_AGENT_PROCESS_IDENTITY_UNPROVEN'
            && error.category === 'proc-scan-limit',
    );
    assert.equal(identityReads, 1);
});

test('readiness prefilters a large outer proc by exact PID namespace', async () => {
    const init = identity({
        pid: 5001,
        nspid: [5001, 1],
        nspgid: [5001, 1],
        nssid: [5001, 1],
    });
    const wrapper = identity({
        pid: 5002,
        argv: BASH_WRAPPER_ARGV,
        innerUid: 1000,
        nspid: [5002, 42],
        nspgid: [5002, 42],
        nssid: [5002, 42],
    });
    const shell = identity({
        pid: 5003,
        parentPid: 5002,
        argv: BASH_INTERACTIVE_ARGV,
        innerUid: 1000,
        nspid: [5003, 43],
        nspgid: [5003, 43],
        nssid: [5003, 42],
    });
    const unrelated = Array.from({ length: 2_000 }, (_, index) => 10_000 + index);
    const unrelatedPaths = new Set(unrelated.map((pid) => `/proc/${pid}/ns/pid`));
    const records = new Map([[5001, init], [5002, wrapper], [5003, shell]]);
    const identityReads = [];
    const captured = await captureAgentInnerProcessIdentity({
        containerInitBoxPid: 5001,
        inner: {
            pid: 43,
            processGroupId: 43,
            sessionId: 42,
            uid: 1000,
            startToken: 'linux-proc:50030',
        },
        marker: MARKER,
    }, {
        fsApi: {
            readdir: async () => directoryEntries(...records.keys(), ...unrelated),
            readlink: async (name) => (unrelatedPaths.has(name) ? 'pid:[9002]' : 'pid:[9001]'),
        },
        readIdentity: async (pid) => {
            identityReads.push(pid);
            return records.get(pid);
        },
    });
    assert.equal(captured.boxPid, 5002);
    assert.deepEqual(identityReads, [5001, 5001, 5002, 5003]);
});

test('readiness capture never reads a non-root target environment from the Box', async () => {
    const init = identity({ pid: 5001, nspid: [5001, 1], nspgid: [5001, 1], nssid: [5001, 1] });
    const wrapper = identity({
        pid: 5002,
        argv: BASH_WRAPPER_ARGV,
        innerUid: 1000,
        nspid: [5002, 42],
        nspgid: [5002, 42],
        nssid: [5002, 42],
    });
    const shell = identity({
        pid: 5003,
        parentPid: 5002,
        argv: BASH_INTERACTIVE_ARGV,
        innerUid: 1000,
        nspid: [5003, 43],
        nspgid: [5003, 43],
        nssid: [5003, 42],
    });
    const records = new Map([[5001, init], [5002, wrapper], [5003, shell]]);
    const fsApi = {
        readdir: async () => directoryEntries(...records.keys()),
        readFile: async (file) => {
            if (String(file).endsWith('/environ')) {
                const error = new Error('permission denied');
                error.code = 'EACCES';
                throw error;
            }
            throw new Error(`unexpected Box proc read: ${file}`);
        },
    };
    const captured = await captureAgentInnerProcessIdentity({
        containerInitBoxPid: 5001,
        inner: {
            pid: 43,
            processGroupId: 43,
            sessionId: 42,
            uid: 1000,
            startToken: 'linux-proc:50030',
        },
        marker: MARKER,
    }, { fsApi, readIdentity: async (pid) => records.get(pid) });
    assert.equal(captured.boxPid, 5002);
});

test('Box-readable cmdline carries the exact fixed wrapper and marker argument', async () => {
    assert.equal(agentShellMarkerArgument(MARKER), MARKER_ARGUMENT);
    const wrapperCmdline = Buffer.from([...BASH_WRAPPER_ARGV, ''].join('\0'));
    assert.deepEqual(parseAgentLinuxProcCmdline(wrapperCmdline), BASH_WRAPPER_ARGV);
    assert.deepEqual(parseAgentLinuxProcCmdline(Buffer.alloc(0)), []);
    assert.throws(() => parseAgentLinuxProcCmdline(Buffer.from('unterminated')));

    const reads = [];
    const files = new Map([
        ['/box-proc/5002/stat', Buffer.from(procStat(5002))],
        ['/box-proc/5002/status', Buffer.from([
            'Name:\tbash',
            'Uid:\t101000\t101000\t101000\t101000',
            'NSpid:\t5002\t42',
            'NSpgid:\t5002\t42',
            'NSsid:\t5002\t42',
            '',
        ].join('\n'))],
        ['/box-proc/5002/uid_map', Buffer.from('0 100000 65536\n')],
        ['/box-proc/5002/cmdline', wrapperCmdline],
    ]);
    const fsApi = {
        async readFile(file) {
            reads.push(file);
            if (String(file).endsWith('/environ')) {
                const error = new Error('permission denied');
                error.code = 'EACCES';
                throw error;
            }
            return files.get(file);
        },
        async readlink(file) {
            assert.equal(file, '/box-proc/5002/ns/pid');
            return 'pid:[9001]';
        },
    };
    const observed = await readAgentBoxProcessIdentity(5002, {
        procRoot: '/box-proc',
        fsApi,
    });
    assert.equal(observed.innerUid, 1000);
    assert.deepEqual(observed.argv, BASH_WRAPPER_ARGV);
    assert.equal(reads.some((file) => String(file).endsWith('/environ')), false);

    let cmdlineReads = 0;
    await assert.rejects(
        () => readAgentBoxProcessIdentity(5002, {
            procRoot: '/box-proc',
            fsApi: {
                ...fsApi,
                async readFile(file) {
                    if (String(file).endsWith('/cmdline')) {
                        cmdlineReads += 1;
                        return Buffer.from(`${cmdlineReads === 1 ? MARKER_ARGUMENT : '/bin/other'}\0`);
                    }
                    return files.get(file);
                },
            },
        }),
        (error) => error.code === 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE'
            && error.category === 'changed-during-read',
    );
});

test('marker recovery scans exact Box namespace and exact wrapper argv without target exec', async () => {
    const init = identity({ pid: 5001, nspid: [5001, 1], nspgid: [5001, 1], nssid: [5001, 1] });
    const shell = identity({
        pid: 5002,
        argv: BASH_WRAPPER_ARGV,
        innerUid: 1000,
        nspid: [5002, 42],
        nspgid: [5002, 42],
        nssid: [5002, 42],
    });
    const forged = identity({
        pid: 5003,
        argv: [...BASH_WRAPPER_ARGV.slice(0, -1), `${MARKER_ARGUMENT}-forged`],
        nspid: [5003, 43],
        nspgid: [5003, 43],
        nssid: [5003, 42],
    });
    const otherNamespace = identity({
        pid: 6002,
        namespace: 'pid:[9002]',
        argv: BASH_WRAPPER_ARGV,
        nspid: [6002, 42],
        nspgid: [6002, 42],
        nssid: [6002, 42],
    });
    const records = new Map([[5001, init], [5002, shell], [5003, forged], [6002, otherNamespace]]);
    const fsApi = { readdir: async () => directoryEntries(...records.keys()) };
    const record = {
        containerInitBoxPid: 5001,
        containerInitStartToken: 'linux-proc:50010',
        pidNamespace: 'pid:[9001]',
    };
    const options = {
        fsApi,
        readIdentity: async (pid) => records.get(pid),
    };
    assert.deepEqual(
        (await listAgentMarkerProcesses(record, MARKER, options)).map((entry) => entry.pid),
        [5002],
    );
    assert.deepEqual(
        (await listAgentRecordedNamespaceMarkerProcesses({
            pid: 5001,
            startToken: 'linux-proc:50010',
            pidNamespace: 'pid:[9001]',
        }, MARKER, options)).map((entry) => entry.pid),
        [5002],
    );
});

test('missing, forged, and duplicate wrapper markers fail startup capture', async () => {
    const init = identity({ pid: 5001, nspid: [5001, 1], nspgid: [5001, 1], nssid: [5001, 1] });
    const baseWrapper = identity({
        pid: 5002,
        innerUid: 1000,
        nspid: [5002, 42],
        nspgid: [5002, 42],
        nssid: [5002, 42],
    });
    const child = identity({
        pid: 5003,
        parentPid: 5002,
        argv: BASH_INTERACTIVE_ARGV,
        innerUid: 1000,
        nspid: [5003, 43],
        nspgid: [5003, 43],
        nssid: [5003, 42],
    });
    const expectedInner = {
        pid: 43,
        processGroupId: 43,
        sessionId: 42,
        uid: 1000,
        startToken: 'linux-proc:50030',
    };
    for (const records of [
        new Map([[5001, init], [5002, baseWrapper], [5003, child]]),
        new Map([
            [5001, init],
            [5002, { ...baseWrapper, argv: [...BASH_WRAPPER_ARGV.slice(0, -1), `${MARKER_ARGUMENT}-forged`] }],
            [5003, child],
        ]),
        new Map([
            [5001, init],
            [5002, { ...baseWrapper, argv: BASH_WRAPPER_ARGV }],
            [5003, child],
            [5004, identity({
                pid: 5004,
                argv: BASH_WRAPPER_ARGV,
                innerUid: 1000,
                nspid: [5004, 44],
                nspgid: [5004, 44],
                nssid: [5004, 42],
            })],
        ]),
    ]) {
        await assert.rejects(
            () => captureAgentInnerProcessIdentity({
                containerInitBoxPid: 5001,
                inner: expectedInner,
                marker: MARKER,
            }, {
                fsApi: { readdir: async () => directoryEntries(...records.keys()) },
                readIdentity: async (pid) => records.get(pid),
            }),
            (error) => error.category === 'marker-correlation',
        );
    }
});

test('stopped target recovery returns only exact recorded-namespace marker survivors', async () => {
    const record = {
        pid: 5001,
        startToken: 'linux-proc:50010',
        pidNamespace: 'pid:[9001]',
    };
    let anchorReads = 0;
    const empty = await listAgentRecordedNamespaceMarkerProcesses(record, MARKER, {
        fsApi: { readdir: async () => [] },
        readIdentity: async () => { anchorReads += 1; throw new Error('must not read'); },
    });
    assert.deepEqual(empty, []);
    assert.equal(anchorReads, 0);

    assert.deepEqual(
        (await listAgentRecordedNamespaceMarkerProcesses(record, MARKER, {
            fsApi: { readdir: async () => directoryEntries(5002, 6002) },
            readIdentity: async (pid) => identity({
                pid,
                namespace: pid === 5002 ? 'pid:[9001]' : 'pid:[9002]',
                argv: BASH_WRAPPER_ARGV,
                nspid: [pid, 42],
                nspgid: [pid, 42],
                nssid: [pid, 42],
            }),
        })).map((entry) => entry.pid),
        [5002],
    );
});

test('proc scans exclude PID 1 before invoking positive identity readers', async () => {
    const reads = [];
    const result = await listAgentMarkerProcesses({ pidNamespace: 'pid:[9001]' }, MARKER, {
        fsApi: { readdir: async () => directoryEntries(1, 5002) },
        readIdentity: async (pid) => {
            reads.push(pid);
            return identity({
                pid,
                argv: BASH_WRAPPER_ARGV,
                nspid: [pid, 42],
                nspgid: [pid, 42],
                nssid: [pid, 42],
            });
        },
    });
    assert.deepEqual(reads, [5002]);
    assert.deepEqual(result.map((entry) => entry.pid), [5002]);
});

test('proc namespace prefilter skips only processes that vanish after enumeration', async () => {
    let identityReads = 0;
    const result = await listAgentMarkerProcesses({ pidNamespace: 'pid:[9001]' }, MARKER, {
        fsApi: {
            readdir: async () => directoryEntries(5002),
            readlink: async () => {
                const error = new Error('process vanished');
                error.code = 'ENOENT';
                throw error;
            },
        },
        readIdentity: async () => {
            identityReads += 1;
            throw new Error('must not read a vanished process');
        },
    });
    assert.deepEqual(result, []);
    assert.equal(identityReads, 0);

    await assert.rejects(
        () => listAgentMarkerProcesses({ pidNamespace: 'pid:[9001]' }, MARKER, {
            fsApi: {
                readdir: async () => directoryEntries(5002),
                readlink: async () => {
                    const error = new Error('permission denied');
                    error.code = 'EACCES';
                    throw error;
                },
            },
            readIdentity: async () => identity({ pid: 5002 }),
        }),
        (error) => error.code === 'EACCES',
    );
});

test('session cleanup snapshots and signals only revalidated exact positive PIDs', async () => {
    const init = identity({ pid: 5001, nspid: [5001, 1], nspgid: [5001, 1], nssid: [5001, 1] });
    const wrapper = identity({ pid: 5002, argv: BASH_WRAPPER_ARGV, nspid: [5002, 42], nspgid: [5002, 42], nssid: [5002, 42] });
    const child = identity({
        pid: 5003,
        parentPid: 5002,
        argv: BASH_INTERACTIVE_ARGV,
        nspid: [5003, 43],
        nspgid: [5003, 43],
        nssid: [5003, 42],
    });
    const other = identity({ pid: 5004, nspid: [5004, 44], nspgid: [5004, 44], nssid: [5004, 44] });
    const records = new Map([[5001, init], [5002, wrapper], [5003, child], [5004, other]]);
    const fsApi = { readdir: async () => directoryEntries(...records.keys()) };
    const readIdentity = async (pid) => records.get(pid);
    const captured = await captureAgentInnerProcessIdentity({
        containerInitBoxPid: 5001,
        inner: {
            pid: 43,
            processGroupId: 43,
            sessionId: 42,
            uid: 0,
            startToken: 'linux-proc:50030',
        },
        marker: MARKER,
    }, { fsApi, readIdentity });
    const snapshot = await captureAgentSessionSnapshot(captured, { fsApi, readIdentity });
    assert.deepEqual(snapshot.map((entry) => entry.pid), [5002, 5003]);
    const signals = [];
    const result = await signalExactAgentSessionSnapshot(snapshot, 'SIGTERM', {
        fsApi,
        readIdentity,
        signalImpl: (pid, signal) => signals.push([pid, signal]),
    });
    assert.deepEqual(result, { signal: 'SIGTERM', signaled: 2 });
    assert.deepEqual(signals, [[5002, 'SIGTERM'], [5003, 'SIGTERM']]);

    records.set(5003, identity({
        pid: 5003,
        start: 99999,
        nspid: [5003, 43],
        nspgid: [5003, 43],
        nssid: [5003, 42],
    }));
    await assert.rejects(
        () => signalExactAgentSessionSnapshot(snapshot, 'SIGKILL', {
            fsApi,
            readIdentity,
            signalImpl: () => {},
        }),
        (error) => error.category === 'session-member-changed',
    );
});

test('recycled numeric session IDs without the immutable anchor are never classified as owned', async () => {
    const init = identity({ pid: 5001, nspid: [5001, 1], nspgid: [5001, 1], nssid: [5001, 1] });
    const replacement = identity({
        pid: 7002,
        start: 70020,
        nspid: [7002, 42],
        nspgid: [7002, 42],
        nssid: [7002, 42],
    });
    const records = new Map([[5001, init], [7002, replacement]]);
    const fsApi = { readdir: async () => directoryEntries(...records.keys()) };
    await assert.rejects(
        () => listAgentSessionMembers({
            boxPid: 5002,
            boxStartToken: 'linux-proc:50020',
            boxProcessGroupId: 5002,
            boxSessionId: 5002,
            pidNamespace: 'pid:[9001]',
            innerPid: 42,
            innerProcessGroupId: 42,
            innerSessionId: 42,
            containerInitBoxPid: 5001,
            containerInitStartToken: 'linux-proc:50010',
        }, {
            fsApi,
            readIdentity: async (pid) => records.get(pid),
        }),
        (error) => error.code === 'WEBTTY_AGENT_PROCESS_IDENTITY_UNPROVEN'
            && error.category === 'session-anchor-missing',
    );
});
