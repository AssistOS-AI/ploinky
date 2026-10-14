import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MpsError, UNIFIED_ALLOCATION_KINDS, UNIFIED_SHARE_QUALIFIED, classifyGpuFacts, classifyGpuMemoryModel, observeMpsGpu, parseMpsGpuObservation, resolveMpsShare, unifiedShareQualified } from '../../cli/sandbox/hardwareLimits/mpsEligibility.mjs';
import { inspectMpsTargetEligibility, readMpsStatus } from '../../cli/sandbox/hardwareLimits/mpsStatus.mjs';
import { mpsClientArgs, mpsClientEnvironment, mpsServerDefaultMemoryMiB, parseMpsMemoryReply } from '../../cli/sandbox/hardwareLimits/mps.mjs';
import { isDeepStrictEqual } from 'node:util';
import { planMpsTransition, resolveMpsServerDefault } from '../../cli/sandbox/hardwareLimits/mpsTransition.mjs';
import { limitsHash, resolveEffectiveLimits, resolveStoredOverride, resolveStoredGpuShare, AGENT_PLACEMENT } from '../../cli/sandbox/hardwareLimits/resolve.mjs';
import { HARDWARE_HELP, hardwareHttpError, qualifyHardwareGpuTarget } from '../../cli/server/authHandlers/hardwareLimitsRoutes.mjs';
import { STORE_SCHEMA, validateStoreDocument, validateAgentEntry, validateAgentLimits } from '../../cli/sandbox/hardwareLimits/store.mjs';

const UUID = 'GPU-12345678-1234-1234-1234-123456789012';
const FIX = 'Clear the GPU share. CPU/RAM controls remain separately available.';
const GB10_PCI = '0x2E1210DE';
const Q10_SENTENCE = 'On the qualified GB10 (driver 580.178.04) a GPU memory share is a best-effort, per-CUDA-process MPS limit on cudaMalloc and managed memory, measured at a 1 GiB limit; managed memory also counts against the RAM limit, and pinned-host and ATS memory count only against the RAM limit.';
const driverReason = (driver) => `GPU sharing is not qualified on this GB10 driver: it is qualified only for NVIDIA driver 580.178.04, and this host runs ${driver}.`;
const Q2_SENTENCE = 'On unified-memory NVIDIA GPUs (GB10 / DGX Spark) a RAM limit does not cap the GPU device memory (cudaMalloc) an agent allocates, such as llama.cpp\'s model buffers; only the agent\'s own admission check keeps that memory within the budget, and an overrun takes memory from the whole host, which has no separate GPU memory. Managed, pinned-host and ATS allocations are charged to the RAM limit (measured on driver 580.178.04).';
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
    // Driver 580.95.05 is not the qualified driver: the PCI-identified GB10 gets the driver refusal (I3), not the name text.
    assert.equal(status.reason, `${driverReason('580.95.05')} ${FIX}`);
    assert.equal(status.code, 'gpu_sharing_unavailable');
    // Without the PCI id the same name is a different story: unknown, with the unchanged name text.
    const nameOnly = refusal(() => observeMpsGpu({ query: smi(ok(`${line('NVIDIA DGX Spark', '[N/A]')}\n`), { status: 1, stdout: '' }) }));
    assert.equal(nameOnly.memoryModel, 'unknown'); assert.equal(nameOnly.reason, reasonFor('NVIDIA DGX Spark'));
    // The PCI id compares case-insensitively.
    assert.equal(classifyGpuFacts({ name: 'x', pciDeviceId: '0x2e1210de' }), 'unified');
});

test('HU.unified-disclosure-payload', () => {
    // A GB10 identified by name alone (no PCI id) keeps the unified text of the Phase 1 refusal.
    const status = refusal(() => parseMpsGpuObservation(line('NVIDIA GB10')));
    assert.equal(status.memoryModel, 'unified');
    assert.deepEqual(status.unifiedMemory, { ramLimitCoversGpuAllocations: false, gpuMemoryBound: 'admission-only', assurance: 'advisory' });
    assert.equal(status.reason, reasonFor('NVIDIA GB10'));
    // The PCI-identified GB10 on another driver carries the same disclosure, with the driver text.
    const byPci = refusal(() => parseMpsGpuObservation(line('NVIDIA GB10'), `${GB10_PCI}, ATS\n`));
    assert.deepEqual(byPci.unifiedMemory, status.unifiedMemory);
    assert.equal(byPci.reason, `${driverReason('580.95.05')} ${FIX}`);
    assert.ok(HARDWARE_HELP.gpu.includes(Q2_SENTENCE));
    // Phase 2 appends one sentence after the Phase 1 sentence (it does not replace it).
    assert.equal(HARDWARE_HELP.gpu[HARDWARE_HELP.gpu.length - 2], Q2_SENTENCE);
    assert.equal(HARDWARE_HELP.gpu[HARDWARE_HELP.gpu.length - 1], Q10_SENTENCE);
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

// ---------------------------------------------------------------------------------------------------------------
// Phase 2 (P2-P): GPU memory shares on the qualified unified GPU (GB10, PCI 0x2E1210DE, driver 580.178.04).
// ---------------------------------------------------------------------------------------------------------------
const MIB = 1048576;
const QUALIFIED_DRIVER = '580.178.04';
const ENVELOPE_BYTES = 128450985984;
const qualifiedText = `${line('NVIDIA GB10', '[N/A]', QUALIFIED_DRIVER)}\n`;
const qualifiedObserve = () => observeMpsGpu({ query: smi(ok(qualifiedText), ok(`${GB10_PCI}, ATS\n`)) });
const qualifiedStatus = (envelope = { memoryBytes: ENVELOPE_BYTES, cpus: 20 }, extra = {}) => readMpsStatus({ readGrant: () => goldenGrant, observeGpu: qualifiedObserve, readState: () => null, envelope, ...extra });
const qualifiedFacts = () => parseMpsGpuObservation(qualifiedText.trim(), `${GB10_PCI}, ATS\n`);
const KINDS_LITERAL = [
    { kind: 'device', apis: ['cudaMalloc', 'cuMemAlloc'], ramLimit: false, gpuShare: true },
    { kind: 'managed', apis: ['cudaMallocManaged'], ramLimit: true, gpuShare: true },
    { kind: 'pinned-host', apis: ['cudaHostAlloc', 'cuMemHostAlloc'], ramLimit: true, gpuShare: false },
    { kind: 'pageable', apis: ['malloc'], ramLimit: true, gpuShare: false },
];
const deepFrozen = (value) => Object.isFrozen(value) && (typeof value !== 'object' || value === null || Object.values(value).every(deepFrozen));

test('HU.qualified-observation', () => {
    const facts = qualifiedFacts();
    assert.equal(facts.memoryModel, 'unified');
    assert.equal(facts.memoryMiB, null);
    assert.equal(facts.unifiedShareQualified, true);
    assert.equal(facts.pciDeviceId, GB10_PCI);
    assert.equal(facts.driverVersion, QUALIFIED_DRIVER);
    // Through the real two-query observation, the PCI id compares case-insensitively and the driver is trimmed.
    const viaSmi = observeMpsGpu({ query: smi(ok(`0, ${UUID}, NVIDIA GB10, [N/A],  ${QUALIFIED_DRIVER} \n`), ok('0x2e1210de, ATS\n')) });
    assert.equal(viaSmi.unifiedShareQualified, true);
    // The name alone never qualifies: without the PCI id the GB10 is the unchanged unified refusal.
    const nameOnly = refusal(() => parseMpsGpuObservation(qualifiedText.trim()));
    assert.equal(nameOnly.reason, reasonFor('NVIDIA GB10')); assert.equal(nameOnly.hardwareSupport, 'unsupported');
    // A malformed UUID on the qualified tuple is a typed refusal, never a share.
    const badUuid = refusal(() => parseMpsGpuObservation('0, GPU-nope, NVIDIA GB10, [N/A], 580.178.04', `${GB10_PCI}, ATS\n`));
    assert.match(badUuid.reason, /GPU identity or dedicated memory is unknown/);
    assert.equal('unifiedShareQualified' in badUuid, false);
});

test('HU.unqualified-driver (A-P-11)', () => {
    for (const driver of ['580.159.03', '580.95.05', '581.0.1', '580.178.040']) {
        const status = refusal(() => parseMpsGpuObservation(line('NVIDIA GB10', '[N/A]', driver), `${GB10_PCI}, ATS\n`));
        assert.equal(status.reason, `${driverReason(driver)} ${FIX}`, driver);
        assert.equal(status.unsupportedReason, driverReason(driver));
        assert.equal(status.code, 'gpu_sharing_unavailable');
        assert.equal(status.hardwareSupport, 'unsupported');
        assert.equal(status.memoryModel, 'unified');
        assert.equal(status.driverVersion, driver);
        assert.equal(status.pciDeviceId, GB10_PCI);
        assert.deepEqual(status.unifiedMemory, { ramLimitCoversGpuAllocations: false, gpuMemoryBound: 'admission-only', assurance: 'advisory' });
        assert.match(status.reason, /not qualified/);
        // Admission (a stored share) and the store (a Save) refuse with the driver text.
        const resolved = resolveStoredOverride({ gpu: { smPercent: 25, vramPercent: 25 } }, { cpus: 8, memoryBytes: 8 * 1024 ** 3 }, { ref: 'demo/worker', gpu: status });
        assert.equal(resolved.problem.reason, driverReason(driver));
        assert.equal(resolved.problem.fix, FIX);
        assert.throws(() => validateAgentLimits({ agentRef: 'demo/worker', limits: { gpu: { smPercent: 25, vramPercent: 25 } }, installedRefs: new Set(['demo/worker']), capabilities: { gate: 'on', gpu: status } }),
            (error) => error.code === 'gpu_sharing_unavailable' && error.message === `${driverReason(driver)} ${FIX}`);
    }
    // A malformed driver string is not echoed: the unchanged name-based refusal.
    for (const driver of ['580.178.04-evil', '5801780', '580.178.04\u0007']) {
        const status = refusal(() => parseMpsGpuObservation(`0, ${UUID}, NVIDIA GB10, [N/A], ${driver}`, `${GB10_PCI}, ATS\n`));
        assert.equal(status.reason, reasonFor('NVIDIA GB10'), JSON.stringify(driver));
    }
    // Unified GPUs other than the qualified tuple keep their existing refusal text, qualified driver or not.
    for (const [name, pci] of [['NVIDIA GH200 480GB', '0x233010DE'], ['NVIDIA Jetson AGX Orin', null], ['NVIDIA GB200', null], ['NVIDIA GB10', null]]) {
        const status = refusal(() => parseMpsGpuObservation(line(name, '97871', QUALIFIED_DRIVER), pci ? `${pci}, ATS\n` : undefined));
        assert.equal(status.reason, reasonFor(name), name);
        assert.equal(status.hardwareSupport, 'unsupported', name);
        assert.equal('unsupportedReason' in status, false, name);
    }
});

test('HU.tuple-table (A-P-19)', () => {
    assert.deepEqual(UNIFIED_SHARE_QUALIFIED, [{ pciDeviceId: '0x2E1210DE', driverVersion: '580.178.04', evidenceRun: 'gb10p-20261014151531-013eff5b' }]);
    assert.ok(deepFrozen(UNIFIED_SHARE_QUALIFIED));
    assert.deepEqual(UNIFIED_ALLOCATION_KINDS, KINDS_LITERAL);
    assert.ok(deepFrozen(UNIFIED_ALLOCATION_KINDS));
    for (const facts of [{ pciDeviceId: '0x2E1210DE', driverVersion: '580.178.04' }, { pciDeviceId: '0x2e1210de', driverVersion: ' 580.178.04 ' }]) assert.equal(unifiedShareQualified(facts), true, JSON.stringify(facts));
    for (const facts of [
        { pciDeviceId: '0x2E1210DE', driverVersion: '580.159.03' }, { pciDeviceId: '0x2E1210DE', driverVersion: '580.95.05' },
        { pciDeviceId: '0x2E1210DE', driverVersion: '580.178.04.1' }, { pciDeviceId: '0x2E1210DE', driverVersion: '580' }, { pciDeviceId: '0x2E1210DE' },
        { pciDeviceId: '0x233010DE', driverVersion: '580.178.04' }, { pciDeviceId: '0x252010DE', driverVersion: '580.178.04' }, { pciDeviceId: null, driverVersion: '580.178.04' }, {}, undefined,
    ]) assert.equal(unifiedShareQualified(facts), false, JSON.stringify(facts));
});

test('HU.unified-eligible-payload (A-P-16)', () => {
    const status = qualifiedStatus();
    assert.equal(status.eligible, true); assert.equal(status.mode, 'mps-shared'); assert.equal(status.assurance, 'best-effort');
    assert.equal(status.memoryModel, 'unified');
    assert.equal(status.deviceMemoryBytes, null);
    assert.deepEqual(status.shareBasis, { kind: 'unified-pool', bytes: 122500 * MIB, source: 'box-envelope' });
    assert.equal(status.pciDeviceId, GB10_PCI); assert.equal(status.addressingMode, 'ATS'); assert.equal(status.driverVersion, QUALIFIED_DRIVER);
    assert.deepEqual(status.unifiedMemory, {
        ramLimitCoversGpuAllocations: false, gpuMemoryBound: 'mps-per-process', assurance: 'best-effort', enforcement: 'cooperative',
        qualification: { pciDeviceId: GB10_PCI, driverVersion: QUALIFIED_DRIVER, evidenceRun: 'gb10p-20261014151531-013eff5b' }, allocationKinds: KINDS_LITERAL,
    });
    assert.equal('hardwareSupport' in status, false);
    assert.equal(status.daemonStatus, 'stopped');
    // The payload serializes (no private fields) and the private facts stay non-enumerable.
    assert.equal(JSON.parse(JSON.stringify(status)).deviceMemoryBytes, null);
    assert.deepEqual(Object.getOwnPropertyNames(status).filter((key) => !Object.keys(status).includes(key)), ['facts', 'grant']);
    // The share basis follows the envelope, rounded down to whole MiB.
    assert.equal(qualifiedStatus({ memoryBytes: 40 * 1024 * MIB + 12345 }).shareBasis.bytes, 40 * 1024 * MIB);
    // A dedicated payload never carries unified keys (the A-P-6 goldens pin the rest).
    const dedicated = readMpsStatus({ readGrant: () => goldenGrant, observeGpu: () => observeMpsGpu({ query: smi(ok(`${dedicatedLine}\n`), ok('0x252010DE, None\n')) }), readState: () => null, envelope: { memoryBytes: ENVELOPE_BYTES } });
    for (const key of ['shareBasis', 'unifiedMemory', 'pciDeviceId', 'addressingMode', 'hardwareSupport']) assert.equal(key in dedicated, false, key);
    assert.equal(dedicated.deviceMemoryBytes, 6144 * MIB);
});

test('HU.qualified-null-envelope (A-P-15b, daemon status survives)', () => {
    for (const envelope of [null, {}, { memoryBytes: 0 }, { memoryBytes: 'x' }]) {
        const status = qualifiedStatus(envelope);
        assert.equal(status.eligible, false);
        assert.equal(status.memoryModel, 'unified');
        assert.equal(status.reason, 'Box memory envelope unknown');
        assert.equal(status.fix, 'Check the Box memory envelope with ploinky limits status, then retry.');
        assert.equal(status.code, 'gpu_sharing_unavailable');
        assert.equal('hardwareSupport' in status, false);
        assert.equal('shareBasis' in status, false);
    }
    // The container monitor and the reconcile verification call readMpsStatus() without an envelope and read only the
    // daemon generation: it must still be observed on the qualified GPU.
    const ready = { status: 'ready', daemonGeneration: 'daemon1', configurationGeneration: 'config1', serverDefault: { smPercent: 50, memoryMiB: 31744, shareMemoryMiB: 30625, deviceUuid: UUID, driverVersion: QUALIFIED_DRIVER, wiringFingerprint: 'wiring' } };
    const backend = { observe: () => ({ state: 'owned' }), verify: () => true };
    const noEnvelope = readMpsStatus({ readGrant: () => goldenGrant, observeGpu: qualifiedObserve, readState: () => ready, backend });
    assert.equal(noEnvelope.eligible, false);
    assert.equal(noEnvelope.daemonStatus, 'ready');
    assert.equal(noEnvelope.mpsGeneration, 'daemon1:config1');
    assert.equal(noEnvelope.reason, 'Box memory envelope unknown');
    const withEnvelope = readMpsStatus({ readGrant: () => goldenGrant, observeGpu: qualifiedObserve, readState: () => ready, backend, envelope: { memoryBytes: ENVELOPE_BYTES } });
    assert.equal(withEnvelope.mpsGeneration, 'daemon1:config1');
    assert.equal(withEnvelope.serverDefault.shareMemoryMiB, 30625);
});

test('HU.unified-share-bytes (A-P-8, A-P-9, A-P-10, A-P-10b)', () => {
    const status = qualifiedStatus();
    const policy = { smPercent: 25, vramPercent: 25 };
    const share = resolveMpsShare(policy, status.facts, { grant: status.grant, fsApi, poolMiB: status.shareBasis.bytes / MIB });
    assert.equal(share.memoryMiB, 30625); assert.equal(share.memoryBytes, 30625 * MIB); assert.equal(share.vramMiB, 30625);
    assert.equal(share.basis, 'unified-pool');
    assert.equal(share.deviceUuid, UUID); assert.equal(share.driverVersion, QUALIFIED_DRIVER); assert.equal(share.wiringFingerprint, 'wiring');
    // The store's Save-time bytes are the resolved share's bytes.
    const saved = validateAgentLimits({ agentRef: 'demo/worker', limits: { gpu: policy }, installedRefs: new Set(['demo/worker']), capabilities: { gate: 'on', gpu: status }, envelope: { cpus: 8, memoryBytes: ENVELOPE_BYTES } });
    assert.equal(saved.gpuBytes, share.memoryBytes);
    const env = mpsClientEnvironment(share, `/run/ploinky/mps/pipe-${'a'.repeat(32)}`);
    assert.equal(env.CUDA_MPS_PINNED_DEVICE_MEM_LIMIT, '0=30625M');
    assert.equal(env.CUDA_MPS_ACTIVE_THREAD_PERCENTAGE, '25');
    assert.deepEqual(Object.keys(env).sort(), ['CUDA_MPS_ACTIVE_THREAD_PERCENTAGE', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT', 'CUDA_MPS_PIPE_DIRECTORY']);
    // A-P-10: a 40 GiB envelope makes 1 % smaller than the 512 MiB minimum, both when resolving and when saving.
    const small = qualifiedStatus({ memoryBytes: 40 * 1024 * MIB });
    assert.throws(() => resolveMpsShare({ smPercent: 50, vramPercent: 1 }, small.facts, { grant: small.grant, fsApi, poolMiB: small.shareBasis.bytes / MIB }), (error) => error instanceof MpsError && /below the 512 MiB minimum/.test(error.message));
    assert.throws(() => validateAgentLimits({ agentRef: 'demo/worker', limits: { gpu: { smPercent: 50, vramPercent: 1 } }, installedRefs: new Set(['demo/worker']), capabilities: { gate: 'on', gpu: small } }),
        (error) => error.code === 'exceeds_envelope' && /below the 512 MiB minimum/.test(error.message));
    // A-P-10b: on the real envelope 1 % is accepted (1225 MiB).
    const one = resolveMpsShare({ smPercent: 50, vramPercent: 1 }, status.facts, { grant: status.grant, fsApi, poolMiB: status.shareBasis.bytes / MIB });
    assert.equal(one.memoryBytes, 1225 * MIB);
    assert.equal(validateAgentLimits({ agentRef: 'demo/worker', limits: { gpu: { smPercent: 50, vramPercent: 1 } }, installedRefs: new Set(['demo/worker']), capabilities: { gate: 'on', gpu: status } }).gpuBytes, 1225 * MIB);
    // The pool must be a known positive integer.
    for (const poolMiB of [undefined, 0, -1, 1.5, NaN]) assert.throws(() => resolveMpsShare(policy, status.facts, { grant: status.grant, fsApi, poolMiB }), { code: 'gpu_sharing_unavailable', message: 'The GPU memory basis is unknown.' });
    // A-P-18: the daemon default of one 30625 MiB share is 30720 MiB, and its `30G` readback parses to that.
    assert.equal(mpsServerDefaultMemoryMiB(30625), 30720);
    assert.equal(resolveMpsServerDefault([{ share }]).memoryMiB, 30720);
    assert.equal(parseMpsMemoryReply('30G'), 30720 * MIB);
});

test('HU.percent-check-precedes-the-model-branch (R6-4)', () => {
    const status = qualifiedStatus();
    const pool = status.shareBasis.bytes / MIB;
    for (const vramPercent of [0, 101, 1.5, '25', null]) {
        assert.throws(() => resolveMpsShare({ smPercent: 50, vramPercent }, status.facts, { grant: status.grant, fsApi, poolMiB: pool }),
            (error) => error instanceof MpsError && error.code === 'gpu_sharing_unavailable' && error.status === 409 && /integers in 1\.\.100/.test(error.message), String(vramPercent));
        // Even with an unknown pool the percentage message wins.
        assert.throws(() => resolveMpsShare({ smPercent: 50, vramPercent }, status.facts, { grant: status.grant, fsApi }), /integers in 1\.\.100/);
    }
    // Unified GPUs without the qualification flag still cannot resolve a share.
    assert.throws(() => resolveMpsShare({ smPercent: 50, vramPercent: 25 }, { ...status.facts, unifiedShareQualified: false }, { grant: status.grant, fsApi, poolMiB: pool }), /Dedicated GPU memory cannot be resolved/);
    assert.throws(() => resolveMpsShare({ smPercent: 50, vramPercent: 25 }, { ...status.facts, driverVersion: '580.159.03' }, { grant: status.grant, fsApi, poolMiB: pool }), /Dedicated GPU memory cannot be resolved/);
});

test('HU.mps-error-fix (R6-1)', () => {
    assert.equal('fix' in new MpsError('m'), false);
    assert.equal('fix' in new MpsError('m', 'image_preparation_required'), false);
    assert.equal('fix' in new MpsError('m', 'gpu_sharing_unavailable', {}), false);
    assert.equal('fix' in new MpsError('m', 'gpu_sharing_unavailable', { fix: '' }), false);
    assert.equal('fix' in new MpsError('m', 'gpu_sharing_unavailable', { fix: 7 }), false);
    const error = new MpsError('m', undefined, { fix: 'do this' });
    assert.equal(error.fix, 'do this'); assert.equal(error.code, 'gpu_sharing_unavailable'); assert.equal(error.status, 409);
    const two = new MpsError('m');
    assert.equal(two.code, 'gpu_sharing_unavailable'); assert.equal(two.status, 409); assert.equal(two.name, 'MpsError');
});

// The transient-failure statuses on a qualified GB10: observation succeeds, then daemon ownership fails (a), and the envelope is null (b).
const ownershipFailure = () => qualifiedStatus(undefined, { readState: () => ({ status: 'ready', daemonGeneration: 'd', configurationGeneration: 'c', serverDefault: {} }), backend: { observe: () => { throw new Error('daemon ownership is unknown'); }, verify: () => true } });
const GENERIC_FIX = 'Inspect GPU wiring and MPS tools, then retry.';
const ENVELOPE_FIX = 'Check the Box memory envelope with ploinky limits status, then retry.';
const ENVELOPE = { cpus: 8, memoryBytes: ENVELOPE_BYTES };

test('HU.transient-not-unsupported (A-P-15)', () => {
    const stored = { gpu: { smPercent: 25, vramPercent: 25 } };
    const cases = [['ownership', ownershipFailure(), /^GPU sharing facts or daemon ownership could not be verified/, GENERIC_FIX], ['null envelope', qualifiedStatus(null), /^Box memory envelope unknown$/, ENVELOPE_FIX]];
    for (const [label, status, reason, fix] of cases) {
        assert.equal(status.eligible, false, label);
        assert.equal(status.fix, fix, label);
        assert.equal('hardwareSupport' in status, false, label);
        // Admission: the status's own reason and remedy, never the §9.3 text or the "Clear the GPU share in Settings" fix.
        const problem = resolveStoredOverride(stored, ENVELOPE, { ref: 'demo/worker', gpu: status }).problem;
        assert.match(problem.reason, reason, label); assert.equal(problem.fix, fix, label);
        assert.doesNotMatch(problem.reason, /unsupported on this unified/, label);
        // The store (Save) path: the same reason, with the remedy carried on the error and in the HTTP body.
        let caught;
        try { validateAgentLimits({ agentRef: 'demo/worker', limits: stored, installedRefs: new Set(['demo/worker']), capabilities: { gate: 'on', gpu: status } }); } catch (error) { caught = error; }
        assert.ok(caught, label);
        assert.equal(caught.code, 'gpu_sharing_unavailable', label); assert.equal(caught.message, status.reason, label); assert.equal(caught.fix, fix, label);
        assert.doesNotMatch(caught.message, /unsupported on this unified/, label);
        const body = hardwareHttpError(caught).body;
        assert.equal(body.error, 'gpu_sharing_unavailable'); assert.equal(body.message, status.reason); assert.equal(body.fix, fix);
    }
    // A missing grant has no status fix and keeps the "Clear the GPU share" remedy (as before).
    const ready = qualifiedStatus();
    const missing = resolveStoredOverride(stored, ENVELOPE, { ref: 'demo/other', gpu: ready }).problem;
    assert.equal(missing.reason, 'This agent has no active, qualified Box GPU grant.');
    assert.match(missing.fix, /^Clear the GPU share in Settings, or run ploinky limits clear --agent demo\/other on the host/);
    // A definite refusal keeps the §9.3 pair.
    const gh200 = refusal(() => parseMpsGpuObservation(line('NVIDIA GH200 480GB', '97871', QUALIFIED_DRIVER), '0x233010DE, ATS\n'));
    const refused = resolveStoredOverride(stored, ENVELOPE, { ref: 'demo/worker', gpu: gh200 }).problem;
    assert.equal(refused.reason, reasonFor('NVIDIA GH200 480GB').slice(0, -(FIX.length + 1))); assert.equal(refused.fix, FIX);
    // A dedicated status failure after a successful observation now also keeps the status's own remedy.
    const dedicatedFailure = readMpsStatus({ readGrant: () => goldenGrant, observeGpu: () => parseMpsGpuObservation(dedicatedLine), readState: () => ({ status: 'ready', daemonGeneration: 'd', configurationGeneration: 'c', serverDefault: {} }), backend: { observe: () => { throw new Error('boom'); } } });
    const dedicatedProblem = resolveStoredOverride(stored, ENVELOPE, { ref: 'demo/worker', gpu: dedicatedFailure }).problem;
    assert.equal(dedicatedProblem.fix, GENERIC_FIX);
});

test('HU.qualified-unified-failure-reasons (A-P-13)', () => {
    const stored = { gpu: { smPercent: 25, vramPercent: 25 } };
    const ok1 = qualifiedStatus();
    const withFs = (status, api = fsApi) => ({ ...status, facts: status.facts, grant: status.grant, fsApi: api });
    // The resolved share through resolveStoredOverride and the status pool.
    const resolved = resolveStoredOverride(stored, ENVELOPE, { ref: 'demo/worker', gpu: withFs(ok1) });
    assert.equal(resolved.problem, null);
    assert.equal(resolved.gpu.memoryMiB, 30625); assert.equal(resolved.gpu.basis, 'unified-pool');
    const sinks = [];
    // (a) the agent is not in the grant.
    sinks.push(['a', resolveStoredOverride(stored, ENVELOPE, { ref: 'demo/missing', gpu: withFs(ok1) }).problem, 'This agent has no active, qualified Box GPU grant.']);
    // (b) the envelope shrinks until 25 percent is under the 512 MiB minimum.
    const tiny = qualifiedStatus({ memoryBytes: 1024 * MIB });
    sinks.push(['b', resolveStoredOverride(stored, ENVELOPE, { ref: 'demo/worker', gpu: withFs(tiny) }).problem, /below the 512 MiB minimum/]);
    // (c) revalidating the MPS tools throws.
    const throwingFs = { ...fsApi, realpathSync: () => { throw new Error('tool vanished'); } };
    sinks.push(['c', resolveStoredOverride(stored, ENVELOPE, { ref: 'demo/worker', gpu: withFs(ok1, throwingFs) }).problem, /tool vanished|MPS/]);
    for (const [label, problem, expected] of sinks) {
        assert.ok(problem, label);
        if (typeof expected === 'string') assert.equal(problem.reason, expected, label); else assert.match(problem.reason, expected, label);
        assert.doesNotMatch(problem.reason, /^GPU sharing is unsupported on this unified/, label);
        assert.notEqual(problem.fix, UNSUPPORTED_FIX_TEXT, label);
    }
});
const UNSUPPORTED_FIX_TEXT = FIX;

test('HU.save-path-qualified (A-P-14)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-unified-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ container: 'prepared:image', start: 'sleep infinity' }));
    const agent = { ref: 'demo/worker', manifestPath };
    const inspectImage = () => [{ Id: `sha256:${'a'.repeat(64)}`, Config: { User: '1000:1000' } }];
    // The real inspectMpsTargetEligibility, with the marker and the tool revalidation seams injected.
    const qualify = (input, deps) => inspectMpsTargetEligibility(input, { ...deps, readGrant: () => goldenGrant, fsApi });
    const save = (status, gpuShare) => qualifyHardwareGpuTarget(agent, [], { gpu: status, identity: { workspaceRoot: root } }, { gpu: gpuShare }, { inspectImage, qualify });
    const accepted = save(qualifiedStatus(), { smPercent: 50, vramPercent: 25 });
    assert.equal(accepted.share.memoryMiB, 30625); assert.equal(accepted.share.basis, 'unified-pool');
    assert.equal(accepted.share.smPercent, 50);
    assert.equal(accepted.imageId, `sha256:${'a'.repeat(64)}`);
    // Out-of-range percentages refuse on the percentage check, as a typed 409, before any store write.
    for (const vramPercent of [0, 101]) {
        let caught;
        try { save(qualifiedStatus(), { smPercent: 50, vramPercent }); } catch (error) { caught = error; }
        assert.ok(caught, String(vramPercent));
        const response = hardwareHttpError(caught);
        assert.equal(response.status, 409); assert.equal(response.body.error, 'gpu_sharing_unavailable'); assert.match(response.body.message, /integers in 1\.\.100/);
    }
    // An unqualified driver is refused with the driver text (no image inspected).
    const unqualified = refusal(() => parseMpsGpuObservation(line('NVIDIA GB10', '[N/A]', '580.159.03'), `${GB10_PCI}, ATS\n`));
    let refused;
    try { qualifyHardwareGpuTarget(agent, [], { gpu: unqualified, identity: { workspaceRoot: root } }, { gpu: { smPercent: 50, vramPercent: 25 } }, { inspectImage: () => assert.fail('a refused driver never inspects an image'), qualify }); } catch (error) { refused = error; }
    assert.equal(hardwareHttpError(refused).body.error, 'gpu_sharing_unavailable');
    assert.equal(hardwareHttpError(refused).body.message, `${driverReason('580.159.03')} ${FIX}`);
    // A transient failure carries its fix through the HTTP body.
    let transient;
    try { save(qualifiedStatus(null), { smPercent: 50, vramPercent: 25 }); } catch (error) { transient = error; }
    const transientBody = hardwareHttpError(transient).body;
    assert.equal(transientBody.message, 'Box memory envelope unknown'); assert.equal(transientBody.fix, ENVELOPE_FIX);
    // A status without its private facts is refused rather than rebuilt.
    const stripped = { ...qualifiedStatus() };
    assert.equal('facts' in stripped, false);
    assert.throws(() => qualify({ image: 'prepared:image', networkMode: 'default', agentRef: 'demo/worker', gpuShare: { smPercent: 50, vramPercent: 25 }, workspaceRoot: root, status: stripped }, { inspectImage }), { code: 'gpu_sharing_unavailable', message: /facts are unavailable/ });
    // The dedicated GPU through the same path: the share equals the frozen golden.
    const dedicatedStatus = readMpsStatus({ readGrant: () => goldenGrant, observeGpu: () => parseMpsGpuObservation(dedicatedLine), readState: () => null, envelope: { memoryBytes: ENVELOPE_BYTES } });
    const dedicated = save(dedicatedStatus, { smPercent: 25, vramPercent: 50 });
    assert.equal(JSON.stringify(dedicated.share), GOLDEN_SHARE_JSON);
    assert.equal('basis' in dedicated.share, false);
});

test('HU.store-model-guard (I1)', () => {
    const base = { agentRef: 'demo/worker', installedRefs: new Set(['demo/worker']), envelope: ENVELOPE };
    const save = (gpu, share = { smPercent: 50, vramPercent: 25 }) => validateAgentLimits({ ...base, limits: { gpu: share }, capabilities: { gate: 'on', gpu } });
    const qualified = qualifiedStatus();
    assert.equal(save(qualified).gpuBytes, 30625 * MIB);
    // Unified or unknown without the unified-pool basis stays refused (the Phase 1 vectors), with the model text.
    for (const gpu of [{ eligible: true, memoryModel: 'unified', name: 'NVIDIA GB10', deviceMemoryBytes: 128 * 1024 * MIB }, { eligible: true, memoryModel: 'unknown', deviceMemoryBytes: 8 * 1024 * MIB }, { eligible: true, name: 'x', deviceMemoryBytes: 8 * 1024 * MIB }]) {
        assert.throws(() => save(gpu), (error) => error.code === 'gpu_sharing_unavailable' && /^GPU sharing is unsupported on this unified or unverified GPU memory model: /.test(error.message), JSON.stringify(gpu));
    }
    // An unsupported marker refuses even an otherwise eligible-looking status.
    assert.throws(() => save({ ...qualified, hardwareSupport: 'unsupported' }), { code: 'gpu_sharing_unavailable' });
    // A non-eligible status keeps its own message (the guard sits after the eligible check).
    assert.throws(() => save({ eligible: false, memoryModel: 'unified', name: 'NVIDIA GB10', reason: 'its own reason', code: 'gpu_sharing_unavailable' }), { message: 'its own reason' });
    // The unified basis must be a positive safe integer.
    for (const bytes of [0, -1, 1.5, '1', null]) assert.throws(() => save({ ...qualified, shareBasis: { kind: 'unified-pool', bytes } }), { code: 'gpu_sharing_unavailable', message: 'The GPU memory basis is unknown.' });
    // Dedicated is unchanged, including its message and rounding.
    assert.throws(() => save({ eligible: true, memoryModel: 'dedicated', deviceMemoryBytes: null }), { message: 'The GPU device memory is unknown.' });
    assert.equal(save({ eligible: true, memoryModel: 'dedicated', deviceMemoryBytes: 6144 * MIB + 5 }, { smPercent: 50, vramPercent: 50 }).gpuBytes, 3072 * MIB);
});

test('HU.help-coupling (A-P-17, ploinky half)', () => {
    assert.equal(HARDWARE_HELP.gpu.filter((sentence) => sentence === Q10_SENTENCE).length, 1);
    assert.equal(HARDWARE_HELP.gpu[HARDWARE_HELP.gpu.length - 1], Q10_SENTENCE);
    // The Phase 1 sentence stays, unchanged, on every host.
    assert.equal(HARDWARE_HELP.gpu[HARDWARE_HELP.gpu.length - 2], Q2_SENTENCE);
    assert.ok(Object.isFrozen(HARDWARE_HELP));
});

test('HU.unified-share-survives-apply-and-launch (A-P-18b)', () => {
    // The unified share carries one extra key (basis). Past Save it must survive the transition plan, a JSON round trip
    // (the applied observation), the exact-share comparison and the client launch arguments unchanged.
    const status = qualifiedStatus();
    const share = resolveMpsShare({ smPercent: 25, vramPercent: 25 }, status.facts, { grant: status.grant, fsApi, poolMiB: status.shareBasis.bytes / MIB });
    assert.deepEqual(Object.keys(share), ['smPercent', 'vramPercent', 'vramMiB', 'memoryMiB', 'memoryBytes', 'deviceUuid', 'driverVersion', 'wiringFingerprint', 'basis']);
    const client = { key: 'demo/worker', ref: 'demo/worker', instanceId: 'instance', enableGeneration: 'generation', containerId: 'a'.repeat(64), share };
    const plan = planMpsTransition({ desiredClients: [client], configuredPolicies: [{ share }], selectedKeys: ['demo/worker'] });
    assert.ok(plan);
    assert.equal(isDeepStrictEqual(JSON.parse(JSON.stringify(share)), share), true);
    const serverDefault = resolveMpsServerDefault([{ share }]);
    assert.deepEqual({ smPercent: serverDefault.smPercent, memoryMiB: serverDefault.memoryMiB, shareMemoryMiB: serverDefault.shareMemoryMiB }, { smPercent: 25, memoryMiB: 30720, shareMemoryMiB: 30625 });
    const pipeDirectory = `/run/ploinky/mps/pipe-${'b'.repeat(32)}`;
    const args = mpsClientArgs(share, { status: 'ready', daemonGeneration: 'daemon1', configurationGeneration: 'config1', pipeDirectory });
    const envFlags = args.flatMap((value, index) => (args[index - 1] === '--env' ? [value] : []));
    assert.deepEqual(envFlags, ['CUDA_MPS_PIPE_DIRECTORY=/run/ploinky-mps-pipe', 'CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=25', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT=0=30625M']);
});
