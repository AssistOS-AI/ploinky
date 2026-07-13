# Ploinky

Ploinky is a lightweight runtime for AI agents. It is technology‑agnostic: an agent can be implemented in any language as long as it reads from stdin and writes to stdout (a simple console process). Ploinky exposes that process as a terminal (Console) and also as a chat interface — the chat mirrors the same TTY stream for a nicer UX.

Beyond a single agent, Ploinky supports a multi‑agent workspace. Each agent runs in its own container. A local web router serves a simple web app and proxies API calls to the containers, so you can build applications that orchestrate multiple agents. A companion cloud component (in progress) will host multiple such custom apps, each with its own agents and routes.

## Prerequisites
- Node.js 18+
- Docker or Podman
- Git

## Getting started

```bash
# Clone and setup
git clone https://github.com/AssistOS-AI/ploinky.git
cd ploinky
export PATH="$PATH:$(pwd)/bin"

# Start the CLI
p-cli

# Enable an agent and start the workspace
enable agent my-agent
start my-agent 8088

# Browser chat surface
webchat
```

## Usage

You can use Ploinky in two ways:

1.  **From within the project directory:**
    As shown in the "Getting started" section, you can run `p-cli` from within the cloned project directory.

2.  **Globally from any directory:**
    To use `ploinky` from anywhere, you need to add its location to your shell's configuration file (e.g., `.bashrc`, `.zshrc`).

    Add the following line to your `~/.bashrc` or `~/.zshrc` file, replacing `~/path/to/ploinky` with the actual path to your ploinky directory:

    ```bash
    export PATH="$PATH:~/path/to/ploinky/bin"
    ```

    After adding the line, restart your shell or run `source ~/.bashrc` (or `source ~/.zshrc`). You can then use `p-cli` or `ploinky` from any directory. For example:

    ```bash
    ploinky list agents
    ```

## Core commands (in p-cli)

- `enable agent <name> [as <alias>]`: register an agent in `.ploinky/agents.json` (creates a minimal manifest if missing). Use `as <alias>` to spin up additional instances with unique container names.
- `update [folderPath]`: update the Ploinky checkout, refresh `node_modules/achillesAgentLib`, update managed repos, refresh `AchillesCopilotBasicSkills` in eligible managed repos, and refresh discovered project repositories and default skills.
- `start <staticAgent> <port>`: first run requires a static agent and port; subsequent runs can just use `start`.
  - Ensures all enabled agents are running and launches the Router on `<port>`.
  - Serves static files from the repository of `<staticAgent>`; non `/<agent>/...` paths are static.
- `cli <name> [args...]`: run the agent’s CLI command interactively.
- `shell <name>`: open interactive `/bin/sh` in the agent container.
- `webchat [--rotate]`: print the WebChat access URL for the router login flow.
- `dashboard [--rotate]`: prepare or rotate the dashboard token and print its access URL.
- `client tool <toolName> [--agent <agent>] [--parameters <params>] [-key value...]`: call an MCP tool exposed by an enabled agent.
- `client list tools|resources`: list MCP tools or resources exposed by enabled agents.
- `client status <agent>`: check agent health status.
- `stop`: stop containers recorded in `.ploinky/agents.json` (do not remove).
- `shutdown`: stop and remove containers recorded in `.ploinky/agents.json`.
- `destroy`: stop the router, remove workspace containers, and clear `.ploinky/deps` while preserving isolated agent data in `.data/<agent-or-alias>`.
- `deps prepare [<repo>/<agent>]`: build the prepared node_modules cache for the current runtime.
- `deps status`: list prepared global and per-agent caches with their runtime keys and validity.
- `deps clean <repo>/<agent>|--global|--all`: remove a cache directory.

## Dependency caches

Node-based agents consume a prepared, runtime-keyed dependency cache. `ploinky start` prepares or reuses the cache before launching the runtime; `ploinky deps prepare` lets operators warm or refresh the same cache explicitly.

- Global deps come from `ploinky/globalDeps/package.json` and land in `.ploinky/deps/global/<runtime-key>/node_modules/`.
- Per-agent deps merge global + `<agent>/package.json` and land in `.ploinky/deps/agents/<repo>/<agent>/<runtime-key>/node_modules/`.
- The runtime key is `<family>-<platform>-<arch>-node<major>` for host runtimes and may include a Linux container libc variant when needed, for example `container-linux-x64-musl-node20` or `container-linux-x64-glibc-node20`.
- Agents mount the cache read-only. Startup checks the cache stamp (runtime key + merged-package hash) and prepares the cache when it is missing or stale, which may require npm, git, network access, and native build tools.
- `bwrap`, `seatbelt`, and container runtimes all consume prepared caches now. Container caches are prepared in a short-lived install container that matches the target runtime image, then mounted read-only into the runtime container.

## Notes

- Containers run with the workspace directory mounted read‑write at the same path inside the container.
- Ploinky’s `Agent` tools directory is mounted read‑only at `/Agent` in every container, providing a supervisor script and helpers.
- If an agent manifest lacks an `agent` command, the container runs `/Agent/AgentServer.sh` which supervises the default AgentServer and restarts it if it exits.

## WebChat agent requirements

- WebChat sends structured message envelopes over stdin. Agents that want a reliable chat experience should expose a real CLI process that reads stdin continuously and writes replies to stdout.
- A manifest `cli` that points to a plain shell such as `"/bin/sh"` or `"/bin/bash"` does not become conversational by itself. In that setup WebChat mirrors raw input to the shell, and the shell may simply echo or mis-handle the incoming payload.
- The recommended pattern is a dedicated CLI entrypoint such as `node /code/main.mjs` that parses WebChat input and keeps running for the full session.
- `ploinky cli <agent>` and WebChat share the same manifest `cli`, so the same command must be suitable for both interactive terminal use and WebChat streaming input.
- At WebChat startup, the CLI receives `PLOINKY_WEBCHAT_HAS_HISTORY=1` when the selected conversation already contains messages, otherwise `0`. Agents that emit a new-conversation introduction should omit it when the value is `1`; Ploinky supplies the prior conversation context with the next normal user message.

## Cloud (preview)

The cloud component will allow hosting multiple custom apps built on Ploinky, each with its own agents and routes.

## License

MIT License - see [LICENSE](LICENSE)
