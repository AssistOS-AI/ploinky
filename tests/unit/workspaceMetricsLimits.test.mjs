import assert from 'node:assert/strict';
import test from 'node:test';
import { AppliedLimitsCache, parseMemoryUsage, projectAppliedLimits, limitsUsage } from '../../cli/server/workspaceMetricsLimits.mjs';

const id = 'a'.repeat(64);
const hash = 'b'.repeat(64);
const inspected = { Id: id, Config: { Labels: { 'ploinky.limitshash': hash, 'ploinky.mpsgeneration': 'daemon:config' }, Env: ['SECRET=never-cache', 'CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=25', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT=0=3072M', 'CUDA_MPS_PIPE_DIRECTORY=/run/ploinky-mps-pipe'] } };
const proof = { containerId: id, limitsHash: hash, mpsGeneration: 'daemon:config', instanceId: 'one', enableGeneration: 'gen1', cpus: 0.25, memoryBytes: 64 * 1024 ** 2 };

test('M.memory-both-halves', () => {
    assert.deepEqual(parseMemoryUsage('12.5MiB / 64MiB'), { memoryBytes: 13107200, memoryLimitBytes: 67108864 });
    assert.deepEqual(parseMemoryUsage('0 B / 0 B'), { memoryBytes: 0, memoryLimitBytes: 0 });
    assert.equal(parseMemoryUsage('malformed / none').memoryLimitBytes, null);
});
test('M.cpu-fraction', () => {
    const value = limitsUsage({ cpuPercent: 12.5, memoryBytes: 32 * 1024 ** 2 }, projectAppliedLimits(inspected, proof));
    assert.equal(value.cpuLimitPercent, 25);
    assert.equal(value.cpuLimitUsagePercent, 50);
    assert.equal(value.memoryLimitUsagePercent, 50);
});
test('M.separate-assurance', () => {
    const value = projectAppliedLimits(inspected, proof);
    assert.equal(value.cpu.assurance, 'kernel');
    assert.equal(value.memory.assurance, 'kernel');
    assert.equal(value.gpu.assurance, 'best-effort');
    assert.equal(value.gpu.vramBytes, 3 * 1024 ** 3);
    assert.equal(projectAppliedLimits(inspected, null).memory.assurance, 'none');
    assert.equal(projectAppliedLimits(inspected, { ...proof, containerId: 'c'.repeat(64) }).cpu.assurance, 'none');
});
test('M.inspect-identity-cache', async () => {
    let calls = 0;
    const cache = new AppliedLimitsCache({ inspect: async () => { calls++; return inspected; }, readVerified: () => proof });
    const entry = { containerName: 'exact-key', containerId: id, instanceId: 'one', enableGeneration: 'gen1', state: { running: true } };
    await cache.reconcile([entry]);
    await cache.reconcile([entry]);
    assert.equal(calls, 1);
    await cache.reconcile([{ ...entry, instanceId: 'two', enableGeneration: 'gen2' }]);
    assert.equal(calls, 2);
    await cache.reconcile([]);
    assert.equal(cache.values.size, 0);
});
test('M.no-full-environment', async () => {
    const cache = new AppliedLimitsCache({ inspect: async () => inspected, readVerified: () => proof });
    await cache.reconcile([{ containerName: 'exact-key', containerId: id, state: { running: true } }]);
    const serialized = JSON.stringify([...cache.values]);
    assert.equal(serialized.includes('SECRET'), false);
    assert.equal(serialized.includes('never-cache'), false);
    assert.equal(serialized.includes('Config'), false);
});
test('M.off-shape', () => {
    assert.equal(projectAppliedLimits({ Id: id, Config: { Labels: {}, Env: [] } }), null);
    const metrics = { cpuPercent: 10, memoryBytes: 20 };
    assert.deepEqual(limitsUsage(metrics, null), metrics);
});

test('M.late-proof-and-generation-change', async () => {
    let calls = 0;
    let observation = null;
    const cache = new AppliedLimitsCache({ inspect: async () => { calls++; return inspected; }, readVerified: () => observation });
    const entry = { containerName: 'exact-key', containerId: id, registryContainerId: id, instanceId: 'one', enableGeneration: 'gen1', state: { running: true } };
    await cache.reconcile([entry]);
    assert.equal(cache.values.get('exact-key').cpu.assurance, 'none');
    observation = proof;
    await cache.reconcile([entry]);
    assert.equal(calls, 1);
    assert.equal(cache.values.get('exact-key').cpu.assurance, 'kernel');
    await cache.reconcile([{ ...entry, enableGeneration: 'new-generation' }]);
    assert.equal(cache.values.get('exact-key').cpu.assurance, 'none');
    await cache.reconcile([{ ...entry, registryContainerId: 'c'.repeat(64) }]);
    assert.equal(cache.values.get('exact-key').cpu.assurance, 'none');
});
