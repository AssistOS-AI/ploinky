import test from 'node:test';
import assert from 'node:assert/strict';
// The real dispatch guard (side-effect-free module), not a mirror.
import { hasInternalAgentSegment } from '../../cli/server/internalAgentPath.js';

const routes = {
    explorer: { hostPort: 7101 },
    'my-agent': { hostPort: 7102 },
    agent123: { hostPort: 7103 }
};

function decodePathSegment(value) {
    try {
        return decodeURIComponent(value || '');
    } catch (_) {
        return '';
    }
}

function extractAgentName(pathname, routeTable = routes) {
    const parts = String(pathname || '').split('/').filter(Boolean);
    if (!parts.length) return null;
    const agentName = decodePathSegment(parts[0]).trim();
    if (!agentName || !routeTable?.[agentName]) return null;
    return agentName;
}

function buildAgentProxyPath(agentName, rawUrl) {
    const parsedUrl = new URL(rawUrl || '/', 'http://localhost');
    const pathname = parsedUrl.pathname || '/';
    const prefix = `/${encodeURIComponent(agentName)}`;
    let upstreamPath = pathname;
    if (pathname === `/${agentName}` || pathname === prefix) {
        upstreamPath = '/';
    } else if (pathname.startsWith(`/${agentName}/`)) {
        upstreamPath = pathname.slice(agentName.length + 1) || '/';
    } else if (pathname.startsWith(`${prefix}/`)) {
        upstreamPath = pathname.slice(prefix.length) || '/';
    }
    return `${upstreamPath || '/'}${parsedUrl.search || ''}`;
}

test('extractAgentName matches any routed agent-prefixed path', () => {
    assert.equal(extractAgentName('/explorer/mcp'), 'explorer');
    assert.equal(extractAgentName('/explorer/index.html'), 'explorer');
    assert.equal(extractAgentName('/explorer/assets/style.css'), 'explorer');
    assert.equal(extractAgentName('/explorer/v1/chat/completions'), 'explorer');
    assert.equal(extractAgentName('/my-agent/app/main.js'), 'my-agent');
    assert.equal(extractAgentName('/agent123/task'), 'agent123');
});

test('extractAgentName ignores paths that are not routed agents', () => {
    assert.equal(extractAgentName('/'), null);
    assert.equal(extractAgentName(''), null);
    assert.equal(extractAgentName('/unknown/index.html'), null);
    assert.equal(extractAgentName('/mcp'), null);
    assert.equal(extractAgentName('/webtty'), null);
    assert.equal(extractAgentName('/agent-card'), null);
});

test('buildAgentProxyPath strips only the route mount prefix', () => {
    assert.equal(buildAgentProxyPath('explorer', '/explorer'), '/');
    assert.equal(buildAgentProxyPath('explorer', '/explorer/'), '/');
    assert.equal(buildAgentProxyPath('explorer', '/explorer/index.html'), '/index.html');
    assert.equal(buildAgentProxyPath('explorer', '/explorer/assets/style.css'), '/assets/style.css');
    assert.equal(buildAgentProxyPath('explorer', '/explorer/v1/chat/completions'), '/v1/chat/completions');
    assert.equal(buildAgentProxyPath('explorer', '/explorer/search?q=abc'), '/search?q=abc');
});

test('any __agent segment is refused at the dispatch (raw path, before http-service/passthrough)', () => {
    // The router refuses `__agent` paths at the TOP of the dispatch, on the RAW
    // request path — before http-service routing or passthrough — so an
    // http-service prefix can no longer expose an agent control-plane route.
    assert.equal(hasInternalAgentSegment('/explorer/__agent/public-route-share/authorize'), true);
    assert.equal(hasInternalAgentSegment('/agentA/__agent/anything'), true);
    assert.equal(hasInternalAgentSegment('/__agent/root'), true);
    // Nested __agent segments are flagged too; query strings never participate.
    assert.equal(hasInternalAgentSegment('/svc/sub/__agent/x?y=1'), true);
    // The stripped upstream form is caught as well (defence regardless of layer).
    assert.equal(hasInternalAgentSegment(buildAgentProxyPath('explorer', '/explorer/__agent/x')), true);
    // Ordinary paths — including `__agent`-like prefixes — are not flagged.
    assert.equal(hasInternalAgentSegment('/explorer/index.html'), false);
    assert.equal(hasInternalAgentSegment('/explorer/__agentlike/x'), false);
    assert.equal(hasInternalAgentSegment('/explorer/v1/chat/completions'), false);
});
