import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { PLOINKY_DIR } from './config.js';
import { deriveSubkey, resolveMasterKey as resolveConfiguredMasterKey } from './masterKey.js';

// Signed-subject identity key primitive.
//
// Mints Ploinky-issued API keys of the exact shape `subjectId|sign(subjectId)`
// where the signature is an Ed25519 signature over the *exact UTF-8 bytes of
// subjectId and nothing else* (no timestamps, nonces, or scopes). The signing
// (private) key is generated and stored locally by Ploinky and never leaves the
// process: only `getOrCreateIdentitySigningKeypair()` ever holds it, and no
// function returns it to callers. The matching public key is what consumers
// verify against.
//
// Storage uses an AES-256-GCM envelope keyed by a HKDF subkey derived from the
// workspace master key via deriveSubkey(), written atomically with 0o600
// permissions under .ploinky/. The private key is therefore encrypted at rest
// and never persisted in plaintext.

const KEYPAIR_NAME = 'ploinky_subject_identity_ed25519_v1';
const KEYPAIR_STORE_FILE = path.join(PLOINKY_DIR, `${KEYPAIR_NAME}.enc`);
const STORE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
// Domain-separated derivation purpose; bumping the version segment rotates the
// at-rest encryption key without colliding with any other Ploinky subkey.
const SUBKEY_PURPOSE = `storage/${KEYPAIR_NAME}`;

// Fixed 12-byte DER prefix for an Ed25519 SubjectPublicKeyInfo (RFC 8410). A raw
// 32-byte Ed25519 public key is exactly these bytes followed by the key bytes,
// so we can serialize the public key as the raw 32 bytes (base64url) and rebuild
// a usable KeyObject by re-prepending this prefix. Keep encode/decode symmetric.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PUBLIC_KEY_BYTES = 32;

// Separate validators per subject type. Each is anchored end-to-end so a single
// extra delimiter, whitespace, or empty segment fails the match. The allowed
// segment alphabet excludes both '/' and '|' so an agent id can never smuggle a
// second repo/name slash and a user id can never contain a slash.
const SEGMENT = '[A-Za-z0-9._:-]+';
const AGENT_SUBJECT_RE = new RegExp(`^agent:(${SEGMENT})/(${SEGMENT})$`);
const USER_SUBJECT_RE = new RegExp(`^user:(${SEGMENT})$`);

// Typed error so callers can distinguish validation, parse, and verification
// failures by `code` rather than by string-matching messages.
class SubjectIdentityKeyError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SubjectIdentityKeyError';
        this.code = code;
    }
}

function resolveKeypairStoreFile() {
    return KEYPAIR_STORE_FILE;
}

function getStorageKey() {
    // Requires PLOINKY_MASTER_KEY; resolveMasterKey throws a clear error if absent.
    resolveConfiguredMasterKey({ purpose: 'subject identity signing keypair storage' });
    return deriveSubkey(SUBKEY_PURPOSE);
}

function decryptPacked(packedText) {
    const buf = Buffer.from(String(packedText || '').trim(), 'base64');
    if (buf.length < IV_BYTES + TAG_BYTES + 1) {
        throw new Error('Encrypted subject identity keypair envelope is incomplete.');
    }
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv(ALGORITHM, getStorageKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptStoreToPacked(store) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, getStorageKey(), iv);
    const plaintext = Buffer.from(JSON.stringify(store), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function readStore() {
    const storeFile = resolveKeypairStoreFile();
    if (!fs.existsSync(storeFile)) {
        return null;
    }
    let raw;
    try {
        raw = fs.readFileSync(storeFile, 'utf8').trim();
    } catch (error) {
        throw new Error(`Unable to read subject identity keypair store: ${error?.message || String(error)}`);
    }
    if (!raw) {
        return null;
    }
    let plaintext;
    try {
        plaintext = decryptPacked(raw);
    } catch (error) {
        throw new Error(`Unable to decrypt subject identity keypair store: ${error?.message || String(error)}`);
    }
    const parsed = JSON.parse(plaintext.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.privateKeyPem !== 'string' || typeof parsed.publicKeyPem !== 'string') {
        throw new Error('Subject identity keypair store is malformed.');
    }
    return parsed;
}

function writeStore(store) {
    const storeFile = resolveKeypairStoreFile();
    const packed = encryptStoreToPacked(store);
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    const tempPath = `${storeFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${packed}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, storeFile);
    try {
        fs.chmodSync(storeFile, 0o600);
    } catch (_) { }
}

// Serialize an Ed25519 public KeyObject to the raw 32-byte key as base64url
// without padding. Buffer's 'base64url' encoding is already unpadded.
function encodePublicKey(publicKeyObject) {
    const jwk = publicKeyObject.export({ format: 'jwk' });
    const raw = Buffer.from(String(jwk.x || ''), 'base64url');
    if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
        throw new Error('Unexpected Ed25519 public key length while encoding.');
    }
    return raw.toString('base64url');
}

// Rebuild a public KeyObject from the base64url raw-32-byte serialization. Throws
// a typed INVALID_PUBLIC_KEY error on any malformed input so verify can surface
// a precise failure code.
function decodePublicKey(publicKeyBase64url) {
    if (typeof publicKeyBase64url !== 'string' || publicKeyBase64url.length === 0) {
        throw new SubjectIdentityKeyError('INVALID_PUBLIC_KEY', 'Subject identity public key must be a non-empty base64url string.');
    }
    // Buffer.from(..., 'base64url') never throws on malformed input; the
    // 32-byte length check below is the real guard against bad public keys.
    const raw = Buffer.from(publicKeyBase64url, 'base64url');
    if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
        throw new SubjectIdentityKeyError('INVALID_PUBLIC_KEY', 'Subject identity public key must decode to 32 raw Ed25519 bytes.');
    }
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
    try {
        return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    } catch (_) {
        throw new SubjectIdentityKeyError('INVALID_PUBLIC_KEY', 'Subject identity public key could not be parsed as Ed25519.');
    }
}

// Validate a subject id and classify it. Returns { subjectId, subjectType }.
// Throws a typed INVALID_SUBJECT error for anything outside the two accepted
// forms (non-strings, wrong prefix, whitespace, empty segments, extra slashes,
// a slash inside a user id, etc. — all rejected by the anchored validators).
function classifySubject(subjectId) {
    if (typeof subjectId !== 'string') {
        throw new SubjectIdentityKeyError('INVALID_SUBJECT', 'Subject id must be a string.');
    }
    if (AGENT_SUBJECT_RE.test(subjectId)) {
        return { subjectId, subjectType: 'agent' };
    }
    if (USER_SUBJECT_RE.test(subjectId)) {
        return { subjectId, subjectType: 'user' };
    }
    throw new SubjectIdentityKeyError(
        'INVALID_SUBJECT',
        'Subject id must match agent:<repo>/<agentName> or user:<userId> with no whitespace, empty segments, or extra delimiters.',
    );
}

// Load the existing Ed25519 keypair from the Ploinky secure config location, or
// create and persist one. The private key stays inside this function's local
// scope and the returned KeyObjects; only the encoded public key string is ever
// surfaced to other functions. NOTE: callers receive only the public key — see
// getOrCreateIdentitySigningKeypair() for the public-facing return shape.
function loadOrCreateKeyObjects() {
    let store = readStore();
    if (!store) {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        store = {
            version: STORE_VERSION,
            privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
            publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        };
        writeStore(store);
    }
    const privateKeyObject = crypto.createPrivateKey({ key: store.privateKeyPem, format: 'pem', type: 'pkcs8' });
    const publicKeyObject = crypto.createPublicKey({ key: store.publicKeyPem, format: 'pem', type: 'spki' });
    return { privateKeyObject, publicKeyObject };
}

// Public API ----------------------------------------------------------------

// Ensure a signing keypair exists and return ONLY non-secret material. The
// private key is never included in the return value (and never logged). Callers
// that need to verify use the returned `publicKey` (base64url, raw 32 bytes).
function getOrCreateIdentitySigningKeypair() {
    const { publicKeyObject } = loadOrCreateKeyObjects();
    return Object.freeze({
        name: KEYPAIR_NAME,
        algorithm: 'ed25519',
        publicKey: encodePublicKey(publicKeyObject),
    });
}

// Return the public key as base64url without padding (raw 32-byte Ed25519 key).
function getSubjectIdentityPublicKey() {
    const { publicKeyObject } = loadOrCreateKeyObjects();
    return encodePublicKey(publicKeyObject);
}

// Validate `subjectId`, sign its exact UTF-8 bytes with the local private key,
// and return `${subjectId}|${signatureBase64url}`. The private key is loaded,
// used, and discarded entirely within this call.
function buildSubjectIdentityKey(subjectId) {
    const { subjectId: validSubjectId } = classifySubject(subjectId);
    const { privateKeyObject } = loadOrCreateKeyObjects();
    const signature = crypto.sign(null, Buffer.from(validSubjectId, 'utf8'), privateKeyObject);
    return `${validSubjectId}|${signature.toString('base64url')}`;
}

// Parse `<subjectId>|<signature>`, verify the signature over the exact subject
// id bytes using the supplied base64url public key, and return
// `{ subjectId, subjectType }`. Throws a typed SubjectIdentityKeyError on any
// malformed key, invalid public key, invalid subject, or failed verification.
function verifySubjectIdentityKey(apiKey, publicKey) {
    if (typeof apiKey !== 'string') {
        throw new SubjectIdentityKeyError('MALFORMED_API_KEY', 'API key must be a string.');
    }
    // Exactly one delimiter: split into exactly two non-empty parts.
    const parts = apiKey.split('|');
    if (parts.length !== 2) {
        throw new SubjectIdentityKeyError('MALFORMED_API_KEY', 'API key must be exactly "<subjectId>|<signature>".');
    }
    const [subjectId, signaturePart] = parts;
    if (!subjectId || !signaturePart) {
        throw new SubjectIdentityKeyError('MALFORMED_API_KEY', 'API key has an empty subject or signature segment.');
    }
    // Validate/classify the subject BEFORE doing any signature math.
    const { subjectId: validSubjectId, subjectType } = classifySubject(subjectId);
    const publicKeyObject = decodePublicKey(publicKey);

    // Buffer.from(..., 'base64url') never throws on malformed input; the
    // emptiness check below is the real guard against a bad signature segment.
    const signature = Buffer.from(signaturePart, 'base64url');
    if (signature.length === 0) {
        throw new SubjectIdentityKeyError('MALFORMED_API_KEY', 'API key signature is empty.');
    }

    let ok = false;
    try {
        ok = crypto.verify(null, Buffer.from(validSubjectId, 'utf8'), publicKeyObject, signature);
    } catch (_) {
        ok = false;
    }
    if (!ok) {
        throw new SubjectIdentityKeyError('SIGNATURE_INVALID', 'Subject identity key signature verification failed.');
    }
    return { subjectId: validSubjectId, subjectType };
}

export {
    SubjectIdentityKeyError,
    KEYPAIR_NAME,
    getOrCreateIdentitySigningKeypair,
    getSubjectIdentityPublicKey,
    buildSubjectIdentityKey,
    verifySubjectIdentityKey,
};
