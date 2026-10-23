import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildShellEnvironment } from '../../core-services/webtty/environment.mjs';
import { TerminalWorker, runTerminalWorker } from '../../core-services/webtty/terminal-worker.mjs';
import { WEBTTY_PROTOCOL_LIMITS, workerMessage } from '../../core-services/webtty/worker-protocol.mjs';

const TERMINAL_ID = 'abcdefghijklmnopqrstuvwx';
// The trusted root the Router places in the worker's fixed environment.
const WORKSPACE_ROOT = '/home/user/work space/proiect';
const SHELL_ENV = buildShellEnvironment({}, { workspaceRoot: WORKSPACE_ROOT });
const PTY_IDENTITY = Object.freeze({
    pid: 4242,
    startToken: 'linux-proc:123456',
    processGroupId: 4242,
    sessionId: 4242,
    foregroundProcessGroupId: 4242,
    ttyNumber: 34816,
});

class FakeProcess extends EventEmitter {
    constructor({ env = { PLOINKY_WORKSPACE_ROOT: WORKSPACE_ROOT } } = {}) {
        super();
        this.env = env;
        this.connected = true;
        this.sent = [];
        this.exitCode = null;
        this.exits = [];
    }

    send(message, callback) {
        this.sent.push(message);
        callback?.(null);
        return true;
    }

    disconnect() {
        this.connected = false;
    }

    exit(code) {
        this.exits.push(code);
    }
}

function fakePty() {
    const state = {
        pid: 4242,
        writes: [],
        resizes: [],
        disposed: 0,
        dataHandler: null,
        exitHandler: null,
    };
    return {
        state,
        api: {
            pid: state.pid,
            onData(handler) { state.dataHandler = handler; },
            onExit(handler) { state.exitHandler = handler; },
            write(data) { state.writes.push(data); },
            resize(cols, rows) { state.resizes.push([cols, rows]); },
            dispose() { state.disposed += 1; },
        },
    };
}

function init(overrides = {}) {
    return workerMessage('init', TERMINAL_ID, {
        cwdRelative: 'repo/src',
        cols: 80,
        rows: 24,
        shellEnv: SHELL_ENV,
        ...overrides,
    });
}

function harness(overrides = {}) {
    const processApi = overrides.processApi || new FakeProcess();
    const terminal = fakePty();
    const spawnCalls = [];
    const cleanups = [];
    const worker = new TerminalWorker({
        processApi,
        ...(overrides.defaultDirectoryResolver ? {} : {
            resolveDirectory: overrides.resolveDirectory || ((relative) => ({
                relativePath: relative,
                absolutePath: `${WORKSPACE_ROOT}/repo/src`,
                workspaceRealPath: WORKSPACE_ROOT,
            })),
        }),
        loadNodePty: overrides.loadNodePty || (() => ({
            spawn(shell, args, options) {
                spawnCalls.push({ shell, args, options });
                return terminal.api;
            },
        })),
        capturePtyIdentityImpl: overrides.capturePtyIdentityImpl || (() => PTY_IDENTITY),
        cleanupSessionImpl: async (identity) => {
            cleanups.push(identity);
            return overrides.cleanupSessionImpl ? overrides.cleanupSessionImpl(identity) : true;
        },
        delayImpl: async () => {},
        identityWaitMs: overrides.identityWaitMs ?? 0,
    });
    return { worker, processApi, terminal, spawnCalls, cleanups };
}

test('one init creates one fixed bash PTY after cwd revalidation and reports evidence', async () => {
    const h = harness();
    await h.worker.initialize(init());
    assert.equal(h.spawnCalls.length, 1);
    assert.deepEqual(h.spawnCalls[0], {
        shell: '/bin/bash',
        args: ['--noprofile', '--norc'],
        options: {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: `${WORKSPACE_ROOT}/repo/src`,
            env: SHELL_ENV,
        },
    });
    assert.deepEqual(h.processApi.sent[0], workerMessage('ready', TERMINAL_ID, {
        processIdentity: PTY_IDENTITY,
    }));

    h.worker.handleMessage(workerMessage('input', TERMINAL_ID, { data: 'pwd\r' }));
    h.worker.handleMessage(workerMessage('resize', TERMINAL_ID, { cols: 120, rows: 40 }));
    assert.deepEqual(h.terminal.state.writes, ['pwd\r']);
    assert.deepEqual(h.terminal.state.resizes, [[120, 40]]);
});

test('output is UTF-8 byte chunked, sequenced, and never precedes ready', async () => {
    const h = harness();
    await h.worker.initialize(init());
    const data = '💥'.repeat((WEBTTY_PROTOCOL_LIMITS.maxOutputBytes / 4) + 100);
    h.terminal.state.dataHandler(data);
    const outputs = h.processApi.sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 2);
    assert.deepEqual(outputs.map((message) => message.sequence), [1, 2]);
    assert.equal(outputs.map((message) => message.data).join(''), data);
    assert.ok(outputs.every((message) => Buffer.byteLength(message.data) <= WEBTTY_PROTOCOL_LIMITS.maxOutputBytes));
    assert.equal(h.processApi.sent[0].type, 'ready');
});

test('close and parent IPC EOF use session cleanup and exact-once exit', async () => {
    for (const category of ['requested', 'parent-disconnect']) {
        const h = harness();
        await h.worker.initialize(init());
        await h.worker.cleanup(category);
        assert.deepEqual(h.cleanups, [PTY_IDENTITY]);
        assert.equal(h.terminal.state.disposed, 0);
        const exits = h.processApi.sent.filter((message) => message.type === 'exit');
        assert.equal(exits.length, 1);
        assert.equal(exits[0].category, category);
        assert.equal(h.processApi.connected, false);
    }
});

test('concurrent close, disconnect and native exit share one pending cleanup', async () => {
    let finish;
    const h = harness({ cleanupSessionImpl: () => new Promise((resolve) => { finish = resolve; }) });
    await h.worker.initialize(init());
    const first = h.worker.cleanup('requested');
    assert.equal(h.worker.cleanup('parent-disconnect'), first);
    h.terminal.state.exitHandler({ exitCode: 0, signal: 9 });
    h.terminal.state.exitHandler({ exitCode: 1, signal: 1 });
    assert.equal(h.processApi.sent.filter((message) => message.type === 'exit').length, 0);
    finish(true);
    await first;
    assert.deepEqual(h.cleanups, [PTY_IDENTITY]);
    const exits = h.processApi.sent.filter((message) => message.type === 'exit');
    assert.equal(exits.length, 1);
    assert.equal(exits[0].category, 'requested');
    assert.equal(exits[0].signal, 9);
});

test('cleanup reports unproven when the process remains after TERM and KILL waits', async () => {
    const h = harness({ cleanupSessionImpl: async () => false });
    await h.worker.initialize(init());
    await h.worker.cleanup('requested');
    assert.deepEqual(h.cleanups, [PTY_IDENTITY]);
    assert.equal(h.terminal.state.disposed, 0);
    const cleanupErrorIndex = h.processApi.sent.findIndex(
        (message) => message.type === 'error' && message.category === 'cleanup-unproven',
    );
    const exitIndex = h.processApi.sent.findIndex((message) => message.type === 'exit');
    assert.ok(cleanupErrorIndex >= 0);
    assert.ok(cleanupErrorIndex < exitIndex, 'Router must receive ambiguity before the worker exit');
});

test('cleanup revalidation ambiguity emits cleanup-unproven once', async () => {
    const h = harness({
        cleanupSessionImpl: () => {
            const error = new Error('identity changed');
            error.code = 'WEBTTY_PROCESS_IDENTITY_UNPROVEN';
            throw error;
        },
    });
    await h.worker.initialize(init());
    await h.worker.cleanup('requested');
    assert.equal(h.cleanups.length, 1);
    assert.equal(h.terminal.state.disposed, 0);
    assert.equal(
        h.processApi.sent.filter((message) => message.type === 'error' && message.category === 'cleanup-unproven').length,
        1,
    );
});

test('stale shell identity alone does not prove session cleanup', async () => {
    const h = harness({
        cleanupSessionImpl: () => {
            const error = new Error('original process gone or pid reused');
            error.code = 'WEBTTY_PROCESS_IDENTITY_STALE';
            throw error;
        },
    });
    await h.worker.initialize(init());
    await h.worker.cleanup('requested');
    assert.equal(h.cleanups.length, 1);
    assert.equal(h.terminal.state.disposed, 0);
    assert.equal(
        h.processApi.sent.some((message) => message.type === 'error' && message.category === 'cleanup-unproven'),
        true,
    );
    assert.equal(h.processApi.sent.find((message) => message.type === 'exit')?.category, 'requested');
});

test('ambiguous identity never calls a native PID kill helper and reports unproven cleanup', async () => {
    const h = harness({
        capturePtyIdentityImpl: () => {
            const error = new Error('unproven');
            error.code = 'WEBTTY_PROCESS_IDENTITY_UNPROVEN';
            throw error;
        },
    });
    await h.worker.initialize(init());
    assert.equal(h.terminal.state.disposed, 0);
    assert.equal(h.cleanups.length, 0);
    assert.equal(
        h.processApi.sent.filter((message) => message.type === 'error' && message.category === 'cleanup-unproven').length,
        1,
    );
});

test('cwd and environment failures happen before loading native bytes', async () => {
    let nativeLoads = 0;
    const h = harness({
        resolveDirectory: () => {
            const error = new Error('replaced');
            error.code = 'WEBTTY_CWD_INVALID';
            throw error;
        },
        loadNodePty: () => { nativeLoads += 1; throw new Error('must not load'); },
    });
    await h.worker.initialize(init());
    assert.equal(nativeLoads, 0);
    assert.equal(h.spawnCalls.length, 0);
    assert.ok(h.processApi.sent.some((message) => message.type === 'error' && message.category === 'cwd-validation'));

    const altered = harness();
    await assert.rejects(() => altered.worker.initialize(init({
        shellEnv: { ...SHELL_ENV, ROUTER_SECRET: 'secret' },
    })));
    assert.equal(altered.spawnCalls.length, 0);
});

test('normal native exit checks the whole session before notifying and disposing', async () => {
    const h = harness();
    await h.worker.initialize(init());
    h.terminal.state.exitHandler({ exitCode: 7, signal: 0 });
    await h.worker.cleanupPromise;
    assert.deepEqual(h.cleanups, [PTY_IDENTITY]);
    assert.equal(h.terminal.state.disposed, 1);
    assert.deepEqual(h.processApi.sent.filter((message) => message.type === 'exit'), [
        workerMessage('exit', TERMINAL_ID, { exitCode: 7, signal: 0, category: 'clean' }),
    ]);
});

test('native exit with unproven residue reports ambiguity before its single exit', async () => {
    let finish;
    const h = harness({ cleanupSessionImpl: () => new Promise((resolve) => { finish = resolve; }) });
    await h.worker.initialize(init());
    h.terminal.state.exitHandler({ exitCode: 7, signal: 0 });
    assert.equal(h.processApi.sent.some((message) => message.type === 'exit'), false);
    finish(false);
    await h.worker.cleanupPromise;
    const notifications = h.processApi.sent.filter((message) => message.type !== 'ready');
    assert.deepEqual(notifications.map((message) => message.category), ['cleanup-unproven', 'clean']);
    assert.equal(notifications[1].exitCode, 7);
    assert.equal(h.cleanups.length, 1);
});

test('the worker resolves cwd and validates its shell environment against its own trusted root', async (t) => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky webtty worker ')));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const root = path.join(parent, 'project ăîș');
    fs.mkdirSync(path.join(root, 'repo', 'src'), { recursive: true });
    fs.mkdirSync(path.join(parent, 'outside'));
    fs.symlinkSync(path.join(parent, 'outside'), path.join(root, 'escape'));
    const processApi = new FakeProcess({ env: { PLOINKY_WORKSPACE_ROOT: root } });
    const shellEnv = buildShellEnvironment({}, { workspaceRoot: root });

    const h = harness({ processApi, defaultDirectoryResolver: true });
    await h.worker.initialize(init({ cwdRelative: 'repo/src', shellEnv }));
    assert.equal(h.spawnCalls[0].options.cwd, path.join(root, 'repo', 'src'));
    assert.equal(h.spawnCalls[0].options.env.PLOINKY_WORKSPACE_ROOT, root);

    const escaping = harness({ processApi: new FakeProcess({ env: { PLOINKY_WORKSPACE_ROOT: root } }), defaultDirectoryResolver: true });
    await escaping.worker.initialize(init({ cwdRelative: 'escape', shellEnv }));
    assert.equal(escaping.spawnCalls.length, 0);
    assert.ok(escaping.processApi.sent.some((message) => message.category === 'cwd-validation'));

    // A shell environment prepared for another root is not this worker's.
    const foreign = harness({ processApi: new FakeProcess({ env: { PLOINKY_WORKSPACE_ROOT: root } }), defaultDirectoryResolver: true });
    await assert.rejects(() => foreign.worker.initialize(init({ cwdRelative: 'repo/src', shellEnv: SHELL_ENV })));
    assert.equal(foreign.spawnCalls.length, 0);
});

test('a worker process without a valid trusted workspace root never starts', () => {
    for (const env of [{}, { PLOINKY_WORKSPACE_ROOT: '' }, { PLOINKY_WORKSPACE_ROOT: 'relative' }]) {
        const processApi = new FakeProcess({ env });
        const worker = runTerminalWorker({ processApi, argv: [`--ploinky-webtty-marker=${'m'.repeat(32)}`] });
        assert.equal(worker, null);
        assert.equal(processApi.exitCode, 1);
        assert.equal(processApi.connected, false);
        assert.equal(processApi.listenerCount('message'), 0);
    }
});

// A real workspace whose root contains spaces: the worker re-resolves the
// profile HOME inside it immediately before spawning, like the cwd.
function profileWorkspace(t) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky webtty worker home '));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const root = fs.realpathSync(parent);
    fs.mkdirSync(path.join(root, 'repo', 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, '.data', 'provider', 'profiles', 'p-1', 'home'), { recursive: true });
    const homeRelative = '.data/provider/profiles/p-1/home';
    const home = path.join(root, homeRelative);
    const identity = () => {
        const stat = fs.statSync(home, { bigint: true });
        return { dev: String(stat.dev), ino: String(stat.ino) };
    };
    const shellEnv = (homeValue = home) => buildShellEnvironment({}, {
        workspaceRoot: root,
        profile: { home: homeValue, provider: 'provider', id: 'p-1', label: 'Profile One' },
    });
    const worker = () => {
        const processApi = new FakeProcess({ env: { PLOINKY_WORKSPACE_ROOT: root } });
        const terminal = fakePty();
        const spawnCalls = [];
        const instance = new TerminalWorker({
            processApi,
            loadNodePty: () => ({
                spawn(shell, args, options) {
                    spawnCalls.push({ shell, args, options });
                    return terminal.api;
                },
            }),
            capturePtyIdentityImpl: () => PTY_IDENTITY,
            cleanupSessionImpl: async () => true,
            delayImpl: async () => {},
            identityWaitMs: 0,
        });
        return { worker: instance, processApi, spawnCalls };
    };
    return { root, home, homeRelative, identity, shellEnv, worker };
}

test('a profile init spawns the fixed shell with HOME only after the worker revalidates it', async (t) => {
    const fx = profileWorkspace(t);
    const h = fx.worker();
    await h.worker.initialize(init({
        cwdRelative: 'repo/src',
        shellEnv: fx.shellEnv(),
        homeRelative: fx.homeRelative,
        homeIdentity: fx.identity(),
    }));
    assert.equal(h.spawnCalls.length, 1);
    assert.equal(h.spawnCalls[0].shell, '/bin/bash');
    assert.deepEqual(h.spawnCalls[0].args, ['--noprofile', '--norc']);
    assert.equal(h.spawnCalls[0].options.cwd, path.join(fx.root, 'repo', 'src'));
    assert.deepEqual(h.spawnCalls[0].options.env, fx.shellEnv());
    assert.equal(h.spawnCalls[0].options.env.HOME, fx.home);
    assert.equal(h.spawnCalls[0].options.env.INPUTRC, '/etc/inputrc');
    assert.equal(h.processApi.sent[0].type, 'ready');
});

test('the worker refuses a replaced, moved or mismatched profile HOME before loading native bytes', async (t) => {
    const fx = profileWorkspace(t);
    const original = fx.identity();
    const cases = [
        ['identity mismatch', () => ({ homeIdentity: { ...original, ino: String(BigInt(original.ino) + 1n) } })],
        ['HOME is not the revalidated directory', () => ({ shellEnv: fx.shellEnv(path.join(fx.root, 'repo')) })],
        ['escaping relative path', () => ({ homeRelative: '../outside' })],
        ['missing directory', () => ({ homeRelative: '.data/provider/profiles/p-2/home' })],
        ['workspace root as HOME', () => ({ homeRelative: '.', shellEnv: fx.shellEnv(fx.root) })],
        ['replaced at the same path', () => {
            // Keep the original alive so the replacement cannot reuse its inode.
            fs.renameSync(fx.home, `${fx.home}-previous`);
            fs.mkdirSync(fx.home);
            return {};
        }],
    ];
    for (const [name, change] of cases) {
        const h = fx.worker();
        let nativeLoads = 0;
        h.worker.loadNodePty = () => { nativeLoads += 1; throw new Error('must not load'); };
        await h.worker.initialize(init({
            cwdRelative: 'repo/src',
            shellEnv: fx.shellEnv(),
            homeRelative: fx.homeRelative,
            homeIdentity: original,
            ...change(),
        }));
        assert.equal(nativeLoads, 0, name);
        assert.equal(h.spawnCalls.length, 0, name);
        assert.ok(h.processApi.sent.some((message) => message.type === 'error' && message.category === 'home-validation'), name);
    }
    // Profile variables without a revalidated HOME are not the fixed allowlist.
    const h = fx.worker();
    await assert.rejects(() => h.worker.initialize(init({ cwdRelative: 'repo/src', shellEnv: fx.shellEnv() })));
    assert.equal(h.spawnCalls.length, 0);
});
