import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isSuspended,
    prepareForExternalCommand,
    registerInterface,
    resume as resumeInputState,
} from '../../cli/commands/inputState.js';

function resetInputState(t) {
    t.after(() => {
        registerInterface(null);
        resumeInputState();
    });
}

test('external command restore is idempotent and does not print a prompt', (t) => {
    resetInputState(t);
    const events = [];
    const input = {
        isRaw: true,
        setRawMode(value) {
            events.push(['raw', value]);
            this.isRaw = value;
        },
    };
    const rl = {
        input,
        pause: () => events.push('pause'),
        resume: () => events.push('resume'),
        prompt: () => events.push('prompt'),
    };
    registerInterface(rl);
    const restore = prepareForExternalCommand({ promptOnRestore: false });
    assert.equal(isSuspended(), true);
    restore();
    restore();
    assert.equal(isSuspended(), false);
    assert.deepEqual(events, [
        'pause',
        ['raw', false],
        ['raw', true],
        'resume',
    ]);
    registerInterface(null);
});

test('raw-mode disable failure still returns a usable restoration', (t) => {
    resetInputState(t);
    const events = [];
    const input = {
        isRaw: true,
        setRawMode(value) {
            events.push(['raw', value]);
            if (value === false) throw new Error('raw disable failed');
            this.isRaw = value;
        },
    };
    const rl = {
        input,
        pause: () => events.push('pause'),
        resume: () => events.push('resume'),
        prompt: () => events.push('prompt'),
    };
    registerInterface(rl);

    let restore;
    assert.doesNotThrow(() => {
        restore = prepareForExternalCommand({ promptOnRestore: false });
    });
    assert.equal(isSuspended(), true);
    assert.doesNotThrow(restore);
    assert.equal(isSuspended(), false);
    assert.deepEqual(events, [
        'pause',
        ['raw', false],
        ['raw', true],
        'resume',
    ]);
});

test('raw-mode restore failure cannot strand the suspended input state', (t) => {
    resetInputState(t);
    const events = [];
    const input = {
        isRaw: true,
        setRawMode(value) {
            events.push(['raw', value]);
            if (value === true) throw new Error('raw restore failed');
            this.isRaw = value;
        },
    };
    const rl = {
        input,
        pause: () => events.push('pause'),
        resume: () => events.push('resume'),
        prompt: () => events.push('prompt'),
    };
    registerInterface(rl);
    const restore = prepareForExternalCommand({ promptOnRestore: false });

    assert.doesNotThrow(restore);
    assert.doesNotThrow(restore);
    assert.equal(isSuspended(), false);
    assert.deepEqual(events, [
        'pause',
        ['raw', false],
        ['raw', true],
        'resume',
    ]);
});

test('readline resume failure still clears suspension exactly once', (t) => {
    resetInputState(t);
    const events = [];
    const rl = {
        input: {},
        pause: () => events.push('pause'),
        resume: () => {
            events.push('resume');
            throw new Error('readline resume failed');
        },
        prompt: () => events.push('prompt'),
    };
    registerInterface(rl);
    const restore = prepareForExternalCommand({ promptOnRestore: false });

    assert.throws(restore, /readline resume failed/);
    assert.equal(isSuspended(), false);
    assert.doesNotThrow(restore);
    assert.deepEqual(events, ['pause', 'resume']);
});

test('input-stream resume failure still clears suspension exactly once', (t) => {
    resetInputState(t);
    const events = [];
    const input = {
        pause: () => events.push('pause'),
        resume: () => {
            events.push('resume');
            throw new Error('input resume failed');
        },
    };
    registerInterface({
        input,
        prompt: () => events.push('prompt'),
    });
    const restore = prepareForExternalCommand({ promptOnRestore: false });

    assert.throws(restore, /input resume failed/);
    assert.equal(isSuspended(), false);
    assert.doesNotThrow(restore);
    assert.deepEqual(events, ['pause', 'resume']);
});
