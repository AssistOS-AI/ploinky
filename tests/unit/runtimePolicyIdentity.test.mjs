import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithRuntimePolicyEnvironment } from '../../cli/utils/runtime/runtimePolicyContext.mjs';
import { getProfileEnvVars } from '../../cli/utils/runtime/profileService.js';
import { computeEnvHash } from '../../cli/sandbox/docker/common.js';

const environment = (prod, workspaceProfile, role = 'embedded') => runWithRuntimePolicyEnvironment(
    { prod, workspaceProfile },
    () => ({
        env: getProfileEnvVars('worker', 'demo', role),
        hash: computeEnvHash({}, {}, {}, { agentName: 'worker', repoName: 'demo', profileName: role }),
    }),
);

test('runtime identity hashes injected generation policy even for identical manifests and role pins', () => {
    const dev = environment(false, 'dev');
    const qa = environment(false, 'qa');
    const prod = environment(true, 'prod');
    const qaOtherRole = environment(false, 'qa', 'explorer');
    assert.equal(dev.env.PLOINKY_PROFILE_ENV, 'development');
    assert.equal(qa.env.PLOINKY_PROFILE_ENV, 'qa');
    assert.equal(prod.env.PROD, 'true');
    assert.equal(qa.env.PLOINKY_PROFILE, 'embedded');
    assert.ok(dev.hash && qa.hash && prod.hash && qaOtherRole.hash);
    assert.notEqual(dev.hash, qa.hash);
    assert.notEqual(qa.hash, prod.hash);
    assert.notEqual(qa.hash, qaOtherRole.hash);
    assert.equal(qa.hash, environment(false, 'qa').hash);
});

test('concurrent policy scopes retain their own generation across awaits', async () => {
    const profiles = await Promise.all(['dev', 'qa'].map((workspaceProfile) => (
        runWithRuntimePolicyEnvironment({ prod: false, workspaceProfile }, async () => {
            await new Promise((resolve) => setImmediate(resolve));
            return getProfileEnvVars('worker', 'demo', 'embedded').PLOINKY_PROFILE_ENV;
        })
    )));
    assert.deepEqual(profiles, ['development', 'qa']);
});
