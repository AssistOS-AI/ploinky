import fs from 'fs';
import path from 'path';

import { SECRETS_FILE } from '../config.js';
import {
    ALGORITHM,
    decryptSecretsText,
    encryptSecretsMapToPacked,
    secretsDecryptionError,
    SECRETS_STORAGE_SUBKEY_PURPOSE,
} from './secretsFileCodec.js';

export { SECRETS_STORAGE_SUBKEY_PURPOSE };

function writeSecretsFile(secrets = {}) {
    fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true, mode: 0o700 });
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
    return decryptSecretsText(raw);
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
    decryptSecretsText,
    deleteSecretValue,
    ensureEncryptedSecretsFile,
    readSecretsFile,
    secretsDecryptionError,
    setSecretValue,
    writeSecretsFile,
};
