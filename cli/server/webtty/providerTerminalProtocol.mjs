import { createHmac } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { computeRch } from '../../../Agent/lib/requestHash.mjs';

export const PROVIDER_TERMINAL_LIMITS = Object.freeze({ json: 16 * 1024, payload: 64 * 1024, header: 26 });
export const U64_MAX = (1n << 64n) - 1n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENDED = new Set(['supersession', 'shutdown', 'lease-expiry', 'generation-end', 'exit', 'unclaimed']);
const ROUTER = {
    hello: ['label?'],
    reattach: ['ownershipSessionId', 'workerGeneration', 'proof'],
    heartbeat: [],
    launch: ['operationId', 'targetId', 'project', 'cols', 'rows', 'launchEvidence'],
    attach: ['ptySessionId', 'afterOutputSequence'],
    resize: ['ptySessionId', 'cols', 'rows'],
    close: ['ptySessionId', 'reason'],
};
const WORKER = {
    challenge: ['nonce'],
    'hello-ok': ['ownershipSessionId', 'workerGeneration', 'leaseExpiresAt', 'secret'],
    'reattach-ok': ['leaseExpiresAt', 'ptys'],
    'heartbeat-ok': ['leaseExpiresAt'],
    launched: ['operationId', 'ptySessionId'],
    'launch-failed': ['operationId', 'code'],
    gap: ['ptySessionId', 'firstAvailable'],
    ack: ['ptySessionId', 'sequence'],
    ended: ['ptySessionId', 'cause', 'exitCode?'],
    'superseded-connection': [],
};

export function terminalError(code = 'protocol') {
    const error = new Error(`Provider terminal: ${code}`);
    error.code = `PROVIDER_TERMINAL_${code.toUpperCase()}`;
    return error;
}

function requireValue(condition) {
    if (!condition) throw terminalError();
}

function exact(value, fields) {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
    const allowed = fields.map((field) => field.replace(/\?$/, ''));
    requireValue(Object.keys(value).every((key) => allowed.includes(key)));
    requireValue(fields.filter((field) => !field.endsWith('?')).every((field) => Object.hasOwn(value, field)));
}

function text(value, max, min = 1) {
    requireValue(typeof value === 'string' && Buffer.byteLength(value) >= min
        && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/.test(value));
}

export function validateTerminalId(value) {
    requireValue(typeof value === 'string' && UUID.test(value));
    return value;
}

export function terminalSequence(value, { zero = false, exhausted = false } = {}) {
    requireValue(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value));
    const number = BigInt(value);
    requireValue(number >= (zero ? 0n : 1n) && number <= U64_MAX + (exhausted ? 1n : 0n));
    return number;
}

function secretBytes(value) {
    requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value));
    const bytes = Buffer.from(value, 'base64url');
    requireValue(bytes.length === 32 && bytes.toString('base64url') === value);
    return bytes;
}

export function validateTerminalLaunch(value) {
    exact(value, ['operationId', 'targetId', 'project', 'cols', 'rows']);
    validateTerminalId(value.operationId);
    requireValue(typeof value.targetId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.targetId));
    dimensions(value);
    if (value.project !== null) {
        exact(value.project, ['selection', 'relativePath']);
        // Opaque selection is not a filesystem grant. Empty relativePath names
        // its root; these are input byte guards, not provider authorization.
        text(value.project.selection, 1024);
        text(value.project.relativePath, 4096, 0);
        requireValue(!value.project.relativePath.startsWith('/') && !value.project.relativePath.includes('\\')
            && !value.project.relativePath.split('/').some((part) => part === '.' || part === '..'));
    }
    return value;
}

function dimensions(value) {
    requireValue(Number.isInteger(value.cols) && value.cols >= 2 && value.cols <= 1024
        && Number.isInteger(value.rows) && value.rows >= 2 && value.rows <= 512);
}

function validateControl(value, direction) {
    const types = direction === 'router' ? ROUTER : direction === 'worker' ? WORKER : null;
    requireValue(types && value && Object.hasOwn(types, value.type));
    exact(value, ['v', 'type', ...types[value.type]]);
    requireValue(value.v === 1);
    for (const field of ['ownershipSessionId', 'workerGeneration', 'operationId', 'ptySessionId']) {
        if (Object.hasOwn(value, field)) validateTerminalId(value[field]);
    }
    for (const field of ['secret', 'nonce', 'proof']) {
        if (Object.hasOwn(value, field)) secretBytes(value[field]);
    }
    if (Object.hasOwn(value, 'leaseExpiresAt')) {
        requireValue(Number.isSafeInteger(value.leaseExpiresAt) && value.leaseExpiresAt > 0);
    }
    if (Object.hasOwn(value, 'cols')) dimensions(value);
    if (Object.hasOwn(value, 'label')) text(value.label, 128);
    if (value.type === 'launch') {
        validateTerminalLaunch(launchFields(value));
        text(value.launchEvidence, 12 * 1024);
    }
    if (value.type === 'reattach-ok') {
        requireValue(Array.isArray(value.ptys) && value.ptys.length <= 128);
        const ids = new Set();
        for (const entry of value.ptys) {
            exact(entry, ['ptySessionId', 'inputNext', 'outputLast']);
            validateTerminalId(entry.ptySessionId);
            requireValue(!ids.has(entry.ptySessionId));
            ids.add(entry.ptySessionId);
            terminalSequence(entry.inputNext, { exhausted: true });
            terminalSequence(entry.outputLast, { zero: true });
        }
    }
    if (value.type === 'attach') terminalSequence(value.afterOutputSequence, { zero: true });
    if (value.type === 'gap') terminalSequence(value.firstAvailable);
    if (value.type === 'ack') terminalSequence(value.sequence);
    if (value.type === 'close') requireValue(['user-close', 'router-shutdown'].includes(value.reason));
    if (value.type === 'launch-failed') {
        requireValue(typeof value.code === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value.code));
    }
    if (value.type === 'ended') {
        requireValue(ENDED.has(value.cause));
        if (Object.hasOwn(value, 'exitCode')) {
            requireValue(Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255);
        }
    }
    return value;
}

export function encodeTerminalControl(value, direction = 'router') {
    validateControl(value, direction);
    const wire = JSON.stringify(value);
    requireValue(Buffer.byteLength(wire) <= PROVIDER_TERMINAL_LIMITS.json);
    return wire;
}

export function decodeTerminalControl(wire, direction = 'worker') {
    try {
        requireValue(typeof wire === 'string' || Buffer.isBuffer(wire));
        requireValue(Buffer.byteLength(wire) <= PROVIDER_TERMINAL_LIMITS.json);
        const source = typeof wire === 'string' ? wire : new TextDecoder('utf-8', { fatal: true }).decode(wire);
        return validateControl(JSON.parse(source), direction);
    } catch (_) {
        throw terminalError();
    }
}

export function encodeTerminalData({ ptySessionId, sequence, payload }, direction = 'router') {
    validateTerminalId(ptySessionId);
    requireValue(typeof sequence === 'bigint' && sequence >= 1n && sequence <= U64_MAX);
    requireValue(Buffer.isBuffer(payload) && payload.length <= PROVIDER_TERMINAL_LIMITS.payload);
    requireValue(direction === 'router' || direction === 'worker');
    const frame = Buffer.alloc(PROVIDER_TERMINAL_LIMITS.header + payload.length);
    frame[0] = 1;
    frame[1] = direction === 'router' ? 1 : 2;
    Buffer.from(ptySessionId.replaceAll('-', ''), 'hex').copy(frame, 2);
    frame.writeBigUInt64BE(sequence, 18);
    payload.copy(frame, 26);
    return frame;
}

export function decodeTerminalData(frame, direction = 'worker') {
    requireValue(Buffer.isBuffer(frame) && frame.length >= 26 && frame.length <= 26 + 64 * 1024);
    requireValue((direction === 'router' || direction === 'worker')
        && frame[0] === 1 && frame[1] === (direction === 'router' ? 1 : 2));
    const hex = frame.subarray(2, 18).toString('hex');
    const ptySessionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
        + `-${hex.slice(16, 20)}-${hex.slice(20)}`;
    validateTerminalId(ptySessionId);
    const sequence = frame.readBigUInt64BE(18);
    requireValue(sequence > 0n);
    return { ptySessionId, sequence, payload: Buffer.from(frame.subarray(26)) };
}

export function terminalPossessionProof({ secret, nonce, ownershipSessionId, workerGeneration }) {
    const key = secretBytes(secret);
    secretBytes(nonce);
    validateTerminalId(ownershipSessionId);
    validateTerminalId(workerGeneration);
    const parts = [nonce, ownershipSessionId, workerGeneration].flatMap((value) => {
        const bytes = Buffer.from(value, 'utf8');
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        return [length, bytes];
    });
    try {
        return createHmac('sha256', key).update(Buffer.concat(parts)).digest('base64url');
    } finally {
        key.fill(0);
    }
}

export function launchFields({ operationId, targetId, project, cols, rows }) {
    return { operationId, targetId, project, cols, rows };
}

export function terminalLaunchHash(value) {
    return computeRch(validateTerminalLaunch(launchFields(value)));
}
