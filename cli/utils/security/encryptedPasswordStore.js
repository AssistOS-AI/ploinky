import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { PLOINKY_DIR } from '../config.js';
import {
    MASTER_KEY_VAR,
    deriveSubkey,
    resolveMasterKey as resolveConfiguredMasterKey,
} from './masterKey.js';

const PASSWORD_STORE_FILE = path.join(PLOINKY_DIR, 'passwords.enc');
const STORE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SUBKEY_PURPOSE = 'storage/passwords';
const KEY_MISMATCH_HINT = 'Check PLOINKY_MASTER_KEY, any walked-up .env, and .ploinky/master-key; this store may have been written with a different master seed.';

function defaultStore() {
    return {
        version: STORE_VERSION,
        usersByVar: {},
    };
}

function resolvePasswordStoreFile() {
    return PASSWORD_STORE_FILE;
}

function resolveMasterKey() {
    return resolveConfiguredMasterKey({ purpose: 'local password storage' });
}

function getStorageKey() {
    return deriveSubkey(SUBKEY_PURPOSE);
}

function normalizeStore(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const usersByVar = source.usersByVar && typeof source.usersByVar === 'object' && !Array.isArray(source.usersByVar)
        ? source.usersByVar
        : {};
    const normalized = defaultStore();
    for (const [usersVar, payload] of Object.entries(usersByVar)) {
        const key = String(usersVar || '').trim();
        if (!key) continue;
        const users = Array.isArray(payload?.users) ? payload.users : [];
        normalized.usersByVar[key] = {
            version: Number(payload?.version) || 1,
            users,
        };
    }
    return normalized;
}

function decryptPacked(packedText) {
    const buf = Buffer.from(String(packedText || '').trim(), 'base64');
    if (buf.length < IV_BYTES + TAG_BYTES + 1) {
        throw new Error('Encrypted password store envelope is incomplete.');
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
    const plaintext = Buffer.from(JSON.stringify(normalizeStore(store)), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function readPasswordStore() {
    const passwordStoreFile = resolvePasswordStoreFile();
    if (!fs.existsSync(passwordStoreFile)) {
        return defaultStore();
    }
    let raw;
    try {
        raw = fs.readFileSync(passwordStoreFile, 'utf8').trim();
    } catch (error) {
        throw new Error(`Unable to read encrypted password store: ${error?.message || String(error)}`);
    }
    if (!raw) {
        return defaultStore();
    }
    let plaintext;
    try {
        plaintext = decryptPacked(raw);
    } catch (error) {
        throw new Error(`Unable to decrypt encrypted password store: ${error?.message || String(error)}. ${KEY_MISMATCH_HINT}`);
    }
    return normalizeStore(JSON.parse(plaintext.toString('utf8')));
}

function writePasswordStore(store) {
    const passwordStoreFile = resolvePasswordStoreFile();
    const packed = encryptStoreToPacked(store);
    fs.mkdirSync(path.dirname(passwordStoreFile), { recursive: true });
    const tempPath = `${passwordStoreFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${packed}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, passwordStoreFile);
    try {
        fs.chmodSync(passwordStoreFile, 0o600);
    } catch (_) { }
}

function getUsersPayload(usersVar) {
    const key = String(usersVar || '').trim();
    if (!key) return { version: 1, users: [] };
    resolveMasterKey();
    const store = readPasswordStore();
    const payload = store.usersByVar[key];
    return {
        version: Number(payload?.version) || 1,
        users: Array.isArray(payload?.users) ? payload.users : [],
    };
}

function setUsersPayload(usersVar, payload = {}) {
    const key = String(usersVar || '').trim();
    if (!key) {
        throw new Error('setUsersPayload requires usersVar.');
    }
    const store = readPasswordStore();
    store.usersByVar[key] = {
        version: Number(payload?.version) || 1,
        users: Array.isArray(payload?.users) ? payload.users : [],
    };
    writePasswordStore(store);
    return store.usersByVar[key];
}

/**
 * Atomically publish a set of local-auth payloads and return an exact-byte
 * rollback callback for transactions whose authorization selector has not yet
 * committed. The rollback is intentionally file-scoped: encrypted envelopes
 * use random IVs, so rebuilding the same logical store would not restore the
 * exact predecessor bytes.
 */
function setUsersPayloadBatchTransactional(updates = []) {
    if (!Array.isArray(updates)) {
        throw new Error('setUsersPayloadBatchTransactional requires an array.');
    }
    if (updates.length === 0) {
        let rollbackAvailable = true;
        return () => {
            if (!rollbackAvailable) {
                throw new Error('password store transaction rollback was already consumed.');
            }
            rollbackAvailable = false;
        };
    }
    const passwordStoreFile = resolvePasswordStoreFile();
    const existed = fs.existsSync(passwordStoreFile);
    const predecessorBytes = existed ? fs.readFileSync(passwordStoreFile) : null;
    const store = readPasswordStore();
    for (const update of updates) {
        const key = String(update?.usersVar || '').trim();
        if (!key) {
            throw new Error('setUsersPayloadBatchTransactional requires usersVar.');
        }
        const payload = update?.payload || {};
        store.usersByVar[key] = {
            version: Number(payload?.version) || 1,
            users: Array.isArray(payload?.users) ? payload.users : [],
        };
    }
    writePasswordStore(store);

    let rollbackAvailable = true;
    return () => {
        if (!rollbackAvailable) {
            throw new Error('password store transaction rollback was already consumed.');
        }
        rollbackAvailable = false;
        if (!existed) {
            try {
                fs.unlinkSync(passwordStoreFile);
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
            return;
        }
        fs.mkdirSync(path.dirname(passwordStoreFile), { recursive: true });
        const tempPath = `${passwordStoreFile}.${process.pid}.${Date.now()}.rollback.tmp`;
        try {
            fs.writeFileSync(tempPath, predecessorBytes, { mode: 0o600 });
            fs.renameSync(tempPath, passwordStoreFile);
            try { fs.chmodSync(passwordStoreFile, 0o600); } catch (_) {}
        } catch (error) {
            try { fs.unlinkSync(tempPath); } catch (_) {}
            throw error;
        }
    };
}

function deleteUsersPayload(usersVar) {
    const key = String(usersVar || '').trim();
    if (!key) return false;
    const store = readPasswordStore();
    if (!Object.prototype.hasOwnProperty.call(store.usersByVar, key)) {
        return false;
    }
    delete store.usersByVar[key];
    writePasswordStore(store);
    return true;
}

export {
    MASTER_KEY_VAR,
    PASSWORD_STORE_FILE,
    deleteUsersPayload,
    getUsersPayload,
    readPasswordStore,
    resolveMasterKey,
    setUsersPayload,
    setUsersPayloadBatchTransactional,
    writePasswordStore,
};
