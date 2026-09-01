import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    activatePreparedRuntimeAfterReadiness,
    runCliWithDependencies,
} from '../../cli/commands/workspaceUtil.js';
import {
    coordinateReplacementRuntimeIdentity,
} from '../../cli/sandbox/docker/agentServiceManager.js';
import {
    applyEdgeRoutingGeneration,
    commitAdditiveEdgeRoutingGeneration,
    loadActiveEdgeRoutingGeneration,
    prepareAdditiveEdgeRoutingGeneration,
    withEdgeGenerationApplyLock,
} from '../../cli/sandbox/edgeGeneration.js';

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createKeyedMaintenanceLock(events = []) {
    const tails = new Map();
    return async (key, _options, callback) => {
        const predecessor = tails.get(key) || Promise.resolve();
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        const tail = predecessor.then(() => held);
        tails.set(key, tail);
        await predecessor;
        events.push(['lock-enter', key]);
        try {
            return await callback();
        } finally {
            events.push(['lock-exit', key]);
            release();
            if (tails.get(key) === tail) tails.delete(key);
        }
    };
}

function createGenerationFixture(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-cli-concurrency-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    const agentDir = path.join(ploinkyDir, 'repos', 'fixtures', 'achilles-cli');
    const manifestPath = path.join(agentDir, 'manifest.json');
    const agentsFile = path.join(ploinkyDir, 'agents.json');
    const routingFile = path.join(ploinkyDir, 'routing.json');
    const containerName = 'achilles-cli-container';
    const manifest = {
        cli: '/Agent/default_cli.sh',
        readiness: { protocol: 'mcp' },
    };
    const predecessor = {
        type: 'agent',
        repoName: 'fixtures',
        agentName: 'achilles-cli',
        runtime: 'podman',
        containerImage: 'docker.io/assistos/ploinky-node:24-bookworm-tools',
        containerId: 'a'.repeat(64),
        instanceId: 'achilles-predecessor-instance',
        enableGeneration: 'achilles-predecessor-enable',
        auth: { mode: 'local' },
        config: { ports: [{ containerPort: 7000, hostPort: 43101, protocol: 'tcp' }] },
    };
    writeJson(manifestPath, manifest);
    writeJson(routingFile, {
        static: { agent: 'achilles-cli', port: 7777 },
        routes: {
            'achilles-cli': {
                repo: 'fixtures',
                agent: 'achilles-cli',
                container: containerName,
                hostPath: agentDir,
                hostPort: 43101,
            },
        },
    });
    writeJson(agentsFile, { [containerName]: predecessor });
    writeJson(path.join(edgeDir, 'desired.json'), { hosts: {} });
    writeJson(path.join(policyDir, 'policy-state.json'), {
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    });

    const previousRouterHostPort = process.env.PLOINKY_ROUTER_HOST_PORT;
    process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
    t.after(() => {
        if (previousRouterHostPort === undefined) delete process.env.PLOINKY_ROUTER_HOST_PORT;
        else process.env.PLOINKY_ROUTER_HOST_PORT = previousRouterHostPort;
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    const active = applyEdgeRoutingGeneration({
        workspaceRoot: workspace,
        reason: 'cli-concurrency-predecessor',
    });
    return {
        active,
        agentDir,
        agentsFile,
        containerName,
        edgeDir,
        manifest,
        manifestPath,
        ploinkyDir,
        predecessor,
        routingFile,
        workspace,
    };
}

test('overlapping CLI starts coalesce one replacement and both attach without an inactive selector', {
    timeout: 10_000,
}, async (t) => {
    const fixture = createGenerationFixture(t);
    const events = [];
    const selectorStates = [];
    const attachments = [];
    const outstandingLeases = new Set();
    const networkLifecycleCapability = Object.freeze({ fixture: 'network-lifecycle' });
    let replacementRequired = true;
    let replacementTransactions = 0;
    let validationOnlyAdoptions = 0;
    let activationCommits = 0;
    let predecessorRetirements = 0;
    let ensureCalls = 0;
    let readinessCalls = 0;
    let candidateContainerName = '';
    let releaseFirstReadiness;
    let markFirstReadinessEntered;
    const firstReadinessEntered = new Promise((resolve) => { markFirstReadinessEntered = resolve; });
    const firstReadinessGate = new Promise((resolve) => { releaseFirstReadiness = resolve; });

    const observeSelector = (label) => {
        const selector = loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }).selector;
        selectorStates.push(selector.state);
        events.push([label, selector.generation]);
        return selector;
    };
    const withWorkspaceApplyLock = (callback, options = {}) => withEdgeGenerationApplyLock(
        callback,
        { workspaceRoot: fixture.workspace, ...options },
    );
    const activateRuntimeAfterReadiness = async (request) => {
        observeSelector('activation-enter');
        const committed = await activatePreparedRuntimeAfterReadiness(request, {
            loadAgents: () => readJson(fixture.agentsFile),
            readRouting: () => readJson(fixture.routingFile),
            withApplyLock: withWorkspaceApplyLock,
            commitAdditive: (lease, options) => {
                activationCommits += 1;
                const result = commitAdditiveEdgeRoutingGeneration(lease, {
                    workspaceRoot: fixture.workspace,
                    ...options,
                });
                outstandingLeases.delete(lease.transactionId);
                return result;
            },
            retirePredecessor: (predecessor, options) => {
                predecessorRetirements += 1;
                assert.equal(options.networkLifecycleCapability, networkLifecycleCapability);
                assert.equal(predecessor.containerName, fixture.containerName);
                assert.equal(predecessor.containerId, fixture.predecessor.containerId);
                const committedAgents = readJson(fixture.agentsFile);
                assert.equal(committedAgents[fixture.containerName], undefined);
                assert.equal(committedAgents[candidateContainerName].containerId, 'b'.repeat(64));
                assert.equal(observeSelector('predecessor-retire').state, 'active');
                events.push(['retire', predecessor.containerName]);
                return { removed: true, state: 'removed' };
            },
        });
        observeSelector('activation-exit');
        return committed;
    };
    const dependencies = {
        env: { PLOINKY_NO_TTY: '1' },
        resolveEnabledAgentRecord: (name) => {
            const records = readJson(fixture.agentsFile);
            const match = Object.entries(records).find(([, record]) => (
                record?.type === 'agent'
                && record.repoName === 'fixtures'
                && (record.agentName === name || `fixtures/${record.agentName}` === name)
            ));
            return match ? { containerName: match[0], record: match[1] } : null;
        },
        findAgent: () => ({
            repo: 'fixtures',
            manifestPath: fixture.manifestPath,
            shortAgentName: 'achilles-cli',
        }),
        enableAgent: () => assert.fail('the fixture is already enabled'),
        readManifest: () => structuredClone(fixture.manifest),
        resolveRouterEndpointForManifest: () => ({
            mode: 'default',
            host: 'host.containers.internal',
            port: 18080,
            url: 'http://host.containers.internal:18080',
            env: {},
        }),
        admitRuntimeManifest: () => ({ runtimeAdmission: Object.freeze({ fixture: true }) }),
        ensureAgentService: (_agentName, _manifest, _agentDir, options) => {
            ensureCalls += 1;
            observeSelector('ensure');
            assert.equal(options.networkLifecycleCapability, networkLifecycleCapability);
            if (replacementRequired) {
                replacementRequired = false;
                replacementTransactions += 1;
                const rotated = coordinateReplacementRuntimeIdentity({
                    containerName: fixture.containerName,
                    existingRecord: readJson(fixture.agentsFile)[fixture.containerName],
                    reason: 'integration-contract-drift',
                    networkLifecycleCapability,
                    stageAlongsidePredecessor: true,
                }, {
                    assertNetworkCapability: (capability) => assert.equal(capability, networkLifecycleCapability),
                    loadRegistry: () => readJson(fixture.agentsFile),
                    loadRouting: () => readJson(fixture.routingFile),
                    withApplyLock: withWorkspaceApplyLock,
                    prepare: (prepareOptions) => prepareAdditiveEdgeRoutingGeneration({
                        workspaceRoot: fixture.workspace,
                        ...prepareOptions,
                    }),
                    uuid: (() => {
                        const values = ['achilles-candidate-instance', 'achilles-candidate-enable'];
                        return () => values.shift();
                    })(),
                });
                candidateContainerName = rotated.candidateContainerName;
                assert.notEqual(candidateContainerName, fixture.containerName);
                outstandingLeases.add(rotated.preparationLease.transactionId);
                const selector = observeSelector('prepared');
                assert.equal(selector.generation, fixture.active.selector.generation);
                return {
                    containerName: candidateContainerName,
                    containerId: 'b'.repeat(64),
                    hostPort: 43111,
                    createdByThisLaunch: true,
                    requiresEdgeActivation: true,
                    preparationLease: rotated.preparationLease,
                    registryRecord: {
                        ...rotated.preparedRegistryRecord,
                        runtime: 'podman',
                        containerImage: fixture.predecessor.containerImage,
                        containerId: 'b'.repeat(64),
                    },
                    replacementPredecessor: {
                        containerName: fixture.containerName,
                        containerId: fixture.predecessor.containerId,
                        runtimeNetwork: { mode: 'default' },
                        registryRecord: fixture.predecessor,
                    },
                };
            }
            validationOnlyAdoptions += 1;
            assert.equal(options.containerName, candidateContainerName);
            const current = readJson(fixture.agentsFile)[candidateContainerName];
            assert.equal(current.instanceId, 'achilles-candidate-instance');
            assert.equal(current.enableGeneration, 'achilles-candidate-enable');
            return {
                containerName: candidateContainerName,
                containerId: current.containerId,
                hostPort: 43111,
                createdByThisLaunch: false,
                requiresEdgeActivation: false,
                registryRecord: current,
            };
        },
        waitForAgentReady: async () => {
            readinessCalls += 1;
            observeSelector('readiness');
            if (readinessCalls === 1) {
                markFirstReadinessEntered();
                await firstReadinessGate;
            }
            return true;
        },
        activateRuntimeAfterReadiness,
        loadAgentsMap: () => readJson(fixture.agentsFile),
        withMaintenanceLock: createKeyedMaintenanceLock(events),
        withNetworkLifecycleLock: (callback) => callback(networkLifecycleCapability),
        attachInteractive: (containerName) => {
            attachments.push(containerName);
            events.push(['attach', containerName]);
            return 0;
        },
        getAgentContainerName: () => fixture.containerName,
        projectPath: '/workspace',
    };

    const first = runCliWithDependencies('achilles-cli', [], dependencies);
    await firstReadinessEntered;
    const second = runCliWithDependencies('achilles-cli', [], dependencies);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ensureCalls, 1, 'the overlapping start must wait on the same runtime key');
    assert.deepEqual(selectorStates, selectorStates.map(() => 'active'));

    releaseFirstReadiness();
    assert.deepEqual(await Promise.all([first, second]), [0, 0]);

    const finalActive = observeSelector('final');
    const finalAgents = readJson(fixture.agentsFile);
    const finalRecord = finalAgents[candidateContainerName];
    assert.equal(replacementTransactions, 1);
    assert.equal(validationOnlyAdoptions, 1);
    assert.equal(activationCommits, 1);
    assert.equal(predecessorRetirements, 1);
    assert.equal(readinessCalls, 2);
    assert.deepEqual(attachments, [candidateContainerName, candidateContainerName]);
    assert.deepEqual(selectorStates, selectorStates.map(() => 'active'));
    assert.notEqual(finalActive.generation, fixture.active.selector.generation);
    assert.equal(finalRecord.instanceId, 'achilles-candidate-instance');
    assert.equal(finalRecord.enableGeneration, 'achilles-candidate-enable');
    assert.equal(finalRecord.containerId, 'b'.repeat(64));
    assert.equal(finalAgents[fixture.containerName], undefined);
    assert.equal(outstandingLeases.size, 0);
    assert.equal(fs.existsSync(path.join(fixture.edgeDir, 'preparation-lease.json')), false);
});

test('maintenance coalescing does not conflate unrelated runtime identities', {
    timeout: 5_000,
}, async () => {
    const records = {
        'alpha-container': {
            type: 'agent',
            repoName: 'fixtures',
            agentName: 'alpha',
            runtime: 'podman',
            containerImage: 'fixture:alpha',
        },
        'beta-container': {
            type: 'agent',
            repoName: 'fixtures',
            agentName: 'beta',
            runtime: 'podman',
            containerImage: 'fixture:beta',
        },
    };
    const attachments = [];
    let readinessEntered = 0;
    let markBothEntered;
    let releaseReadiness;
    const bothEntered = new Promise((resolve) => { markBothEntered = resolve; });
    const readinessGate = new Promise((resolve) => { releaseReadiness = resolve; });
    const dependencies = {
        env: { PLOINKY_NO_TTY: '1' },
        resolveEnabledAgentRecord: (name) => {
            const entry = Object.entries(records).find(([, record]) => record.agentName === name);
            return entry ? { containerName: entry[0], record: entry[1] } : null;
        },
        findAgent: (reference) => {
            const shortAgentName = String(reference).split('/').pop();
            return {
                repo: 'fixtures',
                manifestPath: `/fixtures/${shortAgentName}/manifest.json`,
                shortAgentName,
            };
        },
        enableAgent: () => assert.fail('both fixtures are already enabled'),
        readManifest: () => ({ cli: '/Agent/default_cli.sh', readiness: { protocol: 'mcp' } }),
        resolveRouterEndpointForManifest: () => ({ mode: 'default', host: 'router', port: 18080, url: 'http://router:18080', env: {} }),
        admitRuntimeManifest: () => ({ runtimeAdmission: Object.freeze({ fixture: true }) }),
        ensureAgentService: (agentName) => {
            const containerName = `${agentName}-container`;
            return {
                containerName,
                containerId: agentName.repeat(64).slice(0, 64),
                hostPort: agentName === 'alpha' ? 43121 : 43122,
                createdByThisLaunch: false,
                requiresEdgeActivation: false,
                registryRecord: records[containerName],
            };
        },
        waitForAgentReady: async () => {
            readinessEntered += 1;
            if (readinessEntered === 2) markBothEntered();
            await readinessGate;
            return true;
        },
        activateRuntimeAfterReadiness: async () => false,
        loadAgentsMap: () => structuredClone(records),
        withMaintenanceLock: createKeyedMaintenanceLock(),
        withNetworkLifecycleLock: (callback) => callback(Object.freeze({ fixture: true })),
        attachInteractive: (containerName) => {
            attachments.push(containerName);
            return 0;
        },
        getAgentContainerName: (agentName) => `${agentName}-container`,
        projectPath: '/workspace',
    };

    const alpha = runCliWithDependencies('alpha', [], dependencies);
    const beta = runCliWithDependencies('beta', [], dependencies);
    const enteredConcurrently = await Promise.race([
        bothEntered.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    releaseReadiness();
    await Promise.all([alpha, beta]);

    assert.equal(enteredConcurrently, true);
    assert.equal(readinessEntered, 2);
    assert.deepEqual(attachments.sort(), ['alpha-container', 'beta-container']);
});
