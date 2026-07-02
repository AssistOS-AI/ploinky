import { escapeHtml, normalizeRelativePath } from './shared.js';

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
    renderSsoLoginHtml,
};
