import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { deriveSubkey } from '../../utils/security/masterKey.js';

/**
 * sessionPersistence.js
 *
 * File primitives for the Router's durable SSO session store: the encrypted
 * envelope, a durable atomic replace, a durable unlink and the content digest
 * the store's write guard compares. The session state machine and the write
 * policy live in sessionStore.js. Every operation is synchronous so the store
 * can finish a write before the request that caused it is answered.
 */

export const SSO_SESSIONS_FILE_NAME = 'sso-sessions.enc';
export const SSO_SESSIONS_KEY_PURPOSE = 'storage/router-sso-sessions';
export const SSO_SESSIONS_ENVELOPE_PREFIX = 'ploinky-sso-sessions.v1.';
export const SSO_SESSIONS_DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const SSO_SESSIONS_FILE_VERSION = 1;
// Sentinel digest of a file that does not exist.
export const ABSENT_FILE_DIGEST = 'absent';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from('ploinky/router-sso-sessions/file/v1', 'utf8');
const SESSION_ID_DOMAIN = 'ploinky/sso-session-id/v1\0';
const ENVELOPE_FAMILY = /^ploinky-sso-sessions\.v[0-9]+\./;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const TEMP_FILE = /^\.sso-sessions\..+\.tmp$/;
const READ_ATTEMPTS = 3;
const READ_RETRY_DELAY_MS = 100;
const TOLERATED_DIRECTORY_FSYNC_CODES = ['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'];

// The key under which a session lives in memory and on disk. The cookie value
// carries 192 random bits, so an unsalted, domain-separated digest cannot be
// inverted, and a stolen file never yields a usable cookie.
export function hashSessionId(cookieValue) {
    return crypto.createHash('sha256').update(SESSION_ID_DOMAIN).update(String(cookieValue)).digest('hex');
}

export function digestBytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function defaultDeriveSessionsKey() {
    return deriveSubkey(SSO_SESSIONS_KEY_PURPOSE);
}

function rejection(reason, cause) {
    const error = new Error(`SSO session file rejected: ${reason}`);
    error.reason = reason;
    if (cause?.code) error.code = cause.code;
    return error;
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// `deriveKey` must return a fresh buffer: it is zero-filled after every use.
function withKey(deriveKey, use) {
    let key;
    try {
        key = deriveKey();
    } catch (error) {
        throw rejection('key_unavailable', error);
    }
    try {
        if (!Buffer.isBuffer(key) || key.length !== 32) throw rejection('key_unavailable');
        return use(key);
    } finally {
        if (Buffer.isBuffer(key)) key.fill(0);
    }
}

export function encodeSessionsFile(payload, deriveKey = defaultDeriveSessionsKey) {
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    return withKey(deriveKey, (key) => {
        const iv = crypto.randomBytes(IV_BYTES);
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
        cipher.setAAD(AAD);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const packed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
        return `${SSO_SESSIONS_ENVELOPE_PREFIX}${packed}\n`;
    });
}

// Returns the parsed payload or throws an error whose `reason` is a short code.
export function decodeSessionsFile(text, deriveKey = defaultDeriveSessionsKey) {
    const body = String(text).endsWith('\n') ? String(text).slice(0, -1) : String(text);
    if (!body.startsWith(SSO_SESSIONS_ENVELOPE_PREFIX)) {
        throw rejection(ENVELOPE_FAMILY.test(body) ? 'unsupported_version' : 'bad_prefix');
    }
    const encoded = body.slice(SSO_SESSIONS_ENVELOPE_PREFIX.length);
    if (!encoded || encoded.length % 4 !== 0 || !BASE64.test(encoded)) throw rejection('bad_base64');
    const packed = Buffer.from(encoded, 'base64');
    if (packed.length < IV_BYTES + TAG_BYTES + 1) throw rejection('truncated');
    const plaintext = withKey(deriveKey, (key) => {
        try {
            const decipher = crypto.createDecipheriv(ALGORITHM, key, packed.subarray(0, IV_BYTES));
            decipher.setAAD(AAD);
            decipher.setAuthTag(packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
            return Buffer.concat([decipher.update(packed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
        } catch (error) {
            throw rejection('decrypt_failed', error);
        }
    });
    let payload;
    try {
        payload = JSON.parse(plaintext.toString('utf8'));
    } catch (error) {
        throw rejection('bad_json', error);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw rejection('bad_schema');
    if (payload.version !== SSO_SESSIONS_FILE_VERSION) throw rejection('unsupported_version');
    const sessions = payload.sessions;
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) throw rejection('bad_schema');
    return payload;
}

function fsyncDirectory(fsApi, directory, { tolerateMissing = false } = {}) {
    let descriptor;
    try {
        descriptor = fsApi.openSync(directory, fs.constants.O_RDONLY);
        fsApi.fsyncSync(descriptor);
    } catch (error) {
        if (tolerateMissing && error?.code === 'ENOENT') return;
        if (!TOLERATED_DIRECTORY_FSYNC_CODES.includes(error?.code)) throw error;
    } finally {
        if (descriptor !== undefined) {
            try { fsApi.closeSync(descriptor); } catch (_) { }
        }
    }
}

export function createSessionFile({
    directory,
    fsApi = fs,
    maxFileBytes = SSO_SESSIONS_DEFAULT_MAX_FILE_BYTES,
} = {}) {
    if (typeof directory !== 'string' || !directory.trim()) {
        throw new Error('SSO session persistence requires a directory');
    }
    const dir = path.resolve(directory);
    const file = path.join(dir, SSO_SESSIONS_FILE_NAME);
    let staleTempsRemoved = false;

    function retryingRead(operation) {
        let lastError;
        for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
            try {
                return operation();
            } catch (error) {
                if (error?.code === 'ENOENT') throw error;
                lastError = error;
                if (attempt < READ_ATTEMPTS) sleepSync(READ_RETRY_DELAY_MS);
            }
        }
        throw rejection('read_failed', lastError);
    }

    // `{ absent: true }` or `{ bytes }`; a rejected file throws with `reason`
    // (and the system `code`, when there was one).
    function read() {
        let stat;
        try {
            stat = retryingRead(() => fsApi.lstatSync(file));
        } catch (error) {
            if (error?.code === 'ENOENT' && !error.reason) return { absent: true };
            throw error;
        }
        if (!stat.isFile()) throw rejection('not_regular_file');
        if (stat.size === 0) throw rejection('empty');
        if (stat.size > maxFileBytes) throw rejection('oversized');
        let bytes;
        try {
            bytes = retryingRead(() => fsApi.readFileSync(file));
        } catch (error) {
            if (error?.code === 'ENOENT' && !error.reason) return { absent: true };
            throw error;
        }
        if (bytes.length === 0) throw rejection('empty');
        if (bytes.length > maxFileBytes) throw rejection('oversized');
        return { bytes };
    }

    function currentDigest() {
        try {
            return digestBytes(fsApi.readFileSync(file));
        } catch (error) {
            if (error?.code === 'ENOENT') return ABSENT_FILE_DIGEST;
            throw error;
        }
    }

    function removeStaleTemps() {
        if (staleTempsRemoved) return;
        staleTempsRemoved = true;
        let names = [];
        try { names = fsApi.readdirSync(dir); } catch (_) { return; }
        for (const name of names) {
            if (!TEMP_FILE.test(name)) continue;
            try { fsApi.unlinkSync(path.join(dir, name)); } catch (_) { }
        }
    }

    // Durable atomic replace. A thrown error carries `renamed: true` when the
    // new bytes already replaced the file and only the directory fsync failed,
    // so the caller can still record what the file now holds.
    function replace(text) {
        const bytes = Buffer.from(text, 'utf8');
        if (bytes.length > maxFileBytes) throw rejection('oversized');
        // Created owner-only when absent; an existing directory keeps its mode.
        fsApi.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const suffix = `${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`;
        const tmp = path.join(dir, `.sso-sessions.${suffix}.tmp`);
        let descriptor;
        let renamed = false;
        try {
            descriptor = fsApi.openSync(tmp, 'wx', 0o600);
            fsApi.writeFileSync(descriptor, bytes);
            fsApi.fsyncSync(descriptor);
            fsApi.closeSync(descriptor);
            descriptor = undefined;
            fsApi.renameSync(tmp, file);
            renamed = true;
            fsyncDirectory(fsApi, dir);
        } catch (error) {
            if (descriptor !== undefined) {
                try { fsApi.closeSync(descriptor); } catch (_) { }
            }
            if (!renamed) {
                try { fsApi.unlinkSync(tmp); } catch (_) { }
            }
            const failure = error instanceof Error ? error : new Error(String(error));
            failure.renamed = renamed;
            failure.digest = renamed ? digestBytes(bytes) : null;
            throw failure;
        }
        removeStaleTemps();
        return digestBytes(bytes);
    }

    // Durable removal without following a symlink. A directory at the path is
    // a failed removal: unlink refuses it and its contents are never touched.
    // A thrown error carries `unlinked: true` when the file is already gone and
    // only the directory fsync failed.
    function unlink() {
        let missing = false;
        try {
            fsApi.unlinkSync(file);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            missing = true;
        }
        try {
            fsyncDirectory(fsApi, dir, { tolerateMissing: missing });
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            failure.unlinked = true;
            throw failure;
        }
    }

    return Object.freeze({ directory: dir, file, read, currentDigest, replace, unlink });
}

const DISCARD_RETRY_DELAY_MS = 1000;
const DISCARD_RETRY_LIMIT = 30;

// Used when persistence is opted out, so a stale file cannot come back when
// it is switched on again. Never throws. The returned `removed` is the result
// of the first attempt; a failed removal is retried in the background, so
// sessions logged out during the opted-out run cannot return from a file that
// outlives it.
export function discardPersistedSessions({ directory, fsApi = fs, log } = {}) {
    const emit = (event, fields) => {
        try {
            if (typeof log === 'function') log(event, fields);
        } catch (_) { }
    };

    // True when the file was removed by this attempt; throws if it could not
    // be removed.
    function attempt() {
        const sessionFile = createSessionFile({ directory, fsApi });
        try {
            fsApi.lstatSync(sessionFile.file);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            return false;
        }
        sessionFile.unlink();
        return true;
    }

    function retryLater(attemptNumber) {
        let timer;
        try {
            timer = setTimeout(() => {
                try {
                    attempt();
                } catch (_) {
                    if (attemptNumber < DISCARD_RETRY_LIMIT) retryLater(attemptNumber + 1);
                    return;
                }
                emit('sso_session_store_discard_retried', { removed: true, attempts: attemptNumber + 1 });
            }, DISCARD_RETRY_DELAY_MS);
            timer.unref?.();
        } catch (_) { }
    }

    try {
        const removed = attempt();
        if (removed) emit('sso_session_store_discarded', { removed: true });
        return { removed };
    } catch (error) {
        emit('sso_session_store_discard_failed', { level: 'error', code: error?.code || 'unknown' });
        retryLater(1);
        return { removed: false };
    }
}
