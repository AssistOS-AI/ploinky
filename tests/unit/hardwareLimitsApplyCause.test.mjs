import assert from 'node:assert/strict';
import test from 'node:test';
import { applyHardwareLimits, reconcileExactHardwareInstance, captureExactHardwareInstances } from '../../cli/sandbox/hardwareLimits/reconcile.mjs';
import { coordinateMpsLifecycle } from '../../cli/sandbox/hardwareLimits/mpsLifecycle.mjs';
import { readMpsLaunch, createMpsLaunch } from '../../cli/sandbox/hardwareLimits/mpsLaunch.mjs';
import { createMpsDaemonBackend, runMpsControl } from '../../cli/sandbox/hardwareLimits/mps.mjs';
import { MpsError } from '../../cli/sandbox/hardwareLimits/mpsEligibility.mjs';
import { describeApplyCause, formatApplyCause, inApplyStep, markApplyStep } from '../../cli/sandbox/hardwareLimits/applyCause.mjs';
import { describeMpsTool, MPS_TOOL_PATHS } from '../../ploinky-box/lib/mpsTools.mjs';

const GENERIC_FIX = 'This exact instance was not applied. Reload its state and retry.';
const token = { epoch: 'e'.repeat(32), revision: 1 };
const imageId = 'a'.repeat(64);
const share = { smPercent: 25, vramPercent: 25, vramMiB: 1024, memoryMiB: 1024, memoryBytes: 1024 ** 3, deviceUuid: 'GPU-fixture', driverVersion: '550.1', wiringFingerprint: 'wiring' };
const serverDefault = (value) => ({ smPercent: value.smPercent, memoryMiB: value.memoryMiB, deviceUuid: value.deviceUuid, driverVersion: value.driverVersion, wiringFingerprint: value.wiringFingerprint });
const daemonState = (value = share, generation = 'old') => ({ schema: 1, status: 'ready', daemon: { pid: 123 }, daemonGeneration: generation, configurationGeneration: 'config', pipeDirectory: `/run/ploinky/mps/pipe-${'a'.repeat(32)}`, serverDefault: serverDefault(value), pendingClients: [] });
const clone = (value) => structuredClone(value);

// A product Apply of one exact instance that reaches the real MPS lifecycle. Only the engine, the daemon, the
// registry and the routes are fakes; `fail` names the injected failing step.
function world({ old = false, nextShare = share, fail = {}, tools = {}, backendStart = null } = {}) {
    const capability = {};
    const record = { type: 'agent', repoName: 'demo', agentName: 'a', instanceId: 'i-a', enableGeneration: 'g-a', containerId: 'b'.repeat(64) };
    const registry = { a: record };
    let state = old ? daemonState() : null;
    const make = (name) => { if (fail[name]) throw fail[name](); };
    const dependencies = {
        observeClients: () => { make('inventory'); return []; },
        readContext: () => ({ storeToken: token, overrides: new Map([['demo/a', { gpu: nextShare }]]), gpu: { eligible: true, grant: { mps: tools } } }),
        loadRegistry: () => registry,
        readApplied: () => (old ? { instanceId: record.instanceId, enableGeneration: record.enableGeneration, gpuShare: share, mpsGeneration: 'old:config' } : null),
        loadPlan: () => ({ runtime: 'podman', manifest: {}, profile: { network: { mode: 'default' } }, image: 'prepared:tag' }),
        prepareImage: () => make('image'), inspectImage: () => ({ Id: imageId, Config: { User: '1000:1000' } }),
        resolveShare: (policy) => policy, policyCheck: () => {},
        store: { read: () => clone(state), write: (value) => { state = clone(value); } },
        backend: {
            observe: () => ({ state: state?.daemon ? 'owned' : 'gone', daemon: state?.daemon }), verify: () => true,
            stop: () => make('stop'), cleanup: () => {},
            start: backendStart || ((value) => { make('start'); return daemonState(value, 'new'); }),
        },
        network: async (fn) => fn(capability), assertCapability: () => {},
        drainClient: async () => make('drain'),
    };
    const launchTarget = async (next) => { make('launch'); readMpsLaunch(next.mpsLaunch, 'a', nextShare); return { containerName: 'a', containerId: 'c'.repeat(64) }; };
    const apply = () => applyHardwareLimits({ expectedToken: token, containers: ['a'] }, {
        lease: (_options, callback) => callback(), loadRegistry: () => clone(registry), loadRouting: () => ({ routes: {} }), readPolicy: () => ({ token }), policyCheck: () => {},
        loadPlan: () => ({}), isUnchanged: () => false,
        reconcile: (instance, options) => coordinateMpsLifecycle({ target: { key: instance.key, record: clone(registry[instance.key]) }, options: { onMpsPlan: options.onMpsPlan, onMpsResult: options.onMpsResult }, launchTarget }, dependencies),
    });
    return { apply, get state() { return state; } };
}

test('AC.the-first-share-names-each-failing-step-with-class-code-message-and-the-generic-fix', async () => {
    const plain = (message, name = 'Error') => () => Object.assign(new Error(message), { name });
    for (const [label, options, step] of [
        ['image preparation', { fail: { image: plain('pull failed: registry unreachable', 'PullError') } }, 'image-preparation'],
        ['client inventory', { fail: { inventory: plain('podman ps failed') } }, 'client-inventory'],
        ['daemon start', { fail: { start: plain('spawn nvidia-cuda-mps-control EPERM', 'SpawnError') } }, 'daemon-start'],
        ['client launch', { fail: { launch: plain('podman create failed: invalid mount') } }, 'client-launch'],
        ['drain', { old: true, nextShare: { ...share, smPercent: 50 }, fail: { drain: plain('podman stop timed out') } }, 'drain'],
        ['daemon stop', { old: true, nextShare: { ...share, smPercent: 50 }, fail: { stop: plain('quit refused') } }, 'daemon-stop'],
    ]) {
        const f = world(options);
        const result = await f.apply();
        assert.equal(result.ok, false, label);
        assert.equal(result.status, 409, label);
        assert.equal(result.error, 'apply_failed', label);
        const entry = result.results[0];
        assert.equal(entry.state, 'pending', label);
        assert.equal(entry.problem, null, label);
        assert.equal(entry.cause.step, step, `${label}: ${JSON.stringify(entry.cause)}`);
        assert.equal(entry.cause.errorClass, label === 'image preparation' ? 'PullError' : label === 'daemon start' ? 'SpawnError' : 'Error', label);
        assert.equal(entry.cause.code, null, label);
        assert.match(entry.message, new RegExp(`^Apply stopped at ${step}: `), label);
        assert.equal(entry.fix, GENERIC_FIX, `${label}: the generic text stays the fix hint`);
        assert.deepEqual(result.cause, entry.cause, `${label}: the response carries the cause too`);
        assert.equal(result.message, entry.message, label);
        assert.equal(JSON.stringify(result.cause).length < 700, true, `${label}: bounded`);
    }
});

test('AC.a-failed-transition-journals-its-cause-beside-the-generic-problem', async () => {
    const f = world({ fail: { start: () => Object.assign(new Error('spawn failed'), { code: 'EACCES' }) } });
    const result = await f.apply();
    assert.equal(result.error, 'EACCES');
    assert.equal(f.state.status, 'pending');
    assert.match(f.state.lastProblem.message, /^MPS transition is incomplete/);
    assert.deepEqual({ ...f.state.lastProblem.cause }, { step: 'daemon-start', errorClass: 'Error', code: 'EACCES', message: 'spawn failed' });
});

test('AC.the-cause-is-bounded-and-never-carries-a-secret', async () => {
    const secret = ['password=hunter2', 'Authorization: Bearer abcdefghijklmnop', 'token: s3cr3tvalue', 'https://user:pw123@registry.example/v2', `eyJhbGciOiJIUzI1NiJ9.${'x'.repeat(30)}.${'y'.repeat(30)}`];
    const f = world({ fail: { launch: () => new Error(`${secret.join(' | ')}\n${'z'.repeat(5000)}`) } });
    const result = await f.apply();
    const text = JSON.stringify(result);
    for (const value of ['hunter2', 'abcdefghijklmnop', 's3cr3tvalue', 'pw123', 'eyJhbGciOiJIUzI1NiJ9']) assert.equal(text.includes(value), false, `${value} leaked: ${text.slice(0, 300)}`);
    assert.ok(result.cause.message.length <= 400, `bounded: ${result.cause.message.length}`);
    assert.equal(/[\u0000-\u001f]/.test(result.cause.message), false);
});

test('AC.a-typed-hardware-refusal-keeps-its-own-reason-and-gets-no-cause', async () => {
    const f = world({ fail: { start: () => new MpsError('GPU defaults cannot be applied') } });
    const result = await f.apply();
    assert.equal(result.status, 422, JSON.stringify(result));
    assert.equal(result.results[0].problem.reasonCode, 'gpu_sharing_unavailable');
    assert.match(result.results[0].problem.reason, /GPU defaults cannot be applied/);
    assert.equal(result.results[0].cause, undefined);
});

// The product reconcile of one exact instance (not the MPS lifecycle): the steps after the lifecycle.
function reconcileWorld({ ensure, readiness = async () => {}, activate = async () => {}, gpu = false, mpsReadiness = null } = {}) {
    const record = { type: 'agent', repoName: 'demo', agentName: 'worker', alias: '', instanceId: 'instance-1', enableGeneration: 'generation-1', containerId: 'a'.repeat(64) };
    const registry = { exact: record };
    const created = { containerName: 'exact', containerId: 'd'.repeat(64), registryRecord: record, ...(mpsReadiness ? { mpsReadiness } : {}) };
    const dependencies = {
        loadRegistry: () => registry, loadRouting: () => ({}), readPolicy: () => ({ token }), policyCheck: () => ({ token }),
        loadPlan: () => ({ runtime: 'podman', profileResolution: {}, manifest: {}, agentPath: '/fixture', routerEndpoint: null, runtimeAdmission: { descriptor: { hardwareGpu: gpu ? share : null } } }),
        maintenance: async (_key, _options, callback) => callback(), network: async (callback) => callback({}),
        ensure: ensure || (() => created), readiness, activate,
    };
    return { run: (extra = {}, launchOptions = {}) => applyHardwareLimits({ expectedToken: token, containers: ['exact'] }, {
        lease: (_options, callback) => callback(), loadRegistry: () => registry, loadRouting: () => ({ routes: {} }), readPolicy: () => ({ token }), policyCheck: () => {},
        loadPlan: () => ({}), isUnchanged: () => false,
        reconcile: (instance, options) => reconcileExactHardwareInstance(captureExactHardwareInstances(registry, [instance.key])[0], { ...options, origin: 'cli', ...launchOptions }, { ...dependencies, ...extra }),
    }), dependencies };
}

test('AC.the-product-reconcile-names-launch-readiness-and-activation', async () => {
    for (const [label, extra, gpu, step] of [
        ['runtime launch', { ensure: () => { throw new TypeError('create failed'); } }, false, 'runtime-launch'],
        ['client launch of a GPU share', { ensure: () => { throw new TypeError('create failed'); } }, true, 'client-launch'],
        ['readiness', { readiness: async () => { throw new Error('Readiness deadline expired.'); } }, false, 'readiness'],
        ['activation', { activate: async () => { throw new Error('route publication failed'); } }, false, 'activation'],
        ['planning', { loadPlan: () => { throw new Error('manifest unreadable'); } }, false, 'planning'],
    ]) {
        // A share client reaches the product reconcile through the lifecycle's launch capability.
        const mpsLaunch = gpu ? createMpsLaunch({ key: 'exact', share, state: { ...daemonState(), status: 'ready' }, imageId }) : null;
        const result = await reconcileWorld({ gpu }).run(extra, { mpsLaunch });
        assert.equal(result.error, 'apply_failed', label);
        assert.equal(result.results[0].cause.step, step, `${label}: ${JSON.stringify(result.results[0])}`);
        assert.match(result.results[0].message, new RegExp(`^Apply stopped at ${step}: `), label);
    }
});

test('AC.a-failed-runtime-verification-of-a-share-client-is-the-verify-step', async () => {
    const f = reconcileWorld({ mpsReadiness: { mpsLaunch: {}, key: 'exact', share, client: {} } });
    const result = await f.run();
    assert.equal(result.status, 409);
    assert.equal(result.results[0].cause.step, 'verify', JSON.stringify(result.results[0]));
    assert.equal(result.results[0].cause.errorClass, 'MpsError');
    assert.equal(result.results[0].cause.code, 'gpu_sharing_unavailable');
});

test('AC.the-innermost-step-is-kept-and-values-that-are-not-errors-are-described', async () => {
    const error = new Error('inner');
    markApplyStep(error, 'daemon-start');
    markApplyStep(error, 'client-launch');
    assert.equal(error.applyStep, 'daemon-start');
    assert.equal(Object.keys(error).includes('applyStep'), false, 'the step is never serialized with the error');
    await assert.rejects(inApplyStep('verify', async () => { throw error; }), (value) => value === error && value.applyStep === 'daemon-start');
    assert.throws(() => inApplyStep('verify', () => { throw 'a string'; }), (value) => value === 'a string');
    assert.deepEqual({ ...describeApplyCause('boom\u0007') }, { step: 'apply', errorClass: 'NonError', code: null, message: 'boom' });
    assert.deepEqual({ ...describeApplyCause(undefined, 'drain') }, { step: 'drain', errorClass: 'NonError', code: null, message: 'no message' });
    assert.deepEqual({ ...describeApplyCause(Object.assign(new RangeError('x'), { code: 25 })) }, { step: 'apply', errorClass: 'RangeError', code: '25', message: 'x' });
    assert.equal(describeApplyCause(Object.assign(new Error('x'), { code: 'a b;c' })).code, 'abc');
    assert.equal(formatApplyCause({ step: 'verify', errorClass: 'MpsError', code: 'gpu_sharing_unavailable', message: 'm' }), 'verify: MpsError (gpu_sharing_unavailable): m');
});

test('AC.a-peer-that-was-not-recreated-reports-its-cause-in-the-partial-result', async () => {
    const capability = {};
    const registry = Object.fromEntries(['a', 'b'].map((name, index) => [name, { type: 'agent', repoName: 'demo', agentName: name, instanceId: `i-${name}`, enableGeneration: `g-${name}`, containerId: String(index + 1).repeat(64) }]));
    let state = { ...daemonState(), oldClients: [], drainedClients: [] };
    const applied = (key) => ({ instanceId: registry[key].instanceId, enableGeneration: registry[key].enableGeneration, gpuShare: share, mpsGeneration: 'old:config' });
    const nextShare = { ...share, smPercent: 50 };
    const dependencies = {
        observeClients: () => [], readContext: () => ({ storeToken: token, overrides: new Map([['demo/a', { gpu: nextShare }], ['demo/b', { gpu: share }]]), gpu: { eligible: true, grant: { mps: {} } } }),
        loadRegistry: () => registry, readApplied: (key) => applied(key),
        loadPlan: () => ({ runtime: 'podman', manifest: {}, profile: { network: { mode: 'default' } }, image: 'prepared:tag' }), prepareImage: () => {}, inspectImage: () => ({ Id: imageId, Config: { User: '1000:1000' } }),
        resolveShare: (policy) => policy, policyCheck: () => {}, store: { read: () => clone(state), write: (value) => { state = clone(value); } },
        backend: { observe: () => ({ state: 'owned', daemon: state.daemon }), verify: () => true, stop: () => {}, cleanup: () => {}, start: (value) => daemonState(value, 'new') },
        network: async (fn) => fn(capability), assertCapability: () => {}, drainClient: async () => {},
        reconcile: async () => { throw Object.assign(new Error('podman create failed: password=hunter2'), { name: 'CreateError' }); },
    };
    const result = await applyHardwareLimits({ expectedToken: token, containers: ['a'] }, {
        lease: (_options, callback) => callback(), loadRegistry: () => clone(registry), loadRouting: () => ({ routes: {} }), readPolicy: () => ({ token }), policyCheck: () => {},
        loadPlan: () => ({}), isUnchanged: () => false,
        reconcile: (instance, options) => coordinateMpsLifecycle({ target: { key: 'a', record: clone(registry.a) }, options: { onMpsPlan: options.onMpsPlan, onMpsResult: options.onMpsResult },
            launchTarget: async (next) => { readMpsLaunch(next.mpsLaunch, 'a', nextShare); return { containerName: 'a', containerId: 'c'.repeat(64) }; } }, dependencies),
    });
    assert.equal(result.status, 207, JSON.stringify(result));
    const peer = result.results.find((entry) => entry.key === 'b');
    assert.equal(peer.state, 'pending');
    assert.deepEqual({ ...peer.cause }, { step: 'client-launch', errorClass: 'CreateError', code: null, message: 'podman create failed: password=[REDACTED]' });
    assert.match(peer.message, /^This exact GPU share client was not recreated; it stays inactive until retried\. Cause at client-launch: CreateError: /);
    assert.equal(JSON.stringify(result).includes('hunter2'), false);
});

// What the MPS tools and daemon report when they fail: exit state, error code and a bounded, redacted stderr.
test('AC.mps-control-and-daemon-start-failures-say-how-the-tool-failed', () => {
    assert.throws(() => runMpsControl('get_server_list', { uid: 1000, env: {}, query: () => ({ status: 1, stdout: '', stderr: 'cannot open the log directory\nsecret=top' }) }),
        (error) => error instanceof MpsError && /^MPS control failed, timed out or exceeded its output bound \(exit 1, stderr: cannot open the log directory secret=\[REDACTED\]\)$/.test(error.message));
    assert.throws(() => runMpsControl('quit', { uid: 1000, env: {}, query: () => ({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }) }),
        (error) => /\(error ETIMEDOUT, signal SIGTERM\)$/.test(error.message));
    const tools = fakeTools();
    const backend = createMpsDaemonBackend({ fsApi: tools.fsApi, uid: 1000, query: () => ({ status: 127, error: Object.assign(new Error('spawn'), { code: 'ENOENT' }), stderr: '' }) });
    assert.throws(() => backend.start({ smPercent: 25, memoryMiB: 1024 }, { tools: tools.descriptors }),
        (error) => error instanceof MpsError && /^MPS daemon start failed or timed out \(error ENOENT, exit 127\)$/.test(error.message));
});

// A fake file system holding the two NVIDIA tools, so the product fingerprint check runs unchanged.
function fakeTools() {
    const content = { control: Buffer.from('control-v1'), server: Buffer.from('server-v1') };
    const nameOf = (file) => (String(file).endsWith('control') ? 'control' : 'server');
    const fsApi = {
        realpathSync: (file) => file, openSync: (file) => nameOf(file), accessSync: () => {}, closeSync: () => {},
        fstatSync: (fd) => ({ isFile: () => true, nlink: 1, size: content[fd].length, dev: 7, ino: fd === 'control' ? 10 : 11, mtimeMs: 5, ctimeMs: 5 }),
        readSync: (fd, buffer, offset, length, position) => { const read = Math.min(length, content[fd].length - position); content[fd].copy(buffer, offset, position, position + read); return read; },
        readFileSync: (file) => (file === '/proc/self/cgroup' ? '0::/ploinky/core\n' : ''), mkdirSync: () => {}, readdirSync: () => [],
        lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 1000, mode: 0o40700, dev: 1, ino: 2 }),
    };
    const descriptors = { control: describeMpsTool(MPS_TOOL_PATHS.control, MPS_TOOL_PATHS.control, { fsApi }), server: describeMpsTool(MPS_TOOL_PATHS.server, MPS_TOOL_PATHS.server, { fsApi }) };
    return { fsApi, descriptors, content };
}

test('AC.a-drifted-mounted-tool-is-a-typed-sharing-refusal-through-apply-not-a-generic-failure', async () => {
    const tools = fakeTools();
    tools.content.control = Buffer.from('control-v2');
    const backend = createMpsDaemonBackend({ fsApi: tools.fsApi, uid: 1000 });
    const f = world({ tools: tools.descriptors, backendStart: (value, options) => backend.start(value, options) });
    const result = await f.apply();
    assert.equal(result.status, 422, JSON.stringify(result));
    assert.notEqual(result.error, 'apply_failed');
    assert.equal(result.results[0].state, 'refused');
    assert.equal(result.results[0].problem.reasonCode, 'gpu_sharing_unavailable');
    assert.match(result.results[0].problem.reason, /The mounted MPS tools no longer match the GPU wiring: MPS control tool sha256 changed/);
});
