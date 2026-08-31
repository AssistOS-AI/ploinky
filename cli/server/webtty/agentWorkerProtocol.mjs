import path from 'node:path';

export const WEBTTY_AGENT_WORKER_PROTOCOL = 'ploinky.webtty.agent-worker/v1';
export const WEBTTY_AGENT_BACKEND = 'persistent-podman-exec-under-box-node-pty/v1';

export const WEBTTY_AGENT_PROTOCOL_LIMITS = Object.freeze({
    maxWireBytes: 96 * 1024,
    maxTerminalIdBytes: 128,
    maxTranslatedCwdBytes: 4 * 1024,
    maxTargetUserBytes: 128,
    maxInputBytes: 16 * 1024,
    maxOutputBytes: 64 * 1024,
    maxBaselineExecIds: 256,
    minColumns: 2,
    maxColumns: 1_024,
    minRows: 2,
    maxRows: 512,
});

export const AGENT_WORKER_ERROR_CATEGORIES = Object.freeze([
    'protocol',
    'native-runtime',
    'target-stale',
    'target-evidence',
    'target-inspect',
    'shell-unavailable',
    'pty-spawn',
    'readiness',
    'pty-io',
    'output-limit',
    'cleanup',
    'cleanup-unproven',
    'cleanup-provider-unproven',
    'provider-evidence',
    'internal',
]);

export const AGENT_WORKER_EXIT_CATEGORIES = Object.freeze([
    'clean',
    'signal',
    'requested',
    'parent-disconnect',
    'target-stale',
    'protocol-error',
    'worker-error',
]);

const ERROR_CATEGORIES = new Set(AGENT_WORKER_ERROR_CATEGORIES);
const EXIT_CATEGORIES = new Set(AGENT_WORKER_EXIT_CATEGORIES);
const ROUTER_FIELDS = Object.freeze({
    'init-agent': Object.freeze([
        'protocol',
        'type',
        'terminalId',
        'runtime',
        'containerId',
        'targetUser',
        'translatedCwd',
        'marker',
        'cols',
        'rows',
    ]),
    'start-agent': Object.freeze(['protocol', 'type', 'terminalId']),
    input: Object.freeze(['protocol', 'type', 'terminalId', 'data']),
    resize: Object.freeze(['protocol', 'type', 'terminalId', 'cols', 'rows']),
    close: Object.freeze(['protocol', 'type', 'terminalId']),
});
const WORKER_FIELDS = Object.freeze({
    prepared: Object.freeze(['protocol', 'type', 'terminalId', 'startupEvidence']),
    ready: Object.freeze(['protocol', 'type', 'terminalId', 'recoveryEvidence']),
    output: Object.freeze(['protocol', 'type', 'terminalId', 'sequence', 'data']),
    exit: Object.freeze(['protocol', 'type', 'terminalId', 'exitCode', 'signal', 'category', 'cleanupProven']),
    error: Object.freeze(['protocol', 'type', 'terminalId', 'category']),
});
const STARTUP_FIELDS = Object.freeze([
    'backend',
    'runtime',
    'containerId',
    'targetUser',
    'translatedCwd',
    'marker',
    'baselineExecIds',
    'containerInitProcess',
]);
const CONTAINER_INIT_FIELDS = Object.freeze([
    'pid',
    'startToken',
    'pidNamespace',
]);
const RECOVERY_FIELDS = Object.freeze([
    'backend',
    'runtime',
    'containerId',
    'targetUser',
    'translatedCwd',
    'marker',
    'execId',
    'clientProcess',
    'innerProcess',
]);
const CLIENT_PROCESS_FIELDS = Object.freeze([
    'pid',
    'uid',
    'startToken',
    'processGroupId',
    'sessionId',
    'foregroundProcessGroupId',
    'ttyNumber',
]);
const INNER_PROCESS_FIELDS = Object.freeze([
    'boxPid',
    'boxStartToken',
    'boxProcessGroupId',
    'boxSessionId',
    'pidNamespace',
    'nspid',
    'nspgid',
    'nssid',
    'innerPid',
    'innerProcessGroupId',
    'innerSessionId',
    'innerUid',
    'innerStartToken',
    'containerInitBoxPid',
    'containerInitStartToken',
]);

export function agentWorkerProtocolError(category = 'message') {
    const error = new Error(`invalid WebTTY agent worker protocol ${category}`);
    error.code = 'WEBTTY_AGENT_WORKER_PROTOCOL_INVALID';
    error.category = category;
    return error;
}

function exactObject(value, fields, category) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw agentWorkerProtocolError(category);
    }
    const actual = Object.keys(value).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length
        || actual.some((field, index) => field !== expected[index])) {
        throw agentWorkerProtocolError(category);
    }
}

function boundedString(value, { min = 0, max, pattern, category }) {
    const bytes = typeof value === 'string' ? Buffer.byteLength(value) : -1;
    if (bytes < min || bytes > max || value.includes('\0') || (pattern && !pattern.test(value))) {
        throw agentWorkerProtocolError(category);
    }
    return value;
}

function positiveInteger(value, category, { allowZero = false } = {}) {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
        throw agentWorkerProtocolError(category);
    }
    return value;
}

function terminalId(value) {
    return boundedString(value, {
        min: 16,
        max: WEBTTY_AGENT_PROTOCOL_LIMITS.maxTerminalIdBytes,
        pattern: /^[A-Za-z0-9_-]+$/,
        category: 'terminal-id',
    });
}

function dimensions(cols, rows) {
    if (!Number.isSafeInteger(cols)
        || cols < WEBTTY_AGENT_PROTOCOL_LIMITS.minColumns
        || cols > WEBTTY_AGENT_PROTOCOL_LIMITS.maxColumns
        || !Number.isSafeInteger(rows)
        || rows < WEBTTY_AGENT_PROTOCOL_LIMITS.minRows
        || rows > WEBTTY_AGENT_PROTOCOL_LIMITS.maxRows) {
        throw agentWorkerProtocolError('dimensions');
    }
}

function immutableContainerId(value) {
    return boundedString(value, {
        min: 64,
        max: 64,
        pattern: /^[a-f0-9]{64}$/,
        category: 'container-id',
    });
}

function marker(value) {
    return boundedString(value, {
        min: 24,
        max: 128,
        pattern: /^[A-Za-z0-9_-]+$/,
        category: 'marker',
    });
}

function targetUser(value) {
    return boundedString(value, {
        min: 1,
        max: WEBTTY_AGENT_PROTOCOL_LIMITS.maxTargetUserBytes,
        pattern: /^(?:[0-9]+|[A-Za-z_][A-Za-z0-9_-]*)(?::(?:[0-9]+|[A-Za-z_][A-Za-z0-9_-]*))?$/,
        category: 'target-user',
    });
}

function translatedCwd(value) {
    boundedString(value, {
        min: 1,
        max: WEBTTY_AGENT_PROTOCOL_LIMITS.maxTranslatedCwdBytes,
        category: 'translated-cwd',
    });
    if (!path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
        || value.includes('\\') || value.split('/').includes('..')) {
        throw agentWorkerProtocolError('translated-cwd');
    }
    return value;
}

function protocolEnvelope(message, fieldsByType, expectedTerminalId) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw agentWorkerProtocolError('message');
    }
    if (message.protocol !== WEBTTY_AGENT_WORKER_PROTOCOL) {
        throw agentWorkerProtocolError('version');
    }
    if (typeof message.type !== 'string' || !Object.hasOwn(fieldsByType, message.type)) {
        throw agentWorkerProtocolError('type');
    }
    exactObject(message, fieldsByType[message.type], `${message.type}-fields`);
    terminalId(message.terminalId);
    if (expectedTerminalId !== undefined && message.terminalId !== expectedTerminalId) {
        throw agentWorkerProtocolError('terminal-correlation');
    }
    let wireBytes;
    try {
        wireBytes = Buffer.byteLength(JSON.stringify(message));
    } catch (_) {
        throw agentWorkerProtocolError('serialization');
    }
    if (wireBytes > WEBTTY_AGENT_PROTOCOL_LIMITS.maxWireBytes) {
        throw agentWorkerProtocolError('wire-size');
    }
}

function startToken(value, category) {
    boundedString(value, {
        min: 12,
        max: 128,
        pattern: /^linux-proc:[1-9][0-9]*$/,
        category,
    });
}

function clientProcess(value) {
    exactObject(value, CLIENT_PROCESS_FIELDS, 'client-process-fields');
    for (const field of [
        'pid',
        'processGroupId',
        'sessionId',
        'foregroundProcessGroupId',
        'ttyNumber',
    ]) positiveInteger(value[field], 'client-process');
    positiveInteger(value.uid, 'client-process', { allowZero: true });
    startToken(value.startToken, 'client-process');
}

function namespaceVector(value, category) {
    if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
        throw agentWorkerProtocolError(category);
    }
    for (const entry of value) positiveInteger(entry, category);
}

function innerProcess(value) {
    exactObject(value, INNER_PROCESS_FIELDS, 'inner-process-fields');
    for (const field of [
        'boxPid',
        'boxProcessGroupId',
        'boxSessionId',
        'innerPid',
        'innerProcessGroupId',
        'innerSessionId',
        'containerInitBoxPid',
    ]) positiveInteger(value[field], 'inner-process');
    positiveInteger(value.innerUid, 'inner-process', { allowZero: true });
    startToken(value.boxStartToken, 'inner-process');
    startToken(value.innerStartToken, 'inner-process');
    startToken(value.containerInitStartToken, 'inner-process');
    boundedString(value.pidNamespace, {
        min: 8,
        max: 64,
        pattern: /^pid:\[[1-9][0-9]*\]$/,
        category: 'inner-process',
    });
    namespaceVector(value.nspid, 'inner-process');
    namespaceVector(value.nspgid, 'inner-process');
    namespaceVector(value.nssid, 'inner-process');
    if (value.nspid.at(-1) !== value.innerPid
        || value.nspgid.at(-1) !== value.innerProcessGroupId
        || value.nssid.at(-1) !== value.innerSessionId
        || value.boxStartToken !== value.innerStartToken) {
        throw agentWorkerProtocolError('inner-process-topology');
    }
}

function execId(value, category = 'exec-id') {
    return boundedString(value, {
        min: 64,
        max: 64,
        pattern: /^[a-f0-9]{64}$/,
        category,
    });
}

export function validateAgentStartupEvidence(value) {
    exactObject(value, STARTUP_FIELDS, 'startup-evidence-fields');
    if (value.backend !== WEBTTY_AGENT_BACKEND || value.runtime !== 'podman') {
        throw agentWorkerProtocolError('backend');
    }
    immutableContainerId(value.containerId);
    targetUser(value.targetUser);
    translatedCwd(value.translatedCwd);
    marker(value.marker);
    if (!Array.isArray(value.baselineExecIds)
        || value.baselineExecIds.length > WEBTTY_AGENT_PROTOCOL_LIMITS.maxBaselineExecIds) {
        throw agentWorkerProtocolError('baseline-exec-ids');
    }
    const unique = new Set();
    for (const id of value.baselineExecIds) {
        execId(id, 'baseline-exec-id');
        if (unique.has(id)) throw agentWorkerProtocolError('baseline-exec-id');
        unique.add(id);
    }
    exactObject(value.containerInitProcess, CONTAINER_INIT_FIELDS, 'container-init-fields');
    positiveInteger(value.containerInitProcess.pid, 'container-init');
    startToken(value.containerInitProcess.startToken, 'container-init');
    boundedString(value.containerInitProcess.pidNamespace, {
        min: 8,
        max: 64,
        pattern: /^pid:\[[1-9][0-9]*\]$/,
        category: 'container-init',
    });
    return Object.freeze(value);
}

export function validateAgentRecoveryEvidence(value) {
    exactObject(value, RECOVERY_FIELDS, 'recovery-evidence-fields');
    if (value.backend !== WEBTTY_AGENT_BACKEND || value.runtime !== 'podman') {
        throw agentWorkerProtocolError('backend');
    }
    immutableContainerId(value.containerId);
    targetUser(value.targetUser);
    translatedCwd(value.translatedCwd);
    marker(value.marker);
    execId(value.execId);
    clientProcess(value.clientProcess);
    innerProcess(value.innerProcess);
    return Object.freeze(value);
}

export function validateRouterToAgentWorkerMessage(message, {
    initialized = false,
    closing = false,
    expectedTerminalId,
} = {}) {
    protocolEnvelope(message, ROUTER_FIELDS, expectedTerminalId);
    if (!initialized && !['init-agent', 'close'].includes(message.type)) {
        throw agentWorkerProtocolError('pre-init');
    }
    if (initialized && message.type === 'init-agent') throw agentWorkerProtocolError('duplicate-init');
    if (closing && message.type !== 'close') throw agentWorkerProtocolError('closing');
    if (message.type === 'init-agent') {
        if (message.runtime !== 'podman') throw agentWorkerProtocolError('runtime');
        immutableContainerId(message.containerId);
        targetUser(message.targetUser);
        translatedCwd(message.translatedCwd);
        marker(message.marker);
        dimensions(message.cols, message.rows);
    } else if (message.type === 'input') {
        boundedString(message.data, {
            min: 1,
            max: WEBTTY_AGENT_PROTOCOL_LIMITS.maxInputBytes,
            category: 'input',
        });
    } else if (message.type === 'resize') {
        dimensions(message.cols, message.rows);
    }
    return Object.freeze(message);
}

export function validateAgentWorkerToRouterMessage(message, { expectedTerminalId } = {}) {
    protocolEnvelope(message, WORKER_FIELDS, expectedTerminalId);
    if (message.type === 'prepared') {
        validateAgentStartupEvidence(message.startupEvidence);
    } else if (message.type === 'ready') {
        validateAgentRecoveryEvidence(message.recoveryEvidence);
    } else if (message.type === 'output') {
        positiveInteger(message.sequence, 'sequence');
        boundedString(message.data, {
            min: 1,
            max: WEBTTY_AGENT_PROTOCOL_LIMITS.maxOutputBytes,
            category: 'output',
        });
    } else if (message.type === 'exit') {
        if (typeof message.cleanupProven !== 'boolean') throw agentWorkerProtocolError('cleanup-proof');
        if (message.exitCode !== null
            && (!Number.isSafeInteger(message.exitCode) || message.exitCode < 0 || message.exitCode > 255)) {
            throw agentWorkerProtocolError('exit-code');
        }
        if (message.signal !== null
            && (!Number.isSafeInteger(message.signal) || message.signal < 0 || message.signal > 255)) {
            throw agentWorkerProtocolError('exit-signal');
        }
        if (!EXIT_CATEGORIES.has(message.category)) throw agentWorkerProtocolError('exit-category');
    } else if (!ERROR_CATEGORIES.has(message.category)) {
        throw agentWorkerProtocolError('error-category');
    }
    return Object.freeze(message);
}

export function agentWorkerMessage(type, terminalIdValue, fields = {}) {
    return {
        protocol: WEBTTY_AGENT_WORKER_PROTOCOL,
        type,
        terminalId: terminalIdValue,
        ...fields,
    };
}
