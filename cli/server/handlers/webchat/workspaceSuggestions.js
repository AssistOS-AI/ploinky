import fs from 'fs';
import path from 'path';
import { setImmediate } from 'node:timers/promises';

import {
    getWorkspaceRoot,
    resolveWorkspacePath,
    resolveWorkspacePathAsync,
    sortWorkspaceEntriesAsync
} from '../../utils/workspacePaths.js';
const RESERVED_SECRET_PATH_RE = /(^|\/)\.secrets$|\.secrets$/i;
const MAX_SUGGESTION_RESULTS = 30;
const suggestionCollator = new Intl.Collator();

function isReservedSecretPath(relativePath) {
    const candidate = String(relativePath || '').replace(/^\/+/, '');
    if (!candidate) return false;
    if (candidate === '.secrets' || candidate.endsWith('/.secrets')) return true;
    if (RESERVED_SECRET_PATH_RE.test(candidate)) return true;
    return false;
}

function shouldSkipSuggestionEntry(name) {
    if (!name || name === '.' || name === '..') return true;
    if (name === '.ploinky' || name === 'node_modules') return true;
    return isReservedSecretPath(name);
}

function isRelativeInside(relativePath) {
    return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function readSuggestionStat(absolute, safeRoot) {
    let stat;
    try {
        stat = fs.lstatSync(absolute);
    } catch (_) {
        return null;
    }
    if (stat.isSymbolicLink()) {
        try {
            const real = fs.realpathSync(absolute);
            const rel = path.relative(safeRoot, real);
            if (!isRelativeInside(rel) && rel !== '') return null;
        } catch (_) {
            return null;
        }
    }
    return stat;
}

function buildWorkspaceSuggestion({ safeRoot, safeBase, absolute, name, stat, displayPath = '' }) {
    const relativeFromRoot = path.relative(safeRoot, absolute).replace(/\\+/g, '/');
    const relativeFromBase = path.relative(safeBase, absolute).replace(/\\+/g, '/');
    if (!isRelativeInside(relativeFromRoot) || !isRelativeInside(relativeFromBase)) return null;
    if (isReservedSecretPath(relativeFromRoot) || isReservedSecretPath(relativeFromBase)) return null;
    const isDir = stat.isDirectory();
    const normalizedDisplayPath = String(displayPath || relativeFromBase).replace(/^\/+/, '');
    return {
        kind: isDir ? 'folder' : 'file',
        label: name,
        displayPath: normalizedDisplayPath,
        path: relativeFromBase,
        relativePath: relativeFromBase,
        workspacePath: relativeFromRoot,
        size: !isDir && Number.isFinite(stat.size) ? stat.size : null,
        mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null
    };
}

function sortWorkspaceSuggestions(candidates, query = '') {
    function pathSegments(item) {
        return String(item.displayPath || item.path || item.label || '').split('/').filter(Boolean);
    }
    function matchRank(item) {
        const normalizedQuery = String(query || '').toLowerCase();
        if (!normalizedQuery) return 0;
        const displayPath = String(item.displayPath || item.path || item.label || '').toLowerCase();
        if (displayPath === normalizedQuery) return 0;
        if (displayPath.startsWith(normalizedQuery)) return 1;
        const segments = displayPath.split('/').filter(Boolean);
        if (segments.some((segment) => segment.startsWith(normalizedQuery))) return 2;
        if (displayPath.includes(normalizedQuery)) return 3;
        return 4;
    }
    function compareSegments(aSegments, bSegments) {
        const max = Math.max(aSegments.length, bSegments.length);
        for (let i = 0; i < max; i += 1) {
            const a = aSegments[i] || '';
            const b = bSegments[i] || '';
            if (!a && b) return -1;
            if (a && !b) return 1;
            const aDot = a.startsWith('.');
            const bDot = b.startsWith('.');
            if (aDot !== bDot) return aDot ? 1 : -1;
            const cmp = a.localeCompare(b);
            if (cmp !== 0) return cmp;
        }
        return 0;
    }
    candidates.sort((a, b) => {
        const rankDelta = matchRank(a) - matchRank(b);
        if (rankDelta !== 0) return rankDelta;
        if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
        return compareSegments(pathSegments(a), pathSegments(b));
    });
    return candidates;
}

function listImmediateWorkspaceSuggestions({ safeRoot, safeBase, scanDir, leafLower, limit }) {
    let entries;
    try {
        entries = fs.readdirSync(scanDir, { withFileTypes: true });
    } catch (_) {
        return [];
    }
    const candidates = [];
    for (const entry of entries) {
        const name = entry.name;
        if (shouldSkipSuggestionEntry(name)) continue;
        if (leafLower && !name.toLowerCase().includes(leafLower)) continue;

        const absolute = path.join(scanDir, name);
        const stat = readSuggestionStat(absolute, safeRoot);
        if (!stat) continue;
        const candidate = buildWorkspaceSuggestion({ safeRoot, safeBase, absolute, name, stat });
        if (!candidate) continue;
        candidates.push(candidate);
    }
    return sortWorkspaceSuggestions(candidates, leafLower).slice(0, limit);
}

function suggestionSortKey(displayPath, kind, query) {
    const normalizedPath = displayPath.toLowerCase();
    const segments = displayPath.split('/').filter(Boolean);
    let rank = 0;
    if (query) {
        if (normalizedPath === query) rank = 0;
        else if (normalizedPath.startsWith(query)) rank = 1;
        else if (segments.some((segment) => segment.toLowerCase().startsWith(query))) rank = 2;
        else rank = normalizedPath.includes(query) ? 3 : 4;
    }
    return { rank, kind, segments };
}

function compareSuggestionKeys(left, right) {
    const rankDelta = left.rank - right.rank;
    if (rankDelta !== 0) return rankDelta;
    if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
    const max = Math.max(left.segments.length, right.segments.length);
    for (let index = 0; index < max; index += 1) {
        const a = left.segments[index] || '';
        const b = right.segments[index] || '';
        if (!a && b) return -1;
        if (a && !b) return 1;
        const aDot = a.startsWith('.');
        const bDot = b.startsWith('.');
        if (aDot !== bDot) return aDot ? 1 : -1;
        const comparison = suggestionCollator.compare(a, b);
        if (comparison !== 0) return comparison;
    }
    return 0;
}

async function readSuggestionStatAsync(absolute, safeRoot) {
    try {
        const stat = await fs.promises.lstat(absolute);
        if (stat.isSymbolicLink()) {
            const real = await fs.promises.realpath(absolute);
            const relative = path.relative(safeRoot, real);
            if (!isRelativeInside(relative) && relative !== '') return null;
        }
        return stat;
    } catch (_) {
        return null;
    }
}

async function readSuggestionBatch(candidates, safeRoot, scanDir) {
    const stats = new Array(candidates.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, async () => {
        while (next < candidates.length) {
            const index = next++;
            const absolute = path.join(scanDir, candidates[index].name);
            stats[index] = await readSuggestionStatAsync(absolute, safeRoot);
        }
    }));
    return stats;
}

async function listImmediateWorkspaceSuggestionsAsync({ safeRoot, safeBase, scanDir, leafLower, limit }) {
    let entries;
    try {
        entries = await fs.promises.readdir(scanDir, { withFileTypes: true });
    } catch (_) {
        return [];
    }
    const candidates = [];
    const rootPrefix = path.relative(safeRoot, scanDir).replace(/\\+/g, '/');
    const basePrefix = path.relative(safeBase, scanDir).replace(/\\+/g, '/');
    for (let index = 0; index < entries.length; index += 1) {
        // Bound preprocessing work even on a large, unsorted directory.
        if (index > 0 && index % 128 === 0) await setImmediate();
        const entry = entries[index];
        if (shouldSkipSuggestionEntry(entry.name)) continue;
        if (leafLower && !entry.name.toLowerCase().includes(leafLower)) continue;
        const namePath = entry.name.replace(/\\+/g, '/');
        const workspacePath = rootPrefix ? `${rootPrefix}/${namePath}` : namePath;
        const displayPath = basePrefix ? `${basePrefix}/${namePath}` : namePath;
        if (!isRelativeInside(workspacePath) || !isRelativeInside(displayPath)) continue;
        if (isReservedSecretPath(workspacePath) || isReservedSecretPath(displayPath)) continue;
        const kind = entry.isDirectory() ? 'folder' : 'file';
        const candidate = suggestionSortKey(displayPath, kind, leafLower);
        candidate.name = entry.name;
        candidates.push(candidate);
    }
    const sortedCandidates = await sortWorkspaceEntriesAsync(candidates, compareSuggestionKeys);

    const accepted = [];
    let kindChanged = false;
    const batchSize = Math.max(1, Math.floor(limit));
    for (let offset = 0; offset < sortedCandidates.length && accepted.length < limit; offset += batchSize) {
        const batch = sortedCandidates.slice(offset, offset + batchSize);
        const stats = await readSuggestionBatch(batch, safeRoot, scanDir);
        for (let index = 0; index < batch.length && accepted.length < limit; index += 1) {
            const stat = stats[index];
            if (!stat) continue;
            const item = buildWorkspaceSuggestion({ safeRoot, safeBase,
                absolute: path.join(scanDir, batch[index].name), name: batch[index].name, stat });
            if (!item) continue;
            if (item.kind !== batch[index].kind) kindChanged = true;
            accepted.push(item);
        }
    }
    if (kindChanged) {
        const ranked = accepted.map((item) => ({ item,
            key: suggestionSortKey(item.displayPath, item.kind, leafLower) }));
        const sorted = await sortWorkspaceEntriesAsync(ranked,
            (left, right) => compareSuggestionKeys(left.key, right.key));
        return sorted.map(({ item }) => item);
    }
    return accepted;
}

export function sanitizeSuggestionQuery(rawQuery) {
    const raw = String(rawQuery || '').trim();
    if (!raw) return { folder: '', leaf: '' };
    if (raw.includes('\0')) return null;
    const normalized = raw.replace(/\\+/g, '/');
    if (normalized.startsWith('/')) return null;
    if (normalized.split('/').some((segment) => segment === '..')) return null;
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash === -1) {
        return { folder: '', leaf: normalized };
    }
    return {
        folder: normalized.slice(0, lastSlash),
        leaf: normalized.slice(lastSlash + 1)
    };
}

export function resolveWebchatWorkspaceBase(parsedUrl, { workspaceRoot: configuredRoot = getWorkspaceRoot() } = {}) {
    let workspaceRoot = configuredRoot;
    try {
        workspaceRoot = fs.realpathSync(configuredRoot);
    } catch (_) {
        workspaceRoot = path.resolve(configuredRoot);
    }
    const rawWorkspaceDir = parsedUrl.searchParams.get('workspace-dir')
        ?? parsedUrl.searchParams.get('workspaceDir');
    if (rawWorkspaceDir !== null) {
        try {
            const resolved = resolveWorkspacePath(rawWorkspaceDir, { workspaceRoot });
            const relativeBase = path.relative(workspaceRoot, resolved).replace(/\\+/g, '/');
            return { root: workspaceRoot, base: resolved, relativeBase };
        } catch (_) {
            throw new Error('Invalid WebChat workspace directory.');
        }
    }
    return { root: workspaceRoot, base: workspaceRoot, relativeBase: '' };
}

export async function resolveWebchatWorkspaceBaseAsync(parsedUrl, {
    workspaceRoot: configuredRoot = getWorkspaceRoot()
} = {}) {
    let workspaceRoot;
    try {
        workspaceRoot = await fs.promises.realpath(configuredRoot);
    } catch (_) {
        workspaceRoot = path.resolve(configuredRoot);
    }
    const rawWorkspaceDir = parsedUrl.searchParams.get('workspace-dir')
        ?? parsedUrl.searchParams.get('workspaceDir');
    if (rawWorkspaceDir !== null) {
        try {
            const resolved = await resolveWorkspacePathAsync(rawWorkspaceDir, { workspaceRoot });
            const relativeBase = path.relative(workspaceRoot, resolved).replace(/\\+/g, '/');
            return { root: workspaceRoot, base: resolved, relativeBase };
        } catch (_) {
            throw new Error('Invalid WebChat workspace directory.');
        }
    }
    return { root: workspaceRoot, base: workspaceRoot, relativeBase: '' };
}

export function listWorkspaceSuggestions({
    workspaceRoot,
    base,
    folder,
    leaf,
    limit = MAX_SUGGESTION_RESULTS
} = {}) {
    const requestedRoot = workspaceRoot ? path.resolve(workspaceRoot) : getWorkspaceRoot();
    let safeRoot;
    try {
        safeRoot = fs.realpathSync(requestedRoot);
    } catch (_) {
        safeRoot = requestedRoot;
    }
    const requestedBase = base ? path.resolve(base) : safeRoot;
    let safeBase;
    if (!safeRoot) return { ok: false, items: [], error: 'workspace_unavailable' };
    try {
        safeBase = resolveWorkspacePath(requestedBase, {
            workspaceRoot: safeRoot,
            leadingSlashIsWorkspaceRelative: false
        });
    } catch (_) {
        return { ok: true, items: [] };
    }
    const folderRelative = folder ? folder.replace(/\\+/g, '/').replace(/^\/+/, '') : '';
    let scanDir;
    try {
        scanDir = folderRelative
            ? resolveWorkspacePath(path.join(safeBase, folderRelative), {
                workspaceRoot: safeRoot,
                leadingSlashIsWorkspaceRelative: false
            })
            : safeBase;
    } catch (_) {
        return { ok: true, items: [] };
    }
    const leafLower = leaf ? leaf.toLowerCase() : '';
    const items = listImmediateWorkspaceSuggestions({
        safeRoot,
        safeBase,
        scanDir,
        leafLower,
        limit
    });
    return { ok: true, items };
}

export async function listWorkspaceSuggestionsAsync({
    workspaceRoot,
    base,
    folder,
    leaf,
    limit = MAX_SUGGESTION_RESULTS
} = {}) {
    limit = Math.floor(limit);
    if (limit <= 0) return { ok: true, items: [] };
    const requestedRoot = workspaceRoot ? path.resolve(workspaceRoot) : getWorkspaceRoot();
    let safeRoot;
    try {
        safeRoot = await fs.promises.realpath(requestedRoot);
    } catch (_) {
        safeRoot = requestedRoot;
    }
    const requestedBase = base ? path.resolve(base) : safeRoot;
    if (!safeRoot) return { ok: false, items: [], error: 'workspace_unavailable' };
    let safeBase;
    let scanDir;
    try {
        safeBase = await resolveWorkspacePathAsync(requestedBase, {
            workspaceRoot: safeRoot,
            leadingSlashIsWorkspaceRelative: false
        });
        const folderRelative = folder ? folder.replace(/\\+/g, '/').replace(/^\/+/, '') : '';
        scanDir = folderRelative
            ? await resolveWorkspacePathAsync(path.join(safeBase, folderRelative), {
                workspaceRoot: safeRoot,
                leadingSlashIsWorkspaceRelative: false
            })
            : safeBase;
    } catch (_) {
        return { ok: true, items: [] };
    }
    const items = await listImmediateWorkspaceSuggestionsAsync({
        safeRoot,
        safeBase,
        scanDir,
        leafLower: leaf ? leaf.toLowerCase() : '',
        limit
    });
    return { ok: true, items };
}

export async function handleSuggestionsFiles(req, res, parsedUrl, options = {}) {
    const queryRaw = parsedUrl.searchParams.get('query') || '';
    const limitRaw = parsedUrl.searchParams.get('limit');
    const limitNum = limitRaw ? Math.min(MAX_SUGGESTION_RESULTS, Math.max(1, Number(limitRaw) | 0)) : MAX_SUGGESTION_RESULTS;
    const workspaceBase = await resolveWebchatWorkspaceBaseAsync(parsedUrl, options);
    const sanitized = sanitizeSuggestionQuery(queryRaw);
    if (sanitized === null) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ok: false, error: 'invalid_query' }));
    }
    const result = await listWorkspaceSuggestionsAsync({
        workspaceRoot: workspaceBase.base,
        base: workspaceBase.base,
        folder: sanitized.folder,
        leaf: sanitized.leaf,
        limit: limitNum
    });
    if (!result.ok) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ok: false, error: result.error || 'lookup_failed' }));
    }
    const items = result.items.map((item) => {
        const relativePath = String(item.path || '').replace(/^\/+/, '');
        const workspacePath = workspaceBase.relativeBase
            ? `${workspaceBase.relativeBase}/${relativePath}`
            : relativePath;
        return {
            ...item,
            displayPath: relativePath,
            relativePath,
            queryPath: relativePath,
            path: relativePath,
            workspacePath
        };
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
        ok: true,
        root: '',
        items
    }));
}
