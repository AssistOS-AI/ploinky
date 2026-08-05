import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const enabled = process.env.PLOINKY_NATIVE_TRUSTED_CONTAINER === '1';
const imageReference = String(process.env.PLOINKY_NATIVE_CODING_IMAGE || '').trim();
const immutableContainerId = /^[a-f0-9]{64}$/;

function runPodman(args, { timeout = 30_000 } = {}) {
    return spawnSync('podman', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        killSignal: 'SIGKILL',
    });
}

function requirePodmanSuccess(args, options = {}) {
    const result = runPodman(args, options);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, [
        `podman ${args.join(' ')} failed`,
        String(result.stderr || '').trim(),
    ].filter(Boolean).join(': '));
    return String(result.stdout || '').trim();
}

function inspectContainer(containerId) {
    const parsed = JSON.parse(requirePodmanSuccess(['container', 'inspect', containerId]));
    assert.equal(Array.isArray(parsed), true);
    assert.equal(parsed.length, 1);
    return parsed[0];
}

function execJson(containerId, source) {
    const output = requirePodmanSuccess([
        'container', 'exec', containerId,
        'node', '--input-type=module', '--eval', source,
    ]);
    return JSON.parse(output);
}

async function waitForServiceState(containerId, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            return execJson(containerId, `
                const fs = await import('node:fs');
                const state = JSON.parse(fs.readFileSync('/root/native-container-state.json', 'utf8'));
                process.stdout.write(JSON.stringify({
                    ...state,
                    foreignStateVisible: fs.existsSync('/root/foreign-container-state.json'),
                }));
            `);
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    assert.fail(`native container service did not publish state: ${lastError?.message || 'no diagnostic'}`);
}

function envMap(entries) {
    return new Map((entries || []).map((entry) => {
        const text = String(entry || '');
        const separator = text.indexOf('=');
        return separator < 0
            ? [text, '']
            : [text.slice(0, separator), text.slice(separator + 1)];
    }));
}

function writeDummyAgent(agentPath, manifest) {
    fs.mkdirSync(agentPath, { recursive: true });
    fs.writeFileSync(path.join(agentPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(agentPath, 'AgentServer.mjs'), `
        import fs from 'node:fs';
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        const statePath = '/root/native-container-state.json';
        let prior = { starts: 0 };
        try { prior = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) {}
        const state = {
            starts: Number(prior.starts || 0) + 1,
            home: process.env.HOME,
        };
        fs.writeFileSync(statePath, JSON.stringify(state));
        setInterval(() => {}, 60_000);
        process.on('SIGTERM', () => process.exit(0));
    `);
}

test('native container-selected AgentServer preserves the /root ABI and exact Podman identity', {
    skip: enabled
        ? false
        : 'set PLOINKY_NATIVE_TRUSTED_CONTAINER=1 and PLOINKY_NATIVE_CODING_IMAGE to a local coding image',
    timeout: 4 * 60_000,
}, async () => {
    assert.notEqual(imageReference, '', 'PLOINKY_NATIVE_CODING_IMAGE is required');

    const version = JSON.parse(requirePodmanSuccess(['version', '--format', 'json']));
    assert.equal(version.Server?.Os, 'linux');
    assert.match(String(version.Server?.OsArch || ''), /^linux\/(amd64|arm64)$/);

    const imageInspection = JSON.parse(requirePodmanSuccess(['image', 'inspect', imageReference]));
    assert.equal(imageInspection.length, 1);
    const imageId = String(imageInspection[0]?.Id || imageInspection[0]?.ID || '').replace(/^sha256:/, '');
    assert.match(imageId, immutableContainerId);

    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-native-container-'));
    const priorWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    const fixtureId = randomUUID().replaceAll('-', '').slice(0, 16);
    const repositoryName = `native-container-${fixtureId}`;
    const agentSpecs = [
        { name: `container-false-${fixtureId}`, selector: false },
        { name: `container-missing-${fixtureId}`, selector: undefined },
    ];
    const launched = [];
    let cleanupExactAgentRuntimeCandidate;
    let loadAgentsMap;
    let saveAgentsMap;

    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    try {
        const manager = await import(`../../cli/sandbox/docker/agentServiceManager.js?native-container=${fixtureId}`);
        ({ cleanupExactAgentRuntimeCandidate } = manager);
        ({ loadAgentsMap, saveAgentsMap } = await import('../../cli/sandbox/docker/common.js'));
        const { collectLiveAgentContainers } = await import('../../cli/sandbox/docker/containerRegistry.js');
        const { collectAgentRuntimeStates } = await import('../../cli/sandbox/agentRuntimeState.js');
        const { readServiceOwner } = await import('../../cli/sandbox/bwrap/bwrapFleet.js');
        const { getRuntimeForAgent } = await import('../../cli/sandbox/docker/common.js');
        const {
            createAgentSymlinks,
            getAgentWorkDir,
            initWorkspaceStructure,
        } = await import('../../cli/utils/workspaceStructure.js');

        initWorkspaceStructure(workspaceRoot);
        fs.writeFileSync(path.join(workspaceRoot, '.ploinky', 'agents.json'), '{}\n', { mode: 0o600 });

        for (const spec of agentSpecs) {
            const agentPath = path.join(workspaceRoot, 'sources', repositoryName, spec.name);
            // Keep this Phase 4 HOME/service gate independent of Phase 5 Router
            // authority. RuntimeRelay and credential transport have their own
            // identity-bound integration gates; this service remains private.
            const manifest = {
                name: spec.name,
                container: imageReference,
                startup: 'manual',
                network: { mode: 'none' },
                start: 'node /code/AgentServer.mjs',
                ...(spec.selector === undefined ? {} : { 'lite-sandbox': spec.selector }),
            };
            writeDummyAgent(agentPath, manifest);
            createAgentSymlinks(spec.name, repositoryName, agentPath);

            // The approved coding image runs as its declared non-root user. The
            // native container ABI owns this exact bind as /root, so prepare only
            // the test-owned HOME with the exact private ABI mode.
            const homePath = getAgentWorkDir(spec.name);
            fs.mkdirSync(homePath, { recursive: true, mode: 0o700 });
            fs.chmodSync(homePath, 0o700);

            assert.equal(getRuntimeForAgent(manifest), 'podman');
            const result = manager.ensureAgentService(spec.name, manifest, agentPath, {
                routerEndpoint: null,
            });
            launched.push(result);

            assert.equal(result.createdByThisLaunch, true);
            assert.match(result.containerId, immutableContainerId);
            assert.equal(result.registryRecord.runtime, 'podman');
            assert.equal(result.registryRecord.containerId, result.containerId);
            assert.equal(result.registryRecord.agentName, spec.name);
            assert.equal(result.registryRecord.repoName, repositoryName);
            assert.equal(result.registryRecord.projectPath, homePath);

            const inspection = inspectContainer(result.containerId);
            assert.equal(String(inspection.Id || inspection.ID), result.containerId);
            assert.equal(String(inspection.Name || '').replace(/^\//, ''), result.containerName);
            assert.equal(inspection.State?.Running, true);
            assert.equal(String(inspection.State?.Status || '').toLowerCase(), 'running');
            assert.equal(String(inspection.Image || '').replace(/^sha256:/, ''), imageId);
            assert.equal(String(inspection.Config?.Image || ''), imageReference);

            const environment = envMap(inspection.Config?.Env);
            assert.equal(environment.get('HOME'), '/root');
            const rootMounts = (inspection.Mounts || []).filter((mount) => mount.Destination === '/root');
            assert.equal(rootMounts.length, 1);
            assert.equal(rootMounts[0].RW, true);
            assert.equal(fs.realpathSync.native(rootMounts[0].Source), fs.realpathSync.native(homePath));

            const serviceState = await waitForServiceState(result.containerId);
            assert.deepEqual(serviceState, {
                starts: 1,
                home: '/root',
                foreignStateVisible: false,
            });
            fs.writeFileSync(path.join(homePath, 'foreign-container-state.json'), spec.name);

            const reused = manager.ensureAgentService(spec.name, manifest, agentPath, {
                routerEndpoint: null,
            });
            assert.equal(reused.createdByThisLaunch, false);
            assert.equal(reused.containerId, result.containerId);
            assert.deepEqual(JSON.parse(fs.readFileSync(
                path.join(homePath, 'native-container-state.json'),
                'utf8',
            )), {
                starts: 1,
                home: '/root',
            });
        }

        const firstHome = path.join(workspaceRoot, '.data', agentSpecs[0].name);
        const secondHome = path.join(workspaceRoot, '.data', agentSpecs[1].name);
        assert.notEqual(fs.realpathSync.native(firstHome), fs.realpathSync.native(secondHome));
        assert.equal(fs.readFileSync(path.join(firstHome, 'foreign-container-state.json'), 'utf8'), agentSpecs[0].name);
        assert.equal(fs.readFileSync(path.join(secondHome, 'foreign-container-state.json'), 'utf8'), agentSpecs[1].name);

        const registry = loadAgentsMap();
        const live = collectLiveAgentContainers({ registry });
        const states = collectAgentRuntimeStates({ registry, liveContainers: live });
        for (const result of launched) {
            const record = registry[result.containerName];
            assert.equal(record.runtime, 'podman');
            assert.equal(record.containerId, result.containerId);
            assert.equal(record.instanceId, result.registryRecord.instanceId);
            assert.equal(record.enableGeneration, result.registryRecord.enableGeneration);

            const liveRecord = live.find((entry) => entry.containerName === result.containerName);
            assert.equal(liveRecord?.containerId, result.containerId);
            assert.equal(liveRecord?.ownershipVerified, true);
            assert.equal(liveRecord?.state?.running, true);

            const state = states.find((entry) => entry.containerName === result.containerName);
            assert.equal(state?.runtime, 'podman');
            assert.equal(state?.state?.running, true);
            assert.equal(readServiceOwner(result.containerName), null);
        }
        assert.equal(fs.existsSync(path.join(workspaceRoot, '.ploinky', 'bwrap-pids')), false);

        const finalImage = JSON.parse(requirePodmanSuccess(['image', 'inspect', imageReference]));
        assert.equal(String(finalImage[0]?.Id || finalImage[0]?.ID || '').replace(/^sha256:/, ''), imageId);
    } finally {
        const cleanupErrors = [];
        for (const result of launched.reverse()) {
            try {
                cleanupExactAgentRuntimeCandidate(result);
                const exists = runPodman(['container', 'exists', result.containerId]);
                assert.equal(exists.error, undefined, exists.error?.message);
                assert.equal(exists.status, 1, `exact test container '${result.containerId}' remained after cleanup`);
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        if (loadAgentsMap && saveAgentsMap) {
            try {
                const registry = loadAgentsMap();
                for (const result of launched) {
                    if (registry[result.containerName]?.containerId === result.containerId) {
                        delete registry[result.containerName];
                    }
                }
                saveAgentsMap(registry, { coordinate: false });
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        if (cleanupErrors.length === 0) {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
        if (priorWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = priorWorkspaceRoot;
        assert.deepEqual(cleanupErrors, []);
    }
});
