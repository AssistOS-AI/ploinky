import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { Client, collectSecrets, runVerdict, validateArtifactRoots } from './core.mjs';
import { matchesInventory, coverageRows, writeCoverage } from './coverage.mjs';
import { armPrincipalCleanup } from './principals.mjs';

const report = () => ({ counts: { PASS: 1, FAIL: 0, ERROR: 0 }, cleanup: [], gaps: [], finalOwnership: 'PASS' });
test('final ownership failure, interruption and zero assertions cannot produce passing run', () => {
    for (const changed of [{ finalOwnership: 'mismatch' }, { interrupted: 'SIGINT' }, { setupError: 'setup' }, { counts: { PASS: 0, FAIL: 0, ERROR: 0 } }, { cleanup: [{ status: 'FAIL' }] }]) assert.equal(runVerdict({ ...report(), ...changed }), 'ERROR');
    assert.equal(runVerdict({ ...report(), counts: { PASS: 1, FAIL: 1, ERROR: 0 } }), 'FAIL');
    assert.equal(runVerdict({ ...report(), gaps: [{ id: 'unavailable' }] }), 'NO_FAILURES_WITH_GAPS');
    assert.equal(runVerdict(report()), 'PASS');
});
test('artifact validation rejects symlink into source and nested private/public roots', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authz-selftest-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    await fs.mkdir(source);
    await fs.symlink(source, path.join(root, 'link'));
    await assert.rejects(() => validateArtifactRoots(source, path.join(root, 'link'), path.join(root, 'private')));
    await assert.rejects(() => validateArtifactRoots(source, path.join(root, 'output'), path.join(root, 'output', 'private')));
    const result = await validateArtifactRoots(source, path.join(root, 'a'), path.join(root, 'b'));
    assert.equal(result.length, 2);
});
test('artifact validation rejects source ancestors and missing leaves under source symlinks without creating them', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authz-selftest-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    await fs.mkdir(source);
    await fs.symlink(source, path.join(root, 'link'));
    await assert.rejects(() => validateArtifactRoots(source, root, path.join(root, 'private')));
    await assert.rejects(() => validateArtifactRoots(source, path.join(root, 'link', 'new'), path.join(root, 'private')));
    assert.deepEqual(await fs.readdir(source), []);
    await assert.rejects(fs.stat(path.join(root, 'private')), { code: 'ENOENT' });
});
test('a fresh output directory cannot reuse or truncate prior private artifacts', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authz-selftest-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    const privateRoot = path.join(root, 'private');
    await fs.mkdir(source);
    await fs.mkdir(privateRoot);
    await fs.writeFile(path.join(privateRoot, 'response-1.json'), 'previous-private-evidence');
    await assert.rejects(() => validateArtifactRoots(source, path.join(root, 'output'), privateRoot), /must be new/);
    assert.equal(await fs.readFile(path.join(privateRoot, 'response-1.json'), 'utf8'), 'previous-private-evidence');
    await assert.rejects(fs.stat(path.join(root, 'output')), { code: 'ENOENT' });
});
test('coverage export cannot follow an existing output-file symlink', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authz-selftest-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const output = path.join(root, 'export');
    const protectedFile = path.join(root, 'protected.txt');
    await fs.mkdir(output);
    await fs.writeFile(protectedFile, 'preserve-me');
    await fs.symlink(protectedFile, path.join(output, 'endpoint-coverage.json'));
    await assert.rejects(() => writeCoverage(output), { code: 'EEXIST' });
    assert.equal(await fs.readFile(protectedFile, 'utf8'), 'preserve-me');
});
function registrationFixture() {
    const ctx = { prefix: 'authz-selftest', rows: [], cleanups: [], deleted: [], cleanup(fn) { this.cleanups.push(fn); },
        async request(actor, request) {
            assert.equal(actor, 'admin');
            if (request.method === 'DELETE') { this.deleted.push(request.path); return { status: 200, json: { deleted: true } }; }
            return { status: 200, json: { users: this.rows } };
        } };
    return ctx;
}
test('registration interrupted after account creation still blocks the exact fresh account', async () => {
    const ctx = registrationFixture();
    await armPrincipalCleanup(ctx, 'authz-selftest-usera@example.test');
    ctx.rows = [{ id: 'fresh-account', email: 'authz-selftest-usera@example.test' }, { id: 'unrelated', email: 'different@example.test' }];
    // No successful browser redirect/token and no remembered ID.
    await ctx.cleanups[0]();
    assert.deepEqual(ctx.deleted, ['/api/agents/explorer/users/fresh-account']);
});
test('registration cleanup never adopts a preexisting or changed identity', async () => {
    const ctx = registrationFixture();
    const email = 'authz-selftest-usera@example.test';
    ctx.rows = [{ id: 'preexisting', email }];
    await assert.rejects(() => armPrincipalCleanup(ctx, email), /preexisting/);
    assert.equal(ctx.cleanups.length, 0);
    ctx.rows = [];
    const remember = await armPrincipalCleanup(ctx, email);
    remember('fresh');
    ctx.rows = [{ id: 'different-id', email }];
    await assert.rejects(() => ctx.cleanups[0](), /identity changed/);
    assert.deepEqual(ctx.deleted, []);
});
test('registration failing before account allocation needs no account deletion', async () => {
    const ctx = registrationFixture();
    await armPrincipalCleanup(ctx, 'authz-selftest-usera@example.test');
    await ctx.cleanups[0]();
    assert.deepEqual(ctx.deleted, []);
});
test('hard wall deadline rejects a perpetually trickling mocked response', async t => {
    let interval;
    const request = new PassThrough();
    request.setTimeout = () => request;
    request.end = () => {};
    t.mock.method(http, 'request', (_options, receive) => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        setImmediate(() => { receive(response); interval = setInterval(() => response.write('x'), 2); });
        return request;
    });
    t.after(() => clearInterval(interval));
    await assert.rejects(() => new Client().request({ path: '/never-complete', timeout: 40 }), /wall-clock timeout/);
});
test('raw path reaches HTTP without normalization and redirects are returned unchanged', async t => {
    let seen;
    t.mock.method(http, 'request', (options, receive) => {
        seen = options;
        const request = new PassThrough();
        request.setTimeout = () => request;
        request.end = () => setImmediate(() => { const res = new PassThrough(); res.statusCode = 302; res.headers = { location: 'https://external.invalid' }; receive(res); res.end('<html>login</html>'); });
        return request;
    });
    const response = await new Client().request({ path: '/api//agents/x/../%75sers' });
    assert.equal(seen.hostname, '127.0.0.1');
    assert.equal(seen.path, '/api//agents/x/../%75sers');
    assert.equal(response.status, 302);
});
test('nested MCP credential strings are collected without logging values', () => {
    const secrets = new Set();
    collectSecrets({ result: { content: [{ type: 'text', text: JSON.stringify({ accessToken: 'sensitive-value', nested: { csrfToken: 'csrf-private' } }) }] } }, secrets);
    assert.ok(secrets.has('sensitive-value') && secrets.has('csrf-private'));
});
test('tools/list and another tool cannot satisfy exact invocation inventory coverage', () => {
    const row = { method: 'POST', path: '/agent/mcp', tool: 'dangerous' };
    assert.equal(matchesInventory(row, { method: 'POST', path: '/agent/mcp', rpcMethod: 'tools/list' }), false);
    assert.equal(matchesInventory(row, { method: 'POST', path: '/agent/mcp', rpcMethod: 'tools/call', tool: 'safe' }), false);
    assert.equal(matchesInventory(row, { method: 'POST', path: '/agent/mcp', rpcMethod: 'tools/call', tool: 'dangerous' }), true);
    assert.ok(coverageRows().every(row => row.coverage === 'NOT_EXERCISED' && !row.completeAuthorizationCoverage));
});
