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

function publicUploadError(code) {
    return code === 'upload_target_exists' ? 'target_exists' : code;
}

export function handleWebchatUploadPost(req, res, parsedUrl, context, { policy, timers } = {}) {
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
        return writeJson(res, 409, {
            ok: false,
            error: 'target_exists',
            localPath: target.relativePath,
        });
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

    const latestTarget = inspectExistingTarget(target.absolutePath);
    if (latestTarget.error) return writeJson(res, 409, { ok: false, error: latestTarget.error });
    if (latestTarget.exists && !overwrite) {
        return writeJson(res, 409, {
            ok: false,
            error: 'target_exists',
            localPath: target.relativePath,
        });
    }

    let responseDetails = null;
    return streamAdmittedUpload(req, {
        storageRoot: context.uploadRoot || context.cwd,
        targetPath: target.absolutePath,
        policy: policy || UPLOAD_ROUTE_POLICIES.webchat,
        timers,
        replaceExisting: overwrite,
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
