import assert from 'node:assert/strict';
import test from 'node:test';

import {
    capturePtyProcessIdentity,
    capturePtySessionSnapshot,
    cleanupPtySession,
    captureWorkerProcessIdentity,
    parseLinuxProcessStat,
    revalidatePtyProcessIdentity,
    revalidatePtyProcessLiveness,
    revalidateWorkerProcessIdentity,
    signalVerifiedPtyProcessGroup,
    signalExactPtySessionSnapshot,
    waitForPtyProcessExit,
} from '../../core-services/webtty/process-identity.mjs';

function procStat(pid, {
    state = 'S',
    processGroupId = pid,
    sessionId = pid,
    ttyNumber = 34816,
    foregroundProcessGroupId = pid,
    startTicks = '123456',
} = {}) {
    const fields = [
        state, '1', String(processGroupId), String(sessionId), String(ttyNumber),
        String(foregroundProcessGroupId), '0', '0', '0', '0', '0', '0', '0', '0',
        '0', '20', '0', '1', '0', startTicks,
    ];
    return `${pid} (bash ) unusual name) ${fields.join(' ')}`;
}

function identity(pid = 4242, overrides = {}) {
    return parseLinuxProcessStat(procStat(pid, overrides), pid);
}

test('Linux stat parsing handles closing parentheses and exact topology fields', () => {
    assert.deepEqual(identity(), {
        pid: 4242,
        state: 'S',
        processGroupId: 4242,
        sessionId: 4242,
        ttyNumber: 34816,
        foregroundProcessGroupId: 4242,
        startToken: 'linux-proc:123456',
    });
    assert.throws(() => parseLinuxProcessStat('malformed', 4242));
    assert.throws(() => parseLinuxProcessStat(procStat(4243), 4242));
    assert.throws(() => identity(4242, { startTicks: '0' }));
});

function gone() {
    const error = new Error('gone');
    error.code = 'WEBTTY_PROCESS_IDENTITY_STALE';
    throw error;
}

function sessionFixture(members, { entries = [...members.keys()].map(String), read = (pid) => members.get(pid) || gone() } = {}) {
    let cursor = 0;
    return {
        fsApi: { async opendir() {
            return {
                async read() {
                    const name = entries[cursor++];
                    return name ? { name, isDirectory: () => true } : null;
                },
                async close() {},
            };
        } },
        readIdentityImpl: read,
    };
}

const shell = identity();
const child = identity(5252, { sessionId: shell.pid, startTicks: '54321' });

test('session snapshot includes different groups only under an exact continuous live anchor', async () => {
    const unrelated = identity(6000);
    const snapshot = await capturePtySessionSnapshot(shell, sessionFixture(new Map([
        [shell.pid, shell], [child.pid, child], [unrelated.pid, unrelated],
    ])));
    assert.deepEqual(snapshot.map((member) => member.pid), [shell.pid, child.pid]);
    assert.ok(Object.isFrozen(snapshot) && snapshot.every(Object.isFrozen));
    assert.equal(snapshot[1].startToken, child.startToken);
});

test('session scan refuses unanchored, replaced and disappearing anchors', async () => {
    const members = new Map([[child.pid, child]]);
    await assert.rejects(() => capturePtySessionSnapshot(shell, sessionFixture(members)), {
        category: 'session-anchor-missing',
    });
    members.set(shell.pid, identity(shell.pid, { startTicks: '9999' }));
    await assert.rejects(() => capturePtySessionSnapshot(shell, sessionFixture(members)), {
        category: 'session-anchor-missing',
    });
    let reads = 0;
    await assert.rejects(() => capturePtySessionSnapshot(shell, sessionFixture(members, {
        entries: [String(shell.pid), String(child.pid)],
        read: (pid) => {
            if (pid === shell.pid && ++reads === 3) return gone();
            return pid === shell.pid ? shell : child;
        },
    })), { code: 'WEBTTY_PROCESS_IDENTITY_STALE' });
});

test('captured child can preserve continuity after shell exit, but SID alone cannot', async () => {
    const members = new Map([[child.pid, child]]);
    const snapshot = await capturePtySessionSnapshot(shell, {
        ...sessionFixture(members), anchors: [shell, child],
    });
    assert.deepEqual(snapshot.map((member) => member.pid), [child.pid]);
    const escaped = { ...child, sessionId: 6000 };
    await assert.rejects(() => capturePtySessionSnapshot(shell, {
        ...sessionFixture(new Map([[child.pid, escaped], [7000, identity(7000, { sessionId: shell.pid })]])),
        anchors: [child],
    }), { category: 'session-anchor-missing' });
    assert.deepEqual(await capturePtySessionSnapshot(shell, sessionFixture(new Map())), []);
});

test('session scans reject malformed evidence, unreadable files and entry limits', async () => {
    for (const invalid of [
        { ...shell, pid: 0 }, { ...shell, pid: -1 }, { ...shell, pid: Number.MAX_SAFE_INTEGER + 1 },
        { ...shell, sessionId: 0 }, { ...shell, startToken: 'bad' },
    ]) {
        await assert.rejects(() => capturePtySessionSnapshot(invalid, sessionFixture(new Map())));
    }
    await assert.rejects(() => capturePtySessionSnapshot(shell, {
        ...sessionFixture(new Map([[shell.pid, shell]]), { entries: ['4242', '5252'] }), maxEntries: 1,
    }), { category: 'proc-scan-limit' });
    await assert.rejects(() => capturePtySessionSnapshot(shell, sessionFixture(new Map(), {
        read: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    })), { code: 'EACCES' });
    await assert.rejects(() => capturePtySessionSnapshot(shell, sessionFixture(new Map(), {
        read: () => ({ ...shell, state: '' }),
    })), { category: 'session-identity' });
});

test('bounded proc reads reject overlong stat evidence and close owned handles', async () => {
    let closed = 0;
    const fsApi = {
        async open() { return {
            async read() { return { bytesRead: 64 * 1024 + 1 }; },
            async close() { closed += 1; },
        }; },
    };
    await assert.rejects(() => capturePtySessionSnapshot(shell, { fsApi }), { category: 'proc-file-limit' });
    assert.equal(closed, 1);
});

test('positive PID signaling revalidates every start token and session immediately', () => {
    const calls = [];
    signalExactPtySessionSnapshot([shell, child], 'SIGKILL', {
        deadlineAt: 100, nowImpl: () => 0,
        readIdentityImpl: (pid) => { calls.push(['read', pid]); return pid === shell.pid ? shell : child; },
        killImpl: (pid, signal) => calls.push(['kill', pid, signal]),
    });
    assert.deepEqual(calls, [
        ['read', shell.pid], ['kill', shell.pid, 'SIGKILL'],
        ['read', child.pid], ['kill', child.pid, 'SIGKILL'],
    ]);
    for (const current of [{ ...child, startToken: 'linux-proc:9999' }, { ...child, sessionId: 9999 }]) {
        assert.throws(() => signalExactPtySessionSnapshot([child], 'SIGTERM', {
            deadlineAt: 100, nowImpl: () => 0, readIdentityImpl: () => current,
            killImpl: () => assert.fail('wrong process must not receive a signal'),
        }), { category: 'session-member-changed' });
    }
});

test('missing and zombie targets are gone; signal permission failures stay unproven', () => {
    for (const readIdentityImpl of [gone, () => ({ ...child, state: 'Z' })]) {
        signalExactPtySessionSnapshot([child], 'SIGTERM', {
            deadlineAt: 100, nowImpl: () => 0, readIdentityImpl,
            killImpl: () => assert.fail('gone process must not receive signal'),
        });
    }
    assert.throws(() => signalExactPtySessionSnapshot([child], 'SIGTERM', {
        deadlineAt: 100, nowImpl: () => 0, readIdentityImpl: () => child,
        killImpl: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); },
    }), { code: 'EPERM' });
    signalExactPtySessionSnapshot([child], 'SIGTERM', {
        deadlineAt: 100, nowImpl: () => 0, readIdentityImpl: () => child,
        killImpl: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
    });
});

test('invalid snapshots and expired revalidations never authorize signals', () => {
    for (const snapshot of [[{ ...child, pid: -1 }], [{ ...child, sessionId: 0 }],
        [{ ...child, startToken: 'malformed' }], [shell, identity(6000)]]) {
        assert.throws(() => signalExactPtySessionSnapshot(snapshot, 'SIGTERM', {
            deadlineAt: 100, nowImpl: () => 0,
            killImpl: () => assert.fail('invalid evidence must not signal'),
        }));
    }
    let now = 0;
    assert.throws(() => signalExactPtySessionSnapshot([child], 'SIGTERM', {
        deadlineAt: 100, nowImpl: () => now,
        readIdentityImpl: () => { now = 100; return child; },
        killImpl: () => assert.fail('late read must not signal'),
    }), { category: 'session-deadline' });
});

test('cleanup requires stable empty scans even after the original shell is gone', async () => {
    let now = 0;
    const scans = [];
    assert.equal(await cleanupPtySession(shell, {
        nowImpl: () => now, delayImpl: async (ms) => { now += ms; },
        snapshotImpl: async () => { scans.push(now); return []; },
        signalImpl: () => assert.fail('empty session must not signal'),
    }), true);
    assert.deepEqual(scans, [0, 25]);
});

test('cleanup discovers TERM-phase children, transfers anchors and escalates within one budget', async () => {
    let now = 0;
    const calls = [];
    const newChild = { ...child, pid: 6262, startToken: 'linux-proc:6262' };
    let killed = false;
    assert.equal(await cleanupPtySession(shell, {
        nowImpl: () => now, delayImpl: async (ms) => { now += ms; },
        snapshotImpl: async (_record, { anchors }) => {
            if (now >= 50 && !killed) assert.ok(anchors.some((member) => member.pid === newChild.pid));
            return killed ? [] : (now >= 25 ? [shell, child, newChild] : [shell, child]);
        },
        signalImpl: (snapshot, signal, { deadlineAt }) => {
            calls.push({ snapshot, signal, now, deadlineAt });
            if (signal === 'SIGKILL') killed = true;
        },
    }), true);
    assert.deepEqual(calls.filter((call) => call.signal === 'SIGTERM').map((call) => call.snapshot.map((p) => p.pid)), [
        [child.pid, shell.pid], [newChild.pid],
    ]);
    assert.equal(calls.find((call) => call.signal === 'SIGKILL').now, 750);
    assert.ok(calls.every((call) => call.now < call.deadlineAt));
    assert.ok(now < 1_500);
});

for (const termSignalsBeforeCutoff of [0, 1]) {
    test(`TERM cutoff after ${termSignalsBeforeCutoff} signals rescans before KILL within the original budget`, async () => {
        let now = 0;
        let termReads = 0;
        let scans = 0;
        const members = new Map([[shell.pid, shell], [child.pid, child]]);
        const calls = [];
        assert.equal(await cleanupPtySession(shell, {
            nowImpl: () => now,
            delayImpl: async (ms) => { now += ms; },
            snapshotImpl: (record, options) => {
                scans += 1;
                return capturePtySessionSnapshot(record, { ...options, ...sessionFixture(members) });
            },
            signalImpl: (snapshot, signal, options) => signalExactPtySessionSnapshot(snapshot, signal, {
                ...options,
                readIdentityImpl: (pid) => {
                    if (signal === 'SIGTERM' && termReads++ === termSignalsBeforeCutoff) now = 750;
                    return members.get(pid) || gone();
                },
                killImpl: (pid, selectedSignal) => {
                    calls.push({ pid, signal: selectedSignal, now, scans });
                    if (selectedSignal === 'SIGKILL') members.delete(pid);
                },
            }),
        }), true);
        assert.equal(calls.filter((call) => call.signal === 'SIGTERM').length, termSignalsBeforeCutoff);
        assert.deepEqual(calls.filter((call) => call.signal === 'SIGKILL').map((call) => call.pid), [child.pid, shell.pid]);
        assert.ok(calls.filter((call) => call.signal === 'SIGKILL').every((call) => call.scans === 2));
        assert.ok(calls.every((call) => call.now < (call.signal === 'SIGTERM' ? 750 : 1_500)));
        assert.ok(now < 1_500);
    });
}

test('TERM cutoff does not swallow permission failures, replacement or total deadline expiry', async () => {
    for (const failure of ['permission', 'replacement', 'total-deadline']) {
        let now = 0;
        let signals = 0;
        await assert.rejects(() => cleanupPtySession(shell, {
            nowImpl: () => now,
            snapshotImpl: async () => [shell, child],
            signalImpl: (snapshot, signal, options) => signalExactPtySessionSnapshot(snapshot, signal, {
                ...options,
                readIdentityImpl: () => {
                    now = failure === 'total-deadline' ? 1_500 : 750;
                    if (failure === 'permission') throw Object.assign(new Error('denied'), { code: 'EACCES' });
                    return failure === 'replacement' ? { ...child, startToken: 'linux-proc:9999' } : child;
                },
                killImpl: () => { signals += 1; },
            }),
        }), failure === 'permission' ? { code: 'EACCES' } : {
            category: failure === 'replacement' ? 'session-member-changed' : 'session-deadline',
        });
        assert.equal(signals, 0);
    }
});

for (const failure of ['permission', 'anchor']) {
    test(`TERM rollover refuses KILL when the fresh scan has a ${failure} failure`, async () => {
        let now = 0;
        let scans = 0;
        let signals = 0;
        const members = new Map([[shell.pid, shell], [child.pid, child]]);
        await assert.rejects(() => cleanupPtySession(shell, {
            nowImpl: () => now,
            snapshotImpl: (record, options) => {
                scans += 1;
                return capturePtySessionSnapshot(record, {
                    ...options,
                    ...sessionFixture(members, {
                        read: (pid) => {
                            if (scans === 2 && failure === 'permission') {
                                throw Object.assign(new Error('denied'), { code: 'EACCES' });
                            }
                            return members.get(pid) || gone();
                        },
                    }),
                });
            },
            signalImpl: (snapshot, signal, options) => signalExactPtySessionSnapshot(snapshot, signal, {
                ...options,
                readIdentityImpl: () => {
                    now = 750;
                    members.delete(shell.pid);
                    members.set(child.pid, { ...child, startToken: 'linux-proc:9999' });
                    return child;
                },
                killImpl: () => { signals += 1; },
            }),
        }), failure === 'permission' ? { code: 'EACCES' } : { category: 'session-anchor-missing' });
        assert.equal(scans, 2);
        assert.equal(signals, 0);
    });
}

test('continuing churn and hanging snapshots stop at the absolute deadline', async () => {
    let now = 0;
    const signals = [];
    await assert.rejects(() => cleanupPtySession(shell, {
        nowImpl: () => now, delayImpl: async (ms) => { now += ms; },
        snapshotImpl: async () => [shell],
        signalImpl: (_snapshot, signal) => signals.push([now, signal]),
    }), { category: 'session-deadline' });
    assert.equal(now, 1_500);
    assert.ok(signals.every(([at]) => at < 1_500));
    let finish;
    const late = new Promise((resolve) => { finish = resolve; });
    const started = Date.now();
    await assert.rejects(() => capturePtySessionSnapshot(shell, {
        ...sessionFixture(new Map()), deadlineAt: started + 20,
        readIdentityImpl: () => late,
    }), { category: 'session-deadline' });
    assert.ok(Date.now() - started < 250);
    finish(shell);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(signals.every(([at]) => at < 1_500));
});

test('late cleanup snapshots cannot start any signal after the transaction timed out', async () => {
    let reads = 0;
    let finish;
    let signaled = 0;
    const pending = new Promise((resolve) => { finish = resolve; });
    await assert.rejects(() => cleanupPtySession(shell, {
        nowImpl: () => (++reads === 1 ? 0 : 1_490),
        snapshotImpl: () => pending,
        signalImpl: () => { signaled += 1; },
    }), { category: 'session-deadline' });
    finish([shell, child]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signaled, 0);
});

test('a timed-out proc open closes its eventual handle without reading it', async () => {
    let finish;
    let closed = 0;
    const pending = new Promise((resolve) => { finish = resolve; });
    await assert.rejects(() => capturePtySessionSnapshot(shell, {
        deadlineAt: Date.now() + 20,
        fsApi: { open: () => pending },
    }), { category: 'session-deadline' });
    finish({
        read: () => assert.fail('late handle must not read'),
        async close() { closed += 1; },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, 1);
});

test('PTY evidence requires pid=pgrp=session=tpgid and a controlling terminal', () => {
    const record = capturePtyProcessIdentity(4242, { readIdentityImpl: () => identity() });
    assert.equal(record.startToken, 'linux-proc:123456');
    assert.deepEqual(revalidatePtyProcessIdentity(record, { readIdentityImpl: () => identity() }), record);
    for (const overrides of [
        { processGroupId: 7 },
        { sessionId: 7 },
        { foregroundProcessGroupId: 7 },
        { ttyNumber: 0 },
        { state: 'Z' },
    ]) {
        assert.throws(() => capturePtyProcessIdentity(4242, {
            readIdentityImpl: () => identity(4242, overrides),
        }));
    }
    assert.throws(() => revalidatePtyProcessIdentity(record, {
        readIdentityImpl: () => identity(4242, { startTicks: '999999' }),
    }));
});

test('negative-PID signals happen only after immediate exact revalidation', () => {
    const record = capturePtyProcessIdentity(4242, { readIdentityImpl: () => identity() });
    const calls = [];
    const result = signalVerifiedPtyProcessGroup(record, 'SIGTERM', {
        readIdentityImpl: () => { calls.push('read'); return identity(); },
        killImpl: (target, signal) => calls.push(['kill', target, signal]),
    });
    assert.equal(result.signaled, true);
    assert.deepEqual(calls.slice(-1), [["kill", -4242, 'SIGTERM']]);
    assert.ok(calls.slice(0, -1).every((entry) => entry === 'read'));
    assert.throws(() => signalVerifiedPtyProcessGroup(record, 'SIGUSR1', {
        readIdentityImpl: () => identity(),
        killImpl: () => assert.fail('must not signal'),
    }));
    assert.throws(() => signalVerifiedPtyProcessGroup(record, 'SIGKILL', {
        readIdentityImpl: () => identity(4242, { startTicks: '888' }),
        killImpl: () => assert.fail('must not signal a reused pid'),
    }));
});

test('foreground job-control changes do not invalidate the recorded shell process group', () => {
    const record = capturePtyProcessIdentity(4242, { readIdentityImpl: () => identity() });
    const calls = [];
    const result = signalVerifiedPtyProcessGroup(record, 'SIGTERM', {
        readIdentityImpl: () => identity(4242, { foregroundProcessGroupId: 5252 }),
        killImpl: (target, signal) => calls.push([target, signal]),
    });
    assert.deepEqual(result, {
        signaled: true,
        signal: 'SIGTERM',
        processGroupId: 4242,
    });
    assert.deepEqual(calls, [[-4242, 'SIGTERM']]);
});

test('worker identity binds executable, absolute script, argv, and stable start token', () => {
    const executablePath = '/usr/local/bin/node';
    const workerScriptPath = '/opt/ploinky/core-services/webtty/terminal-worker.mjs';
    const record = captureWorkerProcessIdentity({
        pid: 5151,
        executablePath,
        workerScriptPath,
        readIdentityImpl: () => identity(5151, {
            processGroupId: 1,
            sessionId: 1,
            ttyNumber: 0,
            foregroundProcessGroupId: -1,
        }),
        readArgvImpl: () => [executablePath, workerScriptPath, '--ploinky-webtty-marker=abcdefghijklmnopqrstuvwx'],
    });
    assert.equal(record.startToken, 'linux-proc:123456');
    assert.equal(revalidateWorkerProcessIdentity(record, {
        readIdentityImpl: () => identity(5151, {
            processGroupId: 1,
            sessionId: 1,
            ttyNumber: 0,
            foregroundProcessGroupId: -1,
        }),
        readArgvImpl: () => [executablePath, workerScriptPath, '--ploinky-webtty-marker=abcdefghijklmnopqrstuvwx'],
    }).pid, 5151);
    assert.throws(() => captureWorkerProcessIdentity({
        pid: 5151,
        executablePath,
        workerScriptPath,
        readIdentityImpl: () => identity(5151),
        readArgvImpl: () => [executablePath, '/tmp/same-name/terminal-worker.mjs'],
    }));
});

test('PTY liveness follows only the exact pid and start token during normal teardown', async () => {
    const record = capturePtyProcessIdentity(4242, { readIdentityImpl: () => identity() });
    const teardownIdentity = identity(4242, {
        processGroupId: 7,
        sessionId: 7,
        ttyNumber: 0,
        foregroundProcessGroupId: -1,
    });
    assert.deepEqual(revalidatePtyProcessLiveness(record, {
        readIdentityImpl: () => teardownIdentity,
    }), teardownIdentity);

    let reads = 0;
    assert.equal(await waitForPtyProcessExit(record, {
        readIdentityImpl: () => {
            reads += 1;
            if (reads <= 2) return teardownIdentity;
            const error = new Error('gone');
            error.code = 'WEBTTY_PROCESS_IDENTITY_STALE';
            throw error;
        },
        delayImpl: async () => {},
    }), true);
});

test('exit waiting treats pid reuse and zombies as proof that the original process is gone', async () => {
    const record = capturePtyProcessIdentity(4242, { readIdentityImpl: () => identity() });
    assert.equal(await waitForPtyProcessExit(record, {
        readIdentityImpl: () => identity(4242, { startTicks: '777' }),
    }), true);
    assert.equal(await waitForPtyProcessExit(record, {
        readIdentityImpl: () => identity(4242, { state: 'Z' }),
    }), true);
});

test('exit waiting rejects unreadable identity evidence and times out without weakening signal checks', async () => {
    const record = capturePtyProcessIdentity(4242, { readIdentityImpl: () => identity() });
    await assert.rejects(() => waitForPtyProcessExit(record, {
        readIdentityImpl: () => {
            const error = new Error('unreadable');
            error.code = 'WEBTTY_PROCESS_IDENTITY_UNPROVEN';
            throw error;
        },
    }), { code: 'WEBTTY_PROCESS_IDENTITY_UNPROVEN' });
    await assert.rejects(() => waitForPtyProcessExit(record, {
        readIdentityImpl: () => ({ ...identity(), startToken: 'malformed' }),
    }), { code: 'WEBTTY_PROCESS_IDENTITY_UNPROVEN' });

    const alteredTopology = identity(4242, {
        processGroupId: 7,
        sessionId: 7,
        ttyNumber: 0,
        foregroundProcessGroupId: -1,
    });
    let now = 0;
    assert.equal(await waitForPtyProcessExit(record, {
        timeoutMs: 20,
        pollMs: 10,
        nowImpl: () => now,
        delayImpl: async (duration) => { now += duration; },
        readIdentityImpl: () => alteredTopology,
    }), false);

    assert.throws(() => signalVerifiedPtyProcessGroup(record, 'SIGKILL', {
        readIdentityImpl: () => alteredTopology,
        killImpl: () => assert.fail('must not signal after topology becomes unsafe'),
    }), { code: 'WEBTTY_PROCESS_IDENTITY_UNPROVEN' });
});
