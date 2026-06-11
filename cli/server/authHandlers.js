import fs from 'fs';
import path from 'path';

import { appendLog } from './utils/logger.js';
import { parseCookies, buildCookie, readJsonBody, appendSetCookie } from './handlers/common.js';
import { resolveVarValue } from '../services/secretVars.js';
import { resolveEnabledAgentRecord } from '../services/agents.js';
import { ROUTING_FILE } from '../services/config.js';
import { findAgent } from '../services/utils.js';
import { readRouterSettings, updateRouterSettings } from '../services/routerSettings.js';
import { createAuthService } from './auth/service.js';
import { authenticateLocalUser, createLocalAuthUser, deleteLocalAuthUser, GUEST_SESSION_TTL_SECONDS, getSession as getLocalSession, getSessionCookieMaxAge as getLocalSessionCookieMaxAge, isLocalAdminUser, listLocalAuthUsers, mintGuestSessionJwt, mintSessionJwt, resolveLocalAuthConfig, resolveUserRev, revokeSession as revokeLocalSession, updateLocalAuthUser, updateLocalCredentials, verifySessionJwt } from './auth/localService.js';
import { revokeSessionId } from './auth/sessionRevocations.js';
import { waitForAgentReady } from './utils/agentReadiness.js';

const SSO_AUTH_COOKIE_NAME = 'ploinky_sso';
const LOCAL_AUTH_COOKIE_NAME = 'ploinky_jwt';
const GUEST_AUTH_COOKIE_NAME = 'ploinky_guest';
const authService = createAuthService();

export function sendJson(res, statusCode, body) {
    const payload = JSON.stringify(body || {});
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(payload);
}

function getRequestBaseUrl(req) {
    const headers = req.headers || {};
    const forwardedProto = headers['x-forwarded-proto'];
    const forwardedHost = headers['x-forwarded-host'] || headers['host'];
    const proto = forwardedProto
        ? String(forwardedProto).split(',')[0].trim()
        : (req.socket && req.socket.encrypted ? 'https' : 'http');
    if (!forwardedHost) return null;
    return `${proto}://${forwardedHost}`;
}

function wantsJsonResponse(req, pathname) {
    const accept = String(req.headers?.accept || '').toLowerCase();
    if (accept.includes('application/json')) return true;
    if (accept.includes('text/event-stream')) return true;
    if (!pathname) return false;
    return pathname.startsWith('/apis/') || pathname.startsWith('/api/') || pathname.startsWith('/blobs');
}

function normalizeRelativePath(value, fallback = '/') {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return fallback;
    try {
        const parsed = new URL(raw, 'http://localhost');
        if (parsed.origin !== 'http://localhost') {
            return fallback;
        }
        const normalized = `${parsed.pathname || '/'}${parsed.search || ''}${parsed.hash || ''}`;
        return normalized.startsWith('/') ? normalized : fallback;
    } catch (_) {
        return fallback;
    }
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderLoggedOutHtml(nextPath) {
    const safeNext = normalizeRelativePath(nextPath, '/webchat/');
    const loginUrl = `/auth/login?returnTo=${encodeURIComponent(safeNext)}&prompt=login`;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Signed Out</title>
  <style>
    ${getAuthPageStyles()}
  </style>
</head>
<body>
  <main class="auth-shell">
    <section class="auth-card">
      <h1>Signed out</h1>
      <p>Your session was closed. Sign in again to return to the workspace.</p>
      <a class="auth-btn" href="${escapeHtml(loginUrl)}">Sign in</a>
    </section>
  </main>
</body>
</html>`;
}


function renderExternalAccountHtml({
    providerLabel = 'GitHub',
    returnTo = '/',
    username = ''
} = {}) {
    const safeReturnTo = escapeHtml(normalizeRelativePath(returnTo, '/'));
    const safeUsername = escapeHtml(username || '');
    const safeProvider = escapeHtml(providerLabel || 'GitHub');
    const safeLogoutUrl = escapeHtml(`/auth/logout?returnTo=${encodeURIComponent(normalizeRelativePath(returnTo, '/'))}`);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Account</title>
  <style>
    ${getAuthPageStyles()}
  </style>
</head>
<body>
  <main class="auth-shell">
    <section class="auth-card">
      <div class="auth-kicker">Workspace Access</div>
      <h1>${safeProvider}</h1>
      <p>${safeUsername ? `${safeUsername} is signed in with ${safeProvider}.` : `This workspace session uses ${safeProvider} sign-in.`}</p>
      <p>Local account settings are not available for this sign-in method.</p>
      <div class="auth-actions">
        <a class="auth-btn secondary" href="${safeReturnTo}">Back</a>
        <a class="auth-btn" href="${safeLogoutUrl}">Sign out</a>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function getAuthPageStyles() {
    return `
    :root {
      color-scheme: light;
      --auth-ink: #1f2933;
      --auth-ink-soft: #4b5563;
      --auth-line: rgba(31, 41, 51, 0.12);
      --auth-paper: rgba(255,255,255,0.94);
      --auth-accent: #2563eb;
      --auth-accent-strong: #1d4ed8;
      --auth-bg-a: #f4f5f7;
      --auth-bg-b: #dbeafe;
      --auth-shadow: 0 24px 80px rgba(15, 23, 42, 0.14);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, "Segoe UI", Arial, sans-serif;
      color: var(--auth-ink);
      background:
        radial-gradient(circle at top left, rgba(37,99,235,0.18), transparent 30%),
        radial-gradient(circle at bottom right, rgba(147,197,253,0.28), transparent 32%),
        linear-gradient(135deg, var(--auth-bg-a), var(--auth-bg-b));
    }
    .auth-shell {
      min-height: 100vh;
      display: grid;
      gap: 28px;
      align-content: center;
      justify-content: center;
      padding: 32px;
    }
    .auth-card, .auth-side {
      border: 1px solid var(--auth-line);
      border-radius: 24px;
      backdrop-filter: blur(12px);
      background: var(--auth-paper);
      box-shadow: var(--auth-shadow);
    }
    .auth-card {
      padding: 32px;
    }
    .auth-side {
      padding: 28px;
      align-self: stretch;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0.94)),
        linear-gradient(135deg, rgba(37,99,235,0.14), rgba(147,197,253,0.18));
    }
    .auth-kicker, .auth-side-label {
      text-transform: uppercase;
      letter-spacing: 0.14em;
      font-size: 11px;
      color: var(--auth-ink-soft);
      margin-bottom: 10px;
    }
    h1, .auth-side-title {
      margin: 0;
      line-height: 1.05;
      font-weight: 800;
      letter-spacing: -0.03em;
    }
    h1 {
      font-size: clamp(30px, 4vw, 40px);
      margin-bottom: 12px;
    }
    .auth-side-title {
      font-size: clamp(24px, 3vw, 32px);
      margin-bottom: 14px;
    }
    p {
      margin: 0 0 18px;
      color: var(--auth-ink-soft);
      line-height: 1.6;
      font-size: 15px;
    }
    label {
      display: block;
      margin: 14px 0 8px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--auth-ink-soft);
    }
    input {
      width: 100%;
      border: 1px solid rgba(31, 41, 51, 0.14);
      border-radius: 14px;
      padding: 13px 14px;
      font: inherit;
      color: var(--auth-ink);
      background: rgba(255,255,255,0.88);
      outline: none;
      transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;
    }
    input:focus {
      border-color: rgba(37, 99, 235, 0.5);
      box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.12);
      transform: translateY(-1px);
    }
    .auth-btn {
      display: inline-flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      margin-top: 20px;
      padding: 13px 16px;
      border: 0;
      border-radius: 14px;
      background: linear-gradient(135deg, var(--auth-accent), var(--auth-accent-strong));
      color: white;
      text-decoration: none;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 18px 38px rgba(37, 99, 235, 0.26);
    }
    .auth-btn.secondary {
      background: transparent;
      color: var(--auth-ink);
      box-shadow: none;
      border: 1px solid var(--auth-line);
    }
    .auth-btn.is-loading {
      position: relative;
      pointer-events: none;
      opacity: 0.78;
    }
    .auth-btn-spinner {
      width: 14px;
      height: 14px;
      margin-right: 8px;
      border-radius: 999px;
      border: 2px solid currentColor;
      border-right-color: transparent;
      animation: auth-spin .7s linear infinite;
      display: inline-block;
      flex: 0 0 auto;
    }
    @keyframes auth-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .auth-error {
      margin-bottom: 12px;
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(198, 40, 40, 0.08);
      color: #b3261e;
      font-size: 14px;
    }
    .auth-notice {
      margin-bottom: 12px;
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(37, 99, 235, 0.08);
      color: #1d4ed8;
      font-size: 14px;
    }
    .auth-meta {
      margin-top: 14px;
      font-size: 12px;
      color: var(--auth-ink-soft);
      word-break: break-word;
    }
    .auth-meta a {
      color: var(--auth-accent-strong);
    }
    .auth-actions {
      display: flex;
      gap: 12px;
      margin-top: 18px;
    }
    .auth-actions .auth-btn {
      margin-top: 0;
    }
    @media (max-width: 900px) {
      .auth-shell {
        grid-template-columns: 1fr;
        padding: 20px;
      }
      .auth-side {
        order: -1;
      }
    }`;
}

function renderLocalLoginHtml({ agentName, returnTo = '/', error = '', notice = '', usersVar = '' } = {}) {
    const safeAgent = escapeHtml(agentName || 'application');
    const safeReturnTo = escapeHtml(normalizeRelativePath(returnTo, '/'));
    const safeError = escapeHtml(error || '');
    const safeNotice = escapeHtml(notice || '');
    const safeBrandingName = escapeHtml(readRouterSettings().loginBrandingName);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeBrandingName}</title>
  <style>
    ${getAuthPageStyles()}
  </style>
</head>
<body>
  <main class="auth-shell">
    <section class="auth-card">
      <h1>${safeBrandingName}</h1>
      ${safeNotice ? `<div class="auth-notice">${safeNotice}</div>` : ''}
      ${safeError ? `<div class="auth-error">${safeError}</div>` : ''}
      <form method="post" action="/auth/login">
        <input type="hidden" name="agent" value="${safeAgent}" />
        <input type="hidden" name="returnTo" value="${safeReturnTo}" />
        <label for="username">Username</label>
        <input id="username" name="username" type="text" autocomplete="username" required />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button class="auth-btn" type="submit">Sign in</button>
      </form>
    </section>
  </main>
  <script>
    (() => {
      const form = document.querySelector('form[action="/auth/login"]');
      const button = form?.querySelector('button[type="submit"]');
      if (!form || !button) return;
      form.addEventListener('submit', () => {
        if (button.classList.contains('is-loading')) return;
        button.classList.add('is-loading');
        button.disabled = true;
        button.innerHTML = '<span class="auth-btn-spinner" aria-hidden="true"></span><span>Signing in...</span>';
      });
    })();
  </script>
</body>
</html>`;
}

function renderLocalAccountHtml({
    agentName,
    returnTo = '/',
    error = '',
    notice = '',
    username = '',
    usersVar = ''
} = {}) {
    const safeAgent = escapeHtml(agentName || 'application');
    const safeReturnTo = escapeHtml(normalizeRelativePath(returnTo, '/'));
    const safeError = escapeHtml(error || '');
    const safeNotice = escapeHtml(notice || '');
    const safeUsername = escapeHtml(username || '');
    const safeUsersVar = escapeHtml(usersVar || '');
    const safeLogoutUrl = escapeHtml(`/auth/logout?returnTo=${encodeURIComponent(normalizeRelativePath(returnTo, '/'))}`);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Account settings</title>
  <style>
    ${getAuthPageStyles()}
  </style>
</head>
<body>
  <main class="auth-shell">
    <section class="auth-card">
      <div class="auth-kicker">Workspace Access</div>
      <h1>Account settings</h1>
      <p>Update the local credentials for ${safeAgent}. Confirm the current password before saving any change.</p>
      ${safeNotice ? `<div class="auth-notice">${safeNotice}</div>` : ''}
      ${safeError ? `<div class="auth-error">${safeError}</div>` : ''}
      <form method="post" action="/auth/account">
        <input type="hidden" name="returnTo" value="${safeReturnTo}" />
        <label for="newUsername">Username</label>
        <input id="newUsername" name="newUsername" type="text" autocomplete="username" value="${safeUsername}" required />
        <label for="newPassword">New password</label>
        <input id="newPassword" name="newPassword" type="password" autocomplete="new-password" />
        <label for="confirmPassword">Confirm new password</label>
        <input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" />
        <label for="currentPassword">Current password</label>
        <input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required />
        <button class="auth-btn" type="submit">Save changes</button>
      </form>
      <div class="auth-actions">
        <a class="auth-btn secondary" href="${safeReturnTo}">Back</a>
        <a class="auth-btn secondary" href="${safeLogoutUrl}">Sign out</a>
      </div>
      <div class="auth-meta">Leave the new password fields empty if you only want to change the username.</div>
      ${safeUsersVar ? `<div class="auth-meta">Workspace variable: ${safeUsersVar}</div>` : ''}
    </section>
  </main>
  <script>
    (() => {
      const form = document.querySelector('form[action="/auth/account"]');
      const button = form?.querySelector('button[type="submit"]');
      if (!form || !button) return;
      form.addEventListener('submit', () => {
        if (button.classList.contains('is-loading')) return;
        button.classList.add('is-loading');
        button.disabled = true;
        button.innerHTML = '<span class="auth-btn-spinner" aria-hidden="true"></span><span>Saving...</span>';
      });
    })();
  </script>
</body>
</html>`;
}

function renderSsoLoginHtml({ agentName, returnTo = '/', redirectUrl = '' } = {}) {
    const safeAgent = escapeHtml(agentName || 'application');
    const safeReturnTo = escapeHtml(normalizeRelativePath(returnTo, '/'));
    const safeRedirectUrl = escapeHtml(redirectUrl || '#');
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in</title>
  <style>
    ${getAuthPageStyles()}
  </style>
</head>
<body>
  <main class="auth-shell">
    <section class="auth-card">
      <div class="auth-kicker">Workspace Access</div>
      <h1>Continue with Single Sign-On</h1>
      <p>You are signing in to ${safeAgent}. Redirecting to the identity provider now.</p>
      <div class="auth-actions">
        <a class="auth-btn" href="${safeRedirectUrl}">Continue</a>
        <a class="auth-btn secondary" href="${safeReturnTo}">Back</a>
      </div>
      <div class="auth-meta">If nothing happens, use Continue to open the sign-in page.</div>
    </section>
    <aside class="auth-side">
      <div class="auth-side-label">Workspace</div>
      <div class="auth-side-title">Centralized identity for workspace apps</div>
      <p>Single Sign-On protects routed applications and MCP endpoints under the same workspace policy.</p>
    </aside>
  </main>
  <script>
    window.setTimeout(function () {
      window.location.replace(${JSON.stringify(redirectUrl || '/')});
    }, 120);
  </script>
</body>
</html>`;
}

function readRouting() {
    const dynamicRoutingFile = process.env.PLOINKY_ROUTING_FILE
        || path.join(process.cwd(), '.ploinky', 'routing.json');
    const routingFile = fs.existsSync(dynamicRoutingFile) ? dynamicRoutingFile : ROUTING_FILE;
    try {
        return JSON.parse(fs.readFileSync(routingFile, 'utf8')) || {};
    } catch (_) {
        return {};
    }
}

async function waitForAgentRedirectReady(agentName) {
    const normalizedAgent = typeof agentName === 'string' ? agentName.trim() : '';
    if (!normalizedAgent) {
        return true;
    }
    return waitForAgentReady(normalizedAgent, {
        timeoutMs: 5000,
        intervalMs: 125,
        probeTimeoutMs: 250
    });
}

function readJsonFileIfExists(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return null;
    }
}

function readEnabledAgentManifest(routeKey, routes = {}) {
    const normalizedRouteKey = String(routeKey || '').trim();
    if (!normalizedRouteKey) return null;

    const routeHostPath = String(routes?.[normalizedRouteKey]?.hostPath || '').trim();
    const routeManifest = readJsonFileIfExists(routeHostPath ? path.join(routeHostPath, 'manifest.json') : '');
    if (routeManifest) return routeManifest;

    let resolved = null;
    try {
        resolved = resolveEnabledAgentRecord(normalizedRouteKey);
    } catch (_) {
        resolved = null;
    }
    const record = resolved?.record || null;
    if (!record?.repoName || !record?.agentName) return null;

    try {
        const found = findAgent(`${record.repoName}/${record.agentName}`);
        return readJsonFileIfExists(found?.manifestPath || '');
    } catch (_) {
        return null;
    }
}

function resolveSurfaceAuthRouteKey(surfaceName, targetRouteKey, routing = {}) {
    const normalizedSurface = String(surfaceName || '').trim();
    const normalizedTarget = String(targetRouteKey || '').trim();
    if (!normalizedSurface || !normalizedTarget) return '';

    const manifest = readEnabledAgentManifest(normalizedTarget, routing.routes || {});
    const surfaceConfig = manifest?.[normalizedSurface];
    const authPolicy = typeof surfaceConfig === 'string'
        ? surfaceConfig
        : String(surfaceConfig?.auth || '').trim();
    const normalizedAuthPolicy = String(authPolicy || '').trim().toLowerCase();

    if (normalizedAuthPolicy === 'static') {
        return String(routing.static?.agent || '').trim();
    }
    if (normalizedAuthPolicy === 'self') {
        return normalizedTarget;
    }
    return '';
}

function resolveAuthRouteKey(parsedUrl) {
    const pathname = parsedUrl.pathname || '/';
    const parts = pathname.split('/').filter(Boolean);
    const routing = readRouting();
    const routes = routing.routes || {};
    const explicit = String(parsedUrl.searchParams.get('agent') || '').trim();
    const staticAgent = String(routing.static?.agent || '').trim();
    if (parts[0] === 'webchat' && explicit) {
        const surfaceAuthRoute = resolveSurfaceAuthRouteKey('webchat', explicit, routing);
        if (surfaceAuthRoute) {
            return surfaceAuthRoute;
        }
    }
    if (parts.length >= 1 && routes[parts[0]]) {
        const pathAgent = parts[0];
        if (explicit) return explicit;
        try {
            const resolved = resolveEnabledAgentRecord(pathAgent);
            const pathAuthMode = String(resolved?.record?.auth?.mode || 'none').trim().toLowerCase() || 'none';
            if (pathAuthMode !== 'none') {
                return pathAgent;
            }
        } catch (_) { }
        if (!staticAgent) return pathAgent;
        if (staticAgent) return staticAgent;
    }
    if (explicit) return explicit;
    return staticAgent || null;
}

function resolveAuthContext(parsedUrl) {
    const routeKey = resolveAuthRouteKey(parsedUrl);
    if (!routeKey) {
        return { routeKey: null, mode: 'none', policy: { mode: 'none' }, record: null };
    }
    const resolved = resolveEnabledAgentRecord(routeKey);
    const record = resolved?.record || null;
    const policy = record?.auth || { mode: 'none' };
    const mode = String(policy.mode || 'none').trim().toLowerCase() || 'none';
    return { routeKey, mode, policy, record };
}

function resolveAuthContextForRouteKey(routeKey) {
    const normalizedRouteKey = String(routeKey || '').trim();
    if (!normalizedRouteKey) {
        return { routeKey: null, mode: 'none', policy: { mode: 'none' }, record: null };
    }
    const resolved = resolveEnabledAgentRecord(normalizedRouteKey);
    const record = resolved?.record || null;
    const policy = record?.auth || { mode: 'none' };
    const mode = String(policy.mode || 'none').trim().toLowerCase() || 'none';
    return { routeKey: normalizedRouteKey, mode, policy, record };
}

function isUserAuthenticatedAuthMode(mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    return Boolean(normalized && normalized !== 'none' && normalized !== 'guest');
}

function resolveAuthenticatedRouteAuthContext(routeKey) {
    const normalizedRouteKey = String(routeKey || '').trim();
    const routing = readRouting();
    const ownerContext = resolveAuthContextForRouteKey(normalizedRouteKey);
    if (isUserAuthenticatedAuthMode(ownerContext.mode)) return ownerContext;

    const staticRouteKey = String(routing.static?.agent || '').trim();
    if (staticRouteKey && staticRouteKey !== normalizedRouteKey) {
        const staticContext = resolveAuthContextForRouteKey(staticRouteKey);
        if (isUserAuthenticatedAuthMode(staticContext.mode)) {
            return { ...staticContext, serviceRouteKey: normalizedRouteKey };
        }
    }

    return {
        routeKey: normalizedRouteKey,
        mode: 'authenticated-unconfigured',
        policy: { mode: 'authenticated-unconfigured' },
        record: ownerContext.record || null,
        error: 'authenticated_http_route_auth_not_configured',
        errorDetail: 'Authenticated HTTP routes require a user-authenticated route or static-agent auth policy.'
    };
}

function resolveGuestRouteAuthContext(routeKey, options = {}) {
    return {
        routeKey: String(routeKey || '').trim(),
        mode: 'guest',
        policy: {
            mode: 'guest',
            guestScope: String(options.guestScope || `http-route:${routeKey || ''}`).trim(),
        },
        record: null,
    };
}

export function resolveRouteDefaultHttpAccess(routeKey) {
    const normalizedRouteKey = String(routeKey || '').trim();
    const context = resolveAuthContextForRouteKey(normalizedRouteKey);
    if (context.mode === 'guest') {
        return { access: 'guest', routeKey: normalizedRouteKey, source: 'routeDefault' };
    }
    if (isUserAuthenticatedAuthMode(context.mode)) {
        return { access: 'authenticated', routeKey: normalizedRouteKey, source: 'routeDefault' };
    }

    const staticRouteKey = String(readRouting().static?.agent || '').trim();
    if (staticRouteKey && staticRouteKey !== normalizedRouteKey) {
        const staticContext = resolveAuthContextForRouteKey(staticRouteKey);
        if (isUserAuthenticatedAuthMode(staticContext.mode)) {
            return { access: 'authenticated', routeKey: normalizedRouteKey, source: 'routeDefault' };
        }
        if (staticContext.mode === 'guest') {
            return { access: 'guest', routeKey: normalizedRouteKey, source: 'routeDefault' };
        }
    }

    return { access: 'guest', routeKey: normalizedRouteKey, source: 'routeDefault' };
}

function getLocalRouteKey(parsedUrl, session = null, fallback = '') {
    const fromSession = String(session?.localAuth?.routeKey || session?.externalAuth?.routeKey || '').trim();
    if (fromSession) return fromSession;
    const fromQuery = String(parsedUrl.searchParams.get('agent') || '').trim();
    if (fromQuery) return fromQuery;
    return String(fallback || '').trim();
}

function getLocalAuthPolicyFromSession(session = null, fallbackPolicy = null) {
    const localAuth = session?.localAuth || {};
    if (localAuth.usersVar) {
        return {
            mode: 'local',
            usersVar: localAuth.usersVar
        };
    }
    if (session?.externalAuth?.provider) {
        return null;
    }
    return fallbackPolicy;
}

async function resolveSessionForAuthContext(authContext, sessionId) {
    if (!sessionId) return null;
    let session = authContext.mode === 'local'
        ? getLocalSession(sessionId, { policy: authContext.policy })
        : authService.getSession(sessionId);
    if (authContext.mode === 'sso' && (!session || (session.expiresAt && Date.now() > session.expiresAt))) {
        try {
            await authService.refreshSession(sessionId);
        } catch (_) {
            // ignore refresh failures; caller will treat as unauthenticated
        }
        session = authService.getSession(sessionId);
    }
    return session;
}

function getLocalAccountErrorMessage(code = '') {
    switch (String(code || '').trim()) {
        case 'current_password_required':
            return 'Enter the current password to apply changes.';
        case 'username_required':
            return 'Username cannot be empty.';
        case 'password_too_short':
            return 'New password must be at least 8 characters.';
        case 'password_confirmation_required':
            return 'Confirm the new password.';
        case 'password_confirmation_mismatch':
            return 'The new password and confirmation do not match.';
        case 'invalid_credentials':
            return 'Current password is incorrect.';
        case 'local_auth_not_configured':
            return 'Local auth is not configured for this account.';
        case 'no_changes_requested':
            return 'No changes were submitted.';
        case 'session_stale':
            return 'Your session is out of date. Sign in again and retry.';
        default:
            return code ? 'Unable to update credentials.' : '';
    }
}

function getUserAdminErrorStatus(code = '') {
    switch (String(code || '').trim()) {
        case 'authentication_required':
        case 'invalid_session':
            return 401;
        case 'admin_required':
            return 403;
        case 'local_auth_disabled':
        case 'user_not_found':
        case 'not_found':
            return 404;
        case 'username_taken':
        case 'last_admin_required':
        case 'roles_must_be_array':
        case 'username_required':
        case 'password_required':
        case 'user_id_required':
        case 'no_changes_requested':
            return 400;
        default:
            return 500;
    }
}

function getUserAdminErrorMessage(code = '') {
    switch (String(code || '').trim()) {
        case 'authentication_required':
        case 'invalid_session':
            return 'Authentication required.';
        case 'admin_required':
            return 'Admin access is required.';
        case 'local_auth_disabled':
            return 'Local auth is not enabled for this agent.';
        case 'user_not_found':
            return 'User not found.';
        case 'not_found':
            return 'Not found.';
        case 'username_taken':
            return 'Username is already in use.';
        case 'last_admin_required':
            return 'At least one admin user is required.';
        case 'roles_must_be_array':
            return 'Roles must be an array.';
        case 'username_required':
            return 'Username is required.';
        case 'password_required':
            return 'Password is required.';
        case 'user_id_required':
            return 'User id is required.';
        case 'no_changes_requested':
            return 'No changes were submitted.';
        default:
            return code ? 'User management request failed.' : '';
    }
}

function readTextBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function readLoginBody(req) {
    const contentType = String(req.headers?.['content-type'] || '').toLowerCase();
    if (contentType.includes('application/json')) {
        return readJsonBody(req);
    }
    const raw = await readTextBody(req);
    const params = new URLSearchParams(raw);
    return Object.fromEntries(params.entries());
}

function getCookieNameForMode(mode) {
    if (mode === 'local') return LOCAL_AUTH_COOKIE_NAME;
    if (mode === 'guest') return GUEST_AUTH_COOKIE_NAME;
    return SSO_AUTH_COOKIE_NAME;
}

function respondUnauthenticated(req, res, parsedUrl, authContext = resolveAuthContext(parsedUrl)) {
    const pathname = parsedUrl.pathname || '/';
    const returnTo = `${pathname || '/'}${parsedUrl.search || ''}`;
    const query = new URLSearchParams({ returnTo });
    if (authContext?.routeKey) query.set('agent', authContext.routeKey);
    const loginUrl = `/auth/login?${query.toString()}`;
    const cookieName = getCookieNameForMode(authContext?.mode);
    const clearCookie = buildCookie(cookieName, '', req, '/', { maxAge: 0, sameSite: 'Lax' });
    const method = (req.method || 'GET').toUpperCase();
    const wantsJson = wantsJsonResponse(req, pathname) || method !== 'GET';
    if (wantsJson) {
        res.writeHead(401, {
            'Content-Type': 'application/json',
            'Set-Cookie': clearCookie
        });
        res.end(JSON.stringify({ ok: false, error: 'not_authenticated', login: loginUrl }));
    } else {
        res.writeHead(302, {
            Location: loginUrl,
            'Set-Cookie': clearCookie
        });
        res.end('Authentication required');
    }
    return { ok: false };
}

export function buildIdentityHeaders(req) {
    if (!req || !req.user) return {};
    const headers = {};
    const user = req.user || {};
    if (user.id) headers['X-Ploinky-User-Id'] = String(user.id);
    const name = user.username || user.email || user.name || user.id;
    if (name) headers['X-Ploinky-User'] = String(name);
    if (user.email) headers['X-Ploinky-User-Email'] = String(user.email);
    if (Array.isArray(user.roles) && user.roles.length) {
        headers['X-Ploinky-User-Roles'] = user.roles.join(',');
    }
    if (req.sessionId) headers['X-Ploinky-Session-Id'] = String(req.sessionId);
    if (req.session?.tokens?.accessToken) {
        headers['Authorization'] = `Bearer ${req.session.tokens.accessToken}`;
    }
    return headers;
}

export async function ensureAgentAuthenticated(req, res, parsedUrl) {
    return {
        ok: false,
        error: 'legacy_agent_bearer_auth_removed',
        detail: 'Agent-to-agent calls use an Agent Assertion JWT carried as `Authorization: Bearer`, verified by the router (DS013).'
    };
}

async function ensureAuthenticatedWithContext(req, res, parsedUrl, authContext) {
    if (authContext.error === 'authenticated_http_route_auth_not_configured') {
        sendJson(res, 503, {
            ok: false,
            error: authContext.error,
            detail: authContext.errorDetail || 'Authenticated HTTP routes require a user-authenticated route or static-agent auth policy.',
        });
        return { ok: false, error: authContext.error };
    }
    if (authContext.mode === 'none') {
        return { ok: true };
    }
    if (authContext.mode === 'sso' && !authService.isConfigured()) {
        sendJson(res, 503, { ok: false, error: 'sso_not_configured' });
        return { ok: false, error: 'sso_not_configured' };
    }
    const cookies = parseCookies(req);

    if (authContext.mode === 'guest') {
        const existingAuth = cookies.get(LOCAL_AUTH_COOKIE_NAME);
        if (existingAuth) {
            const authSession = getLocalSession(existingAuth, { policy: authContext.policy });
            if (authSession) {
                req.user = authSession.user;
                req.session = authSession;
                req.sessionId = existingAuth;
                req.authMode = 'local';
                return { ok: true, session: authSession };
            }
        }
        const ssoCookie = cookies.get(SSO_AUTH_COOKIE_NAME);
        if (ssoCookie && authService.isConfigured()) {
            const ssoSession = authService.getSession(ssoCookie);
            if (ssoSession && (!ssoSession.expiresAt || Date.now() <= ssoSession.expiresAt)) {
                req.user = ssoSession.user;
                req.session = ssoSession;
                req.sessionId = ssoCookie;
                req.authMode = 'sso';
                return { ok: true, session: ssoSession };
            }
        }
        const guestCookie = cookies.get(GUEST_AUTH_COOKIE_NAME);
        if (guestCookie) {
            const guestSession = getLocalSession(guestCookie, { policy: authContext.policy });
            if (guestSession) {
                req.user = guestSession.user;
                req.session = guestSession;
                req.sessionId = guestCookie;
                req.authMode = 'guest';
                return { ok: true, session: guestSession };
            }
        }
        const guestJwt = mintGuestSessionJwt({ policy: authContext.policy });
        const guestSession = getLocalSession(guestJwt, { policy: authContext.policy });
        const cookie = buildCookie(GUEST_AUTH_COOKIE_NAME, guestJwt, req, '/', {
            maxAge: GUEST_SESSION_TTL_SECONDS,
            sameSite: 'Lax'
        });
        appendSetCookie(res, cookie);
        req.user = guestSession?.user || { id: 'guest', username: 'visitor', roles: ['guest'] };
        req.session = guestSession;
        req.sessionId = guestJwt;
        req.authMode = 'guest';
        appendLog('auth_guest_session_created', { path: parsedUrl.pathname });
        return { ok: true, session: guestSession };
    }

    const cookieName = getCookieNameForMode(authContext.mode);
    const sessionId = cookies.get(cookieName);
    if (!sessionId) {
        appendLog('auth_missing_cookie', { path: parsedUrl.pathname });
        return respondUnauthenticated(req, res, parsedUrl, authContext);
    }
    let session = authContext.mode === 'local'
        ? getLocalSession(sessionId, { policy: authContext.policy })
        : authService.getSession(sessionId);
    if (authContext.mode === 'sso' && (!session || (session.expiresAt && Date.now() > session.expiresAt))) {
        try {
            await authService.refreshSession(sessionId);
        } catch (err) {
            appendLog('auth_refresh_failed', { error: err?.message || String(err) });
        }
        session = authService.getSession(sessionId);
    }
    if (!session) {
        appendLog('auth_session_invalid', { sessionId: '[redacted]', mode: authContext.mode });
        return respondUnauthenticated(req, res, parsedUrl, authContext);
    }
    if (authContext.mode === 'local' && session._jwtPayload) {
        const jwtPayload = session._jwtPayload;
        const usersVar = authContext.policy?.usersVar || '';
        const currentRev = resolveUserRev(usersVar, jwtPayload.usr?.username || '');
        if (currentRev !== (jwtPayload.rev || 1)) {
            appendLog('auth_rev_mismatch', { username: jwtPayload.usr?.username });
            return respondUnauthenticated(req, res, parsedUrl, authContext);
        }
    }
    req.user = session.user;
    req.session = session;
    req.sessionId = sessionId;
    req.authMode = authContext.mode;
    try {
        if (authContext.mode === 'local' && session.user) {
            const refreshedJwt = mintSessionJwt(session.user, session._jwtPayload?.rev || 1, {
                usersVar: session.localAuth?.usersVar || authContext.policy?.usersVar || '',
                sid: session._jwtPayload?.sid || ''
            });
            const cookie = buildCookie(cookieName, refreshedJwt, req, '/', {
                maxAge: getLocalSessionCookieMaxAge(),
                sameSite: 'Lax'
            });
            appendSetCookie(res, cookie);
        } else {
            const cookie = buildCookie(cookieName, sessionId, req, '/', {
                maxAge: authService.getSessionCookieMaxAge(),
                sameSite: 'Lax'
            });
            appendSetCookie(res, cookie);
        }
    } catch (_) { }
    return { ok: true, session };
}

export async function ensureAuthenticated(req, res, parsedUrl) {
    return ensureAuthenticatedWithContext(req, res, parsedUrl, resolveAuthContext(parsedUrl));
}

export async function ensureHttpRouteAccess(req, res, parsedUrl, decision) {
    if (decision?.access === 'public') return { ok: true };
    if (decision?.access === 'guest') {
        return ensureAuthenticatedWithContext(
            req,
            res,
            parsedUrl,
            resolveGuestRouteAuthContext(decision.routeKey, decision),
        );
    }
    if (decision?.access === 'authenticated') {
        return ensureAuthenticatedWithContext(
            req,
            res,
            parsedUrl,
            resolveAuthenticatedRouteAuthContext(decision.routeKey),
        );
    }

    const status = decision?.access === 'deny' ? (decision.status || 403) : 403;
    const code = decision?.access === 'deny' ? (decision.code || 'HTTP_ROUTE_ACCESS_DENIED') : 'HTTP_ROUTE_ACCESS_DENIED';
    sendJson(res, status, { ok: false, error: code });
    return { ok: false, error: code };
}

function parseUserAdminPath(pathname = '') {
    const parts = String(pathname || '').split('/').filter(Boolean);
    if (parts.length < 4 || parts[0] !== 'api' || parts[1] !== 'agents') {
        return null;
    }
    if (parts[3] !== 'users' && parts[3] !== 'settings') {
        return null;
    }
    if (parts.length > 5) {
        return null;
    }
    return {
        agent: decodeURIComponent(parts[2] || ''),
        resource: parts[3],
        userId: parts[4] ? decodeURIComponent(parts[4]) : ''
    };
}

function sendUserAdminError(res, code, detail = '') {
    const status = getUserAdminErrorStatus(code);
    sendJson(res, status, {
        ok: false,
        error: code,
        message: getUserAdminErrorMessage(code),
        ...(detail ? { detail } : {})
    });
}

async function readUserAdminBody(req) {
    try {
        return await readJsonBody(req);
    } catch (error) {
        const err = new Error('invalid_json');
        err.cause = error;
        throw err;
    }
}

export async function handleUserAdminRoutes(req, res, parsedUrl) {
    const pathname = parsedUrl.pathname || '/';
    const route = parseUserAdminPath(pathname);
    if (!route) return false;

    const method = (req.method || 'GET').toUpperCase();
    const authContext = resolveAuthContextForRouteKey(route.agent);
    if (authContext.mode !== 'local' || !authContext.policy?.usersVar) {
        sendUserAdminError(res, 'local_auth_disabled');
        return true;
    }

    const cookies = parseCookies(req);
    const sessionId = cookies.get(LOCAL_AUTH_COOKIE_NAME) || '';
    const session = getLocalSession(sessionId, { policy: authContext.policy });
    if (!session) {
        sendUserAdminError(res, 'authentication_required');
        return true;
    }
    if (!isLocalAdminUser(session.user)) {
        sendUserAdminError(res, 'admin_required');
        return true;
    }

    try {
        const cookie = buildCookie(LOCAL_AUTH_COOKIE_NAME, sessionId, req, '/', {
            maxAge: getLocalSessionCookieMaxAge(),
            sameSite: 'Lax'
        });
        res.setHeader('Set-Cookie', cookie);

        if (route.resource === 'settings') {
            if (route.userId) {
                sendUserAdminError(res, 'not_found');
                return true;
            }
            if (method === 'GET') {
                sendJson(res, 200, {
                    ok: true,
                    agent: authContext.routeKey,
                    settings: readRouterSettings()
                });
                return true;
            }
            if (method === 'PATCH') {
                const body = await readUserAdminBody(req);
                const settings = updateRouterSettings({
                    loginBrandingName: body?.loginBrandingName
                });
                sendJson(res, 200, {
                    ok: true,
                    agent: authContext.routeKey,
                    settings
                });
                return true;
            }
            res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, PATCH' });
            res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
            return true;
        }

        if (method === 'GET' && !route.userId) {
            const users = listLocalAuthUsers(authContext.policy)
                .sort((left, right) => String(left.username || '').localeCompare(String(right.username || '')));
            sendJson(res, 200, {
                ok: true,
                agent: authContext.routeKey,
                users
            });
            return true;
        }

        if (method === 'POST' && !route.userId) {
            const body = await readUserAdminBody(req);
            const user = createLocalAuthUser({
                policy: authContext.policy,
                username: body?.username,
                password: body?.password,
                name: body?.name,
                email: body?.email,
                roles: Object.prototype.hasOwnProperty.call(body || {}, 'roles') ? body.roles : undefined
            });
            sendJson(res, 201, {
                ok: true,
                agent: authContext.routeKey,
                user
            });
            return true;
        }

        if (method === 'PATCH' && route.userId) {
            const body = await readUserAdminBody(req);
            const user = updateLocalAuthUser({
                policy: authContext.policy,
                id: route.userId,
                username: Object.prototype.hasOwnProperty.call(body || {}, 'username') ? body.username : undefined,
                password: Object.prototype.hasOwnProperty.call(body || {}, 'password') ? body.password : undefined,
                name: Object.prototype.hasOwnProperty.call(body || {}, 'name') ? body.name : undefined,
                email: Object.prototype.hasOwnProperty.call(body || {}, 'email') ? body.email : undefined,
                roles: Object.prototype.hasOwnProperty.call(body || {}, 'roles') ? body.roles : undefined
            });
            sendJson(res, 200, {
                ok: true,
                agent: authContext.routeKey,
                user
            });
            return true;
        }

        if (method === 'DELETE' && route.userId) {
            const user = deleteLocalAuthUser({
                policy: authContext.policy,
                id: route.userId
            });
            sendJson(res, 200, {
                ok: true,
                agent: authContext.routeKey,
                deleted: true,
                user
            });
            return true;
        }

        res.writeHead(405, { 'Content-Type': 'application/json', Allow: route.userId ? 'PATCH, DELETE' : 'GET, POST' });
        res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
        return true;
    } catch (error) {
        const code = error?.message === 'invalid_json' ? 'invalid_json' : (error?.message || 'user_admin_failed');
        if (code === 'invalid_json') {
            sendJson(res, 400, { ok: false, error: code, message: 'Request body must be valid JSON.' });
            return true;
        }
        sendUserAdminError(res, code, error?.message || String(error));
        return true;
    }
}

export async function handleAuthRoutes(req, res, parsedUrl) {
    const pathname = parsedUrl.pathname || '/';
    if (!pathname.startsWith('/auth/')) return false;
    const method = (req.method || 'GET').toUpperCase();
    const baseUrl = getRequestBaseUrl(req);
    const authContext = resolveAuthContext(parsedUrl);
    try {
        if (pathname === '/auth/logged-out') {
            if (method !== 'GET') {
                res.writeHead(405); res.end(); return true;
            }
            const nextPath = normalizeRelativePath(parsedUrl.searchParams.get('next') || '/webchat/', '/webchat/');
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(renderLoggedOutHtml(nextPath));
            return true;
        }
        if (pathname === '/auth/login') {
            if (authContext.mode === 'none') {
                sendJson(res, 404, { ok: false, error: 'auth_disabled' });
                return true;
            }
            if (authContext.mode === 'local') {
                if (method === 'GET') {
                    const returnTo = parsedUrl.searchParams.get('returnTo') || '/';
                    const localCfg = resolveLocalAuthConfig(authContext.policy);
                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Cache-Control': 'no-store'
                    });
                    res.end(renderLocalLoginHtml({
                        agentName: authContext.routeKey,
                        returnTo,
                        error: parsedUrl.searchParams.get('error') || '',
                        notice: parsedUrl.searchParams.get('notice') || '',
                        usersVar: localCfg.usersVar
                    }));
                    return true;
                }
                if (method !== 'POST') {
                    res.writeHead(405); res.end(); return true;
                }
                const body = await readLoginBody(req);
                const username = String(body?.username || '').trim();
                const password = String(body?.password || '');
                const returnTo = normalizeRelativePath(body?.returnTo || '/', '/');
                const agent = String(body?.agent || authContext.routeKey || '').trim();
                try {
                    const result = authenticateLocalUser({ username, password, policy: authContext.policy, routeKey: agent });
                    await waitForAgentRedirectReady(agent);
                    const cookie = buildCookie(LOCAL_AUTH_COOKIE_NAME, result.sessionId, req, '/', {
                        maxAge: getLocalSessionCookieMaxAge(),
                        sameSite: 'Lax'
                    });
                    res.writeHead(302, {
                        Location: returnTo,
                        'Set-Cookie': cookie
                    });
                    res.end('Login successful');
                    appendLog('auth_local_login_success', { user: result.user?.username, agent });
                    return true;
                } catch (err) {
                    appendLog('auth_local_login_failure', { error: err?.message || String(err), agent });
                    const params = new URLSearchParams({
                        agent,
                        returnTo,
                        error: err?.message === 'local_auth_not_configured'
                            ? 'Local auth is not configured for this agent.'
                            : 'Invalid username or password.'
                    });
                    res.writeHead(302, { Location: `/auth/login?${params.toString()}` });
                    res.end('Login failed');
                    return true;
                }
            }
            if (!authService.isConfigured()) {
                sendJson(res, 503, { ok: false, error: 'sso_disabled' });
                return true;
            }
            if (method !== 'GET') {
                res.writeHead(405); res.end(); return true;
            }
            const returnTo = parsedUrl.searchParams.get('returnTo') || '/';
            const prompt = parsedUrl.searchParams.get('prompt') || undefined;
            const { redirectUrl } = await authService.beginLogin({ baseUrl, returnTo, prompt });
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(renderSsoLoginHtml({
                agentName: authContext.routeKey,
                returnTo,
                redirectUrl
            }));
            appendLog('auth_login_redirect', { returnTo });
            return true;
        }
        if (pathname === '/auth/account') {
            if (method !== 'GET' && method !== 'POST') {
                res.writeHead(405); res.end(); return true;
            }
            const cookies = parseCookies(req);
            const sessionId = cookies.get(LOCAL_AUTH_COOKIE_NAME) || '';
            const session = getLocalSession(sessionId, { policy: authContext.policy });
            const routeKey = getLocalRouteKey(parsedUrl, session, authContext.routeKey);
            const returnToFromQuery = normalizeRelativePath(parsedUrl.searchParams.get('returnTo') || '/', '/');

            if (!session) {
                const params = new URLSearchParams({ returnTo: returnToFromQuery });
                if (routeKey) params.set('agent', routeKey);
                res.writeHead(302, { Location: `/auth/login?${params.toString()}` });
                res.end('Authentication required');
                return true;
            }

            req.user = session.user;
            req.session = session;
            req.sessionId = sessionId;
            req.authMode = 'local';

            const policy = getLocalAuthPolicyFromSession(session, authContext.policy);
            if (!policy) {
                if (method === 'GET') {
                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Cache-Control': 'no-store'
                    });
                    res.end(renderExternalAccountHtml({
                        providerLabel: session?.externalAuth?.provider === 'github' ? 'GitHub' : 'External sign-in',
                        returnTo: returnToFromQuery,
                        username: req.user?.username || req.user?.name || ''
                    }));
                    return true;
                }
                sendJson(res, 400, {
                    ok: false,
                    error: 'external_account_readonly',
                    message: 'Account settings are not available for this sign-in method.'
                });
                return true;
            }

            if (method === 'GET') {
                const localCfg = resolveLocalAuthConfig(policy);
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store'
                });
                res.end(renderLocalAccountHtml({
                    agentName: routeKey,
                    returnTo: returnToFromQuery,
                    error: getLocalAccountErrorMessage(parsedUrl.searchParams.get('error') || ''),
                    notice: parsedUrl.searchParams.get('notice') || '',
                    username: req.user?.username || '',
                    usersVar: localCfg.usersVar
                }));
                return true;
            }

            const body = await readLoginBody(req);
            const returnTo = normalizeRelativePath(body?.returnTo || '/', '/');
            const nextUsername = String(body?.newUsername || '').trim();
            const currentPassword = String(body?.currentPassword || '');
            const newPassword = String(body?.newPassword || '');
            const confirmPassword = String(body?.confirmPassword || '');
            const wantsJson = String(req.headers?.accept || '').toLowerCase().includes('application/json');
            let errorCode = '';

            if (!currentPassword) {
                errorCode = 'current_password_required';
            } else if (!nextUsername) {
                errorCode = 'username_required';
            } else if ((newPassword || confirmPassword) && !confirmPassword) {
                errorCode = 'password_confirmation_required';
            } else if ((newPassword || confirmPassword) && newPassword !== confirmPassword) {
                errorCode = 'password_confirmation_mismatch';
            } else if (newPassword && newPassword.length < 8) {
                errorCode = 'password_too_short';
            }

            if (!errorCode) {
                try {
                    const result = updateLocalCredentials({
                        currentPassword,
                        nextUsername,
                        nextPassword: newPassword,
                        policy,
                        sessionUser: req.user
                    });
                    const clearCookie = buildCookie(LOCAL_AUTH_COOKIE_NAME, '', req, '/', { maxAge: 0, sameSite: 'Lax' });
                    const notice = result.passwordChanged
                        ? 'Credentials updated. Sign in again with the new username and password.'
                        : 'Username updated. Sign in again with the new username.';
                    appendLog('auth_local_account_updated', {
                        user: req.user?.username || null,
                        agent: routeKey || null,
                        usernameChanged: result.usernameChanged,
                        passwordChanged: result.passwordChanged
                    });
                    if (wantsJson) {
                        res.writeHead(200, {
                            'Content-Type': 'application/json',
                            'Set-Cookie': clearCookie
                        });
                        res.end(JSON.stringify({ ok: true, notice }));
                        return true;
                    }
                    const params = new URLSearchParams({ returnTo, notice });
                    if (routeKey) params.set('agent', routeKey);
                    res.writeHead(302, {
                        Location: `/auth/login?${params.toString()}`,
                        'Set-Cookie': clearCookie
                    });
                    res.end('Credentials updated');
                    return true;
                } catch (err) {
                    errorCode = err?.message || 'local_account_update_failed';
                    appendLog('auth_local_account_update_failure', {
                        error: errorCode,
                        agent: routeKey || null
                    });
                }
            }

            if (wantsJson) {
                sendJson(res, 400, {
                    ok: false,
                    error: errorCode,
                    message: getLocalAccountErrorMessage(errorCode)
                });
                return true;
            }

            const params = new URLSearchParams({ returnTo });
            if (errorCode) params.set('error', errorCode);
            res.writeHead(302, { Location: `/auth/account?${params.toString()}` });
            res.end('Unable to update credentials');
            return true;
        }

        if (pathname === '/auth/local-users') {
            sendJson(res, 410, {
                ok: false,
                error: 'local_users_endpoint_removed',
                detail: 'Use /api/agents/<agent>/users.'
            });
            return true;
        }

        if (pathname.startsWith('/auth/github/')) {
            sendJson(res, 404, { ok: false, error: 'github_auth_removed' });
            return true;
        }
        if (pathname === '/auth/callback') {
            if (authContext.mode !== 'sso') {
                sendJson(res, 404, { ok: false, error: 'callback_not_supported' });
                return true;
            }
            if (!authService.isConfigured()) {
                sendJson(res, 503, { ok: false, error: 'sso_disabled' });
                return true;
            }
            if (method !== 'GET') {
                res.writeHead(405); res.end(); return true;
            }
            const code = parsedUrl.searchParams.get('code') || '';
            const state = parsedUrl.searchParams.get('state') || '';
            if (!code || !state) {
                sendJson(res, 400, { ok: false, error: 'missing_parameters' });
                return true;
            }
            const result = await authService.handleCallback({ code, state, baseUrl });
            await waitForAgentRedirectReady(authContext.routeKey || '');
            const cookie = buildCookie(SSO_AUTH_COOKIE_NAME, result.sessionId, req, '/', {
                maxAge: authService.getSessionCookieMaxAge(),
                sameSite: 'Lax'
            });
            res.writeHead(302, {
                Location: result.redirectTo || '/',
                'Set-Cookie': cookie
            });
            res.end('Login successful');
            appendLog('auth_callback_success', { user: result.user?.id });
            return true;
        }
        if (pathname === '/auth/logout') {
            if (method !== 'GET' && method !== 'POST') {
                res.writeHead(405); res.end(); return true;
            }
            const cookies = parseCookies(req);
            const cookieName = getCookieNameForMode(authContext.mode);
            const sessionId = cookies.get(cookieName) || '';
            const requestedReturnTo = normalizeRelativePath(parsedUrl.searchParams.get('returnTo') || '/', '/');
            // For stateless JWT sessions (local + guest), add the session's sid to
            // the persistent revocation list so the cookie cannot be replayed.
            if (sessionId && (authContext.mode === 'local' || authContext.mode === 'guest')) {
                try {
                    const payload = verifySessionJwt(sessionId);
                    revokeSessionId({ sid: payload.sid, jti: payload.jti, reason: 'logout' });
                } catch { /* already invalid/expired — nothing to revoke */ }
            }
            const outcome = authContext.mode === 'local'
                ? (revokeLocalSession(sessionId), { redirect: requestedReturnTo || '/' })
                : await authService.logout(sessionId, {
                    baseUrl,
                    postLogoutRedirectUri: requestedReturnTo
                });
            const clearCookie = buildCookie(cookieName, '', req, '/', { maxAge: 0, sameSite: 'Lax' });
            const redirectTarget = outcome.redirect || requestedReturnTo || '/';
            if (method === 'GET' || redirectTarget) {
                res.writeHead(302, {
                    Location: redirectTarget || '/',
                    'Set-Cookie': clearCookie
                });
                res.end('Logged out');
            } else {
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Set-Cookie': clearCookie
                });
                res.end(JSON.stringify({ ok: true }));
            }
            appendLog('auth_logout', { sessionId: sessionId ? '[redacted]' : null });
            return true;
        }
        if (pathname === '/auth/token') {
            if (authContext.mode === 'none') {
                sendJson(res, 404, { ok: false, error: 'auth_disabled' });
                return true;
            }
            if (method !== 'GET' && method !== 'POST') {
                res.writeHead(405); res.end(); return true;
            }
            const cookies = parseCookies(req);
            const cookieName = getCookieNameForMode(authContext.mode);
            const sessionId = cookies.get(cookieName);
            if (!sessionId) {
                sendJson(res, 401, { ok: false, error: 'not_authenticated' });
                return true;
            }
            const session = (authContext.mode === 'local' || authContext.mode === 'guest')
                ? getLocalSession(sessionId, { policy: authContext.policy })
                : authService.getSession(sessionId);
            if (!session) {
                const clearCookie = buildCookie(cookieName, '', req, '/', { maxAge: 0, sameSite: 'Lax' });
                res.writeHead(401, {
                    'Content-Type': 'application/json',
                    'Set-Cookie': clearCookie
                });
                res.end(JSON.stringify({ ok: false, error: 'session_expired' }));
                return true;
            }
            let refreshRequested = false;
            if (method === 'POST') {
                try {
                    const body = await readJsonBody(req);
                    refreshRequested = Boolean(body?.refresh);
                } catch (_) { }
            }
            let tokenInfo;
            if (authContext.mode === 'sso' && refreshRequested) {
                tokenInfo = await authService.refreshSession(sessionId);
            } else {
                tokenInfo = {
                    accessToken: session.tokens?.accessToken || null,
                    expiresAt: session.expiresAt,
                    scope: session.tokens?.scope || null,
                    tokenType: session.tokens?.tokenType || null
                };
            }
            const cookieMaxAge = authContext.mode === 'local'
                ? getLocalSessionCookieMaxAge()
                : authContext.mode === 'guest'
                    ? GUEST_SESSION_TTL_SECONDS
                    : authService.getSessionCookieMaxAge();
            const cookie = buildCookie(cookieName, sessionId, req, '/', {
                maxAge: cookieMaxAge,
                sameSite: 'Lax'
            });
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': cookie
            });
            res.end(JSON.stringify({ ok: true, token: tokenInfo, user: session.user }));
            return true;
        }
        if (pathname === '/auth/agent-token') {
            if (method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
                res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
                return true;
            }
            sendJson(res, 410, {
                ok: false,
                error: 'agent_token_flow_removed',
                detail: 'Use router-mediated caller assertions and invocation tokens instead of /auth/agent-token.'
            });
            return true;
        }
    } catch (err) {
        appendLog('auth_error', { error: err?.message || String(err) });
        if ((err?.message || '').includes('SSO is not configured')) {
            sendJson(res, 503, { ok: false, error: 'sso_not_configured', detail: err?.message || String(err) });
            return true;
        }
        sendJson(res, 500, { ok: false, error: 'auth_failure', detail: err?.message || String(err) });
        return true;
    }
    res.writeHead(404); res.end('Not Found');
    return true;
}

export function getAppName() {
    const secretName = resolveVarValue('APP_NAME');
    const fromSecrets = secretName && String(secretName).trim();
    if (fromSecrets) return fromSecrets;
    const raw = process.env.APP_NAME;
    if (!raw) return null;
    const trimmed = String(raw).trim();
    return trimmed.length ? trimmed : null;
}

export { SSO_AUTH_COOKIE_NAME as AUTH_COOKIE_NAME, SSO_AUTH_COOKIE_NAME, LOCAL_AUTH_COOKIE_NAME, authService };
