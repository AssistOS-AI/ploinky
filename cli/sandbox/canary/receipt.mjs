// The canary rollout receipt (plan 3.6): one write-ahead JSON file per route,
// `.ploinky/data/canary/<routeKey>.json`. Callers record an intent before each
// side effect and its result after it; every `canary` command reconciles this
// file with the observed state under the workspace lock. Owned by slice S2;
// other slices only read it or close it through these functions.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROUTE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function receiptDir(workspaceRoot) {
    const root = String(workspaceRoot || process.env.PLOINKY_WORKSPACE_ROOT || '').trim();
    if (!root || !path.isAbsolute(root)) throw new Error('canary receipt requires an absolute workspace root');
    return path.join(root, '.ploinky', 'data', 'canary');
}

export function receiptPath(routeKey, { workspaceRoot } = {}) {
    const key = String(routeKey || '');
    if (!ROUTE_KEY.test(key)) throw new Error(`canary receipt route key '${key}' is invalid`);
    return path.join(receiptDir(workspaceRoot), `${key}.json`);
}

export function checkedReceiptPath(routeKey, options) {
    const file = receiptPath(routeKey, options);
    let directory = path.resolve(options.workspaceRoot);
    for (const part of path.relative(directory, path.dirname(file)).split(path.sep)) {
        directory = path.join(directory, part);
        const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (stat && !stat.isDirectory()) throw new Error('canary receipts require real workspace directories');
    }
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error('canary receipt requires a regular file');
    return file;
}

// A readable but undecodable receipt can be recovered from an independently
// proved publication. A filesystem error provides no such evidence.
export function inspectStartReceipt(routeKey, options) {
    let bytes;
    try { bytes = fs.readFileSync(checkedReceiptPath(routeKey, options), 'utf8'); } catch (error) {
        if (error.code === 'ENOENT') return { bytes: null, value: null };
        throw error;
    }
    try { return { bytes, value: JSON.parse(bytes) }; }
    catch { return { bytes, value: null }; }
}

export function recoverPublishedStartReceipt(routeKey, expectedBytes, fields, options) {
    const file = checkedReceiptPath(routeKey, options);
    if (inspectStartReceipt(routeKey, options).bytes !== expectedBytes) throw new Error('canary receipt changed during start');
    const now = new Date().toISOString();
    writeAtomic(file, {
        schemaVersion: 1, routeKey, openedAt: now, updatedAt: now, ...fields,
        step: 'published', intent: 'withdraw', failurePhase: null, failureReason: null, terminal: null,
    });
    for (const entry of [file, path.dirname(file), path.dirname(path.dirname(file))]) {
        const fd = fs.openSync(entry, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
}

export function readReceipt(routeKey, options = {}) {
    const file = receiptPath(routeKey, options);
    let bytes;
    try { bytes = fs.readFileSync(file, 'utf8'); } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    const value = JSON.parse(bytes);
    if (!value || typeof value !== 'object' || value.routeKey !== routeKey) {
        throw new Error(`canary receipt for '${routeKey}' is malformed`);
    }
    return value;
}

function writeAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
}

// Opens a receipt for a new rollout. Refuses when an open receipt exists.
export function openReceipt({ routeKey, rolloutId, fields = {} }, options = {}) {
    const existing = readReceipt(routeKey, options);
    if (existing && !existing.terminal) {
        throw new Error(`canary rollout '${existing.rolloutId}' is still open for '${routeKey}'`);
    }
    const now = new Date().toISOString();
    const receipt = {
        schemaVersion: 1, routeKey, rolloutId: String(rolloutId || ''), openedAt: now, updatedAt: now,
        step: 'opened', intent: null, failurePhase: null, failureReason: null, terminal: null, ...fields,
    };
    if (!receipt.rolloutId) throw new Error('canary receipt requires a rollout id');
    writeAtomic(receiptPath(routeKey, options), receipt);
    return receipt;
}

// Merges fields into the open receipt of exactly this rollout.
export function updateReceipt({ routeKey, rolloutId, fields = {} }, options = {}) {
    const current = readReceipt(routeKey, options);
    if (!current || current.rolloutId !== rolloutId) {
        throw new Error(`no open canary receipt for rollout '${rolloutId}' on '${routeKey}'`);
    }
    if (current.terminal) throw new Error(`canary rollout '${rolloutId}' has already ended (${current.terminal.outcome})`);
    const next = { ...current, ...fields, routeKey, rolloutId, updatedAt: new Date().toISOString() };
    writeAtomic(receiptPath(routeKey, options), next);
    return next;
}

// Records the terminal outcome; the file stays so status can report it.
export function closeReceipt({ routeKey, rolloutId, outcome, reason = '' }, options = {}) {
    return updateReceipt({
        routeKey, rolloutId,
        fields: { terminal: { outcome: String(outcome), reason: String(reason), at: new Date().toISOString() }, intent: null },
    }, options);
}
