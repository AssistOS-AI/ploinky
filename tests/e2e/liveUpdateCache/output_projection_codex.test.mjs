import test from 'node:test';
import assert from 'node:assert/strict';
import { createGcOutputProjection } from './output_projection_codex.mjs';

const close = projection => { projection.end('stdout'); projection.end('stderr'); return projection.snapshot(); };
const success = '[DEBUG] [deps-gc] removed 1 object(s); retained bytes by reason {"container-mount":12,"reader:service":3}\n';

test('unknown output is discarded and only known ordinary GC fields survive chunked UTF8 input', () => {
    const projection = createGcOutputProjection();
    const privateLine = Buffer.from('PRIVATE_SENTINEL 🧪\n');
    projection.push('stdout', privateLine.subarray(0, privateLine.length - 2));
    projection.push('stdout', privateLine.subarray(privateLine.length - 2));
    for (let index = 0; index < success.length; index += 3) projection.push('stdout', success.slice(index, index + 3));
    const result = close(projection);
    assert.equal(result.failure, null); assert.equal(result.closed, true); assert.equal(result.discardedLines, 1);
    assert.equal(result.bytes, privateLine.length + Buffer.byteLength(success));
    assert.deepEqual(result.summary, { outcome: 'collected', removedCount: 1, retainedBytesByReason: { 'container-mount': 12, 'reader:service': 3 } });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
});

test('skipped collection exports no arbitrary private detail and does not claim collected', () => {
    const projection = createGcOutputProjection();
    projection.push('stdout', '[DEBUG] [deps-gc] skipped (PRIVATE_SENTINEL)\n');
    const result = close(projection);
    assert.deepEqual(result.summary, { outcome: 'skipped' });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
});

test('unknown reason keys, private values and malformed summaries fail without an excerpt', () => {
    for (const value of ['{"PRIVATE_SENTINEL":1}', '{"container-mount":"PRIVATE_SENTINEL"}', '{PRIVATE_SENTINEL}']) {
        const projection = createGcOutputProjection();
        projection.push('stdout', `[DEBUG] [deps-gc] removed 0 object(s); retained bytes by reason ${value}\n`);
        const result = close(projection);
        assert.ok(result.failure); assert.equal(result.summary, null);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
    }
});

test('duplicate, missing and unclosed stream results never become a sole GC proof', () => {
    const duplicate = createGcOutputProjection(); duplicate.push('stdout', success); duplicate.push('stdout', success);
    assert.equal(close(duplicate).failure, 'gc-summary-duplicate');
    const missing = createGcOutputProjection(); missing.push('stdout', 'non-GC output\n');
    assert.equal(close(missing).failure, 'gc-summary-missing');
    const open = createGcOutputProjection(); open.push('stdout', success);
    assert.equal(open.snapshot().closed, false);
});

test('stderr cannot impersonate the ordinary console.log collection publisher', () => {
    const projection = createGcOutputProjection(); projection.push('stderr', success);
    const result = close(projection);
    assert.equal(result.failure, 'gc-summary-source-invalid'); assert.equal(result.summary, null);
});

test('duplicate and escaped-equivalent keys cannot overwrite an invalid or private earlier value', () => {
    for (const fields of ['"container-mount":"PRIVATE_SENTINEL","container-mount":1',
        '"container-mount":-1,"container\\u002dmount":1', '"container-mount":1,"container-mount":2']) {
        const projection = createGcOutputProjection();
        projection.push('stdout', `[DEBUG] [deps-gc] removed 0 object(s); retained bytes by reason {${fields}}\n`);
        const result = close(projection); assert.ok(result.failure); assert.equal(result.summary, null);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
    }
});

test('pending incomplete UTF8 bytes count against the line bound before EOF', () => {
    const projection = createGcOutputProjection({ maxLineBytes: 4 });
    assert.equal(projection.push('stdout', Buffer.concat([Buffer.from('aaaa'), Buffer.from([0xf0, 0x9f, 0xa7])])), false);
    assert.equal(projection.snapshot().failure, 'gc-output-line-limit');
    const truncated = createGcOutputProjection(); truncated.push('stdout', Buffer.from([0xf0, 0x9f]));
    assert.equal(close(truncated).failure, 'gc-output-utf8-invalid');
});

test('line and combined byte limits count bytes, latch failure and erase parsed data', () => {
    const line = createGcOutputProjection({ maxLineBytes: 4 }); line.push('stdout', '🧪x');
    assert.equal(close(line).failure, 'gc-output-line-limit');
    const bytes = createGcOutputProjection({ maxBytes: 4 }); bytes.push('stdout', 'aa'); bytes.push('stderr', 'bbb');
    const result = close(bytes); assert.equal(result.bytes, 5); assert.equal(result.failure, 'gc-output-byte-limit');
    assert.equal(result.summary, null);
    const afterSuccess = createGcOutputProjection({ maxBytes: Buffer.byteLength(success) + 1 });
    afterSuccess.push('stdout', success); afterSuccess.push('stderr', 'xx');
    assert.equal(close(afterSuccess).summary, null);
});

test('closed or unknown channels reject subsequent data without retaining it', () => {
    const projection = createGcOutputProjection(); projection.end('stdout');
    assert.equal(projection.push('stdout', 'PRIVATE_SENTINEL'), false);
    assert.equal(close(createGcOutputProjection()).failure, 'gc-summary-missing');
    assert.doesNotMatch(JSON.stringify(projection.snapshot()), /PRIVATE_SENTINEL/);
    const unknown = createGcOutputProjection(); unknown.push('PRIVATE_SENTINEL', success);
    assert.equal(unknown.snapshot().failure, 'gc-output-channel-invalid');
});

test('the nested Podman runtime reader kind is a known retained reason while an invented kind stays refused', () => {
    const accept = text => { const projection = createGcOutputProjection(); projection.push('stdout', Buffer.from(text)); projection.end('stdout'); projection.end('stderr'); return projection.snapshot(); };
    const known = accept('[DEBUG] [deps-gc] removed 0 object(s); retained bytes by reason {"admitted-record":10,"container-mount":10,"reader:container":10}\n');
    assert.deepEqual(known.summary, { outcome: 'collected', removedCount: 0, retainedBytesByReason: { 'admitted-record': 10, 'container-mount': 10, 'reader:container': 10 } });
    const invented = accept('[DEBUG] [deps-gc] removed 0 object(s); retained bytes by reason {"reader:made-up":10}\n');
    assert.equal(invented.failure, 'gc-summary-unknown-field'); assert.equal(invented.summary, null);
});
