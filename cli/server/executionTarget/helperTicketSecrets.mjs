// Router-side holder of the per-helper-incarnation ticket secret (plan section 5.6; frozen T0 section 8 + A1.7;
// proof sequence P3/P4 delta "per-helper-incarnation ticket secret").
//
// Provisioning (provisioning.mjs) writes one fresh 32-byte HS256 secret per helper start in exactly two places: the
// helper's single-use `control/helper-secret` and the Router copy `router-ticket-secret` in the instance root on the
// Box tmpfs, which is never a bind source. This module is the `secrets` handle of the target-helper ticket minter:
// `useSecret(target, fn)` reaches the Router copy of exactly the incarnation the controller-private provisioning record
// names for that target, hands `fn(kid, secret)` a private buffer synchronously and zeroes it afterwards.
//
// Nothing is cached: every call re-reads the record and the file, so a new incarnation, a Router restart or a retired
// copy takes effect at once. Every failure (no record, another instance or incarnation, a missing, symlinked, foreign,
// non-private, oversized or malformed file, or `fn` throwing) returns null, which the minter maps to
// `secret_unavailable`. It never throws from `useSecret` and never puts the secret or a path into an error.
//
// This module reads no environment, spawns nothing and opens no network; paths, fs and the expected owner are injected.

import fs from 'node:fs';
import path from 'node:path';

import { isId, isOpaqueIdentity, isPrincipal } from './contract.mjs';
import {
    TICKET_SECRET_BYTES,
    instancePaths,
    readProvisioningRecord,
    ticketKid,
    ticketSecretFilePrefix,
} from './provisioning.mjs';

export const MAX_TICKET_SECRET_FILE_BYTES = 256;
const ENCODED_SECRET_LENGTH = 43;
const BASE64URL_BYTE = /^[A-Za-z0-9_-]$/;

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function lstatOrNull(fsApi, target) {
    try {
        return fsApi.lstatSync(target, { bigint: true });
    } catch (_) {
        return null;
    }
}

function ownedBy(stat, euid) {
    return euid === null || Number(stat.uid) === euid;
}

function privateFile(stat, euid) {
    return stat.isFile() && !stat.isSymbolicLink() && ownedBy(stat, euid) && (Number(stat.mode) & 0o777) === 0o600
        && stat.size > 0n && stat.size <= BigInt(MAX_TICKET_SECRET_FILE_BYTES);
}

// Reads at most MAX + 1 bytes of the file through one O_NOFOLLOW descriptor whose identity equals the lstat result.
// Returns the byte count; the caller owns (and zeroes) `buffer`.
function readSecretFile(fsApi, file, euid, buffer) {
    const before = lstatOrNull(fsApi, file);
    if (!before || !privateFile(before, euid)) return -1;
    const fd = fsApi.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fsApi.fstatSync(fd, { bigint: true });
        if (!privateFile(opened, euid) || opened.dev !== before.dev || opened.ino !== before.ino) return -1;
        let total = 0;
        while (total < buffer.length) {
            const count = fsApi.readSync(fd, buffer, total, buffer.length - total, null);
            if (count === 0) break;
            total += count;
        }
        return total > MAX_TICKET_SECRET_FILE_BYTES ? -1 : total;
    } finally {
        fsApi.closeSync(fd);
    }
}

// Strict v1 parse: exactly `version=1`, `helperIncarnation=<incarnation>`, `kid=hti1.<incarnation>` and
// `secret=<43-char canonical base64url of 32 bytes>`, each newline-terminated, nothing else. Fills `secret`.
function parseSecretFile(bytes, helperIncarnation, secret) {
    const prefix = Buffer.from(ticketSecretFilePrefix(helperIncarnation), 'utf8');
    if (bytes.length !== prefix.length + ENCODED_SECRET_LENGTH + 1) return false;
    if (!bytes.subarray(0, prefix.length).equals(prefix) || bytes[bytes.length - 1] !== 0x0a) return false;
    const encoded = bytes.subarray(prefix.length, prefix.length + ENCODED_SECRET_LENGTH);
    for (const byte of encoded) if (!BASE64URL_BYTE.test(String.fromCharCode(byte))) return false;
    const text = encoded.toString('latin1');
    // Node's decoder is lenient (padding, non-zero trailing bits): only the canonical encoding of 32 bytes is accepted.
    return secret.write(text, 0, 'base64url') === TICKET_SECRET_BYTES && secret.toString('base64url') === text;
}

/**
 * Create the Router's ticket-secret provider.
 *   controllerStateDir  the workspace `.ploinky/data` holding the provisioning records (absolute)
 *   boxTmpRoot          the Box tmpfs holding the per-instance directories (absolute)
 *   fsApi               injected fs (tests)
 *   euid                expected owner of the instance directory and the secret file (null skips the owner check)
 *
 * useSecret(target, fn): `target` is the minter's frozen target identity (`agentPrincipal`, `runtimeInstanceId`,
 * `enableGeneration`, `helperIncarnation`, ...). Returns `fn(kid, secretBuffer)` or null.
 */
export function createHelperTicketSecretProvider({
    controllerStateDir,
    boxTmpRoot,
    fsApi = fs,
    euid = typeof process.geteuid === 'function' ? process.geteuid() : null,
} = {}) {
    if (typeof controllerStateDir !== 'string' || !path.isAbsolute(controllerStateDir)
        || typeof boxTmpRoot !== 'string' || !path.isAbsolute(boxTmpRoot)
        || !(euid === null || Number.isSafeInteger(euid))) {
        throw new TypeError('createHelperTicketSecretProvider: absolute controllerStateDir and boxTmpRoot are required');
    }

    function useSecret(target, fn) {
        const raw = Buffer.alloc(MAX_TICKET_SECRET_FILE_BYTES + 1);
        const secret = Buffer.alloc(TICKET_SECRET_BYTES);
        try {
            if (typeof fn !== 'function' || !isPlainObject(target) || !isPrincipal(target.agentPrincipal)
                || !isId(target.helperIncarnation) || !isOpaqueIdentity(target.runtimeInstanceId)
                || !isOpaqueIdentity(target.enableGeneration)) return null;
            const current = readProvisioningRecord({ controllerStateDir, principal: target.agentPrincipal, fsApi })?.current;
            if (!current || current.helperIncarnation !== target.helperIncarnation
                || current.instanceId !== target.runtimeInstanceId || current.enableGeneration !== target.enableGeneration) return null;
            const instance = instancePaths(boxTmpRoot, current.instanceKey);
            const root = lstatOrNull(fsApi, instance.root);
            if (!root || root.isSymbolicLink() || !root.isDirectory() || !ownedBy(root, euid) || (Number(root.mode) & 0o077) !== 0) {
                return null;
            }
            const length = readSecretFile(fsApi, instance.routerSecret, euid, raw);
            if (length < 0 || !parseSecretFile(raw.subarray(0, length), current.helperIncarnation, secret)) return null;
            return fn(ticketKid(current.helperIncarnation), secret);
        } catch (_) {
            return null;
        } finally {
            secret.fill(0);
            raw.fill(0);
        }
    }

    return Object.freeze({ useSecret });
}
