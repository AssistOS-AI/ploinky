import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { manifestFixture, installPureGuards } from './test_support_codex.mjs';
import { createBrowserPort, smokeEnvironment } from './browser_codex.mjs';
import { applicationMarker } from './application_marker_codex.mjs';
import { smokeOrigin } from './manifest_codex.mjs';
installPureGuards();

function build(overrides = {}) {
    const { value: manifest } = manifestFixture(), marker = applicationMarker(manifest), processEnv = {}, events = [];
    // The fake page reports the origin the smoke helper would sign in on: the one read from processEnv.SMOKE_BASE_URL when the page is created.
    const makePage = () => { const origin = overrides.pageOrigin ?? processEnv.SMOKE_BASE_URL; return {  url: () => `${origin}/`, waitForResponse: () => Promise.resolve({ url: () => `${origin}/upload?path=${encodeURIComponent(marker.applicationPath)}`, request: () => ({ method: () => 'POST' }), status: () => 200 }),
        waitForFunction: async () => {}, setDefaultTimeout: value => events.push(`timeout:${value}`), locator: () => ({ setInputFiles: async () => {}, click: async () => {}, textContent: async () => marker.text }) }; };
    const chromium = { launch: async options => { events.push(`launch:${JSON.stringify(options)}`); return { newContext: async () => { const id = events.filter(event => event === 'context').length; events.push('context');
        return { newPage: async () => makePage(), close: async () => { events.push(`close-context:${id}`); if (overrides.contextCloseFails) throw new Error('PRIVATE'); } }; }, close: async () => { events.push('close-browser'); if (overrides.browserCloseFails) throw new Error('PRIVATE'); } }; } };
    const imports = []; const importModule = async specifier => { imports.push({ specifier, env: { ...processEnv } }); return { openExplorer: async (_page, options) => { events.push(`open:${options.hash}`); }, assertExplorerDirectory: async () => { events.push('dir'); } }; };
    const stored = { exists: true, boxId: manifest.box.id, path: marker.workspacePath, bytes: marker.bytes.length, sha256: marker.sha256, regular: true, links: 1, identity: { dev: 1, ino: 5 } };
    let reads = 0; const markerFiles = { readMarker: async () => (++reads === 1 ? { exists: false } : stored), retainMarker: row => events.push(`retain:${row.ownership ?? 'created'}`) };
    const port = createBrowserPort({ manifest, markerFiles, check() {}, processEnv, importModule, requireFrom: () => () => ({ chromium }) });
    return { manifest, marker, port, events, imports, processEnv };
}
const expectedLive = manifest => { const candidate = { imageId: manifest.box.imageId, repositories: manifest.candidate.repositories.map(repo => ({ name: repo.name, commit: repo.commit, pushedCommit: repo.pushedCommit, branch: repo.branch, upstream: repo.upstream, clean: true, detached: false })) };
    const expected = { workspace: { path: manifest.workspace.path, dev: manifest.workspace.dev, ino: manifest.workspace.ino, uid: manifest.workspace.uid }, box: { id: manifest.box.id, imageId: manifest.box.imageId, startedAt: manifest.box.startedAt }, candidate,
        requiredGraph: manifest.graph.map(entry => ({ name: entry.name, noWait: entry.noWait, externalHealthRequired: entry.externalHealthRequired })), publications: 'p', sourceMounts: 'm', engineIdentity: 'e', activeGeneration: 'g' };
    const observed = { ...structuredClone(expected), hostPlatform: 'linux', engine: 'podman', rootless: true, running: true, initialized: true, pendingActivation: false, recoveryBarrier: false,
        graph: manifest.graph.map(entry => ({ name: entry.name, ready: true, running: true, runtimeId: 'r', instanceId: 'i', enableGeneration: 'e', graphGeneration: 'g', externalHealth: true })) };
    return { expected, observed }; };

test('smoke environment is set before the first smoke import and only names the bound origin, run, artifacts and workspace', async () => {
    const h = build(); const { expected, observed } = expectedLive(h.manifest);
    assert.deepEqual(smokeEnvironment(h.manifest, 'stem'), { SMOKE_BASE_URL: 'http://localhost:8080', SMOKE_RUN_ID: 'stem-browser', SMOKE_ARTIFACT_DIR: path.join(h.manifest.evidence.root, 'browser'), SMOKE_WORKSPACE_ROOT: h.manifest.workspace.path });
    const receipt = await h.port.createMarker({ live: observed, expected });
    assert.equal(receipt.phase, 'U1'); assert.equal(h.imports.length, 1); assert.equal(h.imports[0].env.SMOKE_BASE_URL, 'http://localhost:8080'); assert.ok(h.imports[0].specifier.endsWith('/tests/smoke/lib/explorer.mjs'));
    assert.ok(h.events.includes('launch:{"headless":true}')); assert.equal(h.port.openContexts(), 1); assert.equal(h.processEnv.SMOKE_WORKSPACE_ROOT, h.manifest.workspace.path);
    assert.deepEqual(Object.keys(h.processEnv).sort(), ['SMOKE_ARTIFACT_DIR', 'SMOKE_BASE_URL', 'SMOKE_RUN_ID', 'SMOKE_WORKSPACE_ROOT']);
});

test('U1 refuses a page on the 127.0.0.1 origin of the same publication: the smoke origin is localhost and the marker check is bound to it', async () => {
    const h = build({ pageOrigin: 'http://127.0.0.1:8080' }); const { expected, observed } = expectedLive(h.manifest);
    await assert.rejects(h.port.createMarker({ live: observed, expected }), error => error.code === 'application-marker-origin');
    const wrongPort = build({ pageOrigin: 'http://localhost:8081' }); await assert.rejects(wrongPort.port.createMarker({ live: expectedLive(wrongPort.manifest).observed, expected: expectedLive(wrongPort.manifest).expected }), error => error.code === 'application-marker-origin');
    // The page follows whatever SMOKE_BASE_URL the port exported: it is the shared smoke origin.
    const ok = build(); await ok.port.createMarker({ live: expectedLive(ok.manifest).observed, expected: expectedLive(ok.manifest).expected }); assert.equal(ok.processEnv.SMOKE_BASE_URL, smokeOrigin(ok.manifest.publications[0]));
});

test('verification uses a fresh context and requires the created marker; close is reverse-ordered and proven', async () => {
    const h = build(); await assert.rejects(h.port.verifyMarker(), error => error.code === 'browser-marker-absent');
    const { expected, observed } = expectedLive(h.manifest); await h.port.createMarker({ live: observed, expected });
    const result = await h.port.verifyMarker(); assert.equal(result.phase, 'U7'); assert.equal(h.port.openContexts(), 2); assert.equal(h.imports.length, 1, 'the smoke helpers load once');
    assert.deepEqual(h.events.filter(event => event.startsWith('launch')).length, 1);
    assert.deepEqual(await h.port.close(), { closed: true }); assert.deepEqual(h.events.filter(event => event.startsWith('close')), ['close-context:1', 'close-context:0', 'close-browser']); assert.equal(h.port.openContexts(), 0);
    assert.deepEqual(await h.port.close(), { closed: true });
});

test('a context or browser that fails to close is never reported closed and carries no browser detail', async () => {
    for (const overrides of [{ contextCloseFails: true }, { browserCloseFails: true }]) {
        const h = build(overrides); const { expected, observed } = expectedLive(h.manifest); await h.port.createMarker({ live: observed, expected });
        await assert.rejects(h.port.close(), error => error.code === 'browser-close-unproven' && !String(error.message).includes('PRIVATE'));
    }
});

test('a missing smoke module surface or Explorer repository refuses before launching a browser', async () => {
    const h = build(); const bad = createBrowserPort({ manifest: h.manifest, markerFiles: { readMarker: async () => ({ exists: false }), retainMarker() {} }, check() {}, processEnv: {}, importModule: async () => ({}), requireFrom: () => () => ({ chromium: { launch: async () => { throw new Error('must not launch'); } } }) });
    const { expected, observed } = expectedLive(h.manifest); await assert.rejects(bad.createMarker({ live: observed, expected }), error => error.code === 'browser-modules-unqualified');
    const noRepo = structuredClone(h.manifest); noRepo.candidate.repositories = noRepo.candidate.repositories.filter(repo => repo.name !== 'AssistOSExplorer');
    assert.throws(() => createBrowserPort({ manifest: noRepo, markerFiles: {}, check() {} }), error => error.code === 'browser-explorer-repository');
    assert.throws(() => createBrowserPort({ manifest: h.manifest, markerFiles: null, check() {} }), error => error.code === 'browser-port-adapters');
});
