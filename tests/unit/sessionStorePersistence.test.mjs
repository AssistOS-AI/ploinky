import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSessionStore, SSO_SESSION_STORE_UNAVAILABLE } from '../../cli/server/auth/sessionStore.js';
import {
    decodeSessionsFile,
    discardPersistedSessions,
    hashSessionId,
    SSO_SESSIONS_FILE_NAME,
} from '../../cli/server/auth/sessionPersistence.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sso-store-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const KEY = crypto.randomBytes(32);
// A fresh copy per call: the store zero-fills every key it is given.
const deriveKey = () => Buffer.from(KEY);
const PROVIDER = 'fake/provider';

function freshDirectory() {
    return fs.mkdtempSync(path.join(root, 'd-'));
}

function sessionFile(directory) {
    return path.join(directory, SSO_SESSIONS_FILE_NAME);
}

function storeOn(directory, { now = () => 1000, events = [], ...persistence } = {}) {
    return createSessionStore({
        now,
        persistence: { directory, deriveKey, log: (event, fields) => events.push([event, fields]), ...persistence },
    });
}

function record(expiresAt = 100_000, extra = {}) {
    return {
        providerAgent: PROVIDER,
        user: { id: 'u1', username: 'Zoë 名前' },
        tokens: { accessToken: 'AT' },
        providerSession: { tokens: { accessToken: 'AT' }, generation: 3 },
        expiresAt,
        ...extra,
    };
}

function decrypted(directory) {
    return decodeSessionsFile(fs.readFileSync(sessionFile(directory), 'utf8'), deriveKey);
}

// Real fs with selected operations replaced; `fail` maps an operation name to
// an error code while that entry is set.
function faultyFs(fail = {}, { onlyPath } = {}) {
    const wrap = (name) => (...args) => {
        const target = typeof args[0] === 'string' ? args[0] : '';
        if (fail[name] && (!onlyPath || target === onlyPath || name === 'renameSync')) {
            throw Object.assign(new Error(`${name} injected ${fail[name]}`), { code: fail[name] });
        }
        return fs[name](...args);
    };
    return {
        ...fs,
        lstatSync: wrap('lstatSync'),
        readFileSync: wrap('readFileSync'),
        renameSync: wrap('renameSync'),
        unlinkSync: wrap('unlinkSync'),
    };
}

function writtenStore(directory) {
    const store = storeOn(directory);
    store.open({ providerAgent: PROVIDER });
    const created = store.createSession(record());
    store.close();
    return created;
}

test('session keys are the domain-separated digest of the cookie value', () => {
    const expected = crypto.createHash('sha256').update('ploinky/sso-session-id/v1\0cookie-value').digest('hex');
    assert.equal(hashSessionId('cookie-value'), expected);
});

test('the file never contains a raw cookie value', () => {
    const directory = path.join(freshDirectory(), 'router-security');
    const store = storeOn(directory);
    assert.deepEqual(store.open({ providerAgent: PROVIDER }), { restored: 0, dropped: 0, rejected: null });
    const first = store.createSession({ ...record(), id: 'must-not-be-kept' });
    const second = store.createSession(record(200_000));
    store.close();

    const bytes = fs.readFileSync(sessionFile(directory));
    const plaintext = JSON.stringify(decrypted(directory));
    for (const { id } of [first, second]) {
        assert.equal(bytes.includes(id), false);
        assert.equal(plaintext.includes(id), false);
    }
    assert.equal(Object.hasOwn(first.session, 'id'), false, 'the stored record has no id');
    const entries = decrypted(directory).sessions;
    assert.deepEqual(Object.keys(entries).sort(), [hashSessionId(first.id), hashSessionId(second.id)].sort());
    for (const [key, entry] of Object.entries(entries)) {
        assert.match(key, /^[a-f0-9]{64}$/);
        assert.equal(Object.hasOwn(entry, 'id'), false, 'the plaintext record has no id');
    }
    assert.deepEqual(fs.readdirSync(directory), [SSO_SESSIONS_FILE_NAME], 'no temp file remains');
    assert.equal(fs.statSync(sessionFile(directory)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);

    // A load that accepts the file never writes.
    const writes = [];
    const spyFs = { ...fs };
    for (const name of ['openSync', 'renameSync', 'unlinkSync', 'writeFileSync', 'mkdirSync']) {
        spyFs[name] = (...args) => {
            if (name !== 'openSync' || args[1] !== fs.constants.O_RDONLY) writes.push(name);
            return fs[name](...args);
        };
    }
    const reader = storeOn(directory, { fsApi: spyFs });
    assert.deepEqual(reader.open({ providerAgent: PROVIDER }), { restored: 2, dropped: 0, rejected: null });
    assert.equal(reader.getSession(first.id).user.username, 'Zoë 名前');
    assert.equal(Object.hasOwn(reader.getSession(first.id), 'id'), false);
    assert.equal(reader.getSession(first.id), reader.getSession(first.id), 'one record object per session');
    reader.close();
    assert.deepEqual(writes, []);
});

test('a corrupt or undecryptable file starts empty and is removed', async (t) => {
    const cases = [
        ['truncated', (bytes) => bytes.subarray(0, Math.floor(bytes.length / 2))],
        ['flipped byte', (bytes) => {
            const text = bytes.toString('utf8');
            const index = 'ploinky-sso-sessions.v1.'.length + 40;
            return Buffer.from(text.slice(0, index) + (text[index] === 'A' ? 'B' : 'A') + text.slice(index + 1));
        }],
        ['wrong key', (bytes) => bytes, { deriveKey: () => crypto.randomBytes(32) }],
        ['wrong prefix', (bytes) => Buffer.from(bytes.toString('utf8').replace('ploinky-sso-sessions.', 'other-envelope.'))],
        ['newer version', (bytes) => Buffer.from(bytes.toString('utf8').replace('.v1.', '.v2.'))],
        ['zero bytes', () => Buffer.alloc(0)],
        ['oversized', (bytes) => bytes, { maxFileBytes: 16 }],
        ['read error on every attempt', (bytes) => bytes, { fsApi: 'read-error' }],
    ];
    for (const [label, mutate, options = {}] of cases) {
        await t.test(label, () => {
            const directory = freshDirectory();
            const created = writtenStore(directory);
            const file = sessionFile(directory);
            fs.writeFileSync(file, mutate(fs.readFileSync(file)));
            const events = [];
            const persistence = { ...options, events };
            if (options.fsApi === 'read-error') persistence.fsApi = faultyFs({ readFileSync: 'EIO' }, { onlyPath: file });
            const store = storeOn(directory, persistence);
            const opened = store.open({ providerAgent: PROVIDER });
            assert.equal(opened.restored, 0);
            assert.equal(typeof opened.rejected, 'string');
            assert.equal(store.__testables.size(), 0);
            assert.equal(store.getSession(created.id), null);
            assert.equal(store.state(), 'open');
            assert.equal(fs.existsSync(file), false, 'the rejected file is removed at open');
            assert.ok(events.some(([event, fields]) => event === 'sso_session_store_load_rejected' && fields.reason === opened.rejected));
            store.close();
            const later = storeOn(directory);
            assert.equal(later.open({ providerAgent: PROVIDER }).restored, 0);
            assert.equal(later.getSession(created.id), null);
            later.close();
        });
    }

    await t.test('a removal that fails keeps the store open, empty and retrying', () => {
        const directory = freshDirectory();
        writtenStore(directory);
        const file = sessionFile(directory);
        fs.writeFileSync(file, 'ploinky-sso-sessions.v1.AAAA\n');
        const events = [];
        const store = storeOn(directory, { events, fsApi: faultyFs({ unlinkSync: 'EPERM' }, { onlyPath: file }) });
        const opened = store.open({ providerAgent: PROVIDER });
        assert.equal(opened.restored, 0);
        assert.equal(store.__testables.size(), 0);
        assert.ok(events.some(([event]) => event === 'sso_session_store_reject_not_removed'));
        assert.equal(store.__testables.repairPending(), 'reject');
        assert.equal(store.__testables.repairArmed(), true);
        store.close();
        assert.equal(store.__testables.repairArmed(), false);
    });

    await t.test('a directory at the path is a failed removal and is left untouched', () => {
        const directory = freshDirectory();
        const file = sessionFile(directory);
        fs.mkdirSync(file);
        fs.writeFileSync(path.join(file, 'keep'), 'operator data');
        const events = [];
        const store = storeOn(directory, { events });
        const opened = store.open({ providerAgent: PROVIDER });
        assert.equal(opened.rejected, 'not_regular_file');
        assert.ok(events.some(([event]) => event === 'sso_session_store_reject_not_removed'));
        assert.equal(fs.readFileSync(path.join(file, 'keep'), 'utf8'), 'operator data');
        store.close();
    });

    await t.test('a symlink is unlinked without following it', () => {
        const directory = freshDirectory();
        const target = path.join(freshDirectory(), 'target');
        fs.writeFileSync(target, 'not a session file');
        fs.symlinkSync(target, sessionFile(directory));
        const store = storeOn(directory);
        assert.equal(store.open({ providerAgent: PROVIDER }).rejected, 'not_regular_file');
        assert.equal(fs.existsSync(sessionFile(directory)), false);
        assert.equal(fs.readFileSync(target, 'utf8'), 'not a session file');
        store.close();
    });
});

test('entries that are malformed, expired or of another provider are dropped one by one', () => {
    const directory = freshDirectory();
    const store = storeOn(directory);
    store.open({ providerAgent: PROVIDER });
    const kept = store.createSession(record(100_000));
    store.createSession(record(1500));
    store.createSession(record(100_000, { user: { username: 'no id' } }));
    store.createSession(record(100_000, { providerAgent: 'other/provider' }));
    store.close();
    const reader = storeOn(directory, { now: () => 2000 });
    assert.deepEqual(reader.open({ providerAgent: PROVIDER }), { restored: 1, dropped: 3, rejected: null });
    assert.equal(reader.getSession(kept.id).user.id, 'u1');
    // The other provider's record leaves the file with the next flush.
    assert.equal(reader.__testables.dirty(), true);
    reader.close();
    assert.deepEqual(Object.keys(decrypted(directory).sessions), [hashSessionId(kept.id)]);
    const unconfigured = storeOn(directory, { now: () => 2000 });
    assert.equal(unconfigured.open({ providerAgent: '' }).restored, 1, 'an empty reference drops nothing');
    unconfigured.close();
});

test('debounced expiry never extends a session', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const directory = freshDirectory();
    const E1 = 100_000;
    const E2 = 200_000;
    const E3 = 50_000;
    const store = storeOn(directory);
    store.open({ providerAgent: PROVIDER });
    const { id } = store.createSession(record(E1));
    store.updateSession(id, { expiresAt: E2 });
    assert.equal(store.getSession(id).expiresAt, E2);
    assert.equal(store.__testables.flushArmed(), true);

    const reader = storeOn(directory);
    reader.open({ providerAgent: PROVIDER });
    assert.equal(reader.getSession(id).expiresAt, E1, 'the slide is not on disk yet');
    reader.close();

    const late = storeOn(directory, { now: () => E1 + 1 });
    assert.deepEqual(late.open({ providerAgent: PROVIDER }), { restored: 0, dropped: 1, rejected: null });
    late.close();

    t.mock.timers.tick(29_999);
    assert.equal(decrypted(directory).sessions[hashSessionId(id)].expiresAt, E1);
    t.mock.timers.tick(1);
    assert.equal(decrypted(directory).sessions[hashSessionId(id)].expiresAt, E2);
    assert.equal(store.__testables.flushArmed(), false);

    store.updateSession(id, { expiresAt: E3 });
    assert.equal(decrypted(directory).sessions[hashSessionId(id)].expiresAt, E3, 'a decrease is written at once');
    store.close();
});

test('a store that was never opened never writes', () => {
    const directory = freshDirectory();
    fs.writeFileSync(sessionFile(directory), 'existing bytes');
    const before = fs.readdirSync(directory);
    const store = storeOn(directory);
    assert.equal(store.state(), 'unopened');
    assert.equal(store.isAvailable(), false);
    assert.equal(store.getSession('anything'), null);
    assert.throws(() => store.createSession(record()), { code: SSO_SESSION_STORE_UNAVAILABLE });
    assert.throws(() => store.deleteSession('anything'), { code: SSO_SESSION_STORE_UNAVAILABLE });
    store.close();
    assert.equal(store.state(), 'closed');
    assert.deepEqual(store.open({ providerAgent: PROVIDER }), { restored: 0, dropped: 0, rejected: null });
    assert.equal(store.state(), 'closed', 'transitions are one-way');
    assert.deepEqual(fs.readdirSync(directory), before);
    assert.equal(fs.readFileSync(sessionFile(directory), 'utf8'), 'existing bytes');
    assert.throws(() => store.configurePersistence({ directory }), /cannot be configured/);
    // The default store never touches the disk at all.
    const memory = createSessionStore();
    assert.equal(memory.state(), 'memory');
    assert.deepEqual(memory.deleteSession(memory.createSession(record()).id), { existed: true, persisted: true });
    memory.close();
    assert.equal(memory.state(), 'memory');
});

test('a foreign writer stops the store instead of being overwritten', () => {
    const directory = freshDirectory();
    const created = writtenStore(directory);
    const eventsA = [];
    const a = storeOn(directory, { events: eventsA });
    const b = storeOn(directory);
    a.open({ providerAgent: PROVIDER });
    b.open({ providerAgent: PROVIDER });
    assert.deepEqual(b.deleteSession(created.id), { existed: true, persisted: true });
    const written = fs.readFileSync(sessionFile(directory));
    a.updateSession(created.id, { expiresAt: 150_000 });
    assert.equal(a.flush(), false);
    assert.equal(a.state(), 'closed');
    assert.deepEqual(fs.readFileSync(sessionFile(directory)), written);
    assert.ok(eventsA.some(([event, fields]) => event === 'sso_session_store_foreign_writer' && fields.level === 'error'));
    assert.equal(a.getSession(created.id), null);
    b.close();

    // A rename that lands followed by a failing directory fsync is the
    // store's own write and must not trip its guard.
    const own = freshDirectory();
    let failDirectoryFsync = false;
    const directoryFds = new Set();
    const fsApi = {
        ...fs,
        openSync: (target, flags, mode) => {
            const fd = fs.openSync(target, flags, mode);
            if (target === own) directoryFds.add(fd);
            return fd;
        },
        fsyncSync: (fd) => {
            if (failDirectoryFsync && directoryFds.has(fd)) throw Object.assign(new Error('injected'), { code: 'EIO' });
            return fs.fsyncSync(fd);
        },
    };
    const events = [];
    const c = storeOn(own, { fsApi, events });
    c.open({ providerAgent: PROVIDER });
    failDirectoryFsync = true;
    const session = c.createSession(record());
    assert.ok(events.some(([event, fields]) => event === 'sso_session_store_write_failed' && fields.code === 'EIO'));
    assert.equal(c.state(), 'open');
    failDirectoryFsync = false;
    assert.equal(c.flush(), true);
    assert.equal(c.state(), 'open');
    assert.ok(decrypted(own).sessions[hashSessionId(session.id)]);

    // The same holds for a fallback unlink that lands before its directory
    // fsync fails.
    let failRename = false;
    fsApi.renameSync = (...args) => {
        if (failRename) throw Object.assign(new Error('injected'), { code: 'ENOSPC' });
        return fs.renameSync(...args);
    };
    failRename = true;
    failDirectoryFsync = true;
    assert.deepEqual(c.deleteSession(session.id), { existed: true, persisted: false });
    assert.equal(fs.existsSync(sessionFile(own)), false);
    failRename = false;
    failDirectoryFsync = false;
    c.flush();
    assert.equal(c.state(), 'open');
    assert.equal(c.__testables.repairPending(), null);
    assert.equal(decrypted(own).sessions[hashSessionId(session.id)], undefined);
    c.close();
});

test('durable delete failure falls back to unlink, then reports it', async (t) => {
    await t.test('a failing replace unlinks the file', () => {
        const directory = freshDirectory();
        const fail = {};
        const store = storeOn(directory, { fsApi: faultyFs(fail) });
        store.open({ providerAgent: PROVIDER });
        const kept = store.createSession(record());
        const { id } = store.createSession(record());
        fail.renameSync = 'ENOSPC';
        assert.deepEqual(store.deleteSession(id), { existed: true, persisted: true });
        assert.equal(fs.existsSync(sessionFile(directory)), false);
        const reader = storeOn(directory);
        assert.equal(reader.open({ providerAgent: PROVIDER }).restored, 0);
        reader.close();
        assert.ok(store.getSession(kept.id), 'other sessions stay in memory');
        assert.equal(store.__testables.flushArmed(), true, 'a later flush rewrites the snapshot');
        delete fail.renameSync;
        assert.equal(store.flush(), true);
        assert.deepEqual(Object.keys(decrypted(directory).sessions), [hashSessionId(kept.id)]);
        store.close();
    });

    await t.test('when neither works the delete is reported as not durable and retried', (tt) => {
        tt.mock.timers.enable({ apis: ['setTimeout'] });
        const directory = freshDirectory();
        const fail = {};
        const events = [];
        const store = storeOn(directory, { fsApi: faultyFs(fail), events });
        store.open({ providerAgent: PROVIDER });
        const { id } = store.createSession(record());
        fail.renameSync = 'EROFS';
        fail.unlinkSync = 'EROFS';
        assert.deepEqual(store.deleteSession(id), { existed: true, persisted: false });
        assert.equal(store.getSession(id), null, 'this process refuses the session at once');
        const notDurable = events.find(([event]) => event === 'sso_session_delete_not_durable');
        assert.deepEqual(notDurable[1], { level: 'error', code: 'EROFS' });
        assert.equal(JSON.stringify(events).includes(id), false);
        assert.equal(store.__testables.repairPending(), 'delete');
        assert.equal(store.__testables.repairArmed(), true);
        tt.mock.timers.tick(1000);
        assert.equal(store.__testables.repairPending(), 'delete', 'still failing');
        delete fail.renameSync;
        delete fail.unlinkSync;
        tt.mock.timers.tick(1000);
        assert.equal(store.__testables.repairPending(), null);
        assert.equal(decrypted(directory).sessions[hashSessionId(id)], undefined);
        store.close();
    });
});

test('a failed discard is retried every second until it succeeds, then no timer remains', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const directory = freshDirectory();
    writtenStore(directory);
    let unlinkCalls = 0;
    let failUntil = 3;
    const fsApi = {
        ...fs,
        unlinkSync: (target) => {
            unlinkCalls += 1;
            if (unlinkCalls < failUntil) throw Object.assign(new Error('unlink injected EPERM'), { code: 'EPERM' });
            return fs.unlinkSync(target);
        },
    };
    const events = [];
    const result = discardPersistedSessions({ directory, fsApi, log: (event, fields) => events.push([event, fields]) });
    assert.deepEqual(result, { removed: false }, 'the return value is the first attempt');
    assert.equal(fs.existsSync(sessionFile(directory)), true);
    assert.deepEqual(events.map(([event]) => event), ['sso_session_store_discard_failed']);

    t.mock.timers.tick(999);
    assert.equal(unlinkCalls, 1, 'no retry before one second');
    t.mock.timers.tick(1);
    assert.equal(unlinkCalls, 2);
    assert.equal(fs.existsSync(sessionFile(directory)), true, 'the second attempt fails too');
    t.mock.timers.tick(1000);
    assert.equal(unlinkCalls, 3);
    assert.equal(fs.existsSync(sessionFile(directory)), false, 'the third attempt removes the file');
    assert.deepEqual(events.map(([event]) => event), ['sso_session_store_discard_failed', 'sso_session_store_discard_retried']);
    assert.deepEqual(events[1][1], { removed: true, attempts: 3 });

    for (let second = 0; second < 60; second += 1) t.mock.timers.tick(1000);
    assert.equal(unlinkCalls, 3, 'no further timer remains after success');
    assert.equal(events.length, 2);
});

test('a discard that keeps failing stops retrying after thirty attempts', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const directory = freshDirectory();
    writtenStore(directory);
    let unlinkCalls = 0;
    const fsApi = {
        ...fs,
        unlinkSync: () => {
            unlinkCalls += 1;
            throw Object.assign(new Error('unlink injected EPERM'), { code: 'EPERM' });
        },
    };
    const events = [];
    discardPersistedSessions({ directory, fsApi, log: (event, fields) => events.push([event, fields]) });
    for (let second = 0; second < 40; second += 1) t.mock.timers.tick(1000);
    assert.equal(unlinkCalls, 31, 'the first attempt plus thirty retries');
    assert.deepEqual(events.map(([event]) => event), ['sso_session_store_discard_failed']);
    assert.equal(fs.existsSync(sessionFile(directory)), true);
});

test('discarding persisted sessions removes only the session file and never throws', () => {
    const directory = freshDirectory();
    writtenStore(directory);
    fs.writeFileSync(path.join(directory, 'policy-state.json'), '{}');
    assert.deepEqual(discardPersistedSessions({ directory }), { removed: true });
    assert.deepEqual(fs.readdirSync(directory), ['policy-state.json']);
    assert.deepEqual(discardPersistedSessions({ directory }), { removed: false });
    assert.deepEqual(discardPersistedSessions({ directory: path.join(directory, 'missing') }), { removed: false });
    fs.mkdirSync(sessionFile(directory));
    fs.writeFileSync(path.join(sessionFile(directory), 'keep'), 'x');
    const events = [];
    assert.deepEqual(discardPersistedSessions({ directory, log: (event, fields) => events.push([event, fields]) }), { removed: false });
    assert.equal(fs.readFileSync(path.join(sessionFile(directory), 'keep'), 'utf8'), 'x');
    assert.equal(events[0][0], 'sso_session_store_discard_failed');
});
