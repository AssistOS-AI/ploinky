import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    resolveInteractiveSpawnResult,
    shouldAllocateInteractiveTty,
} from '../../cli/sandbox/interactiveProcess.js';
import { spawnBwrapInteractive } from '../../cli/sandbox/bwrap/interactive.js';
import { attachInteractive } from '../../cli/sandbox/docker/interactive.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('TTY allocation requires both terminal streams and respects the explicit disable override', () => {
    assert.equal(shouldAllocateInteractiveTty({
        env: {},
        stdin: { isTTY: true },
        stdout: { isTTY: true },
    }), true);
    assert.equal(shouldAllocateInteractiveTty({
        env: {},
        stdin: { isTTY: false },
        stdout: { isTTY: true },
    }), false);
    assert.equal(shouldAllocateInteractiveTty({
        env: {},
        stdin: { isTTY: true },
        stdout: { isTTY: false },
    }), false);
    assert.equal(shouldAllocateInteractiveTty({
        env: { PLOINKY_NO_TTY: '1' },
        stdin: { isTTY: true },
        stdout: { isTTY: true },
    }), false);
});

test('interactive spawn results preserve status, signal status, and launch errors', () => {
    assert.equal(resolveInteractiveSpawnResult({ status: 7 }), 7);
    assert.equal(resolveInteractiveSpawnResult({ status: null, signal: 'SIGTERM' }), 143);
    assert.throws(
        () => resolveInteractiveSpawnResult({ status: null, signal: null }),
        /without an exit status or signal/,
    );
    const cause = new Error('spawn failed');
    assert.throws(
        () => resolveInteractiveSpawnResult({ error: cause }),
        (error) => error.cause === cause && /failed to start: spawn failed/.test(error.message),
    );
});

test('bwrap uses the PTY wrapper only when both streams are terminals', () => {
    const calls = [];
    const spawnSyncImpl = (...args) => {
        calls.push(args);
        return { status: 9 };
    };
    assert.equal(spawnBwrapInteractive('/usr/bin/bwrap', ['--unshare-all'], {
        env: {},
        stdin: { isTTY: false },
        stdout: { isTTY: true },
        existsSync: () => true,
        spawnSyncImpl,
    }), 9);
    assert.equal(calls[0][0], '/usr/bin/bwrap');

    calls.length = 0;
    assert.equal(spawnBwrapInteractive('/usr/bin/bwrap', ['--unshare-all'], {
        env: {},
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        existsSync: () => true,
        spawnSyncImpl,
    }), 9);
    assert.equal(calls[0][0], '/usr/bin/script');

    calls.length = 0;
    spawnBwrapInteractive('/usr/bin/bwrap', ['--unshare-all'], {
        env: { PLOINKY_NO_TTY: '1' },
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        existsSync: () => true,
        spawnSyncImpl,
    });
    assert.equal(calls[0][0], '/usr/bin/bwrap');
});

test('container attach never fabricates -it for piped input and returns the child status', () => {
    const calls = [];
    const containerId = 'a'.repeat(64);
    const code = attachInteractive('agent-container', '/work', '/bin/sh', {
        env: {},
        stdin: { isTTY: false },
        stdout: { isTTY: true },
        runtime: 'podman',
        registryRecord: {
            type: 'agent',
            runtime: 'podman',
            containerId,
            instanceId: 'instance-current',
            enableGeneration: 'generation-current',
        },
        spawnSyncImpl: (...args) => {
            calls.push(args);
            return { status: 23 };
        },
    });
    assert.equal(code, 23);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].includes('-it'), false);
    assert.equal(calls[0][1].includes('-i'), true);
    assert.equal(calls[0][1].includes('agent-container'), false);
    assert.equal(calls[0][1].includes(containerId), true);
});

test('container attach rejects missing or non-exact immutable Podman identity before spawn', () => {
    const validRecord = {
        type: 'agent',
        runtime: 'podman',
        containerId: 'a'.repeat(64),
        instanceId: 'instance-current',
        enableGeneration: 'generation-current',
    };
    for (const registryRecord of [
        undefined,
        { ...validRecord, runtime: 'bwrap' },
        { ...validRecord, containerId: 'a'.repeat(63) },
        { ...validRecord, instanceId: ' instance-current ' },
        { ...validRecord, enableGeneration: '' },
    ]) {
        let spawned = false;
        assert.throws(
            () => attachInteractive('agent-container', '/work', '/bin/sh', {
                runtime: 'podman',
                ...(registryRecord ? { registryRecord } : {}),
                spawnSyncImpl: () => {
                    spawned = true;
                    return { status: 0 };
                },
            }),
            error => error?.code === 'PLOINKY_INTERACTIVE_RUNTIME_IDENTITY_INVALID',
        );
        assert.equal(spawned, false);
    }
});

test('container attach requires exact Podman selection and never probes a generic runtime', () => {
    for (const runtime of [undefined, '', 'container', 'docker', ' podman ', 'bwrap']) {
        let spawned = false;
        assert.throws(
            () => attachInteractive('agent-container', '/work', '/bin/sh', {
                ...(runtime === undefined ? {} : { runtime }),
                spawnSyncImpl: () => {
                    spawned = true;
                    return { status: 0 };
                },
            }),
            error => error?.code === 'PLOINKY_INTERACTIVE_RUNTIME_MISMATCH'
                && error?.context?.requestedRuntime === (runtime ?? ''),
        );
        assert.equal(spawned, false);
    }
});

test('shell dispatch and marker verification preserve exact failure semantics', () => {
    const cliSource = fs.readFileSync(path.join(repoRoot, 'cli', 'commands', 'cli.js'), 'utf8');
    const workspaceSource = fs.readFileSync(path.join(repoRoot, 'cli', 'commands', 'workspaceUtil.js'), 'utf8');
    const markerSource = fs.readFileSync(
        path.join(repoRoot, 'tests', 'test-functions', 'install_command_verification.sh'),
        'utf8',
    );

    assert.match(cliSource, /case 'shell':[\s\S]*?return runShell\(options\[0\]\);/);
    assert.equal((workspaceSource.match(/return runWithSuspendedInput\(\(\) => \{/g) || []).length >= 3, true);
    assert.match(markerSource, /PLOINKY_NO_TTY=1 ploinky shell/);
    assert.match(markerSource, /grep -qxF -- "\$success_marker"/);
    assert.doesNotMatch(markerSource, /grep -qF -- "install_marker_ok"/);
});
