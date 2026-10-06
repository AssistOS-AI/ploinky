import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from '../../cli/server/auth/sessionStore.js';

test('an expired requested session is rejected even outside the next sweep batch', (t) => {
    t.mock.method(Date, 'now', () => 100);
    const store = createSessionStore();
    for (let index = 0; index < 100; index += 1) store.createSession({ expiresAt: 1000 });
    const expired = store.createSession({ expiresAt: 200 });
    Date.now.mock.mockImplementation(() => 201);
    assert.equal(store.getSession(expired.id), null);
    assert.equal(store.__testables.size(), 100);
});

test('lookup and creation each examine at most eight stored entries; 1250 lookups drain 9999 expired sessions', (t) => {
    t.mock.method(Date, 'now', () => 100);
    const store = createSessionStore();
    const records = [];
    for (let index = 0; index < 10000; index += 1) {
        records.push(store.createSession({ expiresAt: index === 9999 ? 1000 : 200 }));
    }
    let reads = 0;
    for (const { session } of records) {
        const expiry = session.expiresAt;
        Object.defineProperty(session, 'expiresAt', { get() { reads += 1; return expiry; } });
    }
    reads = 0;
    const extra = store.createSession({ expiresAt: 1000 });
    assert.ok(reads <= 16, `createSession examined ${reads / 2} entries`);
    store.deleteSession(extra.id);
    Date.now.mock.mockImplementation(() => 201);
    const survivor = records.at(-1);
    for (let index = 0; index < 1250; index += 1) {
        reads = 0;
        assert.equal(store.getSession(survivor.id), survivor.session);
        assert.ok(reads <= 18, `getSession examined ${(reads - 2) / 2} sweep entries`);
    }
    assert.equal(store.__testables.size(), 1);
});

test('an exhausted iterator restarts and removes sessions inserted after exhaustion', (t) => {
    t.mock.method(Date, 'now', () => 100);
    const store = createSessionStore();
    const first = store.createSession({ expiresAt: 200 });
    Date.now.mock.mockImplementation(() => 201);
    assert.equal(store.getSession(first.id), null);
    assert.equal(store.__testables.size(), 0);
    store.getSession('missing');
    Date.now.mock.mockImplementation(() => 300);
    store.createSession({ expiresAt: 400 });
    Date.now.mock.mockImplementation(() => 401);
    store.getSession('missing');
    assert.equal(store.__testables.size(), 0);
});

test('bulk listing and predicate deletion still clean every expired session', (t) => {
    t.mock.method(Date, 'now', () => 100);
    for (const operation of ['getAllSessions', 'deleteSessionsWhere']) {
        const store = createSessionStore();
        for (let index = 0; index < 100; index += 1) store.createSession({ expiresAt: 200 });
        const live = store.createSession({ expiresAt: 1000 });
        Date.now.mock.mockImplementation(() => 201);
        if (operation === 'getAllSessions') assert.deepEqual(store.getAllSessions(), [live.session]);
        else store.deleteSessionsWhere(() => false);
        assert.equal(store.__testables.size(), 1);
        Date.now.mock.mockImplementation(() => 100);
    }
});
