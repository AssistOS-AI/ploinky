import fs from 'fs';
import path from 'path';
import { setImmediate } from 'node:timers/promises';

import { readJsonBody } from '../common.js';
import { sortWorkspaceEntriesAsync } from '../../utils/workspacePaths.js';
import {
    resolveWorkspaceDirectory,
    sanitizeUploadDirectoryPath,
} from '../../webchat/uploadPaths.js';

const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

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

export async function listWorkspaceDirectory(context, relativePath = '') {
    const directory = resolveWorkspaceDirectory({
        cwd: context?.cwd,
        workspaceRoot: context?.workspaceRoot,
        relativePath,
    });
    if (!directory) return null;
    const entries = [];
    const directoryEntries = await fs.promises.readdir(directory.absolutePath, { withFileTypes: true });
    for (let index = 0; index < directoryEntries.length; index += 1) {
        if (index > 0 && index % 128 === 0) await setImmediate();
        const entry = directoryEntries[index];
        const entryPath = directory.relativePath
            ? `${directory.relativePath}/${entry.name}`
            : entry.name;
        const safePath = sanitizeUploadDirectoryPath(entryPath);
        if (safePath === null) continue;
        if (entry.isSymbolicLink()) continue;
        if (!entry.isDirectory() && !entry.isFile()) continue;
        entries.push({
            name: entry.name,
            path: safePath,
            kind: entry.isDirectory() ? 'folder' : 'file',
        });
    }
    const sortedEntries = await sortWorkspaceEntriesAsync(entries, (left, right) => {
        if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
        return collator.compare(left.name, right.name);
    });
    return {
        path: directory.relativePath,
        parentPath: directoryParent(directory.relativePath),
        entries: sortedEntries,
    };
}

export async function handleWorkspaceDirectoriesGet(req, res, parsedUrl, context) {
    if (!context) return writeJson(res, 400, { ok: false, error: 'invalid_workspace' });
    const requestedPath = parsedUrl?.searchParams?.get('path') || '';
    const listing = await listWorkspaceDirectory(context, requestedPath);
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
        await fs.promises.mkdir(target.absolutePath);
    } catch (error) {
        if (error?.code === 'EEXIST') {
            return writeJson(res, 409, { ok: false, error: 'directory_exists' });
        }
        return writeJson(res, 500, { ok: false, error: 'mkdir_failed' });
    }
    return writeJson(res, 201, { ok: true, path: target.relativePath });
}
