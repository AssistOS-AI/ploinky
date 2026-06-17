import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { waitForAgentReady } from '../utils/agentReadiness.js';
import {
    getWorkspaceRoot,
    isPathWithinRoots,
    sanitizeRelativeRequestPath,
    toRealPathSafe
} from '../utils/workspacePaths.js';
import { ROUTING_FILE } from '../../services/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const MCP_BROWSER_CLIENT_URL = '/MCPBrowserClient.js';
const MCP_BROWSER_CLIENT_FILE = path.resolve(PROJECT_ROOT, 'Agent/client/MCPBrowserClient.js');
const PROJECT_WEB_LIBS = path.resolve(PROJECT_ROOT, 'webLibs');
const WORKSPACE_FILES_URL_PREFIX = '/workspace-files/';

function readRouting() {
    try {
        return JSON.parse(fs.readFileSync(ROUTING_FILE, 'utf8')) || {};
    } catch (_) {
        return {};
    }
}

function getStaticHostPath() {
    const cfg = readRouting();
    const hostPath = cfg?.static?.hostPath;
    if (!hostPath) return null;
    const abs = path.resolve(hostPath);
    try {
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs;
    } catch (_) { }
    return null;
}

function getStaticAgentName() {
    const cfg = readRouting();
    const agent = cfg?.static?.agent;
    return typeof agent === 'string' && agent.trim() ? agent.trim() : null;
}

function getStaticRouteRecord() {
    const cfg = readRouting();
    const routes = cfg?.routes && typeof cfg.routes === 'object' ? cfg.routes : {};
    const staticCfg = cfg?.static && typeof cfg.static === 'object' ? cfg.static : {};
    const staticAgent = typeof staticCfg.agent === 'string' ? staticCfg.agent.trim() : '';
    const staticHostPath = typeof staticCfg.hostPath === 'string' ? path.resolve(staticCfg.hostPath) : '';
    const staticContainer = typeof staticCfg.container === 'string' ? staticCfg.container.trim() : '';
    const staticAgentShortName = staticAgent.includes('/') ? staticAgent.split('/').pop() : staticAgent;

    for (const [routeName, route] of Object.entries(routes)) {
        if (!route || typeof route !== 'object') continue;
        const routeHostPath = typeof route.hostPath === 'string' ? path.resolve(route.hostPath) : '';
        const routeContainer = typeof route.container === 'string' ? route.container.trim() : '';
        const routeAgent = typeof route.agent === 'string' ? route.agent.trim() : '';
        const routeRepo = typeof route.repo === 'string' ? route.repo.trim() : '';
        const routeRef = routeRepo && routeAgent ? `${routeRepo}/${routeAgent}` : '';
        if (staticHostPath && routeHostPath && routeHostPath === staticHostPath) {
            return { routeName, route };
        }
        if (staticContainer && routeContainer && routeContainer === staticContainer) {
            return { routeName, route };
        }
        if (staticAgent && (routeName === staticAgent || routeRef === staticAgent)) {
            return { routeName, route };
        }
        if (staticAgentShortName && routeName === staticAgentShortName) {
            return { routeName, route };
        }
    }
    return null;
}

function getStaticEntrypointRouteName() {
    return getStaticRouteRecord()?.routeName || null;
}

function getStaticEntrypointUrl() {
    const routeName = getStaticEntrypointRouteName();
    if (!routeName) return null;
    return `/${encodeURIComponent(routeName)}/index.html`;
}

function dedupe(paths) {
    const seen = new Set();
    const out = [];
    for (const p of paths) {
        if (!p) continue;
        const key = path.resolve(p);
        if (seen.has(key)) continue;
        seen.add(key);
        try {
            if (fs.existsSync(key) && fs.statSync(key).isDirectory()) out.push(key);
        } catch (_) { }
    }
    return out;
}

function getBaseDirs(appName, fallbackDir) {
    const dirs = [];
    const staticRoot = getStaticHostPath();
    const variants = Array.from(new Set([appName, appName.toLowerCase()]));
    if (staticRoot) {
        for (const variant of variants) {
            dirs.push(path.join(staticRoot, 'web', variant));
            dirs.push(path.join(staticRoot, 'apps', variant));
            dirs.push(path.join(staticRoot, 'static', variant));
            dirs.push(path.join(staticRoot, 'assets', variant));
            dirs.push(path.join(staticRoot, variant));
        }
        dirs.push(staticRoot);
    }
    dirs.push(PROJECT_WEB_LIBS);
    dirs.push(fallbackDir);
    return dedupe(dirs);
}

function isPathWithinAllowedRoots(allowedRoots, targetPath, options = {}) {
    return isPathWithinRoots(allowedRoots, targetPath, options);
}

function getStaticAllowedRoots() {
    const staticRoot = getStaticHostPath();
    if (!staticRoot) return [];
    return [staticRoot, path.resolve(staticRoot, '..')];
}

function getAgentAllowedRoots(agentName) {
    const agentRoot = getAgentHostPath(agentName);
    if (!agentRoot) return [];
    return [agentRoot, path.resolve(agentRoot, '..')];
}

function resolveAssetPath(appName, fallbackDir, relPath) {
    const sanitized = sanitizeRelativeRequestPath(relPath);
    if (!sanitized) return null;
    const bases = getBaseDirs(appName, fallbackDir);
    for (const base of bases) {
        const allowedRoots = [base, path.resolve(base, '..')];
        const candidates = [
            path.join(base, sanitized),
            path.join(base, 'assets', sanitized)
        ];
        for (const candidate of candidates) {
            try {
                if (fs.existsSync(candidate)
                    && fs.statSync(candidate).isFile()
                    && isPathWithinAllowedRoots(allowedRoots, candidate)) {
                    return candidate;
                }
            } catch (_) { }
        }
    }
    return null;
}

function resolveFirstAvailable(appName, fallbackDir, filenames) {
    const list = Array.isArray(filenames) ? filenames : [filenames];
    for (const name of list) {
        const filePath = resolveAssetPath(appName, fallbackDir, name);
        if (filePath) return filePath;
    }
    return null;
}

function resolveStaticFile(requestPath) {
    const root = getStaticHostPath();
    if (!root) return null;
    const allowedRoots = getStaticAllowedRoots();
    const rel = sanitizeRelativeRequestPath(requestPath);
    if (rel === null) return null;
    const candidates = [];
    // Primary candidate
    candidates.push(path.join(root, rel));
    // If request maps to directory, handle later
    for (const candidate of candidates) {
        try {
            if (!isPathWithinAllowedRoots(allowedRoots, candidate)) {
                continue;
            }
            const stat = fs.statSync(candidate);
            if (stat.isDirectory()) {
                const indexFiles = ['index.html', 'index.htm', 'default.html'];
                for (const name of indexFiles) {
                    const idx = path.join(candidate, name);
                    if (fs.existsSync(idx)
                        && fs.statSync(idx).isFile()
                        && isPathWithinAllowedRoots(allowedRoots, idx)) return idx;
                }
                continue;
            }
            if (stat.isFile()) return candidate;
        } catch (_) { }
    }
    return null;
}

function isStaticEntrypointPath(pathname) {
    const normalized = typeof pathname === 'string' && pathname.trim() ? pathname.trim() : '/';
    const staticAgent = getStaticAgentName();
    const staticRouteName = getStaticEntrypointRouteName();
    if (normalized === '/' || normalized === '/index.html') {
        return true;
    }
    if (!staticAgent && !staticRouteName) {
        return false;
    }
    const aliases = Array.from(new Set([
        staticAgent,
        staticRouteName,
        staticAgent && staticAgent.includes('/') ? staticAgent.split('/').pop() : null
    ].filter(Boolean)));
    return aliases.some((alias) => normalized === `/${alias}`
        || normalized === `/${alias}/`
        || normalized === `/${alias}/index.html`);
}

function renderStaticBootstrapHtml(agentName) {
    const safeAgent = String(agentName || 'application');
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Starting ${safeAgent}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: Inter, "Segoe UI", Arial, sans-serif;
      background: linear-gradient(135deg, #f4f6fb, #dbeafe);
      color: #1f2937;
    }
    .boot-card {
      width: min(420px, calc(100vw - 32px));
      padding: 28px;
      border-radius: 20px;
      background: rgba(255,255,255,0.94);
      border: 1px solid rgba(31,41,55,0.08);
      box-shadow: 0 18px 48px rgba(15, 23, 42, 0.14);
    }
    .boot-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
      font-weight: 700;
    }
    .boot-spinner {
      width: 16px;
      height: 16px;
      border-radius: 999px;
      border: 2px solid #2563eb;
      border-right-color: transparent;
      animation: boot-spin .7s linear infinite;
      flex: 0 0 auto;
    }
    p {
      margin: 0;
      line-height: 1.55;
      color: #4b5563;
      font-size: 14px;
    }
    @keyframes boot-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <main class="boot-card">
    <div class="boot-row">
      <span class="boot-spinner" aria-hidden="true"></span>
      <span>Starting ${safeAgent}...</span>
    </div>
    <p>The workspace is still booting. This page will retry automatically.</p>
  </main>
  <script>
    window.setTimeout(function () {
      window.location.reload();
    }, 1000);
  </script>
</body>
</html>`;
}

async function serveStaticRequest(req, res) {
    try {
        const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const pathname = decodeURIComponent(parsed.pathname || '/');
        if (pathname === MCP_BROWSER_CLIENT_URL) {
            if (sendFile(res, MCP_BROWSER_CLIENT_FILE)) return true;
            return false;
        }

        const root = getStaticHostPath();
        if (!root) return false;

        if (isStaticEntrypointPath(pathname)) {
            const staticAgent = getStaticAgentName();
            const staticRouteName = getStaticEntrypointRouteName();
            const readinessTarget = staticRouteName || staticAgent;
            if (readinessTarget) {
                const ready = await waitForAgentReady(readinessTarget, {
                    timeoutMs: 15000,
                    intervalMs: 150,
                    probeTimeoutMs: 350
                });
                if (!ready) {
                    res.writeHead(503, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Cache-Control': 'no-store'
                    });
                    res.end(renderStaticBootstrapHtml(staticAgent || staticRouteName));
                    return true;
                }
            }
            if (pathname === '/' || pathname === '/index.html') {
                const entrypointUrl = getStaticEntrypointUrl();
                if (entrypointUrl) {
                    res.writeHead(302, {
                        Location: entrypointUrl,
                        'Cache-Control': 'no-store'
                    });
                    res.end();
                    return true;
                }
            }
        }

        const rel = pathname.replace(/^\/+/, '');
        const target = resolveStaticFile(rel || '');
        if (target && sendFile(res, target)) return true;
    } catch (_) { }
    return false;
}

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.html': 'text/html',
        '.json': 'application/json',
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.ico': 'image/x-icon',
        '.woff2': 'font/woff2',
        '.woff': 'font/woff',
        '.ttf': 'font/ttf',
        '.otf': 'font/otf',
        '.eot': 'application/vnd.ms-fontobject',
        '.webp': 'image/webp'
    };
    return map[ext] || 'application/octet-stream';
}

function getCacheControl(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.woff2' || ext === '.woff' || ext === '.ttf' || ext === '.otf' || ext === '.eot') {
        return 'public, max-age=31536000, immutable';
    }
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.ico' || ext === '.svg') {
        return 'public, max-age=86400';
    }
    if (ext === '.js' || ext === '.mjs' || ext === '.css') {
        return 'public, max-age=300';
    }
    return 'public, max-age=60';
}

function sendFile(res, filePath) {
    try {
        const mime = getMimeType(filePath);
        const headers = {
            'Content-Type': mime,
            'Cache-Control': getCacheControl(filePath)
        };
        res.writeHead(200, headers);
        const stream = fs.createReadStream(filePath);
        stream.on('error', () => {
            if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
        });
        stream.pipe(res);
        return true;
    } catch (err) {
        return false;
    }
}

function sendFileStream(res, filePath) {
    try {
        const mime = getMimeType(filePath);
        res.writeHead(200, {
            'Content-Type': mime,
            'Cache-Control': getCacheControl(filePath)
        });
        const stream = fs.createReadStream(filePath);
        stream.on('error', () => {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
            }
            res.end('Internal Server Error');
        });
        stream.pipe(res);
        return true;
    } catch (_) {
        return false;
    }
}

function resolveWorkspaceFile(requestPath) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return { status: 'unavailable', filePath: null };
    }

    const rel = sanitizeRelativeRequestPath(requestPath);
    if (rel === null || !rel.length) {
        return { status: 'denied', filePath: null };
    }

    const candidate = path.join(workspaceRoot, rel);
    const allowedRoots = [workspaceRoot];

    try {
        if (!isPathWithinAllowedRoots(allowedRoots, candidate, { allowMissing: true })) {
            return { status: 'denied', filePath: null };
        }
        const stat = fs.statSync(candidate);
        if (stat.isDirectory()) {
            const indexFiles = ['index.html', 'index.htm', 'default.html'];
            for (const name of indexFiles) {
                const idx = path.join(candidate, name);
                if (fs.existsSync(idx)
                    && fs.statSync(idx).isFile()
                    && isPathWithinAllowedRoots(allowedRoots, idx)) {
                    return { status: 'ok', filePath: idx };
                }
            }
            return { status: 'not_found', filePath: null };
        }
        if (stat.isFile()) {
            return { status: 'ok', filePath: candidate };
        }
    } catch (_) {
        return { status: 'not_found', filePath: null };
    }

    return { status: 'not_found', filePath: null };
}

function serveWorkspaceFileRequest(req, res) {
    try {
        const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const pathname = decodeURIComponent(parsed.pathname || '/');
        if (!(pathname === '/workspace-files' || pathname.startsWith(WORKSPACE_FILES_URL_PREFIX))) {
            return false;
        }

        if (pathname === '/workspace-files' || pathname === '/workspace-files/') {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing workspace file path');
            return true;
        }

        const rel = pathname.slice(WORKSPACE_FILES_URL_PREFIX.length);
        const resolved = resolveWorkspaceFile(rel);
        if (resolved.status === 'denied') {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Access denied');
            return true;
        }
        if (resolved.status !== 'ok' || !resolved.filePath) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return true;
        }
        if (sendFileStream(res, resolved.filePath)) {
            return true;
        }
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        return true;
    } catch (_) {
        return false;
    }
}

function serveWebLibRequest(req, res) {
    try {
        const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const pathname = decodeURIComponent(parsed.pathname || '/');
        if (!(pathname === '/web-libs' || pathname.startsWith('/web-libs/'))) {
            return false;
        }

        const rel = pathname.replace(/^\/web-libs\/?/, '');
        if (!rel) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return true;
        }

        const sanitized = sanitizeRelativeRequestPath(rel);
        if (sanitized === null) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return true;
        }

        const target = path.join(PROJECT_WEB_LIBS, sanitized);
        if (!isPathWithinAllowedRoots([PROJECT_WEB_LIBS], target)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return true;
        }

        try {
            const stat = fs.statSync(target);
            if (stat.isFile() && sendFile(res, target)) return true;
        } catch (_) { }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return true;
    } catch (_) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        return true;
    }
}

export {
    getStaticHostPath,
    getStaticAgentName,
    resolveAssetPath,
    resolveFirstAvailable,
    sendFile,
    serveWorkspaceFileRequest,
    serveWebLibRequest,
    serveStaticRequest,
};

// --- Agent-specific static routing ---
function getAgentHostPath(agentName) {
    const cfg = readRouting();
    const rec = cfg && cfg.routes ? cfg.routes[agentName] : null;
    if (!rec || !rec.hostPath) return null;
    try {
        const abs = path.resolve(rec.hostPath);
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs;
    } catch (_) { }
    return null;
}

function safeJoin(base, rel) {
    const cleaned = sanitizeRelativeRequestPath(rel || '');
    if (cleaned === null) return null;
    const p = path.join(base, cleaned);
    const absBase = path.resolve(base);
    const abs = path.resolve(p);
    if (!abs.startsWith(absBase)) return null; // prevent traversal outside base
    return abs;
}

async function resolveAgentStaticFile(agentName, agentRelPath) {
    const root = getAgentHostPath(agentName);
    if (!root) return null;
    const allowedRoots = getAgentAllowedRoots(agentName);
    const candidate = safeJoin(root, agentRelPath);
    if (!candidate) return null;
    try {
        if (!isPathWithinAllowedRoots(allowedRoots, candidate)) {
            return null;
        }
        const stat = await fs.promises.stat(candidate);
        if (stat.isDirectory()) {
            const indexFiles = ['index.html', 'index.htm', 'default.html'];
            for (const name of indexFiles) {
                const idx = path.join(candidate, name);
                try {
                    const idxStat = await fs.promises.stat(idx);
                    if (idxStat.isFile() && isPathWithinAllowedRoots(allowedRoots, idx)) return idx;
                } catch (_) {
                    continue;
                }
            }
            return null;
        }
        if (stat.isFile()) return candidate;
    } catch (_) { return null; }
    return null;
}

async function serveAgentStaticRequest(req, res) {
    try {
        const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const pathname = decodeURIComponent(parsed.pathname || '/');
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length < 2) return false;
        const agent = parts[0];
        const rest = parts.slice(1).join('/');
        const target = await resolveAgentStaticFile(agent, rest);
        if (target && sendFile(res, target)) return true;
    } catch (_) { }
    return false;
}

const PUBLIC_ASSET_EXTS = new Set([
    '.woff2', '.woff', '.ttf', '.otf', '.eot',
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
    '.css'
]);

function isPublicAssetPath(pathname) {
    const ext = path.extname(pathname).toLowerCase();
    return PUBLIC_ASSET_EXTS.has(ext);
}

async function servePublicAssetRequest(req, res) {
    try {
        const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const pathname = decodeURIComponent(parsed.pathname || '/');
        if (!isPublicAssetPath(pathname)) return false;

        const parts = pathname.split('/').filter(Boolean);
        if (parts.length >= 2) {
            const agent = parts[0];
            const rest = parts.slice(1).join('/');
            const target = await resolveAgentStaticFile(agent, rest);
            if (target && sendFile(res, target)) return true;
        }

        const root = getStaticHostPath();
        if (root) {
            const target = resolveStaticFile(pathname.replace(/^\/+/, ''));
            if (target && sendFile(res, target)) return true;
        }
    } catch (_) { }
    return false;
}

export { getAgentHostPath, resolveAgentStaticFile, serveAgentStaticRequest, servePublicAssetRequest };
