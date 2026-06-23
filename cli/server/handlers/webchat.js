import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { resolveWebchatCommandsForAgent } from '../webchat/commandResolver.js';
import { parseCookies, buildCookie, appendSetCookie } from './common.js';
import * as staticSrv from '../static/index.js';
import {
    getWorkspaceRoot,
    resolveWorkspacePath
} from '../utils/workspacePaths.js';
import {
    ensureSessionUploadRoot,
} from '../webchat/uploadPaths.js';
import {
    handleWebchatUploadGet,
    handleWebchatUploadPost,
    resolveWebchatUploadContext,
} from './webchatUploads.js';
import { buildInvocationContextForProviderCall } from '../mcp-proxy/index.js';
import {
    appendMessage as appendTranscriptMessage,
    appendToMessage as appendTranscriptToMessage,
    closeConversation as closeTranscriptConversation,
    createConversation as createTranscriptConversation,
    setTurnRating as setTranscriptTurnRating,
} from '../utils/transcriptStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appName = 'webchat';
const fallbackAppPath = path.join(__dirname, '../', appName);
const SID_COOKIE = `${appName}_sid`;
const STREAM_RECONNECT_GRACE_MS = 120000;
const MAX_PENDING_SSE_EVENTS = 200;

const PROCESS_PREFIX_RE = /^(?:\s*\.+\s*){3,}/;

function renderTemplate(filenames, replacements) {
    const target = staticSrv.resolveFirstAvailable(appName, fallbackAppPath, filenames);
    if (!target) return null;
    let html = fs.readFileSync(target, 'utf8');
    for (const [key, value] of Object.entries(replacements || {})) {
        html = html.split(key).join(String(value ?? ''));
    }
    return html;
}

function stripCtrlAndAnsi(input) {
    try {
        let out = input || '';
        out = out.replace(/\u001b\][^\u0007\u001b]*?(?:\u0007|\u001b\\)/g, '');
        out = out.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        out = out.replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F]/g, '');
        return out;
    } catch (_) {
        return input;
    }
}

function isProcessingChunk(text) {
    if (!text) {
        return false;
    }
    const trimmed = text.replace(/\s/g, '');
    if (trimmed.length === 0 || !/^[.·…]+$/.test(trimmed)) {
        return false;
    }
    const hasWhitespace = /\s/.test(text);
    return hasWhitespace || trimmed.length > 3;
}

function stripProcessingPrefix(text) {
    if (!text) {
        return text;
    }
    const match = PROCESS_PREFIX_RE.exec(text);
    if (!match) {
        return text;
    }
    if (match[0].length >= text.length) {
        return '';
    }
    return text.slice(match[0].length);
}

function looksLikeReadlinePromptEcho(text, pendingClientText) {
    if (!text || !pendingClientText) {
        return false;
    }
    const trimmed = String(text).trim();
    const clientText = String(pendingClientText).trim();
    if (!clientText) {
        return false;
    }
    return trimmed === clientText
        || (trimmed.startsWith('you> ') && trimmed.slice(5).trim() === clientText);
}

function looksLikeEnvelopeEcho(text) {
    const normalized = String(text || '').trim();
    return normalized.includes('"__webchatMessage"')
        && normalized.includes('"version"')
        && normalized.includes('"text"')
        && normalized.includes('"attachments"');
}

function looksLikeProgressEnvelope(text) {
    const normalized = String(text || '').trim();
    if (!normalized.includes('"__webchatProgress"')) {
        return false;
    }
    try {
        const parsed = JSON.parse(normalized);
        return Boolean(parsed && parsed.__webchatProgress);
    } catch (_) {
        return true;
    }
}

function parseInputEnvelope(rawBody) {
    const fallbackText = typeof rawBody === 'string' ? rawBody : '';
    try {
        const parsed = JSON.parse(fallbackText);
        if (parsed && parsed.__webchatMessage && typeof parsed === 'object') {
            return {
                text: typeof parsed.text === 'string' ? parsed.text : '',
                attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
                references: sanitizeWebchatReferencesForEnvelope(parsed.references)
            };
        }
    } catch (_) {
        // Fall back to plain text input.
    }
    return { text: fallbackText, attachments: [], references: [] };
}

function sanitizeWebchatAttachmentsForEnvelope(attachments = []) {
    return Array.isArray(attachments)
        ? attachments
            .filter((entry) => entry && typeof entry === 'object')
            .map((entry) => ({
                id: typeof entry.id === 'string' ? entry.id : null,
                filename: typeof entry.filename === 'string' ? entry.filename : null,
                mime: typeof entry.mime === 'string' ? entry.mime : null,
                size: Number.isFinite(entry.size) ? entry.size : null,
                downloadUrl: typeof entry.downloadUrl === 'string' ? entry.downloadUrl : null,
                localPath: typeof entry.localPath === 'string' ? entry.localPath : null
            }))
        : [];
}

const REFERENCE_SECRET_RE = /(^|\/)\.secrets$|\.secrets$/i;

function sanitizeWebchatReferencesForEnvelope(references = []) {
    if (!Array.isArray(references)) return [];
    const out = [];
    for (const entry of references) {
        if (!entry || typeof entry !== 'object') continue;
        const kind = typeof entry.kind === 'string' ? entry.kind.trim() : '';
        const refPath = typeof entry.path === 'string' ? entry.path.trim() : '';
        if (!kind || !refPath) continue;
        if (refPath.includes('\0')) continue;
        if (kind === 'workspace-path') {
            const normalized = refPath.replace(/\\+/g, '/');
            if (normalized.startsWith('/')) continue;
            if (normalized.includes('..')) continue;
            if (REFERENCE_SECRET_RE.test(normalized)) continue;
            out.push({
                kind,
                path: normalized,
                type: typeof entry.type === 'string' && entry.type ? entry.type : null,
                label: typeof entry.label === 'string' && entry.label ? entry.label : null
            });
        }
    }
    return out;
}

function buildWebchatInvocationToken({ req, effectiveConfig, tabId, envelope }) {
    const agentName = String(effectiveConfig?.agentName || '').trim();
    if (!agentName) {
        return '';
    }
    try {
        const invocation = buildInvocationContextForProviderCall({
            req,
            agentName,
            toolName: '__webchat_message__',
            toolArgs: {
                surface: 'webchat',
                tabId: String(tabId || ''),
                text: typeof envelope?.text === 'string' ? envelope.text : '',
                attachments: sanitizeWebchatAttachmentsForEnvelope(envelope?.attachments),
                references: sanitizeWebchatReferencesForEnvelope(envelope?.references)
            }
        });
        return invocation?.token || '';
    } catch (_) {
        return '';
    }
}

function firstHeaderValue(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    return String(raw || '').split(',')[0].trim();
}

function resolveRequestPublicOrigin(req) {
    const headers = req?.headers || {};
    const proto = firstHeaderValue(headers['x-forwarded-proto'])
        || (req?.socket?.encrypted ? 'https' : 'http');
    const host = firstHeaderValue(headers['x-forwarded-host'])
        || firstHeaderValue(headers.host);
    const normalizedProto = String(proto || '').toLowerCase().replace(/:$/, '');
    if (!/^(http|https)$/.test(normalizedProto) || !host) {
        return '';
    }
    if (/[\r\n/?#\\]/.test(host)) {
        return '';
    }
    try {
        const parsed = new URL(`${normalizedProto}://${host}`);
        if (!parsed.hostname) {
            return '';
        }
        return parsed.origin;
    } catch (_) {
        return '';
    }
}

function serializeWebchatEnvelopeForAgent({ req, effectiveConfig, tabId, envelope, fallbackText = '' }) {
    const sanitizedReferences = sanitizeWebchatReferencesForEnvelope(envelope?.references);
    const publicBaseUrl = resolveRequestPublicOrigin(req);
    const payload = {
        __webchatMessage: 1,
        version: 1,
        text: (envelope && typeof envelope.text === 'string') ? envelope.text : String(fallbackText || ''),
        attachments: sanitizeWebchatAttachmentsForEnvelope(envelope?.attachments)
    };
    if (publicBaseUrl) {
        payload.origin = { publicBaseUrl };
    }
    if (sanitizedReferences.length) {
        payload.references = sanitizedReferences;
    }
    const token = buildWebchatInvocationToken({
        req,
        effectiveConfig,
        tabId,
        envelope: payload
    });
    if (token) {
        payload.invocation = { token };
    }
    return JSON.stringify(payload);
}

function isTruthyQueryValue(value) {
    return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function shouldForwardWebchatEnvelope(parsedUrl, effectiveConfig = null) {
    return isTruthyQueryValue(parsedUrl.searchParams.get('forward-envelope'))
        || isTruthyQueryValue(parsedUrl.searchParams.get('forwardEnvelope'))
        || effectiveConfig?.forwardEnvelope === true;
}

function buildTranscriptContext(req, appState, tabId) {
    const sid = getSession(req, appState) || '';
    return {
        authMode: req.authMode || (req.user ? 'user' : 'anonymous'),
        sessionId: sid,
        userId: req.user?.id || '',
        tabId
    };
}

function buildWebchatQuery(parsedUrl, agentName = '') {
    const params = new URLSearchParams(parsedUrl.searchParams);
    if (agentName) {
        params.set('agent', agentName);
    }
    params.delete('tabId');
    return params.toString();
}

function resolveWorkspaceScopedQueryPath(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.includes('\0') || path.isAbsolute(raw)) {
        return '';
    }
    const root = getWorkspaceRoot();
    const resolved = path.resolve(root, raw);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return '';
    }
    return resolved;
}

function resolveWebchatLaunchOptions(parsedUrl) {
    const cliArgs = [];
    for (const [rawKey, rawValue] of parsedUrl.searchParams.entries()) {
        const key = String(rawKey || '').trim();
        if (!key || key === 'agent' || key === 'tabId') {
            continue;
        }
        if (key === 'workspace-dir' || key === 'workspaceDir') {
            const resolved = resolveWorkspaceScopedQueryPath(rawValue);
            if (resolved) {
                cliArgs.push(`--dir=${resolved}`);
            }
            continue;
        }
        if (key === 'workspace-skill-root' || key === 'workspaceSkillRoot') {
            const resolved = resolveWorkspaceScopedQueryPath(rawValue);
            if (resolved) {
                cliArgs.push(`--skill-root=${resolved}`);
            }
            continue;
        }
        cliArgs.push(rawValue === '' ? `--${key}` : `--${key}=${String(rawValue)}`);
    }
    return {
        cliArgs
    };
}

const RESERVED_SECRET_PATH_RE = /(^|\/)\.secrets$|\.secrets$/i;
const MAX_SUGGESTION_RESULTS = 30;
const SUGGESTION_SEARCH_MAX_DEPTH = 4;
const SUGGESTION_SEARCH_MAX_DIRS = 400;

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

function shouldDescendSuggestionDirectory(name) {
    if (name === '.git') return false;
    return !shouldSkipSuggestionEntry(name);
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
        if (candidates.length >= limit * 2) break;
    }
    return sortWorkspaceSuggestions(candidates, leafLower).slice(0, limit);
}

function listRecursiveWorkspaceSuggestions({ safeRoot, safeBase, leafLower, limit }) {
    const candidates = [];
    const queue = [{ dir: safeBase, depth: 0 }];
    let visitedDirs = 0;
    while (queue.length && visitedDirs < SUGGESTION_SEARCH_MAX_DIRS && candidates.length < limit * 4) {
        const { dir, depth } = queue.shift();
        visitedDirs += 1;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
            continue;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const name = entry.name;
            if (shouldSkipSuggestionEntry(name)) continue;
            const absolute = path.join(dir, name);
            const stat = readSuggestionStat(absolute, safeRoot);
            if (!stat) continue;
            const relativeFromBase = path.relative(safeBase, absolute).replace(/\\+/g, '/');
            if (!isRelativeInside(relativeFromBase)) continue;
            const normalizedPath = relativeFromBase.toLowerCase();
            if (normalizedPath.includes(leafLower)) {
                const candidate = buildWorkspaceSuggestion({
                    safeRoot,
                    safeBase,
                    absolute,
                    name,
                    stat,
                    displayPath: relativeFromBase
                });
                if (candidate) candidates.push(candidate);
            }
            if (stat.isDirectory() && depth < SUGGESTION_SEARCH_MAX_DEPTH && shouldDescendSuggestionDirectory(name)) {
                queue.push({ dir: absolute, depth: depth + 1 });
            }
            if (candidates.length >= limit * 4) break;
        }
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

export function resolveWebchatWorkspaceBase(parsedUrl) {
    const configuredRoot = getWorkspaceRoot();
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
            const relativeBase = path.relative(workspaceRoot, resolved);
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
            const relativeBase = path.relative(workspaceRoot, resolved);
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
    const safeRoot = workspaceRoot ? path.resolve(workspaceRoot) : getWorkspaceRoot();
    const safeBase = base ? path.resolve(base) : safeRoot;
    if (!safeRoot) return { ok: false, items: [], error: 'workspace_unavailable' };
    const folderRelative = folder ? folder.replace(/\\+/g, '/').replace(/^\/+/, '') : '';
    let scanDir;
    try {
        scanDir = folderRelative
            ? resolveWorkspacePath(path.join(safeBase, folderRelative), { workspaceRoot: safeRoot })
            : safeBase;
    } catch (_) {
        return { ok: true, items: [] };
    }
    const leafLower = leaf ? leaf.toLowerCase() : '';
    const items = !folderRelative && leafLower
        ? listRecursiveWorkspaceSuggestions({ safeRoot, safeBase, leafLower, limit })
        : listImmediateWorkspaceSuggestions({ safeRoot, safeBase, scanDir, leafLower, limit });
    return { ok: true, items };
}

export function normalizeUploadSuggestionQueryPath(rawPath, uploadRootRelToCwd) {
    const normalized = String(rawPath || '').trim().replace(/\\+/g, '/');
    if (!normalized) return '';
    if (normalized.startsWith('/')) return normalized;
    const rootPrefix = String(uploadRootRelToCwd || '').trim().replace(/\\+/g, '/').replace(/^\/+|\/+$/g, '');
    if (!rootPrefix) return normalized;
    if (normalized === rootPrefix) return '';
    if (normalized.startsWith(`${rootPrefix}/`)) {
        return normalized.slice(rootPrefix.length + 1);
    }
    return normalized;
}

export function rewriteUploadSuggestionItem(item, { uploadRootRelToCwd, uploadRootRelToWorkspace }) {
    if (!item || typeof item !== 'object') return item;
    const sessionRelative = String(item.workspacePath || item.relativePath || item.path || '').replace(/^\/+/, '');
    const joinedCwd = uploadRootRelToCwd
        ? (sessionRelative ? `${uploadRootRelToCwd}/${sessionRelative}` : uploadRootRelToCwd)
        : sessionRelative;
    const joinedWorkspace = uploadRootRelToWorkspace
        ? (sessionRelative ? `${uploadRootRelToWorkspace}/${sessionRelative}` : uploadRootRelToWorkspace)
        : sessionRelative;
    return {
        ...item,
        displayPath: sessionRelative || item.displayPath,
        relativePath: sessionRelative,
        queryPath: sessionRelative,
        path: joinedCwd,
        workspacePath: joinedWorkspace,
    };
}

function handleSuggestionsFiles(req, res, parsedUrl, appState) {
    const queryRaw = parsedUrl.searchParams.get('query') || '';
    const limitRaw = parsedUrl.searchParams.get('limit');
    const limitNum = limitRaw ? Math.min(MAX_SUGGESTION_RESULTS, Math.max(1, Number(limitRaw) | 0)) : MAX_SUGGESTION_RESULTS;
    const baseRaw = parsedUrl.searchParams.get('base') || '';
    const workspaceBase = resolveWebchatWorkspaceBase(parsedUrl);
    const sessionId = getSession(req, appState);
    const uploadContext = resolveWebchatUploadContext({ workspaceBase, sessionId });

    if (!uploadContext) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ok: true, root: '', items: [] }));
    }
    ensureSessionUploadRoot(uploadContext.uploadRoot);

    const uploadRootRelToCwd = path.relative(uploadContext.cwd, uploadContext.uploadRoot).replace(/\\+/g, '/');
    const uploadRootRelToWorkspace = path.relative(uploadContext.workspaceRoot, uploadContext.uploadRoot).replace(/\\+/g, '/');
    const queryForUploadRoot = normalizeUploadSuggestionQueryPath(queryRaw, uploadRootRelToCwd);
    const sanitized = sanitizeSuggestionQuery(queryForUploadRoot);
    if (sanitized === null) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ok: false, error: 'invalid_query' }));
    }
    const baseForUploadRoot = normalizeUploadSuggestionQueryPath(baseRaw, uploadRootRelToCwd);
    const baseSanitized = sanitizeSuggestionQuery(baseForUploadRoot);
    if (baseSanitized === null) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ok: false, error: 'invalid_base' }));
    }

    let effectiveBase = uploadContext.uploadRoot;
    if (baseSanitized.folder || baseSanitized.leaf) {
        try {
            const combined = baseSanitized.folder
                ? path.join(baseSanitized.folder, baseSanitized.leaf || '')
                : (baseSanitized.leaf || '');
            effectiveBase = combined
                ? resolveWorkspacePath(path.join(uploadContext.uploadRoot, combined), {
                    workspaceRoot: uploadContext.uploadRoot
                })
                : uploadContext.uploadRoot;
        } catch (_) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ ok: false, error: 'invalid_base' }));
        }
    }
    const result = listWorkspaceSuggestions({
        workspaceRoot: uploadContext.uploadRoot,
        base: effectiveBase,
        folder: sanitized.folder,
        leaf: sanitized.leaf,
        limit: limitNum
    });
    if (!result.ok) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ok: false, error: result.error || 'lookup_failed' }));
    }
    const items = result.items.map((item) => rewriteUploadSuggestionItem(item, {
        uploadRootRelToCwd,
        uploadRootRelToWorkspace,
    }));
    const relativeBase = path.relative(uploadContext.uploadRoot, effectiveBase).replace(/\\+/g, '/');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
        ok: true,
        root: relativeBase,
        items
    }));
}

function handleTranscriptAssistantLine(tab, rawLine) {
    if (!tab?.transcript) {
        return null;
    }
    const transcript = tab.transcript;
    const originalText = typeof rawLine === 'string' ? rawLine : String(rawLine || '');
    if (!originalText) {
        return null;
    }
    if (isProcessingChunk(originalText)) {
        return null;
    }
    const stripped = stripProcessingPrefix(originalText);
    const normalized = stripped.trim();
    if (!normalized || looksLikeEnvelopeEcho(normalized) || looksLikeProgressEnvelope(normalized)) {
        return null;
    }
    const pendingEcho = String(transcript.lastClientText || '').trim();
    if (pendingEcho && looksLikeReadlinePromptEcho(normalized, pendingEcho)) {
        transcript.lastClientText = '';
        return null;
    }
    try {
        let messageId = transcript.lastAssistantMessageId || null;
        let append = false;
        if (!transcript.userInputSent && transcript.lastAssistantMessageId) {
            const appended = appendTranscriptToMessage(transcript.conversationId, transcript.lastAssistantMessageId, stripped);
            if (!appended) {
                const created = appendTranscriptMessage(transcript.conversationId, {
                    role: 'assistant',
                    text: stripped,
                    metadata: {
                        promptMessageId: transcript.lastUserMessageId || null,
                        turnId: transcript.currentTurnId || null
                    }
                });
                transcript.lastAssistantMessageId = created.messageId;
                messageId = created.messageId;
                append = false;
            } else {
                messageId = transcript.lastAssistantMessageId;
                append = true;
            }
        } else {
            const created = appendTranscriptMessage(transcript.conversationId, {
                role: 'assistant',
                text: stripped,
                metadata: {
                    promptMessageId: transcript.lastUserMessageId || null,
                    turnId: transcript.currentTurnId || null
                }
            });
            transcript.lastAssistantMessageId = created.messageId;
            messageId = created.messageId;
            append = false;
        }
        transcript.userInputSent = false;
        return messageId ? { messageId, append } : null;
    } catch (_) {
        // Transcript capture must never break live chat.
        return null;
    }
}

function captureTranscriptOutput(tab, data) {
    if (!tab?.transcript) {
        return [];
    }
    const transcript = tab.transcript;
    transcript.buffer += stripCtrlAndAnsi(String(data ?? ''));
    const lines = transcript.buffer.split(/\r?\n/);
    transcript.buffer = lines.pop() ?? '';
    const events = [];
    for (const line of lines) {
        const meta = handleTranscriptAssistantLine(tab, line);
        if (meta?.messageId) {
            events.push(meta);
        }
    }
    return events;
}

function flushTranscriptOutput(tab) {
    if (!tab?.transcript?.buffer) {
        return;
    }
    const tail = stripCtrlAndAnsi(tab.transcript.buffer);
    tab.transcript.buffer = '';
    if (tail.trim() && !isProcessingChunk(tail)) {
        handleTranscriptAssistantLine(tab, tail);
    }
}

function getSession(req, appState) {
    const cookies = parseCookies(req);
    const sid = cookies.get(SID_COOKIE);
    return (sid && appState.sessions.has(sid)) ? sid : null;
}

function authorized(req) {
    return Boolean(req?.user);
}

function redirectToRouterLogin(req, res, parsedUrl, agentOverride = '') {
    const returnTo = `${parsedUrl.pathname || `/${appName}/`}${parsedUrl.search || ''}`;
    const params = new URLSearchParams({ returnTo });
    if (agentOverride) {
        params.set('agent', agentOverride);
    }
    res.writeHead(302, {
        Location: `/auth/login?${params.toString()}`,
        'Cache-Control': 'no-store'
    });
    res.end('Authentication required');
}

function ensureAppSession(req, res, appState) {
    const cookies = parseCookies(req);
    let sid = cookies.get(SID_COOKIE);
    if (!sid) {
        sid = crypto.randomBytes(16).toString('hex');
        appState.sessions.set(sid, { tabs: new Map(), createdAt: Date.now() });
        appendSetCookie(res, buildCookie(SID_COOKIE, sid, req, `/${appName}`));
    } else if (!appState.sessions.has(sid)) {
        appState.sessions.set(sid, { tabs: new Map(), createdAt: Date.now() });
    }
    if (!cookies.has(SID_COOKIE)) {
        const existing = req.headers.cookie || '';
        req.headers.cookie = existing ? `${existing}; ${SID_COOKIE}=${sid}` : `${SID_COOKIE}=${sid}`;
    }
    return sid;
}

function forceKillPid(pid, tabId) {
    if (!pid || typeof global.processKill !== 'function') {
        return;
    }
    setTimeout(() => {
        try {
            global.processKill(pid, 0);
            global.processKill(pid, 'SIGKILL');
            console.warn(`[webchat] Force killed lingering process ${pid} for tab ${tabId}`);
        } catch (_) {
            console.log(`[webchat] Process ${pid} already dead for tab ${tabId}`);
        }
    }, 2000);
}

function pushPendingSseEvent(tab, payload) {
    if (!tab || !payload) return;
    if (!Array.isArray(tab.pendingSseEvents)) {
        tab.pendingSseEvents = [];
    }
    tab.pendingSseEvents.push(String(payload));
    if (tab.pendingSseEvents.length > MAX_PENDING_SSE_EVENTS) {
        tab.pendingSseEvents.splice(0, tab.pendingSseEvents.length - MAX_PENDING_SSE_EVENTS);
    }
}

export function writeOrBufferSseEvent(tab, payload) {
    if (!tab || !payload) return;
    if (tab.sseRes) {
        try {
            tab.sseRes.write(String(payload));
            return;
        } catch (_) {
            tab.sseRes = null;
        }
    }
    pushPendingSseEvent(tab, payload);
}

export function flushPendingSseEvents(tab) {
    if (!tab?.sseRes || !Array.isArray(tab.pendingSseEvents) || tab.pendingSseEvents.length === 0) {
        return;
    }
    const pending = tab.pendingSseEvents.splice(0);
    for (const payload of pending) {
        try {
            tab.sseRes.write(payload);
        } catch (_) {
            pushPendingSseEvent(tab, payload);
            tab.sseRes = null;
            return;
        }
    }
}

function scheduleDisconnectedTabCleanup(tab, tabId, session, graceMs = STREAM_RECONNECT_GRACE_MS) {
    if (!tab || tab.disposed) return;
    if (tab.cleanupTimer) {
        clearTimeout(tab.cleanupTimer);
        tab.cleanupTimer = null;
    }
    tab.cleanupTimer = setTimeout(() => {
        if (tab.sseRes || tab.disposed) return;
        console.log(`[webchat] Reconnect grace expired for tab ${tabId}; disposing TTY.`);
        disposeTab(tab, tabId, session);
    }, Math.max(1000, Number(graceMs) || STREAM_RECONNECT_GRACE_MS));
    tab.cleanupTimer.unref?.();
}

function disposeTab(tab, tabId, session) {
    if (!tab) {
        return;
    }
    const pid = tab.pid || tab.tty?.pid;
    if (tab.disposed) {
        if (session?.tabs instanceof Map) {
            session.tabs.delete(tabId);
        }
        return;
    }
    tab.disposed = true;

    if (tab.cleanupTimer) {
        clearTimeout(tab.cleanupTimer);
        tab.cleanupTimer = null;
    }

    if (tab.tty) {
        flushTranscriptOutput(tab);
        console.log(`[webchat] Disposing TTY for tab ${tabId}`);
        if (typeof tab.tty.dispose === 'function') {
            try {
                tab.tty.dispose();
                console.log(`[webchat] dispose() called for pid ${pid}`);
            } catch (error) {
                console.error(`[webchat] dispose error: ${error?.message}`);
            }
        } else if (typeof tab.tty.kill === 'function') {
            try {
                tab.tty.kill();
                console.log(`[webchat] kill() called for pid ${pid}`);
            } catch (error) {
                console.error(`[webchat] kill error: ${error?.message}`);
            }
        }
        tab.tty = null;
        forceKillPid(pid, tabId);
    }

    if (tab.sseRes) {
        try {
            tab.sseRes.end();
        } catch (_) {
            // Ignore disconnect write failures
        }
    }
    tab.sseRes = null;

    if (session?.tabs instanceof Map) {
        session.tabs.delete(tabId);
    }

    if (tab.transcript?.conversationId) {
        try {
            closeTranscriptConversation(tab.transcript.conversationId);
        } catch (_) {
            // Ignore transcript finalization errors.
        }
    }
}

function buildLogoutRedirect(agentQuery) {
    return agentQuery ? `/${appName}/?${agentQuery}` : `/${appName}/`;
}

function buildSsoLogoutRedirect(agentQuery) {
    const loggedOut = '/auth/logged-out';
    return `/auth/logout?returnTo=${encodeURIComponent(loggedOut)}`;
}

function handleLogout(req, res, appState, agentQuery) {
    const sid = getSession(req, appState);
    const session = sid ? appState.sessions.get(sid) : null;

    if (session?.tabs instanceof Map) {
        for (const [tabId, tab] of session.tabs.entries()) {
            disposeTab(tab, tabId, session);
        }
    }

    if (sid) {
        appState.sessions.delete(sid);
    }

    const cookies = [
        buildCookie(SID_COOKIE, '', req, `/${appName}`, { maxAge: 0 })
    ];

    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': cookies,
        'Cache-Control': 'no-store'
    });
    const redirect = req.user
        ? buildSsoLogoutRedirect(agentQuery)
        : buildLogoutRedirect(agentQuery);
    res.end(JSON.stringify({
        ok: true,
        redirect
    }));
}

async function handleWebChat(req, res, appConfig, appState) {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname.substring(`/${appName}`.length) || '/';
    const agentOverrideRaw = parsedUrl.searchParams.get('agent') || '';
    const agentOverride = agentOverrideRaw.trim();
    const launchOptions = resolveWebchatLaunchOptions(parsedUrl);
    let effectiveConfig = appConfig;
    let agentQuery = '';

    if (agentOverride) {
        const overrideCommands = resolveWebchatCommandsForAgent(agentOverride, {
            cliArgs: launchOptions.cliArgs
        });
        if (!overrideCommands) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Agent not found or not enabled.');
            return;
        }
        if (typeof appConfig.getFactoryForCommands !== 'function') {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Dynamic agent selection unavailable.');
            return;
        }
        const overrideConfig = appConfig.getFactoryForCommands(overrideCommands);
        if (!overrideConfig || !overrideConfig.ttyFactory) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Unable to start agent session.');
            return;
        }
        effectiveConfig = overrideConfig;
        agentQuery = buildWebchatQuery(parsedUrl, overrideCommands.agentName || agentOverride);
    }

    if (pathname === '/auth' && req.method === 'POST') {
        res.writeHead(410, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({
            ok: false,
            error: 'surface_token_auth_removed',
            detail: 'Use the router login page.'
        }));
    }
    if (pathname === '/logout' && req.method === 'POST') return handleLogout(req, res, appState, agentQuery);
    if (pathname === '/whoami') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: authorized(req) }));
    }

    if (pathname === '/feedback' && req.method === 'POST') {
        const sid = getSession(req, appState);
        const session = appState.sessions.get(sid);
        let body;
        try {
            body = await readJsonBody(req);
        } catch (_) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
        }
        const tabId = String(body?.tabId || '').trim();
        const messageId = String(body?.messageId || '').trim();
        const rating = body?.rating === 'up' || body?.rating === 'down' ? body.rating : null;
        const tab = session?.tabs?.get(tabId);
        if (!tab?.transcript?.conversationId || !messageId) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'message_not_found' }));
        }
        try {
            const updated = setTranscriptTurnRating(tab.transcript.conversationId, messageId, rating);
            if (!updated) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ok: false, error: 'message_not_found' }));
            }
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ ok: true }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: error?.message || 'feedback_failed' }));
        }
    }

    if (pathname.startsWith('/assets/')) {
        const rel = pathname.substring('/assets/'.length);
        const assetPath = staticSrv.resolveAssetPath(appName, fallbackAppPath, rel);
        if (assetPath && staticSrv.sendFile(res, assetPath)) return;
    }

    if (req.user) {
        ensureAppSession(req, res, appState);
    }

    if (!authorized(req)) {
        return redirectToRouterLogin(req, res, parsedUrl, agentOverride);
    }

    if (pathname === '/suggestions/files' && (req.method === 'GET' || req.method === 'HEAD')) {
        return handleSuggestionsFiles(req, res, parsedUrl, appState);
    }

    if (pathname === '/uploads') {
        const sessionId = getSession(req, appState);
        const workspaceBase = resolveWebchatWorkspaceBase(parsedUrl);
        const uploadContext = resolveWebchatUploadContext({ workspaceBase, sessionId });
        if (req.method === 'POST' || req.method === 'PUT') {
            return handleWebchatUploadPost(req, res, parsedUrl, uploadContext);
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
            return handleWebchatUploadGet(req, res, parsedUrl, uploadContext);
        }
        res.writeHead(405, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            Allow: 'GET, HEAD, POST, PUT',
        });
        return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    }

    if (pathname === '/' || pathname === '/index.html') {
        const workspaceBase = resolveWebchatWorkspaceBase(parsedUrl);
        const html = renderTemplate(['chat.html', 'index.html'], {
            '__ASSET_BASE__': `/${appName}/assets`,
            '__AGENT_NAME__': effectiveConfig.agentName || '',
            '__DISPLAY_NAME__': effectiveConfig.displayName || effectiveConfig.agentName || 'WebChat',
            '__RUNTIME__': effectiveConfig.runtime || 'local',
            '__REQUIRES_AUTH__': 'true',
            '__BASE_PATH__': `/${appName}`,
            '__AGENT_QUERY__': agentQuery,
            '__WORKDIR__': workspaceBase.base
        });
        if (html) {
            res.writeHead(200, {
                'Content-Type': 'text/html',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            return res.end(html);
        }
    }

    if (pathname === '/stream') {
        const sid = getSession(req, appState);
        const session = appState.sessions.get(sid);
        const tabId = parsedUrl.searchParams.get('tabId');
        if (!session || !tabId) { res.writeHead(400); return res.end(); }

        // CRITICAL FIX: Global limit across ALL sessions to prevent system-wide overload
        const MAX_GLOBAL_TTYS = 20;
        let globalTabCount = 0;
        for (const sess of appState.sessions.values()) {
            if (sess.tabs instanceof Map) {
                globalTabCount += sess.tabs.size;
            }
        }

        if (globalTabCount >= MAX_GLOBAL_TTYS) {
            res.writeHead(503, {
                'Content-Type': 'text/plain',
                'Retry-After': '30'
            });
            res.end('Server at capacity. Please try again later.');
            return;
        }

        // CRITICAL FIX: Limit concurrent connections per session to prevent process spawn leak
        const MAX_CONCURRENT_TTYS = 3;
        if (session.tabs.size >= MAX_CONCURRENT_TTYS) {
            res.writeHead(429, {
                'Content-Type': 'text/plain',
                'Retry-After': '5'
            });
            res.end('Too many concurrent connections. Please close other tabs or wait.');
            return;
        }

        let tab = session.tabs.get(tabId);

        // CRITICAL FIX: Debounce rapid reconnections to prevent connection storms
        const now = Date.now();
        const MIN_RECONNECT_INTERVAL_MS = 1000; // 1 second

        if (tab && tab.lastConnectTime && (now - tab.lastConnectTime) < MIN_RECONNECT_INTERVAL_MS) {
            res.writeHead(429, {
                'Content-Type': 'text/plain',
                'Retry-After': '1'
            });
            res.end('Reconnecting too fast. Please wait.');
            return;
        }

        if (!tab && !effectiveConfig.ttyFactory) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end(effectiveConfig.unavailableReason || 'WebChat is not available for this agent.');
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache',
            'x-accel-buffering': 'no',
            'alt-svc': 'clear'  // Force HTTP/2, disable HTTP/3 to prevent QUIC errors
        });
        res.write(': connected\n\n');

        const KEEPALIVE_INTERVAL_MS = 15000;
        let keepaliveTimer = null;

        const startKeepalive = () => {
            if (keepaliveTimer || !Number.isFinite(KEEPALIVE_INTERVAL_MS) || KEEPALIVE_INTERVAL_MS <= 0) {
                return;
            }
            keepaliveTimer = setInterval(() => {
                try {
                    res.write(': keepalive\n\n');
                } catch (_) {
                    clearInterval(keepaliveTimer);
                    keepaliveTimer = null;
                }
            }, KEEPALIVE_INTERVAL_MS);
            keepaliveTimer.unref?.();
        };

        startKeepalive();

        if (!tab) {
            try {
                // Extract SSO user context if available
                const ssoUser = req.user && req.authMode === 'sso' ? {
                    id: req.user.id,
                    username: req.user.username,
                    email: req.user.email,
                    roles: req.user.roles || [],
                    sessionId: req.sessionId || null
                } : null;

                let transcript = null;
                try {
                    const transcriptContext = buildTranscriptContext(req, appState, tabId);
                    const createdTranscript = createTranscriptConversation({
                        agentName: effectiveConfig.agentName || effectiveConfig.displayName || 'webchat',
                        runtime: effectiveConfig.runtime || 'local',
                        authMode: transcriptContext.authMode,
                        sessionId: transcriptContext.sessionId,
                        userId: transcriptContext.userId,
                        tabId: transcriptContext.tabId
                    });
                    transcript = {
                        conversationId: createdTranscript.conversationId,
                        buffer: '',
                        lastClientText: '',
                        userInputSent: false,
                        lastAssistantMessageId: null,
                        lastUserMessageId: null,
                        currentTurnId: null
                    };
                } catch (_) {
                    transcript = null;
                }

                const tty = effectiveConfig.ttyFactory.create(ssoUser);
                tab = {
                    tty,
                    sseRes: res,
                    lastConnectTime: now,
                    createdAt: now,
                    pid: tty.pid || null,
                    cleanupTimer: null,
                    pendingSseEvents: [],
                    ttyClosed: false,
                    transcript
                };
                session.tabs.set(tabId, tab);

                tty.onOutput((data) => {
                    const transcriptEvents = captureTranscriptOutput(tab, data);
                    writeOrBufferSseEvent(tab, `data: ${JSON.stringify(data)}\n\n`);
                    for (const meta of transcriptEvents) {
                        writeOrBufferSseEvent(tab, 'event: message-meta\n');
                        writeOrBufferSseEvent(tab, `data: ${JSON.stringify(meta)}\n\n`);
                    }
                });
                tty.onClose(() => {
                    writeOrBufferSseEvent(tab, 'event: close\n');
                    writeOrBufferSseEvent(tab, 'data: {}\n\n');
                    // Clear force kill timer since process closed normally
                    if (tab.cleanupTimer) {
                        clearTimeout(tab.cleanupTimer);
                        tab.cleanupTimer = null;
                    }
                    tab.ttyClosed = true;
                    tab.tty = null;
                    if (tab.sseRes) {
                        // Ensure tab resources are fully released so the next reconnect
                        // creates a fresh TTY session instead of writing into a dead process.
                        disposeTab(tab, tabId, session);
                    } else {
                        scheduleDisconnectedTabCleanup(tab, tabId, session);
                    }
                });

            } catch (e) {
                console.error(`[webchat] Failed to create chat session: ${e?.message || e}`);
                if (!res.headersSent) {
                    res.writeHead(500);
                }
                try { res.end('Failed to create chat session: ' + (e?.message || e)); } catch (_) { }
                return;
            }
        } else {
            // Reusing existing tab
            if (tab.cleanupTimer) {
                clearTimeout(tab.cleanupTimer);
                tab.cleanupTimer = null;
            }
            tab.sseRes = res;
            tab.lastConnectTime = now;
            flushPendingSseEvents(tab);
            if (tab.ttyClosed) {
                disposeTab(tab, tabId, session);
                return;
            }
        }

        req.on('close', () => {
            const pid = tab.pid || tab.tty?.pid;
            console.log(`[webchat] Connection closed for tab ${tabId}, tty pid=${pid}`);

            if (keepaliveTimer) {
                clearInterval(keepaliveTimer);
                keepaliveTimer = null;
            }
            if (tab.sseRes === res || !tab.sseRes) {
                tab.sseRes = null;
                scheduleDisconnectedTabCleanup(tab, tabId, session);
            }
        });
        return;
    }

    if (pathname === '/input' && req.method === 'POST') {
        const sid = getSession(req, appState);
        const session = appState.sessions.get(sid);
        const tabId = parsedUrl.searchParams.get('tabId');
        const tab = session && session.tabs.get(tabId);
        if (!tab) { res.writeHead(400); return res.end(); }
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            let envelope;
            try {
                envelope = parseInputEnvelope(body);
                const hasReferences = Array.isArray(envelope.references) && envelope.references.length > 0;
                if (tab.transcript && (
                    String(envelope.text || '').trim()
                    || (Array.isArray(envelope.attachments) && envelope.attachments.length)
                    || hasReferences
                )) {
                    const turnId = crypto.randomUUID();
                    const created = appendTranscriptMessage(tab.transcript.conversationId, {
                        role: 'user',
                        text: envelope.text,
                        attachments: envelope.attachments,
                        metadata: {
                            turnId,
                            references: hasReferences ? envelope.references : undefined
                        }
                    });
                    tab.transcript.lastClientText = String(envelope.text || '');
                    tab.transcript.userInputSent = true;
                    tab.transcript.lastAssistantMessageId = null;
                    tab.transcript.lastUserMessageId = created.messageId;
                    tab.transcript.currentTurnId = turnId;
                }
            } catch (_) {
                // Ignore transcript capture errors.
            }
            const text = shouldForwardWebchatEnvelope(parsedUrl, effectiveConfig)
                ? serializeWebchatEnvelopeForAgent({
                    req,
                    effectiveConfig,
                    tabId,
                    envelope: envelope || { text: body, attachments: [] },
                    fallbackText: body
                })
                : ((envelope && typeof envelope.text === 'string') ? envelope.text : body);
            tab.tty.write(`${text}\n`);
            res.writeHead(204); res.end();
        });
        return;
    }

    if (pathname === '/control' && req.method === 'POST') {
        const sid = getSession(req, appState);
        const session = appState.sessions.get(sid);
        const tabId = parsedUrl.searchParams.get('tabId');
        const tab = session && session.tabs.get(tabId);
        if (!tab) { res.writeHead(400); return res.end(); }
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                tab.tty.write(body);
            } catch (_) { }
            res.writeHead(204); res.end();
        });
        return;
    }

    res.writeHead(404); res.end(', Not Found in App');
}

export {
    handleWebChat,
    resolveWebchatLaunchOptions,
    resolveRequestPublicOrigin,
    serializeWebchatEnvelopeForAgent,
    shouldForwardWebchatEnvelope,
    resolveWorkspaceScopedQueryPath,
    sanitizeWebchatReferencesForEnvelope,
    parseInputEnvelope
};
