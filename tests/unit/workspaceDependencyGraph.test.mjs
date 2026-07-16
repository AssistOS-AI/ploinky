import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    resolveWorkspaceDependencyGraph,
    topologicallyGroupDependencyGraph
} = graphModule;
const { parseEnableDirective } = bootstrapModule;

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('parseManifestDependencyRef strips mode and alias syntax down to the agent reference', () => {
    assert.equal(parseManifestDependencyRef('gitAgent global'), 'gitAgent');
    assert.equal(parseManifestDependencyRef('basic/keycloak as auth'), 'basic/keycloak');
    assert.equal(parseManifestDependencyRef('repo/agent:dev'), 'repo/agent');
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

test('resolveWorkspaceDependencyGraph preserves the original enable spec for dependency modes', () => {
    writeManifest('demo', 'mode-target', { container: 'node:20-alpine' });
    writeManifest('demo', 'mode-app', {
        container: 'node:20-alpine',
        enable: ['mode-target global']
    });

    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'demo/mode-app' });
    assert.equal(graph.nodes.get('demo/mode-target').enableSpec, 'mode-target global');
});

test('manual startup does not remove an explicit dependency from the graph', () => {
    writeManifest('demo', 'manual-dependency', {
        container: 'node:20-alpine',
        startup: 'manual',
    });
    writeManifest('demo', 'manual-parent', {
        container: 'node:20-alpine',
        enable: ['demo/manual-dependency'],
    });

    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'demo/manual-parent' });
    assert.ok(graph.nodes.has('demo/manual-dependency'));
    assert.deepEqual(topologicallyGroupDependencyGraph(graph), [
        ['demo/manual-dependency'],
        ['demo/manual-parent'],
    ]);
});

test('dependency graph rejects an invalid startup policy explicitly', () => {
    writeManifest('demo', 'invalid-startup', {
        container: 'node:20-alpine',
        startup: 'sometimes',
    });

    assert.throws(
        () => resolveWorkspaceDependencyGraph({ staticAgentRef: 'demo/invalid-startup' }),
        /startup must be 'automatic' or 'manual'/
    );
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
