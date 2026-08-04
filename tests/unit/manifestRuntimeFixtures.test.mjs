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
