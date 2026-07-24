import fs from 'fs';
import path from 'path';

import { readJsonBody } from '../common.js';
import {
    resolveWorkspaceDirectory,
    sanitizeUploadDirectoryPath,
} from '../../webchat/uploadPaths.js';

function writeJson(res, status, payload) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(payload));
}

function directoryParent(relativePath) {
    if (!relativePath) return null;
    const parent = path.posix.dirname(relativePath);
    return parent === '.' ? '' : parent;
}

export function listWorkspaceDirectory(context, relativePath = '') {
    const directory = resolveWorkspaceDirectory({
        cwd: context?.cwd,
        workspaceRoot: context?.workspaceRoot,
        relativePath,
    });
    if (!directory) return null;
    const entries = [];
    for (const entry of fs.readdirSync(directory.absolutePath, { withFileTypes: true })) {
        const entryPath = directory.relativePath
            ? `${directory.relativePath}/${entry.name}`
            : entry.name;
        const safePath = sanitizeUploadDirectoryPath(entryPath);
        if (safePath === null) continue;
        const absolute = path.join(directory.absolutePath, entry.name);
        let stat;
        try {
            stat = fs.lstatSync(absolute);
        } catch (_) {
            continue;
        }
        if (stat.isSymbolicLink()) continue;
        if (!stat.isDirectory() && !stat.isFile()) continue;
        entries.push({
            name: entry.name,
            path: safePath,
            kind: stat.isDirectory() ? 'folder' : 'file',
        });
    }
    entries.sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    });
    return {
        path: directory.relativePath,
        parentPath: directoryParent(directory.relativePath),
        entries,
    };
}

export function handleWorkspaceDirectoriesGet(req, res, parsedUrl, context) {
    if (!context) return writeJson(res, 400, { ok: false, error: 'invalid_workspace' });
    const requestedPath = parsedUrl?.searchParams?.get('path') || '';
    const listing = listWorkspaceDirectory(context, requestedPath);
    if (!listing) return writeJson(res, 400, { ok: false, error: 'invalid_directory' });
    return writeJson(res, 200, { ok: true, ...listing });
}

export async function handleWorkspaceDirectoriesPost(req, res, context) {
    if (!context) return writeJson(res, 400, { ok: false, error: 'invalid_workspace' });
    let body;
    try {
        body = await readJsonBody(req);
    } catch (_) {
        return writeJson(res, 400, { ok: false, error: 'invalid_json' });
    }
    const safePath = sanitizeUploadDirectoryPath(body?.path);
    if (!safePath) return writeJson(res, 400, { ok: false, error: 'invalid_directory' });
    const target = resolveWorkspaceDirectory({
        cwd: context.cwd,
        workspaceRoot: context.workspaceRoot,
        relativePath: safePath,
        allowMissing: true,
    });
    if (!target) return writeJson(res, 400, { ok: false, error: 'invalid_directory' });
    const parentRelative = path.posix.dirname(target.relativePath);
    const parent = resolveWorkspaceDirectory({
        cwd: context.cwd,
        workspaceRoot: context.workspaceRoot,
        relativePath: parentRelative === '.' ? '' : parentRelative,
    });
    if (!parent) return writeJson(res, 400, { ok: false, error: 'invalid_parent' });
    try {
        fs.mkdirSync(target.absolutePath);
    } catch (error) {
        if (error?.code === 'EEXIST') {
            return writeJson(res, 409, { ok: false, error: 'directory_exists' });
        }
        return writeJson(res, 500, { ok: false, error: 'mkdir_failed' });
    }
    return writeJson(res, 201, { ok: true, path: target.relativePath });
}
