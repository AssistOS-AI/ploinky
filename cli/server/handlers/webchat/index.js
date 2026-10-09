import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    resolveWebchatCommandsForAgentAsync,
    resolveWebchatCommandsForBindingAsync
} from '../../webchat/commandResolver.js';
import * as staticSrv from '../../static/index.js';
import {
    handleWebchatUploadPost,
    resolveWebchatUploadContext,
} from './uploads.js';
import {
    handleWorkspaceDirectoriesGet,
    handleWorkspaceDirectoriesPost,
} from './workspaceDirectories.js';
import {
    buildWebchatQuery,
    resolveWebchatLaunchOptionsAsync
} from './launchOptions.js';
import {
    handleSuggestionsFiles,
    resolveWebchatWorkspaceBaseAsync
} from './workspaceSuggestions.js';
import {
    authorized,
    ensureAppSession,
    handleLogout,
    redirectToRouterLogin
} from './browserSession.js';
import { handleRuntimeRoute } from './runtimeRoutes.js';
import { handleTaskRoute } from './taskRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appName = 'webchat';
const fallbackAppPath = path.join(__dirname, '..', '..', appName);
// Workspace paths are the selected host path inside the Box and may contain
// any character a directory name allows, so they are escaped as attribute text.
function escapeHtmlAttribute(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

async function renderTemplate(filenames, replacements) {
    const target = await staticSrv.resolveFirstAvailableAsync(appName, fallbackAppPath, filenames);
    if (!target) return null;
    const html = await fs.promises.readFile(target, 'utf8');
    // Values can themselves contain template-looking directory names. Only
    // replace placeholders from the original template, never inserted values.
    return html.replace(/__[A-Z_]+__/g, (key) => (
        Object.hasOwn(replacements || {}, key) ? String(replacements[key] ?? '') : key
    ));
}

const HELPER_PATHS = new Set(['/uploads', '/directories', '/suggestions/files', '/tasks']);
const RUNTIME_PATHS = new Set(['/', '/index.html', '/stream', '/input', '/control', '/interaction']);
// Guests keep only protocol identifiers; no query value becomes a path or flag.
const GUEST_QUERY_KEYS = ['agent', 'tabId', 'pageInstanceId', 'sessionId'];

function webchatPathClass(pathname) {
    if (HELPER_PATHS.has(pathname) || pathname.startsWith('/tasks/')) return 'helper';
    if (RUNTIME_PATHS.has(pathname)) return 'runtime';
    return 'other';
}

function guestProtocolUrl(parsedUrl) {
    const scoped = new URL(parsedUrl.pathname, parsedUrl.origin);
    for (const key of GUEST_QUERY_KEYS) {
        for (const value of parsedUrl.searchParams.getAll(key)) scoped.searchParams.append(key, value);
    }
    return scoped;
}

// A guest reaches a runtime only for the surface owner itself, when that owner
// declares `webchat.auth: "self"` and admitted this request as a guest.
function admitsGuestRuntime(req, binding) {
    const context = req.edgeAuthContext || {};
    return Boolean(binding)
        && binding.declaration === 'self'
        && Boolean(binding.target)
        && binding.target === binding.ownerRouteKey
        && context.routeKey === binding.target
        && context.mode === 'guest'
        && req.authMode === 'guest';
}

function denyJson(res, status, error) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error }));
}

export async function handleWebChat(req, res, appConfig, appState) {
    if (req.destroyed || res.destroyed) return;
    let parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname.substring(`/${appName}`.length) || '/';
    const pathClass = webchatPathClass(pathname);
    const guest = req.authMode === 'guest';
    const binding = req.edgeAuthContext?.webchatBinding || null;
    // These guards run before any workspace path, launch option or command is
    // derived from the request.
    if (guest && pathClass === 'helper') return denyJson(res, 403, 'guest_workspace_access_denied');
    if (pathClass === 'runtime') {
        if (guest && !admitsGuestRuntime(req, binding)) return denyJson(res, 403, 'guest_webchat_target_denied');
        if (!binding) {
            if (!authorized(req)) return redirectToRouterLogin(req, res, parsedUrl, '');
            return denyJson(res, 503, 'webchat_target_binding_unavailable');
        }
    }
    if (guest) parsedUrl = guestProtocolUrl(parsedUrl);
    const agentOverrideRaw = parsedUrl.searchParams.get('agent') || '';
    const agentOverride = agentOverrideRaw.trim();
    // The binding was computed from this request's selector; a different one
    // means the request changed after authorization.
    if (pathClass === 'runtime' && String(binding.selector || '') !== agentOverride) {
        return denyJson(res, 503, 'webchat_target_changed');
    }
    let launchOptions, workspaceBase;
    try {
        workspaceBase = await resolveWebchatWorkspaceBaseAsync(parsedUrl);
        if (req.destroyed || res.destroyed) return;
        launchOptions = guest
            ? { cliArgs: [] }
            : await resolveWebchatLaunchOptionsAsync(parsedUrl, { workspaceBase });
        if (req.destroyed || res.destroyed) return;
    } catch (_) {
        if (req.destroyed || res.destroyed) return;
        res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('Invalid WebChat workspace directory.');
        return;
    }
    if (typeof appConfig === 'function') {
        appConfig = await appConfig({ req, res, workspaceBase, launchOptions });
        if (req.destroyed || res.destroyed) return;
    }
    let effectiveConfig = appConfig;
    let agentQuery = buildWebchatQuery(parsedUrl);

    if (pathClass === 'runtime') {
        // Explicit and omitted selectors both launch the bound target. As
        // before, only an explicit selector launch carries query launch flags.
        const boundCommands = await resolveWebchatCommandsForBindingAsync(binding, {
            cliArgs: agentOverride ? launchOptions.cliArgs : []
        });
        if (req.destroyed || res.destroyed) return;
        if (!boundCommands || boundCommands.changed) return denyJson(res, 503, 'webchat_target_changed');
        if (typeof appConfig?.getFactoryForCommands !== 'function') {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Dynamic agent selection unavailable.');
            return;
        }
        const boundConfig = appConfig.getFactoryForCommands(boundCommands);
        if (!boundConfig || !boundConfig.ttyFactory) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Unable to start agent session.');
            return;
        }
        // Every guest gets a runtime of its own session principal.
        effectiveConfig = guest ? { ...boundConfig, runtimeScope: 'principal' } : boundConfig;
        agentQuery = buildWebchatQuery(parsedUrl, agentOverride ? boundCommands.agentName : '');
    } else if (agentOverride) {
        const overrideCommands = await resolveWebchatCommandsForAgentAsync(agentOverride, {
            cliArgs: launchOptions.cliArgs
        });
        if (req.destroyed || res.destroyed) return;
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
        const assetPath = await staticSrv.resolveAssetPathAsync(appName, fallbackAppPath, rel);
        if (req.destroyed || res.destroyed) return;
        if (assetPath && await staticSrv.sendFile(res, assetPath, { req })) return;
        if (req.destroyed || res.destroyed) return;
    }

    if (req.user) {
        ensureAppSession(req, res, appState);
    }

    if (!authorized(req)) {
        return redirectToRouterLogin(req, res, parsedUrl, agentOverride);
    }

    const workspaceDirectory = workspaceBase.base;

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
    if (req.destroyed || res.destroyed) return;

    if (pathname === '/suggestions/files' && (req.method === 'GET' || req.method === 'HEAD')) {
        return handleSuggestionsFiles(req, res, parsedUrl);
    }

    if (pathname === '/uploads') {
        const uploadContext = resolveWebchatUploadContext({ workspaceBase });
        if (req.method === 'POST' || req.method === 'PUT') {
            return handleWebchatUploadPost(req, res, parsedUrl, uploadContext);
        }
        res.writeHead(405, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            Allow: 'POST, PUT',
        });
        return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    }

    if (pathname === '/directories') {
        const directoryContext = resolveWebchatUploadContext({ workspaceBase });
        if (req.method === 'GET' || req.method === 'HEAD') {
            return handleWorkspaceDirectoriesGet(req, res, parsedUrl, directoryContext);
        }
        if (req.method === 'POST') {
            return handleWorkspaceDirectoriesPost(req, res, directoryContext);
        }
        res.writeHead(405, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            Allow: 'GET, HEAD, POST',
        });
        return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    }

    if (pathname === '/' || pathname === '/index.html') {
        const html = await renderTemplate(['chat.html', 'index.html'], {
            '__ASSET_BASE__': `/${appName}/assets`,
            '__AGENT_NAME__': effectiveConfig.agentName || '',
            '__DISPLAY_NAME__': effectiveConfig.displayName || effectiveConfig.agentName || 'WebChat',
            '__RUNTIME__': effectiveConfig.runtime || 'local',
            '__BASE_PATH__': `/${appName}`,
            '__AGENT_QUERY__': agentQuery,
            '__WORKDIR__': escapeHtmlAttribute(workspaceBase.base),
            '__WORKSPACE_ROOT__': escapeHtmlAttribute(workspaceBase.root),
            '__WORKSPACE_BASE__': encodeURIComponent(workspaceBase.relativeBase || ''),
        });
        if (req.destroyed || res.destroyed) return;
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
