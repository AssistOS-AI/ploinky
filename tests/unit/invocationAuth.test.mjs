import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    createContainerAgentCredentialContext,
    __testables as credentialContextTestables,
} from '../../Agent/lib/agentCredentialContext.mjs';
import { computeAgentCredentialAdmissionDigest } from '../../Agent/lib/agentCredentialDescriptor.mjs';
import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { computeRchHttp, computeRchTool } from '../../Agent/lib/requestHash.mjs';
import {
    verifyHttpRouteAuthInfoFromHeaders,
    verifyRouterRequestFromHeaders,
} from '../../Agent/lib/invocationAuth.mjs';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-invocation-auth-'));
const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = '6'.repeat(64);
const { installGeneratedRouterRuntime } = await import(`../helpers/generatedRouterRuntime.mjs?test=${Date.now()}`);

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
const HTTP_EXTERNAL_PATH = '/base-agent-additional-server/browserUseAgent/7000/sessions/sess_1';
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

function makeCredentialContext({
    principalId = AGENT_ID,
    agentSecret = AGENT_SECRET_HEX,
} = {}) {
    const runtime = installGeneratedRouterRuntime({
        origin: 'http://127.0.0.1:8080',
        publicAuthority: '127.0.0.1:8080',
        tempDir,
        agentPrincipal: principalId,
    });
    return createContainerAgentCredentialContext({
        ...runtime.env,
        PLOINKY_RUNTIME: 'container',
        PLOINKY_AGENT_SECRET: agentSecret,
        PLOINKY_AGENT_PRIVATE_SECRET: 'b'.repeat(64),
    });
}

function makeExpiredCredentialContext() {
    const admission = {
        runtimeKind: 'bwrap',
        manifestDigest: `sha256:${'1'.repeat(64)}`,
        capabilityDigest: `sha256:${'2'.repeat(64)}`,
        networkHash: `sha256:${'3'.repeat(64)}`,
    };
    return credentialContextTestables.createBwrapContextFromRead({
        descriptor: {
            schemaVersion: 1,
            principalId: AGENT_ID,
            instanceId: 'instance-expired',
            enableGeneration: 'generation-expired',
            runtimeKey: 'runtime-expired',
            routeKey: 'dpuAgent',
            router: {
                physicalOrigin: 'http://127.0.0.1:8080',
                requestAuthority: '127.0.0.1:8080',
                host: '127.0.0.1',
                port: 8080,
            },
            admission,
            admissionDigest: computeAgentCredentialAdmissionDigest(admission),
            nonce: Buffer.alloc(32, 9).toString('base64url'),
            issuedAt: 1,
            expiresAt: 86401,
            credentials: {
                agentSecret: AGENT_SECRET_HEX,
                privateSecret: 'b'.repeat(64),
                apiKey: `${AGENT_ID}|fixture`,
                apiPublicKey: Buffer.alloc(32, 10).toString('base64url'),
            },
        },
        publicAttestation: {},
    });
}

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = originalMasterKey;
});

function sha256BodyHash(body) {
    return crypto.createHash('sha256').update(Buffer.from(body)).digest('base64url');
}

function mintHttpRouteRequest({ method = HTTP_METHOD, path = HTTP_PATH, query = HTTP_QUERY, bodyHash, overrides = {} } = {}) {
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
        tool: '__http_route__',
        rch,
        jti: crypto.randomBytes(12).toString('base64url'),
        iat: now,
        exp: now + 30,
        ...overrides,
    };
    return signHmacJwt({ payload, secret: AGENT_SECRET });
}

function makeHttpRouteAuthInfoHeader(token, bodyHash) {
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
            credentialContext: opts.credentialContext ?? makeCredentialContext(),
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
    const result = verifyRouterRequestFromHeaders({}, {
        credentialContext: makeCredentialContext(), method: METHOD, path: PATH, tool: TOOL, rch: 'x',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing router-request token/);
});

test('rejects a missing credential context without consulting process.env', () => {
    const result = verifyRouterRequestFromHeaders(
        { authorization: `Bearer ${mintRouterRequest()}` },
        { method: METHOD, path: PATH, tool: TOOL, rch: 'x' },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /trusted AgentCredentialContext is required/);
});

test('rejects a fabricated credential context', () => {
    const result = verify(mintRouterRequest(), { credentialContext: Object.freeze({ identity: { principalId: AGENT_ID } }) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /trusted AgentCredentialContext is required/);
});

test('rejects an expired trusted credential context', () => {
    const result = verify(mintRouterRequest(), { credentialContext: makeExpiredCredentialContext() });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not active/);
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

test('verifyHttpRouteAuthInfoFromHeaders accepts a body-bound HTTP route token', () => {
    const body = JSON.stringify({ action: 'create', name: 'body-bound' });
    const bodyHash = sha256BodyHash(body);
    const token = mintHttpRouteRequest({ bodyHash });

    const result = verifyHttpRouteAuthInfoFromHeaders(
        { 'x-ploinky-auth-info': makeHttpRouteAuthInfoHeader(token, bodyHash) },
        {
            credentialContext: makeCredentialContext(),
            replayCache: createMemoryReplayCache(),
            method: HTTP_METHOD,
            path: HTTP_PATH,
            query: HTTP_QUERY,
            body,
        },
    );

    assert.equal(result.ok, true, result.reason);
    assert.equal(result.payload.tool, '__http_route__');
    assert.equal(result.bodyHash, bodyHash);
    assert.equal(result.invocationBody.externalPath, HTTP_EXTERNAL_PATH);
    assert.equal(result.invocationBody.path, HTTP_PATH);
});

test('verifyHttpRouteAuthInfoFromHeaders rejects a changed HTTP body', () => {
    const body = JSON.stringify({ action: 'create', name: 'body-bound' });
    const bodyHash = sha256BodyHash(body);
    const token = mintHttpRouteRequest({ bodyHash });

    const result = verifyHttpRouteAuthInfoFromHeaders(
        { 'x-ploinky-auth-info': makeHttpRouteAuthInfoHeader(token, bodyHash) },
        {
            credentialContext: makeCredentialContext(),
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

test('verifyHttpRouteAuthInfoFromHeaders rejects the external path for rewritten services', () => {
    const body = JSON.stringify({ action: 'create', name: 'body-bound' });
    const bodyHash = sha256BodyHash(body);
    const token = mintHttpRouteRequest({ bodyHash });

    const result = verifyHttpRouteAuthInfoFromHeaders(
        { 'x-ploinky-auth-info': makeHttpRouteAuthInfoHeader(token, bodyHash) },
        {
            credentialContext: makeCredentialContext(),
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

test('verifyHttpRouteAuthInfoFromHeaders rejects replay by default', () => {
    const body = JSON.stringify({ action: 'create', name: 'body-bound' });
    const bodyHash = sha256BodyHash(body);
    const token = mintHttpRouteRequest({ bodyHash, overrides: { jti: 'http-service-replay-default' } });
    const headers = { 'x-ploinky-auth-info': makeHttpRouteAuthInfoHeader(token, bodyHash) };

    const first = verifyHttpRouteAuthInfoFromHeaders(headers, {
        credentialContext: makeCredentialContext(),
        method: HTTP_METHOD,
        path: HTTP_PATH,
        query: HTTP_QUERY,
        body,
    });
    assert.equal(first.ok, true, first.reason);

    const second = verifyHttpRouteAuthInfoFromHeaders(headers, {
        credentialContext: makeCredentialContext(),
        method: HTTP_METHOD,
        path: HTTP_PATH,
        query: HTTP_QUERY,
        body,
    });
    assert.equal(second.ok, false);
    assert.match(second.reason, /already been consumed/);
});
