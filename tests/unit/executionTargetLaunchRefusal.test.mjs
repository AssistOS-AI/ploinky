// C3 follow-up: a manifest that still declares the retired executionTarget is
// refused by ensureAgentService itself (its read-only preflight), before any
// container runtime command, registry, route or generation write.
import '../helpers/isolatedWorkspaceRoot.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureAgentService } from '../../cli/sandbox/docker/agentServiceManager.js';
import { buildRouterEndpoint } from '../../cli/sandbox/routerPort.js';
import { EXECUTION_PROVIDER_INVALID } from '../../cli/server/executionProvider/publication.mjs';

function listTree(root) {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { recursive: true, withFileTypes: true })
        .map((entry) => path.join(entry.parentPath, entry.name)).sort();
}

function withRuntimeShims(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-target-shim-'));
    const log = path.join(directory, 'invocations.log');
    fs.writeFileSync(log, '');
    for (const name of ['docker', 'podman']) {
        fs.writeFileSync(path.join(directory, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit 1\n`, { mode: 0o755 });
    }
    const previous = process.env.PATH;
    process.env.PATH = `${directory}${path.delimiter}${previous}`;
    t.after(() => {
        process.env.PATH = previous;
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
}

test('ensureAgentService refuses an executionTarget manifest before any container or registry mutation', (t) => {
    const invocations = withRuntimeShims(t);
    const workspace = process.env.PLOINKY_WORKSPACE_ROOT;
    const before = listTree(workspace);
    for (const manifest of [
        { container: 'node:20', executionTarget: {} },
        { container: 'node:20', executionTarget: null },
        { container: 'node:20', executionTarget: { kind: 'worker' }, executionProvider: { version: 1, port: 7300, terminals: { path: '/t' } } },
    ]) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-target-agent-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const agentPath = path.join(directory, 'repo', 'agent');
        fs.mkdirSync(agentPath, { recursive: true });
        fs.writeFileSync(path.join(agentPath, 'manifest.json'), JSON.stringify(manifest));
        assert.throws(
            () => ensureAgentService('agent', manifest, agentPath, { routerEndpoint: buildRouterEndpoint('default', 8080) }),
            (error) => error.code === EXECUTION_PROVIDER_INVALID && /executionTarget is no longer supported/.test(error.message),
            JSON.stringify(manifest),
        );
    }
    assert.deepEqual(invocations(), [], 'no container runtime command ran');
    const created = listTree(workspace).filter((entry) => !before.includes(entry)).map((entry) => path.relative(workspace, entry));
    assert.equal(created.some((entry) => /agents\.json|routing\.json|edge-routing|container-runtime/.test(entry)), false, created.join(','));
});
