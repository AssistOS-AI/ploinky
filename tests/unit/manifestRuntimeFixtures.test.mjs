import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const testsRoot = path.join(repositoryRoot, 'tests');
const strictBwrapManifestPath = path.join(testsRoot, 'strictBwrapAgent', 'manifest.json');
const containerManifestPath = path.join(testsRoot, 'testAgent', 'manifest.json');
const dynamicFixtureSources = [
    {
        path: path.join(testsRoot, 'doPrepare.sh'),
        expectedContainerDeclarations: 9
    },
    {
        path: path.join(testsRoot, 'test-functions', 'workspace_dependency_startup_tests.sh'),
        expectedContainerDeclarations: 5
    }
];

async function findManifestPaths(directory) {
    const manifests = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            manifests.push(...await findManifestPaths(entryPath));
        } else if (entry.isFile() && entry.name === 'manifest.json') {
            manifests.push(entryPath);
        }
    }
    return manifests;
}

test('test manifests keep one explicit strict bwrap fixture separate from container fixtures', async () => {
    const selectorManifests = [];
    for (const manifestPath of await findManifestPaths(testsRoot)) {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (manifest['lite-sandbox'] === true) {
            selectorManifests.push(manifestPath);
            assert.equal(Object.hasOwn(manifest, 'container'), false, `${manifestPath} must not declare container`);
            assert.equal(Object.hasOwn(manifest, 'image'), false, `${manifestPath} must not declare image`);
        }
    }

    assert.deepEqual(selectorManifests, [strictBwrapManifestPath]);

    const containerManifest = JSON.parse(await fs.readFile(containerManifestPath, 'utf8'));
    assert.equal(containerManifest.container, 'node:24.15.0-bullseye');
    assert.equal(Object.hasOwn(containerManifest, 'lite-sandbox'), false);
});

test('dynamic fast-suite fixtures remain explicit containers with deterministic registry expectations', async () => {
    for (const fixtureSource of dynamicFixtureSources) {
        const source = await fs.readFile(fixtureSource.path, 'utf8');
        assert.doesNotMatch(source, /"lite-sandbox"\s*:\s*true/);
        assert.equal(
            source.match(/"container"\s*:/g)?.length,
            fixtureSource.expectedContainerDeclarations,
            `${fixtureSource.path} must keep every generated runtime fixture container-backed`
        );
    }

    const prepareSource = await fs.readFile(dynamicFixtureSources[0].path, 'utf8');
    assert.match(prepareSource, /^FAST_AGENT_RUNTIME="container"$/m);
    assert.doesNotMatch(prepareSource, /FAST_AGENT_RUNTIME="(?:bwrap|seatbelt)"/);
    assert.match(
        prepareSource,
        /^set_fast_fixture_container_runtime "\.ploinky\/repos\/demo\/simulator\/manifest\.json"$/m,
    );
    assert.match(
        prepareSource,
        /^set_fast_fixture_container_runtime "\.ploinky\/repos\/webmeet\/moderator\/manifest\.json"$/m,
    );

    const librarySource = await fs.readFile(path.join(testsRoot, 'lib.sh'), 'utf8');
    const fixtureHelperStart = librarySource.indexOf('\nset_fast_fixture_container_runtime()');
    const fixtureHelperEnd = librarySource.indexOf('\n# Replace the `enable` array', fixtureHelperStart);
    assert.ok(fixtureHelperStart >= 0 && fixtureHelperEnd > fixtureHelperStart);
    const fixtureHelper = librarySource.slice(fixtureHelperStart, fixtureHelperEnd);
    assert.match(fixtureHelper, /manifest\.container/);
    assert.match(fixtureHelper, /delete manifest\['lite-sandbox'\]/);
    assert.match(fixtureHelper, /TEST_RUN_DIR/);
});

test('fast-suite container enables wait for the real Router authority socket', async () => {
    const prepareSource = await fs.readFile(path.join(testsRoot, 'doPrepare.sh'), 'utf8');
    const startSource = await fs.readFile(path.join(testsRoot, 'doStart.sh'), 'utf8');
    const stopSource = await fs.readFile(path.join(testsRoot, 'doStop.sh'), 'utf8');
    const librarySource = await fs.readFile(path.join(testsRoot, 'lib.sh'), 'utf8');
    const graphSource = await fs.readFile(
        path.join(testsRoot, 'test-functions', 'workspace_dependency_startup_tests.sh'),
        'utf8'
    );

    assert.doesNotMatch(prepareSource, /^\s*ploinky enable agent\b/m);
    assert.doesNotMatch(graphSource, /^\s*ploinky enable agent\b/m);

    const startRouterReady = startSource.indexOf('\nwait_for_router\n');
    const startDeferredEnables = startSource.indexOf('\nenable_fast_suite_agents_after_router\n');
    assert.ok(startRouterReady >= 0);
    assert.ok(startDeferredEnables > startRouterReady);

    const helperStart = librarySource.indexOf('\nenable_fast_suite_agents_after_router()');
    const helperRouterGuard = librarySource.indexOf('\n  if ! assert_router_status_ok;', helperStart);
    const helperFirstEnable = librarySource.indexOf('\n  ploinky enable agent ', helperStart);
    assert.ok(helperStart >= 0);
    assert.ok(helperRouterGuard > helperStart);
    assert.ok(helperFirstEnable > helperRouterGuard);

    const stopEnable = stopSource.indexOf('\nploinky enable agent ');
    const stopRouter = stopSource.indexOf('\nploinky stop\n');
    assert.ok(stopEnable >= 0);
    assert.ok(stopRouter > stopEnable);
});

test('fast-suite runtime artifacts use TEST_RUN_DIR instead of per-agent dependency storage', async () => {
    const prepareSource = await fs.readFile(path.join(testsRoot, 'doPrepare.sh'), 'utf8');
    const startScriptSource = await fs.readFile(path.join(testsRoot, 'testAgent', 'start_script.sh'), 'utf8');

    assert.match(prepareSource, /^runtime_workspace="\$TEST_RUN_DIR"$/m);
    assert.match(
        prepareSource,
        /^agent_dependency_storage="\$TEST_RUN_DIR\/\.data\/\$TEST_AGENT_NAME"$/m
    );
    assert.match(prepareSource, /^write_state_var "TEST_AGENT_WORKSPACE" "\$runtime_workspace"$/m);
    assert.match(prepareSource, /^write_state_var "TEST_PERSIST_FILE" "\$runtime_workspace\/data\/fast-persist\.txt"$/m);
    assert.match(prepareSource, /^write_state_var "TEST_AGENT_LOG" "\$runtime_workspace\/fast-start\.log"$/m);
    assert.match(prepareSource, /^write_state_var "TEST_PERSIST_MARKER" "\$runtime_workspace\/data\/manual-marker\.txt"$/m);
    assert.match(prepareSource, /^mkdir -p "\$agent_dependency_storage"$/m);

    assert.doesNotMatch(
        prepareSource,
        /^write_state_var "TEST_(?:AGENT_WORKSPACE|PERSIST_FILE|AGENT_LOG|PERSIST_MARKER)" .*\.data\/\$TEST_AGENT_NAME/m
    );
    assert.doesNotMatch(startScriptSource, /persistent \.data\/<agentName> home/);
    assert.match(startScriptSource, /fast-suite container fixture binds its TEST_RUN_DIR/);
});

test('failing-fast dependency workspaces run before the primary Router owns the fixed port', async () => {
    const runnerSource = await fs.readFile(path.join(testsRoot, 'runFailingFast.sh'), 'utf8');
    const dependencySource = 'source "$TESTS_DIR/test-functions/workspace_dependency_startup_tests.sh"';
    const recursiveCheck = 'fast_test_recursive_dependency_graph_startup';
    const overrideCheck = 'fast_test_dependency_readiness_protocol_override';
    const startStage = 'stage_header "START STAGE"';

    assert.equal(runnerSource.split(dependencySource).length - 1, 1);
    assert.ok(runnerSource.indexOf(dependencySource) >= 0);
    assert.ok(runnerSource.indexOf(recursiveCheck) > runnerSource.indexOf(dependencySource));
    assert.ok(runnerSource.indexOf(overrideCheck) > runnerSource.indexOf(dependencySource));
    assert.ok(runnerSource.indexOf(recursiveCheck) < runnerSource.indexOf(startStage));
    assert.ok(runnerSource.indexOf(overrideCheck) < runnerSource.indexOf(startStage));
    assert.doesNotMatch(
        runnerSource.slice(runnerSource.indexOf(startStage)),
        /stage_header "Workspace dependency startup"/,
    );
});
