import assert from 'node:assert/strict';
import test from 'node:test';

import { pipeProcess, streamProcess } from '../../ploinky-box/process.mjs';

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

test('image transfer pipes exact bytes without a mutable intermediate artifact', async () => {
    const payload = 'exact-descriptor-node-image-bytes';
    const digest = await import('node:crypto').then(({ createHash }) => (
        createHash('sha256').update(payload).digest('hex')
    ));
    const stdout = outputCollector();
    const stderr = outputCollector();
    const result = await pipeProcess(
        process.execPath,
        ['--input-type=module', '-e', `process.stdout.write(${JSON.stringify(payload)})`],
        process.execPath,
        ['--input-type=module', '-e', [
            "import crypto from 'node:crypto';",
            'const chunks = [];',
            "process.stdin.on('data', (chunk) => chunks.push(chunk));",
            "process.stdin.on('end', () => process.stdout.write(crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex')));",
        ].join('')],
        { timeoutMs: 2_000, stdout, stderr },
    );

    assert.equal(result.ok, true);
    assert.equal(result.sourceStatus, 0);
    assert.equal(result.destinationStatus, 0);
    assert.equal(result.stdout, digest);
    assert.equal(stdout.value, digest);
    assert.equal(stderr.value, '');
});

test('image transfer timeout force-contains both pipeline processes', async () => {
    const started = Date.now();
    const result = await pipeProcess(
        process.execPath,
        ['--input-type=module', '-e', 'setInterval(() => {}, 1000)'],
        process.execPath,
        ['--input-type=module', '-e', "process.stdin.resume(); setInterval(() => {}, 1000)"],
        { timeoutMs: 50, stdout: outputCollector(), stderr: outputCollector() },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ETIMEDOUT');
    assert.ok(Date.now() - started < 2_000);
});
