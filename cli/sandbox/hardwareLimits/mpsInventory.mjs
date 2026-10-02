import { spawnSync } from 'node:child_process';
import { createNetworkLifecycleAdapter } from '../networkLifecycle.js';
import { networkContractHash } from '../networkContract.js';
import { effectiveInstanceKey } from '../../utils/workspaceDependencyGraph.js';
import { MpsError } from './mpsEligibility.mjs';
import { isMpsClientAlias } from './mps.mjs';

/** A daemon transition must not discard an unjournaled CUDA client's server. */
export function assertKnownMpsClients({ runtime, registry = {}, state = null, query = spawnSync } = {}) {
    if (!['podman', 'docker'].includes(runtime)) throw new MpsError('MPS inventory requires a supported nested engine');
    const reply = query(runtime, ['ps', '-a', '--no-trunc', '--filter', 'label=ploinky.mpsgeneration', '--format', '{{.ID}}'], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const text = String(reply.stdout || '').trim();
    if (reply.status !== 0 || reply.error || reply.signal || Buffer.byteLength(text) > 64 * 1024) throw new MpsError('The complete MPS client inventory is unavailable');
    const ids = text ? text.split(/\r?\n/) : [];
    if (ids.length > 512 || ids.some((id) => !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size !== ids.length) throw new MpsError('MPS client inventory has ambiguous identities');
    const known = new Set([...Object.values(registry).map((record) => record?.containerId),
        ...(state?.oldClients || []).map((client) => client.containerId), ...(state?.pendingClients || []).map((client) => client.containerId)]);
    if (ids.some((id) => !known.has(id))) throw new MpsError('An MPS client is outside the exact registry and transition journal. Recover this Box on the host before changing its daemon.');
    return ids;
}

/**
 * The alias to inspect or drain one journaled client with. The exact current
 * registry record (same key, instanceId, enableGeneration and containerId)
 * decides; a journaled alias that disagrees with it is an identity change.
 * Without an exact record only the journaled alias can be used, and a journal
 * written before aliases were recorded cannot prove one.
 */
export function resolveMpsClientAlias(client, record) {
    const journaled = Object.hasOwn(client, 'alias') ? client.alias : undefined;
    if (journaled !== undefined && !isMpsClientAlias(journaled)) throw new MpsError('MPS client alias is invalid', 'identity_changed');
    const exact = record && record.instanceId === client.instanceId && record.enableGeneration === client.enableGeneration
        && record.containerId === client.containerId;
    if (exact) {
        const current = record.alias === undefined || record.alias === null ? '' : record.alias;
        if (!isMpsClientAlias(current)) throw new MpsError('MPS client registry alias is invalid', 'identity_changed');
        if (journaled !== undefined && journaled !== current) throw new MpsError('MPS client alias changed since it was journaled', 'identity_changed');
        return current;
    }
    if (journaled === undefined) throw new MpsError('MPS client has neither an exact registry record nor a journaled alias', 'identity_changed');
    return journaled;
}

export function inspectMpsClient(client, { network, runtime, alias = client.alias, createAdapter = createNetworkLifecycleAdapter } = {}) {
    if (!/^[a-f0-9]{64}$/.test(String(client.containerId || ''))) throw new MpsError('MPS inspection needs an immutable client ID', 'identity_changed');
    // Never the canonical identity by default: an aliased instance has its own.
    if (!isMpsClientAlias(alias)) throw new MpsError('MPS inspection needs the exact client alias', 'identity_changed');
    const [repoName, agentName] = String(client.ref || '').split('/');
    return createAdapter({ runtime }).inspectContainerContract(client.containerId, network, agentName, {
        instanceKey: effectiveInstanceKey(repoName, agentName, alias), contractHash: networkContractHash(network),
        instanceId: client.instanceId, enableGeneration: client.enableGeneration, requireRuntimeIdentity: true,
    });
}

const IMMUTABLE_ID = /^[a-f0-9]{64}$/;
export const sameMpsTuple = (left, right) => Boolean(left && right) && left.key === right.key && left.instanceId === right.instanceId
    && left.enableGeneration === right.enableGeneration && left.containerId === right.containerId;

/**
 * Journaled created candidates: 'readiness' entries with an immutable ID that
 * the registry does not publish for their key. A failed readiness or a crash
 * leaves them behind while the registry still names the predecessor; they are
 * settled through their own exact tuple, never through the registry record.
 * An entry the registry publishes is an ordinary client whose receipt is
 * pending, and an uncreated intent has no immutable ID.
 */
export function createdMpsCandidates(state, registry = {}) {
    return (Array.isArray(state?.pendingClients) ? state.pendingClients : []).filter((entry) => entry?.phase === 'readiness'
        && IMMUTABLE_ID.test(String(entry.containerId || ''))
        && !sameMpsTuple({ ...entry }, registry[entry.key]?.type === 'agent' ? { key: entry.key, ...registry[entry.key] } : null));
}

/** Presence by immutable ID only, for a client without a resolvable network. */
export function inspectMpsClientPresence(client, { runtime, createAdapter = createNetworkLifecycleAdapter } = {}) {
    if (!IMMUTABLE_ID.test(String(client?.containerId || ''))) throw new MpsError('MPS inspection needs an immutable client ID', 'identity_changed');
    const [, agentName] = String(client.ref || '').split('/');
    // An empty contract hash proves absence or reports presence as foreign;
    // it never accepts a runtime it cannot fully identify.
    const observed = createAdapter({ runtime }).inspectContainerContract(client.containerId, null, agentName || 'unknown', { contractHash: '' });
    return observed.state === 'absent' ? { state: 'absent', id: null } : { state: 'present', id: observed.id || null };
}

/** The registry-shaped exact identity a created candidate was launched with. */
export function mpsCandidateRecord(candidate) {
    const [repoName, agentName] = String(candidate.ref || '').split('/');
    if (!repoName || !agentName || !isMpsClientAlias(candidate.alias ?? '')) throw new MpsError('A journaled MPS candidate has no exact identity', 'identity_changed');
    return { type: 'agent', repoName, agentName, alias: candidate.alias || '', instanceId: candidate.instanceId, enableGeneration: candidate.enableGeneration, containerId: candidate.containerId };
}

/**
 * Settle one created candidate: absent means it is already gone; the exact
 * runtime (labels, instance identity and immutable ID) is removed by that ID;
 * anything else is refused without effects.
 */
export function settleCreatedMpsCandidate(candidate, { inspect, remove }) {
    const observation = inspect(candidate);
    if (observation?.state === 'absent') return 'absent';
    if (observation?.state !== 'exact' || observation.id !== candidate.containerId) {
        throw new MpsError(`The journaled MPS candidate ${candidate.key} is not its exact created runtime. Recover this Box on the host before changing its daemon.`, 'identity_changed');
    }
    mpsCandidateRecord(candidate);
    const removed = remove(candidate);
    if (removed?.state !== 'removed' && removed?.state !== 'absent') throw new MpsError(`The journaled MPS candidate ${candidate.key} could not be removed by its immutable ID`, 'identity_changed');
    return 'removed';
}

/** Drop exactly that candidate's journal entry after its cleanup succeeded. */
export function dropSettledMpsCandidate(store, candidate) {
    const current = store.read();
    if (!current) return;
    store.write({ ...current, pendingClients: (current.pendingClients || []).filter((entry) => !(entry.phase === 'readiness' && sameMpsTuple(entry, candidate))) });
}
