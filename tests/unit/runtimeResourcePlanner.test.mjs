import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-'));
fs.mkdirSync(path.join(tempDir, '.ploinky'), { recursive: true });
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = '6'.repeat(64);

const moduleSuffix = `?test=${Date.now()}`;
const { setSecretValue } = await import(`../../cli/services/encryptedSecretsFile.js${moduleSuffix}`);
setSecretValue('DPU_MASTER_KEY', 'test-master-key-123');
const { deriveAgentSecret } = await import(`../../cli/services/masterKey.js${moduleSuffix}`);
const plannerModule = await import(`../../cli/services/runtimeResourcePlanner.js${moduleSuffix}`);
const { planRuntimeResources, applyRuntimeResourceEnv, ensurePersistentStorageHostDir } = plannerModule;

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
    assert.equal(plan.persistentStorage, null);
    assert.deepEqual(plan.env, {});
});

test('planRuntimeResources resolves persistentStorage and templated env', () => {
    const plan = planRuntimeResources({
        runtime: {
            resources: {
                persistentStorage: { key: 'dpu-data', containerPath: '/dpu-data' },
                env: {
                    DPU_DATA_ROOT: '{{STORAGE_CONTAINER_PATH}}',
                    DPU_MASTER_KEY: '{{secret:DPU_MASTER_KEY}}'
                }
            }
        }
    });
    assert.equal(plan.persistentStorage.containerPath, '/dpu-data');
    assert.match(plan.persistentStorage.hostPath, /dpu-data$/);
    assert.equal(plan.env.DPU_DATA_ROOT, '/dpu-data');
    assert.equal(plan.env.DPU_MASTER_KEY, 'test-master-key-123');
});

test('planRuntimeResources resolves derived-master secret templates', () => {
    const plan = planRuntimeResources({
        runtime: {
            resources: {
                env: {
                    DPU_MASTER_KEY: '{{derivedMasterSecret:DPU_MASTER_KEY}}'
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

test('planRuntimeResources can expand storage container path to host path for host sandboxes', () => {
    const plan = planRuntimeResources({
        runtime: {
            resources: {
                persistentStorage: { key: 'dpu-data', containerPath: '/dpu-data' },
                env: {
                    DPU_DATA_ROOT: '{{STORAGE_CONTAINER_PATH}}',
                },
            },
        },
    }, { useHostStoragePath: true });
    assert.equal(plan.env.DPU_DATA_ROOT, plan.persistentStorage.hostPath);
    assert.match(plan.env.DPU_DATA_ROOT, /dpu-data$/);
});

test('ensurePersistentStorageHostDir is idempotent', () => {
    const plan = planRuntimeResources({
        runtime: {
            resources: {
                persistentStorage: { key: 'test-key', containerPath: '/data' }
            }
        }
    });
    const created = ensurePersistentStorageHostDir(plan);
    assert.ok(fs.existsSync(created));
    // second call should be a no-op
    assert.equal(ensurePersistentStorageHostDir(plan), created);
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
