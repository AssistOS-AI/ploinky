---
id: DS011
title: Security Model
status: implemented
owner: ploinky-team
supersedes: DS006 (partial - auth wire protocol)
summary: Defines Ploinky's trust boundaries, master-keyed storage, authentication modes, secure-wire invocation flow, runtime isolation, file controls, and residual security limits.
---

# DS011 Security Model

## Introduction

Ploinky is a workspace-local runtime. Its security model is designed for a single operator or a trusted team running agents on a controlled host, not for hostile multi-tenant execution or arbitrary third-party agent hosting. The router, workspace state, runtime backends, and enabled agents form one local trust domain.

This document is the system-level security contract. DS006 defines the older authentication and provider-selection framing, including the secure-wire design that this specification supersedes where current behavior differs. This document combines the current branch behavior across storage, authentication, routing, agent invocation, sandboxing, static file serving, uploads, transcripts, and operational gaps. This document is the current authority: `PLOINKY_MASTER_KEY` is the workspace root key, `PLOINKY_DERIVED_MASTER_KEY` is the agent runtime root derived from it, and every Ploinky-owned or agent-owned generated secret is derived through HKDF-SHA256 with a domain-separated `info` label rather than being a copy of the master or a random persistent value.

## Core Content

### Security Scope and Trust Assumptions

Ploinky must treat the operator account, the local host, `PLOINKY_MASTER_KEY`, and the `.ploinky/` workspace directory as high-trust assets. Anyone who can read `PLOINKY_MASTER_KEY` can derive every per-purpose subkey and therefore can decrypt encrypted workspace stores, mint local session JWTs, and mint agent invocation JWTs. The derivation hierarchy means an attacker who only obtains a single subkey (for example `PLOINKY_DERIVED_MASTER_KEY` from inside an agent process) can forge tokens for that purpose but cannot reverse the HKDF to recover the master or compromise the other purposes. Anyone who can write critical `.ploinky/` files can alter enabled agents, routing, profiles, stored secrets, or user records.

The router is the trust broker for browser users and agent-to-agent calls. Browser surfaces and MCP calls should pass through the router so that route auth, session handling, delegated invocation minting, and audit hooks apply. Agent ports must be considered implementation details even when they listen on localhost. Direct access to an agent port may expose tool and resource metadata, because MCP initialization and listing do not require an invocation token, while executable tool calls, resource reads, and task-status reads do require a valid router-minted invocation JWT.

Agents are isolated from the host by containers, bubblewrap, or macOS Seatbelt, but enabled agent code is not mutually distrusted once the derived master key is injected into its runtime. The runtime managers inject the HKDF-derived `derived-master` subkey under `PLOINKY_DERIVED_MASTER_KEY`; agents never receive the master key. Any code running inside an agent process that can read its environment can therefore forge invocation JWTs (the verification key is symmetric and shared across enabled agents) and derive that agent's generated secrets, but cannot decrypt the workspace stores or mint session JWTs, because those purposes use distinct derived subkeys that the agent never sees. This narrowed blast radius is acceptable only under the current single-workspace, operator-controlled trust model. Ploinky must not claim tenant isolation or non-repudiation between agents without replacing the shared-HMAC invocation model with per-agent or asymmetric credentials.

The router port is sensitive. The current server starts with `server.listen(port)` and logs a `127.0.0.1` URL, but the implementation does not explicitly pass a bind host. Operators who expose the port outside the local machine must provide network controls, TLS termination, and proxy policy appropriate for the deployment. Public-internet exposure is outside the implemented security assumptions unless additional controls are added.

### Workspace Key and Encrypted Storage

`PLOINKY_MASTER_KEY` is the root cryptographic secret. It is consumed as 256 bits of key material. `cli/services/masterKey.js` treats any non-empty trimmed value as an operator-supplied seed and hashes it to 32 bytes with SHA-256; the resulting digest is the master key bytes. The seed's effective entropy is therefore bounded by the entropy of the chosen string — operators wanting full 256-bit strength should use a 64-hex-character (or otherwise high-entropy) random string. Resolution checks `process.env.PLOINKY_MASTER_KEY` first and then falls back to the nearest `.env` walked upward from the current working directory, so operators can keep one `.env` in a parent directory that shadows multiple workspaces. Trust implication: anyone who can read the resolved `.env` file can decrypt every encrypted store under any descendant workspace; the file's filesystem permissions therefore inherit the same trust level as `PLOINKY_MASTER_KEY` itself.

The master key bytes must never be used as a cryptographic key directly. Every per-purpose secret in Ploinky is derived from the master through `deriveSubkey(purpose)` in `cli/services/masterKey.js`, which applies HKDF-SHA256 with an empty salt and a domain-separated `info` of `ploinky/<purpose>/v1`. The current purposes are:

- `derived-master` — agent runtime root key. The router uses this subkey for invocation JWT signing/verification, runtime managers inject it into agents as `PLOINKY_DERIVED_MASTER_KEY`, and `deriveAgentSecret()` derives Ploinky-owned and agent-owned generated secrets from it with labels for repo, agent, and secret name.
- `session` — HS256 signing/verification key for local session JWTs (`ploinky_jwt` cookie). Router-only; never injected anywhere.
- `storage/secrets` — AES-256-GCM key for `.ploinky/.secrets`.
- `storage/passwords` — AES-256-GCM key for `.ploinky/passwords.enc`.

Adding a new persistent secret requires picking a fresh purpose label rather than reusing an existing subkey or the master directly. Domain separation through `info` ensures that bumping one purpose's version segment cannot collide with another.

Agent-owned generated secrets must derive from `PLOINKY_DERIVED_MASTER_KEY`, not from `PLOINKY_MASTER_KEY` and not from random persistent storage. Manifests declare ordinary per-agent generated secrets with `generatedSecret: true`; this derives from a domain-separated label containing the current repo name, current agent name, and env name. Runtime resources use `{{generatedSecret:NAME}}` for the same per-agent behavior. Cross-agent service credentials that must be identical, such as a shared media-service API key, must use `sharedGeneratedSecret: true` so the value derives from the source env name rather than a custom logical repo/agent/name tuple. Shared generated credentials are still explicit manifest choices and should be reserved for credentials that truly must be shared. A generated env entry may set `explicitOverride: true` when an operator-provided external credential is allowed to replace the generated value, or `explicitOverrideRequires` when that external credential must travel together with companion topology. Runtime managers expose only the source class, `PLOINKY_ENV_SOURCE_<ENV_NAME>=generated|explicit`, not the secret material itself. External provider credentials and operator-supplied API keys remain explicitly configured because their values originate outside the workspace.

`.ploinky/.secrets` must be stored as an AES-256-GCM JSON envelope through `cli/services/encryptedSecretsFile.js`, encrypted with the `storage/secrets` subkey. Legacy plaintext key-value files are migrated into the encrypted envelope on first read. The envelope encrypts both variable names and values inside the ciphertext payload. Writes use a temporary file and rename, and the implementation attempts to set mode `0600`.

Local authentication users must be stored in `.ploinky/passwords.enc` through `cli/services/encryptedPasswordStore.js`, not in `.ploinky/.secrets`. The password store is an AES-256-GCM envelope encrypted with the `storage/passwords` subkey; it groups user payloads by the route-specific users variable name, such as `PLOINKY_AUTH_EXPLORER_USERS`. User password material inside that store must be password hashes, not plaintext.

Encrypted stores fail closed when the key is missing or unable to decrypt the existing file. Both the `.secrets` and `passwords.enc` decryption paths first try the per-purpose derived subkey and fall back once to the raw master on AES-GCM authentication-tag failure. This fallback exists solely to migrate workspaces written by pre-derivation versions; the next write re-encrypts the envelope with the derived subkey, completing the migration in place. The fallback path will be removed in a future version.

The implementation uses more than one secret resolution path, and future changes must preserve the purpose-specific precedence deliberately. The workspace root key is resolved only from process environment and `.env`, because `.secrets` cannot be decrypted before the key exists. `secretInjector.getSecret()` prefers process environment, then encrypted `.secrets`, then `.env`. Manifest environment resolution in `cli/services/secretVars.js` currently resolves encrypted `.secrets` before process environment and then `.env`. Security-sensitive code must not assume a universal precedence order without checking the call site.

`ensurePersistentSecret()` remains available for legacy generated workspace values that are not agent-owned secrets. Agent-owned generated secrets must use `generatedSecret: true` or `{{generatedSecret:...}}` instead of generating random persistent values.

### Passwords, Local Sessions, and User Administration

Local authentication is enabled per route when the enabled-agent record has `auth.mode: "local"`, which may come from the manifest directive `pwd enable` or from explicit enable-time auth selection. Local auth user records must contain a stable local id, username, display name, optional email, roles, password hash, and revision counter.

Password hashing must use the supported hash verifier in `cli/services/localAuthPasswords.js`. New hashes use scrypt with a random 16-byte salt and a 64-byte derived key. Legacy `sha256:` hashes can still be verified but must not be treated as the preferred storage format.

Successful local login mints a compact HS256 session JWT in the `ploinky_jwt` cookie. The cookie must be `HttpOnly`, `SameSite=Lax`, path `/`, and `Secure` when the request is HTTPS or forwarded as HTTPS. The session JWT has `typ: "session"`, issuer `ploinky-router`, user claims in `usr`, a route users-variable binding in `uvar`, a revision number in `rev`, a random `jti`, and a four-hour expiry. Authenticated local requests refresh the cookie as a sliding window.

Local session revocation is revision-based rather than session-store-based. When a password or admin-managed user record changes, the target user's `rev` increases. On the next request, `getSession()` and `ensureAuthenticated()` compare the JWT `rev` and `uvar` against the current encrypted user store. A mismatch rejects the session. This route binding is required so a JWT issued for one local-auth route cannot administer or authenticate another route that has a different users variable.

The local account page permits a user to change their own username and password only after presenting the current password. The web handler enforces new-password confirmation and a minimum length for self-service password changes. Admin user-management APIs are exposed under `/api/agents/<agent>/users` and must require a valid local session for the target agent plus a local admin role or the built-in local admin identity. Admin mutations must preserve at least one admin user.

### SSO and Guest Sessions

SSO is workspace-bound through direct SSO config. The configured `providerAgent` must point to an installed provider whose manifest sets `ssoProvider: true`. Core auth code delegates provider-specific login URL creation, callback handling, refresh, logout, and user normalization to that provider. Core owns the random pending browser state, expiry, session cookie, and in-memory session store.

SSO pending state must be short lived. The generic bridge currently keeps pending entries for five minutes and deletes them after callback consumption. SSO sessions are server-side records containing normalized user information and opaque provider session or token material. Refresh remains provider-driven.

Guest auth is enabled by `guest: true` in an agent manifest or by an `httpServices` entry with `auth: "guest"`. Normal guest agent routes first honor an existing authenticated local session when one is present. Guest HTTP service declarations may set `forceGuest: true`, in which case the router ignores any workspace login cookie and mints a service-scoped guest session instead. Guest session JWTs live in `ploinky_guest`, expire after one hour, carry a `guest` role and random guest id, and may carry a `gscope` value that prevents reuse outside the declaring service. Guest identity is therefore pseudonymous and short lived, and agents must enforce guest limitations from the `usr.roles` claim in invocation JWTs.

### Router Route Protection

The router must attach authenticated identity to `req.user`, `req.session`, `req.sessionId`, and `req.authMode` before protected browser surfaces and first-party MCP requests execute. The route auth context is resolved from the request path, explicit `agent` query parameter, route table, and static-agent configuration. For `/webchat?agent=<target>`, the target agent manifest may declare `"webchat": { "auth": "static" }` to authenticate the webchat surface with the static agent's route policy while still running the target chat agent.

`/health` and `/MCPBrowserClient.js` are intentionally reachable before route authentication. `/health` exposes operational metadata needed by the watchdog. `/MCPBrowserClient.js` serves first-party client code and must not contain secrets.

`/auth/*` handles login, logout, account, token, and callback flows. `/api/agents/<agent>/users` performs its own local-admin authorization because it must authenticate against the target agent's local-auth policy. `/mcp` is protected by normal route authentication before router-level MCP aggregation. `/mcps/<agent>/mcp` and `/mcp/<agent>/mcp` defer browser authentication or delegated-caller verification until the JSON-RPC body is available, because secure-wire tokens are body-bound.

Dashboard access has two modes. If router auth has established `req.user`, the Dashboard creates its own surface session and treats the router-authenticated user as authorized. If no router user exists, the Dashboard can still use the legacy `WEBDASHBOARD_TOKEN` flow. The Dashboard `/run` endpoint can execute `ploinky` commands with user-supplied arguments and must remain behind Dashboard authorization. Production-oriented deployments should remove or tightly constrain that endpoint before exposing Dashboard beyond a trusted operator network.

The Status surface is protected by the router auth context when a route policy requires auth. Its handler does not implement an additional token challenge. If the active route context resolves to auth mode `none`, Status data is effectively public on the router port.

HTTP service routes are declared by agent manifests through `httpServices`; the router must not encode product-specific service paths in core handlers. A declaration with `auth: "none"` under `/public-services/...` intentionally bypasses router identity. A declaration with `auth: "guest"` follows the same default policy as a manifest-level guest agent: it honors an existing local login, otherwise mints a scoped guest identity, and forwards a router-issued `__http_service__` invocation token. Guest services that must behave like invite links can set `forceGuest: true` to ignore existing workspace login cookies. Protected service routes under `/services/...` must not become anonymous just because the service-owning agent route is configured with `auth.mode: "none"`; the router must prefer the owning route's auth policy, fall back to the static route's authenticated policy, and reject the request if no authenticated policy is available. Protected and guest service routes may pass a compact `x-ploinky-auth-info` header derived from `req.user`. When the downstream service may need to trust that identity or make delegated agent calls, the router includes both a router-issued invocation token and the signed invocation body in that auth-info payload. The invocation body is the canonical `__http_service__` call payload containing method, external path, and search string; downstream services that use router SSO must verify the invocation JWT audience, tool, body hash, and replay id before trusting the header. Services can also re-enter `/mcps/<agent>/mcp` with `X-Ploinky-Caller-JWT` when making delegated calls. The identity fields in `x-ploinky-auth-info` are not a signed secure-wire grant by themselves; downstream services must trust them only after the invocation token verifies for the forwarded service request. The router strips caller-supplied Ploinky identity headers before proxying and regenerates authoritative identity headers from the authenticated request context.

### Secure-Wire Invocation Model

Executable agent calls must use router-minted HS256 invocation JWTs. The router is the issuer. Agents verify only. The signing key is `PLOINKY_DERIVED_MASTER_KEY`, the `derived-master` subkey derived from the workspace master via HKDF-SHA256, not the master bytes themselves. The runtime managers (`bwrap` and `docker`) inject those derived bytes into agents as `PLOINKY_DERIVED_MASTER_KEY`; agents must never receive `PLOINKY_MASTER_KEY` and the agent verifier must not fall back to it.

An invocation JWT must have `typ: "invocation"`, issuer `ploinky-router`, target audience `aud`, caller principal, tool name, normalized scope list, body hash `bh`, delegated user claims `usr`, issued and expiry timestamps, and a random `jti`. Before minting and forwarding `tools/call`, the router canonicalizes arguments with the target tool's advertised input schema so keys that AgentServer will reject or strip are not included in the signed body. The router then computes `bh` from canonical JSON over the exact `{ tool, arguments }` body forwarded to the agent. Default invocation TTL is 60 seconds and the verifier rejects tokens with an excessive TTL.

The agent verifier in `Agent/lib/invocationAuth.mjs` must reject missing bearer tokens, missing derived master key, missing expected audience, audience mismatch, tool mismatch, body hash mismatch, expiry failure, and replayed `jti` values. `Agent/server/AgentServer.mjs` uses an in-memory replay cache with a bounded size and requires verified invocation for tool calls, resource reads, and task-status reads.

Delegated agent calls must go back through the router. The router mints a fresh invocation JWT for the target agent when an orchestrator calls a remote agent through the `/v1/chat/completions/<agent>` endpoint. The `/agent-card` and `/v1/chat/completions/<agent>` routes now require standard router authentication (session cookie or API key) rather than delegated caller JWT verification. The router strips caller-supplied Ploinky identity headers before proxying and regenerates authoritative identity headers from the authenticated request context.

The shared-HMAC model does not provide non-repudiation between agents. The security invariant is that the router is the intended issuer and that normal agents receive invocation tokens only through router-mediated calls. It is not safe to use this model for mutually hostile agents that can read their own environment.

### Agent Index and Domain Authorization

The installed-agent index is not an authorization system. It resolves installed agent references, deterministic agent principals, runtime resources, and SSO-provider markers. It does not grant domain permissions and does not negotiate provider scopes.

Invocation scopes are broad by default for first-party and delegated calls when no explicit scopes are supplied. Domain agents that protect sensitive resources must enforce their own authorization using `authInfo` or the derived actor. For example, a secrets provider must check operation-specific scopes, user or agent identity, per-resource ACLs, and provider-specific policy files before granting access. Ploinky core must not claim that a router session alone authorizes every provider operation.

Legacy agent client-credential auth is removed. `/auth/agent-token` returns gone, and `ensureAgentAuthenticated()` rejects legacy bearer-style agent auth. Agent-to-agent authorization must use delegated invocation JWTs through the router.

### Runtime Isolation and Mount Policy

The default runtime backend is a container runtime, preferring Podman when available and falling back to Docker. Host sandboxes are disabled by default and are selected only when the operator opts in via `ploinky sandbox enable` *and* the manifest requests `lite-sandbox: true`: Linux uses bubblewrap, macOS uses Seatbelt, and unsupported or unavailable host sandboxes fail with operator guidance rather than silently falling back. The environment variable `PLOINKY_DISABLE_HOST_SANDBOX=1` overrides any workspace opt-in and forces the container path.

Container agents must mount `/Agent` read-only, prepared dependency caches read-only, code and skills according to the active profile, and workspace or shared paths as required by the run mode. The `dev` profile defaults code and skills to read-write. `qa` and `prod` default them to read-only unless a profile explicitly relaxes them. Prepared `node_modules` caches must remain read-only in runtime containers. Podman-staged symlink trees must mount each symlink target at its real path with the same read/write policy instead of relying on a broad writable workspace mount. Manifest volumes and runtime resources are explicit operator-granted write surfaces and must be treated as trusted manifest power. Manifest volume host paths must resolve under `.ploinky/`; durable service data belongs under `.ploinky/data/`, generated runtime inputs belong under `.ploinky/agents/`, and arbitrary workspace-root sibling folders are not valid runtime state.

Container-published ports default to localhost when no explicit profile port mapping is declared. Profile port mappings may include an explicit host IP; if a manifest or profile binds to a non-local address, that exposure is intentional operator configuration and must be reviewed as a network security decision.

Bubblewrap agents clear the environment and then set only the constructed environment map. They bind system paths needed for execution as read-only, bind `/Agent` read-only, bind dependency caches read-only, bind code and skills according to profile policy, bind shared and workspace paths as writable where required, and apply read-only overlays to protected Ploinky state such as dependency caches, `.secrets`, profile, routing, server configuration, and staged runtime paths. Bubblewrap currently unshares PID but does not unshare network, because agents need network access and router reachability.

Seatbelt agents run with a generated deny-default SBPL profile. The profile allows system reads, network access, process execution, temporary writes, shared/workspace writes, profile-controlled code and skills writes, declared volumes, and logs. It denies writes to protected runtime paths, dependency caches, staged Agent libraries, `.secrets`, profile, routing, and server configuration. Because Seatbelt exposes real host paths rather than a mount namespace, its generated profile is the authoritative access-control layer.

When multiple host-sandboxed agents are stopped or destroyed, Ploinky sends the graceful signal to every selected sandbox process group before waiting on the shared timeout. Any sandbox still alive after that deadline is force-killed and its PID record is cleared. This is a lifecycle bound, not an additional security boundary.

Lifecycle hooks are trusted host or runtime code. `preinstall` runs on the host before container or sandbox creation and can seed workspace variables or files. Host lifecycle hooks are outside runtime sandbox protection. A manifest that defines hooks must therefore be trusted at the same level as a local script run by the operator.

### Files, Static Content, Uploads, and Blobs

Workspace file reads and uploads must remain confined to the workspace root. `cli/server/utils/workspacePaths.js` rejects null bytes, resolves leading slashes as workspace-relative when requested, canonicalizes paths through realpath-aware logic, and denies symlink escapes outside the workspace.

The WebChat composer autocomplete file-suggestion endpoint (`/webchat/suggestions/files`) must apply the same workspace-confinement rules as Explorer's filesystem reads. The endpoint additionally narrows its search root to the current WebChat session upload directory `<cwd>/uploads/<sessionId>`, where `sessionId` is the `webchat_sid` cookie value, and rejects absolute caller paths, traversal (`..`), NUL bytes, symlink escapes outside both the workspace root and the session upload root, and the reserved secret files `.secrets` and `*.secrets`. Sibling session upload directories must never appear in suggestion results. The endpoint must not return host absolute paths to the browser. The endpoint provides suggestions only; downstream chat agents must still validate any structured `workspace-path` references they receive before reading file content. WebChat must sanitize references on the way out by dropping absolute paths, traversal, NUL bytes, reserved secret-file names, and any non-string path values.

WebChat session-scoped uploads must follow the same containment rules. `POST /webchat/uploads` accepts file bytes and an optional `X-Relative-Path` header (for browser folder selection via `webkitdirectory`) and writes the result to `<cwd>/uploads/<sessionId>/<sanitized-relative-path>`. The server must reject absolute caller paths, traversal segments, NUL bytes, reserved secret-file names, and any path whose canonical resolution leaves the session upload root via a symlink. Existing target files are not overwritten; a deterministic ` (n)` suffix is appended to the leaf name. Responses report only relative paths scoped to the WebChat working directory or workspace root (e.g. `uploads/<sessionId>/notes.md`) and never expose host absolute paths. Stored MIME metadata for download responses lives in `uploads/.webchat-upload-metadata/<sessionId>/`, outside the user-visible session upload tree. `GET /webchat/uploads?path=...` and `HEAD /webchat/uploads?path=...` stream previously stored content with stored `Content-Type`, `X-Content-Type-Options: nosniff`, and the same unsafe path rejection. The session upload directory is a UX convenience scope, not a security boundary between hostile sessions; the workspace operator trust model still applies.

Browser autocomplete must not treat URL query parameters as authority to call arbitrary MCP tools. Ploinky WebChat must not expose provider tag catalogs from URL parameters; dynamic backend discovery belongs to the selected chat agent or relay during a real delegated request that carries a router-minted invocation token.

Static file serving sanitizes relative paths and denies `..` traversal. Static and agent-specific serving may allow symlink targets under the static or agent root's parent directory, because the allowed-root checks include both the root and its parent. Operators must not place secrets in directories reachable by static roots or symlinks from static roots.

Blob upload and download paths use random hexadecimal ids and reject ids containing characters outside the allowed id set. Original filenames and MIME types are stored as metadata and must not control filesystem paths. Blob and upload handlers currently do not enforce a repository-wide content-size limit or quota. Any deployment that exposes uploads beyond a trusted local user must add request-size limits and storage quotas at the router or proxy layer.

`/upload` writes to an operator-specified workspace path after canonical path validation. `/blobs` stores shared blobs under `.ploinky/shared` or agent blobs under the enabled agent project path. Responses use `X-Content-Type-Options: nosniff` for blob data.

### Transcripts, Logs, and Audit Data

WebChat transcripts must be encrypted at rest independently from the main workspace secret envelope. `PLOINKY_TRANSCRIPTS_MASTER_KEY` is resolved from encrypted workspace secrets or environment and may be generated on first use. Each conversation receives a random data-encryption key, and that key is wrapped with the transcript master key. Message text, attachments, and metadata are encrypted with AES-256-GCM.

Transcript records must store hashed session, user, and tab identifiers rather than raw identity values. Dashboard transcript and feedback APIs require transcript viewer access. SSO users must hold an allowed role from `PLOINKY_TRANSCRIPT_VIEWER_ROLES` unless the role list is `*`. Local or legacy Dashboard sessions may read transcripts only when `PLOINKY_TRANSCRIPT_VIEWER_ALLOW_LOCAL` explicitly allows it.

Router logs and agent logs are diagnostic surfaces and must not intentionally record secrets, passwords, cookies, bearer tokens, JWTs, API keys, raw prompts, materialized resource content, base64 resource bodies, command stdin payloads, or internal tool payloads. `AgentServer` tool-argument and payload logging must redact prompt, message, content, base64, resource, stdin, task, and payload-shaped fields before writing to stdout/stderr. Some agent execution paths sanitize known sensitive fields before logging payloads, but `appendLog()` itself trusts the caller. New logging code must redact sensitive fields before writing to `.ploinky/logs/`.

### Browser Media and Third-Party API Keys

WebChat server-side speech-to-text uses `OPENAI_API_KEY` from the router process environment when the OpenAI STT provider is selected. The Realtime token endpoint currently returns that API key to an authenticated browser as `client_secret.value` for direct browser use. This is acceptable only for trusted local users and must not be documented as a production-safe ephemeral-token implementation. A production deployment must replace this behavior with short-lived provider-issued client credentials or disable the endpoint.

The SSO `/auth/token` endpoint can return provider access-token information for an authenticated SSO session. That endpoint is a browser-facing token surface and must remain protected by the active session cookie and route auth context.

### Residual Security Requirements

Ploinky's implemented controls are sufficient for local, operator-controlled workspaces when the router port is not exposed to untrusted networks. Before treating Ploinky as an internet-facing or multi-tenant service, the implementation must add explicit bind-host configuration, TLS guidance or enforcement behind a proxy, CSRF or origin checks for cookie-authenticated state-changing routes, login rate limiting, upload quotas, hardened Dashboard command policy, and a replacement for shared-HMAC agent credentials.

## Decisions & Questions

### Question #1: Why is `PLOINKY_MASTER_KEY` the root security secret?

Response:
The current branch uses `PLOINKY_MASTER_KEY` as the single configured workspace secret from which every per-purpose key is derived via HKDF-SHA256. The router decrypts `.ploinky/.secrets` with the `storage/secrets` subkey, decrypts `.ploinky/passwords.enc` with `storage/passwords`, mints local session JWTs with `session`, and mints invocation JWTs with `PLOINKY_DERIVED_MASTER_KEY`, the same `derived-master` subkey that runtime managers inject into agents and use as the root for agent-owned generated secrets. Keeping a single configured root key keeps operations simple while domain-separated derivation contains the blast radius: a compromise of one subkey does not yield the others or the master. The whole-workspace exposure risk now collapses to "anyone who can read `PLOINKY_MASTER_KEY`", and that variable must continue to be treated as a high-trust asset.

### Question #2: Why is the shared-HMAC invocation model acceptable only for the current local workspace model?

Response:
The shared-HMAC model assumes that enabled agents are operator-controlled participants inside one workspace. It reduces key lifecycle complexity and keeps agent verification simple. It does not prevent an agent that reads the shared secret from minting tokens for another principal. Multi-tenant or hostile-agent deployments require per-agent derived secrets, asymmetric signatures, or another issuer model that restores non-repudiation and limits blast radius.

### Question #3: Why are runtime sandboxes not described as complete containment?

Response:
Containers, bubblewrap, and Seatbelt reduce host filesystem and process exposure, but Ploinky still grants agents network access, selected writable mounts, manifest-declared volumes, runtime-resource storage, and sensitive environment variables. Host lifecycle hooks run outside the sandbox. The correct contract is therefore defense in depth for operator-enabled code, not a guarantee that arbitrary hostile code can be run safely without further controls.

### Question #4: Why does the security model call out router network exposure as a deployment risk?

Response:
The router prints a localhost URL, but the current `RoutingServer.js` call does not pass an explicit hostname to `server.listen()`. The security posture therefore depends on host networking, firewall rules, container or process placement, and any reverse proxy. Documentation must be explicit that exposing the router port changes the threat model.

### Question #5: What unresolved hardening work is required before internet-facing production use?

Response:
The current branch lacks explicit CSRF or origin checks, login rate limiting, upload quotas, a hardened replacement for Dashboard command execution, an ephemeral-token implementation for WebChat Realtime browser credentials, and per-agent credential isolation. These are not defects for the documented local workspace model, but they are blockers for a broader hosted security claim.

## Conclusion

Ploinky's security model is a local workspace model built around a trusted operator, a router trust broker, encrypted workspace stores, JWT-HMAC invocation tokens, and runtime isolation backends. The implementation must continue to document its real boundaries clearly: strong local controls where they exist, explicit trust in the workspace master key and enabled agents, and no claim of multi-tenant or public-internet safety without additional hardening.
