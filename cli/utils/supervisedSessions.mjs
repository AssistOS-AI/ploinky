import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// A supervised session is one pair: a supervisor terminal and a worker terminal
// in the same folder. The record is the only state that outlives the command, so
// it lives under `.ploinky`, which a terminal sandbox cannot read.
export const SUPERVISED_STORE_VERSION = 1;
export const MAX_SUPERVISED_SESSIONS = 50;
const ID = /^[A-Za-z0-9_-]{8,64}$/u;
const CODING_AGENT = /^[a-z][a-z0-9-]{0,31}$/u;
const ROBOT_ID = /^[A-Za-z0-9_-]{1,96}$/u;
const NATIVE_SESSION = /^[A-Za-z0-9_-]{1,96}$/u;

function plain(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, pattern, fallback = '') {
    return typeof value === 'string' && pattern.test(value) ? value : fallback;
}

function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sanitizeRole(value, fallbackRobotId = '') {
    if (!plain(value)) return null;
    const robotId = text(value.robotId, ROBOT_ID, fallbackRobotId);
    const codingAgent = text(value.codingAgent, CODING_AGENT);
    if (!robotId || !codingAgent) return null;
    return {
        robotId,
        robotName: typeof value.robotName === 'string' ? value.robotName.slice(0, 80) : '',
        codingAgent,
        controlId: text(value.controlId, /^[a-f0-9-]{36}$/u, '') || null,
        interruptInput: value.interruptInput === '\u001b' ? value.interruptInput : null,
        sessionBinding: text(value.sessionBinding, /^[a-f0-9-]{36}$/u, '') || null,
        nativeSessionId: text(value.nativeSessionId, NATIVE_SESSION, '') || null,
        historyBefore: Array.isArray(value.historyBefore) ? [...new Set(value.historyBefore.filter(id => typeof id === 'string' && NATIVE_SESSION.test(id)))].slice(0, 50) : null,
        terminalId: text(value.terminalId, ID, '') || null,
    };
}

function sanitizeSession(value) {
    if (!plain(value)) return null;
    const id = text(value.id, /^[A-Za-z0-9_-]{8,64}$/u);
    const folder = typeof value.folder === 'string' && value.folder.startsWith('/') && value.folder.length <= 4096
        ? value.folder : '';
    const supervisor = sanitizeRole(value.supervisor);
    const worker = sanitizeRole(value.worker);
    if (!id || !folder || !supervisor || !worker) return null;
    return {
        id,
        folder,
        label: typeof value.label === 'string' ? value.label.slice(0, 120) : path.basename(folder) || folder,
        createdAt: count(value.createdAt),
        updatedAt: count(value.updatedAt) || count(value.createdAt),
        phase: value.phase === 'ended' ? 'ended' : 'running',
        supervisor,
        worker,
    };
}

export function storePath(workspaceRoot) {
    return path.join(workspaceRoot, '.ploinky', 'supervised-sessions.json');
}

export function emptyStore() {
    return { version: SUPERVISED_STORE_VERSION, sessions: [] };
}

export function newSessionId() {
    return `sup-${crypto.randomUUID().replace(/-/gu, '').slice(0, 24)}`;
}

export function sanitizeStore(value) {
    if (!plain(value) || !Array.isArray(value.sessions)) return emptyStore();
    const seen = new Set();
    const sessions = [];
    for (const entry of value.sessions) {
        const session = sanitizeSession(entry);
        if (!session || seen.has(session.id)) continue;
        seen.add(session.id);
        sessions.push(session);
        if (sessions.length >= MAX_SUPERVISED_SESSIONS) break;
    }
    return { version: SUPERVISED_STORE_VERSION, sessions };
}

// A missing, unreadable or malformed store is an empty store: a session list is
// never the reason a command fails.
export function readStore(file, { read = value => fs.readFileSync(value, 'utf8') } = {}) {
    let text;
    try {
        text = read(file);
    } catch (_) {
        return emptyStore();
    }
    try {
        return sanitizeStore(JSON.parse(text));
    } catch (_) {
        return emptyStore();
    }
}

export function writeStore(file, store, {
    write = (target, value) => fs.writeFileSync(target, value, { mode: 0o600 }),
    rename = (from, to) => fs.renameSync(from, to),
    mkdir = (directory, options) => fs.mkdirSync(directory, options),
    random = () => crypto.randomBytes(6).toString('hex'),
} = {}) {
    mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${random()}.tmp`;
    write(temporary, `${JSON.stringify(sanitizeStore(store), null, 2)}\n`);
    rename(temporary, file);
}

export function findSession(store, id) {
    return store.sessions.find(session => session.id === id) || null;
}

// The newest pair comes first, and the list is capped so the store cannot grow
// without bound.
export function upsertSession(store, record) {
    const session = sanitizeSession(record);
    if (!session) throw new Error('Invalid supervised session record');
    const sessions = [session, ...store.sessions.filter(entry => entry.id !== session.id)];
    return { version: SUPERVISED_STORE_VERSION, sessions: sessions.slice(0, MAX_SUPERVISED_SESSIONS) };
}

export function removeSession(store, id) {
    return { version: SUPERVISED_STORE_VERSION, sessions: store.sessions.filter(session => session.id !== id) };
}

export function updateSession(store, id, change, now = Date.now) {
    const current = findSession(store, id);
    if (!current) return store;
    const next = sanitizeSession({ ...current, ...change(current), updatedAt: now() });
    return next ? upsertSession(store, next) : store;
}
