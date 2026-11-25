import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readBoxWorkspaceRoot } from '../contract/workspace-root.mjs';

export async function initializeBoxEdgeRouting({
    workspaceRoot = readBoxWorkspaceRoot(process.env),
} = {}) {
    const resolvedRoot = path.resolve(String(workspaceRoot || ''));
    if (!path.isAbsolute(String(workspaceRoot || ''))) {
        throw new Error('PLOINKY_WORKSPACE_ROOT must be an absolute path');
    }
    // Loading edge generation resolves CLI configuration, which derives a root
    // from the working directory when none is set. The host-selected root is
    // therefore read and validated before that module is loaded.
    const { initializeFreshEdgeRoutingSources } = await import('../../cli/sandbox/edgeGeneration.js');
    return initializeFreshEdgeRoutingSources({ workspaceRoot: resolvedRoot });
}

// Node gives import.meta.url the real path, while argv[1] keeps a symlinked path
// as typed, so a run through a symlinked checkout also compares the real path.
function isDirectExecution() {
    if (!process.argv[1]) return false;
    const invokedPath = path.resolve(process.argv[1]);
    if (import.meta.url === pathToFileURL(invokedPath).href) return true;
    try { return import.meta.url === pathToFileURL(fs.realpathSync(invokedPath)).href; } catch { return false; }
}

if (isDirectExecution()) {
    try {
        const result = await initializeBoxEdgeRouting();
        process.stdout.write(
            `[ploinky-box] Edge routing baseline ${result.initialized ? 'initialized' : 'already complete'}.\n`,
        );
    } catch (error) {
        process.stderr.write(
            `[ploinky-box] EDGE ROUTING BASELINE FAILED: ${error?.message || String(error)}\n`,
        );
        process.exitCode = 1;
    }
}
