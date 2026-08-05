import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    acquireSpawnedRouterProcessRecord,
    launchManagedWatchdog,
    reinstallAgent,
    startWorkspace,
    stopRouterForReplacement,
} from '../../cli/commands/workspaceUtil.js';
import {
    readRouterProcessRecord,
    terminateRouterFromProcessRecord,
    writeRouterProcessRecord,
} from '../../cli/commands/sessionControl.js';

const WORKSPACE_ROOT = '/exact/workspace';
const PID_FILE = '/exact/workspace/.ploinky/running/router.pid';
const RECORD = Object.freeze({
    schema: 1,
    pid: 43210,
    processIdentity: 'linux-proc:123e4567-e89b-12d3-a456-426614174000:9876',
    processUid: typeof process.getuid === 'function' ? process.getuid() : 501,
    workspaceRoot: WORKSPACE_ROOT,
});

function fakeChild(events) {
    return {
        pid: RECORD.pid,
        exitCode: null,
        signalCode: null,
        unref() { events.push('unref'); },
        kill(signal) {
            events.push(`handle:${signal}`);
            this.signalCode = signal;
            return true;
        },
    };
}

async function spawnLiveChild() {
    const child = spawn(process.execPath, ['-e', [
        "process.on('SIGTERM', () => process.exit(0));",
        "process.stdout.write('ready\\n');",
        'setInterval(() => {}, 1000);',
    ].join('')], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`process ${child.pid} did not become ready`)), 5000);
        child.stdout.setEncoding('utf8');
        child.stdout.once('data', () => {
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
    try { process.kill(child.pid, 'SIGKILL'); } catch (_) { }
    try { await waitForExit(child); } catch (_) { }
}

test('Watchdog launch retries bounded exact identity acquisition before publication', async () => {
    const child = { pid: RECORD.pid, exitCode: null, signalCode: null };
    let attempts = 0;
    const delays = [];
    const record = await acquireSpawnedRouterProcessRecord(child, {
        workspaceRoot: WORKSPACE_ROOT,
        timeoutMs: 100,
        retryMs: 10,
        createRecord() {
            attempts += 1;
            if (attempts < 3) {
                const error = new Error('not inspectable yet');
                error.code = 'PLOINKY_ROUTER_OWNER_IDENTITY_UNVERIFIED';
                throw error;
            }
            return RECORD;
        },
        now: (() => {
            let value = 0;
            return () => value++ * 10;
        })(),
        async delay(milliseconds) { delays.push(milliseconds); },
    });

    assert.equal(record, RECORD);
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [10, 10]);
});

test('Watchdog publication failure terminates only the immutable just-spawned owner before surfacing failure', async () => {
    const events = [];
    const child = fakeChild(events);
    const publicationFailure = new Error('publish EEXIST');
    publicationFailure.code = 'PLOINKY_ROUTER_OWNER_SLOT_BUSY';

    await assert.rejects(
        () => launchManagedWatchdog({
            routerPath: '/exact/Watchdog.js',
            port: 8080,
            routerPidFile: PID_FILE,
            label: 'test-publish',
        }, {
            workspaceRoot: WORKSPACE_ROOT,
            spawnWatchdogImpl() {
                events.push('spawn');
                return child;
            },
            async acquireRecord(actualChild) {
                assert.equal(actualChild, child);
                events.push('identity');
                return RECORD;
            },
            publishRecord(pidFile, record, workspaceRoot) {
                assert.deepEqual({ pidFile, record, workspaceRoot }, {
                    pidFile: PID_FILE,
                    record: RECORD,
                    workspaceRoot: WORKSPACE_ROOT,
                });
                events.push('publish');
                throw publicationFailure;
            },
            terminateExact(record) {
                assert.equal(record, RECORD);
                events.push('terminate-exact');
                return { stopped: true, pid: record.pid, signal: 'SIGTERM' };
            },
            async waitForReady() {
                events.push('readiness');
            },
        }),
        (error) => error === publicationFailure,
    );

    assert.deepEqual(events, ['spawn', 'identity', 'publish', 'terminate-exact']);
});

test('Watchdog readiness failure exact-terminates the published record and leaves no orphan', async () => {
    const events = [];
    const child = fakeChild(events);
    const readinessFailure = new Error('health socket never became ready');
    readinessFailure.code = 'PLOINKY_ROUTER_NOT_READY';

    await assert.rejects(
        () => launchManagedWatchdog({
            routerPath: '/exact/Watchdog.js',
            port: 8080,
            routerPidFile: PID_FILE,
            label: 'test-readiness',
        }, {
            workspaceRoot: WORKSPACE_ROOT,
            spawnWatchdogImpl() {
                events.push('spawn');
                return child;
            },
            async acquireRecord() {
                events.push('identity');
                return RECORD;
            },
            publishRecord() { events.push('publish'); },
            async waitForReady() {
                events.push('readiness');
                throw readinessFailure;
            },
            terminateRecorded(pidFile, workspaceRoot, record) {
                assert.equal(pidFile, PID_FILE);
                assert.equal(workspaceRoot, WORKSPACE_ROOT);
                assert.equal(record, RECORD);
                events.push('terminate-recorded');
                return { stopped: true, pid: RECORD.pid, signal: 'SIGTERM' };
            },
        }),
        (error) => error === readinessFailure,
    );

    assert.deepEqual(events, [
        'spawn',
        'identity',
        'publish',
        'unref',
        'readiness',
        'terminate-recorded',
    ]);
});

test('Watchdog readiness cleanup kills only its immutable launched owner after a successor replaces router.pid', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-launch-successor-'));
    const pidFile = path.join(temporaryRoot, 'router.pid');
    const launched = await spawnLiveChild();
    const successor = await spawnLiveChild();
    const readinessFailure = new Error('injected readiness failure after successor publication');
    readinessFailure.code = 'PLOINKY_ROUTER_NOT_READY';
    let successorRecord = null;
    try {
        await assert.rejects(
            () => launchManagedWatchdog({
                routerPath: '/exact/Watchdog.js',
                port: 8080,
                routerPidFile: pidFile,
                label: 'test-successor-race',
            }, {
                workspaceRoot: temporaryRoot,
                spawnWatchdogImpl: () => launched,
                async waitForReady() {
                    fs.unlinkSync(pidFile);
                    successorRecord = writeRouterProcessRecord(pidFile, successor.pid, temporaryRoot);
                    throw readinessFailure;
                },
            }),
            (error) => error === readinessFailure,
        );
        await waitForExit(launched);

        assert.equal(process.kill(successor.pid, 0), true);
        assert.deepEqual(readRouterProcessRecord(pidFile, temporaryRoot), successorRecord);

        const successorStop = terminateRouterFromProcessRecord(pidFile, temporaryRoot, { timeout: 2000 });
        assert.equal(successorStop.stopped, true);
        await waitForExit(successor);
        assert.equal(fs.existsSync(pidFile), false);
    } finally {
        await cleanupChild(launched);
        await cleanupChild(successor);
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('live exact Router replacement proceeds only after exact stop succeeds', () => {
    const result = stopRouterForReplacement(() => ({
        stopped: true,
        pid: 43210,
        signal: 'SIGTERM',
    }), 'start');
    assert.deepEqual(result, { stopped: true, pid: 43210, signal: 'SIGTERM' });
});

test('Router replacement refuses owner-unverified, signal-failed, timeout, and invalid results', () => {
    for (const result of [
        { stopped: false, reason: 'ownership-unverified', error: new Error('corrupt record') },
        { stopped: false, reason: 'term-signal-failed' },
        { stopped: false, reason: 'kill-timeout' },
        undefined,
    ]) {
        assert.throws(
            () => stopRouterForReplacement(() => result, 'start'),
            (error) => error?.code === 'PLOINKY_ROUTER_REPLACEMENT_REFUSED',
        );
    }
});

test('workspace start and reinstall both use the canonical transactional Watchdog launcher', () => {
    const startSource = startWorkspace.toString();
    const reinstallSource = reinstallAgent.toString();
    const launchSource = launchManagedWatchdog.toString();

    assert.match(startSource, /stopRouterForReplacement\(killRouterIfRunning, 'start'\)/);
    assert.match(startSource, /await launchManagedWatchdogImpl\(\{[\s\S]*?label: 'start'/);
    assert.match(reinstallSource, /stopRouterForReplacement\(killRouterIfRunningImpl, 'reinstall'\)/);
    assert.match(reinstallSource, /await launchManagedWatchdogImpl\(\{[\s\S]*?label: 'reinstall'/);
    assert.doesNotMatch(`${startSource}\n${reinstallSource}`, /writeFileSync\(routerPidFile/);

    const publishIndex = launchSource.indexOf('publishRecord(routerPidFile, record, workspaceRoot)');
    const unrefIndex = launchSource.indexOf('child.unref()');
    const readinessIndex = launchSource.indexOf('await waitForReady(port, child)');
    assert.ok(publishIndex >= 0 && publishIndex < unrefIndex);
    assert.ok(unrefIndex < readinessIndex);
    assert.match(
        launchSource,
        /terminateRecorded\(routerPidFile, workspaceRoot, record\)/,
    );
    assert.doesNotMatch(launchSource, /terminatePublished|terminateRouterFromProcessRecord/);
});
