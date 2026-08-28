import assert from 'node:assert/strict';
import test from 'node:test';

import {
    capturePtyProcessIdentity,
    captureWorkerProcessIdentity,
    parseLinuxProcessStat,
    revalidatePtyProcessIdentity,
    revalidatePtyProcessLiveness,
    revalidateWorkerProcessIdentity,
    signalVerifiedPtyProcessGroup,
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
