import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { WebttyWorkerClient } from '../../cli/server/webtty/workerClient.mjs';

class WedgedChild extends EventEmitter {
    constructor() {
        super();
        this.pid = 4100;
        this.connected = true;
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.messages = [];
        this.kills = [];
    }

    send(message) {
        this.messages.push(message);
        return false;
    }

    kill(signal) {
        this.kills.push(signal);
        queueMicrotask(() => this.emit('exit', null, signal));
        return true;
    }
}

test('Box worker close deadline is independent of a wedged IPC send callback', async () => {
    const child = new WedgedChild();
    const client = new WebttyWorkerClient({
        terminalId: 'terminal-abcdefghijklmnop',
        marker: 'marker-abcdefghijklmnopqrstuvwx',
        forkImpl: () => child,
        readProcessIdentity: async () => ({
            pid: 4100,
            uid: 1000,
            startToken: 'linux-proc:41000',
        }),
        closeGraceMs: 5,
        ipcSendTimeoutMs: 50,
    });
    await client.spawn();
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert.equal(client.queuedBytes, 0);
    assert.equal(await client.waitForExit(), true);
});
