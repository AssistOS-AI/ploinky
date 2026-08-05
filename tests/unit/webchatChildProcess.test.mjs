import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createLocalTTYFactory } from '../../cli/server/webchat/tty.js';

// global.processKill is normally installed by RoutingServer; provide a no-op so
// the handle's kill()/dispose() paths don't throw when run in isolation.
if (typeof global.processKill !== 'function') {
    global.processKill = () => {};
}

function makeSession(command, sessionContext = {}) {
    const factory = createLocalTTYFactory({
        workdir: fs.realpathSync(process.cwd()),
        executable: '/bin/sh',
        argv: ['-c', command, '--'],
    });
    return factory.create({ username: 'guest', id: 'guest', roles: ['guest'] }, sessionContext);
}

test('webchat child_process: Ploinky session env is not exposed to the agent', async () => {
    const previousUnrelatedValue = process.env.PLOINKY_WEBCHAT_UNRELATED;
    process.env.PLOINKY_WEBCHAT_UNRELATED = 'must-not-be-forwarded';
    const session = makeSession(
        `sh -c 'printf "HISTORY=%s|UNRELATED=%s\\n" "$PLOINKY_WEBCHAT_HAS_HISTORY" "\${PLOINKY_WEBCHAT_UNRELATED:-unset}"'`,
        { hasHistory: true }
    );
    if (previousUnrelatedValue === undefined) delete process.env.PLOINKY_WEBCHAT_UNRELATED;
    else process.env.PLOINKY_WEBCHAT_UNRELATED = previousUnrelatedValue;
    const chunks = [];
    await new Promise((resolve) => {
        session.onOutput((data) => chunks.push(data));
        session.onClose(resolve);
    });
    assert.match(chunks.join(''), /^HISTORY=\|UNRELATED=unset$/m);
});

test('webchat child_process: output is delivered as a string, not a Buffer', async () => {
    const session = makeSession("sh -c 'printf WEBCHAT_OK'");
    const chunks = [];
    await new Promise((resolve) => {
        session.onOutput((data) => {
            assert.equal(typeof data, 'string', 'onOutput must deliver a string, not a Buffer');
            chunks.push(data);
        });
        session.onClose(resolve);
    });
    assert.ok(chunks.join('').includes('WEBCHAT_OK'), 'expected command output to reach onOutput');
});

test('webchat child_process: close fires after the child exits', async () => {
    const session = makeSession("sh -c 'printf done'");
    const closed = await new Promise((resolve) => {
        session.onClose(() => resolve(true));
    });
    assert.equal(closed, true);
});

test('webchat child_process: an exited CLI is not restarted inside the same TTY handle', async () => {
    const session = makeSession("sh -c 'printf one-run'");
    const chunks = [];
    let closeCount = 0;
    await new Promise((resolve) => {
        session.onOutput((data) => chunks.push(data));
        session.onClose(() => {
            closeCount += 1;
            resolve();
        });
    });

    assert.equal(chunks.join(''), 'one-run');
    assert.equal(closeCount, 1);
    assert.equal(session.isAlive(), false);
});

test('webchat child_process: handle exposes a numeric pid and no resize method', () => {
    const session = makeSession("sh -c 'sleep 0.2'");
    assert.equal(typeof session.pid, 'number');
    assert.equal(session.isAlive(), true);
    assert.equal(session.resize, undefined, 'resize() must be removed (PTY-only, unused)');
    session.dispose();
    assert.equal(session.isAlive(), false);
    assert.equal(session.write('ignored\n'), false);
});

test('webchat child_process uses exact direct argv and appends identity only after the separator', () => {
    const calls = [];
    const spawnImpl = (executable, argv, options) => {
        calls.push({ executable, argv, options });
        const child = new EventEmitter();
        child.pid = 4242;
        child.exitCode = null;
        child.signalCode = null;
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        return child;
    };
    const cwd = fs.realpathSync(process.cwd());
    const factory = createLocalTTYFactory({
        workdir: cwd,
        executable: '/exact/ploinky-local',
        argv: [
            'cli',
            'codex',
            '--workdir',
            'folder with spaces',
            '--',
            '--dir=/workspace/folder with spaces',
            '',
            '--model=μ-model',
        ],
        spawnImpl,
    });
    const session = factory.create({
        username: 'User With Spaces',
        id: 'user-1',
        email: 'user@example.test',
        roles: ['admin', 'reviewer'],
        sessionId: 'session-1',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, '/exact/ploinky-local');
    assert.deepEqual(calls[0].argv, [
        'cli',
        'codex',
        '--workdir',
        'folder with spaces',
        '--',
        '--dir=/workspace/folder with spaces',
        '',
        '--model=μ-model',
        '--sso-user=User With Spaces',
        '--sso-user-id=user-1',
        '--sso-email=user@example.test',
        '--sso-roles=admin,reviewer',
        '--sso-session-id=session-1',
    ]);
    assert.equal(calls[0].options.cwd, cwd);
    assert.equal(calls[0].options.detached, true);
    assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
    session.dispose();
});
