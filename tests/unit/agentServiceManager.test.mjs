import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    appendExactManagedBindMount,
    assertPreparedRegistryRecordPreservation,
    buildBoxPodmanHostArgs,
    buildRuntimeNetworkPlan,
    buildRuntimeRouterEnv,
    ensureAgentService,
    expectedBindMountsFromArgs,
    hasExactManagedEnv,
    hasExactManagedMountContract,
    isGenerationCapabilityRuntimeEffective,
    restartGenerationCapabilityRuntime,
    replaceRuntimeRouterEnvFlags,
    stripReservedAndRestoreRuntimeRouterEnvFlags,
} from '../../cli/sandbox/docker/agentServiceManager.js';
import { buildRouterEndpoint } from '../../cli/sandbox/routerPort.js';
import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';

function boxMarkerFs(contents = BOX_MARKER_CONTENT) {
    return {
        lstatSync() {
            return {
                isFile: () => true,
                isSymbolicLink: () => false,
                nlink: 1,
            };
        },
        readFileSync() {
            return Buffer.from(contents);
        },
    };
}

test('Box host-gateway compatibility does not duplicate the managed network mapping', () => {
    const fsApi = boxMarkerFs();
    for (const network of [
        { mode: 'default' },
        { mode: 'bridge', attachments: [{ name: 'front', primary: true }] },
    ]) {
        const plan = buildRuntimeNetworkPlan('podman', network);
        assert.equal(plan.requiresManagedNetwork, true);
        assert.deepEqual(buildBoxPodmanHostArgs({
            fsApi,
            markerPath: '/probe/ploinky-box',
            managedNetwork: plan.requiresManagedNetwork,
        }), []);
    }

    const hostPlan = buildRuntimeNetworkPlan('podman', { mode: 'host' });
    assert.deepEqual(buildBoxPodmanHostArgs({
        fsApi,
        markerPath: '/probe/ploinky-box',
        managedNetwork: hostPlan.requiresManagedNetwork === true,
    }), ['--add-host', 'host.containers.internal:host-gateway']);

    assert.throws(() => buildBoxPodmanHostArgs({
        fsApi: boxMarkerFs('wrong\n'),
        markerPath: '/probe/ploinky-box',
        managedNetwork: true,
    }), /marker has invalid content/i);
});

test('prepared graph launches suppress intermediate registry persistence only for the exact staged identity', () => {
    const staged = {
        instanceId: 'instance-current',
        enableGeneration: 'enable-current',
    };
    for (const ownerRef of ['repo/non-host-dependency', 'media/livekit']) {
        assert.equal(assertPreparedRegistryRecordPreservation(staged, {
            preservePreparedRegistryRecord: true,
            instanceId: staged.instanceId,
            enableGeneration: staged.enableGeneration,
        }, { ownerRef }), true);
    }
    assert.equal(assertPreparedRegistryRecordPreservation(staged, {}, {
        ownerRef: 'repo/ordinary-enable',
    }), false);
    assert.throws(
        () => assertPreparedRegistryRecordPreservation(staged, {
            preservePreparedRegistryRecord: true,
            instanceId: staged.instanceId,
            enableGeneration: 'stale-enable',
        }, { ownerRef: 'media/livekit' }),
        /exact staged instanceId\/enableGeneration/,
    );
    assert.throws(
        () => assertPreparedRegistryRecordPreservation({}, {
            preservePreparedRegistryRecord: true,
        }, { ownerRef: 'repo/non-host-dependency' }),
        /exact staged instanceId\/enableGeneration/,
    );

    const source = fs.readFileSync(new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url), 'utf8');
    assert.match(source, /const preserveRuntimeRegistryRecord = Boolean\(targetedRestart\)[\s\S]*Boolean\(runtimeIdentity\.preparationLease\)/);
    assert.match(source, /preserveRegistryRecord:\s*preserveRuntimeRegistryRecord/);
    assert.match(source, /if \(!preserveRuntimeRegistryRecord\) saveAgentsMap\(agents\)/);
    assert.match(source, /registryRecord:\s*structuredClone\(agents\[containerName\]\)/);
    assert.match(source, /stagedRegistryRecord:\s*structuredClone\(stagedRegistryRecord\)/);
    assert.match(source, /returning early \(container exists\)[\s\S]*createdByThisLaunch:\s*false/);
    assert.match(source, /runtimeNetwork:\s*structuredClone\(manifestNetwork\),[\s\S]*createdByThisLaunch:\s*!adoptedExistingRuntime/);
    assert.match(source, /createdByThisLaunch:\s*started\?\.createdByThisLaunch !== false/);
    assert.match(source, /const registryRecord = \{\s*\.\.\.existingRecord,\s*runtime,\s*containerId: reuseInspection\.id,/);
    assert.match(source, /type: 'agent',\s*runtime,\s*containerId: started\.containerId,/);
    assert.match(source, /physical runtime admission returned no complete AgentLib proof/);
    assert.match(source, /agentLib:\s*structuredClone\(startedRecord\.agentLib\)/);
    assert.match(source, /agentLibAttestation:\s*structuredClone\(startedRecord\.agentLibAttestation\)/);
    assert.match(source, /ensureAgentLibCacheLink\(\s*path\.dirname\(preparedNodeModulesDir\),\s*containerAgentLibGrant\.runtimePath,\s*\)/);
    assert.match(source, /ensureImagePresent\(ROUTER_AUTHORITY_HELPER_IMAGE, \{ runtime \}\);[\s\S]*helperImage:\s*ROUTER_AUTHORITY_HELPER_IMAGE/);
    assert.match(source, /assertHostModeGenerationCapability\(\{[\s\S]*containerName,\s*\}, \{ preparedCapability: options\.preparedHostModeCapability \}\)/);

    for (const runtime of ['bwrap', 'seatbelt']) {
        const runtimeSource = fs.readFileSync(
            new URL(`../../cli/sandbox/${runtime}/${runtime}ServiceManager.js`, import.meta.url),
            'utf8',
        );
        assert.match(runtimeSource, /preservePreparedRegistryRecord:\s*options\.preservePreparedRegistryRecord/);
        assert.match(runtimeSource, /registryRecord:\s*structuredClone\(agents\[containerName\]\)/);
    }
});

test('runtime creation cleans fixed control artifacts only after predecessor handling', () => {
    const source = fs.readFileSync(
        new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url),
        'utf8',
    );
    const createStart = source.indexOf('const createContainer = (plan, launch) => {');
    const cleanup = source.indexOf('prepareHealthProbeHostDirForLaunch(containerName);', createStart);
    const runtimeCreate = source.indexOf('const res = spawnSync(runtime, createArgs', createStart);
    assert.ok(createStart >= 0);
    assert.ok(cleanup > createStart);
    assert.ok(runtimeCreate > cleanup);
});

test('effective generation capability requires the exact managed runtime to be running', () => {
    const owner = {
        agentId: 'agent:repo/livekit',
        instanceId: 'instance-current',
        enableGeneration: 'enable-current',
        routeKey: 'livekit',
        containerName: 'livekit-container',
    };
    const generation = {
        compiled: { security: { hostNetworkCapabilities: [owner] } },
        routing: {
            routes: {
                livekit: {
                    container: owner.containerName,
                    hostPath: '/workspace/.ploinky/repos/repo/livekit',
                },
            },
        },
        manifests: {
            livekit: { network: { mode: 'host' } },
        },
        agents: {
            [owner.containerName]: {
                type: 'agent',
                repoName: 'repo',
                agentName: 'livekit',
                instanceId: owner.instanceId,
                enableGeneration: owner.enableGeneration,
            },
        },
    };
    const neverInspect = () => assert.fail('non-running runtime must not be inspected');
    assert.equal(isGenerationCapabilityRuntimeEffective({ generation, owner }, {
        exists: () => false,
        isRunning: () => false,
        inspectContainerContract: neverInspect,
    }), false);
    assert.equal(isGenerationCapabilityRuntimeEffective({ generation, owner }, {
        exists: () => true,
        isRunning: () => false,
        inspectContainerContract: neverInspect,
    }), false);
    assert.equal(isGenerationCapabilityRuntimeEffective({ generation, owner }, {
        exists: () => true,
        isRunning: () => true,
        inspectContainerContract: () => ({ state: 'foreign' }),
    }), false);
    assert.equal(isGenerationCapabilityRuntimeEffective({ generation, owner }, {
        exists: () => true,
        isRunning: () => true,
        inspectContainerContract: (containerName, _network, agentName, options) => {
            assert.equal(containerName, owner.containerName);
            assert.equal(agentName, 'livekit');
            assert.equal(options.instanceId, owner.instanceId);
            assert.equal(options.enableGeneration, owner.enableGeneration);
            assert.equal(options.requireRuntimeIdentity, true);
            return { state: 'exact', id: 'candidate-current' };
        },
    }), true);
    assert.equal(isGenerationCapabilityRuntimeEffective({ generation, owner }, {
        exists: () => true,
        isRunning: () => true,
        inspectContainerContract: () => ({ state: 'owned-drift', reason: 'runtime-identity' }),
    }), false);
});

test('targeted capability restart cannot activate before exact semantic readiness succeeds', () => {
    const owner = {
        agentId: 'agent:media/livekit',
        instanceId: 'instance-current',
        enableGeneration: 'enable-current',
        routeKey: 'livekit',
        containerName: 'livekit-container',
    };
    const generation = {
        compiled: { security: { hostNetworkCapabilities: [owner] } },
        routing: {
            routes: {
                livekit: { container: owner.containerName, hostPath: '/code/livekit' },
            },
        },
        manifests: {
            livekit: {
                network: { mode: 'host' },
                health: { readiness: { script: 'healthcheck.sh' } },
            },
        },
        agents: {
            [owner.containerName]: {
                type: 'agent',
                repoName: 'media',
                agentName: 'livekit',
                instanceId: owner.instanceId,
                enableGeneration: owner.enableGeneration,
            },
        },
    };
    let readinessCalls = 0;
    const cleanupCalls = [];
    const networkLifecycleCapability = Object.freeze({ test: 'network-lifecycle' });
    const assertLifecycleCapability = (capability) => {
        assert.equal(capability, networkLifecycleCapability);
    };
    assert.throws(() => restartGenerationCapabilityRuntime({
        generation,
        owner,
        affectedSelectors: ['media:agent:media/livekit'],
        assertSelectorsInactive: () => true,
        preparedHostModeCapability: Object.freeze({}),
        networkLifecycleCapability,
    }, {
        resolveProfile: () => ({ network: { mode: 'host' }, resolvedProfileName: 'default' }),
        resolveReadinessProtocol: () => 'script',
        ensureService: () => ({
            containerName: owner.containerName,
            containerId: 'candidate-current',
        }),
        isRunning: () => true,
        runScriptReadiness: () => {
            readinessCalls += 1;
            return { status: 'failed', reason: 'udp owner mismatch' };
        },
        removeCandidate: (candidate) => {
            cleanupCalls.push(candidate);
            return { removed: true };
        },
        assertLifecycleCapability,
    }), /semantic readiness failed.*udp owner mismatch/);
    assert.equal(readinessCalls, 1);
    assert.equal(cleanupCalls.length, 1);
    assert.equal(cleanupCalls[0].containerName, owner.containerName);
    assert.equal(cleanupCalls[0].containerId, 'candidate-current');
    assert.deepEqual(cleanupCalls[0].record, generation.agents[owner.containerName]);
    assert.equal(cleanupCalls[0].network.mode, 'host');

    assert.deepEqual(restartGenerationCapabilityRuntime({
        generation,
        owner,
        affectedSelectors: ['media:agent:media/livekit'],
        assertSelectorsInactive: () => true,
        preparedHostModeCapability: Object.freeze({}),
        networkLifecycleCapability,
    }, {
        resolveProfile: () => ({ network: { mode: 'host' }, resolvedProfileName: 'default' }),
        resolveReadinessProtocol: () => 'script',
        ensureService: () => ({
            containerName: owner.containerName,
            containerId: 'candidate-ready',
            marker: 'ready',
        }),
        isRunning: () => true,
        runScriptReadiness: () => ({ status: 'success' }),
        removeCandidate: () => assert.fail('ready candidate must not be removed'),
        assertLifecycleCapability,
    }), {
        containerName: owner.containerName,
        containerId: 'candidate-ready',
        marker: 'ready',
    });
});

test('managed Docker identity derivation is a fail-closed launch precondition', () => {
    const source = fs.readFileSync(new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url), 'utf8');
    assert.equal((source.match(/buildAgentPrincipalEnv\(/g) || []).length, 1);
    assert.equal((source.match(/buildAgentCredentialEnv\(/g) || []).length, 2);
    assert.doesNotMatch(source, /could not set agent identity/);
    assert.match(source, /Only non-secret principal fields exist before topology attestation/);
    assert.match(source, /generationLease\.checkpoint\('pre-credentials'\)[\s\S]*?signGeneratedRouterDescriptorEnvelope\(payload\)[\s\S]*?buildAgentCredentialEnv\(principalId, runtimeIdentity\)/);
    assert.match(source, /computeSemanticEnvHash[\s\S]*PLOINKY_ROUTER_SEMANTIC_TOPOLOGY_DIGEST[\s\S]*PLOINKY_AGENT_ENABLE_GENERATION/);
    assert.match(source, /canReuseExisting && runtimeNetworkPlan\.requiresManagedNetwork[\s\S]*prepareEdgeRoutingGenerationRaw/);
});

test('managed semantic adoption requires exact mounts and singleton generated env values', () => {
    const descriptor = '/tmp/router-descriptor.json';
    const mounts = expectedBindMountsFromArgs([
        'run', '-v', '/tmp/agent:/Agent:ro',
        '-v', '/tmp/code:/code:rw',
    ], descriptor);
    const record = {
        Mounts: mounts.map((mount) => ({
            Type: 'bind',
            Source: mount.source,
            Destination: mount.destination,
            RW: mount.rw,
        })),
        Config: {
            Env: ['PLOINKY_AGENT_API_KEY=exact-key', 'PLOINKY_ROUTER_URL=http://router.invalid'],
        },
    };
    assert.equal(hasExactManagedMountContract(record, mounts), true);
    assert.equal(hasExactManagedEnv(record, {
        PLOINKY_AGENT_API_KEY: 'exact-key',
        PLOINKY_ROUTER_URL: 'http://router.invalid',
    }), true);

    const writableDescriptor = structuredClone(record);
    writableDescriptor.Mounts.at(-1).RW = true;
    assert.equal(hasExactManagedMountContract(writableDescriptor, mounts), false);

    const extraMount = structuredClone(record);
    extraMount.Mounts.push({ Type: 'bind', Source: '/tmp/extra', Destination: '/extra', RW: false });
    assert.equal(hasExactManagedMountContract(extraMount, mounts), false);

    const duplicateCredential = structuredClone(record);
    duplicateCredential.Config.Env.push('PLOINKY_AGENT_API_KEY=attacker-key');
    assert.equal(hasExactManagedEnv(duplicateCredential, { PLOINKY_AGENT_API_KEY: 'exact-key' }), false);
});

test('managed manifest binds collapse only an exact duplicate and reject target conflicts', () => {
    const args = ['run', '-v', '/workspace:/workspace:z'];
    assert.equal(appendExactManagedBindMount(args, '/workspace:/workspace:z'), false);
    assert.deepEqual(args, ['run', '-v', '/workspace:/workspace:z']);

    assert.throws(
        () => appendExactManagedBindMount(args, '/other:/workspace:z'),
        /target '\/workspace' has conflicting bind grants/,
    );
    assert.throws(
        () => appendExactManagedBindMount(args, '/workspace:/workspace:z,ro'),
        /target '\/workspace' has conflicting bind grants/,
    );

    assert.equal(appendExactManagedBindMount(args, '/data:/data:z'), true);
    assert.deepEqual(args.slice(-2), ['-v', '/data:/data:z']);
});

test('container router env builder preserves endpoint parity for every network mode', () => {
    for (const mode of ['default', 'bridge', 'host']) {
        const endpoint = buildRouterEndpoint(mode, 8080);
        const env = buildRuntimeRouterEnv('podman', {
            networkMode: mode,
            routerEndpoint: endpoint,
            routerPort: 8080,
        });
        assert.deepEqual({
            PLOINKY_ROUTER_HOST: env.PLOINKY_ROUTER_HOST,
            PLOINKY_ROUTER_PORT: env.PLOINKY_ROUTER_PORT,
            PLOINKY_ROUTER_URL: env.PLOINKY_ROUTER_URL,
        }, endpoint.env);
        assert.equal(env.PLOINKY_ROUTER_AUTHORITY, '127.0.0.1:8080');
        assert.equal(env.PLOINKY_INTERNAL_ROUTER_URL, `http://${endpoint.host}:8081`);
        assert.equal(typeof env.PLOINKY_EDGE_TOPOLOGY_FILE, 'string');
        assert.notEqual(env.PLOINKY_EDGE_TOPOLOGY_FILE, '');
    }
    assert.deepEqual(buildRuntimeRouterEnv('podman', {
        networkMode: 'none',
        routerEndpoint: null,
        routerPort: 'not-a-port',
    }), {});
});

test('ensureAgentService requires callers to pass a resolved endpoint or explicit null', () => {
    for (const options of [undefined, {}, { routerEndpoint: undefined }, 49123]) {
        assert.throws(
            () => ensureAgentService('agent', { network: { mode: 'none' } }, '/tmp/repo/agent', options),
            { code: 'PLOINKY_ROUTER_ENDPOINT_REQUIRED' },
        );
    }
});

test('container router env builder has no default, reread, or host override path', () => {
    assert.throws(
        () => buildRuntimeRouterEnv('podman', { networkMode: 'bridge' }),
        { code: 'PLOINKY_ROUTER_ENDPOINT_REQUIRED' },
    );
    assert.throws(
        () => buildRuntimeRouterEnv('podman', {
            networkMode: 'bridge',
            routerEndpoint: buildRouterEndpoint('bridge', 8080),
            routerPort: 8097,
        }),
        { code: 'PLOINKY_ROUTER_PORT_INVALID' },
    );
    assert.throws(
        () => buildRuntimeRouterEnv('podman', {
            networkMode: 'bridge',
            routerEndpoint: buildRouterEndpoint('bridge', 8080),
            routerHost: 'host.docker.internal',
        }),
        /routerHost overrides are not supported/,
    );
});

test('runtime router env replaces config values and none mode strips them entirely', () => {
    const supplied = [
        '-e SAFE="kept"',
        '-e PLOINKY_ROUTER_HOST="profile.invalid"',
        '-e PLOINKY_ROUTER_PORT="1"',
        '-e PLOINKY_ROUTER_URL="http://secret.invalid:1"',
    ];
    replaceRuntimeRouterEnvFlags(supplied, {});
    assert.deepEqual(supplied, ['-e SAFE="kept"']);

    const endpoint = buildRouterEndpoint('default', 8080);
    replaceRuntimeRouterEnvFlags(supplied, endpoint.env);
    assert.equal(supplied[0], '-e SAFE="kept"');
    for (const [name, value] of Object.entries(endpoint.env)) {
        assert.deepEqual(
            supplied.filter((entry) => entry.startsWith(`-e ${name}=`)),
            [`-e ${name}="${value}"`],
        );
    }
});

test('reserved env filtering restores only the runtime-owned Router authority', () => {
    const supplied = [
        '-e SAFE="kept"',
        '-e PLOINKY_MASTER_KEY="must-be-removed"',
        '-e PLOINKY_ROUTER_URL="http://manifest.invalid:1"',
        '-e PLOINKY_ROUTER_AUTHORITY="attacker.invalid:1"',
        '-e PLOINKY_AGENT_ID="agent:forged/identity"',
    ];
    const runtimeRouterEnv = buildRuntimeRouterEnv('podman', {
        networkMode: 'bridge',
        routerEndpoint: buildRouterEndpoint('bridge', 8080),
        routerPort: 8080,
    });

    stripReservedAndRestoreRuntimeRouterEnvFlags(supplied, runtimeRouterEnv);

    assert.equal(supplied.includes('-e SAFE="kept"'), true);
    assert.equal(supplied.some((entry) => entry.startsWith('-e PLOINKY_MASTER_KEY=')), false);
    assert.equal(supplied.some((entry) => entry.startsWith('-e PLOINKY_AGENT_ID=')), false);
    for (const [name, value] of Object.entries(runtimeRouterEnv)) {
        assert.deepEqual(
            supplied.filter((entry) => entry.startsWith(`-e ${name}=`)),
            [`-e ${name}="${value}"`],
        );
    }
});

test('existing-container ownership inspection is unconditional across network modes', () => {
    const source = fs.readFileSync(new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bresolveRouterEndpoint\s*\(/, 'service manager must not reread persisted routing state');
    assert.match(source, /const networkLifecycle = createNetworkLifecycleAdapter\(\{ runtime \}\);[\s\S]*?if \(containerExists\(containerName\)\) \{\s+const contractInspection = networkLifecycle\.inspectContainerContract/);
    assert.doesNotMatch(source, /if \(containerExists\(containerName\) && managedNetworkLifecycle\)/);
    assert.match(source, /else if \(!isContainerRunning\(containerName\)\)/);
    assert.match(source, /recreateReason \|\|= 'runtimeStopped'/);
    assert.match(source, /reuseInspection\.id !== inspectedContainerId/);
    assert.match(source, /recreateReason \|\|= 'runtimeStoppedAfterInspection'/);
    assert.match(source, /recreateReason \|\|= 'runtimeDisappearedAfterInspection'/);
    assert.doesNotMatch(source, /execSync\(`\$\{runtime\} start \$\{containerName\}`/);
});

test('drain-aware replacement is explicit and does not rewrite ordinary fleet lifecycle', () => {
    const managerSource = fs.readFileSync(new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url), 'utf8');
    const fleetSource = fs.readFileSync(new URL('../../cli/sandbox/docker/containerFleet.js', import.meta.url), 'utf8');
    const drainSource = fs.readFileSync(new URL('../../cli/sandbox/docker/targetedContainerLifecycle.js', import.meta.url), 'utf8');

    assert.match(managerSource, /const targetedRestart = normalizeTargetedRestart\(options\.targetedRestart\)/);
    assert.match(managerSource, /if \(targetedRestart\) \{[\s\S]*drainTargetedContainer\(containerName, drainOptions\)/);
    assert.match(managerSource, /if \(runtimeNetworkPlan\.requiresManagedNetwork\)[\s\S]*drainTargetedContainer[\s\S]*else \{[\s\S]*drainAndRemoveTargetedContainer/);
    assert.doesNotMatch(fleetSource, /targetedContainerLifecycle|drainTargetedContainer|targetedRestart/);
    assert.doesNotMatch(drainSource, /inactivateEdgeRoutingGeneration/);
    assert.match(
        managerSource,
        /combinedInstallCmd} && exec sh \/Agent\/server\/AgentServer\.sh/,
        'the default server must replace the transient installer shell before it can acknowledge targeted drain',
    );
});

test('fleet cleanup never expands an exact registry key to a derived alias or canonical name', () => {
    const source = fs.readFileSync(new URL('../../cli/sandbox/docker/containerFleet.js', import.meta.url), 'utf8');
    assert.match(source, /return name \? \[name\] : \[\]/);
    assert.doesNotMatch(source, /getAgentContainerName/);
});

test('targeted restart contract cannot be enabled implicitly', () => {
    for (const targetedRestart of [true, {}, {
        acknowledgement: 'exit-zero-after-drain',
        affectedSelectors: ['service:route/editor'],
    }]) {
        assert.throws(
            () => ensureAgentService(
                'agent',
                { network: { mode: 'none' } },
                '/tmp/repo/agent',
                { routerEndpoint: null, targetedRestart },
            ),
            /targetedRestart/,
        );
    }
});
