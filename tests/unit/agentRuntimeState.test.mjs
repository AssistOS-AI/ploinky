import assert from 'node:assert/strict';
import test from 'node:test';

import { collectAgentRuntimeStates, collectAgentRuntimeStatesAsync } from '../../cli/sandbox/agentRuntimeState.js';
import { __testables as marketplaceTestables } from '../../cli/server/authHandlers/marketplaceRoutes.js';

test('collectAgentRuntimeStates reports live and stopped host sandboxes from tracked PIDs', () => {
    const checked = [];
    const registry = {
        bwrapKey: {
            type: 'agent',
            runtime: 'bwrap',
            repoName: 'Agents',
            agentName: 'codexAgent',
            projectPath: '/workspace',
        },
        seatbeltKey: {
            type: 'agent',
            runtime: 'seatbelt',
            repoName: 'Agents',
            agentName: 'piAgent',
            projectPath: '/workspace',
        },
    };

    const states = collectAgentRuntimeStates({
        registry,
        liveContainers: [],
        routes: {
            codexAgent: { repo: 'Agents', agent: 'codexAgent', hostPort: 41001 },
        },
        isSandboxRunning(agentName) {
            checked.push(agentName);
            return agentName === 'codexAgent';
        },
        getSandboxPid: () => 4242,
    });

    assert.deepEqual(checked, ['codexAgent', 'piAgent']);
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

    const states = collectAgentRuntimeStates({
        registry,
        liveContainers,
        routes: {
            runningAgent: { repo: 'Agents', agent: 'runningAgent', hostPort: 41002 },
        },
    });

    assert.equal(states[0].runtime, 'podman');
    assert.equal(states[0].state.running, true);
    assert.equal(states[1].runtime, 'docker');
    assert.equal(states[1].state.status, 'stopped');
});

test('collectAgentRuntimeStatesAsync uses the asynchronous container collector', async () => {
    let called = 0;
    const states = await collectAgentRuntimeStatesAsync({
        registry: {},
        collectContainers: async () => {
            called += 1;
            return [{ containerName: 'ploinky_demo', agentName: 'demo', state: { running: true, status: 'running' } }];
        },
        routes: { demo: { agent: 'demo', hostPort: 41003 } },
    });
    assert.equal(called, 1);
    assert.equal(states[0].containerName, 'ploinky_demo');
});

test('collectAgentRuntimeStates reports a starting runtime until its active route has a port', () => {
    const states = collectAgentRuntimeStates({
        registry: {
            demoKey: {
                type: 'agent',
                runtime: 'podman',
                repoName: 'Agents',
                agentName: 'demo',
            },
        },
        liveContainers: [{
            containerName: 'demoKey',
            state: { status: 'running', running: true, pid: 99 },
        }],
        routes: {
            demo: { repo: 'Agents', agent: 'demo' },
        },
    });

    assert.equal(states[0].state.status, 'starting');
    assert.equal(states[0].state.running, false);
    assert.equal(states[0].state.pid, 99);
});

test('collectAgentRuntimeStates does not report disabled or mismatched routes as running', () => {
    const registry = {
        demoKey: {
            type: 'agent',
            runtime: 'podman',
            repoName: 'Agents',
            agentName: 'demo',
        },
    };
    const liveContainers = [{
        containerName: 'demoKey',
        state: {status: 'running', running: true, pid: 99},
    }];
    const collect = (route) => collectAgentRuntimeStates({
        registry,
        liveContainers,
        routes: {demo: route},
    })[0].state;

    assert.deepEqual(collect({
        repo: 'Agents',
        agent: 'demo',
        container: 'demoKey',
        hostPort: 41004,
        disabled: true,
    }), {
        status: 'starting',
        running: false,
        pid: 99,
    });
    assert.deepEqual(collect({
        repo: 'OtherAgents',
        agent: 'demo',
        container: 'otherKey',
        hostPort: 41004,
    }), {
        status: 'starting',
        running: false,
        pid: 99,
    });
    assert.deepEqual(collect({
        agent: 'demo',
        container: 'demoKey',
        hostPort: 41004,
    }), {
        status: 'starting',
        running: false,
        pid: 99,
    });
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
