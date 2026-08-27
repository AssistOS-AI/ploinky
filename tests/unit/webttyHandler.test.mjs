import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PLOINKY_MASTER_KEY ||= 'b'.repeat(64);

const { mintBrowserCsrfToken } = await import('../../cli/server/browserMutationSecurity.js');
const { wantsJsonResponse } = await import('../../cli/server/authHandlers/shared.js');
const { resolveAuthContextForRoutePlan } = await import('../../cli/server/authHandlers/authContext.js');
const { handleWebtty } = await import('../../cli/server/handlers/webtty.js');

class MockResponse {
    constructor() {
        this.statusCode = 0;
        this.headers = {};
        this.body = '';
        this.writableEnded = false;
        this.destroyed = false;
        this.writableLength = 0;
    }

    writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = { ...headers };
    }

    write(value) {
        this.body += Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
        return true;
    }

    end(value = '') {
        if (value) this.write(value);
        this.writableEnded = true;
    }
}

function plan({ commit = () => true } = {}) {
    const snapshot = { generation: 'generation-a' };
    return {
        host: 'app.example.test',
        forwarding: { protocol: 'https', authority: 'app.example.test' },
        hostSelection: {
            host: 'app.example.test',
            record: { routeKey: 'explorer' },
        },
        lease: {
            id: 'generation-a',
            activationId: 'activation-a',
            snapshot,
            commit,
            isCurrent: () => true,
        },
        snapshot,
    };
}

function request({ method = 'POST', url = '/webtty/sessions', body, routePlan, csrf = true } = {}) {
    let consumed = false;
    const req = {
        method,
        url,
        headers: {
            host: 'app.example.test',
            origin: 'https://app.example.test',
            'content-type': 'application/json',
        },
        socket: { encrypted: false },
        user: { id: 'local:admin', username: 'admin', roles: ['user', 'admin'] },
        sessionId: 'jwt-current',
        session: { _jwtPayload: { sid: 'sess-stable' } },
        authMode: 'local',
        authChannel: 'cli',
        edgeAuthContext: {
            routeKey: 'explorer',
            boundHostRouteKey: 'explorer',
            serviceRouteKey: 'webtty',
        },
        destroy() {},
        async *[Symbol.asyncIterator]() {
            consumed = true;
            if (body !== undefined) yield Buffer.from(JSON.stringify(body));
        },
    };
    if (csrf) {
        req.headers['x-ploinky-browser-csrf-token'] = mintBrowserCsrfToken({
            req,
            routePlan,
            authContext: req.edgeAuthContext,
            sessionId: req.sessionId,
        });
    }
    return { req, wasConsumed: () => consumed };
}

function manager(overrides = {}) {
    return {
        availability: () => ({ ok: true }),
        async create() { return { id: 'terminal-abcdefghijklmnop', cwd: '.', cols: 80, rows: 24 }; },
        ...overrides,
    };
}

test('the entire unauthenticated WebTTY surface is response-oriented instead of redirect-oriented', async () => {
    for (const pathname of ['/webtty', '/webtty/', '/webtty/assets/xterm.js', '/webtty/sessions/id/stream']) {
        assert.equal(wantsJsonResponse({ headers: { accept: 'text/html' } }, pathname), true, pathname);
        const req = { method: 'GET', headers: {}, user: null };
        const res = new MockResponse();
        await handleWebtty(req, res, new URL(pathname, 'http://localhost'), {
            manager: manager(),
            routePlan: plan(),
        });
        assert.equal(res.statusCode, 401, pathname);
        assert.equal(JSON.parse(res.body).error, 'authentication_required', pathname);
    }
});

test('selected WebTTY surface binds authentication to its host owner and generation', () => {
    const routePlan = plan();
    routePlan.kind = 'router-surface';
    routePlan.surface = 'webtty';
    routePlan.snapshot = {
        generation: 'generation-a',
        routing: {
            routes: {
                explorer: { container: 'explorer-container', repo: 'basic', agent: 'explorer' },
            },
        },
        agents: {
            'explorer-container': {
                type: 'agent',
                repoName: 'basic',
                agentName: 'explorer',
                auth: { mode: 'sso' },
            },
        },
    };
    routePlan.lease.snapshot = routePlan.snapshot;
    const context = resolveAuthContextForRoutePlan(
        new URL('/webtty', 'https://app.example.test'),
        routePlan,
    );
    assert.equal(context.mode, 'sso');
    assert.equal(context.routeKey, 'explorer');
    assert.equal(context.boundHostRouteKey, 'explorer');
    assert.equal(context.boundGeneration, 'generation-a');
    assert.equal(context.serviceRouteKey, 'webtty');
});

test('local CLI administrator mutations require direct browser proof before body consumption', async () => {
    const routePlan = plan();
    const input = request({
        routePlan,
        csrf: false,
        body: { dir: '', cols: 80, rows: 24 },
    });
    let allocations = 0;
    const res = new MockResponse();
    await handleWebtty(input.req, res, new URL(input.req.url, 'https://app.example.test'), {
        manager: manager({ create: async () => { allocations += 1; } }),
        routePlan,
        directoryResolver: () => ({ relativePath: '' }),
    });
    assert.equal(res.statusCode, 403);
    assert.equal(input.wasConsumed(), false);
    assert.equal(allocations, 0);
});

test('create-time authentication races map invalid auth to 401 and administrator loss to 403', async () => {
    for (const [code, expectedStatus] of [
        ['WEBTTY_AUTH_INVALID', 401],
        ['WEBTTY_ADMIN_REQUIRED', 403],
    ]) {
        const routePlan = plan();
        const input = request({ routePlan, body: { dir: '', cols: 80, rows: 24 } });
        const res = new MockResponse();
        await handleWebtty(input.req, res, new URL(input.req.url, 'https://app.example.test'), {
            manager: manager({
                async create() {
                    const error = new Error(code);
                    error.code = code;
                    throw error;
                },
            }),
            routePlan,
            directoryResolver: () => ({ relativePath: '' }),
        });
        assert.equal(res.statusCode, expectedStatus, code);
    }
});

test('a late generation change denies creation after parsing and before allocation', async () => {
    let allocations = 0;
    const routePlan = plan({ commit: () => false });
    const input = request({ routePlan, body: { dir: '', cols: 80, rows: 24 } });
    const res = new MockResponse();
    await handleWebtty(input.req, res, new URL(input.req.url, 'https://app.example.test'), {
        manager: manager({ create: async () => { allocations += 1; } }),
        routePlan,
        directoryResolver: () => ({ relativePath: '' }),
    });
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).error, 'edge_generation_changed');
    assert.equal(input.wasConsumed(), true);
    assert.equal(allocations, 0);
});

test('page, asset, and stream GETs never allocate and assets use a fixed allowlist', async () => {
    let allocations = 0;
    let ownershipChecks = 0;
    const routePlan = plan();
    const service = manager({
        async create() { allocations += 1; },
        async validateOwnership() { ownershipChecks += 1; return null; },
    });
    for (const pathname of ['/webtty', '/webtty/', '/webtty/assets/xterm.js']) {
        const req = {
            method: 'GET',
            headers: {},
            user: { id: 'local:admin', username: 'admin', roles: ['admin'] },
        };
        const res = new MockResponse();
        await handleWebtty(req, res, new URL(pathname, 'http://localhost'), {
            manager: service,
            routePlan,
        });
        assert.equal(res.statusCode, 200, pathname);
        assert.equal(res.headers['Cache-Control'], 'no-store', pathname);
        assert.match(res.headers['Content-Security-Policy'], /default-src 'none'/, pathname);
    }
    const unknownRes = new MockResponse();
    await handleWebtty({
        method: 'GET', headers: {}, user: { id: 'local:admin', roles: ['admin'] },
    }, unknownRes, new URL('/webtty/assets/../webtty.html', 'http://localhost'), {
        manager: service,
        routePlan,
    });
    assert.equal(unknownRes.statusCode, 404);

    const streamRes = new MockResponse();
    await handleWebtty({
        method: 'GET', headers: {}, user: { id: 'local:admin', roles: ['admin'] },
    }, streamRes, new URL('/webtty/sessions/terminal-abcdefghijklmnop/stream', 'http://localhost'), {
        manager: service,
        routePlan,
    });
    assert.equal(streamRes.statusCode, 404);
    assert.equal(ownershipChecks, 1);
    assert.equal(allocations, 0);
});

test('declared oversized JSON is rejected before body reads or allocation', async () => {
    const routePlan = plan();
    const input = request({ routePlan, body: { dir: '', cols: 80, rows: 24 } });
    input.req.headers['content-length'] = String(9 * 1024);
    let allocations = 0;
    const res = new MockResponse();
    await handleWebtty(input.req, res, new URL(input.req.url, 'https://app.example.test'), {
        manager: manager({ create: async () => { allocations += 1; } }),
        routePlan,
        directoryResolver: () => ({ relativePath: '' }),
    });
    assert.equal(res.statusCode, 413);
    assert.equal(input.wasConsumed(), false);
    assert.equal(allocations, 0);
});
