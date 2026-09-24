import crypto from 'node:crypto';

import { PloinkyBoxError } from '../errors.mjs';

// A host self-update relaunches the updated CLI. The first invocation's pull
// outcome would otherwise be lost: the child sees the new HEAD and reports the
// checkout as unchanged. The parent records the validated outcome in private
// host state and passes only an operation id and a one-time token. The child
// accepts the record once, only for the same argv, request, scope, workspace
// and parent process, and never trusts any report carried by the environment.

export const UPDATE_HANDOFF_ENV = 'PLOINKY_UPDATE_HANDOFF';
export const UPDATE_HANDOFF_SCHEMA = 'ploinky-update-relaunch-handoff';
export const UPDATE_HANDOFF_VERSION = 1;
export const UPDATE_HANDOFF_MAX_AGE_MS = 10 * 60 * 1000;
const HANDOFF_KIND = 'update-handoffs';
const VALUE_PATTERN = /^([0-9a-f]{32}):([0-9a-f]{64})$/;
const RECORD_KEYS = Object.freeze([
    'argv', 'createdAt', 'host', 'operationId', 'parentPid', 'request', 'schema',
    'scopeRoot', 'tokenHash', 'version', 'workspace',
].sort());
const CLOCK_SKEW_MS = 5_000;

function handoffError(message) {
    return new PloinkyBoxError(
        `Refusing the Ploinky update relaunch handoff: ${message}. `
        + `Run the update again without ${UPDATE_HANDOFF_ENV}.`,
        { code: 'PLOINKY_BOX_UPDATE_HANDOFF_INVALID' },
    );
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

function workspaceOf(identity) {
    return { instance: String(identity?.instance || ''), workspaceRoot: String(identity?.workspaceRoot || '') };
}

/** Parent side: persist the validated host outcome before relaunching. */
export function createRelaunchHandoff({
    store,
    argv,
    request,
    identity,
    scopeRoot = null,
    host,
    parentPid = process.pid,
    now = () => new Date(),
    randomBytes = size => crypto.randomBytes(size),
} = {}) {
    if (!store) throw new TypeError('A relaunch handoff requires a host state store');
    const operationId = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('hex');
    const record = {
        schema: UPDATE_HANDOFF_SCHEMA,
        version: UPDATE_HANDOFF_VERSION,
        operationId,
        tokenHash: hashToken(token),
        argv: [...argv].map(String),
        request: JSON.parse(JSON.stringify(request)),
        workspace: workspaceOf(identity),
        scopeRoot: scopeRoot ? String(scopeRoot) : null,
        host: {
            outcome: 'changed',
            repoPath: String(host?.repoPath || host?.canonicalRoot || ''),
            before: String(host?.before || ''),
            after: String(host?.after || ''),
        },
        parentPid,
        createdAt: now().toISOString(),
    };
    store.write(HANDOFF_KIND, operationId, record);
    return Object.freeze({ operationId, envValue: `${operationId}:${token}`, record });
}

/** Parent side: drop a record the child never consumed. */
export function discardRelaunchHandoff(store, operationId) {
    return store.remove(HANDOFF_KIND, operationId);
}

/**
 * Child side: claim the record exactly once (atomic rename), then validate
 * it. Claiming first means a tampered or replayed attempt also burns it.
 */
export function consumeRelaunchHandoff({
    store,
    value,
    argv,
    request,
    identity,
    scopeRoot = null,
    parentPid = process.ppid,
    now = () => new Date(),
    maxAgeMs = UPDATE_HANDOFF_MAX_AGE_MS,
} = {}) {
    const match = VALUE_PATTERN.exec(String(value ?? ''));
    if (!match) throw handoffError('the handoff value is malformed');
    const [, operationId, token] = match;
    const record = store.claim(HANDOFF_KIND, operationId);
    if (!record) throw handoffError('no pending handoff exists for this operation (it was already used or never created)');
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || canonical(Object.keys(record).sort()) !== canonical(RECORD_KEYS)
        || record.schema !== UPDATE_HANDOFF_SCHEMA || record.version !== UPDATE_HANDOFF_VERSION
        || record.operationId !== operationId) {
        throw handoffError('the handoff record has an unsupported schema');
    }
    const expected = Buffer.from(String(record.tokenHash), 'utf8');
    const actual = Buffer.from(hashToken(token), 'utf8');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        throw handoffError('the handoff token does not match');
    }
    const createdAt = Date.parse(record.createdAt);
    const current = now().getTime();
    if (!Number.isFinite(createdAt) || createdAt > current + CLOCK_SKEW_MS || current - createdAt > maxAgeMs) {
        throw handoffError('the handoff record is stale');
    }
    if (record.parentPid !== parentPid) throw handoffError('the handoff was not created by this process parent');
    if (canonical(record.argv) !== canonical([...argv].map(String))) throw handoffError('the command line changed');
    if (canonical(record.request) !== canonical(JSON.parse(JSON.stringify(request)))) {
        throw handoffError('the update request changed');
    }
    if (canonical(record.workspace) !== canonical(workspaceOf(identity))) throw handoffError('the workspace changed');
    if ((record.scopeRoot ?? null) !== (scopeRoot ? String(scopeRoot) : null)) throw handoffError('the update folder changed');
    const host = record.host;
    if (!host || host.outcome !== 'changed' || !host.after || typeof host.before !== 'string') {
        throw handoffError('the recorded host outcome is incomplete');
    }
    return Object.freeze({
        operationId,
        host: Object.freeze({ ...host, relaunched: true }),
        createdAt: record.createdAt,
    });
}
