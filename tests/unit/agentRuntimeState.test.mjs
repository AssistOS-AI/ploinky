import assert from 'node:assert/strict';
import test from 'node:test';

import { collectAgentRuntimeStates, collectAgentRuntimeStatesAsync } from '../../cli/sandbox/agentRuntimeState.js';
import { __testables as marketplaceTestables } from '../../cli/server/authHandlers/marketplaceRoutes.js';
import { applyCurrentNoWaitReadiness } from '../../cli/utils/noWaitReadiness.js';

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

function serviceOnlyFixture() {
    const record = {
        type: 'agent', runtime: 'podman', repoName: 'Agents', agentName: 'service',
        instanceId: 'instance-1', enableGeneration: 'enable-1', profile: 'default', containerId: 'a'.repeat(64),
    };
    const registry = { serviceKey: record };
    const activeGeneration = {
        routing: { routes: { service: { repo: 'Agents', agent: 'service', container: 'serviceKey' } } },
        agents: structuredClone(registry),
        manifests: { service: { start: './start.sh', health: { readiness: { script: './ready.sh' } } } },
    };
    return {
        registry, activeGeneration,
        liveContainers: [{ containerName: 'serviceKey', containerId: record.containerId, state: { status: 'running', running: true, pid: 99 } }],
        observeNoWaitRecord: () => ({ state: 'running' }),
    };
}

test('service-only OCI runtimes are running after exact active publication and semantic readiness without a main port', () => {
    for (const observation of [null, { state: 'running' }]) {
        const fixture = serviceOnlyFixture();
        fixture.observeNoWaitRecord = (containerName, record, { readRegistrySnapshot }) => {
            assert.equal(containerName, 'serviceKey');
            assert.equal(record, fixture.registry.serviceKey);
            assert.equal(readRegistrySnapshot(), fixture.registry);
            return observation;
        };
        const [entry] = collectAgentRuntimeStates(fixture);
        assert.deepEqual(entry.state, { status: 'running', running: true, pid: 99 });
        assert.equal(marketplaceTestables.normalizeMarketplaceAgentStatus({ active: true, runtimeState: entry.state }).status, 'running');
        const projected = applyCurrentNoWaitReadiness(entry, fixture.registry, {
            readMarker: () => ({}), createBinding: () => ({}), observeRun: () => ({ state: 'running' }),
        });
        assert.equal(projected.state.status, 'running');
        assert.equal(projected.state.ready, true);
    }
});

test('service-only readiness rejects pending, failed, unreadable, and stale detached runs', () => {
    for (const state of ['pending', 'starting', 'failed', 'unverified', 'superseded']) {
        const fixture = serviceOnlyFixture();
        fixture.observeNoWaitRecord = () => ({ state });
        const [entry] = collectAgentRuntimeStates(fixture);
        assert.equal(entry.state.status, 'starting', state);
        assert.equal(entry.state.running, false, state);
        assert.equal(entry.state.pid, 99);
    }
    const fixture = serviceOnlyFixture();
    fixture.observeNoWaitRecord = () => { throw new Error('stale current marker'); };
    assert.equal(collectAgentRuntimeStates(fixture)[0].state.running, false);
});

test('service-only readiness rejects missing publication, ordinary agents, and mismatched immutable runtime identities', () => {
    const mutations = [
        (fixture) => { fixture.activeGeneration = null; },
        (fixture) => { fixture.activeGeneration.routing.routes.service.disabled = true; },
        (fixture) => { fixture.activeGeneration.routing.routes.service.draining = true; },
        (fixture) => { fixture.activeGeneration.routing.routes.service.container = 'otherKey'; },
        (fixture) => { fixture.activeGeneration.routing.routes.service.repo = 'Other'; },
        (fixture) => { delete fixture.activeGeneration.manifests.service; },
        (fixture) => { fixture.activeGeneration.manifests.service = {}; },
        (fixture) => { fixture.activeGeneration.manifests.service.agent = './agent.sh'; },
        (fixture) => { fixture.activeGeneration.agents.serviceKey.instanceId = 'old-instance'; },
        (fixture) => { fixture.activeGeneration.agents.serviceKey.enableGeneration = 'old-enable'; },
        (fixture) => { fixture.activeGeneration.agents.serviceKey.containerId = 'b'.repeat(64); },
        (fixture) => { fixture.activeGeneration.agents.serviceKey.profile = 'other'; },
        (fixture) => { fixture.activeGeneration.agents.serviceKey.runtime = 'docker'; },
        (fixture) => { fixture.liveContainers[0].containerId = 'b'.repeat(64); },
        (fixture) => { delete fixture.liveContainers[0].containerId; },
        (fixture) => { fixture.liveContainers[0].state.running = false; },
    ];
    for (const mutate of mutations) {
        const fixture = serviceOnlyFixture();
        mutate(fixture);
        let observations = 0;
        fixture.observeNoWaitRecord = () => { observations += 1; return { state: 'running' }; };
        assert.equal(collectAgentRuntimeStates(fixture)[0].state.running, false, mutate.toString());
        assert.equal(observations, 0, 'invalid runtime must not reach semantic readiness lookup');
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

test('Marketplace normalizes agent lifecycle states without trusting arbitrary runtime labels', () => {
    const normalize = marketplaceTestables.normalizeMarketplaceAgentStatus;
    assert.deepEqual(normalize({ active: false }), { status: 'disabled', detail: '' });
    assert.deepEqual(normalize({
        active: true,
        runtimeState: { status: 'stopped', running: false },
        noWaitState: { status: 'starting', detail: 'Background startup is in progress.' },
    }), { status: 'starting', detail: 'Background startup is in progress.' });
    assert.deepEqual(normalize({
        active: true,
        runtimeState: { status: 'running', running: true },
        noWaitState: { status: 'failed', detail: 'stale failure' },
    }), { status: 'running', detail: '' });
    assert.deepEqual(normalize({
        active: true,
        runtimeState: { status: 'stopped', running: false },
        noWaitState: { status: 'failed', detail: 'phase: launch — exited' },
    }), { status: 'failed', detail: 'phase: launch — exited' });
    assert.deepEqual(normalize({ active: true, runtimeState: { status: 'paused' } }), {
        status: 'paused',
        detail: '',
    });
    assert.deepEqual(normalize({ active: true, runtimeState: { status: 'exited' } }), {
        status: 'stopped',
        detail: '',
    });
    assert.deepEqual(normalize({ active: true, runtimeState: { status: 'compromised' } }), {
        status: 'unknown',
        detail: '',
    });
});

test('Marketplace reads the exact current no-wait run and publishes bounded lifecycle detail', () => {
    const registry = {
        searchKey: {
            type: 'agent',
            instanceId: 'instance-1',
            enableGeneration: 'generation-1',
        },
    };
    const marker = {
        runId: 'run-1',
        runStartedAtMs: 100,
        waveIndex: 0,
        statusFile: 'searchKey.run-1.json',
    };
    let observedBinding = null;
    const states = marketplaceTestables.collectMarketplaceNoWaitStates(registry, {
        readRunMarker: (containerName) => {
            assert.equal(containerName, 'searchKey');
            return marker;
        },
        createRunBinding: (containerName, record, currentMarker) => {
            assert.equal(record, registry.searchKey);
            assert.equal(currentMarker, marker);
            return { containerName, marker: currentMarker };
        },
        observeRun: (binding, options) => {
            observedBinding = binding;
            assert.equal(options.readRegistrySnapshot(), registry);
            return {
                state: 'failed',
                status: { phase: 'launch', error: { message: 'runtime exited' } },
            };
        },
        summarizeFailure: (status) => `phase: ${status.phase} — ${status.error.message}`,
        readRegistrySnapshot: () => registry,
    });

    assert.deepEqual(observedBinding, { containerName: 'searchKey', marker });
    assert.deepEqual(states.get('searchKey'), {
        status: 'failed',
        detail: 'phase: launch — runtime exited',
    });
});

test('Marketplace state exposes starting and disabled agents as distinct lifecycle states', () => {
    const registry = {
        searchKey: {
            type: 'agent',
            runtime: 'podman',
            repoName: 'proxies',
            agentName: 'searchAgent',
            runMode: 'isolated',
        },
    };
    const summaries = [{
        repo: 'proxies',
        installed: true,
        agents: [
            { repo: 'proxies', name: 'searchAgent', about: 'Search', manifestPath: '/search/manifest.json' },
            { repo: 'proxies', name: 'otherAgent', about: 'Other', manifestPath: '/other/manifest.json' },
        ],
    }];
    const marketplace = marketplaceTestables.buildMarketplaceState(null, {
        registry,
        runtimeEntries: [{
            containerName: 'searchKey',
            repoName: 'proxies',
            agentName: 'searchAgent',
            runtime: 'podman',
            state: { status: 'stopped', running: false, pid: 0 },
        }],
        noWaitStates: new Map([['searchKey', {
            status: 'starting',
            detail: 'Background startup is in progress.',
        }]]),
        summaries,
    });

    assert.deepEqual(marketplace.agents.map((agent) => ({
        ref: agent.ref,
        active: agent.active,
        status: agent.status,
        statusDetail: agent.statusDetail || '',
        running: agent.running,
    })).sort((left, right) => left.ref.localeCompare(right.ref)), [
        {
            ref: 'proxies/otherAgent',
            active: false,
            status: 'disabled',
            statusDetail: '',
            running: false,
        },
        {
            ref: 'proxies/searchAgent',
            active: true,
            status: 'starting',
            statusDetail: 'Background startup is in progress.',
            running: false,
        },
    ]);
});
