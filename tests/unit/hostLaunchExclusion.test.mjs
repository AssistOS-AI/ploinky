import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launch-exclusion-')));
const workspace = path.join(scratch, 'workspace');
fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
// The lease code resolves its workspace when it is first imported.
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const { buildWorkspaceIdentity } = await import('../../ploinky-box/identity.mjs');
const { createMutationLockManager } = await import('../../ploinky-box/locks.mjs');
const { withHostLaunchExclusion, acquireHostLaunchExclusion, runHostInteractiveSession } = await import('../../cli/sandbox/hostLaunchExclusion.js');
const { createWorkspaceMutationLease, releaseWorkspaceMutationLease } = await import('../../cli/utils/runtime/maintenanceLocks.js');

const lockPath = path.join(workspace, '.ploinky-box', 'locks', 'workspace.lock');
const lockOwnerPid = () => JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).pid;
const notInBox = () => false;

// Another process holds D4 for `holdMs`, as a Box transaction would.
function holdInChild(holdMs, events) {
    const url = pathToFileURL(path.join(projectRoot, 'ploinky-box/locks.mjs')).href;
    const instance = buildWorkspaceIdentity(workspace).instance;
    const script = `
        import fs from 'node:fs';
        const { createMutationLockManager } = await import(${JSON.stringify(url)});
        const lock = await createMutationLockManager().acquire(${JSON.stringify(instance)}, { workspaceRoot: ${JSON.stringify(workspace)} });
        fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({ event: 'acquired', t: Date.now() }) + '\\n');
        await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
        const releasedAt = Date.now();
        lock.release();
        fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({ event: 'released', t: releasedAt }) + '\\n');
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
    return { exited };
}

async function waitForEvent(events, name) {
    for (let attempt = 0; attempt < 500; attempt += 1) {
        if (fs.existsSync(events) && fs.readFileSync(events, 'utf8').includes(`"${name}"`)) return;
        await delay(10);
    }
    throw new Error(`no ${name} event`);
}

const readEvents = (events) => fs.readFileSync(events, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

test('a host launch waits for D4 held by another holder and proceeds after its release', async () => {
    const events = path.join(scratch, 'held.log');
    const holder = holdInChild(600, events);
    await waitForEvent(events, 'acquired');
    let launchedAt = 0;
    const result = withHostLaunchExclusion(() => {
        launchedAt = Date.now();
        assert.equal(lockOwnerPid(), process.pid, 'the launch runs while this process holds D4');
        return 'launched';
    }, { workspaceRoot: workspace, label: 'test launch', insideBox: notInBox });
    assert.equal(result, 'launched');
    assert.equal((await holder.exited).code, 0);
    const released = readEvents(events).find((event) => event.event === 'released');
    assert.ok(launchedAt >= released.t, `launched at ${launchedAt}, before the holder released at ${released.t}`);
    assert.equal(fs.existsSync(lockPath), false, 'the launch released D4');
});

test('a host launch that cannot obtain D4 in time fails busy and launches nothing', async () => {
    const events = path.join(scratch, 'busy.log');
    const holder = holdInChild(1500, events);
    await waitForEvent(events, 'acquired');
    let launched = false;
    assert.throws(() => withHostLaunchExclusion(() => { launched = true; }, {
        workspaceRoot: workspace,
        insideBox: notInBox,
        lockManager: createMutationLockManager({ timeoutMs: 200, retryMs: 10 }),
    }), (error) => error.lockBusy === true && /ploinky unlock/.test(error.message));
    assert.equal(launched, false);
    assert.equal((await holder.exited).code, 0);
});

test('lock order: the start lease, then D4; taking the lease while D4 is held for a launch is refused', () => {
    const lease = createWorkspaceMutationLease({ operation: 'lock-order-test' });
    try {
        withHostLaunchExclusion(() => assert.equal(lockOwnerPid(), process.pid),
            { workspaceRoot: workspace, insideBox: notInBox });
    } finally {
        assert.ok(releaseWorkspaceMutationLease(lease));
    }
    const leasePath = path.join(workspace, '.ploinky', 'running', 'workspace-start.json');
    assert.throws(() => withHostLaunchExclusion(() => createWorkspaceMutationLease({ operation: 'inverted' }),
        { workspaceRoot: workspace, insideBox: notInBox }), { code: 'PLOINKY_BOX_LOCK_ORDER' });
    assert.equal(fs.existsSync(leasePath), false, 'no lease was created under D4');
    assert.equal(fs.existsSync(lockPath), false, 'D4 was released after the refusal');
});

test('nested launches in one process reuse the held D4', () => {
    const outer = acquireHostLaunchExclusion({ workspaceRoot: workspace, insideBox: notInBox });
    try {
        const inner = withHostLaunchExclusion(() => lockOwnerPid(), { workspaceRoot: workspace, insideBox: notInBox });
        assert.equal(inner, process.pid);
        assert.equal(lockOwnerPid(), process.pid, 'the outer launch still holds D4');
    } finally {
        outer.release();
    }
    assert.equal(fs.existsSync(lockPath), false);
});

test('an in-Box launch creates no skeleton and takes no lock', () => {
    const inner = path.join(scratch, 'in-box');
    fs.mkdirSync(inner);
    assert.equal(withHostLaunchExclusion(() => 'ok', { workspaceRoot: inner, insideBox: () => true }), 'ok');
    assert.equal(fs.existsSync(path.join(inner, '.ploinky-box')), false);
});

test('a host launch whose skeleton cannot be created fails before launching', () => {
    const broken = path.join(scratch, 'broken');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, '.ploinky-box'), 'not a directory');
    let launched = false;
    assert.throws(() => withHostLaunchExclusion(() => { launched = true; }, { workspaceRoot: broken, insideBox: notInBox }),
        (error) => error.code === 'PLOINKY_BOX_HOST_STATE_INVALID' && /Host-runtime launch refused/.test(error.message));
    assert.equal(launched, false);
});

// The sandbox spawns are synchronous and need a real sandbox, so their wiring is
// checked at the source: the spawn and its pid record happen inside the D4 hold.
test('bwrap and seatbelt spawn and record their process inside the D4 hold; Podman creates and starts inside it', () => {
    for (const [file, launchFunction, spawnCall] of [
        ['cli/sandbox/bwrap/bwrapServiceManager.js', 'function startBwrapProcess(', 'child = spawn(BWRAP_PATH'],
        ['cli/sandbox/seatbelt/seatbeltServiceManager.js', 'function startSeatbeltProcess(', "child = spawn('sandbox-exec'"],
    ]) {
        const source = fs.readFileSync(path.join(projectRoot, file), 'utf8');
        const start = source.indexOf(launchFunction);
        const skeleton = source.indexOf('ensureHostLaunchSkeleton(PLOINKY_WORKSPACE_ROOT);', start);
        const acquired = source.indexOf('launchExclusion = acquireHostLaunchExclusion(', start);
        const spawned = source.indexOf(spawnCall, start);
        const recorded = source.indexOf('saveBwrapPid(containerName, child.pid, runtimeIdentity);', spawned);
        const released = source.indexOf('launchExclusion?.release();', recorded);
        assert.ok(start > 0 && start < skeleton && skeleton < acquired && acquired < spawned
            && spawned < recorded && recorded < released, file);
        assert.equal(source.slice(start, skeleton).includes('\nfunction '), false, `${file}: the skeleton is created by the launch itself`);
    }
    const podman = fs.readFileSync(path.join(projectRoot, 'cli/sandbox/docker/agentServiceManager.js'), 'utf8');
    assert.match(podman, /withHostLaunchExclusion\(\(\) => networkLifecycle\.runManagedContainerTransaction\(/);
    assert.match(podman, /withNetworkLifecycleLock\(\(\) => withHostLaunchExclusion\(\(\) => \{\n\s+const createdId = createContainer\(unmanagedNetworkLifecyclePlan\);/);
    // Interactive bwrap and seatbelt sessions start through the session helper only.
    const bwrap = fs.readFileSync(path.join(projectRoot, 'cli/sandbox/bwrap/bwrapServiceManager.js'), 'utf8');
    const seatbelt = fs.readFileSync(path.join(projectRoot, 'cli/sandbox/seatbelt/seatbeltServiceManager.js'), 'utf8');
    assert.equal(/spawnSync\((BWRAP_PATH|scriptPath)/.test(bwrap), false);
    assert.equal(bwrap.match(/runHostInteractiveSession\(/g)?.length, 2);
    assert.equal(seatbelt.includes("spawnSync('sandbox-exec'"), false);
    assert.match(seatbelt, /await runHostInteractiveSession\('sandbox-exec'/);
    const interactive = fs.readFileSync(path.join(projectRoot, 'cli/sandbox/docker/interactive.js'), 'utf8');
    assert.match(interactive, /function withGuardMountpointCleanup\(operation\) \{\n\s+return withNetworkLifecycleLock\(\(\) => withHostLaunchExclusion\(/);
});

test('a nested launch for another workspace is refused while this process holds D4', () => {
    const other = path.join(scratch, 'other-workspace');
    fs.mkdirSync(other, { recursive: true });
    let nested = false;
    assert.throws(() => withHostLaunchExclusion(() => withHostLaunchExclusion(() => { nested = true; },
        { workspaceRoot: other, insideBox: notInBox }), { workspaceRoot: workspace, insideBox: notInBox }),
    { code: 'PLOINKY_BOX_LOCK_ORDER' });
    assert.equal(nested, false);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(path.join(other, '.ploinky-box', 'locks', 'workspace.lock')), false);
});

test('an interactive session waits for D4 held by another holder and releases it before the session ends', async () => {
    const events = path.join(scratch, 'interactive.log');
    const holder = holdInChild(600, events);
    await waitForEvent(events, 'acquired');
    let spawnedAt = 0;
    let heldDuringSettle = false;
    const session = runHostInteractiveSession(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 1500)'], { stdio: 'ignore' }, {
        workspaceRoot: workspace,
        insideBox: notInBox,
        label: 'test session',
        spawnImpl: (...args) => {
            spawnedAt = Date.now();
            heldDuringSettle = fs.existsSync(lockPath) && lockOwnerPid() === process.pid;
            return spawn(...args);
        },
    });
    // After the settle the session is still running, and D4 is free again.
    await delay(900);
    assert.equal(fs.existsSync(lockPath), false, 'D4 is released while the session still runs');
    const result = await session;
    assert.equal(result.status, 7, 'the session exit code is returned');
    assert.equal(heldDuringSettle, true, 'the session started under this process\'s D4');
    assert.equal((await holder.exited).code, 0);
    const released = readEvents(events).find((event) => event.event === 'released');
    assert.ok(spawnedAt >= released.t, `spawned at ${spawnedAt}, before the holder released at ${released.t}`);
});

test('an interactive session defers this process\'s signal listeners until it ends, like spawnSync', async () => {
    const seen = [];
    const listener = () => seen.push('SIGINT');
    process.on('SIGINT', listener);
    try {
        const session = runHostInteractiveSession(process.execPath, ['-e', 'setTimeout(() => {}, 700)'], { stdio: 'ignore' },
            { workspaceRoot: workspace, insideBox: notInBox, settleMs: 50 });
        await delay(200);
        process.kill(process.pid, 'SIGINT');
        await delay(200);
        assert.deepEqual(seen, [], 'the listener does not run during the session');
        assert.equal((await session).status, 0);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(seen, ['SIGINT'], 'it receives the signal once the session has ended');
    } finally {
        process.removeListener('SIGINT', listener);
    }
});
