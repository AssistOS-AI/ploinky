import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('MCP clients and proxy calls select route keys through the internal relay API', () => {
    const clientSource = fs.readFileSync(new URL('../../cli/server/AgentClient.js', import.meta.url), 'utf8');
    const proxySource = fs.readFileSync(new URL('../../cli/server/mcp-proxy/index.js', import.meta.url), 'utf8');
    assert.match(clientSource, /function createAgentRelayClient\(routeKey/);
    assert.match(clientSource, /relayHttpCall\(\{[\s\S]*?routeKey/);
    assert.match(proxySource, /createAgentRelayClient\(agentName/);
    assert.match(proxySource, /relayHttpCall\(\{[\s\S]*?routeKey: agentName/);
    assert.doesNotMatch(proxySource, /http\.request\s*\(/);
    assert.doesNotMatch(proxySource, /hostname\s*:/);
});
