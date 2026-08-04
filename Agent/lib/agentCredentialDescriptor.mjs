import crypto from 'node:crypto';
import fs from 'node:fs';

export const AGENT_CREDENTIAL_SCHEMA_VERSION = 1;
export const AGENT_CREDENTIAL_MAX_BYTES = 4096;
export const AGENT_CREDENTIAL_TTL_SECONDS = 86400;
export const AGENT_CREDENTIAL_FILE = '/run/ploinky-agent/credential.json';
export const AGENT_MANIFEST_FILE = '/code/manifest.json';

const DESCRIPTOR_FIELDS = Object.freeze([
    'schemaVersion',
    'principalId',
    'instanceId',
    'enableGeneration',
    'runtimeKey',
    'routeKey',
    'router',
    'admission',
    'admissionDigest',
    'nonce',
    'issuedAt',
    'expiresAt',
    'credentials',
]);
const ROUTER_FIELDS = Object.freeze([
    'physicalOrigin',
    'requestAuthority',
    'host',
    'port',
]);
const ADMISSION_FIELDS = Object.freeze([
    'runtimeKind',
    'manifestDigest',
    'capabilityDigest',
    'networkHash',
]);
const CREDENTIAL_FIELDS = Object.freeze([
    'agentSecret',
    'privateSecret',
    'apiKey',
    'apiPublicKey',
]);

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const HEX_SECRET_RE = /^[a-f0-9]{64}$/;
const PRINCIPAL_RE = /^agent:[^/:\s\x00-\x1f\x7f]+\/[^/:\s\x00-\x1f\x7f]+$/;
const SAFE_KEY_RE = /^[A-Za-z0-9_.-]+$/;
const REQUEST_AUTHORITY_RE = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/;

export class AgentCredentialDescriptorError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'AgentCredentialDescriptorError';
        this.code = code;
    }
}

function fail(code, message, cause) {
    throw new AgentCredentialDescriptorError(code, message, cause ? { cause } : undefined);
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype) {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', `${label} must be a plain object`);
    }
    return value;
}

function assertExactKeys(value, expected, label) {
    assertPlainObject(value, label);
    const keys = Object.keys(value);
    const expectedSet = new Set(expected);
    if (keys.length !== expected.length || keys.some((key) => !expectedSet.has(key))) {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', `${label} has missing or unknown fields`);
    }
}

function canonicalValue(value, seen) {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            fail('PLOINKY_AGENT_CREDENTIAL_CANONICAL', 'canonical JSON rejects non-finite numbers');
        }
        return Object.is(value, -0) ? '0' : JSON.stringify(value);
    }
    if (!value || typeof value !== 'object') {
        fail('PLOINKY_AGENT_CREDENTIAL_CANONICAL', `canonical JSON rejects ${typeof value} values`);
    }
    if (seen.has(value)) fail('PLOINKY_AGENT_CREDENTIAL_CANONICAL', 'canonical JSON rejects cycles');
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.prototype.hasOwnProperty.call(value, index)) {
                    fail('PLOINKY_AGENT_CREDENTIAL_CANONICAL', 'canonical JSON rejects sparse arrays');
                }
            }
            const ownKeys = Reflect.ownKeys(value).filter((key) => key !== 'length');
            if (ownKeys.some((key) => typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key))) {
                fail('PLOINKY_AGENT_CREDENTIAL_CANONICAL', 'canonical JSON rejects non-index array fields');
            }
            return `[${value.map((entry) => canonicalValue(entry, seen)).join(',')}]`;
        }
        assertPlainObject(value, 'canonical JSON object');
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const ownKeys = Reflect.ownKeys(value);
        if (ownKeys.some((key) => typeof key !== 'string')) {
            fail('PLOINKY_AGENT_CREDENTIAL_CANONICAL', 'canonical JSON rejects symbol fields');
        }
        for (const key of ownKeys) {
            const property = descriptors[key];
            if (!property?.enumerable || property.get || property.set) {
                fail('PLOINKY_AGENT_CREDENTIAL_CANONICAL', 'canonical JSON rejects hidden fields and accessors');
            }
        }
        return `{${ownKeys.sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key], seen)}`).join(',')}}`;
    } finally {
        seen.delete(value);
    }
}

export function canonicalAgentCredentialJson(value) {
    return canonicalValue(value, new Set());
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function requireExactText(value, field, { maxBytes = 255, pattern } = {}) {
    if (typeof value !== 'string' || !value || value !== value.trim()
        || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes
        || (pattern && !pattern.test(value))) {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', `${field} must be an exact bounded value`);
    }
    return value;
}

function requireSafeKey(value, field) {
    const exact = requireExactText(value, field, { pattern: SAFE_KEY_RE });
    if (exact === '.' || exact === '..') {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', `${field} is not a safe key`);
    }
    return exact;
}

function requireDigest(value, field) {
    if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', `${field} must be a canonical sha256 digest`);
    }
    return value;
}

function decodeNonce(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', 'nonce must be canonical base64url for 32 bytes');
    }
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length !== 32 || decoded.toString('base64url') !== value) {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', 'nonce must be canonical base64url for 32 bytes');
    }
    return decoded;
}

export function computeAgentCredentialAdmissionDigest(admission) {
    return `sha256:${crypto.createHash('sha256')
        .update(Buffer.from(canonicalAgentCredentialJson(admission), 'utf8'))
        .digest('hex')}`;
}

function nonceDigest(nonce) {
    return `sha256:${crypto.createHash('sha256').update(decodeNonce(nonce)).digest('hex')}`;
}

export function validateAgentCredentialDescriptor(value) {
    assertExactKeys(value, DESCRIPTOR_FIELDS, 'agent credential descriptor');
    if (value.schemaVersion !== AGENT_CREDENTIAL_SCHEMA_VERSION) {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', 'agent credential schema version is unsupported');
    }
    requireExactText(value.principalId, 'principalId', { pattern: PRINCIPAL_RE });
    requireSafeKey(value.instanceId, 'instanceId');
    requireSafeKey(value.enableGeneration, 'enableGeneration');
    requireSafeKey(value.runtimeKey, 'runtimeKey');
    requireSafeKey(value.routeKey, 'routeKey');

    assertExactKeys(value.router, ROUTER_FIELDS, 'router');
    if (value.router.host !== '127.0.0.1'
        || value.router.port !== 8080
        || value.router.physicalOrigin !== 'http://127.0.0.1:8080') {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', 'router must use the fixed inner loopback endpoint');
    }
    const authority = typeof value.router.requestAuthority === 'string'
        ? REQUEST_AUTHORITY_RE.exec(value.router.requestAuthority)
        : null;
    if (!authority || Number(authority[1]) > 65535) {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', 'requestAuthority must be canonical loopback plus a valid port');
    }

    assertExactKeys(value.admission, ADMISSION_FIELDS, 'admission');
    if (value.admission.runtimeKind !== 'bwrap') {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', "admission.runtimeKind must be exactly 'bwrap'");
    }
    requireDigest(value.admission.manifestDigest, 'admission.manifestDigest');
    requireDigest(value.admission.capabilityDigest, 'admission.capabilityDigest');
    requireDigest(value.admission.networkHash, 'admission.networkHash');
    requireDigest(value.admissionDigest, 'admissionDigest');
    if (value.admissionDigest !== computeAgentCredentialAdmissionDigest(value.admission)) {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', 'admissionDigest does not match the canonical admission');
    }

    decodeNonce(value.nonce);
    if (!Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0
        || !Number.isSafeInteger(value.expiresAt)
        || value.expiresAt - value.issuedAt !== AGENT_CREDENTIAL_TTL_SECONDS) {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', 'credential lifetime must be the exact supported TTL');
    }

    assertExactKeys(value.credentials, CREDENTIAL_FIELDS, 'credentials');
    if (!HEX_SECRET_RE.test(value.credentials.agentSecret)
        || !HEX_SECRET_RE.test(value.credentials.privateSecret)) {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', 'agent credential secrets are malformed');
    }
    requireExactText(value.credentials.apiKey, 'credentials.apiKey', { maxBytes: 2048 });
    if (!value.credentials.apiKey.startsWith(`${value.principalId}|`)) {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', 'credentials.apiKey does not belong to principalId');
    }
    const publicKey = requireExactText(value.credentials.apiPublicKey, 'credentials.apiPublicKey', {
        maxBytes: 128,
        pattern: /^[A-Za-z0-9_-]+$/,
    });
    const decodedPublicKey = Buffer.from(publicKey, 'base64url');
    if (decodedPublicKey.length !== 32 || decodedPublicKey.toString('base64url') !== publicKey) {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', 'credentials.apiPublicKey is malformed');
    }
    return value;
}

export function serializeAgentCredentialDescriptor(value) {
    validateAgentCredentialDescriptor(value);
    const bytes = Buffer.from(`${canonicalAgentCredentialJson(value)}\n`, 'utf8');
    if (bytes.length < 2 || bytes.length > AGENT_CREDENTIAL_MAX_BYTES) {
        fail('PLOINKY_AGENT_CREDENTIAL_BOUNDS', `agent credential descriptor exceeds ${AGENT_CREDENTIAL_MAX_BYTES} bytes`);
    }
    return bytes;
}

export function buildAgentCredentialPublicAttestation(value) {
    validateAgentCredentialDescriptor(value);
    return deepFreeze({
        schemaVersion: value.schemaVersion,
        principalId: value.principalId,
        instanceId: value.instanceId,
        enableGeneration: value.enableGeneration,
        runtimeKey: value.runtimeKey,
        routeKey: value.routeKey,
        router: { ...value.router },
        admission: { ...value.admission },
        admissionDigest: value.admissionDigest,
        nonceDigest: nonceDigest(value.nonce),
        issuedAt: value.issuedAt,
        expiresAt: value.expiresAt,
    });
}

function requireGeneratedEnvMatch(env, descriptor) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
        fail('PLOINKY_AGENT_CREDENTIAL_PROVENANCE', 'generated runtime environment is required');
    }
    const mirrors = Object.freeze({
        PLOINKY_AGENT_ID: descriptor.principalId,
        PLOINKY_AGENT_PRINCIPAL: descriptor.principalId,
        PLOINKY_AGENT_INSTANCE_ID: descriptor.instanceId,
        PLOINKY_AGENT_ENABLE_GENERATION: descriptor.enableGeneration,
    });
    for (const [name, expected] of Object.entries(mirrors)) {
        if (!Object.prototype.hasOwnProperty.call(env, name)
            || env[name] !== expected
            || env[`PLOINKY_ENV_SOURCE_${name}`] !== 'generated') {
            fail('PLOINKY_AGENT_CREDENTIAL_PROVENANCE', `${name} does not match generated credential identity`);
        }
    }
    if (env.PLOINKY_AGENT_CREDENTIAL_FILE !== AGENT_CREDENTIAL_FILE
        || env.PLOINKY_ENV_SOURCE_PLOINKY_AGENT_CREDENTIAL_FILE !== 'generated') {
        fail('PLOINKY_AGENT_CREDENTIAL_PROVENANCE', 'credential locator does not have exact generated provenance');
    }
}

function readBoundedCredentialFile(credentialPath, { fsApi = fs, expectedUid } = {}) {
    let descriptor;
    try {
        const constants = fsApi.constants || fs.constants;
        if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
            fail('PLOINKY_AGENT_CREDENTIAL_READ', 'credential input requires O_NOFOLLOW support');
        }
        descriptor = fsApi.openSync(
            credentialPath,
            constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const before = fsApi.fstatSync(descriptor, { bigint: true });
        const uid = expectedUid === undefined
            ? (typeof process.getuid === 'function' ? BigInt(process.getuid()) : null)
            : BigInt(expectedUid);
        if (!before.isFile()
            || (before.mode & 0o7777n) !== 0o400n
            || before.size < 1n
            || before.size > BigInt(AGENT_CREDENTIAL_MAX_BYTES)
            || (uid !== null && before.uid !== uid)) {
            fail(
                'PLOINKY_AGENT_CREDENTIAL_READ',
                `credential input must be a current-uid 0400 regular file no larger than ${AGENT_CREDENTIAL_MAX_BYTES} bytes`,
            );
        }
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
            const count = fsApi.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
            if (count < 1) fail('PLOINKY_AGENT_CREDENTIAL_READ', 'credential input changed during its exact read');
            offset += count;
        }
        if (fsApi.readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) {
            fail('PLOINKY_AGENT_CREDENTIAL_READ', 'credential input grew during its exact read');
        }
        const after = fsApi.fstatSync(descriptor, { bigint: true });
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
            || after.mode !== before.mode || after.uid !== before.uid
            || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
            fail('PLOINKY_AGENT_CREDENTIAL_READ', 'credential input identity changed during verification');
        }
        return Object.freeze({
            bytes,
            identity: Object.freeze({
                dev: String(before.dev),
                ino: String(before.ino),
                size: Number(before.size),
                uid: Number(before.uid),
            }),
        });
    } catch (error) {
        if (error instanceof AgentCredentialDescriptorError) throw error;
        fail('PLOINKY_AGENT_CREDENTIAL_READ', 'credential input is unavailable or unsafe', error);
    } finally {
        if (descriptor !== undefined) {
            try { fsApi.closeSync(descriptor); } catch (_) { }
        }
    }
}

function readRawManifestDigest(manifestPath, fsApi = fs) {
    let bytes;
    try {
        bytes = fsApi.readFileSync(manifestPath);
    } catch (error) {
        fail('PLOINKY_AGENT_CREDENTIAL_MANIFEST', 'raw agent manifest is unavailable', error);
    }
    return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function readAgentCredentialDescriptorFile({
    credentialPath,
    manifestPath,
    env,
    now = Math.floor(Date.now() / 1000),
    expectedUid,
    fsApi = fs,
}) {
    if (typeof credentialPath !== 'string' || !credentialPath || credentialPath.includes('\0')
        || typeof manifestPath !== 'string' || !manifestPath || manifestPath.includes('\0')) {
        fail('PLOINKY_AGENT_CREDENTIAL_READ', 'test credential and manifest paths must be exact files');
    }
    const file = readBoundedCredentialFile(credentialPath, { fsApi, expectedUid });
    let descriptor;
    try {
        descriptor = JSON.parse(file.bytes.toString('utf8'));
    } catch (error) {
        fail('PLOINKY_AGENT_CREDENTIAL_INVALID', 'credential input is not valid JSON', error);
    }
    validateAgentCredentialDescriptor(descriptor);
    if (!file.bytes.equals(serializeAgentCredentialDescriptor(descriptor))) {
        fail('PLOINKY_AGENT_CREDENTIAL_CANONICAL', 'credential input is not exact canonical JSON plus newline');
    }
    if (!Number.isSafeInteger(now) || now < descriptor.issuedAt || now >= descriptor.expiresAt) {
        fail('PLOINKY_AGENT_CREDENTIAL_EXPIRED', 'credential input is not active at the current time');
    }
    if (readRawManifestDigest(manifestPath, fsApi) !== descriptor.admission.manifestDigest) {
        fail('PLOINKY_AGENT_CREDENTIAL_MANIFEST', 'credential manifest digest does not match /code/manifest.json bytes');
    }
    requireGeneratedEnvMatch(env, descriptor);
    deepFreeze(descriptor);
    return Object.freeze({
        descriptor,
        bytes: Buffer.from(file.bytes),
        publicAttestation: buildAgentCredentialPublicAttestation(descriptor),
        fileIdentity: file.identity,
    });
}

export function readAgentCredentialDescriptor() {
    return readAgentCredentialDescriptorFile({
        credentialPath: AGENT_CREDENTIAL_FILE,
        manifestPath: AGENT_MANIFEST_FILE,
        env: process.env,
    });
}

export const __testables = Object.freeze({
    admissionDigest: computeAgentCredentialAdmissionDigest,
    nonceDigest,
    readAgentCredentialDescriptorFile,
    readBoundedCredentialFile,
    requireGeneratedEnvMatch,
});
