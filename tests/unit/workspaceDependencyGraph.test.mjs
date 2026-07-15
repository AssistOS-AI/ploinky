import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-graph-'));

function writeManifest(repoName, agentName, manifest) {
    const agentDir = path.join(tempDir, '.ploinky', 'repos', repoName, agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
        path.join(agentDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2)
    );
}

function writeEnabledRepos(repoNames = []) {
    const file = path.join(tempDir, '.ploinky', 'enabled_repos.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(repoNames, null, 2));
}

function clearEnabledRepos() {
    fs.rmSync(path.join(tempDir, '.ploinky', 'enabled_repos.json'), { force: true });
}

process.chdir(tempDir);

const moduleSuffix = `?test=${Date.now()}`;
const graphModuleUrl = new URL('../../cli/services/workspaceDependencyGraph.js', import.meta.url);
const graphModule = await import(`${graphModuleUrl.href}${moduleSuffix}`);
const bootstrapModuleUrl = new URL('../../cli/services/bootstrapManifest.js', import.meta.url);
const bootstrapModule = await import(`${bootstrapModuleUrl.href}${moduleSuffix}`);
const {
    classifyDependencyGraphWaitMode,
    createGraphNodeId,
    parseManifestDependencyRef,
    resolveEnabledAgentRegistryRecord,
    resolveWorkspaceDependencyGraph,
    topologicallyGroupDependencyGraph
} = graphModule;
const { applyManifestDirectives, parseEnableDirective } = bootstrapModule;
const workspaceUtilModuleUrl = new URL('../../cli/services/workspaceUtil.js', import.meta.url);
const {
    buildBlockingReadinessEntryFromNode,
    ensureGraphNodesEnabled,
    reinstallAgent,
    resolveGraphNodeExecutionRecord,
    resolveManifestRouterEndpoint,
    runCli,
    runShell,
    startWorkspace,
    waitForReadinessEntries,
} = await import(`${workspaceUtilModuleUrl.href}${moduleSuffix}`);

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('parseManifestDependencyRef strips mode and alias syntax down to the agent reference', () => {
    assert.equal(parseManifestDependencyRef('gitAgent global'), 'gitAgent');
    assert.equal(parseManifestDependencyRef('basic/keycloak as auth'), 'basic/keycloak');
    assert.equal(parseManifestDependencyRef('repo/agent:dev'), 'repo/agent');
});

test('resolveEnabledAgentRegistryRecord matches core direct, alias, canonical, and ambiguity semantics', () => {
    const registry = {
        _config: { static: { agent: 'demo/shared' } },
        blue_container: {
            type: 'agent', repoName: 'demo', agentName: 'shared', alias: 'blue', profile: 'dev',
        },
        green_container: {
            type: 'agent', repoName: 'demo', agentName: 'shared', alias: 'green', profile: 'prod',
        },
        solo_container: {
            type: 'agent', repoName: 'demo', agentName: 'solo', profile: 'prod',
        },
    };

    assert.equal(resolveEnabledAgentRegistryRecord('blue_container', registry).containerName, 'blue_container');
    assert.equal(resolveEnabledAgentRegistryRecord('blue', registry).record.profile, 'dev');
    assert.equal(resolveEnabledAgentRegistryRecord('demo/solo', registry).containerName, 'solo_container');
    assert.throws(
        () => resolveEnabledAgentRegistryRecord('demo/shared', registry),
        (error) => error.code === 'AGENT_ALIAS_AMBIGUOUS'
            && /Use alias: blue, green/.test(error.message),
    );
});

test('resolveWorkspaceDependencyGraph collects recursive dependencies and preserves aliases', () => {
    writeManifest('demo', 'leaf', { container: 'node:20-alpine' });
    writeManifest('demo', 'dep', {
        container: 'node:20-alpine',
        enable: ['leaf']
    });
    writeManifest('demo', 'sidecar', { container: 'node:20-alpine' });
    writeManifest('demo', 'app', {
        container: 'node:20-alpine',
        enable: ['dep', 'sidecar as media']
    });

    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'demo/app' });
    const waveIds = topologicallyGroupDependencyGraph(graph);

    assert.equal(graph.staticNodeId, 'demo/app');
    assert.ok(graph.nodes.has('demo/leaf'));
    assert.ok(graph.nodes.has('demo/dep'));
    assert.ok(graph.nodes.has('demo/sidecar as media'));
    assert.deepEqual(waveIds, [
        ['demo/leaf', 'demo/sidecar as media'],
        ['demo/dep'],
        ['demo/app']
    ]);
    assert.deepEqual(
        Array.from(graph.nodes.get('demo/app').dependencies).sort(),
        ['demo/dep', 'demo/sidecar as media']
    );
});

test('a failed blocking script readiness probe prevents the next dependency wave', async () => {
    const startedWaves = [];
    const waves = [
        [{
            id: 'demo/database',
            shortAgentName: 'database',
            isStatic: false,
            manifest: {
                start: 'postgres',
                health: { readiness: { script: 'healthcheck.sh', failureThreshold: 1 } },
            },
            route: { container: 'database-container', hostPort: 0 },
        }],
        [{
            id: 'demo/api',
            shortAgentName: 'api',
            isStatic: false,
            manifest: { readiness: { protocol: 'none' } },
            route: { container: 'api-container', hostPort: 0 },
        }],
    ];

    await assert.rejects(async () => {
        for (let waveIndex = 0; waveIndex < waves.length; waveIndex += 1) {
            startedWaves.push(waveIndex);
            const entries = waves[waveIndex].map((node) => (
                buildBlockingReadinessEntryFromNode(node, node.route, 'app')
            ));
            await waitForReadinessEntries(entries, {
                runContainerScriptReadinessImpl() {
                    return { status: 'failed', reason: 'exit 1', detail: 'database unavailable' };
                },
            });
        }
    }, /database unavailable/);

    assert.deepEqual(startedWaves, [0]);
});

test('start workspace clears a stale host port when start-only readiness resolves no route', () => {
    assert.match(
        startWorkspace.toString(),
        /if \(!resolvedHostPort\) delete nextRoute\.hostPort/,
    );
});

test('start workspace forwards each dependency registry profile to its synchronous service launch', () => {
    assert.match(
        startWorkspace.toString(),
        /ensureAgentService\(shortAgentName,[\s\S]*?profileName:\s*rec\.profile\s*\|\|\s*undefined/,
    );
});

test('blocking none-mode launches pass explicit null without forwarding a raw router port', () => {
    assert.equal(resolveManifestRouterEndpoint({ network: { mode: 'none' } }, {
        explicitPort: 'not-a-port',
        path: 'manifest(demo/offline)',
    }), null);

    const source = startWorkspace.toString();
    const launchStart = source.indexOf('const { containerName, hostPort, additionalServerPort } = ensureAgentService');
    const launchEnd = source.indexOf('const executionMode = resolveAgentExecutionMode', launchStart);
    assert.ok(launchStart >= 0 && launchEnd > launchStart, 'blocking service launch must remain discoverable');
    const launch = source.slice(launchStart, launchEnd);
    assert.match(launch, /routerEndpoint/);
    assert.doesNotMatch(launch, /routerPort/);

    const reinstall = reinstallAgent.toString();
    assert.match(reinstall, /const routerPort = resolvePersistedRouterPort\(\)/);
    assert.match(reinstall, /resolveManifestRouterEndpoint\(manifest, \{\s*explicitPort: routerPort,/);
    assert.match(reinstall, /routerEndpoint,/);
    assert.match(reinstall, /cfg\.port = routerPort/);
    assert.match(reinstall, /if \(!isRouterUp\(routerPort\)\)/);
    assert.doesNotMatch(reinstall, /if \(routerEndpoint && !isRouterUp/);
});

test('workspace publication preflights receive the already resolved router port', () => {
    assert.match(
        startWorkspace.toString(),
        /preflightBoxPublicationForCommand\('start', preflightArgs, \{\s*routerPort: resolvedStartPort/,
    );
    for (const [command, fn] of [
        ['cli', runCli],
        ['shell', runShell],
        ['reinstall', reinstallAgent],
    ]) {
        const source = fn.toString();
        assert.match(source, /const routerPort = resolvePersistedRouterPort\(\)/);
        assert.match(source, new RegExp(`preflightBoxPublicationForCommand\\('${command}'[\\s\\S]*?\\{ routerPort \\}\\)`));
    }
});

test('workspace publication preflight reserves the resolved non-default router port', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-workspace-router-port-'));
    try {
        const reposDir = path.join(root, '.ploinky', 'repos');
        for (const repo of ['basic', 'AchillesIDE', 'AchillesCLI', 'copilot-agents', 'demo']) {
            fs.mkdirSync(path.join(reposDir, repo), { recursive: true });
        }
        const agentDir = path.join(reposDir, 'demo', 'root');
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify({
            profiles: {
                default: { openPorts: ['127.0.0.1:49123:7000'] },
            },
        }));
        const marker = path.join(root, 'ploinky-box');
        fs.writeFileSync(marker, '1\n');
        const workspaceUrl = pathToFileURL(path.resolve(
            new URL('../..', import.meta.url).pathname,
            'cli/services/workspaceUtil.js',
        )).href;
        const script = `
import fs from 'node:fs';
import path from 'node:path';
const { startWorkspace } = await import(${JSON.stringify(workspaceUrl)});
let error = null;
try { await startWorkspace('demo/root', '49123'); }
catch (caught) { error = { code: caught.code || null, message: caught.message }; }
const routingPath = path.join(process.cwd(), '.ploinky', 'routing.json');
process.stdout.write(JSON.stringify({
  error,
  routingPort: fs.existsSync(routingPath) ? JSON.parse(fs.readFileSync(routingPath, 'utf8')).port : null,
  agentsExists: fs.existsSync(path.join(process.cwd(), '.ploinky', 'agents.json')),
  dataExists: fs.existsSync(path.join(process.cwd(), '.data')),
}));`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: root,
            env: {
                ...process.env,
                PLOINKY_WORKSPACE_ROOT: root,
                PLOINKY_BOX_MARKER_PATH: marker,
                PLOINKY_OUTER_PUBLICATION_CONTRACT: JSON.stringify({
                    schemaVersion: 2,
                    targets: [{ start: 49123, end: 49123, protocol: 'tcp' }],
                    publishes: [],
                }),
                PLOINKY_MASTER_KEY: '7'.repeat(64),
            },
            encoding: 'utf8',
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = JSON.parse(result.stdout);
        assert.match(output.error?.message || '', /reserved outer router socket 49123\/tcp/);
        assert.deepEqual({
            routingPort: output.routingPort,
            agentsExists: output.agentsExists,
            dataExists: output.dataExists,
        }, {
            routingPort: 49123,
            agentsExists: false,
            dataExists: false,
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('startup config providers run before manifest directives can start dependencies', () => {
    const source = startWorkspace.toString();
    const prepareIndex = source.indexOf('prepareManifestRepositories');
    const providerIndex = source.indexOf('applyStartupConfigProvidersForGraph');
    const enableIndex = source.indexOf('applyManifestDirectives');

    assert.ok(prepareIndex >= 0, 'workspace start must prepare manifest repositories');
    assert.ok(providerIndex > prepareIndex, 'providers must run after their repositories are available');
    assert.ok(enableIndex > providerIndex, 'providers must finish before manifest enable directives start dependencies');
});

test('workspace router TCP listener is ready before first-use static agent startup', () => {
    const source = startWorkspace.toString();
    const routerIndex = source.indexOf('await ensureRouterReadyForStart({');
    const enableIndex = source.indexOf('await enableAgent(staticAgentArg)');
    const lockIndex = source.indexOf('createWorkspaceStartLock()');

    assert.ok(lockIndex >= 0 && lockIndex < routerIndex, 'workspace start must suppress watchdog container reconciliation before router startup');
    assert.ok(routerIndex >= 0, 'workspace start must establish the router listener');
    assert.ok(enableIndex > routerIndex, 'the first managed agent must not start before the router TCP listener');
    assert.match(source, /Existing router TCP listener is ready/);
    assert.doesNotMatch(source, /Unix socket|router\.sock/);
    assert.match(source, /finally\s*\{\s*releaseWorkspaceStartLock\(workspaceStartLock\)/);
});

test('resolveWorkspaceDependencyGraph preserves dependency modes while qualifying relative refs', () => {
    writeManifest('demo', 'mode-target', { container: 'node:20-alpine' });
    writeManifest('demo', 'mode-app', {
        container: 'node:20-alpine',
        enable: ['mode-target global']
    });

    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'demo/mode-app' });
    assert.equal(graph.nodes.get('demo/mode-target').enableSpec, 'demo/mode-target global');
});

test('retained graph records reconcile isolated, global, and devel execution before blocking or no-wait launch', () => {
    const reposDir = path.join(tempDir, '.ploinky', 'repos');
    const develRepo = 'mode-devel-repo';
    const develPath = path.join(reposDir, develRepo);
    const isolatedPath = path.join(tempDir, '.data', 'background-worker');
    const preservedNamedData = path.join(isolatedPath, 'preserved.txt');
    const preservedWorkspaceData = path.join(tempDir, 'workspace-preserved.txt');
    fs.mkdirSync(isolatedPath, { recursive: true });
    fs.mkdirSync(develPath, { recursive: true });
    fs.writeFileSync(preservedNamedData, 'named-data');
    fs.writeFileSync(preservedWorkspaceData, 'workspace-data');

    const nodes = new Map([
        ['demo/blocking-global', {
            id: 'demo/blocking-global', repoName: 'demo', shortAgentName: 'blocking-global',
            alias: '', agentRef: 'demo/blocking-global', enableSpec: 'demo/blocking-global global',
            profile: 'default', isStatic: false,
        }],
        ['demo/background-worker', {
            id: 'demo/background-worker', repoName: 'demo', shortAgentName: 'background-worker',
            alias: '', agentRef: 'demo/background-worker', enableSpec: 'demo/background-worker isolated',
            profile: 'embedded', isStatic: false,
        }],
        ['demo/devel-worker', {
            id: 'demo/devel-worker', repoName: 'demo', shortAgentName: 'devel-worker',
            alias: '', agentRef: 'demo/devel-worker', enableSpec: `demo/devel-worker devel ${develRepo}`,
            profile: 'default', isStatic: false,
        }],
        ['demo/implicit-worker', {
            id: 'demo/implicit-worker', repoName: 'demo', shortAgentName: 'implicit-worker',
            alias: '', agentRef: 'demo/implicit-worker', enableSpec: 'demo/implicit-worker',
            profile: 'embedded', isStatic: false,
        }],
        ['demo/root', {
            id: 'demo/root', repoName: 'demo', shortAgentName: 'root',
            alias: '', agentRef: 'demo/root', enableSpec: 'demo/root',
            profile: 'default', isStatic: true,
        }],
    ]);
    const registry = {
        blocking_container: {
            type: 'agent', repoName: 'demo', agentName: 'blocking-global',
            runMode: 'isolated', projectPath: path.join(tempDir, '.data', 'blocking-global'),
            config: { binds: [{ source: '/old', target: '/root' }] },
        },
        background_container: {
            type: 'agent', repoName: 'demo', agentName: 'background-worker',
            runMode: 'global', projectPath: tempDir, develRepo: 'stale', profile: 'default',
            config: { binds: [{ source: tempDir, target: tempDir }] },
        },
        devel_container: {
            type: 'agent', repoName: 'demo', agentName: 'devel-worker',
            runMode: 'global', projectPath: tempDir,
            config: { binds: [{ source: tempDir, target: tempDir }] },
        },
        implicit_container: {
            type: 'agent', repoName: 'demo', agentName: 'implicit-worker',
            runMode: 'global', projectPath: tempDir, profile: 'default',
            config: { binds: [{ source: tempDir, target: tempDir }] },
        },
        root_container: {
            type: 'agent', repoName: 'demo', agentName: 'root', alias: 'root-blue',
            runMode: 'global', projectPath: tempDir,
            config: { binds: [{ source: tempDir, target: tempDir }] },
        },
    };
    const removed = [];
    const saved = [];

    ensureGraphNodesEnabled({ nodes }, registry, {
        removeAgentContainerForRecreate(containerName) {
            removed.push(containerName);
        },
        saveAgents(nextRegistry) {
            saved.push(structuredClone(nextRegistry));
        },
        enableAgent() {
            assert.fail('all retained graph nodes should already be enabled');
        },
        executionRecordOptions: {
            workspaceRoot: tempDir,
            reposDir,
            getAgentDataDirImpl(instanceName) {
                return path.join(tempDir, '.data', instanceName);
            },
        },
    });

    assert.deepEqual(removed.sort(), ['background_container', 'blocking_container', 'devel_container']);
    assert.equal(saved.length, 1);
    assert.deepEqual(
        {
            runMode: registry.blocking_container.runMode,
            projectPath: registry.blocking_container.projectPath,
            develRepo: registry.blocking_container.develRepo,
        },
        { runMode: 'global', projectPath: tempDir, develRepo: undefined },
    );
    assert.deepEqual(
        {
            runMode: registry.background_container.runMode,
            projectPath: registry.background_container.projectPath,
            develRepo: registry.background_container.develRepo,
            profile: registry.background_container.profile,
        },
        { runMode: 'isolated', projectPath: isolatedPath, develRepo: undefined, profile: 'embedded' },
    );
    assert.deepEqual(
        {
            runMode: registry.devel_container.runMode,
            projectPath: registry.devel_container.projectPath,
            develRepo: registry.devel_container.develRepo,
        },
        { runMode: 'devel', projectPath: develPath, develRepo },
    );
    assert.deepEqual(
        {
            runMode: registry.root_container.runMode,
            projectPath: registry.root_container.projectPath,
        },
        { runMode: 'global', projectPath: tempDir },
    );
    assert.deepEqual(
        {
            runMode: registry.implicit_container.runMode,
            projectPath: registry.implicit_container.projectPath,
            profile: registry.implicit_container.profile,
        },
        { runMode: 'global', projectPath: tempDir, profile: 'embedded' },
    );
    assert.deepEqual(registry.blocking_container.config.binds, [{ source: '/old', target: '/root' }]);
    assert.equal(fs.readFileSync(preservedNamedData, 'utf8'), 'named-data');
    assert.equal(fs.readFileSync(preservedWorkspaceData, 'utf8'), 'workspace-data');

    const startSource = startWorkspace.toString();
    assert.ok(
        startSource.indexOf('ensureGraphNodesEnabled') < startSource.indexOf('classifyDependencyGraphWaitMode'),
        'execution reconciliation must occur before the graph is divided into blocking and no-wait launch paths',
    );
});

test('execution-mode reconciliation leaves registry records unchanged when exact-container removal fails', () => {
    const registry = {
        retained_container: {
            type: 'agent', repoName: 'demo', agentName: 'retained',
            runMode: 'isolated', projectPath: path.join(tempDir, '.data', 'retained'),
            profile: 'default',
        },
    };
    const before = structuredClone(registry);
    let saveCount = 0;

    assert.throws(
        () => ensureGraphNodesEnabled({
            nodes: new Map([['demo/retained', {
                id: 'demo/retained', repoName: 'demo', shortAgentName: 'retained', alias: '',
                agentRef: 'demo/retained', enableSpec: 'demo/retained global', profile: 'embedded', isStatic: false,
            }]]),
        }, registry, {
            removeAgentContainerForRecreate() {
                throw new Error('safe removal refused');
            },
            saveAgents() {
                saveCount += 1;
            },
            executionRecordOptions: { workspaceRoot: tempDir },
        }),
        /safe removal refused/,
    );

    assert.deepEqual(registry, before);
    assert.equal(saveCount, 0);
});

test('an empty legacy develRepo field does not force recreation of an otherwise matching mode', () => {
    const registry = {
        retained_container: {
            type: 'agent', repoName: 'demo', agentName: 'retained',
            runMode: 'global', projectPath: tempDir, develRepo: undefined, profile: 'default',
        },
    };
    let removals = 0;
    let saves = 0;
    ensureGraphNodesEnabled({
        nodes: new Map([['demo/retained', {
            id: 'demo/retained', repoName: 'demo', shortAgentName: 'retained',
            alias: '', agentRef: 'demo/retained', enableSpec: 'demo/retained global',
            profile: 'default', isStatic: false,
        }]]),
    }, registry, {
        removeAgentContainerForRecreate() { removals += 1; },
        saveAgents() { saves += 1; },
        enableAgent() { assert.fail('the retained node is already enabled'); },
        executionRecordOptions: { workspaceRoot: tempDir },
    });
    assert.equal(removals, 0);
    assert.equal(saves, 0);
});

test('devel execution preflight fails before removing any retained graph container', () => {
    const registry = {
        first_container: {
            type: 'agent', repoName: 'demo', agentName: 'first',
            runMode: 'isolated', projectPath: path.join(tempDir, '.data', 'first'),
        },
        missing_devel_container: {
            type: 'agent', repoName: 'demo', agentName: 'missing-devel',
            runMode: 'global', projectPath: tempDir,
        },
    };
    const before = structuredClone(registry);
    const removed = [];

    assert.throws(
        () => ensureGraphNodesEnabled({
            nodes: new Map([
                ['demo/first', {
                    id: 'demo/first', repoName: 'demo', shortAgentName: 'first', alias: '',
                    agentRef: 'demo/first', enableSpec: 'demo/first global', profile: 'default', isStatic: false,
                }],
                ['demo/missing-devel', {
                    id: 'demo/missing-devel', repoName: 'demo', shortAgentName: 'missing-devel', alias: '',
                    agentRef: 'demo/missing-devel', enableSpec: 'demo/missing-devel devel does-not-exist', profile: 'default', isStatic: false,
                }],
            ]),
        }, registry, {
            removeAgentContainerForRecreate(containerName) {
                removed.push(containerName);
            },
            saveAgents() {
                assert.fail('invalid devel preflight must not save the registry');
            },
            executionRecordOptions: {
                workspaceRoot: tempDir,
                reposDir: path.join(tempDir, '.ploinky', 'repos'),
            },
        }),
        /does-not-exist.*was not found/,
    );

    assert.deepEqual(removed, []);
    assert.deepEqual(registry, before);
});

test('graph execution selection accepts colon mode syntax and alias-specific isolated paths', () => {
    assert.deepEqual(
        resolveGraphNodeExecutionRecord({
            id: 'demo/worker as blue', shortAgentName: 'worker', alias: 'blue',
            agentRef: 'demo/worker', enableSpec: 'demo/worker:isolated',
        }, {
            getAgentDataDirImpl(instanceName) {
                return `/data/${instanceName}`;
            },
        }),
        { runMode: 'isolated', projectPath: '/data/blue', develRepo: undefined },
    );
});

test('resolveWorkspaceDependencyGraph resolves same-repo bare dependencies when enabled repos are filtered', (t) => {
    writeEnabledRepos(['basic']);
    t.after(clearEnabledRepos);

    writeManifest('basic', 'webtty', { container: 'node:20-alpine' });
    writeManifest('AchillesIDE', 'gitAgent', {
        container: 'node:20-alpine',
        profiles: { default: {}, embedded: {} },
    });
    writeManifest('AchillesIDE', 'explorer', {
        container: 'node:20-alpine',
        enable: [
            {
                agent: 'gitAgent global',
                profile: 'embedded',
            },
            'basic/webtty',
        ],
    });

    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'AchillesIDE/explorer' });

    assert.ok(graph.nodes.has('AchillesIDE/gitAgent'));
    assert.ok(graph.nodes.has('basic/webtty'));
    assert.equal(graph.nodes.get('AchillesIDE/gitAgent').enableSpec, 'AchillesIDE/gitAgent global');
    assert.equal(graph.nodes.get('AchillesIDE/gitAgent').profile, 'embedded');
    assert.ok(graph.nodes.get('AchillesIDE/explorer').dependencies.has('AchillesIDE/gitAgent'));
});

test('resolveWorkspaceDependencyGraph leaves cross-repo bare dependencies available for global lookup', (t) => {
    writeEnabledRepos(['appRepo']);
    t.after(clearEnabledRepos);

    writeManifest('toolsRepo', 'sharedTool', { container: 'node:20-alpine' });
    writeManifest('appRepo', 'app', {
        container: 'node:20-alpine',
        enable: ['sharedTool global no-wait'],
    });

    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'appRepo/app' });

    assert.ok(graph.nodes.has('toolsRepo/sharedTool'));
    assert.equal(graph.nodes.get('toolsRepo/sharedTool').enableSpec, 'sharedTool global');
    assert.ok(graph.nodes.get('appRepo/app').dependencies.has('toolsRepo/sharedTool'));
    assert.equal(graph.nodes.get('appRepo/app').dependencyEdges.get('toolsRepo/sharedTool')?.noWait, true);
});

test('applyManifestDirectives resolves same-repo bare entries when enabled repos are filtered', async (t) => {
    writeEnabledRepos(['basic']);
    t.after(() => {
        clearEnabledRepos();
        fs.rmSync(path.join(tempDir, '.ploinky', 'agents.json'), { force: true });
    });

    writeManifest('AchillesIDE', 'gitAgent', { container: 'node:20-alpine' });
    writeManifest('AchillesIDE', 'explorer-bootstrap', {
        container: 'node:20-alpine',
        enable: [
            {
                agent: 'gitAgent global',
                profile: 'embedded',
            },
        ],
    });
    fs.writeFileSync(
        path.join(tempDir, '.ploinky', 'agents.json'),
        JSON.stringify({
            existing_gitAgent: {
                type: 'agent',
                repoName: 'AchillesIDE',
                agentName: 'gitAgent',
                config: {},
            },
        }, null, 2)
    );

    await applyManifestDirectives('AchillesIDE/explorer-bootstrap');
    const agents = JSON.parse(fs.readFileSync(path.join(tempDir, '.ploinky', 'agents.json'), 'utf8'));
    const records = Object.values(agents).filter((record) => record?.type === 'agent');

    assert.equal(records.length, 1);
    assert.equal(records[0].repoName, 'AchillesIDE');
    assert.equal(records[0].agentName, 'gitAgent');
    assert.equal(records[0].profile, 'embedded');
});

test('applyManifestDirectives leaves cross-repo bare entries available for global lookup', async (t) => {
    writeEnabledRepos(['appRepo']);
    t.after(() => {
        clearEnabledRepos();
        fs.rmSync(path.join(tempDir, '.ploinky', 'agents.json'), { force: true });
    });

    writeManifest('toolsRepo', 'sharedTool', { container: 'node:20-alpine' });
    writeManifest('appRepo', 'app-bootstrap', {
        container: 'node:20-alpine',
        enable: [
            {
                agent: 'sharedTool global',
                profile: 'utility',
            },
        ],
    });
    fs.writeFileSync(
        path.join(tempDir, '.ploinky', 'agents.json'),
        JSON.stringify({
            existing_sharedTool: {
                type: 'agent',
                repoName: 'toolsRepo',
                agentName: 'sharedTool',
                config: {},
            },
        }, null, 2)
    );

    await applyManifestDirectives('appRepo/app-bootstrap');
    const agents = JSON.parse(fs.readFileSync(path.join(tempDir, '.ploinky', 'agents.json'), 'utf8'));
    const records = Object.values(agents).filter((record) => record?.type === 'agent');

    assert.equal(records.length, 1);
    assert.equal(records[0].repoName, 'toolsRepo');
    assert.equal(records[0].agentName, 'sharedTool');
    assert.equal(records[0].profile, 'utility');
});

test('resolveWorkspaceDependencyGraph respects SSO gating for provider dependencies', () => {
    // SSO provider dependencies are skipped unless the parent manifest requests SSO mode.
    writeManifest('basic', 'keycloak', {
        container: 'quay.io/keycloak/keycloak:24.0',
        ssoProvider: true,
    });
    writeManifest('demo', 'plain-app', {
        container: 'node:20-alpine',
        enable: ['basic/keycloak']
    });
    writeManifest('demo', 'sso-app', {
        container: 'node:20-alpine',
        ploinky: 'sso enable',
        enable: ['basic/keycloak']
    });

    const plainGraph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'demo/plain-app' });
    assert.equal(plainGraph.nodes.has('basic/keycloak'), false);

    const ssoGraph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'demo/sso-app' });
    assert.equal(ssoGraph.nodes.has('basic/keycloak'), true);
});

test('resolveWorkspaceDependencyGraph uses registry auth mode when available', () => {
    writeManifest('demo', 'registry-sso-app', {
        container: 'node:20-alpine',
        enable: ['basic/keycloak']
    });

    const graph = resolveWorkspaceDependencyGraph({
        staticAgentRef: 'demo/registry-sso-app',
        registry: {
            [createGraphNodeId('demo', 'registry-sso-app')]: {
                type: 'agent',
                repoName: 'demo',
                agentName: 'registry-sso-app',
                auth: { mode: 'sso' }
            }
        }
    });

    assert.equal(graph.nodes.has('basic/keycloak'), true);
});

test('resolveWorkspaceDependencyGraph skips cyclic dependency edges with a readable warning', () => {
    writeManifest('cycle', 'a', {
        container: 'node:20-alpine',
        enable: ['cycle/b']
    });
    writeManifest('cycle', 'b', {
        container: 'node:20-alpine',
        enable: ['cycle/a']
    });

    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(' '));
    try {
        const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'cycle/a' });
        assert.deepEqual(topologicallyGroupDependencyGraph(graph), [
            ['cycle/b'],
            ['cycle/a']
        ]);
    } finally {
        console.error = originalError;
    }

    assert.equal(errors.length, 1);
    assert.match(errors[0], /Dependency cycle detected: cycle\/a -> cycle\/b -> cycle\/a/);
});

test('resolveWorkspaceDependencyGraph fails closed when a dependency entry cannot be resolved', () => {
    writeManifest('demo', 'simulator', { container: 'node:20-alpine' });
    writeManifest('demo', 'app-with-missing-dep', {
        container: 'node:20-alpine',
        enable: ['simulator', 'missing-agent']
    });

    assert.throws(
        () => resolveWorkspaceDependencyGraph({ staticAgentRef: 'demo/app-with-missing-dep' }),
        /Failed to resolve dependency 'missing-agent'/
    );
});

test('parseEnableDirective strips no-wait modifier from any position', () => {
    assert.deepEqual(
        parseEnableDirective('worker'),
        { spec: 'worker', alias: undefined, noWait: false }
    );
    assert.deepEqual(
        parseEnableDirective('worker no-wait'),
        { spec: 'worker', alias: undefined, noWait: true }
    );
    assert.deepEqual(
        parseEnableDirective('worker global no-wait'),
        { spec: 'worker global', alias: undefined, noWait: true }
    );
    assert.deepEqual(
        parseEnableDirective('worker devel repo no-wait'),
        { spec: 'worker devel repo', alias: undefined, noWait: true }
    );
    assert.deepEqual(
        parseEnableDirective('worker global no-wait as ai'),
        { spec: 'worker global', alias: 'ai', noWait: true }
    );
    assert.deepEqual(
        parseEnableDirective('worker global as ai no-wait'),
        { spec: 'worker global', alias: 'ai', noWait: true }
    );
    assert.deepEqual(
        parseEnableDirective('worker No-Wait'),
        { spec: 'worker', alias: undefined, noWait: true }
    );
});

test('parseEnableDirective accepts object entries with profile overrides', () => {
    assert.deepEqual(
        parseEnableDirective({
            agent: 'proxies/soul-gateway',
            profile: 'Embedded',
        }),
        {
            spec: 'proxies/soul-gateway',
            alias: undefined,
            noWait: false,
            profile: 'embedded',
        }
    );
    assert.deepEqual(
        parseEnableDirective({
            agent: 'worker global no-wait as ai',
            profile: 'embedded',
        }),
        {
            spec: 'worker global',
            alias: 'ai',
            noWait: true,
            profile: 'embedded',
        }
    );
});

test('resolveWorkspaceDependencyGraph records no-wait metadata on the requesting edge only', () => {
    writeManifest('nw', 'leaf', { container: 'node:20-alpine' });
    writeManifest('nw', 'worker', {
        container: 'node:20-alpine',
        enable: ['nw/leaf']
    });
    writeManifest('nw', 'app', {
        container: 'node:20-alpine',
        enable: ['nw/worker no-wait', 'nw/leaf']
    });

    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'nw/app' });
    const appNode = graph.nodes.get('nw/app');
    const workerNode = graph.nodes.get('nw/worker');

    // The no-wait modifier rides the explicit edge from app -> worker.
    assert.equal(appNode.dependencyEdges.get('nw/worker').noWait, true);
    // The leaf edge from app stays blocking even though leaf is also reached
    // (blockingly) through the worker.
    assert.equal(appNode.dependencyEdges.get('nw/leaf').noWait, false);
    // The worker's own edge to leaf is unrelated to the app -> worker decoration.
    assert.equal(workerNode.dependencyEdges.get('nw/leaf').noWait, false);
});

test('classifyDependencyGraphWaitMode treats reachability through no-wait edges as no-wait', () => {
    writeManifest('cls', 'leaf', { container: 'node:20-alpine' });
    writeManifest('cls', 'opt', {
        container: 'node:20-alpine',
        enable: ['cls/leaf']
    });
    writeManifest('cls', 'critical', {
        container: 'node:20-alpine',
        enable: ['cls/leaf']
    });
    writeManifest('cls', 'app', {
        container: 'node:20-alpine',
        enable: ['cls/critical', 'cls/opt no-wait']
    });

    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'cls/app' });
    const { blocking, noWait } = classifyDependencyGraphWaitMode(graph);

    assert.ok(blocking.has('cls/app'));
    assert.ok(blocking.has('cls/critical'));
    // leaf has a blocking path through critical, so it stays blocking even
    // though there is also a no-wait path through opt.
    assert.ok(blocking.has('cls/leaf'));
    assert.ok(noWait.has('cls/opt'));
    assert.equal(noWait.has('cls/leaf'), false);
});

test('classifyDependencyGraphWaitMode marks pure no-wait subtrees as no-wait', () => {
    writeManifest('sub', 'innerLeaf', { container: 'node:20-alpine' });
    writeManifest('sub', 'optWorker', {
        container: 'node:20-alpine',
        enable: ['sub/innerLeaf']
    });
    writeManifest('sub', 'app', {
        container: 'node:20-alpine',
        enable: ['sub/optWorker no-wait']
    });

    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'sub/app' });
    const { blocking, noWait } = classifyDependencyGraphWaitMode(graph);

    assert.ok(blocking.has('sub/app'));
    assert.ok(noWait.has('sub/optWorker'));
    // innerLeaf is reachable only through the no-wait edge to optWorker.
    assert.ok(noWait.has('sub/innerLeaf'));
    assert.equal(blocking.has('sub/optWorker'), false);
    assert.equal(blocking.has('sub/innerLeaf'), false);
});

test('classifyDependencyGraphWaitMode prefers blocking when two parents disagree', () => {
    writeManifest('mix', 'shared', { container: 'node:20-alpine' });
    writeManifest('mix', 'parentA', {
        container: 'node:20-alpine',
        enable: ['mix/shared no-wait']
    });
    writeManifest('mix', 'parentB', {
        container: 'node:20-alpine',
        enable: ['mix/shared']
    });
    writeManifest('mix', 'app', {
        container: 'node:20-alpine',
        enable: ['mix/parentA', 'mix/parentB']
    });

    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'mix/app' });
    const { blocking } = classifyDependencyGraphWaitMode(graph);

    // shared has one blocking parent (parentB) and one no-wait parent
    // (parentA); the blocking path wins so shared stays in the blocking set.
    assert.ok(blocking.has('mix/shared'));
});

test('AssistOSExplorer-shaped wiring routes the LiveKit AI worker as no-wait while truncating its inverse edge', () => {
    // Mirrors the shipped consumer wiring: webmeetAgent declares the optional
    // LiveKit AI worker with `no-wait`, and the worker's own manifest still
    // lists webmeetAgent so it can be enabled standalone. Cycle truncation
    // drops the inverse edge cleanly so the worker stays in the no-wait set.
    writeManifest('webmeetInfra', 'stack', { container: 'node:20' });
    writeManifest('AchillesIDE', 'webmeetLivekitAiAgent', {
        container: 'node:20',
        enable: ['webmeetInfra/stack', 'webmeetAgent global']
    });
    writeManifest('AchillesIDE', 'webmeetAgent', {
        container: 'node:20',
        enable: ['webmeetInfra/stack', 'webmeetLivekitAiAgent global no-wait']
    });
    writeManifest('AchillesIDE', 'explorer', {
        container: 'node:20',
        enable: ['webmeetAgent global']
    });

    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(' '));
    let graph;
    try {
        graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'AchillesIDE/explorer' });
    } finally {
        console.error = originalError;
    }

    const { blocking, noWait } = classifyDependencyGraphWaitMode(graph);
    assert.deepEqual(
        Array.from(blocking).sort(),
        ['AchillesIDE/explorer', 'AchillesIDE/webmeetAgent', 'webmeetInfra/stack']
    );
    assert.deepEqual(Array.from(noWait), ['AchillesIDE/webmeetLivekitAiAgent']);
    // The inverse edge from the LiveKit AI worker back to webmeetAgent must be
    // truncated by the existing cycle handling, not promoted to a hard error.
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Dependency cycle detected:/);
});

test('resolveWorkspaceDependencyGraph resolves profile-specific enable[] for semantic profiles', () => {
    const profilePath = path.join(tempDir, '.ploinky', 'profile');
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, 'embedded');

    writeManifest('proxies', 'soul-gateway', {
        container: 'node:20-slim',
        profiles: {
            default: {},
            embedded: {},
        },
    });
    writeManifest('AchillesIDE', 'explorer-semantic', {
        container: 'node:20',
        enable: ['demo/leaf'],
        profiles: {
            default: {},
            embedded: {
                enable: ['proxies/soul-gateway'],
            },
        },
    });

    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'AchillesIDE/explorer-semantic' });
    assert.ok(graph.nodes.has('proxies/soul-gateway'));
    assert.ok(graph.nodes.has('demo/leaf'));
    assert.ok(graph.nodes.get('AchillesIDE/explorer-semantic').dependencies.has('proxies/soul-gateway'));

    fs.writeFileSync(profilePath, 'dev');
});

test('resolveWorkspaceDependencyGraph uses default profile enable[] when active profile is absent', (t) => {
    const profilePath = path.join(tempDir, '.ploinky', 'profile');
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, 'embedded');
    t.after(() => fs.writeFileSync(profilePath, 'default'));

    writeManifest('basic', 'default-profile-provider', {
        container: 'node:20-slim',
        profiles: {
            default: {},
        },
    });
    writeManifest('AchillesIDE', 'explorer-default-profile-enable', {
        container: 'node:20',
        profiles: {
            default: {
                enable: ['basic/default-profile-provider global'],
            },
        },
    });

    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'AchillesIDE/explorer-default-profile-enable' });

    assert.ok(graph.nodes.has('basic/default-profile-provider'));
    assert.ok(
        graph.nodes
            .get('AchillesIDE/explorer-default-profile-enable')
            .dependencies
            .has('basic/default-profile-provider')
    );
});

test('resolveWorkspaceDependencyGraph records dependency-local profile overrides', () => {
    writeManifest('profileEdge', 'worker', {
        container: 'node:20',
        profiles: {
            default: {},
            embedded: {},
        },
    });
    writeManifest('profileEdge', 'app', {
        container: 'node:20',
        enable: [
            {
                agent: 'profileEdge/worker',
                profile: 'embedded',
            },
        ],
    });

    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'profileEdge/app' });
    assert.equal(graph.nodes.get('profileEdge/worker').profile, 'embedded');
});

test('resolveWorkspaceDependencyGraph still truncates cycles instead of throwing', () => {
    writeManifest('cycleTrunc', 'a', {
        container: 'node:20-alpine',
        enable: ['cycleTrunc/b']
    });
    writeManifest('cycleTrunc', 'b', {
        container: 'node:20-alpine',
        enable: ['cycleTrunc/a']
    });

    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(' '));
    try {
        const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'cycleTrunc/a' });
        assert.deepEqual(
            topologicallyGroupDependencyGraph(graph),
            [['cycleTrunc/b'], ['cycleTrunc/a']]
        );
    } finally {
        console.error = originalError;
    }

    assert.equal(errors.length, 1);
    assert.match(errors[0], /Dependency cycle detected/);
});
