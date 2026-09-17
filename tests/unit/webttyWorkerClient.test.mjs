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
        workspaceRoot: '/home/user/project',
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

test('Box workers fork with only the fixed environment and the explicit workspace root', async () => {
    const forks = [];
    const child = new WedgedChild();
    const client = new WebttyWorkerClient({
        terminalId: 'terminal-abcdefghijklmnop',
        marker: 'marker-abcdefghijklmnopqrstuvwx',
        workspaceRoot: '/home/user/work space/project',
        forkImpl: (workerPath, args, options) => { forks.push(options.env); return child; },
        readProcessIdentity: async () => ({ pid: 4100, uid: 1000, startToken: 'linux-proc:41000' }),
        closeGraceMs: 5,
        ipcSendTimeoutMs: 50,
    });
    await client.spawn();
    assert.equal(forks[0].PLOINKY_WORKSPACE_ROOT, '/home/user/work space/project');
    assert.equal(Object.keys(forks[0]).some((key) => !['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'PLOINKY_WORKSPACE_ROOT'].includes(key)), false);
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.throws(() => new WebttyWorkerClient({ terminalId: 'terminal-abcdefghijklmnop', marker: 'marker-abcdefghijklmnopqrstuvwx' }),
        (error) => error.code === 'WEBTTY_CWD_INVALID');
});
