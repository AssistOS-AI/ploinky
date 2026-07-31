import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalTTYFactory } from '../../cli/server/webchat/tty.js';

// global.processKill is normally installed by RoutingServer; provide a no-op so
// the handle's kill()/dispose() paths don't throw when run in isolation.
if (typeof global.processKill !== 'function') {
    global.processKill = () => {};
}

function makeSession(command, sessionContext = {}) {
    const factory = createLocalTTYFactory({ workdir: process.cwd(), command });
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

test('webchat child_process: handle exposes a numeric pid and no resize method', () => {
    const session = makeSession("sh -c 'sleep 0.2'");
    assert.equal(typeof session.pid, 'number');
    assert.equal(session.isAlive(), true);
    assert.equal(session.resize, undefined, 'resize() must be removed (PTY-only, unused)');
    session.dispose();
    assert.equal(session.isAlive(), false);
    assert.equal(session.write('ignored\n'), false);
});

test('webchat child_process: input during a bounded launcher restart is delivered once', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-webchat-restart-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const marker = path.join(dir, 'started');
    const command = [
        'sh -c',
        `'if [ ! -f "${marker}" ]; then`,
        `touch "${marker}";`,
        'printf "FIRST_EXIT\\n";',
        'exit 1;',
        'fi;',
        'IFS= read -r line;',
        'printf "RESTART_INPUT=%s\\n" "$line";',
        'sleep 1\'',
    ].join(' ');
    const session = makeSession(command);
    const chunks = [];
    const received = new Promise((resolve) => {
        session.onOutput((data) => {
            chunks.push(data);
            if (chunks.join('').includes('RESTART_INPUT=queued-message')) resolve();
        });
    });

    await new Promise((resolve) => {
        const inspect = (data) => {
            if (!String(data).includes('FIRST_EXIT')) return;
            setTimeout(resolve, 50);
        };
        session.onOutput(inspect);
    });
    assert.equal(session.isAlive(), true);
    assert.equal(session.write('queued-message\n'), true);
    await received;
    assert.equal(
        chunks.join('').match(/RESTART_INPUT=queued-message/g)?.length,
        1,
    );
    session.dispose();
});
