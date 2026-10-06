import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RuntimeRelayManager } from '../../cli/server/runtimeRelay/RuntimeRelayManager.js';

function fakeRuntime(t, body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrdi-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'fake-runtime');
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
    return file;
}

test('default container inspection does not block the event loop and parses JSON', async (t) => {
    const runtime = fakeRuntime(t, 'sleep 0.4\necho \'[{"Id":"abc"}]\'');
    const manager = new RuntimeRelayManager({ minter: {} });
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    try {
        const result = await manager.inspectContainer(runtime, 'abc');
        assert.deepEqual(result, [{ Id: 'abc' }]);
    } finally {
        clearInterval(timer);
    }
    assert.ok(ticks >= 5, `event loop kept running during inspect (ticks=${ticks})`);
});

test('default container inspection rejects on runtime failure and on invalid JSON', async (t) => {
    const manager = new RuntimeRelayManager({ minter: {} });
    await assert.rejects(manager.inspectContainer(fakeRuntime(t, 'exit 3'), 'abc'));
    await assert.rejects(manager.inspectContainer(fakeRuntime(t, 'echo not-json'), 'abc'));
});
