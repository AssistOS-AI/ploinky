import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-image-phase-')));
const originalRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;

const {
    appendImageRefreshPhase,
    buildImageFilter,
    collectAdmittedImageTargets,
    createRetagLease,
    imageRefreshUpdateRecords,
    refreshAdmittedGraphImages,
    refreshUpdateImages,
    refreshWorkspaceGraphImages,
} = await import('../../cli/commands/updateImagePhase.js');
const { createImageRefreshSession } = await import('../../cli/sandbox/docker/imageRefresh.mjs');
const { decideUpdateStatus, buildUpdateResult, createOperationRecord } = await import('../../cli/commands/updateOutcome.js');
const { UpdateCancelledError } = await import('../../cli/commands/updateCancellation.js');

test.after(() => {
    process.chdir(originalCwd);
    if (originalRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = originalRoot;
    fs.rmSync(workspace, { recursive: true, force: true });
});

const REF = 'docker.io/assistos/roboteam-agent:runtime';
const OLD = `sha256:${'1'.repeat(64)}`;
const NEW = `sha256:${'2'.repeat(64)}`;
const REMOTE_DIGEST = `sha256:${'b'.repeat(64)}`;

function response(status, digest) {
    return { status, headers: { get: (name) => (name.toLowerCase() === 'docker-content-digest' ? digest ?? null : null) }, json: async () => ({}) };
}

function makeSession(overrides = {}) {
    const state = { heads: 0, pulls: [], tags: [], logs: [] };
    const session = createImageRefreshSession({
        policy: 'refresh',
        runtime: 'podman',
        log: (line) => state.logs.push(line),
        env: {},
        execArgv: [],
        fetchImpl: async () => { state.heads += 1; return response(200, REMOTE_DIGEST); },
        readRepoDigests: () => [],
        readImageId: (_runtime, ref) => (ref.includes('@') ? (state.pulls.includes(ref) ? NEW : null)
            : (state.pulls.includes(ref) || state.tags.length ? NEW : OLD)),
        pull: (ref) => { state.pulls.push(ref); },
        spawn: (_runtime, args) => { state.tags.push(args); return { status: 0 }; },
        ...overrides,
    });
    return { session, state };
}

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
        { action: 'deferred', canonical: 'docker.io/o/e:1', agents: [] },
        { action: 'retag-deferred', canonical: 'docker.io/o/f:1', agents: [] },
        { action: 'error', canonical: 'docker.io/o/g:1', agents: [], reason: 'boom' },
        { action: 'skipped', canonical: 'docker.io/o/h:1', agents: [] },
    ];
    const records = imageRefreshUpdateRecords(results);
    assert.deepEqual(records.map((record) => [record.phase, record.outcome, record.code, record.required]), [
        ['image', 'changed', 'image-refreshed', false],
        ['image', 'unchanged', 'image-current', false],
        ['image', 'skipped', 'registry-unreachable', false],
        ['image', 'skipped', 'image-pull-failed', false],
        ['image', 'skipped', 'image-refresh-deferred', false],
        ['image', 'skipped', 'image-retag-deferred', false],
        ['image', 'skipped', 'image-refresh-error', false],
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

test('filters: a repo update keeps that repo; a folder keeps checkout agents under it and always registered repos', () => {
    const reposDir = '/ws/.ploinky/repos';
    const at = (manifestPath, repoName = 'r') => ({ manifestPath, repoName });
    const repoFilter = buildImageFilter({ kind: 'repo', repoName: 'Alpha' });
    assert.equal(repoFilter(at('/x/m.json', 'Alpha')), true);
    assert.equal(repoFilter(at('/x/m.json', 'Beta')), false);
    const folder = buildImageFilter({ kind: 'all', folderPath: '/ws/projects/app' }, { reposDir });
    assert.equal(folder(at('/ws/.ploinky/repos/Explorer/a/manifest.json')), true, 'registered repo from a subdirectory run');
    assert.equal(folder(at('/ws/projects/app/agent/manifest.json')), true, 'checkout agent inside the folder');
    assert.equal(folder(at('/ws/projects/other/agent/manifest.json')), false, 'checkout agent outside the folder');
    assert.equal(folder(at('/ws/projects/app-sibling/manifest.json')), false);
    assert.equal(folder(at('')), false);
    assert.equal(buildImageFilter({ kind: 'all', folderPath: '' }, { reposDir }), null, 'a bare update has no filter');
});

test('refreshUpdateImages: nothing without a static agent; skipped while no-wait workers run; otherwise the filter reaches the graph', async () => {
    const logs = [];
    const session = { enabled: true };
    const calls = [];
    const deps = (overrides) => ({
        getConfig: () => ({ static: { agent: 'explorer' } }),
        inspectInFlightNoWaitWorkers: () => [],
        refreshWorkspaceGraphImages: async (received, options) => { calls.push([received, options]); return ['done']; },
        reposDir: '/ws/.ploinky/repos',
        ...overrides,
    });
    const request = { kind: 'all', folderPath: '/ws/sub' };
    assert.deepEqual(await refreshUpdateImages({ request, session, log: (l) => logs.push(l) }, deps({ getConfig: () => ({}) })), []);
    assert.equal(calls.length, 0);
    assert.deepEqual(await refreshUpdateImages({ request, session, log: (l) => logs.push(l) },
        deps({ inspectInFlightNoWaitWorkers: () => [{ containerName: 'c' }] })).then((r) => r.map((x) => [x.action, x.code])),
        [['phase-skipped', 'image-refresh-workers-active']]);
    assert.equal(calls.length, 0);
    assert.match(logs.join('\n'), /no-wait workers of an earlier start are still running/);
    assert.deepEqual(await refreshUpdateImages({ request, session, log: (l) => logs.push(l) }, deps()), ['done']);
    assert.equal(calls[0][0], session);
    assert.equal(calls[0][1].includeNoWait, true);
    assert.equal(calls[0][1].filter({ manifestPath: '/ws/.ploinky/repos/R/a/manifest.json' }), true);
    assert.equal(calls[0][1].filter({ manifestPath: '/ws/elsewhere/manifest.json' }), false);
    await refreshUpdateImages({ request: { kind: 'all', folderPath: '' }, session, log: () => {} }, deps());
    assert.equal(calls[1][1].filter, null);
});

test('retag lease: runs under the lease and releases it; a busy lease is not ok; other errors propagate; a held lease is reused', async () => {
    const events = [];
    const lease = { token: 't' };
    const run = createRetagLease({ acquire: async (o) => { events.push(['acquire', o.operation]); return lease; }, release: (l) => events.push(['release', l.token]) });
    assert.deepEqual(await run(() => { events.push(['fn']); return 7; }), { ok: true, value: 7 });
    assert.deepEqual(events, [['acquire', 'update-image-retag'], ['fn'], ['release', 't']]);
    const busy = createRetagLease({ acquire: async () => { throw Object.assign(new Error('busy'), { code: 'PLOINKY_WORKSPACE_MUTATION_BUSY' }); } });
    assert.deepEqual(await busy(() => 1), { ok: false });
    const broken = createRetagLease({ acquire: async () => { throw new Error('disk'); } });
    await assert.rejects(broken(() => 1), /disk/);
    let acquired = false;
    const held = createRetagLease({ heldLease: lease, acquire: async () => { acquired = true; } });
    assert.deepEqual(await held(() => 2), { ok: true, value: 2 });
    assert.equal(acquired, false);
});

function gitResult(overrides = {}) {
    const record = createOperationRecord({ phase: 'workspace-repository', id: 'Alpha', outcome: 'changed', required: false });
    return { ...buildUpdateResult({ records: [record] }), ...overrides };
}

const phaseOptions = (overrides = {}) => ({
    request: { kind: 'all', folderPath: '' },
    policy: 'refresh',
    cancellation: { checkpoint: async () => {} },
    hostActivates: false,
    log: () => {},
    deadlineMs: Infinity,
    refreshImages: async () => [],
    ...overrides,
});

test('phase: an ignored policy value warns once, adds no record and refreshes as usual', async () => {
    const logs = [];
    let called = false;
    const result = await appendImageRefreshPhase(gitResult(), phaseOptions({
        ignoredValue: 'always', log: (line) => logs.push(line), refreshImages: async () => { called = true; return []; },
    }));
    assert.equal(called, true);
    assert.equal(logs.filter((line) => /PLOINKY_IMAGE_REFRESH='always' is ignored/.test(line)).length, 1);
    assert.equal(result.records.some((record) => record.phase === 'image'), false);
    assert.equal(result.exitCode, 0);
});

test('phase: off logs one line and pulls nothing', async () => {
    const logs = [];
    let called = false;
    const input = gitResult();
    const result = await appendImageRefreshPhase(input, phaseOptions({
        policy: 'off', log: (line) => logs.push(line), refreshImages: async () => { called = true; return []; },
    }));
    assert.equal(called, false);
    assert.equal(result, input);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Image refresh is turned off for this workspace/);
});

test('phase: a failed or recovery-needing git phase skips the image phase with one record', async () => {
    const failed = buildUpdateResult({ records: [createOperationRecord({ phase: 'workspace-repository', id: 'Alpha', outcome: 'failed', required: true })] });
    let called = false;
    const result = await appendImageRefreshPhase(failed, phaseOptions({ refreshImages: async () => { called = true; return []; } }));
    assert.equal(called, false);
    assert.equal(result.records.at(-1).code, 'image-refresh-skipped-git-failed');
    assert.equal(result.exitCode, failed.exitCode, 'the skip changes nothing about the exit status');
});

test('phase: update repos adds nothing and never refreshes', async () => {
    for (const options of [{ request: { kind: 'repos' } }]) {
        let called = false;
        const input = gitResult();
        const result = await appendImageRefreshPhase(input, phaseOptions({ ...options, refreshImages: async () => { called = true; return []; } }));
        assert.equal(called, false);
        assert.equal(result, input);
    }
});

test('phase: budget exhaustion records the remaining refs as deferred and the update still succeeds', async () => {
    const result = await appendImageRefreshPhase(gitResult(), phaseOptions({
        deadlineMs: 0,
        sessionOptions: { runtime: 'podman', readRepoDigests: () => [], env: {}, execArgv: [] },
        refreshImages: async ({ session }) => {
            await session.refresh(REF, { agents: ['r/a'] });
            await session.refresh('ghcr.io/o/other:1', { agents: ['r/b'] });
            return session.results();
        },
    }));
    const images = result.records.filter((record) => record.phase === 'image');
    assert.deepEqual(images.map((record) => record.code), ['image-refresh-deferred', 'image-refresh-deferred']);
    assert.equal(result.exitCode, 0);
    assert.equal(result.activationAllowed, true);
});

test('phase: digest pull plus retag end to end, and a busy lease records image-retag-deferred', async () => {
    const run = async (withRetagLease) => {
        const tags = [];
        const pulls = [];
        const result = await appendImageRefreshPhase(gitResult(), phaseOptions({
            sessionOptions: {
                runtime: 'podman', env: {}, execArgv: [], readRepoDigests: () => [],
                fetchImpl: async () => response(200, REMOTE_DIGEST),
                readImageId: (_rt, ref) => (ref.includes('@') ? (pulls.includes(ref) ? NEW : null)
                    : (pulls.includes(ref) || tags.length ? NEW : OLD)),
                pull: (ref) => { pulls.push(ref); },
                spawn: (_rt, args) => { tags.push(args); return { status: 0 }; },
                ...(withRetagLease ? { withRetagLease } : {}),
            },
            refreshImages: async ({ session }) => { await session.refresh(REF, { agents: ['r/a'] }); return session.results(); },
        }));
        return { result, tags, pulls };
    };
    const ok = await run(null);
    assert.equal(ok.result.records.at(-1).code, 'image-refreshed');
    assert.deepEqual(ok.pulls, [`docker.io/assistos/roboteam-agent@${REMOTE_DIGEST}`]);
    assert.deepEqual(ok.tags, [['tag', NEW, REF]]);
    const busy = await run(async () => ({ ok: false }));
    assert.equal(busy.result.records.at(-1).code, 'image-retag-deferred');
    assert.equal(busy.tags.length, 0);
    assert.equal(busy.result.exitCode, 0);
});

test('phase: the cancellation checkpoint carries the image records so far; a pull killed by a signal is a cancellation', async () => {
    const seen = [];
    let signal = false;
    const cancellation = {
        checkpoint: async (stage, records) => {
            seen.push([stage, records.map((record) => record.code || record.phase)]);
            if (signal) throw new UpdateCancelledError('SIGTERM', stage, records);
        },
    };
    let pulls = 0;
    await assert.rejects(appendImageRefreshPhase(gitResult(), phaseOptions({
        cancellation,
        sessionOptions: {
            runtime: 'podman', env: {}, execArgv: [], readRepoDigests: () => [],
            fetchImpl: async () => response(200, REMOTE_DIGEST),
            readImageId: (_rt, ref) => (ref.includes('@') ? (pulls ? NEW : null) : (ref.startsWith('ghcr') && pulls > 1 ? NEW : OLD)),
            pull: () => {
                pulls += 1;
                if (pulls === 2) { signal = true; throw new Error('terminated'); }
            },
            spawn: () => ({ status: 0 }),
        },
        refreshImages: async ({ session }) => {
            await session.refresh(REF, { agents: ['r/a'] });
            await session.refresh('ghcr.io/o/second:1', { agents: ['r/b'] });
            return session.results();
        },
    })), (error) => {
        assert.ok(error instanceof UpdateCancelledError);
        const codes = error.records.map((record) => record.code || record.phase);
        assert.deepEqual(codes, ['workspace-repository', 'image-refreshed']);
        return true;
    });
    assert.ok(seen.some(([, codes]) => codes.includes('image-refreshed')), 'a later checkpoint includes the earlier image record');
});

test('silent skips leave one optional skipped record each, so the update is not reported as fully verified', async () => {
    const workers = await refreshUpdateImages({ request: { kind: 'all', folderPath: '' }, session: { enabled: true }, log: () => {} }, {
        getConfig: () => ({ static: { agent: 'x' } }), inspectInFlightNoWaitWorkers: () => [{ containerName: 'c' }],
    });
    const graph = await refreshWorkspaceGraphImages({ enabled: true });
    assert.deepEqual(graph.map((entry) => entry.code), ['image-refresh-graph-unavailable']);
    const thrown = await appendImageRefreshPhase(gitResult(), phaseOptions({ refreshImages: async () => { throw new Error('graph exploded'); } }));
    const cases = [
        ['image-refresh-workers-active', imageRefreshUpdateRecords(workers)],
        ['image-refresh-graph-unavailable', imageRefreshUpdateRecords(graph)],
        ['image-refresh-error', thrown.records.filter((record) => record.phase === 'image')],
    ];
    for (const [code, records] of cases) {
        assert.equal(records.length, 1, code);
        assert.deepEqual([records[0].outcome, records[0].required, records[0].code], ['skipped', false, code]);
        const decision = decideUpdateStatus(records);
        assert.equal(decision.status, 'complete-with-skips', 'not claimed as complete');
        assert.equal(decision.exitCode, 0);
    }
});

test('phase: only activationAllowed === false skips the image phase; a partial update still refreshes', async () => {
    const partial = buildUpdateResult({ records: [
        createOperationRecord({ phase: 'workspace-repository', id: 'Gone', outcome: 'failed', required: false }),
    ] });
    assert.equal(partial.status, 'partial');
    assert.equal(partial.activationAllowed, true);
    let called = false;
    await appendImageRefreshPhase(partial, phaseOptions({ refreshImages: async () => { called = true; return []; } }));
    assert.equal(called, true);
});

test('retag lease: a lease that cannot be released exactly is reported as a warning', async () => {
    const logs = [];
    const run = createRetagLease({ acquire: async () => ({}), release: () => false, log: (line) => logs.push(line) });
    assert.deepEqual(await run(() => 1), { ok: true, value: 1 });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /could not be released exactly/);
});

test('phase: the retag callback re-reads the policy, so turning refresh off during the pull keeps the local tag', async () => {
    const tags = [];
    let pulled = false;
    const result = await appendImageRefreshPhase(gitResult(), phaseOptions({
        sessionOptions: {
            runtime: 'podman', env: {}, execArgv: [], readRepoDigests: () => [],
            fetchImpl: async () => response(200, REMOTE_DIGEST),
            readImageId: (_rt, ref) => (ref.includes('@') ? (pulled ? NEW : null) : OLD),
            pull: () => { pulled = true; },
            spawn: (_rt, args) => { tags.push(args); return { status: 0 }; },
            stillEnabled: () => false,
        },
        refreshImages: async ({ session }) => { await session.refresh(REF, { agents: ['r/a'] }); return session.results(); },
    }));
    assert.equal(tags.length, 0);
    assert.equal(result.records.at(-1).code, 'image-refresh-turned-off');
    assert.equal(result.exitCode, 0);
});
