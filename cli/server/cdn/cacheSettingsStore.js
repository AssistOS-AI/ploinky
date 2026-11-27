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

const routeSettings = ['off', 'page'];
const routeManifestMarks = ['page', 'immutable', null];

export function validCachePath(value) {
    return typeof value === 'string' && value.startsWith('/') && Buffer.byteLength(value) <= 512
        && !/[\u0000-\u001f\u007f]/.test(value);
}

function plainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// An administrator choice for one route, with the manifest entry it was made on.
export function validCacheRoute(value) {
    return plainObject(value) && Object.keys(value).sort().join() === 'at,by,entry,setting'
        && routeSettings.includes(value.setting)
        && typeof value.at === 'string' && /^\d{4}-\d\d-\d\dT/.test(value.at) && Number.isFinite(Date.parse(value.at))
        && typeof value.by === 'string' && value.by.trim().length > 0 && Buffer.byteLength(value.by) <= 256
        && plainObject(value.entry) && Object.keys(value.entry).sort().join() === 'access,manifest'
        && value.entry.access === 'public' && routeManifestMarks.includes(value.entry.manifest);
}

function validRouteSettings(agentRoutes) {
    return plainObject(agentRoutes) && Object.entries(agentRoutes)
        .every(([path, value]) => validCachePath(path) && validCacheRoute(value));
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
                || !validEntries(settings.held, validHold)
                || (Object.hasOwn(settings, 'routes') && !validEntries(settings.routes, validRouteSettings))) {
                throw new Error('cache_settings_invalid');
            }
            for (const entries of [settings.applications, settings.held]) {
                Object.values(entries).forEach(Object.freeze);
                Object.freeze(entries);
            }
            if (settings.routes) {
                for (const agentRoutes of Object.values(settings.routes)) {
                    Object.values(agentRoutes).forEach(record => Object.freeze(record.entry) && Object.freeze(record));
                    Object.freeze(agentRoutes);
                }
                Object.freeze(settings.routes);
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

// Serialized read-modify-write. `change` receives the strictly read file and
// returns the new settings with the previous value, or null to leave it as is.
// `before` is the exact file content the change was computed from.
function update(agent, change, { dataDir = CONTROLLER_STATE_DIR, assertCurrent = () => {} } = {}) {
    const operation = pending.then(() => {
        if (typeof agent !== 'string' || !agentId.test(agent)) throw new Error('invalid_request');
        const before = load(dataDir, true);
        const changed = change(before);
        assertCurrent();
        if (changed === null) return { settings: before, previous: undefined, before, changed: false };
        writeCacheJson(path.join(dataDir, 'cache-settings.json'), changed.settings);
        return { settings: changed.settings, previous: changed.previous, before, changed: true };
    });
    pending = operation.catch(() => {});
    return operation;
}

function replaceSection(agent, section, value) {
    return before => {
        const entries = { ...before[section] };
        if (value === null) delete entries[agent];
        else entries[agent] = value;
        return { settings: { ...before, [section]: entries }, previous: before[section][agent] };
    };
}

export async function setCacheApplication(agent, value, options) {
    if (!validCacheApplication(value)) throw new Error('invalid_request');
    const { enabled, pageSeconds } = value;
    const result = await update(agent, replaceSection(agent, 'applications', { enabled, pageSeconds }), options);
    return { ...result, previous: result.previous ?? { enabled: false, pageSeconds: 300 } };
}

export function setCacheHold(agent, hold, options) {
    if (hold !== null && !validHold(hold)) throw new Error('invalid_request');
    return update(agent, replaceSection(agent, 'held', hold && { by: hold.by, since: hold.since }), options);
}

// Sets (record) or removes (null) the administrator choice for one normalized
// route path. A new record is validated before anything is written, and removing
// a missing record writes nothing.
export function setCacheRoute(agent, routePath, record, options) {
    if (!validCachePath(routePath) || (record !== null && !validCacheRoute(record))) {
        return Promise.reject(new Error('invalid_request'));
    }
    return update(agent, before => {
        const routes = { ...(before.routes ?? {}) };
        const agentRoutes = { ...(Object.hasOwn(routes, agent) ? routes[agent] : {}) };
        const previous = Object.hasOwn(agentRoutes, routePath) ? agentRoutes[routePath] : undefined;
        if (record === null) {
            if (previous === undefined) return null;
            delete agentRoutes[routePath];
        } else {
            agentRoutes[routePath] = { setting: record.setting, at: record.at, by: record.by,
                entry: { access: record.entry.access, manifest: record.entry.manifest } };
        }
        if (Object.keys(agentRoutes).length) routes[agent] = agentRoutes;
        else delete routes[agent];
        const settings = { ...before };
        if (Object.keys(routes).length) settings.routes = routes;
        else delete settings.routes;
        return { settings, previous };
    }, options);
}
