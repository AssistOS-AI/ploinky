import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { computeRchTool } from '../../Agent/lib/requestHash.mjs';
import { verifyRouterRequestFromHeaders } from '../../Agent/lib/invocationAuth.mjs';
import { createContainerAgentCredentialContext } from '../../Agent/lib/agentCredentialContext.mjs';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-rrjwt-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);

const moduleSuffix = `?test=${Date.now()}`;
const { installGeneratedRouterRuntime } = await import(`../helpers/generatedRouterRuntime.mjs${moduleSuffix}`);
const { buildRouterRequest } = await import(`../../cli/server/mcp-proxy/invocationMinter.js${moduleSuffix}`);
const { deriveAgentRequestSecret } = await import(`../../cli/utils/security/masterKey.js${moduleSuffix}`);

const TARGET = 'agent:explorer/docs-agent';
const OTHER = 'agent:explorer/other-agent';
const TOOL = 'docs_search';
const ARGS = { q: 'x', tags: ['a', 'b'] };

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function contextFor(agentId, agentSecret = deriveAgentRequestSecret(agentId)) {
    const runtime = installGeneratedRouterRuntime({
        origin: 'http://127.0.0.1:8080',
        publicAuthority: '127.0.0.1:8080',
        tempDir,
        agentPrincipal: agentId,
    });
    return createContainerAgentCredentialContext({
        ...runtime.env,
        PLOINKY_RUNTIME: 'container',
        PLOINKY_AGENT_SECRET: agentSecret,
        PLOINKY_AGENT_PRIVATE_SECRET: 'b'.repeat(64),
    });
}

function mintFor({ targetAgentId = TARGET, method = 'POST', reqPath = '/mcp', tool = TOOL, args = ARGS } = {}) {
    const rch = computeRchTool({ method, path: reqPath, tool, arguments: args });
    return buildRouterRequest({
        targetAgentId,
        sub: 'user:daniel',
        actor: { kind: 'user', id: 'user:daniel', roles: ['user'] },
        method,
        path: reqPath,
        tool,
        rch,
    });
}

// Mirror how AgentServer verifies: recompute rch from the actual request surface.
function agentVerify({ token, credentialContext, method = 'POST', reqPath = '/mcp', tool = TOOL, args = ARGS, replayCache }) {
    const rch = computeRchTool({ method, path: reqPath, tool, arguments: args });
    return verifyRouterRequestFromHeaders(
        { authorization: `Bearer ${token}` },
        { credentialContext, replayCache, method, path: reqPath, tool, rch },
    );
}

test('round-trip: target agent verifies a router-request minted for it', () => {
    const { token, payload } = mintFor();
    assert.equal(payload.typ, 'router-request');
    assert.equal(payload.iss, 'ploinky-router');
    assert.equal(payload.aud, TARGET);
    const result = agentVerify({ token, credentialContext: contextFor(TARGET), replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.payload.tool, TOOL);
    assert.equal(result.payload.actor.kind, 'user');
});

test('isolation: a different agent (its own secret) cannot verify another agent\'s token', () => {
    const { token } = mintFor({ targetAgentId: TARGET });
    // OTHER agent uses its own id + secret; signature was made with TARGET's secret.
    const result = agentVerify({ token, credentialContext: contextFor(OTHER), replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, false);
    // Audience mismatch is detected before signature here (aud=TARGET, self=OTHER).
    assert.match(result.reason, /audience mismatch|signature invalid/);
});

test('wrong secret with right audience fails the signature check', () => {
    const { token } = mintFor({ targetAgentId: TARGET });
    const credentialContext = contextFor(TARGET, deriveAgentRequestSecret(OTHER));
    const result = agentVerify({ token, credentialContext, replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, false);
    assert.match(result.reason, /signature invalid/);
});

test('wrong token type is rejected even with a valid signature', () => {
    const secret = deriveAgentRequestSecret(TARGET, { encoding: 'buffer' });
    const now = Math.floor(Date.now() / 1000);
    const rch = computeRchTool({ method: 'POST', path: '/mcp', tool: TOOL, arguments: ARGS });
    const token = signHmacJwt({
        payload: { typ: 'user-session', iss: 'ploinky-router', aud: TARGET, method: 'POST', path: '/mcp', tool: TOOL, rch, jti: 'x1', iat: now, exp: now + 30 },
        secret,
    });
    const result = agentVerify({ token, credentialContext: contextFor(TARGET), replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, false);
    assert.match(result.reason, /token type is not router-request/);
});

test('wrong audience is rejected even with a valid signature for the wrong target', () => {
    const secret = deriveAgentRequestSecret(TARGET, { encoding: 'buffer' });
    const now = Math.floor(Date.now() / 1000);
    const rch = computeRchTool({ method: 'POST', path: '/mcp', tool: TOOL, arguments: ARGS });
    const token = signHmacJwt({
        payload: { typ: 'router-request', iss: 'ploinky-router', aud: 'agent:explorer/elsewhere', method: 'POST', path: '/mcp', tool: TOOL, rch, jti: 'x2', iat: now, exp: now + 30 },
        secret,
    });
    const result = agentVerify({ token, credentialContext: contextFor(TARGET), replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, false);
    assert.match(result.reason, /audience mismatch/);
});

test('mutated method / path / tool are each rejected (claim binding)', () => {
    const { token } = mintFor();
    const credentialContext = contextFor(TARGET);
    assert.match(agentVerify({ token, credentialContext, method: 'GET', replayCache: createMemoryReplayCache() }).reason, /method mismatch/);
    assert.match(agentVerify({ token, credentialContext, reqPath: '/other', replayCache: createMemoryReplayCache() }).reason, /path mismatch/);
    assert.match(agentVerify({ token, credentialContext, tool: 'docs_delete', replayCache: createMemoryReplayCache() }).reason, /tool mismatch/);
});

test('mutated arguments are rejected via the request-content-hash', () => {
    const { token } = mintFor({ args: { q: 'x', tags: ['a', 'b'] } });
    const credentialContext = contextFor(TARGET);
    // Same tool/method/path, but different arguments → rch mismatch.
    const result = agentVerify({ token, credentialContext, args: { q: 'y', tags: ['a', 'b'] }, replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, false);
    assert.match(result.reason, /request hash mismatch/);
    // Array-order change in an argument also moves the hash.
    assert.match(
        agentVerify({ token, credentialContext, args: { q: 'x', tags: ['b', 'a'] }, replayCache: createMemoryReplayCache() }).reason,
        /request hash mismatch/,
    );
});

test('expired token is rejected', () => {
    const secret = deriveAgentRequestSecret(TARGET, { encoding: 'buffer' });
    const now = Math.floor(Date.now() / 1000);
    const rch = computeRchTool({ method: 'POST', path: '/mcp', tool: TOOL, arguments: ARGS });
    const token = signHmacJwt({
        payload: { typ: 'router-request', iss: 'ploinky-router', aud: TARGET, method: 'POST', path: '/mcp', tool: TOOL, rch, jti: 'exp1', iat: now - 120, exp: now - 90 },
        secret,
    });
    const result = agentVerify({ token, credentialContext: contextFor(TARGET), replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, false);
    assert.match(result.reason, /expired/);
});

test('replayed jti within the ttl window is rejected', () => {
    const { token } = mintFor();
    const credentialContext = contextFor(TARGET);
    const replayCache = createMemoryReplayCache();
    const first = agentVerify({ token, credentialContext, replayCache });
    assert.equal(first.ok, true, first.reason);
    const second = agentVerify({ token, credentialContext, replayCache });
    assert.equal(second.ok, false);
    assert.match(second.reason, /already been consumed/);
});

test('router-request TTL is capped at 30s by the minter', () => {
    const { payload } = mintFor();
    assert.ok(payload.exp - payload.iat <= 30, `ttl ${payload.exp - payload.iat} should be <= 30`);
});

test('buildRouterRequest carries router-minted delegation grants without touching the singular delegation claim', () => {
    const rch = computeRchTool({ method: 'POST', path: '/mcp', tool: 'git_auth_store_token', arguments: { token: 'redacted-by-test' } });
    const { token, payload } = buildRouterRequest({
        targetAgentId: 'agent:AchillesIDE/gitAgent',
        sub: 'user:local:admin',
        actor: { kind: 'user', id: 'user:local:admin', roles: ['admin'] },
        method: 'POST',
        path: '/mcp',
        tool: 'git_auth_store_token',
        rch,
        delegation: { jti: 'upstream-jti', scope: ['secret:read'], sourceAgentId: 'agent:AchillesIDE/explorer' },
        delegations: {
            dpuGitSecrets: {
                token: 'delegation.jwt.value',
                expiresAt: '2026-06-10T12:00:00.000Z',
                targetAgentId: 'agent:AchillesIDE/dpuAgent',
                tools: ['dpu_secret_put', 'dpu_secret_grant'],
                scope: ['secret:write', 'secret:grant'],
            },
            '': { token: 'must-be-dropped', targetAgentId: 'agent:AchillesIDE/dpuAgent' },
            badEntry: { token: '', targetAgentId: 'agent:AchillesIDE/dpuAgent' },
        },
    });

    assert.match(token, /^\S+\.\S+\.\S+$/);
    assert.equal(payload.delegations.dpuGitSecrets.token, 'delegation.jwt.value');
    assert.deepEqual(payload.delegations.dpuGitSecrets.tools, ['dpu_secret_put', 'dpu_secret_grant']);
    assert.deepEqual(Object.keys(payload.delegations), ['dpuGitSecrets']);
    assert.deepEqual(payload.delegation, { jti: 'upstream-jti', scope: ['secret:read'], sourceAgentId: 'agent:AchillesIDE/explorer' });
});

test('buildRouterRequest omits delegations when none are valid', () => {
    const rch = computeRchTool({ method: 'POST', path: '/mcp', tool: 'git_status', arguments: {} });
    const { payload } = buildRouterRequest({
        targetAgentId: 'agent:AchillesIDE/gitAgent',
        sub: 'user:local:admin',
        actor: { kind: 'user', id: 'user:local:admin', roles: [] },
        method: 'POST',
        path: '/mcp',
        tool: 'git_status',
        rch,
        delegations: { broken: { token: '', targetAgentId: '' } },
    });
    assert.equal(payload.delegations, undefined);
});
