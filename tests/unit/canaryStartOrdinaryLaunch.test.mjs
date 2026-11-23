import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('ordinary launch syncs its MCP config and retains its existing network identity', async t => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-launch-')));
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    t.after(() => {
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previous;
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    const { syncAgentMcpConfig } = await import('../../cli/sandbox/docker/common.js');
    const { deriveNetworkAlias, logicalNetworkAttachments } = await import('../../cli/sandbox/networkContract.js');
    const agentPath = path.join(workspace, 'fixtures', 'alpha');
    const workDir = path.join(workspace, '.data', 'agents', 'alpha');
    fs.mkdirSync(agentPath, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    const config = '{"tools":[{"name":"primary"}]}\n';
    fs.writeFileSync(path.join(agentPath, 'mcp-config.json'), config);
    const target = path.join(workDir, 'mcp-config.json');
    fs.writeFileSync(target, '{}');
    assert.equal(syncAgentMcpConfig('primary', agentPath, 'alpha', { workDir }), true);
    assert.equal(fs.readFileSync(target, 'utf8'), config);

    const agentRef = 'Fixtures/Alpha';
    assert.equal(deriveNetworkAlias(agentRef), 'fixtures-alpha');
    assert.deepEqual(logicalNetworkAttachments({ mode: 'default' }, agentRef), [
        { name: 'default-48a1527537e6', primary: true },
    ]);
});
