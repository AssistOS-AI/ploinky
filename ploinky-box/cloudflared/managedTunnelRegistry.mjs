import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CloudflarePublicationError } from './publicationPlan.mjs';

const REGISTRY_KEYS = Object.freeze(['entries', 'updatedAt']);
const ENTRY_KEYS = Object.freeze([
    'ownershipId',
    'accountId',
    'zoneId',
    'requestedName',
    'cloudflareName',
    'tunnelId',
    'deleteOnTeardown',
    'createdAt',
    'updatedAt',
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TUNNEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fail(message) {
    throw new CloudflarePublicationError(message, {
        code: 'CLOUDFLARE_MANAGED_TUNNEL_REGISTRY_CORRUPT',
        operation: 'managed-tunnel-registry',
    });
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
    return isPlainObject(value)
        && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function safeString(value, label, { maximum = 256, optional = false } = {}) {
    const text = String(value || '').trim();
    if (!text && optional) return '';
    if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
        fail(`Cloudflare managed tunnel registry has invalid ${label}`);
    }
    return text;
}

function normalizeTimestamp(value, label) {
    const timestamp = safeString(value, label, { maximum: 24 });
    if (!CANONICAL_TIMESTAMP.test(timestamp)
        || !Number.isFinite(Date.parse(timestamp))
        || new Date(timestamp).toISOString() !== timestamp) {
        fail(`Cloudflare managed tunnel registry has invalid ${label}`);
    }
    return timestamp;
}

function normalizeEntry(value) {
    if (!hasExactKeys(value, ENTRY_KEYS) || typeof value.deleteOnTeardown !== 'boolean') {
        fail('Cloudflare managed tunnel registry has an invalid entry');
    }
    const entry = {
        ownershipId: safeString(value.ownershipId, 'ownership id', { maximum: 36 }),
        accountId: safeString(value.accountId, 'account id', { maximum: 128 }),
        zoneId: safeString(value.zoneId, 'zone id', { maximum: 128 }),
        requestedName: safeString(value.requestedName, 'requested tunnel name', { maximum: 48 }),
        cloudflareName: safeString(value.cloudflareName, 'Cloudflare tunnel name', { maximum: 128 }),
        tunnelId: safeString(value.tunnelId, 'tunnel id', { maximum: 128, optional: true }),
        deleteOnTeardown: value.deleteOnTeardown === true,
        createdAt: normalizeTimestamp(value.createdAt, 'created timestamp'),
        updatedAt: normalizeTimestamp(value.updatedAt, 'updated timestamp'),
    };
    if (!UUID.test(entry.ownershipId)
        || !IDENTIFIER.test(entry.accountId)
        || !IDENTIFIER.test(entry.zoneId)
        || !TUNNEL_NAME.test(entry.requestedName)
        || entry.cloudflareName !== `${entry.requestedName}--ploinky-${entry.ownershipId}`
        || (entry.tunnelId && !IDENTIFIER.test(entry.tunnelId))) {
        fail('Cloudflare managed tunnel registry has inconsistent ownership data');
    }
    return entry;
}

export function normalizeCloudflareManagedTunnelRegistry(value) {
    if (!hasExactKeys(value, REGISTRY_KEYS) || !Array.isArray(value.entries)) {
        fail('Cloudflare managed tunnel registry has an invalid contract');
    }
    const entries = value.entries.map(normalizeEntry);
    const ownershipIds = new Set();
    const desiredKeys = new Set();
    const tunnelIds = new Set();
    for (const entry of entries) {
        const desiredKey = [entry.accountId, entry.zoneId, entry.requestedName].join('\0');
        if (ownershipIds.has(entry.ownershipId) || desiredKeys.has(desiredKey)) {
            fail('Cloudflare managed tunnel registry contains duplicate ownership');
        }
        if (entry.tunnelId && tunnelIds.has(`${entry.accountId}\0${entry.tunnelId}`)) {
            fail('Cloudflare managed tunnel registry contains a duplicate tunnel id');
        }
        ownershipIds.add(entry.ownershipId);
        desiredKeys.add(desiredKey);
        if (entry.tunnelId) tunnelIds.add(`${entry.accountId}\0${entry.tunnelId}`);
    }
    entries.sort((left, right) => (
        left.accountId.localeCompare(right.accountId)
        || left.zoneId.localeCompare(right.zoneId)
        || left.requestedName.localeCompare(right.requestedName)
    ));
    return {
        entries,
        updatedAt: normalizeTimestamp(value.updatedAt, 'registry timestamp'),
    };
}

function assertRegularFileOrMissing(file) {
    try {
        const stats = fs.lstatSync(file);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
            fail('Cloudflare managed tunnel registry is not a regular file');
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

function ensureRealDirectoryChain(anchor, directory) {
    const root = path.resolve(anchor);
    const target = path.resolve(directory);
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        fail('Cloudflare managed tunnel registry escapes its workspace');
    }
    let current = root;
    const rootStats = fs.lstatSync(current);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        fail('Cloudflare managed tunnel registry workspace is not a real directory');
    }
    for (const component of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        try {
            const stats = fs.lstatSync(current);
            if (!stats.isDirectory() || stats.isSymbolicLink()) {
                fail('Cloudflare managed tunnel registry parent is not a real directory');
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            fs.mkdirSync(current, { mode: 0o700 });
            const created = fs.lstatSync(current);
            if (!created.isDirectory() || created.isSymbolicLink()) {
                fail('Cloudflare managed tunnel registry parent is not a real directory');
            }
        }
    }
}

function atomicWrite(file, content, workspaceRoot) {
    const directory = path.dirname(file);
    ensureRealDirectoryChain(workspaceRoot, directory);
    assertRegularFileOrMissing(file);
    const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    try {
        fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
        fs.chmodSync(file, 0o600);
    } finally {
        try { fs.unlinkSync(temporary); } catch (_) {}
    }
}

function desiredMatches(entry, { accountId, zoneId, tunnelName }) {
    return entry.accountId === String(accountId)
        && entry.zoneId === String(zoneId)
        && entry.requestedName === String(tunnelName);
}

export function resolveCloudflareManagedTunnelRegistryPath(workspaceRoot) {
    const root = path.resolve(String(workspaceRoot || process.env.PLOINKY_WORKSPACE_ROOT || process.cwd()));
    return path.join(root, '.ploinky', 'data', 'edge-publication', 'managed-tunnels.json');
}

export function createCloudflareManagedTunnelRegistry({
    workspaceRoot,
    filePath,
    ownershipIdFactory = () => crypto.randomUUID(),
    now = () => new Date(),
} = {}) {
    const root = path.resolve(String(
        workspaceRoot || process.env.PLOINKY_WORKSPACE_ROOT || process.cwd(),
    ));
    const registryPath = path.resolve(String(
        filePath || resolveCloudflareManagedTunnelRegistryPath(root),
    ));
    const relative = path.relative(root, registryPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        fail('Cloudflare managed tunnel registry escapes its workspace');
    }

    const readState = () => {
        assertRegularFileOrMissing(registryPath);
        try {
            return normalizeCloudflareManagedTunnelRegistry(
                JSON.parse(fs.readFileSync(registryPath, 'utf8')),
            );
        } catch (error) {
            if (error?.code === 'ENOENT') return { entries: [], updatedAt: null };
            if (error instanceof CloudflarePublicationError) throw error;
            fail(`Cloudflare managed tunnel registry is unreadable or corrupt: ${error?.message || error}`);
        }
    };
    const writeEntries = (entries) => {
        const timestamp = now().toISOString();
        const normalized = normalizeCloudflareManagedTunnelRegistry({
            entries,
            updatedAt: timestamp,
        });
        atomicWrite(registryPath, `${JSON.stringify(normalized, null, 2)}\n`, root);
        return normalized.entries.map((entry) => ({ ...entry }));
    };

    return Object.freeze({
        path: registryPath,
        list() {
            return readState().entries.map((entry) => ({ ...entry }));
        },
        findDesired(input = {}) {
            const found = readState().entries.find((entry) => desiredMatches(entry, input));
            return found ? { ...found } : null;
        },
        findScope({ accountId, tunnelId } = {}) {
            const found = readState().entries.find((entry) => (
                entry.accountId === String(accountId)
                && entry.tunnelId
                && entry.tunnelId === String(tunnelId)
            ));
            return found ? { ...found } : null;
        },
        begin({
            accountId,
            zoneId,
            tunnelName,
            deleteOnTeardown = false,
        } = {}) {
            const state = readState();
            const existing = state.entries.find((entry) => desiredMatches(entry, {
                accountId,
                zoneId,
                tunnelName,
            }));
            const timestamp = now().toISOString();
            if (existing) {
                if (existing.deleteOnTeardown !== (deleteOnTeardown === true)) {
                    const updated = {
                        ...existing,
                        deleteOnTeardown: deleteOnTeardown === true,
                        updatedAt: timestamp,
                    };
                    writeEntries(state.entries.map((entry) => (
                        entry.ownershipId === existing.ownershipId ? updated : entry
                    )));
                    return updated;
                }
                return { ...existing };
            }
            const ownershipId = String(ownershipIdFactory() || '').trim();
            const entry = normalizeEntry({
                ownershipId,
                accountId: String(accountId || '').trim(),
                zoneId: String(zoneId || '').trim(),
                requestedName: String(tunnelName || '').trim(),
                cloudflareName: `${String(tunnelName || '').trim()}--ploinky-${ownershipId}`,
                tunnelId: '',
                deleteOnTeardown: deleteOnTeardown === true,
                createdAt: timestamp,
                updatedAt: timestamp,
            });
            writeEntries([...state.entries, entry]);
            return { ...entry };
        },
        commit({ ownershipId, tunnelId } = {}) {
            const state = readState();
            const existing = state.entries.find((entry) => entry.ownershipId === String(ownershipId));
            if (!existing) fail('Cloudflare managed tunnel ownership intent is missing');
            if (existing.tunnelId && existing.tunnelId !== String(tunnelId)) {
                fail('Cloudflare managed tunnel ownership id changed unexpectedly');
            }
            const updated = normalizeEntry({
                ...existing,
                tunnelId: String(tunnelId || '').trim(),
                updatedAt: now().toISOString(),
            });
            writeEntries(state.entries.map((entry) => (
                entry.ownershipId === existing.ownershipId ? updated : entry
            )));
            return { ...updated };
        },
        remove({ ownershipId, tunnelId } = {}) {
            const state = readState();
            const existing = state.entries.find((entry) => entry.ownershipId === String(ownershipId));
            if (!existing) return false;
            if (!existing.tunnelId || existing.tunnelId !== String(tunnelId)) {
                fail('Refusing to release mismatched Cloudflare managed tunnel ownership');
            }
            writeEntries(state.entries.filter((entry) => entry.ownershipId !== existing.ownershipId));
            return true;
        },
    });
}
