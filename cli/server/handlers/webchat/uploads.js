import fs from 'fs';
import path from 'path';

import {
    buildWorkspaceFileUrl,
    resolveUploadTarget,
    sanitizeUploadRelativePath,
} from '../../webchat/uploadPaths.js';
import {
    streamAdmittedUpload,
    UPLOAD_ROUTE_POLICIES,
    UploadAdmissionError,
} from '../uploadAdmission.js';

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
        uploadRoot: workspaceBase.base,
    };
}

async function inspectExistingTarget(targetPath) {
    try {
        const stat = await fs.promises.lstat(targetPath);
        if (stat.isSymbolicLink()) return { error: 'invalid_target' };
        if (!stat.isFile()) return { error: 'target_type_conflict' };
        return { exists: true };
    } catch (error) {
        if (error?.code === 'ENOENT') return { exists: false };
        return { error: 'target_unavailable' };
    }
}

function publicUploadError(code) {
    return code === 'upload_target_exists' ? 'target_exists' : code;
}

function isAdmissibleWorkspaceEntry({ relativePath } = {}) {
    return sanitizeUploadRelativePath(relativePath, '') !== null;
}

export async function handleWebchatUploadPost(req, res, parsedUrl, context, { policy, timers } = {}) {
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

    let responseDetails = null;
    return await streamAdmittedUpload(req, {
        res,
        prepare: async check => {
            const inspect = async () => {
                const existing = await inspectExistingTarget(target.absolutePath);
                check();
                if (existing.error) throw new UploadAdmissionError(409, existing.error);
                if (existing.exists && !overwrite) throw new UploadAdmissionError(409, 'target_exists');
            };
            await inspect();
            check();
            try {
                await fs.promises.mkdir(path.dirname(target.absolutePath), { recursive: true });
            } catch (_) {
                check();
                throw new UploadAdmissionError(500, 'mkdir_failed');
            }
            check();
            target = resolveUploadTarget({
                cwd: context.cwd,
                workspaceRoot: context.workspaceRoot,
                destinationPath: destinationHeader,
                relativePath,
            });
            if (!target) throw new UploadAdmissionError(400, 'invalid_target');
            await inspect();
            check();
            return { targetPath: target.absolutePath };
        },
        storageRoot: context.uploadRoot || context.cwd,
        targetPath: target.absolutePath,
        policy: policy || UPLOAD_ROUTE_POLICIES.webchat,
        timers,
        replaceExisting: overwrite,
        includeEntry: isAdmissibleWorkspaceEntry,
        includeDirectory: isAdmissibleWorkspaceEntry,
        finalize: ({ size }) => {
            responseDetails = {
                filename: path.basename(target.absolutePath),
                relativePath: target.relativePath,
                localPath: target.relativePath,
                workspacePath: target.workspacePath,
                downloadUrl: buildWorkspaceFileUrl(target.workspacePath),
                size,
                mime,
            };
        },
        onSuccess: () => {
            writeJson(res, 201, {
                ok: true,
                ...responseDetails,
            });
        },
        onFailure: error => {
            if (!res.headersSent) {
                writeJson(res, error.status || 500, {
                    ok: false,
                    error: publicUploadError(error.code || 'upload_failed'),
                    ...(error.code === 'target_exists' ? { localPath: target.relativePath } : {}),
                });
            }
        },
    });
}

export const __testables = {
    allowsOverwrite,
    inspectExistingTarget,
    publicUploadError,
};
