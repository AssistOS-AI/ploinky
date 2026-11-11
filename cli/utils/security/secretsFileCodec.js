import crypto from 'crypto';

import { deriveSubkey } from './masterKey.js';

// The `.ploinky/data/.secrets` envelope format, without the workspace-bound
// file location. encryptedSecretsFile.js binds it to the configured workspace;
// modules that must not load the workspace configuration decrypt a known file
// through these helpers directly.

const PAYLOAD_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SUBKEY_PURPOSE = 'storage/secrets';
const SECRETS_STORAGE_SUBKEY_PURPOSE = SUBKEY_PURPOSE;
const KEY_MISMATCH_HINT = 'Check PLOINKY_MASTER_KEY, a walked-up .env, or .ploinky/data/master-key as appropriate; managed Boxes use only .ploinky/data/master-key, and .ploinky/data/.secrets may have been written with a different master seed.';

function getStorageKey() {
    return deriveSubkey(SUBKEY_PURPOSE);
}

function normalizeSecretsMap(input = {}) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const normalized = {};
    for (const [name, value] of Object.entries(source)) {
        const key = String(name || '').trim();
        if (!key) continue;
        normalized[key] = String(value ?? '');
    }
    return normalized;
}

function decryptPacked(packedText, key) {
    const buf = Buffer.from(String(packedText || '').trim(), 'base64');
    if (buf.length < IV_BYTES + TAG_BYTES + 1) {
        throw new Error('Encrypted .secrets envelope is incomplete.');
    }
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
    // The storage key is resolved only for a complete envelope, as before.
    const decipher = crypto.createDecipheriv(ALGORITHM, key === undefined ? getStorageKey() : key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function encryptSecretsMapToPacked(secrets = {}) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, getStorageKey(), iv);
    const plaintext = Buffer.from(JSON.stringify({
        version: PAYLOAD_VERSION,
        secrets: normalizeSecretsMap(secrets),
    }), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

// The error readSecretsFile() raises when the file cannot be decrypted,
// including when the storage key itself cannot be resolved.
function secretsDecryptionError(error) {
    return new Error(`Unable to decrypt .ploinky/data/.secrets: ${error?.message || String(error)}. ${KEY_MISMATCH_HINT}`);
}

// Decrypts the trimmed, non-empty contents of a .secrets file. `storageKey`
// defaults to the current storage subkey; a caller that has already resolved
// the master seed passes the subkey derived from that same seed.
function decryptSecretsText(raw, storageKey) {
    let payload;
    try {
        payload = JSON.parse(decryptPacked(raw, storageKey));
    } catch (error) {
        throw secretsDecryptionError(error);
    }
    return normalizeSecretsMap(payload?.secrets);
}

export {
    ALGORITHM,
    decryptSecretsText,
    encryptSecretsMapToPacked,
    normalizeSecretsMap,
    secretsDecryptionError,
    SECRETS_STORAGE_SUBKEY_PURPOSE,
};
