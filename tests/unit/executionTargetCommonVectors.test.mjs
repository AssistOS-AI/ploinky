import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import {
    CONTRACT_ERROR_CODES,
    canonicalTargetJson,
    parseCanonicalTargetJson,
    targetDigest,
    validateSourceClosure,
    validateSourceOperation,
    validateSourceProtectionRecord,
    validateSourceSelection,
    validateWritableReservation,
} from '../../cli/server/executionTarget/contract.mjs';

// T1-03 / A5.5: the common vectors are authored with the worker implementation
// and copied byte-identically; each repository runs its own implementation
// against them. This file never modifies the fixture.
const FIXTURE_URL = new URL('./fixtures/executionTarget/contracts-v1.json', import.meta.url);
const FIXTURE_SHA256 = 'eb8df3e6bd6f7d0a3360f2f27d2f468ef937c7a899655662dcaa4aae01dfdbbc';
const BYTES = fs.readFileSync(FIXTURE_URL);
const FIXTURE = JSON.parse(BYTES.toString('utf8'));

const DOCUMENT_VALIDATORS = Object.freeze({
    sourceProtectionRecord: validateSourceProtectionRecord,
    sourceSelection: validateSourceSelection,
    sourceClosure: validateSourceClosure,
    writableReservation: validateWritableReservation,
});

function validate(type, value) {
    if (Object.hasOwn(DOCUMENT_VALIDATORS, type)) return DOCUMENT_VALIDATORS[type](value);
    return validateSourceOperation(type, value);
}

const OPERATION_NAME = /^(reserve|transition|release|acknowledge|advance)(Request|Result)$/;
const code = (result) => (result.ok ? 'ok' : result.error.code);

test('T1-03 the common fixture is byte-identical to the frozen worker copy', () => {
    assert.equal(crypto.createHash('sha256').update(BYTES).digest('hex'), FIXTURE_SHA256);
    assert.equal(FIXTURE.version, 1);
    assert.deepEqual(Object.keys(FIXTURE).sort(), ['canonical', 'documents', 'parseRejections', 'rejections', 'version']);
});

test('common canonical vectors: exact bytes and digests, and the bytes parse back canonically', () => {
    assert.ok(FIXTURE.canonical.length > 0);
    for (const vector of FIXTURE.canonical) {
        const text = canonicalTargetJson(vector.value);
        assert.equal(text.ok, true, vector.id);
        assert.equal(text.value, vector.canonicalJson, vector.id);
        assert.equal(targetDigest(vector.value).value, vector.sha256, vector.id);
        assert.equal(crypto.createHash('sha256').update(vector.canonicalJson, 'utf8').digest('hex'), vector.sha256, vector.id);
        const parsed = parseCanonicalTargetJson(vector.canonicalJson);
        assert.equal(parsed.ok, true, vector.id);
        assert.deepEqual(parsed.value, vector.value, vector.id);
    }
});

test('common parse rejections: every text refuses with exactly the fixture code', () => {
    assert.ok(FIXTURE.parseRejections.length > 0);
    const codes = new Set(Object.values(CONTRACT_ERROR_CODES));
    for (const vector of FIXTURE.parseRejections) {
        assert.ok(codes.has(vector.code), vector.id);
        const result = parseCanonicalTargetJson(vector.text);
        assert.deepEqual(result, { ok: false, error: { code: vector.code } }, vector.id);
        // The UTF-8 byte form refuses identically, unless the text cannot be encoded (a lone surrogate).
        if (vector.text.isWellFormed()) {
            assert.equal(code(parseCanonicalTargetJson(Buffer.from(vector.text, 'utf8'))), vector.code, `${vector.id} bytes`);
        }
    }
});

test('common positive documents validate, keep their canonical bytes and are returned deep-frozen', () => {
    assert.ok(FIXTURE.documents.length > 0);
    for (const vector of FIXTURE.documents) {
        const result = validate(vector.type, vector.value);
        assert.equal(result.ok, true, `${vector.id}: ${code(result)}`);
        assert.deepEqual(result.value, vector.value, vector.id);
        assert.equal(Object.isFrozen(result.value), true, vector.id);
        assert.equal(canonicalTargetJson(vector.value).value, vector.canonicalJson, vector.id);
        if (vector.sha256) assert.equal(targetDigest(vector.value).value, vector.sha256, vector.id);
        // The operation-name form selects the same document type through its request marker.
        const match = OPERATION_NAME.exec(vector.type);
        if (match) assert.equal(validateSourceOperation(match[1], vector.value).ok, true, `${vector.id} by operation name`);
    }
});

test('common rejection vectors refuse with exactly the fixture code', () => {
    assert.ok(FIXTURE.rejections.length > 0);
    const codes = new Set(Object.values(CONTRACT_ERROR_CODES));
    for (const vector of FIXTURE.rejections) {
        assert.ok(codes.has(vector.code), vector.id);
        const result = validate(vector.type, vector.value);
        assert.deepEqual(result, { ok: false, error: { code: vector.code } }, `${vector.id}: got ${code(result)}`);
    }
});
