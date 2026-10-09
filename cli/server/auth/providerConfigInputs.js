import crypto from 'node:crypto';
import fs from 'node:fs';

import { SECRETS_FILE } from '../../utils/config.js';
import {
    decryptSecretsText,
    readSecretsFile,
    secretsDecryptionError,
    SECRETS_STORAGE_SUBKEY_PURPOSE,
} from '../../utils/security/encryptedSecretsFile.js';
import {
    deriveSubkeyFromSeed,
    deriveWorkspaceSecret,
    resolveMasterKeySeed,
} from '../../utils/security/masterKey.js';

/**
 * providerConfigInputs.js
 *
 * A validate-on-every-hit memo of the files the SSO bridge reads to resolve
 * its provider configuration: parsed JSON documents (the provider manifest)
 * and the decrypted workspace `.secrets` map. It holds configuration inputs
 * only, never a provider answer or an authorization decision, and it has no
 * time window: every read re-checks its inputs and returns exactly what a fresh
 * read would return.
 *
 *   - Each file is opened and its handle fstat'ed on every read. The memo
 *     entry is used only when the handle's bigint
 *     dev:ino:size:mtimeNs:ctimeNs stamp equals the stamp of the handle whose
 *     bytes were parsed; otherwise the bytes are read from that same handle.
 *   - The `.secrets` entry is additionally keyed on the identity of the master
 *     seed, resolved on every read through the same precedence and guards as
 *     every other decryption (environment, walked-up .env, generated or managed
 *     key file, retired-secret refusal). Only a domain-separated hash of the
 *     seed is kept. A miss decrypts with the subkey derived from that same seed.
 *   - Failures (missing file, unreadable or corrupt JSON, failed decryption,
 *     key resolution errors) are never memoized; the entry is dropped and the
 *     error propagates exactly as a fresh read would raise it.
 *
 * Values are deeply frozen; callers that hand them to code which may mutate
 * them pass a copy.
 */

const MAX_JSON_ENTRIES = 16;
// deriveDerivedMasterKey() is deriveSubkey('derived-master').
const DERIVED_MASTER_SUBKEY_PURPOSE = 'derived-master';
const SEED_IDENTITY_DOMAIN = 'ploinky/provider-config-inputs/master-seed-identity/v1\0';

function fileStamp(stat) {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function deepFreeze(value) {
    const pending = [value];
    while (pending.length) {
        const entry = pending.pop();
        if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) continue;
        Object.freeze(entry);
        for (const child of Object.values(entry)) pending.push(child);
    }
    return value;
}

function seedIdentity(seed) {
    return crypto.createHash('sha256').update(SEED_IDENTITY_DOMAIN).update(seed, 'utf8').digest('hex');
}

export function createProviderConfigInputs({
    fsApi = fs,
    secretsFile = SECRETS_FILE,
    resolveSeed = () => resolveMasterKeySeed(),
    readSecretsFallback = readSecretsFile,
} = {}) {
    const jsonEntries = new Map();
    let secretsEntry = null;
    const counters = { jsonHits: 0, jsonMisses: 0, secretsHits: 0, secretsMisses: 0 };

    // Opens `absPath`, fstats the handle and passes both to `use`. The handle
    // is always closed.
    function withStampedHandle(absPath, use) {
        const fd = fsApi.openSync(absPath, 'r');
        try {
            const stat = fsApi.fstatSync(fd, { bigint: true });
            return use(fd, stat.isFile() ? fileStamp(stat) : null);
        } finally {
            fsApi.closeSync(fd);
        }
    }

    // JSON.parse of the file's current bytes, as a deeply frozen value.
    function readJson(absPath) {
        try {
            return withStampedHandle(absPath, (fd, stamp) => {
                const entry = jsonEntries.get(absPath);
                if (stamp !== null && entry && entry.stamp === stamp) {
                    counters.jsonHits += 1;
                    jsonEntries.delete(absPath);
                    jsonEntries.set(absPath, entry);
                    return entry.value;
                }
                counters.jsonMisses += 1;
                jsonEntries.delete(absPath);
                const value = deepFreeze(JSON.parse(fsApi.readFileSync(fd, 'utf8')));
                // A non-regular file has no stamp that describes its bytes.
                if (stamp !== null) {
                    jsonEntries.set(absPath, { stamp, value });
                    while (jsonEntries.size > MAX_JSON_ENTRIES) jsonEntries.delete(jsonEntries.keys().next().value);
                }
                return value;
            });
        } catch (error) {
            jsonEntries.delete(absPath);
            throw error;
        }
    }

    // The decrypted workspace secrets, as readSecretsFile() would return them
    // now (frozen). Like readSecretsFile(), a missing or empty file never
    // resolves the master seed, and a seed failure is reported as a decryption
    // failure.
    function readSecrets(resolveScopeSeed = resolveSeedForDecryption) {
        let fd;
        try {
            try {
                fd = fsApi.openSync(secretsFile, 'r');
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
                secretsEntry = null;
                return Object.freeze({});
            }
            const stat = fsApi.fstatSync(fd, { bigint: true });
            const stamp = stat.isFile() ? fileStamp(stat) : null;
            let seed;
            if (stamp !== null && secretsEntry && secretsEntry.stamp === stamp) {
                seed = resolveScopeSeed();
                if (secretsEntry.identity === seedIdentity(seed)) {
                    counters.secretsHits += 1;
                    return secretsEntry.secrets;
                }
            }
            counters.secretsMisses += 1;
            secretsEntry = null;
            const raw = fsApi.readFileSync(fd, 'utf8').trim();
            // An empty file is rewritten by readSecretsFile(); never memoized.
            if (!raw) return Object.freeze({ ...readSecretsFallback() });
            if (seed === undefined) seed = resolveScopeSeed();
            // Decrypt with the subkey of the very seed whose identity keys the entry.
            const key = deriveSubkeyFromSeed(seed, SECRETS_STORAGE_SUBKEY_PURPOSE);
            let secrets;
            try {
                secrets = Object.freeze(decryptSecretsText(raw, key));
            } finally {
                key.fill(0);
            }
            if (stamp !== null) secretsEntry = { stamp, identity: seedIdentity(seed), secrets };
            return secrets;
        } catch (error) {
            secretsEntry = null;
            throw error;
        } finally {
            if (fd !== undefined) fsApi.closeSync(fd);
        }
    }

    function resolveSeedForDecryption() {
        try {
            return resolveSeed();
        } catch (error) {
            // readSecretsFile() resolves the storage key inside its decryption
            // step and reports the failure as a decryption failure.
            throw secretsDecryptionError(error);
        }
    }

    // One provider-configuration resolution. Its secrets read and its
    // workspace-secret derivations share a single master-seed resolution, made
    // on first use, so the resolution sees one consistent key. A scope is
    // never kept beyond the resolution that created it.
    function scope() {
        let seed;
        let seedError;
        const scopeSeed = () => {
            if (seedError) throw seedError;
            if (seed === undefined) {
                try {
                    seed = resolveSeed();
                } catch (error) {
                    seedError = error;
                    throw error;
                }
            }
            return seed;
        };
        return Object.freeze({
            readJson,
            readSecrets: () => readSecrets(() => {
                try {
                    return scopeSeed();
                } catch (error) {
                    throw secretsDecryptionError(error);
                }
            }),
            // deriveWorkspaceSecret() from masterKey.js, derived from this
            // scope's seed.
            deriveWorkspaceSecret: (args = {}) => {
                const derivedMasterSecret = deriveSubkeyFromSeed(scopeSeed(), DERIVED_MASTER_SUBKEY_PURPOSE);
                try {
                    return deriveWorkspaceSecret({ ...args, derivedMasterSecret });
                } finally {
                    derivedMasterSecret.fill(0);
                }
            },
        });
    }

    function clear() {
        jsonEntries.clear();
        secretsEntry = null;
    }

    return Object.freeze({
        readJson,
        readSecrets: () => readSecrets(),
        scope,
        clear,
        stats: () => ({ ...counters, jsonEntries: jsonEntries.size, secretsEntry: secretsEntry !== null }),
    });
}
