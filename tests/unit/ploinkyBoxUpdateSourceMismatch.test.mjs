import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { activeDescriptorPath } from '../../agentlib/source.mjs';
import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';
import { updateHostPloinkySource } from '../../ploinky-box/command/hostUpdate.mjs';
import { BOX_SOURCE_MISMATCH, validateContainerConfiguration } from '../../ploinky-box/contract/container.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { createMemoryUpdateHostState, UPDATE_STATE_KINDS } from '../../ploinky-box/update/hostState.mjs';
import { writeAgentLibCheckout } from '../helpers/agentlibFixture.mjs';

// Never read the global, system or XDG Git policy of the machine running this.
const isolation = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-source-mismatch-env-')));
fs.writeFileSync(path.join(isolation, 'gitconfig'), '');
const savedEnv = Object.fromEntries(['XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM',
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']
    .map(key => [key, process.env[key]]));
Object.assign(process.env, {
    XDG_CONFIG_HOME: path.join(isolation, 'xdg'),
    GIT_CONFIG_GLOBAL: path.join(isolation, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
});
test.after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(isolation, { recursive: true, force: true });
});

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// HEAD, index bytes, porcelain status and every tracked file's bytes.
function snapshot(checkout) {
    const files = git(checkout, 'ls-files').split('\n').filter(Boolean).sort();
    return {
        head: git(checkout, 'rev-parse', 'HEAD'),
        index: sha256(path.join(checkout, '.git', 'index')),
        status: git(checkout, 'status', '--porcelain', '--untracked-files=all'),
        files: Object.fromEntries(files.map(file => [file, sha256(path.join(checkout, file))])),
    };
}

function writePloinkyShape(dir) {
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ploinky-box', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ploinky-cloud', bin: { ploinky: './bin/ploinky' } }));
    fs.writeFileSync(path.join(dir, 'bin', 'ploinky'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(dir, 'ploinky-box', 'bin', 'ploinky-box.mjs'), '// fixture\n');
}

// A checkout at `target` tracking a bare remote whose tip has moved one
// commit past it, so a fast-forward pull would change it.
function movingCheckout(root, name, target, shape) {
    const remote = path.join(root, 'remotes', `${name}.git`);
    const seed = path.join(root, 'seeds', name);
    fs.mkdirSync(remote, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    fs.mkdirSync(seed, { recursive: true });
    git(seed, 'init', '-q', '-b', 'main');
    shape(seed);
    fs.writeFileSync(path.join(seed, 'version.txt'), 'one\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'initial');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-q', '--set-upstream', 'origin', 'main');
    execFileSync('git', ['clone', '-q', '--branch', 'main', remote, target]);
    fs.writeFileSync(path.join(seed, 'version.txt'), 'two\n');
    git(seed, 'commit', '-q', '-am', 'advance');
    git(seed, 'push', '-q');
    const tip = git(remote, 'rev-parse', 'main');
    assert.notEqual(git(target, 'rev-parse', 'HEAD'), tip, `${name} upstream really moved`);
    return { remote, tip };
}

function ownedBox(ploinkySource) {
    return {
        state: 'owned',
        engine: { name: 'podman', identity: 'engine' },
        handles: {
            container: {
                id: 'a'.repeat(64),
                runtime: {
                    running: true,
                    mounts: [{ type: 'bind', source: ploinkySource, name: '', destination: '/opt/ploinky', rw: false }],
                },
            },
        },
    };
}

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-source-mismatch-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    // The executing checkout sits inside the update folder, so a full update
    // would self-update it; the Box was created by a sibling checkout.
    const host = path.join(workspace, 'ploinky');
    const hostRemote = movingCheckout(root, 'host-ploinky', host, writePloinkyShape);
    const creator = path.join(root, 'creator-ploinky');
    writePloinkyShape(creator);
    return { root, workspace, identity, host, hostRemote, creator };
}

function sink() {
    let text = '';
    return { isTTY: false, write(chunk) { text += String(chunk); return true; }, text: () => text };
}

function hostCli(f, discover) {
    const events = [];
    const store = createMemoryUpdateHostState();
    const output = sink();
    const errorOutput = sink();
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => f.identity,
        launchCwd: f.workspace,
        repositoryRoot: f.host,
        discover() { events.push('discover'); return discover(); },
        lockManager: { async acquire() { events.push('workspace-lock'); throw new Error('no workspace lock expected'); } },
        updateHostState: store,
        env: {},
        stdout: { write() {} },
        stderr: { write() {} },
    });
    const reports = [];
    const promise = runOuterCli(['update'], {
        env: {},
        cwd: () => f.workspace,
        detectInsideBox: () => false,
        repositoryRoot: f.host,
        supervisor,
        output,
        errorOutput,
        updateHostState: store,
        onUpdateResult: report => reports.push(report),
        async updateHostSource(options) {
            events.push('host-update');
            return updateHostPloinkySource({
                ...options,
                boxMarkerPath: path.join(f.root, 'not-a-box'),
                lockManager: { async acquire() { return { assertHeld() {}, release() {} }; } },
            });
        },
        relaunch() { events.push('relaunch'); return 0; },
    });
    return { promise, events, store, output, errorOutput, reports };
}

test('a full update from another checkout refuses before pulling its in-folder checkout', async (t) => {
    const f = fixture(t);
    const before = snapshot(f.host);
    const run = hostCli(f, () => ownedBox(f.creator));
    await assert.rejects(run.promise, (error) => {
        assert.equal(error.code, BOX_SOURCE_MISMATCH);
        assert.ok(error.message.includes(`runs Ploinky from ${f.creator},`), error.message);
        assert.ok(error.message.includes(`this command runs Ploinky from ${f.host}.`), error.message);
        return true;
    });
    assert.deepEqual(snapshot(f.host), before, 'HEAD, index, status and tracked bytes are unchanged');
    assert.notEqual(before.head, f.hostRemote.tip);
    assert.deepEqual(run.events, ['discover'], 'no host pull, relaunch or workspace lock');
    for (const kind of UPDATE_STATE_KINDS) assert.deepEqual(run.store.list(kind), [], kind);
    const text = run.output.text();
    assert.match(text, /activation update-transaction: failed \[PLOINKY_BOX_SOURCE_MISMATCH\]/);
    assert.match(text, /Update did not start in this workspace: its Box runs another Ploinky checkout, so no source checkout was pulled/);
    assert.doesNotMatch(text, /Using Ploinky update folder|already pulled/);
    assert.equal(run.reports.length, 1);
    assert.equal(run.reports[0].failed, true);
    assert.equal(run.reports[0].result.exitCode, 1);
});

test('a matching, absent or undiscoverable Box still lets the host self-update pull', async (t) => {
    const cases = [
        ['matching Box', f => () => ownedBox(f.host)],
        ['absent Box', () => () => ({ state: 'absent', handles: null })],
        ['foreign Box', f => () => ({ ...ownedBox(f.creator), state: 'foreign' })],
        ['discovery error', () => () => { throw new Error('engine unavailable'); }],
    ];
    for (const [name, discover] of cases) {
        const f = fixture(t);
        const run = hostCli(f, discover(f));
        assert.equal(await run.promise, 0, name);
        assert.equal(git(f.host, 'rev-parse', 'HEAD'), f.hostRemote.tip, `${name}: the host checkout fast-forwarded`);
        assert.equal(fs.readFileSync(path.join(f.host, 'version.txt'), 'utf8'), 'two\n', name);
        assert.deepEqual(run.events, ['discover', 'host-update', 'relaunch'], name);
    }
});

test('workspace Ploinky and AgentLib selection mutate no checkout before the locked source check', async (t) => {
    const f = fixture(t);
    // The workspace's own checkouts, both behind moving remotes. The host
    // checkout is outside this update folder, as in the recorded live repro.
    const outside = path.join(f.root, 'outside-ploinky');
    writePloinkyShape(outside);
    const agentLib = path.join(f.workspace, 'achillesAgentLib');
    const agentLibRemote = movingCheckout(f.root, 'agentlib', agentLib, writeAgentLibCheckout);
    const before = { ploinky: snapshot(f.host), agentLib: snapshot(agentLib) };
    const events = [];
    let held = false;
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => f.identity,
        launchCwd: f.workspace,
        repositoryRoot: outside,
        discover: () => ownedBox(f.creator),
        lockManager: {
            async acquire(instance) {
                held = true;
                return {
                    assertHeld(expected) { assert.equal(held, true); assert.equal(expected, instance); },
                    release() { held = false; events.push('release'); },
                };
            },
        },
        updateHostState: createMemoryUpdateHostState(),
        routerBindingStore: { read: () => null },
        captureCoreStartArgv: () => null,
        env: {},
        stdout: { write() {} },
        stderr: { write() {} },
        runner: {
            run() { throw new Error('no engine mutation expected'); },
            query() { return { ok: true, stdout: JSON.stringify({ initialized: true, routingConfigured: false }) }; },
        },
        loadAgentLibImage() { throw new Error('a local AgentLib checkout needs no image bundle'); },
        async reconcile(options) {
            events.push('reconcile');
            // Only the real source comparison is exercised; it runs first.
            validateContainerConfiguration(options.ownership.handles.container, {
                identity: options.identity,
                repositoryRoot: options.repositoryRoot,
            });
            throw new Error('the source check must refuse this Box');
        },
        runUpdateCore() { throw new Error('the in-Box update must not run'); },
    });
    await assert.rejects(supervisor.runUpdateTransaction(['update'], {
        updateScopeRoot: f.workspace,
        hostRecords: [],
    }), error => error.code === BOX_SOURCE_MISMATCH);
    assert.deepEqual(events, ['reconcile', 'release']);
    assert.deepEqual(snapshot(f.host), before.ploinky, 'workspace Ploinky checkout unchanged');
    assert.deepEqual(snapshot(agentLib), before.agentLib, 'AgentLib checkout unchanged');
    assert.notEqual(before.ploinky.head, f.hostRemote.tip);
    assert.notEqual(before.agentLib.head, agentLibRemote.tip);
    assert.equal(fs.existsSync(activeDescriptorPath(f.identity.workspaceRoot)), false, 'no AgentLib selection committed');
});
