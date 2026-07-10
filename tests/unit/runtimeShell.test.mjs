import test from 'node:test';
import assert from 'node:assert/strict';
import { runOuterRuntimeShell } from '../../cli/services/runtimeShell.js';

test('outer shell validates marker before tty and restores around bash', () => {
    const events = [];
    const lines = [];
    const code = runOuterRuntimeShell({
        env: { TOKEN: 'kept' },
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        markerPath: '/marker',
        isManagedRuntimeImpl: value => value === '/marker',
        runtimeName: 'ploinky-box-demo',
        user: 'podman',
        log: line => lines.push(line),
        prepareForExternalCommandImpl: options => {
            events.push(['suspend', options]);
            return () => events.push('restore');
        },
        spawnSyncImpl: (file, args, options) => {
            events.push({ file, args, options });
            return { status: 0 };
        },
    });

    assert.equal(code, 0);
    assert.deepEqual(lines, [
        "[ploinky] Entering outer runtime 'ploinky-box-demo'",
        '[ploinky] user=podman cwd=/workspace; exit returns to the previous prompt',
    ]);
    assert.deepEqual(events[0], ['suspend', { promptOnRestore: false }]);
    assert.deepEqual(events[1], {
        file: '/bin/bash',
        args: [],
        options: { cwd: '/workspace', stdio: 'inherit', env: { TOKEN: 'kept' } },
    });
    assert.equal(events[2], 'restore');
});

test('outer shell rejects direct core execution before checking tty', () => {
    assert.throws(
        () => runOuterRuntimeShell({
            stdin: { isTTY: false },
            stdout: { isTTY: false },
            isManagedRuntimeImpl: () => false,
        }),
        /requires the managed Ploinky runtime/,
    );
});

test('outer shell requires both interactive streams', () => {
    assert.throws(
        () => runOuterRuntimeShell({
            stdin: { isTTY: true },
            stdout: { isTTY: false },
            isManagedRuntimeImpl: () => true,
        }),
        /requires an interactive terminal/,
    );
});

test('outer shell preserves a nonzero bash exit status', () => {
    const code = runOuterRuntimeShell({
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        isManagedRuntimeImpl: () => true,
        prepareForExternalCommandImpl: () => () => {},
        spawnSyncImpl: () => ({ status: 7 }),
        log: () => {},
    });

    assert.equal(code, 7);
});

test('outer shell maps SIGTERM termination to shell exit status 143', () => {
    const code = runOuterRuntimeShell({
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        isManagedRuntimeImpl: () => true,
        prepareForExternalCommandImpl: () => () => {},
        spawnSyncImpl: () => ({ status: null, signal: 'SIGTERM' }),
        log: () => {},
    });

    assert.equal(code, 143);
});
