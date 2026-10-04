import { EventEmitter } from 'node:events';
import { createOwnedCustody, createStopLatch } from './execution_codex.mjs';

// Test-only fabricated host. It routes exact argument arrays to canned replies; nothing here spawns or touches a runtime.
export function createFakeHost(routes = []) {
    const log = [], latch = createStopLatch(), custody = createOwnedCustody(); let time = 1000, pid = 5000;
    const launch = (bin, args, options) => {
        const child = new EventEmitter(); child.pid = ++pid; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.writes = [];
        if (options.stdio?.[0] === 'pipe') { child.stdin = new EventEmitter(); child.stdin.end = value => { child.writes.push(Buffer.from(value)); }; }
        const entry = { bin, args, options, child }; log.push(entry);
        queueMicrotask(() => {
            const route = routes.find(row => row.match(bin, args, options, entry));
            const reply = route ? route.reply({ bin, args, options, child, input: Buffer.concat(child.writes) }) : { code: 127, stderr: 'no-route' };
            if (reply.stdout !== undefined) child.stdout.emit('data', Buffer.from(reply.stdout));
            if (reply.stderr !== undefined) child.stderr.emit('data', Buffer.from(reply.stderr));
            for (const stream of [child.stdout, child.stderr]) { stream.emit('end'); stream.emit('close'); }
            child.emit('close', reply.code ?? 0, null);
        });
        return child;
    };
    const deps = { launch, latch, custody, runId: 'run_codex', now: () => time, delay: async ms => { time += ms; await new Promise(resolve => setImmediate(resolve)); } };
    return { log, deps, latch, custody, routes };
}
export const byArgs = (...needles) => (_bin, args) => needles.every(needle => args.includes(needle));
