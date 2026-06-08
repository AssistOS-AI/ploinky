import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { computeRchHttp, computeRchTool } from '../../Agent/lib/requestHash.mjs';
import {
    verifyHttpServiceAuthInfoFromHeaders,
    verifyRouterRequestFromHeaders,
} from '../../Agent/lib/invocationAuth.mjs';

// The agent verifies Router Request JWTs with its OWN per-agent secret. The test
// treats that secret as opaque random bytes (its derivation is covered by
// perAgentSecret.test.mjs); here we exercise the agent-side header helper.
const AGENT_ID = 'agent:AssistOSExplorer/dpuAgent';
const AGENT_SECRET = crypto.randomBytes(32);
const AGENT_SECRET_HEX = AGENT_SECRET.toString('hex');

const METHOD = 'POST';
const PATH = '/mcp';
const TOOL = 'secret_put';
const ARGS = { key: 'GIT_GITHUB_TOKEN', value: 'x' };
const HTTP_METHOD = 'POST';
const HTTP_EXTERNAL_PATH = '/services/browser-use/sessions/sess_1';
const HTTP_PATH = '/browser-use/sessions/sess_1';
const HTTP_QUERY = '?view=1';

function mintRouterRequest(overrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    const rch = computeRchTool({ method: METHOD, path: PATH, tool: TOOL, arguments: ARGS });
    const payload = {
        typ: 'router-request',
        iss: 'ploinky-router',
        aud: AGENT_ID,
        sub: 'user:local:admin',
        actor: { kind: 'user', id: 'user:local:admin', roles: ['user'] },
        method: METHOD,
        path: PATH,
        tool: TOOL,
        rch,
        jti: crypto.randomBytes(12).toString('base64url'),
        iat: now,
        exp: now + 30,
        ...overrides,
    };
    return signHmacJwt({ payload, secret: AGENT_SECRET });
}

function makeEnv(overrides = {}) {
    return { PLOINKY_AGENT_ID: AGENT_ID, PLOINKY_AGENT_SECRET: AGENT_SECRET_HEX, ...overrides };
}

function sha256BodyHash(body) {
    return crypto.createHash('sha256').update(Buffer.from(body)).digest('base64url');
}

function mintHttpServiceRequest({ method = HTTP_METHOD, path = HTTP_PATH, query = HTTP_QUERY, bodyHash, overrides = {} } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const rch = computeRchHttp({ method, path, query, bodyHash });
    const payload = {
        typ: 'router-request',
        iss: 'ploinky-router',
        aud: AGENT_ID,
        sub: 'user:local:admin',
        actor: { kind: 'user', id: 'user:local:admin', roles: ['user'] },
        method,
        path,
        tool: '__http_service__',
        rch,
        jti: crypto.randomBytes(12).toString('base64url'),
        iat: now,
        exp: now + 30,
        ...overrides,
    };
    return signHmacJwt({ payload, secret: AGENT_SECRET });
}

function makeHttpServiceAuthInfoHeader(token, bodyHash) {
    return JSON.stringify({
        user: { id: 'local:admin', username: 'admin', roles: ['user'] },
        invocationToken: token,
        invocationBody: {
            method: HTTP_METHOD,
            externalPath: HTTP_EXTERNAL_PATH,
            path: HTTP_PATH,
            search: HTTP_QUERY,
            routeKey: 'browserUseAgent',
            bodyHash,
        },
    });
}

function verify(token, opts = {}) {
    const method = opts.method ?? METHOD;
    const reqPath = opts.path ?? PATH;
    const tool = opts.tool ?? TOOL;
    const args = opts.args ?? ARGS;
    const rch = computeRchTool({ method, path: reqPath, tool, arguments: args });
    return verifyRouterRequestFromHeaders(
        { authorization: `Bearer ${token}` },
        {
            env: opts.env ?? makeEnv(),
            replayCache: opts.replayCache ?? createMemoryReplayCache(),
            method,
            path: reqPath,
            tool,
            rch,
        },
    );
}

test('verifyRouterRequestFromHeaders accepts a valid router-request', () => {
    const result = verify(mintRouterRequest());
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.payload.actor.kind, 'user');
    assert.equal(result.payload.tool, TOOL);
    assert.equal(result.payload.sub, 'user:local:admin');
});

test('rejects a missing bearer token', () => {
    const result = verifyRouterRequestFromHeaders({}, { env: makeEnv(), method: METHOD, path: PATH, tool: TOOL, rch: 'x' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing router-request token/);
});

test('rejects when PLOINKY_AGENT_SECRET is not configured (no master/shared fallback)', () => {
    const result = verify(mintRouterRequest(), { env: { PLOINKY_AGENT_ID: AGENT_ID } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /PLOINKY_AGENT_SECRET not configured/);
});

test('rejects when PLOINKY_AGENT_ID is not configured', () => {
    const result = verify(mintRouterRequest(), { env: { PLOINKY_AGENT_SECRET: AGENT_SECRET_HEX } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /PLOINKY_AGENT_ID not configured/);
});

test('rejects a tampered body via request-content-hash', () => {
    const result = verify(mintRouterRequest(), { args: { key: 'DIFFERENT', value: 'y' } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /request hash mismatch/);
});

test('rejects the wrong tool', () => {
    const result = verify(mintRouterRequest(), { tool: 'secret_get' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /tool mismatch/);
});

test('rejects a token addressed to a different agent', () => {
    const result = verify(mintRouterRequest({ aud: 'agent:AssistOSExplorer/otherAgent' }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /audience mismatch/);
});

test('rejects a replayed jti', () => {
    const token = mintRouterRequest({ jti: 'replay-1' });
    const replayCache = createMemoryReplayCache();
    assert.equal(verify(token, { replayCache }).ok, true);
    const second = verify(token, { replayCache });
    assert.equal(second.ok, false);
    assert.match(second.reason, /already been consumed/);
});

test('verifyHttpServiceAuthInfoFromHeaders accepts a body-bound HTTP service token', () => {
    const body = JSON.stringify({ action: 'create', name: 'body-bound' });
    const bodyHash = sha256BodyHash(body);
    const token = mintHttpServiceRequest({ bodyHash });

    const result = verifyHttpServiceAuthInfoFromHeaders(
        { 'x-ploinky-auth-info': makeHttpServiceAuthInfoHeader(token, bodyHash) },
        {
            env: makeEnv(),
            replayCache: createMemoryReplayCache(),
            method: HTTP_METHOD,
            path: HTTP_PATH,
            query: HTTP_QUERY,
            body,
        },
    );

    assert.equal(result.ok, true, result.reason);
    assert.equal(result.payload.tool, '__http_service__');
    assert.equal(result.bodyHash, bodyHash);
    assert.equal(result.invocationBody.externalPath, HTTP_EXTERNAL_PATH);
    assert.equal(result.invocationBody.path, HTTP_PATH);
});

test('verifyHttpServiceAuthInfoFromHeaders rejects a changed HTTP body', () => {
    const body = JSON.stringify({ action: 'create', name: 'body-bound' });
    const bodyHash = sha256BodyHash(body);
    const token = mintHttpServiceRequest({ bodyHash });

    const result = verifyHttpServiceAuthInfoFromHeaders(
        { 'x-ploinky-auth-info': makeHttpServiceAuthInfoHeader(token, bodyHash) },
        {
            env: makeEnv(),
            replayCache: createMemoryReplayCache(),
            method: HTTP_METHOD,
            path: HTTP_PATH,
            query: HTTP_QUERY,
            body: JSON.stringify({ action: 'tampered' }),
        },
    );

    assert.equal(result.ok, false);
    assert.match(result.reason, /body hash mismatch/);
});

test('verifyHttpServiceAuthInfoFromHeaders rejects the external path for rewritten services', () => {
    const body = JSON.stringify({ action: 'create', name: 'body-bound' });
    const bodyHash = sha256BodyHash(body);
    const token = mintHttpServiceRequest({ bodyHash });

    const result = verifyHttpServiceAuthInfoFromHeaders(
        { 'x-ploinky-auth-info': makeHttpServiceAuthInfoHeader(token, bodyHash) },
        {
            env: makeEnv(),
            replayCache: createMemoryReplayCache(),
            method: HTTP_METHOD,
            path: HTTP_EXTERNAL_PATH,
            query: HTTP_QUERY,
            body,
        },
    );

    assert.equal(result.ok, false);
    assert.match(result.reason, /path mismatch/);
});

test('verifyHttpServiceAuthInfoFromHeaders rejects replay by default', () => {
    const body = JSON.stringify({ action: 'create', name: 'body-bound' });
    const bodyHash = sha256BodyHash(body);
    const token = mintHttpServiceRequest({ bodyHash, overrides: { jti: 'http-service-replay-default' } });
    const headers = { 'x-ploinky-auth-info': makeHttpServiceAuthInfoHeader(token, bodyHash) };

    const first = verifyHttpServiceAuthInfoFromHeaders(headers, {
        env: makeEnv(),
        method: HTTP_METHOD,
        path: HTTP_PATH,
        query: HTTP_QUERY,
        body,
    });
    assert.equal(first.ok, true, first.reason);

    const second = verifyHttpServiceAuthInfoFromHeaders(headers, {
        env: makeEnv(),
        method: HTTP_METHOD,
        path: HTTP_PATH,
        query: HTTP_QUERY,
        body,
    });
    assert.equal(second.ok, false);
    assert.match(second.reason, /already been consumed/);
});
