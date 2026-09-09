import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-reinstall-exact-recovery-'));
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
test.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

const { reinstallAgent } = await import('../../cli/commands/workspaceUtil.js');
const manager = await import('../../cli/sandbox/docker/agentServiceManager.js');
const { removeExactRegisteredContainer } = await import('../../cli/sandbox/docker/containerFleet.js');
const { loadAgentsMap } = await import('../../cli/sandbox/docker/common.js');
const { readRuntimeCandidate, retireRuntimeCandidate } = await import('../../cli/sandbox/runtimeCandidateStore.js');
const { NETWORK_LABELS, workspaceNetworkIdentity } = await import('../../cli/sandbox/networkIdentity.js');
const { NETWORK_SCHEMA_VERSION } = await import('../../cli/sandbox/networkContract.js');

const NAME = 'ploinky_Example_failed_workspace';
const ID = 'a'.repeat(64);
const NEW_ID = 'c'.repeat(64);
const manifestPath = path.join(workspace, '.ploinky/repos/Example/failed/manifest.json');
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, JSON.stringify({ runtime: 'podman' }));
const managerSource = fs.readFileSync(new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url), 'utf8');
const removalStart = managerSource.indexOf('function removeContainerForRecreate(');
const removalEnd = managerSource.indexOf('\nfunction normalizeTargetedRestart(', removalStart);
assert.ok(removalStart >= 0 && removalEnd > removalStart);

// Keep the command, manager wrapper, registry reads, receipt reads and fleet
// removal real. Replace only the engine calls along the removal path. The
// subsequent installer/readiness boundaries record whether recovery unblocked
// the retry without launching containers or a real server.
function fixture({ strictLegacyRemoval = false, foreign = false, removeFails = false, absent = false } = {}) {
    const record = { type: 'agent', agentName: 'failed', repoName: 'Example', runtime: 'podman',
        instanceId: 'old-instance', enableGeneration: 'old-generation', alias: 'chosen-name',
        config: { binds: [] } };
    fs.writeFileSync(path.join(workspace, '.ploinky/agents.json'), JSON.stringify({ [NAME]: record }));
    const calls = [];
    const errors = [];
    let mutationHeld = false;
    let maintenanceHeld = false;
    let networkHeld = false;
    const workspaceMutationLease = {};
    const networkLifecycleCapability = {};
    let current = absent ? null : {
        Id: ID, Name: `/${NAME}`,
        Config: {
            Labels: {
                [NETWORK_LABELS.managed]: '1', [NETWORK_LABELS.resource]: 'agent',
                [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
                [NETWORK_LABELS.workspace]: foreign ? 'foreign-workspace' : workspaceNetworkIdentity().hash,
                [NETWORK_LABELS.contract]: 'b'.repeat(64),
                [NETWORK_LABELS.instanceId]: record.instanceId,
                [NETWORK_LABELS.enableGeneration]: record.enableGeneration,
            },
            Env: [
                'PLOINKY_AGENT_PRINCIPAL=agent:Example/failed',
                `PLOINKY_AGENT_INSTANCE_ID=${record.instanceId}`,
                `PLOINKY_AGENT_ENABLE_GENERATION=${record.enableGeneration}`,
            ],
        },
        HostConfig: { Init: true }, Mounts: [], State: { Running: false, ExitCode: 1 },
    };
    const removalContext = {
        loadAgentsMap, readRuntimeCandidate, retireRuntimeCandidate,
        getRuntime: () => 'podman',
        clearLivenessState: (name) => calls.push(['clear-liveness', name]),
        removeExactRegisteredContainer(name, input, options) {
            return removeExactRegisteredContainer(name, input, {
                ...options,
                ...(strictLegacyRemoval ? { recoverIncompleteIdentity: false } : {}),
                withLock(callback) {
                    assert.equal(mutationHeld && maintenanceHeld && networkHeld, true);
                    return callback();
                },
                inspect(runtime, identifier) {
                    assert.equal(runtime, 'podman');
                    return identifier === NAME || identifier === current?.Id ? current : null;
                },
                control(runtime, args) {
                    assert.equal(runtime, 'podman');
                    assert.deepEqual(args, ['rm', '-f', ID]);
                    calls.push(['remove-exact', args.at(-1)]);
                    if (removeFails) return { status: 1 };
                    current = null;
                    return { status: 0 };
                },
            });
        },
    };
    removalContext.removeContainerForRecreate = vm.runInNewContext(
        `(${managerSource.slice(removalStart, removalEnd)})`, removalContext,
    );
    const removeAgentContainerForRecreate = vm.runInNewContext(
        `(${manager.removeAgentContainerForRecreate.toString()})`, removalContext,
    );
    const result = { containerName: NAME, containerId: NEW_ID, hostPort: 0 };
    const endpoint = { mode: 'bridge' };
    const context = {
        path, fs,
        console: { log() {}, error(message) { errors.push(message); } },
        resolvePersistedRouterPort: () => 8080,
        agentsSvc: { resolveEnabledAgentRecord: () => ({ containerName: NAME, record: loadAgentsMap()[NAME] }) },
        utils: { findAgent: () => ({ repo: 'Example', shortAgentName: 'failed', manifestPath }) },
        resolveManifestRouterEndpoint: () => endpoint,
        admitDirectAgentRuntimeManifest: () => ({ runtimeAdmission: 'admitted' }),
        getRuntimeForAgent: () => 'podman',
        isSandboxRuntime: () => false,
        withWorkspaceMutationLease: async (options, callback) => {
            assert.equal(options.operation, 'reinstall');
            mutationHeld = true;
            try { return await callback(workspaceMutationLease); } finally { mutationHeld = false; }
        },
        withMaintenanceLock: async (name, options, callback) => {
            assert.equal(name, NAME);
            assert.equal(options.operation, 'reinstall');
            assert.equal(mutationHeld, true);
            maintenanceHeld = true;
            try { return await callback(); } finally { maintenanceHeld = false; }
        },
        withNetworkLifecycleLock: async (callback) => {
            assert.equal(mutationHeld && maintenanceHeld, true);
            networkHeld = true;
            try { return await callback(networkLifecycleCapability); } finally { networkHeld = false; }
        },
        readEdgeRoutingSelection: () => ({ selector: { state: 'inactive' } }),
        retireAbandonedAgentPreparation(name, options) {
            assert.equal(name, NAME);
            assert.equal(options.workspaceMutationLease, workspaceMutationLease);
            assert.equal(options.networkLifecycleCapability, networkLifecycleCapability);
            calls.push(['retire-preparation', name]);
        },
        dockerSvc: {
            removeAgentContainerForRecreate,
            async ensureAgentService(name, manifest, agentPath, options) {
                assert.equal(current, null, 'failed container must be gone before retrying installation');
                assert.equal(name, 'failed');
                assert.equal(options.containerName, NAME);
                assert.equal(options.forceRecreate, true);
                assert.equal(options.stageAlongsidePredecessor, false);
                assert.equal(options.networkLifecycleCapability, networkLifecycleCapability);
                calls.push(['retry-install', name]);
                current = { Id: NEW_ID, State: { Running: true } };
                return result;
            },
        },
        buildRelayReadinessRoute: ({ route }) => route,
        waitForManifestReadiness: async ({ route }) => {
            assert.equal(current?.Id, NEW_ID);
            assert.equal(route.container, NAME);
            calls.push(['readiness', NAME]);
        },
        activatePreparedRuntimeAfterReadiness: async (options) => {
            assert.equal(options.result, result);
            calls.push(['activate', NAME]);
        },
        cleanupFailedPreparedRuntime: (value, error) => calls.push(['cleanup-failure', error.message]),
        execSync: () => Buffer.from('123'),
    };
    return { run: vm.runInNewContext(`(${reinstallAgent.toString()})`, context), calls, errors,
        get current() { return current; } };
}

test('actual reinstall removal recovers the failed exited runtime ID and reaches retry, readiness and activation', async () => {
    const state = fixture();
    await state.run('chosen-name');
    assert.deepEqual(state.calls.map(([step]) => step), [
        'retire-preparation', 'remove-exact', 'clear-liveness', 'retry-install', 'readiness', 'activate',
    ]);
    assert.equal(state.current.Id, NEW_ID);
    assert.deepEqual(state.errors, []);
});

test('the same command fixture reproduces the reported failure with the old strict removal policy', async () => {
    const state = fixture({ strictLegacyRemoval: true });
    await assert.rejects(state.run('chosen-name'), /inactiveManifestReplacement.*immutable registry container ID/);
    assert.equal(state.current.Id, ID);
    assert.equal(state.calls.some(([step]) => step === 'retry-install' || step === 'activate'), false);
});

test('reinstall reports conflicting ownership and preserves the foreign runtime without retrying installation', async () => {
    const state = fixture({ foreign: true });
    await assert.rejects(state.run('chosen-name'), /inactiveManifestReplacement.*exact managed ownership labels/);
    assert.equal(state.current.Id, ID);
    assert.equal(state.calls.some(([step]) => step === 'remove-exact' || step === 'retry-install'), false);
});

test('reinstall reports an exact removal failure and never starts a replacement over the surviving runtime', async () => {
    const state = fixture({ removeFails: true });
    await assert.rejects(state.run('chosen-name'), /inactiveManifestReplacement.*exact container removal/);
    assert.equal(state.current.Id, ID);
    assert.equal(state.calls.some(([step]) => step === 'retry-install' || step === 'activate'), false);
});

test('reinstall can retry an already-absent failed runtime without attempting a removal', async () => {
    const state = fixture({ absent: true });
    await state.run('chosen-name');
    assert.equal(state.calls.some(([step]) => step === 'remove-exact'), false);
    assert.equal(state.calls.some(([step]) => step === 'activate'), true);
});
