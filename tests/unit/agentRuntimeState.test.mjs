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

function activatedScriptRuntimeFixture() {
    const record = {
        type: 'agent', runtime: 'podman', repoName: 'Services', agentName: 'documentServer',
        alias: 'documents', profile: 'default', instanceId: 'instance-current',
        enableGeneration: 'enable-current', containerId: 'container-current',
    };
    return {
        registry: { documentKey: { ...record } },
        liveContainers: [{
            containerName: 'documentKey',
            state: { status: 'running', running: true, pid: 123 },
        }],
        activeGeneration: {
            agents: { documentKey: { ...record } },
            routing: { routes: { documents: {
                container: 'documentKey', repo: 'Services', agent: 'documentServer', alias: 'documents',
            } } },
            manifests: { documents: {
                start: 'node /code/server.mjs',
                health: { readiness: { script: 'ready.sh' } },
                profiles: { default: {} },
            } },
        },
    };
}

test('a running script-ready start-only runtime uses its exact activated generation without a main port', async () => {
    const options = activatedScriptRuntimeFixture();
    assert.deepEqual(collectAgentRuntimeStates(options)[0].state, {
        status: 'running', running: true, pid: 123,
    });
    assert.equal((await collectAgentRuntimeStatesAsync(options))[0].state.running, true);
    options.liveContainers[0].state = { status: 'stopped', running: false, pid: 0 };
    assert.deepEqual(collectAgentRuntimeStates(options)[0].state, {
        status: 'stopped', running: false, pid: 0,
    });
});

const invalidScriptRuntimeEvidence = {
    'missing generation': (o) => { o.activeGeneration = null; },
    'missing captured manifest': (o) => { delete o.activeGeneration.manifests.documents; },
    'missing captured registry': (o) => { delete o.activeGeneration.agents; },
    'missing captured route': (o) => { delete o.activeGeneration.routing.routes.documents; },
    'disabled route': (o) => { o.activeGeneration.routing.routes.documents.disabled = true; },
    'draining route': (o) => { o.activeGeneration.routing.routes.documents.draining = true; },
    'wrong container name': (o) => { o.activeGeneration.routing.routes.documents.container = 'replacementKey'; },
    'wrong route repository': (o) => { o.activeGeneration.routing.routes.documents.repo = 'Other'; },
    'wrong route agent': (o) => { o.activeGeneration.routing.routes.documents.agent = 'other'; },
    'wrong route alias': (o) => { o.activeGeneration.routing.routes.documents.alias = 'other'; },
    'wrong route key': (o) => { o.activeGeneration.routing.routes.other = o.activeGeneration.routing.routes.documents; delete o.activeGeneration.routing.routes.documents; },
    'untracked live process': (o) => { o.registry = {}; },
    'ordinary MCP with script': (o) => { o.activeGeneration.manifests.documents.agent = 'node agent.mjs'; },
    'ordinary implicit MCP': (o) => { delete o.activeGeneration.manifests.documents.start; },
    'TCP start-only readiness': (o) => { o.activeGeneration.manifests.documents.readiness = { protocol: 'tcp' }; },
    'missing script readiness': (o) => { delete o.activeGeneration.manifests.documents.health; },
    'undeclared profile': (o) => { o.registry.documentKey.profile = 'missing'; o.activeGeneration.agents.documentKey.profile = 'missing'; },
    'noncanonical profile': (o) => { o.registry.documentKey.profile = 'DEFAULT'; o.activeGeneration.agents.documentKey.profile = 'DEFAULT'; },
};
for (const field of ['instanceId', 'enableGeneration', 'containerId', 'repoName', 'agentName', 'profile', 'alias']) {
    invalidScriptRuntimeEvidence[`stale ${field}`] = (o) => { o.activeGeneration.agents.documentKey[field] = 'stale'; };
    if (field !== 'alias') {
        invalidScriptRuntimeEvidence[`missing ${field}`] = (o) => { delete o.activeGeneration.agents.documentKey[field]; delete o.registry.documentKey[field]; };
    }
}
for (const [label, invalidate] of Object.entries(invalidScriptRuntimeEvidence)) {
    test(`script-ready runtime remains starting for ${label}`, () => {
        const options = activatedScriptRuntimeFixture();
        invalidate(options);
        assert.deepEqual(collectAgentRuntimeStates(options)[0].state, {
            status: 'starting', running: false, pid: 123,
        });
    });
}

test('routes-only evidence cannot declare a portless script runtime ready', () => {
    const options = activatedScriptRuntimeFixture();
    options.routes = options.activeGeneration.routing.routes;
    delete options.activeGeneration;
    assert.equal(collectAgentRuntimeStates(options)[0].state.running, false);
});
