import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyMpsRuntimeObservation } from '../../cli/sandbox/hardwareLimits/mpsRuntimeObservation.mjs';
const containerId = 'a'.repeat(64);
const imageId = 'b'.repeat(64);
const state = { daemonGeneration: 'daemon', configurationGeneration: 'config', pipeDirectory: `/run/ploinky/mps/pipe-${'c'.repeat(32)}` };
const share = { smPercent: 25, memoryMiB: 1024 };
function inspected() { return { Id: containerId, Image: `sha256:${imageId}`, Config: { User: '1000:1000', Labels: { 'ploinky.mpsgeneration': 'daemon:config' }, Env: ['PRIVATE_TOKEN=do-not-retain', 'CUDA_MPS_PIPE_DIRECTORY=/run/ploinky-mps-pipe', 'CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=25', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT=0=1024M'] }, Mounts: [{ Type: 'bind', Source: state.pipeDirectory, Destination: '/run/ploinky-mps-pipe', RW: true }, { Type: 'bind', Source: '/workspace', Destination: '/code', RW: false }] }; }
function verify(value = inspected(), extra = {}) { return verifyMpsRuntimeObservation({ containerId, imageId, share, state, query: () => ({ status: 0, stdout: JSON.stringify([value]) }), ...extra }); }
test('MRO.exact runtime verifies only filtered fields with bounded immutable inspect', () => {
    let call;
    const result = verify(inspected(), { query: (...args) => { call = args; return { ok: true, stdout: JSON.stringify([inspected()]) }; }, imageUser: '1000:1000' });
    assert.deepEqual(call[1], ['container', 'inspect', containerId]); assert.equal(call[2].timeout, 5000); assert.equal(call[2].maxBuffer, 1024 * 1024);
    assert.equal(result.imageId, imageId); assert.equal(result.mpsGeneration, 'daemon:config'); assert.equal(Object.keys(result.environment).length, 3);
    assert.equal(JSON.stringify(result).includes('PRIVATE_TOKEN'), false); assert.equal(JSON.stringify(result).includes('do-not-retain'), false);
});
for (const [name, mutate] of [
    ['container replacement', (v) => { v.Id = 'd'.repeat(64); }], ['image replacement', (v) => { v.Image = 'e'.repeat(64); }],
    ['mutable image', (v) => { v.Image = 'image:tag'; }], ['generation replay', (v) => { v.Config.Labels['ploinky.mpsgeneration'] = 'old:config'; }],
    ['missing environment', (v) => { v.Config.Env.pop(); }], ['duplicate same environment', (v) => { v.Config.Env.push(v.Config.Env[1]); }],
    ['duplicate changed environment', (v) => { v.Config.Env.push('CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=100'); }],
    ['changed environment', (v) => { v.Config.Env[2] = 'CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=100'; }],
    ['bare environment', (v) => { v.Config.Env[2] = 'CUDA_MPS_ACTIVE_THREAD_PERCENTAGE'; }],
    ['missing pipe', (v) => { v.Mounts.shift(); }], ['read-only pipe', (v) => { v.Mounts[0].RW = false; }],
    ['duplicate pipe', (v) => { v.Mounts.push({ ...v.Mounts[0] }); }], ['changed source', (v) => { v.Mounts[0].Source = '/other'; }],
    ['destination child overlap', (v) => { v.Mounts.push({ Type: 'bind', Source: '/other', Destination: '/run/ploinky-mps-pipe/child', RW: true }); }],
    ['destination ancestor overlap', (v) => { v.Mounts.push({ Type: 'bind', Source: '/other', Destination: '/run', RW: true }); }],
    ['source alias', (v) => { v.Mounts.push({ Type: 'bind', Source: state.pipeDirectory, Destination: '/other', RW: true }); }],
    ['source ancestor', (v) => { v.Mounts.push({ Type: 'bind', Source: '/run/ploinky/mps', Destination: '/other', RW: true }); }],
    ['noncanonical mount', (v) => { v.Mounts[0].Destination = '/tmp/../run/ploinky-mps-pipe'; }],
]) test(`MRO.reject ${name}`, () => { const value = inspected(); mutate(value); assert.throws(() => verify(value), { code: 'gpu_sharing_unavailable' }); });
test('MRO.reject expected image user mismatch', () => { assert.throws(() => verify(inspected(), { imageUser: '2000:2000' }), /user changed/); });
test('MRO.failed and oversized replies never expose environment', () => {
    for (const reply of [{ status: 1, stdout: 'PRIVATE_TOKEN=do-not-retain' }, { status: 0, ok: false, stdout: '[]' }, { ok: true, signal: 'SIGTERM', stdout: '[]' }, { status: 0, stdout: 'x'.repeat(1024 * 1024 + 1) }, { status: 0, stdout: '{invalid' }, { status: 0, stdout: JSON.stringify([inspected(), inspected()]) }]) {
        assert.throws(() => verify(null, { query: () => reply }), (error) => error.code === 'gpu_sharing_unavailable' && !error.message.includes('PRIVATE_TOKEN'));
    }
});
test('MRO.invalid expected identity refuses without executing query', () => {
    assert.throws(() => verify(null, { containerId: 'name', query: () => assert.fail('must not run') }), /exact container/);
});
