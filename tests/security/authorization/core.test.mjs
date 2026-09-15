import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, TARGET, assertDenied, assertPrincipal, safeError, validateTarget, responseSummary } from './core.mjs';
import { assertResourceDenied } from './resource-probes.mjs';

for (const target of ['https://skills.axiologic.dev', 'http://localhost:8080', 'http://127.0.0.1:8081', 'http://127.0.0.1:8080/', 'http://127.0.0.1:8080@evil.invalid', 'http://2130706433:8080', 'http://[::1]:8080', '', undefined]) {
    test(`target guard rejects non-exact target ${String(target)}`, () => assert.throws(() => validateTarget(target)));
}
test('exact selected Router is admitted', () => assert.equal(validateTarget(TARGET).origin, TARGET));
for (const status of [200, 204, 301, 302, 303, 307, 308, 400, 404, 405, 500, 502, 503, 504]) {
    test(`status ${status} cannot masquerade as authorization denial`, () => assert.throws(() => assertDenied({ status, json: { error: 'forbidden' } })));
}
test('HTML login body on 403 cannot masquerade as denial', () => assert.throws(() => assertDenied({ status: 403, text: '<html>login</html>' })));
test('positive payload cannot masquerade as denial', () => assert.throws(() => assertDenied({ status: 403, json: { ok: true, error: 'forbidden' } })));
test('explicit structured permission refusal is admitted', () => assert.doesNotThrow(() => assertDenied({ status: 403, json: { ok: false, error: 'admin_required' } })));
for (const payload of [{}, { user: { id: 'p', roles: ['guest'] } }, { user: { id: 'p', roles: ['user'] } }, { user: { id: 'other', roles: ['selfRegistered'] } }]) {
    test(`wrong principal is rejected ${JSON.stringify(payload)}`, () => assert.throws(() => assertPrincipal(payload, 'selfRegistered', 'p')));
}
test('verified selfRegistered accepted only with correct identity', () => assert.equal(assertPrincipal({ user: { id: 'p', roles: ['selfRegistered'] } }, 'selfRegistered', 'p').id, 'p'));
test('MCP missing object and malformed request are not denials', () => {
    for (const status of [200, 400, 404, 503]) assert.throws(() => assertResourceDenied({ failed: true, response: { status }, value: { error: 'not found' }, error: 'not found' }, 'probe'));
});
test('MCP leaking protected marker fails even with forbidden status', () => assert.throws(() => assertResourceDenied({ failed: true, response: { status: 403 }, value: { error: 'forbidden', content: 'fixture-marker' }, error: 'forbidden' }, 'probe', 'fixture-marker')));
test('MCP success with denial-looking content is rejected', () => assert.throws(() => assertResourceDenied({ failed: false, response: { status: 200 }, value: { result: 'forbidden' }, error: 'forbidden' }, 'probe')));
test('MCP HTTP 403 requires a structured authorization error', () => {
    for (const response of [{ status: 403 }, { status: 403, text: '<html>login</html>' }, { status: 403, json: { error: 'storage_full' } }]) {
        assert.throws(() => assertResourceDenied({ failed: true, response, value: undefined, error: '' }, 'probe'));
    }
});
test('summary omits response payload, headers, credentials and arbitrary errors', () => {
    const summary = responseSummary({ status: 200, text: 'private-cookie-value', json: { token: 'private-token', error: 'eyJsecret/unsafe' }, headers: { 'set-cookie': ['secret'], 'content-type': 'application/json' } });
    assert.equal(summary.error, undefined);
    assert.ok(!JSON.stringify(summary).includes('private'));
    assert.equal(summary.sha256.length, 64);
});
test('error sanitizer handles regex metacharacters and overlapping exact secrets', () => assert.equal(safeError(new Error('a.$[secret] abcdefghi abcdef 123456'), ['a.$[secret]', 'abcdef', 'abcdefghi']), '[private] [private] [private] [code]'));
test('client rejects header delimiter path before networking or mutation', async () => {
    let mutated = false;
    const client = new Client([], { beforeMutation: async () => { mutated = true; } });
    await assert.rejects(() => client.request({ path: '/x\r\nHost: evil', method: 'POST' }));
    assert.equal(mutated, false);
});
