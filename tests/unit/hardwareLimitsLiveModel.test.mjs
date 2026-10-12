// Offline injected evidence only. No engine, model, GPU, machine or network is
// used. The real manifest/provision/live/cleanup code runs against this world.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { buildConcreteManifest, validatePins, CONCRETE_BLOCKS, renderSummary } from '../hardware-limits/liveManifest.mjs';
import { validateProfile, executeLiveRun, executeCleanupRun, validateAuthorization } from '../hardware-limits/liveHarness.mjs';
import { provisionRun, fixtureContainerName } from '../hardware-limits/liveFixture.mjs';
import { engineIdentityDigest, digest, jsonDigest, liveSourceDigest, workspaceSocketProblem } from '../hardware-limits/liveCommon.mjs';
import { MODEL_PROFILES, assertModelObservation, assertModelContainer, assertModelSource, validateModelPins } from '../hardware-limits/liveModelCases.mjs';
import { assertModelHostSample, parseModelHostSample, createModelHostGuard, observeAppleMachine } from '../hardware-limits/liveModelHostGuard.mjs';
import { MODEL_PROCESS_FACTS, LLM_TOOL_CALL } from '../hardware-limits/liveLlmCommands.mjs';
import { requiredArtifacts, llmCleanupProofProblem, modelInferenceProofProblem, judgeArtifacts, writeUstar } from '../hardware-limits/liveStage.mjs';
import { fakeEngineInfo, evaluateTemplate, inspectModel, ok } from '../hardware-limits/fakeLiveEngine.mjs';
import { validateRunManifest } from '../hardware-limits/fixtures.mjs';

const hex = value => crypto.createHash('sha256').update(value).digest('hex');
const IMAGE = `docker.io/assistos/local-llm@sha256:${'a'.repeat(64)}`;
const CONFIG = `sha256:${'b'.repeat(64)}`;
const SMALL = { id: 'qwen2.5-0.5b-instruct-q4_k_m', repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', commit: 'c'.repeat(40), size: 500, sha256: 'd'.repeat(64) };
const HOST = { arch: 'test', os: 'linux', hostname: 'offline', id: 'model-engine' };
const clone = value => structuredClone(value);
function modelPin(profile) {
    return { profile, imageConfigDigest: CONFIG, imageParentDigest: `sha256:${'c'.repeat(64)}`, cibRevision: 'd'.repeat(40),
        executable: { path: MODEL_PROFILES[profile].executable, sha256: 'e'.repeat(64), version: 'b11159' },
        ...(profile === 'apple' ? { apple: { machine: 'owned-test', connection: 'owned-test', uri: 'ssh://user@localhost:1234/run/user/501/podman/podman.sock', provider: 'libkrun', renderNode: '/dev/dri/renderD128' } } : {}) };
}
function observation(profile = 'cpu') {
    const model = modelPin(profile); const spec = MODEL_PROFILES[profile];
    return { spec, model, pins: SMALL, imageId: CONFIG,
        status: { phase: 'ready', profile: spec.backend, deployment: { phase: 'ready', profile: spec.backend, modelId: SMALL.id, runnerId: spec.runner, artifact: { ...SMALL } }, runnerReport: { device: profile === 'cpu' ? 'CPU' : `${profile === 'apple' ? 'Vulkan0' : 'CUDA0'} (offline GPU)`, offloaded: { layers: profile === 'cpu' ? 0 : 24 } } },
        answer: { text: 'Blue.', modelId: SMALL.id, runnerId: spec.runner, generationTokensPerSecond: 4 },
        processes: [{ pid: 42, start: '1234', exe: model.executable.path, sha256: model.executable.sha256, gpuNodes: [], args: { '--device': profile === 'cpu' ? 'none' : profile === 'apple' ? 'Vulkan0' : null, '--n-gpu-layers': profile === 'cpu' ? '0' : '99', '-ngl': null, '--fit': profile === 'cpu' ? 'off' : null }, cudaVisible: profile === 'cpu' ? '' : null, icd: profile === 'apple' ? '/opt/local-llm/vulkan/icd.d/virtio_icd.json' : null, layers: profile === 'apple' ? '~all~' : null, mps: false, nvidiaLibrary: profile === 'nvidia' }] };
}

function world(t, profile = 'cpu', fault = {}) {
    const root = fs.realpathSync(fs.mkdtempSync('/tmp/mm-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = name => { const target = path.join(root, name); fs.mkdirSync(target, { recursive: true }); return target; };
    const home = dir('h'); const source = dir('s'); const bin = dir('b'); const evidence = dir('e');
    const node = fs.realpathSync(process.execPath); const engine = path.join(bin, 'podman'); const ssh = path.join(bin, 'ssh'); const knownHosts = path.join(bin, 'known_hosts');
    for (const file of [engine, ssh, knownHosts]) fs.writeFileSync(file, 'offline fake\n');
    fs.mkdirSync(path.join(source, 'ploinky-box', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(source, 'ploinky-box', 'bin', 'ploinky-box.mjs'), '// offline candidate\n');
    const local = path.join(source, '.hwl-local-llms', 'local-llm');
    fs.mkdirSync(path.join(local, 'catalog'), { recursive: true });
    fs.writeFileSync(path.join(local, 'manifest.json'), JSON.stringify({ container: 'image:tag', agent: 'exec node /code/main.mjs', containerSecurity: { gpu: true } }));
    fs.writeFileSync(path.join(local, 'main.mjs'), '// offline agent\n');
    fs.writeFileSync(path.join(local, 'catalog', 'models.json'), JSON.stringify({ models: [
        { id: SMALL.id, sources: { gguf: { ...SMALL } } },
        { id: 'qwen3-4b-awq', sources: { hf: { repo: 'Qwen/Qwen3-4B-AWQ', commit: 'f'.repeat(40), files: [{ path: 'weights', size: 1, sha256: 'f'.repeat(64) }] } } },
    ] }));
    const pins = { schema: 1, host: { hostname: 'offline', platform: MODEL_PROFILES[profile].platform, home }, node: { path: node, digest: digest(fs.readFileSync(node)) },
        engine: { path: engine, digest: digest(fs.readFileSync(engine)), identityDigest: engineIdentityDigest(fakeEngineInfo(HOST)) }, boxImage: `docker.io/assistos/box@sha256:${'f'.repeat(64)}`, llm: { image: IMAGE }, model: modelPin(profile),
        ...(profile === 'apple' ? { workspaceParentRoot: root } : { ssh: { alias: 'ubuntu-codex', sshBinary: ssh, address: '192.168.1.63', hostKeyAlias: '192.168.1.63', user: 'offline', knownHosts, identityFile: null } }),
        ...(profile === 'nvidia' ? { gpu: { uuid: 'GPU-12345678', name: 'offline GPU', driverVersion: '595.1', memoryMiB: 6144, smi: { path: engine, digest: digest(fs.readFileSync(engine)) } } } : {}) };
    const runId = crypto.randomBytes(16).toString('hex');
    const candidate = { root: source, digest: liveSourceDigest(source), revision: 'a'.repeat(40), llm: { revision: 'b'.repeat(40) } };
    const payload = path.join(evidence, 'candidate.tar'); candidate.payload = { path: payload, ...writeUstar(source, payload) };
    const run = buildConcreteManifest({ block: MODEL_PROFILES[profile].block, runId, configDigest: digest('config'), casesDigest: digest('cases'), documentSuffix: 'codex', pins, candidate, image: IMAGE, ports: { tcp: 23456, udp: 34567 }, unsupported: {} });
    if (run.target.stage) {
        fs.mkdirSync(run.target.stage.root, { recursive: true, mode: 0o700 }); fs.chmodSync(run.target.stage.root, 0o700);
        fs.writeFileSync(path.join(run.target.stage.root, '.ploinky-hwl-owner'), runId);
        fs.cpSync(source, path.join(run.target.stage.root, 'source'), { recursive: true });
    }
    const artifacts = new Map(); const calls = []; let box = null; let agent = null; let running = false;
    const value = observation(profile);
    const fail = text => ok('', { status: 1, stderr: text });
    const prefix = `/user.slice/libpod-${'1'.repeat(64)}.scope`;
    const leaf = `${prefix}/${fault.controllerHeavy ? 'engine/agents/' : ''}libpod-${'2'.repeat(64)}`;
    const controllerFiles = Array.from({ length: 90 }, (_, index) => `controller.${index}`);
    const cgroupChildren = { [prefix]: ['engine'], [`${prefix}/engine`]: ['agents'], [`${prefix}/engine/agents`]: [`libpod-${'2'.repeat(64)}`] };
    const bootId = '11111111-2222-4333-8444-555555555555';
    const hostProc = { bootId: () => bootId, uid: () => process.getuid(),
        observe: pid => pid === 100 && box || pid === 200 && running ? { hostPid: pid, ppid: 1, startIdentity: '1234', bootId, cgroup: pid === 100 ? prefix : leaf, nspid: pid === 100 ? [100] : [200, 42], uid: { effective: process.getuid() } } : null,
        cgroupDirectories: directory => fault.controllerHeavy
            ? Object.hasOwn(cgroupChildren, directory) ? [...controllerFiles, ...cgroupChildren[directory]] : []
            : directory === prefix ? [`libpod-${'2'.repeat(64)}`] : [],
        cgroupProcs: directory => directory === leaf ? running ? [200] : [] : fault.controllerHeavy && [`${prefix}/engine`, `${prefix}/engine/agents`].includes(directory) ? [] : null };
    const provider = async (binary, args, options) => {
        calls.push({ binary, args, env: options.env });
        assert.ok(!args.some(arg => String(arg).includes('/.ploinky/repos/')), 'No managed source operation');
        if (options.signal?.aborted) return ok('', { status: null, cancelled: true });
        if (binary === '/usr/sbin/sysctl') return ok(args.at(-1) === 'vm.swapusage' ? 'used = 0.00M' : args.at(-1) === 'kern.memorystatus_level' ? '50' : '1');
        if (binary === '/bin/ps') return ok('123 1024000 /opt/bin/krunkit\n');
        if (args[0] === 'machine') return ok(JSON.stringify(args[1] === 'list' ? [{ Name: 'owned-test', VMType: 'libkrun', Running: true }] : [{ Name: 'owned-test', State: 'running', Rootful: false }]));
        if (args[0] === 'system') return ok(JSON.stringify([{ Name: 'owned-test', URI: pins.model.apple.uri, Default: true }]));
        if (args.includes('-q') && args.includes('-x')) {
            const rows = running ? [{ pid: 200, type: 'C' }, ...(fault.foreign ? [{ pid: 999, type: 'C' }] : [])] : fault.foreignBefore ? [{ pid: 999, type: 'C' }] : [];
            return ok(`<nvidia_smi_log><gpu id="0"><uuid>GPU-12345678</uuid><compute_mode>Default</compute_mode><fb_memory_usage><total>6144 MiB</total><used>100 MiB</used><free>6044 MiB</free></fb_memory_usage><processes>${rows.map(row => `<process_info><pid>${row.pid}</pid><type>${row.type}</type></process_info>`).join('')}</processes></gpu></nvidia_smi_log>`);
        }
        if (binary === node && args.includes('start')) {
            assert.equal(options.env.PLOINKY_BOX_HARDWARE_LIMITS, 'off');
            const identity = buildWorkspaceIdentity(options.cwd);
            box = { id: '1'.repeat(64), created: '2026-10-12T00:00:00Z', image: 'f'.repeat(64), imageName: pins.boxImage, running: true, pid: 100,
                labels: { [BOX_LABELS.pathHash]: identity.pathHash, [BOX_LABELS.role]: 'box', [BOX_LABELS.imageRef]: pins.boxImage }, mounts: [{ Source: options.cwd, Destination: options.cwd, RW: true }], devices: ['/dev/fuse', '/dev/net/tun'].map(name => ({ PathOnHost: name, PathInContainer: name })) };
            agent = { id: '2'.repeat(64), name: fixtureContainerName(options.cwd, 'local-llm', 'local-llms'), created: box.created, image: CONFIG.slice(7), imageName: IMAGE, running: true, labels: {}, devices: [], mounts: [{ Source: path.join(options.cwd, 'local-llms', 'local-llm'), Destination: '/code', RW: false }] };
            if (profile === 'apple') { agent.devices = [{ PathOnHost: '/dev/dri/renderD128', PathInContainer: '/dev/dri/renderD128' }]; box.devices.push(...agent.devices); }
            return ok();
        }
        if (binary === node && args.includes('destroy')) {
            if (fault.destroy) return fail('injected destroy failure');
            box = null; agent = null; running = false; return ok();
        }
        if (binary === node && args.includes('gpu')) return ok();
        if (args[0] === 'info') return ok(JSON.stringify(fakeEngineInfo(HOST)));
        if (args.includes(LLM_TOOL_CALL)) {
            const at = args.indexOf(LLM_TOOL_CALL); const tool = args[at + 1];
            if (tool === 'local_llm_run') running = true;
            if (tool === 'local_llm_stop') { if (fault.stop) return fail('injected stop failure'); running = false; }
            if (tool === 'local_llm_status' && fault.cancelLoad && running) return ok('', { cancelled: true, status: null });
            let result = tool === 'local_llm_overview' ? { profile: value.spec.backend, hardware: { gpu: { name: 'offline GPU', driverVersion: '595.1' } }, runners: [{ id: value.spec.runner, installed: true, version: 'b11159' }] }
                : tool === 'local_llm_status' ? running ? clone(value.status) : { phase: 'idle' }
                    : tool === 'local_llm_test_prompt' ? { ...value.answer, ...(fault.empty ? { text: '' } : {}) } : {};
            return ok(JSON.stringify({ ok: true, agent: fault.agent ? 'foreign/agent' : 'local-llms/local-llm', result }));
        }
        if (args.includes(MODEL_PROCESS_FACTS)) return ok(JSON.stringify({ processes: value.processes }), fault.oversized ? { truncated: true } : {});
        if (args.includes('inspect')) {
            const wanted = args.at(-1);
            const record = wanted === box?.id ? box : wanted === agent?.id || wanted === agent?.name ? agent : null;
            if (!record) return fail('no such container');
            const rendered = evaluateTemplate(args[args.indexOf('--format') + 1], 'inspect', inspectModel(record));
            return typeof rendered === 'string' ? ok(rendered) : rendered;
        }
        if (args.includes('ps')) return ok(box ? box.id + '\n' : '');
        throw new Error(`Unexpected offline command: ${args[0]}`);
    };
    const options = () => ({ run, processProvider: provider, hostIdentity: pins.host, hostProc, remoteArrival: profile !== 'apple', artifacts: (name, data) => {
        if (fault.proof && name === 'llm-cleanup-proof') throw new Error('injected proof write failure');
        artifacts.set(name, clone(data));
    }, persist: () => {} });
    return { root, source, pins, run, calls, artifacts, provider, options, value,
        provision: () => provisionRun({ ...options(), validateProfile, portProbe: async () => ({ tcp: true, udp: true }) }),
        live: () => executeLiveRun({ ...options(), gpuTimings: { pollMs: 1 } }),
        cleanup: () => executeCleanupRun(options()) };
}

test('MODEL.manifest-profile-pins-and-old-mode-separation', t => {
    for (const profile of Object.keys(MODEL_PROFILES)) {
        const w = world(t, profile);
        const localPins = clone(w.pins);
        if (profile === 'apple') localPins.host = { hostname: os.hostname(), platform: process.platform, home: fs.realpathSync(os.homedir()) };
        if (profile === 'apple' && process.platform !== 'darwin') assert.throws(() => validatePins(localPins, w.run.block), /Invalid pins/);
        else validatePins(localPins, w.run.block);
        validateProfile(w.run, { partial: true }); validateRunManifest(w.run);
        assert.equal(CONCRETE_BLOCKS[w.run.block].cases.length, 1);
        assert.equal(w.run.target.execution.provision.ordinarySource, true);
        assert.match(renderSummary(w.run, '/tmp/run_codex.json'), /Hardware budgets and MPS are disabled/);
        for (const mutate of [m => { m.profile = ''; }, m => { m.profile = 'other'; }, m => { m.imageConfigDigest = ''; }, m => { m.executable.sha256 = 'bad'; }, m => { m.imageParentDigest = 'sha256:'; }]) {
            const pin = clone(w.pins.model); mutate(pin); assert.throws(() => validateModelPins(pin, w.run.block));
        }
        const bad = clone(w.run); bad.target.execution.model.profile = profile === 'cpu' ? 'apple' : 'cpu'; assert.throws(() => validateProfile(bad, { partial: true }));
        const empty = clone(w.run); empty.target.execution.cases = []; assert.throws(() => validateProfile(empty, { partial: true }));
    }
    assert.equal(CONCRETE_BLOCKS['apparatus-local-llm'].gpu, true);
    assert.equal(CONCRETE_BLOCKS['apparatus-local-llm'].model, undefined);
});

test('MODEL.cpu-canonical-provision-inference-cleanup-with-ordinary-source', async t => {
    const w = world(t); const provision = await w.provision(); assert.equal(provision.verdict, 'PASS', JSON.stringify(provision));
    const profile = w.run.target.execution;
    assert.ok(w.calls.findIndex(call => call.args.includes('revoke')) < w.calls.findIndex(call => call.args.includes('start')));
    assertModelSource(profile);
    const live = await w.live(); assert.equal(live.verdict, 'PASS', JSON.stringify(live));
    assert.deepEqual(live.cases.map(row => [row.id, row.result]), [['LIVE-L5', 'pass']]);
    assert.equal(w.artifacts.get('model-live-l5').status, 'pass');
    assert.deepEqual(w.artifacts.get('llm-cleanup-proof').remaining, []);
    assert.equal(fs.existsSync(profile.workspace.path), false);
    const repeated = await w.live(); assert.notEqual(repeated.verdict, 'PASS');
});

test('MODEL.failure-cancellation-stop-destroy-and-oversized-never-pass', async t => {
    for (const fault of [{ empty: true }, { agent: true }, { oversized: true }, { cancelLoad: true }, { stop: true }, { destroy: true }, { proof: true }]) {
        const w = world(t, 'cpu', fault); assert.equal((await w.provision()).verdict, 'PASS');
        const result = await w.live(); assert.notEqual(result.verdict, 'PASS', JSON.stringify(fault));
        if (fault.destroy) { assert.equal(result.cleanup.state, 'failed'); assert.equal(fs.existsSync(w.run.target.execution.workspace.path), true); }
        else assert.equal(fs.existsSync(w.run.target.execution.workspace.path), false);
        assert.ok(w.artifacts.has('model-live-l5'));
    }
});

test('MODEL.apple-and-nvidia-cohorts-and-foreign-compute-guard', async t => {
    for (const profile of ['apple', 'nvidia', 'cpu']) {
        const w = world(t, profile, { controllerHeavy: profile === 'nvidia' });
        const originals = Object.fromEntries(['readFileSync', 'readdirSync', 'lstatSync', 'statSync', 'writeFileSync', 'mkdirSync', 'existsSync'].map(name => [name, fs[name]]));
        let live;
        try {
            for (const [name, original] of Object.entries(originals)) fs[name] = function (target, ...args) {
                assert.ok(!String(target).includes('/.ploinky/repos'), `Managed source access: ${name}`);
                return original.call(this, target, ...args);
            };
            const provision = await w.provision(); assert.equal(provision.verdict, 'PASS', JSON.stringify(provision));
            live = await w.live(); assert.equal(live.verdict, 'PASS', JSON.stringify(live));
        } finally { Object.assign(fs, originals); }
        assert.deepEqual(live.cases.map(row => [row.id, row.result]), [[MODEL_PROFILES[profile].case, 'pass']]);
        assert.ok(!w.calls.some(call => call.args[0] === 'machine' && !['list', 'inspect'].includes(call.args[1])));
    }
    const foreign = world(t, 'nvidia', { foreign: true });
    assert.equal((await foreign.provision()).verdict, 'PASS');
    const result = await foreign.live(); assert.notEqual(result.verdict, 'PASS');
    assert.ok(result.limitations.some(reason => /GPU idle gate blocked/.test(reason)), JSON.stringify(result));
    assert.ok(!foreign.calls.some(call => call.args.includes('kill')));
    const busy = world(t, 'nvidia', { foreignBefore: true });
    assert.notEqual((await busy.provision()).verdict, 'PASS');
    assert.ok(!busy.calls.some(call => call.args.includes('start') || call.args.includes('destroy')));
});

test('MODEL.backend-model-image-offload-and-safe-process-facts', () => {
    for (const profile of Object.keys(MODEL_PROFILES)) {
        const good = observation(profile); assert.doesNotThrow(() => assertModelObservation(good));
        for (const mutate of [o => { o.status.profile = 'wrong'; }, o => { o.status.deployment.modelId = 'wrong'; }, o => { o.status.deployment.artifact.sha256 = '0'.repeat(64); }, o => { o.imageId = '0'.repeat(64); }, o => { o.answer.text = ''; }, o => { o.answer.generationTokensPerSecond = 0; }, o => { o.processes[0].mps = true; }, o => { o.processes[0].sha256 = '0'.repeat(64); }]) {
            const bad = clone(good); mutate(bad); assert.throws(() => assertModelObservation(bad));
        }
        if (profile !== 'cpu') for (const mutate of [o => { o.status.runnerReport.offloaded.layers = 0; }, o => { o.status.runnerReport.device = 'CPU'; }]) { const bad = clone(good); mutate(bad); assert.throws(() => assertModelObservation(bad)); }
        if (profile === 'apple') { const bad = clone(good); bad.processes[0].icd = '/wrong'; assert.throws(() => assertModelObservation(bad)); }
        if (profile === 'cpu') for (const mutate of [o => { o.processes[0].cudaVisible = '0'; }, o => { o.processes[0].nvidiaLibrary = true; }, o => { o.processes[0].args['--fit'] = 'on'; }, o => { o.processes[0].args['--n-gpu-layers'] = '99'; }]) { const bad = clone(good); mutate(bad); assert.throws(() => assertModelObservation(bad)); }
    }
});

test('MODEL.source-mount-hash-device-and-workspace-reuse-refused', async t => {
    const w = world(t); assert.equal((await w.provision()).verdict, 'PASS'); const profile = w.run.target.execution;
    const agent = { ...profile.agents[0], imageName: IMAGE, running: true, devices: [], mounts: [{ Source: path.join(profile.workspace.path, 'local-llms', 'local-llm'), Destination: '/code', RW: false }] };
    assertModelContainer(agent, { profile, role: 'agent' });
    const baseDevices = ['/dev/fuse', '/dev/net/tun'].map(name => ({ PathOnHost: name, PathInContainer: name }));
    assert.doesNotThrow(() => assertModelContainer({ mounts: [], devices: baseDevices }, { profile, role: 'box' }));
    assert.throws(() => assertModelContainer({ mounts: [], devices: [...baseDevices, { PathOnHost: '/dev/dri/renderD128', PathInContainer: '/dev/dri/renderD128' }] }, { profile, role: 'box' }));
    for (const mutate of [v => { v.mounts = []; }, v => { v.mounts[0].Source += '/wrong'; }, v => { v.mounts[0].RW = true; }, v => { v.devices = [{ PathOnHost: '/dev/nvidia0' }]; }, v => { v.id = 'a'.repeat(64); }]) { const bad = clone(agent); mutate(bad); assert.throws(() => assertModelContainer(bad, { profile, role: 'agent' })); }
    fs.appendFileSync(path.join(profile.workspace.path, 'local-llms', 'local-llm', 'main.mjs'), 'changed');
    assert.throws(() => assertModelSource(profile), /bytes changed/);
    assert.notEqual((await w.provision()).verdict, 'PASS');
    assert.ok(workspaceSocketProblem('/tmp/' + 'x'.repeat(200)));
});

test('MODEL.apple-guard-thresholds-unreadable-and-cancellation', async () => {
    const sample = { memoryLevel: 50, pressure: 1, swapMiB: 100, krunkitRssMiB: 1000 };
    assertModelHostSample(sample);
    for (const bad of [{ memoryLevel: 19 }, { pressure: 2 }, { swapMiB: 1125 }, { krunkitRssMiB: 9217 }, { memoryLevel: NaN }]) assert.throws(() => assertModelHostSample({ ...sample, ...bad }, sample));
    assert.deepEqual(parseModelHostSample({ memoryLevel: '50\n', pressure: '1\n', swap: 'used = 100.00M', processes: '123 1024000 /opt/bin/krunkit\n' }), sample);
    assert.throws(() => parseModelHostSample({ memoryLevel: '50', pressure: '1', swap: 'used = 100M', processes: '1 100 /bin/krunkit\n2 100 /bin/krunkit' }), /ambiguous/);
    let count = 0; let aborted = false;
    const guard = createModelHostGuard({ intervalMs: 1, sample: async () => count++ ? { ...sample, pressure: 2 } : sample });
    await assert.rejects(guard.monitor(signal => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }))), /threshold/);
    assert.equal(aborted, true);
    await assert.rejects(createModelHostGuard({ sample: async () => { throw new Error('unreadable'); } }).monitor(async () => assert.fail('must not start')), /unreadable/);
});

test('MODEL.apple-selected-machine-and-connection-fail-closed', async () => {
    const profile = { model: modelPin('apple'), engine: { identityDigest: engineIdentityDigest(fakeEngineInfo(HOST)) } };
    const documents = [ [{ Name: 'owned-test', Running: true, VMType: 'libkrun' }], [{ Name: 'owned-test', State: 'running', Rootful: false }], [{ Name: 'owned-test', URI: profile.model.apple.uri, Default: true }] ];
    const observe = async docs => observeAppleMachine({ profile, engine: async kind => ok(JSON.stringify(kind === 'engine-identity' ? fakeEngineInfo(HOST) : docs[kind === 'model-machine-list' ? 0 : kind === 'model-machine-inspect' ? 1 : 2])) });
    await observe(documents);
    for (const mutate of [d => { d[0][0].VMType = 'applehv'; }, d => { d[1][0].Rootful = true; }, d => { d[2][0].URI += 'changed'; }, d => { d[2].push(d[2][0]); }]) { const bad = clone(documents); mutate(bad); await assert.rejects(observe(bad)); }
    profile.engine.identityDigest = digest('changed'); await assert.rejects(observe(documents), /engine identity changed/);
});

test('MODEL.cleanup-artifacts-and-exact-action-bindings', t => {
    for (const profile of ['cpu', 'nvidia', 'apple']) {
        const w = world(t, profile); const execution = w.run.target.execution;
        assert.ok(requiredArtifacts({ profile: execution, action: 'live' }).includes(`model-${execution.cases[0].toLowerCase()}`));
        assert.ok(requiredArtifacts({ profile: execution, action: 'cleanup' }).includes('llm-cleanup-proof'));
        const bytes = Buffer.from(JSON.stringify(w.run)); const auth = { schema: 1, runId: w.run.runId, manifestDigest: digest(bytes), targetDigest: jsonDigest(w.run.target), action: 'live' };
        validateAuthorization(w.run, bytes, auth, 'live');
        for (const action of ['', 'all', 'cleanup']) assert.throws(() => validateAuthorization(w.run, bytes, auth, action));
        const proof = { schema: 1, runId: w.run.runId, action: 'live', at: Date.now(), remaining: [] };
        assert.equal(llmCleanupProofProblem(JSON.stringify(proof), { runId: w.run.runId, action: 'live' }), null);
        assert.match(llmCleanupProofProblem(JSON.stringify(proof), { runId: w.run.runId }), /not by this cleanup/);
        proof.action = 'cleanup'; proof.remaining = ['model-data']; assert.match(llmCleanupProofProblem(JSON.stringify(proof), { runId: w.run.runId }), /remains/);
        assert.match(modelInferenceProofProblem('{}', { runId: w.run.runId, caseId: execution.cases[0] }), /identity mismatch/);
        const report = judgeArtifacts({ verdict: 'PASS', exitCode: 0, limitations: [] }, { complete: false, missingRequired: [`model-${execution.cases[0].toLowerCase()}`], failures: [] });
        assert.equal(report.verdict, 'BLOCKED');
    }
});

test('MODEL.process-observer-never-emits-secret-arguments-or-environment', () => {
    const captured = []; const exe = '/opt/llama.cpp/llama-server'; const files = { '/proc/42/cmdline': [exe, '--api-key', 'do-not-output-key', '--device', 'none', '--n-gpu-layers', '0', '--fit', 'off', ''].join('\0'), '/proc/42/environ': 'API_TOKEN=do-not-output-token\0CUDA_VISIBLE_DEVICES=\0', '/proc/42/stat': '42 (llama-server) S 1 ' + Array(17).fill('0').join(' ') + ' 1234 0' };
    const fake = { readdirSync: () => ['42'], readlinkSync: () => exe, readFileSync: name => files[name], openSync: () => 1, closeSync() {}, readSync: () => 0 };
    vm.runInNewContext(MODEL_PROCESS_FACTS, { require: name => name === 'node:fs' ? fake : crypto, Buffer, process: { argv: ['node', exe], stdout: { write: text => captured.push(text) } } });
    const text = captured.join(''); assert.ok(!text.includes('do-not-output')); assert.ok(!text.includes('API_TOKEN')); assert.equal(JSON.parse(text).processes[0].args['--device'], 'none');
});
