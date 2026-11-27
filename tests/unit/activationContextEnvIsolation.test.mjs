import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Q30 S1-F1: the host-issued activation context reaches an in-Box command
// only through the environment of the exec the host launched. The workspace
// .env and manifest secrets are agent-writable, so no path that copies them
// into process.env may carry PLOINKY_ACTIVATION_CONTEXT: a forged context
// would admit workspace-start under the barrier marker and let a start
// remove the host's marker.

const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-activation-env-')));
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
test.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

const { populateProcessEnvFromEnvFile } = await import('../../cli/commands/llmProviderUtils.js');
const { injectSecretsToEnv } = await import('../../cli/utils/security/secretInjector.js');
const { ACTIVATION_CONTEXT_ENV, hostAdmittedActivation, readActivationRequest } = await import('../../cli/sandbox/activationRecords.mjs');

const FORGED = JSON.stringify({
    schema: 'ploinky-activation-context', version: 1, operation: 'start', purpose: 'activate',
    settlesOperationId: null, operationId: 'f'.repeat(32), instance: 'ploinky-box-workspace-123456789abc',
    containerId: 'c'.repeat(64), workspaceRoot: workspace,
});

test.afterEach(() => {
    delete process.env[ACTIVATION_CONTEXT_ENV];
    delete process.env.Q30_ORDINARY_KEY;
    readActivationRequest({});
});

test('the workspace .env never sets the activation context, while ordinary keys still load', () => {
    const envFile = path.join(workspace, '.env');
    fs.writeFileSync(envFile, `${ACTIVATION_CONTEXT_ENV}=${FORGED}\nQ30_ORDINARY_KEY=loaded\n`);
    delete process.env[ACTIVATION_CONTEXT_ENV];
    populateProcessEnvFromEnvFile(envFile);
    assert.equal(process.env[ACTIVATION_CONTEXT_ENV], undefined);
    assert.equal(process.env.Q30_ORDINARY_KEY, 'loaded', 'the population itself still runs');
    assert.equal(readActivationRequest(process.env, { command: 'start' }), null);
    assert.equal(hostAdmittedActivation(), null);
});

test('injected secrets never set the activation context', () => {
    delete process.env[ACTIVATION_CONTEXT_ENV];
    injectSecretsToEnv({ [ACTIVATION_CONTEXT_ENV]: FORGED, Q30_ORDINARY_KEY: 'injected' });
    assert.equal(process.env[ACTIVATION_CONTEXT_ENV], undefined);
    assert.equal(process.env.Q30_ORDINARY_KEY, 'injected');
});
