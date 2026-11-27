import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerControlRelay } from '../../cli/utils/workerControlRelay.mjs';

test('MCP relay uses only the bound worker, monitors successful sends and does not replay operations', async () => {
    const inputs = [], sent = [], acknowledged = [];
    const requests = [
        { requestId: '1', operation: 'worker_status', arguments: {}, deadline: 100 },
        { requestId: '2', operation: 'worker_interrupt', arguments: {}, deadline: 100 },
        { requestId: '3', operation: 'worker_send', arguments: { message: 'Read tasks.md\nDo the work' }, deadline: 100 },
        { requestId: '4', operation: 'worker_send', arguments: { message: 'expired' }, deadline: 1 },
    ];
    const relay = createWorkerControlRelay({ now: () => 10,
        session: { supervisor: { controlId: 'control-1' }, worker: { terminalId: 'worker-1', interruptInput: '\u001b' } },
        monitor: { sent: () => sent.push(true), start() {}, stop() {} },
        api: async (route, body) => { assert.equal(route, 'control-poll'); assert.equal(body.id, 'control-1');
            acknowledged.push(...body.results); return { requests: requests.splice(0) }; },
        client: { json: async (method, url, body) => { inputs.push([method, url, body]); return { running: true, recentOutput: 'progress' }; } },
    });
    await relay.once(); await relay.once(); await relay.once();
    assert.equal(inputs.length, 3);
    assert.ok(inputs.every(([, url]) => url.startsWith('/webtty/sessions/worker-1/')));
    assert.equal(inputs[1][2].data, '\u001b');
    assert.equal(inputs[2][2].data, '\u001b[200~Read tasks.md\nDo the work\u001b[201~\r');
    assert.deepEqual(sent, [true]);
    assert.equal(acknowledged.length, 4);
    assert.match(acknowledged[3].result.error, /expired/u);
});

test('failed sends never arm monitoring', async () => {
    const relay = createWorkerControlRelay({ now: () => 1,
        session: { supervisor: { controlId: 'c' }, worker: { terminalId: 'w' } },
        monitor: { sent() { assert.fail('failed delivery was monitored'); } },
        api: async () => ({ requests: [{ requestId: 'a', deadline: 10, operation: 'worker_send', arguments: { message: 'go' } }] }),
        client: { json: async () => { throw new Error('gone'); } },
    });
    await relay.once();
});
