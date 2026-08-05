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
        },
        stoppedKey: {
            type: 'agent',
            runtime: 'podman',
            repoName: 'Agents',
            agentName: 'stoppedAgent',
            containerId: 'b'.repeat(64),
            instanceId: 'instance-stopped',
            enableGeneration: 'generation-stopped',
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

    const states = collectAgentRuntimeStates({ registry, liveContainers });

    assert.equal(states[0].runtime, 'podman');
    assert.equal(states[0].state.running, true);
    assert.equal(states[1].runtime, 'podman');
    assert.equal(states[1].state.status, 'stopped');
    for (const state of states) {
        for (const hostOnlyField of [
            'role',
            'runtimeKey',
            'ownerKey',
            'instanceId',
            'enableGeneration',
            'homeKey',
            'workdir',
            'logPath',
            'taskId',
            'provider',
            'processIdentity',
        ]) {
            assert.equal(Object.hasOwn(state, hostOnlyField), false, `${hostOnlyField} must remain host-only`);
        }
    }
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
        });
        const enabled = states.find((entry) => entry.enabled === true);
        assert.equal(enabled.state.running, false, `stale identity ${JSON.stringify(stale)} must not match`);
    }

    const exact = collectAgentRuntimeStates({ registry, liveContainers: [baseLive] });
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
            () => collectAgentRuntimeStates({ registry: { incomplete: record }, liveContainers: [] }),
            (error) => error?.code === 'PLOINKY_AGENT_RUNTIME_STATE_INVALID'
                && error.message.includes(field),
        );
    }
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
