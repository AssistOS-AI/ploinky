import assert from 'node:assert/strict';
import test from 'node:test';

import { collectAgentRuntimeStates } from '../../cli/sandbox/agentRuntimeState.js';
import { __testables as marketplaceTestables } from '../../cli/server/authHandlers/marketplaceRoutes.js';

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
        },
        seatbeltKey: {
            type: 'agent',
            runtime: 'seatbelt',
            repoName: 'Agents',
            agentName: 'piAgent',
            projectPath: '/workspace',
            instanceId: 'instance-seatbelt',
            enableGeneration: 'generation-seatbelt',
        },
    };
    const owners = {
        bwrapKey: {
            schemaVersion: 3,
            role: 'service',
            runtimeKey: 'bwrapKey',
            ownerKey: 'service-bwrap-owner',
            pid: 4242,
            processIdentity: 'linux-proc:101',
            instanceId: 'instance-bwrap',
            enableGeneration: 'generation-bwrap',
            homeKey: 'bwrapKey',
            workdir: '/workspace/projects/current',
            logPath: '/workspace/.ploinky/logs/bwrapKey-bwrap.log',
            taskId: '',
            provider: '',
        },
        seatbeltKey: {
            schemaVersion: 3,
            role: 'service',
            runtimeKey: 'seatbeltKey',
            ownerKey: 'service-seatbelt-owner',
            pid: 4343,
            processIdentity: 'ps-lstart:Tue Aug 4 10:00:00 2026',
            instanceId: 'instance-seatbelt',
            enableGeneration: 'stale-seatbelt-generation',
            homeKey: 'seatbeltKey',
            workdir: '/workspace',
            logPath: '/workspace/.ploinky/logs/seatbeltKey-seatbelt.log',
            taskId: '',
            provider: '',
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
        homeKey: 'bwrapKey',
        workdir: '/workspace/projects/current',
        logPath: '/workspace/.ploinky/logs/bwrapKey-bwrap.log',
        taskId: '',
        provider: '',
        processIdentity: 'linux-proc:101',
    });
});

test('collectAgentRuntimeStates merges OCI state and retains stopped enabled containers', () => {
    const registry = {
        runningKey: {
            type: 'agent',
            runtime: 'podman',
            repoName: 'Agents',
            agentName: 'runningAgent',
        },
        stoppedKey: {
            type: 'agent',
            runtime: 'docker',
            repoName: 'Agents',
            agentName: 'stoppedAgent',
        },
    };
    const liveContainers = [{
        containerName: 'runningKey',
        repoName: 'Agents',
        agentName: 'runningAgent',
        state: { status: 'running', running: true, pid: 99 },
        config: {},
    }];

    const states = collectAgentRuntimeStates({ registry, liveContainers });

    assert.equal(states[0].runtime, 'podman');
    assert.equal(states[0].state.running, true);
    assert.equal(states[1].runtime, 'docker');
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
