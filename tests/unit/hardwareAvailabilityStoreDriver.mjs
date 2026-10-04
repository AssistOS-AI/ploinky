// Child-process driver for hardwareAvailabilityStore.test.mjs (not a test file).
// Usage: node hardwareAvailabilityStoreDriver.mjs <phase> <workspaceRoot> [json-options]
//
//   init    initializeFreshEdgeRoutingSources; options.pauseAt names an install hook.
//   commit  one policy commit under the real apply lock; options.pauseAt is beforeRename or afterRename.
//   read    print the reader's result.
//
// A pause writes <signalDir>/paused.<name> and then blocks synchronously, so the
// parent can SIGKILL the process at exactly that point. It prints one JSON line
// on completion.

import fs from 'node:fs';
import path from 'node:path';

const [phase, workspace, rawOptions] = process.argv.slice(2);
const options = rawOptions ? JSON.parse(rawOptions) : {};
const cli = (relative) => import(new URL(`../../cli/${relative}`, import.meta.url).href);

function pause(name) {
    fs.writeFileSync(path.join(options.signalDir, `paused.${name}`), String(process.pid));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

function waitForFile(file, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(file)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
}

async function run() {
    const edge = await cli('sandbox/edgeGeneration.js');
    const store = await cli('sandbox/hardwareAvailabilityStore.mjs');
    const paths = edge.resolveEdgeGenerationPaths({ workspaceRoot: workspace });
    if (options.barrier) waitForFile(options.barrier);
    if (phase === 'init') {
        const faults = options.pauseAt ? { [options.pauseAt]: () => pause(options.pauseAt) } : {};
        const result = edge.initializeFreshEdgeRoutingSources({
            workspaceRoot: workspace,
            testHooks: { hardwareAvailability: { faults } },
        });
        return { initialized: result.initialized, availability: result.hardwareAvailability ?? null };
    }
    if (phase === 'commit') {
        const faults = options.pauseAt === 'afterRename' ? { afterRename: () => pause('afterRename') } : {};
        const hooks = options.pauseAt === 'beforeRename' ? { beforeRename: () => pause('beforeRename') } : {};
        return edge.withEdgeGenerationApplyLock((capability) => {
            const assertApplyLock = () => edge.assertEdgeGenerationApplyLockCapability({
                workspaceRoot: workspace,
                applyLockCapability: capability,
            });
            const current = store.readHardwareAvailabilityPolicy({ paths });
            return store.commitHardwareAvailabilityPolicy({
                paths,
                assertApplyLock,
                expectedRevision: current.revision,
                entries: options.entries,
                slots: options.slots,
                faults,
                ...hooks,
            });
        }, { workspaceRoot: workspace });
    }
    if (phase === 'read') {
        const { state, revision, storeId, entries, slots, diagnostic } = store.readHardwareAvailabilityPolicy({ paths });
        return { state, revision, storeId, entries, slots, diagnostic };
    }
    throw new Error(`unknown phase ${phase}`);
}

try {
    const result = await run();
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error?.code ?? null, message: String(error?.message || error) })}\n`);
    process.exitCode = 1;
}
