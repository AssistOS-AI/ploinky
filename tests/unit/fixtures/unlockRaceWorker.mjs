// One process of the `ploinky unlock` race tests (ploinkyBoxUnlockConcurrency):
//   unlock     runs the real unlockWorkspace;
//   reclaimer  acquires the workspace lock like any command, holds it briefly
//              and releases it (release fails if anyone removed it);
//   hold       runs unlockWorkspace and blocks inside the store lock step,
//              holding the unlock lock and the workspace lock, until killed.
// All use the real lock manager and liveness over a probed filesystem. At the
// moment it happens, the probe records a second holder of the workspace lock,
// of its reclaim guard or of the unlock lock (an exclusive marker file per
// lock), and a reclaim guard that was removed or replaced while its creator
// held it. Each process waits for one byte on stdin, so all start together.
// No worker outlives its test: each exits by itself when its stdin closes
// (the test runner died), when its parent changes, or after WORKER_LIMIT_MS.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { buildWorkspaceIdentity } from '../../../ploinky-box/identity.mjs';
import { createMutationLockManager } from '../../../ploinky-box/locks.mjs';
import { unlockWorkspace } from '../../../ploinky-box/unlock.mjs';

const [role, workspace, markers] = process.argv.slice(2);
const WORKER_LIMIT_MS = 60_000;
const parentPid = process.ppid;
setTimeout(() => process.exit(70), WORKER_LIMIT_MS).unref();
const GUARD_NAME = 'workspace.lock.reclaim';
const violations = [];
const heldGuards = new Map();

function claim(name) {
    const marker = path.join(markers, name);
    try {
        fs.writeFileSync(marker, String(process.pid), { flag: 'wx' });
    } catch (error) {
        let other = '?';
        try { other = fs.readFileSync(marker, 'utf8'); } catch {}
        violations.push(`two holders of the ${name}: ${process.pid} and ${other} (${error.code})`);
    }
}

function unclaim(name) {
    const marker = path.join(markers, name);
    try {
        if (fs.readFileSync(marker, 'utf8') === String(process.pid)) fs.unlinkSync(marker);
    } catch {}
}

const probedFs = {
    ...fs,
    mkdirSync(target, options) {
        const result = fs.mkdirSync(target, options);
        if (path.basename(String(target)) === GUARD_NAME) {
            heldGuards.set(String(target), fs.lstatSync(target).ino);
            claim('guard');
        }
        return result;
    },
    rmdirSync(target) {
        const key = String(target);
        if (heldGuards.has(key)) {
            let ino = null;
            try { ino = fs.lstatSync(key).ino; } catch {}
            if (ino !== heldGuards.get(key)) {
                violations.push(`the guard ${process.pid} held was removed or replaced (inode ${heldGuards.get(key)} -> ${ino})`);
            }
            heldGuards.delete(key);
            unclaim('guard');
        }
        return fs.rmdirSync(target);
    },
};

const real = createMutationLockManager({ fsApi: probedFs, retryMs: 2, timeoutMs: 20_000 });
const marked = (handle, name) => ({ ...handle, release() { unclaim(name); handle.release(); } });
const lockManager = {
    ...real,
    async acquire(...args) {
        const handle = await real.acquire(...args);
        claim('workspace lock');
        return marked(handle, 'workspace lock');
    },
    async acquireAt(...args) {
        const handle = await real.acquireAt(...args);
        claim('unlock lock');
        return marked(handle, 'unlock lock');
    },
};

const identity = buildWorkspaceIdentity(workspace);
// The hold worker blocks the event loop inside the store lock step, so it
// checks for its parent and its own limit while it waits.
function blockUntilParentGone() {
    const cell = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + WORKER_LIMIT_MS;
    while (process.ppid === parentPid && Date.now() < deadline) Atomics.wait(cell, 0, 0, 100);
    process.exit(71);
}

const observeBoxState = role === 'hold'
    ? () => {
        // Written synchronously: the event loop is blocked from here on.
        fs.writeSync(1, 'inside\n');
        blockUntilParentGone();
    }
    : () => ({ state: 'absent' });

fs.writeSync(1, 'ready\n');
await new Promise((resolve) => {
    process.stdin.once('data', resolve);
    process.stdin.once('end', () => process.exit(72));
});

const started = Date.now();
let result = null;
let error = null;
try {
    if (role === 'reclaimer') {
        const lock = await lockManager.acquire(identity.instance, { workspaceRoot: identity.workspaceRoot });
        await delay(5);
        lock.release();
        result = { acquired: true };
    } else {
        const report = await unlockWorkspace({ identity, lockManager, observeBoxState, fsApi: fs });
        result = {
            exitCode: report.exitCode,
            items: report.items.map((entry) => ({
                kind: entry.kind, state: entry.state, reason: entry.reason ?? null, holderPid: entry.holder?.pid ?? null,
            })),
        };
    }
} catch (caught) {
    error = { code: caught?.code ?? null, message: String(caught?.message ?? caught) };
}
const finished = Date.now();
fs.writeSync(1, `${JSON.stringify({ role, pid: process.pid, started, finished, result, violations, error })}\n`);
// stdin stays open to notice a dead parent, so the exit is explicit.
process.exit(0);
