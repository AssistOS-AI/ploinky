import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
    AUTHORITY_DIAGNOSTIC_LIMIT,
    authorityCommandFailure,
    sanitizeAuthorityDiagnostic,
} from '../../cli/sandbox/authorityCommandDiagnostics.mjs';

test('authority diagnostics redact before truncation and remove terminal escape sequences', () => {
    const secret = 'credential-canary'.repeat(300);
    const diagnostic = sanitizeAuthorityDiagnostic(
        `Error: permission denied\n{"api_\u001b[31mkey":"${secret}"}\n${'x'.repeat(5_000)}`,
    );
    assert.match(diagnostic, /^Error: permission denied/);
    assert.match(diagnostic, /REDACTED/);
    assert.doesNotMatch(diagnostic, /canary|\u001b|[\r\n]/);
    assert.equal(diagnostic.length, AUTHORITY_DIAGNOSTIC_LIMIT);
    assert.ok(diagnostic.endsWith('…'));
});

test('authority diagnostics mask known environment credentials even without their keys', (t) => {
    const name = 'PLOINKY_TEST_DIAGNOSTIC_SECRET';
    const previous = process.env[name];
    process.env[name] = 'opaque-environment-canary';
    t.after(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
    });
    const diagnostic = sanitizeAuthorityDiagnostic('Error: opaque-environment-canary was rejected');
    assert.equal(diagnostic, 'Error: [REDACTED] was rejected');
});

test('authority diagnostics preserve byte length and digest while bounding UTF-8 stderr', () => {
    const stderr = Buffer.from(`Error: ${'失敗'.repeat(3_000)}`);
    const message = authorityCommandFailure('inspect authority helper', { status: 125, stderr }, { timeout: 4_000 });
    assert.match(message, new RegExp(`"stderrBytes":${stderr.length}`));
    assert.ok(message.includes(crypto.createHash('sha256').update(stderr).digest('hex')));
    assert.ok(message.includes('失敗'));
    assert.ok(message.length < AUTHORITY_DIAGNOSTIC_LIMIT + 400);
});

test('empty and malformed stderr never serialize arbitrary objects or spawn arguments', () => {
    for (const stderr of ['', null, undefined, { toString() { throw new Error('must not be serialized'); } }]) {
        const error = Object.assign(new Error('command-argv-canary'), { code: 'ENOENT', spawnargs: ['secret-canary'] });
        const message = authorityCommandFailure('start authority helper', { error, stderr }, { timeout: 15_000 });
        assert.match(message, /"errorCode":"ENOENT"/);
        assert.match(message, /stderr: \(empty\)/);
        assert.doesNotMatch(message, /canary|spawnargs/);
    }
});

test('credential headers, quoted values, and truncated private keys stay redacted', () => {
    for (const input of [
        'Proxy-Authorization: Basic header-canary\nError: denied',
        'Cookie: session=cookie-canary; preference=theme\nError: denied',
        "--password 'quoted password canary' Error: denied",
        '{"client_secret":"escaped \\"credential canary"} Error: denied',
        'Error: password="prefix truncated canary',
        "password='prefix truncated canary\\",
        '{"password": {"value": "nested-canary"}}',
        '{"credentials": ["array-canary"]}',
        '-----BEGIN OPENSSH PRIVATE KEY-----\ntruncated-key-canary',
    ]) {
        const diagnostic = sanitizeAuthorityDiagnostic(input);
        assert.doesNotMatch(diagnostic, /canary/);
        assert.match(diagnostic, /REDACTED/);
    }
});

test('oversized stderr cannot stall diagnostics on long hyphenated tokens', () => {
    const moduleUrl = new URL('../../cli/sandbox/authorityCommandDiagnostics.mjs', import.meta.url).href;
    // spawnSync can collect an entire 64 KiB pipe chunk before enforcing an
    // 8 KiB maxBuffer. Bound this probe externally so a regex regression cannot
    // hang the test runner or conceal the original runtime failure.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { sanitizeAuthorityDiagnostic } from ${JSON.stringify(moduleUrl)};
        for (const text of ['x-'.repeat(32_768), 'eyJ-'.repeat(16_384)]) {
            const diagnostic = sanitizeAuthorityDiagnostic(text);
            assert.ok(diagnostic.length <= 2_000);
        }
    `], { encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL' });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
});
