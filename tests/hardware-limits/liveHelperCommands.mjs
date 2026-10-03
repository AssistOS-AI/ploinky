// LIVE-C6 (spec 15.4 :1327): the Router authority helper, measured through the product's own post-probe/pre-cleanup observation seam
// (`runContainerAuthorityProbe({ observeCompletedProbe })`, cli/sandbox/routerAuthorityAttestation.js). A reviewed fixed program runs INSIDE the
// owned Box as the Box user, through the product modules the Box mounts at /opt/ploinky: it prepares the exact managed-network plan of the
// fixture agent, captures the exact edge generation lease, builds the topology intent and runs `attestRouterAuthority` with the product's own
// probe runner, adding only the observation seam (and, in `delayed` mode, a command runner that makes the helper's probe allocate late).
// Manifest values reach it as one JSON argv, never as source text. Test-only.

const MiB = 1024 * 1024;
export const HELPER_MEMORY_BYTES = 64 * MiB;            // the helper's recorded --memory 64m
export const HELPER_PEAK_MAX_BYTES = 48 * MiB;           // spec :1327: at most 48 MiB for 64m
export const HELPER_PEAK_ESCALATION = Object.freeze({ memory: '128m', peakMaxMiB: 96 });   // the only permitted redesign, a reviewed change and a new candidate
// The delayed allocating probe (spec :1327 "prove sampling order"): the helper's probe process allocates and touches this much AFTER this
// delay, so a sample taken before the probe completed cannot see it. The delayed run must reach the real run's peak plus at least half of it.
export const DELAYED_ALLOCATION = Object.freeze({ bytes: 16 * MiB, delayMs: 2000, minPeakIncreaseBytes: 8 * MiB });
export const HELPER_LEAF_PARENT = '/ploinky/system';

// Runs inside the Box. argv[1] is one JSON object:
//   { root, cgroupRoot, mode: 'real'|'delayed', routerPort, containerName, repoName, agentName, image, delayed: { bytes, delayMs } }
// The generation lease of the fixture agent's exact owner and the topology intent over it, as the product's own
// prepareGeneratedRouterAttestation builds them (cli/sandbox/docker/agentServiceManager.js). It reads the active edge generation, so the exec
// environment must be the one the core compiled it in: the lease compares the generation's physical media port with PLOINKY_MEDIA_HOST_PORT
// (cli/sandbox/edgeGeneration.js loadActiveEdgeRoutingGeneration) and the intent's public authority is built from the Router port. Kept as its own
// text so that a test runs these exact statements against the real product modules.
export const LEASE_AND_INTENT_SOURCE = String.raw`
const leaseAndIntent = ({ edge, attestation, identity }, params, record, plan) => {
  const principal = identity.deriveAgentPrincipalId(params.repoName, params.agentName);
  const lease = edge.createRouterAttestationGenerationLease({ expectedOwner: { containerName: params.containerName, principal, instanceId: record.instanceId, enableGeneration: record.enableGeneration } });
  const topology = edge.edgeRuntimeEnvironment('default');
  const intent = attestation.buildRouterAuthorityTopologyIntent({
    networkMode: plan.mode, runtimeProof: plan.runtimeProof, networkFingerprint: plan.networkFingerprint, runtimeKind: 'container',
    edgeTopologyFile: topology.PLOINKY_EDGE_TOPOLOGY_FILE, authRouteKey: lease.snapshot?.routing?.static?.agent, routerHostPort: Number(params.routerPort),
  });
  return { lease, intent };
};
`;

export const AUTHORITY_HELPER_PROGRAM = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const params = JSON.parse(process.argv[1]);
if (!path.isAbsolute(params.root) || !['real', 'delayed'].includes(params.mode) || !/^[A-Za-z0-9_.-]+$/.test(params.containerName)) throw new Error('Invalid helper-probe parameters');
const load = (relative) => import(new URL('file://' + params.root + '/' + relative).href);
const clock = () => Number(process.hrtime.bigint() / 1000n);
const events = [];
const mark = (name, extra = {}) => events.push({ name, atUs: clock(), ...extra });
const [lifecycle, edge, attestation, delegation, requested, registryModule, graph, identity, hardwareState] = await Promise.all([
  load('cli/sandbox/networkLifecycle.js'), load('cli/sandbox/edgeGeneration.js'), load('cli/sandbox/routerAuthorityAttestation.js'),
  load('cli/sandbox/hardwareLimits/delegation.mjs'), load('cli/sandbox/hardwareLimits/requestedLimits.mjs'),
  load('cli/utils/agentRegistrySnapshot.js'), load('cli/utils/workspaceDependencyGraph.js'), load('cli/utils/security/agentIdentity.js'),
  load('ploinky-box/lib/boxMarker.mjs'),
]);
const record = registryModule.readAgentRegistrySnapshot()[params.containerName];
if (!record || !record.instanceId || !record.enableGeneration) throw new Error('The fixture agent has no exact registry record');
const adapter = lifecycle.createNetworkLifecycleAdapter({ runtime: 'podman' });
const plan = adapter.prepare({ mode: 'default' }, params.agentName, { instanceKey: graph.effectiveInstanceKey(params.repoName, params.agentName, record.alias || '') });
${LEASE_AND_INTENT_SOURCE}
const { lease, intent } = leaseAndIntent({ edge, attestation, identity }, params, record, plan);
const placement = delegation.authorityHelperPlacementFromContext(requested.captureHardwareContext({ insideBox: hardwareState.isInsideBox(), runtimeKind: 'container' }));
// The product's own probe runs unchanged. In delayed mode only the helper's probe exec gets a prefix that allocates and touches memory
// late; the exec still returns the probe's own output, once the process has exited.
const delayedPrefix = ';setTimeout(()=>{globalThis.__hold=Buffer.alloc(' + Number(params.delayed?.bytes || 0) + ',1)},' + Number(params.delayed?.delayMs || 0) + ');';
let execBegan = false;
const commandRunner = {
  run(command, args, options) {
    const isProbe = params.mode === 'delayed' && args.includes('exec') && args.includes('node') && args.includes('-e') && args.some((value) => value === '--user');
    const rewritten = isProbe ? args.map((value, index) => (args[index - 1] === '-e' ? delayedPrefix + value : value)) : args;
    const probing = rewritten.includes('exec') && rewritten.includes('node') && rewritten.includes('-e');
    if (probing) { execBegan = true; mark('probe-exec-begin'); }
    const result = spawnSync(command, rewritten, options);
    if (probing) mark('probe-exec-end', { status: result.status });
    return result;
  },
  now: () => Date.now(),
  sleep: (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
};
let observed = null;
const leafOf = (helperId) => {
  const parent = path.join(params.cgroupRoot, 'ploinky', 'system');
  let entries = [];
  try { entries = fs.readdirSync(parent); } catch (error) { return { parent, error: String(error.code || error.message) }; }
  const name = entries.find((entry) => entry.includes(helperId));
  return { parent, name: name || null };
};
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (error) { return null; } };
const attested = attestation.attestRouterAuthority({
  intent, generationLease: lease,
  runProbe: ({ intent: probeIntent, nonce, registerObservation, consumeObservation }) => attestation.runContainerAuthorityProbe({
    runtime: 'podman', plan, image: params.image, intent: probeIntent, nonce, commandRunner, placement,
    registerObservation: () => { mark('register'); return registerObservation(); },
    consumeObservation: () => { mark('consume'); return consumeObservation(); },
    observeCompletedProbe: (info) => {
      mark('observe', { helperId: info.helperId, placement: info.placement });
      const leaf = leafOf(info.helperId);
      const directory = leaf.name ? path.join(leaf.parent, leaf.name) : null;
      const memoryPeak = directory ? readText(path.join(directory, 'memory.peak')) : null;
      mark('sample');
      observed = {
        helperId: info.helperId, placement: info.placement, leaf: leaf.name || null, leafError: leaf.error || null,
        memoryPeak, memoryMax: directory ? readText(path.join(directory, 'memory.max')) : null,
        memoryCurrent: directory ? readText(path.join(directory, 'memory.current')) : null,
        memoryEvents: directory ? readText(path.join(directory, 'memory.events')) : null,
      };
    },
  }),
});
const probeEvidence = attested.evidence;
process.stdout.write(JSON.stringify({
  schema: 1, mode: params.mode, attestationId: attested.attestationId, helper: probeEvidence.helper, external: probeEvidence.external.map((entry) => ({ host: entry.host, status: entry.status })),
  observed, events, execBegan, delayedPlanned: params.mode === 'delayed' ? { bytes: Number(params.delayed.bytes), delayMs: Number(params.delayed.delayMs) } : null,
}));
`;

// The exec argv that runs the program inside the owned Box as the Box user, in the workspace, with the run's Router port AND media port: the
// product's own exec paths pass both (ploinky-box/command/execute.mjs), and the active edge generation was compiled with the Box's published UDP port.
const portText = (value, what) => {
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`The ${what} must be a port number`);
    return String(value);
};
export function helperProgramArgv({ boxId, workspace, routerPort, mediaPort, params }) {
    return ['container', 'exec', '--user', 'podman', '--workdir', workspace,
        '--env', `PLOINKY_ROUTER_HOST_PORT=${portText(routerPort, 'Router port')}`, '--env', `PLOINKY_MEDIA_HOST_PORT=${portText(mediaPort, 'media port')}`, boxId,
        'node', '--input-type=module', '-e', AUTHORITY_HELPER_PROGRAM, JSON.stringify(params)];
}

const failure = message => new Error(message);
const bytesOf = (text, label) => {
    const value = Number(String(text ?? '').trim());
    if (!Number.isSafeInteger(value) || value <= 0) throw failure(`The helper ${label} is missing or not a positive integer (${JSON.stringify(String(text ?? '').slice(0, 40))})`);
    return value;
};
// The product's attestation retries when a probe's observation expired, up to this many attempts (routerAuthorityAttestation.js
// ROUTER_AUTHORITY_ATTESTATION_MAX_ATTEMPTS); every attempt creates its own helper and runs the probe once. The observation seam runs only
// after a probe whose observation was consumed, so exactly one 'observe' and one 'sample' exist, and the lifecycle of THAT attempt is its last one.
export const ATTESTATION_MAX_ATTEMPTS = 3;
const eventsNamed = (value, name) => (Array.isArray(value.events) ? value.events.filter(event => event?.name === name) : []);
const ATTEMPT_STEPS = Object.freeze(['register', 'probe-exec-begin', 'probe-exec-end', 'consume']);
const eventAt = (value, name) => {
    const found = eventsNamed(value, name);
    if (found.length !== 1 || !Number.isSafeInteger(found[0].atUs)) throw failure(`The helper observation has ${found.length} '${name}' events instead of exactly one`);
    return found[0].atUs;
};
// How many attestation attempts the program made: one registration, one probe exec and one consumption each.
const attemptsOf = value => {
    const attempts = eventsNamed(value, 'register').length;
    for (const name of ['probe-exec-begin', 'probe-exec-end', 'consume']) {
        if (eventsNamed(value, name).length !== attempts) throw failure(`The helper observation has ${eventsNamed(value, name).length} '${name}' events for ${attempts} attestation attempts`);
    }
    if (attempts < 1 || attempts > ATTESTATION_MAX_ATTEMPTS) throw failure(`The attestation made ${attempts} attempts; the product makes between 1 and ${ATTESTATION_MAX_ATTEMPTS}`);
    return attempts;
};

// One helper observation: real attestation success, the immutable helper identity, the exact lifecycle order (the seam runs after the probe
// exec ended and before cleanup) and a readable peak of the helper's own leaf.
export function assertHelperObservation(value, { mode = 'real' } = {}) {
    if (!value || value.schema !== 1 || value.mode !== mode) throw failure('The helper observation is missing or of another mode');
    if (!/^sha256:[a-f0-9]{64}$/.test(String(value.attestationId || ''))) throw failure('Real attestation did not succeed: the program produced no attestation identity');
    if (!/^[a-f0-9]{64}$/.test(String(value.helper?.id || '')) || !/^(?:sha256:)?[a-f0-9]{64}$/.test(String(value.helper?.image || ''))) throw failure('The helper identity is not an immutable container and image ID');
    if (!Array.isArray(value.external) || value.external.length !== 2 || value.external.some(entry => !Number.isInteger(entry?.status))) throw failure('The probe did not produce exactly two observations');
    const observed = value.observed;
    if (!observed || observed.helperId !== value.helper.id) throw failure('The post-probe observation was not made for the attested helper');
    const attempts = attemptsOf(value);
    const observe = eventAt(value, 'observe'); const sample = eventAt(value, 'sample');
    // The lifecycle is the product's: per attempt a registration, the probe exec (begin, end) and a consumption, then the seam once.
    const sequence = value.events.map(event => event?.name);
    const expected = [...Array(attempts).fill(ATTEMPT_STEPS).flat(), 'observe', 'sample'];
    if (JSON.stringify(sequence) !== JSON.stringify(expected)) throw failure(`The helper was sampled out of order: the events ${JSON.stringify(sequence)} are not the product's lifecycle ${JSON.stringify(expected)}`);
    const times = value.events.map(event => event.atUs);
    if (times.some((at, index) => !Number.isSafeInteger(at) || (index > 0 && at < times[index - 1]))) throw failure('The helper was sampled out of order: the events are not in time order');
    // The attempt that counts is the last one: the four events before the seam.
    const [register, begin, end, consume] = value.events.slice(-6, -2).map(event => event.atUs);
    if (!(register <= begin && begin <= end && end <= consume && consume <= observe && observe <= sample)) throw failure('The helper was sampled out of order: the post-probe seam must run after the probe exec ended and its observation was consumed');
    if (value.events.at(-4).status !== 0) throw failure('The probe exec did not end successfully');
    if (observed.placement !== 'enforced') throw failure(`The helper was not placed in the delegated hierarchy (placement: ${observed.placement}); its peak is not the enforced helper's`);
    if (!observed.leaf) throw failure(`The helper has no leaf under ${HELPER_LEAF_PARENT}${observed.leafError ? ` (${observed.leafError})` : ''}; its peak cannot be measured`);
    const peak = bytesOf(observed.memoryPeak, 'memory.peak'); const max = bytesOf(observed.memoryMax, 'memory.max');
    if (max !== HELPER_MEMORY_BYTES) throw failure(`The helper memory.max is ${max}, not the recorded ${HELPER_MEMORY_BYTES} (64m)`);
    if (peak > max) throw failure('The helper memory.peak exceeds its own memory.max');
    return Object.freeze({ peakBytes: peak, maxBytes: max, begin, end, observe, sample, attempts });
}

// The real probe: the final memory.peak is at most 48 MiB for the 64m helper. A larger need is a reviewed redesign (128m with 96 MiB), never a silent increase.
export function assertRealHelperPeak(value) {
    const facts = assertHelperObservation(value, { mode: 'real' });
    if (facts.peakBytes > HELPER_PEAK_MAX_BYTES) {
        throw failure(`The authority helper's final memory.peak is ${facts.peakBytes} bytes, over the ${HELPER_PEAK_MAX_BYTES} bytes allowed at 64m; `
            + `the only permitted change is a reviewed update of the creation and the proof together to ${HELPER_PEAK_ESCALATION.memory} with at most ${HELPER_PEAK_ESCALATION.peakMaxMiB} MiB, and a new candidate`);
    }
    return facts;
}

// The delayed allocating probe proves sampling order: the exec lasted at least the delay, the sample came after it ended (the order check of
// assertHelperObservation: exec end <= consume <= observe <= sample), and the peak
// carries the late allocation (the real run's peak plus at least the stated increase).
export function assertDelayedSamplingOrder(delayed, real) {
    const facts = assertHelperObservation(delayed, { mode: 'delayed' });
    const baseline = assertHelperObservation(real, { mode: 'real' });
    const plan = delayed.delayedPlanned;
    if (!plan || plan.bytes !== DELAYED_ALLOCATION.bytes || plan.delayMs !== DELAYED_ALLOCATION.delayMs) throw failure('The delayed run did not carry the approved allocation and delay');
    if ((facts.end - facts.begin) / 1000 < plan.delayMs) throw failure(`The delayed probe exec lasted ${(facts.end - facts.begin) / 1000} ms, shorter than its ${plan.delayMs} ms delay: the allocation did not happen inside the probe`);
    if (facts.peakBytes < baseline.peakBytes + DELAYED_ALLOCATION.minPeakIncreaseBytes) {
        throw failure(`The delayed probe's peak ${facts.peakBytes} does not carry its late allocation (the real peak ${baseline.peakBytes} plus ${DELAYED_ALLOCATION.minPeakIncreaseBytes}): the sample was taken before the allocation, or the peak is not the final one`);
    }
    return Object.freeze({ delayedPeakBytes: facts.peakBytes, realPeakBytes: baseline.peakBytes, execMs: (facts.end - facts.begin) / 1000, attempts: facts.attempts });
}
