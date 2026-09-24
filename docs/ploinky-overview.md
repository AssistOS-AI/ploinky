# Ploinky Overview

Ploinky is a workspace-local runtime for repository-backed agents.

## Workspace model

- The workspace root is the nearest directory that contains `.ploinky/`.
- Runtime state lives under `.ploinky/`, including `agents.json`, `routing.json`, `.secrets`, `repos/`, `deps/`, and `logs/`.
- The first core command in a genuinely fresh workspace creates `agents.json`, `routing.json`, `data/router-security/policy-state.json`, and `data/edge-routing/desired.json` together before any registry mutation. A partial set remains fail-closed and requires explicit repair.
- Agent repositories are cloned under `.ploinky/repos/<repo>/`.
- The default `start` flow requires a static agent and router port the first time, then reuses the saved configuration.

## Common CLI commands

- `ploinky install <url> [repoName] [branch]` and `ploinky add <url> [repoName] [branch]`: clone a repository into `.ploinky/repos/`. The optional `repo` token is also accepted, and the repository name is derived from the URL when omitted.
- `ploinky uninstall <repoName|url>` and `ploinky remove <repoName|url>`: remove an installed repository checkout after disabling enabled agents from that repository. Source metadata remains in `.ploinky/repo_sources.json` so the repository can be installed again.
- `ploinky update [folderPath]` and `ploinky update all [folderPath]`: select the current directory, or `folderPath` (inside the workspace) when supplied, as the update folder. Ploinky itself is updated only when its canonical checkout is inside that folder or the command is launched from inside the checkout. Every checkout (registered repositories, discovered project repositories and declared skills sources, deduplicated by physical identity) is fetched once and fast-forwarded only when it is clean, on its configured upstream and not diverged; otherwise it is preserved untouched and reported with a named reason. Non-git installed repo directories are cloned only when absent or empty. Default skills and skills manifests are then refreshed from the verified sources without pulling again. Inside a Ploinky box, `/opt/ploinky` is mounted read-only, so the self-update is skipped. The command exits nonzero when any phase failed or a required input of the configured graph was not verified, and the workspace is restarted only when every required input verified. Update never prepares dependency caches.
- `ploinky update repos`: fast-forward installed `.ploinky/repos/` entries and refresh default skills in eligible managed repositories; activation is recorded as pending (run `ploinky restart`).
- `ploinky update repo <name>`: fast-forward one repository under `.ploinky/repos/`, refresh its default skills when eligible and refresh the manifest consumers of that source; activation is recorded as pending.
- `ploinky enable agent <name|repo/name> [global|devel [repo]] [--auth none|pwd|sso] [as <alias>]`: register an agent in `.ploinky/agents.json`. Isolated agents use `.data/<agent-or-alias>/` as their host-side home and work directory.
- `ploinky start [staticAgent] [hostPort] [--branch <branch>] [--repo-branch <repo=branch>]... [--branch-fallback default|fail] [--reset-repos]`: resolve dependency waves, start automatic enabled agents, retain already running manual agents, write `routing.json`, and launch the fixed inner Router on `8080` under the watchdog. A manifest may declare `startup: "manual"` to stay dormant when it is outside the static dependency graph; absent means automatic, while static/dependency membership always wins. At the public wrapper, the optional positional port selects only the loopback physical-host side of the fixed mapping; direct/core start accepts only `8080`. `--branch` sets a candidate branch for all repos involved in this start; `--repo-branch` reconciles an existing named repo before manifest traversal and overrides it when traversal installs the repo. `--branch-fallback default` (the default) keeps repos on their configured branch when the candidate is missing; `fail` aborts when a targeted branch is missing or cannot be refreshed. `--reset-repos` hard-resets targeted managed repos to the refreshed remote branch.
- `ploinky status`: show SSO state, router listening state, installed and remembered repositories, and backend-aware state for enabled or running agent runtimes. The public host command uses this same read-only renderer for a compatible initialized Box without running core initialization or bootstrap; unavailable Box states use the dependency-free outer summary.
- `ploinky list routes`: inspect the current `.ploinky/routing.json` route table.
- `ploinky restart`: reconcile sources, then restart enabled agents and the router.
- `ploinky restart AGENT`: restart only that agent in the already-running Box and preserve the existing Box image and AgentLib generation.
- `ploinky shell <agent>`: open `/bin/sh` inside the running agent backend.
- `ploinky cli <agent> [args...]`: run the manifest CLI command interactively.
- `ploinky stop`: stop enabled agents and the router without removing runtime state. Host-sandboxed agents are signaled in a batch before Ploinky waits.
- `ploinky shutdown`: stop the router and remove runtimes recorded for this workspace in `.ploinky/agents.json`.
- `ploinky destroy`: stop the router, remove all Ploinky runtimes for the workspace, and clear the regenerated dependency cache under `.ploinky/deps/` without deleting `.data/<agent-or-alias>/`.
- `ploinky clean`: alias for `destroy`.
- `ploinky logs tail [router|agent] [--startup]` and `ploinky logs last [<N>] [router|agent] [--startup]`: inspect the Ploinky-owned Router file by default or one exact enabled agent. `--startup` applies only to agents. Agent runtime ownership and cancellation checks remain unchanged.
- WebChat is served by the running Router at `/webchat/`; the retired `ploinky webchat [--rotate]` access command is no longer registered.
- `ploinky client list tools|resources`, `ploinky client status <agent>`, and `ploinky client tool <name>`: inspect or call MCP surfaces through the router.

## Web surfaces

- `/webchat`: chat surface over a workspace-scoped TTY runtime. Conversation sessions are owned by the selected CLI, which can publish `current`, `list`, and `selected` snapshots through the generic `__webchatSession` protocol. WebChat validates and retains the latest snapshot only in memory, automatically renders the latest 100 messages and prepends 50 earlier messages when the reader scrolls to the top. A loading indicator temporarily blocks scrolling and the reader’s position is preserved. Paging bounds DOM rendering; the CLI still supplies the session snapshot. WebChat sends `/session`, `/session new`, or `/session resume <id>` for session controls. Ploinky does not persist conversation files or hydrate the CLI's agent. When opened as `/webchat?agent=<name>&...`, the router forwards additional query parameters except router-owned `tabId` to `ploinky cli <name>` as long-form CLI flags encoded as `--key=value`.
- `/status/data`: current workspace resource snapshot; `follow=1` streams live NDJSON samples from the Router-owned collector.
- `/api/marketplace`: JSON endpoint for the first-party agent marketplace. Authenticated local or SSO users may read repository, agent, enabled-record, recorded backend, and runtime state; Bubblewrap and Seatbelt liveness comes from tracked PIDs, while Docker and Podman use OCI state. Local admins may perform the complete `install_repo`, `uninstall_repo`, `enable_agent`, and `disable_agent` action set. A running agent may use a request-bound Agent Assertion to read state and submit only `enable_agent`, which supports on-demand dependency startup without granting repository or disable operations. Client helpers check status first and forward `mode` only when the caller supplies it; an omitted mode retains Marketplace's isolated default. Repository uninstall disables agents from that repository and removes the checkout while preserving source metadata for reinstall. Marketplace agent disablement removes the enabled-agent registry record before removing the runtime so the watchdog does not restart it during the operation.

`/webchat` uses the normal router login flow. `/status` is a local-control surface that requires a real router-authenticated local-admin session on an exact control Host. They do not accept a component token, invitation, agent assertion, media credential, or localhost provenance as admin identity. This monitoring route is read-only.

## Auth and agent cards

- Local auth stores hashed credentials in a workspace variable such as `PLOINKY_AUTH_<ROUTE>_USERS`.
- SSO stores a configured provider agent in workspace SSO config; provider manifests use `"ssoProvider": true`.
- The installed-agent index tracks route names, principals, runtime resources, and SSO-provider markers.
- `GET /agent-card` on the router lists successful capability responses from active agents without enforcing a fixed payload shape; `GET /<agent>/agent-card` proxies one agent's metadata.
- `POST /<agent>/v1/chat/completions` routes OpenAI-compatible requests to one agent, with `stream: true` selecting SSE streaming and normal JSON returned otherwise.
- `/<agent>/...` routes are transparent per-agent proxy routes after router-owned paths are handled. The router strips the `/<agent>` prefix; the target agent owns paths such as `/index.html`, `/agent-card`, `/v1/chat/completions`, and custom HTTP endpoints. `/<agent>/mcp` remains special so the router can preserve MCP session mediation and secure-wire token minting.
- `/base-agent-additional-server/<agentName>/<port>/<path>` selects an additional private server owned by an enabled agent. The agent must declare the path through `routerAccess.httpRoutes`; malformed selectors, reserved ports, stale owners, and undeclared paths fail closed. HTTP and WebSocket traffic uses the same immutable route-and-policy authorization generation.
- Delegated MCP calls use router-minted invocation JWTs. The router verifies the caller's session and forwards a fresh target invocation token.

## Dependency and profile commands

- `ploinky reinstall <agent>`: rebuild one exact agent registration's dependency tree from empty npm state and recreate its runtime. Dependency caches are otherwise managed automatically; the retired `ploinky deps` command only prints that hint and exits nonzero.
- `ploinky profile <dev|qa|prod>`: switch the active profile.
- `ploinky profile show|list|validate`: inspect profile state.

## Secrets and skills

- `ploinky vars`, `ploinky var <NAME> <value>`, and `ploinky echo <NAME>` manage `.ploinky/.secrets`.
- `ploinky expose <ENV_NAME> [<$VAR|value>] [agent]` maps values into agent environments.
- `ploinky default-skills <repoName>` refreshes the repo's skill directories under `.agents/skills/`. Skill directories with matching names are replaced from the repo, unrelated existing skills are preserved, and legacy `.claude/skills/` skills are migrated into `.agents/skills/` before compatibility symlinks are created. Generated links owned by Ploinky are excluded through private per-worktree Git configuration (`extensions.worktreeConfig` plus a worktree `core.excludesFile` inside the private Git directory), never through the tracked `.gitignore` or the shared `info/exclude`; `.agents/` itself stays visible. A live external excludes policy that would be shadowed defers the exclusion (reported as `exclusions-deferred`) unless `PLOINKY_SKILL_EXCLUDES_COMPOSE=1` authorizes composing it. Folders that are not in any Git repository keep a receipt-backed managed `.gitignore` block. Existing consumers without a recorded selection keep their current skills and are not silently broadened; run `ploinky default-skills <repoName>` in them to opt into all default skills.

## LLM helper behavior

- `ploinky-shell` is a shell-oriented entry point that asks the configured LLM for command suggestions.
- Invalid CLI input can also trigger LLM suggestions.
- The LLM helper uses this file as context, so this overview must stay in sync with the current CLI behavior.

WebChat message bubbles can occupy up to 80% of the chat width. Task cards show the executing robot when supplied by the CLI, status and duration. Cards always show **View Task Details** in the right pane or an available **Open live browser/desktop** link. Logs and the continuation composer live on the task details page. The chat header uses the selected robot launch parameter and optional runtime `robotName` metadata.

## Agent repository source selection

Agent repositories can live directly inside the workspace. Every operation selecting their source prefers a matching workspace checkout over `.ploinky/repos/<repository>`: first by repository alias as the folder name, otherwise by registered Git origin. Candidates must contain agent directories with `manifest.json`; multiple matching Git origins cause an error. The managed directory is the fallback when no local checkout matches. Explicitly unregistered repositories remain excluded until installed again.

For example, `work/AssistOSExplorer` can supply `AchillesIDE` while Ploinky runs in `work`, even with a cached `.ploinky/repos/AchillesIDE` present. An explicit update can pull into the selected local Git checkout. Uninstalling a local repository unregisters it and preserves its files. See [workspace repository operations](operations.html#workspace-agent-repositories).

Workspace agent checkouts may have a different folder name from their registered repository alias. Discovery matches the Git origin to the registered source and keeps the alias for runtime principals, container identity, dependency caches and Router attestation. The checkout path selects source files; it does not rename the agent.

Repository dependencies declared in agent manifests are discovered from each repository's selected source, including workspace-only checkouts. Installing a new alias can match its explicit Git URL to a differently named local checkout; it records the association without cloning or switching that checkout's branch. Container diagnostics prefer the runtime principal over staged code directory names. Existing runtime generations retain their admitted source paths until a lifecycle transition selects a new source.

When a new runtime starts, Bubblewrap and Seatbelt refresh managed source symlinks before resolving code and skill paths for dependency preparation and execution. If the selected source has no `skills/` directory, lifecycle preparation removes the previous managed skills symlink, including dangling links, while preserving real user directories and the old source files.

Installed and active repository lists use the same source resolver. They include workspace-only agent repositories under their registered aliases, exclude unregistered or missing sources, and retain managed repositories. If no enabled repository list is configured, the active list contains all installed repositories; otherwise it contains only installed entries from that list.
