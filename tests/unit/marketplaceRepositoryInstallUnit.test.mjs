import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createRepositoryInstallUnit, installBootstrapEnvironment, installUnitArguments, readInstallFrames, INSTALL_PROCESS } from '../../cli/server/marketplaceRepositoryInstallUnit.mjs';
import { startRepositoryInstallProcess } from '../../cli/server/marketplaceRepositoryInstallProcess.mjs';

const operationId = '01234567-89ab-cdef-0123-456789abcdef';

test('fixed install launch has an inert Node environment, private proc/dev/tmp and no parent-death shortcut', () => {
    const env = installBootstrapEnvironment(operationId);
    assert.deepEqual(Object.keys(env).sort(), ['LANG', 'PATH', 'PLOINKY_MARKETPLACE_REPOSITORY_OPERATION']);
    const args = installUnitArguments({ workspaceRoot: '/workspace', cwd: '/workspace/folder', executable: '/node' });
    assert.deepEqual(args.slice(-3), ['--', '/node', INSTALL_PROCESS]);
    for (const flag of ['--unshare-user', '--unshare-pid', '--proc', '--dev', '--tmpfs', '--ro-bind', '--block-fd', '--sync-fd']) assert.ok(args.includes(flag));
    for (const flag of ['--die-with-parent', '--as-pid-1', '--unshare-net']) assert.equal(args.includes(flag), false);
    assert.throws(() => installUnitArguments({ workspaceRoot: '/', cwd: '/' }));
    assert.throws(() => installUnitArguments({ workspaceRoot: '../workspace', cwd: '/workspace' }));
});

test('bounded frame parsing rejects overflow, malformed text and arrays without retaining secret text', () => {
    for (const data of ['SECRET_CANARY'.repeat(10), '[]\n', '{invalid}\n', '\n']) {
        const stream = new PassThrough();
        let error;
        let frames = 0;
        readInstallFrames(stream, () => { frames += 1; }, value => { error = value; }, 64);
        stream.end(data);
        assert.equal(error?.code, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
        assert.doesNotMatch(error.message, /SECRET_CANARY/);
        assert.equal(frames, 0);
    }
});

test('inert helper imports nothing and cannot install on EOF, wrong operation or premature release', async () => {
    for (const frame of [null, { type: 'run', operationId: 'wrong' }, { type: 'release', operationId }]) {
        const input = new PassThrough();
        const output = new PassThrough();
        let loads = 0;
        let exit;
        startRepositoryInstallProcess({ input, output, operationId,
            load: async () => { loads += 1; throw Error('must stay inert'); }, finish: code => { exit = code; } });
        if (frame) input.end(`${JSON.stringify(frame)}\n`); else input.end();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(loads, 0);
        assert.equal(exit, frame?.type === 'release' ? 0 : 1);
    }
});

test('monitor exit never substitutes for namespace synchronization EOF', async () => {
    const child = new EventEmitter();
    child.pid = 10;
    child.stdio = Array.from({ length: 6 }, () => new PassThrough());
    [child.stdin, child.stdout, child.stderr] = child.stdio;
    const unit = createRepositoryInstallUnit({ operationId, workspaceRoot: '/workspace', cwd: '/workspace', spawnProcess: () => child });
    child.stdio[3].end(JSON.stringify({ 'child-pid': 11 }));
    child.stdout.write(`${JSON.stringify({ type: 'ready', operationId })}\n`);
    assert.deepEqual(await unit.ready, { launcherPid: 10, initPid: 11 });
    let finished = false;
    const releasing = unit.release().then(() => { finished = true; });
    child.emit('exit', 0, null);
    await Promise.resolve();
    assert.equal(finished, false, 'a surviving orphan can keep init alive after monitor exit');
    child.stdio[5].end();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false, 'exit and sync EOF cannot bypass protocol output validation');
    child.stdout.end();
    await releasing;
    assert.equal(finished, true);
    unit.close();
});

async function preparedUnit() {
    const child = new EventEmitter();
    child.pid = 10;
    child.stdio = Array.from({ length: 6 }, () => new PassThrough());
    [child.stdin, child.stdout, child.stderr] = child.stdio;
    const unit = createRepositoryInstallUnit({ operationId, workspaceRoot: '/workspace', cwd: '/workspace', spawnProcess: () => child });
    child.stdio[3].end(JSON.stringify({ 'child-pid': 11 }));
    child.stdout.write(`${JSON.stringify({ type: 'ready', operationId })}\n`);
    await unit.ready;
    return { child, unit };
}

for (const [label, trailing] of [
    ['partial', '{"type":"barrier"'],
    ['duplicate', `${JSON.stringify({ type: 'ready', operationId })}\n`],
    ['wrong-operation', `${JSON.stringify({ type: 'ready', operationId: 'wrong' })}\n`],
]) {
    test(`late ${label} protocol output after monitor exit and sync EOF still prevents completion`, async () => {
        const { child, unit } = await preparedUnit();
        let finished = false;
        const release = unit.release();
        release.then(() => { finished = true; }, () => {});
        child.emit('exit', 0, null); child.stdio[5].end();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(finished, false);
        child.stdout.end(trailing);
        await assert.rejects(release, { code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' });
        assert.equal(finished, false);
        unit.close();
    });
}

for (const order of [
    ['exit', 'sync', 'output'], ['exit', 'output', 'sync'], ['sync', 'exit', 'output'],
    ['sync', 'output', 'exit'], ['output', 'exit', 'sync'], ['output', 'sync', 'exit'],
]) {
    test(`clean completion requires every event in ${order.join('/')} order`, async () => {
        const { child, unit } = await preparedUnit();
        let finished = false;
        const release = unit.release().then(() => { finished = true; });
        for (const [index, event] of order.entries()) {
            if (event === 'exit') child.emit('exit', 0, null);
            else if (event === 'sync') child.stdio[5].end();
            else child.stdout.end();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(finished, index === 2);
        }
        await release; unit.close();
    });
}

test('aborted stdout without clean EOF cannot finish an otherwise ended unit', async () => {
    const { child, unit } = await preparedUnit();
    const release = unit.release();
    child.emit('exit', 0, null); child.stdio[5].end(); child.stdout.destroy();
    await assert.rejects(release, { code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' });
    unit.close();
});

test('bootstrap excludes Node and dynamic loader canaries before the child process exists', async () => {
    const previous = Object.fromEntries(['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].map(key => [key, process.env[key]]));
    try {
        for (const key of Object.keys(previous)) process.env[key] = 'PRELOAD_SECRET_CANARY';
        let captured;
        assert.throws(() => createRepositoryInstallUnit({ operationId, workspaceRoot: '/workspace', cwd: '/workspace',
            spawnProcess(_executable, _args, options) { captured = options; throw Error('stop before spawn'); } }));
        for (const key of Object.keys(previous)) assert.equal(Object.hasOwn(captured.env, key), false);
        assert.doesNotMatch(JSON.stringify(captured), /PRELOAD_SECRET_CANARY/);
    } finally {
        for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
});
