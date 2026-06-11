import test from 'node:test';
import assert from 'node:assert/strict';

const moduleSuffix = `?t=${Date.now()}-${Math.random()}`;
const { AgentAssertionService } = await import(`../../cli/server/security/tokens/AgentAssertionService.js${moduleSuffix}`);

test('AgentAssertionService rejects assertions bound to a different request', async () => {
    const service = new AgentAssertionService({
        jwsCodec: {
            verifyJws: async () => ({
                payload: {
                    iss: 'agent-a',
                    aud: 'router',
                    method: 'POST',
                    path: '/agent-a/tool',
                    tool: 'write',
                    rch: 'mcp',
                },
            }),
        },
        resolveAgentSecret: async () => 'agent-secret',
    });

    await assert.rejects(
        () => service.verify({
            token: 'aa.jwt',
            targetAgentId: 'agent-a',
            method: 'GET',
            path: '/agent-a/tool',
            tool: 'write',
            rch: 'mcp',
        }),
        /AGENT_ASSERTION_BINDING_MISMATCH/,
    );
});
