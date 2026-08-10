import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    SANDBOX_LOG_DIR_NAME,
    openSandboxLogHandle,
    proveSandboxLogSource,
    readSandboxCrashLog,
    sandboxLogFileName,
    sandboxLogIdentityDigest,
} from '../../cli/sandbox/sandboxLogFiles.js';

const BLUE = 'ploinky_demo_shared_blue';
const GREEN = 'ploinky_demo_shared_green';
const TUPLE = { instanceId: 'instance-0001', enableGeneration: 'generation-0001' };

function workspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-logs-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const logsDir = path.join(root, 'logs');
    fs.mkdirSync(logsDir, { mode: 0o700 });
    return logsDir;
}

function record(overrides = {}) {
    return { type: 'agent', runtime: 'bwrap', pid: 4242, ...TUPLE, ...overrides };
}

test('the digest is the documented sha256 over the tuple and the decimal pid', () => {
    // NUL separators keep the three components unambiguous; written as an
    // explicit code point so the following digit is not read as an octal escape.
    const NUL = String.fromCharCode(0);
    const expected = crypto.createHash('sha256')
        .update(`${TUPLE.instanceId}${NUL}${TUPLE.enableGeneration}${NUL}4242`)
        .digest('hex');
    assert.equal(sandboxLogIdentityDigest({ ...TUPLE, pid: 4242 }), expected);
});

test('two aliases of one manifest get different paths', () => {
    const digest = sandboxLogIdentityDigest({ ...TUPLE, pid: 4242 });
    assert.notEqual(sandboxLogFileName(BLUE, digest), sandboxLogFileName(GREEN, digest));
});

test('two generations of one canonical key get different paths', () => {
    const first = sandboxLogIdentityDigest({ ...TUPLE, pid: 4242 });
    const second = sandboxLogIdentityDigest({
        instanceId: 'instance-0002', enableGeneration: 'generation-0002', pid: 4242,
    });
    assert.notEqual(first, second);
    assert.notEqual(sandboxLogFileName(BLUE, first), sandboxLogFileName(BLUE, second));
});

test('the finalized pid participates in the digest', () => {
    assert.notEqual(
        sandboxLogIdentityDigest({ ...TUPLE, pid: 4242 }),
        sandboxLogIdentityDigest({ ...TUPLE, pid: 4243 }),
    );
});

test('an incomplete identity never derives a path', () => {
    for (const broken of [
        { instanceId: '', enableGeneration: 'g', pid: 1 },
        { instanceId: 'i', enableGeneration: '  ', pid: 1 },
        { instanceId: 'i', enableGeneration: 'g', pid: 0 },
        { instanceId: 'i', enableGeneration: 'g', pid: -1 },
        { instanceId: 'i', enableGeneration: 'g', pid: 1.5 },
        { instanceId: 'i', enableGeneration: 'g', pid: undefined },
    ]) {
        assert.throws(() => sandboxLogIdentityDigest(broken), (error) => (
            error.code === 'SANDBOX_LOG_UNAVAILABLE'
        ), JSON.stringify(broken));
    }
    for (const unsafe of ['', '../escape', 'nested/name', '.hidden']) {
        assert.throws(
            () => sandboxLogFileName(unsafe, 'a'.repeat(64)),
            (error) => error.code === 'SANDBOX_LOG_UNAVAILABLE',
            unsafe,
        );
    }
});

test('the producer spawns against a 0600 temporary file and links it without replacement after the pid is known', (t) => {
    const logsDir = workspace(t);
    const handle = openSandboxLogHandle({ containerName: BLUE, logsDir });

    const directory = path.join(logsDir, SANDBOX_LOG_DIR_NAME);
    assert.equal((fs.statSync(directory).mode & 0o777), 0o700);
    assert.equal((fs.statSync(handle.temporaryPath).mode & 0o777), 0o600);
    // One descriptor carries both sandbox streams.
    assert.equal(handle.stdio[0], 'ignore');
    assert.equal(handle.stdio[1], handle.stdio[2]);

    fs.writeSync(handle.descriptor, 'sandbox output\n');
    const finalPath = handle.finalize(4242, TUPLE);

    assert.equal(fs.existsSync(handle.temporaryPath), false);
    assert.equal(
        path.basename(finalPath),
        sandboxLogFileName(BLUE, sandboxLogIdentityDigest({ ...TUPLE, pid: 4242 })),
    );
    // Immediate-crash diagnostics read this exact renamed file.
    assert.equal(fs.readFileSync(finalPath, 'utf8'), 'sandbox output\n');
    assert.equal((fs.statSync(finalPath).mode & 0o777), 0o600);
});

test('a spawn failure discards the temporary file and writes no final log', (t) => {
    const logsDir = workspace(t);
    const handle = openSandboxLogHandle({ containerName: BLUE, logsDir });
    const temporaryPath = handle.temporaryPath;
    handle.discard();
    assert.equal(fs.existsSync(temporaryPath), false);
    assert.deepEqual(fs.readdirSync(path.join(logsDir, SANDBOX_LOG_DIR_NAME)), []);
});

test('two concurrent launches never share a temporary file', (t) => {
    const logsDir = workspace(t);
    const first = openSandboxLogHandle({ containerName: BLUE, logsDir });
    const second = openSandboxLogHandle({ containerName: BLUE, logsDir });
    t.after(() => { first.discard(); second.discard(); });
    assert.notEqual(first.temporaryPath, second.temporaryPath);
    assert.notEqual(first.descriptor, second.descriptor);
});

test('final publication never replaces an existing tuple-and-pid log', (t) => {
    const logsDir = workspace(t);
    const first = openSandboxLogHandle({ containerName: BLUE, logsDir });
    fs.writeSync(first.descriptor, 'first launch\n');
    const finalPath = first.finalize(4242, TUPLE);
    first.commit();

    const collision = openSandboxLogHandle({ containerName: BLUE, logsDir });
    fs.writeSync(collision.descriptor, 'replacement\n');
    assert.throws(() => collision.finalize(4242, TUPLE), (error) => error.code === 'EEXIST');
    assert.equal(fs.readFileSync(finalPath, 'utf8'), 'first launch\n');
    assert.deepEqual(
        fs.readdirSync(path.join(logsDir, SANDBOX_LOG_DIR_NAME)),
        [path.basename(finalPath)],
    );
    assert.throws(() => fs.fstatSync(collision.descriptor), { code: 'EBADF' });
});

test('a failed pending-name unlink removes only task-owned links and closes the descriptor', (t) => {
    const logsDir = workspace(t);
    let failPendingUnlink = true;
    const fsApi = {
        ...fs,
        constants: fs.constants,
        unlinkSync(target) {
            if (failPendingUnlink && String(target).includes('.pending-')) {
                failPendingUnlink = false;
                const error = new Error('injected pending unlink failure');
                error.code = 'EIO';
                throw error;
            }
            return fs.unlinkSync(target);
        },
    };
    const handle = openSandboxLogHandle({ containerName: BLUE, logsDir, fsApi });
    assert.throws(() => handle.finalize(4242, TUPLE), { code: 'EIO' });
    assert.deepEqual(fs.readdirSync(path.join(logsDir, SANDBOX_LOG_DIR_NAME)), []);
    assert.throws(() => fs.fstatSync(handle.descriptor), { code: 'EBADF' });
});

test('a producer fstat failure still closes its newly opened descriptor', (t) => {
    const logsDir = workspace(t);
    const opened = [];
    const closed = [];
    const fsApi = {
        ...fs,
        constants: fs.constants,
        openSync(...args) {
            const descriptor = fs.openSync(...args);
            opened.push(descriptor);
            return descriptor;
        },
        fstatSync() { throw new Error('injected fstat failure'); },
        closeSync(descriptor) {
            closed.push(descriptor);
            return fs.closeSync(descriptor);
        },
    };
    assert.throws(
        () => openSandboxLogHandle({ containerName: BLUE, logsDir, fsApi }),
        /injected fstat failure/,
    );
    assert.deepEqual(closed, opened);
});

test('producer selection rejects symlinked and writable log parents', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-parent-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.symlinkSync(outside, path.join(root, 'logs'));
    assert.throws(
        () => openSandboxLogHandle({ containerName: BLUE, logsDir: path.join(root, 'logs') }),
        /not one regular directory/,
    );

    fs.unlinkSync(path.join(root, 'logs'));
    fs.mkdirSync(path.join(root, 'logs'), { mode: 0o700 });
    fs.chmodSync(path.join(root, 'logs'), 0o777);
    assert.throws(
        () => openSandboxLogHandle({ containerName: BLUE, logsDir: path.join(root, 'logs') }),
        /group- or other-writable/,
    );
});

test('a stopped post-cut sandbox log is derived from the registry tuple and pid', (t) => {
    const logsDir = workspace(t);
    const handle = openSandboxLogHandle({ containerName: BLUE, logsDir });
    fs.writeSync(handle.descriptor, 'stopped agent output\n');
    handle.finalize(4242, TUPLE);

    const source = proveSandboxLogSource(BLUE, record(), {
        logsDir,
    });
    assert.equal(source.runtime, 'bwrap');
    assert.equal(source.pid, 4242);
    assert.equal(Object.hasOwn(source, 'running'), false);
    assert.deepEqual(source.fileSpec.relativeSegments[0], SANDBOX_LOG_DIR_NAME);
    assert.equal(fs.readFileSync(source.path, 'utf8'), 'stopped agent output\n');
});

test('immediate-crash diagnostics read only the bounded recent suffix', (t) => {
    const logsDir = workspace(t);
    const handle = openSandboxLogHandle({ containerName: BLUE, logsDir });
    fs.writeSync(handle.descriptor, `${'old line\n'.repeat(20_000)}${'recent\n'.repeat(12)}`);
    handle.finalize(4242, TUPLE);
    assert.equal(
        readSandboxCrashLog(BLUE, record(), { logsDir }),
        Array(12).fill('recent').join('\n'),
    );
});

test('sandbox log selection never invokes a lifecycle liveness helper', (t) => {
    const logsDir = workspace(t);
    const handle = openSandboxLogHandle({ containerName: BLUE, logsDir });
    handle.finalize(4242, TUPLE);

    const source = proveSandboxLogSource(BLUE, record(), {
        logsDir,
        isSandboxProcessRunning: () => { throw new Error('must remain observational'); },
    });
    assert.equal(source.pid, 4242);
    assert.equal(Object.hasOwn(source, 'running'), false);
});

test('a staged predecessor record cannot select either generation log', (t) => {
    const logsDir = workspace(t);
    // The predecessor launch wrote its own file under the old tuple and pid.
    const predecessor = openSandboxLogHandle({ containerName: BLUE, logsDir });
    predecessor.finalize(4242, TUPLE);
    // A successor launch wrote its own file under the new tuple and pid.
    const successor = openSandboxLogHandle({ containerName: BLUE, logsDir });
    const newTuple = { instanceId: 'instance-0002', enableGeneration: 'generation-0002' };
    successor.finalize(5555, newTuple);

    // Staging spreads the predecessor record and rotates only the tuple, so the
    // record carries the new tuple beside the predecessor's pid.
    assert.throws(
        () => proveSandboxLogSource(BLUE, record({ ...newTuple, pid: 4242 }), { logsDir }),
        (error) => error.code === 'SANDBOX_LOG_RESTART_REQUIRED',
    );
});

test('a pre-cut stopped record returns the restart-required diagnostic', (t) => {
    const logsDir = workspace(t);
    fs.mkdirSync(logsDir, { recursive: true });
    // Only the ambiguous legacy names exist.
    fs.writeFileSync(path.join(logsDir, 'shared-bwrap.log'), 'legacy output\n');
    fs.writeFileSync(path.join(logsDir, 'shared-seatbelt.log'), 'legacy output\n');

    assert.throws(
        () => proveSandboxLogSource(BLUE, record(), { logsDir }),
        (error) => error.code === 'SANDBOX_LOG_RESTART_REQUIRED'
            && /restart the agent to produce one/.test(error.message),
    );
});

test('no legacy filename is probed, migrated, or inferred', async () => {
    const modules = [
        '../../cli/sandbox/sandboxLogFiles.js',
        '../../cli/commands/logCommands.js',
        '../../cli/commands/logUtils.js',
        '../../cli/sandbox/bwrap/bwrapServiceManager.js',
        '../../cli/sandbox/seatbelt/seatbeltServiceManager.js',
    ];
    const sources = await Promise.all(modules.map(
        (relative) => fs.promises.readFile(new URL(relative, import.meta.url), 'utf8'),
    ));
    for (const [index, source] of sources.entries()) {
        // Documentation may name what was removed; executable code may not
        // build, probe, or fall back to either legacy name.
        const executable = source
            .split('\n')
            .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
            .join('\n');
        assert.equal(executable.includes('-bwrap.log'), false, modules[index]);
        assert.equal(executable.includes('-seatbelt.log'), false, modules[index]);
    }
});

test('an unsupported runtime or malformed record never derives a sandbox source', (t) => {
    const logsDir = workspace(t);
    for (const broken of [
        record({ runtime: 'podman' }),
        record({ runtime: '' }),
        record({ instanceId: '' }),
        record({ instanceId: 123 }),
        record({ instanceId: ` ${TUPLE.instanceId}` }),
        record({ enableGeneration: '' }),
        record({ enableGeneration: 123 }),
        record({ pid: 0 }),
        record({ pid: '4242' }),
        record({ pid: 'x' }),
    ]) {
        assert.throws(
            () => proveSandboxLogSource(BLUE, broken, { logsDir }),
            (error) => error.code === 'SANDBOX_LOG_UNAVAILABLE',
            JSON.stringify(broken),
        );
    }
});

test('a non-regular derived path is rejected instead of read', (t) => {
    const logsDir = workspace(t);
    const digest = sandboxLogIdentityDigest({ ...TUPLE, pid: 4242 });
    const directory = path.join(logsDir, SANDBOX_LOG_DIR_NAME);
    fs.mkdirSync(path.join(directory, sandboxLogFileName(BLUE, digest)), { recursive: true });
    assert.throws(
        () => proveSandboxLogSource(BLUE, record(), { logsDir }),
        (error) => error.code === 'SANDBOX_LOG_UNAVAILABLE' && /not one regular file/.test(error.message),
    );
});
