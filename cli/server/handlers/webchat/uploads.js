import fs from 'fs';
import path from 'path';

import {
    buildCwdRelativePath,
    buildSessionRelativePath,
    buildSessionUploadMetadataRoot,
    buildSessionUploadRoot,
    buildWorkspaceRelativePath,
    ensureSessionUploadRoot,
    normalizeWebchatSessionId,
    resolveNonCollidingTarget,
    resolveUploadTarget,
    sanitizeUploadRelativePath,
} from '../../webchat/uploadPaths.js';

const APP_NAME = 'webchat';
const ROUTER_RESERVED_QUERY_KEYS = new Set([
    'tabId',
    'path',
    'forward-envelope',
    'forwardEnvelope',
]);

function readHeader(req, name) {
    const target = String(name || '').toLowerCase();
    if (!target || !req?.headers) return '';
    const direct = req.headers[target];
    if (direct) return Array.isArray(direct) ? direct[0] : direct;
    for (const [key, value] of Object.entries(req.headers)) {
        if (String(key).toLowerCase() === target) {
            return Array.isArray(value) ? value[0] : value;
        }
    }
    return '';
}

function decodeOptionalHeader(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        return decodeURIComponent(raw);
    } catch (_) {
        return raw;
    }
}

function buildDownloadUrl(parsedUrl, sessionRelativePath) {
    const params = new URLSearchParams();
    if (parsedUrl?.searchParams) {
        for (const [key, value] of parsedUrl.searchParams.entries()) {
            if (ROUTER_RESERVED_QUERY_KEYS.has(key)) continue;
            params.append(key, value);
        }
    }
    params.set('path', sessionRelativePath);
    return `/${APP_NAME}/uploads?${params.toString()}`;
}

function normalizeMimeType(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.length > 255 || /[\r\n\0]/.test(raw)) {
        return 'application/octet-stream';
    }
    return raw;
}

function isRelativeInside(relativePath) {
    return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function isRealPathInsideRoot(rootPath, candidatePath) {
    try {
        const realRoot = fs.realpathSync(rootPath);
        const realCandidate = fs.realpathSync(candidatePath);
        const relative = path.relative(realRoot, realCandidate);
        return relative === '' || isRelativeInside(relative);
    } catch (_) {
        return false;
    }
}

function resolveUploadMetadataPath(context, sessionRelativePath) {
    if (!context?.cwd || !context?.sessionId) return null;
    const safeRelative = sanitizeUploadRelativePath(sessionRelativePath, '');
    if (!safeRelative) return null;
    const metadataRoot = buildSessionUploadMetadataRoot(context.cwd, context.sessionId);
    if (!metadataRoot) return null;
    const metadataLeaf = `${Buffer.from(safeRelative, 'utf8').toString('base64url')}.json`;
    const metadataPath = path.resolve(metadataRoot, metadataLeaf);
    const relative = path.relative(metadataRoot, metadataPath);
    if (!isRelativeInside(relative)) return null;
    return { metadataRoot, metadataPath };
}

function writeUploadMetadata(context, sessionRelativePath, metadata) {
    const target = resolveUploadMetadataPath(context, sessionRelativePath);
    if (!target) return false;
    try {
        fs.mkdirSync(target.metadataRoot, { recursive: true });
        if (!isRealPathInsideRoot(context.cwd, target.metadataRoot)) return false;
        fs.writeFileSync(target.metadataPath, `${JSON.stringify(metadata)}\n`, { encoding: 'utf8', flag: 'wx' });
        return true;
    } catch (_) {
        return false;
    }
}

function readUploadMetadata(context, sessionRelativePath) {
    const target = resolveUploadMetadataPath(context, sessionRelativePath);
    if (!target) return null;
    try {
        if (!isRealPathInsideRoot(context.cwd, target.metadataRoot)) return null;
        const raw = fs.readFileSync(target.metadataPath, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
        return null;
    }
}

function writeJson(res, status, payload) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(payload));
}

export function resolveWebchatUploadContext({ workspaceBase, sessionId }) {
    if (!workspaceBase || !workspaceBase.root || !workspaceBase.base) {
        return null;
    }
    const safeSession = normalizeWebchatSessionId(sessionId);
    if (!safeSession) return null;
    const uploadRoot = buildSessionUploadRoot(workspaceBase.base, safeSession);
    if (!uploadRoot) return null;
    return {
        workspaceRoot: workspaceBase.root,
        cwd: workspaceBase.base,
        sessionId: safeSession,
        uploadRoot,
    };
}

export function handleWebchatUploadPost(req, res, parsedUrl, context) {
    if (!context) {
        return writeJson(res, 400, { ok: false, error: 'invalid_session' });
    }
    const filenameHeader = decodeOptionalHeader(readHeader(req, 'x-file-name'));
    const relativeHeader = decodeOptionalHeader(readHeader(req, 'x-relative-path'));
    const mimeHeader = normalizeMimeType(readHeader(req, 'x-mime-type') || readHeader(req, 'content-type'));
    const fallbackName = filenameHeader || (relativeHeader ? path.basename(relativeHeader) : '');

    const sanitizedRelative = sanitizeUploadRelativePath(relativeHeader, fallbackName)
        || sanitizeUploadRelativePath(filenameHeader, '');

    if (!sanitizedRelative) {
        return writeJson(res, 400, { ok: false, error: 'invalid_relative_path' });
    }

    if (!ensureSessionUploadRoot(context.uploadRoot)) {
        return writeJson(res, 500, { ok: false, error: 'upload_root_unavailable' });
    }

    const target = resolveNonCollidingTarget({
        uploadRoot: context.uploadRoot,
        workspaceRoot: context.workspaceRoot,
        relativePath: sanitizedRelative,
    });
    if (!target) {
        return writeJson(res, 400, { ok: false, error: 'invalid_target' });
    }

    try {
        fs.mkdirSync(path.dirname(target.absolutePath), { recursive: true });
    } catch (_) {
        return writeJson(res, 500, { ok: false, error: 'mkdir_failed' });
    }

    let size = 0;
    let aborted = false;
    const out = fs.createWriteStream(target.absolutePath);
    req.on('data', (chunk) => {
        size += chunk.length;
    });
    req.on('aborted', () => {
        aborted = true;
        try { out.destroy(); } catch (_) { /* ignore */ }
        try { fs.unlinkSync(target.absolutePath); } catch (_) { /* ignore */ }
    });
    req.pipe(out);
    out.on('error', () => {
        try { fs.unlinkSync(target.absolutePath); } catch (_) { /* ignore */ }
        if (!res.headersSent) {
            writeJson(res, 500, { ok: false, error: 'write_failed' });
        }
    });
    out.on('finish', () => {
        if (aborted) return;
        const sessionRelative = buildSessionRelativePath(context.uploadRoot, target.absolutePath);
        const workspaceRelative = buildWorkspaceRelativePath(context.workspaceRoot, target.absolutePath);
        const cwdRelative = buildCwdRelativePath(context.cwd, target.absolutePath);
        const filename = path.basename(target.absolutePath);
        const mime = mimeHeader;
        writeUploadMetadata(context, sessionRelative, {
            filename,
            relativePath: sessionRelative,
            localPath: cwdRelative,
            workspacePath: workspaceRelative,
            size,
            mime,
            uploadedAt: new Date().toISOString(),
        });
        writeJson(res, 201, {
            ok: true,
            filename,
            relativePath: sessionRelative,
            localPath: cwdRelative,
            workspacePath: workspaceRelative,
            downloadUrl: buildDownloadUrl(parsedUrl, sessionRelative),
            size,
            mime,
        });
    });
}

function streamFile(req, res, absolutePath, mime, isHead) {
    let stat;
    try {
        stat = fs.statSync(absolutePath);
    } catch (_) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not Found');
    }
    const size = stat.size;
    const range = req.headers['range'];
    if (range && /^bytes=/.test(range)) {
        const m = range.match(/bytes=(\d+)-(\d+)?/);
        if (m) {
            const start = parseInt(m[1], 10);
            const end = m[2] ? parseInt(m[2], 10) : size - 1;
            if (start <= end && start < size) {
                res.writeHead(206, {
                    'Content-Type': mime,
                    'Content-Length': (end - start + 1),
                    'Content-Range': `bytes ${start}-${end}/${size}`,
                    'Accept-Ranges': 'bytes',
                    'X-Content-Type-Options': 'nosniff',
                    'Cache-Control': 'no-store',
                });
                if (isHead) return res.end();
                return fs.createReadStream(absolutePath, { start, end }).pipe(res);
            }
        }
    }
    res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': size,
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
    });
    if (isHead) return res.end();
    return fs.createReadStream(absolutePath).pipe(res);
}

export function handleWebchatUploadGet(req, res, parsedUrl, context) {
    if (!context) {
        return writeJson(res, 400, { ok: false, error: 'invalid_session' });
    }
    const rawPath = parsedUrl?.searchParams?.get('path') || '';
    if (!rawPath) {
        return writeJson(res, 400, { ok: false, error: 'missing_path' });
    }
    const sanitized = sanitizeUploadRelativePath(rawPath, '');
    if (!sanitized) {
        return writeJson(res, 400, { ok: false, error: 'invalid_path' });
    }
    if (!ensureSessionUploadRoot(context.uploadRoot)) {
        return writeJson(res, 500, { ok: false, error: 'upload_root_unavailable' });
    }
    const target = resolveUploadTarget({
        uploadRoot: context.uploadRoot,
        workspaceRoot: context.workspaceRoot,
        relativePath: sanitized,
        allowMissingLeaf: false,
    });
    if (!target) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not Found');
    }
    let stat;
    try {
        stat = fs.statSync(target.absolutePath);
    } catch (_) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not Found');
    }
    if (!stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not Found');
    }
    const metadata = readUploadMetadata(context, target.relativePath);
    const mime = normalizeMimeType(metadata?.mime);
    return streamFile(req, res, target.absolutePath, mime, req.method === 'HEAD');
}
