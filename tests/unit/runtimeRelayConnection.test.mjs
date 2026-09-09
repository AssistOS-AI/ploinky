import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connectRelayWorker } from '../../Agent/server/lib/runtimeRelayConnection.mjs';

function fixture() {
    const socket = new PassThrough();
    const stderr = new PassThrough();
    const worker = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        exitCode: null, signalCode: null,
    });
    let kills = 0;
    worker.kill = () => { kills += 1; };
    connectRelayWorker(socket, worker, { stderr });
    return { socket, worker, stderr, kills: () => kills };
}

test('broker accepts a new client after a real connection reset', async (t) => {
    const workers = new Set();
    const server = net.createServer((socket) => {
        const worker = spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { stdio: ['pipe', 'pipe', 'pipe'] });
        workers.add(worker);
        connectRelayWorker(socket, worker, { stderr: new PassThrough(), onExit: () => workers.delete(worker) });
    });
    t.after(() => { server.close(); for (const worker of workers) worker.kill(); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const broken = net.createConnection(server.address().port, '127.0.0.1');
    await once(broken, 'connect');
    broken.resetAndDestroy();
    await once(broken, 'close');
    const client = net.createConnection(server.address().port, '127.0.0.1');
    t.after(() => client.destroy());
    await once(client, 'connect');
    client.write('relay still works');
    const [data] = await once(client, 'data', { signal: AbortSignal.timeout(3000) });
    assert.equal(data.toString(), 'relay still works');
    client.end();
});

for (const channel of ['socket', 'stdin', 'stdout', 'stderr', 'worker']) {
    test(`relay contains ${channel} errors and tolerates subsequent teardown errors`, async () => {
        const f = fixture();
        const stream = channel === 'socket' ? f.socket : channel === 'worker' ? f.worker : f.worker[channel];
        stream.emit('error', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
        f.worker.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
        assert.equal(f.kills(), 1);
        assert.equal(f.socket.destroyed, true);
        assert.equal(f.stderr.destroyed, false);
        const next = fixture();
        assert.equal(next.socket.destroyed, false);
        next.socket.destroy();
    });
}
