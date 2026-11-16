import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;
const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-')));
fs.mkdirSync(path.join(tempDir, '.ploinky'), { recursive: true });
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = '6'.repeat(64);

const moduleSuffix = `?test=${Date.now()}`;
const { setSecretValue } = await import(`../../cli/utils/security/encryptedSecretsFile.js${moduleSuffix}`);
setSecretValue('DPU_MASTER_KEY', 'test-master-key-123');
const { deriveAgentSecret } = await import(`../../cli/utils/security/masterKey.js${moduleSuffix}`);
const plannerModule = await import(`../../cli/utils/runtime/runtimeResourcePlanner.js${moduleSuffix}`);
const { planRuntimeResources, applyRuntimeResourceEnv, ensureGitCredentialsHostDir } = plannerModule;
const { deriveSubkey } = await import(`../../cli/utils/security/masterKey.js${moduleSuffix}`);

test.after(() => {
    process.chdir(originalCwd);
    if (originalMasterKey === undefined) {
        delete process.env.PLOINKY_MASTER_KEY;
    } else {
        process.env.PLOINKY_MASTER_KEY = originalMasterKey;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('planRuntimeResources returns empty plan for manifest without runtime block', () => {
    const plan = planRuntimeResources({});
    assert.equal(Object.hasOwn(plan, 'persistentStorage'), false);
    assert.equal(plan.gitCredentials, null);
    assert.deepEqual(plan.env, {});
});

test('retired storage declarations and templates fail with migration guidance', () => {
    for (const resources of [
        { persistentStorage: { key: 'demo', containerPath: '/data' } },
        { persistentStorage: null },
        { env: { DATA_ROOT: '{{STORAGE_CONTAINER_PATH}}' } },
        { env: { DATA_ROOT: '{{ STORAGE_HOST_PATH }}' } },
    ]) {
        assert.throws(() => planRuntimeResources({ runtime: { resources } }), error => {
            assert.equal(error.code, 'PLOINKY_REMOVED_PERSISTENT_STORAGE');
            assert.match(error.message, /automatic persistent home at \/root/);
            return true;
        });
    }
});

test('runtime env uses explicit home paths and preserves secret templates', () => {
    const plan = planRuntimeResources({ runtime: { resources: { env: {
        DATA_ROOT: '/root', KEY: '{{secret:DPU_MASTER_KEY}}',
    } } } });
    assert.deepEqual(plan.env, { DATA_ROOT: '/root', KEY: 'test-master-key-123' });
});

test('planRuntimeResources resolves generatedSecret templates', () => {
    const plan = planRuntimeResources({
        runtime: {
            resources: {
                env: {
                    DPU_MASTER_KEY: '{{generatedSecret:DPU_MASTER_KEY}}'
                }
            }
        }
    }, {
        repoName: 'AssistOSExplorer',
        agentName: 'dpuAgent',
    });

    assert.equal(plan.env.DPU_MASTER_KEY, deriveAgentSecret({
        repoName: 'AssistOSExplorer',
        agentName: 'dpuAgent',
        name: 'DPU_MASTER_KEY',
    }));
    assert.notEqual(plan.env.DPU_MASTER_KEY, 'test-master-key-123');
});

test('generatedSecret template produces different values for different agents', () => {
    const manifest = {
        runtime: {
            resources: {
                env: {
                    MY_KEY: '{{generatedSecret:MY_KEY}}'
                }
            }
        }
    };
    const planA = planRuntimeResources(manifest, {
        repoName: 'AssistOSExplorer',
        agentName: 'agentA',
    });
    const planB = planRuntimeResources(manifest, {
        repoName: 'AssistOSExplorer',
        agentName: 'agentB',
    });
    assert.ok(planA.env.MY_KEY, 'agentA key should be non-empty');
    assert.ok(planB.env.MY_KEY, 'agentB key should be non-empty');
    assert.notEqual(planA.env.MY_KEY, planB.env.MY_KEY);
});

test('planRuntimeResources rejects removed derivedMasterSecret templates', () => {
    assert.throws(() => planRuntimeResources({
        runtime: {
            resources: {
                env: {
                    OLD_KEY: '{{derivedMasterSecret:OLD_KEY}}'
                }
            }
        }
    }, {
        repoName: 'AssistOSExplorer',
        agentName: 'dpuAgent',
    }), error => {
        assert.equal(error.code, 'PLOINKY_LEGACY_DERIVED_MASTER_TEMPLATE');
        assert.match(error.message, /generatedSecret/);
        return true;
    });
});

test('applyRuntimeResourceEnv copies env map as new object', () => {
    const plan = planRuntimeResources({
        runtime: {
            resources: { env: { FOO: 'bar' } }
        }
    });
    const applied = applyRuntimeResourceEnv(plan);
    assert.deepEqual(applied, { FOO: 'bar' });
    applied.FOO = 'baz';
    assert.equal(plan.env.FOO, 'bar', 'mutating the applied map must not affect the plan');
});

const gitCredentialsManifest = (resource = { containerPath: '/git-credentials' }) => ({
    runtime: {
        resources: {
            gitCredentials: resource,
            env: {
                MIRROR_DIR: '{{GIT_CREDENTIALS_CONTAINER_PATH}}',
                MIRROR_KEY: '{{GIT_CREDENTIALS_KEY}}',
            },
        },
    },
});

test('gitCredentials plans the workspace credentials directory and its two templates', () => {
    const hostPath = path.join(tempDir, '.data', 'dpu-data', 'git-credentials');
    const plan = planRuntimeResources(gitCredentialsManifest());
    assert.deepEqual(plan.gitCredentials, { hostPath, containerPath: '/git-credentials' });
    assert.equal(plan.env.MIRROR_DIR, '/git-credentials');
    assert.equal(plan.env.MIRROR_KEY, deriveSubkey('git-credentials-v1', 32).toString('hex'));
    assert.match(plan.env.MIRROR_KEY, /^[0-9a-f]{64}$/);

    // Host sandboxes see the physical Git credentials path.
    const hostPlan = planRuntimeResources(gitCredentialsManifest(), { useHostStoragePath: true });
    assert.equal(hostPlan.env.MIRROR_DIR, hostPath);

    // The container path defaults to /git-credentials.
    assert.equal(planRuntimeResources(gitCredentialsManifest({})).gitCredentials.containerPath, '/git-credentials');

    const created = ensureGitCredentialsHostDir(plan);
    assert.equal(created, hostPath);
    assert.equal(fs.statSync(created).mode & 0o777, 0o700);
    assert.equal(ensureGitCredentialsHostDir(plan), created);
    assert.equal(ensureGitCredentialsHostDir(planRuntimeResources({})), null);
});

test('gitCredentials templates expand to nothing unless the resource is declared', () => {
    const manifest = gitCredentialsManifest();
    delete manifest.runtime.resources.gitCredentials;
    const plan = planRuntimeResources(manifest);
    assert.equal(plan.gitCredentials, null);
    assert.equal(plan.env.MIRROR_DIR, '');
    assert.equal(plan.env.MIRROR_KEY, '');
});

test('gitCredentials rejects unsafe container paths', () => {
    for (const containerPath of ['relative', '/', '/a/../b', '/a:/b']) {
        assert.throws(
            () => planRuntimeResources(gitCredentialsManifest({ containerPath })),
            error => error?.code === 'PLOINKY_AGENT_DATA_POLICY_VIOLATION',
            containerPath,
        );
    }
    assert.throws(
        () => planRuntimeResources(gitCredentialsManifest('yes')),
        error => error?.code === 'PLOINKY_AGENT_DATA_POLICY_VIOLATION',
    );
});
