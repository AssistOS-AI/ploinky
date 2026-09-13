/** Hand-reviewed custom dispatch shapes, supplemented by literal registration parsing. */
import fs from 'node:fs';
import path from 'node:path';
const role = (anonymous, selfRegistered, user, admin) => ({ anonymous, selfRegistered, user, admin });
const workspace = role('deny', 'deny', 'allow-subject-to-resource-policy', 'allow-subject-to-resource-policy');
const admin = role('deny', 'deny', 'deny', 'allow');
const account = role('deny', 'allow-own-account', 'allow-own-account', 'allow');
const publicProtocol = role('allow-protocol-with-proof', 'allow-protocol-with-proof', 'allow-protocol-with-proof', 'allow-protocol-with-proof');
const internal = role('deny-without-service-proof', 'deny-without-service-proof', 'deny-without-service-proof', 'deny-without-service-proof');
const publicAsset = role('allow', 'allow', 'allow', 'allow');

export function customHttpInventory(catalog, repos) {
    const out = [];
    const read = (repo, file) => fs.readFileSync(path.join(repos[repo].root, file), 'utf8');
    function add(repo, agent, port, method, suffix, file, needle, expected, gap, transport = 'http') {
        const record = catalog.find((a) => a.repo === repo && a.agent === agent);
        if (!record) throw new Error(`Unknown agent ${repo}/${agent}`);
        const text = read(repo, file);
        const at = text.indexOf(needle);
        if (at < 0) throw new Error(`Source anchor absent: ${file}: ${needle}`);
        const pathname = `/base-agent-additional-server/${agent}/${port}${suffix}`;
        out.push({ id: `${repo}/${agent}:${method}:${pathname}:${transport}`, repo, agent, revision: record.revision, enabled: record.enabled, method, path: pathname, transport, source: `${repo}/${file}:${text.slice(0, at).split('\n').length}`, expected, authorizationBasis: 'Concrete executable handler or registration at source. Per-role expectation derives from persisted roles, resource policy, and explicit protocol proof exceptions.', coverage: 'inventoried-not-exercised', gap: !record.enabled ? `Disabled/on-demand runtime. ${gap || 'No functional positive control.'}` : gap });
        if (!record.additionalPorts.includes(port)) record.additionalPorts.push(port);
    }
    const a = (agent, port, method, suffix, file, needle, expected = workspace, gap, transport) => add('AchillesIDE', agent, port, method, suffix, `${agent}/${file}`, needle, expected, gap, transport);
    const r = (method, suffix, needle, expected = workspace, gap, transport) => add('AchillesCLI', 'roboTeamAgent', 3001, method, suffix, 'roboTeamAgent/server/http-server.mjs', needle, expected, gap, transport);
    for (const suffix of ['/', '/config.js', '/InterVariable.woff2', '/styles.css', '/app.js', '/skills-dialog.js', '/terminal.js']) r('GET', suffix, `pathname === '${suffix}'`);
    r('GET', '/status', "pathname === '/status'", publicAsset, 'Router authenticated policy may be stricter than backend readiness path.');
    r('GET', '/api/robots', "pathname === '/api/robots'");
    r('POST', '/api/robots', "pathname === '/api/robots' && req.method === 'POST'", admin, 'Create only named test fixture; cleanup through bounded robot-delete operation.');
    r('POST', '/api/robots/:robotId/terminal', "matchRobotPath(pathname, '/terminal')", admin, 'Requires existing disposable robot. Optional browser/desktop tools have known image setup failures.');
    for (const method of ['POST', 'DELETE', 'PATCH']) r(method, '/api/robots/:robotId/skillsets', "matchRobotPath(pathname, '/skillsets')", admin, 'Change only test-owned robot skillsets; do not install remote sources.');
    for (const method of ['GET', 'POST', 'DELETE']) r(method, '/api/robots/:robotId/run', "matchRobotPath(pathname, '/run')", workspace, 'Shared robot lifecycle lacks per-user ownership; browser/desktop execution may be unavailable.');
    r('GET', '/api/robots/:robotId/logs', "matchRobotPath(pathname, '/logs')", workspace, 'Existing test-owned robot; assert bounded response contains no credential material.');
    r('GET', '/api/robots/:robotId/session/*', 'const sessionId = sessionRobotId(pathname)', workspace, 'Active disposable browser/desktop backend required.');
    r('GET', '/api/robots/:robotId/session/*', "server.on('upgrade'", workspace, 'Actual 101 and test-owned running backend required; missing backend is not an authorization result.', 'websocket');
    for (const operation of ['robot-delete', 'open-desktop', 'start-desktop-task', 'start-browser-task', 'start-simple-task', 'stop-desktop-task', 'stop-browser-task', 'stop-simple-task', 'take-control', 'resume-task', 'message-task', 'task-status', 'desktop-url', 'browser-url', 'stop-desktop-container', 'stop-browser-container']) {
        r('POST', `/api/control#operation=${operation}`, `'${operation}'`, operation === 'robot-delete' ? admin : workspace, 'Request body operation selector; only named test-owned robots/tasks may be changed.');
    }
    a('onlyOffice', 7000, 'GET', '/control/office/session', 'src/routes/control.mjs', "'/control/office/session'", workspace, 'GET creates an editing session: require disposable document and verify same-role/Confidential ownership.');
    a('onlyOffice', 9100, 'GET', '/internal/document/:token', 'src/routes/storage.mjs', "'/internal/document/'", internal, 'Container-local storage listener; public Router alias must not bypass signed session token.');
    a('onlyOffice', 9100, 'POST', '/internal/callback/:token', 'src/routes/storage.mjs', "'/internal/callback/'", internal, 'Requires test-owned document callback token and signed DocumentServer JWT; never fabricate a success from invalid token.');
    a('onlyOffice', 8080, '*', '/*', 'src/proxy/editor-proxy.mjs', 'export ', publicProtocol, 'DocumentServer binary route namespace remains opaque: public assets, editor transport and JWT document authorization require image-source route inventory.', 'http+websocket-family');
    a('webmeetStt', 9000, 'GET', '/healthz', 'server.py', '@app.get("/healthz")', workspace, 'Port must reconcile with live service registry.');
    a('webmeetStt', 9000, 'POST', '/v1/audio/transcriptions', 'server.py', '@app.post("/v1/audio/transcriptions")', workspace, 'Bounded audio fixture required; backend latency/functionality is separate from authorization.');
    a('liveKitServerAgent', 7880, 'GET', '/rtc', 'manifest.json', '"routerAccess"', publicProtocol, 'Image-owned LiveKit WebSocket; requires room token, participant and room ACL controls.', 'websocket');
    for (const service of ['RoomService', 'AgentDispatchService']) a('liveKitServerAgent', 7880, 'POST', `/twirp/livekit.${service}/*`, 'manifest.json', `/twirp/livekit.${service}/*`, internal, 'Image-owned Twirp namespace: enumerate exact methods from pinned image source before claiming complete coverage.');
    a('liveKitServerAgent', 17000, 'GET', '/ready', 'scripts/health/supervisor-health.mjs', "request.url !== '/ready'", internal, 'Readiness listener port must be reconciled to supervisor environment.');
    // UserPersisto custom service: exact operation maps supplement path branches.
    for (const suffix of ['/service/auth/methods', '/service/auth/setup']) a('userPersistoAgent', 7000, 'GET|HEAD', suffix, 'service/index.mjs', `'${suffix}'`, publicProtocol);
    a('userPersistoAgent', 7000, 'GET|HEAD', '/service/auth/*', 'service/index.mjs', "path.startsWith('/service/auth/')", publicAsset, 'Static auth asset namespace; explicit files should be tested as assets, not API success.');
    for (const suffix of [...read('AchillesIDE', 'userPersistoAgent/service/ssoWizard.mjs').matchAll(/^\s+'(\/service\/auth\/[^']+)'/gm)].map((m) => m[1])) a('userPersistoAgent', 7000, 'POST', suffix, 'service/ssoWizard.mjs', `'${suffix}'`, publicProtocol, 'Public passwordless protocol requires valid attempt, verified proof and same-origin controls.');
    for (const suffix of ['sso-login-request', 'sso-consume-code', 'sso-user', 'sso-admin-users-list', 'sso-admin-user-create', 'sso-admin-user-update', 'sso-admin-user-delete', 'sso-admin-policy-get', 'sso-admin-policy-update']) a('userPersistoAgent', 7000, 'POST', `/service/runtime/${suffix}`, 'service/index.mjs', `'/service/runtime/${suffix}'`, internal, 'Runtime secret remains mandatory even for browser administrator.');
    a('userPersistoAgent', 7000, 'POST', '/service/billing/stripe/webhook', 'service/index.mjs', "'/service/billing/stripe/webhook'", internal, 'Valid signed provider webhook out of scope; local invalid-signature probe only, not a positive authorization control.');
    for (const [method, suffix, needle] of [['GET', 'confirmation', '`${ROOT}/confirmation`'], ['POST', 'start', '`${ROOT}/start`'], ['GET', 'callback', 'GOOGLE_CALLBACK_PATH'], ['GET|POST', 'resume/:handle/:action?', 'const match = url.pathname.match']]) a('userPersistoAgent', 7000, method, `/service/auth/google/${suffix}`, 'service/googleAuth.mjs', needle, publicProtocol, 'Only local protocol rejection and state isolation are in scope; never contact or attack OAuth provider.');
    const dash = read('AchillesIDE', 'userPersistoAgent/service/dashboard.mjs');
    for (const [suffix, expected] of [['/', account], ['/users.html', admin], ['/applications.html', admin], ['/authentication.html', admin]]) a('userPersistoAgent', 7000, 'GET', `/service/dashboard${suffix}`, 'service/dashboard.mjs', suffix === '/' ? "path === '/'" : `'${suffix.slice(1)}'`, expected);
    a('userPersistoAgent', 7000, 'GET|POST', '/service/dashboard/api/profile', 'service/dashboard.mjs', "path === '/api/profile'", account, 'Profile updates must never change persisted roles; admin-like usernames must not grant privileges elsewhere.');
    const adminSection = dash.slice(dash.indexOf('const ADMIN_OPERATIONS'), dash.indexOf('function fail'));
    for (const m of adminSection.matchAll(/\['([^']+)',\s*\{/g)) a('userPersistoAgent', 7000, 'POST', `/service/dashboard/api/admin/${m[1]}`, 'service/dashboard.mjs', `['${m[1]}'`, admin, 'Existing disposable resource + positive admin control; skip global destructive/provider changes.');
    for (const suffix of ['auth/passkey/options', 'auth/passkey/verify', 'auth/totp/start', 'auth/totp/verify']) a('userPersistoAgent', 7000, 'POST', `/service/dashboard/api/${suffix}`, 'service/dashboard.mjs', `['${suffix}'`, account, 'Enrollment requires fresh, actor-bound, single-use operation grant.');
    for (const suffix of ['reauth/start', 'reauth/verify', 'reauth/cancel', 'reauth/google/complete', 'contact/start', 'contact/verify']) a('userPersistoAgent', 7000, 'POST', `/service/dashboard/api/${suffix}`, 'service/dashboard.mjs', suffix === 'reauth/verify' || suffix === 'contact/verify' ? 'async function accountSecurity' : `/api/${suffix}`, account, 'Keep changes bound to disposable identity; Google provider itself remains out of scope.');
    a('userPersistoAgent', 7000, 'GET|HEAD|POST|OPTIONS', '/service/oidc/*', 'lib/oidc/http.mjs', 'export async function handleOidc', publicProtocol, 'oidc-provider generated authorization/token/jwks/userinfo/logout/device/interaction route family; needs pinned library endpoint inventory and valid isolated client fixture.');
    for (const file of ['src/management/build-routes.mjs', 'src/public-api/register-routes.mjs']) {
        const text = read('proxies', `soul-gateway/${file}`);
        const re = /(httpRouter|wsRouter|router)\.add\(\s*'(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)'\s*,\s*'([^']+)'/g;
        for (const m of text.matchAll(re)) add('proxies', 'soul-gateway', 7000, m[2], m[3], `soul-gateway/${file}`, m[0], file.includes('management') ? admin : internal, m[3].includes(':') ? 'Existing disposable keyed resource required; global provider mutations are not exercised.' : m[3].startsWith('/v1/') ? 'Soul API credential required separately from browser session; inference to external service is out of scope.' : undefined, m[1] === 'wsRouter' ? 'websocket' : m[3].includes('/stream') ? 'sse' : 'http');
    }
    add('proxies', 'soul-gateway', 7000, 'GET', '/healthz/', 'soul-gateway/manifest.json', '"/base-agent-additional-server/soul-gateway/7000/healthz/*"', publicAsset);
    add('UmamiAgent', 'umamiAgent', 3000, '*', '/*', 'umamiAgent/scripts/umami-ingress.mjs', 'export function createUmamiIngress', workspace, 'Pinned Next/Umami 3.2.0 image owns concrete dashboard/API/share/tracking routes; source unavailable in agent repo. Router ingress does not itself replace Umami account permissions.', 'http-family');
    for (const [method, suffix] of [['GET', '/status'], ['POST', '/browser-use/run-task'], ['GET', '/browser-use/task-status'], ['POST', '/browser-use/continue-task'], ['POST', '/browser-use/close-session']]) add('copilot-agents', 'browserUseAgent', 7000, method, suffix, 'browserUseAgent/server/browser-use-server.mjs', `pathname === '${suffix}'`, workspace);
    for (const [method, suffix] of [['GET', '/'], ['GET', '/events'], ['POST', '/input'], ['POST', '/user-ready'], ['POST', '/close'], ['GET', '/status']]) add('copilot-agents', 'browserUseAgent', 7000, method, `/browser-use/sessions/:sessionId${suffix}`, 'browserUseAgent/server/viewer-routes.mjs', suffix === '/' ? "subPath === ''" : `subPath === '${suffix}'`, workspace, 'Session owner/control authorization requires test-owned enabled browser backend.', suffix === '/events' ? 'sse' : 'http');
    add('AchillesCLI', 'GPTResearcher', 8000, '*', '/*', 'GPTResearcher/scripts/start-gpt-researcher.sh', '-m uvicorn main:app', workspace, 'Upstream GPT Researcher UI/API/WebSocket routes are image/environment-owned and disabled; exact nested route inventory unresolved.', 'http+websocket-family');
    return out;
}
