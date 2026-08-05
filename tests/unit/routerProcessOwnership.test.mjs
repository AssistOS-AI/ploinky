import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    createRouterProcessRecord,
    readRouterProcessRecord,
    terminateRouterFromProcessRecord,
    writeRouterProcessRecord,
} from '../../cli/commands/sessionControl.js';
import { inspectProcessIdentity } from '../../cli/sandbox/processIdentity.js';

function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

async function spawnLiveChild({ ignoreTerm = false } = {}) {
    const termHandler = ignoreTerm ? '() => {}' : '() => process.exit(0)';
    const source = [
        `process.on('SIGTERM', ${termHandler});`,
        "process.stdout.write('ready\\n');",
        'setInterval(() => {}, 1000);',
    ].join('');
    const child = spawn(process.execPath, ['-e', source], {
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error(`process ${child.pid} did not become ready`)), 5000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            output += chunk;
            if (!output.includes('ready\n')) return;
            clearTimeout(timer);
            resolve();
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            reject(new Error(`process ${child.pid} exited before ready (${code ?? signal})`));
        });
    });
    return child;
}

async function waitForIdentifiedProcess(pid) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const inspection = inspectProcessIdentity(pid);
        if (inspection.state === 'identified') return inspection;
        if (inspection.state === 'dead') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`process ${pid} did not acquire an inspectable identity`);
}

async function waitForExit(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`process ${child.pid} did not exit`)), 5000);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

async function cleanupChild(child) {
    if (processIsAlive(child.pid)) {
        try { process.kill(child.pid, 'SIGKILL'); } catch (_) { }
    }
    try { await waitForExit(child); } catch (_) { }
}

function canonicalPayload(record) {
    return `${JSON.stringify(record)}\n`;
}

function publishRecordDirect(pidFile, record) {
    const temporaryFile = `${pidFile}.test-${crypto.randomBytes(8).toString('hex')}.tmp`;
    fs.writeFileSync(temporaryFile, canonicalPayload(record), { mode: 0o600, flag: 'wx' });
    try {
        fs.linkSync(temporaryFile, pidFile);
    } finally {
        fs.unlinkSync(temporaryFile);
    }
}

function operationPaths(pidFile, record) {
    const operationId = crypto.createHash('sha256')
        .update(canonicalPayload(record))
        .digest('hex')
        .slice(0, 32);
    const base = `${pidFile}.operation-${operationId}`;
    return { claim: `${base}.claim`, quarantine: `${base}.quarantine` };
}

test('Router record reader rejects symlink, mode, link-count, noncanonical, and PID-only records', async (t) => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-owner-invalid-'));
    const child = await spawnLiveChild();
    try {
        const record = createRouterProcessRecord(child.pid, temporaryRoot);
        const cases = [
            {
                name: 'symlink',
                setup(pidFile) {
                    const target = `${pidFile}.target`;
                    fs.writeFileSync(target, canonicalPayload(record), { mode: 0o600 });
                    fs.symlinkSync(target, pidFile);
                },
                pattern: /must not be a symlink/,
            },
            {
                name: 'mode',
                setup(pidFile) {
                    fs.writeFileSync(pidFile, canonicalPayload(record), { mode: 0o600 });
                    fs.chmodSync(pidFile, 0o640);
                },
                pattern: /exact private bounded record/,
            },
            {
                name: 'link-count',
                setup(pidFile) {
                    fs.writeFileSync(pidFile, canonicalPayload(record), { mode: 0o600 });
                    fs.linkSync(pidFile, `${pidFile}.extra-link`);
                },
                pattern: /exact private bounded record/,
            },
            {
                name: 'noncanonical-json',
                setup(pidFile) {
                    const reordered = {
                        workspaceRoot: record.workspaceRoot,
                        schema: record.schema,
                        processUid: record.processUid,
                        processIdentity: record.processIdentity,
                        pid: record.pid,
                    };
                    fs.writeFileSync(pidFile, `${JSON.stringify(reordered)}\n`, { mode: 0o600 });
                },
                pattern: /not exact canonical JSON/,
            },
            {
                name: 'legacy-pid-only',
                setup(pidFile) {
                    fs.writeFileSync(pidFile, `${record.pid}\n`, { mode: 0o600 });
                },
                pattern: /plain object/,
            },
        ];

        for (const entry of cases) {
            await t.test(entry.name, () => {
                const caseRoot = fs.mkdtempSync(path.join(temporaryRoot, `${entry.name}-`));
                const pidFile = path.join(caseRoot, 'router.pid');
                entry.setup(pidFile);
                assert.throws(
                    () => readRouterProcessRecord(pidFile, temporaryRoot),
                    entry.pattern,
                );
                assert.equal(processIsAlive(child.pid), true, `${entry.name} must not authorize a signal`);
            });
        }
    } finally {
        await cleanupChild(child);
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('Router publication fails EEXIST without overwriting a concurrent successor', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-owner-eexist-'));
    const pidFile = path.join(temporaryRoot, 'router.pid');
    const candidate = await spawnLiveChild();
    const successor = await spawnLiveChild();
    try {
        const successorRecord = createRouterProcessRecord(successor.pid, temporaryRoot);
        assert.throws(
            () => writeRouterProcessRecord(pidFile, candidate.pid, temporaryRoot, {
                beforePublish: () => publishRecordDirect(pidFile, successorRecord),
            }),
            (error) => error?.code === 'PLOINKY_ROUTER_OWNER_SLOT_BUSY',
        );
        assert.deepEqual(readRouterProcessRecord(pidFile, temporaryRoot), successorRecord);
        assert.equal(processIsAlive(candidate.pid), true);
        assert.equal(processIsAlive(successor.pid), true);
    } finally {
        await cleanupChild(candidate);
        await cleanupChild(successor);
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('Router exact removal never touches a successor published after the atomic rename', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-owner-successor-'));
    const pidFile = path.join(temporaryRoot, 'router.pid');
    const owner = await spawnLiveChild();
    const successor = await spawnLiveChild();
    try {
        writeRouterProcessRecord(pidFile, owner.pid, temporaryRoot);
        const successorRecord = createRouterProcessRecord(successor.pid, temporaryRoot);

        const result = terminateRouterFromProcessRecord(pidFile, temporaryRoot, {
            timeout: 2000,
            afterPrimaryRelease: () => publishRecordDirect(pidFile, successorRecord),
        });
        await waitForExit(owner);

        assert.deepEqual(result, { stopped: true, pid: owner.pid, signal: 'SIGTERM' });
        assert.deepEqual(readRouterProcessRecord(pidFile, temporaryRoot), successorRecord);
        assert.equal(processIsAlive(successor.pid), true);
        assert.deepEqual(
            fs.readdirSync(temporaryRoot).filter((name) => name.includes('.operation-')),
            [],
        );
    } finally {
        await cleanupChild(owner);
        await cleanupChild(successor);
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('Router exact removal restores a successor that replaces the canonical slot immediately before rename', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-owner-pre-rename-'));
    const pidFile = path.join(temporaryRoot, 'router.pid');
    const owner = await spawnLiveChild();
    const successor = await spawnLiveChild();
    try {
        writeRouterProcessRecord(pidFile, owner.pid, temporaryRoot);
        const successorRecord = createRouterProcessRecord(successor.pid, temporaryRoot);

        const result = terminateRouterFromProcessRecord(pidFile, temporaryRoot, {
            timeout: 2000,
            beforePrimaryRelease: () => {
                fs.unlinkSync(pidFile);
                publishRecordDirect(pidFile, successorRecord);
            },
        });
        await waitForExit(owner);

        assert.deepEqual(result, { stopped: true, pid: owner.pid, signal: 'SIGTERM' });
        assert.deepEqual(readRouterProcessRecord(pidFile, temporaryRoot), successorRecord);
        assert.equal(processIsAlive(successor.pid), true);
        assert.deepEqual(
            fs.readdirSync(temporaryRoot).filter((name) => name.includes('.operation-')),
            [],
        );

        const successorStop = terminateRouterFromProcessRecord(pidFile, temporaryRoot, { timeout: 2000 });
        await waitForExit(successor);
        assert.deepEqual(successorStop, {
            stopped: true,
            pid: successor.pid,
            signal: 'SIGTERM',
        });
        assert.equal(fs.existsSync(pidFile), false);
    } finally {
        await cleanupChild(owner);
        await cleanupChild(successor);
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('Router exact removal preserves a displaced owner without touching a newer canonical successor', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-owner-double-successor-'));
    const pidFile = path.join(temporaryRoot, 'router.pid');
    const owner = await spawnLiveChild();
    const displaced = await spawnLiveChild();
    const canonical = await spawnLiveChild();
    try {
        writeRouterProcessRecord(pidFile, owner.pid, temporaryRoot);
        const displacedRecord = createRouterProcessRecord(displaced.pid, temporaryRoot);
        const canonicalRecord = createRouterProcessRecord(canonical.pid, temporaryRoot);

        assert.throws(
            () => terminateRouterFromProcessRecord(pidFile, temporaryRoot, {
                timeout: 2000,
                beforePrimaryRelease: () => {
                    fs.unlinkSync(pidFile);
                    publishRecordDirect(pidFile, displacedRecord);
                },
                afterPrimaryRelease: () => publishRecordDirect(pidFile, canonicalRecord),
            }),
            (error) => error?.code === 'PLOINKY_ROUTER_OWNER_SLOT_BUSY',
        );
        await waitForExit(owner);

        assert.deepEqual(readRouterProcessRecord(pidFile, temporaryRoot), canonicalRecord);
        assert.equal(processIsAlive(displaced.pid), true);
        assert.equal(processIsAlive(canonical.pid), true);
        const artifacts = fs.readdirSync(temporaryRoot)
            .filter((name) => name.includes('.operation-'));
        assert.equal(artifacts.length, 1);
        assert.match(artifacts[0], /\.quarantine$/);
        assert.equal(
            fs.readFileSync(path.join(temporaryRoot, artifacts[0]), 'utf8'),
            canonicalPayload(displacedRecord),
        );

        process.kill(displaced.pid, 'SIGKILL');
        await waitForExit(displaced);
        const canonicalStop = terminateRouterFromProcessRecord(pidFile, temporaryRoot, { timeout: 2000 });
        await waitForExit(canonical);
        assert.deepEqual(canonicalStop, {
            stopped: true,
            pid: canonical.pid,
            signal: 'SIGTERM',
        });
        assert.deepEqual(
            fs.readdirSync(temporaryRoot).filter((name) => name.includes('.operation-')),
            [],
        );
    } finally {
        await cleanupChild(owner);
        await cleanupChild(displaced);
        await cleanupChild(canonical);
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('Router store recovers a dead interrupted quarantine before publishing a new owner', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-owner-recover-dead-'));
    const pidFile = path.join(temporaryRoot, 'router.pid');
    const oldOwner = await spawnLiveChild();
    const successor = await spawnLiveChild();
    try {
        const oldRecord = writeRouterProcessRecord(pidFile, oldOwner.pid, temporaryRoot);
        const operation = operationPaths(pidFile, oldRecord);
        fs.linkSync(pidFile, operation.claim);
        fs.renameSync(pidFile, operation.quarantine);
        process.kill(oldOwner.pid, 'SIGKILL');
        await waitForExit(oldOwner);

        const successorRecord = writeRouterProcessRecord(pidFile, successor.pid, temporaryRoot);

        assert.deepEqual(readRouterProcessRecord(pidFile, temporaryRoot), successorRecord);
        assert.equal(fs.existsSync(operation.claim), false);
        assert.equal(fs.existsSync(operation.quarantine), false);
    } finally {
        await cleanupChild(oldOwner);
        await cleanupChild(successor);
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('Router store refuses interrupted quarantine recovery while its exact owner is live', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-owner-recover-live-'));
    const pidFile = path.join(temporaryRoot, 'router.pid');
    const oldOwner = await spawnLiveChild();
    const candidate = await spawnLiveChild();
    try {
        const oldRecord = writeRouterProcessRecord(pidFile, oldOwner.pid, temporaryRoot);
        const operation = operationPaths(pidFile, oldRecord);
        fs.linkSync(pidFile, operation.claim);
        fs.renameSync(pidFile, operation.quarantine);

        assert.throws(
            () => writeRouterProcessRecord(pidFile, candidate.pid, temporaryRoot),
            (error) => error?.code === 'PLOINKY_ROUTER_OWNER_SLOT_BUSY',
        );
        assert.equal(fs.existsSync(pidFile), false);
        assert.equal(fs.existsSync(operation.claim), true);
        assert.equal(fs.existsSync(operation.quarantine), true);
        assert.equal(processIsAlive(oldOwner.pid), true);
        assert.equal(processIsAlive(candidate.pid), true);
    } finally {
        await cleanupChild(oldOwner);
        await cleanupChild(candidate);
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('Router termination clears a PID-reuse-shaped stale record without signaling the unrelated process', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-owner-reused-'));
    const pidFile = path.join(temporaryRoot, 'router.pid');
    const unrelated = await spawnLiveChild();
    try {
        const unrelatedIdentity = await waitForIdentifiedProcess(unrelated.pid);
        const staleIdentity = await waitForIdentifiedProcess(1);
        assert.notEqual(staleIdentity.processIdentity, unrelatedIdentity.processIdentity);
        const staleRecord = createRouterProcessRecord(unrelated.pid, temporaryRoot, {
            inspectIdentity: () => ({
                state: 'identified',
                processIdentity: staleIdentity.processIdentity,
                processUid: unrelatedIdentity.processUid,
            }),
        });
        publishRecordDirect(pidFile, staleRecord);

        const result = terminateRouterFromProcessRecord(pidFile, temporaryRoot);

        assert.deepEqual(result, { stopped: false, reason: 'stale-record', pid: unrelated.pid });
        assert.equal(processIsAlive(unrelated.pid), true);
        assert.equal(fs.existsSync(pidFile), false);
    } finally {
        await cleanupChild(unrelated);
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('Router termination sends TERM, waits for exact exit, and clears only the recorded owner', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-owner-term-'));
    const pidFile = path.join(temporaryRoot, 'router.pid');
    const owner = await spawnLiveChild();
    try {
        writeRouterProcessRecord(pidFile, owner.pid, temporaryRoot);

        const result = terminateRouterFromProcessRecord(pidFile, temporaryRoot, { timeout: 2000 });
        await waitForExit(owner);

        assert.deepEqual(result, { stopped: true, pid: owner.pid, signal: 'SIGTERM' });
        assert.equal(fs.existsSync(pidFile), false);
    } finally {
        await cleanupChild(owner);
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('Router termination reverifies the exact owner before KILL escalation', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-owner-kill-'));
    const pidFile = path.join(temporaryRoot, 'router.pid');
    const owner = await spawnLiveChild({ ignoreTerm: true });
    try {
        writeRouterProcessRecord(pidFile, owner.pid, temporaryRoot);

        const result = terminateRouterFromProcessRecord(pidFile, temporaryRoot, {
            timeout: 25,
            killTimeout: 2000,
        });
        await waitForExit(owner);

        assert.deepEqual(result, { stopped: true, pid: owner.pid, signal: 'SIGKILL' });
        assert.equal(fs.existsSync(pidFile), false);
    } finally {
        await cleanupChild(owner);
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});
