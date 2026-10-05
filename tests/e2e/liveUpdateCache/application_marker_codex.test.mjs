import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { manifestFixture, installPureGuards, H } from './test_support_codex.mjs';
import { applicationMarker, createApplicationMarker, verifyApplicationMarker } from './application_marker_codex.mjs';
installPureGuards();

const rejects = (operation, code) => assert.rejects(operation, error => error.code === code);
const copies = value => structuredClone(value);

// The pure control builds the expected/observed pair that U0 would hand to assertLiveBefore.
function liveFixture(manifest) {
    const candidate = { imageId: manifest.box.imageId, repositories: manifest.candidate.repositories.map(repo => ({
        name: repo.name, commit: repo.commit, pushedCommit: repo.pushedCommit, branch: repo.branch, upstream: repo.upstream, clean: true, detached: false })) };
    const expected = { workspace: { path: manifest.workspace.path, dev: manifest.workspace.dev, ino: manifest.workspace.ino, uid: manifest.workspace.uid },
        box: { id: manifest.box.id, imageId: manifest.box.imageId, startedAt: manifest.box.startedAt }, candidate,
        requiredGraph: manifest.graph.map(entry => ({ name: entry.name, noWait: entry.noWait, externalHealthRequired: entry.externalHealthRequired })),
        publications: 'router-media-only', sourceMounts: 'read-only-source', engineIdentity: 'selected-engine', activeGeneration: manifest.box.activeGeneration };
    const observed = { ...copies(expected), hostPlatform: 'linux', engine: 'podman', rootless: true, running: true, initialized: true,
        pendingActivation: false, recoveryBarrier: false,
        graph: manifest.graph.map(entry => ({ name: entry.name, ready: true, running: true, runtimeId: `${entry.name}-runtime`,
            instanceId: `${entry.name}-instance`, enableGeneration: 'enabled-1', graphGeneration: manifest.box.activeGeneration, externalHealth: true })) };
    return { expected, observed };
}

function harness(manifest, overrides = {}) {
    const calls = [], retained = [];
    const origin = `http://${manifest.publications[0].hostIP}:${manifest.publications[0].hostPort}`;
    const marker = applicationMarker(manifest);
    const state = { stored: null, predicate: null, inputFiles: null, pageOrigin: origin, uploadStatus: 200, uploadFails: false };
    Object.assign(state, overrides.state);
    const response = { url: () => `${origin}/upload?path=${encodeURIComponent(marker.applicationPath)}`, request: () => ({ method: () => 'POST' }), status: () => state.uploadStatus };
    const page = {
        url: () => state.pageOrigin + '/',
        waitForResponse: (predicate, options) => { state.predicate = predicate; calls.push('waitForResponse');
            return state.uploadFails ? Promise.reject(new Error('PRIVATE-BROWSER-DETAIL')) : Promise.resolve(response); },
        waitForFunction: async () => { calls.push('waitForFunction'); },
        locator: selector => ({
            setInputFiles: async (file, options) => { calls.push(`setInputFiles:${selector}`); state.inputFiles = { file, options };
                if (overrides.setInputFails) throw new Error('PRIVATE-BROWSER-DETAIL'); },
            click: async () => { calls.push(`click:${selector}`); },
            textContent: async () => overrides.preview ?? marker.text,
        }),
    };
    const stored = () => ({ exists: true, boxId: manifest.box.id, path: marker.workspacePath, bytes: marker.bytes.length, sha256: marker.sha256,
        regular: true, links: 1, identity: { dev: 1, ino: 77 }, ...overrides.storedFields });
    const adapters = {
        page,
        openExplorer: async (_page, options) => { calls.push(`openExplorer:${options.hash}`); },
        assertExplorerDirectory: async (_page, directory) => { calls.push(`assertExplorerDirectory:${directory}`); },
        readMarker: async () => { calls.push('readMarker'); return state.stored ?? (calls.filter(name => name === 'readMarker').length === 1 ? { exists: false } : stored()); },
        retainMarker: row => { calls.push(`retainMarker:${row.ownership ?? 'CREATED'}`); retained.push(row); },
        check: () => { calls.push('check'); },
        actionTimeoutMs: 30000,
    };
    return { calls, retained, state, adapters, marker, origin, stored };
}
const significant = calls => calls.filter(name => name !== 'check');

test('marker helper imports the real live-admission export and creates only after proven live admission', async () => {
    const { value: manifest } = manifestFixture(), { expected, observed } = liveFixture(manifest);
    const h = harness(manifest);
    const receipt = await createApplicationMarker({ manifest, live: observed, expected, ...h.adapters });
    assert.deepEqual(receipt, { phase: 'U1', markerPath: h.marker.applicationPath, byteCount: h.marker.bytes.length, sha256: h.marker.sha256,
        uploaded: true, previewed: true, storageProved: true });
    assert.deepEqual(significant(h.calls), ['readMarker', 'retainMarker:CREATION_PENDING_AFTER_PROVEN_ABSENCE', 'openExplorer:file-exp/',
        'assertExplorerDirectory:/', 'waitForResponse', 'setInputFiles:file-exp #fileUploadInput', 'waitForFunction', 'readMarker', 'retainMarker:CREATED']);
    assert.equal(h.retained[0].identity, null); assert.deepEqual(h.retained[1].identity, { dev: 1, ino: 77 });
    assert.equal(h.state.inputFiles.file.name, h.marker.name); assert.deepEqual(h.state.inputFiles.file.buffer, h.marker.bytes);
    // The response observer accepts only this origin's owned upload of the exact marker path.
    const good = { url: () => `${h.origin}/upload?path=${encodeURIComponent(h.marker.applicationPath)}`, request: () => ({ method: () => 'POST' }) };
    assert.equal(h.state.predicate(good), true);
    for (const row of [{ url: () => `http://127.0.0.1:1/upload?path=${encodeURIComponent(h.marker.applicationPath)}`, request: () => ({ method: () => 'POST' }) },
        { url: () => `${h.origin}/upload?path=%2Fother`, request: () => ({ method: () => 'POST' }) },
        { url: () => good.url(), request: () => ({ method: () => 'GET' }) }]) assert.equal(h.state.predicate(row), false);
    assert.equal(h.marker.name, `update-persistence-${manifest.runId.replace(/_codex$/, '')}_codex.txt`);
});

test('a stale or unlive deployment refuses before any marker read, retention or browser action', async () => {
    const { value: manifest } = manifestFixture();
    for (const [key, code] of [['running', 'workspace-not-live'], ['pendingActivation', 'workspace-not-live'], ['rootless', 'runtime-host-unqualified']]) {
        const { expected, observed } = liveFixture(manifest); observed[key] = key === 'pendingActivation' ? true : false;
        const h = harness(manifest);
        await rejects(createApplicationMarker({ manifest, live: observed, expected, ...h.adapters }), code);
        assert.deepEqual(h.calls, []);
    }
    const { expected, observed } = liveFixture(manifest); observed.graph[0].ready = false;
    const h = harness(manifest);
    await rejects(createApplicationMarker({ manifest, live: observed, expected, ...h.adapters }), 'graph-not-ready'); assert.deepEqual(h.calls, []);
    // The old call shape (admission arguments positional) must not be accepted as a live proof.
    const swapped = liveFixture(manifest), g = harness(manifest);
    await assert.rejects(createApplicationMarker({ manifest, live: swapped.expected, expected: swapped.observed, ...g.adapters })); assert.deepEqual(g.calls, []);
});

test('existing marker, wrong origin, browser failure and storage mismatch fail closed without claiming success', async () => {
    const { value: manifest } = manifestFixture(), { expected, observed } = liveFixture(manifest);
    let h = harness(manifest, { state: { stored: { exists: true } } });
    await rejects(createApplicationMarker({ manifest, live: observed, expected, ...h.adapters }), 'application-marker-already-present');
    assert.deepEqual(h.retained, []);
    h = harness(manifest, { state: { pageOrigin: 'http://127.0.0.1:9' } });
    await rejects(createApplicationMarker({ manifest, live: observed, expected, ...h.adapters }), 'application-marker-origin');
    assert.equal(h.retained.length, 1); assert.equal(h.retained[0].ownership, 'CREATION_PENDING_AFTER_PROVEN_ABSENCE');
    assert.equal(h.calls.some(name => name.startsWith('setInputFiles')), false);
    h = harness(manifest, { setInputFails: true });
    await assert.rejects(createApplicationMarker({ manifest, live: observed, expected, ...h.adapters }), error => error.code === 'application-marker-browser' && !String(error.message).includes('PRIVATE'));
    assert.equal(h.retained.length, 1);
    h = harness(manifest, { state: { uploadStatus: 500 } });
    await rejects(createApplicationMarker({ manifest, live: observed, expected, ...h.adapters }), 'application-marker-upload');
    for (const fields of [{ sha256: H('other') }, { links: 2 }, { regular: false }, { boxId: H('other-box') }, { identity: null }, { bytes: 1 }]) {
        h = harness(manifest, { storedFields: fields });
        await rejects(createApplicationMarker({ manifest, live: observed, expected, ...h.adapters }), 'application-marker-storage');
        assert.equal(h.retained.length, 1, 'ownership remains pending, never CREATED, without storage proof');
    }
});

test('post-update verification requires the same marker bytes in storage and Explorer preview', async () => {
    const { value: manifest } = manifestFixture(), h = harness(manifest);
    const marker = Object.freeze({ ...h.marker, bytes: h.marker.bytes.length });
    const receipt = await verifyApplicationMarker({ marker, page: h.adapters.page, ...h.adapters, readMarker: async () => h.stored() });
    assert.deepEqual(receipt, { phase: 'U7', markerPath: marker.applicationPath, sha256: marker.sha256, storageProved: true, previewed: true });
    await rejects(verifyApplicationMarker({ marker, page: h.adapters.page, ...h.adapters, readMarker: async () => ({ ...h.stored(), sha256: H('changed') }) }), 'application-marker-not-preserved');
    await rejects(verifyApplicationMarker({ marker, page: h.adapters.page, ...h.adapters, readMarker: async () => ({ exists: false }) }), 'application-marker-not-preserved');
    const other = harness(manifest, { preview: 'different preview content' });
    await rejects(verifyApplicationMarker({ marker, page: other.adapters.page, ...other.adapters, readMarker: async () => other.stored() }), 'application-marker-preview-not-preserved');
});

test('this control performs no process, network or filesystem runtime operation', () => {
    assert.throws(() => cp.spawnSync('true'), /PURE_REAL_OPERATION_FORBIDDEN/);
});
