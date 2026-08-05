import assert from 'node:assert/strict';
import test from 'node:test';

import { collectAgentRuntimeStates } from '../../cli/sandbox/agentRuntimeState.js';
import { inspectOwnership } from '../../cli/sandbox/docker/containerRegistry.js';
import { __testables as marketplaceTestables } from '../../cli/server/authHandlers/marketplaceRoutes.js';

const MANAGED_LABELS = Object.freeze({
    'io.assistos.ploinky.managed': '1',
    'io.assistos.ploinky.resource': 'agent',
    'io.assistos.ploinky.network-schema': '2',
    'io.assistos.ploinky.workspace': 'a'.repeat(12),
    'io.assistos.ploinky.network-contract': 'b'.repeat(64),
    'io.assistos.ploinky.instance-id': 'instance-current',
    'io.assistos.ploinky.enable-generation': 'generation-current',
});

test('container inspection extracts only exact managed Podman ownership', () => {
    const data = {
        Id: 'c'.repeat(64),
        Name: '/exactKey',
        Config: { Labels: MANAGED_LABELS },
    };
    const expected = {
        workspaceHash: 'a'.repeat(12),
        containerId: 'c'.repeat(64),
        instanceId: 'instance-current',
        enableGeneration: 'generation-current',
    };
    assert.deepEqual(inspectOwnership(data, 'exactKey', expected), {
        containerId: 'c'.repeat(64),
        instanceId: 'instance-current',
        enableGeneration: 'generation-current',
        ownershipVerified: true,
    });

    for (const mutated of [
        { ...data, Id: 'short-id' },
        { ...data, Name: '/replacementKey' },
        { ...data, Config: { Labels: { ...MANAGED_LABELS, 'io.assistos.ploinky.managed': '0' } } },
        { ...data, Config: { Labels: { ...MANAGED_LABELS, 'io.assistos.ploinky.instance-id': ' stale ' } } },
    ]) {
        assert.equal(inspectOwnership(mutated, 'exactKey', expected).ownershipVerified, false);
    }
    assert.equal(inspectOwnership(data, 'exactKey', {
        ...expected,
        workspaceHash: 'f'.repeat(12),
    }).ownershipVerified, false);
});

test('collectAgentRuntimeStates uses exact registry runtime ownership and surfaces host metadata', () => {
    const reads = [];
    const checks = [];
    const registry = {
        bwrapKey: {
            type: 'agent',
            runtime: 'bwrap',
            repoName: 'Agents',
            agentName: 'codexAgent',
            projectPath: '/workspace',
            instanceId: 'instance-bwrap',
            enableGeneration: 'generation-bwrap',
            homeKey: 'bwrapKey.sandbox-v2',
        },
        seatbeltKey: {
            type: 'agent',
            runtime: 'seatbelt',
            repoName: 'Agents',
            agentName: 'piAgent',
            projectPath: '/workspace',
            instanceId: 'instance-seatbelt',
            enableGeneration: 'generation-seatbelt',
            homeKey: 'seatbeltKey.sandbox-v2',
        },
    };
    const owners = {
        bwrapKey: {
            schemaVersion: 5,
            role: 'service',
            runtimeKey: 'bwrapKey',
            ownerKey: 'service-bwrap-owner',
            pid: 4242,
            processIdentity: 'linux-proc:123e4567-e89b-12d3-a456-426614174000:101',
            processUid: 501,
            instanceId: 'instance-bwrap',
            enableGeneration: 'generation-bwrap',
            homeKey: 'bwrapKey.sandbox-v2',
            workdir: '/workspace/projects/current',
            logPath: '/workspace/.ploinky/logs/bwrapKey-bwrap.log',
            taskId: '',
            provider: '',
            routeKey: 'codexAgent',
            rootPort: 8080,
            credentialNonceDigest: 'sha256:' + 'a'.repeat(64),
            credentialExpiresAt: 1_800_000_000,
            manifestDigest: 'sha256:' + 'b'.repeat(64),
            admissionDigest: 'sha256:' + 'c'.repeat(64),
            networkHash: 'sha256:' + 'd'.repeat(64),
        },
        seatbeltKey: {
            schemaVersion: 5,
            role: 'service',
            runtimeKey: 'seatbeltKey',
            ownerKey: 'service-seatbelt-owner',
            pid: 4343,
            processIdentity: 'darwin-ps:1785220336:610367:Tue Aug 4 10:00:00 2026',
            processUid: 501,
            instanceId: 'instance-seatbelt',
            enableGeneration: 'stale-seatbelt-generation',
            homeKey: 'seatbeltKey.sandbox-v2',
            workdir: '/workspace',
            logPath: '/workspace/.ploinky/logs/seatbeltKey-seatbelt.log',
            taskId: '',
            provider: '',
            routeKey: 'piAgent',
            rootPort: 8080,
            credentialNonceDigest: 'sha256:' + 'e'.repeat(64),
            credentialExpiresAt: 1_800_000_000,
            manifestDigest: 'sha256:' + 'f'.repeat(64),
            admissionDigest: 'sha256:' + '0'.repeat(64),
            networkHash: 'sha256:' + '1'.repeat(64),
        },
    };

    const states = collectAgentRuntimeStates({
        registry,
        liveContainers: [],
        providerOwners: [],
        readSandboxServiceOwner(runtimeKey) {
            reads.push(runtimeKey);
            return owners[runtimeKey] || null;
        },
        isSandboxOwnerRunning(ownerKey, expected) {
            checks.push({ ownerKey, expected });
            return ownerKey === owners.bwrapKey.ownerKey;
        },
    });

    assert.deepEqual(reads, ['bwrapKey', 'seatbeltKey']);
    assert.deepEqual(checks, [{
        ownerKey: 'service-bwrap-owner',
        expected: {
            instanceId: 'instance-bwrap',
            enableGeneration: 'generation-bwrap',
            role: 'service',
            runtimeKey: 'bwrapKey',
        },
    }]);
    assert.deepEqual(states.map((entry) => ({
        name: entry.agentName,
        runtime: entry.runtime,
        status: entry.state.status,
        running: entry.state.running,
        pid: entry.state.pid,
    })), [
        { name: 'codexAgent', runtime: 'bwrap', status: 'running', running: true, pid: 4242 },
        { name: 'piAgent', runtime: 'seatbelt', status: 'stopped', running: false, pid: 0 },
    ]);
    assert.deepEqual({
        role: states[0].role,
        runtimeKey: states[0].runtimeKey,
        ownerKey: states[0].ownerKey,
        instanceId: states[0].instanceId,
        enableGeneration: states[0].enableGeneration,
        homeKey: states[0].homeKey,
        workdir: states[0].workdir,
        logPath: states[0].logPath,
        taskId: states[0].taskId,
        provider: states[0].provider,
        processIdentity: states[0].processIdentity,
    }, {
        role: 'service',
        runtimeKey: 'bwrapKey',
        ownerKey: 'service-bwrap-owner',
        instanceId: 'instance-bwrap',
        enableGeneration: 'generation-bwrap',
        homeKey: 'bwrapKey.sandbox-v2',
        workdir: '/workspace/projects/current',
        logPath: '/workspace/.ploinky/logs/bwrapKey-bwrap.log',
        taskId: '',
        provider: '',
        processIdentity: 'linux-proc:123e4567-e89b-12d3-a456-426614174000:101',
    });
});

test('collectAgentRuntimeStates merges OCI state and retains stopped enabled containers', () => {
    const registry = {
        runningKey: {
            type: 'agent',
            runtime: 'podman',
            repoName: 'Agents',
            agentName: 'runningAgent',
            containerId: 'a'.repeat(64),
            instanceId: 'instance-running',
            enableGeneration: 'generation-running',
            alias: 'editor-running',
        },
        stoppedKey: {
            type: 'agent',
            runtime: 'podman',
            repoName: 'Agents',
            agentName: 'stoppedAgent',
            containerId: 'b'.repeat(64),
            instanceId: 'instance-stopped',
            enableGeneration: 'generation-stopped',
            alias: 'editor-stopped',
        },
    };
    const liveContainers = [{
        containerName: 'runningKey',
        runtime: 'podman',
        ownershipVerified: true,
        containerId: 'a'.repeat(64),
        instanceId: 'instance-running',
        enableGeneration: 'generation-running',
        repoName: 'Agents',
        agentName: 'runningAgent',
        state: { status: 'running', running: true, pid: 99 },
        config: {},
    }];

    const states = collectAgentRuntimeStates({ registry, liveContainers, providerOwners: [] });

    assert.equal(states[0].runtime, 'podman');
    assert.equal(states[0].state.running, true);
    assert.equal(states[0].effectiveInstance, 'editor-running');
    assert.equal(states[0].readiness, 'not-ready');
    assert.equal(states[0].logPath, `podman://${'a'.repeat(64)}`);
    assert.equal(states[1].runtime, 'podman');
    assert.equal(states[1].state.status, 'stopped');
    assert.equal(states[1].effectiveInstance, 'editor-stopped');
    assert.equal(states[1].readiness, 'not-ready');
    assert.equal(states[1].logPath, `podman://${'b'.repeat(64)}`);
    for (const state of states) {
        assert.equal(state.role, 'service');
        assert.ok(state.runtimeKey);
        assert.equal(state.instanceId.startsWith('instance-'), true);
        assert.equal(state.enableGeneration.startsWith('generation-'), true);
    }
});

test('service readiness requires the exact active authenticated generation', () => {
    const record = {
        type: 'agent', runtime: 'podman', alias: 'editor', agentName: 'agent',
        containerId: 'a'.repeat(64), instanceId: 'instance-ready',
        enableGeneration: 'generation-ready',
    };
    const live = [{
        containerName: 'runtime-ready', runtime: 'podman', ownershipVerified: true,
        containerId: record.containerId, instanceId: record.instanceId,
        enableGeneration: record.enableGeneration,
        state: { status: 'running', running: true, pid: 99 },
    }];
    const collect = (activeEdgeGeneration) => collectAgentRuntimeStates({
        registry: { 'runtime-ready': record }, liveContainers: live, providerOwners: [],
        activeEdgeGeneration,
    })[0];
    assert.equal(collect(null).readiness, 'not-ready');
    assert.equal(collect({
        selector: { state: 'active', publicationState: 'ready' },
        generation: { agents: { 'runtime-ready': { ...record } } },
    }).readiness, 'ready');
    assert.equal(collect({
        selector: { state: 'active', publicationState: 'ready' },
        generation: { agents: { 'runtime-ready': { ...record, enableGeneration: 'stale' } } },
    }).readiness, 'not-ready');
});

test('collectAgentRuntimeStates rejects legacy and non-exact registry runtimes before probing OCI', () => {
    for (const runtime of [undefined, null, '', 'container', 'docker', 'Podman', ' podman ', 'nerdctl']) {
        let probes = 0;
        assert.throws(
            () => collectAgentRuntimeStates({
                registry: {
                    invalidKey: {
                        type: 'agent',
                        ...(runtime === undefined ? {} : { runtime }),
                        containerId: 'a'.repeat(64),
                        instanceId: 'instance-invalid',
                        enableGeneration: 'generation-invalid',
                    },
                },
                collectContainers() {
                    probes += 1;
                    return [];
                },
                providerOwners: [],
            }),
            (error) => error?.code === 'PLOINKY_AGENT_RUNTIME_STATE_INVALID'
                && /invalidKey/.test(error.message),
            `runtime ${JSON.stringify(runtime)} must fail closed`,
        );
        assert.equal(probes, 0, 'invalid registry state must fail before probing a container engine');
    }
});

test('collectAgentRuntimeStates does not probe a container engine for an all-sandbox registry', () => {
    let probes = 0;
    const states = collectAgentRuntimeStates({
        registry: {
            sandboxOnly: {
                type: 'agent',
                runtime: 'bwrap',
                instanceId: 'instance-sandbox',
                enableGeneration: 'generation-sandbox',
                homeKey: 'sandboxOnly.sandbox-v2',
            },
        },
        collectContainers() {
            probes += 1;
            return [];
        },
        readSandboxServiceOwner() {
            return null;
        },
        providerOwners: [],
    });

    assert.equal(probes, 0);
    assert.equal(states.length, 1);
    assert.equal(states[0].runtime, 'bwrap');
    assert.equal(states[0].state.running, false);
});

test('collectAgentRuntimeStates matches Podman state by immutable ID and exact generation identity', () => {
    const registry = {
        exactKey: {
            type: 'agent',
            runtime: 'podman',
            agentName: 'currentAgent',
            containerId: 'a'.repeat(64),
            instanceId: 'instance-current',
            enableGeneration: 'generation-current',
        },
    };
    const baseLive = {
        containerName: 'exactKey',
        runtime: 'podman',
        ownershipVerified: true,
        containerId: 'a'.repeat(64),
        instanceId: 'instance-current',
        enableGeneration: 'generation-current',
        agentName: 'currentAgent',
        state: { status: 'running', running: true, pid: 99 },
    };

    for (const stale of [
        { containerId: 'b'.repeat(64) },
        { instanceId: 'instance-stale' },
        { enableGeneration: 'generation-stale' },
        { runtime: 'docker' },
        { ownershipVerified: false },
    ]) {
        const states = collectAgentRuntimeStates({
            registry,
            liveContainers: [{ ...baseLive, ...stale }],
            providerOwners: [],
        });
        const enabled = states.find((entry) => entry.enabled === true);
        assert.equal(enabled.state.running, false, `stale identity ${JSON.stringify(stale)} must not match`);
    }

    const exact = collectAgentRuntimeStates({
        registry,
        liveContainers: [baseLive],
        providerOwners: [],
    });
    assert.equal(exact.find((entry) => entry.enabled === true).state.running, true);
});

test('collectAgentRuntimeStates never surfaces a foreign or unregistered live Podman runtime', () => {
    const registry = {
        exactKey: {
            type: 'agent',
            runtime: 'podman',
            agentName: 'currentAgent',
            containerId: 'a'.repeat(64),
            instanceId: 'instance-current',
            enableGeneration: 'generation-current',
        },
    };
    const states = collectAgentRuntimeStates({
        registry,
        providerOwners: [],
        liveContainers: [{
            containerName: 'foreignKey',
            runtime: 'podman',
            ownershipVerified: true,
            containerId: 'b'.repeat(64),
            instanceId: 'instance-foreign',
            enableGeneration: 'generation-foreign',
            agentName: 'foreignAgent',
            repoName: 'foreignRepo',
            state: { status: 'running', running: true, pid: 999 },
        }],
    });
    assert.deepEqual(states.map((entry) => entry.containerName), ['exactKey']);
    assert.equal(states[0].enabled, true);
    assert.equal(states[0].state.running, false);
});

test('collectAgentRuntimeStates rejects legacy or mismatched sandbox HOME keys', () => {
    for (const homeKey of [undefined, '', 'sandboxKey', 'other.sandbox-v2', ' sandboxKey.sandbox-v2 ']) {
        assert.throws(
            () => collectAgentRuntimeStates({
                registry: {
                    sandboxKey: {
                        type: 'agent',
                        runtime: 'bwrap',
                        instanceId: 'instance-current',
                        enableGeneration: 'generation-current',
                        ...(homeKey === undefined ? {} : { homeKey }),
                    },
                },
                liveContainers: [],
                providerOwners: [],
            }),
            error => error?.code === 'PLOINKY_AGENT_RUNTIME_STATE_INVALID'
                && /sandbox-v2 HOME key/.test(error.message),
        );
    }
});

test('collectAgentRuntimeStates rejects incomplete Podman registry identities', () => {
    const complete = {
        type: 'agent',
        runtime: 'podman',
        containerId: 'a'.repeat(64),
        instanceId: 'instance-current',
        enableGeneration: 'generation-current',
    };
    for (const field of ['containerId', 'instanceId', 'enableGeneration']) {
        const record = { ...complete };
        delete record[field];
        assert.throws(
            () => collectAgentRuntimeStates({
                registry: { incomplete: record },
                liveContainers: [],
                providerOwners: [],
            }),
            (error) => error?.code === 'PLOINKY_AGENT_RUNTIME_STATE_INVALID'
                && error.message.includes(field),
        );
    }
});

test('provider status is allowlisted and live only under its exact running parent runtime', () => {
    const runtimeKey = 'runtime-provider';
    const registry = {
        [runtimeKey]: {
            type: 'agent',
            runtime: 'bwrap',
            repoName: 'fixtures',
            agentName: 'alpha',
            alias: 'editor',
            instanceId: 'instance-provider',
            enableGeneration: 'generation-provider',
            homeKey: `${runtimeKey}.sandbox-v2`,
        },
    };
    const serviceOwner = {
        ownerKey: 'service-owner',
        runtimeKey,
        instanceId: 'instance-provider',
        enableGeneration: 'generation-provider',
        homeKey: `${runtimeKey}.sandbox-v2`,
        pid: 41,
    };
    const providerOwner = {
        role: 'provider-task',
        ownerKey: 'provider-owner',
        runtimeKey,
        runtime: 'bwrap',
        alias: 'editor',
        instanceId: 'instance-provider',
        enableGeneration: 'generation-provider',
        homeKey: `${runtimeKey}.sandbox-v2`,
        workdir: '/workspace/project',
        logPath: '/workspace/.ploinky/logs/agents/instance-provider/tasks/task-1-provider.log',
        taskId: 'task-1',
        provider: 'codex',
        mode: 'task',
        audience: 'secret-audience',
        brokerOwner: `sha256:${'a'.repeat(64)}`,
        pid: 42,
        processGroupId: 42,
        processIdentity: 'linux-proc:123e4567-e89b-12d3-a456-426614174000:42',
        processUid: 1000,
        readiness: 'ready',
        state: 'running',
    };
    const states = collectAgentRuntimeStates({
        registry,
        providerOwners: [providerOwner],
        readSandboxServiceOwner: () => serviceOwner,
        isSandboxOwnerRunning: () => true,
        activeEdgeGeneration: {
            selector: { state: 'active', publicationState: 'ready' },
            generation: { agents: registry },
        },
    });
    const provider = states.find((state) => state.role === 'provider-task');
    assert.equal(provider.state.status, 'running');
    assert.equal(provider.effectiveInstance, 'editor');
    assert.equal(provider.processAuthority, 'inner-runtime-attestation');
    assert.equal(Object.hasOwn(provider, 'audience'), false);
    assert.equal(Object.hasOwn(provider, 'brokerOwner'), false);
    assert.equal(Object.hasOwn(provider, 'processUid'), false);

    const unpublished = collectAgentRuntimeStates({
        registry,
        providerOwners: [providerOwner],
        readSandboxServiceOwner: () => serviceOwner,
        isSandboxOwnerRunning: () => true,
        activeEdgeGeneration: null,
    }).find((state) => state.role === 'provider-task');
    assert.equal(unpublished.state.status, 'failed');
    assert.equal(unpublished.classification, 'parent-runtime-not-ready');

    const contained = collectAgentRuntimeStates({
        registry,
        providerOwners: [providerOwner],
        readSandboxServiceOwner: () => serviceOwner,
        isSandboxOwnerRunning: () => false,
        activeEdgeGeneration: null,
    }).find((state) => state.role === 'provider-task');
    assert.equal(contained.state.status, 'failed');
    assert.equal(contained.classification, 'parent-runtime-contained');
});

test('Marketplace reports an enabled bwrap agent as running from generic runtime state', () => {
    const registry = {
        bwrapKey: {
            type: 'agent',
            runtime: 'bwrap',
            repoName: 'AchillesCLI',
            agentName: 'codexAgent',
            runMode: 'global',
        },
    };
    const marketplace = marketplaceTestables.buildMarketplaceState(null, {
        registry,
        runtimeEntries: [{
            containerName: 'bwrapKey',
            repoName: 'AchillesCLI',
            agentName: 'codexAgent',
            runtime: 'bwrap',
            state: { status: 'running', running: true, pid: 5150 },
        }],
        summaries: [{
            repo: 'AchillesCLI',
            installed: true,
            agents: [{
                repo: 'AchillesCLI',
                name: 'codexAgent',
                about: 'Codex',
                manifestPath: '/repo/codexAgent/manifest.json',
            }],
        }],
    });

    assert.deepEqual(marketplace.agents[0], {
        ref: 'AchillesCLI/codexAgent',
        repo: 'AchillesCLI',
        name: 'codexAgent',
        about: 'Codex',
        active: true,
        enableMode: 'global',
        enableModes: ['isolated', 'global', 'devel'],
        runtime: 'bwrap',
        status: 'running',
        running: true,
        pid: 5150,
        containerName: 'bwrapKey',
        manifestPath: '/repo/codexAgent/manifest.json',
    });
    assert.equal(marketplace.enabledAgents[0].runtime, 'bwrap');
});
