import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(path.resolve('cli/sandbox/providerTaskOwnership.js')).href;

test('provider ownership never interprets inner process attestations through host process APIs', () => {
    const source = fs.readFileSync(new URL('../../cli/sandbox/providerTaskOwnership.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /process\.kill\s*\(/);
    assert.doesNotMatch(source, /inspectProcessIdentity/);
    assert.match(source, /processAuthority:\s*'inner-runtime-attestation'/);
});

test('selected runtime requires its exact recorded HOME identity for every provider backend', async () => {
    const ownership = await import(`${moduleUrl}?selection=${Date.now()}`);
    const callerIdentity = {
        agentId: 'agent:demo/alpha',
        instanceId: 'instance-home',
        enableGeneration: 'generation-home',
    };
    const selected = (runtime, homeKey) => ownership.resolveSelectedProviderRuntime({
        agents: {
            'runtime-home': {
                type: 'agent',
                runtime,
                repoName: 'demo',
                agentName: 'alpha',
                alias: 'alpha',
                instanceId: callerIdentity.instanceId,
                enableGeneration: callerIdentity.enableGeneration,
                ...(homeKey === undefined ? {} : { homeKey }),
            },
        },
    }, callerIdentity);
    assert.equal(selected('podman', undefined).homeKey, 'runtime-home');
    assert.equal(selected('podman', 'foreign-home').homeKey, 'runtime-home');
    assert.equal(selected('bwrap', 'runtime-home.sandbox-v2').homeKey, 'runtime-home.sandbox-v2');
    for (const [runtime, homeKey] of [
        ['bwrap', undefined],
        ['bwrap', 'runtime-home'],
    ]) {
        assert.throws(
            () => selected(runtime, homeKey),
            { code: 'PLOINKY_PROVIDER_TASK_RUNTIME_MISMATCH' },
        );
    }
});

test('provider task ownership is durable, exact, log-safe, and never signals inner runtime pids', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-provider-owner-'));
    const script = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import { spawn } from 'node:child_process';
        process.chdir(${JSON.stringify(workspace)});
        const ownership = await import(${JSON.stringify(moduleUrl)} + '?fixture=' + Date.now());
        const child = spawn(process.execPath, ['--input-type=module', '--eval', 'setInterval(() => {}, 1000)'], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
        const audience = 'https://api.openai.com/v1';
        const brokerOwner = ownership.brokerOwnerFor(
            'agent:fixtures/alpha', 'instance-a', 'generation-a', 'task-1', 'codex', audience,
        );
        const common = {
            schemaVersion: 1,
            taskId: 'task-1',
            audience,
            provider: 'codex',
            mode: 'task',
            runtimeKind: 'bwrap',
            runtimeKey: 'runtime-a',
            homeKey: 'runtime-a.sandbox-v2',
            workdir: '/workspace/project',
            pid: child.pid,
            processGroupId: child.pid,
            processIdentity: 'linux-proc:123e4567-e89b-12d3-a456-426614174000:42',
            processUid: 1000,
            brokerOwner,
            readiness: 'ready',
            state: 'running',
        };
        const context = {
            callerIdentity: {
                agentId: 'agent:fixtures/alpha',
                instanceId: 'instance-a',
                enableGeneration: 'generation-a',
                routeKey: 'alpha',
                containerName: 'runtime-a',
            },
            selectedRuntime: {
                agentId: 'agent:fixtures/alpha',
                instanceId: 'instance-a',
                enableGeneration: 'generation-a',
                runtime: 'bwrap',
                runtimeKey: 'runtime-a',
                homeKey: 'runtime-a.sandbox-v2',
                alias: 'alpha',
            },
        };
        try {
            const published = ownership.publishProviderTask({ ...context, body: common });
            assert.equal(published.ok, true);
            const stored = ownership.readProviderTaskOwner(common.runtimeKey, common.taskId);
            assert.equal(stored.role, 'provider-task');
            assert.equal(stored.pid, child.pid);
            assert.equal(fs.statSync(published.owner.logPath).mode & 0o777, 0o600);
            assert.equal(fs.statSync(path.join(${JSON.stringify(workspace)}, '.ploinky', 'run', 'provider-task-owners')).mode & 0o777, 0o700);
            assert.deepEqual(ownership.publishProviderTask({ ...context, body: common }), published);
            assert.throws(
                () => ownership.publishProviderTask({ ...context, body: { ...common, processUid: 1001 } }),
                { code: 'PLOINKY_PROVIDER_TASK_CONFLICT' },
            );
            assert.throws(
                () => ownership.publishProviderTask({ ...context, body: { ...common, extra: true } }),
                { code: 'PLOINKY_PROVIDER_TASK_INVALID' },
            );
            ownership.appendProviderTaskLog({
                ...context,
                body: {
                    schemaVersion: 1,
                    taskId: common.taskId,
                    provider: common.provider,
                    runtimeKey: common.runtimeKey,
                    processIdentity: common.processIdentity,
                    stream: 'stderr',
                    sequence: 1,
                    chunk: 'token=secret-value\\n',
                },
            });
            assert.doesNotMatch(fs.readFileSync(published.owner.logPath, 'utf8'), /secret-value/);
            assert.equal(
                ownership.classifyProviderTaskOwnersReadOnly({ nowMs: Date.now() + 120000 })[0].classification,
                'stale',
            );
            const registry = {
                [common.runtimeKey]: {
                    type: 'agent',
                    runtime: 'bwrap',
                    instanceId: 'instance-a',
                    enableGeneration: 'generation-a',
                    homeKey: common.homeKey,
                },
            };
            const serviceStates = [{
                runtimeKey: common.runtimeKey,
                instanceId: 'instance-a',
                enableGeneration: 'generation-a',
                state: { running: true },
            }];
            const reconcile = (overrides = {}) => ownership.reconcileProviderTaskOwnershipReadOnly({
                registry,
                serviceStates,
                ...overrides,
            })[0].classification;
            assert.equal(reconcile(), 'live');
            assert.equal(reconcile({ registry: {
                [common.runtimeKey]: { ...registry[common.runtimeKey], enableGeneration: 'replacement' },
            } }), 'mixed-generation');
            assert.equal(reconcile({ runtimeReports: [{
                runtimeKey: common.runtimeKey,
                taskId: common.taskId,
                instanceId: 'instance-a',
                enableGeneration: 'generation-a',
                processIdentity: common.processIdentity,
                state: 'pid-reused',
            }] }), 'pid-reused');
            assert.equal(reconcile({ runtimeReports: [{
                runtimeKey: common.runtimeKey,
                taskId: common.taskId,
                instanceId: 'instance-a',
                enableGeneration: 'generation-a',
                processIdentity: common.processIdentity,
                state: 'terminal',
            }] }), 'terminal');
            assert.equal(reconcile({ nowMs: Date.now() + 120000 }), 'stale');
            assert.equal(reconcile({ serviceStates: [{
                ...serviceStates[0], state: { running: false },
            }] }), 'parent-contained');
            ownership.reportProviderTask({
                ...context,
                body: { ...common, reportState: 'pid-reused' },
            });
            assert.equal(reconcile(), 'pid-reused');
            assert.equal(
                ownership.classifyProviderTaskOwnersReadOnly()[0].classification,
                'pid-reused',
            );
            assert.throws(
                () => ownership.heartbeatProviderTask({ ...context, body: common }),
                { code: 'PLOINKY_PROVIDER_TASK_PID_REUSED' },
            );
            for (const taskId of ['../escape', 'bad/task', 'bad:task']) {
                assert.throws(
                    () => ownership.publishProviderTask({ ...context, body: { ...common, taskId } }),
                    { code: 'PLOINKY_PROVIDER_TASK_INVALID' },
                );
            }
            const target = path.join(${JSON.stringify(workspace)}, 'foreign.log');
            fs.writeFileSync(target, 'foreign');
            fs.unlinkSync(published.owner.logPath);
            fs.symlinkSync(target, published.owner.logPath);
            assert.throws(() => ownership.appendProviderTaskLog({
                ...context,
                body: {
                    schemaVersion: 1,
                    taskId: common.taskId,
                    provider: common.provider,
                    runtimeKey: common.runtimeKey,
                    processIdentity: common.processIdentity,
                    stream: 'stdout',
                    sequence: 2,
                    chunk: 'safe',
                },
            }), { code: 'PLOINKY_PROVIDER_TASK_STORE_INVALID' });
            assert.equal(fs.readFileSync(target, 'utf8'), 'foreign');
            fs.unlinkSync(published.owner.logPath);
            fs.writeFileSync(published.owner.logPath, '', { mode: 0o600 });
            assert.throws(() => ownership.removeProviderTaskOwnersAfterContainment(
                ownership.listProviderTaskOwners(),
                { contained: false },
            ), { code: 'PLOINKY_PROVIDER_TASK_CONTAINMENT_REQUIRED' });
            ownership.removeProviderTaskOwnersAfterContainment(
                ownership.listProviderTaskOwners(),
                { contained: true, runtimeKey: common.runtimeKey, instanceId: 'instance-a', enableGeneration: 'generation-a', releaseGeneration: '' },
            );
            assert.equal(ownership.listProviderTaskOwners().length, 0);
            assert.doesNotThrow(() => process.kill(child.pid, 0));
            const partial = path.join(${JSON.stringify(workspace)}, '.ploinky', 'run', 'provider-task-owners', '.interrupted.tmp');
            fs.writeFileSync(partial, 'partial', { mode: 0o600 });
            assert.throws(
                () => ownership.collectProviderTaskOwnersReadOnly(),
                { code: 'PLOINKY_PROVIDER_TASK_ATOMIC_PARTIAL' },
            );
            fs.unlinkSync(partial);
            const store = path.dirname(partial);
            const foreignStore = path.join(${JSON.stringify(workspace)}, 'foreign-store');
            fs.mkdirSync(foreignStore, { mode: 0o700 });
            fs.rmdirSync(store);
            fs.symlinkSync(foreignStore, store);
            assert.throws(
                () => ownership.collectProviderTaskOwnersReadOnly(),
                { code: 'PLOINKY_PROVIDER_TASK_STORE_INVALID' },
            );
        } finally {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
            try { process.kill(child.pid, 'SIGKILL'); } catch (_) {}
        }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: workspace,
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: workspace,
            PLOINKY_CWD: workspace,
        },
        encoding: 'utf8',
    });
    try {
        assert.equal(result.status, 0, result.stderr);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('terminal removal retries an exact interrupted owner unlink without losing proof', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-provider-terminal-retry-'));
    const script = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        process.chdir(${JSON.stringify(workspace)});
        const ownership = await import(${JSON.stringify(moduleUrl)} + '?terminal-retry=' + Date.now());
        const audience = 'https://api.openai.com/v1';
        const common = {
            schemaVersion: 1, taskId: 'task-retry', audience, provider: 'codex', mode: 'task',
            runtimeKind: 'bwrap', runtimeKey: 'runtime-retry', homeKey: 'runtime-retry.sandbox-v2',
            workdir: '/workspace/project', pid: 4242, processGroupId: 4242,
            processIdentity: 'linux-proc:123e4567-e89b-12d3-a456-426614174000:42', processUid: 1000,
            brokerOwner: ownership.brokerOwnerFor('agent:fixtures/alpha', 'instance-r', 'generation-r', 'task-retry', 'codex', audience),
            readiness: 'ready', state: 'running',
        };
        const context = {
            callerIdentity: { agentId: 'agent:fixtures/alpha', instanceId: 'instance-r', enableGeneration: 'generation-r', routeKey: 'alpha' },
            selectedRuntime: { agentId: 'agent:fixtures/alpha', instanceId: 'instance-r', enableGeneration: 'generation-r', runtime: 'bwrap', runtimeKey: 'runtime-retry', homeKey: 'runtime-retry.sandbox-v2', alias: 'alpha' },
        };
        const terminal = { ...common, terminalState: 'completed', terminalProof: {
            processTerminal: true, descendantsTerminal: true, brokerClosed: true, leaseReleased: true,
        } };
        ownership.publishProviderTask({ ...context, body: common });
        const originalUnlink = fs.unlinkSync;
        let injected = false;
        fs.unlinkSync = function (target) {
            if (!injected && String(target).endsWith('.owner.json')) {
                injected = true;
                const error = new Error('injected owner unlink failure');
                error.code = 'EIO';
                throw error;
            }
            return originalUnlink.apply(this, arguments);
        };
        assert.throws(() => ownership.terminalProviderTask({ ...context, body: terminal }), /injected owner unlink failure/);
        fs.unlinkSync = originalUnlink;
        const reconciled = ownership.reconcileProviderTaskOwnershipReadOnly({
            registry: { 'runtime-retry': { type: 'agent', runtime: 'bwrap', instanceId: 'instance-r', enableGeneration: 'generation-r', homeKey: 'runtime-retry.sandbox-v2' } },
            serviceStates: [{ runtimeKey: 'runtime-retry', instanceId: 'instance-r', enableGeneration: 'generation-r', state: { running: true } }],
        })[0];
        assert.equal(reconciled.classification, 'terminal');
        assert.doesNotThrow(() => ownership.removeReportedTerminalProviderTaskOwner(reconciled));
        assert.deepEqual(ownership.collectProviderTaskOwnersReadOnly(), []);
        assert.deepEqual(fs.readdirSync(ownership.PROVIDER_TASK_OWNER_DIR), []);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: workspace,
        env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspace, PLOINKY_CWD: workspace },
        encoding: 'utf8',
    });
    try { assert.equal(result.status, 0, result.stderr); } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('terminal removal fails and exactly retries when claim cleanup is interrupted', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-provider-claim-retry-'));
    const script = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        process.chdir(${JSON.stringify(workspace)});
        const ownership = await import(${JSON.stringify(moduleUrl)} + '?claim-retry=' + Date.now());
        const audience = 'https://api.openai.com/v1';
        const common = { schemaVersion: 1, taskId: 'claim-retry', audience, provider: 'codex', mode: 'task', runtimeKind: 'bwrap', runtimeKey: 'runtime-claim', homeKey: 'runtime-claim.sandbox-v2', workdir: '/workspace/project', pid: 4242, processGroupId: 4242, processIdentity: 'linux-proc:123e4567-e89b-12d3-a456-426614174000:42', processUid: 1000, brokerOwner: ownership.brokerOwnerFor('agent:fixtures/alpha', 'instance-c', 'generation-c', 'claim-retry', 'codex', audience), readiness: 'ready', state: 'running' };
        const context = { callerIdentity: { agentId: 'agent:fixtures/alpha', instanceId: 'instance-c', enableGeneration: 'generation-c', routeKey: 'alpha' }, selectedRuntime: { agentId: 'agent:fixtures/alpha', instanceId: 'instance-c', enableGeneration: 'generation-c', runtime: 'bwrap', runtimeKey: 'runtime-claim', homeKey: 'runtime-claim.sandbox-v2', alias: 'alpha' } };
        const terminal = { ...common, terminalState: 'completed', terminalProof: { processTerminal: true, descendantsTerminal: true, brokerClosed: true, leaseReleased: true } };
        ownership.publishProviderTask({ ...context, body: common });
        const originalUnlink = fs.unlinkSync;
        let injected = false;
        fs.unlinkSync = function (target) {
            if (!injected && String(target).endsWith('.claim')) { injected = true; const error = new Error('injected claim cleanup failure'); error.code = 'EIO'; throw error; }
            return originalUnlink.apply(this, arguments);
        };
        assert.throws(() => ownership.terminalProviderTask({ ...context, body: terminal }), /injected claim cleanup failure/);
        fs.unlinkSync = originalUnlink;
        assert.doesNotThrow(() => ownership.terminalProviderTask({ ...context, body: terminal }));
        assert.deepEqual(fs.readdirSync(ownership.PROVIDER_TASK_OWNER_DIR), []);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: workspace, env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspace, PLOINKY_CWD: workspace }, encoding: 'utf8' });
    try { assert.equal(result.status, 0, result.stderr); } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('publish fails and exactly retries when temporary hardlink cleanup is interrupted', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-provider-publish-retry-'));
    const script = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        process.chdir(${JSON.stringify(workspace)});
        const ownership = await import(${JSON.stringify(moduleUrl)} + '?publish-retry=' + Date.now());
        const audience = 'https://api.openai.com/v1';
        const common = { schemaVersion: 1, taskId: 'publish-retry', audience, provider: 'codex', mode: 'task', runtimeKind: 'bwrap', runtimeKey: 'runtime-publish', homeKey: 'runtime-publish.sandbox-v2', workdir: '/workspace/project', pid: 4242, processGroupId: 4242, processIdentity: 'linux-proc:123e4567-e89b-12d3-a456-426614174000:42', processUid: 1000, brokerOwner: ownership.brokerOwnerFor('agent:fixtures/alpha', 'instance-p', 'generation-p', 'publish-retry', 'codex', audience), readiness: 'ready', state: 'running' };
        const context = { callerIdentity: { agentId: 'agent:fixtures/alpha', instanceId: 'instance-p', enableGeneration: 'generation-p', routeKey: 'alpha' }, selectedRuntime: { agentId: 'agent:fixtures/alpha', instanceId: 'instance-p', enableGeneration: 'generation-p', runtime: 'bwrap', runtimeKey: 'runtime-publish', homeKey: 'runtime-publish.sandbox-v2', alias: 'alpha' } };
        const originalUnlink = fs.unlinkSync;
        let injected = false;
        fs.unlinkSync = function (target) {
            if (!injected && String(target).endsWith('.tmp')) { injected = true; const error = new Error('injected publish temp cleanup failure'); error.code = 'EIO'; throw error; }
            return originalUnlink.apply(this, arguments);
        };
        assert.throws(() => ownership.publishProviderTask({ ...context, body: common }), /injected publish temp cleanup failure/);
        fs.unlinkSync = originalUnlink;
        assert.equal(ownership.publishProviderTask({ ...context, body: common }).ok, true);
        assert.deepEqual(fs.readdirSync(ownership.PROVIDER_TASK_OWNER_DIR).filter((name) => name.endsWith('.tmp')), []);
        ownership.terminalProviderTask({ ...context, body: { ...common, terminalState: 'completed', terminalProof: { processTerminal: true, descendantsTerminal: true, brokerClosed: true, leaseReleased: true } } });
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: workspace, env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspace, PLOINKY_CWD: workspace }, encoding: 'utf8' });
    try { assert.equal(result.status, 0, result.stderr); } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});
