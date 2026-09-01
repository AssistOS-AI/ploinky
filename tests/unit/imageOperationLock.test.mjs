import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    acquireImageOperationLock,
    imageOperationLockOwnerIsAlive,
    withImageOperationLock,
} from '../../cli/utils/runtime/imageOperationLock.js';
import { ensureImagePresent } from '../../cli/sandbox/docker/common.js';

const temporaryRoots = [];
const lockModuleUrl = new URL('../../cli/utils/runtime/imageOperationLock.js', import.meta.url).href;
const commonModuleUrl = new URL('../../cli/sandbox/docker/common.js', import.meta.url).href;
const agentlibContractUrl = new URL('../helpers/agentlibTestContract.mjs', import.meta.url).href;

function temporaryWorkspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-image-operation-lock-'));
    temporaryRoots.push(root);
    fs.mkdirSync(path.join(root, '.ploinky', 'running'), { recursive: true, mode: 0o700 });
    return {
        root,
        lockPath: path.join(root, '.ploinky', 'running', 'image-operations', 'exclusive.lock'),
    };
}

function childResult(child) {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
}

async function waitForFile(target, pattern, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const contents = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
        if (pattern.test(contents)) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${pattern} in ${target}`);
}

afterEach(() => {
    while (temporaryRoots.length) {
        fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true });
    }
});

test('a live image operation owner excludes a peer until the bounded wait expires', () => {
    const { root, lockPath } = temporaryWorkspace();
    const first = acquireImageOperationLock({ trustedRoot: root, ownerId: 'first-owner' });
    let nowMs = 1_000;

    assert.throws(
        () => acquireImageOperationLock({
            trustedRoot: root,
            ownerId: 'second-owner',
            waitMs: 25,
            pollMs: 10,
            now: () => nowMs,
            sleep: delayMs => { nowMs += delayMs; },
            isOwnerAlive: () => true,
        }),
        error => error?.code === 'PLOINKY_IMAGE_OPERATION_BUSY' && /pid/.test(error.message),
    );

    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).ownerId, 'first-owner');
    first.release();
    assert.equal(fs.existsSync(lockPath), false);
});

test('a dead owner is reclaimed without allowing the old owner to delete its successor', () => {
    const { root, lockPath } = temporaryWorkspace();
    const first = acquireImageOperationLock({
        trustedRoot: root,
        ownerId: 'stale-owner',
        ownerPid: 100,
        processStartTime: 'old-start',
        bootId: 'old-boot',
        now: () => 0,
    });
    const second = acquireImageOperationLock({
        trustedRoot: root,
        ownerId: 'successor-owner',
        ownerPid: 200,
        now: () => 1,
        isOwnerAlive: () => false,
    });

    first.release();
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).ownerId, 'successor-owner');
    second.release();
    assert.equal(fs.existsSync(lockPath), false);
});

test('owner identity detects PID reuse and Box reboot while retaining a matching process', () => {
    const record = {
        pid: 42,
        processStartTime: '100',
        bootId: 'boot-a',
    };
    const base = { processAliveImpl: () => true };

    assert.equal(imageOperationLockOwnerIsAlive(record, {
        ...base,
        readProcessStartTime: () => '101',
        readBootId: () => 'boot-a',
    }), false);
    assert.equal(imageOperationLockOwnerIsAlive(record, {
        ...base,
        readProcessStartTime: () => '100',
        readBootId: () => 'boot-b',
    }), false);
    assert.equal(imageOperationLockOwnerIsAlive(record, {
        ...base,
        readProcessStartTime: () => '100',
        readBootId: () => 'boot-a',
    }), true);
});

test('malformed lock records receive a grace period and are then reclaimed', () => {
    const { root, lockPath } = temporaryWorkspace();
    fs.mkdirSync(path.dirname(lockPath), { mode: 0o700 });
    fs.writeFileSync(lockPath, '{', { mode: 0o600 });
    fs.utimesSync(lockPath, new Date(0), new Date(0));

    assert.throws(
        () => acquireImageOperationLock({
            trustedRoot: root,
            waitMs: 0,
            now: () => 1_000,
        }),
        error => error?.code === 'PLOINKY_IMAGE_OPERATION_BUSY',
    );
    const lock = acquireImageOperationLock({
        trustedRoot: root,
        ownerId: 'reclaimer',
        now: () => 31_000,
    });
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).ownerId, 'reclaimer');
    lock.release();
});

test('lock acquisition rejects symlinked producer paths and alternate lock files', () => {
    const { root } = temporaryWorkspace();
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-image-operation-foreign-'));
    temporaryRoots.push(foreign);
    fs.rmSync(path.join(root, '.ploinky', 'running'), { recursive: true });
    fs.symlinkSync(foreign, path.join(root, '.ploinky', 'running'), 'dir');

    assert.throws(
        () => acquireImageOperationLock({ trustedRoot: root }),
        error => error?.code === 'VERIFIED_FILE_INVALID' && /producer/.test(error.message),
    );

    fs.unlinkSync(path.join(root, '.ploinky', 'running'));
    fs.mkdirSync(path.join(root, '.ploinky', 'running'), { mode: 0o700 });
    assert.throws(
        () => acquireImageOperationLock({
            trustedRoot: root,
            lockPath: path.join(root, '.ploinky', 'running', 'different.lock'),
        }),
        error => error?.code === 'VERIFIED_FILE_INVALID' && /workspace-owned path/.test(error.message),
    );

    const lockPath = path.join(root, '.ploinky', 'running', 'image-operations', 'exclusive.lock');
    const foreignLock = path.join(foreign, 'foreign.lock');
    fs.writeFileSync(foreignLock, '{}');
    fs.symlinkSync(foreignLock, lockPath);
    assert.throws(
        () => acquireImageOperationLock({ trustedRoot: root }),
        error => error?.code === 'PLOINKY_IMAGE_OPERATION_LOCK_INVALID',
    );
});

test('withImageOperationLock releases ownership after synchronous and asynchronous failures', async () => {
    const { root, lockPath } = temporaryWorkspace();
    assert.throws(
        () => withImageOperationLock(() => { throw new Error('sync failure'); }, { trustedRoot: root }),
        /sync failure/,
    );
    assert.equal(fs.existsSync(lockPath), false);

    await assert.rejects(
        withImageOperationLock(async () => { throw new Error('async failure'); }, { trustedRoot: root }),
        /async failure/,
    );
    assert.equal(fs.existsSync(lockPath), false);
});

test('real Node processes enter the image operation critical section one at a time', async () => {
    const { root } = temporaryWorkspace();
    const eventsFile = path.join(root, 'events.log');
    const script = String.raw`
        import fs from 'node:fs';
        const { acquireImageOperationLock } = await import(process.env.LOCK_MODULE_URL);
        const lock = acquireImageOperationLock({
            trustedRoot: process.env.TEST_WORKSPACE_ROOT,
            waitMs: 2_000,
            pollMs: 10,
        });
        fs.appendFileSync(process.env.EVENTS_FILE, process.env.CHILD_ID + ':enter\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.HOLD_MS));
        fs.appendFileSync(process.env.EVENTS_FILE, process.env.CHILD_ID + ':exit\n');
        lock.release();
    `;
    const spawnChild = (id, holdMs) => {
        const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
            env: {
                ...process.env,
                LOCK_MODULE_URL: lockModuleUrl,
                TEST_WORKSPACE_ROOT: root,
                EVENTS_FILE: eventsFile,
                CHILD_ID: id,
                HOLD_MS: String(holdMs),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { child, result: childResult(child) };
    };

    const first = spawnChild('first', 400);
    await waitForFile(eventsFile, /first:enter/);
    const second = spawnChild('second', 0);
    const [firstResult, secondResult] = await Promise.all([first.result, second.result]);
    assert.deepEqual(firstResult, { code: 0, signal: null, stdout: '', stderr: '' });
    assert.deepEqual(secondResult, { code: 0, signal: null, stdout: '', stderr: '' });
    assert.deepEqual(fs.readFileSync(eventsFile, 'utf8').trim().split('\n'), [
        'first:enter',
        'first:exit',
        'second:enter',
        'second:exit',
    ]);
});

test('concurrent ensureImagePresent processes globally serialize distinct pulls and deduplicate one tag', async () => {
    const { root } = temporaryWorkspace();
    const fakeRuntime = path.join(root, 'fake-podman');
    const readyDirectory = path.join(root, 'ready');
    const eventsFile = path.join(root, 'pull-events.log');
    fs.mkdirSync(readyDirectory, { mode: 0o700 });
    fs.writeFileSync(fakeRuntime, String.raw`#!/bin/sh
set -eu
key_for_image() {
    printf '%s' "$1" | tr '/:' '__'
}
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
    key="$(key_for_image "$3")"
    if [ -f "$FAKE_READY_DIRECTORY/$key" ]; then
        if [ "$#" -ge 4 ] && [ "$4" = "--format" ]; then printf '1\n'; fi
        exit 0
    fi
    exit 1
fi
if [ "$1" = "pull" ]; then
    image="$2"
    key="$(key_for_image "$image")"
    printf '%s:enter\n' "$image" >> "$FAKE_EVENTS_FILE"
    sleep 0.2
    : > "$FAKE_READY_DIRECTORY/$key"
    printf '%s:exit\n' "$image" >> "$FAKE_EVENTS_FILE"
    exit 0
fi
exit 2
`, { mode: 0o700 });
    const script = String.raw`
        const { ensureImagePresent } = await import(process.env.COMMON_MODULE_URL);
        const result = ensureImagePresent(process.env.TEST_IMAGE, {
            runtime: process.env.FAKE_RUNTIME,
            pullTimeoutMs: 2_000,
            log() {},
        });
        process.stdout.write(JSON.stringify({ image: process.env.TEST_IMAGE, result }));
    `;
    const spawnEnsure = (image) => {
        const child = spawn(process.execPath, [
            '--import', agentlibContractUrl,
            '--input-type=module',
            '--eval', script,
        ], {
            env: {
                ...process.env,
                PLOINKY_WORKSPACE_ROOT: root,
                COMMON_MODULE_URL: commonModuleUrl,
                FAKE_RUNTIME: fakeRuntime,
                FAKE_READY_DIRECTORY: readyDirectory,
                FAKE_EVENTS_FILE: eventsFile,
                TEST_IMAGE: image,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return childResult(child);
    };

    const results = await Promise.all([
        spawnEnsure('demo/shared:1'),
        spawnEnsure('demo/shared:1'),
        spawnEnsure('demo/distinct:1'),
    ]);
    for (const result of results) {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.signal, null);
        assert.equal(result.stderr, '');
    }
    const values = results.map(result => JSON.parse(result.stdout));
    assert.equal(values.filter(value => value.image === 'demo/shared:1' && value.result).length, 1);
    assert.equal(values.filter(value => value.image === 'demo/shared:1' && !value.result).length, 1);
    assert.equal(values.filter(value => value.image === 'demo/distinct:1' && value.result).length, 1);

    const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
    assert.equal(events.length, 4);
    for (let index = 0; index < events.length; index += 2) {
        const entered = events[index].replace(/:enter$/, '');
        const exited = events[index + 1].replace(/:exit$/, '');
        assert.equal(entered, exited);
        assert.match(events[index], /:enter$/);
        assert.match(events[index + 1], /:exit$/);
    }
    assert.deepEqual(new Set(events.map(event => event.replace(/:(?:enter|exit)$/, ''))), new Set([
        'demo/shared:1',
        'demo/distinct:1',
    ]));
});

test('ensureImagePresent rechecks the cache after waiting and shares one pull budget', () => {
    const events = [];
    let inspectCalls = 0;
    const result = ensureImagePresent('demo/image:1', {
        runtime: 'podman',
        pullTimeoutMs: 500,
        imageExists(image, runtime) {
            events.push(['inspect', image, runtime]);
            inspectCalls += 1;
            return inspectCalls === 2;
        },
        withImageOperationLock(callback, options) {
            events.push(['lock', options.waitMs, typeof options.onWait]);
            return callback();
        },
        pullImage() {
            events.push(['pull']);
        },
        log() {},
    });

    assert.equal(result, false);
    assert.deepEqual(events, [
        ['inspect', 'demo/image:1', 'podman'],
        ['lock', 500, 'function'],
        ['inspect', 'demo/image:1', 'podman'],
    ]);
});

test('ensureImagePresent gives a pull only the budget remaining after lock wait', () => {
    const events = [];
    let nowMs = 1_000;
    const result = ensureImagePresent('demo/image:2', {
        runtime: 'podman',
        pullTimeoutMs: 100,
        now: () => nowMs,
        imageExists() {
            events.push('inspect');
            return false;
        },
        withImageOperationLock(callback, options) {
            events.push(`lock-enter:${options.waitMs}`);
            nowMs += 40;
            const value = callback();
            events.push('lock-exit');
            return value;
        },
        pullImage(image, options) {
            events.push(`pull:${image}:${options.runtime}:${options.timeoutMs}`);
        },
        log() {},
    });

    assert.equal(result, true);
    assert.deepEqual(events, [
        'inspect',
        'lock-enter:100',
        'inspect',
        'pull:demo/image:2:podman:60',
        'lock-exit',
    ]);
});

test('an exhausted lock budget starts neither a pull nor a local build', () => {
    let nowMs = 1_000;
    let pullCalls = 0;
    let buildCalls = 0;

    assert.throws(
        () => ensureImagePresent('demo/image:3', {
            runtime: 'podman',
            pullTimeoutMs: 100,
            now: () => nowMs,
            imageExists: () => false,
            withImageOperationLock(callback) {
                nowMs += 100;
                return callback();
            },
            pullImage() { pullCalls += 1; },
            resolveLocalImageBuildSource: () => ({ repoName: 'repo', context: 'image' }),
            buildLocalImage() { buildCalls += 1; },
            log() {},
        }),
        error => error?.code === 'PLOINKY_IMAGE_OPERATION_BUSY' && /budget/.test(error.message),
    );
    assert.equal(pullCalls, 0);
    assert.equal(buildCalls, 0);
});

test('local build fallback begins only after the global pull lock is released', () => {
    const events = [];
    let inLock = false;
    const result = ensureImagePresent('demo/image:4', {
        runtime: 'podman',
        imageExists() {
            events.push('inspect');
            return false;
        },
        withImageOperationLock(callback) {
            inLock = true;
            events.push('lock-enter');
            try {
                return callback();
            } finally {
                inLock = false;
                events.push('lock-exit');
            }
        },
        pullImage() {
            events.push('pull');
            throw new Error('registry unavailable');
        },
        resolveLocalImageBuildSource() {
            events.push('resolve');
            return { repoName: 'repo', context: 'image' };
        },
        buildLocalImage() {
            assert.equal(inLock, false);
            events.push('build');
        },
        log() {},
    });

    assert.equal(result, true);
    assert.deepEqual(events, [
        'inspect',
        'lock-enter',
        'inspect',
        'pull',
        'lock-exit',
        'inspect',
        'resolve',
        'build',
    ]);
});

test('lock contention cannot fall back to a local build', () => {
    let buildCalls = 0;
    const busy = new Error('busy');
    busy.code = 'PLOINKY_IMAGE_OPERATION_BUSY';

    assert.throws(
        () => ensureImagePresent('demo/image:5', {
            runtime: 'podman',
            imageExists: () => false,
            withImageOperationLock() { throw busy; },
            resolveLocalImageBuildSource: () => ({ repoName: 'repo', context: 'image' }),
            buildLocalImage() { buildCalls += 1; },
            log() {},
        }),
        error => error === busy,
    );
    assert.equal(buildCalls, 0);
});
