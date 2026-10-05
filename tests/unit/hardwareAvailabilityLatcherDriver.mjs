// Child-process driver for hardwareAvailabilityLatcher.test.mjs (not a test file).
// Usage: node hardwareAvailabilityLatcherDriver.mjs <phase> <json-argument>
// It runs the REAL latcher against the workspace in PLOINKY_WORKSPACE_ROOT with the REAL workspace lease,
// network lock and apply lock (so the lock files live in that workspace, never in the repository), and
// prints one JSON line. The lock calls are recorded as they are made.
//
//   contend  hold one real lock (lease | network | apply | none), run one attempt, release it, run another
//   pause    one attempt that blocks at beforeRename or afterRename so the parent can SIGKILL it there
//   recover  start the latcher with a short retry and wait until its slots are resolved (stale locks included)
//
// Argument fields: { hold, pauseAt, signalDir, timeoutMs }

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const root = process.env.PLOINKY_WORKSPACE_ROOT;
const [phase, rawArgument] = process.argv.slice(2);
const argument = rawArgument ? JSON.parse(rawArgument) : {};
const cli = (relative) => import(new URL(`../../cli/${relative}`, import.meta.url).href);

function pause(name) {
    fs.writeFileSync(path.join(argument.signalDir, `paused.${name}`), String(process.pid));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

async function run() {
    const edge = await cli('sandbox/edgeGeneration.js');
    const network = await cli('sandbox/networkLifecycle.js');
    const maintenance = await cli('utils/runtime/maintenanceLocks.js');
    const store = await cli('sandbox/hardwareAvailabilityStore.mjs');
    const { createHardwareAvailabilityLatcher } = await cli('server/hardwareAvailabilityLatcher.mjs');
    const paths = edge.resolveEdgeGenerationPaths({ workspaceRoot: root });

    const logs = [];
    const calls = [];
    const log = (type, data) => logs.push({ type, ...data });
    const renames = [];
    const locks = {
        createLease: (options) => { calls.push({ lock: 'lease', operation: options?.operation }); return maintenance.createWorkspaceMutationLease(options); },
        releaseLease: (lease) => { calls.push({ lock: 'lease-release' }); return maintenance.releaseWorkspaceMutationLease(lease); },
        runWithLease: maintenance.runWithWorkspaceMutationLease,
        networkLock: (callback, options) => { calls.push({ lock: 'network', waitMs: options?.waitMs }); return network.withNetworkLifecycleLock(callback, options); },
        applyLock: (callback, options) => { calls.push({ lock: 'apply' }); return edge.withEdgeGenerationApplyLock(callback, options); },
    };
    const hooks = {
        beforeRename: () => { renames.push('before'); if (argument.pauseAt === 'beforeRename') pause('beforeRename'); },
        faults: { afterRename: () => { if (argument.pauseAt === 'afterRename') pause('afterRename'); } },
    };
    const policyBytes = () => fs.readFileSync(paths.availabilityPolicyFile, 'utf8');
    const snapshot = () => {
        const { revision, entries, slots } = store.readHardwareAvailabilityPolicy({ paths });
        return { revision, entries: Object.keys(entries).sort(), slots: Object.keys(slots).sort() };
    };

    if (phase === 'contend') {
        const latcher = createHardwareAvailabilityLatcher({ workspaceRoot: root, log, locks, hooks });
        const timed = () => {
            const started = performance.now();
            const cpuStart = process.cpuUsage();
            const outcome = latcher.attempt();
            const cpu = process.cpuUsage(cpuStart);
            return { outcome, durationMs: performance.now() - started, cpuMs: (cpu.user + cpu.system) / 1000 };
        };
        const before = policyBytes();
        let held = null;
        let blocked;
        if (argument.hold === 'lease') {
            held = maintenance.createWorkspaceMutationLease({ operation: 'fixture-holder' });
            blocked = timed();
            maintenance.releaseWorkspaceMutationLease(held);
        } else if (argument.hold === 'network') {
            held = network.acquireNetworkLifecycleLock();
            blocked = timed();
            held.release();
        } else if (argument.hold === 'apply') {
            blocked = edge.withEdgeGenerationApplyLock(() => timed(), { workspaceRoot: root });
        } else {
            blocked = null;
        }
        const blockedState = blocked ? { ...blocked, unchanged: policyBytes() === before, renames: renames.length, snapshot: snapshot() } : null;
        const blockedCalls = calls.splice(0);
        const second = timed();
        return { blocked: blockedState, blockedCalls, second: { ...second, snapshot: snapshot(), renames: renames.length }, secondCalls: calls.splice(0), logs };
    }

    if (phase === 'pause') {
        const latcher = createHardwareAvailabilityLatcher({ workspaceRoot: root, log, locks, hooks });
        return { outcome: latcher.attempt() };
    }

    if (phase === 'recover') {
        const latcher = createHardwareAvailabilityLatcher({ workspaceRoot: root, log, locks, retryMs: 150, pollMs: 60_000 });
        const started = Date.now();
        latcher.start();
        const deadline = started + (argument.timeoutMs || 30_000);
        while (Date.now() < deadline && Object.keys(store.readHardwareAvailabilityPolicy({ paths }).slots).length > 0) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        latcher.stop();
        return { elapsedMs: Date.now() - started, snapshot: snapshot(), logs, calls: calls.length };
    }
    throw new Error(`unknown phase '${phase}'`);
}

run().then((value) => process.stdout.write(`${JSON.stringify(value)}\n`), (error) => {
    process.stdout.write(`${JSON.stringify({ driverError: String(error?.stack || error) })}\n`);
    process.exitCode = 1;
});
