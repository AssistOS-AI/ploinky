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
    createImageRefreshSession,
    resolveImageRefreshPolicy,
} = await import('../../cli/sandbox/docker/imageRefresh.mjs');

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
    const state = {
        heads: 0, pulls: [], tags: [], logs: [], ids: [OLD, NEW], local: [`docker.io/assistos/roboteam-agent@${LOCAL_DIGEST}`],
    };
    const session = createImageRefreshSession({
        policy: 'check',
        runtime: 'podman',
        log: (line) => state.logs.push(line),
        env: {},
        execArgv: [],
        fetchImpl: async () => { state.heads += 1; return response(200, REMOTE_DIGEST); },
        readRepoDigests: () => state.local,
        readImageId: () => (state.pulls.length ? state.ids[1] : state.ids[0]),
        pull: (ref, options) => { state.pulls.push(ref); state.timeouts = [...(state.timeouts || []), options.timeoutMs]; },
        spawn: (_runtime, args) => { state.tags.push(args); return { status: 0 }; },
        ...overrides,
    });
    return { session, state };
}

test('policy: off is the only recognised value and comes only from the workspace variable', () => {
    assert.deepEqual(resolveImageRefreshPolicy({ readVar: () => 'off' }), { policy: 'off', ignoredValue: '' });
    assert.deepEqual(resolveImageRefreshPolicy({ readVar: () => '  off ' }), { policy: 'off', ignoredValue: '' });
    assert.deepEqual(resolveImageRefreshPolicy({ readVar: () => '' }), { policy: 'refresh', ignoredValue: '' });
});

test('policy: the process environment is not consulted', () => {
    const previous = process.env.PLOINKY_IMAGE_REFRESH;
    process.env.PLOINKY_IMAGE_REFRESH = 'off';
    try {
        assert.equal(resolveImageRefreshPolicy({ readVar: () => '' }).policy, 'refresh');
    } finally {
        if (previous === undefined) delete process.env.PLOINKY_IMAGE_REFRESH;
        else process.env.PLOINKY_IMAGE_REFRESH = previous;
    }
});

test('policy: any other value, including the removed check and always modes, is ignored and reported', () => {
    for (const value of ['check', 'always', 'Off', 'bogus']) {
        assert.deepEqual(resolveImageRefreshPolicy({ readVar: () => value }), { policy: 'refresh', ignoredValue: value });
    }
});

test('policy: an unreadable variable store refreshes', () => {
    assert.deepEqual(resolveImageRefreshPolicy({ readVar: () => { throw new Error('boom'); } }), { policy: 'refresh', ignoredValue: '' });
});

const DIGEST_REF = `docker.io/assistos/roboteam-agent@${REMOTE_DIGEST}`;

test('session: a known registry digest is pulled by digest, then the tag is moved; one HEAD for two agents', async () => {
    const { session, state } = makeSession();
    const first = await session.refresh(REF, { agents: ['repo/a'] });
    const second = await session.refresh(REF, { agents: ['repo/b'] });
    assert.equal(first.action, 'refreshed');
    assert.equal(second, first);
    assert.equal(state.heads, 1);
    assert.deepEqual(state.pulls, [DIGEST_REF], 'the tag itself is never pulled');
    assert.deepEqual(state.tags, [['tag', NEW, REF]]);
    assert.deepEqual(first.agents, ['repo/a', 'repo/b']);
    const log = state.logs.join('\n');
    assert.match(log, /registry digest differs/);
    assert.match(log, new RegExp(`previous image ${'1'.repeat(64)}`));
    assert.match(log, new RegExp(`podman tag ${'1'.repeat(64)} ${REF}`));
    assert.match(session.summaryLine(), /1 refreshed, 0 current, 0 unavailable, 0 failed, 0 deferred/);
});

test('session: a busy lease defers the tag move without a rollback and records retag-deferred', async () => {
    const { session, state } = makeSession({ withRetagLease: async () => ({ ok: false }) });
    const result = await session.refresh(REF);
    assert.equal(result.action, 'retag-deferred');
    assert.equal(state.tags.length, 0);
    assert.match(session.summaryLine(), /1 deferred/);
});

test('session: the tag move runs inside the lease callback only', async () => {
    const events = [];
    const { session, state } = makeSession({
        withRetagLease: async (fn) => { events.push(`lease:${state.tags.length}`); const value = await fn(); events.push(`done:${state.tags.length}`); return { ok: true, value }; },
    });
    assert.equal((await session.refresh(REF)).action, 'refreshed');
    assert.deepEqual(events, ['lease:0', 'done:1']);
});

test('session: a failing tag command is a pull-failed result', async () => {
    const { session } = makeSession({ spawn: () => ({ status: 1, stderr: 'no space' }) });
    const result = await session.refresh(REF);
    assert.equal(result.action, 'pull-failed');
    assert.match(result.reason, /tag failed/);
});

test('session: a digest pull that finds the same image ID is current and moves nothing', async () => {
    const { session, state } = makeSession({ readImageId: () => OLD });
    assert.equal((await session.refresh(REF)).action, 'current');
    assert.equal(state.tags.length, 0);
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

test('session: an empty RepoDigests set with a known digest pulls by digest', async () => {
    const { session, state } = makeSession({ readRepoDigests: () => [] });
    assert.equal((await session.refresh(REF)).action, 'refreshed');
    assert.deepEqual(state.pulls, [DIGEST_REF]);
});

test('session: an undetermined registry answer falls back to the engine pulling the tag, with no retag', async () => {
    const { session, state } = makeSession({ fetchImpl: async () => response(404) });
    assert.equal((await session.refresh(REF)).action, 'refreshed');
    assert.deepEqual(state.pulls, [REF]);
    assert.equal(state.tags.length, 0);
    assert.match(state.logs.join('\n'), /asking podman to pull/);
});

test('session: a plain pull that finds nothing new is current, not refreshed', async () => {
    const { session } = makeSession({ fetchImpl: async () => response(404), readImageId: () => OLD });
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
    assert.equal(state.tags.length, 0);
});

test('session: an unexpected internal error is an error result under the normalized ref', async () => {
    const { session } = makeSession({ readImageId: () => { throw new Error('engine crashed'); } });
    const result = await session.refresh(REF);
    assert.equal(result.action, 'error');
    assert.equal(result.canonical, REF);
    assert.match(result.reason, /engine crashed/);
    assert.match(session.summaryLine(), /1 failed/);
});

test('session: policy off makes no calls', async () => {
    const off = makeSession({ policy: 'off' });
    assert.equal(off.session.enabled, false);
    assert.equal((await off.session.refresh(REF)).action, 'skipped');
    assert.equal(off.state.heads + off.state.pulls.length, 0);
});

test('session: a proxy that native fetch would ignore delegates to the engine without a HEAD', async () => {
    const { session, state } = makeSession({ env: { HTTPS_PROXY: 'http://proxy:3128' } });
    assert.equal((await session.refresh(REF)).action, 'refreshed');
    assert.equal(state.heads, 0);
    assert.deepEqual(state.pulls, [REF]);
});

test('session: an error from beforePull or afterPullFailure propagates unchanged', async () => {
    const cancelled = new Error('cancelled');
    const before = makeSession({ beforePull: async () => { throw cancelled; } });
    await assert.rejects(before.session.refresh(REF), (error) => error === cancelled);
    assert.equal(before.state.pulls.length, 0);
    const after = makeSession({ pull: () => { throw new Error('killed by signal'); }, afterPullFailure: async () => { throw cancelled; } });
    await assert.rejects(after.session.refresh(REF), (error) => error === cancelled, 'a pull that failed because of a signal is a cancellation');
});

test('session: with the budget used up the remaining refs are deferred without any registry or pull call', async () => {
    let clock = 0;
    const { session, state } = makeSession({ deadlineMs: 100_000, now: () => clock });
    clock = 50_000;
    assert.equal((await session.refresh(REF)).action, 'deferred', 'under a minute left');
    assert.equal(state.heads + state.pulls.length, 0);
    assert.equal((await session.refresh('node:18-alpine')).action, 'skipped', 'refs that need no refresh stay skipped');
    assert.match(session.summaryLine(), /1 deferred/);
});

test('session: each pull is capped at the remaining budget', async () => {
    const { session, state } = makeSession({ deadlineMs: 600_000, now: () => 0, pullTimeoutMs: () => 30 * 60 * 1000 });
    await session.refresh(REF);
    assert.deepEqual(state.timeouts, [600_000]);
    const roomy = makeSession({ deadlineMs: Infinity, pullTimeoutMs: () => 123_000 });
    await roomy.session.refresh(REF);
    assert.deepEqual(roomy.state.timeouts, [123_000]);
});

test('session: a budget that runs out during the registry check defers before pulling', async () => {
    let clock = 0;
    const { session, state } = makeSession({
        deadlineMs: 100_000, now: () => clock,
        fetchImpl: async () => { clock = 90_000; return response(200, REMOTE_DIGEST); },
    });
    assert.equal((await session.refresh(REF)).action, 'deferred');
    assert.equal(state.pulls.length, 0);
});

test('session: an unknown runtime is skipped', async () => {
    const { session, state } = makeSession({ runtime: null });
    assert.equal((await session.refresh(REF)).action, 'skipped');
    assert.equal(state.heads, 0);
});
