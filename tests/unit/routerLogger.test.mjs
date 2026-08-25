import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAsyncLogWriter } from '../../cli/server/utils/logger.js';

test('router log writer batches ordered records without synchronous file writes', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-log-'));
    const logPath = path.join(root, 'router.log');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const writer = createAsyncLogWriter({ logDir: root, logPath });
    assert.equal(writer.appendLine('first\n'), true);
    assert.equal(writer.appendLine('second\n'), true);
    assert.deepEqual(writer.pendingState(), {
        pendingRecords: 2,
        pendingBytes: 13,
        droppedRecords: 0,
        flushing: false,
    });

    await writer.flush();

    assert.equal(fs.readFileSync(logPath, 'utf8'), 'first\nsecond\n');
    assert.deepEqual(writer.pendingState(), {
        pendingRecords: 0,
        pendingBytes: 0,
        droppedRecords: 0,
        flushing: false,
    });
});

test('router log writer bounds pending diagnostics and records dropped entries', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-log-bounded-'));
    const logPath = path.join(root, 'router.log');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const writer = createAsyncLogWriter({
        logDir: root,
        logPath,
        maxPendingBytes: 13,
    });
    writer.appendLine('first\n');
    writer.appendLine('second\n');
    writer.appendLine('third\n');

    await writer.flush();

    const records = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const dropped = JSON.parse(records[0]);
    assert.equal(dropped.type, 'router_log_records_dropped');
    assert.equal(dropped.dropped, 1);
    assert.deepEqual(records.slice(1), ['second', 'third']);
});
