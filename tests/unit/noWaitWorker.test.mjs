import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    waitForPriorWorker,
    writeStatus,
} from '../../cli/commands/noWaitWorker.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-no-wait-worker-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runningDir = path.join(root, 'running');
    return { root, runningDir };
}

test('no-wait status replacement is atomic and leaves no temporary file', (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'ploinky_demo_worker';
    const statusDir = path.join(runningDir, 'no-wait');
    const target = path.join(statusDir, `${containerName}.json`);

    for (let sequence = 0; sequence < 50; sequence += 1) {
        writeStatus(containerName, { state: 'starting', sequence }, { runningDir });
        assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), {
            state: 'starting',
            sequence,
        });
        assert.deepEqual(fs.readdirSync(statusDir), [`${containerName}.json`]);
    }
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('no-wait predecessor observes a complete atomically published terminal state', async (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'ploinky_demo_predecessor';
    const target = path.join(runningDir, 'no-wait', `${containerName}.json`);
    writeStatus(containerName, { state: 'starting' }, { runningDir });
    let polls = 0;

    await waitForPriorWorker(target, {
        runningDir,
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        async sleepFn() {
            polls += 1;
            writeStatus(containerName, { state: 'running' }, { runningDir });
        },
    });

    assert.equal(polls, 1);
});

test('no-wait predecessor rejects a path outside the status directory', async (t) => {
    const { root, runningDir } = fixture(t);
    await assert.rejects(
        () => waitForPriorWorker(path.join(root, 'foreign.json'), { runningDir }),
        /must be an exact file/,
    );
});
