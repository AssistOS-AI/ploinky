import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const ownershipUrl = pathToFileURL(path.join(
    repoRoot,
    'cli/sandbox/docker/runtimeOwnership.js',
)).href;
const stateUrl = pathToFileURL(path.join(
    repoRoot,
    'cli/sandbox/agentRuntimeState.js',
)).href;
const fleetUrl = pathToFileURL(path.join(
    repoRoot,
    'cli/sandbox/docker/containerFleet.js',
)).href;

test('managed start/status/stop touches only the exact selected runtime in a shared engine', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-phase10r-shared-'));
    const script = `
        import assert from 'node:assert/strict';
        const ownership = await import(${JSON.stringify(ownershipUrl)});
        const { collectAgentRuntimeStates } = await import(${JSON.stringify(stateUrl)});
        const { stopConfiguredAgents } = await import(${JSON.stringify(fleetUrl)});

        const ownedId = 'a'.repeat(64);
        const unrelatedId = 'b'.repeat(64);
        const name = 'ploinky_demo_selected';
        const events = [];
        const engine = new Map([
            [ownedId, { name, running: true }],
            [unrelatedId, { name: 'observe-only-unrelated', running: true }],
        ]);
        const selected = {
            type: 'agent',
            runtime: 'podman',
            repoName: 'demo',
            agentName: 'selected',
            alias: 'selected',
            instanceId: 'instance-selected',
            enableGeneration: 'enable-selected',
            releaseGeneration: 'c'.repeat(64),
            projectPath: '/workspace/project',
            profile: 'default',
            containerImage: 'd'.repeat(64),
            config: { binds: [] },
        };

        // This is the production start visibility boundary: startAgentContainer
        // invokes this atomic publication immediately after acquiring the ID.
        ownership.publishPodmanRuntimeOwnership({
            ...selected,
            containerName: name,
            containerId: ownedId,
            imageId: 'd'.repeat(64),
            manifestSha256: 'sha256:' + 'e'.repeat(64),
            contractHash: 'sha256:' + 'f'.repeat(64),
            networkContractHash: 'sha256:' + '1'.repeat(64),
        });
        events.push(['start-visible', ownedId]);

        let registry = { [name]: selected };
        const states = collectAgentRuntimeStates({
            registry,
            providerOwners: [],
            activeEdgeGeneration: null,
            collectContainers({ registry: exactRegistry }) {
                assert.equal(exactRegistry[name].containerId, ownedId);
                events.push(['inspect', exactRegistry[name].containerId]);
                const runtime = engine.get(exactRegistry[name].containerId);
                return [{
                    containerName: name,
                    containerId: ownedId,
                    runtime: 'podman',
                    ownershipVerified: true,
                    instanceId: selected.instanceId,
                    enableGeneration: selected.enableGeneration,
                    releaseGeneration: selected.releaseGeneration,
                    agentName: selected.agentName,
                    repoName: selected.repoName,
                    state: { status: 'running', running: runtime.running, pid: 42 },
                    config: {},
                }];
            },
        });
        assert.equal(states.length, 1);
        assert.equal(states[0].state.running, true);
        assert.equal(states[0].processIdentity, 'container:' + ownedId);

        const stopped = stopConfiguredAgents({
            fast: true,
            removeContainers: true,
            removeRegistry: true,
            loadRegistry: () => structuredClone(registry),
            saveRegistry(next) { registry = structuredClone(next); },
            reconcileProviderOwnership: () => [],
            withLifecycleLock(callback) {
                events.push(['fleet-lock']);
                return callback(Object.freeze({ exactFleet: true }));
            },
            removeContainer(runtimeName, record, runtime) {
                assert.equal(runtimeName, name);
                assert.equal(record.containerId, ownedId);
                assert.equal(runtime, 'podman');
                events.push(['remove', record.containerId]);
                engine.delete(record.containerId);
                return { found: true, stopped: true, removed: true };
            },
            clearContainerLiveness() {},
        });
        assert.deepEqual(stopped, [name]);
        assert.deepEqual(stopped.survivors, []);
        assert.deepEqual(registry, {});
        assert.equal(ownership.readPodmanRuntimeOwnership(name), null);
        assert.equal(engine.has(ownedId), false);
        assert.deepEqual(engine.get(unrelatedId), {
            name: 'observe-only-unrelated',
            running: true,
        });
        assert.equal(JSON.stringify(events).includes(unrelatedId), false);
        assert.deepEqual(events, [
            ['start-visible', ownedId],
            ['inspect', ownedId],
            ['fleet-lock'],
            ['remove', ownedId],
        ]);
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
        assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
