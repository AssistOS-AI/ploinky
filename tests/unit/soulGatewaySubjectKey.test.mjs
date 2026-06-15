import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each test process gets an isolated workspace so the on-disk keypair store
// (.ploinky/soul_gateway_api_signing_ed25519_v1.enc) never collides with a real
// workspace and is torn down afterwards.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sgkey-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = 'f'.repeat(64);

const moduleSuffix = `?test=${Date.now()}`;
const {
    getOrCreateSoulGatewaySigningKeypair,
    getSoulGatewayPublicKey,
    buildSoulGatewayApiKey,
    verifySoulGatewayApiKey,
    SoulGatewayKeyError,
} = await import(`../../cli/services/soulGatewaySubjectKey.js${moduleSuffix}`);

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('getOrCreateSoulGatewaySigningKeypair persists and never returns the private key', () => {
    const first = getOrCreateSoulGatewaySigningKeypair();
    // The public handle is exposed; the private key must never be returned.
    assert.equal(typeof first.publicKey, 'string');
    assert.ok(first.publicKey.length > 0);
    assert.equal(first.privateKey, undefined);
    assert.equal(first.privateKeyPem, undefined);
    assert.equal(first.secretKey, undefined);
    // A backing encrypted file is written under .ploinky and is not world readable.
    const storePath = path.join(tempDir, '.ploinky', 'soul_gateway_api_signing_ed25519_v1.enc');
    assert.ok(fs.existsSync(storePath), 'expected the encrypted keypair store to exist');
    const mode = fs.statSync(storePath).mode & 0o777;
    assert.equal(mode, 0o600);
    // On-disk material is encrypted: the raw PKCS8 PEM marker must not appear.
    const onDisk = fs.readFileSync(storePath, 'utf8');
    assert.ok(!onDisk.includes('PRIVATE KEY'), 'private key must be encrypted at rest');
    // Idempotent: a second call loads the same public key, not a fresh keypair.
    const second = getOrCreateSoulGatewaySigningKeypair();
    assert.equal(second.publicKey, first.publicKey);
});

test('getSoulGatewayPublicKey is base64url without padding and round-trips back to a usable key', () => {
    const pub = getSoulGatewayPublicKey();
    assert.equal(typeof pub, 'string');
    // base64url alphabet only, and no padding.
    assert.match(pub, /^[A-Za-z0-9_-]+$/);
    assert.ok(!pub.includes('='), 'public key must not contain base64 padding');
    assert.ok(!pub.includes('+') && !pub.includes('/'), 'public key must be base64url, not standard base64');
    // Round trip: a key built under this public key verifies with the returned public key.
    const apiKey = buildSoulGatewayApiKey('user:roundtrip');
    const result = verifySoulGatewayApiKey(apiKey, pub);
    assert.equal(result.subjectId, 'user:roundtrip');
    assert.equal(result.subjectType, 'user');
});

test('buildSoulGatewayApiKey("agent:AssistOSExplorer/llmAssistant") is subjectId|signature and verifies', () => {
    const subjectId = 'agent:AssistOSExplorer/llmAssistant';
    const apiKey = buildSoulGatewayApiKey(subjectId);
    const pipeIndex = apiKey.indexOf('|');
    assert.ok(pipeIndex > 0, 'api key must contain a | delimiter');
    assert.equal(apiKey.slice(0, pipeIndex), subjectId);
    const signature = apiKey.slice(pipeIndex + 1);
    assert.match(signature, /^[A-Za-z0-9_-]+$/, 'signature must be base64url');
    assert.ok(!signature.includes('='), 'signature must not contain base64 padding');

    const result = verifySoulGatewayApiKey(apiKey, getSoulGatewayPublicKey());
    assert.deepEqual(result, { subjectId, subjectType: 'agent' });
});

test('buildSoulGatewayApiKey("user:123") verifies and reports subjectType user', () => {
    const apiKey = buildSoulGatewayApiKey('user:123');
    const result = verifySoulGatewayApiKey(apiKey, getSoulGatewayPublicKey());
    assert.deepEqual(result, { subjectId: 'user:123', subjectType: 'user' });
});

test('the signed payload is exactly the subjectId bytes (independently verifiable)', () => {
    // Reconstruct the raw public key from the base64url handle and verify the
    // signature directly with node:crypto over the exact UTF-8 subject bytes.
    const subjectId = 'agent:AssistOSExplorer/llmAssistant';
    const apiKey = buildSoulGatewayApiKey(subjectId);
    const signature = Buffer.from(apiKey.slice(apiKey.indexOf('|') + 1), 'base64url');
    const rawPub = Buffer.from(getSoulGatewayPublicKey(), 'base64url');
    assert.equal(rawPub.length, 32, 'public key handle must decode to the raw 32-byte Ed25519 key');
    const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, rawPub]);
    const keyObject = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    assert.equal(crypto.verify(null, Buffer.from(subjectId, 'utf8'), keyObject, signature), true);
    // The same signature must NOT validate over any other message.
    assert.equal(crypto.verify(null, Buffer.from(`${subjectId}x`, 'utf8'), keyObject, signature), false);
});

test('verifySoulGatewayApiKey(validKey, publicKey) returns subjectId and subjectType', () => {
    const apiKey = buildSoulGatewayApiKey('agent:repo/name');
    const result = verifySoulGatewayApiKey(apiKey, getSoulGatewayPublicKey());
    assert.deepEqual(result, { subjectId: 'agent:repo/name', subjectType: 'agent' });
});

test('verifySoulGatewayApiKey rejects a tampered subject (signature no longer matches)', () => {
    const apiKey = buildSoulGatewayApiKey('user:alice');
    const signature = apiKey.slice(apiKey.indexOf('|') + 1);
    const tampered = `user:bob|${signature}`;
    assert.throws(
        () => verifySoulGatewayApiKey(tampered, getSoulGatewayPublicKey()),
        (err) => err instanceof SoulGatewayKeyError && err.code === 'SIGNATURE_INVALID',
    );
});

test('verifySoulGatewayApiKey rejects a tampered signature', () => {
    const apiKey = buildSoulGatewayApiKey('user:alice');
    const pipeIndex = apiKey.indexOf('|');
    const subjectId = apiKey.slice(0, pipeIndex);
    const signature = Buffer.from(apiKey.slice(pipeIndex + 1), 'base64url');
    // Flip the first byte of the signature.
    signature[0] ^= 0xff;
    const tampered = `${subjectId}|${signature.toString('base64url')}`;
    assert.throws(
        () => verifySoulGatewayApiKey(tampered, getSoulGatewayPublicKey()),
        (err) => err instanceof SoulGatewayKeyError && err.code === 'SIGNATURE_INVALID',
    );
});

test('verifySoulGatewayApiKey("subject-without-delimiter", publicKey) rejects', () => {
    assert.throws(
        () => verifySoulGatewayApiKey('subject-without-delimiter', getSoulGatewayPublicKey()),
        (err) => err instanceof SoulGatewayKeyError && err.code === 'MALFORMED_API_KEY',
    );
});

test('verifySoulGatewayApiKey("agent:a|sig|extra", publicKey) rejects on extra delimiter', () => {
    assert.throws(
        () => verifySoulGatewayApiKey('agent:a|sig|extra', getSoulGatewayPublicKey()),
        (err) => err instanceof SoulGatewayKeyError && err.code === 'MALFORMED_API_KEY',
    );
});

test('public-key base64url round trip is stable across encode/decode', () => {
    const pub = getSoulGatewayPublicKey();
    const raw = Buffer.from(pub, 'base64url');
    assert.equal(raw.length, 32);
    // Re-encoding the decoded bytes reproduces the exact handle (canonical form).
    assert.equal(raw.toString('base64url'), pub);
});

test('buildSoulGatewayApiKey rejects a user: id containing a slash', () => {
    assert.throws(
        () => buildSoulGatewayApiKey('user:ab/cd'),
        (err) => err instanceof SoulGatewayKeyError && err.code === 'INVALID_SUBJECT',
    );
});

test('buildSoulGatewayApiKey rejects an agent: id with zero slashes', () => {
    assert.throws(
        () => buildSoulGatewayApiKey('agent:repoonly'),
        (err) => err instanceof SoulGatewayKeyError && err.code === 'INVALID_SUBJECT',
    );
});

test('buildSoulGatewayApiKey rejects an agent: id with two slashes', () => {
    assert.throws(
        () => buildSoulGatewayApiKey('agent:repo/sub/name'),
        (err) => err instanceof SoulGatewayKeyError && err.code === 'INVALID_SUBJECT',
    );
});

test('buildSoulGatewayApiKey rejects whitespace in the subject', () => {
    for (const bad of ['user:al ice', 'agent:repo /name', 'agent:repo/na me', ' user:alice', 'user:alice ', 'user:al\tice']) {
        assert.throws(
            () => buildSoulGatewayApiKey(bad),
            (err) => err instanceof SoulGatewayKeyError && err.code === 'INVALID_SUBJECT',
            `expected whitespace subject to be rejected: ${JSON.stringify(bad)}`,
        );
    }
});

test('buildSoulGatewayApiKey rejects non-string input', () => {
    for (const bad of [null, undefined, 123, {}, [], true, Symbol('x')]) {
        assert.throws(
            () => buildSoulGatewayApiKey(bad),
            (err) => err instanceof SoulGatewayKeyError && err.code === 'INVALID_SUBJECT',
            `expected non-string subject to be rejected: ${String(bad)}`,
        );
    }
});

test('buildSoulGatewayApiKey rejects empty segments', () => {
    for (const bad of ['agent:/name', 'agent:repo/', 'agent:/', 'user:', 'agent:', 'user', 'agent', '', ':', 'agent::x']) {
        assert.throws(
            () => buildSoulGatewayApiKey(bad),
            (err) => err instanceof SoulGatewayKeyError && err.code === 'INVALID_SUBJECT',
            `expected empty-segment subject to be rejected: ${JSON.stringify(bad)}`,
        );
    }
});

test('buildSoulGatewayApiKey rejects an unknown subject prefix', () => {
    for (const bad of ['service:foo', 'admin:root', 'foo:bar', 'AGENT:repo/name', 'USER:1']) {
        assert.throws(
            () => buildSoulGatewayApiKey(bad),
            (err) => err instanceof SoulGatewayKeyError && err.code === 'INVALID_SUBJECT',
            `expected unknown prefix to be rejected: ${JSON.stringify(bad)}`,
        );
    }
});

test('verifySoulGatewayApiKey rejects a structurally valid key whose subject is invalid', () => {
    // Hand-craft "<invalid subject>|<valid-looking base64url>" so that parsing
    // succeeds on shape but subject validation must still reject before/at verify.
    const fakeSig = Buffer.alloc(64, 7).toString('base64url');
    assert.throws(
        () => verifySoulGatewayApiKey(`service:foo|${fakeSig}`, getSoulGatewayPublicKey()),
        (err) => err instanceof SoulGatewayKeyError && err.code === 'INVALID_SUBJECT',
    );
});

test('verifySoulGatewayApiKey rejects a non-string api key and a non-string public key', () => {
    const validKey = buildSoulGatewayApiKey('user:x');
    assert.throws(
        () => verifySoulGatewayApiKey(42, getSoulGatewayPublicKey()),
        (err) => err instanceof SoulGatewayKeyError && err.code === 'MALFORMED_API_KEY',
    );
    assert.throws(
        () => verifySoulGatewayApiKey(validKey, 12345),
        (err) => err instanceof SoulGatewayKeyError && err.code === 'INVALID_PUBLIC_KEY',
    );
});

test('verifySoulGatewayApiKey rejects an empty signature segment', () => {
    assert.throws(
        () => verifySoulGatewayApiKey('user:x|', getSoulGatewayPublicKey()),
        (err) => err instanceof SoulGatewayKeyError && err.code === 'MALFORMED_API_KEY',
    );
});

test('verifySoulGatewayApiKey under a different public key rejects', () => {
    const apiKey = buildSoulGatewayApiKey('user:x');
    // A freshly generated, unrelated Ed25519 public key in the same serialization.
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const rawOther = publicKey.export({ format: 'jwk' }).x; // base64url already
    assert.throws(
        () => verifySoulGatewayApiKey(apiKey, rawOther),
        (err) => err instanceof SoulGatewayKeyError && err.code === 'SIGNATURE_INVALID',
    );
});
