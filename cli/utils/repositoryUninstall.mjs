import { assertWorkspaceMutationLease } from './runtime/maintenanceLocks.js';
import * as reposSvc from './repos.js';
import * as agentsSvc from './agents.js';
import * as workspaceSvc from './workspace.js';

// A repository uninstall is one workspace mutation, whether the Router or the
// CLI runs it. Target resolution, agent selection, their disable and the source
// removal all run under one lease, so no enable, update or other repository
// change interleaves with them, and a repository with no enabled agent is
// serialized too. The nested disable runs under exactly this lease and the
// lease is revalidated before the removal, so a lost lease refuses instead of
// re-acquiring. `withLease(options, fn)` supplies the lease: the Router always
// acquires its own; a CLI command reuses one its operation already holds.
export async function uninstallRepositoryUnderLease(target, {
    withLease,
    workspaceLeaseWaitMs,
    agentDisableDependencies = {},
    stdio = 'inherit',
} = {}) {
    if (typeof withLease !== 'function') throw new TypeError('repository uninstall requires a workspace lease provider');
    const leaseOptions = workspaceLeaseWaitMs === undefined
        ? { operation: 'repositories-uninstall' }
        : { operation: 'repositories-uninstall', waitTimeoutMs: workspaceLeaseWaitMs };
    return withLease(leaseOptions, async (lease) => {
        const repoName = reposSvc.resolveInstalledRepoTarget(target);
        assertWorkspaceMutationLease(lease);
        const containerNames = Object.entries(workspaceSvc.loadAgents() || {})
            .filter(([, record]) => record && record.type === 'agent' && record.repoName === repoName && record.agentName)
            .map(([containerName]) => containerName);
        const disabledAgents = await agentsSvc.disableAgentContainers(containerNames, {
            ...agentDisableDependencies,
            withWorkspaceLeaseImpl: (_options, fn) => fn(assertWorkspaceMutationLease(lease)),
        });
        assertWorkspaceMutationLease(lease);
        return {
            ...reposSvc.uninstallRepo(repoName, { stdio }),
            disabledAgents,
        };
    });
}
