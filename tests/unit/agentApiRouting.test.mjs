import test from 'node:test';
import assert from 'node:assert/strict';

// We need to test parseAgentApiRoute which is not exported, so we'll test the behavior
// by importing the module and checking route matching logic indirectly.
// For now, we'll replicate the function logic here for unit testing.

const AGENT_API_SUBPATHS = ['mcp', 'task', 'agent-card', 'v1/chat/completions'];

const GLOBAL_ROUTE_PREFIXES = [
    '/health',
    '/MCPBrowserClient.js',
    '/auth/',
    '/api/agents/',
    '/agent-card',
    '/mcp',
    '/webtty',
    '/webchat',
    '/dashboard',
    '/webmeet',
    '/status',
    '/upload',
    '/blobs',
];

function isGlobalRoute(pathname) {
    for (const prefix of GLOBAL_ROUTE_PREFIXES) {
        if (prefix.endsWith('/')) {
            if (pathname.startsWith(prefix)) return true;
        } else {
            if (pathname === prefix || pathname.startsWith(prefix + '/')) return true;
        }
    }
    return false;
}

function decodePathSegment(value) {
    try {
        return decodeURIComponent(value || '');
    } catch (_) {
        return '';
    }
}

function parseAgentApiRoute(pathname) {
    const parts = String(pathname || '').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const agentName = decodePathSegment(parts[0]).trim();
    if (!agentName) return null;
    if (isGlobalRoute(pathname)) return null;

    const subPath = parts.slice(1).join('/');
    for (const apiSubpath of AGENT_API_SUBPATHS) {
        if (subPath === apiSubpath || subPath.startsWith(apiSubpath + '/')) {
            return { agentName, subPath };
        }
    }
    return null;
}

test('parseAgentApiRoute matches API routes', () => {
    // MCP routes
    assert.deepEqual(parseAgentApiRoute('/explorer/mcp'), { agentName: 'explorer', subPath: 'mcp' });
    assert.deepEqual(parseAgentApiRoute('/explorer/mcp/'), { agentName: 'explorer', subPath: 'mcp' });
    assert.deepEqual(parseAgentApiRoute('/explorer/mcp/session/123'), { agentName: 'explorer', subPath: 'mcp/session/123' });

    // Task routes
    assert.deepEqual(parseAgentApiRoute('/explorer/task'), { agentName: 'explorer', subPath: 'task' });
    assert.deepEqual(parseAgentApiRoute('/explorer/task/'), { agentName: 'explorer', subPath: 'task' });

    // Agent-card routes
    assert.deepEqual(parseAgentApiRoute('/explorer/agent-card'), { agentName: 'explorer', subPath: 'agent-card' });

    // OpenAI-compatible routes
    assert.deepEqual(parseAgentApiRoute('/explorer/v1/chat/completions'), { agentName: 'explorer', subPath: 'v1/chat/completions' });
});

test('parseAgentApiRoute returns null for static paths', () => {
    // Static files should NOT be matched as API routes
    assert.equal(parseAgentApiRoute('/explorer/index.html'), null);
    assert.equal(parseAgentApiRoute('/explorer/main.js'), null);
    assert.equal(parseAgentApiRoute('/explorer/assets/style.css'), null);
    assert.equal(parseAgentApiRoute('/explorer/styles/app.css'), null);
    assert.equal(parseAgentApiRoute('/explorer/favicon.ico'), null);
    assert.equal(parseAgentApiRoute('/explorer/images/logo.png'), null);
});

test('parseAgentApiRoute rejects global routes', () => {
    // These paths start with global prefixes and should not be treated as agent routes
    assert.equal(parseAgentApiRoute('/mcp'), null);
    assert.equal(parseAgentApiRoute('/mcp/session'), null);
    assert.equal(parseAgentApiRoute('/mcps/dpuAgent/mcp'), null);
    assert.equal(parseAgentApiRoute('/mcp/dpuAgent/mcp'), null);
    assert.equal(parseAgentApiRoute('/agent-card'), null);
    assert.equal(parseAgentApiRoute('/health'), null);
    assert.equal(parseAgentApiRoute('/webtty'), null);
});

test('parseAgentApiRoute handles edge cases', () => {
    assert.equal(parseAgentApiRoute('/'), null);
    assert.equal(parseAgentApiRoute(''), null);
    assert.equal(parseAgentApiRoute('/explorer'), null);
    assert.equal(parseAgentApiRoute('/explorer/'), null);
    assert.equal(parseAgentApiRoute('/explorer/unknown'), null);
    assert.equal(parseAgentApiRoute('/explorer/other/path'), null);
});

test('parseAgentApiRoute works with different agent names', () => {
    assert.deepEqual(parseAgentApiRoute('/my-agent/mcp'), { agentName: 'my-agent', subPath: 'mcp' });
    assert.deepEqual(parseAgentApiRoute('/agent123/task'), { agentName: 'agent123', subPath: 'task' });
    assert.deepEqual(parseAgentApiRoute('/test-agent/v1/chat/completions'), { agentName: 'test-agent', subPath: 'v1/chat/completions' });
});
