// Generic execution-target contract (frozen T0 + A1 + A2): canonical JSON,
// digests and the source-protection / writable-reservation documents that the
// controller-private interlock persists and exchanges.
//
// Every validator is pure: no I/O, no clock, no randomness. A validator returns
// exactly `{ok:true,value}` with a deep-frozen copy of the validated document,
// or exactly `{ok:false,error:{code}}` with one code of CONTRACT_ERROR_CODES.
// Errors never carry raw input, paths or exception text.

import crypto from 'node:crypto';

export const CONTRACT_ERROR_CODES = Object.freeze({
    invalidRequest: 'invalid_request',
    unsupportedVersion: 'unsupported_version',
    noncanonicalEncoding: 'noncanonical_encoding',
    capacityExceeded: 'capacity_exceeded',
});

export const CONTRACT_VERSION = 1;
export const MAX_CANONICAL_DEPTH = 16;
export const MAX_OBJECT_BYTES = 64 * 1024;
export const MAX_CLOSURE_BYTES = 64 * 1024 * 1024;
export const MAX_SAFE_COUNTER = Number.MAX_SAFE_INTEGER;
export const SOURCE_CLOSURE_BOUNDS = Object.freeze({
    roots: 512,
    entries: 65536,
    dependencies: 4096,
    secretReferences: 1024,
});
export const SOURCE_RESERVATION_RESOURCE_BOUND = 64;
export const PRIOR_STORE_IDENTITY_BOUND = 64;

// Workspace-wide controller policy (A1.4 as changed by A2.3: no retired set).
// Never part of a target declaration.
export const INTERLOCK_LIMITS_V1 = Object.freeze({
    writableReservations: 4096,
    sourceStateBytes: 33554432,
    operationReceipts: 65536,
    lockWaitMs: 5000,
});

export const SOURCE_OPERATION_KINDS = Object.freeze(['reserve', 'transition', 'release', 'acknowledge', 'advance']);
export const REPOSITORY_SOURCE_MODES = Object.freeze(['dev', 'prod']);
export const SOURCE_ROLES = Object.freeze([
    'controller', 'worker', 'coordinator', 'agent', 'helper', 'shared-library', 'dependency', 'skill-source',
]);
export const SOURCE_KINDS = Object.freeze(['workspace', 'managed', 'link-install', 'image', 'dependency-store']);
export const FS_FILE_TYPES = Object.freeze(['directory', 'regular', 'symlink']);
export const GIT_STATES = Object.freeze(['tracked-clean', 'tracked-dirty', 'untracked', 'non-git']);
export const DEPENDENCY_KINDS = Object.freeze(['link-install', 'shared-library', 'package-tree', 'executable-runtime']);
export const WRITABLE_RESOURCE_KINDS = Object.freeze([
    'home', 'project', 'target-state', 'retained-gui', 'broker-write', 'pending-create',
]);
export const CONSUMER_KINDS = Object.freeze(['execution', 'terminal', 'retained-gui', 'broker']);
export const RESERVATION_STATES = Object.freeze(['reserved', 'released']);
export const PROTECTION_STATUSES = Object.freeze(['protected', 'unavailable']);
export const STORE_HOLDER_STATES = Object.freeze(['awaiting-holder-ack', 'ready']);

const C = CONTRACT_ERROR_CODES;

// ---------------------------------------------------------------- results

class ContractFailure {
    constructor(code) { this.code = code; }
}

function fail(code) {
    throw new ContractFailure(code);
}

export function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const key of Object.keys(value)) deepFreeze(value[key]);
        Object.freeze(value);
    }
    return value;
}

export function okResult(value) {
    return deepFreeze({ ok: true, value });
}

export function errorResult(code) {
    return deepFreeze({ ok: false, error: { code } });
}

function guarded(fn) {
    try {
        return okResult(fn());
    } catch (error) {
        if (error instanceof ContractFailure) return errorResult(error.code);
        if (error instanceof RangeError) return errorResult(C.invalidRequest);
        throw error;
    }
}

// ---------------------------------------------------------------- canonical JSON

function isWellFormed(text) {
    if (typeof text.isWellFormed === 'function') return text.isWellFormed();
    return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(text);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

const ASCII_KEY = /^[\x00-\x7f]*$/;

function encode(value, depth) {
    if (value === null) return 'null';
    switch (typeof value) {
        case 'boolean':
            return value ? 'true' : 'false';
        case 'number':
            if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail(C.invalidRequest);
            return String(value);
        case 'string':
            if (!isWellFormed(value)) fail(C.noncanonicalEncoding);
            return JSON.stringify(value);
        case 'object':
            break;
        default:
            return fail(C.invalidRequest);
    }
    if (depth + 1 > MAX_CANONICAL_DEPTH) fail(C.invalidRequest);
    if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) fail(C.invalidRequest);
        const keys = Reflect.ownKeys(value);
        if (keys.length !== value.length + 1) fail(C.invalidRequest);
        const parts = [];
        for (let index = 0; index < value.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail(C.invalidRequest);
            parts.push(encode(descriptor.value, depth + 1));
        }
        return `[${parts.join(',')}]`;
    }
    if (!isPlainObject(value)) fail(C.invalidRequest);
    const keys = Reflect.ownKeys(value);
    const names = [];
    for (const key of keys) {
        if (typeof key !== 'string') fail(C.invalidRequest);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!('value' in descriptor) || !descriptor.enumerable) fail(C.invalidRequest);
        if (key === '__proto__') fail(C.invalidRequest);
        if (!ASCII_KEY.test(key)) fail(C.noncanonicalEncoding);
        names.push(key);
    }
    names.sort();
    const parts = names.map((key) => `${JSON.stringify(key)}:${encode(value[key], depth + 1)}`);
    return `{${parts.join(',')}}`;
}

function canonicalText(value) {
    return encode(value, 0);
}

/** Canonical JSON text of a JSON value: `{ok:true,value:string}`. */
export function canonicalTargetJson(value) {
    return guarded(() => canonicalText(value));
}

function sha256Hex(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** SHA-256 (lowercase hex) of the canonical UTF-8 bytes. */
export function targetDigest(value) {
    return guarded(() => sha256Hex(canonicalText(value)));
}

// Internal throwing forms for sibling modules of this contract.
export function canonicalOrThrow(value) {
    return canonicalText(value);
}

export function digestOrThrow(value) {
    return sha256Hex(canonicalText(value));
}

export function isContractFailure(error) {
    return error instanceof ContractFailure;
}

export function contractFailureCode(error) {
    return error instanceof ContractFailure ? error.code : null;
}

// ---------------------------------------------------------------- strict parser

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class StrictJsonParser {
    constructor(text) {
        this.text = text;
        this.index = 0;
    }

    // A5.5: malformed JSON text is noncanonical, never a value-level refusal.
    error() {
        fail(C.noncanonicalEncoding);
    }

    skipWhitespace() {
        const { text } = this;
        while (this.index < text.length) {
            const code = text.charCodeAt(this.index);
            if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) this.index += 1;
            else break;
        }
    }

    parseDocument() {
        this.skipWhitespace();
        const value = this.parseValue(0);
        this.skipWhitespace();
        if (this.index !== this.text.length) this.error();
        return value;
    }

    // `depth` counts enclosing containers; a container nested deeper than 16 levels is a value refusal.
    parseValue(depth) {
        const char = this.text[this.index];
        if ((char === '{' || char === '[') && depth + 1 > MAX_CANONICAL_DEPTH) fail(C.invalidRequest);
        if (char === '{') return this.parseObject(depth);
        if (char === '[') return this.parseArray(depth);
        if (char === '"') return this.parseString();
        if (char === 't') return this.literal('true', true);
        if (char === 'f') return this.literal('false', false);
        if (char === 'n') return this.literal('null', null);
        if (char === '-' || (char >= '0' && char <= '9')) return this.parseNumber();
        return this.error();
    }

    literal(word, value) {
        if (this.text.slice(this.index, this.index + word.length) !== word) this.error();
        this.index += word.length;
        return value;
    }

    parseNumber() {
        const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(this.text.slice(this.index, this.index + 400));
        if (!match) this.error();
        this.index += match[0].length;
        // A5.5: any float spelling (including 1.0 and exponents), -0 and unsafe integers are value refusals.
        if (match[2] !== undefined || match[3] !== undefined || match[0] === '-0') fail(C.invalidRequest);
        const value = Number(match[0]);
        if (!Number.isSafeInteger(value)) fail(C.invalidRequest);
        return value;
    }

    parseString() {
        const { text } = this;
        this.index += 1;
        let out = '';
        while (true) {
            if (this.index >= text.length) this.error();
            const char = text[this.index];
            const code = text.charCodeAt(this.index);
            if (char === '"') {
                this.index += 1;
                return out;
            }
            if (code < 0x20) this.error();
            if (char === '\\') {
                const escape = text[this.index + 1];
                this.index += 2;
                switch (escape) {
                    case '"': out += '"'; break;
                    case '\\': out += '\\'; break;
                    case '/': out += '/'; break;
                    case 'b': out += '\b'; break;
                    case 'f': out += '\f'; break;
                    case 'n': out += '\n'; break;
                    case 'r': out += '\r'; break;
                    case 't': out += '\t'; break;
                    case 'u': {
                        const hex = text.slice(this.index, this.index + 4);
                        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.error();
                        out += String.fromCharCode(parseInt(hex, 16));
                        this.index += 4;
                        break;
                    }
                    default:
                        this.error();
                }
                continue;
            }
            out += char;
            this.index += 1;
        }
    }

    parseArray(depth) {
        this.index += 1;
        const out = [];
        this.skipWhitespace();
        if (this.text[this.index] === ']') {
            this.index += 1;
            return out;
        }
        while (true) {
            this.skipWhitespace();
            out.push(this.parseValue(depth + 1));
            this.skipWhitespace();
            const char = this.text[this.index];
            this.index += 1;
            if (char === ']') return out;
            if (char !== ',') this.error();
        }
    }

    parseObject(depth) {
        this.index += 1;
        const out = {};
        const seen = new Set();
        this.skipWhitespace();
        if (this.text[this.index] === '}') {
            this.index += 1;
            return out;
        }
        while (true) {
            this.skipWhitespace();
            if (this.text[this.index] !== '"') this.error();
            const key = this.parseString();
            // Duplicate keys are rejected before any object is built from them.
            if (seen.has(key)) fail(C.noncanonicalEncoding);
            seen.add(key);
            this.skipWhitespace();
            if (this.text[this.index] !== ':') this.error();
            this.index += 1;
            this.skipWhitespace();
            const value = this.parseValue(depth + 1);
            Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
            this.skipWhitespace();
            const char = this.text[this.index];
            this.index += 1;
            if (char === '}') return out;
            if (char !== ',') this.error();
        }
    }
}

function parseCanonicalOrThrow(input, maxBytes) {
    let text;
    if (typeof input === 'string') {
        if (!isWellFormed(input)) fail(C.noncanonicalEncoding);
        if (Buffer.byteLength(input, 'utf8') > maxBytes) fail(C.capacityExceeded);
        text = input;
    } else if (input instanceof Uint8Array) {
        if (input.length > maxBytes) fail(C.capacityExceeded);
        try {
            text = UTF8.decode(input);
        } catch (_) {
            fail(C.noncanonicalEncoding);
        }
    } else {
        fail(C.invalidRequest);
    }
    if (text.charCodeAt(0) === 0xfeff) fail(C.noncanonicalEncoding);
    const value = new StrictJsonParser(text).parseDocument();
    if (canonicalText(value) !== text) fail(C.noncanonicalEncoding);
    return value;
}

/**
 * Parse wire or stored bytes that must already be canonical. Duplicate keys,
 * invalid UTF-8, lone surrogates, a BOM or any noncanonical spelling refuse
 * `noncanonical_encoding`, as does malformed JSON text (A5.5); a float spelling,
 * `-0`, an unsafe integer or nesting deeper than 16 refuses `invalid_request`.
 */
export function parseCanonicalTargetJson(input, { maxBytes = MAX_OBJECT_BYTES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return errorResult(C.invalidRequest);
    return guarded(() => parseCanonicalOrThrow(input, maxBytes));
}

export function parseCanonicalOrThrowInternal(input, maxBytes) {
    return parseCanonicalOrThrow(input, maxBytes);
}

// ---------------------------------------------------------------- primitive grammars

const BASE64URL_22 = /^[A-Za-z0-9_-]{22}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REF_COMPONENT = /^[A-Za-z0-9._-]{1,128}$/;
const OPAQUE_FORBIDDEN = /[\u0000-\u0020\u007f-\u009f\s]/u;
const U64_MAX = 18446744073709551615n;

export function isId(value) {
    if (typeof value !== 'string' || !BASE64URL_22.test(value)) return false;
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === 16 && bytes.toString('base64url') === value;
}

export function isOperationId(value) {
    return typeof value === 'string' && BASE64URL_22.test(value);
}

export function isDigest(value) {
    return typeof value === 'string' && DIGEST.test(value);
}

export function isOpaqueIdentity(value) {
    return typeof value === 'string'
        && value.length > 0
        && isWellFormed(value)
        && Buffer.byteLength(value, 'utf8') <= 200
        && !OPAQUE_FORBIDDEN.test(value);
}

export function isRef(value) {
    if (typeof value !== 'string') return false;
    const parts = value.split('/');
    return parts.length === 2 && parts.every((part) => REF_COMPONENT.test(part) && part !== '.' && part !== '..');
}

export function isPrincipal(value) {
    return typeof value === 'string' && value.startsWith('agent:') && isRef(value.slice('agent:'.length));
}

export function isCounter(value, { positive = false } = {}) {
    return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)
        && value >= (positive ? 1 : 0);
}

export function isU64Text(value) {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return false;
    return BigInt(value) <= U64_MAX;
}

// Throws invalid_request for grammar, capacity_exceeded for the byte/component bounds.
function relativePath(value) {
    if (typeof value !== 'string' || value.length === 0 || !isWellFormed(value)) fail(C.invalidRequest);
    if (Buffer.byteLength(value, 'utf8') > 4096) fail(C.capacityExceeded);
    if (/[\u0000-\u001f\u007f-\u009f\\]/u.test(value)) fail(C.invalidRequest);
    const components = value.split('/');
    if (components.length > 128) fail(C.capacityExceeded);
    for (const component of components) {
        if (component === '' || component === '.' || component === '..') fail(C.invalidRequest);
        if (Buffer.byteLength(component, 'utf8') > 255) fail(C.capacityExceeded);
    }
    return value;
}

export function isRelativePath(value) {
    try {
        relativePath(value);
        return true;
    } catch (error) {
        if (error instanceof ContractFailure) return false;
        throw error;
    }
}

// ---------------------------------------------------------------- shape helpers

function object(value, keys, { versioned = false } = {}) {
    if (!isPlainObject(value)) fail(C.invalidRequest);
    if (versioned && (!Object.hasOwn(value, 'version') || value.version !== CONTRACT_VERSION)) {
        fail(C.unsupportedVersion);
    }
    const own = Object.keys(value);
    if (own.length !== keys.length) fail(C.invalidRequest);
    for (const key of own) if (!keys.includes(key)) fail(C.invalidRequest);
    return value;
}

function require(condition, code = C.invalidRequest) {
    if (!condition) fail(code);
}

function id(value) { require(isId(value)); }
function operationId(value) { require(isOperationId(value)); }
function digest(value) { require(isDigest(value)); }
function opaque(value) { require(isOpaqueIdentity(value)); }
function principal(value) { require(isPrincipal(value)); }
function counter(value, positive = false) { require(isCounter(value, { positive })); }
function oneOf(value, values) { require(typeof value === 'string' && values.includes(value)); }
function nullOr(value, check) { if (value !== null) check(value); }

function list(value, { min = 0, max }) {
    require(Array.isArray(value));
    if (value.length > max) fail(C.capacityExceeded);
    require(value.length >= min);
    return value;
}

function byteCompare(left, right) {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

// Strictly ascending by key: sorted and duplicate-free.
function strictlyAscending(items, keyOf, compare = byteCompare) {
    for (let index = 1; index < items.length; index += 1) {
        require(compare(keyOf(items[index - 1]), keyOf(items[index])) < 0);
    }
}

function sourceRevision(value) {
    object(value, ['algorithm', 'value']);
    if (value.algorithm === 'git-sha1') require(typeof value.value === 'string' && /^[0-9a-f]{40}$/.test(value.value));
    else if (value.algorithm === 'git-sha256') require(typeof value.value === 'string' && DIGEST.test(value.value));
    else fail(C.invalidRequest);
}

export const FS_IDENTITY_KEYS = Object.freeze(['filesystemId', 'mountId', 'device', 'inode', 'fileType']);

function fsIdentity(value) {
    object(value, FS_IDENTITY_KEYS);
    opaque(value.filesystemId);
    require(isU64Text(value.mountId) && isU64Text(value.device) && isU64Text(value.inode));
    oneOf(value.fileType, FS_FILE_TYPES);
}

export function isFsIdentity(value) {
    try {
        fsIdentity(value);
        return true;
    } catch (error) {
        if (error instanceof ContractFailure) return false;
        throw error;
    }
}

// Credential-free canonical repository identity, at most 512 bytes.
function repositoryIdentity(value) {
    require(typeof value === 'string' && value.length > 0 && isWellFormed(value));
    require(!/[\u0000-\u0020\u007f-\u009f\s]/u.test(value));
    if (Buffer.byteLength(value, 'utf8') > 512) fail(C.capacityExceeded);
    // A URL userinfo component would carry credentials.
    require(!/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*@/.test(value));
}

function validator(check, maxBytes = MAX_OBJECT_BYTES) {
    return (value) => guarded(() => {
        const text = canonicalText(value);
        if (Buffer.byteLength(text, 'utf8') > maxBytes) fail(C.capacityExceeded);
        check(value);
        return JSON.parse(text);
    });
}

// ---------------------------------------------------------------- source protection record

export const SOURCE_PROTECTION_RECORD_KEYS = Object.freeze([
    'version', 'workspaceId', 'boxIdentity', 'boxGeneration', 'sourceStoreIdentity',
    'sourceProtectionEpoch', 'sourceSelectionDigest', 'sourceClosureDigest', 'sourceAcceptanceIdentity',
    'protectionStatus', 'enforcementDigest', 'aliasCoverageDigest', 'acceptedAtMs',
]);

function sourceProtectionRecord(value) {
    object(value, SOURCE_PROTECTION_RECORD_KEYS, { versioned: true });
    opaque(value.workspaceId);
    opaque(value.boxIdentity);
    opaque(value.boxGeneration);
    id(value.sourceStoreIdentity);
    counter(value.sourceProtectionEpoch, true);
    digest(value.sourceSelectionDigest);
    digest(value.sourceClosureDigest);
    opaque(value.sourceAcceptanceIdentity);
    oneOf(value.protectionStatus, PROTECTION_STATUSES);
    // A5.5: an `unavailable` record is a valid document (never launch
    // authority); only a `protected` record must carry both evidence digests.
    if (value.protectionStatus === 'protected') {
        digest(value.enforcementDigest);
        digest(value.aliasCoverageDigest);
    } else {
        nullOr(value.enforcementDigest, digest);
        nullOr(value.aliasCoverageDigest, digest);
    }
    counter(value.acceptedAtMs);
}

export const validateSourceProtectionRecord = validator(sourceProtectionRecord);

// ---------------------------------------------------------------- source selection

const SELECTION_ENTRY_KEYS = Object.freeze([
    'consumerPrincipal', 'role', 'repositoryIdentity', 'revision', 'sourceKind', 'rootIdentity', 'dependencyIdentity',
]);

function sourceSelection(value) {
    object(value, ['version', 'repositorySourceMode', 'selections'], { versioned: true });
    oneOf(value.repositorySourceMode, REPOSITORY_SOURCE_MODES);
    list(value.selections, { min: 1, max: SOURCE_CLOSURE_BOUNDS.roots });
    const encoded = [];
    for (const entry of value.selections) {
        object(entry, SELECTION_ENTRY_KEYS);
        principal(entry.consumerPrincipal);
        oneOf(entry.role, SOURCE_ROLES);
        repositoryIdentity(entry.repositoryIdentity);
        sourceRevision(entry.revision);
        oneOf(entry.sourceKind, SOURCE_KINDS);
        fsIdentity(entry.rootIdentity);
        nullOr(entry.dependencyIdentity, digest);
        encoded.push(canonicalText(entry));
    }
    strictlyAscending(encoded, (entry) => entry);
}

export const validateSourceSelection = validator(sourceSelection);

// ---------------------------------------------------------------- source closure

const ROOT_KEYS = Object.freeze(['rootId', 'rootIdentity', 'repositoryIdentity', 'revision', 'sourceKind']);
const ENTRY_KEYS = Object.freeze([
    'rootId', 'path', 'fileType', 'mode', 'gitState', 'contentDigest', 'linkTarget', 'resolvedIdentity', 'dependencyIdentity',
]);
const DEPENDENCY_KEYS = Object.freeze(['id', 'kind', 'selectionDigest', 'closureDigest', 'rootIdentity', 'lockDigest']);
const SECRET_REFERENCE_KEYS = Object.freeze(['rootId', 'path', 'secretHandleId', 'revisionId']);

export function sameInode(left, right) {
    return left.filesystemId === right.filesystemId && left.device === right.device && left.inode === right.inode;
}

function linkTarget(value) {
    require(typeof value === 'string' && value.length > 0 && isWellFormed(value));
    require(!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
    if (Buffer.byteLength(value, 'utf8') > 4096) fail(C.capacityExceeded);
}

function sourceClosure(value) {
    object(value, ['version', 'roots', 'entries', 'dependencies', 'secretReferences'], { versioned: true });
    list(value.roots, { min: 1, max: SOURCE_CLOSURE_BOUNDS.roots });
    list(value.entries, { max: SOURCE_CLOSURE_BOUNDS.entries });
    list(value.dependencies, { max: SOURCE_CLOSURE_BOUNDS.dependencies });
    list(value.secretReferences, { max: SOURCE_CLOSURE_BOUNDS.secretReferences });
    const rootIds = new Set();
    for (const root of value.roots) {
        object(root, ROOT_KEYS);
        id(root.rootId);
        fsIdentity(root.rootIdentity);
        require(root.rootIdentity.fileType === 'directory');
        // Non-repository roots (image, dependency store) carry no repository identity or revision.
        nullOr(root.repositoryIdentity, repositoryIdentity);
        nullOr(root.revision, sourceRevision);
        oneOf(root.sourceKind, SOURCE_KINDS);
        rootIds.add(root.rootId);
    }
    strictlyAscending(value.roots, (root) => root.rootId);
    const dependencyIds = new Set();
    for (const dependency of value.dependencies) {
        object(dependency, DEPENDENCY_KEYS);
        id(dependency.id);
        oneOf(dependency.kind, DEPENDENCY_KINDS);
        digest(dependency.selectionDigest);
        digest(dependency.closureDigest);
        fsIdentity(dependency.rootIdentity);
        nullOr(dependency.lockDigest, digest);
        dependencyIds.add(dependency.id);
    }
    strictlyAscending(value.dependencies, (dependency) => dependency.id);
    const targets = new Set(value.roots.map((root) => canonicalText(root.rootIdentity)));
    for (const entry of value.entries) {
        object(entry, ENTRY_KEYS);
        require(rootIds.has(entry.rootId));
        relativePath(entry.path);
        oneOf(entry.fileType, FS_FILE_TYPES);
        require(typeof entry.mode === 'string' && /^0[0-7]{3}$/.test(entry.mode));
        oneOf(entry.gitState, GIT_STATES);
        nullOr(entry.resolvedIdentity, fsIdentity);
        nullOr(entry.dependencyIdentity, (dependency) => require(dependencyIds.has(dependency)));
        if (entry.fileType === 'regular') {
            digest(entry.contentDigest);
            require(entry.linkTarget === null);
            require(entry.resolvedIdentity !== null && entry.resolvedIdentity.fileType === 'regular');
        } else if (entry.fileType === 'directory') {
            require(entry.contentDigest === null && entry.linkTarget === null);
            require(entry.resolvedIdentity === null || entry.resolvedIdentity.fileType === 'directory');
        } else {
            require(entry.contentDigest === null);
            linkTarget(entry.linkTarget);
            // Unresolved or link-to-link targets are unsafe.
            require(entry.resolvedIdentity !== null && entry.resolvedIdentity.fileType !== 'symlink');
        }
        if (entry.fileType !== 'symlink' && entry.resolvedIdentity) targets.add(canonicalText(entry.resolvedIdentity));
    }
    strictlyAscending(value.entries, (entry) => entry, (left, right) => (
        left.rootId === right.rootId ? byteCompare(left.path, right.path) : byteCompare(left.rootId, right.rootId)
    ));
    // A symlink's resolved target must itself be part of the closure.
    for (const entry of value.entries) {
        if (entry.fileType !== 'symlink') continue;
        require(targets.has(canonicalText(entry.resolvedIdentity)));
    }
    for (const reference of value.secretReferences) {
        object(reference, SECRET_REFERENCE_KEYS);
        require(rootIds.has(reference.rootId));
        relativePath(reference.path);
        opaque(reference.secretHandleId);
        opaque(reference.revisionId);
    }
    strictlyAscending(value.secretReferences, (reference) => reference, (left, right) => (
        left.rootId === right.rootId ? byteCompare(left.path, right.path) : byteCompare(left.rootId, right.rootId)
    ));
    // A5.3: a secret-bearing input is modelled only by its handle, never also as content.
    const entryKeys = new Set(value.entries.map((entry) => `${entry.rootId}\u0000${entry.path}`));
    for (const reference of value.secretReferences) require(!entryKeys.has(`${reference.rootId}\u0000${reference.path}`));
}

export const validateSourceClosure = validator(sourceClosure, MAX_CLOSURE_BYTES);

// ---------------------------------------------------------------- writable reservations

export const WRITABLE_RESOURCE_KEYS = Object.freeze([
    'resourceId', 'kind', 'rootIdentity', 'bindingChainDigest', 'access', 'aliasCoverageDigest',
]);
export const WRITABLE_RESERVATION_KEYS = Object.freeze([
    'version', 'reservationId', 'operationId',
    'workspaceId', 'boxIdentity', 'boxGeneration', 'sourceStoreIdentity',
    'workerPrincipal', 'workerRuntimeInstanceId', 'workerEnableGeneration', 'workerGeneration',
    'robotId', 'executionId', 'attemptId',
    'consumerKind', 'consumerId',
    'sourceProtectionEpoch', 'sourceSelectionDigest', 'sourceClosureDigest', 'sourceAcceptanceIdentity',
    'resources', 'requestDigest',
    'state', 'createdAtMs', 'releaseEvidenceDigest',
]);
export const RESERVATION_TOMBSTONE_KEYS = Object.freeze([
    'reservationId', 'operationId', 'requestDigest', 'workerPrincipal', 'workerGeneration', 'state', 'releaseEvidenceDigest',
]);

function writableResources(value) {
    list(value, { min: 1, max: SOURCE_RESERVATION_RESOURCE_BOUND });
    for (const resource of value) {
        object(resource, WRITABLE_RESOURCE_KEYS);
        id(resource.resourceId);
        oneOf(resource.kind, WRITABLE_RESOURCE_KINDS);
        fsIdentity(resource.rootIdentity);
        digest(resource.bindingChainDigest);
        require(resource.access === 'write');
        digest(resource.aliasCoverageDigest);
    }
    strictlyAscending(value, (resource) => resource.resourceId);
}

function executionPair(executionId, attemptId) {
    if (executionId === null || attemptId === null) require(executionId === null && attemptId === null);
    else {
        id(executionId);
        id(attemptId);
    }
}

function writableReservation(value) {
    object(value, WRITABLE_RESERVATION_KEYS, { versioned: true });
    id(value.reservationId);
    operationId(value.operationId);
    opaque(value.workspaceId);
    opaque(value.boxIdentity);
    opaque(value.boxGeneration);
    id(value.sourceStoreIdentity);
    principal(value.workerPrincipal);
    opaque(value.workerRuntimeInstanceId);
    opaque(value.workerEnableGeneration);
    id(value.workerGeneration);
    id(value.robotId);
    executionPair(value.executionId, value.attemptId);
    oneOf(value.consumerKind, CONSUMER_KINDS);
    id(value.consumerId);
    counter(value.sourceProtectionEpoch, true);
    digest(value.sourceSelectionDigest);
    digest(value.sourceClosureDigest);
    opaque(value.sourceAcceptanceIdentity);
    writableResources(value.resources);
    digest(value.requestDigest);
    oneOf(value.state, RESERVATION_STATES);
    counter(value.createdAtMs);
    if (value.state === 'reserved') require(value.releaseEvidenceDigest === null);
    else digest(value.releaseEvidenceDigest);
}

export const validateWritableReservation = validator(writableReservation);

function reservationTombstone(value) {
    object(value, RESERVATION_TOMBSTONE_KEYS);
    id(value.reservationId);
    operationId(value.operationId);
    digest(value.requestDigest);
    principal(value.workerPrincipal);
    id(value.workerGeneration);
    require(value.state === 'released');
    digest(value.releaseEvidenceDigest);
}

export const validateReservationTombstone = validator(reservationTombstone);

// ---------------------------------------------------------------- private operations

const RESERVE_REQUEST_KEYS = Object.freeze([
    'version', 'operationId', 'reservationId', 'workspaceId', 'boxIdentity', 'boxGeneration', 'workerGeneration',
    'robotId', 'executionId', 'attemptId', 'consumerKind', 'consumerId', 'expectedEpoch', 'resources',
]);
const RESERVE_TOMBSTONE_RESULT_KEYS = Object.freeze(['version', ...RESERVATION_TOMBSTONE_KEYS, 'sourceStoreIdentity']);
const TRANSITION_REQUEST_KEYS = Object.freeze([
    'version', 'operationId', 'workspaceId', 'boxIdentity', 'boxGeneration', 'expectedEpoch',
    'selectionDigest', 'closureDigest', 'sourceAcceptanceIdentity', 'enforcementDigest', 'aliasCoverageDigest',
]);
const TRANSITION_RESULT_KEYS = Object.freeze([
    'version', 'operationId', 'previousEpoch', 'record', 'requestDigest', 'sourceStoreIdentity',
]);
const RELEASE_REQUEST_KEYS = Object.freeze([
    'version', 'operationId', 'reservationId', 'reservationRequestDigest', 'owningWorkerGeneration',
    'resourcesDigest', 'releaseEvidenceDigest',
]);
const RELEASE_RESULT_KEYS = Object.freeze([
    'version', 'operationId', 'reservationId', 'state', 'requestDigest', 'releaseEvidenceDigest', 'sourceStoreIdentity',
]);
const ACKNOWLEDGE_REQUEST_KEYS = Object.freeze([
    'version', 'operationId', 'sourceStoreIdentity', 'workerGeneration', 'priorStoreIdentities', 'settlementAttestationDigest',
]);
const ACKNOWLEDGE_RESULT_KEYS = Object.freeze([
    'version', 'operationId', 'sourceStoreIdentity', 'workerPrincipal', 'state', 'requestDigest',
]);
const ADVANCE_REQUEST_KEYS = Object.freeze(['version', 'operationId', 'priorGeneration', 'nextGeneration']);
const ADVANCE_RESULT_KEYS = Object.freeze([
    'version', 'operationId', 'workerPrincipal', 'priorGeneration', 'currentGeneration', 'requestDigest',
]);

// expectedEpoch + 1 must stay a safe integer; an overflow never wraps.
function transitionEpoch(value) {
    counter(value);
    require(value < MAX_SAFE_COUNTER);
}

const OPERATION_SCHEMAS = Object.freeze({
    reserve: {
        request(value) {
            object(value, RESERVE_REQUEST_KEYS, { versioned: true });
            operationId(value.operationId);
            id(value.reservationId);
            opaque(value.workspaceId);
            opaque(value.boxIdentity);
            opaque(value.boxGeneration);
            id(value.workerGeneration);
            id(value.robotId);
            executionPair(value.executionId, value.attemptId);
            oneOf(value.consumerKind, CONSUMER_KINDS);
            id(value.consumerId);
            counter(value.expectedEpoch, true);
            writableResources(value.resources);
        },
        result(value) {
            if (isPlainObject(value) && Object.hasOwn(value, 'resources')) {
                writableReservation(value);
                return;
            }
            object(value, RESERVE_TOMBSTONE_RESULT_KEYS, { versioned: true });
            const { version, sourceStoreIdentity, ...tombstone } = value;
            reservationTombstone(tombstone);
            id(sourceStoreIdentity);
        },
    },
    transition: {
        request(value) {
            object(value, TRANSITION_REQUEST_KEYS, { versioned: true });
            operationId(value.operationId);
            opaque(value.workspaceId);
            opaque(value.boxIdentity);
            opaque(value.boxGeneration);
            transitionEpoch(value.expectedEpoch);
            digest(value.selectionDigest);
            digest(value.closureDigest);
            opaque(value.sourceAcceptanceIdentity);
            digest(value.enforcementDigest);
            digest(value.aliasCoverageDigest);
        },
        result(value) {
            object(value, TRANSITION_RESULT_KEYS, { versioned: true });
            operationId(value.operationId);
            transitionEpoch(value.previousEpoch);
            sourceProtectionRecord(value.record);
            digest(value.requestDigest);
            id(value.sourceStoreIdentity);
            require(value.record.sourceProtectionEpoch === value.previousEpoch + 1);
            require(value.record.protectionStatus === 'protected');
            require(value.record.sourceStoreIdentity === value.sourceStoreIdentity);
        },
    },
    release: {
        request(value) {
            object(value, RELEASE_REQUEST_KEYS, { versioned: true });
            operationId(value.operationId);
            id(value.reservationId);
            digest(value.reservationRequestDigest);
            id(value.owningWorkerGeneration);
            digest(value.resourcesDigest);
            digest(value.releaseEvidenceDigest);
        },
        result(value) {
            object(value, RELEASE_RESULT_KEYS, { versioned: true });
            operationId(value.operationId);
            id(value.reservationId);
            require(value.state === 'released');
            digest(value.requestDigest);
            digest(value.releaseEvidenceDigest);
            id(value.sourceStoreIdentity);
        },
    },
    acknowledge: {
        request(value) {
            object(value, ACKNOWLEDGE_REQUEST_KEYS, { versioned: true });
            operationId(value.operationId);
            id(value.sourceStoreIdentity);
            id(value.workerGeneration);
            list(value.priorStoreIdentities, { max: PRIOR_STORE_IDENTITY_BOUND });
            for (const prior of value.priorStoreIdentities) {
                id(prior);
                require(prior !== value.sourceStoreIdentity);
            }
            strictlyAscending(value.priorStoreIdentities, (prior) => prior);
            digest(value.settlementAttestationDigest);
        },
        result(value) {
            object(value, ACKNOWLEDGE_RESULT_KEYS, { versioned: true });
            operationId(value.operationId);
            id(value.sourceStoreIdentity);
            principal(value.workerPrincipal);
            oneOf(value.state, STORE_HOLDER_STATES);
            digest(value.requestDigest);
        },
    },
    advance: {
        request(value) {
            object(value, ADVANCE_REQUEST_KEYS, { versioned: true });
            operationId(value.operationId);
            nullOr(value.priorGeneration, id);
            id(value.nextGeneration);
            require(value.priorGeneration !== value.nextGeneration);
        },
        result(value) {
            object(value, ADVANCE_RESULT_KEYS, { versioned: true });
            operationId(value.operationId);
            principal(value.workerPrincipal);
            nullOr(value.priorGeneration, id);
            id(value.currentGeneration);
            require(value.priorGeneration !== value.currentGeneration);
            digest(value.requestDigest);
        },
    },
});

// The key that marks the request form of each operation (common-vector rule):
// its absence selects the result form.
export const SOURCE_OPERATION_REQUEST_MARKERS = Object.freeze({
    reserve: 'expectedEpoch',
    transition: 'expectedEpoch',
    release: 'reservationRequestDigest',
    acknowledge: 'settlementAttestationDigest',
    advance: 'nextGeneration',
});
export const SOURCE_OPERATION_DOCUMENT_TYPES = Object.freeze(SOURCE_OPERATION_KINDS.flatMap((kind) => [
    `${kind}Request`, `${kind}Result`,
]));

/**
 * Validate one private interlock operation document. `kind` is an operation
 * name of SOURCE_OPERATION_KINDS, whose request or result form is selected by
 * the request marker key, or an explicit document type such as
 * `reserveRequest` or `advanceResult`. Each form has its own exact key set.
 */
export function validateSourceOperation(kind, value) {
    if (typeof kind !== 'string') return errorResult(C.invalidRequest);
    let operation;
    let form;
    if (SOURCE_OPERATION_KINDS.includes(kind)) {
        if (!isPlainObject(value)) return errorResult(C.invalidRequest);
        operation = kind;
        form = Object.hasOwn(value, SOURCE_OPERATION_REQUEST_MARKERS[kind]) ? 'request' : 'result';
    } else if (SOURCE_OPERATION_DOCUMENT_TYPES.includes(kind)) {
        operation = kind.replace(/(Request|Result)$/, '');
        form = kind.endsWith('Request') ? 'request' : 'result';
    } else {
        return errorResult(C.invalidRequest);
    }
    return validator(OPERATION_SCHEMAS[operation][form])(value);
}

// Request digest used by the interlock and expected in results.
export function sourceRequestDigest(request) {
    return digestOrThrow(request);
}

export function resourcesDigestOf(resources) {
    return digestOrThrow(resources);
}
