import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

function writeAgentManifest(workspace, repoName, agentName) {
    const agentDir = path.join(workspace, '.ploinky', 'repos', repoName, agentName);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify({ about: agentName }, null, 2));
}

function withBearerPrefix(value) {
    return String(value || '').replace(/^Bearer\s+/i, '');
}

test('routed agent HTTP identity headers mint target invocation from caller JWT', async (t) => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ploinky-routed-http-'));
    const previousCwd = process.cwd();
    const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
    const previousDerivedMasterKey = process.env.PLOINKY_DERIVED_MASTER_KEY;
    process.chdir(workspace);
    process.env.PLOINKY_MASTER_KEY = crypto.randomBytes(32).toString('hex');
    delete process.env.PLOINKY_DERIVED_MASTER_KEY;
    writeAgentManifest(workspace, 'callerRepo', 'caller');
    writeAgentManifest(workspace, 'targetRepo', 'target');

    t.after(() => {
        process.chdir(previousCwd);
        if (previousMasterKey === undefined) {
            delete process.env.PLOINKY_MASTER_KEY;
        } else {
            process.env.PLOINKY_MASTER_KEY = previousMasterKey;
        }
        if (previousDerivedMasterKey === undefined) {
            delete process.env.PLOINKY_DERIVED_MASTER_KEY;
        } else {
            process.env.PLOINKY_DERIVED_MASTER_KEY = previousDerivedMasterKey;
        }
        rmSync(workspace, { recursive: true, force: true });
    });

    const nonce = `${Date.now()}-${Math.random()}`;
    const { signHmacJwt, bodyHashForRequest } = await import(`${pathToFileURL(path.join(REPO_ROOT, 'Agent/lib/jwtSign.mjs')).href}?test=${nonce}`);
    const { verifyInvocationToken } = await import(`${pathToFileURL(path.join(REPO_ROOT, 'Agent/lib/jwtVerify.mjs')).href}?test=${nonce}`);
    const { deriveDerivedMasterKey } = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/services/masterKey.js')).href}?test=${nonce}`);
    const { buildRoutedAgentIdentityHeaders } = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/routerHandlers.js')).href}?test=${nonce}`);

    const now = Math.floor(Date.now() / 1000);
    const callerToken = signHmacJwt({
        secret: deriveDerivedMasterKey(),
        payload: {
            typ: 'invocation',
            iss: 'ploinky-router',
            aud: 'agent:callerRepo/caller',
            sub: 'local:admin',
            caller: 'router:first-party',
            tool: 'source-tool',
            scope: ['secret:read'],
            bh: bodyHashForRequest({ tool: 'source-tool', arguments: {} }),
            usr: { id: 'local:admin', username: 'admin', roles: ['local'] },
            jti: crypto.randomBytes(8).toString('hex'),
            iat: now,
            exp: now + 60
        }
    });

    const headers = buildRoutedAgentIdentityHeaders({
        headers: { 'x-ploinky-caller-jwt': callerToken }
    }, 'target', 'agent-card', { agent: 'target' });

    assert.match(headers.authorization, /^Bearer\s+/);
    assert.notEqual(withBearerPrefix(headers.authorization), callerToken);
    assert.ok(headers['x-ploinky-auth-info']);

    const authInfo = JSON.parse(headers['x-ploinky-auth-info']);
    assert.equal(authInfo.agent?.principalId, 'agent:callerRepo/caller');
    assert.equal(authInfo.user?.id, 'local:admin');
    assert.equal(authInfo.invocationToken, withBearerPrefix(headers.authorization));

    const verified = verifyInvocationToken(withBearerPrefix(headers.authorization), {
        secret: deriveDerivedMasterKey(),
        expectedAudience: 'agent:targetRepo/target',
        expectedTool: 'agent-card',
        bodyObject: { tool: 'agent-card', arguments: { agent: 'target' } }
    });
    assert.equal(verified.payload.caller, 'agent:callerRepo/caller');
    assert.equal(verified.payload.aud, 'agent:targetRepo/target');
});
