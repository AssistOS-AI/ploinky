import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    agentStartupClientMatches,
    inspectExactAgentTargetAsync,
    listExactAgentStartupPodmanClients,
    listLinuxSessionMembers,
    readLinuxProcessIdentity,
    RuntimeRecordStore,
} from '../../cli/server/webtty/runtimeRecords.mjs';
import { fixedAgentPodmanArgv } from '../../cli/server/webtty/agentRuntime.mjs';
import { DEFAULT_WEBTTY_AGENT_WORKER_PATH } from '../../cli/server/webtty/agentWorkerClient.mjs';
import { WEBTTY_AGENT_BACKEND } from '../../cli/server/webtty/agentWorkerProtocol.mjs';

const AGENT_CONTAINER_ID = 'a'.repeat(64);
const AGENT_EXEC_ID = 'b'.repeat(64);

function agentTarget() {
    return {
        runtime: 'podman',
        containerId: AGENT_CONTAINER_ID,
        containerName: 'ploinky-agent-demo',
        instanceId: 'instance-demo',
        enableGeneration: 'enable-generation-demo',
    };
}

function agentWorkerObserved(overrides = {}) {
    return {
        ...workerIdentity(),
        state: 'S',
        pgrp: 201,
        session: 201,
        cmdline: [
            '/usr/bin/node',
            DEFAULT_WEBTTY_AGENT_WORKER_PATH,
            '--ploinky-webtty-agent-worker=v1',
        ],
        ...overrides,
    };
}

function agentEvidence(marker = 'worker-marker-abcdefghijklmnopqrstuvwx') {
    return {
        backend: WEBTTY_AGENT_BACKEND,
        runtime: 'podman',
        containerId: AGENT_CONTAINER_ID,
        targetUser: '1000:1000',
        translatedCwd: '/workspace/demo',
        marker,
        execId: AGENT_EXEC_ID,
        clientProcess: {
            pid: 4100,
            uid: 1000,
            startToken: 'linux-proc:41000',
            processGroupId: 4100,
            sessionId: 4100,
            foregroundProcessGroupId: 4100,
            ttyNumber: 34816,
        },
        innerProcess: {
            boxPid: 4200,
            boxStartToken: 'linux-proc:42000',
            boxProcessGroupId: 4200,
            boxSessionId: 4200,
            pidNamespace: 'pid:[9001]',
            nspid: [4200, 42],
            nspgid: [4200, 42],
            nssid: [4200, 42],
            innerPid: 42,
            innerProcessGroupId: 42,
            innerSessionId: 42,
            innerUid: 1000,
            innerStartToken: 'linux-proc:42000',
            containerInitBoxPid: 4199,
            containerInitStartToken: 'linux-proc:41990',
        },
    };
}

function agentStartupEvidence(marker = 'worker-marker-abcdefghijklmnopqrstuvwx', overrides = {}) {
    return {
        backend: WEBTTY_AGENT_BACKEND,
        runtime: 'podman',
        containerId: AGENT_CONTAINER_ID,
        targetUser: '1000:1000',
        translatedCwd: '/workspace/demo',
        marker,
        baselineExecIds: [],
        containerInitProcess: {
            pid: 4199,
            startToken: 'linux-proc:41990',
            pidNamespace: 'pid:[9001]',
        },
        ...overrides,
    };
}

function agentMarkerWrapper() {
    const inner = agentEvidence().innerProcess;
    return {
        pid: inner.boxPid,
        state: 'S',
        startToken: inner.boxStartToken,
        parentPid: inner.containerInitBoxPid,
        processGroupId: inner.boxProcessGroupId,
        sessionId: inner.boxSessionId,
        pidNamespace: inner.pidNamespace,
        nspid: inner.nspid,
        nspgid: inner.nspgid,
        nssid: inner.nssid,
        innerUid: inner.innerUid,
        argv: [],
    };
}

async function createAgentRecord(store, { state = 'worker-only' } = {}) {
    const marker = 'worker-marker-abcdefghijklmnopqrstuvwx';
    const handle = await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker,
        targetKind: 'agent',
        target: agentTarget(),
        worker: workerIdentity(),
    });
    if (state !== 'worker-only') {
        await store.markAgentPtyStarting(handle, agentStartupEvidence(marker));
    }
    if (state === 'pty-ready') {
        await store.update(handle, {
            ...handle.record,
            agent: agentEvidence(marker),
            ptyState: 'pty-ready',
        });
    }
    return handle;
}

function workerIdentity() {
    return { pid: 201, startToken: 'linux-proc:101', uid: process.getuid?.() ?? 0 };
}

function observedWorker(marker, overrides = {}) {
    return {
        ...workerIdentity(),
        pgrp: 201,
        session: 201,
        cmdline: ['node', `--ploinky-webtty-marker=${marker}`],
        ...overrides,
    };
}

function ptyIdentity() {
    return {
        pid: 301,
        startToken: 'linux-proc:202',
        uid: process.getuid?.() ?? 0,
        pgrp: 301,
        session: 301,
    };
}

async function markPtyReady(store, handle) {
    await store.markPtyStarting(handle);
    await store.update(handle, {
        ...handle.record,
        pty: ptyIdentity(),
        ptyState: 'pty-ready',
    });
}

function procStat(pid, {
    state = 'S', pgrp = pid, session = pid, startToken = '12345',
} = {}) {
    const fields = [
        state, '1', String(pgrp), String(session), '34816', String(pgrp),
        '0', '0', '0', '0', '0', '0', '0', '0', '0', '20', '0', '1', '0', startToken,
    ];
    return `${pid} (command ) with parens) ${fields.join(' ')}`;
}

test('Linux session enumeration returns live members and ignores zombies and other sessions', async (t) => {
    const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-proc-'));
    t.after(() => fs.rm(procRoot, { recursive: true, force: true }));
    for (const [pid, stat] of [
        [301, procStat(301, { state: 'Z', session: 301 })],
        [302, procStat(302, { pgrp: 302, session: 301, startToken: '12346' })],
        [401, procStat(401, { session: 401, startToken: '12347' })],
    ]) {
        await fs.mkdir(path.join(procRoot, String(pid)));
        await fs.writeFile(path.join(procRoot, String(pid), 'stat'), stat);
    }
    await fs.writeFile(path.join(procRoot, 'not-a-pid'), 'ignored');

    assert.deepEqual(await listLinuxSessionMembers(301, { procRoot }), [{
        pid: 302,
        state: 'S',
        pgrp: 302,
        session: 301,
        startToken: 'linux-proc:12346',
    }]);
});

test('Router recovery does not misclassify an unrelated not-found engine failure as target absence', async () => {
    for (const stderr of [
        'runtime database not found',
        `Error: cannot connect to nested runtime: no such container ${AGENT_CONTAINER_ID}`,
        `Error: permission denied; container ${AGENT_CONTAINER_ID} does not exist in cached database`,
    ]) {
        await assert.rejects(inspectExactAgentTargetAsync(AGENT_CONTAINER_ID, {
            execFileImpl: (_command, _args, _options, callback) => callback(
                Object.assign(new Error('engine failure'), { code: 125 }), '', stderr,
            ),
        }), (error) => error.code === 'WEBTTY_AGENT_PODMAN_FAILURE');
    }
});

test('Router recovery accepts only the exact Podman inspect absence stream frame', async () => {
    const exactStderr = `Error: no such container "${AGENT_CONTAINER_ID}"\n`;
    for (const stdout of ['', '[]\n']) {
        assert.deepEqual(await inspectExactAgentTargetAsync(AGENT_CONTAINER_ID, {
            execFileImpl: (_command, _args, _options, callback) => callback(
                Object.assign(new Error('absent'), { code: 125 }), stdout, exactStderr,
            ),
        }), { absent: true, id: AGENT_CONTAINER_ID });
    }
    for (const stdout of [
        '[{}]\n',
        '[]\nuntrusted trailing output\n',
        `[{"Id":"${AGENT_CONTAINER_ID}"}]\n`,
    ]) {
        await assert.rejects(inspectExactAgentTargetAsync(AGENT_CONTAINER_ID, {
            execFileImpl: (_command, _args, _options, callback) => callback(
                Object.assign(new Error('ambiguous absence'), { code: 125 }), stdout, exactStderr,
            ),
        }), (error) => error.code === 'WEBTTY_AGENT_PODMAN_FAILURE');
    }
});

test('startup client discovery accepts only the exact fixed marker-bearing Podman argv', async (t) => {
    const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-startup-proc-'));
    t.after(() => fs.rm(procRoot, { recursive: true, force: true }));
    await fs.mkdir(path.join(procRoot, '4100'));
    await fs.mkdir(path.join(procRoot, '4101'));
    const startup = agentStartupEvidence();
    const exact = {
        pid: 4100,
        state: 'S',
        pgrp: 4100,
        session: 4100,
        startToken: 'linux-proc:41000',
        uid: 1000,
        cmdline: [
            '/usr/bin/podman',
            ...fixedAgentPodmanArgv(startup),
        ],
    };
    const foreign = {
        ...exact,
        pid: 4101,
        pgrp: 4101,
        session: 4101,
        startToken: 'linux-proc:41010',
        cmdline: exact.cmdline.map((value) => (
            value === `PLOINKY_WEBTTY_MARKER=${startup.marker}`
                ? 'PLOINKY_WEBTTY_MARKER=foreign_marker_abcdefghijkl'
                : value
        )),
    };
    assert.equal(agentStartupClientMatches(exact, startup, 1000), true);
    assert.equal(agentStartupClientMatches(foreign, startup, 1000), false);
    assert.deepEqual(await listExactAgentStartupPodmanClients(startup, 1000, {
        procRoot,
        readCandidate: async (pid) => pid === 4100,
        readIdentity: async (pid) => (pid === 4100 ? exact : foreign),
    }), [exact]);
});

test('startup client discovery excludes unrelated incomplete proc entries before full identity', async (t) => {
    const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-startup-prefilter-'));
    t.after(() => fs.rm(procRoot, { recursive: true, force: true }));
    await fs.mkdir(path.join(procRoot, '4100'));
    await fs.mkdir(path.join(procRoot, '4101'));
    const identityReads = [];
    const startup = agentStartupEvidence();
    const exact = {
        pid: 4101,
        state: 'S',
        pgrp: 4101,
        session: 4101,
        startToken: 'linux-proc:41010',
        uid: 1000,
        cmdline: ['/usr/bin/podman', ...fixedAgentPodmanArgv(startup)],
    };
    assert.deepEqual(await listExactAgentStartupPodmanClients(startup, 1000, {
        procRoot,
        readCandidate: async (pid) => pid === 4101,
        readIdentity: async (pid) => {
            identityReads.push(pid);
            if (pid === 4100) throw new Error('incomplete proc identity');
            return exact;
        },
    }), [exact]);
    assert.deepEqual(identityReads, [4101]);
});

test('startup client discovery fails closed when an exact-argv candidate has incomplete identity', async (t) => {
    const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-startup-fail-closed-'));
    t.after(() => fs.rm(procRoot, { recursive: true, force: true }));
    await fs.mkdir(path.join(procRoot, '4100'));
    await assert.rejects(() => listExactAgentStartupPodmanClients(
        agentStartupEvidence(),
        1000,
        {
            procRoot,
            readCandidate: async () => true,
            readIdentity: async () => { throw new Error('incomplete proc identity'); },
        },
    ), /incomplete proc identity/);
});

test('Linux proc recovery scans are entry-bounded', async (t) => {
    const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-proc-limit-'));
    t.after(() => fs.rm(procRoot, { recursive: true, force: true }));
    await Promise.all([2, 3, 4].map((pid) => fs.mkdir(path.join(procRoot, String(pid)))));
    await assert.rejects(
        () => listLinuxSessionMembers(301, { procRoot, maxEntries: 2 }),
        (error) => error.code === 'WEBTTY_PROCESS_IDENTITY_UNPROVEN'
            && error.category === 'proc-scan-limit',
    );
});

test('Linux process identity rejects oversized proc files before parsing', async (t) => {
    const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-proc-file-limit-'));
    t.after(() => fs.rm(procRoot, { recursive: true, force: true }));
    const pid = 4100;
    const directory = path.join(procRoot, String(pid));
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'stat'), procStat(pid));
    await fs.writeFile(path.join(directory, 'status'), 'Uid:\t1000\t1000\t1000\t1000\n');
    await fs.writeFile(path.join(directory, 'cmdline'), Buffer.alloc((64 * 1024) + 1, 65));
    await assert.rejects(
        () => readLinuxProcessIdentity(pid, { procRoot }),
        (error) => error.code === 'WEBTTY_PROCESS_IDENTITY_UNPROVEN'
            && error.category === 'proc-file-limit',
    );
});

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function sessionProcFixture(t, count = 9) {
    const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-session-scan-'));
    t.after(() => fs.rm(procRoot, { recursive: true, force: true }));
    const pids = Array.from({ length: count }, (_, index) => 302 + index);
    await Promise.all(pids.map(async pid => {
        await fs.mkdir(path.join(procRoot, String(pid)));
        await fs.writeFile(path.join(procRoot, String(pid), 'stat'), procStat(pid, { session: 301 }));
    }));
    return { procRoot, pids };
}

test('session scans overlap at most four complete stat visits and cover every entry', { timeout: 5_000 }, async t => {
    const { procRoot, pids } = await sessionProcFixture(t);
    const originalOpen = fs.open.bind(fs);
    const release = deferred();
    const fourOpened = deferred();
    let openCount = 0;
    let active = 0;
    let maximum = 0;
    t.mock.method(fs, 'open', async (...args) => {
        const handle = await originalOpen(...args);
        openCount += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        if (active === 4) fourOpened.resolve();
        return {
            async read(...readArgs) { await release.promise; return handle.read(...readArgs); },
            async close() { try { await handle.close(); } finally { active -= 1; } },
        };
    });
    const scan = listLinuxSessionMembers(301, { procRoot });
    try {
        await Promise.race([fourOpened.promise, new Promise(resolve => setTimeout(resolve, 500))]);
        assert.equal(active, 4, 'independent stat reads must progress while the first read is held');
        release.resolve();
        const members = await scan;
        assert.deepEqual(members.map(member => member.pid).sort((a, b) => a - b), pids);
        assert.equal(openCount, pids.length * 2, 'every member requires both identity snapshots');
        assert.equal(maximum, 4);
        assert.equal(active, 0);
    } finally {
        release.resolve();
        await scan.catch(() => {});
    }
});

test('session scan deadline closes late opens without starting reads or later batches', { timeout: 5_000 }, async t => {
    const { procRoot } = await sessionProcFixture(t);
    const originalOpen = fs.open.bind(fs);
    const release = deferred();
    const closed = deferred();
    let opens = 0;
    let reads = 0;
    let closes = 0;
    t.mock.method(fs, 'open', async (...args) => {
        const handle = await originalOpen(...args);
        opens += 1;
        await release.promise;
        return {
            async read(...readArgs) { reads += 1; return handle.read(...readArgs); },
            async close() { await handle.close(); if (++closes === 4) closed.resolve(); },
        };
    });
    try {
        await assert.rejects(listLinuxSessionMembers(301, { procRoot, scanTimeoutMs: 100 }), {
            code: 'WEBTTY_PROCESS_IDENTITY_UNPROVEN', category: 'proc-scan-timeout',
        });
        assert.equal(opens, 4);
        release.resolve();
        await closed.promise;
        assert.equal(reads, 0);
        assert.equal(opens, 4, 'settlement must not schedule another batch');
    } finally { release.resolve(); }
});

test('session scan deadline closes a late directory open without enumerating it', { timeout: 5_000 }, async t => {
    const { procRoot } = await sessionProcFixture(t);
    const release = deferred();
    const closed = deferred();
    let closes = 0;
    let enumerations = 0;
    t.mock.method(fs, 'opendir', async () => {
        await release.promise;
        return {
            async close() { closes += 1; closed.resolve(); },
            [Symbol.asyncIterator]() { enumerations += 1; throw new Error('late directory must not be enumerated'); },
        };
    });
    try {
        await assert.rejects(listLinuxSessionMembers(301, { procRoot, scanTimeoutMs: 50 }), {
            code: 'WEBTTY_PROCESS_IDENTITY_UNPROVEN', category: 'proc-scan-timeout',
        });
        release.resolve();
        await Promise.race([closed.promise, new Promise(resolve => setTimeout(resolve, 100))]);
        assert.equal(closes, 1);
        assert.equal(enumerations, 0);
    } finally { release.resolve(); }
});

test('a pending directory iteration cannot extend the scan deadline or start late visits', { timeout: 5_000 }, async t => {
    const { procRoot } = await sessionProcFixture(t);
    const release = deferred();
    let closes = 0;
    let visits = 0;
    t.mock.method(fs, 'open', async () => { visits += 1; throw new Error('late entry must not be visited'); });
    t.mock.method(fs, 'opendir', async () => ({
        [Symbol.asyncIterator]() { return this; },
        async next() {
            await release.promise;
            return { done: false, value: { name: '302', isDirectory: () => true } };
        },
        async close() { closes += 1; await release.promise; },
    }));
    const scan = listLinuxSessionMembers(301, { procRoot, scanTimeoutMs: 50 });
    const outcome = scan.then(() => 'unexpected success', error => error);
    try {
        const result = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('hung'), 300))]);
        assert.equal(result?.category, 'proc-scan-timeout', 'directory cleanup must not extend the scan deadline');
        release.resolve();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(closes, 1);
        assert.equal(visits, 0);
    } finally { release.resolve(); await outcome; }
});

test('failed session scans stop sibling identity reads and close every held handle', { timeout: 5_000 }, async t => {
    const { procRoot } = await sessionProcFixture(t);
    const originalOpen = fs.open.bind(fs);
    const release = deferred();
    const closed = deferred();
    let opens = 0;
    let closes = 0;
    t.mock.method(fs, 'open', async (...args) => {
        const handle = await originalOpen(...args);
        opens += 1;
        const malformed = opens === 1;
        return {
            async read(...readArgs) {
                if (malformed) {
                    readArgs[0].write('bad');
                    return { bytesRead: 3 };
                }
                await release.promise;
                return handle.read(...readArgs);
            },
            async close() { await handle.close(); if (++closes === 4) closed.resolve(); },
        };
    });
    try {
        await assert.rejects(listLinuxSessionMembers(301, { procRoot }), /invalid proc stat/);
        release.resolve();
        await closed.promise;
        assert.equal(opens, 4, 'no second identity read or later batch may start after failure');
    } finally { release.resolve(); await closed.promise; }
});

test('concurrent session scans retain file, PID, and start-token evidence checks', async t => {
    for (const scenario of ['file-limit', 'wrong-pid', 'recycled-pid', 'changed-session']) {
        await t.test(scenario, async t => {
            const { procRoot, pids } = await sessionProcFixture(t, 4);
            const selectedPath = path.join(procRoot, String(pids[0]), 'stat');
            if (scenario === 'file-limit') await fs.writeFile(selectedPath, Buffer.alloc(64 * 1024 + 1));
            if (scenario === 'wrong-pid') await fs.writeFile(selectedPath, procStat(999, { session: 301 }));
            if (scenario === 'recycled-pid' || scenario === 'changed-session') {
                const originalOpen = fs.open.bind(fs);
                let snapshots = 0;
                t.mock.method(fs, 'open', async (...args) => {
                    if (args[0] === selectedPath && ++snapshots === 2) {
                        await fs.writeFile(selectedPath, procStat(pids[0], {
                            session: scenario === 'changed-session' ? 999 : 301,
                            startToken: scenario === 'recycled-pid' ? '99999' : '12345',
                        }));
                    }
                    return originalOpen(...args);
                });
            }
            const scan = listLinuxSessionMembers(301, { procRoot });
            if (scenario === 'file-limit') await assert.rejects(scan, {
                code: 'WEBTTY_PROCESS_IDENTITY_UNPROVEN', category: 'proc-file-limit',
            });
            else if (scenario === 'wrong-pid') await assert.rejects(scan, /invalid proc stat/);
            else if (scenario === 'recycled-pid') await assert.rejects(scan, /identity changed while enumerating session/);
            else assert.deepEqual((await scan).map(member => member.pid).sort((a, b) => a - b), pids.slice(1));
        });
    }
});

test('restart reclaims only exact owned atomic-write temp residue', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-temp-record-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new RuntimeRecordStore({ directory });
    await store.ensureDirectory();
    const residue = `.${'a'.repeat(24)}.json.0123456789abcdef`;
    await fs.writeFile(path.join(directory, residue), '{}', { mode: 0o600 });

    const recovery = await store.recover();
    assert.deepEqual(recovery, {
        ok: true,
        evidence: ['temporary_record_reclaimed'],
    });
    assert.deepEqual(await fs.readdir(directory), []);
});

test('restart preserves and fails closed on unrecognized runtime residue', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-unknown-record-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new RuntimeRecordStore({ directory });
    await store.ensureDirectory();
    await fs.writeFile(path.join(directory, '.foreign'), '{}', { mode: 0o600 });

    const recovery = await store.recover();
    assert.equal(recovery.ok, false);
    assert.equal(recovery.category, 'record_unprovable');
    assert.deepEqual(await fs.readdir(directory), ['.foreign']);
});

test('dead cleanup-unproven worker-only records self-heal on restart', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const signals = [];
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        signal: (...args) => signals.push(args),
        graceMs: 1,
    });
    const handle = await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker: 'worker-marker-abcdefghijklmnopqrstuvwx',
        worker: workerIdentity(),
    });
    await store.markCleanupUnproven(handle);

    const restartedStore = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        signal: (...args) => signals.push(args),
        graceMs: 1,
    });
    const recovery = await restartedStore.recover();
    assert.deepEqual(recovery, {
        ok: true,
        evidence: ['dead_unproven_record_removed'],
    });
    assert.deepEqual(signals, []);
    assert.equal((await fs.readdir(directory)).length, 0);
});

test('dead cleanup-unproven PTY records self-heal only after the whole terminal session is empty', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        listSessionMembers: async () => [],
        signal: () => assert.fail('dead identities must never be signaled'),
        graceMs: 1,
        delay: async () => {},
    });
    const handle = await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker: 'worker-marker-abcdefghijklmnopqrstuvwx',
        worker: workerIdentity(),
    });
    await markPtyReady(store, handle);
    await store.markCleanupUnproven(handle);

    assert.deepEqual(await store.recover(), {
        ok: true,
        evidence: ['dead_unproven_record_removed'],
    });
    assert.deepEqual(await fs.readdir(directory), []);
});

test('cleanup-unproven PTY records remain fail-closed while a terminal-session member survives', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const member = {
        pid: 302, state: 'S', pgrp: 302, session: 301, startToken: 'linux-proc:203',
    };
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        listSessionMembers: async () => [member],
        signal: () => assert.fail('ambiguous descendants must never be signaled'),
        graceMs: 1,
        delay: async () => {},
    });
    const handle = await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker: 'worker-marker-abcdefghijklmnopqrstuvwx',
        worker: workerIdentity(),
    });
    await markPtyReady(store, handle);
    await store.markCleanupUnproven(handle);

    const recovery = await store.recover();
    assert.equal(recovery.ok, false);
    assert.equal(recovery.category, 'cleanup_unproven');
    assert.equal((await fs.readdir(directory)).length, 1);
});

test('proven records are not removed while a terminal-session descendant survives', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        listSessionMembers: async () => [{
            pid: 302, state: 'S', pgrp: 302, session: 301, startToken: 'linux-proc:203',
        }],
        signal: () => assert.fail('an unverified descendant group must never be signaled'),
        graceMs: 1,
        delay: async () => {},
    });
    const handle = await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker: 'worker-marker-abcdefghijklmnopqrstuvwx',
        worker: workerIdentity(),
    });
    await markPtyReady(store, handle);

    const recovery = await store.recover();
    assert.equal(recovery.ok, false);
    assert.equal(recovery.category, 'process_cleanup_unconfirmed');
    assert.equal((await fs.readdir(directory)).length, 1);
});

test('dead proven records are removed without signaling recycled numeric process ids', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const signals = [];
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        signal: (...args) => signals.push(args),
        graceMs: 1,
    });
    await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker: 'worker-marker-abcdefghijklmnopqrstuvwx',
        worker: workerIdentity(),
    });
    assert.deepEqual(await store.recover(), {
        ok: true,
        evidence: ['dead_record_removed'],
    });
    assert.deepEqual(signals, []);
    assert.deepEqual(await fs.readdir(directory), []);
});

test('unknown cleanup state is ambiguous evidence and never normalized away', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        signal: () => assert.fail('ambiguous evidence must never be signaled'),
        graceMs: 1,
    });
    const handle = await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker: 'worker-marker-abcdefghijklmnopqrstuvwx',
        worker: workerIdentity(),
    });
    const recordPath = path.join(directory, handle.fileName);
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    record.cleanupState = 'looks-safe-but-is-unknown';
    await fs.writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });

    const recovery = await store.recover();
    assert.equal(recovery.ok, false);
    assert.equal(recovery.category, 'record_unprovable');
    assert.equal((await fs.readdir(directory)).length, 1);
});

test('crash after init admission but before ready PTY evidence remains fail-closed', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        signal: () => assert.fail('unknown startup PTY must never be signaled by numeric PID'),
        graceMs: 1,
    });
    const handle = await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker: 'worker-marker-abcdefghijklmnopqrstuvwx',
        worker: workerIdentity(),
    });
    assert.equal(await store.markPtyStarting(handle), true);

    const recovery = await store.recover();
    assert.equal(recovery.ok, false);
    assert.equal(recovery.category, 'pty_startup_unproven');
    assert.equal((await fs.readdir(directory)).length, 1);
});

test('legacy v1 records are rejected instead of being normalized into the new provider schema', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new RuntimeRecordStore({ directory, readIdentity: async () => null, graceMs: 1 });
    const handle = await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker: 'worker-marker-abcdefghijklmnopqrstuvwx',
        worker: workerIdentity(),
    });
    const recordPath = path.join(directory, handle.fileName);
    const legacy = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    legacy.schema = 'ploinky-webtty-recovery/v1';
    await fs.writeFile(recordPath, JSON.stringify(legacy), { mode: 0o600 });

    const recovery = await store.recover();
    assert.equal(recovery.ok, false);
    assert.equal(recovery.category, 'record_unprovable');
    assert.equal((await fs.readdir(directory)).length, 1);
});

test('dead agent worker-only evidence is removed without consulting container identity', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        inspectAgentTarget: () => assert.fail('worker-only admission cannot have created an exec'),
        graceMs: 1,
        delay: async () => {},
    });
    await createAgentRecord(store);

    assert.deepEqual(await store.recover(), {
        ok: true,
        evidence: ['dead_record_removed'],
        agentAvailable: true,
        quarantinedTargets: [],
    });
    assert.deepEqual(await fs.readdir(directory), []);
});

test('agent pty-starting recovery stops the exact worker and self-heals after exact absence', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const observed = [agentWorkerObserved(), agentWorkerObserved(), null, null];
    const signals = [];
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => observed.shift() ?? null,
        signal: (...args) => signals.push(args),
        listAgentStartupClients: async () => [],
        listAgentMarkers: async () => [],
        inspectAgentTarget: async () => ({ absent: true, id: AGENT_CONTAINER_ID }),
        graceMs: 1,
        delay: async () => {},
    });
    await createAgentRecord(store, { state: 'pty-starting' });

    const recovery = await store.recover();
    assert.equal(recovery.ok, true, JSON.stringify(recovery));
    assert.equal(recovery.agentAvailable, true, JSON.stringify(recovery));
    assert.deepEqual(recovery.evidence, ['verified_agent_startup_reclaimed']);
    assert.deepEqual(recovery.quarantinedTargets, []);
    assert.deepEqual(signals, [[201, 'SIGTERM']]);
    assert.equal((await fs.readdir(directory)).length, 0);
});

test('agent pty-starting recovery never drains an uncorrelated sole post-baseline exec', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let drained = false;
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        listAgentStartupClients: async () => [],
        listAgentMarkers: async () => [],
        inspectAgentTarget: async () => ({
            absent: false,
            running: false,
            initPid: 0,
            execIds: drained ? [] : [AGENT_EXEC_ID],
        }),
        drainAgentExec: async (containerId, execId) => {
            assert.equal(containerId, AGENT_CONTAINER_ID);
            assert.equal(execId, AGENT_EXEC_ID);
            drained = true;
        },
        graceMs: 1,
        delay: async () => {},
    });
    await createAgentRecord(store, { state: 'pty-starting' });
    const recovery = await store.recover();
    assert.equal(recovery.ok, true);
    assert.equal(recovery.agentAvailable, true);
    assert.deepEqual(recovery.evidence, ['agent_startup_exec_unowned']);
    assert.equal(recovery.quarantinedTargets.length, 1);
    assert.equal(drained, false);
    assert.equal((await fs.readdir(directory)).length, 1);
});

test('agent pty-starting recovery finds and reclaims the exact outer Podman client', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const startup = agentStartupEvidence();
    const client = {
        pid: 5100,
        state: 'S',
        pgrp: 5100,
        session: 5100,
        startToken: 'linux-proc:51000',
        uid: process.getuid?.() ?? 0,
        cmdline: [
            '/usr/bin/podman',
            ...fixedAgentPodmanArgv(startup),
        ],
    };
    let clientLive = true;
    const signals = [];
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async (pid) => (pid === client.pid && clientLive ? client : null),
        listAgentStartupClients: async () => (clientLive ? [client] : []),
        listAgentMarkers: async () => [],
        inspectAgentTarget: async () => ({ absent: true, id: AGENT_CONTAINER_ID }),
        signal: (pid, selectedSignal) => {
            signals.push([pid, selectedSignal]);
            if (pid === -client.pid) clientLive = false;
        },
        graceMs: 1,
        delay: async () => {},
    });
    await createAgentRecord(store, { state: 'pty-starting' });
    const recovery = await store.recover();
    assert.equal(recovery.ok, true);
    assert.deepEqual(recovery.evidence, ['verified_agent_startup_reclaimed']);
    assert.deepEqual(signals, [[-client.pid, 'SIGTERM']]);
    assert.equal((await fs.readdir(directory)).length, 0);
});

test('agent pty-starting recovery never transfers historical client ownership to a later foreign exec', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const startup = agentStartupEvidence();
    const client = {
        pid: 5100,
        state: 'S',
        pgrp: 5100,
        session: 5100,
        startToken: 'linux-proc:51000',
        uid: process.getuid?.() ?? 0,
        cmdline: ['/usr/bin/podman', ...fixedAgentPodmanArgv(startup)],
    };
    const foreignExecId = 'c'.repeat(64);
    let clientLive = true;
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async (pid) => (pid === client.pid && clientLive ? client : null),
        listAgentStartupClients: async () => (clientLive ? [client] : []),
        listAgentMarkers: async () => [],
        inspectAgentTarget: async () => ({
            absent: false,
            running: true,
            initPid: 4199,
            execIds: [foreignExecId],
        }),
        drainAgentExec: async () => assert.fail('historical client evidence must not own a later exec'),
        signal: (pid) => {
            if (pid === -client.pid) clientLive = false;
        },
        graceMs: 1,
        delay: async () => {},
    });
    await createAgentRecord(store, { state: 'pty-starting' });

    const recovery = await store.recover();
    assert.equal(recovery.ok, true, JSON.stringify(recovery));
    assert.deepEqual(recovery.evidence, ['agent_startup_exec_unowned']);
    assert.equal(recovery.quarantinedTargets.length, 1);
    assert.equal((await fs.readdir(directory)).length, 1);
});

test('agent pty-starting recovery reclaims the exact marked wrapper session before exec drainage', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const wrapper = agentMarkerWrapper();
    let markerLive = true;
    let execLive = true;
    const sessionSignals = [];
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        listAgentStartupClients: async () => [],
        listAgentMarkers: async () => (markerLive ? [wrapper] : []),
        listAgentSession: async () => (markerLive ? [wrapper] : []),
        signalAgentSession: async (snapshot, selectedSignal) => {
            assert.deepEqual(snapshot, [wrapper]);
            sessionSignals.push(selectedSignal);
            if (selectedSignal === 'SIGKILL') markerLive = false;
        },
        inspectAgentTarget: async () => ({
            absent: false,
            running: true,
            initPid: 4199,
            execIds: execLive ? [AGENT_EXEC_ID] : [],
        }),
        drainAgentExec: async (containerId, execId) => {
            assert.equal(containerId, AGENT_CONTAINER_ID);
            assert.equal(execId, AGENT_EXEC_ID);
            assert.equal(markerLive, false, 'exec drainage must follow exact marker-session reclamation');
            execLive = false;
        },
        graceMs: 1,
        delay: async () => {},
    });
    await createAgentRecord(store, { state: 'pty-starting' });

    assert.deepEqual(await store.recover(), {
        ok: true,
        evidence: ['verified_agent_startup_reclaimed'],
        agentAvailable: true,
        quarantinedTargets: [],
    });
    assert.deepEqual(sessionSignals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(await fs.readdir(directory), []);
});

test('agent pty-starting recovery retains evidence when duplicate marked wrappers are ambiguous', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const wrapper = agentMarkerWrapper();
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        listAgentStartupClients: async () => [],
        listAgentMarkers: async () => [wrapper, { ...wrapper, pid: wrapper.pid + 1 }],
        listAgentSession: async () => assert.fail('ambiguous markers must not define a session'),
        inspectAgentTarget: async () => assert.fail('ambiguous markers must stop recovery'),
        drainAgentExec: async () => assert.fail('ambiguous markers must not drain an exec'),
        graceMs: 1,
        delay: async () => {},
    });
    await createAgentRecord(store, { state: 'pty-starting' });

    const recovery = await store.recover();
    assert.deepEqual(recovery.evidence, ['agent_startup_marker_survived']);
    assert.equal(recovery.quarantinedTargets.length, 1);
    assert.equal((await fs.readdir(directory)).length, 1);
});

test('agent pty-starting recovery quarantines an unanchored exact marked wrapper', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const wrapper = agentMarkerWrapper();
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        listAgentStartupClients: async () => [],
        listAgentMarkers: async () => [wrapper],
        listAgentSession: async () => {
            const error = new Error('recorded init or session anchor changed');
            error.code = 'WEBTTY_AGENT_PROCESS_IDENTITY_STALE';
            error.category = 'container-init-replaced';
            throw error;
        },
        signalAgentSession: async () => assert.fail('unanchored session must not be signaled'),
        inspectAgentTarget: async () => assert.fail('unanchored marker must stop recovery'),
        graceMs: 1,
        delay: async () => {},
    });
    await createAgentRecord(store, { state: 'pty-starting' });

    const recovery = await store.recover();
    assert.deepEqual(recovery.evidence, ['agent_target_evidence_failed']);
    assert.equal(recovery.quarantinedTargets.length, 1);
    assert.equal((await fs.readdir(directory)).length, 1);
});

test('agent pty-starting recovery quarantines late uncorrelated exec evidence', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let inspections = 0;
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        listAgentStartupClients: async () => [],
        listAgentMarkers: async () => [],
        inspectAgentTarget: async () => {
            inspections += 1;
            return {
                absent: false,
                running: true,
                initPid: 4199,
                execIds: inspections === 1 ? [] : [AGENT_EXEC_ID],
            };
        },
        drainAgentExec: async () => assert.fail('uncorrelated late exec must not be drained'),
        graceMs: 1,
        delay: async () => {},
    });
    await createAgentRecord(store, { state: 'pty-starting' });
    const recovery = await store.recover();
    assert.equal(recovery.ok, true);
    assert.deepEqual(recovery.evidence, ['agent_startup_exec_unowned']);
    assert.equal(recovery.quarantinedTargets.length, 1);
    assert.equal((await fs.readdir(directory)).length, 1);
});

test('agent ready recovery drains the exact exec and preserves Box availability', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let drained = false;
    const inspections = [];
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        inspectAgentTarget: (containerId) => {
            assert.equal(containerId, AGENT_CONTAINER_ID);
            inspections.push(containerId);
            return {
                absent: false,
                running: true,
                execIds: drained ? [] : [AGENT_EXEC_ID],
            };
        },
        drainAgentExec: (containerId, execId) => {
            assert.equal(containerId, AGENT_CONTAINER_ID);
            assert.equal(execId, AGENT_EXEC_ID);
            drained = true;
        },
        listAgentMarkers: async () => [],
        listAgentSession: async () => [],
        graceMs: 1,
        delay: async () => {},
    });
    await createAgentRecord(store, { state: 'pty-ready' });

    assert.deepEqual(await store.recover(), {
        ok: true,
        evidence: ['verified_agent_reclaimed'],
        agentAvailable: true,
        quarantinedTargets: [],
    });
    assert.equal(drained, true);
    assert.ok(inspections.length >= 3);
    assert.deepEqual(await fs.readdir(directory), []);
});

test('agent ready recovery never drains while the exact client survives SIGKILL', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const client = {
        pid: 4100,
        state: 'S',
        pgrp: 4100,
        session: 4100,
        startToken: 'linux-proc:41000',
        uid: 1000,
        cmdline: [],
    };
    const signals = [];
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async (pid) => (pid === client.pid ? client : null),
        inspectAgentTarget: async () => ({
            absent: false,
            running: true,
            initPid: 4199,
            execIds: [AGENT_EXEC_ID],
        }),
        listAgentMarkers: async () => [],
        listAgentSession: async () => [],
        drainAgentExec: async () => assert.fail('exec must not drain while client survives'),
        signal: (...args) => signals.push(args),
        graceMs: 1,
        delay: async () => {},
    });
    await createAgentRecord(store, { state: 'pty-ready' });
    const recovery = await store.recover();
    assert.equal(recovery.ok, true);
    assert.deepEqual(recovery.evidence, ['agent_client_survived']);
    assert.equal(recovery.quarantinedTargets.length, 1);
    assert.deepEqual(signals, [[-4100, 'SIGTERM'], [-4100, 'SIGKILL']]);
});

test('agent ready recovery retains the record while its exact marker survives', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const wrapper = agentMarkerWrapper();
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        listAgentMarkers: async () => [wrapper],
        listAgentSession: async () => [],
        inspectAgentTarget: async () => ({ absent: true, id: AGENT_CONTAINER_ID }),
        drainAgentExec: async () => assert.fail('surviving marker must stop exec cleanup'),
        graceMs: 1,
        delay: async () => {},
    });
    await createAgentRecord(store, { state: 'pty-ready' });

    const recovery = await store.recover();
    assert.deepEqual(recovery.evidence, ['agent_inner_marker_survived']);
    assert.equal(recovery.quarantinedTargets.length, 1);
    assert.equal((await fs.readdir(directory)).length, 1);
});

test('agent provider evidence failure disables only agent terminals and keeps recovery globally available', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        inspectAgentTarget: () => {
            const error = new Error('podman unavailable');
            error.code = 'WEBTTY_AGENT_PODMAN_FAILURE';
            throw error;
        },
        graceMs: 1,
        delay: async () => {},
    });
    await createAgentRecord(store, { state: 'pty-ready' });

    assert.deepEqual(await store.recover(), {
        ok: true,
        evidence: ['agent_provider_evidence_failed'],
        agentAvailable: false,
        quarantinedTargets: [],
    });
    assert.equal((await fs.readdir(directory)).length, 1);
});

test('absent agent target is not reclaimed while the exact recorded inner process survives', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const evidence = agentEvidence();
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async (pid) => pid === evidence.innerProcess.boxPid
            ? {
                pid,
                state: 'S',
                startToken: evidence.innerProcess.boxStartToken,
                uid: process.getuid?.() ?? 0,
                pgrp: pid,
                session: pid,
                cmdline: [],
            }
            : null,
        inspectAgentTarget: async () => ({ absent: true, id: AGENT_CONTAINER_ID }),
        graceMs: 1,
        delay: async () => {},
    });
    await createAgentRecord(store, { state: 'pty-ready' });
    assert.equal(await store.confirmReclaimed((await store.readEntry(
        (await fs.readdir(directory))[0],
    ))), false);
});

test('agent process-evidence mechanism failure is provider-scoped while Box remains available', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        listAgentMarkers: async () => [],
        listAgentSession: async () => {
            const error = new Error('proc scan denied');
            error.code = 'WEBTTY_AGENT_PROCESS_IDENTITY_UNPROVEN';
            error.category = 'process-not-readable';
            throw error;
        },
        inspectAgentTarget: async () => ({ absent: false, running: true, execIds: [AGENT_EXEC_ID] }),
        graceMs: 1,
        delay: async () => {},
    });
    await createAgentRecord(store, { state: 'pty-ready' });
    assert.deepEqual(await store.recover(), {
        ok: true,
        evidence: ['agent_provider_evidence_failed'],
        agentAvailable: false,
        quarantinedTargets: [],
    });
});

test('restart recovery keeps exact-target session-anchor failures target scoped', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let drained = false;
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        listAgentMarkers: async () => [],
        listAgentSession: async () => {
            const error = new Error('exact target session anchor is missing');
            error.code = 'WEBTTY_AGENT_PROCESS_IDENTITY_UNPROVEN';
            error.category = 'session-anchor-missing';
            throw error;
        },
        inspectAgentTarget: async () => ({
            absent: false,
            running: true,
            execIds: drained ? [] : [AGENT_EXEC_ID],
        }),
        drainAgentExec: async (containerId, execId) => {
            assert.equal(containerId, AGENT_CONTAINER_ID);
            assert.equal(execId, AGENT_EXEC_ID);
            drained = true;
        },
        graceMs: 1,
        delay: async () => {},
    });
    await createAgentRecord(store, { state: 'pty-ready' });
    const recovery = await store.recover();
    assert.equal(recovery.ok, true, JSON.stringify(recovery));
    assert.equal(recovery.agentAvailable, true, JSON.stringify(recovery));
    assert.deepEqual(recovery.evidence, ['agent_target_evidence_failed']);
    assert.equal(recovery.quarantinedTargets.length, 1);
    assert.equal(recovery.quarantinedTargets[0].target.containerId, AGENT_CONTAINER_ID);
});

test('worker TERM refuses a PID recycled between inspection and immediate revalidation', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const marker = 'worker-marker-abcdefghijklmnopqrstuvwx';
    const observed = [
        observedWorker(marker),
        observedWorker(marker),
        observedWorker(marker, { startToken: 'linux-proc:recycled' }),
    ];
    const signals = [];
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => observed.shift() || null,
        signal: (...args) => signals.push(args),
        graceMs: 1,
    });
    await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker,
        worker: workerIdentity(),
    });
    const recovery = await store.recover();
    assert.equal(recovery.ok, false);
    assert.equal(recovery.category, 'worker_term_revalidation_failed');
    assert.deepEqual(signals, []);
});

test('worker KILL refuses a PID recycled after TERM grace', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const marker = 'worker-marker-abcdefghijklmnopqrstuvwx';
    const observed = [
        observedWorker(marker),
        observedWorker(marker),
        observedWorker(marker),
        observedWorker(marker),
        observedWorker(marker, { startToken: 'linux-proc:recycled' }),
    ];
    const signals = [];
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => observed.shift() || null,
        signal: (...args) => signals.push(args),
        graceMs: 1,
    });
    await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker,
        worker: workerIdentity(),
    });
    const recovery = await store.recover();
    assert.equal(recovery.ok, false);
    assert.equal(recovery.category, 'worker_force_revalidation_failed');
    assert.deepEqual(signals, [[201, 'SIGTERM']]);
});
