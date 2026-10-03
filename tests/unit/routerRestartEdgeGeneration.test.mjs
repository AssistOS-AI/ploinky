import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    applyEdgeRoutingGeneration,
    initializeFreshEdgeRoutingSources,
    loadActiveEdgeRoutingGeneration,
    readEdgeRoutingSelection,
} from '../../cli/sandbox/edgeGeneration.js';
import {
    readRouterRestartHandoff,
    routerRestartHandoffFile,
} from '../../ploinky-box/cloudflared/routerRestartHandoff.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WATCHDOG = path.join(REPO_ROOT, 'cli/server/Watchdog.js');
const STEP_TIMEOUT_MS = 45_000;

// The managed Router binds the fixed Box ports 8080/8081. On a shared host
// those ports may belong to a live deployment or another suite, so the real
// Router children run with a preload that moves only those two TCP listens to
// ephemeral loopback ports. The preload can also make exactly one Router exit
// before any Router code runs (a replacement that dies before readiness):
// whichever Router first removes the crash marker claims it. Router,
// Watchdog, and publication code are otherwise unmodified.
const CRASH_MARKER_ENV = 'PLOINKY_TEST_ROUTER_CRASH_MARKER';
const LISTEN_SHIM = `import fs from 'node:fs';
import net from 'node:net';
const crashMarker = process.env.${CRASH_MARKER_ENV};
if (crashMarker && /RoutingServer\\.js$/.test(process.argv[1] || '')) {
    let claimed = false;
    try { fs.unlinkSync(crashMarker); claimed = true; } catch (_) {}
    if (claimed) process.exit(1);
}
const FIXED_BOX_PORTS = new Set([8080, 8081]);
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function listenOnEphemeralLoopback(...args) {
    if (typeof args[0] === 'number' && FIXED_BOX_PORTS.has(args[0])) {
        return listen.call(this, { port: 0, host: '127.0.0.1' }, args.find((value) => typeof value === 'function'));
    }
    if (args[0] && typeof args[0] === 'object' && FIXED_BOX_PORTS.has(Number(args[0].port))) {
        const [options, ...rest] = args;
        return listen.call(this, { ...options, port: 0, host: '127.0.0.1' }, ...rest);
    }
    return listen.apply(this, args);
};
`;

// Outside a Box the Router discovers managed networks and the Watchdog
// snapshots containers through podman. The fixture owns no containers, so an
// empty inventory keeps both away from the host's real container runtime, and
// the child PATH holds only system directories so no real runtime is reachable.
const EMPTY_CONTAINER_RUNTIME = '#!/bin/sh\necho "[]"\n';
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

function shortTemporaryRoot() {
    // macOS limits Unix socket paths to 104 bytes.
    const candidate = os.tmpdir();
    return path.join(candidate, 'pkrr-XXXXXX', 'h.sock').length < 100 ? candidate : '/tmp';
}

function createFixture(t) {
    const base = fs.mkdtempSync(path.join(shortTemporaryRoot(), 'pkrr-'));
    const workspace = path.join(base, 'ws');
    const bin = path.join(base, 'bin');
    const shim = path.join(base, 'listen-shim.mjs');
    fs.mkdirSync(workspace);
    fs.mkdirSync(bin);
    fs.writeFileSync(shim, LISTEN_SHIM);
    for (const runtime of ['podman', 'docker']) {
        fs.writeFileSync(path.join(bin, runtime), EMPTY_CONTAINER_RUNTIME, { mode: 0o755 });
    }
    const children = new Set();
    t.after(async () => {
        // Each Watchdog leads its own process group. Killing the group also
        // removes a Router that a failed run would otherwise orphan.
        for (const child of children) {
            const exited = child.exitCode !== null || child.signalCode !== null
                ? Promise.resolve()
                : new Promise((resolve) => child.once('exit', resolve));
            try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
            await exited;
            const deadline = Date.now() + 5_000;
            for (;;) {
                try { process.kill(-child.pid, 0); } catch (_) { break; }
                if (Date.now() >= deadline) break;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        }
        fs.rmSync(base, { recursive: true, force: true });
    });

    initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    const applied = applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'router-restart-fixture' });
    assert.equal(applied.selector.state, 'active');
    assert.equal(applied.selector.publicationState, 'ready');

    const logsDir = path.join(workspace, '.ploinky', 'logs');
    const socket = path.join(base, 'h.sock');
    const crashMarker = path.join(base, 'crash-next-router');
    const env = { ...process.env };
    for (const key of [
        'NODE_TEST_CONTEXT',
        'PLOINKY_WATCHDOG_TEST_MODE',
        'PLOINKY_ROUTER_PID_FILE',
        'PLOINKY_ROUTER_INSTANCE_ID',
        'PLOINKY_ROUTER_PREDECESSOR_INSTANCE_ID',
        'HEALTH_CHECK_ENABLED',
    ]) delete env[key];
    Object.assign(env, {
        PLOINKY_WORKSPACE_ROOT: workspace,
        PLOINKY_CWD: workspace,
        PATH: [bin, ...SYSTEM_PATH].join(path.delimiter),
        PLOINKY_ROUTER_HEALTH_SOCKET: socket,
        NODE_OPTIONS: `--import=${pathToFileURL(shim).href}`,
        PORT: '8080',
        PLOINKY_WATCHDOG_HEALTH_CHECK_START_DELAY_MS: '5000',
        PLOINKY_WATCHDOG_HEALTH_CHECK_INTERVAL_MS: '1000',
        [CRASH_MARKER_ENV]: crashMarker,
    });

    function startWatchdog() {
        const output = [];
        const child = spawn(process.execPath, [WATCHDOG], {
            cwd: workspace,
            env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', (chunk) => output.push(chunk));
        child.stderr.on('data', (chunk) => output.push(chunk));
        child.output = () => Buffer.concat(output).toString('utf8').slice(-4000);
        children.add(child);
        return child;
    }

    function records(file, key) {
        let text = '';
        try { text = fs.readFileSync(path.join(logsDir, file), 'utf8'); } catch (_) { return []; }
        const parsed = [];
        for (const line of text.split('\n')) {
            if (!line.startsWith('{')) continue;
            try {
                const record = JSON.parse(line);
                if (record?.[key]) parsed.push(record);
            } catch (_) {}
        }
        return parsed;
    }

    return {
        workspace,
        socket,
        crashMarker,
        applied,
        startWatchdog,
        watchdogEvents: (event) => records('watchdog.log', 'event').filter((entry) => entry.event === event),
        routerEvents: (type) => records('router.log', 'type').filter((entry) => entry.type === type),
        selector: () => readEdgeRoutingSelection({ workspaceRoot: workspace }).selector,
        handoff: () => readRouterRestartHandoff(routerRestartHandoffFile(workspace)),
    };
}

async function waitFor(predicate, describe, child, pollMs = 100) {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    for (;;) {
        const value = predicate();
        if (value) return value;
        if (Date.now() >= deadline) {
            assert.fail(`timed out waiting for ${describe()}${child ? `\nWatchdog output:\n${child.output()}` : ''}`);
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
}

async function stopWatchdog(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
}

test('a Watchdog health-check restart of a real Router restores the exact previously active generation', {
    timeout: 10 * STEP_TIMEOUT_MS,
}, async (t) => {
    const fixture = createFixture(t);
    const generation = fixture.applied.selector.generation;
    const originalActivation = fixture.applied.selector.activationId;
    const served = (count) => fixture.routerEvents('cloudflare-local-only')
        .filter((entry) => entry.configurationGeneration === generation).length >= count;
    const exits = () => fixture.watchdogEvents('process_exited');

    const watchdog = fixture.startWatchdog();
    await waitFor(() => served(1), () => 'the first Router to serve the selected generation', watchdog);
    assert.equal(fixture.watchdogEvents('server_spawned').length, 1, 'the first Router must serve before any restart');
    assert.equal(fixture.selector().activationId, originalActivation);

    // The first replacement dies before its listeners are ready, so it never
    // starts a publication runtime. The restore must survive it and complete
    // in the next replacement. The running Router already passed the preload.
    fs.writeFileSync(fixture.crashMarker, '');
    // Make every later health check fail exactly as an unresponsive Router
    // does: the supervisor-only health socket stops answering.
    fs.rmSync(fixture.socket);
    await waitFor(() => exits().length >= 2, () => 'the unhealthy Router and its first replacement to exit', watchdog);
    assert.equal(exits()[0].exitCode, 0, 'the Router must have stopped through its graceful shutdown path');
    assert.equal(exits()[1].exitCode, 1, 'the first replacement must exit before readiness');
    assert.equal(fs.existsSync(fixture.crashMarker), false);
    assert.equal(fixture.watchdogEvents('health_check_threshold_exceeded').length, 1);
    assert.equal(fixture.watchdogEvents('health_check_restart').length, 1);

    const restored = await waitFor(() => {
        const selector = fixture.selector();
        return selector.state === 'active' ? selector : null;
    }, () => `a replacement Router to restore the generation (selector: ${JSON.stringify(fixture.selector())})`, watchdog);
    assert.equal(restored.generation, generation);
    assert.equal(restored.publicationState, 'ready');
    assert.notEqual(restored.activationId, originalActivation);
    assert.equal(loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }).selector.generation, generation);

    const spawns = fixture.watchdogEvents('server_spawned');
    assert.equal(spawns.length, 3);
    assert.equal(new Set(spawns.map((entry) => entry.pid)).size, 3);
    assert.match(spawns[0].routerSupervisorId, /^[0-9a-f-]{36}$/);
    assert.ok(spawns.every((entry) => entry.routerSupervisorId === spawns[0].routerSupervisorId));
    await waitFor(() => served(2), () => 'the restoring Router to serve the restored generation', watchdog);
    assert.equal(fixture.routerEvents('cloudflare_publication_runtime_start').length, 2,
        'only the first Router and the restoring Router started a publication runtime');
    assert.equal(fixture.routerEvents('cloudflare-router-restart-restore-pending')[0]?.generation, generation);
    const [restoreEvent] = fixture.routerEvents('cloudflare-router-restart-restored');
    assert.equal(restoreEvent.generation, generation);
    assert.equal(restoreEvent.activationId, restored.activationId);
    assert.equal(fixture.handoff(), null);

    // Control: a Box shutdown stops the Router without a replacement. The
    // generation stays withdrawn and only a later Router of the same Watchdog
    // could ever consume the recorded handoff.
    await stopWatchdog(watchdog);
    assert.equal(fixture.watchdogEvents('server_spawned').length, 3);
    const shutdown = fixture.selector();
    assert.equal(shutdown.state, 'inactive');
    assert.equal(shutdown.reason, 'cloudflare-controller-stop');
    assert.equal(shutdown.previousGeneration, generation);
    assert.equal(fixture.handoff().routerSupervisorId, spawns[0].routerSupervisorId);

    const fresh = fixture.startWatchdog();
    await waitFor(
        () => fixture.routerEvents('cloudflare-router-restart-restore-skipped')
            .some((entry) => entry.reason === 'other-supervision-lifetime'),
        () => 'the first Router of a new supervision lifetime to discard the handoff',
        fresh,
    );
    const freshSpawn = fixture.watchdogEvents('server_spawned')[3];
    assert.notEqual(freshSpawn.routerSupervisorId, spawns[0].routerSupervisorId);
    assert.deepEqual(fixture.selector(), shutdown);
    assert.equal(fixture.handoff(), null);
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        (error) => error.code === 'EDGE_GENERATION_INACTIVE',
    );
    await stopWatchdog(fresh);
    assert.deepEqual(fixture.selector(), shutdown);
    assert.equal(fixture.routerEvents('cloudflare-router-restart-restored').length, 1);
});
