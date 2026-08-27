import { readRouterSettings } from '../auth/routerSettings.js';
import {
    appendLocationHashToRelativeTarget,
    escapeHtml,
    normalizeRelativePath,
} from './shared.js';

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
    username = '',
    agentName = '',
    includeAgentSelector = true,
} = {}) {
    const safeReturnTo = escapeHtml(normalizeRelativePath(returnTo, '/'));
    const safeUsername = escapeHtml(username || '');
    const safeProvider = escapeHtml(providerLabel || 'GitHub');
    const logoutParams = new URLSearchParams({ returnTo: normalizeRelativePath(returnTo, '/') });
    if (includeAgentSelector && String(agentName || '').trim()) logoutParams.set('agent', String(agentName).trim());
    const safeLogoutUrl = escapeHtml(`/auth/logout?${logoutParams.toString()}`);
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

function renderLocalLoginHtml({
    agentName,
    returnTo = '/',
    error = '',
    notice = '',
    usersVar = '',
    includeAgentSelector = true,
} = {}) {
    const rawAgent = String(agentName || '').trim();
    const safeAgent = escapeHtml(rawAgent || 'application');
    const safeReturnTo = escapeHtml(normalizeRelativePath(returnTo, '/'));
    const safeError = escapeHtml(error || '');
    const safeNotice = escapeHtml(notice || '');
    const safeBrandingName = escapeHtml(readRouterSettings().loginBrandingName);
    const safeLoginAction = escapeHtml(includeAgentSelector && rawAgent
        ? `/auth/login?agent=${encodeURIComponent(rawAgent)}`
        : '/auth/login');
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
      <form method="post" action="${safeLoginAction}" data-auth-login-form>
        ${includeAgentSelector ? `<input type="hidden" name="agent" value="${safeAgent}" />` : ''}
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
      const form = document.querySelector('form[data-auth-login-form]');
      const button = form?.querySelector('button[type="submit"]');
      if (!form || !button) return;
      form.addEventListener('submit', () => {
        const returnTo = form.elements.namedItem('returnTo');
        if (returnTo) {
          const appendLocationHash = (${appendLocationHashToRelativeTarget.toString()});
          returnTo.value = appendLocationHash(returnTo.value, window.location.hash);
        }
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
    usersVar = '',
    csrfToken = '',
    includeAgentSelector = true,
} = {}) {
    const safeAgent = escapeHtml(agentName || 'application');
    const safeReturnTo = escapeHtml(normalizeRelativePath(returnTo, '/'));
    const safeError = escapeHtml(error || '');
    const safeNotice = escapeHtml(notice || '');
    const safeUsername = escapeHtml(username || '');
    const safeUsersVar = escapeHtml(usersVar || '');
    const safeCsrfToken = escapeHtml(csrfToken || '');
    const logoutParams = new URLSearchParams({ returnTo: normalizeRelativePath(returnTo, '/') });
    if (includeAgentSelector && String(agentName || '').trim()) logoutParams.set('agent', String(agentName).trim());
    const safeLogoutUrl = escapeHtml(`/auth/logout?${logoutParams.toString()}`);
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
        <input type="hidden" name="csrfToken" value="${safeCsrfToken}" />
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

function renderLogoutConfirmationHtml({
    agentName = '',
    returnTo = '/',
    cancelTo = returnTo,
    csrfToken = '',
    includeAgentSelector = true,
} = {}) {
    const rawAgent = String(agentName || '').trim();
    const normalizedReturnTo = normalizeRelativePath(returnTo, '/');
    const safeReturnTo = escapeHtml(normalizedReturnTo);
    const safeCancelTo = escapeHtml(normalizeRelativePath(cancelTo, normalizedReturnTo));
    const safeCsrfToken = escapeHtml(csrfToken || '');
    const logoutAction = includeAgentSelector && rawAgent
        ? `/auth/logout?agent=${encodeURIComponent(rawAgent)}`
        : '/auth/logout';
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Confirm sign out</title>
  <style>
    ${getAuthPageStyles()}
  </style>
</head>
<body>
  <main class="auth-shell">
    <section class="auth-card">
      <div class="auth-kicker">Workspace Access</div>
      <h1>Sign out?</h1>
      <p>This closes the current workspace session.</p>
      <form method="post" action="${escapeHtml(logoutAction)}">
        <input type="hidden" name="csrfToken" value="${safeCsrfToken}" />
        <input type="hidden" name="returnTo" value="${safeReturnTo}" />
        ${includeAgentSelector && rawAgent ? `<input type="hidden" name="agent" value="${escapeHtml(rawAgent)}" />` : ''}
        <button class="auth-btn" type="submit">Sign out</button>
      </form>
      <a class="auth-btn secondary" href="${safeCancelTo}">Cancel</a>
    </section>
  </main>
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

export {
    renderLoggedOutHtml,
    renderExternalAccountHtml,
    renderLocalLoginHtml,
    renderLocalAccountHtml,
    renderLogoutConfirmationHtml,
    renderSsoLoginHtml,
};
