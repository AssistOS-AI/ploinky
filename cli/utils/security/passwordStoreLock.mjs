import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

// Router and CLI writes may originate in different PID namespaces. Never infer
// that an owner is dead from a PID probe in this process's namespace.
export function withPasswordStoreLock(passwordStoreFile, callback, { waitMs = 5000 } = {}) {
    const lockPath = `${passwordStoreFile}.lock`;
    const token = crypto.randomUUID();
    const deadline = Date.now() + waitMs;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let descriptor;
    while (descriptor === undefined) {
        try {
            descriptor = fs.openSync(lockPath, 'wx', 0o600);
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            if (Date.now() >= deadline) {
                const busy = new Error('Encrypted password store mutation is busy; retry or inspect its lock after confirming all writers have stopped.');
                busy.code = 'PLOINKY_PASSWORD_STORE_BUSY';
                throw busy;
            }
            Atomics.wait(sleepBuffer, 0, 0, Math.min(10, deadline - Date.now()));
        }
    }
    const held = fs.fstatSync(descriptor);
    try {
        fs.writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid }));
        return callback();
    } finally {
        try {
            // Keep the descriptor open until unlink so its inode cannot be
            // reused for another acquisition while release checks its identity.
            const current = fs.lstatSync(lockPath);
            if (current.dev !== held.dev || current.ino !== held.ino || !current.isFile()) {
                throw new Error('Encrypted password store lock changed before release.');
            }
            fs.unlinkSync(lockPath);
        } finally {
            fs.closeSync(descriptor);
        }
    }
}
