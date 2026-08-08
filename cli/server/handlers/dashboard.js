import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { readJsonBody } from './common.js';
import * as staticSrv from '../static/index.js';
import { requireAdminControlRequest } from '../adminControlSecurity.js';
import { PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';
import { DIRECT_CLI_PATH } from '../../utils/directCli.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appName = 'dashboard';
const fallbackAppPath = path.join(__dirname, '../', appName);
const MAX_COMMAND_LENGTH = 4096;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const RESTART_COMMAND_TIMEOUT_MS = 16 * 60_000;

export function resolveDashboardCommandTimeoutMs(args) {
    return args?.[0] === 'restart' ? RESTART_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
}

export function shouldDetachDashboardCommand(platform = process.platform) {
    return platform !== 'win32';
}

export function terminateDashboardCommand(proc, {
    platform = process.platform,
    killProcess = process.kill,
} = {}) {
    const pid = Number(proc?.pid);
    if (shouldDetachDashboardCommand(platform) && Number.isSafeInteger(pid) && pid > 1) {
        try {
            killProcess(-pid, 'SIGTERM');
            return 'group';
        } catch (_) {}
    }
    if (typeof proc?.kill !== 'function') return 'failed';
    try {
        proc.kill('SIGTERM');
        return 'process';
    } catch (_) {
        return 'failed';
    }
}

function renderTemplate(filenames, replacements) {
    const target = staticSrv.resolveFirstAvailable(appName, fallbackAppPath, filenames);
    if (!target) return null;
    let html = fs.readFileSync(target, 'utf8');
    for (const [key, value] of Object.entries(replacements || {})) {
        html = html.split(key).join(String(value ?? ''));
    }
    return html;
}

function handleDashboard(req, res, appConfig, appState) {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname.substring(`/${appName}`.length) || '/';

    // Dashboard is a local control surface and always requires a real Router
    // administrator session.
    if (!requireAdminControlRequest(req, res)) return;
    if (pathname === '/whoami') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, admin: true }));
    }

    if (pathname.startsWith('/assets/')) {
        const rel = pathname.substring('/assets/'.length);
        const assetPath = staticSrv.resolveAssetPath(appName, fallbackAppPath, rel);
        if (assetPath && staticSrv.sendFile(res, assetPath)) return;
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
        if (!requireAdminControlRequest(req, res, { mutation: true })) return;
        readJsonBody(req).then((body) => {
            try {
                const cmd = String(body?.cmd || '').trim();
                if (!cmd || cmd.length > MAX_COMMAND_LENGTH) {
                    res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify({ ok: false, error: 'invalid_command' }));
                    return;
                }
                const args = cmd.split(/\s+/).filter(Boolean);
                const proc = spawn(DIRECT_CLI_PATH, args, {
                    cwd: PLOINKY_WORKSPACE_ROOT,
                    env: { ...process.env, PLOINKY_CWD: PLOINKY_WORKSPACE_ROOT },
                    detached: shouldDetachDashboardCommand(),
                });
                let out = ''; let err = '';
                let outputBytes = 0;
                let finished = false;
                const timer = setTimeout(() => {
                    if (finished) return;
                    finished = true;
                    terminateDashboardCommand(proc);
                    res.writeHead(504, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify({ ok: false, error: 'command_timeout' }));
                }, resolveDashboardCommandTimeoutMs(args));
                timer.unref?.();
                const collect = (target) => (chunk) => {
                    outputBytes += chunk.length;
                    if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
                        if (!finished) {
                            finished = true;
                            clearTimeout(timer);
                            terminateDashboardCommand(proc);
                            res.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                            res.end(JSON.stringify({ ok: false, error: 'command_output_limit' }));
                        }
                        return;
                    }
                    if (target === 'stdout') out += chunk.toString('utf8');
                    else err += chunk.toString('utf8');
                };
                proc.stdout.on('data', collect('stdout'));
                proc.stderr.on('data', collect('stderr'));
                proc.on('close', (code) => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify({ ok: true, code, stdout: out, stderr: err }));
                });
                proc.on('error', (error) => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify({ ok: false, error: error?.message || 'spawn_failed' }));
                });
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        }).catch(() => {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
        });
        return;
    }

    res.writeHead(404); res.end('Not Found in App');
}

export { handleDashboard };
