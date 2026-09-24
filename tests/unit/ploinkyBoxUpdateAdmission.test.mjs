import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    ADMISSION_JOURNAL_KIND,
    listUnresolvedAdmissions,
    runJournaledAdmission,
} from '../../ploinky-box/update/admission.mjs';
import { createMemoryUpdateHostState, createUpdateHostState } from '../../ploinky-box/update/hostState.mjs';

const identity = Object.freeze({ instance: 'ploinky-box-workspace-123456789abc', workspaceRoot: '/workspace' });

// One metadata cell with read/write/restore adapters and injectable faults.
function cell(name, prior, candidate, faults, events) {
    const state = { value: prior };
    return {
        state,
        item: {
            name,
            read() {
                events.push(`read:${name}`);
                if (faults.readAfterWrite === name && state.value === candidate) throw new Error(`${name} readback failed`);
                return state.value;
            },
            write() {
                events.push(`write:${name}`);
                if (faults.write === name) throw new Error(`${name} write failed`);
                state.value = candidate;
                if (faults.writePartial === name) throw new Error(`${name} write failed after publishing`);
                if (faults.successorAfterWrite === name) state.value = `${candidate}-successor`;
            },
            restore(value) {
                events.push(`restore:${name}`);
                if (faults.restore === name) throw new Error(`${name} restore failed`);
                state.value = value;
            },
        },
    };
}

function run({ prior = { a: null, b: null }, faults = {}, store = createMemoryUpdateHostState() } = {}) {
    const events = [];
    const a = cell('a', prior.a, 'candidate-a', faults, events);
    const b = cell('b', prior.b, 'candidate-b', faults, events);
    const promise = runJournaledAdmission({
        identity,
        store,
        operation: 'update',
        items: [a.item, b.item],
        source: { coreArgv: ['update'] },
        transactionId: 'feedfacefeedface',
        async validate() {
            events.push('validate');
            if (faults.validate) throw new Error('identity changed');
        },
        async settle() {
            events.push('settle');
            if (faults.settleSuccessor) b.state.value = 'external-successor';
            if (faults.settle) throw new Error('settle failed');
        },
    });
    return { promise, events, a, b, store };
}

const journals = store => store.list(ADMISSION_JOURNAL_KIND);

for (const [label, prior] of [
    ['absent prior metadata', { a: null, b: null }],
    ['present prior metadata', { a: 'old-a', b: { nested: ['old-b'] } }],
]) {
    test(`successful admission publishes candidates, settles last and removes its journal (${label})`, async () => {
        const fixture = run({ prior });
        const result = await fixture.promise;
        assert.equal(result.outcome, 'settled');
        assert.equal(fixture.a.state.value, 'candidate-a');
        assert.equal(fixture.b.state.value, 'candidate-b');
        assert.equal(fixture.events.indexOf('validate') < fixture.events.indexOf('write:a'), true);
        assert.equal(fixture.events.at(-1), 'settle');
        assert.deepEqual(journals(fixture.store), []);
    });

    for (const fault of ['write:a', 'write:b', 'readback:a', 'readback:b', 'settle']) {
        test(`${fault} failure recovers ${label} and keeps a journal only when recovery is required`, async () => {
            const [kind, name] = fault.split(':');
            const faults = kind === 'write' ? { write: name }
                : kind === 'readback' ? { readAfterWrite: name } : { settle: true };
            const fixture = run({ prior, faults });
            await assert.rejects(fixture.promise, error => {
                if (kind === 'readback') {
                    // A candidate that was published but never observed cannot be
                    // proven ours, so it is preserved and reported.
                    assert.equal(error.admission.outcome, 'recovery-required');
                    assert.match(error.message, /recovery required/);
                    return true;
                }
                assert.equal(error.admission.outcome, 'recovered');
                assert.doesNotMatch(error.message, /recovery required/);
                return true;
            });
            if (kind === 'readback') {
                assert.equal(fixture[name].state.value, `candidate-${name}`);
                assert.equal(journals(fixture.store).length, 1);
                return;
            }
            assert.deepEqual(fixture.a.state.value, prior.a);
            assert.deepEqual(fixture.b.state.value, prior.b);
            assert.deepEqual(journals(fixture.store), []);
        });
    }

    test(`validation and journal failures stop before any metadata write (${label})`, async () => {
        const validation = run({ prior, faults: { validate: true } });
        await assert.rejects(validation.promise, /identity changed/);
        assert.equal(validation.events.some(event => event.startsWith('write:')), false);
        assert.deepEqual(journals(validation.store), []);

        const store = createMemoryUpdateHostState();
        const failing = { ...store, write() { throw new Error('journal unavailable'); } };
        const journal = run({ prior, store: failing });
        await assert.rejects(journal.promise, /journal unavailable/);
        assert.equal(journal.events.some(event => event.startsWith('write:')), false);
        assert.deepEqual(journal.a.state.value, prior.a);
    });

    test(`an external successor is preserved and reported while ours is restored (${label})`, async () => {
        const fixture = run({ prior, faults: { settleSuccessor: true, settle: true } });
        await assert.rejects(fixture.promise, error => {
            assert.equal(error.admission.outcome, 'recovery-required');
            assert.deepEqual(error.admission.results.map(result => [result.name, result.outcome]), [
                ['b', 'successor-preserved'],
                ['a', 'restored'],
            ]);
            assert.match(error.message, /settle failed; admission metadata recovery required \[b: successor-preserved\]/);
            return true;
        });
        assert.equal(fixture.b.state.value, 'external-successor');
        assert.deepEqual(fixture.a.state.value, prior.a);
        const [name] = journals(fixture.store);
        const journal = fixture.store.read(ADMISSION_JOURNAL_KIND, name);
        assert.equal(journal.phase, 'recovery-required');
        assert.deepEqual(journal.items.map(item => item.prior), [prior.a, prior.b]);
        assert.deepEqual(journal.items.map(item => item.candidate), ['candidate-a', 'candidate-b']);
        assert.deepEqual(listUnresolvedAdmissions(fixture.store, identity).map(entry => entry.phase), ['recovery-required']);
    });

    test(`a failed restoration is reported and retains the journal (${label})`, async () => {
        const fixture = run({ prior, faults: { settle: true, restore: 'b' } });
        await assert.rejects(fixture.promise, error => {
            assert.equal(error.admission.outcome, 'recovery-required');
            assert.match(error.message, /b: restore-failed \(b restore failed\)/);
            return true;
        });
        assert.equal(fixture.b.state.value, 'candidate-b');
        assert.deepEqual(fixture.a.state.value, prior.a);
        assert.equal(journals(fixture.store).length, 1);
    });

    test(`a write that failed after publishing is never restored blindly (${label})`, async () => {
        const fixture = run({ prior, faults: { writePartial: 'b' } });
        await assert.rejects(fixture.promise, error => {
            assert.equal(error.admission.outcome, 'recovery-required');
            return true;
        });
        assert.equal(fixture.b.state.value, 'candidate-b');
        assert.deepEqual(fixture.a.state.value, prior.a);
    });

    test(`the value observed right after our write is the candidate that recovery compares (${label})`, async () => {
        // Known limit: a change inside the write/read-back window itself is
        // indistinguishable from our write and is treated as ours.
        const fixture = run({ prior, faults: { successorAfterWrite: 'a', settle: true } });
        await assert.rejects(fixture.promise, error => {
            assert.equal(error.admission.outcome, 'recovered');
            return true;
        });
        assert.deepEqual(fixture.a.state.value, prior.a);
    });
}

test('journal cleanup failure after settlement is a warning, never a restoration', async () => {
    const store = createMemoryUpdateHostState();
    const failing = { ...store, remove() { throw new Error('disk full'); } };
    const fixture = run({ store: failing });
    const result = await fixture.promise;
    assert.equal(result.outcome, 'settled');
    assert.match(result.warnings[0], /could not be removed: disk full/);
    assert.equal(fixture.a.state.value, 'candidate-a');
    assert.equal(fixture.events.some(event => event.startsWith('restore:')), false);
});

test('an unreadable prior value stops admission before the journal or any write', async () => {
    const store = createMemoryUpdateHostState();
    const events = [];
    await assert.rejects(runJournaledAdmission({
        identity,
        store,
        items: [{ name: 'a', read() { throw new Error('prior unreadable'); }, write() { events.push('write'); }, restore() {} }],
    }), /prior unreadable/);
    assert.deepEqual(events, []);
    assert.deepEqual(journals(store), []);
});

test('the durable journal holds prior absence and the observed candidate until settlement', async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-admission-journal-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const store = createUpdateHostState({ stateRoot: path.join(home, '.ploinky-box') });
    const directory = path.join(home, '.ploinky-box', ADMISSION_JOURNAL_KIND);
    const values = { a: null };
    let observed;
    await runJournaledAdmission({
        identity,
        store,
        operation: 'restart',
        transactionId: '0123456789abcdef',
        items: [{
            name: 'a',
            read: () => values.a,
            write: () => { values.a = { selected: 'candidate' }; },
            restore: (prior) => { values.a = prior; },
        }],
        async settle() {
            const [file] = fs.readdirSync(directory);
            assert.equal(fs.statSync(path.join(directory, file)).mode & 0o777, 0o600);
            assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
            observed = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
        },
    });
    assert.equal(observed.phase, 'admitting');
    assert.equal(observed.instance, identity.instance);
    assert.deepEqual(observed.items, [{ name: 'a', prior: null, candidate: { selected: 'candidate' }, state: 'written' }]);
    assert.deepEqual(fs.readdirSync(directory), []);
});

test('the durable host state store refuses linked, shared or foreign-mode records', async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-state-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const store = createUpdateHostState({ stateRoot: path.join(home, '.ploinky-box') });
    store.write('update-pending', 'ploinky-box-a-123456789abc', { ok: true });
    const file = path.join(home, '.ploinky-box', 'update-pending', 'ploinky-box-a-123456789abc.json');
    assert.deepEqual(store.read('update-pending', 'ploinky-box-a-123456789abc'), { ok: true });
    fs.chmodSync(file, 0o644);
    assert.throws(() => store.read('update-pending', 'ploinky-box-a-123456789abc'), { code: 'PLOINKY_BOX_UPDATE_STATE_INVALID' });
    fs.chmodSync(file, 0o600);
    fs.linkSync(file, path.join(home, 'second-link'));
    assert.throws(() => store.read('update-pending', 'ploinky-box-a-123456789abc'), /non-linked/);
    fs.unlinkSync(path.join(home, 'second-link'));
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(home, 'elsewhere.json'), file);
    assert.throws(() => store.read('update-pending', 'ploinky-box-a-123456789abc'), { code: 'PLOINKY_BOX_UPDATE_STATE_INVALID' });
    assert.throws(() => store.write('update-pending', '../escape', {}), /Invalid update state record name/);
    assert.equal(store.claim('update-pending', 'missing-record'), null);
});
