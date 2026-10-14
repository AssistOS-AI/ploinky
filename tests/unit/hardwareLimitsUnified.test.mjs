import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { classifyGpuFacts, classifyGpuMemoryModel, observeMpsGpu, parseMpsGpuObservation, resolveMpsShare } from '../../cli/sandbox/hardwareLimits/mpsEligibility.mjs';
import { readMpsStatus } from '../../cli/sandbox/hardwareLimits/mpsStatus.mjs';
import { limitsHash, resolveEffectiveLimits, resolveStoredOverride, resolveStoredGpuShare, AGENT_PLACEMENT } from '../../cli/sandbox/hardwareLimits/resolve.mjs';
import { HARDWARE_HELP } from '../../cli/server/authHandlers/hardwareLimitsRoutes.mjs';
import { STORE_SCHEMA, validateStoreDocument, validateAgentEntry } from '../../cli/sandbox/hardwareLimits/store.mjs';

const UUID = 'GPU-12345678-1234-1234-1234-123456789012';
const FIX = 'Clear the GPU share. CPU/RAM controls remain separately available.';
const GB10_PCI = '0x2E1210DE';
const Q2_SENTENCE = 'On unified-memory NVIDIA GPUs (GB10 / DGX Spark) a RAM limit does not cap the GPU memory an agent allocates (measured for llama.cpp\'s CUDA buffers); only the agent\'s own admission check keeps that memory within the budget, and an overrun takes memory from the whole host, which has no separate GPU memory.';
const line = (name, memory = '122570', driver = '580.95.05') => `0, ${UUID}, ${name}, ${memory}, ${driver}`;
const grant = { valid: true, state: 'active', fingerprint: 'wiring', agents: ['demo/worker'], mps: { control: { source: '/private/tool' } } };
const statusFor = (observeGpu) => readMpsStatus({ readGrant: () => grant, observeGpu, readState: () => null });
const reasonFor = (name) => `GPU sharing is unsupported on this unified or unverified GPU memory model: ${name}. ${FIX}`;
// A query stub answering the two nvidia-smi queries: the main one, then the optional device one.
const smi = (main, device, calls = []) => (command, args, options) => {
    calls.push({ command, args, env: options?.env, options });
    const reply = args.some((arg) => arg.includes('pci.device_id')) ? device : main;
    return typeof reply === 'function' ? reply() : reply;
};
const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
const refusal = (observeGpu) => { const status = statusFor(observeGpu); assert.equal(status.eligible, false); return status; };

test('HU.gb10-by-pci', () => {
    // Base: the name alone says "unknown" for the DGX Spark marketing name.
    assert.equal(classifyGpuMemoryModel('NVIDIA DGX Spark'), 'unknown');
    const facts = { name: 'NVIDIA DGX Spark', pciDeviceId: GB10_PCI, addressingMode: 'ATS', memoryNumeric: null };
    assert.equal(classifyGpuFacts(facts), 'unified');
    // Through the real two-query observation, with memory.total reported as [N/A].
    const status = refusal(() => observeMpsGpu({ query: smi(ok(`${line('NVIDIA DGX Spark', '[N/A]')}\n`), ok(`${GB10_PCI}, ATS\n`)) }));
    assert.equal(status.memoryModel, 'unified');
    assert.equal(status.pciDeviceId, GB10_PCI);
    assert.equal(status.addressingMode, 'ATS');
    assert.equal(status.reason, reasonFor('NVIDIA DGX Spark'));
    assert.equal(status.code, 'gpu_sharing_unavailable');
    // The PCI id compares case-insensitively.
    assert.equal(classifyGpuFacts({ name: 'x', pciDeviceId: '0x2e1210de' }), 'unified');
});

test('HU.unified-disclosure-payload', () => {
    const status = refusal(() => parseMpsGpuObservation(line('NVIDIA GB10'), `${GB10_PCI}, ATS\n`));
    assert.equal(status.memoryModel, 'unified');
    assert.deepEqual(status.unifiedMemory, { ramLimitCoversGpuAllocations: false, gpuMemoryBound: 'admission-only', assurance: 'advisory' });
    assert.equal(status.reason, reasonFor('NVIDIA GB10'));
    assert.ok(HARDWARE_HELP.gpu.includes(Q2_SENTENCE));
    assert.equal(HARDWARE_HELP.gpu[HARDWARE_HELP.gpu.length - 1], Q2_SENTENCE);
    // Only the unified refusal carries the disclosure: unknown and dedicated payloads do not.
    const unknown = refusal(() => parseMpsGpuObservation(line('NVIDIA futuristic 123', '8192'), '0x12345678, Default\n'));
    assert.equal(unknown.memoryModel, 'unknown');
    for (const key of ['unifiedMemory', 'pciDeviceId', 'addressingMode']) assert.equal(key in unknown, false, key);
});

test('HU.classifier-table', () => {
    const rows = [
        { name: 'NVIDIA GB10', pciDeviceId: GB10_PCI, addressingMode: 'ATS', memoryNumeric: null, expected: 'unified' },
        { name: 'NVIDIA DGX Spark', pciDeviceId: GB10_PCI, addressingMode: 'ATS', memoryNumeric: null, expected: 'unified' },
        { name: 'NVIDIA GeForce RTX 3060 Laptop GPU', pciDeviceId: '0x252010DE', addressingMode: 'None', memoryNumeric: 6144, expected: 'dedicated' },
        { name: 'NVIDIA GH200 480GB', pciDeviceId: '0x233010DE', addressingMode: 'ATS', memoryNumeric: 97871, expected: 'unified' },
        { name: 'NVIDIA Jetson AGX Orin', pciDeviceId: null, addressingMode: null, memoryNumeric: null, expected: 'unified' },
        { name: 'NVIDIA GB200', pciDeviceId: null, addressingMode: null, memoryNumeric: null, expected: 'unified' },
        { name: 'NVIDIA GeForce RTX 3060 Laptop GPU', pciDeviceId: GB10_PCI, addressingMode: 'ATS', memoryNumeric: 6144, expected: 'unified' },
        { name: 'Unknown model', pciDeviceId: null, addressingMode: null, memoryNumeric: 8192, expected: 'unknown' },
        { name: 'NVIDIA DGX Spark', pciDeviceId: null, addressingMode: null, memoryNumeric: null, expected: 'unknown' },
    ];
    for (const { expected, ...facts } of rows) assert.equal(classifyGpuFacts(facts), expected, JSON.stringify(facts));
    // Without the PCI id, every row equals the name-only classifier (kept for compatibility).
    for (const { name, expected, pciDeviceId } of rows) if (!pciDeviceId?.startsWith('0x2E12')) assert.equal(classifyGpuMemoryModel(name), expected, name);
});

test('HU.gh200-still-refused', () => {
    const status = refusal(() => observeMpsGpu({ query: smi(ok(`${line('NVIDIA GH200 480GB', '97871')}\n`), ok('0x233010DE, ATS\n')) }));
    assert.equal(status.memoryModel, 'unified');
    assert.equal(status.code, 'gpu_sharing_unavailable');
    assert.equal(status.reason, reasonFor('NVIDIA GH200 480GB'));
    // Admission refuses a stored share with the same text.
    const resolved = resolveStoredOverride({ gpu: { smPercent: 25, vramPercent: 25 } }, { cpus: 8, memoryBytes: 8 * 1024 ** 3 }, { ref: 'demo/worker', gpu: status });
    assert.equal(resolved.problem.reason, reasonFor('NVIDIA GH200 480GB').slice(0, -(FIX.length + 1)));
    assert.equal(resolved.problem.fix, FIX);
});

test('HU.second-query-failure', () => {
    const main = ok(`${line('NVIDIA GB10', '[N/A]')}\n`);
    const failures = { 'exit 1': { status: 1, stdout: '', stderr: 'unsupported query' }, 'spawn error': { status: null, error: Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }), stdout: '' }, 'signal': { status: null, signal: 'SIGTERM', stdout: '' } };
    for (const [label, device] of Object.entries(failures)) {
        const status = refusal(() => observeMpsGpu({ query: smi(main, device) }));
        assert.equal(status.memoryModel, 'unified', label);
        assert.equal(status.pciDeviceId, null, label);
        assert.equal(status.addressingMode, null, label);
        assert.equal(status.reason, reasonFor('NVIDIA GB10'), label);
        assert.equal(status.code, 'gpu_sharing_unavailable', label);
    }
    // A throwing device query is also contained.
    const thrown = refusal(() => observeMpsGpu({ query: smi(main, () => { throw new Error('spawn failed'); }) }));
    assert.equal(thrown.memoryModel, 'unified'); assert.equal(thrown.pciDeviceId, null);
    // Without the PCI id, the DGX Spark name stays unknown: no new qualification.
    assert.equal(refusal(() => observeMpsGpu({ query: smi(ok(`${line('NVIDIA DGX Spark', '[N/A]')}\n`), { status: 1, stdout: '' }) })).memoryModel, 'unknown');
});

test('HU.second-query-garbage', () => {
    const main = ok(`${line('NVIDIA GB10', '[N/A]')}\n`);
    for (const garbage of ['', 'garbage', `${GB10_PCI}\n`, `${GB10_PCI}, ATS, extra\n`, '0xZZZZZZZZ, ATS\n', `${GB10_PCI}, ATS\n${GB10_PCI}, ATS\n`, `${GB10_PCI}, ${'A'.repeat(64)}\n`, '\u0000\u0001\n']) {
        const status = refusal(() => observeMpsGpu({ query: smi(main, ok(garbage)) }));
        assert.equal(status.memoryModel, 'unified', JSON.stringify(garbage));
        assert.equal(status.pciDeviceId, null, JSON.stringify(garbage));
        assert.equal(status.addressingMode, null, JSON.stringify(garbage));
    }
    // A garbage device answer must not qualify an unknown GPU by name either.
    assert.equal(refusal(() => observeMpsGpu({ query: smi(ok(`${line('NVIDIA DGX Spark', '[N/A]')}\n`), ok('garbage\n')) })).memoryModel, 'unknown');
    // The main query keeps its own typed failure; the second query is not reached then.
    const calls = [];
    const failed = statusFor(() => observeMpsGpu({ query: smi({ status: 1, stdout: '', stderr: 'no' }, ok(`${GB10_PCI}, ATS\n`), calls) }));
    assert.equal(failed.eligible, false); assert.match(failed.reason, /GPU observation failed or timed out/);
    assert.equal(calls.length, 1);
});

test('HU.second-query-oversize', () => {
    const main = ok(`${line('NVIDIA GB10', '[N/A]')}\n`);
    const big = ok(`${GB10_PCI}, ATS\n${' '.repeat(8200)}`);
    const status = refusal(() => observeMpsGpu({ query: smi(main, big) }));
    assert.equal(status.memoryModel, 'unified'); assert.equal(status.pciDeviceId, null); assert.equal(status.addressingMode, null);
    assert.equal(status.reason, reasonFor('NVIDIA GB10')); assert.equal(status.code, 'gpu_sharing_unavailable');
    // A dedicated GPU with an oversize device reply keeps its dedicated facts.
    const facts = observeMpsGpu({ query: smi(ok(`${dedicatedLine}\n`), ok(`0x252010DE, None\n${' '.repeat(8200)}`)) });
    assert.equal(facts.memoryModel, 'dedicated'); assert.equal(facts.pciDeviceId, null);
});

test('HU.unqualified-memory-na', () => {
    // memory.total [N/A] on an unqualified (dedicated-named) GPU is a typed refusal, never a share.
    const status = statusFor(() => observeMpsGpu({ query: smi(ok(`${line('NVIDIA GeForce RTX 3060 Laptop GPU', '[N/A]', '595.91.07')}\n`), ok('0x252010DE, None\n')) }));
    assert.equal(status.eligible, false);
    assert.equal(status.code, 'gpu_sharing_unavailable');
    assert.match(status.reason, /GPU identity or dedicated memory is unknown/);
    assert.equal('unifiedMemory' in status, false);
});

test('HU.second-query-shape', () => {
    const calls = [];
    const facts = observeMpsGpu({ query: smi(ok(`${line('NVIDIA GeForce RTX 3060 Laptop GPU', '6144', '595.91.07')}\n`), ok('0x252010DE, None\n'), calls) });
    assert.equal(facts.memoryModel, 'dedicated');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args, ['-i', '0', '--query-gpu=pci.device_id,addressing_mode', '--format=csv,noheader']);
    assert.deepEqual(calls[1].env, calls[0].env);
    for (const key of ['timeout', 'maxBuffer', 'stdio', 'encoding']) { assert.ok(calls[0].options[key] !== undefined, key); assert.deepEqual(calls[1].options[key], calls[0].options[key], key); }
    assert.equal(calls[1].options.maxBuffer, 8192);
    assert.equal(calls[1].command, '/usr/local/nvidia/bin/nvidia-smi');
});

const goldenSha = '3632721fd57cec689066c49b1301cf1b501721e63d14f99980593f95c26c7d36';
const content = Buffer.from('fake mps tool\n');
const stat = { dev: 1, ino: 7, size: content.length, mtimeMs: 1000, ctimeMs: 1000, nlink: 1, isFile: () => true };
const fsApi = { realpathSync: (p) => p, openSync: () => 3, fstatSync: () => stat, accessSync: () => {}, readSync: (fd, buf, off, len) => { content.copy(buf, off, 0, len); return len; }, closeSync: () => {} };
const goldenMps = {
    control: { source: '/host/bin/nvidia-cuda-mps-control', destination: '/usr/local/nvidia/bin/nvidia-cuda-mps-control', dev: 1, ino: 7, size: content.length, mtimeMs: 1000, sha256: goldenSha },
    server: { source: '/host/bin/nvidia-cuda-mps-server', destination: '/usr/local/nvidia/bin/nvidia-cuda-mps-server', dev: 1, ino: 7, size: content.length, mtimeMs: 1000, sha256: goldenSha },
};
const goldenGrant = { valid: true, state: 'active', fingerprint: 'wiring', agents: ['demo/worker'], mps: goldenMps };
const dedicatedLine = '0, GPU-1234abcd-1234-abcd-1234-abcd12345678, NVIDIA GeForce RTX 3060 Laptop GPU, 6144, 595.91.07';
// Frozen base literals: /home/daniel/work/gb10-impl-evidence/goldens/goldens.json (A-P-6a, A-P-6b, A-P-6c), never regenerated.
const GOLDEN_SHARE_JSON = "{\"smPercent\":25,\"vramPercent\":50,\"vramMiB\":3072,\"memoryMiB\":3072,\"memoryBytes\":3221225472,\"deviceUuid\":\"GPU-1234abcd-1234-abcd-1234-abcd12345678\",\"driverVersion\":\"595.91.07\",\"wiringFingerprint\":\"wiring\"}";
const GOLDEN_HASH = "4dfa53101d3353ccbaea4a6cef1a5dc3c68b7b771c7efd8ba8c348c497fe24a7";
const GOLDEN_STATUS_READY_JSON = "{\"eligible\":true,\"mode\":\"mps-shared\",\"assurance\":\"best-effort\",\"daemonStatus\":\"ready\",\"serverDefault\":{\"smPercent\":50,\"vramMiB\":4096,\"shareMemoryMiB\":3500},\"mpsGeneration\":\"daemon1:config1\",\"memoryModel\":\"dedicated\",\"name\":\"NVIDIA GeForce RTX 3060 Laptop GPU\",\"deviceUuid\":\"GPU-1234abcd-1234-abcd-1234-abcd12345678\",\"driverVersion\":\"595.91.07\",\"deviceMemoryBytes\":6442450944,\"wiringFingerprint\":\"wiring\",\"pendingClients\":[{\"key\":\"alias\",\"instanceId\":\"i\",\"enableGeneration\":\"g\"}],\"clientsPending\":true}";
const GOLDEN_STATUS_STOPPED_JSON = "{\"eligible\":true,\"mode\":\"mps-shared\",\"assurance\":\"best-effort\",\"daemonStatus\":\"stopped\",\"serverDefault\":null,\"mpsGeneration\":null,\"memoryModel\":\"dedicated\",\"name\":\"NVIDIA GeForce RTX 3060 Laptop GPU\",\"deviceUuid\":\"GPU-1234abcd-1234-abcd-1234-abcd12345678\",\"driverVersion\":\"595.91.07\",\"deviceMemoryBytes\":6442450944,\"wiringFingerprint\":\"wiring\"}";
const GOLDEN_FACTS_JSON = "{\"index\":0,\"uuid\":\"GPU-1234abcd-1234-abcd-1234-abcd12345678\",\"name\":\"NVIDIA GeForce RTX 3060 Laptop GPU\",\"memoryMiB\":6144,\"driverVersion\":\"595.91.07\",\"memoryModel\":\"dedicated\"}";
const GOLDEN_STATUS_KEYS_READY = ["eligible", "mode", "assurance", "daemonStatus", "serverDefault", "mpsGeneration", "memoryModel", "name", "deviceUuid", "driverVersion", "deviceMemoryBytes", "wiringFingerprint", "pendingClients", "clientsPending"];

test('HU.dedicated-golden', () => {
    assert.equal(content.length, 14);
    assert.equal(crypto.createHash('sha256').update(content).digest('hex'), goldenSha);
    const facts = parseMpsGpuObservation(dedicatedLine);
    assert.equal(JSON.stringify(facts), GOLDEN_FACTS_JSON);
    // A-P-6a
    const share = resolveMpsShare({ smPercent: 25, vramPercent: 50 }, facts, { grant: goldenGrant, fsApi });
    assert.equal(JSON.stringify(share), GOLDEN_SHARE_JSON);
    // A-P-6b
    const resolved = resolveEffectiveLimits({ declared: { cpus: '2', memory: '4g', pidsLimit: 512 } });
    assert.equal(limitsHash({ resolved, placement: AGENT_PLACEMENT, hardSwap: true, gpu: share }), GOLDEN_HASH);
    // A-P-6c: the status payload, both from the parsed facts and from the real two-query observation of the same GPU.
    const ready = { status: 'ready', daemonGeneration: 'daemon1', configurationGeneration: 'config1', serverDefault: { smPercent: 50, memoryMiB: 4096, shareMemoryMiB: 3500, deviceUuid: facts.uuid, driverVersion: facts.driverVersion, wiringFingerprint: 'wiring' }, pendingClients: [{ key: 'alias', instanceId: 'i', enableGeneration: 'g', secret: 'omit' }] };
    const backend = { observe: () => ({ state: 'owned' }), verify: () => true };
    const observed = () => observeMpsGpu({ query: smi(ok(`${dedicatedLine}\n`), ok('0x252010DE, None\n')) });
    const observedNoDevice = () => observeMpsGpu({ query: smi(ok(`${dedicatedLine}\n`), { status: 1, stdout: '', stderr: 'unsupported' }) });
    for (const observeGpu of [() => facts, observed, observedNoDevice]) {
        const mk = (state) => readMpsStatus({ readGrant: () => goldenGrant, observeGpu, readState: () => state, backend });
        const status = mk(ready), stopped = mk(null);
        assert.equal(JSON.stringify(status), GOLDEN_STATUS_READY_JSON);
        assert.equal(JSON.stringify(stopped), GOLDEN_STATUS_STOPPED_JSON);
        assert.deepEqual(Object.keys(status), GOLDEN_STATUS_KEYS_READY);
        assert.deepEqual(Object.getOwnPropertyNames(status).filter((key) => !Object.keys(status).includes(key)), ['facts', 'grant']);
        assert.equal(status.grant, goldenGrant);
        // Runtime path: status.facts into resolveMpsShare (resolve.mjs), and through resolveStoredGpuShare.
        const policy = { smPercent: 25, vramPercent: 50 };
        const viaFacts = resolveMpsShare(policy, status.facts, { grant: status.grant, fsApi });
        const viaStored = resolveStoredGpuShare(policy, { ...status, facts: status.facts, grant: status.grant, fsApi }, 'demo/worker');
        for (const runtimeShare of [viaFacts, viaStored]) {
            assert.equal(JSON.stringify(runtimeShare), GOLDEN_SHARE_JSON);
            assert.equal(limitsHash({ resolved, placement: AGENT_PLACEMENT, hardSwap: true, gpu: runtimeShare }), GOLDEN_HASH);
        }
    }
});

test('HU.schema-v1-behaviour', () => {
    // An entry carrying a Phase 2 key is refused by the exact-key check.
    assert.throws(() => validateAgentEntry({ gpu: { smPercent: 25, vramPercent: 25, basis: 'unified-pool' } }), (error) => error.code === 'store_unreadable' && /basis|unsupported|key/i.test(error.message));
    const document = (agents, extra = {}) => ({ schema: STORE_SCHEMA, instance: 'ploinky-box-demo-0123456789ab', storeId: 'b'.repeat(32), epoch: 'c'.repeat(32), revision: 1, updatedAt: '2026-10-01T00:00:00.000Z', agents, auditOutbox: null, auditReceipt: null, ...extra });
    assert.throws(() => validateStoreDocument(document({ 'demo/worker': { gpu: { smPercent: 25, vramPercent: 25, basis: 'unified-pool' } } })), (error) => error.code === 'store_unreadable');
    assert.throws(() => validateStoreDocument(document({}, { schema: 'ploinky.hardware-limits/v2' })), (error) => error.code === 'store_unreadable' && /unsupported schema/.test(error.message));
    // A v1 document with a plain GPU share reads back identically.
    const v1 = document({ 'demo/worker': { cpus: 1, memoryPercent: 50, gpu: { smPercent: 25, vramPercent: 25 } } });
    const before = JSON.stringify(v1);
    const read = validateStoreDocument(v1);
    assert.equal(read.document.schema, 'ploinky.hardware-limits/v1');
    assert.deepEqual(read.agents.get('demo/worker'), { cpus: 1, memoryPercent: 50, gpu: { smPercent: 25, vramPercent: 25 } });
    assert.equal(JSON.stringify(v1), before);
    assert.deepEqual(validateAgentEntry({ gpu: { smPercent: 25, vramPercent: 25 } }), { gpu: { smPercent: 25, vramPercent: 25 } });
});
