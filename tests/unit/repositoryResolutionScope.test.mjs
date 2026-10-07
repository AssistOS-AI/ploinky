import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncResource } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'repository-scope-'));
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = root;
fs.mkdirSync(path.join(root, '.ploinky/repos'), { recursive: true });
const { listAgentRepositoryNames, resolveAgentRepositoryPath, runWithRepositoryResolutionScope } = await import('../../cli/utils/agentRepositorySource.mjs');
const { isAgentRepositoryUnregistered, setAgentRepositoryRegistered } = await import('../../cli/utils/agentRepositoryRegistration.mjs');
const { collectAgentsSummary } = await import('../../cli/utils/status.js');
const { __testables } = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
const sources = path.join(root, '.ploinky/repo_sources.json');
const registrations = path.join(root, '.ploinky/unregistered_agent_repos.json');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test.after(() => {
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
});
function checkout(name, url) {
    const directory = path.join(root, name);
    fs.mkdirSync(path.join(directory, 'worker'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'worker/manifest.json'), '{}');
    if (url) {
        execFileSync('git', ['init', '-q', directory]);
        execFileSync('git', ['-C', directory, 'remote', 'add', 'origin', url]);
    }
    return directory;
}

test('repository list and every alias resolution share one workspace and checkout scan', t => {
    const directory = checkout('development', 'https://example.test/team/one.git');
    fs.writeFileSync(sources, JSON.stringify({ first: { url: 'https://example.test/team/one.git' }, second: { url: 'https://example.test/team/one.git' } }));
    const readdir = fs.readdirSync;
    const reads = new Map();
    t.mock.method(fs, 'readdirSync', (target, ...options) => {
        reads.set(String(target), (reads.get(String(target)) || 0) + 1);
        return readdir(target, ...options);
    });
    runWithRepositoryResolutionScope(() => {
        assert.deepEqual(listAgentRepositoryNames(), ['first', 'second']);
        assert.equal(resolveAgentRepositoryPath('first'), directory);
        assert.equal(resolveAgentRepositoryPath('second'), directory);
        assert.deepEqual(listAgentRepositoryNames(), ['first', 'second']);
    });
    assert.equal(reads.get(root), 1);
    assert.equal(reads.get(directory), 1, 'hasAgents is shared by both source modules');
    reads.clear();
    runWithRepositoryResolutionScope(() => collectAgentsSummary({ includeInactive: true }));
    assert.equal(reads.get(root), 1, 'the real summary call chain scans the root once');
});

test('the very next scope sees new checkouts, origins, sources and registration changes', () => {
    const before = runWithRepositoryResolutionScope(() => listAgentRepositoryNames());
    assert.deepEqual(before, ['first', 'second']);
    checkout('next-request');
    fs.writeFileSync(path.join(root, 'development/.git/config'), '[remote "origin"]\nurl = https://example.test/team/new.git\n');
    fs.writeFileSync(sources, JSON.stringify({ renamed: { url: 'https://example.test/team/new.git' } }));
    fs.writeFileSync(registrations, JSON.stringify(['next-request']));
    assert.deepEqual(runWithRepositoryResolutionScope(() => listAgentRepositoryNames()), ['renamed']);
    fs.writeFileSync(registrations, '[]');
    assert.deepEqual(listAgentRepositoryNames(), ['next-request', 'renamed'], 'CLI reads stay fresh without a scope');
});

test('concurrent scopes keep independent snapshots across awaits', async () => {
    const gate = deferred();
    const first = runWithRepositoryResolutionScope(async () => {
        const before = listAgentRepositoryNames();
        await gate.promise;
        assert.deepEqual(listAgentRepositoryNames(), before);
        return before;
    });
    checkout('concurrent');
    const second = runWithRepositoryResolutionScope(async () => {
        await Promise.resolve();
        assert.ok(listAgentRepositoryNames().includes('concurrent'));
    });
    await second;
    gate.resolve();
    assert.ok(!(await first).includes('concurrent'));
});

test('settled scopes stop memoizing detached continuations after success and rejection', async () => {
    for (const reject of [false, true]) {
        let detached;
        const outcome = runWithRepositoryResolutionScope(async () => {
            listAgentRepositoryNames();
            detached = AsyncResource.bind(() => listAgentRepositoryNames());
            if (reject) throw new Error('fixture rejection');
        });
        if (reject) await assert.rejects(outcome, /fixture rejection/);
        else await outcome;
        const name = reject ? 'after-rejection' : 'after-success';
        checkout(name);
        assert.ok(detached().includes(name));
    }
});

test('registration writers read disk and leave the active read snapshot intact', () => {
    fs.writeFileSync(registrations, '[]');
    runWithRepositoryResolutionScope(() => {
        assert.equal(isAgentRepositoryUnregistered('first'), false);
        fs.writeFileSync(registrations, '["external"]');
        setAgentRepositoryRegistered('first', false);
        assert.deepEqual(JSON.parse(fs.readFileSync(registrations, 'utf8')), ['external', 'first']);
        assert.equal(isAgentRepositoryUnregistered('first'), false, 'writer must not mutate the memoized Set');
        assert.equal(runWithRepositoryResolutionScope(() => isAgentRepositoryUnregistered('first')), true);
        setAgentRepositoryRegistered('external', true);
        assert.deepEqual(JSON.parse(fs.readFileSync(registrations, 'utf8')), ['first']);
    });
});

test('queued E6a inventory jobs retain their own repository scope', async () => {
    const limiter = __testables.createInventoryLimiter(1);
    const gate = deferred();
    const first = runWithRepositoryResolutionScope(async () => {
        const names = listAgentRepositoryNames();
        await limiter(() => gate.promise);
        assert.deepEqual(listAgentRepositoryNames(), names);
    });
    checkout('queued-scope');
    const second = runWithRepositoryResolutionScope(async () => {
        const names = listAgentRepositoryNames();
        await limiter(() => assert.deepEqual(listAgentRepositoryNames(), names));
    });
    gate.resolve();
    await Promise.all([first, second]);
});
