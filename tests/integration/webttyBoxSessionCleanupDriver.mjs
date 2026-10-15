import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { readLinuxProcessIdentity } from '../../core-services/webtty/process-identity.mjs';
import { WEBTTY_NATIVE_ARTIFACT_PATH } from '../../core-services/webtty/native-runtime.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webtty-box-cleanup-')));
process.env.PLOINKY_WORKSPACE_ROOT = root;
const { RuntimeRecordStore } = await import('../../cli/server/webtty/runtimeRecords.mjs');
const { WebttySessionManager } = await import('../../cli/server/webtty/sessionManager.mjs');
const { terminalTargetRouteBinding } = await import('../../cli/server/webtty/terminalTargetResolver.mjs');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const result = await check();
        if (result) return result;
        await pause(20);
    }
    throw new Error(`${label} timed out`);
}

function exactLive(expected) {
    try {
        const current = readLinuxProcessIdentity(expected.pid);
        return current.startToken === expected.startToken && current.state !== 'Z';
    } catch (error) {
        if (error.code === 'WEBTTY_PROCESS_IDENTITY_STALE') return false;
        throw error;
    }
}

const lease = {
    mode: 'local', userId: 'local:fixture', sessionId: 'fixture-session',
    sessionBindingId: 'fixture-binding', sessionFingerprint: 'fixture-fingerprint',
};
const snapshot = { generation: 'fixture-generation' };
const plan = {
    host: 'localhost', snapshot,
    hostSelection: { host: 'localhost', record: { routeKey: 'control' } },
    lease: { snapshot, id: snapshot.generation, activationId: 'fixture-activation',
        commit: () => true, isCurrent: () => true },
};
const store = new RuntimeRecordStore({ directory: path.join(root, 'records') });
const manager = new WebttySessionManager({
    workspaceRoot: root,
    recordStore: store,
    auth: {
        createLease: () => lease, requestMatchesLease: () => true,
        subscribeInvalidation: () => () => {}, validateLease: async () => ({ ok: true }),
    },
    // Authentication and target discovery are outside this native process probe.
    // The actual manager, client, worker and reclamation store remain in use.
    targetResolver: { revalidate: async ({ target }) => target },
});
const owned = [];
let sentinel;

async function createTerminal() {
    const stat = fs.statSync(root);
    const discovery = manager.launchStore.createDiscovery({
        owner: { userId: lease.userId, sessionFingerprint: lease.sessionFingerprint },
        routeBinding: terminalTargetRouteBinding(plan),
        targets: [{ kind: 'box', label: 'Box', detail: 'Fixture', access: 'rw', cwdDisplay: root,
            directory: { relativePath: '', absolutePath: root,
                identity: { dev: String(stat.dev), ino: String(stat.ino) } } }],
        agentTargetsAvailable: false,
    });
    const created = await manager.create({ req: {}, routePlan: plan, launch: discovery.targets[0].launch });
    const session = manager.sessions.get(created.id);
    owned.push(session.recordHandle.record.pty);
    return session;
}

try {
    await manager.initialize();
    sentinel = spawn('/bin/bash', ['-c', 'exec sleep 90'], { detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { sentinel.once('spawn', resolve); sentinel.once('error', reject); });
    const sentinelIdentity = readLinuxProcessIdentity(sentinel.pid);
    owned.push(sentinelIdentity);
    const session = await createTerminal();
    const shell = readLinuxProcessIdentity(session.recordHandle.record.pty.pid);
    let exits = 0;
    let unproven = 0;
    session.worker.on('terminal-exit', () => { exits += 1; });
    session.worker.on('terminal-error', (message) => { if (message.category === 'cleanup-unproven') unproven += 1; });
    const childFile = path.join(root, 'child.pid');
    await session.worker.input(`nohup /bin/bash -c 'trap "" HUP TERM; echo $$ > "${childFile}"; exec sleep 90' </dev/null >/dev/null 2>&1 &\r`);
    const child = await waitFor(() => {
        if (!fs.existsSync(childFile)) return null;
        const pid = Number(fs.readFileSync(childFile, 'utf8').trim());
        return Number.isSafeInteger(pid) && pid > 0 ? readLinuxProcessIdentity(pid) : null;
    }, 'background child');
    owned.push(child);
    assert.equal(child.sessionId, shell.sessionId);
    assert.notEqual(child.processGroupId, shell.processGroupId);
    assert.notEqual(sentinelIdentity.sessionId, shell.sessionId);
    const started = Date.now();
    let workerExitMs;
    session.worker.once('process-exit', () => { workerExitMs = Date.now() - started; });
    await manager.closeSession(session, 'requested');
    const evidence = {
        childDifferentGroup: child.processGroupId !== shell.processGroupId,
        shellGone: !exactLive(shell), childGone: !exactLive(child),
        sentinelUnchanged: exactLive(sentinelIdentity),
        reclaimed: await store.confirmReclaimed(session.recordHandle.record),
        recordRemoved: !fs.existsSync(path.join(store.directory, session.recordHandle.fileName)),
        workerExitMs, exitNotifications: exits, cleanupUnproven: unproven,
        secondAdmitted: false,
        nativeArtifactSha256: crypto.createHash('sha256').update(fs.readFileSync(WEBTTY_NATIVE_ARTIFACT_PATH)).digest('hex'),
        sources: Object.fromEntries([
            'tests/integration/webttyBoxSessionCleanupDriver.mjs',
            'core-services/webtty/process-identity.mjs', 'core-services/webtty/terminal-worker.mjs',
        ].map((source) => [source, crypto.createHash('sha256').update(fs.readFileSync(`/opt/ploinky/${source}`)).digest('hex')])),
    };
    process.stdout.write(`cleanup observation ${JSON.stringify(evidence)}\n`);
    // The native harness preserves stderr when an expected baseline assertion
    // fails, so retain the bounded process observation there before throwing.
    process.stderr.write(`cleanup observation ${JSON.stringify(evidence)}\n`);
    assert.equal(evidence.childGone, true, 'same-session background child survived native worker cleanup');
    assert.equal(evidence.reclaimed, true, 'Router did not prove full-session reclamation');
    assert.equal(evidence.recordRemoved, true);
    assert.equal(manager.availability().ok, true);
    const second = await createTerminal();
    evidence.secondAdmitted = Boolean(second);
    await manager.closeSession(second, 'requested');
    assert.equal(manager.availability().ok, true);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
    await manager.closeAll();
    // Only identities captured in this private fixture may be terminated.
    for (const expected of owned) {
        if (exactLive(expected)) process.kill(expected.pid, 'SIGKILL');
    }
    if (sentinel && sentinel.exitCode === null && sentinel.signalCode === null) {
        await new Promise((resolve) => sentinel.once('exit', resolve));
    }
    assert.ok(root.startsWith(`${fs.realpathSync(os.tmpdir())}/webtty-box-cleanup-`));
    fs.rmSync(root, { recursive: true, force: false });
}
