import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createMouseReportFilter, TerminalRelay, SWITCH_KEY } from '../../cli/utils/webttyCliClient.mjs';
import { createKeyParser } from '../../cli/utils/codingSessionsMenu.mjs';
import { createTerminalQueryStripper } from '../../core-services/webtty/terminal-queries.mjs';
import { createSupervisionCourier } from '../../cli/utils/supervisionCourier.mjs';

test('mouse enables are removed at every possible chunk boundary, preserving other modes', () => {
    const text = 'before\x1b[?1000;1002;1006;1049hafter';
    for (let split = 0; split <= text.length; split++) {
        const filter = createMouseReportFilter();
        assert.equal(filter(text.slice(0, split)) + filter(text.slice(split)), 'before\x1b[?1049hafter');
    }
});

test('replay removes terminal queries at every chunk boundary but preserves colours and text', () => {
    for (const query of ['\x1b]10;?\x07', '\x1b]11;?\x1b\\', '\x1b]4;0;?\x07', '\x1b[6n', '\x1b[>0c']) {
        const text = `before${query}\x1b[31mafter`;
        for (let split = 0; split <= text.length; split++) {
            const filter = createTerminalQueryStripper();
            assert.equal(filter(text.slice(0, split)) + filter(text.slice(split)), 'before\x1b[31mafter', `${query}: ${split}`);
        }
    }
});

test('Ctrl+backslash switches without delivering the control byte to the agent', async () => {
    const posted = [];
    const input = Object.assign(new EventEmitter(), { pause() {} });
    const relay = new TerminalRelay({ input, output: { write() {} }, signals: new EventEmitter(),
        sessionId: 'session', viewId: 'view', keys: { switch: SWITCH_KEY },
        client: { json: async (...args) => posted.push(args) } });
    relay.onData = () => {}; relay.onEnd = () => {}; relay.onSignal = () => {};
    const result = new Promise(resolve => { relay.resolve = resolve; });
    assert.equal(SWITCH_KEY, '\x1c');
    relay.queueInput('\x1c');
    assert.equal((await result).reason, 'switch');
    assert.equal(posted.some(([, route]) => route.endsWith('/input')), false);
    const parse = createKeyParser();
    assert.deepEqual(parse('\x1b['), []);
    assert.deepEqual(parse('Z'), ['tab']);
});

test('Shift+Tab and its follow-up reach the coding agent immediately', async () => {
    for (const followup of [null, 'r', 'x']) {
        const posted = [];
        const relay = new TerminalRelay({ sessionId: 'session', viewId: 'view',
            keys: { switch: SWITCH_KEY }, client: { json: async (...args) => posted.push(args) } });
        relay.queueInput('\x1b[Z');
        assert.equal(relay.keyTimer, null);
        if (followup) relay.queueInput(followup);
        await relay.flushing;
        assert.equal(relay.finished, false);
        assert.equal(posted.map(([, , body]) => body.data).join(''), `\x1b[Z${followup || ''}`);
        if (!followup) {
            relay.queueInput('r');
            await relay.flushing;
            assert.equal(relay.finished, false, 'r remains ordinary input');
            assert.equal(posted.at(-1)[2].data, 'r');
        }
    }
});

test('results wake the supervisor once per change and concurrent polling does not duplicate delivery', async () => {
    const worker = [], supervisor = [];
    let results = '## rev: 2\nstarted';
    let rev = 2;
    const courier = createSupervisionCourier({ folder: '/unused',
        readRevision: async () => ({ rev }), readResults: () => results,
        deliver: async text => worker.push(text), notifySupervisor: async text => supervisor.push(text) });
    await Promise.all([courier.once(), courier.once()]);
    assert.equal(worker.length, 1);
    assert.equal(supervisor.length, 1);
    await courier.once();
    assert.equal(supervisor.length, 1);
    results += '\nsummary: implemented; tests passed';
    await courier.once();
    assert.equal(supervisor.length, 2);
    assert.match(supervisor[1], /review the actual diff and tests/);
    rev = 1;
    await courier.once();
    assert.equal(worker.length, 1, 'an older task must not be replayed');
});
