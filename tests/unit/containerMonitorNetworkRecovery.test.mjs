import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-network-recovery-'));
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = root;
const { performContainerRestart } = await import('../../cli/server/containerMonitor.js');
const {
    buildRuntimeNetworkPlan,
    resolveReplacementRuntimeIdentity,
} = await import('../../cli/sandbox/docker/agentServiceManager.js');

test.after(() => {
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
});

for (const mode of ['host', 'none', 'default', 'bridge']) {
    for (const state of ['stopped', 'missing']) {
        test(`watchdog recovers a ${state} ${mode} runtime from an active generation`, async () => {
            const network = mode === 'bridge'
                ? { mode, attachments: [{ name: 'fixture', primary: true }] }
                : { mode };
            const managed = mode === 'default' || mode === 'bridge';
            const manifestPath = path.join(root, `manifest-${mode}-${state}.json`);
            fs.writeFileSync(manifestPath, JSON.stringify({
                container: 'node:20-alpine',
                start: 'sleep infinity',
                network: { mode: 'default' },
                profiles: { default: { network } },
                health: { readiness: { type: 'script', script: 'true' } },
            }));
            const oldRecord = {
                type: 'agent', runtime: 'container', repoName: 'fixtures', agentName: 'demo',
                instanceId: 'old-instance', enableGeneration: 'old-enable', containerId: 'old-container-id',
            };
            const target = {
                ...oldRecord, containerName: 'fixture-runtime', manifestPath, isRestarting: true,
            };
            let registry = { [target.containerName]: structuredClone(oldRecord) };
            let routing = { routes: { demo: { container: target.containerName } } };
            const selector = { state: 'active' };
            const networkCapability = Object.freeze({ fixture: 'network-lock' });
            const applyCapability = Object.freeze({ fixture: 'apply-lock' });
            const preparationLease = Object.freeze({
                mode: managed ? 'additive' : 'replacement',
                transactionId: `${mode}-${state}`,
            });
            const events = [];
            let networkHeld = false;
            let applyHeld = false;
            let finalRecord;
            let preparedRecord;
            let successorName;
            const withApplyLock = asyncOrSyncCallback => {
                assert.equal(networkHeld, true);
                assert.equal(applyHeld, false);
                applyHeld = true;
                try {
                    const result = asyncOrSyncCallback(applyCapability);
                    if (result && typeof result.then === 'function') {
                        return result.finally(() => { applyHeld = false; });
                    }
                    applyHeld = false;
                    return result;
                } catch (error) {
                    applyHeld = false;
                    throw error;
                }
            };
            const monitor = {
                targets: new Map([[target.containerName, target]]),
                isShuttingDown: () => false,
                log() {},
                createWorkspaceMutationLease: () => Object.freeze({ fixture: 'workspace-lease' }),
                releaseWorkspaceMutationLease() {},
                async withNetworkLifecycleLock(callback) {
                    networkHeld = true;
                    try { return await callback(networkCapability); }
                    finally { networkHeld = false; }
                },
                readEdgeRoutingSelection: () => ({ selector }),
                resolveRouterEndpoint: resolvedMode => resolvedMode === 'none' ? null : {
                    mode: resolvedMode, host: '127.0.0.1', port: 8080, url: 'http://127.0.0.1:8080',
                },
                ensureAgentService(_agent, _manifest, _dir, options) {
                    assert.equal(networkHeld, true);
                    assert.deepEqual(options.profileResolution.network, network);
                    assert.equal(options.preserveActiveAuthorization, managed);
                    // Exercise the real identity coordinator with the same
                    // runtime-network decision used by ensureAgentService.
                    const plan = buildRuntimeNetworkPlan('podman', options.profileResolution.network);
                    const values = ['new-instance', 'new-enable'];
                    const identity = resolveReplacementRuntimeIdentity({
                        containerName: target.containerName,
                        existingRecord: oldRecord,
                        existingRuntime: state === 'stopped',
                        recreateReason: state === 'stopped' ? 'runtimeStopped' : null,
                        stageAlongsidePredecessor: plan.requiresManagedNetwork,
                        preserveActiveAuthorization: options.preserveActiveAuthorization,
                        networkLifecycleCapability: options.networkLifecycleCapability,
                    }, {
                        assertNetworkCapability: received => assert.equal(received, networkCapability),
                        withApplyLock,
                        inactivate(_reason, received) {
                            assert.equal(applyHeld, true);
                            assert.equal(received.applyLockCapability, applyCapability);
                            selector.state = 'inactive';
                            events.push('inactivate');
                        },
                        loadRegistry: () => structuredClone(registry),
                        loadRouting: () => structuredClone(routing),
                        saveRegistry(next) {
                            assert.equal(applyHeld, true);
                            assert.equal(selector.state, 'inactive');
                            registry = structuredClone(next);
                            events.push('stage-registry');
                        },
                        saveRouting: () => assert.fail('same-name replacement must not rewrite the route early'),
                        prepare({ agents, applyLockCapability }) {
                            assert.equal(applyLockCapability, applyCapability);
                            assert.equal(selector.state, 'active');
                            assert.deepEqual(registry[target.containerName], oldRecord);
                            events.push('prepare-additive');
                            return { selector, preparationLease, generation: { agents } };
                        },
                        prepareReplacement({ applyLockCapability }) {
                            assert.equal(applyLockCapability, applyCapability);
                            assert.equal(selector.state, 'inactive');
                            events.push('prepare-replacement');
                            return { selector, preparationLease, generation: { agents: structuredClone(registry) } };
                        },
                        uuid: () => values.shift(),
                    });
                    successorName = identity.candidateContainerName;
                    assert.equal(successorName === target.containerName, !managed);
                    assert.equal(selector.state, managed ? 'active' : 'inactive');
                    events.push('physical-launch');
                    preparedRecord = structuredClone(identity.preparedRegistryRecord);
                    finalRecord = { ...preparedRecord, containerId: 'new-container-id', config: { ports: [] } };
                    return {
                        containerName: successorName,
                        hostPort: mode === 'none' ? 0 : 43123,
                        registryRecord: finalRecord,
                        stagedRegistryRecord: preparedRecord,
                        preparationLease: identity.preparationLease,
                        requiresEdgeActivation: true,
                        ...(managed ? { replacementPredecessor: {
                            containerName: target.containerName,
                            containerId: oldRecord.containerId,
                            registryRecord: structuredClone(oldRecord),
                            runtimeNetwork: network,
                        } } : {}),
                    };
                },
                resolveAgentReadinessProtocol: () => 'script',
                runContainerScriptReadiness() {
                    assert.equal(selector.state, managed ? 'active' : 'inactive');
                    assert.deepEqual(registry['fixture-runtime'], managed ? oldRecord : preparedRecord);
                    events.push('readiness');
                    return { status: 'success' };
                },
                withEdgeGenerationApplyLock: withApplyLock,
                loadAgents: () => structuredClone(registry),
                readRoutingConfig: () => structuredClone(routing),
                saveAgents(next) {
                    assert.equal(applyHeld, true);
                    assert.equal(selector.state, 'inactive');
                    registry = structuredClone(next);
                    events.push('commit-registry');
                },
                async mergeRoutingConfig(mutator) {
                    routing = await mutator(structuredClone(routing));
                    events.push('commit-route');
                },
                applyEdgeRoutingGeneration(options) {
                    assert.equal(applyHeld, true);
                    assert.equal(options.applyLockCapability, applyCapability);
                    assert.equal(options.preparationLease, preparationLease);
                    assert.equal(selector.state, 'inactive');
                    options.testHooks.beforeSelectorCommit();
                    selector.state = 'active';
                    events.push('activate');
                },
                commitAdditiveEdgeRoutingGeneration(lease, options) {
                    assert.equal(applyHeld, true);
                    assert.equal(lease, preparationLease);
                    assert.equal(options.applyLockCapability, applyCapability);
                    assert.equal(selector.state, 'active');
                    assert.deepEqual(registry['fixture-runtime'], oldRecord);
                    registry = structuredClone(options.agents);
                    routing = structuredClone(options.routing);
                    events.push('commit-additive');
                },
                retireExactAgentRuntimePredecessor(predecessor, options) {
                    assert.equal(options.networkLifecycleCapability, networkCapability);
                    assert.equal(predecessor.containerId, oldRecord.containerId);
                    assert.equal(registry['fixture-runtime'], undefined);
                    events.push('retire-predecessor');
                },
                abortEdgeRoutingPreparation: () => assert.fail('successful recovery must not abort its lease'),
                cleanupFailedRuntime: () => assert.fail('successful recovery must not clean up its successor'),
            };

            await performContainerRestart(monitor, target, 'not_running');

            assert.equal(selector.state, 'active');
            assert.deepEqual(registry, { [successorName]: finalRecord });
            assert.equal(routing.routes.demo.container, successorName);
            assert.equal(target.instanceId, 'new-instance');
            assert.equal(target.enableGeneration, 'new-enable');
            assert.equal(target.isRestarting, false);
            assert.deepEqual(events, managed ? [
                'prepare-additive', 'physical-launch', 'readiness', 'commit-additive', 'retire-predecessor',
            ] : [
                'inactivate', 'stage-registry', 'prepare-replacement', 'physical-launch',
                'readiness', 'commit-registry', 'commit-route', 'activate',
            ]);
        });
    }
}
