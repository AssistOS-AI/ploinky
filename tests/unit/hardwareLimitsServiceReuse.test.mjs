import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { verifyReusableHardwareRuntime, exactCleanupFailureOf } from '../../cli/sandbox/docker/agentServiceManager.js';

// Execute the production service function with isolated engine/registry
// collaborators. Keeping its complete body catches a missing reuse guard at
// the real return branch while preventing any fixture from invoking Podman.
const source = fs.readFileSync(new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url), 'utf8');
const start = source.indexOf('function ensureAgentService(');
const end = source.indexOf('\nfunction removeExactGenerationCandidate(', start);
assert.ok(start > 0 && end > start);
const serviceSource = source.slice(start, end);

function fixture(mode, { problem = null, cleanupProblem = null, inactivationProblem = null } = {}) {
    const events = [];
    const key = 'ploinky_demo_worker_router';
    const id = 'a'.repeat(64);
    const record = { type: 'agent', repoName: 'demo', agentName: 'worker', alias: 'router', instanceId: 'instance', enableGeneration: 'generation', containerId: id, projectPath: '/fixture', runMode: 'isolated' };
    const network = { mode };
    const manifest = { container: 'image', network };
    const admission = { descriptor: {}, runtimeKind: 'container' };
    const noOp = () => {};
    const dependencies = {
        admitAgentServicePreflight: () => ({ preflightRepoName: 'demo', preflightManifestPath: '/fixture/manifest.json', preflightManifestBytes: Buffer.from(JSON.stringify(manifest)), preflightAgentRuntime: 'podman', preflightRuntimeKind: 'container', preflightAdmission: admission, hardwareInstanceKey: key }),
        normalizeTargetedRestart: () => null,
        readAppliedObservation: () => null,
        hasMpsLaunch: () => false,
        assertNetworkLifecycleCapability: noOp,
        dependencyRefreshOperation: () => false,
        resolveAgentRepositoryName: () => 'demo',
        assertAgentServiceNotDraining: noOp,
        loadAgentsMap: () => ({ [key]: record }),
        assertPreparedRegistryRecordPreservation: () => false,
        resolveManifestRuntimeProfile: () => ({ resolvedProfileName: 'default', profileConfig: {}, network }),
        resolveLlmRuntimeAdmissionContext: () => ({ catalogPolicy: null, catalogIdentity: null }),
        admitManifestRuntimeCapabilities: () => admission,
        assertNetworkStartupCompatibility: noOp,
        assertRouterEndpoint: () => null,
        getRuntimeForAgent: () => 'podman',
        getRuntime: () => 'podman',
        containerExists: () => true,
        assertManifestEnvProfileCompleteness: noOp,
        resolveManifestImage: () => 'image',
        buildRuntimeRouterEnv: () => ({}),
        buildRuntimeNetworkPlan: () => ({ mode, hashEnv: {} }),
        manifestUsesHealthProbeBroker: () => false,
        parseManifestPorts: () => ({ publishArgs: [], portMappings: [] }),
        assertHostPortContract: noOp,
        buildEnvMap: () => ({}),
        resolveImplicitAgentServerPort: () => 0,
        shouldCreateImplicitAgentServerPublish: () => false,
        readManifestAgentCommand: () => ({ raw: null }),
        readManifestStartCommand: () => null,
        randomUUID,
        computeEnvHash: () => 'hash',
        getContainerLabel: () => 'hash',
        debugLog: noOp,
        agentLibReuseProblem: () => null,
        agentLibGrant: () => ({}),
        limitsHashReuseReason: () => null,
        LIMITS_HASH_LABEL: 'ploinky.limitshash',
        isLlmRuntimeManifest: () => false,
        createNetworkLifecycleAdapter: () => ({ inspectContainerContract: () => ({ state: 'exact', running: true, id }) }),
        effectiveInstanceKey: () => key,
        networkContractHash: () => 'network-hash',
        getConfiguredProjectPath: () => '/fixture',
        resolveAgentHomeLayout: () => ({ binds: [] }),
        getAgentWorkDir: () => '/fixture/home',
        spawnSync: () => ({ status: 0, stdout: JSON.stringify([{ Id: id }]) }),
        hasExactAgentHomeLayout: () => true,
        verifyReusableHardwareRuntime: (value, captured) => verifyReusableHardwareRuntime(value, captured, {
            createGuard: () => ({ afterLaunch(observed) { events.push(['readback', observed.containerId]); if (problem) throw problem; } }),
            inactivate() { events.push(['revoke']); if (inactivationProblem) throw inactivationProblem; },
            removeExact(capturedRuntime) { events.push(['remove', capturedRuntime.containerId, capturedRuntime.record.instanceId]); if (cleanupProblem) throw cleanupProblem; return { removed: true }; },
        }),
        assertHostModeGenerationCapability: () => events.push(['host-authority']),
        deriveAgentPrincipalId: () => 'demo/worker',
        syncAgentMcpConfig: () => events.push(['mcp']),
        structuredClone,
    };
    const run = new Function(...Object.keys(dependencies), `${serviceSource}\nreturn ensureAgentService;`)(...Object.values(dependencies));
    return { events, key, id, run: () => run('worker', manifest, '/fixture', { containerName: key, alias: 'router', routerEndpoint: null, networkLifecycleCapability: {} }) };
}

test('D.service-host-none-readback-before-reuse', () => {
    for (const mode of ['host', 'none']) {
        const f = fixture(mode);
        const result = f.run();
        assert.equal(result.containerId, f.id);
        assert.equal(result.createdByThisLaunch, false);
        assert.deepEqual(f.events[0], ['readback', f.id]);
        assert.equal(f.events.some(([event]) => event === 'remove' || event === 'revoke'), false);
    }
});

test('D.service-host-none-readback-failure-removes-exact-reuse', () => {
    for (const mode of ['host', 'none']) {
        const problem = Object.assign(new Error('applied cgroup differs'), { code: 'PLOINKY_RUNTIME_INPUT_CHANGED' });
        const f = fixture(mode, { problem });
        assert.throws(f.run, (error) => {
            assert.equal(error, problem);
            assert.equal(error.ploinkyRestartCandidate.containerId, f.id);
            assert.equal(error.ploinkyRestartCandidate.exactCleanupPerformed, true);
            return true;
        });
        assert.deepEqual(f.events, [['readback', f.id], ['revoke'], ['remove', f.id, 'instance']]);
    }
});

test('D.service-reuse-cleanup-failure-is-loud', () => {
    const f = fixture('none', { problem: new Error('readback failed'), cleanupProblem: new Error('ownership changed') });
    assert.throws(f.run, (error) => {
        assert.equal(error.ploinkyRestartCandidate.exactCleanupPerformed, false);
        assert.ok(exactCleanupFailureOf(error));
        assert.match(error.message, /ownership changed/);
        return true;
    });
    const failedRevoke = fixture('host', { problem: new Error('readback failed'), inactivationProblem: new Error('cannot revoke') });
    assert.throws(failedRevoke.run, /cannot revoke/);
    assert.deepEqual(failedRevoke.events.map(([event]) => event), ['readback', 'revoke']);
});
