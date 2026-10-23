export const WEBTTY_WORKER_PROTOCOL = 'ploinky.webtty.worker/v1';

export const WEBTTY_PROTOCOL_LIMITS = Object.freeze({
    maxWireBytes: 96 * 1024,
    maxTerminalIdBytes: 128,
    maxCwdBytes: 4 * 1024,
    maxInputBytes: 16 * 1024,
    maxOutputBytes: 64 * 1024,
    minColumns: 2,
    maxColumns: 1_024,
    minRows: 2,
    maxRows: 512,
    maxEnvironmentEntries: 16,
    maxEnvironmentValueBytes: 1_024,
    // A profile HOME is the workspace root (bounded like a cwd) plus one
    // separator plus a workspace-relative path (bounded like a cwd).
    maxHomeBytes: 4 * 1024 + 1 + 4 * 1024,
    maxIdentityBytes: 32,
});

export const WORKER_ERROR_CATEGORIES = Object.freeze([
    'protocol',
    'native-runtime',
    'cwd-validation',
    'home-validation',
    'pty-spawn',
    'pty-io',
    'output-limit',
    'cleanup',
    'cleanup-unproven',
    'internal',
]);
const WORKER_ERROR_CATEGORY_SET = new Set(WORKER_ERROR_CATEGORIES);

export const WORKER_EXIT_CATEGORIES = Object.freeze([
    'clean',
    'signal',
    'requested',
    'parent-disconnect',
    'protocol-error',
    'worker-error',
]);
const WORKER_EXIT_CATEGORY_SET = new Set(WORKER_EXIT_CATEGORIES);

const ROUTER_MESSAGE_FIELDS = Object.freeze({
    init: Object.freeze(['protocol', 'type', 'terminalId', 'cwdRelative', 'cols', 'rows', 'shellEnv']),
    input: Object.freeze(['protocol', 'type', 'terminalId', 'data']),
    resize: Object.freeze(['protocol', 'type', 'terminalId', 'cols', 'rows']),
    close: Object.freeze(['protocol', 'type', 'terminalId']),
});
// A home-profile init adds exactly the workspace-relative HOME and the
// directory identity the worker must find there before spawning.
const ROUTER_PROFILE_MESSAGE_FIELDS = Object.freeze({
    ...ROUTER_MESSAGE_FIELDS,
    init: Object.freeze([...ROUTER_MESSAGE_FIELDS.init, 'homeRelative', 'homeIdentity']),
});
const WORKER_MESSAGE_FIELDS = Object.freeze({
    ready: Object.freeze(['protocol', 'type', 'terminalId', 'processIdentity']),
    output: Object.freeze(['protocol', 'type', 'terminalId', 'sequence', 'data']),
    exit: Object.freeze(['protocol', 'type', 'terminalId', 'exitCode', 'signal', 'category']),
    error: Object.freeze(['protocol', 'type', 'terminalId', 'category']),
});
const PROCESS_IDENTITY_FIELDS = Object.freeze([
    'pid',
    'startToken',
    'processGroupId',
    'sessionId',
    'foregroundProcessGroupId',
    'ttyNumber',
]);

export function workerProtocolError(category = 'message') {
    const error = new Error(`invalid WebTTY worker protocol ${category}`);
    error.code = 'WEBTTY_WORKER_PROTOCOL_INVALID';
    error.category = category;
    return error;
}

function utf8Bytes(value) {
    return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : -1;
}

function exactObject(value, fields, category) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw workerProtocolError(category);
    const actual = Object.keys(value).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw workerProtocolError(category);
    }
}

function boundedString(value, { min = 0, max, pattern, category }) {
    const bytes = utf8Bytes(value);
    if (bytes < min || bytes > max || value.includes('\0') || (pattern && !pattern.test(value))) {
        throw workerProtocolError(category);
    }
    return value;
}

function validateTerminalId(terminalId) {
    return boundedString(terminalId, {
        min: 16,
        max: WEBTTY_PROTOCOL_LIMITS.maxTerminalIdBytes,
        pattern: /^[A-Za-z0-9_-]+$/,
        category: 'terminal-id',
    });
}

function validateDimensions(cols, rows) {
    if (!Number.isSafeInteger(cols)
        || cols < WEBTTY_PROTOCOL_LIMITS.minColumns
        || cols > WEBTTY_PROTOCOL_LIMITS.maxColumns
        || !Number.isSafeInteger(rows)
        || rows < WEBTTY_PROTOCOL_LIMITS.minRows
        || rows > WEBTTY_PROTOCOL_LIMITS.maxRows) {
        throw workerProtocolError('dimensions');
    }
}

function validateEnvironment(shellEnv) {
    if (!shellEnv || typeof shellEnv !== 'object' || Array.isArray(shellEnv)) {
        throw workerProtocolError('environment');
    }
    const entries = Object.entries(shellEnv);
    if (entries.length === 0 || entries.length > WEBTTY_PROTOCOL_LIMITS.maxEnvironmentEntries) {
        throw workerProtocolError('environment');
    }
    for (const [key, value] of entries) {
        // The host-selected workspace can occupy a full filesystem path, and
        // a profile HOME lies below it; other fixed environment values keep
        // their smaller wire bound.
        const maxValueBytes = key === 'PLOINKY_WORKSPACE_ROOT'
            ? WEBTTY_PROTOCOL_LIMITS.maxCwdBytes
            : key === 'HOME'
                ? WEBTTY_PROTOCOL_LIMITS.maxHomeBytes
                : WEBTTY_PROTOCOL_LIMITS.maxEnvironmentValueBytes;
        if (!/^[A-Z][A-Z0-9_]*$/.test(key)
            || utf8Bytes(key) > 64
            || utf8Bytes(value) < 0
            || utf8Bytes(value) > maxValueBytes
            || value.includes('\0')) {
            throw workerProtocolError('environment');
        }
    }
}

function validateHomeIdentity(identity) {
    exactObject(identity, ['dev', 'ino'], 'home-identity');
    for (const field of ['dev', 'ino']) {
        boundedString(identity[field], {
            min: 1,
            max: WEBTTY_PROTOCOL_LIMITS.maxIdentityBytes,
            pattern: /^[0-9]+$/,
            category: 'home-identity',
        });
    }
}

function validateProtocolEnvelope(message, fieldsByType, { expectedTerminalId } = {}) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw workerProtocolError('message');
    if (message.protocol !== WEBTTY_WORKER_PROTOCOL) throw workerProtocolError('version');
    if (typeof message.type !== 'string' || !Object.hasOwn(fieldsByType, message.type)) {
        throw workerProtocolError('type');
    }
    exactObject(message, fieldsByType[message.type], `${message.type}-fields`);
    validateTerminalId(message.terminalId);
    if (expectedTerminalId !== undefined && message.terminalId !== expectedTerminalId) {
        throw workerProtocolError('terminal-correlation');
    }
    let wireBytes;
    try {
        wireBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    } catch (_) {
        throw workerProtocolError('serialization');
    }
    if (wireBytes > WEBTTY_PROTOCOL_LIMITS.maxWireBytes) throw workerProtocolError('wire-size');
}

export function validateRouterToWorkerMessage(message, {
    initialized = false,
    closing = false,
    expectedTerminalId,
} = {}) {
    const profileInit = Boolean(message) && typeof message === 'object'
        && message.type === 'init' && Object.hasOwn(message, 'homeRelative');
    validateProtocolEnvelope(
        message,
        profileInit ? ROUTER_PROFILE_MESSAGE_FIELDS : ROUTER_MESSAGE_FIELDS,
        { expectedTerminalId },
    );
    if (!initialized && message.type !== 'init') throw workerProtocolError('pre-init');
    if (initialized && message.type === 'init') throw workerProtocolError('duplicate-init');
    if (closing && message.type !== 'close') throw workerProtocolError('closing');

    if (message.type === 'init') {
        boundedString(message.cwdRelative, {
            max: WEBTTY_PROTOCOL_LIMITS.maxCwdBytes,
            category: 'cwd',
        });
        validateDimensions(message.cols, message.rows);
        validateEnvironment(message.shellEnv);
        if (profileInit) {
            boundedString(message.homeRelative, {
                min: 1,
                max: WEBTTY_PROTOCOL_LIMITS.maxCwdBytes,
                category: 'home',
            });
            validateHomeIdentity(message.homeIdentity);
        }
    } else if (message.type === 'input') {
        boundedString(message.data, {
            min: 1,
            max: WEBTTY_PROTOCOL_LIMITS.maxInputBytes,
            category: 'input',
        });
    } else if (message.type === 'resize') {
        validateDimensions(message.cols, message.rows);
    }
    return Object.freeze(message);
}

function validateProcessIdentity(identity) {
    exactObject(identity, PROCESS_IDENTITY_FIELDS, 'process-identity-fields');
    for (const field of ['pid', 'processGroupId', 'sessionId', 'foregroundProcessGroupId', 'ttyNumber']) {
        if (!Number.isSafeInteger(identity[field]) || identity[field] <= 0) {
            throw workerProtocolError('process-identity');
        }
    }
    boundedString(identity.startToken, { min: 1, max: 128, category: 'process-identity' });
}

export function validateWorkerToRouterMessage(message, { expectedTerminalId } = {}) {
    validateProtocolEnvelope(message, WORKER_MESSAGE_FIELDS, { expectedTerminalId });
    if (message.type === 'ready') {
        validateProcessIdentity(message.processIdentity);
    } else if (message.type === 'output') {
        if (!Number.isSafeInteger(message.sequence) || message.sequence < 1) throw workerProtocolError('sequence');
        boundedString(message.data, {
            min: 1,
            max: WEBTTY_PROTOCOL_LIMITS.maxOutputBytes,
            category: 'output',
        });
    } else if (message.type === 'exit') {
        if (message.exitCode !== null
            && (!Number.isSafeInteger(message.exitCode) || message.exitCode < 0 || message.exitCode > 255)) {
            throw workerProtocolError('exit-code');
        }
        if (message.signal !== null
            && (!Number.isSafeInteger(message.signal) || message.signal < 0 || message.signal > 255)) {
            throw workerProtocolError('exit-signal');
        }
        if (!WORKER_EXIT_CATEGORY_SET.has(message.category)) throw workerProtocolError('exit-category');
    } else if (!WORKER_ERROR_CATEGORY_SET.has(message.category)) {
        throw workerProtocolError('error-category');
    }
    return Object.freeze(message);
}

export function workerMessage(type, terminalId, fields = {}) {
    return { protocol: WEBTTY_WORKER_PROTOCOL, type, terminalId, ...fields };
}
