import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { LOGS_DIR, PLOINKY_DIR } from '../utils/config.js';

export const WORKSPACE_LOG_SOURCES = Object.freeze(['router', 'policy']);
export const DEFAULT_LOG_RETENTION_DAYS = 7;
export const MAX_LOG_RETENTION_DAYS = 365;
export const MAX_LOG_READ_BYTES = 16 * 1024 * 1024;
export const MAX_LOG_SEARCH_BYTES = 16 * 1024 * 1024;
export const MAX_LOG_SEARCH_RESULTS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_NAME = /^\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/;

function sourceConfig(source, { workspaceRoot } = {}) {
    const ploinkyDir = workspaceRoot ? path.join(path.resolve(workspaceRoot), '.ploinky') : PLOINKY_DIR;
    const logsDir = workspaceRoot ? path.join(ploinkyDir, 'logs') : LOGS_DIR;
    if (source === 'router') {
        return {
            active: path.join(logsDir, 'router.log'),
            archive: path.join(logsDir, 'router-archive'),
        };
    }
    if (source === 'policy') {
        const root = path.join(ploinkyDir, 'data', 'router-security');
        return {
            active: path.join(root, 'policy-audit.log'),
            archive: path.join(root, 'policy-audit-archive'),
        };
    }
    throw new Error(`Unsupported workspace log source: ${source}`);
}

function retentionDays(value) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LOG_RETENTION_DAYS) {
        throw new Error(`retentionDays must be an integer between 1 and ${MAX_LOG_RETENTION_DAYS}.`);
    }
    return parsed;
}

function boundedInteger(value, fallback, maximum) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, maximum);
}

function normalizeArchiveName(name) {
    const normalized = String(name || '');
    if (!ARCHIVE_NAME.test(normalized)) throw new Error('Log archive name is invalid.');
    return normalized;
}

async function regularFile(pathname) {
    try {
        const stat = await fs.lstat(pathname);
        return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

async function openRegularFile(pathname) {
    let handle;
    try {
        handle = await fs.open(pathname, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile()) {
            await handle.close();
            return null;
        }
        return { handle, stat };
    } catch (error) {
        try { await handle?.close(); } catch (_) {}
        if (error?.code === 'ENOENT' || error?.code === 'ELOOP') return null;
        throw error;
    }
}

async function firstRecordTime(pathname) {
    const input = fsSync.createReadStream(pathname, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            let candidate = '';
            try {
                const record = JSON.parse(line);
                candidate = record?.ts ?? record?.timestamp ?? '';
            } catch (_) {
                candidate = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.exec(line)?.[0] || '';
            }
            const parsed = Date.parse(candidate);
            if (Number.isFinite(parsed)) return parsed;
        }
    } finally {
        lines.close();
        input.destroy();
    }
    return null;
}

async function latestRecordTime(pathname) {
    const input = fsSync.createReadStream(pathname, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let latest = null;
    try {
        for await (const line of lines) {
            let candidate = '';
            try {
                const record = JSON.parse(line);
                candidate = record?.ts ?? record?.timestamp ?? '';
            } catch (_) {
                candidate = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.exec(line)?.[0] || '';
            }
            const parsed = Date.parse(candidate);
            if (Number.isFinite(parsed) && (latest === null || parsed > latest)) latest = parsed;
        }
    } finally {
        lines.close();
        input.destroy();
    }
    return latest;
}

async function uniqueArchivePath(root, day) {
    for (let sequence = 0; ; sequence += 1) {
        const name = `${day}${sequence ? `.${sequence}` : ''}.jsonl`;
        const target = path.join(root, name);
        if (!(await regularFile(target))) return { name, target };
    }
}

export async function rotateWorkspaceLog(source, { now = new Date(), workspaceRoot } = {}) {
    const config = sourceConfig(source, { workspaceRoot });
    const stat = await regularFile(config.active);
    if (!stat || stat.size === 0) return { source, rotated: false };
    const todayStart = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const firstTimestamp = await firstRecordTime(config.active);
    const fileCreated = Math.min(stat.birthtimeMs || stat.mtimeMs, stat.mtimeMs);
    const oldest = firstTimestamp === null ? fileCreated : Math.min(firstTimestamp, fileCreated);
    if (oldest >= todayStart) return { source, rotated: false };
    await fs.mkdir(config.archive, { recursive: true });
    const day = new Date(oldest).toISOString().slice(0, 10);
    const archive = await uniqueArchivePath(config.archive, day);
    await fs.rename(config.active, archive.target);
    return { source, rotated: true, name: archive.name };
}

export async function pruneWorkspaceLogs(source, days, { now = new Date(), workspaceRoot } = {}) {
    const config = sourceConfig(source, { workspaceRoot });
    const boundedDays = retentionDays(days);
    const cutoff = now.getTime() - boundedDays * DAY_MS;
    let entries = [];
    try { entries = await fs.readdir(config.archive, { withFileTypes: true }); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const removed = [];
    for (const entry of entries) {
        if (!entry.isFile() || !ARCHIVE_NAME.test(entry.name)) continue;
        const target = path.join(config.archive, entry.name);
        const stat = await regularFile(target);
        const latestTimestamp = stat ? await latestRecordTime(target) : null;
        const archiveTime = Date.parse(`${entry.name.slice(0, 10)}T00:00:00.000Z`);
        const newestContent = latestTimestamp ?? stat?.mtimeMs ?? archiveTime;
        if (stat && newestContent < cutoff) {
            await fs.unlink(target);
            removed.push(entry.name);
        }
    }
    return { source, retentionDays: boundedDays, removed };
}

export async function maintainWorkspaceLogs({ retentionDays: days, now = new Date(), workspaceRoot } = {}) {
    const boundedDays = retentionDays(days);
    const results = [];
    for (const source of WORKSPACE_LOG_SOURCES) {
        const rotation = await rotateWorkspaceLog(source, { now, workspaceRoot });
        const cleanup = await pruneWorkspaceLogs(source, boundedDays, { now, workspaceRoot });
        results.push({ source, ...rotation, removed: cleanup.removed });
    }
    return { ok: true, retentionDays: boundedDays, results };
}

export async function listWorkspaceLogs(source, { workspaceRoot } = {}) {
    const config = sourceConfig(source, { workspaceRoot });
    let entries = [];
    try { entries = await fs.readdir(config.archive, { withFileTypes: true }); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const items = [];
    for (const entry of entries) {
        if (!entry.isFile() || !ARCHIVE_NAME.test(entry.name)) continue;
        const stat = await regularFile(path.join(config.archive, entry.name));
        if (stat) items.push({ name: entry.name, date: entry.name.slice(0, 10), modifiedAt: stat.mtime.toISOString(), size: stat.size });
    }
    items.sort((left, right) => {
        const dateOrder = right.date.localeCompare(left.date);
        if (dateOrder) return dateOrder;
        const sequence = (name) => Number(/\.(\d+)\.jsonl$/.exec(name)?.[1] || 0);
        return sequence(right.name) - sequence(left.name);
    });
    return { ok: true, source, active: Boolean(await regularFile(config.active)), items };
}

function completeTail(buffer, truncated) {
    const tail = buffer.toString('utf8');
    if (!truncated) return tail;
    const boundary = tail.indexOf('\n');
    return boundary === -1 ? '' : tail.slice(boundary + 1);
}

export async function getWorkspaceLog(source, { name = 'live', maxBytes = MAX_LOG_READ_BYTES, workspaceRoot } = {}) {
    const config = sourceConfig(source, { workspaceRoot });
    const targetName = String(name || 'live');
    const pathname = targetName === 'live'
        ? config.active
        : path.join(config.archive, normalizeArchiveName(targetName));
    const opened = await openRegularFile(pathname);
    if (!opened) return { ok: true, source, item: { name: targetName, content: '', truncated: false } };
    const { handle, stat } = opened;
    const limit = boundedInteger(maxBytes, MAX_LOG_READ_BYTES, MAX_LOG_READ_BYTES);
    const start = Math.max(0, stat.size - limit);
    let content;
    try {
        const buffer = Buffer.allocUnsafe(stat.size - start);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        content = completeTail(buffer.subarray(0, bytesRead), start > 0);
    } finally {
        await handle.close();
    }
    return { ok: true, source, item: { name: targetName, content, truncated: start > 0 } };
}

function displayLine(raw) {
    try {
        const record = JSON.parse(raw);
        return { line: typeof record?.line === 'string' ? record.line : raw, timestamp: record?.ts ?? record?.timestamp ?? null };
    } catch (_) {
        return { line: raw, timestamp: null };
    }
}

export async function searchWorkspaceLogs(source, {
    query,
    limit = MAX_LOG_SEARCH_RESULTS,
    maxBytes = MAX_LOG_SEARCH_BYTES,
    workspaceRoot,
} = {}) {
    const needle = String(query || '').trim().toLocaleLowerCase();
    if (!needle) throw new Error('Search query is required.');
    const boundedLimit = boundedInteger(limit, MAX_LOG_SEARCH_RESULTS, MAX_LOG_SEARCH_RESULTS);
    const byteLimit = boundedInteger(maxBytes, MAX_LOG_SEARCH_BYTES, MAX_LOG_SEARCH_BYTES);
    const listing = await listWorkspaceLogs(source, { workspaceRoot });
    const files = [{ name: 'live' }, ...listing.items];
    const matches = [];
    let truncated = false;
    let scannedBytes = 0;
    for (const item of files) {
        const config = sourceConfig(source, { workspaceRoot });
        const pathname = item.name === 'live' ? config.active : path.join(config.archive, normalizeArchiveName(item.name));
        const opened = await openRegularFile(pathname);
        if (!opened) continue;
        const fileMatches = [];
        let lineNumber = 0;
        // FileHandle.createReadStream keeps descriptor ownership coordinated
        // with the FileHandle object. Passing its numeric fd to fs.createReadStream
        // lets the stream close the descriptor behind the FileHandle and causes
        // an uncaught EBADF when current Node releases finalize the handle.
        const input = opened.handle.createReadStream({ encoding: 'utf8' });
        const lines = readline.createInterface({ input, crlfDelay: Infinity });
        try {
            for await (const line of lines) {
                const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
                if (scannedBytes + lineBytes > byteLimit) {
                    truncated = true;
                    break;
                }
                scannedBytes += lineBytes;
                lineNumber += 1;
                if (!line) continue;
                const displayed = displayLine(line);
                if (!displayed.line.toLocaleLowerCase().includes(needle)) continue;
                fileMatches.push({ file: item.name, lineNumber, timestamp: displayed.timestamp, line: displayed.line });
                if (fileMatches.length > boundedLimit + 1) fileMatches.shift();
            }
        } finally {
            lines.close();
            if (!input.closed) {
                await new Promise((resolve, reject) => {
                    input.once('close', resolve);
                    input.once('error', reject);
                    input.destroy();
                });
            }
        }
        const remaining = boundedLimit - matches.length;
        if (fileMatches.length > remaining) truncated = true;
        if (remaining > 0) matches.push(...fileMatches.slice(-remaining).reverse());
        if (truncated) break;
    }
    return { ok: true, source, query: String(query), matches, truncated, scannedBytes };
}

export async function executeWorkspaceLogOperation(input = {}, options = {}) {
    switch (input.action) {
        case 'list': return listWorkspaceLogs(input.source, options);
        case 'get': return getWorkspaceLog(input.source, { ...input, ...options });
        case 'search': return searchWorkspaceLogs(input.source, { ...input, ...options });
        case 'maintenance': return maintainWorkspaceLogs({ ...input, ...options });
        default: throw new Error('Unsupported workspace log action.');
    }
}
