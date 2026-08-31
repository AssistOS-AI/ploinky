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
    for (const pathname of ['/webtty', '/webtty/', '/webtty/assets/webtty-bootstrap.js', '/webtty/assets/xterm.js', '/webtty/sessions/id/stream']) {
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
        body: { launch: 'a'.repeat(32), cols: 80, rows: 24 },
    });
    let allocations = 0;
    const res = new MockResponse();
    await handleWebtty(input.req, res, new URL(input.req.url, 'https://app.example.test'), {
        manager: manager({
            create: async () => {
                if (routePlan.lease.commit() !== true) {
                    const error = new Error('generation changed');
                    error.code = 'WEBTTY_GENERATION_CHANGED';
                    throw error;
                }
                allocations += 1;
            },
        }),
        routePlan,
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
        const input = request({ routePlan, body: { launch: 'a'.repeat(32), cols: 80, rows: 24 } });
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
        });
        assert.equal(res.statusCode, expectedStatus, code);
    }
});

test('target discovery accepts only the canonical directory and returns the manager safe projection', async () => {
    const routePlan = plan();
    const input = request({
        routePlan,
        url: '/webtty/target-discoveries',
        body: { dir: 'Projects/demo' },
    });
    let observed = null;
    const discovery = {
        id: 'd'.repeat(32),
        directory: 'Projects/demo',
        expiresAt: 1234,
        agentTargetsAvailable: true,
        targets: [{
            launch: 'l'.repeat(32),
            kind: 'box',
            label: 'Ploinky Box',
            detail: 'Workspace runtime',
            access: 'rw',
            cwdDisplay: '/workspace/Projects/demo',
        }],
    };
    const res = new MockResponse();
    await handleWebtty(input.req, res, new URL(input.req.url, 'https://app.example.test'), {
        manager: manager({
            async discoverTargets(value) { observed = value; return discovery; },
        }),
        routePlan,
    });

    assert.equal(res.statusCode, 201);
    assert.equal(observed.req, input.req);
    assert.equal(observed.routePlan, routePlan);
    assert.equal(observed.directory, 'Projects/demo');
    assert.deepEqual(JSON.parse(res.body), { ok: true, discovery });

    const invalid = request({
        routePlan,
        url: '/webtty/target-discoveries',
        body: { dir: 'Projects/demo', containerId: 'attacker-controlled' },
    });
    const invalidRes = new MockResponse();
    await handleWebtty(invalid.req, invalidRes, new URL(invalid.req.url, 'https://app.example.test'), {
        manager: manager({
            async discoverTargets() { throw new Error('must not be called'); },
        }),
        routePlan,
    });
    assert.equal(invalidRes.statusCode, 400);
    assert.equal(JSON.parse(invalidRes.body).error, 'invalid_discovery_request');
});

test('the session API hard-cuts direct cwd and every raw runtime selector', async () => {
    const forbiddenBodies = [
        { cwd: 'Projects', cols: 80, rows: 24 },
        { launch: 'a'.repeat(32), cols: 80, rows: 24, containerId: 'b'.repeat(64) },
        { launch: 'a'.repeat(32), cols: 80, rows: 24, argv: ['/bin/sh'] },
        { launch: 'a'.repeat(32), cols: 80, rows: 24, user: '0' },
        { launch: 'a'.repeat(32), cols: 80, rows: 24, env: { PATH: '/tmp' } },
        { launch: 'a'.repeat(32), cols: 80, rows: 24, runtime: 'podman' },
    ];
    for (const body of forbiddenBodies) {
        const routePlan = plan();
        const input = request({ routePlan, body });
        let allocations = 0;
        const res = new MockResponse();
        await handleWebtty(input.req, res, new URL(input.req.url, 'https://app.example.test'), {
            manager: manager({ async create() { allocations += 1; } }),
            routePlan,
        });
        assert.equal(res.statusCode, 400, JSON.stringify(body));
        assert.equal(allocations, 0, JSON.stringify(body));
    }
});

test('launch replay, stale target, and provider isolation errors use non-oracular public responses', async () => {
    for (const [code, status, publicError] of [
        ['WEBTTY_LAUNCH_NOT_FOUND', 404, 'terminal_launch_unavailable'],
        ['WEBTTY_TARGET_STALE', 409, 'terminal_target_stale'],
        ['WEBTTY_TARGET_PROVIDER_UNAVAILABLE', 503, 'webtty_unavailable'],
    ]) {
        const routePlan = plan();
        const input = request({ routePlan, body: { launch: 'a'.repeat(32), cols: 80, rows: 24 } });
        const res = new MockResponse();
        await handleWebtty(input.req, res, new URL(input.req.url, 'https://app.example.test'), {
            manager: manager({
                async create() {
                    const error = new Error('private detail must not cross the boundary');
                    error.code = code;
                    throw error;
                },
            }),
            routePlan,
        });
        assert.equal(res.statusCode, status, code);
        assert.deepEqual(JSON.parse(res.body), { ok: false, error: publicError }, code);
    }
});

test('only exact client operation errors cross the handler boundary', async () => {
    for (const [code, status, publicError, retryable = false] of [
        ['WEBTTY_AUTH_SESSION_REQUIRED', 401, 'authentication_required'],
        ['WEBTTY_LAUNCH_NOT_FOUND', 404, 'terminal_launch_unavailable'],
        ['WEBTTY_SESSION_NOT_FOUND', 404, 'not_found'],
        ['WEBTTY_TARGET_DIRECTORY_STALE', 409, 'terminal_target_stale'],
        ['WEBTTY_TARGET_GENERATION_STALE', 409, 'terminal_target_stale'],
        ['WEBTTY_TARGET_IDENTITY_STALE', 409, 'terminal_target_stale'],
        ['WEBTTY_LAUNCH_QUOTA', 429, 'webtty_launch_quota', true],
        ['WEBTTY_GLOBAL_QUOTA', 429, 'webtty_global_quota', true],
        ['WEBTTY_USER_QUOTA', 429, 'webtty_user_quota', true],
        ['WEBTTY_SESSION_QUOTA', 429, 'webtty_session_quota', true],
        ['WEBTTY_CREATION_RATE', 429, 'webtty_creation_rate', true],
        ['WEBTTY_INPUT_RATE', 429, 'webtty_input_rate', true],
    ]) {
        const routePlan = plan();
        const input = request({ routePlan, body: { launch: 'a'.repeat(32), cols: 80, rows: 24 } });
        const res = new MockResponse();
        await handleWebtty(input.req, res, new URL(input.req.url, 'https://app.example.test'), {
            manager: manager({
                async create() {
                    const error = new Error('private detail must not cross the boundary');
                    error.code = code;
                    throw error;
                },
            }),
            routePlan,
        });
        assert.equal(res.statusCode, status, code);
        assert.deepEqual(JSON.parse(res.body), { ok: false, error: publicError }, code);
        assert.equal(res.headers['Retry-After'], retryable ? '5' : undefined, code);
    }
});

test('internal invalid, quota-looking, and rate-looking failures collapse to a non-oracular 503', async () => {
    for (const code of [
        'WEBTTY_CWD_INVALID',
        'WEBTTY_LAUNCH_RANDOMNESS_INVALID',
        'WEBTTY_AUTH_SUBSCRIPTION_INVALID',
        'WEBTTY_AGENT_WORKER_PROTOCOL_INVALID',
        'WEBTTY_AGENT_ENVIRONMENT_INVALID',
        'WEBTTY_TARGET_INSPECT_INVALID',
        'WEBTTY_PROVIDER_QUOTA_INVALID',
        'WEBTTY_PROVIDER_RATE_INVALID',
    ]) {
        const routePlan = plan();
        const input = request({ routePlan, body: { launch: 'a'.repeat(32), cols: 80, rows: 24 } });
        const res = new MockResponse();
        await handleWebtty(input.req, res, new URL(input.req.url, 'https://app.example.test'), {
            manager: manager({
                async create() {
                    const error = new Error(`secret:${code}`);
                    error.code = code;
                    throw error;
                },
            }),
            routePlan,
        });
        assert.equal(res.statusCode, 503, code);
        assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'terminal_runtime_failure' }, code);
        assert.equal(res.headers['Retry-After'], undefined, code);
        assert.doesNotMatch(res.body, /secret|invalid|quota|rate/i, code);
    }
});

test('availability, ownership, and close internals cannot escape the HTTP error boundary', async () => {
    for (const [method, url, overrides] of [
        ['GET', '/webtty', {
            availability() {
                const error = new Error('private availability detail');
                error.code = 'WEBTTY_PROVIDER_STATE_INVALID';
                throw error;
            },
        }],
        ['GET', '/webtty/sessions/terminal-abcdefghijklmnop/stream', {
            async validateOwnership() {
                const error = new Error('private ownership detail');
                error.code = 'WEBTTY_AUTH_SUBSCRIPTION_INVALID';
                throw error;
            },
        }],
        ['DELETE', '/webtty/sessions/terminal-abcdefghijklmnop', {
            async closeOwned() {
                const error = new Error('private cleanup detail');
                error.code = 'WEBTTY_RECOVERY_STATE_INVALID';
                throw error;
            },
        }],
    ]) {
        const routePlan = plan();
        const input = request({ routePlan, method, url });
        const res = new MockResponse();
        await handleWebtty(input.req, res, new URL(url, 'https://app.example.test'), {
            manager: manager(overrides),
            routePlan,
        });
        assert.equal(res.statusCode, 503, `${method} ${url}`);
        assert.deepEqual(
            JSON.parse(res.body),
            { ok: false, error: 'terminal_runtime_failure' },
            `${method} ${url}`,
        );
        assert.doesNotMatch(res.body, /private|invalid/i, `${method} ${url}`);
    }
});

test('a stream rejected after ownership validation is ended instead of leaked', async () => {
    const routePlan = plan();
    const input = request({
        routePlan,
        method: 'GET',
        url: '/webtty/sessions/terminal-abcdefghijklmnop/stream',
    });
    const res = new MockResponse();
    await handleWebtty(
        input.req,
        res,
        new URL(input.req.url, 'https://app.example.test'),
        {
            routePlan,
            manager: manager({
                async validateOwnership() { return { id: 'terminal-abcdefghijklmnop' }; },
                attachStream() { return false; },
            }),
        },
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.writableEnded, true);
});

test('discovery cancellation is ownership checked after mutation proof and route commit', async () => {
    const id = 'd'.repeat(32);
    let cancellations = 0;
    const routePlan = plan();
    const input = request({ routePlan, method: 'DELETE', url: `/webtty/target-discoveries/${id}` });
    const res = new MockResponse();
    await handleWebtty(input.req, res, new URL(input.req.url, 'https://app.example.test'), {
        manager: manager({
            async cancelTargetDiscovery(value) {
                cancellations += 1;
                assert.equal(value.id, id);
                return true;
            },
        }),
        routePlan,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(cancellations, 1);

    const denied = request({
        routePlan,
        method: 'DELETE',
        url: `/webtty/target-discoveries/${id}`,
        csrf: false,
    });
    const deniedRes = new MockResponse();
    await handleWebtty(denied.req, deniedRes, new URL(denied.req.url, 'https://app.example.test'), {
        manager: manager({ async cancelTargetDiscovery() { cancellations += 1; return true; } }),
        routePlan,
    });
    assert.equal(deniedRes.statusCode, 403);
    assert.equal(cancellations, 1);
});

test('a late generation change denies creation after parsing and before allocation', async () => {
    let allocations = 0;
    const routePlan = plan({ commit: () => false });
    const input = request({ routePlan, body: { launch: 'a'.repeat(32), cols: 80, rows: 24 } });
    const res = new MockResponse();
    await handleWebtty(input.req, res, new URL(input.req.url, 'https://app.example.test'), {
        manager: manager({
            create: async () => {
                if (routePlan.lease.commit() !== true) {
                    const error = new Error('generation changed');
                    error.code = 'WEBTTY_GENERATION_CHANGED';
                    throw error;
                }
                allocations += 1;
            },
        }),
        routePlan,
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
    for (const pathname of ['/webtty', '/webtty/', '/webtty/assets/webtty-bootstrap.js', '/webtty/assets/xterm.js']) {
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
    for (const inheritedName of ['__proto__', 'constructor']) {
        const inheritedRes = new MockResponse();
        await handleWebtty({
            method: 'GET', headers: {}, user: { id: 'local:admin', roles: ['admin'] },
        }, inheritedRes, new URL(`/webtty/assets/${inheritedName}`, 'http://localhost'), {
            manager: service,
            routePlan,
        });
        assert.equal(inheritedRes.statusCode, 404, inheritedName);
        assert.equal(JSON.parse(inheritedRes.body).error, 'not_found', inheritedName);
    }

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
    const input = request({ routePlan, body: { launch: 'a'.repeat(32), cols: 80, rows: 24 } });
    input.req.headers['content-length'] = String(9 * 1024);
    let allocations = 0;
    const res = new MockResponse();
    await handleWebtty(input.req, res, new URL(input.req.url, 'https://app.example.test'), {
        manager: manager({ create: async () => { allocations += 1; } }),
        routePlan,
    });
    assert.equal(res.statusCode, 413);
    assert.equal(input.wasConsumed(), false);
    assert.equal(allocations, 0);
});

test('worker IPC backpressure is exposed as a retryable 429', async () => {
    for (const code of ['WEBTTY_IPC_BACKPRESSURE', 'WEBTTY_AGENT_IPC_BACKPRESSURE']) {
        const routePlan = plan();
        const input = request({
            routePlan,
            url: '/webtty/sessions/terminal-abcdefghijklmnop/input',
            body: { data: 'x' },
        });
        const res = new MockResponse();
        await handleWebtty(input.req, res, new URL(input.req.url, 'https://app.example.test'), {
            manager: manager({
                async validateOwnership() { return { id: 'terminal-abcdefghijklmnop' }; },
                async input() {
                    const error = new Error('worker IPC high-water limit exceeded');
                    error.code = code;
                    throw error;
                },
            }),
            routePlan,
        });
        assert.equal(res.statusCode, 429, code);
        assert.equal(res.headers['Retry-After'], '5', code);
        assert.equal(JSON.parse(res.body).error, code.toLowerCase(), code);
    }
});
