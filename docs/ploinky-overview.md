# Ploinky Overview

Ploinky is a workspace-local runtime for repository-backed agents.

## Workspace model

- The workspace root is the nearest directory that contains `.ploinky/`.
- Runtime state lives under `.ploinky/`, including `agents.json`, `routing.json`, `.secrets`, `repos/`, `deps/`, `logs/`, `keys/`, and `transcripts/`.
- Agent repositories are cloned under `.ploinky/repos/<repo>/`.
- The default `start` flow requires a static agent and router port the first time, then reuses the saved configuration.

## Common CLI commands

- `ploinky add repo <name> [url] [branch]`: clone a repository into `.ploinky/repos/`.
- `ploinky update [folderPath]` and `ploinky update all [folderPath]`: update the Ploinky checkout, refresh `ploinky/node_modules/achillesAgentLib`, update `.ploinky/repos/`, repairing non-git installed repo directories by recloning on the recorded branch when a source URL is known, recursively update discovered git repositories, and refresh Achilles default skills in those project repositories. Discovered project repositories with missing or unreachable remotes are logged and skipped for the pull step while still receiving default skills. When no folder path is provided, discovery starts at the current working directory.
- `ploinky update repos`: update installed `.ploinky/repos/` entries and refresh both the Ploinky runtime Achilles checkout and managed-repo Achilles dependencies.
- `ploinky update repo <name>`: update one repository under `.ploinky/repos/`.
- `ploinky enable repo <name> [branch]`: enable a repository for discovery and listings.
- `ploinky enable agent <name|repo/name> [global|devel [repo]] [--auth none|pwd|sso] [as <alias>]`: register an agent in `.ploinky/agents.json`.
- `ploinky start [staticAgent] [port] [--branch <branch>] [--repo-branch <repo=branch>]... [--branch-fallback default|fail] [--reset-repos]`: resolve dependency waves, start enabled agents, write `routing.json`, and launch the router under the watchdog. `--branch` sets a candidate branch for all repos involved in this start; `--repo-branch` overrides it per repo. `--branch-fallback default` (the default) keeps repos on their configured branch when the candidate is missing; `fail` aborts. `--reset-repos` permits hard reset of dirty managed repos.
- `ploinky status`: show SSO state, router listening state, installed and enabled repositories, and running agent containers.
- `ploinky list routes`: inspect the current `.ploinky/routing.json` route table.
- `ploinky restart`: restart enabled agents and the router.
- `ploinky shell <agent>`: open `/bin/sh` inside the running agent backend.
- `ploinky cli <agent> [args...]`: run the manifest CLI command interactively.
- `ploinky stop`: stop enabled agents and the router without removing runtime state. Host-sandboxed agents are signaled in a batch before Ploinky waits.
- `ploinky shutdown`: stop the router and remove runtimes recorded for this workspace in `.ploinky/agents.json`.
- `ploinky destroy`: stop the router, remove all Ploinky runtimes for the workspace, and clear `.ploinky/agents/`.
- `ploinky clean`: alias for `destroy`.
- `ploinky logs tail [router]` and `ploinky logs last <N> [router]`: inspect router logs. Router logs are the only logs exposed through the CLI.
- `ploinky webtty [shell] [--rotate]` and `ploinky webconsole [shell] [--rotate]`: show or rotate the WebTTY token and optionally set the interactive shell.
- `ploinky webchat [--rotate]`: show or rotate the WebChat token.
- `ploinky webmeet [moderatorAgent] [--rotate]`: show or rotate the WebMeet token and optionally persist the moderator agent.
- `ploinky dashboard [--rotate]`: show or rotate the dashboard token used for `/dashboard` and invitation-style `/status` access.
- `ploinky client list tools|resources`, `ploinky client status <agent>`, and `ploinky client tool <name>`: inspect or call MCP surfaces through the router.

## Web surfaces

- `/webtty`: browser terminal.
- `/webchat`: chat surface over the same TTY stream, with encrypted transcript storage. When opened as `/webchat?agent=<name>&...`, the router forwards every additional query parameter except `tabId` to `ploinky cli <name>` as long-form CLI flags encoded as `--key=value`.
- `/webmeet`: meeting and moderator UI.
- `/dashboard`: management surface, including transcript and feedback views.
- `/status`: read-only browser view that shells out to `ploinky status` and adds router-side server and agent summaries.

`/webtty`, `/webchat`, and `/webmeet` use the normal router login flow. `/dashboard` still supports `WEBDASHBOARD_TOKEN`, and `/status` reuses the dashboard token or dashboard invitation link for read-only access.

## Auth and agent cards

- Local auth stores hashed credentials in a workspace variable such as `PLOINKY_AUTH_<ROUTE>_USERS`.
- SSO stores a configured provider agent in workspace SSO config; provider manifests use `"ssoProvider": true`.
- The installed-agent index tracks route names, principals, runtime resources, and SSO-provider markers.
- `GET /agent-card` on the router lists successful capability responses from active agents without enforcing a fixed payload shape; `GET /agent-card/<agent>` proxies one agent's metadata.
- `POST /v1/chat/completions/<agent>` routes OpenAI-compatible requests to one agent, with `stream: true` selecting SSE streaming and normal JSON returned otherwise.
- `/agent-card` and `/v1/chat/completions/<agent>` are public at the router level; the target agent decides whether to accept or reject the request. Orchestrators discover remote agents through `PloinkyAgentSkillsSubsystem` and declare them via `## Allowed Agents` in `oskill.md`.
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
