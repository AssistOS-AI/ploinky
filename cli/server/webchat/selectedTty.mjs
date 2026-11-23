import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertExactContainerOwnership, IMMUTABLE_CONTAINER_ID, OCI_LOG_RUNTIMES } from '../../sandbox/docker/containerOwnership.js';
import { workspaceNetworkIdentity } from '../../sandbox/networkIdentity.js';
import { verifyRegisteredLaunchId } from '../../utils/security/agentIdentityEnv.js';

const exec = promisify(execFile);

// Inspect one immutable ID. Engine output contains the process environment and must never escape in diagnostics.
export async function inspectWebchatLaunch(target, run = exec) {
    const record = target.targetRecord;
    if (!record || (target.selection?.copy !== 'old' && !record.launchId)
        || !OCI_LOG_RUNTIMES.includes(record.runtime) || !IMMUTABLE_CONTAINER_ID.test(record.containerId)) {
        throw new Error('WebChat requires an exact managed launch');
    }
    try {
        const { stdout } = await run(record.runtime, ['container', 'inspect', record.containerId], {
            timeout: 5000, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL',
        });
        const [inspection] = JSON.parse(stdout);
        assertExactContainerOwnership(target.container, record, inspection, record.containerId, workspaceNetworkIdentity().hash);
        verifyRegisteredLaunchId(record.launchId, inspection.Config.Env);
        const principals = inspection.Config.Env.filter(entry => entry.startsWith('PLOINKY_AGENT_ID='));
        if (inspection.State?.Running !== true || principals.length !== 1
            || principals[0] !== 'PLOINKY_AGENT_ID=agent:' + record.repoName + '/' + record.agentName) throw new Error();
    } catch {
        throw new Error('WebChat could not verify the selected running launch');
    }
    return Object.freeze({ runtime: record.runtime, containerId: record.containerId, launchId: record.launchId });
}
