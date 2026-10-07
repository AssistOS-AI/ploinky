import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncResource } from 'node:async_hooks';
import { runWithRepositoryResolutionScope, memoizeRepositoryRead, prefetchRepositoryReads } from '../../cli/utils/repositoryResolutionScope.mjs';
import { prefetchWorkspaceRepositoryOrigins, repositoryOrigin } from '../../cli/utils/repositorySource.mjs';
import { readOriginFromGitConfigAsync } from '../../cli/utils/repositoryOriginConfig.mjs';
import { installGitFixture, until, sleep } from '../helpers/repositoryGitFixture.mjs';

function fixture(t, count = 5) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-preparation-'));
    const directories = Array.from({ length: count }, (_, index) => path.join(root, `repo-${index}`));
    directories.forEach(directory => fs.mkdirSync(path.join(directory, '.git'), { recursive: true }));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, directories };
}

test('preparation shares pending work, bounds two children and keeps sync values separate', async t => {
    const { root, directories } = fixture(t);
    const git = installGitFixture(t, { delayMs: 150, value: 'https://example.test/prepared.git' });
    await runWithRepositoryResolutionScope(async () => {
        const first = prefetchWorkspaceRepositoryOrigins(root);
        const second = prefetchWorkspaceRepositoryOrigins([root, root]);
        await Promise.all([first, second]);
        for (const directory of directories) assert.equal(repositoryOrigin(directory), 'example.test/prepared');
        assert.equal(git.synchronous(), 0);
        assert.equal(git.started.length, directories.length);
        assert.equal(new Set(git.started.map(entry => entry.directory)).size, directories.length);
        assert.equal(git.peak(), 2);
        assert.equal(git.live.size, 0);
    });
});

test('two simultaneous scopes have independent two-child pools and values', async t => {
    const first = fixture(t, 4);
    const second = fixture(t, 4);
    const values = Object.fromEntries([first, second].flatMap(({ directories }, index) => directories.map(directory => [directory, `https://example.test/scope-${index}.git`])));
    const git = installGitFixture(t, { delayMs: 200, values });
    const runs = [first, second].map(({ root, directories }, index) => runWithRepositoryResolutionScope(async () => {
        await prefetchWorkspaceRepositoryOrigins(root);
        directories.forEach(directory => assert.equal(repositoryOrigin(directory), `example.test/scope-${index}`));
    }));
    await until(() => git.live.size === 4, 'two active children per scope');
    for (const { root } of [first, second]) assert.equal(git.started.filter(entry => entry.directory.startsWith(root + path.sep)).length, 2);
    await Promise.all(runs);
    assert.equal(git.peak(), 4);
    assert.equal(git.started.length, 8);
    assert.equal(git.live.size, 0);
    assert.equal(git.synchronous(), 0);
});

test('an aborted scope begins no discovery and a new scope immediately rereads the same path', async t => {
    const { root, directories } = fixture(t, 1);
    const git = installGitFixture(t, { value: 'https://example.test/old.git' });
    const controller = new AbortController();
    controller.abort();
    const readdir = fs.readdirSync;
    let scans = 0;
    t.mock.method(fs, 'readdirSync', (target, ...args) => { if (target === root) scans += 1; return readdir(target, ...args); });
    await runWithRepositoryResolutionScope(() => prefetchWorkspaceRepositoryOrigins(root), { signal: controller.signal });
    assert.equal(scans, 0);
    assert.equal(git.started.length, 0);
    await runWithRepositoryResolutionScope(async () => {
        await prefetchWorkspaceRepositoryOrigins(root);
        assert.equal(repositoryOrigin(directories[0]), 'example.test/old');
    });
    git.configure({ value: 'https://example.test/new.git' });
    await runWithRepositoryResolutionScope(async () => {
        await prefetchWorkspaceRepositoryOrigins(root);
        assert.equal(repositoryOrigin(directories[0]), 'example.test/new');
    });
    assert.equal(git.started.length, 2);
    assert.equal(git.synchronous(), 0);
});

test('overlapping scopes publish different origin snapshots for the same exact path', async t => {
    const { root, directories } = fixture(t, 1);
    const git = installGitFixture(t, { delayMs: 300, value: 'https://example.test/first.git' });
    const first = runWithRepositoryResolutionScope(async () => {
        await prefetchWorkspaceRepositoryOrigins(root);
        assert.equal(repositoryOrigin(directories[0]), 'example.test/first');
    });
    await until(() => git.events().length === 1, 'first scope child captured settings');
    git.configure({ value: 'https://example.test/second.git' });
    await runWithRepositoryResolutionScope(async () => {
        await prefetchWorkspaceRepositoryOrigins(root);
        assert.equal(repositoryOrigin(directories[0]), 'example.test/second');
    });
    await first;
    assert.equal(git.started.length, 2);
    assert.equal(git.synchronous(), 0);
});

test('timeout kills a TERM-ignoring child, joins it and lets queued paths proceed', { timeout: 7000 }, async t => {
    const { root, directories } = fixture(t, 4);
    const git = installGitFixture(t, { hangName: 'repo-0', value: 'https://example.test/survivor.git' });
    const start = Date.now();
    const cleanupErrors = [];
    const reapOwnedChildren = async () => {
        // These ChildProcess objects belong only to this fixture's spawn wrapper.
        const results = await Promise.allSettled([...git.live].map(child => new Promise((resolve, reject) => {
            child.once('close', resolve);
            try {
                if (!child.kill('SIGKILL') && child.exitCode === null && child.signalCode === null) reject(new Error('Could not kill owned origin fixture child.'));
            } catch (error) { reject(error); }
        })));
        cleanupErrors.push(...results.filter(result => result.status === 'rejected').map(result => result.reason));
    };
    let watchdogFired = false;
    let watchdogCleanup = Promise.resolve();
    const watchdog = setTimeout(() => {
        watchdogFired = true;
        watchdogCleanup = reapOwnedChildren();
    }, 6000);
    const run = runWithRepositoryResolutionScope(async () => {
        await prefetchWorkspaceRepositoryOrigins(root);
        assert.equal(repositoryOrigin(directories[0]), '');
        directories.slice(1).forEach(directory => assert.equal(repositoryOrigin(directory), 'example.test/survivor'));
    });
    let failure;
    try {
        await run;
        assert.equal(watchdogFired, false, 'production termination must finish before the fixture watchdog');
        assert.ok(Date.now() - start < 5000, '2000ms child timeout plus 3000ms harness margin');
        assert.equal(git.started.length, 4);
        assert.equal(git.live.size, 0);
        const hung = git.started.find(entry => entry.directory === directories[0]).child;
        assert.equal(hung.signalCode, 'SIGKILL');
        assert.throws(() => process.kill(hung.pid, 0), { code: 'ESRCH' });
    } catch (error) { failure = error; }
    finally {
        clearTimeout(watchdog);
        await watchdogCleanup;
        await reapOwnedChildren();
    }
    if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Origin fixture cleanup failed.');
    if (failure) throw failure;
});

test('cancellation stops queued paths and joins active children before scope settles', async t => {
    const { root } = fixture(t);
    const git = installGitFixture(t, { hang: true });
    const controller = new AbortController();
    const run = runWithRepositoryResolutionScope(() => prefetchWorkspaceRepositoryOrigins(root), { signal: controller.signal });
    await until(() => git.events().length === 2, 'both children started');
    const cancelledAt = Date.now();
    controller.abort();
    await run;
    assert.ok(Date.now() - cancelledAt < 1000, 'cancellation joins promptly rather than waiting for the 2000ms timeout');
    assert.equal(git.started.length, 2);
    assert.equal(git.live.size, 0);
    for (const { child } of git.started) assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});

test('origin reader handles pre-abort, missing executable and stdout overflow without partial identity', async t => {
    const { directories } = fixture(t, 1);
    const git = installGitFixture(t, { overflow: true });
    const controller = new AbortController();
    controller.abort();
    assert.equal(await readOriginFromGitConfigAsync(directories[0], { signal: controller.signal }), '');
    assert.equal(git.started.length, 0);
    assert.equal(await readOriginFromGitConfigAsync(directories[0]), '');
    assert.equal(git.live.size, 0);
    const previousPath = process.env.PATH;
    try {
        process.env.PATH = path.join(directories[0], 'missing-bin');
        assert.equal(await readOriginFromGitConfigAsync(directories[0]), '');
    } finally { process.env.PATH = previousPath; }
    assert.equal(git.live.size, 0);
});

test('pending values never escape sync reads or overwrite an already resolved identity', async () => {
    let release;
    await runWithRepositoryResolutionScope(async () => {
        const preparation = prefetchRepositoryReads('origins', ['path'], () => new Promise(resolve => { release = resolve; }));
        await Promise.resolve();
        try {
            assert.equal(memoizeRepositoryRead('origins', 'path', () => 'sync-authority'), 'sync-authority');
        } finally {
            release('late-preparation');
            await preparation;
        }
        assert.equal(memoizeRepositoryRead('origins', 'path', () => assert.fail('cached')), 'sync-authority');
    });
});

test('sync return and throw dispose captured contexts; async rejection joins detached preparation', async () => {
    let detached;
    assert.equal(runWithRepositoryResolutionScope(() => {
        memoizeRepositoryRead('probe', 'key', () => 'old');
        detached = AsyncResource.bind(() => memoizeRepositoryRead('probe', 'key', () => 'fresh'));
        return 17;
    }), 17);
    assert.equal(detached(), 'fresh');
    assert.throws(() => runWithRepositoryResolutionScope(() => {
        memoizeRepositoryRead('probe', 'key', () => 'old');
        detached = AsyncResource.bind(() => memoizeRepositoryRead('probe', 'key', () => 'fresh'));
        throw new Error('sync fixture');
    }), /sync fixture/);
    assert.equal(detached(), 'fresh');
    let settled = false;
    await assert.rejects(runWithRepositoryResolutionScope(async () => {
        void prefetchRepositoryReads('probe', ['key'], (_key, signal) => new Promise(resolve => {
            signal.addEventListener('abort', () => setTimeout(() => { settled = true; resolve('late'); }, 25), { once: true });
        }));
        await Promise.resolve();
        detached = AsyncResource.bind(() => memoizeRepositoryRead('probe', 'key', () => 'fresh'));
        throw new Error('async fixture');
    }), /async fixture/);
    assert.equal(settled, true);
    assert.equal(detached(), 'fresh');
});

test('orchestration rejection cancels and joins its sibling before propagating', async () => {
    let siblingSettled = false;
    let queued = false;
    await assert.rejects(runWithRepositoryResolutionScope(() => prefetchRepositoryReads('probe', ['bad', 'sibling', 'queued'], async (key, signal) => {
        if (key === 'bad') { await sleep(10); throw new Error('orchestration'); }
        if (key === 'queued') { queued = true; return 'wrong'; }
        return new Promise(resolve => signal.addEventListener('abort', () => setTimeout(() => { siblingSettled = true; resolve('late'); }, 25), { once: true }));
    })), /orchestration/);
    assert.equal(siblingSettled, true);
    assert.equal(queued, false);
});
