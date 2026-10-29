import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const sourceUrl = new URL('../../cli/commands/workspaceUtil.js', import.meta.url).href;
const graphUrl = new URL('../../cli/utils/workspaceDependencyGraph.js', import.meta.url).href;

test('an enabled agent whose source is missing is skipped and the resolvable one stays', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skipped-enabled-'));
    try {
        const agentDir = path.join(root, '.ploinky', 'repos', 'demo', 'present');
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify({ container: 'node:20-alpine' }));
        const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
            const { resolveExtraEnabledRuntimeNodes } = await import(${JSON.stringify(sourceUrl)});
            const { resolveWorkspaceDependencyGraph } = await import(${JSON.stringify(graphUrl)});
            const registry = {
                ploinky_demo_present_x: { type: 'agent', repoName: 'demo', agentName: 'present' },
                ploinky_missing_ghost_x: { type: 'agent', repoName: 'missing', agentName: 'ghost' },
            };
            const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'demo/present' });
            const { nodes, skipped } = resolveExtraEnabledRuntimeNodes(graph, registry);
            console.log(JSON.stringify({ extra: nodes.map(node => node.agentRef), skipped: skipped.map(entry => entry.ref) }));
        `], { encoding: 'utf8', cwd: root, env: { ...process.env, PLOINKY_WORKSPACE_ROOT: root } }));
        assert.deepEqual(result.extra, []);
        assert.deepEqual(result.skipped, ['missing/ghost']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
