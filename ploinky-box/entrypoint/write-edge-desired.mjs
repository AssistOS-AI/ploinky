import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readBoxWorkspaceRoot } from '../contract/workspace-root.mjs';
import { BOX_EDGE_DESIRED_MAX_BYTES, writeWorkspaceEdgeDesired } from '../edgeDesired.mjs';

// Runs inside the Box: the host saves the edge document here while a Box runs,
// so a Box process that swaps a workspace path can redirect this write only
// where the Box can already write. The host holds the workspace lock meanwhile.
export async function writeBoxEdgeDesired({
    workspaceRoot = readBoxWorkspaceRoot(process.env),
    input = process.stdin,
} = {}) {
    const root = path.resolve(String(workspaceRoot || ''));
    if (!path.isAbsolute(String(workspaceRoot || ''))) {
        throw new Error('PLOINKY_WORKSPACE_ROOT must be an absolute path');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of input) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > BOX_EDGE_DESIRED_MAX_BYTES) throw new Error('Edge authority replacement is too large');
        chunks.push(bytes);
    }
    return writeWorkspaceEdgeDesired({ anchorPath: path.join(root, '.ploinky') }, {
        bytes: Buffer.concat(chunks),
        assertHeld() {},
    });
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
        const { digest, size } = await writeBoxEdgeDesired();
        process.stdout.write(`${JSON.stringify({ digest, size })}\n`);
    } catch (error) {
        process.stderr.write(`[ploinky-box] EDGE DESIRED WRITE FAILED: ${error?.message || String(error)}\n`);
        process.exitCode = 1;
    }
}
