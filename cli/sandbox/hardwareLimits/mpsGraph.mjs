import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { readAgentRegistrySnapshot } from '../../utils/agentRegistrySnapshot.js';
import { resolveManifestRuntimeProfile } from '../../utils/runtime/profileService.js';
import { readEdgeRoutingSelection } from '../edgeGeneration.js';
import { assertNetworkLifecycleCapability } from '../networkLifecycle.js';
import { getRuntime } from '../docker/common.js';
import { drainTargetedContainer, TARGETED_DRAIN_ACKNOWLEDGEMENT } from '../docker/targetedContainerLifecycle.js';
import { retireRuntimeRelaySocket } from '../docker/healthProbes.js';
import { readBoxHardwareContext } from './context.mjs';
import { readAppliedObservation } from './runtimeState.mjs';
import {
    assertKnownMpsClients, inspectMpsClient, inspectMpsClientPresence, resolveMpsClientAlias,
    createdMpsCandidates, settleCreatedMpsCandidate, mpsCandidateRecord, sameMpsTuple, mpsOwnerState, releaseMpsLaunchOwner,
} from './mpsInventory.mjs';
import { createMpsStateStore, createMpsDaemonBackend, isMpsClientAlias, sameMpsServerDefault } from './mps.mjs';
import { retireExactAgentRuntimePredecessor } from '../docker/agentServiceManager.js';
import { MpsError } from './mpsEligibility.mjs';
import { resolveStoredGpuShare } from './resolve.mjs';
import { buildDirectRefusal, hex64 } from './requestedLimits.mjs';
import { resolveMpsServerDefault } from './mpsTransition.mjs';

const tuple = (client) => [client.key, client.instanceId, client.enableGeneration, client.containerId || ''].join('\0');
const sameRecord = (client, record) => record?.type === 'agent' && client.instanceId === record.instanceId
    && client.enableGeneration === record.enableGeneration && client.containerId === record.containerId;

// Graph preparation already selected the complete workspace inactive. This
// phase drains exact predecessors and removes never-published created
// candidates; the existing graph batch owns removal of predecessors, identity
// rotation, its preparation lease, readiness and final publication.
// `progress.mutating` turns true immediately before the first effect: every
// failure before it is a contained GPU refusal.
async function prepareMpsGraphImpl({ nodes, networkLifecycleCapability, deadline = Date.now() + 15 * 60_000 } = {}, {
    readContext = readBoxHardwareContext, loadRegistry = readAgentRegistrySnapshot, readApplied = readAppliedObservation,
    store = createMpsStateStore(), backend = createMpsDaemonBackend(), assertCapability = assertNetworkLifecycleCapability,
    readSelection = readEdgeRoutingSelection, resolveShare = resolveStoredGpuShare, runtime = getRuntime,
    inspect = (client, network, engine) => inspectMpsClient(client, { network, runtime: engine }),
    inspectPresence = (client, engine) => inspectMpsClientPresence(client, { runtime: engine }),
    removeCandidate = (candidate, network, capability) => retireExactAgentRuntimePredecessor({ containerName: candidate.key, containerId: candidate.containerId,
        registryRecord: mpsCandidateRecord(candidate), runtimeNetwork: network }, { networkLifecycleCapability: capability }),
    drain = drainTargetedContainer, observeClients = assertKnownMpsClients, ownerState = mpsOwnerState,
} = {}, progress = {}) {
    assertCapability(networkLifecycleCapability);
    const context = readContext();
    const replacedKeys = new Set();
    if (context.gate !== 'on') return { replacedKeys };
    const registry = loadRegistry();
    const members = new Map(nodes.map((entry) => [entry.key, entry]));
    let saved;
    try { saved = store.read(); } catch (_) { throw new MpsError('The private MPS state cannot be read safely', 'mps_backend_unavailable'); }
    const networkOf = (key, ref) => {
        const member = members.get(key);
        return member ? resolveManifestRuntimeProfile(member.node.manifest, { agentName: ref, profileName: registry[key]?.profile || undefined }).network : null;
    };
    // Journaled created candidates are judged by their own tuple and ID.
    const candidates = createdMpsCandidates(saved, registry).map((candidate) => {
        const network = isMpsClientAlias(candidate.alias) ? networkOf(candidate.key, candidate.ref) : null;
        const engine = runtime();
        const observed = network ? inspect(candidate, network, engine) : inspectPresence(candidate, engine);
        // A launch still starting under its own operation (a no-wait child
        // waiting for readiness outside the locks) is never removed; this
        // graph's GPU agents are refused until it settles.
        if (observed.state !== 'absent' && ownerState(candidate.owner) === 'live') {
            throw new MpsError(`The GPU share client ${candidate.key} is still starting under its launching operation; no client was drained`, 'hardware_limits_transition');
        }
        if (observed.state !== 'absent' && (observed.state !== 'exact' || observed.id !== candidate.containerId)) {
            throw new MpsError(`The journaled MPS candidate ${candidate.key} is not its exact created runtime; no client was drained`, 'identity_changed');
        }
        return { candidate, network, absent: observed.state === 'absent' };
    });
    const clients = new Map((saved?.oldClients || []).map((client) => [tuple(client), client]));
    for (const [key, record] of Object.entries(registry)) {
        if (record?.type !== 'agent' || !record.containerId) continue;
        const applied = readApplied(key, record.containerId);
        if (!applied?.mpsGeneration || applied.instanceId !== record.instanceId || applied.enableGeneration !== record.enableGeneration) continue;
        const client = { key, alias: record.alias || '', ref: `${record.repoName}/${record.agentName}`, instanceId: record.instanceId,
            enableGeneration: record.enableGeneration, containerId: record.containerId, share: applied.gpuShare, mpsGeneration: applied.mpsGeneration };
        const journaled = clients.get(tuple(client));
        // The re-observed exact tuple carries its registry alias into the one
        // journaled entry; a different journaled alias is an identity change.
        if (!journaled) clients.set(tuple(client), client);
        else clients.set(tuple(client), { ...journaled, alias: resolveMpsClientAlias(journaled, record) });
    }
    const policies = [];
    for (const [ref, entry] of context.overrides || []) {
        if (!entry.gpu) continue;
        try { policies.push({ share: resolveShare(entry.gpu, context.gpu, ref) }); }
        catch (_) { /* Metadata admission contains this agent's GPU refusal. */ }
    }
    if (!clients.size && !saved?.daemon && !policies.length && !candidates.length) return { replacedKeys };
    observeClients({ runtime: runtime(), registry, state: saved });
    if (clients.size > 256) throw new MpsError('MPS graph cohort exceeds its bound');
    const alreadyDrained = new Set(saved?.drainedClients || []);
    // A journaled client outside this graph is settled only by an exact
    // drain receipt or by proof that its immutable container is gone.
    const outside = new Set();
    for (const client of clients.values()) {
        if (members.has(client.key)) continue;
        if (!alreadyDrained.has(tuple(client))) {
            if (inspectPresence(client, runtime()).state !== 'absent') throw new MpsError(`MPS client ${client.key} is outside the admitted graph; no client was drained`);
            alreadyDrained.add(tuple(client));
        }
        outside.add(tuple(client));
    }
    const desiredServerDefault = resolveMpsServerDefault(policies);
    const observation = saved?.daemon || saved?.pipeDirectory ? backend.observe(saved) : { state: 'gone' };
    if (['foreign', 'unknown'].includes(observation.state)) throw new MpsError('MPS graph preparation cannot prove daemon ownership', 'mps_backend_unavailable');
    const generation = saved?.daemonGeneration && saved?.configurationGeneration ? `${saved.daemonGeneration}:${saved.configurationGeneration}` : '';
    // As in the lifecycle planner: a verified owned daemon whose only problem
    // is clients that were not recreated is healthy, and a drained client is
    // not a live client of any generation.
    const clientFailuresOnly = saved?.status === 'pending' && saved?.lastProblem?.code === 'mps_client_failed';
    const healthy = (saved?.status === 'ready' || clientFailuresOnly) && observation.state === 'owned' && backend.verify(saved);
    const needsTransition = !sameMpsServerDefault(saved?.serverDefault, desiredServerDefault)
        || Boolean(desiredServerDefault && !healthy) || [...clients.values()].some((client) => !outside.has(tuple(client)) && !alreadyDrained.has(tuple(client)) && client.mpsGeneration !== generation);
    const toDrain = [];
    // A drained journal entry whose key the registry now names with a newer
    // live share client is history: that newer client is judged on its own.
    // A drained predecessor whose key has no live client still needs its
    // replacement launched by this graph.
    const liveKeys = new Set([...clients.values()].filter((client) => !alreadyDrained.has(tuple(client)) && sameRecord(client, registry[client.key])).map((client) => client.key));
    for (const client of clients.values()) {
        if (outside.has(tuple(client))) continue;
        if (alreadyDrained.has(tuple(client)) && liveKeys.has(client.key)) continue;
        const member = members.get(client.key);
        let desiredShare = null;
        const policy = context.overrides?.get(client.ref)?.gpu;
        if (policy) { try { desiredShare = resolveShare(policy, context.gpu, client.ref); } catch (_) {} }
        if (!needsTransition && isDeepStrictEqual(client.share, desiredShare) && !alreadyDrained.has(tuple(client))) continue;
        replacedKeys.add(client.key);
        if (alreadyDrained.has(tuple(client))) continue;
        if (!sameRecord(client, registry[client.key])) throw new MpsError('MPS predecessor registry changed before graph preparation');
        const network = resolveManifestRuntimeProfile(member.node.manifest, { agentName: client.ref,
            profileName: registry[client.key].profile || undefined }).network;
        const engine = runtime();
        const observed = inspect({ ...client, alias: resolveMpsClientAlias(client, registry[client.key]) }, network, engine);
        if (observed.state !== 'absent' && (observed.state !== 'exact' || observed.id !== client.containerId)) throw new MpsError('MPS graph predecessor runtime ownership is not exact');
        toDrain.push({ client, observed, engine });
    }
    const selection = readSelection().selector;
    const check = () => {
        assertCapability(networkLifecycleCapability);
        if (Date.now() >= deadline) throw new MpsError('MPS graph preparation exceeded its deadline');
        if (selection.state !== 'inactive' || !isDeepStrictEqual(readSelection().selector, selection)) throw new MpsError('MPS graph preparation lost its exact inactive selector');
        if (!isDeepStrictEqual(readContext().storeToken, context.storeToken)) throw new MpsError('MPS graph policy changed before drain', 'revision_conflict');
    };
    // The transaction checks are not GPU prerequisites: they still fail start.
    progress.transactionChecks = true;
    check();
    progress.mutating = true;
    const settled = candidates.filter(({ absent }) => absent).map(({ candidate }) => candidate);
    const state = { ...(saved || { schema: 1, daemon: null, daemonGeneration: null, configurationGeneration: null,
        pipeDirectory: null, logDirectory: null, serverDefault: null }), status: needsTransition || replacedKeys.size ? 'pending' : saved?.status || 'inactive',
        graphPrepared: true, graphPreparationId: randomUUID(), graphNeedsTransition: needsTransition, replacedKeys: [...replacedKeys], desiredServerDefault,
        oldClients: [...clients.values()], drainedClients: [...alreadyDrained],
        pendingClients: (saved?.pendingClients || []).filter((entry) => !settled.some((candidate) => entry.phase === 'readiness' && sameMpsTuple(entry, candidate))), lastProblem: null };
    store.write(state);
    for (const candidate of settled) releaseMpsLaunchOwner(candidate.owner);
    // Never-published candidates are removed by their exact immutable ID.
    for (const { candidate, network, absent } of candidates) {
        if (absent) continue;
        check();
        settleCreatedMpsCandidate(candidate, { inspect: () => inspect(candidate, network, runtime()), remove: () => removeCandidate(candidate, network, networkLifecycleCapability), ownerState });
        state.pendingClients = state.pendingClients.filter((entry) => !(entry.phase === 'readiness' && sameMpsTuple(entry, candidate))); store.write(state);
        releaseMpsLaunchOwner(candidate.owner);
    }
    for (const { client, observed, engine } of toDrain) {
        check();
        if (!sameRecord(client, loadRegistry()[client.key])) throw new MpsError('MPS graph predecessor identity changed before drain');
        if (observed.state !== 'absent' && observed.running !== false) {
            const inspectExact = () => {
                const reply = spawnSync(engine, ['inspect', client.containerId], { encoding: 'utf8', timeout: 5000,
                    maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
                let records;
                try { records = JSON.parse(reply.stdout || ''); } catch (_) {}
                if (reply.error || reply.status !== 0 || !Array.isArray(records) || records.length !== 1
                    || (records[0].Id || records[0].ID) !== client.containerId) throw new MpsError('Exact MPS predecessor inspection failed during graph drain');
                return { State: records[0].State };
            };
            drain(client.key, { runtime: engine, acknowledgement: TARGETED_DRAIN_ACKNOWLEDGEMENT,
                exists: () => true, isRunning: () => inspectExact().State?.Running === true, inspect: inspectExact,
                affectedSelectors: [`route:${client.key}`], assertSelectorsInactive: () => { check(); return true; },
                timeoutMs: Math.min(30_000, Math.max(1, deadline - Date.now())), retireControlSocket: retireRuntimeRelaySocket,
                signal: (command) => spawnSync(command, ['kill', '--signal', 'SIGTERM', client.containerId], { encoding: 'utf8', timeout: 5000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'pipe'] }),
            });
        }
        check();
        alreadyDrained.add(tuple(client)); state.drainedClients = [...alreadyDrained]; store.write(state);
    }
    return { replacedKeys, graphPreparationId: state.graphPreparationId };
}

export async function prepareMpsGraph(input, dependencies = {}) {
    const progress = {};
    try { return await prepareMpsGraphImpl(input, dependencies, progress); }
    catch (error) {
        // Before any effect, an MPS failure refuses only the GPU-share agents
        // of this graph and leaves the daemon untouched; CPU-only agents and
        // Explorer start (U10, §9.1). The graph transaction's own checks and
        // any failure after the first effect still fail the start.
        if (progress.mutating || progress.transactionChecks) throw error;
        const context = (dependencies.readContext || readBoxHardwareContext)();
        const registry = (dependencies.loadRegistry || readAgentRegistrySnapshot)();
        const readApplied = dependencies.readApplied || readAppliedObservation;
        const refusals = [];
        for (const { key, node } of input.nodes) {
            const record = registry[key];
            const ref = record ? `${record.repoName}/${record.agentName}` : node.agentRef;
            const configured = context.overrides?.get(ref)?.gpu;
            const applied = record?.containerId ? readApplied(key, record.containerId) : null;
            if (!configured && !applied?.mpsGeneration) continue;
            refusals.push(buildDirectRefusal({ key, ref, alias: record?.alias || node.alias || null,
                refusalParts: { reasonCode: 'gpu_sharing_unavailable', reason: error.message,
                    fix: 'Inspect ploinky limits status, repair the MPS state or restart this Box on the host, then retry the affected agent.',
                    requested: [{ field: 'gpu', value: 'configured or previously applied MPS share', source: 'settings' }] },
                inputFingerprint: hex64({ ref, configured, gpu: context.gpu?.wiringFingerprint, reason: error.message }),
            }));
        }
        return { replacedKeys: new Set(), refusals, diagnostic: { code: String(error.code || 'gpu_sharing_unavailable').slice(0, 64), message: String(error.message).slice(0, 1024), fix: 'Inspect ploinky limits status and restart this Box on the host before using GPU shares.' } };
    }
}
