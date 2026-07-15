import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import { loadToken, parseCookies, buildCookie, readJsonBody, appendSetCookie } from './common.js';
import * as staticSrv from '../static/index.js';
import { PLOINKY_WORKSPACE_ROOT } from '../../services/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appName = 'dashboard';
const fallbackAppPath = path.join(__dirname, '../', appName);
const SID_COOKIE = `${appName}_sid`;

function renderTemplate(filenames, replacements) {
    const target = staticSrv.resolveFirstAvailable(appName, fallbackAppPath, filenames);
    if (!target) return null;
    let html = fs.readFileSync(target, 'utf8');
    for (const [key, value] of Object.entries(replacements || {})) {
        html = html.split(key).join(String(value ?? ''));
    }
    return html;
}

function getSession(req, appState) {
    const cookies = parseCookies(req);
    const sid = cookies.get(SID_COOKIE);
    return (sid && appState.sessions.has(sid)) ? sid : null;
}

function authorized(req, appState) {
    if (req.user) return true;
    return !!getSession(req, appState);
}

async function handleAuth(req, res, appConfig, appState) {
    if (req.user) {
        res.writeHead(400);
        res.end('SSO is enabled; legacy auth disabled.');
        return;
    }
    try {
        const token = loadToken(appName);
        const body = await readJsonBody(req);
        if (body && body.token && String(body.token).trim() === token) {
            const sid = crypto.randomBytes(16).toString('hex');
            appState.sessions.set(sid, { createdAt: Date.now() });
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': buildCookie(SID_COOKIE, sid, req, `/${appName}`)
            });
            res.end(JSON.stringify({ ok: true }));
        } else {
            res.writeHead(403);
            res.end('Forbidden');
        }
    } catch (_) {
        res.writeHead(400);
        res.end('Bad Request');
    }
}

function ensureAppSession(req, res, appState) {
    const cookies = parseCookies(req);
    let sid = cookies.get(SID_COOKIE);
    if (!sid) {
        sid = crypto.randomBytes(16).toString('hex');
        appState.sessions.set(sid, { createdAt: Date.now() });
        appendSetCookie(res, buildCookie(SID_COOKIE, sid, req, `/${appName}`));
    } else if (!appState.sessions.has(sid)) {
        appState.sessions.set(sid, { createdAt: Date.now() });
    }
    if (!cookies.has(SID_COOKIE)) {
        const existing = req.headers.cookie || '';
        req.headers.cookie = existing ? `${existing}; ${SID_COOKIE}=${sid}` : `${SID_COOKIE}=${sid}`;
    }
    return sid;
}

function handleDashboard(req, res, appConfig, appState) {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname.substring(`/${appName}`.length) || '/';

    if (pathname === '/auth' && req.method === 'POST') return handleAuth(req, res, appConfig, appState);
    if (pathname === '/whoami') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: authorized(req, appState) }));
    }

    if (req.user) {
        ensureAppSession(req, res, appState);
    }

    if (pathname.startsWith('/assets/')) {
        const rel = pathname.substring('/assets/'.length);
        const assetPath = staticSrv.resolveAssetPath(appName, fallbackAppPath, rel);
        if (assetPath && staticSrv.sendFile(res, assetPath)) return;
    }

    if (!authorized(req, appState)) {
        if (req.user) {
            res.writeHead(403);
            return res.end('Access forbidden');
        }
        const html = renderTemplate(['login.html', 'index.html'], {
            '__ASSET_BASE__': `/${appName}/assets`,
            '__AGENT_NAME__': appConfig.agentName || 'Dashboard',
            '__CONTAINER_NAME__': appConfig.containerName || '-',
            '__RUNTIME__': appConfig.runtime || 'local',
            '__REQUIRES_AUTH__': 'true',
            '__BASE_PATH__': `/${appName}`
        });
        if (html) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(html);
        }
        res.writeHead(403); return res.end('Forbidden');
    }

    if (pathname === '/' || pathname === '/index.html') {
        const html = renderTemplate(['dashboard.html', 'index.html'], {
            '__ASSET_BASE__': `/${appName}/assets`,
            '__AGENT_NAME__': appConfig.agentName || 'Dashboard',
            '__CONTAINER_NAME__': appConfig.containerName || '-',
            '__RUNTIME__': appConfig.runtime || 'local',
            '__REQUIRES_AUTH__': 'true',
            '__BASE_PATH__': `/${appName}`
        });
        if (html) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(html);
        }
    }

    if (pathname === '/run' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const { cmd } = JSON.parse(body);
                const args = (cmd || '').trim().split(/\s+/).filter(Boolean);
                const proc = spawn('ploinky', args, { cwd: PLOINKY_WORKSPACE_ROOT, env: { ...process.env, PLOINKY_CWD: PLOINKY_WORKSPACE_ROOT } });
                let out = ''; let err = '';
                proc.stdout.on('data', d => out += d.toString('utf8'));
                proc.stderr.on('data', d => err += d.toString('utf8'));
                proc.on('close', (code) => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, code, stdout: out, stderr: err }));
                });
            } catch (e) {
                res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    res.writeHead(404); res.end('Not Found in App');
}

export { handleDashboard };
