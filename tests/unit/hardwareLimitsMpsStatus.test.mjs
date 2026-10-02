import assert from 'node:assert/strict';
import test from 'node:test';
import { readMpsStatus, inspectPreparedMpsImage, inspectMpsTargetEligibility } from '../../cli/sandbox/hardwareLimits/mpsStatus.mjs';
import { projectAppliedLimits } from '../../cli/server/workspaceMetricsLimits.mjs';
const facts = { memoryModel: 'dedicated', name: 'RTX 4090', uuid: 'GPU-fixture', driverVersion: '550.1', memoryMiB: 24576 };
const grant = { valid: true, state: 'active', fingerprint: 'wiring', agents: ['demo/worker'], mps: { control: { source: '/private/tool' } } };
const ready = { status: 'ready', daemonGeneration: 'daemon1', configurationGeneration: 'config1', serverDefault: { smPercent: 50, memoryMiB: 4096, shareMemoryMiB: 3500, deviceUuid: facts.uuid, driverVersion: facts.driverVersion, wiringFingerprint: grant.fingerprint }, pendingClients: [{ key: 'alias', instanceId: 'i', enableGeneration: 'g', secret: 'omit' }] };
const deps = { readGrant: () => grant, observeGpu: () => facts, readState: () => ready, backend: { observe: () => ({ state: 'owned' }), verify: () => true } };
test('MS.read-only status retains private admission facts without serializing them', () => {
    const result = readMpsStatus(deps);
    assert.equal(result.eligible, true); assert.equal(result.mpsGeneration, 'daemon1:config1');
    assert.equal(result.facts, facts); assert.equal(result.grant, grant);
    assert.equal(JSON.stringify(result).includes('/private/tool'), false);
    assert.equal(JSON.stringify(result).includes('omit'), false);
    assert.deepEqual(result.serverDefault, { smPercent: 50, vramMiB: 4096, shareMemoryMiB: 3500 });
});
test('MS.dormant policies require no daemon and lost daemon has no applied generation', () => {
    assert.equal(readMpsStatus({ ...deps, readState: () => null }).daemonStatus, 'stopped');
    const result = readMpsStatus({ ...deps, backend: { observe: () => ({ state: 'gone' }), verify: () => { throw Error('must not read foreign daemon'); } } });
    assert.equal(result.daemonStatus, 'lost'); assert.equal(result.mpsGeneration, null); assert.equal(result.serverDefault, null);
});
test('MS.unavailable grant and unknown GPU cannot qualify', () => {
    for (const changes of [{ readGrant: () => ({}) }, { observeGpu: () => { throw Error('unknown memory model'); } }, { readState: () => { throw Error('unsafe state'); } }]) assert.equal(readMpsStatus({ ...deps, ...changes }).eligible, false);
});
test('MS.image probe is bounded inspect only; missing images never pull', () => {
    const calls = [];
    const record = { Id: 'a'.repeat(64), Config: { User: '1000:1000' } };
    assert.deepEqual(inspectPreparedMpsImage('local/image', { query: (...args) => { calls.push(args); return { status: 0, stdout: JSON.stringify([record]) }; } }), [record]);
    assert.deepEqual(calls[0][1], ['image', 'inspect', 'local/image']); assert.equal(calls[0][2].timeout, 5000);
    assert.throws(() => inspectPreparedMpsImage('missing', { query: () => ({ status: 1 }) }), { code: 'image_preparation_required' });
});
test('MS.exact target requires current grant before inspecting image', () => {
    const input = { image: 'prepared', agentRef: 'demo/other', status: readMpsStatus(deps), networkMode: 'default', gpuShare: { smPercent: 25, vramPercent: 25 } };
    assert.throws(() => inspectMpsTargetEligibility(input, { readGrant: () => grant, inspectImage: () => { throw Error('must not inspect'); } }), { code: 'gpu_sharing_unavailable' });
    assert.throws(() => inspectMpsTargetEligibility({ ...input, agentRef: 'demo/worker' }, { readGrant: () => grant, inspectImage: () => ({ Id: 'a'.repeat(64), Config: { User: '0:0' } }) }), { code: 'gpu_sharing_unavailable' });
});
test('MS.GPU assurance requires exact applied generation and runtime identity', () => {
    const inspect = { Id: 'a'.repeat(64), Config: { Labels: { 'ploinky.limitshash': 'hash', 'ploinky.mpsgeneration': 'd:c' }, Env: ['CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=25', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT=0=1024M'] } };
    const proof = { containerId: inspect.Id, limitsHash: 'hash', mpsGeneration: 'd:c' };
    assert.equal(projectAppliedLimits(inspect, proof).gpu.assurance, 'best-effort');
    assert.equal(projectAppliedLimits(inspect, { ...proof, mpsGeneration: 'old' }).gpu.assurance, 'none');
    assert.equal(projectAppliedLimits(inspect, null).gpu.assurance, 'none');
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { handleHardwareLimitsRoutes } from '../../cli/server/authHandlers/hardwareLimitsRoutes.mjs';
import { hardwareStorePaths, initializeStore, readStoreSnapshot } from '../../cli/sandbox/hardwareLimits/store.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';

test('MS.POST GPU validation sees exact profiles and fails before store write', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-api-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const identity = buildWorkspaceIdentity(root, { markerFound: true });
    const paths = hardwareStorePaths({ identity, homeDirectory: path.join(root, 'home') });
    initializeStore({ paths, identity });
    const snapshot = readStoreSnapshot({ paths, identity });
    const registry = { exact: { type: 'agent', repoName: 'demo', agentName: 'worker', alias: 'router', profile: 'small' }, unrelated: { type: 'agent', repoName: 'other', agentName: 'worker' } };
    let writes = 0; let status; let payload;
    const req = Readable.from([JSON.stringify({ action: 'set_agent_limits', expectedToken: snapshot.token, agentRef: 'demo/worker', limits: { gpu: { smPercent: 25, vramPercent: 25 } } })]);
    Object.assign(req, { method: 'POST', headers: {}, user: { id: 'admin' } });
    await handleHardwareLimitsRoutes(req, { writeHead: (value) => { status = value; }, end: (value) => { payload = JSON.parse(value); } }, new URL('http://localhost/api/marketplace/hardware-limits'), {
        ensureAdmin: () => true, verifyMutation: () => ({ ok: true }),
        getContext: () => ({ paths, identity, gate: 'on', gpu: readMpsStatus(deps) }),
        getInstalled: () => [{ ref: 'demo/worker' }], getRegistry: () => registry,
        qualifyGpu: (agent, records) => { assert.equal(agent.ref, 'demo/worker'); assert.deepEqual(records, [registry.exact]); throw Object.assign(new Error('Prepare image first'), { code: 'image_preparation_required', status: 409 }); },
        set: () => { writes++; },
    });
    assert.equal(status, 409); assert.equal(payload.error, 'image_preparation_required'); assert.equal(writes, 0);
    assert.deepEqual(readStoreSnapshot({ paths, identity }).token, snapshot.token);
});

 test('MS.changed device driver or wiring invalidates observed generation', () => {
    for (const field of ['deviceUuid', 'driverVersion', 'wiringFingerprint']) {
        const status = readMpsStatus({ ...deps, readState: () => ({ ...ready, serverDefault: { ...ready.serverDefault, [field]: 'changed' } }) });
        assert.equal(status.mpsGeneration, null); assert.equal(status.daemonStatus, 'pending');
    }
});

test('M7.gb10-refusal-carries-the-unified-memory-text', async (t) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { parseMpsGpuObservation } = await import('../../cli/sandbox/hardwareLimits/mpsEligibility.mjs');
    const { resolveStoredOverride } = await import('../../cli/sandbox/hardwareLimits/resolve.mjs');
    const { qualifyHardwareGpuTarget, hardwareHttpError } = await import('../../cli/server/authHandlers/hardwareLimitsRoutes.mjs');
    const reason = 'GPU sharing is unsupported on this unified or unverified GPU memory model: NVIDIA GB10.';
    const fix = 'Clear the GPU share. CPU/RAM controls remain separately available.';
    // GB10 with numeric memory, and GB10 that reports no dedicated memory.
    for (const line of ['0, GPU-12345678-1234-1234-1234-123456789012, NVIDIA GB10, 122570, 580.95.05', '0, GPU-12345678-1234-1234-1234-123456789012, NVIDIA GB10, [N/A], 580.95.05']) {
        const status = readMpsStatus({ ...deps, observeGpu: () => parseMpsGpuObservation(line) });
        assert.equal(status.eligible, false);
        assert.equal(status.memoryModel, 'unified');
        assert.equal(status.name, 'NVIDIA GB10');
        assert.equal(status.reason, `${reason} ${fix}`);
        // Admission: the stored share is refused with exactly the §9.3 text.
        const resolved = resolveStoredOverride({ gpu: { smPercent: 25, vramPercent: 25 } }, { cpus: 8, memoryBytes: 8 * 1024 ** 3 }, { ref: 'demo/worker', gpu: status });
        assert.equal(resolved.problem.reason, reason);
        assert.equal(resolved.problem.fix, fix);
        // API qualification of a Save: the typed HTTP message carries it too.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-gb10-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const manifestPath = path.join(root, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ container: 'prepared:image', start: 'sleep infinity' }));
        let error;
        try {
            qualifyHardwareGpuTarget({ ref: 'demo/worker', manifestPath }, [], { gpu: status, identity: { workspaceRoot: root } }, { gpu: { smPercent: 25, vramPercent: 25 } },
                { inspectImage: () => assert.fail('a refused model never inspects an image') });
        } catch (caught) { error = caught; }
        assert.ok(error, 'qualification refuses');
        const response = hardwareHttpError(error);
        assert.equal(response.body.error, 'gpu_sharing_unavailable');
        assert.equal(response.body.message, `${reason} ${fix}`);
    }
    // An unknown model names itself the same way.
    const unknown = readMpsStatus({ ...deps, observeGpu: () => parseMpsGpuObservation('0, GPU-12345678-1234-1234-1234-123456789012, NVIDIA DGX Spark, 122570, 580.95.05') });
    assert.equal(unknown.memoryModel, 'unknown');
    assert.equal(unknown.reason, `GPU sharing is unsupported on this unified or unverified GPU memory model: NVIDIA DGX Spark. ${fix}`);
});
