# Router Policy Command-Bus + SOLID Class Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Commit policy (workspace override):** Do NOT run `git commit` automatically. Each task ends at a logical commit point — stage the files and ask the human to confirm the commit. The `git commit` lines below are the intended message/scope, not an instruction to commit unattended.

**Goal:** Re-express `ploinky/cli/server/policy/` as an OOP class collection wired with SOLID, with `POST /whitelist/command` implemented via the Command pattern — a pure structural refactor preserving all DS013/DS014 behavior.

**Architecture:** A composition root (`policy/index.js`) builds singletons — a `PolicyStateRepository` (persistence), `PolicyAuditLog`, `HttpRouteWhitelist`, `McpToolPolicy`, `HttpShareAuthorizer` — plus 7 `WhitelistCommand` classes behind a `PolicyCommandRegistry` and a `PolicyCommandInvoker` (the HTTP adapter). `RoutingServer`, `mcp-proxy/index.js`, and `routerHandlers.js` import the wired `policy` object and call methods. Dependencies flow via constructor injection so each unit is testable with fakes.

**Tech Stack:** Node.js ESM, `node --test`, `node:crypto`/`node:fs`/`node:http`. No new dependencies.

---

## File Structure

Create under `cli/server/policy/`:

| File | Responsibility |
|---|---|
| `PolicyStateRepository.js` | Load/atomic-write/index `policy-state.json`; fail-closed on corrupt |
| `PolicyAuditLog.js` | Append-only JSONL audit |
| `WhitelistPath.js` | Pure path normalize/validate + internal-route + readonly-method predicates |
| `HttpRouteWhitelist.js` | Guest read-only reachability over repo entries |
| `Caller.js` | `Caller` value object + `Caller.fromRequest(req)` |
| `McpToolPolicy.js` | `accessFromTags`/`evaluate`/`filterTools`/`collectDefaults`/`bootstrap` |
| `ShareAuthorizer.js` | Abstract base (contract) |
| `HttpShareAuthorizer.js` | Deny-by-default router→agent authorize call |
| `commands/WhitelistCommand.js` | Abstract command base; documents `CommandContext`/`CommandResult` shapes |
| `commands/HttpWhitelist{Add,Remove,Check,List}Command.js` | 4 whitelist commands |
| `commands/McpPolicy{Set,Get,List}Command.js` | 3 MCP-policy commands |
| `PolicyCommandRegistry.js` | name → command instance |
| `PolicyCommandInvoker.js` | HTTP adapter: auth → context → authorize → execute → respond → audit |
| `index.js` | Composition root — exports `policy` |

Modify: `cli/server/RoutingServer.js`, `cli/server/mcp-proxy/index.js`, `cli/server/routerHandlers.js`.
Delete (logic relocated): `cli/server/policy/{policyStore,mcpPolicy,httpWhitelist,whitelistCommand,shareAuthorizer}.js` and tests `tests/unit/{mcpPolicy,httpWhitelist,whitelistCommand}.test.mjs`.
New tests: `tests/unit/{policyStateRepository,httpRouteWhitelist,mcpToolPolicy,whitelistCommands,policyCommandInvoker}.test.mjs`.

Implementation order is dependency order: receivers → commands → registry/invoker → composition root → consumer rewire → delete-old + verify.

---

## Task 1: PolicyStateRepository + PolicyAuditLog

**Files:**
- Create: `cli/server/policy/PolicyStateRepository.js`, `cli/server/policy/PolicyAuditLog.js`
- Test: `tests/unit/policyStateRepository.test.mjs`

- [ ] **Step 1: Write the failing test** (`tests/unit/policyStateRepository.test.mjs`)

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-repo-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
const { PolicyStateRepository } = await import(`../../cli/server/policy/PolicyStateRepository.js?t=${Date.now()}`);
const file = path.join(tempDir, '.ploinky', 'data', 'router-security', 'policy-state.json');

test.after(() => { process.chdir(originalCwd); fs.rmSync(tempDir, { recursive: true, force: true }); });

function writeState(mcpTools = [], httpRoutes = []) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: 'router-policy', httpRoutes, mcpTools }, null, 2));
}
function mcp(agent, tool, access, extra = {}) {
    return { agent, tool, access, source: 'admin', enabled: true, createdAt: 't', createdBy: 't', updatedAt: 't', updatedBy: 't', ...extra };
}

test('missing file is a valid empty state, not corrupt', () => {
    const repo = new PolicyStateRepository();
    assert.equal(repo.isCorrupt(), false);
    assert.equal(repo.getMcpToolEntry('a', 'b'), null);
    assert.deepEqual(repo.listHttpRoutes(), []);
});

test('reads entries and indexes by agent+tool and by path', () => {
    writeState([mcp('explorer', 'docs', 'authenticated')], [{ path: '/x/*', enabled: true }]);
    const repo = new PolicyStateRepository();
    assert.equal(repo.getMcpToolEntry('explorer', 'docs').access, 'authenticated');
    assert.equal(repo.getHttpRouteEntry('/x/*').enabled, true);
});

test('corrupt file fails closed: isCorrupt true, accessors signal corrupt, mutate refuses', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const repo = new PolicyStateRepository();
    assert.equal(repo.isCorrupt(), true);
    assert.equal(repo.getMcpToolEntry('a', 'b').corrupt, true);
    assert.throws(() => repo.mutate((s) => s), /POLICY_PERSISTENCE_ERROR|corrupt/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json'); // not overwritten
});

test('mutate writes atomically and re-reads the new state', () => {
    writeState([], []);
    const repo = new PolicyStateRepository();
    repo.mutate((state) => { state.mcpTools.push(mcp('a', 'b', 'internal')); return state; });
    assert.equal(repo.getMcpToolEntry('a', 'b').access, 'internal');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcpTools.length, 1); // valid JSON on disk
});
```

- [ ] **Step 2: Run the test, expect FAIL** — `cd ploinky && node --test tests/unit/policyStateRepository.test.mjs` → FAIL (`Cannot find module PolicyStateRepository.js`).

- [ ] **Step 3: Implement `PolicyAuditLog.js`**

```javascript
import fs from 'node:fs';
import path from 'node:path';

export class PolicyAuditLog {
    constructor({ dir } = {}) { this._dirFn = dir || (() => path.join(process.env.PLOINKY_WORKSPACE_ROOT || process.cwd(), '.ploinky', 'data', 'router-security')); }
    record(entry) {
        try {
            const dir = this._dirFn();
            fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(path.join(dir, 'policy-audit.log'), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
        } catch (err) {
            console.error(`[ploinky] failed to append policy audit: ${err?.message || err}`);
        }
    }
}
```

- [ ] **Step 4: Implement `PolicyStateRepository.js`** — port the existing logic of `cli/server/policy/policyStore.js` (the `SCHEMA`/`ACCESS_VALUES` constants, `emptyState`, `cloneState`, `validateState`, `buildIndex`, the mtime+size cache in `loadPolicyState`, `getMcpToolEntry`, `listMcpTools`, `listHttpRoutes`, `getHttpRouteEntry`, `updatePolicyState`) into instance methods. Mapping: `loadPolicyState()`→`#load()` (private, populates `this._cache`); `getMcpToolEntry/listMcpTools/listHttpRoutes/getHttpRouteEntry`→same names as methods returning `{corrupt:true}`/`null`/`[]` exactly as today; `updatePolicyState(updater)`→`mutate(updater)` (throws an `Error` with `code='POLICY_PERSISTENCE_ERROR'` when corrupt, atomic temp→rename, then `invalidate()`); add `isCorrupt()` (returns `#load().ok === false`) and `invalidate()`. The workspace-path resolver is the same `process.env.PLOINKY_WORKSPACE_ROOT || process.cwd()` + `.ploinky/data/router-security/policy-state.json`. Keep the cache as instance fields (`this._cache`, `this._cacheKey`).

```javascript
// Skeleton (port bodies from policyStore.js as described above):
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = 'router-policy';
const ACCESS_VALUES = new Set(['authenticated', 'internal', 'admin']);

export class PolicyStateRepository {
    constructor({ file } = {}) {
        this._fileFn = file || (() => path.join(process.env.PLOINKY_WORKSPACE_ROOT || process.cwd(), '.ploinky', 'data', 'router-security', 'policy-state.json'));
        this._cache = null; this._cacheKey = '';
    }
    // #load(): { ok:true, state, index } | { ok:false, corrupt:true }  — port loadPolicyState()
    // isCorrupt(), getMcpToolEntry(agent,tool), listMcpTools(), listHttpRoutes(),
    // getHttpRouteEntry(path), invalidate(), mutate(updater)  — port the matching functions
}
export { SCHEMA, ACCESS_VALUES };
```

- [ ] **Step 5: Run the test, expect PASS** — `cd ploinky && node --test tests/unit/policyStateRepository.test.mjs` → PASS (4 tests).

- [ ] **Step 6: Stage + commit point** — `git add cli/server/policy/PolicyStateRepository.js cli/server/policy/PolicyAuditLog.js tests/unit/policyStateRepository.test.mjs` → message: `refactor(policy): PolicyStateRepository + PolicyAuditLog classes`. (Pause for human confirmation.)

---

## Task 2: WhitelistPath + HttpRouteWhitelist

**Files:**
- Create: `cli/server/policy/WhitelistPath.js`, `cli/server/policy/HttpRouteWhitelist.js`
- Test: `tests/unit/httpRouteWhitelist.test.mjs`

- [ ] **Step 1: Write the failing test** (uses a **fake repository** — demonstrates DI isolation, no temp files)

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { WhitelistPath } from '../../cli/server/policy/WhitelistPath.js';
import { HttpRouteWhitelist } from '../../cli/server/policy/HttpRouteWhitelist.js';

class FakeRepo {
    constructor(entries = [], corrupt = false) { this._e = entries; this._c = corrupt; }
    listHttpRoutes() { return this._c ? { corrupt: true, entries: [] } : { corrupt: false, entries: this._e }; }
}
const route = (p, extra = {}) => ({ path: p, enabled: true, ...extra });

test('WhitelistPath.normalize accepts trailing /* and rejects bad forms', () => {
    assert.equal(WhitelistPath.normalize('/explorer/public-view/folder/*').path, '/explorer/public-view/folder/*');
    assert.equal(WhitelistPath.normalize('explorer/x').code, 'INVALID_PATH');
    assert.equal(WhitelistPath.normalize('/a/../b').code, 'INVALID_PATH');
    assert.equal(WhitelistPath.normalize('/%2Fsecret').code, 'INVALID_PATH');
    assert.equal(WhitelistPath.normalize('/a/*/b').code, 'INVALID_WILDCARD');
    assert.equal(WhitelistPath.normalize('/**').code, 'INVALID_WILDCARD');
    assert.equal(WhitelistPath.normalize('/').code, 'INVALID_PATH');
});

test('WhitelistPath.isInternal flags router-owned routes', () => {
    for (const p of ['/whitelist/command', '/auth/login', '/admin/x', '/__agent/x', '/explorer/__agent/s', '/metrics', '/health/internal', '/*'])
        assert.equal(WhitelistPath.isInternal(p), true, p);
    assert.equal(WhitelistPath.isInternal('/explorer/public-view/x'), false);
});

test('isReachableByGuest: wildcard/exact/method/query + internal-never + corrupt-fail-closed', () => {
    const wl = new HttpRouteWhitelist({ repository: new FakeRepo([route('/explorer/public-view/folder/*'), route('/x/y')]) });
    assert.equal(wl.isReachableByGuest('/explorer/public-view/folder/a', 'GET'), true);
    assert.equal(wl.isReachableByGuest('/explorer/public-view/folder', 'GET'), true);
    assert.equal(wl.isReachableByGuest('/explorer/public-view/other', 'GET'), false);
    assert.equal(wl.isReachableByGuest('/x/y', 'HEAD'), true);
    assert.equal(wl.isReachableByGuest('/x/y', 'POST'), false);
    assert.equal(wl.isReachableByGuest('/x/y?t=secret', 'GET'), true);

    const wlInternal = new HttpRouteWhitelist({ repository: new FakeRepo([route('/auth/login'), route('/explorer/__agent/s')]) });
    assert.equal(wlInternal.isReachableByGuest('/auth/login', 'GET'), false);
    assert.equal(wlInternal.isReachableByGuest('/explorer/__agent/s', 'GET'), false);

    assert.equal(new HttpRouteWhitelist({ repository: new FakeRepo([], true) }).isReachableByGuest('/x/y', 'GET'), false);
});
```

- [ ] **Step 2: Run, expect FAIL** — `node --test tests/unit/httpRouteWhitelist.test.mjs`.

- [ ] **Step 3: Implement `WhitelistPath.js`** — port `normalizeWhitelistPath`, `isInternalRoute`, `isReadonlyMethod` from `httpWhitelist.js` into `static normalize(raw, {allowWildcard=true})`, `static isInternal(path)`, `static isReadonlyMethod(method)`. Same `INTERNAL_EXACT` set and rules verbatim.

- [ ] **Step 4: Implement `HttpRouteWhitelist.js`**

```javascript
import { WhitelistPath } from './WhitelistPath.js';

export class HttpRouteWhitelist {
    constructor({ repository }) { this._repo = repository; }
    isReachableByGuest(requestPath, method) {
        if (!WhitelistPath.isReadonlyMethod(method)) return false;
        const norm = WhitelistPath.normalize(requestPath, { allowWildcard: false });
        if (!norm.ok || WhitelistPath.isInternal(norm.path)) return false;
        const { entries, corrupt } = this._repo.listHttpRoutes();
        if (corrupt) return false;
        for (const entry of entries) {
            if (!entry || entry.enabled === false || typeof entry.path !== 'string') continue;
            if (WhitelistPath.isInternal(entry.path)) continue;
            if (this._matches(norm.path, entry.path)) return true;
        }
        return false;
    }
    _matches(reqPath, entryPath) {
        if (entryPath.endsWith('/*')) { const prefix = entryPath.slice(0, -2); return prefix && (reqPath === prefix || reqPath.startsWith(`${prefix}/`)); }
        return reqPath === entryPath;
    }
}
```

Note: `listHttpRoutes()` here returns `{corrupt, entries}` — keep `PolicyStateRepository.listHttpRoutes()` returning that shape (it already does in policyStore).

- [ ] **Step 5: Run, expect PASS** — `node --test tests/unit/httpRouteWhitelist.test.mjs` (3 tests).
- [ ] **Step 6: Stage + commit point** — message: `refactor(policy): WhitelistPath value object + HttpRouteWhitelist`.

---

## Task 3: Caller + McpToolPolicy

**Files:**
- Create: `cli/server/policy/Caller.js`, `cli/server/policy/McpToolPolicy.js`
- Test: `tests/unit/mcpToolPolicy.test.mjs`

- [ ] **Step 1: Write the failing test** — port every assertion from the current `tests/unit/mcpPolicy.test.mjs` (accessFromTags mapping, persisted-wins bootstrap, the full class/caller matrix, caller classification, tools/list filtering, corrupt fail-closed) but against the class API: construct `new McpToolPolicy({ repository: new PolicyStateRepository() })` in a temp workspace, and use `Caller.fromRequest(req)` for classification. (Reuse the temp-workspace + `writePolicy` helpers from the existing suite verbatim; replace the function calls with `policy.accessFromTags`, `policy.evaluate`, `policy.filterTools`, `policy.bootstrap`, `Caller.fromRequest`.)

- [ ] **Step 2: Run, expect FAIL**.

- [ ] **Step 3: Implement `Caller.js`**

```javascript
export class Caller {
    constructor({ kind, id = '', roles = [], isAdmin = false }) { this.kind = kind; this.id = id; this.roles = roles; this.isAdmin = isAdmin; }
    static fromRequest(req) {
        const delegated = req?.delegatedAgentVerified;
        if (delegated && typeof delegated === 'object' && delegated.callerPrincipal)
            return new Caller({ kind: 'agent', id: String(delegated.callerPrincipal) });
        if (req?.user && typeof req.user === 'object') {
            const roles = Array.isArray(req.user.roles) ? req.user.roles.map((r) => String(r || '').trim().toLowerCase()).filter(Boolean) : [];
            const username = String(req.user.username || '').trim().toLowerCase();
            const id = String(req.user.id || '').trim().toLowerCase();
            const isGuest = roles.includes('guest');
            const isAdmin = !isGuest && (roles.includes('admin') || username === 'admin' || id === 'local:admin');
            return new Caller({ kind: isGuest ? 'guest' : 'user', id: String(req.user.id || ''), roles, isAdmin });
        }
        return new Caller({ kind: 'none' });
    }
}
```

- [ ] **Step 4: Implement `McpToolPolicy.js`** — port `accessFromTags`, `collectMcpToolDefaults`(→`collectDefaults`), `bootstrapMcpPolicy`(→`bootstrap`), `evaluateMcpAccess`(→`evaluate`), `filterToolsForCaller`(→`filterTools`) from `mcpPolicy.js` into methods on a class holding `this._repo`. `evaluate({agent,tool,caller})` reads `this._repo.getMcpToolEntry(...)`; `bootstrap(routes)` calls `this._repo.mutate(...)`. The class/caller matrix, tag rules, `REPOS_DIR` mcp-config reading, and guest-allowed-for-`authenticated` decision are unchanged.

- [ ] **Step 5: Run, expect PASS**.
- [ ] **Step 6: Stage + commit point** — message: `refactor(policy): Caller value object + McpToolPolicy service`.

---

## Task 4: ShareAuthorizer + HttpShareAuthorizer

**Files:** Create `cli/server/policy/ShareAuthorizer.js`, `cli/server/policy/HttpShareAuthorizer.js`. (No standalone test — covered via the command test with a fake; `HttpShareAuthorizer` is exercised by `policyCommandInvoker.test` indirectly.)

- [ ] **Step 1: Implement `ShareAuthorizer.js`** (the abstract contract)

```javascript
export class ShareAuthorizer {
    // Returns Promise<{ allowed: boolean, reason: string }>. Deny by default.
    async authorize(_ctx) { return { allowed: false, reason: 'not_implemented' }; }
}
```

- [ ] **Step 2: Implement `HttpShareAuthorizer.js`** — `extends ShareAuthorizer`; port the body of `shareAuthorizer.js`'s `authorizePublicRouteShare` into `async authorize({ agentName, normalizedPath, user })`, keeping the `readRoutingRoutes`/`resolveOwningRoute`/`postJson` helpers (as private methods or module functions) and the deny-on-anything-unexpected behavior. It depends on `buildRouterRequest` (from `mcp-proxy/invocationMinter.js`) and `computeRch` (from `Agent/lib/requestHash.mjs`) exactly as today.

- [ ] **Step 3: Sanity** — `node --check cli/server/policy/ShareAuthorizer.js cli/server/policy/HttpShareAuthorizer.js`.
- [ ] **Step 4: Stage + commit point** — message: `refactor(policy): ShareAuthorizer interface + HttpShareAuthorizer`.

---

## Task 5: Command base + 7 command classes

**Files:** Create `cli/server/policy/commands/WhitelistCommand.js` (base) and the 7 concrete command files.
Test: `tests/unit/whitelistCommands.test.mjs`.

- [ ] **Step 1: Write the failing test** — port every assertion from the current `tests/unit/whitelistCommand.test.mjs` (admin add → guest reachable; internal route → `INTERNAL_ROUTE_NOT_ALLOWED`; invalid wildcard; non-admin add denied/allowed via authorizer; `mcp.policy.set` admin-required + invalid-access; unknown command — *moved to the registry/invoker test in Task 6*; corrupt-not-overwritten; audit-no-tokens) but constructing commands directly with injected fakes:

```javascript
// shape of each case:
const repo = new PolicyStateRepository(); // temp workspace
const allow = { authorize: async () => ({ allowed: true }) };
const deny  = { authorize: async () => ({ allowed: false }) };
const cmd = new HttpWhitelistAddCommand({ repository: repo, whitelist: new HttpRouteWhitelist({ repository: repo }), authorizer: deny });
const ctx = { command: 'http.whitelist.add', body: { path: '/explorer/shared/a' }, user: { id: 'local:bob' }, isAdmin: false };
const authz = await cmd.authorize(ctx);            // → { ok:false, error:{code:'FORBIDDEN'} }
// admin path: cmd.authorize({...,isAdmin:true}) → { ok:true }; then cmd.execute(ctx) → { ok:true, status:200, data:{path}, audit:{path} }
```

Assertions to carry over verbatim: `INTERNAL_ROUTE_NOT_ALLOWED` (400), `INVALID_WILDCARD`, `FORBIDDEN` (403, non-admin + deny authorizer), `POLICY_ENTRY_EXISTS` (409), `POLICY_ENTRY_NOT_FOUND` (404), `ADMIN_REQUIRED` (403 for `McpPolicySetCommand` non-admin), invalid access → `UNKNOWN_COMMAND` (400), and `mcp.policy.set` success persists with `source:'admin'`, `updatedBy:'user:local:admin'`. Audit fields are returned in `result.audit` (the invoker writes them, so commands' tests assert `result.audit`).

- [ ] **Step 2: Run, expect FAIL**.

- [ ] **Step 3: Implement `commands/WhitelistCommand.js`** (base + shapes)

```javascript
// CommandContext: { command, body, user, isAdmin, caller }
// CommandResult: { ok, status, data?, error?{code,message}, audit?{...} }
export class WhitelistCommand {
    get name() { throw new Error('WhitelistCommand.name must be overridden'); }
    async authorize(_ctx) { return { ok: true }; }                       // override for admin/share gating
    async execute(_ctx) { throw new Error('WhitelistCommand.execute must be overridden'); }
    _ok(status, data, audit) { return { ok: true, status, data, audit }; }
    _fail(status, code, message, audit) { return { ok: false, status, error: { code, message }, audit }; }
}
```

- [ ] **Step 4: Implement the 7 commands** — each `extends WhitelistCommand`, constructor `({ repository, whitelist, authorizer })` (take only what it needs), `get name()` returns the dotted command string. Port the per-command branches of `whitelistCommand.js`'s `dispatchWhitelistCommand` into `authorize`/`execute`:
  - `HttpWhitelistAddCommand` (`http.whitelist.add`): `authorize` — normalize path (else `_fail(400, norm.code)`), reject internal (`INTERNAL_ROUTE_NOT_ALLOWED`), then admin-or-`authorizer.authorize(...)` (`FORBIDDEN`); `execute` — `repository.mutate` push (dup → `POLICY_ENTRY_EXISTS`), audit `{path}`.
  - `HttpWhitelistRemoveCommand` (`http.whitelist.remove`): symmetric; not-found → `POLICY_ENTRY_NOT_FOUND`.
  - `HttpWhitelistCheckCommand` (`http.whitelist.check`): any authed; `data:{path, public: whitelist.isReachableByGuest(norm.path,'GET')}`.
  - `HttpWhitelistListCommand` (`http.whitelist.list`): `repository.listHttpRoutes()` (corrupt → `POLICY_PERSISTENCE_ERROR`).
  - `McpPolicySetCommand` (`mcp.policy.set`): `authorize` admin-only (`ADMIN_REQUIRED`); `execute` validate `access` (else `UNKNOWN_COMMAND`), `repository.mutate` upsert, audit `{agent,tool,access}`.
  - `McpPolicyGetCommand` / `McpPolicyListCommand`: admin-only; read repo (`POLICY_ENTRY_NOT_FOUND` / `POLICY_PERSISTENCE_ERROR`).

- [ ] **Step 5: Run, expect PASS**.
- [ ] **Step 6: Stage + commit point** — message: `refactor(policy): Command base + 7 whitelist/mcp command classes`.

---

## Task 6: PolicyCommandRegistry + PolicyCommandInvoker

**Files:** Create `cli/server/policy/PolicyCommandRegistry.js`, `cli/server/policy/PolicyCommandInvoker.js`.
Test: `tests/unit/policyCommandInvoker.test.mjs`.

- [ ] **Step 1: Write the failing test** — temp workspace + a real composition (or hand-built registry). Cover: unknown command → 400 `UNKNOWN_COMMAND`; no session cookie → 401 `AUTH_REQUIRED`; admin `mcp.policy.set` → 200 then `repository.getMcpToolEntry` reflects it; the audit log file has `"command":"mcp.policy.set"` and no `Bearer `/`eyJ`. Use the same `MockResponse` + cookie minting pattern as the existing `whitelistCommand`/`guestAuthRoutes` suites.

- [ ] **Step 2: Run, expect FAIL**.

- [ ] **Step 3: Implement `PolicyCommandRegistry.js`**

```javascript
export class PolicyCommandRegistry {
    constructor() { this._commands = new Map(); }
    register(command) { this._commands.set(command.name, command); return this; }
    get(name) { return this._commands.get(String(name || '')) || null; }
}
```

- [ ] **Step 4: Implement `PolicyCommandInvoker.js`** — `constructor({ registry, auditLog, getSession, isAdminUser })` (inject the session resolver + admin predicate so it's testable). `async handle(req, res)`:
  1. require POST (else 405);
  2. read `ploinky_jwt` cookie via `parseCookies` (from `handlers/common.js`), `getSession(cookie)`; no user → 401 `AUTH_REQUIRED`;
  3. `readJsonBody(req)` (catch → 400 `UNKNOWN_COMMAND`/invalid JSON);
  4. `const command = registry.get(body.command)`; missing → 400 `UNKNOWN_COMMAND`;
  5. build `ctx = { command: body.command, body, user, isAdmin: isAdminUser(user), caller: Caller.fromRequest(req) }`;
  6. `const authz = await command.authorize(ctx)`; if `!authz.ok` → respond `authz.error`/status + `auditLog.record({user, command, ...authz.audit, ok:false, code})`;
  7. `const result = await command.execute(ctx)`; respond `result` + `auditLog.record({user, command, ...result.audit, ok:result.ok, code:result.error?.code})`;
  8. respond JSON via `sendJson` (from `authHandlers.js`).
  The HTTP-status/JSON mapping and error codes match today's `handleWhitelistCommand` exactly.

- [ ] **Step 5: Run, expect PASS**.
- [ ] **Step 6: Stage + commit point** — message: `refactor(policy): PolicyCommandRegistry + PolicyCommandInvoker`.

---

## Task 7: Composition root (`index.js`)

**Files:** Create `cli/server/policy/index.js`.

- [ ] **Step 1: Implement** — instantiate the singletons and wire the 7 commands into the registry; export `policy`.

```javascript
import { getSession, isLocalAdminUser } from '../auth/localService.js';
import { PolicyStateRepository } from './PolicyStateRepository.js';
import { PolicyAuditLog } from './PolicyAuditLog.js';
import { HttpRouteWhitelist } from './HttpRouteWhitelist.js';
import { McpToolPolicy } from './McpToolPolicy.js';
import { Caller } from './Caller.js';
import { HttpShareAuthorizer } from './HttpShareAuthorizer.js';
import { PolicyCommandRegistry } from './PolicyCommandRegistry.js';
import { PolicyCommandInvoker } from './PolicyCommandInvoker.js';
import { HttpWhitelistAddCommand } from './commands/HttpWhitelistAddCommand.js';
// ...import the other 6 commands

const repository = new PolicyStateRepository();
const auditLog = new PolicyAuditLog();
const httpWhitelist = new HttpRouteWhitelist({ repository });
const mcpToolPolicy = new McpToolPolicy({ repository });
const shareAuthorizer = new HttpShareAuthorizer();

const registry = new PolicyCommandRegistry()
    .register(new HttpWhitelistAddCommand({ repository, whitelist: httpWhitelist, authorizer: shareAuthorizer }))
    .register(new HttpWhitelistRemoveCommand({ repository, authorizer: shareAuthorizer }))
    .register(new HttpWhitelistCheckCommand({ repository, whitelist: httpWhitelist }))
    .register(new HttpWhitelistListCommand({ repository }))
    .register(new McpPolicySetCommand({ repository }))
    .register(new McpPolicyGetCommand({ repository }))
    .register(new McpPolicyListCommand({ repository }));

const commandInvoker = new PolicyCommandInvoker({ registry, auditLog, getSession, isAdminUser: isLocalAdminUser });

export const policy = {
    repository, auditLog, httpWhitelist, mcpToolPolicy, commandInvoker,
    resolveCaller: (req) => Caller.fromRequest(req),
};
export default policy;
```

- [ ] **Step 2: Sanity** — `node --check cli/server/policy/index.js`.
- [ ] **Step 3: Stage + commit point** — message: `refactor(policy): composition root index.js`.

---

## Task 8: Rewire RoutingServer.js

**Files:** Modify `cli/server/RoutingServer.js`.

- [ ] **Step 1: Replace imports** — remove the `mcpPolicy`/`httpWhitelist`/`whitelistCommand` imports; add `import { policy } from './policy/index.js';`
- [ ] **Step 2: Update call sites:**
  - guest gate: `isPathWhitelistedForGuest(pathname, req.method)` → `policy.httpWhitelist.isReachableByGuest(pathname, req.method)`
  - dispatch: `handleWhitelistCommand(req, res)` → `policy.commandInvoker.handle(req, res)`
  - boot: `bootstrapMcpPolicy(collectMcpToolDefaults(loadApiRoutes()))` → `policy.mcpToolPolicy.bootstrap(loadApiRoutes())`
- [ ] **Step 3: Verify boot/routing** — `node --check cli/server/RoutingServer.js` and `node --test tests/unit/agentApiRouting.test.mjs` → PASS.
- [ ] **Step 4: Stage + commit point** — message: `refactor(policy): RoutingServer uses policy composition root`.

---

## Task 9: Rewire mcp-proxy/index.js + routerHandlers.js

**Files:** Modify `cli/server/mcp-proxy/index.js`, `cli/server/routerHandlers.js`.

- [ ] **Step 1:** In both, replace `import { callerFromRequest, evaluateMcpAccess, filterToolsForCaller } from '../policy/mcpPolicy.js'` (path differs per file) with `import { policy } from '../policy/index.js'` (mcp-proxy) / `'./policy/index.js'` (routerHandlers).
- [ ] **Step 2: Update call sites** — `callerFromRequest(req)` → `policy.resolveCaller(req)`; `evaluateMcpAccess({...})` → `policy.mcpToolPolicy.evaluate({...})`; `filterToolsForCaller(agent, tools, caller)` → `policy.mcpToolPolicy.filterTools(agent, tools, caller)`.
- [ ] **Step 3: Verify** — `node --check` both files; `node --test tests/unit/httpServiceInvocation.test.mjs tests/unit/agentServerSessionLifecycle.test.mjs` → PASS.
- [ ] **Step 4: Stage + commit point** — message: `refactor(policy): mcp-proxy + routerHandlers use McpToolPolicy`.

---

## Task 10: Delete old modules + full verification

**Files:** Delete `cli/server/policy/{policyStore,mcpPolicy,httpWhitelist,whitelistCommand,shareAuthorizer}.js` and `tests/unit/{mcpPolicy,httpWhitelist,whitelistCommand}.test.mjs`.

- [ ] **Step 1: Confirm no remaining references** — `git grep -n "policyStore\|mcpPolicy\|httpWhitelist'\|whitelistCommand\|shareAuthorizer" -- cli Agent ':!*.test.mjs'` → no hits to the old files (only the new class names / dirs). Fix any stragglers.
- [ ] **Step 2: Delete** the five modules and three superseded test files.
- [ ] **Step 3: Full suite** — `cd ploinky && node --test tests/unit/*.test.mjs` → PASS, count ≥ prior 527 (5 old policy tests replaced by 5 new ones).
- [ ] **Step 4: Reference + import check** — `git grep -n "from './policy/" -- cli/server` shows the 3 consumers import only `./policy/index.js`.
- [ ] **Step 5: Stage + commit point** — message: `refactor(policy): remove legacy function modules; full OOP policy layer`.

---

## Task 11: DS014 note + close-out

**Files:** Modify `docs/specs/DS014-router-access-control-http-whitelist-and-mcp-policy.md`.

- [ ] **Step 1:** Add one sentence to DS014 §Single Administrative Endpoint: "The endpoint is implemented as a Command bus — a `PolicyCommandInvoker` dispatches to one `WhitelistCommand` class per command via a `PolicyCommandRegistry`, over a `PolicyStateRepository`, `HttpRouteWhitelist`, `McpToolPolicy`, and `ShareAuthorizer` (DS contract unchanged)." Status stays `implemented`.
- [ ] **Step 2: Optional E2E** — a structural refactor with full unit parity does not require the container E2E; run `npm test` opportunistically if a runtime is available.
- [ ] **Step 3: Stage + commit point** — message: `docs(DS014): note command-bus class implementation`.

---

## Self-Review (completed by plan author)

- **Spec coverage:** every spec component (repository, audit, whitelist+path, caller, mcp policy, share authorizer, command base + 7 commands, registry, invoker, composition root, consumer wiring, DS014 note) maps to Tasks 1–11. ✓
- **Placeholders:** ported-logic steps name the exact source function to relocate; new code shown in full; tests shown or specified assertion-by-assertion. No "TBD/handle edge cases". ✓
- **Type/name consistency:** method names (`isReachableByGuest`, `evaluate`, `filterTools`, `bootstrap`, `collectDefaults`, `mutate`, `getMcpToolEntry`, `listHttpRoutes`, `Caller.fromRequest`, `authorize`/`execute`, `registry.get`) are used consistently across tasks and the composition root. ✓
- **Behavior:** every preserved error code and the DS014 matrix/accept-reject table are carried into the new suites verbatim. ✓
