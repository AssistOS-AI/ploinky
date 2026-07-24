import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import {
    buildWorkspaceFileUrl,
    resolveUploadTarget,
    sanitizeUploadRelativePath,
} from '../../webchat/uploadPaths.js';

function readHeader(req, name) {
    const target = String(name || '').toLowerCase();
    const direct = req?.headers?.[target];
    if (direct) return Array.isArray(direct) ? direct[0] : direct;
    for (const [key, value] of Object.entries(req?.headers || {})) {
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

function normalizeMimeType(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.length > 255 || /[\r\n\0]/.test(raw)) {
        return 'application/octet-stream';
    }
    return raw;
}

function allowsOverwrite(value) {
    return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function writeJson(res, status, payload) {
    if (res.headersSent) return;
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(payload));
}

export function resolveWebchatUploadContext({ workspaceBase } = {}) {
    if (!workspaceBase?.root || !workspaceBase?.base) return null;
    return {
        workspaceRoot: workspaceBase.root,
        cwd: workspaceBase.base,
    };
}

function inspectExistingTarget(targetPath) {
    try {
        const stat = fs.lstatSync(targetPath);
        if (stat.isSymbolicLink()) return { error: 'invalid_target' };
        if (!stat.isFile()) return { error: 'target_type_conflict' };
        return { exists: true };
    } catch (error) {
        if (error?.code === 'ENOENT') return { exists: false };
        return { error: 'target_unavailable' };
    }
}

function commitTemporaryFile(tempPath, targetPath, overwrite) {
    if (overwrite) {
        fs.renameSync(tempPath, targetPath);
        return;
    }
    fs.linkSync(tempPath, targetPath);
    fs.unlinkSync(tempPath);
}

export function handleWebchatUploadPost(req, res, parsedUrl, context) {
    if (!context) return writeJson(res, 400, { ok: false, error: 'invalid_workspace' });

    const filenameHeader = decodeOptionalHeader(readHeader(req, 'x-file-name'));
    const relativeHeader = decodeOptionalHeader(readHeader(req, 'x-relative-path'));
    const destinationHeader = decodeOptionalHeader(readHeader(req, 'x-destination-path'));
    const mime = normalizeMimeType(readHeader(req, 'x-mime-type') || readHeader(req, 'content-type'));
    const overwrite = allowsOverwrite(readHeader(req, 'x-overwrite'));
    const relativePath = sanitizeUploadRelativePath(relativeHeader, filenameHeader);
    if (!relativePath) {
        return writeJson(res, 400, { ok: false, error: 'invalid_relative_path' });
    }

    let target = resolveUploadTarget({
        cwd: context.cwd,
        workspaceRoot: context.workspaceRoot,
        destinationPath: destinationHeader,
        relativePath,
    });
    if (!target) return writeJson(res, 400, { ok: false, error: 'invalid_target' });

    const initialTarget = inspectExistingTarget(target.absolutePath);
    if (initialTarget.error) return writeJson(res, 409, { ok: false, error: initialTarget.error });
    if (initialTarget.exists && !overwrite) {
        return writeJson(res, 409, { ok: false, error: 'target_exists', localPath: target.relativePath });
    }

    try {
        fs.mkdirSync(path.dirname(target.absolutePath), { recursive: true });
    } catch (_) {
        return writeJson(res, 500, { ok: false, error: 'mkdir_failed' });
    }

    target = resolveUploadTarget({
        cwd: context.cwd,
        workspaceRoot: context.workspaceRoot,
        destinationPath: destinationHeader,
        relativePath,
    });
    if (!target) return writeJson(res, 400, { ok: false, error: 'invalid_target' });

    const tempName = `.${path.basename(target.absolutePath)}.webchat-upload-${process.pid}-${randomUUID()}.tmp`;
    const tempPath = path.join(path.dirname(target.absolutePath), tempName);
    let size = 0;
    let settled = false;
    let writeFinished = false;
    let out = null;
    const cleanupTemp = () => {
        try { fs.unlinkSync(tempPath); } catch (_) { /* no temporary file */ }
    };
    const fail = (status, error) => {
        if (settled) return;
        settled = true;
        try { out?.destroy(); } catch (_) { /* ignore */ }
        cleanupTemp();
        writeJson(res, status, { ok: false, error });
    };

    try {
        out = fs.createWriteStream(tempPath, { flags: 'wx' });
    } catch (_) {
        return writeJson(res, 500, { ok: false, error: 'write_failed' });
    }

    req.on('data', (chunk) => {
        size += chunk.length;
    });
    req.once('aborted', () => {
        if (settled) return;
        settled = true;
        try { out.destroy(); } catch (_) { /* ignore */ }
        cleanupTemp();
    });
    req.once('error', () => fail(500, 'read_failed'));
    out.once('error', () => fail(500, 'write_failed'));
    out.once('finish', () => {
        writeFinished = true;
    });
    out.once('close', () => {
        if (settled) {
            cleanupTemp();
            return;
        }
        if (!writeFinished) return fail(500, 'write_failed');
        try {
            const latest = inspectExistingTarget(target.absolutePath);
            if (latest.error) return fail(409, latest.error);
            if (latest.exists && !overwrite) return fail(409, 'target_exists');
            commitTemporaryFile(tempPath, target.absolutePath, overwrite);
        } catch (error) {
            if (!overwrite && error?.code === 'EEXIST') return fail(409, 'target_exists');
            return fail(500, 'commit_failed');
        }

        settled = true;
        const filename = path.basename(target.absolutePath);
        writeJson(res, 201, {
            ok: true,
            filename,
            relativePath: target.relativePath,
            localPath: target.relativePath,
            workspacePath: target.workspacePath,
            downloadUrl: buildWorkspaceFileUrl(target.workspacePath),
            size,
            mime,
        });
    });
    req.pipe(out);
}

export const __testables = {
    allowsOverwrite,
    commitTemporaryFile,
    inspectExistingTarget,
};
