import fs from 'fs';
import path from 'path';

import {
    getWorkspaceRoot,
    resolveWorkspacePath
} from '../../utils/workspacePaths.js';
const RESERVED_SECRET_PATH_RE = /(^|\/)\.secrets$|\.secrets$/i;
const MAX_SUGGESTION_RESULTS = 30;

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
        || parsedUrl.searchParams.get('workspaceDir')
        || '';
    if (rawWorkspaceDir) {
        try {
            const resolved = resolveWorkspacePath(rawWorkspaceDir, { workspaceRoot });
            const relativeBase = path.relative(workspaceRoot, resolved).replace(/\\+/g, '/');
            return { root: workspaceRoot, base: resolved, relativeBase };
        } catch (_) {
            return { root: workspaceRoot, base: workspaceRoot, relativeBase: '' };
        }
    }
    const rawCompatDir = parsedUrl.searchParams.get('dir') || '';
    if (rawCompatDir) {
        try {
            const resolved = resolveWorkspacePath(rawCompatDir, {
                workspaceRoot,
                leadingSlashIsWorkspaceRelative: false
            });
            const relativeBase = path.relative(workspaceRoot, resolved).replace(/\\+/g, '/');
            return { root: workspaceRoot, base: resolved, relativeBase };
        } catch (_) {
            return { root: workspaceRoot, base: workspaceRoot, relativeBase: '' };
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

export function handleSuggestionsFiles(req, res, parsedUrl, options = {}) {
    const queryRaw = parsedUrl.searchParams.get('query') || '';
    const limitRaw = parsedUrl.searchParams.get('limit');
    const limitNum = limitRaw ? Math.min(MAX_SUGGESTION_RESULTS, Math.max(1, Number(limitRaw) | 0)) : MAX_SUGGESTION_RESULTS;
    const workspaceBase = resolveWebchatWorkspaceBase(parsedUrl, options);
    const sanitized = sanitizeSuggestionQuery(queryRaw);
    if (sanitized === null) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ok: false, error: 'invalid_query' }));
    }
    const result = listWorkspaceSuggestions({
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
