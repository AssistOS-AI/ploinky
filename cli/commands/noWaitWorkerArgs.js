import pathDefault from 'node:path';

import { RUNNING_DIR } from '../utils/config.js';
import {
    MAX_NO_WAIT_WAVE_INDEX,
    exactEpochMs,
    exactRunId,
    exactWaveIndex,
} from './noWaitIdentity.js';

export { MAX_NO_WAIT_WAVE_INDEX, exactEpochMs, exactRunId, exactWaveIndex } from './noWaitIdentity.js';
export const MAX_NO_WAIT_BARRIER_ENTRIES = 1024;

export const NO_WAIT_IMMUTABLE_IDENTITY_FIELDS = Object.freeze([
    'containerName',
    'instanceId',
    'enableGeneration',
    'repoName',
    'shortAgent',
    'alias',
    'routeKey',
    'runId',
    'runStartedAtMs',
    'waveIndex',
    'statusFile',
]);

const REQUIRED_FLAGS = Object.freeze([
    'container',
    'instance-id',
    'enable-generation',
    'short-agent',
    'repo',
    'alias',
    'manifest-path',
    'agent-path',
    'route-key',
    'run-id',
    'run-started-at-ms',
    'wave-index',
    'status-file',
    'wait-for-statuses',
]);
const OPTIONAL_FLAGS = Object.freeze([
    'profile',
    'router-port',
    'force-recreate',
]);
const KNOWN_FLAGS = new Set([...REQUIRED_FLAGS, ...OPTIONAL_FLAGS]);
const SAFE_CONTAINER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_AGENT_IDENTITY = /^[^/:\s\u0000-\u001f\u007f-\u009f]+$/u;
const SAFE_OPAQUE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_IDENTITY_VALUE_LENGTH = 1024;

function camelKey(key) {
    return key.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}

function exactIdentityString(value, label, {
    allowEmpty = false,
    pattern = SAFE_COMPONENT,
} = {}) {
    if (typeof value !== 'string'
        || value !== value.trim()
        || value.length > MAX_IDENTITY_VALUE_LENGTH
        || (!allowEmpty && value.length === 0)
        || (value.length > 0 && !pattern.test(value))) {
        throw new Error(`${label} is not one exact canonical identity value`);
    }
    return value;
}

function exactCanonicalRunId(value) {
    if (typeof value !== 'string') {
        throw new Error('no-wait run id must be one exact canonical UUID');
    }
    const runId = exactRunId(value);
    if (value !== runId) {
        throw new Error('no-wait run id must be one exact canonical UUID');
    }
    return runId;
}

function exactPublishedInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number'
        || !Number.isSafeInteger(value)
        || value < 0
        || value > maximum) {
        throw new Error(`${label} must be one exact published integer`);
    }
    return value;
}

export function exactNoWaitImmutableIdentity(identity, {
    pathApi = pathDefault,
} = {}) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
        throw new Error('no-wait immutable identity must be one object');
    }
    const containerName = exactIdentityString(
        identity.containerName,
        'no-wait container name',
        { pattern: SAFE_CONTAINER },
    );
    const instanceId = exactIdentityString(
        identity.instanceId,
        'no-wait instance id',
        { pattern: SAFE_OPAQUE_IDENTITY },
    );
    const enableGeneration = exactIdentityString(
        identity.enableGeneration,
        'no-wait enable generation',
        { pattern: SAFE_OPAQUE_IDENTITY },
    );
    if (instanceId === enableGeneration) {
        throw new Error('no-wait instance id and enable generation must be distinct');
    }
    const repoName = exactIdentityString(identity.repoName, 'no-wait repository name');
    const shortAgent = exactIdentityString(
        identity.shortAgent,
        'no-wait short agent name',
        { pattern: SAFE_AGENT_IDENTITY },
    );
    const alias = exactIdentityString(identity.alias, 'no-wait normalized alias', { allowEmpty: true });
    const routeKey = exactIdentityString(
        identity.routeKey,
        'no-wait route key',
        { pattern: alias ? SAFE_COMPONENT : SAFE_AGENT_IDENTITY },
    );
    if (routeKey !== (alias || shortAgent)) {
        throw new Error('no-wait route key must equal the normalized alias or short agent name');
    }
    const runId = exactCanonicalRunId(identity.runId);
    const runStartedAtMs = exactPublishedInteger(identity.runStartedAtMs, 'no-wait run start');
    const waveIndex = exactPublishedInteger(
        identity.waveIndex,
        'no-wait wave index',
        MAX_NO_WAIT_WAVE_INDEX,
    );
    const statusFile = exactIdentityString(identity.statusFile, 'no-wait status filename');
    const expectedStatusFile = `${containerName}.${runId}.json`;
    if (pathApi.basename(statusFile) !== statusFile || statusFile !== expectedStatusFile) {
        throw new Error(`no-wait status filename must be exactly '${expectedStatusFile}'`);
    }
    return Object.freeze({
        containerName,
        instanceId,
        enableGeneration,
        repoName,
        shortAgent,
        alias,
        routeKey,
        runId,
        runStartedAtMs,
        waveIndex,
        statusFile,
    });
}

export function sameNoWaitImmutableIdentity(left, right) {
    return Boolean(left && right)
        && NO_WAIT_IMMUTABLE_IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

export function exactNoWaitStatusPath(rawStatusPath, {
    runningDir = RUNNING_DIR,
    label = 'no-wait status',
    pathApi = pathDefault,
} = {}) {
    const raw = String(rawStatusPath || '');
    const statusPath = pathApi.resolve(raw);
    const statusRoot = pathApi.resolve(runningDir, 'no-wait');
    if (!pathApi.isAbsolute(raw)
        || raw !== statusPath
        || pathApi.dirname(statusPath) !== statusRoot
        || pathApi.extname(statusPath) !== '.json') {
        throw new Error(`${label} must be an absolute JSON file in the workspace no-wait status directory`);
    }
    return statusPath;
}

export function exactNoWaitCoordinationStatusPath(rawStatusPath, {
    containerName,
    runId,
    runningDir = RUNNING_DIR,
    pathApi = pathDefault,
} = {}) {
    const statusPath = exactNoWaitStatusPath(rawStatusPath, {
        runningDir,
        label: 'no-wait coordination status',
        pathApi,
    });
    const expectedName = `${String(containerName || '')}.${exactRunId(runId)}.json`;
    if (pathApi.basename(statusPath) !== expectedName) {
        throw new Error(`no-wait coordination status must be the exact run-scoped file '${expectedName}'`);
    }
    return statusPath;
}

export function exactNoWaitBarrierEntry(entry, {
    runningDir = RUNNING_DIR,
    expectedRunId = '',
    label = 'no-wait status barrier entry',
    pathApi = pathDefault,
} = {}) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.directDependency !== 'boolean') {
        throw new Error(`${label} is invalid`);
    }
    const entryRunId = exactRunId(entry.runId, `${label} run id`);
    if (expectedRunId && entryRunId !== exactRunId(expectedRunId)) {
        throw new Error(`${label} belongs to a different run`);
    }
    return Object.freeze({
        path: exactNoWaitStatusPath(entry.path, { runningDir, label, pathApi }),
        runId: entryRunId,
        waveIndex: exactWaveIndex(entry.waveIndex, `${label} wave index`),
        directDependency: entry.directDependency,
    });
}

export function parseNoWaitStatusBarrier(rawBarrier, {
    runId,
    waveIndex,
    runningDir = RUNNING_DIR,
    pathApi = pathDefault,
} = {}) {
    if (typeof rawBarrier !== 'string' || rawBarrier === '') {
        throw new Error('no-wait status barrier must be one JSON array argument');
    }
    const expectedRunId = exactRunId(runId);
    const ownerWaveIndex = exactWaveIndex(waveIndex, 'no-wait status barrier owner wave index');
    let parsed;
    try {
        parsed = JSON.parse(rawBarrier);
    } catch (_) {
        throw new Error('no-wait status barrier is invalid JSON');
    }
    if (!Array.isArray(parsed) || parsed.length > MAX_NO_WAIT_BARRIER_ENTRIES) {
        throw new Error(`no-wait status barrier must be an array with at most ${MAX_NO_WAIT_BARRIER_ENTRIES} entries`);
    }
    const seen = new Set();
    return Object.freeze(parsed.map((entry, index) => {
        const barrierEntry = exactNoWaitBarrierEntry(entry, {
            runningDir,
            expectedRunId,
            label: `no-wait status barrier entry ${index}`,
            pathApi,
        });
        if (barrierEntry.waveIndex >= ownerWaveIndex) {
            throw new Error(
                `no-wait status barrier entry ${index} references wave ${barrierEntry.waveIndex} from wave ${ownerWaveIndex}`,
            );
        }
        if (seen.has(barrierEntry.path)) {
            throw new Error(`no-wait status barrier repeats '${pathApi.basename(barrierEntry.path)}'`);
        }
        seen.add(barrierEntry.path);
        return barrierEntry;
    }));
}

export function resolveNoWaitRunScopedArguments(args, {
    containerName,
    runningDir = RUNNING_DIR,
    pathApi = pathDefault,
} = {}) {
    for (const [key, flag] of [
        ['runId', 'run-id'],
        ['runStartedAtMs', 'run-started-at-ms'],
        ['waveIndex', 'wave-index'],
        ['statusFile', 'status-file'],
        ['waitForStatuses', 'wait-for-statuses'],
    ]) {
        if (typeof args?.[key] !== 'string' || args[key] === '') {
            throw new Error(`run-scoped no-wait launch requires --${flag}`);
        }
    }
    const runId = exactRunId(args.runId);
    if (args.runId !== runId) {
        throw new Error('no-wait run id must be one exact canonical UUID');
    }
    const exactWave = exactWaveIndex(args.waveIndex, 'no-wait worker wave index');
    if (args.waveIndex !== String(exactWave)) {
        throw new Error('no-wait worker wave index must be one canonical decimal integer');
    }
    const runStartedAtMs = exactEpochMs(args.runStartedAtMs, 'no-wait run start');
    if (args.runStartedAtMs !== String(runStartedAtMs)) {
        throw new Error('no-wait run start must be one canonical decimal integer');
    }
    return Object.freeze({
        runId,
        runStartedAtMs,
        waveIndex: exactWave,
        statusFile: exactNoWaitCoordinationStatusPath(args.statusFile, {
            containerName,
            runId,
            runningDir,
            pathApi,
        }),
        waitForStatuses: parseNoWaitStatusBarrier(args.waitForStatuses, {
            runId,
            waveIndex: exactWave,
            runningDir,
            pathApi,
        }),
    });
}

export function parseNoWaitWorkerArgs(argv, {
    runningDir = RUNNING_DIR,
    pathApi = pathDefault,
} = {}) {
    if (!Array.isArray(argv)) throw new Error('no-wait worker arguments must be one array');
    const raw = {};
    const seen = new Set();
    for (let index = 0; index < argv.length; index += 2) {
        const token = String(argv[index] ?? '');
        const value = argv[index + 1];
        if (!token.startsWith('--')) {
            throw new Error(`no-wait worker received positional argument '${token}'`);
        }
        const flag = token.slice(2);
        if (!KNOWN_FLAGS.has(flag)) throw new Error(`no-wait worker received unknown flag '--${flag}'`);
        if (seen.has(flag)) throw new Error(`no-wait worker received duplicate flag '--${flag}'`);
        if (value === undefined || String(value).startsWith('--')) {
            throw new Error(`no-wait worker flag '--${flag}' requires one value`);
        }
        seen.add(flag);
        raw[camelKey(flag)] = String(value);
    }
    for (const flag of REQUIRED_FLAGS) {
        if (!seen.has(flag) || (flag !== 'alias' && raw[camelKey(flag)] === '')) {
            throw new Error(`no-wait worker requires --${flag}`);
        }
    }
    const container = exactIdentityString(raw.container, 'no-wait container name', { pattern: SAFE_CONTAINER });
    for (const field of ['manifestPath', 'agentPath']) {
        if (!pathApi.isAbsolute(raw[field])) throw new Error(`no-wait worker ${field} must be absolute`);
    }
    if (raw.routerPort !== undefined
        && (!/^[1-9][0-9]*$/.test(raw.routerPort)
            || Number(raw.routerPort) > 65535)) {
        throw new Error('no-wait worker router port must be an integer between 1 and 65535');
    }
    if (raw.forceRecreate !== undefined && raw.forceRecreate !== '1') {
        throw new Error('no-wait worker force-recreate value must be 1');
    }
    const runScoped = resolveNoWaitRunScopedArguments(raw, {
        containerName: container,
        runningDir,
        pathApi,
    });
    const identity = exactNoWaitImmutableIdentity({
        containerName: container,
        instanceId: raw.instanceId,
        enableGeneration: raw.enableGeneration,
        repoName: raw.repo,
        shortAgent: raw.shortAgent,
        alias: raw.alias,
        routeKey: raw.routeKey,
        runId: runScoped.runId,
        runStartedAtMs: runScoped.runStartedAtMs,
        waveIndex: runScoped.waveIndex,
        statusFile: pathApi.basename(runScoped.statusFile),
    }, { pathApi });
    return Object.freeze({ ...raw, container, runScoped, identity });
}
