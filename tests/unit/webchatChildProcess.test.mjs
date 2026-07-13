import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWebchatSessionEnv, createLocalTTYFactory } from '../../cli/server/webchat/tty.js';

// global.processKill is normally installed by RoutingServer; provide a no-op so
// the handle's kill()/dispose() paths don't throw when run in isolation.
if (typeof global.processKill !== 'function') {
    global.processKill = () => {};
}

function makeSession(command, sessionContext = {}) {
    const factory = createLocalTTYFactory({ workdir: process.cwd(), command });
    return factory.create({ username: 'guest', id: 'guest', roles: ['guest'] }, sessionContext);
}

test('webchat child_process: history state is exposed through env', async () => {
    assert.deepEqual(buildWebchatSessionEnv({ hasHistory: true }), {
        PLOINKY_WEBCHAT_HAS_HISTORY: '1'
    });
    assert.deepEqual(buildWebchatSessionEnv({ hasHistory: false }), {
        PLOINKY_WEBCHAT_HAS_HISTORY: '0'
    });

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
    assert.match(chunks.join(''), /^HISTORY=1\|UNRELATED=unset$/m);
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

test('webchat child_process: handle exposes a numeric pid and no resize method', () => {
    const session = makeSession("sh -c 'sleep 0.2'");
    assert.equal(typeof session.pid, 'number');
    assert.equal(session.resize, undefined, 'resize() must be removed (PTY-only, unused)');
    session.dispose();
});
