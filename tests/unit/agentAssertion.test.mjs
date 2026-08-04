import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { computeRchTool } from '../../Agent/lib/requestHash.mjs';
import { signAgentAssertion } from '../../Agent/lib/agentAssertion.mjs';
import {
    createContainerAgentCredentialContext,
    __testables as credentialContextTestables,
} from '../../Agent/lib/agentCredentialContext.mjs';
import { computeAgentCredentialAdmissionDigest } from '../../Agent/lib/agentCredentialDescriptor.mjs';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-assertion-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = 'c'.repeat(64);

const moduleSuffix = `?test=${Date.now()}`;
const { installGeneratedRouterRuntime } = await import(`../helpers/generatedRouterRuntime.mjs${moduleSuffix}`);
const { verifyAgentAssertion } = await import(`../../cli/server/mcp-proxy/invocationMinter.js${moduleSuffix}`);
const { deriveAgentRequestSecret } = await import(`../../cli/utils/security/masterKey.js${moduleSuffix}`);

const AGENT_A = 'agent:explorer/source-agent';
const AGENT_B = 'agent:dpu/dpu-agent';
const TARGET_ROUTE = 'dpu';            // route name the source addresses
const TOOL = 'dpu_internal_op';
const ARGS = { key: 'X', n: 2 };

function contextFor(agentId) {
    const runtime = installGeneratedRouterRuntime({
        origin: 'http://127.0.0.1:8080',
        publicAuthority: '127.0.0.1:8080',
        tempDir,
        agentPrincipal: agentId,
    });
    return createContainerAgentCredentialContext({
        ...runtime.env,
        PLOINKY_RUNTIME: 'container',
        PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(agentId),
        PLOINKY_AGENT_PRIVATE_SECRET: 'b'.repeat(64),
    });
}

function expiredContextFor(agentId) {
    const admission = {
        runtimeKind: 'bwrap',
        manifestDigest: `sha256:${'1'.repeat(64)}`,
        capabilityDigest: `sha256:${'2'.repeat(64)}`,
        networkHash: `sha256:${'3'.repeat(64)}`,
    };
    return credentialContextTestables.createBwrapContextFromRead({
        descriptor: {
            schemaVersion: 1,
            principalId: agentId,
            instanceId: 'instance-expired',
            enableGeneration: 'generation-expired',
            runtimeKey: 'runtime-expired',
            routeKey: 'source-agent',
            router: {
                physicalOrigin: 'http://127.0.0.1:8080',
                requestAuthority: '127.0.0.1:8080',
                host: '127.0.0.1',
                port: 8080,
            },
            admission,
            admissionDigest: computeAgentCredentialAdmissionDigest(admission),
            nonce: Buffer.alloc(32, 7).toString('base64url'),
            issuedAt: 1,
            expiresAt: 86401,
            credentials: {
                agentSecret: deriveAgentRequestSecret(agentId),
                privateSecret: 'b'.repeat(64),
                apiKey: `${agentId}|fixture`,
                apiPublicKey: Buffer.alloc(32, 8).toString('base64url'),
            },
        },
        publicAttestation: {},
    });
}

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// Mirror how the router verifies: recompute rch from the actual request surface.
function routerVerify(token, { method = 'POST', reqPath = '/mcp', tool = TOOL, args = ARGS, target = TARGET_ROUTE, replayCache } = {}) {
    const rch = computeRchTool({ method, path: reqPath, tool, arguments: args });
    return verifyAgentAssertion({ token, method, path: reqPath, tool, rch, targetAgentId: target, replayCache });
}

test('an assertion signed by agent A verifies as A', () => {
    const token = signAgentAssertion({ targetAgent: TARGET_ROUTE, tool: TOOL, argumentsObj: ARGS, credentialContext: contextFor(AGENT_A) });
    const result = routerVerify(token, { replayCache: createMemoryReplayCache() });
    assert.equal(result.callerPrincipal, AGENT_A);
    assert.equal(result.payload.typ, 'agent-assertion');
    assert.equal(result.payload.sub, AGENT_A);
});

test('agent A cannot forge an assertion for agent B (B\'s derived secret rejects A\'s signature)', () => {
    // Craft a token claiming iss=B but signed with A's secret.
    const now = Math.floor(Date.now() / 1000);
    const rch = computeRchTool({ method: 'POST', path: '/mcp', tool: TOOL, arguments: ARGS });
    const forged = signHmacJwt({
        payload: {
            typ: 'agent-assertion', iss: AGENT_B, sub: AGENT_B, aud: 'ploinky-router',
            method: 'POST', path: '/mcp', targetAgent: TARGET_ROUTE, tool: TOOL, rch,
            iat: now, exp: now + 60, jti: 'forge-1',
        },
        secret: deriveAgentRequestSecret(AGENT_A, { encoding: 'buffer' }),
    });
    assert.throws(() => routerVerify(forged, { replayCache: createMemoryReplayCache() }), /signature invalid/);
});

test('an invalid issuer form is rejected before any derivation', () => {
    const now = Math.floor(Date.now() / 1000);
    const rch = computeRchTool({ method: 'POST', path: '/mcp', tool: TOOL, arguments: ARGS });
    const token = signHmacJwt({
        payload: {
            typ: 'agent-assertion', iss: 'user:not-an-agent', sub: 'user:not-an-agent', aud: 'ploinky-router',
            method: 'POST', path: '/mcp', tool: TOOL, rch, iat: now, exp: now + 60, jti: 'bad-iss',
        },
        secret: deriveAgentRequestSecret(AGENT_A, { encoding: 'buffer' }),
    });
    assert.throws(() => routerVerify(token), /issuer is not a valid agent id/);
});

test('a targetAgent mismatch is rejected', () => {
    const token = signAgentAssertion({ targetAgent: TARGET_ROUTE, tool: TOOL, argumentsObj: ARGS, credentialContext: contextFor(AGENT_A) });
    assert.throws(() => routerVerify(token, { target: 'some-other-agent', replayCache: createMemoryReplayCache() }), /targetAgent mismatch/);
});

test('the signer refuses to issue a target-less assertion', () => {
    assert.throws(
        () => signAgentAssertion({ tool: TOOL, argumentsObj: ARGS, credentialContext: contextFor(AGENT_A) }),
        /targetAgent is required/,
    );
});

test('a target-less assertion is rejected at verify (DS013 target binding)', () => {
    // Hand-craft a valid-but-target-less token; it must not be accepted as valid
    // for whatever target the router resolves from the URL.
    const now = Math.floor(Date.now() / 1000);
    const rch = computeRchTool({ method: 'POST', path: '/mcp', tool: TOOL, arguments: ARGS });
    const token = signHmacJwt({
        payload: {
            typ: 'agent-assertion', iss: AGENT_A, sub: AGENT_A, aud: 'ploinky-router',
            method: 'POST', path: '/mcp', tool: TOOL, rch, iat: now, exp: now + 60, jti: 'no-target-1',
        },
        secret: deriveAgentRequestSecret(AGENT_A, { encoding: 'buffer' }),
    });
    assert.throws(() => routerVerify(token, { replayCache: createMemoryReplayCache() }), /missing targetAgent/);
});

test('mutated tool / arguments are rejected', () => {
    const token = signAgentAssertion({ targetAgent: TARGET_ROUTE, tool: TOOL, argumentsObj: ARGS, credentialContext: contextFor(AGENT_A) });
    assert.throws(() => routerVerify(token, { tool: 'other_tool', replayCache: createMemoryReplayCache() }), /tool mismatch/);
    assert.throws(() => routerVerify(token, { args: { key: 'Y', n: 2 }, replayCache: createMemoryReplayCache() }), /request hash mismatch/);
});

test('an expired assertion is rejected', () => {
    const now = Math.floor(Date.now() / 1000);
    const rch = computeRchTool({ method: 'POST', path: '/mcp', tool: TOOL, arguments: ARGS });
    const token = signHmacJwt({
        payload: {
            typ: 'agent-assertion', iss: AGENT_A, sub: AGENT_A, aud: 'ploinky-router',
            method: 'POST', path: '/mcp', targetAgent: TARGET_ROUTE, tool: TOOL, rch,
            iat: now - 200, exp: now - 140, jti: 'exp-1',
        },
        secret: deriveAgentRequestSecret(AGENT_A, { encoding: 'buffer' }),
    });
    assert.throws(() => routerVerify(token, { replayCache: createMemoryReplayCache() }), /expired/);
});

test('a replayed assertion jti is rejected', () => {
    const token = signAgentAssertion({ targetAgent: TARGET_ROUTE, tool: TOOL, argumentsObj: ARGS, credentialContext: contextFor(AGENT_A) });
    const replayCache = createMemoryReplayCache();
    assert.equal(routerVerify(token, { replayCache }).callerPrincipal, AGENT_A);
    assert.throws(() => routerVerify(token, { replayCache }), /already been consumed/);
});

test('the signer rejects missing and fabricated credential contexts', () => {
    assert.throws(
        () => signAgentAssertion({ targetAgent: TARGET_ROUTE, tool: TOOL, argumentsObj: ARGS }),
        /trusted AgentCredentialContext is required/,
    );
    assert.throws(
        () => signAgentAssertion({
            targetAgent: TARGET_ROUTE,
            tool: TOOL,
            argumentsObj: ARGS,
            credentialContext: Object.freeze({ identity: { principalId: AGENT_A } }),
        }),
        /trusted AgentCredentialContext is required/,
    );
});

test('the signer rejects an expired trusted credential context', () => {
    assert.throws(
        () => signAgentAssertion({
            targetAgent: TARGET_ROUTE,
            tool: TOOL,
            argumentsObj: ARGS,
            credentialContext: expiredContextFor(AGENT_A),
        }),
        (error) => error?.code === 'PLOINKY_AGENT_CREDENTIAL_CONTEXT_EXPIRED',
    );
});
