import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { readAgentRegistrySnapshot } from '../../utils/agentRegistrySnapshot.js';
import { resolveManifestRuntimeProfile } from '../../utils/runtime/profileService.js';
import { readEdgeRoutingSelection } from '../edgeGeneration.js';
import { assertNetworkLifecycleCapability, createNetworkLifecycleAdapter } from '../networkLifecycle.js';
import { getRuntime } from '../docker/common.js';
import { drainTargetedContainer, TARGETED_DRAIN_ACKNOWLEDGEMENT } from '../docker/targetedContainerLifecycle.js';
import { retireRuntimeRelaySocket } from '../docker/healthProbes.js';
import { readBoxHardwareContext } from './context.mjs';
import { readAppliedObservation } from './runtimeState.mjs';
import { assertKnownMpsClients } from './mpsInventory.mjs';
import { createMpsStateStore, createMpsDaemonBackend } from './mps.mjs';
import { MpsError } from './mpsEligibility.mjs';
import { resolveStoredGpuShare } from './resolve.mjs';
import { buildDirectRefusal, hex64 } from './requestedLimits.mjs';
import { resolveMpsServerDefault } from './mpsTransition.mjs';

const tuple = (client) => [client.key, client.instanceId, client.enableGeneration, client.containerId || ''].join('\0');
const sameRecord = (client, record) => record?.type === 'agent' && client.instanceId === record.instanceId
    && client.enableGeneration === record.enableGeneration && client.containerId === record.containerId;

// Graph preparation already selected the complete workspace inactive. This
// phase drains exact predecessors only; the existing graph batch owns removal,
// identity rotation, its preparation lease, readiness and final publication.
async function prepareMpsGraphImpl({ nodes, networkLifecycleCapability, deadline = Date.now() + 15 * 60_000 } = {}, {
    readContext = readBoxHardwareContext, loadRegistry = readAgentRegistrySnapshot, readApplied = readAppliedObservation,
    store = createMpsStateStore(), backend = createMpsDaemonBackend(), assertCapability = assertNetworkLifecycleCapability,
    readSelection = readEdgeRoutingSelection, resolveShare = resolveStoredGpuShare, runtime = getRuntime,
    inspect = (client, network, engine) => createNetworkLifecycleAdapter({ runtime: engine }).inspectContainerContract(
        client.key, network, client.ref.split('/')[1], { instanceId: client.instanceId, enableGeneration: client.enableGeneration, requireRuntimeIdentity: true }),
    drain = drainTargetedContainer, observeClients = assertKnownMpsClients,
} = {}) {
    assertCapability(networkLifecycleCapability);
    const context = readContext();
    const replacedKeys = new Set();
    if (context.gate !== 'on') return { replacedKeys };
    const registry = loadRegistry();
    const members = new Map(nodes.map((entry) => [entry.key, entry]));
    let saved;
    try { saved = store.read(); } catch (_) { throw new MpsError('The private MPS state cannot be read safely', 'mps_backend_unavailable'); }
    const clients = new Map((saved?.oldClients || []).map((client) => [tuple(client), client]));
    for (const [key, record] of Object.entries(registry)) {
        if (record?.type !== 'agent' || !record.containerId) continue;
        const applied = readApplied(key, record.containerId);
        if (!applied?.mpsGeneration || applied.instanceId !== record.instanceId || applied.enableGeneration !== record.enableGeneration) continue;
        const client = { key, ref: `${record.repoName}/${record.agentName}`, instanceId: record.instanceId,
            enableGeneration: record.enableGeneration, containerId: record.containerId, share: applied.gpuShare, mpsGeneration: applied.mpsGeneration };
        if (!clients.has(tuple(client))) clients.set(tuple(client), client);
    }
    const policies = [];
    for (const [ref, entry] of context.overrides || []) {
        if (!entry.gpu) continue;
        try { policies.push({ share: resolveShare(entry.gpu, context.gpu, ref) }); }
        catch (_) { /* Metadata admission contains this agent's GPU refusal. */ }
    }
    if (!clients.size && !saved?.daemon && !policies.length) return { replacedKeys };
    observeClients({ runtime: runtime(), registry, state: saved });
    if (clients.size > 256) throw new MpsError('MPS graph cohort exceeds its bound');
    const desiredServerDefault = resolveMpsServerDefault(policies);
    const observation = saved?.daemon || saved?.pipeDirectory ? backend.observe(saved) : { state: 'gone' };
    if (['foreign', 'unknown'].includes(observation.state)) throw new MpsError('MPS graph preparation cannot prove daemon ownership', 'mps_backend_unavailable');
    const generation = saved?.daemonGeneration && saved?.configurationGeneration ? `${saved.daemonGeneration}:${saved.configurationGeneration}` : '';
    const healthy = saved?.status === 'ready' && observation.state === 'owned' && backend.verify(saved);
    const needsTransition = !isDeepStrictEqual(saved?.serverDefault || null, desiredServerDefault)
        || Boolean(desiredServerDefault && !healthy) || [...clients.values()].some((client) => client.mpsGeneration !== generation);
    const alreadyDrained = new Set(saved?.drainedClients || []);
    const toDrain = [];
    for (const client of clients.values()) {
        const member = members.get(client.key);
        if (!member) throw new MpsError(`MPS client ${client.key} is outside the admitted graph; no client was drained`);
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
        const observed = inspect(client, network, engine);
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
    check();
    const state = { ...(saved || { schema: 1, daemon: null, daemonGeneration: null, configurationGeneration: null,
        pipeDirectory: null, logDirectory: null, serverDefault: null }), status: needsTransition || replacedKeys.size ? 'pending' : saved?.status || 'inactive',
        graphPrepared: true, graphPreparationId: randomUUID(), graphNeedsTransition: needsTransition, replacedKeys: [...replacedKeys], desiredServerDefault,
        oldClients: [...clients.values()], drainedClients: [...alreadyDrained], pendingClients: saved?.pendingClients || [], lastProblem: null };
    store.write(state);
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
    try { return await prepareMpsGraphImpl(input, dependencies); }
    catch (error) {
        if (error.code !== 'mps_backend_unavailable') throw error;
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
        if (!refusals.length) throw error;
        return { replacedKeys: new Set(), refusals };
    }
}
