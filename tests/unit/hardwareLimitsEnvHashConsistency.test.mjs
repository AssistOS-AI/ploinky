// The environment hash a container is created with must equal the hash every
// later start recomputes for the same, unchanged agent (amendment A2: the same
// effective values give the same hash, so nothing restarts). Both sides use the
// repository's own builders and hash functions; only the container engine is
// faked.
//
// Producer: the real ensureAgentService -> startAgentContainer path runs against
// a test-owned fake `podman`. It cannot finish offline (the Router authority
// attestation needs a real helper container), so a module-load hook adds three
// observation-only assignments to agentServiceManager.js: the `envHash` the
// creation path computes (the label of host and none networks), the
// `computeSemanticEnvHash` closure the creation path writes the managed label
// with and managed adoption compares against, each with the runtime identity
// the creation path minted, and the `buildCreateArgs` closure whose output is
// the argv the managed create runs. Nothing else is changed.
//
// The label a running container carries is READ from the creation argv, never
// taken from a computed value: host and none networks from the `create` argv the
// fake engine records, the managed network from `buildCreateArgs` after its
// label rewrite. Each is compared with the hash the creation path computed, so
// a creation path that renders a different label than it hashed fails here.
// Consumers: the graph reuse decision (ensureGraphNodesEnabled ->
// graphNodeRuntimeReplacementReason -> computeRetainedManagedEnvHash) and the
// service-level reuse check in ensureAgentService.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'node:module';
// The creation path needs the selected achillesAgentLib identity in the environment. The
// repository test runners preload this; the hardware-limits phase runner does not, and
// this file is a required phase case, so it establishes the contract itself.
import '../helpers/agentlibTestContract.mjs';

const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(['PLOINKY_WORKSPACE_ROOT', 'PLOINKY_ROUTER_HOST_PORT', 'PLOINKY_MASTER_KEY', 'CONTAINER_RUNTIME', 'PATH']
    .map((key) => [key, process.env[key]]));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-envhash-')));
const workspace = path.join(root, 'workspace');
const home = path.join(root, 'home');
const fakeBin = path.join(root, 'fakebin');
fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
fs.mkdirSync(home);
fs.mkdirSync(fakeBin);
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '8080';
process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);
process.env.CONTAINER_RUNTIME = 'podman';

// A test-owned fake engine: answers the minimum offline and never runs anything.
// `info` reports a non-rootless engine, which stops the managed creation path
// right after the creation hashes exist and before any engine mutation.
const fakeCalls = path.join(root, 'engine-calls.log');
fs.writeFileSync(path.join(fakeBin, 'podman'), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(fakeCalls)}
case "$*" in
  --version*|version*) echo "podman version 5.7.0"; exit 0 ;;
  # The runtime-key probe reports an image without Node: this test observes the environment hash, so no dependency generation is
  # prepared (the immutable dependency store builds one only for an image that has Node).
  *"process.report"*) printf '{"noNode":true}'; exit 0 ;;
  "info "*) printf '{"rootless":false,"networkBackend":"netavark","pasta":null,"serviceIsRemote":false}'; exit 0 ;;
  *"container exists"*|*"container inspect"*|"inspect "*) echo "Error: no such container" >&2; exit 1 ;;
  *"image exists"*) exit 0 ;;
  *"image inspect --format {{json .Config.Entrypoint}}"*) echo '["docker-entrypoint.sh"]'; exit 0 ;;
  *"image inspect --format {{json .Config.Cmd}}"*) echo '["node"]'; exit 0 ;;
  *"image inspect --format {{.Id}}"*) echo 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; exit 0 ;;
  *"image inspect --format"*) echo '""'; exit 0 ;;
  *"image inspect"*) echo '[{"Id":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","Config":{"User":"","Entrypoint":["docker-entrypoint.sh"],"Cmd":["node"],"WorkingDir":"/"}}]'; exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;

// Observation hook for agentServiceManager.js (loaded below, never earlier).
const HOOK = `
const ANCHORS = [
  ['    // LLM runtime opt-in: catalog-driven image, hardware-aware policy, reuse hash.', '    Object.assign(globalThis.__envHashProbe ||= {}, { creation: envHash, runtimeIdentity });\\n'],
  ['    const prepareGeneratedRouterAttestation = (plan) => {', '    Object.assign(globalThis.__envHashProbe ||= {}, { semantic: computeSemanticEnvHash, runtimeIdentity });\\n'],
  ['    // The engine create of an argv the hardware guard already produced.', '    Object.assign(globalThis.__envHashProbe ||= {}, { buildCreateArgs });\\n'],
];
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.split('?')[0].endsWith('/cli/sandbox/docker/agentServiceManager.js')) return result;
  let source = String(result.source);
  for (const [anchor, insert] of ANCHORS) {
    if (source.split(anchor).length !== 2) throw new Error('env hash observation anchor not found in agentServiceManager.js: ' + anchor.trim());
    source = source.replace(anchor, insert + anchor);
  }
  return { ...result, source, shortCircuit: true };
}
`;
register(`data:text/javascript;base64,${Buffer.from(HOOK).toString('base64')}`);

const imp = (relative) => import(new URL(relative, import.meta.url).href);
const { BOX_MARKER_CONTENT } = await imp('../../ploinky-box/constants.mjs');
const { createHardwareGateStore, resolveDesiredHardwareWiring, selectHardwareGate } = await imp('../../ploinky-box/hardwareLimitsGate.mjs');
const { buildWorkspaceIdentity } = await imp('../../ploinky-box/identity.mjs');
const { initializeStore } = await imp('../../cli/sandbox/hardwareLimits/store.mjs');
const { readBoxHardwareContext, resetHardwareContextCacheForTests } = await imp('../../cli/sandbox/hardwareLimits/context.mjs');
const { preparedCgroupFs } = await imp('../hardware-limits/fakeCgroupFs.mjs');
const { FIXTURE_REPOSITORY, fixtureManifest, fixturePlan } = await imp('../hardware-limits/liveFixture.mjs');
const workspaceUtil = await imp('../../cli/commands/workspaceUtil.js');
const workspaceSvc = await imp('../../cli/utils/workspace.js');
const dockerSvc = await imp('../../cli/sandbox/docker/index.js');
const common = await imp('../../cli/sandbox/docker/common.js');
const manager = await imp('../../cli/sandbox/docker/agentServiceManager.js');
const capabilities = await imp('../../cli/sandbox/runtimeCapabilities.js');
const profileService = await imp('../../cli/utils/runtime/profileService.js');
const structure = await imp('../../cli/utils/workspaceStructure.js');
const { deriveAgentPrincipalId } = await imp('../../cli/utils/security/agentIdentity.js');
const { PLOINKY_DIR } = await imp('../../cli/utils/config.js');

const { ensureGraphNodesEnabled, preflightWorkspaceStartRuntimeCapabilities, createGraphAvailabilityTracker } = workspaceUtil;

test.after(() => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
});

const IMAGE = `docker.io/assistos/ploinky-node@sha256:${'a'.repeat(64)}`;
const STATIC_REF = `${FIXTURE_REPOSITORY}/memory`;
const ROOT = '/sys/fs/cgroup';
const markerPath = path.join(root, 'ploinky-box');
fs.writeFileSync(markerPath, BOX_MARKER_CONTENT);
const boxMarkerOptions = { markerPath };
const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
const descriptorRoot = path.join(PLOINKY_DIR, 'run', 'router-descriptors');
fs.mkdirSync(descriptorRoot, { recursive: true });
const { initializeFreshEdgeRoutingSources } = await imp('../../cli/sandbox/edgeGeneration.js');
// The workspace state a creation finds: fresh edge routing sources (a started
// workspace has them), no registry, and the Router port its first start persisted.
function freshWorkspaceState() {
    for (const target of ['data/edge-routing', 'data/router-security', 'run/edge-topology', 'agents.json', 'routing.json']) {
        fs.rmSync(path.join(PLOINKY_DIR, target), { recursive: true, force: true });
    }
    initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    fs.writeFileSync(path.join(PLOINKY_DIR, 'routing.json'), `${JSON.stringify({ port: 8080, routes: {} })}\n`);
}
freshWorkspaceState();

const agents = fixturePlan(['LIVE-C1', 'LIVE-C2']);
const containerOf = (name) => dockerSvc.getAgentContainerName(name, FIXTURE_REPOSITORY);
const agentDir = (name) => path.join(workspace, '.ploinky', 'repos', FIXTURE_REPOSITORY, name);
const principalOf = (name) => deriveAgentPrincipalId(FIXTURE_REPOSITORY, name);
const instanceOf = (name) => identities.get(name).instanceId;
const generationOf = (name) => identities.get(name).enableGeneration;
const uuidOf = { memory: '11111111-1111-4111-8111-111111111111', cpu: '22222222-2222-4222-8222-222222222222', pids: '33333333-3333-4333-8333-333333333333' };

// ---------------------------------------------------------------------------
// Fixture agents: the live fixture's manifests (static memory agent enabling
// cpu and pids, readiness none, hardwareLimits 64m/0.5/64), on a managed
// network (the default) or on `none` (the unmanaged path host shares). `expose` carries one stable
// manifest env value the control test changes.
function writeManifests({ network = 'managed', limits = true, exposeValue = 'one', health = false } = {}) {
    for (const agent of agents) {
        const manifest = fixtureManifest(agent, { image: IMAGE, agents });
        if (!limits) delete manifest.hardwareLimits;
        if (network === 'none') {
            // `none` rejects an AgentServer entry: the same command runs as `start`.
            manifest.network = { mode: 'none' };
            manifest.start = manifest.agent;
            delete manifest.agent;
        }
        manifest.expose = { R9_CONTROL: exposeValue };
        if (health) manifest.health = { readiness: { script: 'ready.sh' } };
        fs.mkdirSync(agentDir(agent.name), { recursive: true });
        fs.writeFileSync(path.join(agentDir(agent.name), 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    }
}
const readManifest = (name) => JSON.parse(fs.readFileSync(path.join(agentDir(name), 'manifest.json'), 'utf8'));

// A fresh signed-descriptor stand-in per agent: the payload semantics creation
// hashes and the retained graph path reads back.
function descriptorPayload(name) {
    return {
        agentPrincipal: principalOf(name),
        instanceId: instanceOf(name),
        generationId: generationOf(name),
        semanticTopologyDigest: `sha256:${'ab'.repeat(32)}`,
        schema: 'ploinky.generated-local-router.v1',
        transportVersion: 'node-authority-v1',
        localStreaming: 'disabled',
    };
}
const payloads = new Map();
// The runtime identity the creation path minted per agent (the registry keeps it).
const identities = new Map();

// The `ploinky.envhash=` label values of one argv (the words the fake engine
// recorded for a call, or the array `buildCreateArgs` returns).
function envHashLabelsOf(argv) {
    const words = Array.isArray(argv) ? argv : String(argv).split(' ');
    return words.flatMap((word, index) => (words[index - 1] === '--label' && String(word).startsWith('ploinky.envhash=') ? [String(word).slice('ploinky.envhash='.length)] : []));
}
// The fake engine creates its call log on its first call.
const engineCalls = () => (fs.existsSync(fakeCalls) ? fs.readFileSync(fakeCalls, 'utf8').split('\n').filter(Boolean) : []);
// The label each agent's creation rendered, by agent name (see createdEnvHash).
const renderedLabels = new Map();

// The creation path for one agent, through the repository's ensureAgentService
// and the fake engine. Returns what the creation path hashes. The label the
// creation renders is recorded separately in renderedLabels: from the engine's
// `create` argv on host and none networks, from `buildCreateArgs` (after the
// managed label rewrite) on the managed network.
async function createdEnvHash(name, { network = 'managed' } = {}) {
    globalThis.__envHashProbe = {};
    const manifest = readManifest(name);
    const endpoint = workspaceUtil.resolveManifestRouterEndpoint(manifest, { explicitPort: 8080, path: `manifest(${FIXTURE_REPOSITORY}/${name})` });
    const callsBefore = engineCalls().length;
    let failure = null;
    try {
        await manager.ensureAgentService(name, manifest, agentDir(name), {
            routerEndpoint: endpoint,
            containerName: containerOf(name),
        });
    } catch (error) {
        failure = error;
    }
    // The fake-engine run ends mid-start and leaves its edge preparation lease
    // behind; the next creation starts from the sources a start finds.
    fs.rmSync(path.join(PLOINKY_DIR, 'data', 'edge-routing', 'preparation-lease.json'), { force: true });
    const probe = globalThis.__envHashProbe;
    assert.equal(typeof probe?.creation, 'string', `creation hashed no environment for ${name} (the fake-engine run ended with: ${failure?.message})`);
    const created = { instanceId: probe.runtimeIdentity?.instanceId, enableGeneration: probe.runtimeIdentity?.enableGeneration };
    assert.ok(created.instanceId && created.enableGeneration, `the creation path minted no runtime identity for ${name}`);
    identities.set(name, created);
    if (network !== 'managed') {
        // The engine's own record of the create this agent's creation ran.
        const name_ = containerOf(name);
        const creates = engineCalls().slice(callsBefore).filter((line) => /^create /.test(line) && line.split(' ').some((word, index, words) => words[index - 1] === '--name' && word === name_));
        assert.equal(creates.length, 1, `the creation path ran exactly one engine create for ${name} (${creates.length})`);
        const labels = envHashLabelsOf(creates[0]);
        assert.equal(labels.length, 1, `the create argv of ${name} carries exactly one ploinky.envhash label`);
        renderedLabels.set(name, labels[0]);
        return probe.creation;
    }
    assert.equal(typeof probe.semantic, 'function', `the managed creation path never defined its semantic env hash for ${name} (${failure?.message})`);
    assert.equal(typeof probe.buildCreateArgs, 'function', `the managed creation path never defined buildCreateArgs for ${name} (${failure?.message})`);
    const semantic = probe.semantic(descriptorPayload(name));
    // The managed create argv, after the label rewrite, for the launch state
    // the creation path builds (its envHash is computeSemanticEnvHash(payload),
    // pinned in the source by the managed label test below).
    const createArgv = probe.buildCreateArgs({ mode: 'default', args: [] }, {
        envHash: semantic, attested: { evidence: { target: { user: '1000:1000' } } },
        descriptorHostFile: path.join(root, 'launch-descriptor.json'), env: {},
    });
    const labels = envHashLabelsOf(createArgv);
    assert.equal(labels.length, 1, `the managed create argv of ${name} carries exactly one ploinky.envhash label after the rewrite`);
    renderedLabels.set(name, labels[0]);
    return semantic;
}

// ---------------------------------------------------------------------------
// Running containers: the registry a first start wrote, the labels the creation
// path rendered, and the descriptors the retained graph path reads back.

function registry({ network = 'managed' } = {}) {
    const reg = {};
    agents.forEach((agent, index) => {
        const key = containerOf(agent.name);
        const binds = [];
        if (network === 'managed') {
            const file = path.join(descriptorRoot, `${uuidOf[agent.name]}.json`);
            fs.writeFileSync(file, '{}', { mode: 0o600 });
            payloads.set(fs.realpathSync(file), descriptorPayload(agent.name));
            binds.push({ source: file, target: '/run/ploinky/router-descriptor.json', ro: true, generatedRouterDescriptor: true });
        }
        reg[key] = {
            type: 'agent', agentName: agent.name, repoName: FIXTURE_REPOSITORY, containerImage: IMAGE,
            runtime: 'podman', runMode: 'isolated', profile: 'default',
            projectPath: agent.name === 'memory' ? workspace : structure.getAgentDataDir(agent.name),
            instanceId: instanceOf(agent.name), enableGeneration: generationOf(agent.name),
            containerId: String(index + 1).repeat(64), auth: { mode: 'none' },
            config: { binds, env: [], ports: [] },
        };
    });
    reg._config = { static: { agent: STATIC_REF, port: 8080 } };
    workspaceSvc.saveAgents(reg);
    return reg;
}

// ---------------------------------------------------------------------------
// Hardware context and admission for the limited managed fixture, as the
// repeat-start regression builds them (cgroup fake, fixture Box marker).
const SERVED = new Map([['/proc/meminfo', 'MemTotal:     8388608 kB\n'], [`${ROOT}/memory.max`, 'max\n'], [`${ROOT}/cpu.max`, 'max 100000\n']]);
function compositeFs(fake) {
    const routed = new Set(['readFileSync', 'lstatSync', 'mkdirSync', 'writeFileSync', 'readdirSync', 'rmdirSync']);
    return new Proxy(fs, {
        get(target, property) {
            if (!routed.has(property)) return target[property];
            return (first, ...rest) => {
                const value = typeof first === 'string' ? first : '';
                if (property === 'readFileSync' && SERVED.has(value)) return SERVED.get(value);
                if (value === ROOT || value.startsWith(`${ROOT}/`) || value.startsWith('/proc/')) return fake[property](first, ...rest);
                return target[property](first, ...rest);
            };
        },
    });
}
// The wiring of the gate one start selected (the default is an on gate).
function boxContext({ enabled = true } = {}) {
    const wiring = resolveDesiredHardwareWiring({ identity, enabled, hostKind: 'podman-machine', homeDirectory: home, initializeStore });
    resetHardwareContextCacheForTests();
    const fake = preparedCgroupFs({ controllers: ['cpu', 'memory', 'pids'] });
    return readBoxHardwareContext({
        fsApi: compositeFs(fake),
        markerPath: wiring.markerPath,
        storeRoot: wiring.storeRoot,
        query: () => ({ ok: true, stdout: JSON.stringify({ host: { ociRuntime: { name: 'crun' }, cgroupManager: 'cgroupfs' } }) }),
    });
}
function admission(name, context, mode) {
    const ref = `${FIXTURE_REPOSITORY}/${name}`;
    const manifestPath = path.join(agentDir(name), 'manifest.json');
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const profile = profileService.resolveManifestRuntimeProfile(manifest, { agentName: ref, path: `manifest(${ref})` });
    return capabilities.admitManifestRuntimeCapabilities(manifest, {
        manifestBytes, manifestPath, agentId: ref, profileName: profile.resolvedProfileName, profileConfig: profile.profileConfig,
        network: profile.network, runtime: 'podman', runtimeKind: 'container', hardwareAdmission: mode, hardwareContext: context,
        boxMarkerOptions, workspaceRoot: workspace, instanceKey: containerOf(name), alias: '',
    });
}
// The limits labels of the arguments the creation path renders.
function limitsLabels(name, context) {
    const created = admission(name, context, 'strict');
    const args = capabilities.renderRuntimePolicyArgs(created.descriptor, { runtime: 'podman' });
    const found = {};
    args.forEach((value, index) => {
        if (value === '--label') { const [key, ...rest] = args[index + 1].split('='); found[key] = rest.join('='); }
    });
    return found;
}

// The graph reuse decision of one `ploinky start` process over running
// containers. Only engine reads are faked; the env hashes are the repository's.
function graphStart({ network = 'managed', limits = true, labels, gate = { enabled: true } }) {
    const reg = registry({ network });
    const context = limits ? boxContext({ enabled: gate.enabled }) : undefined;
    const preflight = preflightWorkspaceStartRuntimeCapabilities(STATIC_REF, { hardwareContext: context, boxMarkerOptions });
    const unavailable = new Set(createGraphAvailabilityTracker(preflight.graph, preflight.admissions).unavailableEntries().map((entry) => entry.nodeId));
    const removed = [];
    const prepared = ensureGraphNodesEnabled(preflight.graph, preflight.registry, {
        hardwareContext: context,
        boxMarkerOptions,
        unavailableNodeIds: unavailable,
        prepareAgentEnableBatch: () => ({ plans: [], preparedGeneration: { selector: { state: 'inactive' } } }),
        saveAgents() {}, loadRouting: () => ({ routes: {} }), saveRouting() {}, inactivateGeneration() {}, retireNoWaitMarkers() {},
        removeAgentContainerForRecreate: (key, reason) => removed.push({ key, reason }),
        executionRecordOptions: { workspaceRoot: workspace },
        runtimeReplacementOptions: {
            containerExistsImpl: () => true,
            isContainerRunningImpl: () => true,
            getRuntimeForAgentImpl: () => 'podman',
            getRuntimeImpl: () => 'podman',
            getContainerLabelImpl: (key, label) => labels[key]?.[label] ?? '',
            createNetworkLifecycleAdapterImpl: () => ({ inspectContainerContract: () => ({ state: 'exact', running: true }) }),
            retainedManagedEnvHashOptions: { descriptorRoot, readDescriptorFileImpl: (file) => ({ payload: payloads.get(fs.realpathSync(file)) }) },
            // The production graph reuse admission reads the fixed
            // /etc/ploinky-box marker; the fixture marker and context stand in.
            ...(limits ? { admitRuntimeImpl: (node) => ({ descriptor: admission(node.shortAgentName, context, 'metadata').descriptor }) } : {}),
        },
    });
    return { prepared, removed, reg, unavailable, context };
}

async function runningLabels({ network = 'managed', limits = true }) {
    freshWorkspaceState();
    const context = limits ? boxContext() : undefined;
    const labels = {};
    for (const agent of agents) {
        const computed = await createdEnvHash(agent.name, { network });
        // The running container carries the label its creation RENDERED. It must
        // be the hash the creation path computed: a label rendered from anything
        // else (or not at all) is the defect this file exists to catch.
        assert.equal(renderedLabels.get(agent.name), computed, `${agent.name}: the label the creation renders equals the hash the creation path computed`);
        labels[containerOf(agent.name)] = {
            ...(limits ? limitsLabels(agent.name, context) : {}),
            'ploinky.envhash': renderedLabels.get(agent.name),
        };
    }
    return labels;
}

// The saved-gate store of the workspace: the first start saved its gate, so a
// later start with no environment value selects the saved one (selectHardwareGate,
// the repository's own selection). The gate-off world (limits false) has no gate.
const gateStore = createHardwareGateStore({ homeDirectory: home });
const gateLock = { assertHeld() {} };

test('EH.managed-repeat-start-reuses-every-unchanged-agent-on-the-environment-gate-and-the-saved-gate', async () => {
    writeManifests({ network: 'managed', limits: true });
    const labels = await runningLabels({ network: 'managed', limits: true });
    for (const label of Object.values(labels)) assert.match(label['ploinky.envhash'], /^[a-f0-9]{64}$/, 'the creation path wrote an environment hash');
    const first = selectHardwareGate({ identity, gateStore, env: { PLOINKY_BOX_HARDWARE_LIMITS: 'on' }, operation: 'start' });
    assert.deepEqual([first.enabled, first.source], [true, 'environment']);
    gateStore.write(identity, first.enabled, gateLock);
    for (const [start, env, source] of [
        ['environment gate', { PLOINKY_BOX_HARDWARE_LIMITS: 'on' }, 'environment'],
        ['saved gate', {}, 'saved'],
    ]) {
        // Each repeat start selects its own gate before the graph decision.
        const gate = selectHardwareGate({ identity, gateStore, env, operation: 'start' });
        assert.deepEqual([gate.enabled, gate.source, gate.persist], [true, source, false], `${start}: the repository selects the ${source} gate`);
        const result = graphStart({ network: 'managed', limits: true, labels, gate });
        assert.deepEqual([...result.unavailable], [], `${start}: no agent is refused`);
        assert.deepEqual(result.removed.map((entry) => `${entry.key}: ${entry.reason}`), [], `${start}: no agent is replaced (envHashChanged would be the defect)`);
        assert.deepEqual(result.prepared.changedContainers, [], `${start}: no agent is planned for replacement`);
    }
});

test('EH.none-repeat-start-reuses-every-unchanged-agent-on-a-first-and-a-second-repeat-start', async () => {
    // A none-network, limit-free fixture has no hardware gate: both starts are
    // the same graph decision, which is all this test claims.
    writeManifests({ network: 'none', limits: false });
    const labels = await runningLabels({ network: 'none', limits: false });
    for (const label of Object.values(labels)) assert.match(label['ploinky.envhash'], /^[a-f0-9]{64}$/, 'the creation path wrote an environment hash');
    for (const start of ['first repeat start', 'second repeat start']) {
        const result = graphStart({ network: 'none', limits: false, labels });
        assert.deepEqual([...result.unavailable], [], `${start}: no agent is refused`);
        assert.deepEqual(result.removed.map((entry) => `${entry.key}: ${entry.reason}`), [], `${start}: no agent is replaced (envHashChanged would be the defect)`);
        assert.deepEqual(result.prepared.changedContainers, [], `${start}: no agent is planned for replacement`);
    }
});

// ---------------------------------------------------------------------------
// The label the creation argv carries. The running label of the tests above is
// read from it; these two pin the claim directly, so a creation path that
// corrupts `--label ploinky.envhash=...` (or the managed rewrite of it) fails a
// test named for it, not only a reuse decision.

test('EH.none-label-the-creation-argv-renders-equals-the-hook-value-and-the-graph-recompute', async () => {
    writeManifests({ network: 'none', limits: false });
    const labels = await runningLabels({ network: 'none', limits: false });
    for (const agent of agents) {
        const rendered = renderedLabels.get(agent.name);
        assert.match(rendered, /^[a-f0-9]{64}$/, `${agent.name}: the engine create argv carries a full ploinky.envhash label`);
        assert.equal(labels[containerOf(agent.name)]['ploinky.envhash'], rendered);
    }
    // Hook value: createdEnvHash returned it and runningLabels asserted it equals
    // the rendered label. Graph recompute: the graph decision over the rendered
    // labels replaces nothing, and a label that differs by one character replaces
    // exactly that agent with reason envHashChanged.
    assert.deepEqual(graphStart({ network: 'none', limits: false, labels }).removed, [], 'the graph recompute equals the rendered label');
    const corrupted = structuredClone(labels);
    const key = containerOf('cpu');
    corrupted[key]['ploinky.envhash'] = `${labels[key]['ploinky.envhash'].slice(0, 63)}${labels[key]['ploinky.envhash'].endsWith('0') ? '1' : '0'}`;
    assert.deepEqual(graphStart({ network: 'none', limits: false, labels: corrupted }).removed.map((entry) => [entry.key, entry.reason]),
        [[key, `workspaceGraph:${FIXTURE_REPOSITORY}/cpu:envHashChanged`]], 'the decision reads the rendered label');
});

test('EH.managed-label-rewrite-renders-the-semantic-hash-exactly-once', async () => {
    writeManifests({ network: 'managed', limits: true });
    const labels = await runningLabels({ network: 'managed', limits: true });
    const reg = registry({ network: 'managed' });
    for (const agent of agents) {
        const rendered = renderedLabels.get(agent.name);
        assert.equal(labels[containerOf(agent.name)]['ploinky.envhash'], rendered);
        // The graph's retained recompute (the consumer of this label) equals the rendered one.
        const node = { repoName: FIXTURE_REPOSITORY, shortAgentName: agent.name, manifest: readManifest(agent.name), profile: '' };
        const profile = profileService.resolveManifestRuntimeProfile(node.manifest, { agentName: `${FIXTURE_REPOSITORY}/${agent.name}`, path: 'manifest' });
        const plan = manager.buildRuntimeNetworkPlan('podman', profile.network);
        assert.equal(workspaceUtil.computeRetainedManagedEnvHash(node, reg[containerOf(agent.name)], profile.profileConfig, plan, {
            descriptorRoot, readDescriptorFileImpl: (file) => ({ payload: payloads.get(fs.realpathSync(file)) }),
        }), rendered, `${agent.name}: the graph recompute equals the label the managed create renders`);
    }
    // The launch state the managed creation builds carries
    // computeSemanticEnvHash(payload), and the rewrite renders launch.envHash:
    // the two source facts the observation above cannot reach offline.
    assert.match(managerSource, /const semanticEnvHash = computeSemanticEnvHash\(payload\);[\s\S]{0,240}envHash: semanticEnvHash,/);
    assert.match(managerSource, /createArgs\[index \+ 1\] = `ploinky\.envhash=\$\{launch\.envHash\}`;/);
});

// ---------------------------------------------------------------------------
// Control: a genuine, stable environment change replaces exactly that agent
// once, with reason envHashChanged; the start after the replacement reuses it.

test('EH.managed-stable-env-change-replaces-one-agent-once-then-the-next-start-reuses-it', async () => {
    writeManifests({ network: 'managed', limits: true });
    const labels = await runningLabels({ network: 'managed', limits: true });
    assert.deepEqual(graphStart({ network: 'managed', limits: true, labels }).removed, [], 'baseline: the unchanged fixture is reused');

    // The cpu agent's manifest env value changes.
    const cpu = agents.find((agent) => agent.name === 'cpu');
    const changed = { ...readManifest('cpu'), expose: { R9_CONTROL: 'two' } };
    fs.writeFileSync(path.join(agentDir('cpu'), 'manifest.json'), `${JSON.stringify(changed, null, 2)}\n`);
    const replacement = graphStart({ network: 'managed', limits: true, labels });
    assert.deepEqual(
        replacement.removed.map((entry) => [entry.key, entry.reason]),
        [[containerOf('cpu'), `workspaceGraph:${FIXTURE_REPOSITORY}/cpu:envHashChanged`]],
        'exactly the changed agent is replaced, with reason envHashChanged',
    );

    // The replacement is created by the real creation path with the new value.
    freshWorkspaceState();
    labels[containerOf(cpu.name)] = {
        ...limitsLabels(cpu.name, boxContext()),
        'ploinky.envhash': await createdEnvHash(cpu.name, { network: 'managed' }),
    };
    assert.notEqual(labels[containerOf(cpu.name)]['ploinky.envhash'], '', 'the replacement carries its own hash');
    const next = graphStart({ network: 'managed', limits: true, labels });
    assert.deepEqual(next.removed.map((entry) => `${entry.key}: ${entry.reason}`), [], 'the start after the replacement reuses every runtime');
    assert.deepEqual(next.prepared.changedContainers, []);
});

// ---------------------------------------------------------------------------
// Service-level reuse check (ensureAgentService, unmanaged networks). The
// production body runs with isolated engine collaborators; every env builder
// and hash function is the repository's own. The label is the one the real
// creation path wrote.

const routerPort = await imp('../../cli/sandbox/routerPort.js');
const secretVars = await imp('../../cli/utils/security/secretVars.js');
const replacementLog = await imp('../../cli/sandbox/runtimeReplacementLog.js');
const { randomUUID } = await import('node:crypto');
const managerSource = fs.readFileSync(new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url), 'utf8');
const serviceStart = managerSource.indexOf('function ensureAgentService(');
const serviceEnd = managerSource.indexOf('\nfunction removeExactGenerationCandidate(', serviceStart);
assert.ok(serviceStart > 0 && serviceEnd > serviceStart);
const serviceSource = managerSource.slice(serviceStart, serviceEnd);
const STOP = new Error('stopped after the replacement line');

function serviceReuse(name, { envHashLabel }) {
    const lines = [];
    const key = containerOf(name);
    const id = 'c'.repeat(64);
    const manifest = readManifest(name);
    const record = { type: 'agent', repoName: FIXTURE_REPOSITORY, agentName: name, instanceId: instanceOf(name), enableGeneration: generationOf(name), containerId: id, projectPath: workspace, runMode: 'isolated' };
    const noOp = () => {};
    const admission = { descriptor: {}, runtimeKind: 'container' };
    const dependencies = {
        admitAgentServicePreflight: () => ({ preflightRepoName: FIXTURE_REPOSITORY, preflightManifestPath: path.join(agentDir(name), 'manifest.json'), preflightManifestBytes: Buffer.from(JSON.stringify(manifest)), preflightAgentRuntime: 'podman', preflightRuntimeKind: 'container', preflightAdmission: admission, hardwareInstanceKey: key }),
        normalizeTargetedRestart: () => null,
        readAppliedObservation: () => null,
        hasMpsLaunch: () => false,
        assertNetworkLifecycleCapability: noOp,
        dependencyRefreshOperation: () => false,
        resolveAgentRepositoryName: () => FIXTURE_REPOSITORY,
        assertAgentServiceNotDraining: noOp,
        loadAgentsMap: () => ({ [key]: record }),
        assertPreparedRegistryRecordPreservation: () => false,
        resolveManifestRuntimeProfile: profileService.resolveManifestRuntimeProfile,
        resolveLlmRuntimeAdmissionContext: () => ({ catalogPolicy: null, catalogIdentity: null }),
        admitManifestRuntimeCapabilities: () => admission,
        assertNetworkStartupCompatibility: noOp,
        assertRouterEndpoint: routerPort.assertRouterEndpoint,
        getRuntimeForAgent: () => 'podman',
        getRuntime: () => 'podman',
        containerExists: () => true,
        assertManifestEnvProfileCompleteness: noOp,
        resolveManifestImage: () => IMAGE,
        buildRuntimeRouterEnv: manager.buildRuntimeRouterEnv,
        buildRuntimeNetworkPlan: manager.buildRuntimeNetworkPlan,
        manifestUsesHealthProbeBroker: manager.manifestUsesHealthProbeBroker,
        parseManifestPorts: () => ({ publishArgs: [], portMappings: [] }),
        assertHostPortContract: noOp,
        buildEnvMap: secretVars.buildEnvMap,
        resolveImplicitAgentServerPort: () => 0,
        shouldCreateImplicitAgentServerPublish: () => false,
        readManifestAgentCommand: () => ({ raw: null }),
        readManifestStartCommand: () => null,
        randomUUID,
        computeEnvHash: common.computeEnvHash,
        computeAgentEnvHash: manager.computeAgentEnvHash,
        getContainerLabel: (_name, label) => (label === 'ploinky.envhash' ? envHashLabel : ''),
        debugLog: noOp,
        agentLibReuseProblem: () => null,
        agentLibGrant: () => ({}),
        limitsHashReuseReason: () => null,
        limitsHashDetail: replacementLog.limitsHashDetail,
        LIMITS_HASH_LABEL: 'ploinky.limitshash',
        isLlmRuntimeManifest: () => false,
        createNetworkLifecycleAdapter: () => ({ inspectContainerContract: () => ({ state: 'exact', running: true, id }) }),
        effectiveInstanceKey: () => key,
        networkContractHash: () => 'network-hash',
        getConfiguredProjectPath: () => workspace,
        resolveAgentHomeLayout: () => ({ binds: [] }),
        getAgentWorkDir: () => path.join(workspace, 'home'),
        spawnSync: () => ({ status: 0, stdout: JSON.stringify([{ Id: id }]) }),
        hasExactAgentHomeLayout: () => true,
        verifyReusableHardwareRuntime: noOp,
        // The admitted immutable dependency generation is the desired one, and the host/none mount topology names it.
        containerDependencyReuseProblem: () => '',
        hasAdmittedDependencyMount: () => true,
        assertHostModeGenerationCapability: noOp,
        deriveAgentPrincipalId,
        syncAgentMcpConfig: noOp,
        resolveReplacementRuntimeIdentity: () => { throw STOP; },
        formatReplacementReason: replacementLog.formatReplacementReason,
        hashMismatchDetail: replacementLog.hashMismatchDetail,
        shortenHashes: replacementLog.shortenHashes,
        logRuntimeReplacement: (agent, reason) => lines.push(replacementLog.formatRuntimeReplacementLine(agent, reason)),
        structuredClone,
    };
    const run = new Function(...Object.keys(dependencies), `${serviceSource}\nreturn ensureAgentService;`)(...Object.values(dependencies));
    let result = null;
    let stopped = false;
    try {
        result = run(name, manifest, agentDir(name), { containerName: key, routerEndpoint: null, networkLifecycleCapability: {} });
    } catch (error) {
        if (error !== STOP) throw error;
        stopped = true;
    }
    return { lines, result, stopped };
}

test('EH.none-service-reuse-check-matches-the-creation-label-and-replaces-only-on-a-stable-change', async () => {
    writeManifests({ network: 'none', limits: false });
    const labels = await runningLabels({ network: 'none', limits: false });
    for (const agent of agents) {
        const label = labels[containerOf(agent.name)]['ploinky.envhash'];
        const reused = serviceReuse(agent.name, { envHashLabel: label });
        assert.deepEqual(reused.lines, [], `${agent.name}: the service-level check prints no replacement line`);
        assert.equal(reused.stopped, false, `${agent.name}: the runtime is reused`);
        assert.equal(reused.result.createdByThisLaunch, false);
    }
    // Control: the same label against a changed manifest env value replaces.
    fs.writeFileSync(path.join(agentDir('cpu'), 'manifest.json'), `${JSON.stringify({ ...readManifest('cpu'), expose: { R9_CONTROL: 'two' } }, null, 2)}\n`);
    const changed = serviceReuse('cpu', { envHashLabel: labels[containerOf('cpu')]['ploinky.envhash'] });
    assert.equal(changed.stopped, true);
    assert.equal(changed.lines.length, 1);
    assert.match(changed.lines[0], /replacing its runtime \(envHashChanged: envHash [a-f0-9]{12} -> [a-f0-9]{12}\)/);
});

// ---------------------------------------------------------------------------
// Managed adoption: a repeat start of a running managed runtime adopts it only
// when the semantic hash the creation path wrote equals the one adoption
// expects. Both are the creation path's own `computeSemanticEnvHash` closure
// (startAgentContainer defines it once; its label write and the adoption
// comparison both call it), so the closure's value must equal the label and the
// graph's retained recomputation for the unchanged agent. Adoption's other
// checks need a Router authority attestation and a prepared generation and are
// not driven here.

test('EH.managed-adoption-expectation-equals-the-label-the-graph-and-the-closure-agree-on', async () => {
    writeManifests({ network: 'managed', limits: true });
    const labels = await runningLabels({ network: 'managed', limits: true });
    const reg = registry({ network: 'managed' });
    for (const agent of agents) {
        const node = {
            repoName: FIXTURE_REPOSITORY, shortAgentName: agent.name, manifest: readManifest(agent.name), profile: '',
        };
        const profile = profileService.resolveManifestRuntimeProfile(node.manifest, { agentName: `${FIXTURE_REPOSITORY}/${agent.name}`, path: 'manifest' });
        const plan = manager.buildRuntimeNetworkPlan('podman', profile.network);
        const retained = workspaceUtil.computeRetainedManagedEnvHash(node, reg[containerOf(agent.name)], profile.profileConfig, plan, {
            descriptorRoot, readDescriptorFileImpl: (file) => ({ payload: payloads.get(fs.realpathSync(file)) }),
        });
        assert.equal(retained, labels[containerOf(agent.name)]['ploinky.envhash'], `${agent.name}: the graph's retained hash equals the creation label adoption compares against`);
    }
    // The adoption verdict compares exactly this closure with the label and
    // requires the same managed control env the creation path set.
    assert.match(managerSource, /const expectedEnvHash = computeSemanticEnvHash\(payload\);/);
    assert.match(managerSource, /\['ploinky\.envhash'\][^;]*!== expectedEnvHash/);
    assert.match(managerSource, /hasExactManagedEnv\(record, expectedEnv\)/);
    assert.match(managerSource, /\.\.\.managedControlEnv,\n\s*\}\);\n\s*const expectedMounts/);
});

// ---------------------------------------------------------------------------
// Every security-relevant input stays in the hash, and the broker flag is one of
// them: a change of any makes the unchanged-agent hash differ.

test('EH.every-security-relevant-input-and-the-broker-flag-change-the-managed-hash', async () => {
    writeManifests({ network: 'managed', limits: true });
    const name = 'memory';
    const manifest = readManifest(name);
    const profile = profileService.resolveManifestRuntimeProfile(manifest, { agentName: `${FIXTURE_REPOSITORY}/${name}`, path: 'manifest' });
    const plan = manager.buildRuntimeNetworkPlan('podman', profile.network);
    const base = {
        agentName: name, repoName: FIXTURE_REPOSITORY, runtimeNetworkPlan: plan,
        generatedRouter: { payload: descriptorPayload(name), principalId: 'agent:hwlfixture/memory', instanceId: 'i1', enableGeneration: 'g1' },
    };
    const hash = (overrides = {}, withManifest = manifest) => manager.computeAgentEnvHash(withManifest, profile.profileConfig, {
        ...base, ...overrides, generatedRouter: { ...base.generatedRouter, ...(overrides.generatedRouter || {}) },
    });
    const reference = hash();
    assert.match(reference, /^[a-f0-9]{64}$/);
    const variants = {
        principal: hash({ generatedRouter: { principalId: 'agent:hwlfixture/cpu' } }),
        instance: hash({ generatedRouter: { instanceId: 'i2' } }),
        generation: hash({ generatedRouter: { enableGeneration: 'g2' } }),
        descriptorDigest: hash({ generatedRouter: { payload: { ...descriptorPayload(name), semanticTopologyDigest: `sha256:${'cd'.repeat(32)}` } } }),
        descriptorSchema: hash({ generatedRouter: { payload: { ...descriptorPayload(name), schema: 'other.v1' } } }),
        manifestEnv: hash({}, { ...manifest, expose: { R9_CONTROL: 'two' } }),
        brokerFlag: hash({}, { ...manifest, health: { readiness: { script: 'ready.sh' } } }),
    };
    for (const [input, value] of Object.entries(variants)) assert.notEqual(value, reference, `${input} is part of the hash`);
    assert.equal(new Set(Object.values(variants)).size, Object.keys(variants).length, 'each input changes the hash differently');
    assert.deepEqual({ ...manager.buildManagedControlEnv(manifest) }, { PLOINKY_HEALTH_PROBE_BROKER: '0' });
    assert.deepEqual({ ...manager.buildManagedControlEnv({ ...manifest, health: { liveness: { script: 'live.sh' } } }) }, { PLOINKY_HEALTH_PROBE_BROKER: '1' });
});

// Adoption recomputes the generated credential env and requires it to equal the
// running container's env exactly; it must therefore be a pure function of the
// agent identity (never of the time or of a fresh nonce).
test('EH.adoption-recomputes-the-same-generated-credential-env-for-an-unchanged-agent', async () => {
    const { buildAgentCredentialEnv } = await imp('../../cli/utils/security/agentIdentityEnv.js');
    const owner = { instanceId: 'instance-r9', enableGeneration: 'generation-r9' };
    const first = buildAgentCredentialEnv(principalOf('memory'), owner);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.deepEqual(buildAgentCredentialEnv(principalOf('memory'), owner), first);
    assert.notDeepEqual(buildAgentCredentialEnv(principalOf('memory'), { ...owner, enableGeneration: 'generation-r9b' }), first, 'a new generation changes it');
});
