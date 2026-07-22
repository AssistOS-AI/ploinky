import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveWebchatCommandsForAgent } from '../../webchat/commandResolver.js';
import * as staticSrv from '../../static/index.js';
import {
    handleWebchatUploadGet,
    handleWebchatUploadPost,
    resolveWebchatUploadContext,
} from './uploads.js';
import {
    buildWebchatQuery,
    resolveWebchatLaunchOptions
} from './launchOptions.js';
import {
    handleSuggestionsFiles,
    resolveWebchatWorkspaceBase
} from './workspaceSuggestions.js';
import {
    authorized,
    ensureAppSession,
    getSession,
    handleLogout,
    redirectToRouterLogin
} from './browserSession.js';
import { handleConversationRoute } from './conversationRoutes.js';
import { handleRuntimeRoute } from './runtimeRoutes.js';
import { handleTaskRoute } from './taskRoutes.js';
import { ensureCurrentSession } from '../../webchat/sessionStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appName = 'webchat';
const fallbackAppPath = path.join(__dirname, '..', '..', appName);
function renderTemplate(filenames, replacements) {
    const target = staticSrv.resolveFirstAvailable(appName, fallbackAppPath, filenames);
    if (!target) return null;
    let html = fs.readFileSync(target, 'utf8');
    for (const [key, value] of Object.entries(replacements || {})) {
        html = html.split(key).join(String(value ?? ''));
    }
    return html;
}

export async function handleWebChat(req, res, appConfig, appState) {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname.substring(`/${appName}`.length) || '/';
    const agentOverrideRaw = parsedUrl.searchParams.get('agent') || '';
    const agentOverride = agentOverrideRaw.trim();
    const launchOptions = resolveWebchatLaunchOptions(parsedUrl);
    let effectiveConfig = appConfig;
    let agentQuery = buildWebchatQuery(parsedUrl);

    if (agentOverride) {
        const overrideCommands = resolveWebchatCommandsForAgent(agentOverride, {
            cliArgs: launchOptions.cliArgs
        });
        if (!overrideCommands) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Agent not found or not enabled.');
            return;
        }
        if (typeof appConfig.getFactoryForCommands !== 'function') {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Dynamic agent selection unavailable.');
            return;
        }
        const overrideConfig = appConfig.getFactoryForCommands(overrideCommands);
        if (!overrideConfig || !overrideConfig.ttyFactory) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Unable to start agent session.');
            return;
        }
        effectiveConfig = overrideConfig;
        agentQuery = buildWebchatQuery(parsedUrl, overrideCommands.agentName || agentOverride);
    }

    if (pathname === '/auth' && req.method === 'POST') {
        res.writeHead(410, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({
            ok: false,
            error: 'surface_token_auth_removed',
            detail: 'Use the router login page.'
        }));
    }
    if (pathname === '/logout' && req.method === 'POST') return handleLogout(req, res, appState, agentQuery);

    if (pathname.startsWith('/assets/')) {
        const rel = pathname.substring('/assets/'.length);
        const assetPath = staticSrv.resolveAssetPath(appName, fallbackAppPath, rel);
        if (assetPath && staticSrv.sendFile(res, assetPath)) return;
    }

    if (req.user) {
        ensureAppSession(req, res, appState);
    }

    if (!authorized(req)) {
        return redirectToRouterLogin(req, res, parsedUrl, agentOverride);
    }

    const workspaceBase = resolveWebchatWorkspaceBase(parsedUrl);
    const workspaceDirectory = workspaceBase.base;

    if (await handleConversationRoute({ pathname, req, res, workspaceDirectory, appState })) return;
    if (await handleTaskRoute({
        pathname,
        req,
        res,
        parsedUrl,
        workspaceDirectory,
        appState,
        renderTaskView: () => renderTemplate(['task-view.html'], {
            '__ASSET_BASE__': `/${appName}/assets`,
        }),
    })) return;

    if (pathname === '/suggestions/files' && (req.method === 'GET' || req.method === 'HEAD')) {
        return handleSuggestionsFiles(req, res, parsedUrl);
    }

    if (pathname === '/uploads') {
        const sessionId = getSession(req, appState);
        const uploadContext = resolveWebchatUploadContext({ workspaceBase, sessionId });
        if (req.method === 'POST' || req.method === 'PUT') {
            return handleWebchatUploadPost(req, res, parsedUrl, uploadContext);
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
            return handleWebchatUploadGet(req, res, parsedUrl, uploadContext);
        }
        res.writeHead(405, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            Allow: 'GET, HEAD, POST, PUT',
        });
        return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    }

    if (pathname === '/' || pathname === '/index.html') {
        try {
            ensureCurrentSession(workspaceDirectory);
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            return res.end(`Unable to initialize WebChat history: ${error?.message || 'session_store_unavailable'}`);
        }
        const html = renderTemplate(['chat.html', 'index.html'], {
            '__ASSET_BASE__': `/${appName}/assets`,
            '__AGENT_NAME__': effectiveConfig.agentName || '',
            '__DISPLAY_NAME__': effectiveConfig.displayName || effectiveConfig.agentName || 'WebChat',
            '__RUNTIME__': effectiveConfig.runtime || 'local',
            '__BASE_PATH__': `/${appName}`,
            '__AGENT_QUERY__': agentQuery,
            '__WORKDIR__': workspaceBase.base,
            '__WORKSPACE_BASE__': encodeURIComponent(workspaceBase.relativeBase || ''),
        });
        if (html) {
            res.writeHead(200, {
                'Content-Type': 'text/html',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            return res.end(html);
        }
    }

    if (pathname === '/stream'
        || (pathname === '/input' && req.method === 'POST')
        || (pathname === '/control' && req.method === 'POST')
        || (pathname === '/interaction' && req.method === 'POST')) {
        return handleRuntimeRoute({
            pathname,
            req,
            res,
            parsedUrl,
            appState,
            workspaceDirectory,
            effectiveConfig,
            agentQuery
        });
    }

    res.writeHead(404); res.end(', Not Found in App');
}
