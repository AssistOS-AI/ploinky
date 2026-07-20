import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import * as staticSrv from '../static/index.js';
import { requireAdminControlRequest } from '../adminControlSecurity.js';
import { ROUTING_FILE, PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';
import { getAllServerStatuses } from '../serverManager.js';
import { loadAgents } from '../../utils/workspace.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appName = 'status';
const fallbackAppPath = path.join(__dirname, '../', appName);

function renderTemplate(filenames, replacements) {
    const target = staticSrv.resolveFirstAvailable(appName, fallbackAppPath, filenames);
    if (!target) return null;
    let html = fs.readFileSync(target, 'utf8');
    for (const [key, value] of Object.entries(replacements || {})) {
        html = html.split(key).join(String(value ?? ''));
    }
    return html;
}

function runStatusCommand() {
    return new Promise((resolve) => {
        let resolved = false;
        const finish = (payload) => {
            if (resolved) return;
            resolved = true;
            resolve(payload);
        };
        try {
            const proc = spawn('ploinky', ['status'], {
                cwd: PLOINKY_WORKSPACE_ROOT,
                env: { ...process.env, PLOINKY_CWD: PLOINKY_WORKSPACE_ROOT },
            });
            let out = '';
            let err = '';
            proc.stdout.on('data', chunk => out += chunk.toString('utf8'));
            proc.stderr.on('data', chunk => err += chunk.toString('utf8'));
            proc.on('close', (code) => {
                finish({ code, stdout: out, stderr: err });
            });
            proc.on('error', (error) => {
                const message = error && error.message ? error.message : String(error || 'spawn error');
                finish({ code: -1, stdout: out, stderr: message });
            });
        } catch (e) {
            finish({ code: -1, stdout: '', stderr: e?.message || String(e) });
        }
    });
}

function collectServerStatuses() {
    try {
        return getAllServerStatuses();
    } catch (_) {
        return {};
    }
}

function collectWorkspaceAgents() {
    try {
        const map = loadAgents() || {};
        return Object.entries(map)
            .filter(([key]) => key !== '_config')
            .map(([container, rec]) => ({
                container,
                agentName: rec?.agentName || container,
                repoName: rec?.repoName || '',
                image: rec?.containerImage || ''
            }));
    } catch (_) {
        return [];
    }
}

function collectStaticInfo() {
    try {
        const routing = JSON.parse(fs.readFileSync(ROUTING_FILE, 'utf8')) || {};
        const staticAgent = routing?.static?.agent || null;
        const shortAgentName = typeof staticAgent === 'string' && staticAgent.includes('/')
            ? staticAgent.split('/').pop()
            : staticAgent;
        const routes = routing?.routes && typeof routing.routes === 'object' ? routing.routes : {};
        const routeEntry = routes[staticAgent] || routes[shortAgentName] || Object.values(routes).find((route) => {
            const routeRef = route?.repo && route?.agent ? `${route.repo}/${route.agent}` : '';
            return routeRef === staticAgent;
        }) || {};
        const hostPath = routing?.static?.hostPath || routeEntry.hostPath || null;
        let repo = null;
        if (hostPath) {
            // Extract repo name from path like /path/to/.ploinky/repos/repoName/agentName
            const pathParts = hostPath.split(path.sep);
            const reposIndex = pathParts.indexOf('repos');
            if (reposIndex !== -1 && reposIndex < pathParts.length - 1) {
                repo = pathParts[reposIndex + 1];
            } else {
                // Fallback: get parent directory name
                repo = path.basename(path.dirname(hostPath));
            }
        }
        return {
            agent: staticAgent,
            hostPath,
            port: routing?.port || null,
            repo: repo
        };
    } catch (_) {
        return { agent: null, hostPath: null, port: null, repo: null };
    }
}

function handleStatus(req, res) {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname.substring(`/${appName}`.length) || '/';

    if (!requireAdminControlRequest(req, res)) return;

    if (pathname.startsWith('/assets/')) {
        const rel = pathname.substring('/assets/'.length);
        const assetPath = staticSrv.resolveAssetPath(appName, fallbackAppPath, rel);
        if (assetPath && staticSrv.sendFile(res, assetPath)) return;
    }

    if (pathname === '/' || pathname === '/index.html') {
        const html = renderTemplate(['status.html', 'index.html'], {
            '__ASSET_BASE__': `/${appName}/assets`,
            '__AGENT_NAME__': 'Status',
            '__CONTAINER_NAME__': '-',
            '__RUNTIME__': 'local',
            '__REQUIRES_AUTH__': 'true',
            '__BASE_PATH__': `/${appName}`
        });
        if (html) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(html);
        }
    }

    if (pathname === '/data') {
        Promise.all([runStatusCommand()]).then(([result]) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            const payload = {
                ok: true,
                code: result.code,
                output: result.stdout || result.stderr || '',
                servers: collectServerStatuses(),
                static: collectStaticInfo(),
                agents: collectWorkspaceAgents()
            };
            res.end(JSON.stringify(payload));
        });
        return;
    }

    res.writeHead(404);
    res.end('Not Found in App');
}

export { handleStatus };
