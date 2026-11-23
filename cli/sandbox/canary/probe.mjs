import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { sha256RawBodyHash } from '../../../Agent/lib/requestHash.mjs';
import { buildRelayReadinessRoute } from '../../server/utils/agentReadiness.js';
import { createRelayHttpAgent, RelayDuplex } from '../../server/proxy/executeHttpPlan.js';
import { compileProxyLimits } from '../../server/proxy/limits.js';
import { RuntimeRelayManager } from '../../server/runtimeRelay/RuntimeRelayManager.js';
import { RelayRequestMinter } from '../../server/runtimeRelay/relayRequestMinter.js';
import { deriveAgentRequestSecret } from '../../utils/security/masterKey.js';
import { assertExactContainerOwnership, IMMUTABLE_CONTAINER_ID } from '../docker/containerOwnership.js';
import { NETWORK_LABELS, workspaceNetworkIdentity } from '../networkIdentity.js';

const run = promisify(execFile);

// The container may still be unpublished. Begin with the receipt's immutable
// ID, then build the same private channel as declared readiness from that ID.
export async function probeCanaryContainer({
    runtime, containerId, containerName, port, path, status, timeoutMs = 5000,
    workspaceRoot, registryRecord, signal,
} = {}, options = {}) {
    if (!['podman', 'docker'].includes(runtime) || !IMMUTABLE_CONTAINER_ID.test(containerId)
        || typeof containerName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(containerName)
        || !Number.isInteger(port) || port < 1 || port > 65535
        || typeof path !== 'string' || !/^\/(?!\/)/.test(path) || /[\\#\s\x00-\x1f\x7f]/u.test(path)
        || !Number.isInteger(status) || status < 100 || status > 599
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1) {
        return { ok: false, status: null, code: 'CANARY_PROBE_INVALID' };
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const cancellation = AbortSignal.any([deadline, signal, options.signal].filter(Boolean));
    let manager, channel, agent;
    let observation = { inspectFailed: true };
    let onAbort;
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(new Error('operator probe cancelled'));
        cancellation.addEventListener('abort', onAbort, { once: true });
    });
    async function requestStatus() {
        cancellation.throwIfAborted();
        const { stdout } = await run(runtime, ['container', 'inspect', containerId], {
            signal: cancellation, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL',
        });
        cancellation.throwIfAborted();
        const [inspection] = JSON.parse(stdout);
        const labels = inspection.Config.Labels;
        const principal = inspection.Config.Env.find(value => value.startsWith('PLOINKY_AGENT_ID='));
        const match = /^PLOINKY_AGENT_ID=agent:([^/:\s]+)\/([^/:\s]+)$/.exec(principal);
        if (!match) throw new Error('missing agent identity');
        const record = registryRecord || {
            type: 'agent', repoName: match[1], agentName: match[2],
            instanceId: labels[NETWORK_LABELS.instanceId], enableGeneration: labels[NETWORK_LABELS.enableGeneration],
        };
        assertExactContainerOwnership(containerName, record, inspection, containerId, workspaceNetworkIdentity(workspaceRoot).hash);
        if (record.repoName !== match[1] || record.agentName !== match[2]) throw new Error('agent identity mismatch');
        const running = inspection.State?.Running;
        const startedAt = inspection.State?.StartedAt;
        if (typeof running !== 'boolean' || (running && (typeof startedAt !== 'string' || !Number.isFinite(Date.parse(startedAt))))) {
            throw new Error('missing container state');
        }
        observation = { containerId, running, ...(startedAt ? { startedAt } : {}) };
        if (!running) return { ...observation, ok: false, status: null, code: 'CANARY_PROBE_STOPPED' };
        const route = buildRelayReadinessRoute({
            manifest: { readiness: { port } },
            runtimeResult: { containerId, containerName, registryRecord: { ...record, runtime } },
            networkMode: inspection.HostConfig.NetworkMode,
        });
        if (route.deniedPorts.includes(port)) return { ...observation, ok: false, status: null, code: 'CANARY_PROBE_PORT_DENIED' };
        const queryStart = path.indexOf('?');
        const limits = compileProxyLimits({ connectTimeoutMs: Math.min(5000, timeoutMs) });
        const plan = {
            ...route, limits, method: 'GET', port, transport: 'http',
            targetPath: queryStart < 0 ? path : path.slice(0, queryStart),
            query: queryStart < 0 ? '' : path.slice(queryStart + 1),
        };
        manager = new RuntimeRelayManager({
            limits, minter: new RelayRequestMinter({ resolveAgentSecret: deriveAgentRequestSecret }),
            // checkout verifies this exact fresh inspection and its control socket.
            inspectContainer: async () => inspection,
        });
        const lease = { commit: () => !cancellation.aborted, release() {} };
        channel = await manager.checkout({ plan, lease, authorized: true });
        cancellation.throwIfAborted();
        const stream = await channel.openRequest({ plan, bodyMode: 'none', bodyHash: sha256RawBodyHash() });
        cancellation.throwIfAborted();
        agent = createRelayHttpAgent(new RelayDuplex(stream));
        const actual = await new Promise((resolve, reject) => {
            const request = http.get({ agent, path, port, hostname: '127.0.0.1', signal: cancellation }, response => {
                resolve(response.statusCode);
                response.destroy();
            });
            request.on('error', reject);
        });
        return actual === status ? { ...observation, ok: true, status: actual }
            : { ...observation, ok: false, status: actual, code: 'CANARY_PROBE_STATUS' };
    }
    try {
        return await Promise.race([requestStatus(), aborted]);
    } catch {
        // Inspection and transport errors can contain the container environment.
        return { ...observation, ok: false, status: null, code: cancellation.aborted ? 'CANARY_PROBE_CANCELLED' : 'CANARY_PROBE_FAILED' };
    } finally {
        cancellation.removeEventListener('abort', onAbort);
        agent?.destroy();
        channel?.close();
        manager?.close();
    }
}
