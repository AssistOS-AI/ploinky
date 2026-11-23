import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTROLLER_STATE_DIR } from '../../utils/config.js';

const empty = Object.freeze({ version: 1, applications: Object.freeze({}), held: Object.freeze({}) });
const agentId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
let cached;
let pending = Promise.resolve();

export function validCacheApplication(value) {
    return typeof value?.enabled === 'boolean' && [60, 120, 300].includes(value.pageSeconds);
}

function validHold(value) {
    return typeof value?.since === 'string' && /^\d{4}-\d\d-\d\dT/.test(value.since)
        && Number.isFinite(Date.parse(value.since)) && typeof value.by === 'string' && value.by.trim().length > 0;
}

function validEntries(entries, validate) {
    return entries && typeof entries === 'object' && !Array.isArray(entries)
        && Object.entries(entries).every(([key, value]) => agentId.test(key) && validate(value));
}

export function writeCacheJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
        fs.writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
        fs.renameSync(temp, file);
    } finally {
        fs.rmSync(temp, { force: true });
    }
}

function fileKey(file, stat) {
    return [file, stat.dev, stat.ino, stat.size, stat.mtimeNs].join(':');
}

function unreadableFileKey(file) {
    // open may have refused a symlink. Identify the entry without following it.
    try {
        return fileKey(file, fs.lstatSync(file, { bigint: true }));
    } catch {
        return file;
    }
}

function load(dataDir, strict) {
    const file = path.join(dataDir, 'cache-settings.json');
    let key;
    let fd;
    try {
        // Inspect and read the same file across atomic replacements. Refuse
        // symlinks and special files before reading the Router-owned settings.
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd, { bigint: true });
        key = fileKey(file, stat);
        if (!stat.isFile()) throw new Error('cache_settings_unreadable');
        if (cached?.key !== key) {
            const settings = JSON.parse(fs.readFileSync(fd, 'utf8'));
            if (settings?.version !== 1 || !validEntries(settings.applications, validCacheApplication)
                || !validEntries(settings.held, validHold)) throw new Error('cache_settings_invalid');
            for (const entries of [settings.applications, settings.held]) {
                Object.values(entries).forEach(Object.freeze);
                Object.freeze(entries);
            }
            cached = { key, settings: Object.freeze(settings) };
        }
        if (cached.settings) return cached.settings;
    } catch (error) {
        if (error.code === 'ENOENT') {
            cached = undefined;
            return empty;
        }
        const warningKey = key ?? unreadableFileKey(file);
        const errorCode = error.code ?? error.name;
        if (cached?.warningKey !== warningKey || cached.errorCode !== errorCode) {
            console.warn('cache_settings_unreadable');
        }
        // Retry I/O failures even if the file contents have not changed.
        cached = { key: error.code ? undefined : key, warningKey, errorCode };
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    // A write must never discard a hold because the input was unreadable.
    if (strict) throw new Error('cache_settings_unreadable');
    return empty;
}

export function readCacheSettings({ dataDir = CONTROLLER_STATE_DIR } = {}) {
    return load(dataDir, false);
}

function update(agent, section, value, { dataDir = CONTROLLER_STATE_DIR, assertCurrent = () => {} } = {}) {
    const operation = pending.then(() => {
        if (typeof agent !== 'string' || !agentId.test(agent)) throw new Error('invalid_request');
        const before = load(dataDir, true);
        const entries = { ...before[section] };
        if (value === null) delete entries[agent];
        else entries[agent] = value;
        const settings = { ...before, [section]: entries };
        assertCurrent();
        writeCacheJson(path.join(dataDir, 'cache-settings.json'), settings);
        return { settings, previous: before[section][agent] };
    });
    pending = operation.catch(() => {});
    return operation;
}

export async function setCacheApplication(agent, value, options) {
    if (!validCacheApplication(value)) throw new Error('invalid_request');
    const { enabled, pageSeconds } = value;
    const result = await update(agent, 'applications', { enabled, pageSeconds }, options);
    return { ...result, previous: result.previous ?? { enabled: false, pageSeconds: 300 } };
}

export function setCacheHold(agent, hold, options) {
    if (hold !== null && !validHold(hold)) throw new Error('invalid_request');
    return update(agent, 'held', hold && { by: hold.by, since: hold.since }, options);
}
