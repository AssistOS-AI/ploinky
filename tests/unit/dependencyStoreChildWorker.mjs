// Child process used by dependencyStoreCrash tests (not a test file).
// Usage: node dependencyStoreChildWorker.mjs <config.json>
// The config names the workspace, a serialized plan and an optional stage at
// which the child exits abruptly (no finally/catch runs) or blocks until killed.

import fs from 'node:fs';
import path from 'node:path';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { createCacheStore } = await import('../../cli/utils/dependencies/store/objectStore.mjs');
const { currentWriterIdentity } = await import('../../cli/utils/dependencies/store/receipts.mjs');
const { fakeInstaller } = await import('./dependencyStoreFixtures.mjs');

const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
const hooks = {
    at(stage) {
        if (stage === config.crashAt) process.exit(137);
        if (stage === config.pauseAt) {
            fs.writeFileSync(config.signal, stage);
            block();
        }
    },
};

const installer = fakeInstaller({
    extra: () => {
        if (config.counter) fs.appendFileSync(config.counter, `${process.pid}\n`);
        if (config.installDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, config.installDelayMs);
    },
});
const consumer = { kind: 'test-child', process: currentWriterIdentity() };

async function run() {
    if (config.realLease) {
        const { withWorkspaceMutationLease } = await import('../../cli/utils/runtime/maintenanceLocks.js');
        const store = createCacheStore({ depsDir: config.depsDir, workspaceRoot: config.workspaceRoot, hooks, checkDiskSpace: () => ({ ok: true }) });
        return withWorkspaceMutationLease({ operation: 'deps-test', waitTimeoutMs: 30_000, retryIntervalMs: 20 },
            (lease) => store.ensureGeneration(lease, config.plan, { installer, consumer, operation: 'deps-test' }));
    }
    const lease = {};
    const store = createCacheStore({
        depsDir: config.depsDir, workspaceRoot: config.workspaceRoot, hooks,
        assertLease: (candidate) => candidate, checkDiskSpace: () => ({ ok: true }),
    });
    return store.ensureGeneration(lease, config.plan, { installer, consumer, operation: 'deps-test' });
}

const result = await run();
fs.writeFileSync(config.out, JSON.stringify({ status: result.status, objectId: result.objectId, generationId: result.generationId }));
process.stdout.write(path.basename(config.out));
