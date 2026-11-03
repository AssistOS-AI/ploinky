import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-image-refresh-')));
const originalRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;

const {
    collectAdmittedImageTargets,
    createImageRefreshSession,
    imageRefreshUpdateRecords,
    refreshAdmittedGraphImages,
    resolveImageRefreshPolicy,
} = await import('../../cli/sandbox/docker/imageRefresh.mjs');
const { decideUpdateStatus } = await import('../../cli/commands/updateOutcome.js');

test.after(() => {
    process.chdir(originalCwd);
    if (originalRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = originalRoot;
    fs.rmSync(workspace, { recursive: true, force: true });
});

const REF = 'docker.io/assistos/roboteam-agent:runtime';
const OLD = `sha256:${'1'.repeat(64)}`;
const NEW = `sha256:${'2'.repeat(64)}`;
const LOCAL_DIGEST = `sha256:${'a'.repeat(64)}`;
const REMOTE_DIGEST = `sha256:${'b'.repeat(64)}`;

function response(status, digest) {
    return { status, headers: { get: (name) => (name.toLowerCase() === 'docker-content-digest' ? digest ?? null : null) }, json: async () => ({}) };
}

// A session with every seam injected: no network, no engine.
function makeSession(overrides = {}) {
    const state = { heads: 0, pulls: [], logs: [], ids: [OLD, NEW], local: [`docker.io/assistos/roboteam-agent@${LOCAL_DIGEST}`] };
    const session = createImageRefreshSession({
        policy: 'check',
        runtime: 'podman',
        log: (line) => state.logs.push(line),
        env: {},
        execArgv: [],
        fetchImpl: async () => { state.heads += 1; return response(200, REMOTE_DIGEST); },
        readRepoDigests: () => state.local,
        readImageId: () => (state.pulls.length ? state.ids[1] : state.ids[0]),
        pull: (ref) => { state.pulls.push(ref); },
        ...overrides,
    });
    return { session, state };
}

test('policy: the workspace variable wins over the environment, then the default', () => {
    assert.equal(resolveImageRefreshPolicy({ env: { PLOINKY_IMAGE_REFRESH: 'always' }, readVar: () => 'off' }), 'off');
    assert.equal(resolveImageRefreshPolicy({ env: { PLOINKY_IMAGE_REFRESH: 'always' }, readVar: () => '' }), 'always');
    assert.equal(resolveImageRefreshPolicy({ env: {}, readVar: () => '' }), 'check');
});

test('policy: an unreadable variable store falls back to the environment; invalid values throw', () => {
    const readVar = () => { throw new Error('boom'); };
    assert.equal(resolveImageRefreshPolicy({ env: { PLOINKY_IMAGE_REFRESH: 'off' }, readVar }), 'off');
    assert.throws(() => resolveImageRefreshPolicy({ env: { PLOINKY_IMAGE_REFRESH: 'bogus' }, readVar: () => '' }),
        { code: 'PLOINKY_IMAGE_REFRESH_INVALID' });
    assert.throws(() => resolveImageRefreshPolicy({ env: {}, readVar: () => 'Check' }), { code: 'PLOINKY_IMAGE_REFRESH_INVALID' });
});

test('session: two agents on one ref make one HEAD, one pull, and the rollback hint names the old ID', async () => {
    const { session, state } = makeSession();
    const first = await session.refresh(REF, { agents: ['repo/a'] });
    const second = await session.refresh(REF, { agents: ['repo/b'] });
    assert.equal(first.action, 'refreshed');
    assert.equal(second, first);
    assert.equal(state.heads, 1);
    assert.deepEqual(state.pulls, [REF]);
    assert.deepEqual(first.agents, ['repo/a', 'repo/b']);
    const log = state.logs.join('\n');
    assert.match(log, /registry digest differs/);
    assert.match(log, new RegExp(`previous image ${'1'.repeat(64)}`));
    assert.match(log, new RegExp(`podman tag ${'1'.repeat(64)} ${REF}`));
    assert.match(session.summaryLine(), /1 refreshed, 0 current, 0 unavailable, 0 failed/);
});

test('session: pinned, unqualified, localhost and missing images make no fetch and no pull', async () => {
    for (const [ref, local] of [
        [`docker.io/o/r@sha256:${'c'.repeat(64)}`, []],
        ['node:18-alpine', []],
        ['localhost/o/r:1', []],
        ['localhost:5000/o/r:1', []],
        [REF, null],
        ['not a ref', []],
    ]) {
        const { session, state } = makeSession({ readRepoDigests: () => local });
        const result = await session.refresh(ref);
        assert.equal(result.action, 'skipped', ref);
        assert.equal(state.heads, 0, ref);
        assert.equal(state.pulls.length, 0, ref);
        assert.equal(session.results().length, 0, 'skipped refs are not reported');
    }
});

test('session: an equal digest means no pull', async () => {
    const { session, state } = makeSession({ fetchImpl: async () => response(200, LOCAL_DIGEST) });
    assert.equal((await session.refresh(REF)).action, 'current');
    assert.equal(state.pulls.length, 0);
});

test('session: an empty RepoDigests set and an undetermined registry answer both delegate to a pull', async () => {
    const empty = makeSession({ readRepoDigests: () => [] });
    assert.equal((await empty.session.refresh(REF)).action, 'refreshed');
    const undetermined = makeSession({ fetchImpl: async () => response(404) });
    assert.equal((await undetermined.session.refresh(REF)).action, 'refreshed');
    assert.match(undetermined.state.logs.join('\n'), /asking podman to pull/);
});

test('session: a pull that finds nothing new is current, not refreshed', async () => {
    const { session } = makeSession({ readImageId: () => OLD });
    assert.equal((await session.refresh(REF)).action, 'current');
});

test('session: an unavailable registry warns once and keeps the cached image', async () => {
    const { session, state } = makeSession({ fetchImpl: async () => response(503) });
    const result = await session.refresh(REF);
    assert.equal(result.action, 'unavailable');
    assert.equal(state.pulls.length, 0);
    assert.equal(state.logs.filter((line) => /Warning: registry/.test(line)).length, 1);
});

test('session: a throwing pull is pull-failed and never throws; credentials in the message are removed', async () => {
    const { session, state } = makeSession({ pull: () => { throw new Error('failed https://user:pw@host/x'); } });
    const result = await session.refresh(REF);
    assert.equal(result.action, 'pull-failed');
    assert.equal(result.reason.includes('pw'), false);
    assert.match(state.logs.join('\n'), /Warning: pull of .* failed/);
});

test('session: policy always skips the registry check; off makes no calls', async () => {
    const always = makeSession({ policy: 'always' });
    assert.equal((await always.session.refresh(REF)).action, 'refreshed');
    assert.equal(always.state.heads, 0);
    assert.equal(always.session.enabled, true);
    const off = makeSession({ policy: 'off' });
    assert.equal(off.session.enabled, false);
    assert.equal((await off.session.refresh(REF)).action, 'skipped');
    assert.equal(off.state.heads + off.state.pulls.length, 0);
});

test('session: a proxy that native fetch would ignore delegates to the engine without a HEAD', async () => {
    const { session, state } = makeSession({ env: { HTTPS_PROXY: 'http://proxy:3128' } });
    assert.equal((await session.refresh(REF)).action, 'refreshed');
    assert.equal(state.heads, 0);
});

test('session: an error from beforePull propagates unchanged and nothing is pulled', async () => {
    const cancelled = new Error('cancelled');
    const { session, state } = makeSession({ beforePull: async () => { throw cancelled; } });
    await assert.rejects(session.refresh(REF), (error) => error === cancelled);
    assert.equal(state.pulls.length, 0);
});

test('session: an unknown runtime is skipped', async () => {
    const { session, state } = makeSession({ runtime: null });
    assert.equal((await session.refresh(REF)).action, 'skipped');
    assert.equal(state.heads, 0);
});

function admission(nodeId, agentId, { manifest, runtimeKind = 'container', hardwareRefusal = null, catalogIdentity = null } = {}) {
    const bytes = Buffer.from(JSON.stringify(manifest || { container: REF }));
    return {
        nodeId,
        manifestPath: `/ws/${agentId}/manifest.json`,
        manifestBytesBase64: bytes.toString('base64'),
        profileName: 'default',
        runtimeKind,
        hardwareRefusal,
        admission: { agentId, descriptor: { catalogIdentity } },
    };
}

function admitted(admissions) {
    const nodes = new Map([
        ['s', { dependencies: new Set(['w']), dependencyEdges: new Map([['w', { noWait: true }]]) }],
        ['w', { dependencies: new Set(), dependencyEdges: new Map() }],
        ['b', { dependencies: new Set(), dependencyEdges: new Map() }],
    ]);
    nodes.get('s').dependencies.add('b');
    return { graph: { nodes, staticNodeId: 's' }, admissions };
}

test('targets: no-wait nodes only with includeNoWait; extra nodes count as blocking', () => {
    const start = admitted([
        admission('s', 'repo/static'),
        admission('w', 'repo/waiter', { manifest: { container: 'ghcr.io/o/waiter:1' } }),
        admission('extra:c', 'repo/extra', { manifest: { container: 'ghcr.io/o/extra:1' } }),
    ]);
    const blocking = collectAdmittedImageTargets(start, {});
    assert.deepEqual(blocking.map((target) => target.agentName).sort(), ['extra', 'static']);
    const all = collectAdmittedImageTargets(start, { includeNoWait: true });
    assert.deepEqual(all.map((target) => target.ref).sort(), ['docker.io/assistos/roboteam-agent:runtime', 'ghcr.io/o/extra:1', 'ghcr.io/o/waiter:1']);
    assert.equal(all[0].repoName, 'repo');
    assert.equal(collectAdmittedImageTargets(start, { includeNoWait: true, filter: (target) => target.agentName === 'waiter' }).length, 1);
});

test('targets: sandbox, hardware-refused and catalog-digest records are skipped; a catalog ref beats the manifest image', () => {
    const start = admitted([
        admission('s', 'repo/sandbox', { runtimeKind: 'bwrap' }),
        admission('b', 'repo/refused', { hardwareRefusal: { code: 'x' } }),
        admission('extra:p', 'repo/pinned', { catalogIdentity: { imageRef: 'ghcr.io/o/m:1', imageDigest: `sha256:${'d'.repeat(64)}` } }),
        admission('extra:q', 'repo/llm', { catalogIdentity: { imageRef: 'ghcr.io/o/llm:2', imageDigest: '' } }),
    ]);
    const targets = collectAdmittedImageTargets(start, { includeNoWait: true });
    assert.deepEqual(targets.map((target) => [target.agentName, target.ref]), [['llm', 'ghcr.io/o/llm:2']]);
});

test('targets: an unresolved placeholder or a broken manifest is skipped without a throw', () => {
    const start = admitted([
        admission('s', 'repo/placeholder', { manifest: { container: 'ghcr.io/o/r:${NOT_SET_ANYWHERE}' } }),
        { ...admission('b', 'repo/broken'), manifestBytesBase64: Buffer.from('{not json').toString('base64') },
        admission('extra:ok', 'repo/ok', { manifest: { container: 'ghcr.io/o/ok:1' } }),
    ]);
    assert.deepEqual(collectAdmittedImageTargets(start, { includeNoWait: true }).map((target) => target.agentName), ['ok']);
});

test('refreshAdmittedGraphImages refreshes each distinct ref once with every agent and prints the summary', async () => {
    const start = admitted([admission('s', 'repo/one'), admission('b', 'repo/two')]);
    const { session, state } = makeSession();
    const printed = [];
    const original = console.log;
    console.log = (line) => printed.push(String(line));
    try {
        const results = await refreshAdmittedGraphImages(start, session, { includeNoWait: true });
        assert.equal(results.length, 1);
        assert.deepEqual(results[0].agents, ['repo/one', 'repo/two']);
    } finally {
        console.log = original;
    }
    assert.equal(state.heads, 1);
    assert.ok(printed.some((line) => /Image refresh: 1 refreshed/.test(line)));
});

test('update records follow the outcome table and a failed pull still exits 0 with activation allowed', () => {
    const results = [
        { action: 'refreshed', canonical: 'docker.io/o/a:1', agents: ['r/a'], beforeId: OLD, afterId: NEW },
        { action: 'current', canonical: 'docker.io/o/b:1', agents: ['r/b'] },
        { action: 'unavailable', canonical: 'docker.io/o/c:1', agents: [], reason: 'ENOTFOUND' },
        { action: 'pull-failed', canonical: 'docker.io/o/d:1', agents: [], reason: 'exit 1' },
        { action: 'skipped', canonical: 'docker.io/o/e:1', agents: [] },
    ];
    const records = imageRefreshUpdateRecords(results);
    assert.deepEqual(records.map((record) => [record.phase, record.outcome, record.code, record.required]), [
        ['image', 'changed', 'image-refreshed', false],
        ['image', 'unchanged', 'image-current', false],
        ['image', 'skipped', 'registry-unreachable', false],
        ['image', 'skipped', 'image-pull-failed', false],
    ]);
    assert.deepEqual(records[0].before, { imageId: OLD });
    assert.deepEqual(records[0].after, { imageId: NEW });
    assert.deepEqual(records[0].details, { agents: ['r/a'] });
    assert.equal(records[3].attempted, true);
    const decision = decideUpdateStatus(records);
    assert.equal(decision.status, 'complete-with-skips');
    assert.equal(decision.exitCode, 0);
    assert.equal(decision.activationAllowed, true);
});
