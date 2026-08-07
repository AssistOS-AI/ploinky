# Ploinky Overview

Ploinky is a workspace-local runtime for repository-backed agents.

## Workspace model

- The workspace root is the nearest directory that contains `.ploinky/`.
- Runtime state lives under `.ploinky/`, including `agents.json`, `routing.json`, `.secrets`, `repos/`, `deps/`, `logs/`, and `keys/`.
- The first core command in a genuinely fresh workspace creates `agents.json`,
  `routing.json`, `data/router-security/policy-state.json`, and
  `data/edge-routing/desired.json` together before any registry mutation.
  A partial set remains fail-closed and requires explicit repair.
- Agent repositories are cloned under `.ploinky/repos/<repo>/`.
- The default `start` flow requires a static agent and router port the first time, then reuses the saved configuration.

## Common CLI commands

- `ploinky install <url> [repoName] [branch]` and `ploinky add <url> [repoName] [branch]`: clone a repository into `.ploinky/repos/`. The optional `repo` token is also accepted, and the repository name is derived from the URL when omitted.
- `ploinky uninstall <repoName|url>` and `ploinky remove <repoName|url>`: remove an installed repository checkout after disabling enabled agents from that repository. Source metadata remains in `.ploinky/repo_sources.json` so the repository can be installed again.
- `ploinky update [folderPath]` and `ploinky update all [folderPath]`: update the Ploinky checkout, refresh `ploinky/node_modules/achillesAgentLib`, update `.ploinky/repos/`, repair non-git installed repo directories by recloning on the recorded branch when a source URL is known, refresh `AchillesCopilotBasicSkills` in eligible installed `.ploinky/repos/` entries, recursively update discovered git repositories, and refresh Achilles default skills in those project repositories. Inside a Ploinky box, `/opt/ploinky` is mounted read-only, so the self-pull is skipped while the writable runtime Achilles dependency, managed repositories, workspace repositories, and skills continue to update. Discovered project repositories with missing or unreachable remotes are logged and skipped for the pull step while still receiving default skills. When no folder path is provided, discovery starts at the current working directory.
- `ploinky update repos`: update installed `.ploinky/repos/` entries, refresh `AchillesCopilotBasicSkills` in eligible managed repositories, and refresh both the Ploinky runtime Achilles checkout and managed-repo Achilles dependencies.
- `ploinky update repo <name>`: update one repository under `.ploinky/repos/` and refresh `AchillesCopilotBasicSkills` in that repo when it is eligible.
- `ploinky enable agent <name|repo/name> [global|devel [repo]] [--auth none|pwd|sso] [as <alias>]`: register an agent in `.ploinky/agents.json`. Isolated agents use `.data/<agent-or-alias>/` as their host-side home and work directory.
- `ploinky start [staticAgent] [hostPort] [--branch <branch>] [--repo-branch <repo=branch>]... [--branch-fallback default|fail] [--reset-repos]`: resolve dependency waves, start automatic enabled agents, retain already running manual agents, write `routing.json`, and launch the fixed inner Router on `8080` under the watchdog. A manifest may declare `startup: "manual"` to stay dormant when it is outside the static dependency graph; absent means automatic, while static/dependency membership always wins. At the public wrapper, the optional positional port selects only the loopback physical-host side of the fixed mapping; direct/core start accepts only `8080`. `--branch` sets a candidate branch for all repos involved in this start; `--repo-branch` reconciles an existing named repo before manifest traversal and overrides it when traversal installs the repo. `--branch-fallback default` (the default) keeps repos on their configured branch when the candidate is missing; `fail` aborts when a targeted branch is missing or cannot be refreshed. `--reset-repos` hard-resets targeted managed repos to the refreshed remote branch.
- `ploinky status`: show SSO state, router listening state, installed and remembered repositories, and backend-aware state for enabled or running agent runtimes. The public host command uses this same read-only renderer for a compatible initialized Box without running core initialization or bootstrap; unavailable Box states use the dependency-free outer summary.
- `ploinky list routes`: inspect the current `.ploinky/routing.json` route table.
- `ploinky restart`: restart enabled agents and the router.
- `ploinky shell <agent>`: open `/bin/sh` inside the running agent backend.
- `ploinky cli <agent> --workdir <path> -- [provider-args...]`: run the manifest CLI through the selected runtime in an existing real non-root workspace directory; there is no cwd inference or cross-runtime fallback.
- `ploinky stop`: stop enabled agents and the router without removing runtime state. Host-sandboxed agents are signaled in a batch before Ploinky waits.
- `ploinky shutdown`: stop the router and remove runtimes recorded for this workspace in `.ploinky/agents.json`.
- `ploinky destroy`: stop the router, remove all Ploinky runtimes for the workspace, and clear the regenerated dependency cache under `.ploinky/deps/` without deleting `.data/<agent-or-alias>/`.
- `ploinky clean`: alias for `destroy`.
- `ploinky logs tail [router]` and `ploinky logs last <N> [router]`: inspect router logs. Router logs are the only logs exposed through the CLI.
- `ploinky webchat [--rotate]`: print the WebChat access URL. WebChat uses the router login flow; `--rotate` is accepted for compatibility but does not mint a WebChat-specific token.
- `ploinky client list tools|resources`, `ploinky client status <agent>`, and `ploinky client tool <name>`: inspect or call MCP surfaces through the router.

## Web surfaces

- `/webchat`: chat surface over a workspace-scoped TTY runtime. Conversation
  sessions are owned by the selected CLI, which can publish `current`, `list`,
  and `selected` snapshots through the generic `__webchatSession` protocol.
  WebChat validates and retains the latest snapshot only in memory, renders
  existing messages through `Click to load session history`, and sends
  `/session`, `/session new`, or `/session resume <id>` for session controls.
  Ploinky does not persist conversation files or hydrate the CLI's agent. When opened as
  `/webchat?agent=<name>&workspace-dir=<path>&...`, the router validates the
  workdir and dispatches `ploinky cli <name> --workdir <path> -- ...`.
  Ordinary parameters become long-form provider flags; agent/workspace selectors
  and router-owned tab, session, and page identifiers are not forwarded.
- `/dashboard`: operational management surface for status, logs, agents, and runtime control.
- `/status`: read-only browser view that shells out to `ploinky status` and adds router-side server and agent summaries.
- `/api/marketplace`: JSON endpoint for the first-party agent marketplace. Authenticated local or SSO users may read repository, agent, enabled-record, recorded backend, and runtime state; Bubblewrap and Seatbelt liveness comes from tracked PIDs, while Docker and Podman use OCI state. Local admins may perform the complete `install_repo`, `uninstall_repo`, `enable_agent`, and `disable_agent` action set. A running agent may use a request-bound Agent Assertion to read state and submit only `enable_agent`, which supports on-demand dependency startup without granting repository or disable operations. Client helpers check status first and forward `mode` only when the caller supplies it; an omitted mode retains Marketplace's isolated default. Repository uninstall disables agents from that repository and removes the checkout while preserving source metadata for reinstall. Marketplace agent disablement removes the enabled-agent registry record before removing the runtime so the watchdog does not restart it during the operation.

`/webchat` uses the normal router login flow. `/dashboard` and `/status` are
local-control surfaces that require a real router-authenticated local-admin
session on an exact control Host. They do not accept a component token,
invitation, agent assertion, media credential, or localhost provenance as admin
identity; mutations additionally require the exact Origin and a session-bound
CSRF proof.

## Auth and agent cards

- Local auth stores hashed credentials in a workspace variable such as `PLOINKY_AUTH_<ROUTE>_USERS`.
- SSO stores a configured provider agent in workspace SSO config; provider manifests use `"ssoProvider": true`.
- The installed-agent index tracks route names, principals, runtime resources, and SSO-provider markers.
- `GET /agent-card` on the router lists successful capability responses from active agents without enforcing a fixed payload shape; `GET /<agent>/agent-card` proxies one agent's metadata.
- `POST /<agent>/v1/chat/completions` routes OpenAI-compatible requests to one agent, with `stream: true` selecting SSE streaming and normal JSON returned otherwise.
- `/<agent>/...` routes are transparent per-agent proxy routes after router-owned paths are handled. The router strips the `/<agent>` prefix; the target agent owns paths such as `/index.html`, `/agent-card`, `/v1/chat/completions`, and custom HTTP endpoints. `/<agent>/mcp` remains special so the router can preserve MCP session mediation and secure-wire token minting.
- `http://<service-slug>.localhost:<routerPort>/` selects a uniquely slugged `httpServices` entry. Its optional `port` resolves to an engine-assigned private target; omitted port preserves the owning agent's primary target. All HTTP, SSE, and WebSocket traffic uses the same immutable route-and-policy authorization generation.
- Delegated MCP calls use router-minted invocation JWTs. The router verifies the caller's session and forwards a fresh target invocation token.

## Dependency and profile commands

- `ploinky deps prepare [<repo>/<agent>]`: prepare runtime-keyed dependency caches.
- `ploinky deps status`: show cache validity.
- `ploinky deps clean <repo>/<agent>|--global|--all`: remove caches.
- `ploinky profile <dev|qa|prod>`: switch the active profile.
- `ploinky profile show|list|validate`: inspect profile state.

## Secrets and skills

- `ploinky vars`, `ploinky var <NAME> <value>`, and `ploinky echo <NAME>` manage `.ploinky/.secrets`.
- `ploinky expose <ENV_NAME> [<$VAR|value>] [agent]` maps values into agent environments.
- `ploinky default-skills <repoName>` refreshes the repo's skill directories under `.agents/skills/`. Skill directories with matching names are replaced from the repo, unrelated existing skills are preserved, and legacy `.claude/skills/` skills are migrated into `.agents/skills/` before compatibility symlinks are created. The managed `.gitignore` block lists `.claude` and only the refreshed repo skill directories; `.agents/` itself stays tracked.

## LLM helper behavior

- `ploinky-shell` is a shell-oriented entry point that asks the configured LLM for command suggestions.
- Invalid CLI input can also trigger LLM suggestions.
- The LLM helper uses this file as context, so this overview must stay in sync with the current CLI behavior.
