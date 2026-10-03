// Canonical JSON and full-length digests for the immutable dependency cache.
//
// Every identity in this namespace is a full SHA-256 over canonical JSON:
// object keys are sorted recursively (never with an array replacer, which
// would silently drop nested keys), arrays keep their order, and values that
// JSON cannot represent faithfully are rejected instead of being coerced.

import crypto from 'node:crypto';

export const FULL_SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export function dependencyStoreError(code, message, details = undefined) {
    const error = new Error(message);
    error.code = code;
    if (details !== undefined) error.details = details;
    return error;
}

export function canonicalValue(value, trail = '$') {
    if (value === null) return null;
    if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${trail}[${index}]`));
    switch (typeof value) {
    case 'string':
    case 'boolean':
        return value;
    case 'number':
        if (!Number.isFinite(value)) {
            throw dependencyStoreError('PLOINKY_DEPS_CANONICAL_INVALID', `non-finite number at ${trail}`);
        }
        return value;
    case 'object': {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
            throw dependencyStoreError('PLOINKY_DEPS_CANONICAL_INVALID', `non-plain object at ${trail}`);
        }
        const result = {};
        for (const key of Object.keys(value).sort()) {
            if (value[key] === undefined) continue;
            result[key] = canonicalValue(value[key], `${trail}.${key}`);
        }
        return result;
    }
    default:
        throw dependencyStoreError('PLOINKY_DEPS_CANONICAL_INVALID', `unsupported ${typeof value} at ${trail}`);
    }
}

export function canonicalJson(value) {
    return JSON.stringify(canonicalValue(value));
}

export function sha256Hex(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

export function canonicalDigest(value) {
    return sha256Hex(canonicalJson(value));
}

export function assertFullSha256(value, label = 'digest') {
    if (!FULL_SHA256_PATTERN.test(String(value || ''))) {
        throw dependencyStoreError('PLOINKY_DEPS_KEY_INVALID', `${label} must be a full lowercase SHA-256 hex digest`);
    }
    return value;
}

export function isFullGitSha(value) {
    return FULL_GIT_SHA_PATTERN.test(String(value || ''));
}
