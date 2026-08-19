# Authenticated WebSocket-Upgrade Proxying in the Ploinky Router — Implementation Plan (rev. 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

> **Revision note:** rev. 2 incorporates an adversarial review. All 11 findings were verified against the code and accepted. Key corrections vs rev. 1: the router is **ESM, not CommonJS**; soul-gateway has a **wrong WebSocket-accept GUID** (a real pre-existing bug — so an agent change *is* required); helper exports were misattributed; the auth-capture stub, identity-injection condition, `head` handling, handshake timeout, and test placement were all wrong. See the "Findings addressed" table.

**Goal:** Make the Ploinky router proxy browser **WebSocket upgrades** to declared HTTP-service agents with the same signed `x-ploinky-auth-info` identity it injects on HTTP requests, so agent WS endpoints (Soul Gateway's `/services/soul-gateway/management/ws/logs`) work behind the router — and fix the soul-gateway accept-GUID bug that would otherwise make any real browser reject the handshake.

**Architecture:** `RoutingServer.js` (ESM) creates `http.createServer(...)` with **no `'upgrade'` listener** (`RoutingServer.js:572`), so browser WebSockets behind the router hang. We add `server.on('upgrade', …)` that mirrors `handleHttpServiceRoute` (`routerHandlers.js:425`): resolve route → authenticate the session cookie (populating `req.user`, capturing any refreshed `Set-Cookie`) → strip client identity headers → rewrite external→internal path → build the signed auth-info header (mirroring the HTTP builder call) → transparently pipe the upgrade to the agent's port via `http.request`'s `'upgrade'` event, with a handshake timeout. The agent already accepts upgrades (`proxies/soul-gateway/src/core/http-server.mjs:77`) **but computes `Sec-WebSocket-Accept` with a non-RFC GUID** (`websocket-frame-codec.mjs:7`), which must be fixed first.

**Tech Stack:** Node.js **ESM** throughout (`ploinky/package.json` `"type":"module"`; `cli/server/*.js` use `import`/`export`). Node built-in `http`. Tests: `node --test` under `ploinky/tests/unit/*.test.mjs`, run by `npm test` → `./tests/run-all.sh`.

## Findings addressed (from review)

| # | Finding | Resolution |
| --- | --- | --- |
| 1 | Router is ESM, not CommonJS | All new code is ESM (`import`/`export`); module file is `cli/server/wsServiceProxy.js` (ESM `.js`). |
| 2 | Export assumptions wrong | Export **only** `stripRouterIdentityHeaders` from `routerHandlers.js`; import `loadApiRoutes`/`buildHttpServiceAuthInfoHeader` from `routerHandlers.js`, `hasInternalAgentSegment` from `internalAgentPath.js`, `sha256RawBodyHash` from `Agent/lib/requestHash.mjs`. |
| 3 | Soul Gateway WS accept GUID wrong | **New Task 1**: fix `WS_GUID` to the RFC value + fix the test to the RFC vector. |
| 4 | Auth capture drops Set-Cookie + real status | Capturing `res` records `statusCode` + headers; refreshed `Set-Cookie` is relayed into the 101; failure uses the real captured status. |
| 5 | Identity injection didn't mirror HTTP path | Always call `buildHttpServiceAuthInfoHeader` (it self-gates on `includeAuthInfo`/`issueInvocation`); fail closed for non-public services lacking a signed header. |
| 6 | `head` could drop early frames | Client `head` is written to the **agent** socket after the 101; upstream head to the browser socket. |
| 7 | Test location/fixtures won't run | Tests in `tests/unit/*.test.mjs`; route fixtures via a temp `PLOINKY_ROUTING_FILE`. |
| 8 | Mock e2e misses real wiring / import side-effects | E2e runs a **real router child process** with temp routing config against a mock upstream; `node --check` (not `require`) for load checks. |
| 9 | No handshake timeout → socket leak | `proxyWsUpgrade` has a handshake timeout that tears down both sockets. |
| 10 | Brittle 404 fallthrough | Single resolver pass returns `{matched, ok, status}`. |
| 11 | Client WS-timeout not optional | **New Task 6** (soul-gateway): WS-open timeout + SSE fallback; real-router `101` verification is a required gate. |

## Global Constraints

- **Blast radius = production router core** (`RoutingServer.js` fronts all agents/hosts). The `'upgrade'` handler is strictly additive; it must never touch the HTTP request path. Any throw inside it ends in `socket.destroy()`, never an unhandled rejection.
- **Security — fail closed:** `stripRouterIdentityHeaders(req.headers)` BEFORE forwarding; non-`public` services with no `req.user` → reject; non-`public` `includeAuthInfo` services that yield no signed header → reject; only forward to `apiRoutes[routeKey].hostPort`; re-apply `hasInternalAgentSegment` (DS015) 404.
- **ESM only.** `cli/server/*.js` are ESM modules (`import`/`export`); `Agent/lib/*.mjs` likewise. Match the surrounding files. `loadApiRoutes()`/`resolveHttpServiceRoute()` read global config — do not assume injectability without a fixture.
- Commit policy: no `Co-Authored-By`/AI attribution. No SSH deploy; production rollout via GitHub Actions only — out of plan scope.

---

## File Structure

| File | Change |
| --- | --- |
| `proxies/soul-gateway/src/core/websocket-frame-codec.mjs` | Fix `WS_GUID` to the RFC 6455 value (Task 1) |
| `proxies/soul-gateway/src/test/unit/websocket-codec.test.mjs` | Assert the RFC accept vector (Task 1) |
| `ploinky/cli/server/routerHandlers.js` | Add `stripRouterIdentityHeaders` to the ESM exports (Task 2) |
| `ploinky/cli/server/wsServiceProxy.js` | **NEW** ESM module: auth + signing + WS pipe (Task 3) |
| `ploinky/tests/unit/wsServiceProxy.test.mjs` | **NEW** unit tests (Task 3) |
| `ploinky/cli/server/RoutingServer.js` | Add `server.on('upgrade', …)` (Task 4) |
| `ploinky/tests/unit/wsProxyE2e.test.mjs` | **NEW** real-router child-process e2e (Task 5) |
| `proxies/soul-gateway/src/dashboard/js/app.mjs` | WS-open timeout + SSE fallback (Task 6) |

---

## Task 1: Fix the soul-gateway WebSocket-accept GUID (standalone bug)

This is a real bug independent of the router work: `computeWebSocketAccept` uses a non-RFC magic GUID, so a browser rejects the agent's 101. The unit test currently pins the wrong value, hiding it.

**Files:** Modify `proxies/soul-gateway/src/core/websocket-frame-codec.mjs`, `proxies/soul-gateway/src/test/unit/websocket-codec.test.mjs`

- [ ] **Step 1: Rewrite the test to the RFC 6455 vector (fails first)**

In `websocket-codec.test.mjs`, set the `computeWebSocketAccept` expectation to the canonical RFC example: key `dGhlIHNhbXBsZSBub25jZQ==` → accept `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`.
```js
assert.equal(
    computeWebSocketAccept('dGhlIHNhbXBsZSBub25jZQ=='),
    's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
);
```
Run: `cd proxies/soul-gateway && node --test src/test/unit/websocket-codec.test.mjs` → expect **FAIL** (current GUID produces a different accept), proving the bug.

- [ ] **Step 2: Fix the GUID**

In `websocket-frame-codec.mjs:7` change:
```js
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
```
(RFC 6455 §1.3. Was `258EAFA5-E914-47DA-95CA-5AB5DC11D65B`.)

- [ ] **Step 3: Re-run the test → PASS**

`cd proxies/soul-gateway && node --test src/test/unit/websocket-codec.test.mjs` → PASS. Then run the full unit suite `npm run test:unit` → expect green (no other test depended on the wrong value).

- [ ] **Step 4: Commit**

```bash
git add src/core/websocket-frame-codec.mjs src/test/unit/websocket-codec.test.mjs
git commit -m "Fix WebSocket Sec-WebSocket-Accept to use the RFC 6455 GUID"
```

---

## Task 2: Export `stripRouterIdentityHeaders` from `routerHandlers.js`

**Files:** Modify `ploinky/cli/server/routerHandlers.js`

- [ ] **Step 1: Confirm current export state**

```bash
cd ploinky
grep -n "^export function stripRouterIdentityHeaders\|stripRouterIdentityHeaders" cli/server/routerHandlers.js | head
```
Expected: defined at `:229` as `function stripRouterIdentityHeaders` (no `export`). `loadApiRoutes` (`:30`) and `buildHttpServiceAuthInfoHeader` (`:367`) already have `export`.

- [ ] **Step 2: Add `export`**

Change `function stripRouterIdentityHeaders(headers = {}) {` (`:229`) to `export function stripRouterIdentityHeaders(headers = {}) {`. Do not change the body or other call sites.

- [ ] **Step 3: Verify ESM import resolves**

```bash
node --input-type=module -e "import('./cli/server/routerHandlers.js').then(m=>console.log(['stripRouterIdentityHeaders','loadApiRoutes','buildHttpServiceAuthInfoHeader'].map(k=>k+':'+typeof m[k]).join(' ')))"
```
Expected: all three print `:function`.

- [ ] **Step 4: Commit**

```bash
git add cli/server/routerHandlers.js
git commit -m "Export stripRouterIdentityHeaders for the WS upgrade proxy"
```

---

## Task 3: Implement the ESM WS-upgrade proxy module + unit tests

**Files:** Create `ploinky/cli/server/wsServiceProxy.js`, `ploinky/tests/unit/wsServiceProxy.test.mjs`

**Interfaces produced:**
- `resolveUpgradeTarget({req,parsedUrl,policy}): Promise<{matched:boolean, ok?:boolean, status?:number, hostPort?, upstreamPath?, identityHeaders?, responseHeaders?}>`
- `handleHttpServiceUpgrade({req,socket,head,parsedUrl,policy}): Promise<boolean>` (returns `false` only when the path is not a declared service).
- `createCapturingRes()` (exported for tests).

- [ ] **Step 1: Failing unit test for non-service path**

Create `ploinky/tests/unit/wsServiceProxy.test.mjs`:
```js
import assert from 'node:assert';
import { test } from 'node:test';
import { resolveUpgradeTarget } from '../../cli/server/wsServiceProxy.js';

test('resolveUpgradeTarget returns matched:false for a non-service path', async () => {
    const req = { method: 'GET', url: '/definitely-not-a-service/ws', headers: {} };
    const parsedUrl = new URL(req.url, 'http://router.local');
    const policy = { httpRouteAccessPolicy: { evaluate: () => ({ access: 'deny' }) } };
    const out = await resolveUpgradeTarget({ req, parsedUrl, policy });
    assert.equal(out.matched, false);
});
```
Run: `cd ploinky && node --test tests/unit/wsServiceProxy.test.mjs` → FAIL (module missing).

- [ ] **Step 2: Implement `cli/server/wsServiceProxy.js` (ESM)**

```js
import http from 'http';
import { resolveHttpServiceRoute, buildServiceAgentPath } from './httpServiceRoutes.js';
import { buildHttpServiceAuthInfoHeader, stripRouterIdentityHeaders, loadApiRoutes } from './routerHandlers.js';
import { hasInternalAgentSegment } from './internalAgentPath.js';
import { sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import { ensureHttpRouteAccess } from './authHandlers/authContext.js';

const HANDSHAKE_TIMEOUT_MS = 10_000;

function lowerKeys(obj = {}) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[String(k).toLowerCase()] = v;
    return out;
}

// res-shaped sink so the existing cookie→user auth gate (which writes status,
// Set-Cookie refresh, and redirects to `res`) runs unchanged during an upgrade
// where only a raw socket exists. We capture statusCode + headers (esp.
// set-cookie) and read the {ok} result + req.user side effect.
export function createCapturingRes() {
    const headers = {};
    return {
        statusCode: 200,
        headersSent: false,
        finished: false,
        setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
        getHeader(name) { return headers[String(name).toLowerCase()]; },
        removeHeader(name) { delete headers[String(name).toLowerCase()]; },
        writeHead(status, maybeHeaders) {
            this.statusCode = status;
            if (maybeHeaders && typeof maybeHeaders === 'object') Object.assign(headers, lowerKeys(maybeHeaders));
            this.headersSent = true;
            return this;
        },
        write() { return true; },
        end() { this.finished = true; this.headersSent = true; },
    };
}

export async function resolveUpgradeTarget({ req, parsedUrl, policy }) {
    const pathname = parsedUrl?.pathname || '';
    const definition = resolveHttpServiceRoute(pathname);
    if (!definition) return { matched: false };

    const route = loadApiRoutes()[definition.routeKey];
    if (!route || !route.hostPort) return { matched: true, ok: false, status: 404 };

    const decision = policy.httpRouteAccessPolicy.evaluate({ pathname, method: 'GET', routeKey: definition.routeKey });
    const capRes = createCapturingRes();
    const access = await ensureHttpRouteAccess(req, capRes, parsedUrl, decision);
    if (!access || access.ok !== true) {
        return { matched: true, ok: false, status: capRes.statusCode || 401 };
    }
    if (definition.access !== 'public' && (!req.user || typeof req.user !== 'object')) {
        return { matched: true, ok: false, status: 401 };
    }

    req.headers = stripRouterIdentityHeaders(req.headers);
    const upstreamPath = buildServiceAgentPath(pathname, parsedUrl?.search, definition.externalPrefix, definition.internalPrefix);
    if (hasInternalAgentSegment(upstreamPath)) return { matched: true, ok: false, status: 404 };

    // Mirror the HTTP path: always call the builder (it returns {} unless
    // includeAuthInfo && req.user, and adds the signed invocation token only
    // when issueInvocation). Empty body hash — upgrades carry no body, same as
    // the GET requests that already work.
    let identityHeaders = {};
    try {
        identityHeaders = buildHttpServiceAuthInfoHeader(req, parsedUrl, definition, {
            bodyHash: sha256RawBodyHash(Buffer.alloc(0)),
            servicePath: upstreamPath,
        });
    } catch (_) {
        return { matched: true, ok: false, status: 500 };
    }
    if (definition.access !== 'public' && definition.includeAuthInfo && !identityHeaders['x-ploinky-auth-info']) {
        return { matched: true, ok: false, status: 401 }; // fail closed
    }

    const setCookie = capRes.getHeader('set-cookie');
    return {
        matched: true, ok: true,
        hostPort: route.hostPort,
        upstreamPath,
        identityHeaders,
        responseHeaders: setCookie ? { 'set-cookie': setCookie } : {},
    };
}

function buildStatusLine(statusCode, statusMessage, headers = {}) {
    const lines = [`HTTP/1.1 ${statusCode} ${statusMessage || ''}`.trim()];
    for (const [k, v] of Object.entries(headers)) {
        if (Array.isArray(v)) v.forEach((val) => lines.push(`${k}: ${val}`));
        else if (v != null) lines.push(`${k}: ${v}`);
    }
    return lines.join('\r\n') + '\r\n\r\n';
}

function closeSocket(socket, status, message) {
    try { socket.write(buildStatusLine(status, message)); } catch (_) {}
    try { socket.destroy(); } catch (_) {}
}

function proxyWsUpgrade({ socket, head, hostPort, upstreamPath, forwardHeaders, extraResponseHeaders }) {
    const proxyReq = http.request({
        hostname: '127.0.0.1', port: hostPort, method: 'GET', path: upstreamPath,
        headers: { ...forwardHeaders, host: `127.0.0.1:${hostPort}` },
    });
    let settled = false;
    const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proxyReq.destroy(); } catch (_) {}
        closeSocket(socket, 504, 'Gateway Timeout');
    }, HANDSHAKE_TIMEOUT_MS);

    proxyReq.on('upgrade', (proxyRes, agentSocket, agentHead) => {
        if (settled) { try { agentSocket.destroy(); } catch (_) {} return; }
        settled = true; clearTimeout(timer);
        socket.write(buildStatusLine(proxyRes.statusCode, proxyRes.statusMessage, { ...proxyRes.headers, ...extraResponseHeaders }));
        if (agentHead && agentHead.length) socket.write(agentHead);   // upstream → browser
        if (head && head.length) agentSocket.write(head);             // client → agent
        agentSocket.pipe(socket);
        socket.pipe(agentSocket);
        const teardown = () => { try { agentSocket.destroy(); } catch (_) {} try { socket.destroy(); } catch (_) {} };
        agentSocket.on('error', teardown); socket.on('error', teardown);
        agentSocket.on('close', () => { try { socket.destroy(); } catch (_) {} });
        socket.on('close', () => { try { agentSocket.destroy(); } catch (_) {} });
    });

    proxyReq.on('response', (proxyRes) => {            // agent refused upgrade (e.g. 401)
        if (settled) return;
        settled = true; clearTimeout(timer);
        socket.write(buildStatusLine(proxyRes.statusCode, proxyRes.statusMessage, proxyRes.headers));
        proxyRes.pipe(socket);
        proxyRes.on('end', () => { try { socket.destroy(); } catch (_) {} });
    });

    proxyReq.on('error', () => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        closeSocket(socket, 502, 'Bad Gateway');
    });

    proxyReq.end();
}

export async function handleHttpServiceUpgrade({ req, socket, head, parsedUrl, policy }) {
    let target;
    try {
        target = await resolveUpgradeTarget({ req, parsedUrl, policy });
    } catch (_) {
        closeSocket(socket, 500, 'Internal Server Error');
        return true;
    }
    if (!target.matched) return false;
    if (!target.ok) { closeSocket(socket, target.status || 401); return true; }
    proxyWsUpgrade({
        socket, head,
        hostPort: target.hostPort,
        upstreamPath: target.upstreamPath,
        forwardHeaders: { ...req.headers, ...target.identityHeaders },
        extraResponseHeaders: target.responseHeaders || {},
    });
    return true;
}
```

- [ ] **Step 3: Run the non-service test → PASS**

`cd ploinky && node --test tests/unit/wsServiceProxy.test.mjs` → PASS.

- [ ] **Step 4: Add a fixture-backed auth+signing test**

Add a test that points routing at a temp fixture so `resolveHttpServiceRoute`/`loadApiRoutes` see a declared service. Pattern (confirm the exact env/file name by reading `httpServiceRoutes.js:13-21` for the config loader and an existing router test that sets it):
```js
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Write a routing fixture declaring an http-service (externalPrefix
// '/services/demo', internalPrefix '/', includeAuthInfo+invocation), set the
// router config env var (confirm the real name), and an apiRoutes entry with a
// hostPort. Then assert resolveUpgradeTarget(...) for a path under the prefix
// returns { matched:true, ok:true } with identityHeaders carrying
// 'x-ploinky-auth-info' and upstreamPath rewritten to the internal prefix.
```
Provide a stub `req.user = { id:'u1', roles:['admin'] }` and a `policy.httpRouteAccessPolicy.evaluate` returning `{access:'authenticated', routeKey}`. Use the real `ensureHttpRouteAccess` if the fixture makes it pass; otherwise document why a stub is used. Run `node --test tests/unit/wsServiceProxy.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/server/wsServiceProxy.js tests/unit/wsServiceProxy.test.mjs
git commit -m "Add ESM authenticated WebSocket-upgrade proxy for HTTP-service routes"
```

---

## Task 4: Wire `server.on('upgrade')` into `RoutingServer.js`

**Files:** Modify `ploinky/cli/server/RoutingServer.js`

- [ ] **Step 1: Import (ESM)**

Add near the other `cli/server/*` imports at the top:
```js
import { handleHttpServiceUpgrade } from './wsServiceProxy.js';
```

- [ ] **Step 2: Register the listener after `server` is created**

After the `const server = http.createServer(...)` block (`RoutingServer.js:572`) and before `server.on('error', …)` (`:592`), add:
```js
server.on('upgrade', async (req, socket, head) => {
    try {
        const parsedUrl = new URL(req.url, 'http://router.local');
        const handled = await handleHttpServiceUpgrade({ req, socket, head, parsedUrl, policy });
        if (!handled) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); }
    } catch (_) {
        try { socket.destroy(); } catch (_) {}
    }
});
```
`policy` is module-scope (same object used at `:357` and `:644`) so it is in scope here. If the normal request handler builds `parsedUrl` differently, match that so `pathname` is identical.

- [ ] **Step 3: Syntax-check (do NOT `node -e require` — it starts the server at import, `:621`)**

```bash
cd ploinky && node --check cli/server/RoutingServer.js && echo "RoutingServer syntax OK"
```
Expected: `RoutingServer syntax OK`.

- [ ] **Step 4: Full suite — no regression**

```bash
npm test
```
Expected: `./tests/run-all.sh` passes at the pre-change baseline. STOP if any previously-green test fails.

- [ ] **Step 5: Commit**

```bash
git add cli/server/RoutingServer.js
git commit -m "Proxy WebSocket upgrades to HTTP-service agents in the router"
```

---

## Task 5: Real-router end-to-end test (child process + mock upstream)

A handler-only test misses router wiring, policy binding, and the import-time `server.listen` (`RoutingServer.js:621`). This test runs the actual router.

**Files:** Create `ploinky/tests/unit/wsProxyE2e.test.mjs`

- [ ] **Step 1: Write the e2e test**

It must: (a) start a mock upstream `http` server that handles `'upgrade'`, asserts the request carried `x-ploinky-auth-info`, completes the handshake (using the router's own `acceptWebSocketUpgrade` from `cli/server/utils/websocket.js`), and echoes one frame; (b) write a temp routing config + apiRoutes mapping a service prefix to the mock's port (confirm the env/file names from `httpServiceRoutes.js` and an existing router test); (c) spawn the router as a child process (`node cli/server/RoutingServer.js`) with `PORT` and the temp config in env; (d) open a WS client through the router path; (e) assert `101` + echo round-trip + that the mock observed the signed header. Tear down both servers.

- [ ] **Step 2: Run it**

```bash
cd ploinky && node --test tests/unit/wsProxyE2e.test.mjs
```
Expected: PASS. If spawning the full router proves impractical in the harness, fall back to extracting an importable `createRoutingServer()` factory from the listen side-effect (separate, reviewed refactor) and test that — log the choice.

- [ ] **Step 3: Real dashboard verification (REQUIRED release gate)**

With Soul Gateway (Task 1 GUID fix included) running behind the router: open the management dashboard, Safari Web Inspector → Network, reload, and confirm `…/management/ws/logs` returns **`101 Switching Protocols`** (was hanging) and a newly-logged request appears in the **Logs** tab **without a refresh**. Capture the `101` as the proof artifact. This is a hard gate before any production rollout.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/wsProxyE2e.test.mjs
git commit -m "Add real-router WebSocket proxy end-to-end test"
```

---

## Task 6: Client WS-open timeout + SSE fallback (soul-gateway resilience)

Defense-in-depth (review #11): today `connectWs()` only falls back to SSE in `onclose`, so a hung upgrade never falls back. Make the client resilient regardless of router state.

**Files:** Modify `proxies/soul-gateway/src/dashboard/js/app.mjs`

- [ ] **Step 1: Add an open-timeout to `connectWs()`**

In `connectWs()` (`app.mjs:628`), after `const ws = new WebSocket(wsUrl)`, start a timer; if `onopen` hasn't fired within ~4s, close the socket and call `connectSse()` (guard so the existing `onclose` fallback doesn't double-fire). Clear the timer in `onopen`/`onclose`.
```js
let opened = false;
const openTimer = setTimeout(() => {
    if (!opened) { try { ws.close(); } catch (_) {} this.connectSse(); }
}, 4000);
ws.onopen = () => { opened = true; clearTimeout(openTimer); this.wsConnected = true; this.streamMode = 'ws'; };
// in onclose: clearTimeout(openTimer); and keep the existing !opened → connectSse() guard
```

- [ ] **Step 2: Verify the fallback path by grep + a manual disconnect**

`grep -n "openTimer\|connectSse" src/dashboard/js/app.mjs` confirms wiring. Manually (with the router WS intentionally unavailable) confirm the Logs tab still streams via SSE within ~4s. (No JS unit harness exists for the dashboard.)

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/js/app.mjs
git commit -m "Fall back to SSE when the dashboard WebSocket does not open"
```

---

## Rollout (out of scope — do not execute without explicit request)

Production router + agent change. Deploy via **GitHub Actions** (never SSH). Task 5 Step 3 (`101` in the real dashboard) is a required pre-rollout gate. Order: ship Task 1 (GUID) first (standalone fix), then the router change.

## Self-Review

- **Spec coverage:** GUID bug (Task 1), reusable export (Task 2), ESM proxy with auth/signing/head/timeout/Set-Cookie (Task 3), router wiring (Task 4), real e2e + required dashboard gate (Task 5), client resilience (Task 6). Each review finding maps to a task in the "Findings addressed" table.
- **Placeholder scan:** the proxy module is fully concrete. The two fixture-dependent test steps (Task 3 Step 4, Task 5) name the exact assertions but defer the precise routing-config env var to a verification read of `httpServiceRoutes.js:13-21` — flagged explicitly, not hand-waved, because that loader's contract must be confirmed against the code at implementation time.
- **Type/name consistency:** `resolveUpgradeTarget`/`handleHttpServiceUpgrade`/`createCapturingRes` and the imported helpers match their definitions (`routerHandlers.js`, `httpServiceRoutes.js`, `internalAgentPath.js`, `Agent/lib/requestHash.mjs`, `authHandlers/authContext.js`) as verified.
