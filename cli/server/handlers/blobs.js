import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { loadAgents } from '../../utils/workspace.js';
import { SHARED_DIR } from '../../utils/config.js';
import { getWorkspaceRoot, resolveWorkspacePath } from '../utils/workspacePaths.js';

function ensureSharedHostDir() {
    const dir = SHARED_DIR;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return dir;
}

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

function resolveAgentRecord(agentSegment) {
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

    let map;
    try {
        map = loadAgents() || {};
    } catch (_) {
        map = {};
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

    const record = matches[0];
    const projectPath = path.resolve(record.projectPath);
    const blobsDir = path.join(projectPath, 'blobs');

    return {
        ok: true,
        agent: {
            requestSegment: agentSegment,
            canonicalName: record.agentName,
            repoName: record.repoName || null,
            projectPath,
            blobsDir,
            isShared: false
        }
    };
}

function resolveSharedRecord() {
    const sharedDir = ensureSharedHostDir();
    return {
        ok: true,
        agent: {
            requestSegment: '',
            canonicalName: 'shared',
            repoName: null,
            projectPath: sharedDir,
            blobsDir: sharedDir,
            isShared: true
        }
    };
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
    return `blobs/${id}`;
}

function ensureAgentBlobsDir(agent) {
    try { fs.mkdirSync(agent.blobsDir, { recursive: true }); } catch (_) { }
}

function getAgentPaths(agent, id) {
    const safe = sanitizeId(id);
    if (!safe) return null;
    const filePath = path.join(agent.blobsDir, safe);
    const metaPath = `${filePath}.json`;
    return { filePath, metaPath, id: safe };
}

function readMeta(agent, id) {
    ensureAgentBlobsDir(agent);
    const paths = getAgentPaths(agent, id);
    if (!paths) return null;
    try { return JSON.parse(fs.readFileSync(paths.metaPath, 'utf8')); } catch (_) { return null; }
}

function writeMeta(agent, id, meta) {
    ensureAgentBlobsDir(agent);
    const paths = getAgentPaths(agent, id);
    if (!paths) return false;
    try {
        fs.writeFileSync(paths.metaPath, JSON.stringify(meta || {}, null, 2));
        return true;
    } catch (_) {
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

function handlePost(req, res, agent) {
    try {
        const mime = req.headers['x-mime-type'] || req.headers['content-type'] || 'application/octet-stream';
        const id = newId();
        ensureAgentBlobsDir(agent);
        const paths = getAgentPaths(agent, id);
        if (!paths) { res.writeHead(400); return res.end('Bad id'); }
        const out = fs.createWriteStream(paths.filePath);
        let size = 0;
        const originalName = parseUploadFilename(req);
        req.on('data', chunk => { size += chunk.length; });
        req.pipe(out);
        out.on('finish', () => {
            const displayName = originalName || null;
            const routeUrl = getRouteUrl(agent, id);
            const localPath = getLocalPath(agent, id);
            const protoHeader = readHeader(req, 'x-forwarded-proto');
            const forwardedHost = readHeader(req, 'x-forwarded-host');
            const hostHeader = readHeader(req, 'host');
            const protoRaw = (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader) || '';
            const proto = protoRaw ? String(protoRaw).split(',')[0].trim() : (req.socket?.encrypted ? 'https' : 'http');
            const hostRaw = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) || (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader) || '';
            const host = hostRaw ? String(hostRaw).split(',')[0].trim() : '';
            const absoluteUrl = host ? `${proto}://${host}${routeUrl}` : null;
            const meta = {
                id,
                mime,
                size,
                createdAt: new Date().toISOString(),
                agent: agent.canonicalName,
                repo: agent.repoName,
                filename: displayName,
                localPath,
                downloadUrl: absoluteUrl
            };
            writeMeta(agent, id, meta);
            res.writeHead(201, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
            res.end(JSON.stringify({
                id,
                localPath,
                size,
                mime,
                agent: agent.canonicalName,
                filename: displayName,
                downloadUrl: absoluteUrl
            }));
        });
        out.on('error', (e) => {
            try { fs.unlinkSync(paths.filePath); } catch (_) { }
            res.writeHead(500);
            res.end('Write error');
        });
    } catch (e) {
        res.writeHead(500); res.end('Upload error');
    }
}

function streamRange(req, res, filePath, meta) {
    try {
        const stat = fs.statSync(filePath);
        const size = stat.size;
        const range = req.headers['range'];
        if (range && /^bytes=/.test(range)) {
            const m = range.match(/bytes=(\d+)-(\d+)?/);
            if (m) {
                const start = parseInt(m[1], 10);
                const end = m[2] ? parseInt(m[2], 10) : size - 1;
                if (start <= end && start < size) {
                    res.writeHead(206, {
                        'Content-Type': meta?.mime || 'application/octet-stream',
                        'Content-Length': (end - start + 1),
                        'Content-Range': `bytes ${start}-${end}/${size}`,
                        'Accept-Ranges': 'bytes',
                        'X-Content-Type-Options': 'nosniff'
                    });
                    return fs.createReadStream(filePath, { start, end }).pipe(res);
                }
            }
        }
        // Full response
        res.writeHead(200, {
            'Content-Type': meta?.mime || 'application/octet-stream',
            'Content-Length': size,
            'Accept-Ranges': 'bytes',
            'X-Content-Type-Options': 'nosniff'
        });
        fs.createReadStream(filePath).pipe(res);
    } catch (e) {
        res.writeHead(500); res.end('Read error');
    }
}

function handleGetHead(req, res, agent, id, isHead = false) {
    try {
        ensureAgentBlobsDir(agent);
        const paths = getAgentPaths(agent, id);
        if (!paths) { res.writeHead(400); return res.end('Bad id'); }
        const meta = readMeta(agent, id) || {};
        if (!fs.existsSync(paths.filePath)) { res.writeHead(404); return res.end('Not Found'); }
        if (req.method === 'HEAD' || isHead) {
            const stat = fs.statSync(paths.filePath);
            res.writeHead(200, {
                'Content-Type': meta?.mime || 'application/octet-stream',
                'Content-Length': stat.size,
                'Accept-Ranges': 'bytes',
                'X-Content-Type-Options': 'nosniff'
            });
            return res.end();
        }
        return streamRange(req, res, paths.filePath, meta);
    } catch (e) {
        res.writeHead(500); res.end('Error');
    }
}

function resolveWorkspaceUploadPath(inputPath) {
    return resolveWorkspacePath(inputPath, {
        workspaceRoot: getWorkspaceRoot(),
        leadingSlashIsWorkspaceRelative: true
    });
}

function handleWorkspaceUpload(req, res) {
    if (req.method !== 'POST' && req.method !== 'PUT') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST, PUT' });
        res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
        return;
    }

    try {
        const u = new URL(req.url || '/upload', `http://${req.headers.host || 'localhost'}`);
        const targetPath = resolveWorkspaceUploadPath(u.searchParams.get('path') || '');
        const parentDir = path.dirname(targetPath);
        fs.mkdirSync(parentDir, { recursive: true });

        const out = fs.createWriteStream(targetPath);
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
        });
        req.pipe(out);
        out.on('finish', () => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
            res.end(JSON.stringify({
                ok: true,
                path: targetPath,
                size
            }));
        });
        out.on('error', () => {
            try { fs.unlinkSync(targetPath); } catch (_) {}
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Write error' }));
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: message }));
    }
}

function handleBlobs(req, res) {
    const u = new URL(req.url || '/blobs', `http://${req.headers.host || 'localhost'}`);
    const pathname = u.pathname || '/blobs';
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 0 || segments[0] !== 'blobs') {
        res.writeHead(404); return res.end('Not Found');
    }

    if (req.method === 'POST' && segments.length === 1) {
        const resolved = resolveSharedRecord();
        return handlePost(req, res, resolved.agent);
    }

    if (req.method === 'POST' && segments.length === 2) {
        const agentSegment = segments[1];
        const resolved = resolveAgentRecord(agentSegment);
        if (!resolved.ok) {
            res.writeHead(resolved.status, { 'Content-Type': 'text/plain' });
            res.end(resolved.message);
            return;
        }
        return handlePost(req, res, resolved.agent);
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && segments.length === 2) {
        const idSegment = segments[1];
        const safeId = sanitizeId(idSegment);
        if (!safeId) {
            res.writeHead(400); return res.end('Bad id');
        }
        const resolved = resolveSharedRecord();
        return handleGetHead(req, res, resolved.agent, safeId, req.method === 'HEAD');
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && segments.length === 3) {
        const agentSegment = segments[1];
        const idSegment = segments[2];
        const resolved = resolveAgentRecord(agentSegment);
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
