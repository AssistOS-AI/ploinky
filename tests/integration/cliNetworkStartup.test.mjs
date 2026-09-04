import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-cli-network-startup-'));
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
after(() => fs.rmSync(workspace, { recursive: true, force: true }));
const { runCliWithDependencies } = await import('../../cli/commands/workspaceUtil.js');
const {
    NETWORK_LOCK_WAIT_MS,
    acquireNetworkLifecycleLock,
    assertNetworkLifecycleCapability,
    withNetworkLifecycleLockAsync,
} = await import('../../cli/sandbox/networkLifecycle.js');
const { ensureAgentService } = await import('../../cli/sandbox/docker/agentServiceManager.js');
const lockPath = path.join(workspace, '.ploinky', 'run', 'network.lock');

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function cliHarness() {
    const records = Object.fromEntries(['alpha', 'beta'].map((name) => [`${name}-container`, {
        type: 'agent', repoName: 'fixtures', agentName: name, runtime: 'podman',
        instanceId: `${name}-instance`, enableGeneration: `${name}-generation`,
    }]));
    const events = [];
    const dependencies = {
        env: { PLOINKY_NO_TTY: '1' },
        resolveEnabledAgentRecord: (name) => ({ containerName: `${name}-container`, record: records[`${name}-container`] }),
        findAgent: (ref) => {
            const shortAgentName = ref.split('/').pop();
            return { shortAgentName, manifestPath: path.join(workspace, 'fixtures', shortAgentName, 'manifest.json') };
        },
        enableAgent: () => assert.fail('already enabled'),
        readManifest: () => ({ cli: 'node cli.mjs', readiness: { protocol: 'mcp' } }),
        resolveRouterEndpointForManifest: () => ({ mode: 'default', host: 'router', port: 8080, url: 'http://router:8080', env: {} }),
        admitRuntimeManifest: () => ({ runtimeAdmission: Object.freeze({ fixture: true }) }),
        withMaintenanceLock: async (name, _options, callback) => {
            events.push(['maintenance', name]);
            return await callback();
        },
        loadAgentsMap: () => structuredClone(records),
        ensureAgentService: (name, _manifest, _agentDir, options) => {
            assertNetworkLifecycleCapability(options.networkLifecycleCapability, { lockPath });
            events.push(['ensure', name, options.containerName]);
            return { containerName: options.containerName, hostPort: 43121, requiresEdgeActivation: false };
        },
        waitForAgentReady: async () => true,
        activateRuntimeAfterReadiness: async ({ shortAgentName, networkLifecycleCapability }) => {
            assertNetworkLifecycleCapability(networkLifecycleCapability, { lockPath });
            events.push(['activate', shortAgentName]);
        },
        attachInteractive: (name, _workdir, _command, options) => {
            options.onReady();
            events.push(['attach', name]);
            return 0;
        },
        notifyCliReady: () => { events.push(['ready']); },
        projectPath: workspace,
    };
    return { records, events, dependencies };
}

test('different-agent CLI starts serialize on the real network lock through readiness and activation', { timeout: 3000 }, async () => {
    const { events, dependencies } = cliHarness();
    const entered = deferred();
    const release = deferred();
    let readinessCalls = 0;
    dependencies.waitForAgentReady = async () => {
        if (++readinessCalls === 1) {
            entered.resolve();
            await release.promise;
        }
        return true;
    };
    const alpha = runCliWithDependencies('alpha', [], dependencies);
    await entered.promise;
    const beta = runCliWithDependencies('beta', [], dependencies);
    const results = Promise.allSettled([alpha, beta]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(events.filter(([event]) => event === 'maintenance').length, 2);
    assert.deepEqual(events.filter(([event]) => event === 'ensure'), [['ensure', 'alpha', 'alpha-container']]);
    release.resolve();
    assert.deepEqual(await results, [
        { status: 'fulfilled', value: 0 },
        { status: 'fulfilled', value: 0 },
    ]);
    assert.ok(events.findIndex(([event, name]) => event === 'activate' && name === 'alpha')
        < events.findIndex(([event, name]) => event === 'ensure' && name === 'beta'));
    assert.equal(fs.existsSync(lockPath), false);
});

test('CLI startup times out without mutation, ready signal, attach, or stealing a live owner', async () => {
    const { events, dependencies } = cliHarness();
    const owner = acquireNetworkLifecycleLock();
    try {
        dependencies.withNetworkLifecycleLock = (callback, options) => {
            assert.equal(options.waitMs, NETWORK_LOCK_WAIT_MS);
            assert.equal(options.waitMs, 60_000);
            return withNetworkLifecycleLockAsync(callback, { ...options, waitMs: 30, pollMs: 10 });
        };
        await assert.rejects(runCliWithDependencies('beta', [], dependencies), {
            code: 'PLOINKY_NETWORK_LIFECYCLE_BUSY',
            message: /timed out waiting 30ms/,
        });
        assert.deepEqual(events, [['maintenance', 'beta-container']]);
        assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, owner.token);
        assertNetworkLifecycleCapability(owner.capability);
    } finally {
        owner.release();
    }
});

test('CLI startup refreshes a peer-rotated exact runtime after acquiring the network lock', async () => {
    const { records, events, dependencies } = cliHarness();
    const owner = acquireNetworkLifecycleLock();
    const pending = runCliWithDependencies('beta', [], dependencies);
    records['beta-candidate'] = { ...records['beta-container'], instanceId: 'new-instance', enableGeneration: 'new-generation' };
    delete records['beta-container'];
    owner.release();
    assert.equal(await pending, 0);
    assert.deepEqual(events.filter(([event]) => event === 'ensure'), [['ensure', 'beta', 'beta-candidate']]);
    assert.deepEqual(events.slice(-3), [['activate', 'beta'], ['ready'], ['attach', 'beta-candidate']]);
});

test('CLI startup fails closed when the target disappears, becomes ambiguous, or changes identity during lock wait', async () => {
    for (const change of ['removed', 'ambiguous', 'foreign']) {
        const { records, events, dependencies } = cliHarness();
        const owner = acquireNetworkLifecycleLock();
        const pending = runCliWithDependencies('beta', [], dependencies);
        const outcome = assert.rejects(pending, /exact refreshed runtime identity|changed runtime identity/);
        if (change === 'foreign') {
            records['beta-container'].repoName = 'unrelated';
        } else {
            if (change === 'ambiguous') {
                records['beta-one'] = { ...records['beta-container'] };
                records['beta-two'] = { ...records['beta-container'] };
            }
            delete records['beta-container'];
        }
        owner.release();
        await outcome;
        assert.deepEqual(events, [['maintenance', 'beta-container']], change);
        assert.equal(fs.existsSync(lockPath), false);
    }
});

test('manifest changed during lock wait is rejected by real service admission before runtime mutation', async () => {
    const { events, dependencies } = cliHarness();
    const manifestPath = dependencies.findAgent('fixtures/beta').manifestPath;
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(dependencies.readManifest()));
    dependencies.ensureAgentService = ensureAgentService;
    const owner = acquireNetworkLifecycleLock();
    const pending = runCliWithDependencies('beta', [], dependencies);
    const outcome = assert.rejects(pending, { code: 'PLOINKY_RUNTIME_INPUT_CHANGED' });
    fs.writeFileSync(manifestPath, JSON.stringify({ cli: 'changed-command' }));
    owner.release();
    await outcome;
    assert.deepEqual(events, [['maintenance', 'beta-container']]);
    assert.equal(fs.existsSync(lockPath), false);
});

test('readiness and activation failures cannot signal CLI ready or attach', async () => {
    for (const failingStage of ['waitForAgentReady', 'activateRuntimeAfterReadiness']) {
        const { events, dependencies } = cliHarness();
        dependencies[failingStage] = async () => { throw new Error('startup failed'); };
        await assert.rejects(runCliWithDependencies('beta', [], dependencies), /startup failed/);
        assert.equal(events.some(([event]) => ['ready', 'attach'].includes(event)), false);
        assert.equal(fs.existsSync(lockPath), false);
    }
});

test('real sandbox attach preflight failure cannot announce readiness', async () => {
    const { records, events, dependencies } = cliHarness();
    records['beta-container'].runtime = 'bwrap';
    await assert.rejects(runCliWithDependencies('beta', [], dependencies), /not running as bwrap agent/);
    assert.equal(events.some(([event]) => ['ready', 'attach'].includes(event)), false);
    assert.equal(fs.existsSync(lockPath), false);
});

test('CLI reports readiness on private fd3 only and never forwards its control environment to the runtime', { timeout: 5000 }, async () => {
    const moduleUrl = new URL('../../cli/commands/workspaceUtil.js', import.meta.url).href;
    for (const [fd, ready, attachFails = false] of [['3', true], ['4', true], ['3', false], ['3', true, true]]) {
        const child = spawn(process.execPath, ['--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            import { runCliWithDependencies } from ${JSON.stringify(moduleUrl)};
            const record = { type: 'agent', repoName: 'fixtures', agentName: 'beta', runtime: 'podman' };
            try {
                await runCliWithDependencies('beta', [], {
                    env: process.env,
                    resolveEnabledAgentRecord: () => ({ containerName: 'beta-container', record }),
                    findAgent: () => ({ shortAgentName: 'beta', manifestPath: '/fixtures/beta/manifest.json' }),
                    readManifest: () => ({ cli: 'agent-cli', readiness: { protocol: 'mcp' } }),
                    resolveRouterEndpointForManifest: () => ({ mode: 'default', host: 'router', port: 8080 }),
                    admitRuntimeManifest: () => ({ runtimeAdmission: {} }),
                    loadAgentsMap: () => ({ 'beta-container': record }),
                    withMaintenanceLock: async (_name, _options, callback) => await callback(),
                    ensureAgentService: () => {
                        assert.equal(process.env.PLOINKY_WEBCHAT_STARTUP_FD, undefined);
                        return { containerName: 'beta-container', hostPort: 43121 };
                    },
                    waitForAgentReady: async () => ${ready},
                    activateRuntimeAfterReadiness: async () => {},
                    attachInteractive: (_name, _workdir, _command, options) => {
                        assert.equal(process.env.PLOINKY_WEBCHAT_STARTUP_FD, undefined);
                        if (${attachFails}) throw new Error('attach preflight failed');
                        options.onReady();
                        process.stdout.write('agent output');
                        return 0;
                    },
                    projectPath: process.env.PLOINKY_WORKSPACE_ROOT,
                });
            } catch (error) {
                process.stderr.write(error.message);
                process.exitCode = 1;
            }
        `], {
            env: { ...process.env, PLOINKY_NO_TTY: '1', PLOINKY_WEBCHAT_STARTUP_FD: fd },
            stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let control = '';
        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });
        child.stdio[3].on('data', (data) => { control += data; });
        const success = ready && !attachFails;
        assert.deepEqual(await once(child, 'close'), [success ? 0 : 1, null]);
        assert.equal(control, success && fd === '3' ? '{"version":1,"state":"ready"}\n' : '');
        assert.equal(stdout, success ? 'agent output' : '');
        if (success) assert.equal(stderr, '');
        else if (attachFails) assert.match(stderr, /attach preflight failed/);
        else assert.match(stderr, /did not become ready before CLI attach/);
    }
});
