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

function isDirectExecution() {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
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
