import { spawnSync } from 'node:child_process';
import { createNetworkLifecycleAdapter } from '../networkLifecycle.js';
import { networkContractHash } from '../networkContract.js';
import { effectiveInstanceKey } from '../../utils/workspaceDependencyGraph.js';
import { MpsError } from './mpsEligibility.mjs';

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

export function inspectMpsClient(client, { network, runtime, alias = client.alias || '', createAdapter = createNetworkLifecycleAdapter } = {}) {
    if (!/^[a-f0-9]{64}$/.test(String(client.containerId || ''))) throw new MpsError('MPS inspection needs an immutable client ID', 'identity_changed');
    const [repoName, agentName] = String(client.ref || '').split('/');
    return createAdapter({ runtime }).inspectContainerContract(client.containerId, network, agentName, {
        instanceKey: effectiveInstanceKey(repoName, agentName, alias), contractHash: networkContractHash(network),
        instanceId: client.instanceId, enableGeneration: client.enableGeneration, requireRuntimeIdentity: true,
    });
}
