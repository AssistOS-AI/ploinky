// W9: the cause sanitizer (authorityCommandDiagnostics.mjs) redacts a credential-named word followed by a value, so a
// product message such as "MPS lifecycle authorization changed" read "authorization=[REDACTED]". The shared sanitizer is
// not weakened; the product's messages avoid the pattern, and this scan keeps them that way.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { describeApplyCause } from '../../cli/sandbox/hardwareLimits/applyCause.mjs';
import { sanitizeAuthorityDiagnostic } from '../../cli/sandbox/authorityCommandDiagnostics.mjs';
import { validateStoreToken } from '../../cli/sandbox/hardwareLimits/store.mjs';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'sandbox', 'hardwareLimits');

test('W9.the-reworded-lifecycle-and-store-messages-survive-the-cause-sanitizer-intact', () => {
    for (const message of ['The MPS lifecycle authority changed', 'the policy stamp must be {epoch:128-bit hex, revision:positive integer}', 'lock owner stamp is invalid']) {
        assert.equal(describeApplyCause(new Error(message)).message, message, message);
    }
    // The reworded text is what the product throws.
    let thrown; try { validateStoreToken({ epoch: 'x', revision: 0 }); } catch (error) { thrown = error; }
    assert.ok(thrown, 'the store refuses a malformed stamp'); assert.equal(describeApplyCause(thrown).message.includes('[REDACTED]'), false, thrown.message);
    // The shared sanitizer still redacts a real credential (it is not weakened).
    assert.equal(sanitizeAuthorityDiagnostic('authorization changed'), 'authorization=[REDACTED]');
    assert.match(sanitizeAuthorityDiagnostic('token=abc123 and password: hunter2'), /token=\[REDACTED\].*password=\[REDACTED\]/);
});

test('W9.no-error-text-of-the-hardware-limits-code-trips-the-sanitizer', () => {
    const offenders = [];
    for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.mjs'))) {
        const source = fs.readFileSync(path.join(directory, file), 'utf8');
        // The literal text of every Error, failure(code, text), fail(text) and schemaFail(text) call.
        for (const match of source.matchAll(/(?:Error|failure|fail|schemaFail|MpsError|HardwareStoreError)\(\s*(?:'[a-z_]+',\s*)?(['`])((?:\\.|(?!\1).)+)\1/g)) {
            const text = match[2].replace(/\$\{[^}]*\}/g, 'x');
            const sanitized = sanitizeAuthorityDiagnostic(text, { limit: 600 });
            if (sanitized !== text.slice(0, 600) && /\[REDACTED\]/.test(sanitized)) offenders.push(`${file}: ${text.slice(0, 90)}`);
        }
    }
    assert.deepEqual(offenders, [], 'these messages read "[REDACTED]" in a cause; reword them');
});
