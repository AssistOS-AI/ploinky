import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { initializeFreshEdgeRoutingSources } from '../../cli/sandbox/edgeGeneration.js';

export function initializeBoxEdgeRouting({
    workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT || '/workspace',
} = {}) {
    const resolvedRoot = path.resolve(String(workspaceRoot || ''));
    if (!path.isAbsolute(String(workspaceRoot || ''))) {
        throw new Error('PLOINKY_WORKSPACE_ROOT must be an absolute path');
    }
    return initializeFreshEdgeRoutingSources({ workspaceRoot: resolvedRoot });
}

function isDirectExecution() {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectExecution()) {
    try {
        const result = initializeBoxEdgeRouting();
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
