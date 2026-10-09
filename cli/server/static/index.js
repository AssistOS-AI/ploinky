import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { waitForAgentReady } from '../utils/agentReadiness.js';
import {
    getWorkspaceRoot,
    isPathWithinRoots,
    isPathWithinRootsAsync,
    sanitizeRelativeRequestPath,
    toRealPathSafe
} from '../utils/workspacePaths.js';
import { ROUTING_FILE } from '../../utils/config.js';
import { resolveAgentRepositoryPath } from '../../utils/agentRepositorySource.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
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

async function getBaseDirsAsync(appName, fallbackDir) {
    let cfg;
    try {
        cfg = JSON.parse(await fs.promises.readFile(ROUTING_FILE, 'utf8'));
    } catch (_) { }
    const staticRoot = cfg?.static?.hostPath ? await directoryOrNull(cfg.static.hostPath) : null;
    const dirs = [];
    if (staticRoot) {
        for (const variant of new Set([appName, appName.toLowerCase()])) {
            for (const parent of ['web', 'apps', 'static', 'assets', '']) {
                dirs.push(path.join(staticRoot, parent, variant));
            }
        }
        dirs.push(staticRoot);
    }
    dirs.push(PROJECT_WEB_LIBS, fallbackDir);
    const unique = [...new Set(dirs.filter(Boolean).map(dir => path.resolve(dir)))];
    return (await Promise.all(unique.map(directoryOrNull))).filter(Boolean);
}

async function resolveAssetFromBasesAsync(bases, relPath) {
    const sanitized = sanitizeRelativeRequestPath(relPath);
    if (!sanitized) return null;
    for (const base of bases) {
        const allowedRoots = [base, path.resolve(base, '..')];
        for (const candidate of [path.join(base, sanitized), path.join(base, 'assets', sanitized)]) {
            try {
                if ((await fs.promises.stat(candidate)).isFile()
                    && await isPathWithinAllowedRootsAsync(allowedRoots, candidate)) return candidate;
            } catch (_) { }
        }
    }
    return null;
}

async function resolveAssetPathAsync(appName, fallbackDir, relPath) {
    if (!sanitizeRelativeRequestPath(relPath)) return null;
    return resolveAssetFromBasesAsync(await getBaseDirsAsync(appName, fallbackDir), relPath);
}

async function resolveFirstAvailableAsync(appName, fallbackDir, filenames) {
    const bases = await getBaseDirsAsync(appName, fallbackDir);
    for (const name of Array.isArray(filenames) ? filenames : [filenames]) {
        const target = await resolveAssetFromBasesAsync(bases, name);
        if (target) return target;
    }
    return null;
}

function isPathWithinAllowedRoots(allowedRoots, targetPath, options = {}) {
    return isPathWithinRoots(allowedRoots, targetPath, options);
}

function isPathWithinAllowedRootsAsync(allowedRoots, targetPath, options = {}) {
    return isPathWithinRootsAsync(allowedRoots, targetPath, options);
}

async function pathExists(target) {
    try {
        await fs.promises.access(target);
        return true;
    } catch (_) {
        return false;
    }
}

async function directoryOrNull(hostPath) {
    try {
        const abs = path.resolve(hostPath);
        if ((await fs.promises.stat(abs)).isDirectory()) return abs;
    } catch (_) { }
    return null;
}

function getStaticAllowedRoots() {
    const staticRoot = getStaticHostPath();
    if (!staticRoot) return [];
    return [staticRoot, path.resolve(staticRoot, '..')];
}

async function getAgentAllowedRoots(agentName, options = {}) {
    const agentRoot = Object.prototype.hasOwnProperty.call(options, 'hostPath')
        ? await normalizeAgentHostPath(options.hostPath)
        : await getAgentHostPath(agentName);
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
            if (await sendFile(res, MCP_BROWSER_CLIENT_FILE, { req })) return true;
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
        if (target && await sendFile(res, target, { req })) return true;
    } catch (_) { }
    return false;
}

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.c': 'text/plain; charset=utf-8',
        '.cc': 'text/plain; charset=utf-8',
        '.cpp': 'text/plain; charset=utf-8',
        '.cs': 'text/plain; charset=utf-8',
        '.css': 'text/css',
        '.csv': 'text/csv; charset=utf-8',
        '.go': 'text/plain; charset=utf-8',
        '.h': 'text/plain; charset=utf-8',
        '.hpp': 'text/plain; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.htm': 'text/html; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.java': 'text/plain; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.jsx': 'text/plain; charset=utf-8',
        '.log': 'text/plain; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8',
        '.mdx': 'text/markdown; charset=utf-8',
        '.php': 'text/plain; charset=utf-8',
        '.pdf': 'application/pdf',
        '.py': 'text/plain; charset=utf-8',
        '.rb': 'text/plain; charset=utf-8',
        '.rs': 'text/plain; charset=utf-8',
        '.scss': 'text/plain; charset=utf-8',
        '.sh': 'text/plain; charset=utf-8',
        '.sql': 'text/plain; charset=utf-8',
        '.toml': 'text/plain; charset=utf-8',
        '.ts': 'text/plain; charset=utf-8',
        '.tsx': 'text/plain; charset=utf-8',
        '.txt': 'text/plain; charset=utf-8',
        '.xml': 'application/xml; charset=utf-8',
        '.yaml': 'text/yaml; charset=utf-8',
        '.yml': 'text/yaml; charset=utf-8',
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

function getCacheControl(filePath, { authenticated = false } = {}) {
    const ext = path.extname(filePath).toLowerCase();
    // HTML documents are application entry points behind session and capability
    // checks. A cached copy would let a browser reopen a shell the Router has
    // since denied (logout, demotion, block), so documents are never stored.
    if (ext === '.html' || ext === '.htm') {
        return 'no-store';
    }
    // Authenticated surfaces (agent static, workspace files) must never be kept
    // by a shared cache, so they are `private`; public assets stay `public`.
    const scope = authenticated ? 'private' : 'public';
    if (ext === '.woff2' || ext === '.woff' || ext === '.ttf' || ext === '.otf' || ext === '.eot') {
        return `${scope}, max-age=31536000, immutable`;
    }
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.ico' || ext === '.svg') {
        return `${scope}, max-age=86400`;
    }
    if (ext === '.js' || ext === '.mjs' || ext === '.css') {
        return `${scope}, max-age=300`;
    }
    return `${scope}, max-age=60`;
}

function normalizeEntityTag(tag) {
    return tag.startsWith('W/') ? tag.slice(2) : tag;
}

// If-None-Match: comma-separated entity tags or `*`, compared weakly.
function ifNoneMatchMatches(headerValue, etag) {
    const raw = Array.isArray(headerValue) ? headerValue.join(',') : headerValue;
    if (typeof raw !== 'string' || !raw.trim()) return false;
    const current = normalizeEntityTag(etag);
    const tagPattern = /\s*(\*|(?:W\/)?"[^"]*")\s*(?:,|$)/y;
    let offset = 0;
    while (offset < raw.length) {
        tagPattern.lastIndex = offset;
        const match = tagPattern.exec(raw);
        if (!match) return false;
        if (match[1] === '*' || normalizeEntityTag(match[1]) === current) return true;
        offset = tagPattern.lastIndex;
    }
    return false;
}

// Open the file once, take validators from the open handle (fstat), then
// stream from that same handle so headers and body describe the same file.
// Callers run any generation/lease check before calling this, so neither a 200
// nor a 304 is produced for a stale generation.
// A client that resets the connection while the request is awaiting I/O leaves
// a destroyed response whose 'close' event has already fired; nothing may be
// written to it and every handle opened for it must still be closed.
function responseGone(res) {
    return Boolean(res?.destroyed || res?.writableEnded);
}

async function sendOpenedFile(req, res, filePath, { authenticated = false, extraHeaders = {} } = {}) {
    if (responseGone(res)) return true;
    let handle;
    try {
        handle = await fs.promises.open(filePath, 'r');
    } catch (_) {
        return false;
    }
    let streamStarted = false;
    try {
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile()) return false;
        // Last await is behind us: a gone client is handled here, and the
        // finally block closes the handle because no stream was started.
        if (responseGone(res)) return true;
        const size = Number(stat.size);
        const etag = `W/"${stat.size}-${stat.mtimeNs}-${stat.ino}"`;
        const lastModified = new Date(Number(stat.mtimeNs / 1000000n)).toUTCString();
        const cacheControl = getCacheControl(filePath, { authenticated });
        const method = String(req?.method || 'GET').toUpperCase();
        if ((method === 'GET' || method === 'HEAD')
            && ifNoneMatchMatches(req?.headers?.['if-none-match'], etag)) {
            res.writeHead(304, {
                'Cache-Control': cacheControl,
                ETag: etag,
                'Last-Modified': lastModified,
            });
            res.end();
            return true;
        }
        res.writeHead(200, {
            'Content-Type': getMimeType(filePath),
            'Cache-Control': cacheControl,
            'Content-Length': size,
            ETag: etag,
            'Last-Modified': lastModified,
            ...extraHeaders,
        });
        if (size === 0) {
            res.end();
            return true;
        }
        // `end` caps the body at the fstat size so it cannot exceed Content-Length.
        const stream = handle.createReadStream({ start: 0, end: size - 1, autoClose: true });
        streamStarted = true;
        stream.on('error', () => {
            if (typeof res.destroy === 'function') res.destroy();
            else res.end();
        });
        if (typeof res.on === 'function') res.on('close', () => stream.destroy());
        if (responseGone(res)) {
            stream.destroy();
            return true;
        }
        stream.pipe(res);
        return true;
    } catch (_) {
        return false;
    } finally {
        if (!streamStarted) await handle.close().catch(() => { });
    }
}

async function sendFile(res, filePath, { req = null, authenticated = false } = {}) {
    return sendOpenedFile(req, res, filePath, { authenticated });
}

async function sendFileStream(req, res, filePath) {
    return sendOpenedFile(req, res, filePath, {
        authenticated: true,
        extraHeaders: getWorkspaceFileHeaders(filePath),
    });
}

function getWorkspaceFileHeaders(filePath) {
    return {
        'Content-Type': getMimeType(filePath),
        'Cache-Control': getCacheControl(filePath, { authenticated: true }),
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
    };
}

async function resolveWorkspaceFile(requestPath) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return { status: 'unavailable', filePath: null };
    }

    const rel = sanitizeRelativeRequestPath(requestPath);
    if (rel === null || !rel.length) {
        return { status: 'denied', filePath: null };
    }

    try {
        let candidate = path.join(workspaceRoot, rel);
        let allowedRoots = [workspaceRoot];
        const segments = rel.split('/');
        if (segments[0] === '.ploinky' && segments[1] === 'repos' && segments.length >= 4) {
            const [, , repo, agent, ...asset] = segments;
            const routes = Object.values(readRouting().routes || {}).filter(route =>
                route?.repo === repo && route?.agent === agent && route?.hostPath);
            const selectedRoots = [...new Set(routes.map(route => path.resolve(route.hostPath)))];
            if (selectedRoots.length > 1) return { status: 'denied', filePath: null };
            const sourceRoot = selectedRoots[0] || path.join(resolveAgentRepositoryPath(repo), agent);
            const managedRoot = path.join(workspaceRoot, '.ploinky', 'repos', repo, agent);
            if (selectedRoots.length || await pathExists(path.join(sourceRoot, 'manifest.json'))
                || await pathExists(path.join(managedRoot, 'manifest.json'))) {
                // Legacy agent asset URLs follow the admitted source, never a
                // second copy. Ordinary workspace file paths remain literal.
                if (!await isPathWithinAllowedRootsAsync([workspaceRoot], sourceRoot, { allowMissing: true })) {
                    return { status: 'denied', filePath: null };
                }
                candidate = path.join(sourceRoot, ...asset);
                allowedRoots = [sourceRoot];
            }
        }
        if (!await isPathWithinAllowedRootsAsync(allowedRoots, candidate, { allowMissing: true })) {
            return { status: 'denied', filePath: null };
        }
        const stat = await fs.promises.stat(candidate);
        if (stat.isDirectory()) {
            const indexFiles = ['index.html', 'index.htm', 'default.html'];
            for (const name of indexFiles) {
                const idx = path.join(candidate, name);
                try {
                    if ((await fs.promises.stat(idx)).isFile()
                        && await isPathWithinAllowedRootsAsync(allowedRoots, idx)) {
                        return { status: 'ok', filePath: idx };
                    }
                } catch (_) {
                    continue;
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

// The mount is matched on its literal spelling, exactly as Router
// authorization classifies it; only the file path below it is decoded.
function workspaceFilePathname(req) {
    const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const rawPathname = parsed.pathname || '/';
    if (rawPathname !== '/workspace-files' && !rawPathname.startsWith(WORKSPACE_FILES_URL_PREFIX)) return null;
    return decodeURIComponent(rawPathname);
}

// Synchronous prefix check so the Router can decide dispatch without awaiting.
function isWorkspaceFileRequest(req) {
    try {
        return workspaceFilePathname(req) !== null;
    } catch (_) {
        return false;
    }
}

async function serveWorkspaceFileRequest(req, res) {
    try {
        const pathname = workspaceFilePathname(req);
        if (pathname === null) {
            return false;
        }

        if (pathname === '/workspace-files' || pathname === '/workspace-files/') {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing workspace file path');
            return true;
        }

        const rel = pathname.slice(WORKSPACE_FILES_URL_PREFIX.length);
        const resolved = await resolveWorkspaceFile(rel);
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
        if (await sendFileStream(req, res, resolved.filePath)) {
            return true;
        }
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        return true;
    } catch (_) {
        return false;
    }
}

async function serveWebLibRequest(req, res) {
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
        const confined = await isPathWithinAllowedRootsAsync([PROJECT_WEB_LIBS], target);
        if (req.destroyed || res.destroyed) return true;
        if (!confined) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return true;
        }

        try {
            const stat = await fs.promises.stat(target);
            if (req.destroyed || res.destroyed) return true;
            if (stat.isFile() && await sendFile(res, target, { req })) return true;
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
    getBaseDirsAsync,
    resolveAssetPathAsync,
    resolveFirstAvailableAsync,
    sendFile,
    isWorkspaceFileRequest,
    serveWorkspaceFileRequest,
    serveWebLibRequest,
    serveStaticRequest,
    getMimeType,
    getWorkspaceFileHeaders,
};

// --- Agent-specific static routing ---
async function getAgentHostPath(agentName) {
    const cfg = readRouting();
    const rec = cfg && cfg.routes ? cfg.routes[agentName] : null;
    if (!rec || !rec.hostPath) return null;
    return directoryOrNull(rec.hostPath);
}

async function normalizeAgentHostPath(hostPath) {
    if (typeof hostPath !== 'string' || !hostPath.trim()) return null;
    return directoryOrNull(hostPath);
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

async function resolveAgentStaticFile(agentName, agentRelPath, options = {}) {
    const capturedHostPath = Object.prototype.hasOwnProperty.call(options, 'hostPath');
    const root = capturedHostPath
        ? await normalizeAgentHostPath(options.hostPath)
        : await getAgentHostPath(agentName);
    if (!root) return null;
    const allowedRoots = await getAgentAllowedRoots(agentName, capturedHostPath ? { hostPath: root } : {});
    const candidate = safeJoin(root, agentRelPath);
    if (!candidate) return null;
    try {
        if (!await isPathWithinAllowedRootsAsync(allowedRoots, candidate)) {
            return null;
        }
        const stat = await fs.promises.stat(candidate);
        if (stat.isDirectory()) {
            const indexFiles = ['index.html', 'index.htm', 'default.html'];
            for (const name of indexFiles) {
                const idx = path.join(candidate, name);
                try {
                    const idxStat = await fs.promises.stat(idx);
                    if (idxStat.isFile() && await isPathWithinAllowedRootsAsync(allowedRoots, idx)) return idx;
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

async function serveAgentStaticRequest(req, res, {
    routeKey = null,
    hostPath = null,
    beforeRead = null,
} = {}) {
    try {
        const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const pathname = decodeURIComponent(parsed.pathname || '/');
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length < 2) return false;
        const agent = parts[0];
        if (routeKey !== null && agent !== routeKey) return false;
        const rest = parts.slice(1).join('/');
        const target = await resolveAgentStaticFile(agent, rest, routeKey !== null ? { hostPath } : {});
        if (target) {
            if (typeof beforeRead === 'function' && beforeRead() !== true) {
                res.writeHead(503, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store',
                });
                res.end(JSON.stringify({ error: 'edge_generation_changed' }));
                return true;
            }
            if (await sendFile(res, target, { req, authenticated: true })) return true;
        }
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
            if (target && await sendFile(res, target, { req })) return true;
        }

        const root = getStaticHostPath();
        if (root) {
            const target = resolveStaticFile(pathname.replace(/^\/+/, ''));
            if (target && await sendFile(res, target, { req })) return true;
        }
    } catch (_) { }
    return false;
}

export { getAgentHostPath, resolveAgentStaticFile, serveAgentStaticRequest, servePublicAssetRequest };
