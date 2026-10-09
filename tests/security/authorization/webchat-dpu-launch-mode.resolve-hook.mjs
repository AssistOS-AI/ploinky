// Test-only resolver: maps the bare `achillesAgentLib` import of the actual DPU module to the checkout named by
// PLOINKY_AGENTLIB_DIR, because the DPU checkout is read-only here and has no node_modules of its own.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'achillesAgentLib' && process.env.PLOINKY_AGENTLIB_DIR) {
        return { url: pathToFileURL(path.join(process.env.PLOINKY_AGENTLIB_DIR, 'index.mjs')).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
