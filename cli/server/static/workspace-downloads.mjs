import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createZipStream } from './zip-stream.mjs';

function within(root, candidate) {
    return candidate === root || candidate.startsWith(root + path.sep);
}

// Agent-private data and runtime metadata must not become downloadable through
// an ancestor folder. Managed repository source is the explicit .ploinky exception.
export function isPrivateDownloadPath(relativePath) {
    const parts = relativePath.split(/[\\/]/).filter(Boolean);
    return parts.some(part => part === '.data' || part === '.secrets' || part.endsWith('.secrets'))
        || parts.some((part, index) => part === '.ploinky' && parts[index + 1] !== 'repos');
}

function denied() {
    return Object.assign(new Error('Access denied'), { statusCode: 403 });
}

async function inspect(root, candidate) {
    if (!within(root, candidate) || isPrivateDownloadPath(path.relative(root, candidate))) throw denied();
    const real = await fs.promises.realpath(candidate);
    if (!within(root, real) || isPrivateDownloadPath(path.relative(root, real))) throw denied();
    const stat = await fs.promises.lstat(real);
    if (!stat.isFile() && !stat.isDirectory()) throw denied();
    return { real, stat };
}

async function verifyEntry(root, entry) {
    const current = await inspect(root, entry.real);
    if (current.real !== entry.real || current.stat.dev !== entry.stat.dev || current.stat.ino !== entry.stat.ino) throw denied();
}

async function openEntry(root, entry) {
    await verifyEntry(root, entry);
    const handle = await fs.promises.open(entry.real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        await verifyEntry(root, entry);
        if (!stat.isFile() || stat.dev !== entry.stat.dev || stat.ino !== entry.stat.ino) throw denied();
        return handle;
    } catch (error) {
        await handle.close();
        throw error;
    }
}

async function* folderEntries(root, entry, name) {
    await verifyEntry(root, entry);
    yield { name: name + '/', stat: entry.stat, directory: true };
    const directory = await fs.promises.opendir(entry.real);
    try {
        for await (const child of directory) {
            // Never follow recursive symlinks, special devices or private paths.
            if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) continue;
            const candidate = path.join(entry.real, child.name);
            if (isPrivateDownloadPath(path.relative(root, candidate))) continue;
            const childEntry = await inspect(root, candidate);
            if (childEntry.real !== candidate) throw denied();
            const childName = name + '/' + child.name;
            if (childEntry.stat.isDirectory()) {
                yield* folderEntries(root, childEntry, childName);
            } else {
                yield { name: childName, stat: childEntry.stat, directory: false, open: () => openEntry(root, childEntry) };
            }
        }
    } finally {
        await directory.close().catch(error => {
            if (error.code !== 'ERR_DIR_CLOSED') throw error;
        });
    }
}

export function attachmentHeader(name) {
    const safe = name.replace(/[\x00-\x1f\x7f/\\]/g, '_');
    const fallback = safe.replace(/[^\x20-\x7e]|["\\]/g, '_');
    const encoded = encodeURIComponent(safe).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// Called only after the Router's existing workspace-assets authorization gate.
export async function serveWorkspaceDownload(req, res, relativePath, workspaceRoot) {
    let handle;
    try {
        if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
            res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
            res.end('Method not allowed');
            return;
        }
        if (!relativePath || relativePath.includes('\0') || relativePath.includes('\\')
            || relativePath.split('/').some(part => part === '.' || part === '..')) throw denied();
        const root = await fs.promises.realpath(workspaceRoot);
        const candidate = path.resolve(root, relativePath);
        if (candidate === root) throw denied();
        const entry = await inspect(root, candidate);
        const directory = entry.stat.isDirectory();
        const name = path.basename(candidate);
        if (!directory) handle = await openEntry(root, entry);
        const size = directory ? null : (await handle.stat()).size;
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, {
            'Content-Type': directory ? 'application/zip' : 'application/octet-stream',
            'Content-Disposition': attachmentHeader(name + (directory ? '.zip' : '')),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...(directory ? {} : { 'Content-Length': size })
        });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        const stream = directory
            ? createZipStream(folderEntries(root, entry, name))
            : size === 0 ? Readable.from([]) : handle.createReadStream({ autoClose: false, end: size - 1 });
        await pipeline(stream, res);
    } catch (error) {
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent) {
            res.destroy(error);
            return;
        }
        const status = error.statusCode || (['EACCES', 'EPERM', 'ELOOP'].includes(error.code) ? 403
            : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500);
        res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end(status === 403 ? 'Access denied' : status === 404 ? 'Not Found' : 'Download failed');
    } finally {
        if (handle && handle.fd !== -1) await handle.close();
    }
}
