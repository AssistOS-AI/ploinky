import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENTS_DATA_SEGMENT, RESERVED_DATA_ENTRIES } from './runtime/agentDataPathPolicy.js';

export const DATA_LAYOUT_VERSION = 4;
export const DATA_LAYOUT_FILE = '.layout.json';
const LOCK_FILE = '.layout-init.lock';
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 200;
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function layoutError(message, context = {}) {
    const error = new Error(`[data-layout] ${message}`);
    error.code = 'PLOINKY_DATA_LAYOUT_UNSUPPORTED';
    error.context = context;
    return error;
}

function lstatOrNull(target) {
    try {
        return fs.lstatSync(target);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function requireRealDirectory(target, label) {
    const stat = lstatOrNull(target);
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw layoutError(`${label} '${target}' must be a real directory`, { target });
    }
    return true;
}

export function readDataLayoutVersion(workspaceRoot) {
    const dataRoot = path.join(path.resolve(workspaceRoot), '.data');
    const file = path.join(dataRoot, DATA_LAYOUT_FILE);
    requireRealDirectory(dataRoot, 'workspace data directory');
    const stat = lstatOrNull(file);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw layoutError(`unsafe layout file '${file}'`);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return 1;
        throw error;
    }
    const version = Number(JSON.parse(raw)?.version);
    if (!Number.isInteger(version) || version < 1) {
        throw layoutError(`invalid layout file '${file}'`, { file });
    }
    return version;
}

function writeLayoutVersion(dataRoot, version) {
    const file = path.join(dataRoot, DATA_LAYOUT_FILE);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ version }, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
    fs.renameSync(temporary, file);
}

function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

function acquireLock(dataRoot) {
    const lockPath = path.join(dataRoot, LOCK_FILE);
    const owner = JSON.stringify({ pid: process.pid, host: os.hostname() });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try {
            const fd = fs.openSync(lockPath, 'wx', 0o600);
            fs.writeSync(fd, owner);
            fs.closeSync(fd);
            return () => { try { fs.unlinkSync(lockPath); } catch (_) {} };
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }
        const lockStat = lstatOrNull(lockPath);
        if (lockStat && (!lockStat.isFile() || lockStat.isSymbolicLink())) throw layoutError(`unsafe initialization lock '${lockPath}'`);
        let holder = null;
        try { holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) {}
        // Only a holder of this host (same pid namespace) can be proven dead.
        if (holder?.host === os.hostname() && Number.isInteger(holder?.pid) && !processAlive(holder.pid)) {
            try { fs.unlinkSync(lockPath); } catch (_) {}
            continue;
        }
        if (Date.now() >= deadline) {
            throw layoutError(`another process is initializing '${dataRoot}' (lock '${lockPath}'). `
                + 'If no ploinky process is running, remove the lock file and retry.', { lockPath });
        }
        Atomics.wait(SLEEP_ARRAY, 0, 0, LOCK_POLL_MS);
    }
}

function safePath(root, target) {
    const relative = path.relative(root, target);
    if (relative.startsWith('../') || path.isAbsolute(relative)) throw layoutError(`path escapes workspace: '${target}'`);
    let current = root;
    const parts = relative.split(path.sep);
    for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        const stat = lstatOrNull(current);
        if (stat && (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()))) {
            throw layoutError(`unsafe storage path '${current}': symlink or non-directory`);
        }
    }
}

/** Initialize a fresh workspace; existing stores must already use the supported layout. */
export function assertDataLayoutCurrent(workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    const data = path.join(root, '.data');
    const version = readDataLayoutVersion(root);
    if (version === DATA_LAYOUT_VERSION) return version;
    const fresh = () => !lstatOrNull(path.join(data, DATA_LAYOUT_FILE))
        && (!lstatOrNull(data) || fs.readdirSync(data).every(name => RESERVED_DATA_ENTRIES.includes(name) || name.startsWith('.')))
        && !lstatOrNull(path.join(root, '.ploinky', 'data', 'master-key'))
        && !lstatOrNull(path.join(data, '.private'));
    safePath(root, path.join(data, AGENTS_DATA_SEGMENT));
    if (version === 1 && fresh()) {
        fs.mkdirSync(data, { recursive: true });
        const release = acquireLock(data);
        try {
            if (readDataLayoutVersion(root) === DATA_LAYOUT_VERSION) return DATA_LAYOUT_VERSION;
            if (fresh()) {
                const agents = path.join(data, AGENTS_DATA_SEGMENT);
                if (!requireRealDirectory(agents, 'agents data directory')) fs.mkdirSync(agents);
                writeLayoutVersion(data, DATA_LAYOUT_VERSION);
                return DATA_LAYOUT_VERSION;
            }
        } finally { release(); }
    }
    throw layoutError(`Unsupported workspace data layout (version ${version}); expected version ${DATA_LAYOUT_VERSION}.`, { version });
}
