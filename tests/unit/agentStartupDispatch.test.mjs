import '../helpers/isolatedWorkspaceRoot.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { dispatchAgentStartupRequest } from '../../cli/server/agentStartupDispatch.js';
import { __testables as activationClock } from '../../cli/server/edgeActivationClock.js';

const GENERATION = `sha256:${'a'.repeat(64)}`;

class MockResponse {
    constructor() {
        this.statusCode = 0;
        this.headers = {};
        this.body = '';
    }

    writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = { ...headers };
    }

    end(body = '') {
        this.body += body === undefined ? '' : String(body);
    }
}

function plan({ kind = 'agent-root-pending', commit = () => true, hostKind = 'control' } = {}) {
    return {
        ok: true,
        kind,
        routeKey: 'sample',
        route: { repo: 'fixtures', agent: 'sample', container: 'ploinky_fixtures_sample' },
        pathname: hostKind === 'control' ? '/sample/index.html' : '/index.html',
        canonicalPath: '/sample/index.html',
        upstreamPath: '/index.html',
        parsedUrl: new URL(
            hostKind === 'control' ? '/sample/index.html' : '/index.html',
            hostKind === 'control' ? 'http://127.0.0.1:8080' : 'https://sample.example.test',
        ),
        hostSelection: { kind: hostKind },
        decision: { access: 'public', routeKey: 'sample' },
        lease: { id: GENERATION, commit },
        transport: 'http',
    };
}

function navigationReq(overrides = {}) {
    return {
        method: 'GET',
        headers: {
            accept: 'text/html',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
        },
        ...overrides,
    };
}

function probeReq(overrides = {}) {
    return {
        method: 'GET',
        headers: {
            accept: 'application/json',
            'x-ploinky-agent-startup-probe': '1',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
        },
        ...overrides,
    };
}

function parseBody(res) {
    return JSON.parse(res.body || '{}');
}

test('pending lifecycle observation occurs only after access and the first lease fence', async () => {
    const order = [];
    const routePlan = plan({
        commit: () => {
            order.push(order.includes('resolve') ? 'commit-post' : 'commit-pre');
            return true;
        },
    });
    const res = new MockResponse();
    const handled = await dispatchAgentStartupRequest({
        req: navigationReq(),
        res,
        parsedUrl: routePlan.parsedUrl,
        routePlan,
        inspectPublication: () => {
            order.push('inspect-snapshot');
            return { ok: true, canPublishHttp: true };
        },
        ensureRouteAccess: async () => {
            order.push('authorize');
            return { ok: true };
        },
        resolveStartupState: async () => {
            order.push('resolve');
            return { state: 'starting', queued: false };
        },
    });
    assert.equal(handled, true);
    assert.deepEqual(order, ['inspect-snapshot', 'authorize', 'commit-pre', 'resolve', 'commit-post']);
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /data-ploinky-agent-startup-page="starting"/);
});
test('denied requests preserve the access response and perform zero lifecycle I/O', async () => {
    for (const [status, body] of [
        [401, { error: 'not_authenticated' }],
        [403, { error: 'guest_scope_denied' }],
        [403, { error: 'route_denied' }],
    ]) {
        let lifecycleReads = 0;
        let commits = 0;
        const routePlan = plan({ commit: () => { commits += 1; return true; } });
        const res = new MockResponse();
        await dispatchAgentStartupRequest({
            req: navigationReq(),
            res,
            parsedUrl: routePlan.parsedUrl,
            routePlan,
            inspectPublication: () => ({ ok: true, canPublishHttp: true }),
            ensureRouteAccess: async (_req, response) => {
                response.writeHead(status, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(body));
                return { ok: false };
            },
            resolveStartupState: async () => {
                lifecycleReads += 1;
                return { state: 'failed', code: 'startup_failed' };
            },
        });
        assert.equal(res.statusCode, status);
        assert.deepEqual(parseBody(res), body);
        assert.equal(lifecycleReads, 0);
        assert.equal(commits, 0);
    }
});

test('ineligible pending API, MCP, non-document, and targetless navigation use generic inactive output', async () => {
    const cases = [
        { req: { method: 'GET', headers: { accept: 'application/json' } } },
        { req: navigationReq(), plan: { upstreamPath: '/mcp' } },
        { req: navigationReq(), plan: { canonicalPath: '/sample/__agent/private' } },
        { req: navigationReq(), canPublishHttp: false },
    ];
    for (const entry of cases) {
        let authCalls = 0;
        let lifecycleReads = 0;
        const routePlan = { ...plan(), ...(entry.plan || {}) };
        const res = new MockResponse();
        await dispatchAgentStartupRequest({
            req: entry.req,
            res,
            parsedUrl: routePlan.parsedUrl,
            routePlan,
            inspectPublication: () => ({
                ok: true,
                canPublishHttp: entry.canPublishHttp !== false,
            }),
            ensureRouteAccess: async () => { authCalls += 1; return { ok: true }; },
            resolveStartupState: async () => { lifecycleReads += 1; return { state: 'starting' }; },
        });
        assert.equal(res.statusCode, 503);
        assert.deepEqual(parseBody(res), { error: 'TARGET_INACTIVE' });
        assert.equal(authCalls, 0);
        assert.equal(lifecycleReads, 0);
    }
});

test('an existing targetless probe is authorized and receives terminal unavailable', async () => {
    let authCalls = 0;
    let lifecycleReads = 0;
    const routePlan = plan();
    const res = new MockResponse();
    await dispatchAgentStartupRequest({
        req: probeReq(),
        res,
        parsedUrl: routePlan.parsedUrl,
        routePlan,
        inspectPublication: () => ({ ok: true, canPublishHttp: false }),
        ensureRouteAccess: async () => { authCalls += 1; return { ok: true }; },
        resolveStartupState: async () => {
            lifecycleReads += 1;
            return { state: 'unavailable', code: 'route_unavailable' };
        },
    });
    assert.equal(authCalls, 1);
    assert.equal(lifecycleReads, 1);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(parseBody(res), {
        state: 'unavailable',
        code: 'route_unavailable',
        message: 'This agent does not provide a web page.',
    });
});

test('an active probe commits its exact lease and reports ready without lifecycle observation', async () => {
    for (const hostKind of ['control', 'agent-root']) {
        let commits = 0;
        let lifecycleReads = 0;
        const routePlan = plan({
            kind: 'agent-root',
            hostKind,
            commit: () => { commits += 1; return true; },
        });
        const res = new MockResponse();
        const handled = await dispatchAgentStartupRequest({
            req: probeReq(),
            res,
            parsedUrl: routePlan.parsedUrl,
            routePlan,
            ensureRouteAccess: async () => ({ ok: true }),
            resolveStartupState: async () => { lifecycleReads += 1; return { state: 'starting' }; },
        });
        assert.equal(handled, true);
        assert.equal(commits, 1);
        assert.equal(lifecycleReads, 0);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(parseBody(res), { state: 'ready', generation: GENERATION });
    }
});

test('ordinary active requests bypass the startup dispatcher unchanged', async () => {
    let authCalls = 0;
    const routePlan = plan({ kind: 'agent-root' });
    const res = new MockResponse();
    const handled = await dispatchAgentStartupRequest({
        req: navigationReq(),
        res,
        parsedUrl: routePlan.parsedUrl,
        routePlan,
        ensureRouteAccess: async () => { authCalls += 1; return { ok: true }; },
    });
    assert.equal(handled, false);
    assert.equal(authCalls, 0);
    assert.equal(res.statusCode, 0);
});

test('pre- and post-observation lease races never emit a stale startup page', async () => {
    for (const commits of [[false], [true, false]]) {
        let commitIndex = 0;
        let lifecycleReads = 0;
        const routePlan = plan({ commit: () => commits[commitIndex++] });
        const res = new MockResponse();
        await dispatchAgentStartupRequest({
            req: probeReq(),
            res,
            parsedUrl: routePlan.parsedUrl,
            routePlan,
            inspectPublication: () => ({ ok: true, canPublishHttp: true }),
            ensureRouteAccess: async () => ({ ok: true }),
            resolveStartupState: async () => {
                lifecycleReads += 1;
                return { state: 'starting' };
            },
        });
        assert.equal(res.statusCode, 503);
        assert.deepEqual(parseBody(res), { state: 'retry', code: 'edge_generation_changed' });
        assert.equal(lifecycleReads, commits[0] ? 1 : 0);
    }
});

test('only fixed allowlisted resolver outcomes reach browser responses', async () => {
    const hostile = 'Error /Users/private secret=token pid=999 port=49152 container=image\nstack';
    const cases = [
        [{ state: 'starting', queued: true, diagnostic: hostile }, 202, 'starting'],
        [{ state: 'failed', code: 'startup_failed', diagnostic: hostile }, 503, 'failed'],
        [{ state: 'failed', code: 'startup_timed_out', diagnostic: hostile }, 503, 'failed'],
        [{ state: 'unavailable', code: 'route_unavailable', diagnostic: hostile }, 503, 'unavailable'],
        [{ state: 'generation_changed', diagnostic: hostile }, 503, 'retry'],
        [{ state: 'unverified', diagnostic: hostile }, 503, undefined],
        [{ state: 'failed', code: hostile }, 503, undefined],
    ];
    for (const [result, status, state] of cases) {
        const routePlan = plan();
        const res = new MockResponse();
        await dispatchAgentStartupRequest({
            req: probeReq(),
            res,
            parsedUrl: routePlan.parsedUrl,
            routePlan,
            inspectPublication: () => ({ ok: true, canPublishHttp: true }),
            ensureRouteAccess: async () => ({ ok: true }),
            resolveStartupState: async () => result,
        });
        assert.equal(res.statusCode, status);
        const body = parseBody(res);
        assert.equal(body.state, state);
        assert.doesNotMatch(res.body, /Users|secret|999|49152|container=image|stack/);
    }
});

const ACTIVATION_TOKEN = /^[A-Za-z0-9_-]{12}\.[1-9][0-9]{0,15}$/;
const ACTIVATION_ID = 'f3b1c2d4-activation-secret';

// A lease shaped like captureEdgeRoutingLease(): it carries an activation.
function activePlan({ commit = () => true, activationId = ACTIVATION_ID } = {}) {
    const routePlan = plan({ kind: 'agent-root', commit });
    routePlan.lease = { id: GENERATION, activationId, effective: { revision: 'revision-1' }, commit };
    return routePlan;
}

async function probeActive(routePlan, options = {}) {
    const res = new MockResponse();
    const handled = await dispatchAgentStartupRequest({
        req: probeReq(),
        res,
        parsedUrl: routePlan.parsedUrl,
        routePlan,
        ensureRouteAccess: async () => ({ ok: true }),
        resolveStartupState: async () => { throw new Error('a ready probe observes no lifecycle'); },
        ...options,
    });
    return { handled, res };
}

test('R-A7: a ready probe on a lease with an activation reports the token, age and mutation state behind a second commit', async () => {
    activationClock.reset();
    const order = [];
    const routePlan = activePlan({ commit: () => { order.push('commit'); return true; } });
    const { handled, res } = await probeActive(routePlan, {
        readMutationState: () => { order.push('read-mutation'); return 'idle'; },
    });
    assert.equal(handled, true);
    assert.deepEqual(order, ['commit', 'read-mutation', 'commit'], 'observe and read between the two commits');
    assert.equal(res.statusCode, 200);
    const body = parseBody(res);
    assert.deepEqual(Object.keys(body), ['state', 'generation', 'activation', 'activeForMs', 'mutation']);
    assert.equal(body.state, 'ready');
    assert.equal(body.generation, GENERATION);
    assert.match(body.activation, ACTIVATION_TOKEN);
    assert.ok(Number.isSafeInteger(body.activeForMs) && body.activeForMs >= 0);
    assert.equal(body.mutation, 'idle');
    assert.equal(res.body.includes(ACTIVATION_ID), false, 'the activation id is never disclosed');
    assert.equal(res.body.includes('revision-1'), false);
    assert.equal(res.headers['Cache-Control'], 'no-store');

    // The same activation keeps its token on the next probe.
    const again = await probeActive(activePlan(), { readMutationState: () => 'busy' });
    assert.equal(parseBody(again.res).activation, body.activation);
    assert.equal(parseBody(again.res).mutation, 'busy');
});

test('R-A8: a lost second commit, a failing reader, and a lease without an activation stay fail-safe', async () => {
    activationClock.reset();
    // The activation changed between the reads: retry, never a stale ready.
    const commits = [true, false];
    let commitIndex = 0;
    const lost = await probeActive(activePlan({ commit: () => commits[commitIndex++] }), {
        readMutationState: () => 'idle',
    });
    assert.equal(commitIndex, 2);
    assert.equal(lost.res.statusCode, 503);
    assert.deepEqual(parseBody(lost.res), { state: 'retry', code: 'edge_generation_changed' });

    // A lost first commit never reads the mutation state.
    let reads = 0;
    const first = await probeActive(activePlan({ commit: () => false }), {
        readMutationState: () => { reads += 1; return 'idle'; },
    });
    assert.equal(reads, 0);
    assert.deepEqual(parseBody(first.res), { state: 'retry', code: 'edge_generation_changed' });

    // Any reader failure or unknown answer is busy.
    for (const readMutationState of [
        () => { throw new Error('reader failed'); },
        () => 'IDLE',
        () => undefined,
        () => ({ state: 'idle' }),
        null,
    ]) {
        const { res } = await probeActive(activePlan(), { readMutationState });
        assert.equal(res.statusCode, 200);
        assert.equal(parseBody(res).mutation, 'busy');
    }

    // A lease without an activation keeps today's body and one commit.
    let mockCommits = 0;
    reads = 0;
    const mock = await probeActive(plan({ kind: 'agent-root', commit: () => { mockCommits += 1; return true; } }), {
        readMutationState: () => { reads += 1; return 'idle'; },
    });
    assert.equal(mockCommits, 1);
    assert.equal(reads, 0);
    assert.deepEqual(parseBody(mock.res), { state: 'ready', generation: GENERATION });
    assert.equal(mock.res.body, JSON.stringify({ state: 'ready', generation: GENERATION }));
});

test('R-A8: a navigation or a pending plan never carries activation fields', async () => {
    activationClock.reset();
    let reads = 0;
    const navigation = activePlan();
    const res = new MockResponse();
    const handled = await dispatchAgentStartupRequest({
        req: navigationReq(),
        res,
        parsedUrl: navigation.parsedUrl,
        routePlan: navigation,
        ensureRouteAccess: async () => ({ ok: true }),
        readMutationState: () => { reads += 1; return 'idle'; },
    });
    assert.equal(handled, false, 'ordinary active navigations bypass the dispatcher');
    const pending = plan();
    pending.lease = { ...activePlan().lease };
    const starting = await probeActive(pending, {
        inspectPublication: () => ({ ok: true, canPublishHttp: true }),
        resolveStartupState: async () => ({ state: 'starting' }),
        readMutationState: () => { reads += 1; return 'idle'; },
    });
    assert.equal(starting.res.statusCode, 202);
    assert.deepEqual(Object.keys(parseBody(starting.res)), ['state', 'generation', 'retryAfterMs']);
    assert.equal(reads, 0);
});

test('an omitted reader uses the production routing mutation reader for this workspace', async () => {
    activationClock.reset();
    // Write only inside the private root isolatedWorkspaceRoot.mjs created;
    // a root the runner chose may be a real workspace.
    if (!path.basename(process.env.PLOINKY_WORKSPACE_ROOT).startsWith('ploinky-test-workspace-')) {
        const { res } = await probeActive(activePlan());
        assert.ok(['idle', 'busy'].includes(parseBody(res).mutation));
        return;
    }
    const runningDir = path.join(process.env.PLOINKY_WORKSPACE_ROOT, '.ploinky', 'running');
    assert.equal(fs.existsSync(runningDir), false);
    const { res } = await probeActive(activePlan());
    assert.equal(parseBody(res).mutation, 'busy', 'no running directory is not positive evidence of idle');
    fs.mkdirSync(runningDir, { recursive: true });
    try {
        const idle = await probeActive(activePlan());
        assert.equal(parseBody(idle.res).mutation, 'idle');
        fs.writeFileSync(path.join(runningDir, 'workspace-start.json'), '{}');
        const leased = await probeActive(activePlan());
        assert.equal(parseBody(leased.res).mutation, 'busy');
    } finally {
        fs.rmSync(runningDir, { recursive: true, force: true });
    }
});

test('importing the dispatcher does not evaluate the workspace configuration', () => {
    const env = { ...process.env };
    delete env.PLOINKY_WORKSPACE_ROOT;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', [
        `await import(${JSON.stringify(new URL('../../cli/server/agentStartupDispatch.js', import.meta.url).href)});`,
        'process.stdout.write(String(Boolean(process.env.PLOINKY_WORKSPACE_ROOT)));',
    ].join('\n')], { env, encoding: 'utf8', cwd: path.dirname(process.env.PLOINKY_WORKSPACE_ROOT) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'false');
});
