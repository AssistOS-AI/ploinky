import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    getSubjectIdentityPublicKey,
    signGeneratedRouterDescriptor,
    verifyGeneratedRouterDescriptorSignature,
} from './subjectIdentityKey.js';

export const GENERATED_ROUTER_DESCRIPTOR_SCHEMA = 'ploinky.generated-local-router.v1';
export const GENERATED_ROUTER_TRANSPORT_VERSION = 'node-authority-v1';
export const GENERATED_ROUTER_LOCAL_STREAMING = 'disabled';
export const GENERATED_ROUTER_DESCRIPTOR_CONTAINER_FILE = '/run/ploinky/router-descriptor.json';

const PAYLOAD_FIELDS = Object.freeze([
    'agentPrincipal',
    'attestationId',
    'edgeTopologyFile',
    'expiresAtUnixMs',
    'generationId',
    'instanceId',
    'internalRouterUrl',
    'issuedAtUnixMs',
    'launchId',
    'listenerClass',
    'localStreaming',
    'networkFingerprint',
    'physicalOrigin',
    'publicAuthority',
    'requestAuthority',
    'routerHost',
    'routerPort',
    'runtimeProof',
    'schema',
    'semanticTopologyDigest',
    'socketLocalAddressClass',
    'topology',
    'transportVersion',
]);

const PAYLOAD_FIELD_SET = new Set(PAYLOAD_FIELDS);
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const LOOPBACK_AUTHORITY_RE = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/;

export class GeneratedRouterDescriptorError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'GeneratedRouterDescriptorError';
        this.code = code;
    }
}

function descriptorError(code, message, cause) {
    return new GeneratedRouterDescriptorError(code, message, cause ? { cause } : undefined);
}

function assertPlainRecord(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', `${label} must be a plain object`);
    }
    return value;
}

function canonicalValue(value, seen) {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_CANONICAL', 'canonical JSON rejects non-finite numbers');
        }
        return Object.is(value, -0) ? '0' : JSON.stringify(value);
    }
    if (typeof value !== 'object') {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_CANONICAL', `canonical JSON rejects ${typeof value} values`);
    }
    if (seen.has(value)) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_CANONICAL', 'canonical JSON rejects cyclic objects');
    }
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.prototype.hasOwnProperty.call(value, index)) {
                    throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_CANONICAL', 'canonical JSON rejects sparse arrays');
                }
            }
            const ownKeys = Reflect.ownKeys(value).filter((key) => key !== 'length');
            if (ownKeys.some((key) => typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key))) {
                throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_CANONICAL', 'canonical JSON rejects non-index array properties');
            }
            return `[${value.map((entry) => canonicalValue(entry, seen)).join(',')}]`;
        }
        assertPlainRecord(value, 'canonical JSON object');
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const ownKeys = Reflect.ownKeys(value);
        if (ownKeys.some((key) => typeof key !== 'string')) {
            throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_CANONICAL', 'canonical JSON rejects symbol keys');
        }
        for (const key of ownKeys) {
            const property = descriptors[key];
            if (!property?.enumerable || property.get || property.set) {
                throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_CANONICAL', 'canonical JSON rejects accessors and non-enumerable properties');
            }
        }
        return `{${ownKeys.sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key], seen)}`).join(',')}}`;
    } finally {
        seen.delete(value);
    }
}

export function canonicalJson(value) {
    return canonicalValue(value, new Set());
}

export function canonicalJsonBytes(value) {
    return Buffer.from(canonicalJson(value), 'utf8');
}

function parseOrigin(value, field) {
    if (typeof value !== 'string' || !value) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', `${field} must be a nonempty HTTP(S) origin`);
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch (error) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', `${field} must be a valid HTTP(S) origin`, error);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
        || parsed.username || parsed.password || parsed.pathname !== '/'
        || parsed.search || parsed.hash || parsed.origin !== value) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', `${field} must be an exact HTTP(S) origin without credentials, path, query, or fragment`);
    }
    return parsed;
}

function parseAuthority(value, field) {
    if (typeof value !== 'string' || !value || value.endsWith(':') || /[\s\\/@?#,]/.test(value)) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', `${field} is invalid`);
    }
    let parsed;
    try {
        parsed = new URL(`http://${value}/`);
    } catch (error) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', `${field} is invalid`, error);
    }
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/'
        || parsed.search || parsed.hash || parsed.host.toLowerCase() !== value.toLowerCase()) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', `${field} is invalid`);
    }
    return parsed.host.toLowerCase();
}

function requireString(payload, field) {
    const value = payload[field];
    if (typeof value !== 'string' || !value || value !== value.trim()) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', `${field} must be a nonempty exact string`);
    }
    return value;
}

export function validateGeneratedRouterDescriptorPayload(payload, { allowStreamingEnabled = false } = {}) {
    assertPlainRecord(payload, 'generated Router descriptor payload');
    const keys = Object.keys(payload);
    if (keys.length !== PAYLOAD_FIELDS.length || keys.some((key) => !PAYLOAD_FIELD_SET.has(key))) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'generated Router descriptor payload has missing or unknown fields');
    }
    if (payload.schema !== GENERATED_ROUTER_DESCRIPTOR_SCHEMA
        || payload.transportVersion !== GENERATED_ROUTER_TRANSPORT_VERSION) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'generated Router descriptor schema or transport version is unsupported');
    }
    if (payload.localStreaming !== GENERATED_ROUTER_LOCAL_STREAMING
        && !(allowStreamingEnabled && payload.localStreaming === 'enabled')) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'generated-local streaming is not certified');
    }
    if (payload.expiresAtUnixMs !== null) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'schema v1 expiresAtUnixMs must be exactly null');
    }
    if (!Number.isSafeInteger(payload.issuedAtUnixMs) || payload.issuedAtUnixMs < 0) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'issuedAtUnixMs must be a nonnegative safe integer');
    }
    for (const field of ['agentPrincipal', 'instanceId', 'generationId', 'launchId', 'topology', 'routerHost', 'routerPort']) {
        requireString(payload, field);
    }
    for (const field of ['attestationId', 'networkFingerprint', 'semanticTopologyDigest']) {
        if (!DIGEST_RE.test(requireString(payload, field))) {
            throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', `${field} must be a canonical sha256 digest`);
        }
    }
    const physicalOrigin = parseOrigin(payload.physicalOrigin, 'physicalOrigin');
    parseOrigin(payload.internalRouterUrl, 'internalRouterUrl');
    const publicAuthority = parseAuthority(payload.publicAuthority, 'publicAuthority');
    const requestAuthority = parseAuthority(payload.requestAuthority, 'requestAuthority');
    const publicMatch = LOOPBACK_AUTHORITY_RE.exec(publicAuthority);
    if (!publicMatch || Number(publicMatch[1]) > 65535) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'publicAuthority must be canonical loopback plus the selected Router host port');
    }
    if (!['public', 'managed'].includes(payload.listenerClass)
        || payload.socketLocalAddressClass !== payload.listenerClass) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'listener/address classes must be the same supported exact class');
    }
    if (payload.listenerClass === 'public' && requestAuthority !== publicAuthority) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'public listener requestAuthority must equal publicAuthority');
    }
    if (payload.listenerClass === 'managed'
        && (requestAuthority !== 'host.containers.internal:8080' || requestAuthority === publicAuthority)) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'managed listener requestAuthority must be the distinct managed Router authority');
    }
    if (physicalOrigin.hostname.toLowerCase() !== payload.routerHost.toLowerCase()
        || String(physicalOrigin.port || (physicalOrigin.protocol === 'https:' ? 443 : 80)) !== payload.routerPort) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'Router host/port mirrors do not match physicalOrigin');
    }
    assertPlainRecord(payload.runtimeProof, 'runtimeProof');
    canonicalJson(payload.runtimeProof);
    if (payload.semanticTopologyDigest !== semanticTopologyDigest(payload)) {
        throw descriptorError(
            'PLOINKY_ROUTER_DESCRIPTOR_INVALID',
            'semanticTopologyDigest does not match the exact signed topology inputs',
        );
    }
    return payload;
}

export function semanticTopologyDigest(fields) {
    const topology = {
        listenerClass: fields.listenerClass,
        localStreaming: fields.localStreaming,
        networkFingerprint: fields.networkFingerprint,
        physicalOrigin: fields.physicalOrigin,
        publicAuthority: fields.publicAuthority,
        requestAuthority: fields.requestAuthority,
        runtimeProof: fields.runtimeProof,
        socketLocalAddressClass: fields.socketLocalAddressClass,
        topology: fields.topology,
        transportVersion: fields.transportVersion,
    };
    return `sha256:${crypto.createHash('sha256').update(canonicalJsonBytes(topology)).digest('hex')}`;
}

export function createGeneratedRouterDescriptorPayload(fields) {
    const payload = {
        ...fields,
        schema: GENERATED_ROUTER_DESCRIPTOR_SCHEMA,
        transportVersion: GENERATED_ROUTER_TRANSPORT_VERSION,
        localStreaming: GENERATED_ROUTER_LOCAL_STREAMING,
        expiresAtUnixMs: null,
    };
    payload.semanticTopologyDigest = semanticTopologyDigest(payload);
    validateGeneratedRouterDescriptorPayload(payload);
    return Object.freeze(payload);
}

export function signGeneratedRouterDescriptorEnvelope(payload) {
    validateGeneratedRouterDescriptorPayload(payload);
    const payloadBytes = canonicalJsonBytes(payload);
    const signature = signGeneratedRouterDescriptor(payloadBytes);
    const publicKey = getSubjectIdentityPublicKey();
    if (!verifyGeneratedRouterDescriptorSignature(payloadBytes, signature, publicKey)) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_SIGNATURE', 'generated Router descriptor signature self-verification failed');
    }
    const envelope = Object.freeze({ payload, signature });
    return Object.freeze({
        envelope,
        bytes: canonicalJsonBytes(envelope),
        publicKey,
        signedEnvelopeDigest: `sha256:${crypto.createHash('sha256').update(canonicalJsonBytes(envelope)).digest('hex')}`,
    });
}

export function readVerifiedGeneratedRouterDescriptorFile(file) {
    const target = path.resolve(String(file || ''));
    if (!target || target === path.parse(target).root) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_PATH', 'descriptor input path must be a specific file');
    }
    let descriptor;
    try {
        descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const before = fs.fstatSync(descriptor);
        if (!before.isFile() || (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 64 * 1024) {
            throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor input must be one exact 0600 regular file no larger than 64 KiB');
        }
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
            const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
            if (read < 1) throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor input changed during its exact read');
            offset += read;
        }
        const after = fs.fstatSync(descriptor);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
            || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
            throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor input identity changed during verification');
        }
        let envelope;
        try { envelope = JSON.parse(bytes.toString('utf8')); } catch (error) {
            throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor envelope is not valid JSON', error);
        }
        assertPlainRecord(envelope, 'generated Router descriptor envelope');
        if (Object.keys(envelope).sort().join(',') !== 'payload,signature'
            || typeof envelope.signature !== 'string'
            || !/^[A-Za-z0-9_-]+$/.test(envelope.signature)) {
            throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor envelope shape or signature encoding is invalid');
        }
        validateGeneratedRouterDescriptorPayload(envelope.payload);
        if (!canonicalJsonBytes(envelope).equals(bytes)) {
            throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_CANONICAL', 'descriptor envelope bytes are not exact canonical JSON');
        }
        const payloadBytes = canonicalJsonBytes(envelope.payload);
        if (!verifyGeneratedRouterDescriptorSignature(
            payloadBytes,
            envelope.signature,
            getSubjectIdentityPublicKey(),
        )) {
            throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_SIGNATURE', 'descriptor signature verification failed');
        }
        return Object.freeze({
            payload: Object.freeze({ ...envelope.payload }),
            bytes,
            identity: Object.freeze({ dev: before.dev, ino: before.ino, size: before.size }),
        });
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
}

export function writeGeneratedRouterDescriptorFile(file, bytes) {
    const target = path.resolve(String(file || ''));
    if (!target || target === path.parse(target).root) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_PATH', 'descriptor output path must be a specific file');
    }
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 64 * 1024) {
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor bytes must be a nonempty Buffer no larger than 64 KiB');
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let published = false;
    try {
        fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
        // Same-directory hard-link publication gives us atomic no-overwrite
        // semantics: a pre-existing launch artifact is never replaced.
        fs.linkSync(temporary, target);
        published = true;
        fs.unlinkSync(temporary);
        fs.chmodSync(target, 0o600);
    } catch (error) {
        try { fs.unlinkSync(temporary); } catch (_) { }
        if (published) {
            try { fs.unlinkSync(target); } catch (_) { }
        }
        throw descriptorError('PLOINKY_ROUTER_DESCRIPTOR_WRITE', 'failed to write generated Router descriptor atomically', error);
    }
    return target;
}

const MIRROR_FIELDS = Object.freeze({
    PLOINKY_ROUTER_HOST: 'routerHost',
    PLOINKY_ROUTER_PORT: 'routerPort',
    PLOINKY_ROUTER_URL: 'physicalOrigin',
    PLOINKY_ROUTER_REQUEST_AUTHORITY: 'requestAuthority',
    PLOINKY_ROUTER_AUTHORITY: 'publicAuthority',
    PLOINKY_INTERNAL_ROUTER_URL: 'internalRouterUrl',
    PLOINKY_EDGE_TOPOLOGY_FILE: 'edgeTopologyFile',
    PLOINKY_ROUTER_LISTENER_CLASS: 'listenerClass',
    PLOINKY_ROUTER_ATTESTATION_ID: 'attestationId',
    PLOINKY_ROUTER_TRANSPORT_VERSION: 'transportVersion',
    PLOINKY_ROUTER_LOCAL_STREAMING: 'localStreaming',
    PLOINKY_AGENT_ID: 'agentPrincipal',
    PLOINKY_AGENT_PRINCIPAL: 'agentPrincipal',
    PLOINKY_AGENT_INSTANCE_ID: 'instanceId',
    PLOINKY_AGENT_ENABLE_GENERATION: 'generationId',
});

export function buildGeneratedRouterDescriptorEnv(payload, {
    descriptorFile = GENERATED_ROUTER_DESCRIPTOR_CONTAINER_FILE,
} = {}) {
    validateGeneratedRouterDescriptorPayload(payload);
    const env = { PLOINKY_ROUTER_DESCRIPTOR_FILE: descriptorFile };
    for (const [name, field] of Object.entries(MIRROR_FIELDS)) env[name] = String(payload[field]);
    for (const name of Object.keys(env)) env[`PLOINKY_ENV_SOURCE_${name}`] = 'generated';
    return Object.freeze(env);
}

export default {
    canonicalJson,
    canonicalJsonBytes,
    validateGeneratedRouterDescriptorPayload,
    createGeneratedRouterDescriptorPayload,
    signGeneratedRouterDescriptorEnvelope,
    readVerifiedGeneratedRouterDescriptorFile,
    writeGeneratedRouterDescriptorFile,
    buildGeneratedRouterDescriptorEnv,
};
