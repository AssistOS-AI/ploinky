import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { readAgentsSnapshot } from '../../utils/workspace.js';
import { SHARED_DIR } from '../../utils/config.js';
import {
    assertCanonicalAgentDataPath,
    resolveAgentDataPath,
    assertCanonicalAgentDataPathAsync,
    ensureAgentDataDirectoryAsync,
    resolveAgentDataPathAsync,
    validateAgentDataKey,
} from '../../utils/runtime/agentDataPathPolicy.js';
import { getWorkspaceRoot, resolveWorkspacePath } from '../utils/workspacePaths.js';
import {
    streamAdmittedUpload,
    UPLOAD_ROUTE_POLICIES,
} from './uploadAdmission.js';

function newId() { return crypto.randomBytes(24).toString('hex'); }

function sanitizeId(id) {
    const safe = String(id || '').replace(/[^a-zA-Z0-9_.-]/g, '');
    return safe && safe === id ? safe : null;
}

function normalizeAgentSegment(segment) {
    if (!segment) return '';
    try {
        return decodeURIComponent(segment.trim());
    } catch (_) {
        return segment.trim();
    }
}

export function resolveAgentBlobStorage(record, { workspaceRoot } = {}) {
    const canonicalName = String(record?.agentName || '');
    const agentDataDir = resolveAgentDataPath(canonicalName, {
        ...(workspaceRoot ? { workspaceRoot } : {}),
        label: 'blob agent name',
    });
    return Object.freeze({
        agentDataDir,
        blobsDir: assertCanonicalAgentDataPath(path.join(agentDataDir, 'blobs'), {
            ...(workspaceRoot ? { workspaceRoot } : {}),
        }),
    });
}

function selectAgentRecord(agentSegment, { agentMap } = {}) {
    const name = normalizeAgentSegment(agentSegment);
    if (!name) {
        return { ok: false, status: 400, message: 'Missing agent name in path.' };
    }

    let repoFilter = null;
    let agentFilter = name;
    const delimiterMatch = name.match(/[:/]/);
    if (delimiterMatch) {
        const [repoCandidate, agentCandidate] = name.split(/[:/]/);
        if (agentCandidate) {
            repoFilter = repoCandidate;
            agentFilter = agentCandidate;
        }
    }

    let map = agentMap;
    if (!map) {
        try {
            map = readAgentsSnapshot() || {};
        } catch (_) {
            map = {};
        }
    }

    const entries = Object.entries(map)
        .filter(([key]) => key !== '_config')
        .map(([, rec]) => rec)
        .filter(rec => rec && rec.type === 'agent' && rec.agentName && rec.projectPath);

    const matches = entries.filter(rec => {
        if (repoFilter && String(rec.repoName || '') !== repoFilter) return false;
        return String(rec.agentName) === agentFilter;
    });

    if (matches.length === 0) {
        return { ok: false, status: 404, message: `Agent '${name}' not found or not enabled.` };
    }
    if (!repoFilter && matches.length > 1) {
        const firstPath = matches[0].projectPath;
        const allSame = matches.every(rec => rec.projectPath === firstPath);
        if (!allSame) {
            const repos = matches.map(rec => String(rec.repoName || '-')).join(', ');
            return {
                ok: false,
                status: 409,
                message: `Agent '${name}' is ambiguous. Specify as '<repo>:${agentFilter}'. Found in repos: ${repos}.`
            };
        }
    }

    return { ok: true, record: matches[0] };
}

function agentRecordResult(agentSegment, record, blobsDir, workspaceRoot) {
    return {
        ok: true,
        agent: {
            requestSegment: agentSegment,
            canonicalName: record.agentName,
            repoName: record.repoName || null,
            projectPath: path.resolve(record.projectPath),
            blobsDir,
            ...(workspaceRoot ? { workspaceRoot } : {}),
            isShared: false,
        },
    };
}

export function resolveAgentRecord(agentSegment, { agentMap, workspaceRoot } = {}) {
    const selected = selectAgentRecord(agentSegment, { agentMap });
    if (!selected.ok) return selected;
    const { blobsDir } = resolveAgentBlobStorage(selected.record, { workspaceRoot });
    return agentRecordResult(agentSegment, selected.record, blobsDir, workspaceRoot);
}

async function resolveAgentRecordAsync(agentSegment, { agentMap, workspaceRoot, check = () => {} } = {}) {
    const selected = selectAgentRecord(agentSegment, { agentMap });
    if (!selected.ok) return selected;
    const agentDataDir = await resolveAgentDataPathAsync(selected.record.agentName, {
        workspaceRoot, label: 'blob agent name', check,
    });
    check();
    const blobsDir = await assertCanonicalAgentDataPathAsync(path.join(agentDataDir, 'blobs'), { workspaceRoot, check });
    check();
    return agentRecordResult(agentSegment, selected.record, blobsDir, workspaceRoot);
}

function resolveSharedRecord() {
    const sharedDir = SHARED_DIR;
    return {
        ok: true,
        agent: {
            requestSegment: '',
            canonicalName: 'shared',
            repoName: null,
            projectPath: sharedDir,
            blobsDir: sharedDir,
            workspaceRoot: getWorkspaceRoot(),
            isShared: true
        }
    };
}

function resolveAgentRecordForUpload(agentSegment) {
    const selected = selectAgentRecord(agentSegment);
    if (!selected.ok) return selected;
    const workspaceRoot = getWorkspaceRoot();
    const key = validateAgentDataKey(selected.record.agentName, { label: 'blob agent name' });
    return agentRecordResult(agentSegment, selected.record,
        path.join(workspaceRoot, '.data', key, 'blobs'), workspaceRoot);
}

function getRouteUrl(agent, id) {
    if (!agent) return `/blobs/${id}`;
    if (agent.isShared) {
        return `/blobs/${id}`;
    }
    const segment = encodeURIComponent(normalizeAgentSegment(agent.requestSegment || agent.canonicalName));
    return `/blobs/${segment}/${id}`;
}

function getLocalPath(agent, id) {
    if (agent?.isShared) {
        return `/shared/${id}`;
    }
    return `.data/${agent.canonicalName}/blobs/${id}`;
}

async function ensureAgentBlobsDirAsync(agent, check) {
    if (agent?.isShared) {
        if (agent.workspaceRoot) {
            await ensureAgentDataDirectoryAsync(agent.blobsDir, { workspaceRoot: agent.workspaceRoot, check });
            check();
            return;
        }
        await fs.promises.mkdir(agent.blobsDir, { recursive: true });
        check();
        return;
    }
    const pathOptions = { workspaceRoot: agent.workspaceRoot, check };
    await ensureAgentDataDirectoryAsync(path.dirname(agent.blobsDir), pathOptions);
    check();
    await assertCanonicalAgentDataPathAsync(agent.blobsDir, pathOptions);
    check();
    await fs.promises.mkdir(agent.blobsDir, { recursive: true });
    check();
    await assertCanonicalAgentDataPathAsync(agent.blobsDir, pathOptions);
    check();
}

function getAgentPaths(agent, id) {
    const safe = sanitizeId(id);
    if (!safe) return null;
    const filePath = path.join(agent.blobsDir, safe);
    const metaPath = `${filePath}.json`;
    return { filePath, metaPath, id: safe };
}

async function writeMeta(agent, id, meta) {
    await ensureAgentBlobsDirAsync(agent, () => {});
    const paths = getAgentPaths(agent, id);
    if (!paths) return false;
    const temporaryPath = `${paths.metaPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let committed = false;
    try {
        await fs.promises.writeFile(temporaryPath, JSON.stringify(meta || {}, null, 2), { flag: 'wx' });
        await fs.promises.link(temporaryPath, paths.metaPath);
        committed = true;
        await fs.promises.unlink(temporaryPath);
        return true;
    } catch (_) {
        await fs.promises.unlink(temporaryPath).catch(() => {});
        if (committed) await fs.promises.unlink(paths.metaPath).catch(() => {});
        return false;
    }
}

function readHeader(req, name) {
    const target = String(name || '').toLowerCase();
    if (!target || !req?.headers) return '';
    const direct = req.headers[target];
    if (direct) return direct;
    for (const [key, value] of Object.entries(req.headers)) {
        if (String(key).toLowerCase() === target) {
            return value;
        }
    }
    return '';
}

function parseUploadFilename(req) {
    const rawHeader = readHeader(req, 'x-file-name') || readHeader(req, 'x-filename');
    if (rawHeader) {
        const value = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
        if (value) {
            try {
                return decodeURIComponent(String(value)).slice(0, 512);
            } catch (_) {
                return String(value).slice(0, 512);
            }
        }
    }

    const contentDisposition = readHeader(req, 'content-disposition');
    if (contentDisposition && /filename=/i.test(contentDisposition)) {
        const match = contentDisposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
        if (match && match[1]) {
            try {
                return decodeURIComponent(match[1]).slice(0, 512);
            } catch (_) {
                return String(match[1]).slice(0, 512);
            }
        }
    }

    return '';
}

function isBlobStorageEntry({ relativePath }) {
    return !/^[a-f0-9]{48}\.json$/i.test(relativePath);
}

function writeBlobUploadError(res, error) {
    if (res.headersSent) return;
    res.writeHead(error.status || 500, {
        'Content-Type': 'text/plain',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(error.code || 'upload_failed');
}

function buildBlobUploadDetails(req, agent, id, originalName) {
    const routeUrl = getRouteUrl(agent, id);
    const protoHeader = readHeader(req, 'x-forwarded-proto');
    const forwardedHost = readHeader(req, 'x-forwarded-host');
    const hostHeader = readHeader(req, 'host');
    const protoRaw = (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader) || '';
    const proto = protoRaw
        ? String(protoRaw).split(',')[0].trim()
        : (req.socket?.encrypted ? 'https' : 'http');
    const hostRaw = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)
        || (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader)
        || '';
    const host = hostRaw ? String(hostRaw).split(',')[0].trim() : '';
    return {
        displayName: originalName || null,
        localPath: getLocalPath(agent, id),
        absoluteUrl: host ? `${proto}://${host}${routeUrl}` : null,
    };
}

async function handlePost(req, res, agent, { policy, timers } = {}) {
    try {
        const mime = req.headers['x-mime-type'] || req.headers['content-type'] || 'application/octet-stream';
        const id = newId();
        const paths = getAgentPaths(agent, id);
        if (!paths) { res.writeHead(400); return res.end('Bad id'); }
        const originalName = parseUploadFilename(req);
        const details = buildBlobUploadDetails(req, agent, id, originalName);
        return await streamAdmittedUpload(req, {
            res,
            prepare: check => ensureAgentBlobsDirAsync(agent, check),
            storageRoot: agent.blobsDir,
            targetPath: paths.filePath,
            policy: policy || UPLOAD_ROUTE_POLICIES.blobs,
            includeEntry: isBlobStorageEntry,
            timers,
            finalize: async ({ size }) => {
                const meta = {
                    id,
                    mime,
                    size,
                    createdAt: new Date().toISOString(),
                    agent: agent.canonicalName,
                    repo: agent.repoName,
                    filename: details.displayName,
                    localPath: details.localPath,
                    downloadUrl: details.absoluteUrl
                };
                if (!await writeMeta(agent, id, meta)) {
                    throw new Error('Unable to persist blob metadata.');
                }
            },
            onSuccess: ({ size }) => {
                if (res.headersSent || res.destroyed) return;
                res.writeHead(201, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
                res.end(JSON.stringify({
                    id,
                    localPath: details.localPath,
                    size,
                    mime,
                    agent: agent.canonicalName,
                    filename: details.displayName,
                    downloadUrl: details.absoluteUrl
                }));
            },
            onFailure: error => writeBlobUploadError(res, error),
        });
    } catch (e) {
        if (!res.headersSent && !res.destroyed) { res.writeHead(500); res.end('Upload error'); }
    }
}

async function handleGetHead(req, res, agent, id, isHead = false) {
    let handle;
    let streamStarted = false;
    const gone = () => res.destroyed || res.writableEnded || req.aborted || req.readableAborted;
    try {
        if (gone()) return;
        const paths = getAgentPaths(agent, id);
        if (!paths) { res.writeHead(400); return res.end('Bad id'); }
        if (!agent.isShared || agent.workspaceRoot) {
            await assertCanonicalAgentDataPathAsync(agent.blobsDir, {
                workspaceRoot: agent.workspaceRoot,
                check: () => { if (gone()) throw new Error('Download disconnected'); },
            });
            if (gone()) return;
        }
        let meta = {};
        try { meta = JSON.parse(await fs.promises.readFile(paths.metaPath, 'utf8')); } catch (_) { /* optional */ }
        if (gone()) return;
        handle = await fs.promises.open(paths.filePath, 'r');
        if (gone()) return;
        const stat = await handle.stat();
        if (gone()) return;
        if (!stat.isFile()) { res.writeHead(404); return res.end('Not Found'); }
        const size = stat.size;
        let start = 0;
        let end = size - 1;
        let status = 200;
        const headers = {
            'Content-Type': meta?.mime || 'application/octet-stream',
            'Content-Length': size,
            'Accept-Ranges': 'bytes',
            'X-Content-Type-Options': 'nosniff',
        };
        if (!isHead && req.method !== 'HEAD') {
            const range = req.headers?.range;
            const match = range && /^bytes=/.test(range) && range.match(/bytes=(\d+)-(\d+)?/);
            if (match) {
                start = Number(match[1]);
                end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
                if (start >= size) {
                    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
                    return res.end();
                }
                if (start <= end) {
                    status = 206;
                    headers['Content-Length'] = end - start + 1;
                    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
                } else {
                    start = 0;
                    end = size - 1;
                }
            }
        }
        if (gone()) return;
        res.writeHead(status, headers);
        if (isHead || req.method === 'HEAD' || size === 0) return res.end();
        const stream = handle.createReadStream({ start, end, autoClose: true });
        streamStarted = true;
        const onClose = () => stream.destroy();
        res.on('close', onClose);
        stream.once('close', () => res.off('close', onClose));
        stream.on('error', () => res.destroy());
        if (gone()) stream.destroy();
        else stream.pipe(res);
    } catch (error) {
        if (!gone() && !res.headersSent) {
            res.writeHead(error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 404 : 500);
            res.end(error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'Not Found' : 'Error');
        }
    } finally {
        if (handle && !streamStarted) await handle.close().catch(() => {});
    }
}

function resolveWorkspaceUploadPath(inputPath, workspaceRoot = getWorkspaceRoot()) {
    return resolveWorkspacePath(inputPath, {
        workspaceRoot,
        leadingSlashIsWorkspaceRelative: true
    });
}

async function handleWorkspaceUpload(req, res, { policy, timers, workspaceRoot } = {}) {
    if (req.method !== 'POST' && req.method !== 'PUT') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST, PUT' });
        res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
        return;
    }

    try {
        const u = new URL(req.url || '/upload', `http://${req.headers.host || 'localhost'}`);
        const quotaRoot = path.resolve(workspaceRoot || getWorkspaceRoot());
        const targetPath = resolveWorkspaceUploadPath(u.searchParams.get('path') || '', quotaRoot);
        const parentDir = path.dirname(targetPath);
        return await streamAdmittedUpload(req, {
            res,
            prepare: async check => {
                await fs.promises.mkdir(parentDir, { recursive: true });
                check();
                return { targetPath: resolveWorkspaceUploadPath(u.searchParams.get('path') || '', quotaRoot) };
            },
            storageRoot: quotaRoot,
            targetPath,
            policy: policy || UPLOAD_ROUTE_POLICIES.workspace,
            replaceExisting: true,
            timers,
            onSuccess: ({ size }) => {
                if (res.headersSent || res.destroyed) return;
                res.writeHead(200, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
                res.end(JSON.stringify({
                    ok: true,
                    path: targetPath,
                    size
                }));
            },
            onFailure: error => {
                if (res.headersSent) return;
                res.writeHead(error.status || 500, {
                    'Content-Type': 'application/json',
                    'X-Content-Type-Options': 'nosniff',
                });
                res.end(JSON.stringify({ ok: false, error: error.code || 'upload_failed' }));
            },
        });
    } catch (error) {
        const storageFull = error?.code === 'ENOSPC' || error?.code === 'EDQUOT';
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(storageFull ? 507 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: false,
            error: storageFull ? 'upload_storage_full' : message,
        }));
    }
}

async function handleBlobs(req, res, options = {}) {
    const u = new URL(req.url || '/blobs', `http://${req.headers.host || 'localhost'}`);
    const pathname = u.pathname || '/blobs';
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 0 || segments[0] !== 'blobs') {
        res.writeHead(404); return res.end('Not Found');
    }

    if (req.method === 'POST' && segments.length === 1) {
        const resolver = options.sharedRecordResolver || resolveSharedRecord;
        const resolved = resolver();
        return handlePost(req, res, resolved.agent, {
            policy: options.policy,
            timers: options.timers,
        });
    }

    if (req.method === 'POST' && segments.length === 2) {
        const agentSegment = segments[1];
        const resolver = options.agentRecordResolver || resolveAgentRecordForUpload;
        const resolved = resolver(agentSegment);
        if (!resolved.ok) {
            res.writeHead(resolved.status, { 'Content-Type': 'text/plain' });
            res.end(resolved.message);
            return;
        }
        return handlePost(req, res, resolved.agent, {
            policy: options.policy,
            timers: options.timers,
        });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && segments.length === 2) {
        const idSegment = segments[1];
        const safeId = sanitizeId(idSegment);
        if (!safeId) {
            res.writeHead(400); return res.end('Bad id');
        }
        const resolved = (options.sharedRecordResolver || resolveSharedRecord)();
        return handleGetHead(req, res, resolved.agent, safeId, req.method === 'HEAD');
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && segments.length === 3) {
        const agentSegment = segments[1];
        const idSegment = segments[2];
        if (res.destroyed || res.writableEnded) return;
        let resolved;
        try {
            resolved = await (options.agentRecordResolver || resolveAgentRecordAsync)(agentSegment, {
                check: () => {
                    if (res.destroyed || res.writableEnded) throw new Error('Download disconnected');
                },
            });
        } catch (_) {
            if (!res.destroyed && !res.writableEnded && !res.headersSent) {
                res.writeHead(500);
                res.end('Error');
            }
            return;
        }
        if (res.destroyed || res.writableEnded) return;
        if (!resolved.ok) {
            res.writeHead(resolved.status, { 'Content-Type': 'text/plain' });
            res.end(resolved.message);
            return;
        }
        const safeId = sanitizeId(idSegment);
        if (!safeId) {
            res.writeHead(400); return res.end('Bad id');
        }
        return handleGetHead(req, res, resolved.agent, safeId, req.method === 'HEAD');
    }

    res.writeHead(404); res.end('Not Found');
}

export { handleBlobs, handleWorkspaceUpload };
