import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = 'ploinky.generated-local-router.v1';
const TRANSPORT_VERSION = 'node-authority-v1';
const LOCAL_STREAMING = 'disabled';
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const SIGNATURE_DOMAIN = Buffer.from('PLOINKY\0GENERATED_LOCAL_ROUTER_DESCRIPTOR\0V1\0', 'utf8');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const PAYLOAD_FIELDS = new Set([
    'agentPrincipal', 'attestationId', 'edgeTopologyFile', 'expiresAtUnixMs',
    'generationId', 'instanceId', 'internalRouterUrl', 'issuedAtUnixMs',
    'launchId', 'listenerClass', 'localStreaming', 'networkFingerprint',
    'physicalOrigin', 'publicAuthority', 'requestAuthority', 'routerHost',
    'routerPort', 'runtimeProof', 'schema', 'semanticTopologyDigest',
    'socketLocalAddressClass', 'topology', 'transportVersion',
]);
const MIRRORS = Object.freeze({
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
const REQUIRED_MARKED_ONLY = Object.freeze([
    'PLOINKY_ROUTER_DESCRIPTOR_FILE',
    'PLOINKY_AGENT_API_PUBLIC_KEY',
    'PLOINKY_AGENT_API_KEY',
]);
const VERIFIED = new WeakSet();

export class AgentRouterDescriptorError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'AgentRouterDescriptorError';
        this.code = code;
    }
}

function fail(code, message, cause) {
    throw new AgentRouterDescriptorError(code, message, cause ? { cause } : undefined);
}

function canonical(value, seen = new Set()) {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor contains a non-finite number');
        return Object.is(value, -0) ? '0' : JSON.stringify(value);
    }
    if (!value || typeof value !== 'object') fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor contains a non-JSON value');
    if (seen.has(value)) fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor contains a cycle');
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.prototype.hasOwnProperty.call(value, index)) fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor contains a sparse array');
            }
            return `[${value.map((entry) => canonical(entry, seen)).join(',')}]`;
        }
        if (Object.getPrototypeOf(value) !== Object.prototype) fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor objects must be plain');
        const keys = Reflect.ownKeys(value);
        if (keys.some((key) => typeof key !== 'string')) fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor contains a symbol key');
        return `{${keys.sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(',')}}`;
    } finally {
        seen.delete(value);
    }
}

function exactOrigin(value, field) {
    let parsed;
    try { parsed = new URL(value); } catch (error) { fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', `${field} is not a valid URL`, error); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
        || parsed.username || parsed.password || parsed.pathname !== '/'
        || parsed.search || parsed.hash || parsed.origin !== value) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', `${field} must be an exact HTTP(S) origin`);
    }
    return parsed;
}

function exactAuthority(value, field) {
    if (typeof value !== 'string' || !value || value.endsWith(':') || /[\s\\/@?#,]/.test(value)) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', `${field} is invalid`);
    }
    let parsed;
    try { parsed = new URL(`http://${value}/`); } catch (error) { fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', `${field} is invalid`, error); }
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/'
        || parsed.search || parsed.hash || parsed.host.toLowerCase() !== value.toLowerCase()) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', `${field} is invalid`);
    }
    return parsed.host.toLowerCase();
}

function semanticTopologyDigest(payload) {
    const topology = {
        listenerClass: payload.listenerClass,
        localStreaming: payload.localStreaming,
        networkFingerprint: payload.networkFingerprint,
        physicalOrigin: payload.physicalOrigin,
        publicAuthority: payload.publicAuthority,
        requestAuthority: payload.requestAuthority,
        runtimeProof: payload.runtimeProof,
        socketLocalAddressClass: payload.socketLocalAddressClass,
        topology: payload.topology,
        transportVersion: payload.transportVersion,
    };
    return `sha256:${crypto.createHash('sha256').update(Buffer.from(canonical(topology), 'utf8')).digest('hex')}`;
}

function validatePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.getPrototypeOf(payload) !== Object.prototype
        || Object.keys(payload).length !== PAYLOAD_FIELDS.size
        || Object.keys(payload).some((key) => !PAYLOAD_FIELDS.has(key))) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor payload has missing or unknown fields');
    }
    if (payload.schema !== SCHEMA || payload.transportVersion !== TRANSPORT_VERSION
        || payload.localStreaming !== LOCAL_STREAMING || payload.expiresAtUnixMs !== null) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor schema, transport, capability, or lifetime is unsupported');
    }
    if (!Number.isSafeInteger(payload.issuedAtUnixMs) || payload.issuedAtUnixMs < 0) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor issue time is invalid');
    }
    for (const field of ['agentPrincipal', 'instanceId', 'generationId', 'launchId', 'topology', 'routerHost', 'routerPort']) {
        if (typeof payload[field] !== 'string' || !payload[field] || payload[field] !== payload[field].trim()) {
            fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', `descriptor ${field} is invalid`);
        }
    }
    for (const field of ['attestationId', 'networkFingerprint', 'semanticTopologyDigest']) {
        if (!DIGEST_RE.test(payload[field])) fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', `descriptor ${field} is invalid`);
    }
    const origin = exactOrigin(payload.physicalOrigin, 'physicalOrigin');
    exactOrigin(payload.internalRouterUrl, 'internalRouterUrl');
    const publicAuthority = exactAuthority(payload.publicAuthority, 'publicAuthority');
    const requestAuthority = exactAuthority(payload.requestAuthority, 'requestAuthority');
    if (!/^127\.0\.0\.1:([1-9][0-9]{0,4})$/.test(publicAuthority)
        || Number(publicAuthority.slice(publicAuthority.lastIndexOf(':') + 1)) > 65535) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor public authority is not canonical loopback');
    }
    if (!['public', 'managed'].includes(payload.listenerClass)
        || payload.socketLocalAddressClass !== payload.listenerClass) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor listener classes are invalid');
    }
    if ((payload.listenerClass === 'public' && requestAuthority !== publicAuthority)
        || (payload.listenerClass === 'managed'
            && (requestAuthority !== 'host.containers.internal:8080' || requestAuthority === publicAuthority))) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor request authority does not match its listener');
    }
    if (origin.hostname.toLowerCase() !== payload.routerHost.toLowerCase()
        || String(origin.port || (origin.protocol === 'https:' ? 443 : 80)) !== payload.routerPort) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor Router origin mirrors disagree');
    }
    if (!payload.runtimeProof || typeof payload.runtimeProof !== 'object' || Array.isArray(payload.runtimeProof)
        || Object.getPrototypeOf(payload.runtimeProof) !== Object.prototype) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor runtimeProof is invalid');
    }
    canonical(payload.runtimeProof);
    if (payload.semanticTopologyDigest !== semanticTopologyDigest(payload)) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'descriptor semantic topology digest is invalid');
    }
}

function readOwnEnv(env, name) {
    if (!Object.prototype.hasOwnProperty.call(env, name)) fail('PLOINKY_ROUTER_DESCRIPTOR_PROVENANCE', `missing runtime-owned ${name}`);
    const value = env[name];
    if (typeof value !== 'string' || !value) fail('PLOINKY_ROUTER_DESCRIPTOR_PROVENANCE', `runtime-owned ${name} is empty`);
    return value;
}

function requireGeneratedMarker(env, name) {
    if (readOwnEnv(env, `PLOINKY_ENV_SOURCE_${name}`) !== 'generated') {
        fail('PLOINKY_ROUTER_DESCRIPTOR_PROVENANCE', `${name} lacks generated provenance`);
    }
}

function decodePublicKey(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail('PLOINKY_ROUTER_DESCRIPTOR_TRUST', 'Router descriptor trust anchor is invalid');
    const raw = Buffer.from(value, 'base64url');
    if (raw.length !== 32 || raw.toString('base64url') !== value) fail('PLOINKY_ROUTER_DESCRIPTOR_TRUST', 'Router descriptor trust anchor is invalid');
    try {
        return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    } catch (error) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_TRUST', 'Router descriptor trust anchor is invalid', error);
    }
}

function verifySignature(payload, signature, publicKey) {
    if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]+$/.test(signature)) fail('PLOINKY_ROUTER_DESCRIPTOR_SIGNATURE', 'Router descriptor signature is malformed');
    const decoded = Buffer.from(signature, 'base64url');
    if (decoded.length !== 64 || decoded.toString('base64url') !== signature) fail('PLOINKY_ROUTER_DESCRIPTOR_SIGNATURE', 'Router descriptor signature is malformed');
    const payloadBytes = Buffer.from(canonical(payload), 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(payloadBytes.length));
    const signed = Buffer.concat([SIGNATURE_DOMAIN, length, payloadBytes]);
    if (!crypto.verify(null, signed, decodePublicKey(publicKey), decoded)) fail('PLOINKY_ROUTER_DESCRIPTOR_SIGNATURE', 'Router descriptor signature is invalid');
}

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const entry of Object.values(value)) deepFreeze(entry);
        Object.freeze(value);
    }
    return value;
}

function readDescriptorBytes(descriptorFile, fsApi = fs) {
    let pathStat;
    try {
        pathStat = fsApi.lstatSync(descriptorFile, { bigint: true });
    } catch (error) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_READ', 'Router descriptor is unavailable', error);
    }
    if (!pathStat?.isFile?.() || pathStat.isSymbolicLink?.()
        || pathStat.nlink !== 1n || pathStat.size < 2n
        || pathStat.size > BigInt(MAX_DESCRIPTOR_BYTES)
        || (pathStat.mode & 0o777n) !== 0o600n) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_READ', 'Router descriptor must be a bounded single-link 0600 regular non-symlink file');
    }
    const constants = fsApi.constants || fs.constants;
    let descriptor;
    try {
        descriptor = fsApi.openSync(
            descriptorFile,
            constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
        );
        const before = fsApi.fstatSync(descriptor, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n
            || before.dev !== pathStat.dev || before.ino !== pathStat.ino
            || before.size !== pathStat.size || before.size < 2n
            || before.size > BigInt(MAX_DESCRIPTOR_BYTES)
            || (before.mode & 0o777n) !== 0o600n) {
            fail('PLOINKY_ROUTER_DESCRIPTOR_READ', 'Router descriptor identity changed before reading');
        }
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
            const count = fsApi.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
            if (count <= 0) fail('PLOINKY_ROUTER_DESCRIPTOR_READ', 'Router descriptor changed size while reading');
            offset += count;
        }
        if (fsApi.readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) {
            fail('PLOINKY_ROUTER_DESCRIPTOR_READ', 'Router descriptor changed size while reading');
        }
        const after = fsApi.fstatSync(descriptor, { bigint: true });
        if (after.dev !== before.dev || after.ino !== before.ino
            || after.nlink !== before.nlink || after.size !== before.size
            || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
            fail('PLOINKY_ROUTER_DESCRIPTOR_READ', 'Router descriptor changed while reading');
        }
        const afterPath = fsApi.lstatSync(descriptorFile, { bigint: true });
        if (afterPath.isSymbolicLink() || !afterPath.isFile() || afterPath.nlink !== 1n
            || afterPath.dev !== before.dev || afterPath.ino !== before.ino
            || afterPath.size !== before.size
            || afterPath.mtimeNs !== before.mtimeNs || afterPath.ctimeNs !== before.ctimeNs) {
            fail('PLOINKY_ROUTER_DESCRIPTOR_READ', 'Router descriptor path identity changed while reading');
        }
        return bytes;
    } catch (error) {
        if (error instanceof AgentRouterDescriptorError) throw error;
        fail('PLOINKY_ROUTER_DESCRIPTOR_READ', 'Router descriptor cannot be read', error);
    } finally {
        if (descriptor !== undefined) {
            try { fsApi.closeSync(descriptor); } catch (_) {}
        }
    }
}

export function loadVerifiedGeneratedRouterDescriptor({ env = process.env, fsApi = fs } = {}) {
    // Validate descriptor locator and trust-anchor provenance before touching
    // any generated credential or assertion secret.
    requireGeneratedMarker(env, 'PLOINKY_ROUTER_DESCRIPTOR_FILE');
    requireGeneratedMarker(env, 'PLOINKY_AGENT_API_PUBLIC_KEY');
    const descriptorFile = readOwnEnv(env, 'PLOINKY_ROUTER_DESCRIPTOR_FILE');
    if (!path.isAbsolute(descriptorFile) || descriptorFile.includes('\0')) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_READ', 'Router descriptor locator must be an absolute non-NUL path');
    }
    const publicKey = readOwnEnv(env, 'PLOINKY_AGENT_API_PUBLIC_KEY');
    const bytes = readDescriptorBytes(descriptorFile, fsApi);
    let envelope;
    try { envelope = JSON.parse(bytes.toString('utf8')); } catch (error) { fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'Router descriptor JSON is invalid', error); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
        || Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, 'payload') || !Object.hasOwn(envelope, 'signature')) {
        fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'Router descriptor envelope is invalid');
    }
    validatePayload(envelope.payload);
    const canonicalEnvelope = canonical(envelope);
    if (!bytes.equals(Buffer.from(canonicalEnvelope, 'utf8'))) fail('PLOINKY_ROUTER_DESCRIPTOR_INVALID', 'Router descriptor bytes are not canonical');
    verifySignature(envelope.payload, envelope.signature, publicKey);

    for (const [name, field] of Object.entries(MIRRORS)) {
        requireGeneratedMarker(env, name);
        if (readOwnEnv(env, name) !== String(envelope.payload[field])) {
            fail('PLOINKY_ROUTER_DESCRIPTOR_PROVENANCE', `runtime-owned ${name} disagrees with the signed descriptor`);
        }
    }
    // These fields are provenance requirements but are not duplicated in the
    // payload. Check them last, after descriptor/signature/mirror validation,
    // so malformed descriptors fail before any API-key value is accessed.
    for (const name of REQUIRED_MARKED_ONLY) {
        requireGeneratedMarker(env, name);
        if (!Object.prototype.hasOwnProperty.call(env, name)) {
            fail('PLOINKY_ROUTER_DESCRIPTOR_PROVENANCE', `missing runtime-owned ${name}`);
        }
    }

    const verified = deepFreeze({
        payload: envelope.payload,
        physicalOrigin: envelope.payload.physicalOrigin,
        publicAuthority: envelope.payload.publicAuthority,
        requestAuthority: envelope.payload.requestAuthority,
        descriptorFile,
    });
    VERIFIED.add(verified);
    return verified;
}

export function assertVerifiedGeneratedRouterDescriptor(value) {
    if (!value || !VERIFIED.has(value)) fail('PLOINKY_ROUTER_DESCRIPTOR_UNVERIFIED', 'a verified generated Router descriptor is required');
    return value;
}

export function resolveGeneratedRouterOperation(descriptor, absolutePath) {
    const verified = assertVerifiedGeneratedRouterDescriptor(descriptor);
    if (typeof absolutePath !== 'string' || !absolutePath.startsWith('/')
        || absolutePath.includes('?') || absolutePath.includes('#') || absolutePath.includes('\\')) {
        fail('PLOINKY_ROUTER_OPERATION_INVALID', 'Router operation path must be an exact absolute path');
    }
    const url = new URL(absolutePath, verified.physicalOrigin);
    if (url.origin !== verified.physicalOrigin || url.pathname !== absolutePath
        || url.search || url.hash || url.username || url.password) {
        fail('PLOINKY_ROUTER_OPERATION_INVALID', 'Router operation escaped its signed origin or exact path');
    }
    return url;
}

export const __descriptorTestables = Object.freeze({ canonical, semanticTopologyDigest, validatePayload });
