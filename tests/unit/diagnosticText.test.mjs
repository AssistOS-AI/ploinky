import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DIAGNOSTIC_TEXT_LIMIT,
    sanitizeControlDiagnosticText,
    sanitizeDiagnosticText,
} from '../../cli/utils/diagnosticText.js';

test('diagnostics redact authorization values, JWTs, assignments, and named secrets', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue';
    const text = sanitizeDiagnosticText(
        `Authorization: Bearer top-secret ${jwt} password=hunter2 API_TOKEN: abc123 CUSTOM_CREDENTIAL=visible`,
        { secretNames: ['CUSTOM_CREDENTIAL'] },
    );
    for (const secret of ['top-secret', jwt, 'hunter2', 'abc123', 'visible']) {
        assert.equal(text.includes(secret), false, secret);
    }
    assert.match(text, /\[REDACTED\]/);
});

test('diagnostics redact before applying the hard output ceiling', () => {
    const secret = `credential-${'x'.repeat(DIAGNOSTIC_TEXT_LIMIT * 2)}`;
    const text = sanitizeDiagnosticText(`token=${secret}\n${'z'.repeat(DIAGNOSTIC_TEXT_LIMIT * 2)}`);
    assert.ok(text.length <= DIAGNOSTIC_TEXT_LIMIT);
    assert.equal(text.includes(secret), false);
});

test('diagnostics never serialize arbitrary objects, stacks, or environments', () => {
    const object = { message: 'safe', env: { PASSWORD: 'do-not-print' } };
    assert.equal(sanitizeDiagnosticText(object), 'An internal operation failed');
    const error = new Error('token=do-not-print');
    error.stack = 'stack with do-not-print-again';
    const text = sanitizeDiagnosticText(error);
    assert.equal(text.includes('do-not-print'), false);
    assert.equal(text.includes('stack with'), false);
});

test('control diagnostics cannot inject terminal lines or control bytes', () => {
    const text = sanitizeControlDiagnosticText(
        'first\r\nsecond\u001b[31m\u0000\u009b token=do-not-print',
    );
    assert.equal(text.includes('\r'), false);
    assert.equal(text.includes('\n'), false);
    assert.equal(text.includes('\u001b'), false);
    assert.equal(text.includes('\u0000'), false);
    assert.equal(text.includes('\u009b'), false);
    assert.equal(text.includes('do-not-print'), false);
    assert.match(text, /^first\?\?second\?\[31m\?/);
});
