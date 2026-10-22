// Offline injected evidence only. No engine, model, GPU, machine or network is
// used. The real manifest/provision/live/cleanup code runs against this world.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { agentLibLabels, normalizeBoxAgentLib } from '../../ploinky-box/contract/agentlib.mjs';
import { imageSourceIdentity } from '../../agentlib/contract.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { buildConcreteManifest, validatePins, CONCRETE_BLOCKS, renderSummary, blockDeadlines } from '../hardware-limits/liveManifest.mjs';
import { validateProfile, executeLiveRun, executeCleanupRun, validateAuthorization, runLiveCommand } from '../hardware-limits/liveHarness.mjs';
import { provisionRun, fixtureContainerName } from '../hardware-limits/liveFixture.mjs';
import { artifactPathFor, engineIdentityDigest, digest, jsonDigest, liveSourceDigest, workspaceSocketProblem } from '../hardware-limits/liveCommon.mjs';
import { MODEL_PROFILES, assertModelObservation, assertModelContainer, assertModelSource, validateModelPins, ordinaryGpuAnchor } from '../hardware-limits/liveModelCases.mjs';
import { MEASUREMENT_WEIGHTS, MEASUREMENT_MEMORY, MEASUREMENT_RUNNER, MEASUREMENT_GROUP } from '../hardware-limits/liveModelMeasurementCommands.mjs';
import { validateMeasurementReceipt } from '../hardware-limits/liveModelMeasurements.mjs';
import { MODEL_SOURCE_VIEW, modelSourceLayout, observeModelStage, observeModelCodeView } from '../hardware-limits/liveModelSource.mjs';
import { ensureCodeMountPoint, buildPodmanStagedTargetMounts } from '../../cli/sandbox/docker/agentServiceManager.js';
import { canonicalDigest } from '../../cli/utils/dependencies/store/canonical.mjs';
import { hashInstalledTree } from '../../cli/utils/dependencies/store/treeHash.mjs';
import { buildResolutionManifest } from '../../cli/utils/dependencies/store/resolution.mjs';
import { generationIdFor } from '../../cli/utils/dependencies/store/objectStore.mjs';
import { assertModelHostSample, parseModelHostSample, createModelHostGuard, observeAppleMachine, modelGrantInventory } from '../hardware-limits/liveModelHostGuard.mjs';
import { MODEL_PROCESS_FACTS, LLM_TOOL_CALL } from '../hardware-limits/liveLlmCommands.mjs';
import { APPLE_DEVICE_INSPECT, APPLE_RENDER_FACTS } from '../hardware-limits/liveModelDevices.mjs';
import { requiredArtifacts, llmCleanupProofProblem, modelInferenceProofProblem, modelProvisionOnlyCleanupProven, judgeArtifacts, writeUstar } from '../hardware-limits/liveStage.mjs';
import { fakeEngineInfo, evaluateTemplate, inspectModel, ok } from '../hardware-limits/fakeLiveEngine.mjs';
import { validateRunManifest, writePrivateJson } from '../hardware-limits/fixtures.mjs';
import { fakeApuPin, fakeApuActivity, fakeApuProof } from '../hardware-limits/fakeApuEvidence.mjs';
import { projectApuEvidence } from '../hardware-limits/liveApuProjection.mjs';
import { LINUX_HOST_SAMPLE } from '../hardware-limits/liveLinuxHostGuard.mjs';
import { APU_ENV_FACTS, APU_DISCOVERY } from '../hardware-limits/liveApuCommands.mjs';
import { apuFetchedProofProblem } from '../hardware-limits/liveStage.mjs';
import { APU_TRANSFER_PHASES, validateApuDeployment } from '../hardware-limits/liveApuDeployment.mjs';

const hex = value => crypto.createHash('sha256').update(value).digest('hex');
const IMAGE = `docker.io/assistos/local-llm@sha256:${'a'.repeat(64)}`;
const CONFIG = `sha256:${'b'.repeat(64)}`;
const SMALL = { id: 'qwen2.5-0.5b-instruct-q4_k_m', repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', commit: 'c'.repeat(40), size: 500, sha256: 'd'.repeat(64) };
const HOST = { arch: 'test', os: 'linux', hostname: 'offline', id: 'model-engine' };
const clone = value => structuredClone(value);
const imageProvider = image => normalizeBoxAgentLib({ mode: 'image', sourceDir: '/opt/ploinky-agentlib', sourceRelativePath: 'image',
    sourceId: imageSourceIdentity(`sha256:${String(image).replace(/^sha256:/, '')}`) });

// The agent namespace over the real host tree, from the engine mount table:
// /code is the source bind, /code/node_modules the dependency bind over the
// source's mount point, and every self-bind keeps its host path. Device and
// inode facts come from the bound host directory, as with a real bind mount.
function modelNamespaceFs(mounts, providerRoot) {
    const provider = '/opt/ploinky-agentlib';
    const binds = mounts.filter(mount => mount.Destination === '/code' || mount.Destination.startsWith('/code/'))
        .sort((a, b) => b.Destination.length - a.Destination.length);
    const map = file => {
        const bind = binds.find(mount => file === mount.Destination || file.startsWith(`${mount.Destination}/`));
        return bind ? { host: bind.Source + file.slice(bind.Destination.length), bind } : null;
    };
    return new Proxy(fs, { get(target, key) {
        if (typeof target[key] !== 'function') return target[key];
        return (file, ...rest) => {
            const mapped = typeof file === 'string' ? map(file) : null;
            if (key === 'realpathSync' && typeof file === 'string' && file.endsWith('/node_modules/achillesAgentLib')) {
                const host = mapped ? mapped.host : file;
                if (fs.readlinkSync(host) !== provider) return fs.realpathSync(host);
                fs.statSync(providerRoot); return provider;
            }
            if (file === provider) return key === 'realpathSync' ? (fs.realpathSync(providerRoot), provider) : target[key](providerRoot, ...rest);
            if (key === 'realpathSync' && mapped) {
                // A bind root resolves to its namespace path; a symlink below it
                // resolves to wherever its target points on the host.
                const resolved = fs.realpathSync(mapped.host);
                const root = fs.realpathSync(mapped.bind.Source);
                return resolved === root || resolved.startsWith(`${root}/`) ? mapped.bind.Destination + resolved.slice(root.length) : resolved;
            }
            return target[key](mapped ? mapped.host : file, ...rest);
        };
    } });
}

function stageModelFixture(profile, agent) {
    const workspace = profile.workspace.path;
    const source = path.join(workspace, 'local-llms', 'local-llm');
    const objectId = crypto.randomUUID();
    const objectRoot = path.join(workspace, '.ploinky', 'deps', 'store', 'objects', objectId);
    const payload = path.join(objectRoot, 'payload');
    const dependency = path.join(payload, 'node_modules');
    fs.mkdirSync(dependency, { recursive: true });
    fs.symlinkSync('/opt/ploinky-agentlib', path.join(dependency, 'achillesAgentLib'));
    const contract = { kind: 'agent', runtime: { family: 'container', key: 'container-linux-x64-glibc-node24' }, toolchain: { kind: 'container', engine: 'podman', imageId: CONFIG },
        providers: { mcpSdk: null, agentLib: { library: 'achillesAgentLib', mode: 'image', supplyingImageId: profile.box?.image || 'f'.repeat(64),
            sourceIdHash: imageProvider(profile.box?.image || 'f'.repeat(64)).sourceIdHash, linkTarget: '/opt/ploinky-agentlib', installTarget: '/opt/ploinky-agentlib' } },
        agent: { packageSource: { selection: 'root', relativePath: 'local-llms/local-llm/package.json', sha256: hex(fs.readFileSync(path.join(source, 'package.json'))) } } };
    const inputKey = canonicalDigest(contract);
    const tree = hashInstalledTree(payload, { approvedExternalTargets: ['/opt/ploinky-agentlib'] });
    const resolution = buildResolutionManifest(null, { installer: null });
    const generationId = generationIdFor(inputKey, resolution.hash, tree.hash);
    const manifest = { format: 'ploinky-deps-cache', version: 1, owner: 'ploinky-deps-store', workspaceId: hex(workspace), objectId, inputKey, generationId,
        contract, payloadPath: payload, tree, resolution: { hash: resolution.hash, installer: null }, approvedExternalTargets: ['/opt/ploinky-agentlib'] };
    const manifestBytes = JSON.stringify(manifest);
    fs.writeFileSync(path.join(objectRoot, 'manifest.json'), manifestBytes);
    fs.writeFileSync(path.join(objectRoot, 'complete.json'), JSON.stringify({ format: manifest.format, version: 1, objectId, generationId, manifestSha256: hex(manifestBytes) }));
    // The product's own layout: the mount point it creates in the source, /code
    // bound directly to that source with the dependency generation over the
    // mount point, and the staged /Agent's read-only self-binds.
    ensureCodeMountPoint(source, 'node_modules');
    const selfBinds = buildPodmanStagedTargetMounts({ agentCodePath: source, nodeModulesDir: dependency, codeReadOnly: true, writableProjectSource: false });
    assert.deepEqual(selfBinds, [{ source, target: source, ro: true }, { source: dependency, target: dependency, ro: true }]);
    const mounts = [
        { Type: 'bind', Source: source, Destination: '/code', RW: false },
        { Type: 'bind', Source: dependency, Destination: '/code/node_modules', RW: false },
        ...selfBinds.map(bind => ({ Type: 'bind', Source: bind.source, Destination: bind.target, RW: !bind.ro })),
        { Type: 'bind', Source: path.join(workspace, '.data', 'local-llm'), Destination: '/data', RW: true },
        { Type: 'bind', Source: '/opt/ploinky-agentlib', Destination: '/opt/ploinky-agentlib', RW: false },
    ];
    agent.mounts = mounts;
    fs.writeFileSync(path.join(workspace, '.ploinky', 'agents.json'), JSON.stringify({ [agent.name]: {
        containerId: agent.id, runtime: 'podman', profile: 'default', auth: { privateSentinel: 'must-not-be-emitted' },
        config: { binds: mounts.map(mount => ({ source: mount.Source, target: mount.Destination, ro: !mount.RW })) },
        dependencies: { schema: 1, mode: 'store', family: 'container', imageId: CONFIG, runtimeKey: contract.runtime.key, inputKey, generationId, objectId, payloadPath: payload, nodeModulesPath: dependency },
    } }));
    fs.writeFileSync(path.join(workspace, '.ploinky', 'routing.json'), JSON.stringify({ routes: {
        'local-llm': { repo: 'local-llms', agent: 'local-llm', container: agent.name, hostPort: 12345 },
    } }));
    return { source, dependency, objectRoot };
}
function modelPin(profile) {
    if (profile.startsWith('amd-apu')) return fakeApuPin(profile);
    return { profile, imageConfigDigest: CONFIG, imageParentDigest: `sha256:${'c'.repeat(64)}`, cibRevision: 'd'.repeat(40),
        executable: { path: MODEL_PROFILES[profile].executable, sha256: 'e'.repeat(64), version: 'b11159' },
        ...(['apple', 'apple-cpu'].includes(profile) ? { apple: { machine: 'owned-test', connection: 'owned-test', uri: 'ssh://user@localhost:1234/run/user/501/podman/podman.sock', provider: 'libkrun', ...(profile === 'apple' ? { renderNode: '/dev/dri/renderD128' } : {}) } } : {}) };
}
function observation(profile = 'cpu') {
    const model = modelPin(profile); const spec = MODEL_PROFILES[profile];
    if (profile === 'apple-cpu') return { ...observation('cpu'), model, spec };
    if (profile.startsWith('amd-apu')) {
        const value = observation(profile === 'amd-apu-cpu' ? 'cpu' : 'apple');
        value.spec = spec; value.model = model; value.status.profile = spec.backend; value.status.deployment.profile = spec.backend;
        value.status.deployment.runnerId = spec.runner;
        value.status.deployment.params = { ctxSize: 4096, parallel: 1 };
        if (spec.backend === 'apu') {
            value.status.runnerReport = { device: 'Vulkan0 (offline GPU)', offloaded: { layers: 25, of: 25 }, kvMiB: 4,
                modelMiB: 1, modelBufferDenominatorBytes: SMALL.size, modelBufferRatio: 1048576 / SMALL.size, minModelBufferFraction: null };
            Object.assign(value.processes[0], { icd: '/opt/local-llm/vulkan/icd.d/radeon_icd.json', gpuNodes: ['/dev/dri/renderD128'],
                args: { '--device': 'Vulkan0', '--n-gpu-layers': null, '-ngl': '999', '--fit': 'off' } });
        }
        return value;
    }
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
    const providerRoot = dir('image-provider');
    const node = fs.realpathSync(process.execPath); const engine = path.join(bin, 'podman'); const ssh = path.join(bin, 'ssh'); const knownHosts = path.join(bin, 'known_hosts');
    for (const file of [engine, ssh, knownHosts]) fs.writeFileSync(file, 'offline fake\n');
    fs.mkdirSync(path.join(source, 'ploinky-box', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(source, 'ploinky-box', 'bin', 'ploinky-box.mjs'), '// offline candidate\n');
    const local = path.join(source, '.hwl-local-llms', 'local-llm');
    fs.mkdirSync(path.join(local, 'catalog'), { recursive: true });
    fs.writeFileSync(path.join(local, 'manifest.json'), JSON.stringify({ container: 'image:tag', agent: 'exec node /code/main.mjs', containerSecurity: { gpu: true }, volumes: { '.data/local-llm': '/data' },
        ...(profile.startsWith('amd-apu') ? { profiles: { default: { env: { LOCAL_LLM_AMD_APU: { required: false }, LOCAL_LLM_APU_GUARD_FLOOR_BYTES: { required: false } } } } } : {}) }));
    fs.writeFileSync(path.join(local, 'package.json'), JSON.stringify({ name: 'local-llm', type: 'module' }));
    fs.writeFileSync(path.join(local, 'main.mjs'), '// offline agent\n');
    fs.writeFileSync(path.join(local, 'catalog', 'models.json'), JSON.stringify({ models: [
        { id: SMALL.id, sources: { gguf: { ...SMALL } } },
        { id: 'qwen3-4b-awq', sources: { hf: { repo: 'Qwen/Qwen3-4B-AWQ', commit: 'f'.repeat(40), files: [{ path: 'weights', size: 1, sha256: 'f'.repeat(64) }] } } },
    ] }));
    const pins = { schema: 1, host: { hostname: 'offline', platform: MODEL_PROFILES[profile].platform, home }, node: { path: node, digest: digest(fs.readFileSync(node)) },
        engine: { path: engine, digest: digest(fs.readFileSync(engine)), identityDigest: engineIdentityDigest(fakeEngineInfo(HOST)) }, boxImage: `docker.io/assistos/box@sha256:${'f'.repeat(64)}`, llm: { image: IMAGE }, model: modelPin(profile),
        ...(['apple', 'apple-cpu'].includes(profile) ? { workspaceParentRoot: root } : { ssh: { alias: 'ubuntu-codex', sshBinary: ssh, address: '192.168.1.63', hostKeyAlias: '192.168.1.63', user: 'offline', knownHosts, identityFile: null } }),
        ...(fault.allowHostProcesses ? { allowHostProcesses: fault.allowHostProcesses } : {}),
        ...(profile === 'nvidia' ? { gpu: { uuid: 'GPU-12345678', name: 'offline GPU', driverVersion: '595.1', memoryMiB: 6144, smi: { path: engine, digest: digest(fs.readFileSync(engine)) } } } : {}) };
    const runId = crypto.randomBytes(16).toString('hex');
    if (fault.measurement) pins.model.measurement = { schema: 1, comparisonId: 'a'.repeat(32), cohort: 1, scenario: fault.measurement };
    const candidate = { root: source, digest: liveSourceDigest(source), revision: 'a'.repeat(40), llm: { revision: 'b'.repeat(40) } };
    const payload = path.join(evidence, 'candidate.tar'); candidate.payload = { path: payload, ...writeUstar(source, payload) };
    const run = buildConcreteManifest({ block: MODEL_PROFILES[profile].block, runId, configDigest: digest('config'), casesDigest: digest('cases'), documentSuffix: 'codex', pins, candidate, image: IMAGE, ports: { tcp: 23456, udp: 34567 }, unsupported: {} });
    if (run.target.stage) {
        fs.mkdirSync(run.target.stage.root, { recursive: true, mode: 0o700 }); fs.chmodSync(run.target.stage.root, 0o700);
        fs.writeFileSync(path.join(run.target.stage.root, '.ploinky-hwl-owner'), runId);
        fs.cpSync(source, path.join(run.target.stage.root, 'source'), { recursive: true });
    }
    const artifacts = new Map(); const calls = []; let box = null; let agent = null; let running = false; let runnerEpoch = 0;
    const value = observation(profile);
    let apuTime = 0; let apuSeq = 0; let apuLogs = []; let apuLaunch = null; let apuPhase = 'idle'; let apuReads = 0; let apuJobs = 0; let apuActivityMs = 0;
    // A cold first Run passes through the controller's transfer phases before its launch.
    let apuTransfer = fault.transfer ? [...fault.transfer] : []; let apuPendingLaunch = null; const apuTransferSeen = [];
    const apuHostTimings = { gate: { clock: () => ++apuTime, wait: async ms => { apuTime += ms; } } };
    const fail = text => ok('', { status: 1, stderr: text });
    const prefix = `/user.slice/libpod-${'1'.repeat(64)}.scope`;
    const leaf = `${prefix}/${fault.controllerHeavy ? 'engine/agents/' : ''}libpod-${'2'.repeat(64)}`;
    const controllerFiles = Array.from({ length: 90 }, (_, index) => `controller.${index}`);
    const cgroupChildren = { [prefix]: ['engine'], [`${prefix}/engine`]: ['agents'], [`${prefix}/engine/agents`]: [`libpod-${'2'.repeat(64)}`] };
    const bootId = '11111111-2222-4333-8444-555555555555';
    // The budget-off host capture had [244954, 1] for the Box and
    // [249565, 3190, 1] for its agent init, in the same Box cgroup.
    let factsReads = 0; let reused = false; let loadingChecks = 0;
    const hostProc = { bootId: () => bootId, uid: () => process.getuid(),
        pidNamespace(pid) {
            if (fault.namespaceDenied) throw new Error('namespace read denied');
            return pid === 244954 || fault.unrelatedBox && pid === 200 ? 'pid:[4026533239]'
                : fault.siblingNamespace && pid === 200 ? 'pid:[4026533481]' : 'pid:[4026533317]';
        },
        observe(pid) {
            if (!(pid === 244954 && box || pid === 249565 && agent || pid === 200 && running)) return null;
            return { hostPid: pid, ppid: 1, startIdentity: pid === 244954 ? '13787279' : pid === 249565 ? '13812476' : reused ? '9999' : '1234',
                bootId, cgroup: pid === 244954 || fault.sharedCgroup ? prefix : leaf,
                nspid: pid === 244954 ? [244954, 1] : pid === 249565 ? [249565, 3190, 1] : [200, 3380, 42], uid: { effective: process.getuid() } };
        },
        cgroupDirectories: directory => fault.sharedCgroup ? [] : fault.controllerHeavy
            ? Object.hasOwn(cgroupChildren, directory) ? [...controllerFiles, ...cgroupChildren[directory]] : []
            : directory === prefix ? [`libpod-${'2'.repeat(64)}`] : [],
        cgroupProcs: directory => directory === prefix ? [244954, ...(fault.sharedCgroup ? [249565, ...(running ? [200] : [])] : [])]
            : !fault.sharedCgroup && directory === leaf ? [249565, ...(running ? [200] : [])]
                : fault.controllerHeavy && [`${prefix}/engine`, `${prefix}/engine/agents`].includes(directory) ? [] : null };
    // The product's per-workspace decision record, saved as gpuGrant.mjs does: version, identity, vendor, agents, the
    // admitted wiring and `workspaceDenied`, one line, mode 0600, by temporary file and rename in a 0700 directory.
    const saveGrantRecord = (workspace, admitted) => {
        const identity = buildWorkspaceIdentity(workspace);
        const directory = path.join(workspace, '.ploinky-box', 'gpu-grants');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const target = path.join(directory, `${identity.instance}.json`);
        const temporary = path.join(directory, `.${identity.instance}.json.${crypto.randomUUID()}.tmp`);
        fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, instance: identity.instance, pathHash: identity.pathHash, workspaceRoot: workspace, vendor: 'nvidia', agents: [], admitted, workspaceDenied: true })}\n`, { mode: 0o600 });
        fs.renameSync(temporary, target);
    };
    const provider = async (binary, args, options) => {
        calls.push({ binary, args, env: options.env, cancelled: Boolean(options.signal?.aborted) });
        assert.ok(!args.some(arg => String(arg).includes('/.ploinky/repos/')), 'No managed source operation');
        if (options.signal?.aborted) return ok('', { status: null, cancelled: true });
        if (args.includes(LINUX_HOST_SAMPLE)) {
            const pin = pins.model.amd;
            return ok(JSON.stringify({ identity: { pci: pin.pci, render: pin.render, kernel: pin.host.kernel, os: pin.host.os,
                memTotalBytes: pin.host.memTotalBytes, memory: pin.memory }, totalBytes: pin.host.memTotalBytes, availableBytes: pin.host.availableBytes,
                swapTotalBytes: 0, swapUsedBytes: 0, psiFull: 0, busyPercent: 0, vramUsedBytes: 100, gttUsedBytes: 100 }));
        }
        if (args.includes(APU_ENV_FACTS)) return ok(JSON.stringify({ switchMatched: profile !== 'amd-apu-cpu', floorMatched: profile === 'amd-apu-pressure', unexpectedSwitch: false, unexpectedFloor: false }));
        if (args.includes(APU_DISCOVERY)) return ok(JSON.stringify({ vulkan: pins.model.amd.vulkan, devices: pins.model.amd.devices }));
        if (binary === '/usr/sbin/sysctl') return ok(args.at(-1) === 'machdep.cpu.brand_string' ? 'Offline Apple' : args.at(-1) === 'hw.memsize' ? String(16 * 2 ** 30) : args.at(-1) === 'vm.swapusage' ? 'used = 0.00M' : args.at(-1) === 'kern.memorystatus_level' ? '50' : '1');
        if (binary === '/usr/bin/sw_vers') return ok('offline');
        if (binary === '/bin/ps') return ok('123 1024000 /opt/bin/krunkit\n');
        if (args[0] === 'machine') return ok(JSON.stringify(args[1] === 'list' ? [{ Name: 'owned-test', VMType: 'libkrun', Running: true }] : [{ Name: 'owned-test', State: 'running', Rootful: false, Resources: { CPUs: 4, Memory: 6144 } }]));
        if (args[0] === 'system') return ok(JSON.stringify([{ Name: 'owned-test', URI: pins.model.apple.uri, Default: true }]));
        if (args.includes('-q') && args.includes('-x')) {
            if (running && fault.loading) loadingChecks += 1;
            const rows = running ? [{ pid: 200, type: 'C' }, ...(fault.foreign ? [{ pid: 999, type: 'C' }] : [])] : fault.foreignBefore ? [{ pid: 999, type: 'C' }] : [];
            return ok(`<nvidia_smi_log><gpu id="0"><uuid>GPU-12345678</uuid><compute_mode>Default</compute_mode><fb_memory_usage><total>6144 MiB</total><used>100 MiB</used><free>6044 MiB</free></fb_memory_usage><processes>${rows.map(row => `<process_info><pid>${row.pid}</pid><type>${row.type}</type></process_info>`).join('')}</processes></gpu></nvidia_smi_log>`);
        }
        if (binary === node && args.includes('start')) {
            assert.equal(options.env.PLOINKY_BOX_HARDWARE_LIMITS, 'off');
            const identity = buildWorkspaceIdentity(options.cwd);
            box = { id: '1'.repeat(64), created: '2026-10-12T00:00:00Z', image: 'f'.repeat(64), imageName: pins.boxImage, running: true, pid: 244954,
                labels: { [BOX_LABELS.pathHash]: identity.pathHash, [BOX_LABELS.role]: 'box', [BOX_LABELS.imageRef]: pins.boxImage,
                    ...agentLibLabels(imageProvider('f'.repeat(64))) }, mounts: [{ Type: 'bind', Source: options.cwd, Destination: options.cwd, RW: true }], devices: ['/dev/fuse', '/dev/net/tun'].map(name => ({ PathOnHost: name, PathInContainer: name })) };
            agent = { id: '2'.repeat(64), pid: 3190, name: fixtureContainerName(options.cwd, 'local-llm', 'local-llms'), created: box.created, image: CONFIG.slice(7), imageName: IMAGE, running: true, labels: {}, devices: [], mounts: [{ Source: path.join(options.cwd, 'local-llms', 'local-llm'), Destination: '/code', RW: false }] };
            stageModelFixture({ ...run.target.execution, box }, agent);
            // After the health check the product saves the decision record again with the admitted wiring (a new
            // file: temporary file and rename) and writes the generation directory of that wiring beside it.
            if (profile === 'apple-cpu') {
                const fingerprint = 'f'.repeat(64);
                saveGrantRecord(options.cwd, { fingerprint });
                const generation = path.join(options.cwd, '.ploinky-box', 'gpu-grants', buildWorkspaceIdentity(options.cwd).instance, fingerprint);
                fs.mkdirSync(generation, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(generation, 'wiring.json'), '{"state":"revoked"}\n', { mode: 0o600 });
            }
            if (profile === 'apple' || profile.startsWith('amd-apu') && profile !== 'amd-apu-cpu') { agent.devices = []; box.devices = []; }
            return ok();
        }
        if (binary === node && args.includes('destroy')) {
            if (fault.destroy) return fail('injected destroy failure');
            box = null; agent = null; running = false; return ok();
        }
        if (binary === node && args.includes('gpu')) {
            // The product's `gpu revoke` without `--agent` saves the workspace decision record in the workspace's own
            // state directory (supervisor.mjs, gpuGrant.mjs); the run's host record is recorded right after it.
            if (args.includes('revoke') && !args.includes('--agent')) saveGrantRecord(options.cwd, null);
            return ok();
        }
        if (args[0] === 'info') return ok(JSON.stringify(fakeEngineInfo(HOST)));
        if (args.includes(LLM_TOOL_CALL)) {
            const at = args.indexOf(LLM_TOOL_CALL); const tool = args[at + 1];
            assert.equal(JSON.parse(args[at + 3]).agent, 'local-llm', 'ordinary calls pin the exact advertised route before dispatch');
            if (fault.toolReply) return ok(fault.toolStdout ?? JSON.stringify(fault.toolReply), fault.toolTransport);
            if (profile.startsWith('amd-apu')) {
                const input = JSON.parse(args[at + 2]);
                if (tool === 'local_llm_run') {
                    const activity = () => ({ ...fakeApuActivity(++apuActivityMs), modelJobsStarted: apuJobs });
                    if (input.requestId.endsWith('-l9')) {
                        const selected = run.target.execution.model.refusal.selected;
                        return ok(JSON.stringify({ ok: false, agent: 'local-llm', error: { code: `admission_${selected.status.replace('-', '_')}`,
                            details: { admission: { status: selected.status, estimate: { constraint: selected.constraint } }, apuAttempt: {
                                schema: 1, attemptId: 'attempt-01234567', controllerInstanceId: 'controller-01234567', requestId: input.requestId,
                                modelId: input.modelId, runnerId: input.runnerId, params: input.params, boundary: 'initial-admission', before: activity(2), after: activity(3) } } } }));
                    }
                    apuJobs++; apuReads = 0; apuLaunch = null;
                    const logSeqStart = apuSeq; const deploymentId = `deployment-${apuJobs}`;
                    const launch = () => {
                        running = true;
                        apuPhase = input.requestId.endsWith('-l11') || input.requestId.endsWith('-l10') ? 'starting' : 'ready';
                        apuLogs.push({ seq: ++apuSeq, stream: 'controller', line: 'phase starting' });
                        apuLogs.push({ seq: ++apuSeq, stream: 'controller', line: 'starting /opt/llama.cpp-vulkan/llama-server --api-key SECRET' });
                        apuLaunch = { controllerInstanceId: 'controller-01234567', deploymentId, requestId: input.requestId,
                            pid: 42, command: '/opt/llama.cpp-vulkan/llama-server', launchSeq: apuSeq, logSeqStart, startedMonotonicMs: 100, guardStop: null };
                        apuLogs.push({ seq: ++apuSeq, stream: 'stderr', line: 'loading model tensors, this can take a while...' });
                    };
                    Object.assign(value.status.deployment, { id: deploymentId, requestId: input.requestId, logSeqStart, params: input.params });
                    if (apuTransfer.length) { running = false; apuPhase = apuTransfer.shift(); apuPendingLaunch = launch; } else launch();
                }
                if (tool === 'local_llm_stop') { running = false; apuPhase = 'idle'; apuLogs.push({ seq: ++apuSeq, stream: 'controller', line: 'phase idle' }); }
                if (tool === 'local_llm_status') {
                    if (profile === 'amd-apu-pressure' && running && ++apuReads >= 2) {
                        running = false; apuPhase = 'error'; apuLogs.push({ seq: ++apuSeq, stream: 'controller', line: 'stopped: memory floor' });
                        apuLaunch.guardStop = { kind: 'host-memory-floor', seq: apuSeq, floorBytes: run.target.execution.model.guardFloorBytes,
                            availableBytes: pins.model.amd.host.availableBytes, killRequestedMonotonicMs: 600, settledMonotonicMs: 601, settlement: 'resolved', valid: true };
                    }
                    const current = apuPendingLaunch ? { phase: apuPhase, launch: false } : null;
                    if (apuPendingLaunch && !apuTransfer.length) { const launch = apuPendingLaunch; apuPendingLaunch = null; current.after = () => launch(); }
                    const raw = { ...clone(value.status), phase: apuPhase, deployment: apuLaunch || current ? { ...clone(value.status.deployment), phase: apuPhase } : null,
                        logs: apuLogs.filter(row => row.seq > (input.sinceSeq || 0)).slice(-200), nextSeq: apuSeq,
                        apuActivity: { ...fakeApuActivity(++apuActivityMs), modelJobsStarted: apuJobs, runnerRunning: running },
                        apuObservation: apuLaunch ? { ...apuLaunch, running, firstSeq: 1, nextSeq: apuSeq } : null };
                    if (current) { apuTransferSeen.push(raw.phase); if (current.after) current.after(); else apuPhase = apuTransfer.shift(); }
                    fault.apuStatus?.(raw);
                    return ok(JSON.stringify({ ok: true, agent: 'local-llm', result: projectApuEvidence(raw, input.sinceSeq || 0) }));
                }
            }
            if (tool === 'local_llm_test_prompt' && fault.providerOverlayAfter) {
                box.mounts.push({ Type: 'bind', Source: '/foreign', Destination: '/opt/ploinky-agentlib/main.mjs', RW: true });
            }
            if (tool === 'local_llm_run') {
                running = !apuPendingLaunch;
                if (fault.measurement) {
                    runnerEpoch++; value.processes[0].start = String(1234 + runnerEpoch);
                    value.status.deployment.params = JSON.parse(args[at + 2]).params;
                    value.status.context = { totalContext: value.status.deployment.params.ctxSize,
                        perRequestContext: Math.floor(value.status.deployment.params.ctxSize / value.status.deployment.params.parallel),
                        parallel: value.status.deployment.params.parallel, kvUnified: false };
                    value.status.startupObservation = { controllerEpoch: 'offline-epoch', deploymentId: `deployment-${runnerEpoch}`, runnerIdentity: { runnerStartId: `runner-${runnerEpoch}`, pid: 42 },
                        pageCachePreparation: { policy: 'existing-best-effort-per-file-drop', phase: 'complete', filesConsidered: 1, attempts: 1, reportedSuccesses: 1, reportedFailures: 0, skippedNonRegular: 0, observationErrors: 0 } };
                }
            }
            if (tool === 'local_llm_test_prompt') fault.afterPrompt?.(value);
            if (tool === 'local_llm_stop') { if (fault.stop) return fail('injected stop failure'); running = false; }
            if (tool === 'local_llm_status' && fault.cancelLoad && running) return ok('', { cancelled: true, status: null });
            let result = tool === 'local_llm_overview' ? { profile: value.spec.backend, hardware: { gpu: { name: 'offline GPU', driverVersion: '595.1' } }, runners: [{ id: value.spec.runner, installed: true, version: 'b11159' }] }
                : tool === 'local_llm_status' ? running ? clone(value.status) : { phase: 'idle' }
                    : tool === 'local_llm_test_prompt' ? { ...value.answer, ...(fault.empty ? { text: '' } : {}) } : {};
            if (fault.measurement) {
                if (tool === 'local_llm_overview') result.preview = { admission: { status: 'ok' } };
                if (tool === 'local_llm_run') result = { deployment: { params: value.status.deployment.params } };
                if (tool === 'local_llm_test_prompt') result.completionTokens = 2;
            }
            if (tool === 'local_llm_status' && running && fault.loading && loadingChecks < (fault.loadingChecks || 1)) result = { phase: 'loading' };
            return ok(JSON.stringify({ ok: true, agent: fault.agent ? 'foreign-agent' : 'local-llm', result }));
        }
        if (args.includes(MODEL_PROCESS_FACTS)) {
            factsReads += 1;
            if (running && fault.reuseDuringFacts) reused = true;
            if (running && fault.replaceInit) agent.pid += 1;
            if (running && fault.factsDenied) return fail('process read denied');
            return ok(JSON.stringify({ processes: running ? value.processes : [] }), fault.oversized ? { truncated: true } : {});
        }
        if (args.includes(MEASUREMENT_WEIGHTS)) return ok(JSON.stringify({ root: 'controller-gguf-cache', files: [{ file: SMALL.file, size: SMALL.size, sha256: SMALL.sha256 }], weightsReused: true, pageCacheState: 'unverified', shaderCachePolicy: 'unchanged-no-harness-purge' }));
        if (args.includes(MEASUREMENT_MEMORY)) return ok(JSON.stringify({ vm: { totalBytes: 6 * 2 ** 30, availableBytes: 4 * 2 ** 30 }, cgroup: { 'memory.current': '1000', 'memory.peak': '2000', 'memory.max': 'max', 'memory.swap.current': '0', 'memory.events': 'oom_kill 0' }, peakKind: 'cumulative' }));
        if (args.includes(MEASUREMENT_RUNNER)) return ok(JSON.stringify({ pid: 42, start: value.processes[0].start, pgid: 42, resolvedThreads: 4, shaderCacheIdentity: profile === 'apple' ? 'a'.repeat(64) : null, flags: { '--threads': '4' } }));
        if (args.includes(MEASUREMENT_GROUP)) return ok(JSON.stringify({ ...JSON.parse(args.at(-1)), groupAbsent: !running }));
        if (args.includes(MODEL_SOURCE_VIEW)) {
            const io = modelNamespaceFs(agent.mounts, providerRoot);
            let output = '';
            vm.runInNewContext(MODEL_SOURCE_VIEW, { require: name => name === 'node:fs' ? io : name === 'node:path' ? path : crypto, Buffer,
                process: { argv: ['node', args.at(-1)], stdout: { write: text => { output += text; } } } });
            return ok(output);
        }
        if (args.includes('inspect')) {
            const wanted = args.at(-1);
            const record = wanted === box?.id ? box : wanted === agent?.id || wanted === agent?.name ? agent : null;
            if (!record) return fail('no such container');
            if ((profile === 'apple' || profile.startsWith('amd-apu')) && args.includes(APPLE_DEVICE_INSPECT)) {
                const value = { ...record, createCommand: ['podman', 'create', '--env', 'SECRET=must-not-be-emitted',
                    ...(record === box ? ['/dev/fuse', '/dev/net/tun', '/dev/dri/renderD128'] : ['ploinky.local/gpu=all']).flatMap(device => ['--device', device])] };
                fault.appleInspect?.(value); return ok(JSON.stringify(value));
            }
            const rendered = evaluateTemplate(args[args.indexOf('--format') + 1], 'inspect', inspectModel(record));
            return typeof rendered === 'string' ? ok(rendered) : rendered;
        }
        if ((profile === 'apple' || profile.startsWith('amd-apu')) && args.includes(APPLE_RENDER_FACTS)) {
            const value = { renderNodes: [{ path: '/dev/dri/renderD128', character: true, symlink: false, rdev: 57984, mode: 8630,
                uid: 65534, gid: 65534, read: true, write: true }],
            cdi: args.at(-1) === 'box' ? { device: 'ploinky.local/gpu=all', deviceNodes: [{ path: '/dev/dri/renderD128' }] } : null };
            fault.appleRender?.(value); return ok(JSON.stringify(value));
        }
        if (args.includes('ps')) return ok(box ? box.id + '\n' : '');
        throw new Error(`Unexpected offline command: ${args[0]}`);
    };
    const options = () => ({ run, processProvider: provider, hostIdentity: pins.host, hostProc, signal: fault.liveAbort?.signal, remoteArrival: MODEL_PROFILES[profile].platform !== 'darwin', artifacts: (name, data) => {
        artifactPathFor(path.join(evidence, 'run_codex.json'), name);
        fault.onArtifact?.(name);
        if (fault.proof && name === 'llm-cleanup-proof') throw new Error('injected proof write failure');
        artifacts.set(name, clone(data));
    }, persist: () => {} });
    return { root, source, pins, run, calls, artifacts, provider, options, value, hostProc, factsReads: () => factsReads, agent: () => agent, box: () => box, apuTransferSeen,
        namespace: (mounts = agent.mounts) => modelNamespaceFs(mounts, providerRoot),
        provision: () => provisionRun({ ...options(), validateProfile, apuHostTimings, portProbe: async () => ({ tcp: true, udp: true }) }),
        live: () => executeLiveRun({ ...options(), gpuTimings: { pollMs: 1, apuHost: apuHostTimings, ...(fault.loading ? { monitorMs: 1 } : {}) } }),
        cleanup: () => executeCleanupRun(options()) };
}

test('MODEL.APU canonical every-case dispatch keeps L12 pending with independent cleanup', async t => {
    const w = world(t, 'amd-apu');
    const provision = await w.provision(); assert.equal(provision.verdict, 'PASS', JSON.stringify(provision));
    const report = await w.live();
    assert.deepEqual(report.cases.map(entry => [entry.id, entry.result]), [['LIVE-L13', 'pass'], ['LIVE-L9', 'pass'], ['LIVE-L11', 'pass'], ['LIVE-L12', 'pending']], JSON.stringify(report));
    assert.equal(report.verdict, 'BLOCKED'); assert.equal(report.cleanup.state, 'complete');
    const read = name => JSON.stringify(w.artifacts.get(name));
    assert.equal(apuFetchedProofProblem({ run: w.run, fetched: w.run, remoteReport: report, action: 'live', read }), null);
    const changed = clone(report); changed.verdict = 'PASS';
    assert.match(apuFetchedProofProblem({ run: w.run, fetched: w.run, remoteReport: changed, action: 'live', read }), /nonpassing/);
    // Injected L12 validates its full remote receipt contract. The real executor
    // above remains pending and never uses this synthetic generation proof.
    const synthetic = clone(w.artifacts.get('model-live-l11'));
    // Its idle evidence is the pending L12 receipt's own current-case gate history.
    const pendingL12 = w.artifacts.get('model-live-l12');
    for (const key of ['before', 'gpuGate', 'bufferObservations']) synthetic[key] = clone(pendingL12[key] ?? []);
    const generation = fakeApuProof('LIVE-L12').proof;
    for (const key of ['launch', 'process', 'stop', 'generation', 'requestSettlement', 'promptRequestId']) synthetic[key] = generation[key];
    synthetic.case = 'LIVE-L12'; synthetic.requestId = `apu-${w.run.runId}-l12`; synthetic.launch.requestId = synthetic.requestId; synthetic.stop.requestId = synthetic.requestId;
    synthetic.deployment = { ...synthetic.deployment, phase: 'ready', apuObservation: clone(synthetic.launch), deployment: {
        ...synthetic.deployment.deployment, id: synthetic.launch.deploymentId, requestId: synthetic.requestId,
        logSeqStart: synthetic.launch.logSeqStart, phase: 'ready' } };
    delete synthetic.reason; synthetic.status = 'pass';
    const syntheticFetched = clone(w.run);
    Object.assign(syntheticFetched.operations.find(op => op.kind === 'apu-case-result' && op.case === 'LIVE-L12'), { status: 'pass', receiptDigest: jsonDigest(synthetic) });
    const syntheticReport = clone(report); syntheticReport.verdict = 'PASS'; syntheticReport.cases[3].result = 'pass';
    const syntheticRead = name => name === 'model-live-l12' ? JSON.stringify(synthetic) : read(name);
    assert.equal(apuFetchedProofProblem({ run: w.run, fetched: syntheticFetched, remoteReport: syntheticReport, action: 'live', read: syntheticRead }), null);
    for (const caseId of ['LIVE-L11', 'LIVE-L12']) for (const mutate of [p => delete p.deployment,
        p => p.deployment.deployment.modelId = 'wrong-model', p => p.deployment.deployment.runnerId = 'wrong-runner',
        p => p.deployment.deployment.artifact.sha256 = '0'.repeat(64), p => p.deployment.deployment.params.ctxSize = 512,
        p => p.deployment.deployment.requestId = 'wrong-request', p => p.deployment.apuObservation.controllerInstanceId = 'wrong-epoch']) {
        const proof = clone(caseId === 'LIVE-L12' ? synthetic : w.artifacts.get('model-live-l11')); mutate(proof);
        const fetched = clone(syntheticFetched);
        fetched.operations.find(op => op.kind === 'apu-case-result' && op.case === caseId).receiptDigest = jsonDigest(proof);
        assert.match(apuFetchedProofProblem({ run: w.run, fetched, remoteReport: syntheticReport, action: 'live',
            read: name => name === `model-${caseId.toLowerCase()}` ? JSON.stringify(proof) : syntheticRead(name) }) || '',
        /APU launched deployment (model, artifact or parameters|identity) differ/, `${caseId}: ${mutate}`);
    }
    // Each case needs its own initial idle window, every positive allowance needs
    // its recorded same-case buffer observation and the run ends in a final window.
    const l12Started = Math.max(...synthetic.gpuGate.history.filter(receipt => receipt.context?.case === 'LIVE-L12').map(receipt => receipt.startedMonotonicMs));
    for (const [name, mutate, expected] of [
        ['model-live-l12', p => { p.before.monotonicMs = l12Started + 1; }, /AMD current-case initial idle window unavailable/],
        ['model-live-l11', p => { p.bufferObservations = []; }, /AMD allocation allowance lacks its recorded case buffer observation/],
        ['model-live-l11', p => { p.bufferObservations = p.bufferObservations.map(value => ({ ...value, buffers: { ...value.buffers, kvMiB: (value.buffers.kvMiB ?? 0) + 1 } })); },
            /AMD allocation allowance lacks its recorded case buffer observation/],
        ['amd-idle-gate-final', p => { p.history.at(-1).purpose = 'operation'; }, /AMD final five-second idle window unavailable/]]) {
        const proof = JSON.parse(syntheticRead(name)); mutate(proof);
        const fetched = clone(syntheticFetched);
        const record = fetched.operations.find(op => op.kind === 'apu-case-result' && `model-${op.case.toLowerCase()}` === name);
        if (record) record.receiptDigest = jsonDigest(proof);
        assert.match(apuFetchedProofProblem({ run: w.run, fetched, remoteReport: syntheticReport, action: 'live',
            read: other => other === name ? JSON.stringify(proof) : syntheticRead(other) }) || '', expected, `${name}: ${mutate}`);
    }
    for (const change of ['missing-last', 'wrong-last', 'duplicate', 'digest', 'status', 'host-baseline', 'host-threshold']) {
        const proofs = new Map([...w.artifacts].map(([key, value]) => [key, clone(value)]));
        const fetched = clone(w.run); const remote = clone(report);
        if (change === 'missing-last') proofs.delete('model-live-l12');
        if (change === 'wrong-last') proofs.get('model-live-l12').case = 'LIVE-L7';
        if (change === 'duplicate') remote.cases[3] = clone(remote.cases[0]);
        if (change === 'digest') fetched.operations.find(op => op.kind === 'apu-case-result').receiptDigest = `sha256:${'0'.repeat(64)}`;
        if (change === 'status') remote.cases[0].result = 'pending';
        if (change === 'host-baseline') delete proofs.get('linux-host-guard').baseline;
        if (change === 'host-threshold') proofs.get('linux-host-guard').samples[0].availableBytes = 0;
        assert.ok(apuFetchedProofProblem({ run: w.run, fetched, remoteReport: remote, action: 'live', read: name => JSON.stringify(proofs.get(name)) }), change);
    }
    const cleanup = await w.cleanup(); assert.equal(cleanup.verdict, 'PASS', JSON.stringify(cleanup));
    assert.equal(apuFetchedProofProblem({ run: w.run, fetched: w.run, remoteReport: cleanup, action: 'cleanup', read }), null);
    // The cleanup action's own fresh gate never carries a case context.
    const cleanupFinal = clone(w.artifacts.get('amd-idle-gate-final'));
    assert.ok(cleanupFinal.history.every(receipt => receipt.context === null));
    cleanupFinal.history[0].context = { case: 'LIVE-L13', requestId: `apu-${w.run.runId}-l13` };
    assert.match(apuFetchedProofProblem({ run: w.run, fetched: w.run, remoteReport: cleanup, action: 'cleanup',
        read: name => name === 'amd-idle-gate-final' ? JSON.stringify(cleanupFinal) : read(name) }) || '', /cleanup idle history carries a case context/);
    assert.equal(report.verdict, 'BLOCKED');
});
test('MODEL.APU prepare/provision refuses drift before any operation', async t => {
    for (const mutate of [r => delete r.target.execution.model.env.LOCAL_LLM_AMD_APU,
        r => r.target.execution.model.guardFloorBytes--, r => r.target.execution.model.guardFloorBytes = r.target.execution.model.amd.host.memTotalBytes,
        r => r.target.plan.live = r.target.plan.live.filter(step => step.id !== 'model-amd-box-devices'),
        r => r.target.plan.provision.push({ id: 'late-var', argv: ['var', 'LOCAL_LLM_AMD_APU', 'experimental'] })]) {
        const w = world(t, 'amd-apu-pressure'); mutate(w.run);
        assert.equal((await w.provision()).verdict, 'BLOCKED'); assert.equal(w.calls.length, 0); assert.equal(w.run.operations.length, 0);
    }
});
for (const name of ['amd-apu-pressure', 'amd-apu-cpu']) test(`MODEL.APU ${name} provisions and certifies its case`, async t => {
    const w = world(t, name); const provision = await w.provision(); assert.equal(provision.verdict, 'PASS', JSON.stringify(provision));
    const report = await w.live(); assert.equal(report.verdict, 'PASS', JSON.stringify(report));
    assert.equal(apuFetchedProofProblem({ run: w.run, fetched: w.run, remoteReport: report, action: 'live', read: key => JSON.stringify(w.artifacts.get(key)) }), null);
});
test('MODEL.APU reviewed idle and deployment corruptions cannot certify a PASS pressure cohort', async t => {
    const w = world(t, 'amd-apu-pressure'); assert.equal((await w.provision()).verdict, 'PASS');
    const report = await w.live(); assert.equal(report.verdict, 'PASS', JSON.stringify(report));
    const final = artifacts => artifacts.get('amd-idle-gate-final');
    const proof = artifacts => artifacts.get('model-live-l10');
    const mutations = [a => final(a).history = [null], a => proof(a).gpuGate.history = [null],
        a => final(a).history.at(-1).samples[0] = null,
        a => final(a).history.at(-1).samples.forEach(row => row.busyPercent = 11),
        a => final(a).history.at(-1).samples[0].gttUsedBytes += 536870913,
        a => final(a).history.pop(), a => final(a).history.at(-1).state = 'pending',
        a => final(a).history.at(-1).allocationAllowanceBytes = 1,
        a => final(a).history.at(-1).idleMode = 'active',
        a => final(a).history.at(-1).samples = final(a).history.at(-1).samples.slice(0, 1),
        a => final(a).history.at(-1).samples[0].sequence = 1,
        a => final(a).history.at(-1).samples[0].monotonicMs = -1,
        a => final(a).history.at(-1).endedMonotonicMs = 0,
        a => final(a).history.find(row => row.allocationAllowanceBytes > 0).allocationAllowanceBytes++,
        a => final(a).history.find(row => row.allocationAllowanceBytes > 0).allocationEvidence.case = 'LIVE-L13',
        a => final(a).history.find(row => row.allocationAllowanceBytes > 0).allocationEvidence.status.deployment.modelId = 'wrong-model',
        a => delete proof(a).deployment,
        a => proof(a).deployment.deployment.modelId = 'wrong-model', a => proof(a).deployment.deployment.runnerId = 'wrong-runner',
        a => proof(a).deployment.deployment.artifact.sha256 = '0'.repeat(64), a => proof(a).deployment.deployment.params.parallel = 4,
        a => proof(a).deployment.profile = 'cpu', a => proof(a).deployment.deployment.profile = 'cpu',
        a => proof(a).deployment.deployment.id = 'wrong-deployment', a => proof(a).deployment.deployment.requestId = 'wrong-request',
        a => proof(a).deployment.apuObservation.pid++, a => proof(a).deployment.apuObservation.startedMonotonicMs++,
        a => proof(a).deployment.apuObservation.controllerInstanceId = 'wrong-controller'];
    for (const mutate of mutations) {
        const artifacts = new Map([...w.artifacts].map(([key, value]) => [key, clone(value)])); const fetched = clone(w.run);
        mutate(artifacts);
        fetched.operations.find(op => op.kind === 'apu-case-result').receiptDigest = jsonDigest(proof(artifacts));
        assert.ok(apuFetchedProofProblem({ run: w.run, fetched, remoteReport: report, action: 'live', read: name => JSON.stringify(artifacts.get(name)) }), String(mutate));
    }
});
test('MODEL.APU producers reject wrong launched deployment before case certification', async t => {
    for (const [profile, suffix] of [['amd-apu-pressure', '-l10'], ['amd-apu', '-l11']]) {
        const w = world(t, profile, { apuStatus: state => {
            if (state.apuObservation?.requestId?.endsWith(suffix)) state.deployment.modelId = 'wrong-model';
        } });
        assert.equal((await w.provision()).verdict, 'PASS'); const report = await w.live();
        const entry = report.cases.find(row => row.id.toLowerCase().endsWith(suffix));
        assert.equal(entry.result, 'fail'); assert.match(entry.reason, /launched deployment/);
    }
});
test('MODEL.APU cold first launch passes through transfer phases and still certifies', async t => {
    const transfer = ['downloading', 'copying', 'verifying'];
    const w = world(t, 'amd-apu', { transfer }); assert.equal((await w.provision()).verdict, 'PASS');
    const report = await w.live();
    assert.deepEqual(w.apuTransferSeen, transfer);
    assert.deepEqual(report.cases.map(entry => [entry.id, entry.result]), [['LIVE-L13', 'pass'], ['LIVE-L9', 'pass'], ['LIVE-L11', 'pass'], ['LIVE-L12', 'pending']], JSON.stringify(report));
    assert.equal(report.cleanup.state, 'complete');
    assert.equal(apuFetchedProofProblem({ run: w.run, fetched: w.run, remoteReport: report, action: 'live', read: key => JSON.stringify(w.artifacts.get(key)) }), null);
    const pressure = world(t, 'amd-apu-pressure', { transfer: ['copying', 'verifying'] }); assert.equal((await pressure.provision()).verdict, 'PASS');
    const passed = await pressure.live(); assert.equal(passed.verdict, 'PASS', JSON.stringify(passed));
    assert.deepEqual(pressure.apuTransferSeen, ['copying', 'verifying']);
    assert.equal(apuFetchedProofProblem({ run: pressure.run, fetched: pressure.run, remoteReport: passed, action: 'live', read: key => JSON.stringify(pressure.artifacts.get(key)) }), null);
});
test('MODEL.APU transfer phase after a launch observation is refused', async t => {
    // The producer: a launched runner reported back in a transfer phase fails the case.
    for (const phase of ['verifying', 'copying', 'downloading']) {
        const w = world(t, 'amd-apu', { transfer: ['verifying'], apuStatus: state => {
            if (state.apuObservation?.requestId?.endsWith('-l13') && state.phase === 'ready') { state.phase = phase; state.deployment.phase = phase; }
        } });
        assert.equal((await w.provision()).verdict, 'PASS'); const report = await w.live();
        assert.deepEqual(w.apuTransferSeen, ['verifying']);
        const entry = report.cases.find(row => row.id === 'LIVE-L13');
        assert.equal(entry.result, 'fail', phase); assert.match(entry.reason, /launched deployment model, artifact or parameters differ/, phase);
    }
    // The validator: the same pinned state passes before a launch and is refused with any launch evidence.
    const w = world(t, 'amd-apu'); assert.equal((await w.provision()).verdict, 'PASS'); await w.live();
    const profile = w.run.target.execution; const proof = w.artifacts.get('model-live-l11');
    const launched = clone(proof.deployment);
    assert.doesNotThrow(() => validateApuDeployment(launched, { profile, requestId: proof.requestId, launch: proof.launch, requireLaunch: true }));
    for (const phase of APU_TRANSFER_PHASES) {
        const before = clone(launched); before.phase = phase; before.deployment.phase = phase; before.apuObservation = null;
        assert.doesNotThrow(() => validateApuDeployment(before, { profile, requestId: proof.requestId }), phase);
        for (const options of [{ requireLaunch: true }, { launch: proof.launch }]) {
            assert.throws(() => validateApuDeployment(before, { profile, requestId: proof.requestId, ...options }), /launched deployment/, `${phase} ${JSON.stringify(Object.keys(options))}`);
        }
        const after = clone(launched); after.phase = phase; after.deployment.phase = phase;
        assert.throws(() => validateApuDeployment(after, { profile, requestId: proof.requestId }), /launched deployment/, phase);
        const wrong = clone(before); wrong.deployment.modelId = 'wrong-model';
        assert.throws(() => validateApuDeployment(wrong, { profile, requestId: proof.requestId }), /launched deployment/, phase);
        const params = clone(before); params.deployment.params = { ...params.deployment.params, ctxSize: 512 };
        assert.throws(() => validateApuDeployment(params, { profile, requestId: proof.requestId }), /launched deployment/, phase);
        const request = clone(before); request.deployment.requestId = 'wrong-request';
        assert.throws(() => validateApuDeployment(request, { profile, requestId: proof.requestId }), /launched deployment/, phase);
        const mismatched = clone(before); mismatched.deployment.phase = 'starting';
        assert.throws(() => validateApuDeployment(mismatched, { profile, requestId: proof.requestId }), /launched deployment/, phase);
    }
    const loading = clone(launched); loading.phase = 'loading'; loading.deployment.phase = 'loading'; loading.apuObservation = null;
    assert.throws(() => validateApuDeployment(loading, { profile, requestId: proof.requestId }), /launched deployment/);
});
test('MODEL.APU final idle history must extend every case snapshot and keep blocked checks on nonpassing cases', async t => {
    // Edits that keep the final history internally valid (renumbered checks and samples).
    const renumber = proof => {
        let sample = 0;
        proof.history.forEach((receipt, index) => { receipt.sequence = index + 1; for (const row of receipt.samples) row.sequence = ++sample; });
    };
    for (const name of ['amd-apu', 'amd-apu-pressure']) {
        const w = world(t, name); assert.equal((await w.provision()).verdict, 'PASS');
        const report = await w.live();
        const read = artifacts => key => JSON.stringify(artifacts.get(key));
        assert.equal(apuFetchedProofProblem({ run: w.run, fetched: w.run, remoteReport: report, action: 'live', read: read(w.artifacts) }), null, name);
        const passing = w.run.target.execution.cases.filter(caseId => w.artifacts.get(`model-${caseId.toLowerCase()}`).status === 'pass');
        assert.ok(passing.length > 0);
        const first = passing[0];
        const edits = [
            ['passing case check blocked with growth', final => {
                const receipt = final.history.find(row => row.context?.case === first);
                receipt.state = 'blocked'; receipt.samples.at(-1).gttUsedBytes += 2 * 536870912; final.tripped = true;
            }],
            ['final history truncated to its final window', final => { final.history = [final.history.at(-1)]; renumber(final); }],
            ['case initial idle window dropped from the final history only', final => {
                const index = final.history.findIndex(row => row.context?.case === first && row.idleMode === 'idle' && row.allocationAllowanceBytes === 0);
                final.history.splice(index, 1); renumber(final);
            }],
            ['passing case check blocked in the final history and in no snapshot', final => {
                // Appended after every snapshot, attributed to a passing case.
                const receipt = clone(final.history.at(-1)); receipt.context = clone(final.history.find(row => row.context?.case === first).context);
                receipt.purpose = 'operation'; receipt.state = 'blocked'; final.tripped = true; final.history.splice(final.history.length - 1, 0, receipt);
                const shift = receipt.endedMonotonicMs - receipt.startedMonotonicMs + 1;
                const last = final.history.at(-1); last.startedMonotonicMs += shift; last.endedMonotonicMs += shift;
                for (const row of last.samples) row.monotonicMs += shift;
                renumber(final);
            }],
        ];
        for (const [label, edit] of edits) {
            const artifacts = new Map([...w.artifacts].map(([key, value]) => [key, clone(value)]));
            edit(artifacts.get('amd-idle-gate-final'));
            const problem = apuFetchedProofProblem({ run: w.run, fetched: w.run, remoteReport: report, action: 'live', read: read(artifacts) }) || '';
            // A PASS report already refuses any tripped history; a BLOCKED one relies on the cross-check.
            assert.match(problem, report.verdict === 'PASS' ? /./ : /not a prefix of the final idle history|belongs to a passing case/, `${name}: ${label}`);
        }
        // A blocked final cleanup window (no case context, after every snapshot) stays a non-PASS, non-certifying fact.
        if (report.verdict !== 'PASS') {
            const artifacts = new Map([...w.artifacts].map(([key, value]) => [key, clone(value)]));
            const final = artifacts.get('amd-idle-gate-final'); final.history.at(-1).state = 'blocked'; final.tripped = true;
            assert.match(apuFetchedProofProblem({ run: w.run, fetched: w.run, remoteReport: report, action: 'live', read: read(artifacts) }) || '', /final five-second idle window/);
        }
    }
});
test('MODEL.deadlines-are-exact-per-block-and-only-L4-L5-have-the-cold-start-bound', async t => {
    const base = { coreMs: 30000, startMs: 1200000, destroyMs: 300000, fullGraphMs: 1200000, modelLoadMs: 1200000, cleanupMs: 300000, stagingMs: 600000 };
    const expected = {
        'apparatus-model-nvidia': { ...base, startMs: 3600000, blockMs: 4500000 },
        'apparatus-model-cpu': { ...base, startMs: 3600000, blockMs: 4500000 },
        'linux-model-amd-apu': { ...base, blockMs: 1440000 }, 'linux-model-amd-apu-pressure': { ...base, blockMs: 1440000 },
        'linux-model-amd-apu-cpu': { ...base, blockMs: 1440000 }, 'mac-model-venus': { ...base, blockMs: 1440000 }, 'mac-model-cpu': { ...base, blockMs: 1440000 },
        'mac-cpu': { ...base, blockMs: 1200000 }, 'apparatus-cpu': { ...base, blockMs: 1200000 }, 'apparatus-core': { ...base, blockMs: 1200000 },
        'apparatus-authority': { ...base, blockMs: 1200000 }, 'apparatus-availability': { ...base, blockMs: 3600000 },
        'apparatus-router-controls': { ...base, blockMs: 3600000 }, 'apparatus-store': { ...base, blockMs: 2700000 },
        'apparatus-mps': { ...base, blockMs: 1440000 }, 'apparatus-local-llm': { ...base, blockMs: 1440000 },
        'apparatus-vllm': { ...base, modelLoadMs: 1800000, blockMs: 16200000, installMs: 12600000, installStallMs: 600000 },
    };
    assert.deepEqual(Object.keys(CONCRETE_BLOCKS).sort(), Object.keys(expected).sort());
    for (const [block, deadlines] of Object.entries(expected)) assert.deepEqual(blockDeadlines(block, {}), deadlines, block);
    for (const block of ['mac-model-venus', 'mac-model-cpu']) {
        const measured = blockDeadlines(block, { model: { measurement: {} } });
        assert.equal(measured.startMs, 1200000); assert.equal(measured.blockMs, 1200000); assert.equal(measured.actionMs, 2400000, block);
    }
    // The remote action bound covers the 60-minute start; every other model block keeps its previous bound.
    const remoteBound = deadlines => Math.min(18_000_000, deadlines.blockMs + deadlines.cleanupMs + 30000);
    assert.equal(remoteBound(blockDeadlines('apparatus-model-nvidia', {})), 4830000);
    assert.ok(remoteBound(blockDeadlines('apparatus-model-cpu', {})) > blockDeadlines('apparatus-model-cpu', {}).startMs + 10 * 60 * 1000);
    assert.equal(remoteBound(blockDeadlines('linux-model-amd-apu', {})), 1770000);
    // The built manifests and their approval summaries record those values.
    for (const [profile, start, summarized] of [['cpu', 3600000, true], ['nvidia', 3600000, true], ['amd-apu', 1200000, false], ['apple', 1200000, false]]) {
        const w = world(t, profile);
        assert.equal(w.run.deadlines.startMs, start, profile);
        const summary = renderSummary(w.run, path.join(w.root, 'e', 'run_codex.json'));
        assert.match(summary, new RegExp(`start ${start} ms`), profile);
        assert.equal(summary.includes('the remote action bound is 4830000 ms'), summarized, profile);
    }
});
test('MODEL.APU earlier failure records every later receipt as pending', async t => {
    const w = world(t, 'amd-apu', { empty: true }); assert.equal((await w.provision()).verdict, 'PASS');
    const report = await w.live(); assert.equal(report.verdict, 'FAIL');
    assert.deepEqual(report.cases.map(entry => entry.result), ['fail', 'pending', 'pending', 'pending']);
    for (const entry of report.cases) assert.equal(w.artifacts.get(`model-${entry.id.toLowerCase()}`).status, entry.result);
});
test('MODEL.APU live prerequisite failure still binds every declared receipt', async t => {
    const w = world(t, 'amd-apu'); assert.equal((await w.provision()).verdict, 'PASS');
    const before = w.calls.length;
    const report = await executeLiveRun({ ...w.options(), hostIdentity: { ...w.pins.host, hostname: 'other-host' } });
    assert.equal(w.calls.length, before);
    assert.deepEqual(report.cases.map(entry => entry.result), ['blocked', 'pending', 'pending', 'pending']);
    for (const entry of report.cases) assert.equal(w.artifacts.get(`model-${entry.id.toLowerCase()}`).status, entry.result);
    assert.equal(w.run.operations.filter(op => op.kind === 'apu-case-result').length, 4);
});

test('MODEL.ordinary-NVIDIA-shared-Box-cgroup-registers-only-runner', async t => {
    const w = world(t, 'nvidia', { sharedCgroup: true });
    assert.equal((await w.provision()).verdict, 'PASS');
    const result = await w.live();
    assert.equal(result.verdict, 'PASS', JSON.stringify(result));
    assert.deepEqual(w.run.ownedProcesses.filter(row => row.kind === 'gpu-process').map(row => row.hostPid), [200]);
    assert.ok(w.factsReads() >= 4, 'every noninitial classification collected new safe facts');
});

test('MODEL.ordinary-NVIDIA-loading-registers-runner-and-refuses-foreign-compute', async t => {
    for (const foreign of [false, true]) {
        const w = world(t, 'nvidia', { sharedCgroup: true, loading: true, foreign });
        assert.equal((await w.provision()).verdict, 'PASS');
        const result = await w.live();
        assert.equal(result.verdict === 'PASS', !foreign, JSON.stringify(result));
        const firstFacts = w.calls.findIndex(call => call.args.includes(MODEL_PROCESS_FACTS));
        const prompt = w.calls.findIndex(call => call.args.includes('local_llm_test_prompt'));
        assert.ok(firstFacts >= 0 && (prompt === -1 || firstFacts < prompt));
        if (foreign) assert.equal(prompt, -1, 'foreign loading activity prevented inference');
    }
});

test('MODEL.ordinary-NVIDIA-fresh-identity-and-executable-proofs-fail-closed', async t => {
    const scenarios = [
        ['sibling namespace with identical inner PID/start', { siblingNamespace: true }],
        ['unrelated Box process', { unrelatedBox: true }],
        ['PID reused while safe process facts are read', { reuseDuringFacts: true }],
        ['agent init replaced during facts', { replaceInit: true }],
        ['namespace read denied', { namespaceDenied: true }],
        ['process facts read denied', { factsDenied: true }],
        ['missing facts after registration', { afterPrompt: value => { value.processes = []; } }],
        ['wrong executable after registration', { afterPrompt: value => { value.processes[0].exe = '/foreign/llama-server'; } }],
        ['wrong hash after registration', { afterPrompt: value => { value.processes[0].sha256 = '0'.repeat(64); } }],
        ['different inner PID after registration', { afterPrompt: value => { value.processes[0].pid = 43; } }],
        ['zero inner PID', {}, value => { value.processes[0].pid = 0; }],
        ['wrong executable', {}, value => { value.processes[0].exe = '/foreign/llama-server'; }],
        ['wrong hash', {}, value => { value.processes[0].sha256 = '0'.repeat(64); }],
    ];
    for (const [label, fault, mutate] of scenarios) {
        const w = world(t, 'nvidia', { sharedCgroup: true, ...fault });
        mutate?.(w.value);
        assert.equal((await w.provision()).verdict, 'PASS', label);
        const result = await w.live();
        assert.notEqual(result.verdict, 'PASS', label);
        assert.match(w.artifacts.get('model-live-l4').reason, fault.factsDenied ? /Live command failed/ : /GPU|namespace/, label);
        if (!fault.afterPrompt) assert.equal(w.run.ownedProcesses.filter(row => row.kind === 'gpu-process').length, 0, label);
        assert.ok(!w.calls.some(call => call.args.includes('kill')), label);
    }
});

test('MODEL.ordinary-NVIDIA-init-mapping-is-unique-and-pinned-to-Box-namespace-position', async t => {
    const w = world(t, 'nvidia', { sharedCgroup: true });
    assert.equal((await w.provision()).verdict, 'PASS');
    const anchor = ordinaryGpuAnchor(w.hostProc, w.box(), w.agent());
    assert.deepEqual(anchor.agentProcess.nspid, [249565, 3190, 1]);
    assert.equal(anchor.agentProcess.pidNamespace, 'pid:[4026533317]');
    assert.equal(anchor.boxProcess.cgroup, anchor.agentProcess.cgroup);
    for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => ordinaryGpuAnchor(w.hostProc, w.box(), { ...w.agent(), pid }), /init PID/);
    }
    const duplicate = { ...w.hostProc, cgroupProcs: () => [244954, 249565, 999],
        observe: pid => pid === 999 ? { ...w.hostProc.observe(249565), hostPid: 999, nspid: [999, 3190, 1] } : w.hostProc.observe(pid) };
    assert.throws(() => ordinaryGpuAnchor(duplicate, w.box(), w.agent()), /ambiguous/);
    const wrongPosition = { ...w.hostProc, observe: pid => pid === 249565 ? { ...w.hostProc.observe(pid), nspid: [249565, 777, 3190, 1] } : w.hostProc.observe(pid) };
    assert.throws(() => ordinaryGpuAnchor(wrongPosition, w.box(), w.agent()), /absent/);
    const sameNamespace = { ...w.hostProc, pidNamespace: () => 'pid:[4026533239]' };
    assert.throws(() => ordinaryGpuAnchor(sameNamespace, w.box(), w.agent()), /namespace/);
});

test('MODEL.Router-short-key-stays-bound-to-qualified-route-and-container', async t => {
    for (const mutate of [
        route => { route.repo = 'foreign'; }, route => { route.agent = 'foreign'; },
        route => { route.container = 'foreign'; }, route => { route.disabled = true; }, route => { route.draining = true; },
    ]) {
        const w = world(t); assert.equal((await w.provision()).verdict, 'PASS');
        const file = path.join(w.run.target.execution.workspace.path, '.ploinky', 'routing.json');
        const document = JSON.parse(fs.readFileSync(file)); mutate(document.routes['local-llm']); fs.writeFileSync(file, JSON.stringify(document));
        assert.notEqual((await w.live()).verdict, 'PASS');
        assert.equal(w.artifacts.get('model-tool-binding-local-llm-overview').matches, false);
        assert.ok(!w.calls.some(call => call.args.includes(LLM_TOOL_CALL)), 'wrong route refused before tool dispatch');
    }
    const w = world(t); assert.equal((await w.provision()).verdict, 'PASS');
    const file = path.join(w.run.target.execution.workspace.path, '.ploinky', 'agents.json');
    const records = JSON.parse(fs.readFileSync(file)); records[w.agent().name].containerId = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(records));
    assert.notEqual((await w.live()).verdict, 'PASS');
    assert.ok(!w.calls.some(call => call.args.includes(LLM_TOOL_CALL)));
});

test('MODEL.Router-reply-evidence-distinguishes-refusal-and-identity-without-secrets', async t => {
    for (const [toolReply, outcome] of [
        [{ ok: true, agent: 'foreign-agent', result: { token: 'must-not-be-emitted' } }, 'identity-mismatch'],
        [{ ok: false, agent: 'local-llm', error: { code: 'admission_insufficient_now', message: 'must-not-be-emitted ECONNRESET HTTP 503',
            details: { admission: { status: 'insufficient-now', reason: 'must-not-be-emitted', estimate: { ramBytes: 1234, token: 'must-not-be-emitted' } } } } }, 'tool-refusal'],
        [{ ok: false, error: { code: 'transport', message: 'ETIMEDOUT must-not-be-emitted' } }, 'tool-refusal'],
        [{ ok: false, error: { code: 'agent_identity_mismatch', message: 'must-not-be-emitted' } }, 'identity-mismatch'],
    ]) {
        const w = world(t, 'cpu', { toolReply }); assert.equal((await w.provision()).verdict, 'PASS');
        assert.notEqual((await w.live()).verdict, 'PASS');
        const evidence = w.artifacts.get('model-tool-reply-local-llm-overview');
        assert.equal(evidence.outcome, outcome);
        assert.equal(evidence.expected.ref, 'local-llms/local-llm');
        assert.equal(evidence.expected.containerId, '2'.repeat(64));
        assert.equal(JSON.stringify(evidence).includes('must-not-be-emitted'), false);
        if (toolReply.error?.code === 'admission_insufficient_now') {
            assert.equal(evidence.error.code, 'admission_insufficient_now'); assert.equal(evidence.error.errno, 'ECONNRESET');
            assert.equal(evidence.error.httpStatus, '503'); assert.equal(evidence.error.admission.estimate.ramBytes, 1234);
        }
    }
});

test('MODEL.Router-helper-opt-in-refuses-wrong-sole-agent-before-dispatch', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-route-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const auth = path.join(root, 'auth.mjs'); const client = path.join(root, 'client.mjs'); const dispatched = path.join(root, 'dispatched');
    fs.writeFileSync(auth, 'export const mintSessionJwt=()=>"must-not-be-emitted";');
    const program = LLM_TOOL_CALL.replace('/opt/ploinky/cli/server/auth/localService.js', pathToFileURL(auth).href)
        .replace('/opt/ploinky/Agent/client/MCPBrowserClient.js', pathToFileURL(client).href);
    for (const agent of ['local-llm', 'foreign-agent', 'local-llms/local-llm']) {
        fs.writeFileSync(client, `import fs from 'node:fs'; export const createAgentClient=()=>({
            listTools:async()=>[{name:'local_llm_stop',annotations:{router:{agent:${JSON.stringify(agent)}}}}],
            callTool:async()=>{fs.writeFileSync(${JSON.stringify(dispatched)},'called');return {json:{}};},close:async()=>{}});`);
        const result = spawnSync(process.execPath, ['-e', program, 'local_llm_stop', '{}', '{"agent":"local-llm"}'], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
        const doc = JSON.parse(result.stdout);
        assert.equal(doc.ok, agent === 'local-llm');
        assert.equal(fs.existsSync(dispatched), agent === 'local-llm');
        assert.ok(!result.stdout.includes('must-not-be-emitted'));
        if (agent === 'local-llm') fs.unlinkSync(dispatched);
        else assert.equal(doc.error.code, 'agent_identity_mismatch');
    }
    fs.writeFileSync(client, 'export const createAgentClient=()=>({listTools:async()=>{throw new Error("ECONNREFUSED");},close:async()=>{}});');
    const refused = spawnSync(process.execPath, ['-e', program, 'local_llm_stop', '{}', '{"agent":"local-llm"}'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(refused.status, 3);
    assert.equal(JSON.parse(refused.stdout).error.code, 'transport');
    assert.ok(!fs.existsSync(dispatched));
});

test('MODEL.Router-artifacts-follow-the-real-writer-contract', async t => {
    const w = world(t); assert.equal((await w.provision()).verdict, 'PASS');
    const report = await w.live();
    assert.equal(report.verdict, 'PASS', JSON.stringify(report));
    assert.ok(w.artifacts.has('model-tool-reply-local-llm-overview'));
});

test('MODEL.repeated-observations-exceed-512-without-consuming-mutation-journal', async t => {
    const w = world(t, 'nvidia', { sharedCgroup: true, loading: true, loadingChecks: 110 });
    assert.equal((await w.provision()).verdict, 'PASS');
    const result = await w.live();
    assert.equal(result.verdict, 'PASS', JSON.stringify(result));
    assert.ok(w.factsReads() >= 110);
    assert.ok(w.calls.filter(call => call.args.includes('inspect') || call.args.includes(MODEL_PROCESS_FACTS)).length > 512);
    assert.ok(w.run.operations.length < 128, w.run.operations.length);
    for (const kind of ['model-tool-agent', 'model-gpu-box', 'model-gpu-agent']) assert.ok(!w.run.operations.some(row => row.kind === kind), kind);
    for (const kind of ['model-local_llm_run', 'model-local_llm_test_prompt', 'model-local_llm_stop']) assert.ok(w.run.operations.some(row => row.kind === kind), kind);
});

test('MODEL.Router-transport-failures-save-bounded-diagnostics-before-refusal', async t => {
    for (const transport of [{ status: 3 }, { status: null, timedOut: true }, { truncated: true }, { cancelled: true }, { settlementForced: true }]) {
        const toolReply = { ok: false, error: { code: 'transport', message: 'ECONNREFUSED HTTP 503 must-not-be-emitted' } };
        const w = world(t, 'cpu', { toolReply, toolTransport: transport });
        assert.equal((await w.provision()).verdict, 'PASS');
        assert.notEqual((await w.live()).verdict, 'PASS');
        const evidence = w.artifacts.get('model-tool-reply-local-llm-overview');
        assert.ok(evidence, JSON.stringify(transport));
        assert.equal(evidence.outcome, 'transport-failure');
        assert.equal(evidence.error.code, 'transport'); assert.equal(evidence.error.errno, 'ECONNREFUSED');
        assert.equal(evidence.error.httpStatus, '503');
        assert.equal(evidence.transport.status, transport.status === undefined ? 0 : transport.status);
        assert.equal(JSON.stringify(evidence).includes('must-not-be-emitted'), false);
    }
    for (const toolStdout of ['{"ok":', 'x'.repeat(65537)]) {
        const w = world(t, 'cpu', { toolReply: {}, toolStdout, toolTransport: { truncated: true } });
        assert.equal((await w.provision()).verdict, 'PASS');
        assert.notEqual((await w.live()).verdict, 'PASS');
        const evidence = w.artifacts.get('model-tool-reply-local-llm-overview');
        assert.equal(evidence.outcome, 'transport-failure'); assert.equal(evidence.replyParsed, false);
        assert.equal(evidence.transport.truncated, true);
    }
});

test('MODEL.manifest-profile-pins-and-old-mode-separation', t => {
    for (const profile of Object.keys(MODEL_PROFILES)) {
        const w = world(t, profile);
        const localPins = clone(w.pins);
        if (MODEL_PROFILES[profile].platform === 'darwin') localPins.host = { hostname: os.hostname(), platform: process.platform, home: fs.realpathSync(os.homedir()) };
        if (MODEL_PROFILES[profile].platform === 'darwin' && process.platform !== 'darwin') assert.throws(() => validatePins(localPins, w.run.block), /Invalid pins/);
        else validatePins(localPins, w.run.block);
        validateProfile(w.run, { partial: true }); validateRunManifest(w.run);
        assert.equal(CONCRETE_BLOCKS[w.run.block].cases.length, MODEL_PROFILES[profile].cases?.length || 1);
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
    const proof = w.artifacts.get('model-live-l5');
    assert.equal(modelInferenceProofProblem(JSON.stringify(proof), { runId: w.run.runId, caseId: 'LIVE-L5', workspace: profile.provision.workspace.path, requirePass: true }), null);
    for (const mutate of [p => { delete p.source.binding.provider; }, p => { p.source.binding.provider.boxId = '0'.repeat(64); },
        p => { p.source.binding.provider.supplyingImageId = `sha256:${'0'.repeat(64)}`; }]) {
        const bad = clone(proof); mutate(bad);
        assert.match(modelInferenceProofProblem(JSON.stringify(bad), { runId: w.run.runId, caseId: 'LIVE-L5', workspace: profile.provision.workspace.path, requirePass: true }), /lacks runtime evidence/);
    }
    delete proof.source.binding;
    assert.match(modelInferenceProofProblem(JSON.stringify(proof), { runId: w.run.runId, caseId: 'LIVE-L5', workspace: profile.provision.workspace.path, requirePass: true }), /lacks runtime evidence/);
    assert.deepEqual(w.artifacts.get('llm-cleanup-proof').remaining, []);
    assert.equal(fs.existsSync(profile.workspace.path), false);
    const repeated = await w.live(); assert.notEqual(repeated.verdict, 'PASS');
});

test('MODEL.apple-cpu-canonical-withdrawal-host-guard-and-cleanup', async t => {
    const w = world(t, 'apple-cpu');
    assert.equal((await w.provision()).verdict, 'PASS');
    const revoke = w.calls.findIndex(call => call.args.includes('revoke'));
    const start = w.calls.findIndex(call => call.args.includes('start'));
    assert.ok(revoke >= 0 && revoke < start);
    const result = await w.live(); assert.equal(result.verdict, 'PASS', JSON.stringify(result));
    assert.equal(w.artifacts.get('model-live-l7').status, 'pass');
    assert.ok(w.artifacts.get('model-a15-host-guard').samples.length > 0);
    assert.equal(w.calls.some(call => call.args.includes('grant')), false);
});

test('MODEL.apple-cpu-grant-inventory-is-the-run-workspace-s-own', async t => {
    // The inventory is the run workspace's own `.ploinky-box/gpu-grants`, which cleanup removes with the workspace:
    // the baseline of a new workspace is empty and so is the inventory after cleanup. The standalone-cleanup test
    // below proves that a baseline which no longer matches is still refused.
    const w = world(t, 'apple-cpu');
    const workspacePath = w.run.target.execution.provision.workspace.path;
    assert.equal(fs.existsSync(workspacePath), false, 'the workspace is only proposed');
    assert.equal((await w.provision()).verdict, 'PASS');
    assert.deepEqual(w.run.preInventory.gpuGrants, [], 'a new workspace holds no grant');
    assert.deepEqual(fs.readdirSync(path.join(workspacePath, '.ploinky-box', 'gpu-grants')).sort(), [w.run.workspace.instance, `${w.run.workspace.instance}.json`].sort(), 'only the run\'s own decision record and its wiring directory exist');
    assert.ok(w.run.ownedPaths.some(entry => entry.role === 'host-record' && entry.path === path.join(workspacePath, '.ploinky-box', 'gpu-grants', `${w.run.workspace.instance}.json`)), 'the revoke record is recorded as a host record');
    const livePass = await w.live();
    assert.equal(livePass.verdict, 'PASS', JSON.stringify(livePass));
    assert.deepEqual(w.artifacts.get('model-grants-before'), { runId: w.run.runId, entries: [] });
    assert.deepEqual(w.artifacts.get('model-grants-after'), { runId: w.run.runId, entries: [] });
    assert.equal(fs.existsSync(workspacePath), false, 'the host state went with the workspace');
});

test('MODEL.apple-cpu-live-is-not-pass-when-the-run-workspace-s-grant-inventory-changes', async t => {
    // The baseline is the run workspace's own `.ploinky-box/gpu-grants`, taken before the run's own revoke record
    // exists, and compared without the run's exact recorded host records. A record added there after provision, or
    // after the case has run, is not the run's: `live` must name the change and must not pass, and the model is
    // still stopped with its proof first. The file is not named for the run's instance, so the exact-record cleanup
    // step is not what refuses it.
    const change = (grants, kind) => {
        fs.mkdirSync(grants, { recursive: true });
        if (kind === 'directory') fs.mkdirSync(path.join(grants, 'other'));
        else fs.writeFileSync(path.join(grants, 'other.json'), '{"grant":"added"}');
    };
    const stopAfterPrompt = w => {
        const tool = call => call.args.includes(LLM_TOOL_CALL) ? call.args[call.args.indexOf(LLM_TOOL_CALL) + 1] : null;
        const prompt = w.calls.findIndex(call => tool(call) === 'local_llm_test_prompt');
        return prompt >= 0 && w.calls.findIndex((call, index) => index > prompt && tool(call) === 'local_llm_stop') > prompt;
    };
    for (const [when, kind] of [['after-provision', 'file'], ['after-provision', 'directory'], ['after-the-case', 'file']]) {
        let grants = null; let fire = false;
        const w = world(t, 'apple-cpu', { onArtifact: name => { if (fire && name === 'model-live-l7') { fire = false; change(grants, kind); } } });
        assert.equal((await w.provision()).verdict, 'PASS');
        grants = path.join(w.run.target.execution.provision.workspace.path, '.ploinky-box', 'gpu-grants');
        assert.deepEqual(w.run.preInventory.gpuGrants, []);
        if (when === 'after-provision') change(grants, kind); else fire = true;
        const result = await w.live();
        assert.notEqual(result.verdict, 'PASS', `${when} ${kind}: ${JSON.stringify(result)}`);
        assert.match(JSON.stringify(result), /Unrelated GPU grant inventory changed/, `${when} ${kind}`);
        assert.equal(fire, false, `${when} ${kind}: the hook ran when armed`);
        assert.equal(stopAfterPrompt(w), true, `${when} ${kind}: the model was stopped after the prompt`);
        assert.ok(w.artifacts.get('model-stop-proof'), `${when} ${kind}: the Stop proof exists`);
        const evidence = w.artifacts.get('model-grants-changed');
        assert.deepEqual(evidence.observed.map(entry => entry.path), [kind === 'directory' ? 'other' : 'other.json'], `${when} ${kind}: the differing entry is kept, the run's own record is not in it`);
    }
});

test('MODEL.apple-cpu-live-passes-with-the-products-own-records-and-refuses-a-recorded-one-that-changed-kind', async t => {
    // `gpu revoke` saves `<instance>.json` after the baseline, and the start saves it again (a new file) and writes
    // `<instance>/<fingerprint>/`. All of it is the run's own recorded host records and is not a change. A recorded
    // record that is no longer a regular file of its recorded kind is one.
    const w = world(t, 'apple-cpu');
    assert.equal((await w.provision()).verdict, 'PASS');
    const grants = path.join(w.run.target.execution.provision.workspace.path, '.ploinky-box', 'gpu-grants');
    const name = `${w.run.workspace.instance}.json`;
    assert.deepEqual(fs.readdirSync(grants).sort(), [w.run.workspace.instance, name].sort());
    const recorded = w.run.ownedPaths.filter(entry => entry.role === 'host-record');
    assert.deepEqual(recorded.map(entry => path.basename(entry.path)).sort(), [w.run.workspace.instance, name].sort());
    const recordedInode = recorded.find(entry => entry.path.endsWith('.json')).ino;
    assert.notEqual(String(fs.statSync(path.join(grants, name)).ino), recordedInode, 'the start saved the record again: the recorded inode is stale');
    const passed = await w.live(); assert.equal(passed.verdict, 'PASS', JSON.stringify(passed));
    const changed = world(t, 'apple-cpu');
    assert.equal((await changed.provision()).verdict, 'PASS');
    const file = path.join(changed.run.target.execution.provision.workspace.path, '.ploinky-box', 'gpu-grants', name.replace(w.run.workspace.instance, changed.run.workspace.instance));
    fs.rmSync(file); fs.mkdirSync(file);
    const refused = await changed.live();
    assert.notEqual(refused.verdict, 'PASS', JSON.stringify(refused));
    assert.match(JSON.stringify(refused), /Unrelated GPU grant inventory changed/);
});

test('MODEL.apple-cpu-a-teardown-failure-is-not-masked-by-the-grant-inventory-change', async t => {
    const w = world(t, 'apple-cpu', { stop: true });
    assert.equal((await w.provision()).verdict, 'PASS');
    const grants = path.join(w.run.target.execution.provision.workspace.path, '.ploinky-box', 'gpu-grants');
    fs.writeFileSync(path.join(grants, 'other.json'), '{"grant":"added"}');
    const result = await w.live();
    assert.notEqual(result.verdict, 'PASS');
    const failures = JSON.stringify(result.cleanup.failures);
    assert.match(failures, /GPU pre-cleanup: Live command failed/, 'the teardown error is the one thrown');
    assert.doesNotMatch(failures, /GPU pre-cleanup: Unrelated/, 'and it is not replaced by the inventory error');
    assert.match(failures, /Unrelated GPU grant inventory changed/, 'the inventory error is recorded as well');
});

test('MODEL.apple-cpu-never-touches-another-workspace-s-grant-records', async t => {
    // Another workspace's `.ploinky-box` holds records of its own instance, including ones named for this run's
    // instance. None is in the run workspace's inventory and none is removed or changed by live or cleanup.
    const w = world(t, 'apple-cpu');
    const neighbour = path.join(w.root, 'neighbour-workspace', '.ploinky-box');
    const instance = w.run.workspace.instance;
    const records = new Map([
        [path.join(neighbour, 'gpu-grants', 'ploinky-box-other-0123456789ab.json'), '{"grant":"other"}'],
        [path.join(neighbour, 'gpu-grants', 'ploinky-box-other-0123456789ab', 'wiring.json'), '{}'],
        [path.join(neighbour, 'gpu-grants', `${instance}.json`), '{"grant":"same-name"}'],
        [path.join(neighbour, 'hardware-limits', instance, 'policy.json'), '{"limits":"same-name"}'],
    ]);
    for (const [file, bytes] of records) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
    const untouched = () => { for (const [file, bytes] of records) assert.equal(fs.readFileSync(file, 'utf8'), bytes, file); };
    assert.equal((await w.provision()).verdict, 'PASS');
    assert.deepEqual(w.run.preInventory.gpuGrants, [], 'the neighbour is not part of the run workspace inventory');
    const livePass = await w.live(); assert.equal(livePass.verdict, 'PASS', JSON.stringify(livePass));
    untouched();
    const cleanup = await w.cleanup(); assert.equal(cleanup.verdict, 'PASS', JSON.stringify(cleanup));
    assert.equal(fs.existsSync(w.run.target.execution.provision.workspace.path), false);
    untouched();
    assert.equal(fs.existsSync(path.join(w.pins.host.home, '.ploinky-box')), false, 'no host state is written under the home');
});

test('MODEL.allowance-reaches-the-candidate-commands-of-provision-live-and-cleanup', async t => {
    const w = world(t, 'apple-cpu', { allowHostProcesses: [4242, 17] });
    assert.equal((await w.provision()).verdict, 'PASS');
    const live = await w.live(); assert.equal(live.verdict, 'PASS', JSON.stringify(live));
    const candidate = w.calls.filter(call => call.binary === w.pins.node.path && /ploinky-box\.mjs$/.test(String(call.args[0])));
    for (const verb of ['revoke', 'start', 'destroy']) assert.ok(candidate.some(call => call.args.includes(verb)), verb);
    for (const call of candidate) assert.deepEqual(call.args.slice(1, 5), ['--allow-host-process', '4242', '--allow-host-process', '17'], call.args.join(' '));
});

test('MODEL.completed-live-run-allows-repeated-standalone-cleanup', async t => {
    for (const profile of ['apple-cpu', 'cpu', 'apple', 'nvidia']) {
        const w = world(t, profile);
        assert.equal((await w.provision()).verdict, 'PASS');
        if (profile === 'apple-cpu') assert.deepEqual(w.run.preInventory, { containers: [], gpuGrants: [] });
        assert.equal((await w.live()).verdict, 'PASS');
        assert.equal(w.run.cleanup.state, 'complete');
        for (let attempt = 0; attempt < 2; attempt += 1) {
            w.artifacts.delete('llm-cleanup-proof'); w.artifacts.delete('model-grants-after');
            const result = await w.cleanup();
            assert.equal(result.verdict, 'PASS', JSON.stringify(result));
            assert.equal(result.exitCode, 0); assert.equal(result.cleanup.state, 'complete');
            assert.deepEqual(result.cleanup.failures, []);
            const proof = w.artifacts.get('llm-cleanup-proof');
            assert.equal(proof.action, 'cleanup'); assert.equal(proof.runId, w.run.runId);
            assert.deepEqual(proof.remaining, []);
            if (profile === 'apple-cpu') assert.deepEqual(w.artifacts.get('model-grants-after'), { runId: w.run.runId, entries: [] });
        }
    }
});

test('MODEL.apple-cpu-standalone-cleanup-checks-the-complete-grant-baseline-and-ownership', async t => {
    // The workspace owns its `.ploinky-box/gpu-grants`, so the baseline of a new workspace is empty and the
    // cleanup that removes the workspace ends with the same empty inventory.
    const w = world(t, 'apple-cpu');
    assert.equal((await w.provision()).verdict, 'PASS');
    assert.deepEqual(w.run.preInventory.gpuGrants, []);
    const workspacePath = w.run.target.execution.provision.workspace.path;
    const grants = path.join(workspacePath, '.ploinky-box', 'gpu-grants');
    assert.equal((await w.live()).verdict, 'PASS');
    const cleanup = run => executeCleanupRun({ ...w.options(), run });
    const result = await w.cleanup(); assert.equal(result.verdict, 'PASS', JSON.stringify(result));
    assert.deepEqual(w.artifacts.get('model-grants-after').entries, w.run.preInventory.gpuGrants);
    assert.equal(fs.existsSync(workspacePath), false, 'the workspace and its host state are gone');
    for (const mutate of [
        run => { delete run.preInventory.gpuGrants; },
        run => { run.preInventory.gpuGrants = null; },
        run => { run.preInventory.gpuGrants = [{ path: 'unrelated', type: 'directory' }]; },
        run => { run.preInventory.gpuGrants = [{ path: 'unrelated.json', type: 'file', sha256: '0'.repeat(64) }]; },
    ]) {
        const bad = clone(w.run); mutate(bad);
        const failed = await cleanup(bad); assert.equal(failed.verdict, 'FAIL');
        assert.ok(failed.cleanup.failures.includes('Unrelated GPU grant inventory changed'));
    }
    for (const mutate of [
        run => { run.preInventory.unexpected = []; },
        run => { run.preInventory.containers = [{ id: 'short', created: 'now', image: 'image' }]; },
        run => { run.ownedPaths.push({ path: grants }); },
    ]) {
        const bad = clone(w.run); mutate(bad); const before = w.calls.length;
        assert.equal((await cleanup(bad)).verdict, 'BLOCKED');
        assert.equal(w.calls.length, before, 'invalid inventory or ownership must refuse before commands');
    }
});

test('MODEL.measurement-manifest-through-canonical-cohort-retains-receipts', async t => {
    for (const profile of ['apple', 'apple-cpu']) {
        const w = world(t, profile, { measurement: 'baseline-v1' });
        validateProfile(w.run, { partial: true });
        assert.equal((await w.provision()).verdict, 'PASS');
        const result = await w.live(); assert.equal(result.verdict, 'PASS', JSON.stringify(result));
        const receipt = w.artifacts.get('measurement-live-m1');
        validateMeasurementReceipt(receipt, { run: w.run, runId: w.run.runId, caseId: 'LIVE-M1', profile,
            configuration: w.run.target.execution.model.measurement, readArtifact: name => Buffer.from(JSON.stringify(w.artifacts.get(name), null, 2) + '\n') });
        assert.equal(receipt.trials.length, 4); assert.equal(receipt.loads.length, 2);
        assert.equal(w.artifacts.get('model-stop-proof').groupAbsent, true);
    }
});

test('MODEL.measurement-runLiveCommand-consumes-frozen-authorized-manifest', async t => {
    const w = world(t, 'apple-cpu', { measurement: 'baseline-v1' });
    assert.equal((await w.provision()).verdict, 'PASS');
    const runPath = path.join(w.root, 'e', 'run_codex.json'); const authorizationPath = path.join(w.root, 'e', 'authorization.json');
    writePrivateJson(runPath, w.run);
    writePrivateJson(authorizationPath, { schema: 1, runId: w.run.runId, manifestDigest: digest(fs.readFileSync(runPath)), targetDigest: jsonDigest(w.run.target), action: 'live' });
    const report = await runLiveCommand({ runPath, authorizationPath, action: 'live', processProvider: w.provider, hostIdentity: w.pins.host });
    assert.equal(report.verdict, 'PASS', JSON.stringify(report));
    assert.equal(JSON.parse(fs.readFileSync(artifactPathFor(runPath, 'measurement-live-m1'))).status, 'pass');
    const calls = w.calls.length;
    await assert.rejects(runLiveCommand({ runPath, authorizationPath, action: 'live', processProvider: w.provider, hostIdentity: w.pins.host }), /binding|manifest|approval/i);
    assert.equal(w.calls.length, calls);
});

test('MODEL.measurement-abort-dispatches-normal-Stop-under-fresh-cleanup-scope', async t => {
    const liveAbort = new AbortController();
    const w = world(t, 'apple', { measurement: 'longer-context-v1', liveAbort, afterPrompt: () => liveAbort.abort(Error('injected live abort')) });
    assert.equal((await w.provision()).verdict, 'PASS');
    const report = await w.live();
    assert.notEqual(report.verdict, 'PASS'); assert.equal(report.cleanup.state, 'complete', JSON.stringify(report.cleanup));
    const promptIndex = w.calls.findIndex(call => call.args.includes(LLM_TOOL_CALL) && call.args[call.args.indexOf(LLM_TOOL_CALL) + 1] === 'local_llm_test_prompt');
    const stopIndex = w.calls.findIndex((call, index) => index > promptIndex && call.args.includes(LLM_TOOL_CALL) && call.args[call.args.indexOf(LLM_TOOL_CALL) + 1] === 'local_llm_stop');
    assert.ok(promptIndex >= 0 && stopIndex > promptIndex, 'Normal Stop dispatched after live cancellation');
    assert.equal(w.calls[stopIndex].cancelled, false);
    assert.ok(w.calls.some(call => call.args.includes('destroy') && !call.cancelled));
    assert.equal(w.artifacts.get('model-stop-proof').groupAbsent, true);
    assert.notEqual(w.artifacts.get('measurement-live-m2').status, 'pass');
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

test('MODEL.apple-device-proof-injected-cohort', async t => {
    const w = world(t, 'apple');
    assert.equal((await w.provision()).verdict, 'PASS');
    const result = await w.live(); assert.equal(result.verdict, 'PASS', JSON.stringify(result));
    assert.deepEqual(result.cases.map(row => [row.id, row.result]), [['LIVE-L6', 'pass']]);
    for (const name of ['model-apple-devices-before', 'model-apple-devices-after']) {
        const proof = w.artifacts.get(name);
        assert.deepEqual(proof.box.recordedDevices, ['/dev/fuse', '/dev/net/tun', '/dev/dri/renderD128']);
        assert.deepEqual(proof.agent.recordedDevices, ['ploinky.local/gpu=all']);
        assert.equal(proof.box.renderNodes[0].rdev, proof.agent.renderNodes[0].rdev);
    }
    assert.ok(!JSON.stringify([...w.artifacts]).includes('must-not-be-emitted'));
});

test('MODEL.apple-device-proof-refuses-before-tool-dispatch', async t => {
    for (const fault of [{ appleInspect: value => { value.createCommand = []; } },
        { appleInspect: value => { value.devices = null; } },
        { appleRender: value => { value.renderNodes[0].write = false; } },
        { appleRender: value => { value.renderNodes.push(value.renderNodes[0]); } },
        { appleRender: value => { if (value.cdi) value.cdi.deviceNodes[0].path = '/dev/null'; } }]) {
        const w = world(t, 'apple', fault);
        assert.equal((await w.provision()).verdict, 'PASS');
        assert.notEqual((await w.live()).verdict, 'PASS');
        assert.ok(!w.calls.some(call => call.args.includes(LLM_TOOL_CALL)));
        assert.ok(!JSON.stringify([...w.artifacts]).includes('must-not-be-emitted'));
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
        if (MODEL_PROFILES[profile].backend !== 'cpu') for (const mutate of [o => { o.status.runnerReport.offloaded.layers = 0; }, o => { o.status.runnerReport.device = 'CPU'; }]) { const bad = clone(good); mutate(bad); assert.throws(() => assertModelObservation(bad)); }
        if (profile === 'apple') { const bad = clone(good); bad.processes[0].icd = '/wrong'; assert.throws(() => assertModelObservation(bad)); }
        if (MODEL_PROFILES[profile].backend === 'apu') for (const mutate of [o => o.status.runnerReport.kvMiB = null,
            o => o.status.runnerReport.modelMiB = 0, o => o.status.runnerReport.offloaded.of = 26,
            o => o.status.runnerReport.modelBufferRatio = 0, o => o.processes[0].icd = '/wrong', o => o.processes[0].args['-ngl'] = '0']) {
            const bad = clone(good); mutate(bad); assert.throws(() => assertModelObservation(bad));
        }
        if (MODEL_PROFILES[profile].backend === 'cpu') for (const mutate of [o => { o.processes[0].cudaVisible = '0'; }, o => { o.processes[0].nvidiaLibrary = true; }, o => { o.processes[0].args['--fit'] = 'on'; }, o => { o.processes[0].args['--n-gpu-layers'] = '99'; }]) { const bad = clone(good); mutate(bad); assert.throws(() => assertModelObservation(bad)); }
    }
});

test('MODEL.source-mount-hash-device-and-workspace-reuse-refused', async t => {
    const w = world(t); assert.equal((await w.provision()).verdict, 'PASS'); const profile = w.run.target.execution;
    const agent = clone(w.agent());
    assertModelContainer(agent, { profile, role: 'agent' });
    const captured = [];
    const binding = observeModelStage(profile, agent, { box: w.box(), write: value => captured.push(value) });
    assert.equal(binding.complete, true);
    assert.ok(!JSON.stringify(captured).includes('must-not-be-emitted'));
    const layout = modelSourceLayout(profile, agent);
    const source = path.join(profile.workspace.path, 'local-llms', 'local-llm');
    assert.equal(layout.code, source); assert.equal(binding.view.source, source);
    const view = observeModelCodeView(binding.view, w.namespace());
    assert.equal(view.complete, true, view.problem);
    assert.deepEqual(view.identity, { code: true, dependency: true });
    assert.deepEqual(view.mountPoint, { name: 'node_modules', directory: true, symbolic: false, entryCount: 0 });
    assert.equal(view.treeDigest, assertModelSource(profile).stagedTreeDigest);
    assert.ok(!view.files.some(file => file.path.startsWith('node_modules')));
    const baseDevices = ['/dev/fuse', '/dev/net/tun'].map(name => ({ PathOnHost: name, PathInContainer: name }));
    assert.doesNotThrow(() => assertModelContainer({ mounts: [], devices: baseDevices }, { profile, role: 'box' }));
    assert.throws(() => assertModelContainer({ mounts: [], devices: [...baseDevices, { PathOnHost: '/dev/dri/renderD128', PathInContainer: '/dev/dri/renderD128' }] }, { profile, role: 'box' }));
    const at = (v, destination) => v.mounts.find(mount => mount.Destination === destination);
    const dependency = binding.view.dependency;
    // Wrong /code source (another directory, the old staged tree, the dependency), writable /code,
    // a missing, writable, foreign or nested dependency mount, and any other /code or source descendant.
    for (const [label, mutate] of [
        ['no mounts', v => { v.mounts = []; }],
        ['wrong /code source', v => { at(v, '/code').Source += '/wrong'; }],
        ['old staged /code', v => { at(v, '/code').Source = path.join(profile.workspace.path, '.ploinky', 'container-runtime', agent.name, 'code-1-1'); }],
        ['/code is the dependency', v => { at(v, '/code').Source = dependency; }],
        ['writable /code', v => { at(v, '/code').RW = true; }],
        ['/code not a bind', v => { at(v, '/code').Type = 'volume'; }],
        ['duplicate /code', v => { v.mounts.push({ ...at(v, '/code') }); }],
        ['missing /code/node_modules', v => { v.mounts = v.mounts.filter(mount => mount.Destination !== '/code/node_modules'); }],
        ['writable /code/node_modules', v => { at(v, '/code/node_modules').RW = true; }],
        ['foreign /code/node_modules', v => { at(v, '/code/node_modules').Source = '/foreign/node_modules'; }],
        ['nested /code/node_modules overlay', v => { v.mounts.push({ Type: 'bind', Source: '/foreign', Destination: '/code/node_modules/achillesAgentLib', RW: false }); }],
        ['extra /code/skills', v => { v.mounts.push({ Type: 'bind', Source: path.join(profile.workspace.path, '.ploinky', 'skills', 'local-llm'), Destination: '/code/skills', RW: false }); }],
        ['/code file overlay', v => { v.mounts.push({ Type: 'bind', Source: '/wrong', Destination: '/code/main.mjs', RW: false }); }],
        ['source descendant overlay', v => { v.mounts.push({ Type: 'bind', Source: '/wrong', Destination: path.join(source, 'node_modules'), RW: false }); }],
        ['writable source self-bind', v => { at(v, source).RW = true; }],
        ['missing source self-bind', v => { v.mounts = v.mounts.filter(mount => mount.Destination !== source); }],
    ]) {
        const bad = clone(agent); mutate(bad);
        assert.throws(() => assertModelContainer(bad, { profile, role: 'agent' }), undefined, label);
        const failures = [];
        assert.throws(() => observeModelStage(profile, bad, { box: w.box(), write: value => failures.push(value) }), undefined, label);
        assert.equal(failures.at(-1).complete, false, label);
    }
    for (const mutate of [v => { v.devices = [{ PathOnHost: '/dev/nvidia0' }]; }, v => { v.id = 'a'.repeat(64); }]) {
        const bad = clone(agent); mutate(bad); assert.throws(() => assertModelContainer(bad, { profile, role: 'agent' }));
    }
    // A wrong but well-formed dependency generation under the owned store fails the stage proof.
    const otherGeneration = path.join(profile.workspace.path, '.ploinky', 'deps', 'store', 'objects', crypto.randomUUID(), 'payload', 'node_modules');
    for (const [label, mutate, pattern] of [
        ['wrong /code/node_modules generation', v => { at(v, '/code/node_modules').Source = otherGeneration; }, /admitted dependency generation/],
        ['writable dependency self-bind', v => { at(v, dependency).RW = true; }, /self-bind/],
        ['foreign dependency self-bind', v => { at(v, dependency).Source += '/wrong'; }, /self-bind/],
        ['writable data volume', v => { at(v, '/data').Source += '/wrong'; }, /volume/],
    ]) {
        const bad = clone(agent); mutate(bad); const failures = [];
        assert.throws(() => observeModelStage(profile, bad, { box: w.box(), write: value => failures.push(value) }), pattern, label);
        assert.equal(failures.at(-1).complete, false); assert.ok(failures[0].agent.mounts.length > 0);
    }
    // In the namespace, /code or /code/node_modules bound to another directory with the same bytes.
    const twin = path.join(w.root, 'twin-source'); fs.cpSync(source, twin, { recursive: true });
    const twinModules = path.join(w.root, 'twin-modules'); fs.mkdirSync(twinModules);
    fs.symlinkSync('/opt/ploinky-agentlib', path.join(twinModules, 'achillesAgentLib'));
    for (const [label, mutate, pattern] of [
        ['namespace /code is a byte-identical copy', v => { at(v, '/code').Source = twin; }, /another directory/],
        ['namespace /code/node_modules is another directory', v => { at(v, '/code/node_modules').Source = twinModules; }, /another directory/],
        ['namespace /code/node_modules absent', v => { v.mounts = v.mounts.filter(mount => mount.Destination !== '/code/node_modules'); }, /dependency mount differs/],
    ]) {
        const bad = clone(agent); mutate(bad);
        assert.match(observeModelCodeView(binding.view, w.namespace(bad.mounts)).problem || '', pattern, label);
    }
    // A symlinked /code path: the owned source replaced by a link to a byte-identical copy.
    const local = path.join(profile.workspace.path, 'local-llms');
    const realSource = path.join(local, 'real-local-llm'); fs.renameSync(source, realSource); fs.symlinkSync(realSource, source);
    assert.throws(() => observeModelStage(profile, agent, { box: w.box() }), /symlink or wrong type/);
    assert.throws(() => assertModelSource(profile), /directory changed/);
    assert.match(observeModelCodeView(binding.view, w.namespace()).problem, /roots changed/);
    fs.unlinkSync(source); fs.renameSync(realSource, source);
    // A symlink inside the source.
    const mainFile = path.join(source, 'main.mjs'); const mainBytes = fs.readFileSync(mainFile);
    const impostor = path.join(w.root, 'same-bytes.mjs'); fs.writeFileSync(impostor, mainBytes);
    fs.unlinkSync(mainFile); fs.symlinkSync(impostor, mainFile);
    assert.throws(() => assertModelSource(profile), /file changed/);
    assert.match(observeModelCodeView(binding.view, w.namespace()).problem, /symbolic link/);
    fs.unlinkSync(mainFile); fs.writeFileSync(mainFile, mainBytes);
    assert.equal(observeModelCodeView(binding.view, w.namespace()).treeDigest, view.treeDigest);
    // The mount point: missing, a symlink, a file, or holding content the dependency mount would hide.
    const point = path.join(source, 'node_modules');
    const restorePoint = () => { fs.rmSync(point, { recursive: true, force: true }); ensureCodeMountPoint(source, 'node_modules'); };
    for (const [label, mutate] of [
        ['missing mount point', () => { fs.rmdirSync(point); }],
        ['symlinked mount point', () => { fs.rmdirSync(point); fs.symlinkSync(dependency, point); }],
        ['file mount point', () => { fs.rmdirSync(point); fs.writeFileSync(point, ''); }],
        ['hidden file in mount point', () => { fs.writeFileSync(path.join(point, 'hidden.mjs'), 'export default 1;\n'); }],
        ['hidden empty directory in mount point', () => { fs.mkdirSync(path.join(point, 'hidden')); }],
    ]) {
        mutate();
        const failures = [];
        assert.throws(() => observeModelStage(profile, agent, { box: w.box(), write: value => failures.push(value) }), undefined, label);
        assert.equal(failures.at(-1).complete, false, label);
        assert.throws(() => assertModelSource(profile), undefined, label);
        assert.equal(observeModelCodeView(binding.view, w.namespace()).complete, false, label);
        restorePoint();
    }
    assert.equal(observeModelStage(profile, agent, { box: w.box() }).complete, true);
    // Extra top-level entries: a second empty directory or a file are code substitutions.
    const extraDirectory = path.join(source, 'skills'); fs.mkdirSync(extraDirectory);
    assert.throws(() => assertModelSource(profile), /entries changed/); fs.rmdirSync(extraDirectory);
    const extra = path.join(source, 'injected.mjs'); fs.writeFileSync(extra, 'export default 1;\n');
    assert.throws(() => assertModelSource(profile), /entries changed/);
    assert.notEqual(observeModelCodeView(binding.view, w.namespace()).treeDigest, view.treeDigest); fs.unlinkSync(extra);
    // The provisioned source itself must not carry a node_modules substitution.
    const frozenModules = path.join(profile.provision.llm.sourcePath, 'node_modules'); fs.mkdirSync(frozenModules);
    assert.throws(() => assertModelSource(profile), /code substitution|Frozen model source changed/); fs.rmdirSync(frozenModules);
    assert.equal(assertModelSource(profile).stagedTreeDigest, view.treeDigest);
    const recordFile = path.join(profile.workspace.path, '.ploinky', 'agents.json');
    const records = JSON.parse(fs.readFileSync(recordFile));
    for (const [label, change, pattern] of [
        ['generation', r => { r.dependencies.generationId = '0'.repeat(64); }, /integrity check/],
        ['recorded /code', r => { r.config.binds.find(bind => bind.target === '/code').source = '/wrong'; }, /Recorded source binding/],
        ['recorded writable /code', r => { r.config.binds.find(bind => bind.target === '/code').ro = false; }, /Recorded source binding/],
        ['recorded /code/node_modules', r => { r.config.binds.find(bind => bind.target === '/code/node_modules').source = '/wrong'; }, /Recorded \/code\/node_modules/],
        ['recorded writable /code/node_modules', r => { r.config.binds.find(bind => bind.target === '/code/node_modules').ro = false; }, /Recorded \/code\/node_modules/],
        ['recorded extra /code descendant', r => { r.config.binds.push({ source: '/wrong', target: '/code/skills', ro: true }); }, /unexpected descendant/],
    ]) {
        const badRecord = clone(records); change(badRecord[layout.name]);
        fs.writeFileSync(recordFile, JSON.stringify(badRecord));
        assert.throws(() => observeModelStage(profile, agent, { box: w.box() }), pattern, label);
    }
    fs.writeFileSync(recordFile, JSON.stringify(records));
    fs.writeFileSync(recordFile, 'must-not-be-emitted');
    const unreadable = [];
    assert.throws(() => observeModelStage(profile, agent, { box: w.box(), write: value => unreadable.push(value) }), /record is unreadable/);
    assert.ok(!JSON.stringify(unreadable).includes('must-not-be-emitted')); fs.writeFileSync(recordFile, JSON.stringify(records));
    // Source bytes changed after provisioning.
    fs.appendFileSync(path.join(source, 'main.mjs'), 'changed');
    assert.throws(() => assertModelSource(profile), /bytes changed/);
    assert.notEqual(observeModelCodeView(binding.view, w.namespace()).treeDigest, view.treeDigest);
    assert.notEqual((await w.provision()).verdict, 'PASS');
    assert.ok(workspaceSocketProblem('/tmp/' + 'x'.repeat(200)));
});

test('MODEL.external-provider-mount-chain-is-required', async t => {
    const changedDuringInference = world(t, 'cpu', { providerOverlayAfter: true });
    assert.equal((await changedDuringInference.provision()).verdict, 'PASS');
    const failed = await changedDuringInference.live();
    assert.notEqual(failed.verdict, 'PASS');
    assert.match(changedDuringInference.artifacts.get('model-live-l5').reason, /provider image/);
    assert.equal(failed.cleanup.state, 'failed');
    assert.equal(fs.existsSync(changedDuringInference.run.target.execution.workspace.path), true);
    const w = world(t); assert.equal((await w.provision()).verdict, 'PASS');
    const profile = w.run.target.execution; const agent = w.agent();
    const observed = observeModelStage(profile, agent, { box: w.box() });
    assert.equal(observed.complete, true);
    for (const mutate of [
        mounts => mounts.filter(mount => mount.Destination !== '/opt/ploinky-agentlib'),
        mounts => mounts.map(mount => mount.Destination === '/opt/ploinky-agentlib' ? { ...mount, Source: '/foreign', RW: true } : mount),
        mounts => mounts.map(mount => mount.Destination === '/opt/ploinky-agentlib' ? { ...mount, RW: true } : mount),
        mounts => mounts.map(mount => mount.Destination === '/opt/ploinky-agentlib' ? { ...mount, Source: '/foreign' } : mount),
        mounts => [...mounts, mounts.find(mount => mount.Destination === '/opt/ploinky-agentlib')],
        mounts => [...mounts, { Type: 'bind', Source: '/foreign', Destination: '/opt/ploinky-agentlib/main.mjs', RW: true }],
    ]) {
        const bad = { ...agent, mounts: mutate(clone(agent.mounts)) };
        assert.throws(() => observeModelStage(profile, bad, { box: w.box() }), /provider/);
    }
    for (const destination of ['/', '/opt', '/opt/ploinky-agentlib', '/opt/ploinky-agentlib/main.mjs']) {
        for (const writable of [true, false]) {
            const box = clone(w.box()); box.mounts.push({ Type: 'bind', Source: '/foreign', Destination: destination, RW: writable });
            const evidence = [];
            assert.throws(() => observeModelStage(profile, agent, { box, write: facts => evidence.push(facts) }), /provider image/);
            assert.equal(evidence.at(-1).complete, false); assert.equal(evidence[0].box.mounts.at(-1).Destination, destination);
        }
    }
    for (const mutate of [box => { box.labels = {}; }, box => { box.id = '0'.repeat(64); }, box => { box.image = '0'.repeat(64); },
        box => { box.created += 'changed'; }, box => { box.running = false; },
        box => { Object.assign(box.labels, agentLibLabels(imageProvider('0'.repeat(64)))); }]) {
        const box = clone(w.box()); mutate(box);
        assert.throws(() => observeModelStage(profile, agent, { box }));
    }
    assert.throws(() => observeModelStage(profile, agent), /provider Box/);
    const file = path.join(profile.workspace.path, '.ploinky', 'agents.json');
    const records = JSON.parse(fs.readFileSync(file));
    for (const change of [
        binds => binds.filter(bind => bind.target !== '/opt/ploinky-agentlib'),
        binds => binds.map(bind => bind.target === '/opt/ploinky-agentlib' ? { ...bind, ro: false } : bind),
        binds => binds.map(bind => bind.target === '/opt/ploinky-agentlib' ? { ...bind, source: '/foreign' } : bind),
        binds => [...binds, { source: '/foreign', target: '/opt/ploinky-agentlib/main.mjs', ro: true }],
    ]) {
        const changed = clone(records); changed[agent.name].config.binds = change(changed[agent.name].config.binds);
        fs.writeFileSync(file, JSON.stringify(changed));
        assert.throws(() => observeModelStage(profile, agent, { box: w.box() }), /Recorded model provider/);
    }
    fs.writeFileSync(file, JSON.stringify(records));
    const input = observed.view;
    assert.equal(observeModelCodeView(input, w.namespace()).provider.resolved, true);
    const absent = new Proxy(w.namespace(), { get(target, key) {
        if (typeof target[key] !== 'function') return target[key];
        return (name, ...args) => { if (name === '/opt/ploinky-agentlib') throw new Error('provider absent'); return target[key](name, ...args); };
    } });
    assert.equal(observeModelCodeView(input, absent).complete, false);
    const link = path.join(observed.view.dependency, 'achillesAgentLib');
    fs.unlinkSync(link); fs.symlinkSync('/foreign', link);
    assert.match(observeModelCodeView(input, w.namespace()).problem, /provider link/);
    assert.throws(() => observeModelStage(profile, agent, { box: w.box() }));
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

test('MODEL.cleanup-artifacts-and-exact-action-bindings', async t => {
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
    const w = world(t);
    assert.equal((await w.provision()).verdict, 'PASS');
    const cleanup = await w.cleanup(); assert.equal(cleanup.verdict, 'PASS');
    assert.equal(w.artifacts.has('model-live-l5'), false);
    const dispatchHistory = { schema: 1, runId: w.run.runId, root: w.run.target.stage.root, rootIntent: true, staged: true, identity: { dev: '1', ino: '2', uid: '1000' },
        dispatches: [{ action: 'provision', state: 'returned', manifestDigest: digest('provision') }, { action: 'cleanup', state: 'returned', manifestDigest: digest('cleanup') }] };
    const context = { profile: w.run.target.execution, action: 'cleanup', remoteReport: cleanup, fetched: w.run, dispatchHistory };
    assert.equal(modelProvisionOnlyCleanupProven(context), true);
    for (const state of ['intent', 'incomplete']) {
        const interrupted = clone(dispatchHistory); interrupted.dispatches[0].state = state;
        assert.equal(modelProvisionOnlyCleanupProven({ ...context, dispatchHistory: interrupted }), true);
    }
    assert.deepEqual(requiredArtifacts(context), ['llm-cleanup-proof']);
    assert.equal(judgeArtifacts(cleanup, { complete: true, missingRequired: [], failures: [] }).verdict, 'PASS');
    for (const state of ['intent', 'incomplete', 'returned']) {
        const attempted = clone(dispatchHistory); attempted.dispatches.splice(1, 0, { action: 'live', state, manifestDigest: digest('live') });
        assert.ok(requiredArtifacts({ ...context, dispatchHistory: attempted }).includes('model-live-l5'));
        assert.equal(judgeArtifacts(cleanup, { complete: false, missingRequired: ['model-live-l5'], failures: [] }).verdict, 'BLOCKED');
    }
    for (const mutate of [h => { h.schema = 99; }, h => { h.staged = false; }, h => { h.identity = null; }, h => { h.runId = '0'.repeat(32); }, h => { h.root += '/foreign'; }, h => { h.dispatches = []; }, h => { delete h.dispatches[0].manifestDigest; }, h => { h.dispatches[0].state = 'unknown'; }, h => { h.dispatches[0].action = 'unknown'; }, h => { h.dispatches.pop(); }]) {
        const bad = clone(dispatchHistory); mutate(bad); assert.ok(requiredArtifacts({ ...context, dispatchHistory: bad }).includes('model-live-l5'));
    }
    assert.ok(requiredArtifacts({ ...context, dispatchHistory: null }).includes('model-live-l5'));
    for (const kind of ['model-box', 'model-box-after', 'model-local_llm_run']) {
        const contradiction = clone(w.run); contradiction.operations.push({ kind });
        assert.ok(requiredArtifacts({ ...context, fetched: contradiction }).includes('model-live-l5'));
    }
});

test('MODEL.process-observer-never-emits-secret-arguments-or-environment', () => {
    const captured = []; const exe = '/opt/llama.cpp/llama-server'; const files = { '/proc/42/cmdline': [exe, '--api-key', 'do-not-output-key', '--device', 'none', '--n-gpu-layers', '0', '--fit', 'off', ''].join('\0'), '/proc/42/environ': 'API_TOKEN=do-not-output-token\0CUDA_VISIBLE_DEVICES=\0', '/proc/42/stat': '42 (llama-server) S 1 ' + Array(17).fill('0').join(' ') + ' 1234 0' };
    const fake = { readdirSync: () => ['42'], readlinkSync: () => exe, readFileSync: name => files[name], openSync: () => 1, closeSync() {}, readSync: () => 0 };
    vm.runInNewContext(MODEL_PROCESS_FACTS, { require: name => name === 'node:fs' ? fake : crypto, Buffer, process: { argv: ['node', exe], stdout: { write: text => captured.push(text) } } });
    const text = captured.join(''); assert.ok(!text.includes('do-not-output')); assert.ok(!text.includes('API_TOKEN')); assert.equal(JSON.parse(text).processes[0].args['--device'], 'none');
});
