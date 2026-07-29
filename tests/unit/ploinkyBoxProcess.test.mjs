import assert from 'node:assert/strict';
import test from 'node:test';

import { streamProcess } from '../../ploinky-box/process.mjs';

function outputCollector(onWrite = () => {}) {
    return {
        value: '',
        write(chunk) {
            this.value += String(chunk);
            onWrite(this.value);
        },
    };
}

test('streamed processes expose progress before completion and retain bounded output', async () => {
    let observedProgress;
    const progressSeen = new Promise((resolve) => {
        observedProgress = resolve;
    });
    const stdout = outputCollector((value) => {
        if (value.includes('progress')) observedProgress();
    });
    const stderr = outputCollector();
    let completed = false;

    const pending = streamProcess(process.execPath, [
        '--input-type=module',
        '-e',
        [
            "process.stdout.write('progress\\n');",
            "setTimeout(() => process.stderr.write('detail\\n'), 25);",
            'setTimeout(() => process.exit(0), 100);',
        ].join(''),
    ], {
        stdout,
        stderr,
        timeoutMs: 2_000,
    }).then((result) => {
        completed = true;
        return result;
    });

    await progressSeen;
    assert.equal(completed, false);

    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'progress\n');
    assert.equal(result.stderr, 'detail\n');
    assert.equal(stdout.value, result.stdout);
    assert.equal(stderr.value, result.stderr);
});
