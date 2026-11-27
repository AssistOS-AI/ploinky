import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Q30 delta review D2: the Router environment reaches the Watchdog, the
// RoutingServer and the WebChat local shell. A host-issued activation context
// must never reach it from the agent-writable .env, the secrets file or a
// leftover process variable: an operator's `ploinky start` in that shell
// would otherwise read a forged one.

const cwd = process.cwd();
const savedEnv = { ...process.env };
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-env-activation-')));
test.after(() => {
    process.chdir(cwd);
    for (const name of Object.keys(process.env)) {
        if (!Object.hasOwn(savedEnv, name)) delete process.env[name];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(workspace, { recursive: true, force: true });
});
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_MASTER_KEY = randomUUID().replaceAll('-', '').padEnd(64, 'd');
fs.writeFileSync('.env', '');

const { buildRouterEnv } = await import('../../cli/commands/workspaceUtil.js');
const { writeSecretsFile } = await import('../../cli/utils/security/encryptedSecretsFile.js');
const { ACTIVATION_CONTEXT_ENV } = await import('../../cli/sandbox/activationRecords.mjs');

test('the Router environment never carries an activation context from .env, secrets or the process', () => {
    fs.writeFileSync('.env', `${ACTIVATION_CONTEXT_ENV}=forged-from-env\nQ30_ROUTER_ORDINARY=kept\n`);
    const fromEnvFile = buildRouterEnv();
    assert.equal(fromEnvFile[ACTIVATION_CONTEXT_ENV], undefined, '.env');
    assert.equal(fromEnvFile.Q30_ROUTER_ORDINARY, 'kept', 'ordinary .env keys still reach the Router');
    fs.writeFileSync('.env', '');
    writeSecretsFile({ [ACTIVATION_CONTEXT_ENV]: 'forged-from-secrets' });
    assert.equal(buildRouterEnv()[ACTIVATION_CONTEXT_ENV], undefined, 'secrets');
    writeSecretsFile({});
    process.env[ACTIVATION_CONTEXT_ENV] = 'left-in-process';
    try {
        assert.equal(buildRouterEnv()[ACTIVATION_CONTEXT_ENV], undefined, 'process environment');
    } finally {
        delete process.env[ACTIVATION_CONTEXT_ENV];
    }
});
