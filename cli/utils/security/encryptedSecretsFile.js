import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { SECRETS_FILE } from '../config.js';
import { deriveSubkey } from './masterKey.js';

const PAYLOAD_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SUBKEY_PURPOSE = 'storage/secrets';
const KEY_MISMATCH_HINT = 'Check PLOINKY_MASTER_KEY, any walked-up .env, and .ploinky/master-key; .ploinky/.secrets may have been written with a different master seed.';

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

function decryptPacked(packedText) {
    const buf = Buffer.from(String(packedText || '').trim(), 'base64');
    if (buf.length < IV_BYTES + TAG_BYTES + 1) {
        throw new Error('Encrypted .secrets envelope is incomplete.');
    }
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv(ALGORITHM, getStorageKey(), iv);
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

function writeSecretsFile(secrets = {}) {
    fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
    const packed = encryptSecretsMapToPacked(secrets);
    const tempPath = `${SECRETS_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${packed}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, SECRETS_FILE);
    try {
        fs.chmodSync(SECRETS_FILE, 0o600);
    } catch (_) { }
}

function readSecretsFile() {
    if (!fs.existsSync(SECRETS_FILE)) {
        return {};
    }
    const raw = fs.readFileSync(SECRETS_FILE, 'utf8').trim();
    if (!raw) {
        writeSecretsFile({});
        return {};
    }
    let payload;
    try {
        payload = JSON.parse(decryptPacked(raw));
    } catch (error) {
        throw new Error(`Unable to decrypt .ploinky/.secrets: ${error?.message || String(error)}. ${KEY_MISMATCH_HINT}`);
    }
    return normalizeSecretsMap(payload?.secrets);
}

function setSecretValue(name, value) {
    const key = String(name || '').trim();
    if (!key) {
        throw new Error('Missing variable name.');
    }
    const secrets = readSecretsFile();
    secrets[key] = String(value ?? '');
    writeSecretsFile(secrets);
}

function deleteSecretValue(name) {
    const key = String(name || '').trim();
    if (!key || !fs.existsSync(SECRETS_FILE)) return;
    const secrets = readSecretsFile();
    if (!Object.prototype.hasOwnProperty.call(secrets, key)) return;
    delete secrets[key];
    writeSecretsFile(secrets);
}

function ensureEncryptedSecretsFile() {
    if (!fs.existsSync(SECRETS_FILE)) {
        writeSecretsFile({});
        return;
    }
    readSecretsFile();
}

export {
    ALGORITHM,
    deleteSecretValue,
    ensureEncryptedSecretsFile,
    readSecretsFile,
    setSecretValue,
    writeSecretsFile,
};
