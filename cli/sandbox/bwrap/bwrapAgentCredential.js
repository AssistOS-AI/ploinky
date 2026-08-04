import crypto from 'node:crypto';

import {
    AGENT_CREDENTIAL_FILE,
    AGENT_CREDENTIAL_MAX_BYTES,
    AGENT_CREDENTIAL_TTL_SECONDS,
    buildAgentCredentialPublicAttestation,
    computeAgentCredentialAdmissionDigest,
    serializeAgentCredentialDescriptor,
} from '../../../Agent/lib/agentCredentialDescriptor.mjs';
import { buildAgentCredentialEnv } from '../../utils/security/agentIdentityEnv.js';

export const BWRAP_AGENT_CREDENTIAL_FILE = AGENT_CREDENTIAL_FILE;
export const BWRAP_AGENT_CREDENTIAL_MAX_BYTES = AGENT_CREDENTIAL_MAX_BYTES;
export const BWRAP_AGENT_CREDENTIAL_TTL_SECONDS = AGENT_CREDENTIAL_TTL_SECONDS;

const INPUT_FIELDS = new Set([
    'principalId', 'instanceId', 'enableGeneration', 'runtimeKey', 'routeKey', 'router', 'admission',
]);
const ROUTER_FIELDS = new Set(['physicalOrigin', 'requestAuthority', 'host', 'port']);
const ADMISSION_FIELDS = new Set(['runtimeKind', 'manifestDigest', 'capabilityDigest', 'networkHash']);

function assertExactInputRecord(value, fields, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype
        || Object.keys(value).length !== fields.size
        || Object.keys(value).some((key) => !fields.has(key))) {
        throw new Error(`bwrapAgentCredential: ${label} has missing or unknown fields`);
    }
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function exactNonce(randomBytes) {
    const bytes = randomBytes(32);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
        throw new Error('bwrapAgentCredential: randomBytes must return exactly 32 bytes');
    }
    return Buffer.from(bytes).toString('base64url');
}

/**
 * Build the one-generation bwrap credential artifact in memory.
 *
 * This module deliberately exposes no write/persist API. The caller owns the
 * dedicated child pipe and must send `bytes` directly to the helper's
 * `--ro-bind-data` input before closing the pipe.
 */
export function buildBwrapAgentCredential(input, {
    now = () => Math.floor(Date.now() / 1000),
    randomBytes = crypto.randomBytes,
    buildCredentialEnv = buildAgentCredentialEnv,
} = {}) {
    assertExactInputRecord(input, INPUT_FIELDS, 'input');
    assertExactInputRecord(input.router, ROUTER_FIELDS, 'router');
    assertExactInputRecord(input.admission, ADMISSION_FIELDS, 'admission');
    const issuedAt = typeof now === 'function' ? now() : now;
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
        throw new Error('bwrapAgentCredential: issuedAt must be nonnegative Unix seconds');
    }
    const credentialEnv = buildCredentialEnv(input.principalId, {
        instanceId: input.instanceId,
        enableGeneration: input.enableGeneration,
    });
    const admission = {
        runtimeKind: input.admission?.runtimeKind,
        manifestDigest: input.admission?.manifestDigest,
        capabilityDigest: input.admission?.capabilityDigest,
        networkHash: input.admission?.networkHash,
    };
    const descriptor = {
        schemaVersion: 1,
        principalId: input.principalId,
        instanceId: input.instanceId,
        enableGeneration: input.enableGeneration,
        runtimeKey: input.runtimeKey,
        routeKey: input.routeKey,
        router: {
            physicalOrigin: input.router?.physicalOrigin,
            requestAuthority: input.router?.requestAuthority,
            host: input.router?.host,
            port: input.router?.port,
        },
        admission,
        admissionDigest: computeAgentCredentialAdmissionDigest(admission),
        nonce: exactNonce(randomBytes),
        issuedAt,
        expiresAt: issuedAt + BWRAP_AGENT_CREDENTIAL_TTL_SECONDS,
        credentials: {
            agentSecret: credentialEnv.PLOINKY_AGENT_SECRET,
            privateSecret: credentialEnv.PLOINKY_AGENT_PRIVATE_SECRET,
            apiKey: credentialEnv.PLOINKY_AGENT_API_KEY,
            apiPublicKey: credentialEnv.PLOINKY_AGENT_API_PUBLIC_KEY,
        },
    };
    const bytes = serializeAgentCredentialDescriptor(descriptor);
    deepFreeze(descriptor);
    return Object.freeze({
        bytes,
        descriptor,
        publicAttestation: buildAgentCredentialPublicAttestation(descriptor),
    });
}

export default {
    buildBwrapAgentCredential,
    BWRAP_AGENT_CREDENTIAL_FILE,
    BWRAP_AGENT_CREDENTIAL_MAX_BYTES,
    BWRAP_AGENT_CREDENTIAL_TTL_SECONDS,
};
