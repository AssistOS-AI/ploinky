import test from 'node:test';
import assert from 'node:assert/strict';

const moduleSuffix = `?t=${Date.now()}-${Math.random()}`;
const {
    HttpRouteAccessPath,
    ROUTER_OWNED_FIRST_SEGMENTS,
} = await import(`../../cli/server/policy/HttpRouteAccessPath.js${moduleSuffix}`);

test('normalizes concrete and trailing wildcard route access paths', () => {
    assert.deepEqual(HttpRouteAccessPath.normalize('/explorer/public/*'), {
        ok: true,
        path: '/explorer/public/*',
        isWildcard: true,
        prefix: '/explorer/public',
    });
    assert.deepEqual(HttpRouteAccessPath.normalize('/explorer/readme'), {
        ok: true,
        path: '/explorer/readme',
        isWildcard: false,
        prefix: '/explorer/readme',
    });
});

test('rejects unsafe route access paths', () => {
    for (const value of ['/', '/*', '/auth/login', '/admin/users', '/policy/command', '/metrics', '/health/internal', '/a/__agent/x']) {
        assert.equal(HttpRouteAccessPath.normalize(value).ok, false, value);
    }
    assert.equal(HttpRouteAccessPath.normalize('/a/*/b').code, 'INVALID_WILDCARD');
    assert.equal(HttpRouteAccessPath.normalize('/a/%2F/b').code, 'INVALID_PATH');
});

test('rejects percent-encoded __agent segments like the current internalAgentPath guard', () => {
    for (const value of ['/a/%5F%5Fagent/x', '/a/%255F%255Fagent/x', '/a/__agent', '/a/__agent/*']) {
        const result = HttpRouteAccessPath.normalize(value);
        assert.equal(result.ok, false, value);
        assert.equal(result.code, 'INTERNAL_ROUTE_NOT_ALLOWED', value);
    }
    assert.equal(HttpRouteAccessPath.isInternal('/a/%5F%5Fagent/x'), true);
});

test('rejects router-owned first segments so policy entries cannot shadow router surfaces', () => {
    for (const value of ['/webtty/*', '/webchat/session', '/dashboard/*', '/status', '/upload', '/blobs/*', '/workspace-files/*', '/agent-card', '/api/agents/x', '/mcp', '/health', '/MCPBrowserClient.js']) {
        const result = HttpRouteAccessPath.normalize(value);
        assert.equal(result.ok, false, value);
        assert.equal(result.code, 'INTERNAL_ROUTE_NOT_ALLOWED', value);
    }
});

test('ROUTER_OWNED_FIRST_SEGMENTS stays in sync with isRouterOwnedPath', () => {
    const expected = [
        'agent-card', 'mcp', 'auth', 'admin', 'webtty', 'webchat', 'dashboard',
        'status', 'upload', 'blobs', 'workspace-files', 'api', 'health',
        'metrics', 'MCPBrowserClient.js',
    ];
    assert.deepEqual([...ROUTER_OWNED_FIRST_SEGMENTS].sort(), expected.sort());
});

test('matches trailing wildcard by path boundary', () => {
    assert.equal(HttpRouteAccessPath.matches('/explorer/public', '/explorer/public/*'), true);
    assert.equal(HttpRouteAccessPath.matches('/explorer/public/file', '/explorer/public/*'), true);
    assert.equal(HttpRouteAccessPath.matches('/explorer/publicity/file', '/explorer/public/*'), false);
});

test('treats only GET and HEAD as public read methods', () => {
    assert.equal(HttpRouteAccessPath.isReadOnlyMethod('GET'), true);
    assert.equal(HttpRouteAccessPath.isReadOnlyMethod('HEAD'), true);
    assert.equal(HttpRouteAccessPath.isReadOnlyMethod('POST'), false);
});
