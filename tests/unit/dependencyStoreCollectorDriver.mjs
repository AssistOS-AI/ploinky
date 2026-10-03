// Child-process driver for the production-default collector test (not a test
// file). Usage: node dependencyStoreCollectorDriver.mjs <config.json>
// PLOINKY_WORKSPACE_ROOT selects the workspace before any Ploinky import, so the
// store, registry, edge state, lease and engine inspector are the defaults a
// lifecycle command uses. Writes a JSON transcript of every step result.

import fs from 'node:fs';
import path from 'node:path';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const root = process.env.PLOINKY_WORKSPACE_ROOT;
const results = [];

const { DEPS_DIR, PLOINKY_WORKSPACE_ROOT } = await import('../../cli/utils/config.js');
const { withWorkspaceMutationLease } = await import('../../cli/utils/runtime/maintenanceLocks.js');
const { createCacheStore } = await import('../../cli/utils/dependencies/store/objectStore.mjs');
const { buildAgentInstallPlan } = await import('../../cli/utils/dependencies/store/installContract.mjs');
const { collectDependencyObjectsAfterAdmission } = await import('../../cli/utils/dependencies/store/collector.mjs');
const { hashInstalledTree } = await import('../../cli/utils/dependencies/store/treeHash.mjs');
const { fakeInstaller, hostProvider, makeAgentLib } = await import('./dependencyStoreFixtures.mjs');

if (path.resolve(PLOINKY_WORKSPACE_ROOT) !== path.resolve(root)) throw new Error(`workspace root mismatch: ${PLOINKY_WORKSPACE_ROOT}`);

// The store exactly as the lifecycle defaults construct it (default receipt
// proofs, which inspect containers through the engine on PATH).
const store = () => createCacheStore({ depsDir: DEPS_DIR, workspaceRoot: PLOINKY_WORKSPACE_ROOT });

async function runStep(step) {
    if (step.action === 'init-edge') {
        const { initializeFreshEdgeRoutingSources } = await import('../../cli/sandbox/edgeGeneration.js');
        initializeFreshEdgeRoutingSources({ workspaceRoot: root });
        return { ok: true };
    }
    if (step.action === 'activate-edge') {
        // Prepare and commit one routing generation, as a lifecycle command
        // does once its graph is ready: the selector becomes active and no
        // preparation stays outstanding.
        const edge = await import('../../cli/sandbox/edgeGeneration.js');
        const { mergeRoutingConfig } = await import('../../cli/server/routingFile.js');
        const prepared = edge.withEdgeGenerationApplyLock((applyLockCapability) => {
            edge.inactivateEdgeRoutingGeneration('collector-driver:source-stage', { applyLockCapability });
            return edge.prepareEdgeRoutingGeneration({ reason: 'collector-driver', applyLockCapability });
        });
        await mergeRoutingConfig((current) => current, { reason: 'collector-driver-ready', preparationLease: prepared.preparationLease });
        const { selector, paths } = edge.readEdgeRoutingSelection();
        return { ok: true, value: { selector: selector.state, preparationOutstanding: fs.existsSync(paths.preparationLeaseFile) } };
    }
    if (step.action === 'build') {
        const agentLib = makeAgentLib(path.join(root, '.agentlib-fixture'));
        const plan = buildAgentInstallPlan({
            provider: hostProvider({ agentLib }),
            globalPackage: { name: 'g', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } },
            agentPackage: {
                selection: 'code', relativePath: `${step.registration}/code/package.json`, sha256: 'f'.repeat(64),
                manifest: { name: step.registration, dependencies: { dep: '1.0.0' } },
            },
            registration: step.registration,
            agentLibSelection: agentLib,
        });
        const generation = await withWorkspaceMutationLease({ operation: 'collector-driver-build' },
            (lease) => store().ensureGeneration(lease, plan, { installer: fakeInstaller(), consumer: step.consumer }));
        const { readerReceipt, ...rest } = generation;
        return { ok: true, value: { ...rest, readerReceipt: readerReceipt?.receiptId || null } };
    }
    if (step.action === 'collect') {
        const report = await withWorkspaceMutationLease({ operation: 'collector-driver-collect' },
            (lease) => collectDependencyObjectsAfterAdmission({ lease, reason: 'collector-driver' }));
        return { ok: true, value: report };
    }
    if (step.action === 'open') {
        // A fresh open and full re-hash of the retained payload, never a
        // descriptor held from before the collection.
        const file = path.join(step.nodeModulesPath, 'left-pad', 'index.js');
        const fd = fs.openSync(file, 'r');
        let bytes;
        try { bytes = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
        const payloadPath = path.dirname(step.nodeModulesPath);
        const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(payloadPath), 'manifest.json'), 'utf8'));
        const tree = hashInstalledTree(payloadPath, { approvedExternalTargets: manifest.approvedExternalTargets });
        return {
            ok: true,
            value: {
                bytes,
                treeMatches: tree.hash === manifest.tree.hash,
                validation: store().validateObject(step.objectId, { inputKey: step.inputKey }).reason,
            },
        };
    }
    throw new Error(`unknown step ${step.action}`);
}

for (const step of config.steps) {
    try {
        results.push({ step: step.label || step.action, ...(await runStep(step)) });
    } catch (error) {
        results.push({ step: step.label || step.action, ok: false, error: String(error?.stack || error) });
    }
}
fs.writeFileSync(config.out, JSON.stringify(results, null, 2));
