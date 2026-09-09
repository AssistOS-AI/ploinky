import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { reinstallAgent } from '../../cli/commands/workspaceUtil.js';

// Execute the command body with runtime boundaries replaced, so recovery can
// be tested without installing agents or mutating a real workspace.
function fixture({ runtime = 'docker', running = false, active = true, failure, enabled = true, changedRegistration = false } = {}) {
    let resolutions = 0;
    const calls = [];
    const errors = [];
    const record = {
        containerName: 'workspace-example',
        record: { repoName: 'repo', agentName: 'example', alias: 'chosen-name', profile: 'local',
            instanceId: 'old-instance', enableGeneration: 'old-generation' },
    };
    const manifest = { runtime };
    const result = { containerName: 'replacement-example', hostPort: 0 };
    const endpoint = { mode: 'bridge' };
    const capability = {};
    const context = {
        path,
        console: { log() {}, error(message) { errors.push(message); } },
        resolvePersistedRouterPort: () => 8080,
        agentsSvc: { resolveEnabledAgentRecord: () => {
            resolutions += 1;
            if (!enabled) return null;
            return changedRegistration && resolutions > 1
                ? { ...record, record: { ...record.record, enableGeneration: 'concurrent-generation' } }
                : record;
        } },
        utils: { findAgent(name) {
            assert.equal(enabled, true, 'unregistered targets must not reach runtime lookup');
            assert.equal(name, 'repo/example');
            return { repo: 'repo', shortAgentName: 'example', manifestPath: '/repos/repo/example/manifest.json' };
        } },
        fs: { readFileSync: () => JSON.stringify(manifest) },
        resolveManifestRouterEndpoint: () => endpoint,
        admitDirectAgentRuntimeManifest: () => ({ runtimeAdmission: 'admitted' }),
        getRuntimeForAgent: () => runtime,
        isSandboxRuntime: value => ['bwrap', 'seatbelt'].includes(value),
        isBwrapProcessRunning: () => running,
        dockerSvc: {
            getAgentContainerName: () => assert.fail('must preserve registered target'),
            isContainerRunning: () => running,
            removeAgentContainerForRecreate(name) { calls.push(['remove', name]); },
            async ensureAgentService(name, suppliedManifest, agentPath, options) {
                calls.push(['prepare', name]);
                assert.equal(options.containerName, record.containerName);
                assert.equal(options.alias, 'chosen-name');
                assert.equal(options.forceRecreate, true);
                assert.equal(options.routerEndpoint, endpoint);
                assert.equal(options.runtimeAdmission, 'admitted');
                assert.equal(options.networkLifecycleCapability, capability);
                assert.equal(options.stageAlongsidePredecessor, active);
                if (failure === 'install') throw new Error('install failed');
                return result;
            },
        },
        withWorkspaceMutationLease: async (options, callback) => {
            assert.equal(options.operation, 'reinstall');
            return callback('workspace-lease');
        },
        retireAbandonedAgentPreparation(name, options) {
            assert.equal(name, record.containerName);
            assert.equal(options.workspaceMutationLease, 'workspace-lease');
            assert.equal(options.networkLifecycleCapability, capability);
        },
        withMaintenanceLock: async (name, options, callback) => {
            assert.equal(name, record.containerName);
            assert.equal(options.operation, 'reinstall');
            return callback();
        },
        withNetworkLifecycleLock: async callback => callback(capability),
        readEdgeRoutingSelection: () => ({ selector: { state: active ? 'active' : 'inactive' } }),
        buildRelayReadinessRoute: ({ route }) => route,
        waitForManifestReadiness: async ({ route }) => {
            calls.push(['readiness', route.container]);
            if (failure === 'readiness') throw new Error('readiness failed');
        },
        activatePreparedRuntimeAfterReadiness: async options => {
            assert.equal(options.result, result);
            assert.equal(options.routeKey, 'chosen-name');
            calls.push(['activate', options.result.containerName]);
        },
        cleanupFailedPreparedRuntime: (value, error) => calls.push(['cleanup', value, error.message]),
        execSync: () => Buffer.from('123'),
    };
    return { run: vm.runInNewContext(`(${reinstallAgent.toString()})`, context), calls, errors, result };
}

for (const runtime of ['docker', 'bwrap', 'seatbelt']) {
    for (const active of [false, true]) {
        test(`reinstall recovers an enabled ${runtime} agent with no running runtime; routing active=${active}`, async () => {
            const { run, calls, errors } = fixture({ runtime, active });
            await run('chosen-name');
            assert.deepEqual(calls.filter(([step]) => step !== 'remove'), [
                ['prepare', 'example'], ['readiness', 'replacement-example'], ['activate', 'replacement-example'],
            ]);
            assert.deepEqual(calls.filter(([step]) => step === 'remove'),
                runtime === 'docker' && !active ? [['remove', 'workspace-example']] : []);
            assert.deepEqual(errors, []);
        });
    }
}

test('reinstall still recreates an already running agent', async () => {
    const { run, calls } = fixture({ running: true });
    await run('chosen-name');
    assert.deepEqual(calls.map(([step]) => step), ['prepare', 'readiness', 'activate']);
});

for (const failure of ['install', 'readiness']) {
    test(`failed recovery propagates ${failure} failure and never activates`, async () => {
        const { run, calls, result } = fixture({ failure });
        await assert.rejects(run('chosen-name'), { message: `${failure} failed` });
        assert.equal(calls.some(([step]) => step === 'activate'), false);
        assert.deepEqual(calls.at(-1), ['cleanup', failure === 'install' ? null : result, `${failure} failed`]);
    });
}

test('reinstall rejects an empty target before attempting recovery', async () => {
    const { run, calls } = fixture();
    await assert.rejects(run(''), /Usage: reinstall/);
    assert.deepEqual(calls, []);
});

test('reinstall rejects an unregistered target instead of creating a new installation', async () => {
    const { run, calls } = fixture({ enabled: false });
    await assert.rejects(run('chosen-name'), /is not enabled/);
    assert.deepEqual(calls, []);
});


test('reinstall revalidates the enabled identity after waiting for the workspace lease', async () => {
    const { run, calls } = fixture({ changedRegistration: true });
    await assert.rejects(run('chosen-name'), /changed while waiting for reinstall/);
    assert.deepEqual(calls.map(([step]) => step), ['cleanup']);
});
