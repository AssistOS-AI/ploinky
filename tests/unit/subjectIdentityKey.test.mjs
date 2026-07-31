import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each test process gets an isolated workspace so the on-disk keypair store
// (.ploinky/ploinky_subject_identity_ed25519_v1.enc) never collides with a real
// workspace and is torn down afterwards.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sgkey-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = 'f'.repeat(64);

const moduleSuffix = `?test=${Date.now()}`;
const {
    getOrCreateIdentitySigningKeypair,
    getSubjectIdentityPublicKey,
    buildSubjectIdentityKey,
    verifySubjectIdentityKey,
    signGeneratedRouterDescriptor,
    verifyGeneratedRouterDescriptorSignature,
    SubjectIdentityKeyError,
} = await import(`../../cli/utils/security/subjectIdentityKey.js${moduleSuffix}`);
const { canonicalJsonBytes } = await import(`../../cli/utils/security/generatedRouterDescriptor.js${moduleSuffix}`);

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('getOrCreateIdentitySigningKeypair persists and never returns the private key', () => {
    const first = getOrCreateIdentitySigningKeypair();
    // The public handle is exposed; the private key must never be returned.
    assert.equal(typeof first.publicKey, 'string');
    assert.ok(first.publicKey.length > 0);
    assert.equal(first.privateKey, undefined);
    assert.equal(first.privateKeyPem, undefined);
    assert.equal(first.secretKey, undefined);
    // A backing encrypted file is written under .ploinky and is not world readable.
    const storePath = path.join(tempDir, '.ploinky', 'ploinky_subject_identity_ed25519_v1.enc');
    assert.ok(fs.existsSync(storePath), 'expected the encrypted keypair store to exist');
    const mode = fs.statSync(storePath).mode & 0o777;
    assert.equal(mode, 0o600);
    // On-disk material is encrypted: the raw PKCS8 PEM marker must not appear.
    const onDisk = fs.readFileSync(storePath, 'utf8');
    assert.ok(!onDisk.includes('PRIVATE KEY'), 'private key must be encrypted at rest');
    // Idempotent: a second call loads the same public key, not a fresh keypair.
    const second = getOrCreateIdentitySigningKeypair();
    assert.equal(second.publicKey, first.publicKey);
});

test('getSubjectIdentityPublicKey is base64url without padding and round-trips back to a usable key', () => {
    const pub = getSubjectIdentityPublicKey();
    assert.equal(typeof pub, 'string');
    // base64url alphabet only, and no padding.
    assert.match(pub, /^[A-Za-z0-9_-]+$/);
    assert.ok(!pub.includes('='), 'public key must not contain base64 padding');
    assert.ok(!pub.includes('+') && !pub.includes('/'), 'public key must be base64url, not standard base64');
    // Round trip: a key built under this public key verifies with the returned public key.
    const apiKey = buildSubjectIdentityKey('user:roundtrip');
    const result = verifySubjectIdentityKey(apiKey, pub);
    assert.equal(result.subjectId, 'user:roundtrip');
    assert.equal(result.subjectType, 'user');
});

test('buildSubjectIdentityKey("agent:AssistOSExplorer/llmAssistant") is subjectId|signature and verifies', () => {
    const subjectId = 'agent:AssistOSExplorer/llmAssistant';
    const apiKey = buildSubjectIdentityKey(subjectId);
    const pipeIndex = apiKey.indexOf('|');
    assert.ok(pipeIndex > 0, 'api key must contain a | delimiter');
    assert.equal(apiKey.slice(0, pipeIndex), subjectId);
    const signature = apiKey.slice(pipeIndex + 1);
    assert.match(signature, /^[A-Za-z0-9_-]+$/, 'signature must be base64url');
    assert.ok(!signature.includes('='), 'signature must not contain base64 padding');

    const result = verifySubjectIdentityKey(apiKey, getSubjectIdentityPublicKey());
    assert.deepEqual(result, { subjectId, subjectType: 'agent' });
});

test('buildSubjectIdentityKey("user:123") verifies and reports subjectType user', () => {
    const apiKey = buildSubjectIdentityKey('user:123');
    const result = verifySubjectIdentityKey(apiKey, getSubjectIdentityPublicKey());
    assert.deepEqual(result, { subjectId: 'user:123', subjectType: 'user' });
});

test('the signed payload is exactly the subjectId bytes (independently verifiable)', () => {
    // Reconstruct the raw public key from the base64url handle and verify the
    // signature directly with node:crypto over the exact UTF-8 subject bytes.
    const subjectId = 'agent:AssistOSExplorer/llmAssistant';
    const apiKey = buildSubjectIdentityKey(subjectId);
    const signature = Buffer.from(apiKey.slice(apiKey.indexOf('|') + 1), 'base64url');
    const rawPub = Buffer.from(getSubjectIdentityPublicKey(), 'base64url');
    assert.equal(rawPub.length, 32, 'public key handle must decode to the raw 32-byte Ed25519 key');
    const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, rawPub]);
    const keyObject = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    assert.equal(crypto.verify(null, Buffer.from(subjectId, 'utf8'), keyObject, signature), true);
    // The same signature must NOT validate over any other message.
    assert.equal(crypto.verify(null, Buffer.from(`${subjectId}x`, 'utf8'), keyObject, signature), false);
});

test('generated Router descriptors use the frozen domain-separated signature vector', () => {
    const fixtureRoot = path.join(originalCwd, 'tests', 'fixtures', 'router-descriptor');
    const envelope = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'public-envelope.json'), 'utf8'));
    const environment = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'public-environment.json'), 'utf8'));
    const payloadBytes = canonicalJsonBytes(envelope.payload);

    assert.equal(
        verifyGeneratedRouterDescriptorSignature(
            payloadBytes,
            envelope.signature,
            environment.PLOINKY_AGENT_API_PUBLIC_KEY,
        ),
        true,
    );
    assert.equal(
        verifyGeneratedRouterDescriptorSignature(
            Buffer.concat([payloadBytes, Buffer.from(' ')]),
            envelope.signature,
            environment.PLOINKY_AGENT_API_PUBLIC_KEY,
        ),
        false,
    );
});

test('generated Router descriptor signer exposes only a canonical signature string', () => {
    const payload = Buffer.from('{"test":true}', 'utf8');
    const signature = signGeneratedRouterDescriptor(payload);
    assert.match(signature, /^[A-Za-z0-9_-]+$/);
    assert.equal(Buffer.from(signature, 'base64url').length, 64);
    assert.equal(
        verifyGeneratedRouterDescriptorSignature(payload, signature, getSubjectIdentityPublicKey()),
        true,
    );
});

test('generated Router descriptor verification rejects malformed signature and trust anchor encodings', () => {
    const payload = Buffer.from('{}', 'utf8');
    assert.throws(
        () => verifyGeneratedRouterDescriptorSignature(payload, 'AA', getSubjectIdentityPublicKey()),
        (error) => error instanceof SubjectIdentityKeyError && error.code === 'MALFORMED_DESCRIPTOR_SIGNATURE',
    );
    const signature = signGeneratedRouterDescriptor(payload);
    assert.throws(
        () => verifyGeneratedRouterDescriptorSignature(payload, signature, 'AA'),
        (error) => error instanceof SubjectIdentityKeyError && error.code === 'INVALID_PUBLIC_KEY',
    );
});

test('verifySubjectIdentityKey(validKey, publicKey) returns subjectId and subjectType', () => {
    const apiKey = buildSubjectIdentityKey('agent:repo/name');
    const result = verifySubjectIdentityKey(apiKey, getSubjectIdentityPublicKey());
    assert.deepEqual(result, { subjectId: 'agent:repo/name', subjectType: 'agent' });
});

test('verifySubjectIdentityKey rejects a tampered subject (signature no longer matches)', () => {
    const apiKey = buildSubjectIdentityKey('user:alice');
    const signature = apiKey.slice(apiKey.indexOf('|') + 1);
    const tampered = `user:bob|${signature}`;
    assert.throws(
        () => verifySubjectIdentityKey(tampered, getSubjectIdentityPublicKey()),
        (err) => err instanceof SubjectIdentityKeyError && err.code === 'SIGNATURE_INVALID',
    );
});

test('verifySubjectIdentityKey rejects a tampered signature', () => {
    const apiKey = buildSubjectIdentityKey('user:alice');
    const pipeIndex = apiKey.indexOf('|');
    const subjectId = apiKey.slice(0, pipeIndex);
    const signature = Buffer.from(apiKey.slice(pipeIndex + 1), 'base64url');
    // Flip the first byte of the signature.
    signature[0] ^= 0xff;
    const tampered = `${subjectId}|${signature.toString('base64url')}`;
    assert.throws(
        () => verifySubjectIdentityKey(tampered, getSubjectIdentityPublicKey()),
        (err) => err instanceof SubjectIdentityKeyError && err.code === 'SIGNATURE_INVALID',
    );
});

test('verifySubjectIdentityKey("subject-without-delimiter", publicKey) rejects', () => {
    assert.throws(
        () => verifySubjectIdentityKey('subject-without-delimiter', getSubjectIdentityPublicKey()),
        (err) => err instanceof SubjectIdentityKeyError && err.code === 'MALFORMED_API_KEY',
    );
});

test('verifySubjectIdentityKey("agent:a|sig|extra", publicKey) rejects on extra delimiter', () => {
    assert.throws(
        () => verifySubjectIdentityKey('agent:a|sig|extra', getSubjectIdentityPublicKey()),
        (err) => err instanceof SubjectIdentityKeyError && err.code === 'MALFORMED_API_KEY',
    );
});

test('public-key base64url round trip is stable across encode/decode', () => {
    const pub = getSubjectIdentityPublicKey();
    const raw = Buffer.from(pub, 'base64url');
    assert.equal(raw.length, 32);
    // Re-encoding the decoded bytes reproduces the exact handle (canonical form).
    assert.equal(raw.toString('base64url'), pub);
});

test('buildSubjectIdentityKey rejects a user: id containing a slash', () => {
    assert.throws(
        () => buildSubjectIdentityKey('user:ab/cd'),
        (err) => err instanceof SubjectIdentityKeyError && err.code === 'INVALID_SUBJECT',
    );
});

test('buildSubjectIdentityKey rejects an agent: id with zero slashes', () => {
    assert.throws(
        () => buildSubjectIdentityKey('agent:repoonly'),
        (err) => err instanceof SubjectIdentityKeyError && err.code === 'INVALID_SUBJECT',
    );
});

test('buildSubjectIdentityKey rejects an agent: id with two slashes', () => {
    assert.throws(
        () => buildSubjectIdentityKey('agent:repo/sub/name'),
        (err) => err instanceof SubjectIdentityKeyError && err.code === 'INVALID_SUBJECT',
    );
});

test('buildSubjectIdentityKey rejects whitespace in the subject', () => {
    for (const bad of ['user:al ice', 'agent:repo /name', 'agent:repo/na me', ' user:alice', 'user:alice ', 'user:al\tice']) {
        assert.throws(
            () => buildSubjectIdentityKey(bad),
            (err) => err instanceof SubjectIdentityKeyError && err.code === 'INVALID_SUBJECT',
            `expected whitespace subject to be rejected: ${JSON.stringify(bad)}`,
        );
    }
});

test('buildSubjectIdentityKey rejects non-string input', () => {
    for (const bad of [null, undefined, 123, {}, [], true, Symbol('x')]) {
        assert.throws(
            () => buildSubjectIdentityKey(bad),
            (err) => err instanceof SubjectIdentityKeyError && err.code === 'INVALID_SUBJECT',
            `expected non-string subject to be rejected: ${String(bad)}`,
        );
    }
});

test('buildSubjectIdentityKey rejects empty segments', () => {
    for (const bad of ['agent:/name', 'agent:repo/', 'agent:/', 'user:', 'agent:', 'user', 'agent', '', ':', 'agent::x']) {
        assert.throws(
            () => buildSubjectIdentityKey(bad),
            (err) => err instanceof SubjectIdentityKeyError && err.code === 'INVALID_SUBJECT',
            `expected empty-segment subject to be rejected: ${JSON.stringify(bad)}`,
        );
    }
});

test('buildSubjectIdentityKey rejects an unknown subject prefix', () => {
    for (const bad of ['service:foo', 'admin:root', 'foo:bar', 'AGENT:repo/name', 'USER:1']) {
        assert.throws(
            () => buildSubjectIdentityKey(bad),
            (err) => err instanceof SubjectIdentityKeyError && err.code === 'INVALID_SUBJECT',
            `expected unknown prefix to be rejected: ${JSON.stringify(bad)}`,
        );
    }
});

test('verifySubjectIdentityKey rejects a structurally valid key whose subject is invalid', () => {
    // Hand-craft "<invalid subject>|<valid-looking base64url>" so that parsing
    // succeeds on shape but subject validation must still reject before/at verify.
    const fakeSig = Buffer.alloc(64, 7).toString('base64url');
    assert.throws(
        () => verifySubjectIdentityKey(`service:foo|${fakeSig}`, getSubjectIdentityPublicKey()),
        (err) => err instanceof SubjectIdentityKeyError && err.code === 'INVALID_SUBJECT',
    );
});

test('verifySubjectIdentityKey rejects a non-string api key and a non-string public key', () => {
    const validKey = buildSubjectIdentityKey('user:x');
    assert.throws(
        () => verifySubjectIdentityKey(42, getSubjectIdentityPublicKey()),
        (err) => err instanceof SubjectIdentityKeyError && err.code === 'MALFORMED_API_KEY',
    );
    assert.throws(
        () => verifySubjectIdentityKey(validKey, 12345),
        (err) => err instanceof SubjectIdentityKeyError && err.code === 'INVALID_PUBLIC_KEY',
    );
});

test('verifySubjectIdentityKey rejects an empty signature segment', () => {
    assert.throws(
        () => verifySubjectIdentityKey('user:x|', getSubjectIdentityPublicKey()),
        (err) => err instanceof SubjectIdentityKeyError && err.code === 'MALFORMED_API_KEY',
    );
});

test('verifySubjectIdentityKey under a different public key rejects', () => {
    const apiKey = buildSubjectIdentityKey('user:x');
    // A freshly generated, unrelated Ed25519 public key in the same serialization.
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const rawOther = publicKey.export({ format: 'jwk' }).x; // base64url already
    assert.throws(
        () => verifySubjectIdentityKey(apiKey, rawOther),
        (err) => err instanceof SubjectIdentityKeyError && err.code === 'SIGNATURE_INVALID',
    );
});
