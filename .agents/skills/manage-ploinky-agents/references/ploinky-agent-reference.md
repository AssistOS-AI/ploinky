# What is a Ploinky agent?

A Ploinky agent is a repository-owned runtime component discovered from a `manifest.json` file under an installed repository. The installed-agent index scans paths shaped like `.ploinky/repos/<repo>/<agent>/manifest.json` and builds a descriptor for each discovered agent. The descriptor includes the installed repository name, the agent directory name, the canonical reference `<repo>/<agent>`, the agent id `agent:<repo>/<agent>`, whether the manifest marks the agent as an SSO provider, and normalized runtime resource requests.

A discovered agent is not automatically running. An agent becomes enabled when the Ploinky enable flow writes an agent record into `.ploinky/agents.json`. That enabled record supplies the route key, auth mode, runtime mode, project path, image, bind configuration, and exposed port information later used by workspace startup.

An enabled agent can be addressed by its short name or by an alias. An alias becomes a route key and can expose the agent at a different public URL prefix, such as `/<alias>/mcp`. The alias must not change the canonical agent id, which remains derived from the original repository and agent directory.

## How does agent workspace layout work?

Ploinky supports isolated, global, and development runtime modes. In isolated mode, the agent works in `.ploinky/agents/<agent>/`. In global mode, the agent works directly in the workspace root. In development mode, the agent works against `.ploinky/repos/<repo>`, which is the installed repository checkout.

The workspace also maintains symlinks and shared directories. Agent code is linked under `.ploinky/code/<agent>`, skills are linked under `.ploinky/skills/<agent>`, shared storage lives under `.ploinky/shared`, logs live under `.ploinky/logs`, runtime state lives under `.ploinky/running`, dependencies live under `.ploinky/deps`, and transcripts live under `.ploinky/transcripts`.

Container-style startup mounts the bundled agent runtime at `/Agent`, the agent source at `/code`, the workspace shared area at `/shared`, and the selected project path at its host path. The bundled AgentServer looks for its MCP configuration at `/code/mcp-config.json` by default through `PLOINKY_MCP_CONFIG_PATH`.

## Which manifest fields affect runtime behavior?

`manifest.json` is the main agent contract. The fields `container` and `image` choose the container image, with `node:18-alpine` as the default when neither is set. The field `start` supplies the main startup command and usually causes readiness to default to TCP unless readiness is explicit. The field `agent` and the nested field `commands.run` are explicit agent commands. When no `start`, `agent`, or `commands.run` field exists, Ploinky uses the bundled `sh /Agent/server/AgentServer.sh` launcher, which starts `Agent/server/AgentServer.mjs`.

The nested field `readiness.protocol` can be `tcp`, `mcp`, or `none`. The field `enable` declares dependency agents. The field `repos` declares repositories to install and enable before dependencies are processed. The field `profiles` can add profile-specific environment variables, ports, lifecycle hooks, secrets, mounts, network settings, and extra enable entries.

The fields `env` and profile-level `env` describe environment variables copied from the process environment, `.ploinky/.secrets`, `.env`, generated secrets, or explicit values. Wildcards may be supported by the runtime, but raw secrets should not be committed into manifests. The fields `ports` and profile-level `ports` declare port mappings. When no port mapping is present, Ploinky publishes container port `7000` on a random localhost host port.

The field `guest: true` enables guest auth mode for the route. The value `ploinky: "pwd enable"` enables local password auth unless overridden. The value `ploinky: "sso enable"` enables SSO auth unless overridden. The field `pwd.users` seeds local users when local auth is enabled.

The field `httpServices` exposes protected or authenticated HTTP service routes through the router. The field `publicServices` exposes anonymous HTTP service routes through the router. The nested field `endpoints["agent-card"]` defines the agent-card payload returned by the agent-side `/agent-card`. The nested field `endpoints.chatCompletions` configures the OpenAI-compatible `/v1/chat/completions` command. The field `ssoProvider: true` marks the agent as an SSO provider candidate. The nested field `runtime.resources` describes runtime resource requests used by the installed-agent index.

## How does enable grammar work?

The enable grammar accepts strings and objects. String entries can include `as <alias>` and `no-wait` in any position. Object entries can use `agent`, `ref`, `spec`, or `name` to identify the dependency. Object entries can also use `alias` or `as`, `profile`, and either `noWait` or `no-wait`.

When editing enable directives, preserve dependency intent. A blocking dependency must be ready before the dependent starts. A `no-wait` dependency may start in the background and must not be assumed ready by dependent code.

## How does startup and routing work?

`startWorkspace()` is the orchestrator. It ensures the static agent is enabled, applies manifest repositories and enable directives, builds a dependency graph, starts dependency waves, updates `.ploinky/routing.json`, and starts the router watchdog on the selected port.

The dependency graph combines top-level `manifest.enable` with active-profile `profiles[profile].enable`. Dependencies start before dependents. A no-wait edge starts in the background through the no-wait worker, while a blocking edge must be ready before the dependent proceeds.

For each started route, `.ploinky/routing.json` stores the router port, static route information, and route entries that point at localhost host ports. A route entry contains the container name, host path, repository name, agent name, alias, and host port. Route keys under `routes` become public URL prefixes. If the route key is `demo`, router paths under `/demo/...` are forwarded to the agent on `127.0.0.1:<hostPort>` after the router applies its rules.

```json
{
  "port": 8080,
  "static": {
    "agent": "demo",
    "container": "ploinky-demo-demo"
  },
  "routes": {
    "demo": {
      "container": "ploinky-demo-demo",
      "hostPath": "/absolute/path/to/.ploinky/repos/demo/demo",
      "repo": "demo",
      "agent": "demo",
      "alias": "",
      "hostPort": 54321
    }
  }
}
```

## What does the bundled AgentServer do?

The bundled runtime server is `Agent/server/AgentServer.mjs`. It uses the MCP SDK with `McpServer` and `StreamableHTTPServerTransport`. It listens on `PORT` or `7000`. Inside a container it normally binds to `0.0.0.0`, and outside a container it normally binds to `127.0.0.1`, unless `PLOINKY_AGENT_BIND_HOST` overrides the host.

The advertised server name is `ploinky-agent-mcp`, and the advertised version is `1.0.0`.

The server loads MCP config from the first existing path in this search order.

```text
PLOINKY_AGENT_CONFIG
MCP_CONFIG_FILE
AGENT_CONFIG_FILE
PLOINKY_MCP_CONFIG_PATH
/tmp/ploinky/mcp-config.json
${PLOINKY_CODE_DIR || "/code"}/mcp-config.json
process.cwd()/mcp-config.json
```

The server loads the agent manifest from the first existing path in this search order.

```text
PLOINKY_AGENT_MANIFEST
PLOINKY_MANIFEST_FILE
AGENT_MANIFEST_FILE
${PLOINKY_CODE_DIR || "/code"}/manifest.json
process.cwd()/manifest.json
```

## How does MCP configuration become runtime behavior?

`mcp-config.json` can define tools, resources, and prompts. A tool entry is registered with `server.registerTool()`. The important fields are `name`, `command`, `args`, `cwd`, `env`, `timeoutMs`, `timeout`, `title`, `description`, `inputSchema`, and `async`. A tool command receives JSON on standard input and returns MCP text content from standard output. Standard error is appended as a separate text item prefixed with `stderr:\n`. A non-zero exit becomes an MCP internal error.

Before a tool command runs, the server calls invocation verification. The tool receives a payload that includes the tool name, the input object, and metadata about the user, caller, or provider.

```json
{
  "tool": "docs_search",
  "input": {
    "query": "contract"
  },
  "metadata": {
    "user": "user:daniel",
    "caller": "agent:explorer/docs-agent",
    "provider": "ploinky-router"
  }
}
```

An async tool is backed by the task queue. The default task queue persists under `.tasksQueue`, limits concurrent tasks to ten unless configured, and stores log tails with a default cap of one hundred twenty-eight KiB. Pending or running tasks found after a restart are marked failed. An async tool result includes task metadata, and the browser MCP client polls the task-status endpoint until completion or failure.

A resource entry is registered with `server.registerResource()`. It can use a fixed `uri` or a template. Resource reads are protected by invocation verification with the expected tool name `resources/read`. The resource command receives JSON on standard input and returns resource content through standard output.

```json
{
  "resource": "agent_status",
  "uri": "ploinky://agent/status",
  "params": {}
}
```

A prompt entry is registered with `server.registerPrompt()`. Prompt definitions are read from MCP config and exposed through the underlying MCP server.

## Which agent-side HTTP endpoints exist?

The bundled agent runtime serves `/health`, `/agent-card`, `/mcp`, `/task`, `/getTaskStatus`, `/v1/chat/completions`, and static files. `GET /health` returns a health JSON. `GET /agent-card` reads `manifest.endpoints["agent-card"]` and returns a normalized card, or returns `404` when no card exists. `POST /mcp`, `GET /mcp`, and `DELETE /mcp` implement Streamable HTTP MCP sessions. `GET /task` and `GET /getTaskStatus` expose secure task-status lookup. `POST /v1/chat/completions` is available when `manifest.endpoints.chatCompletions` is configured. Static file serving runs after protected runtime endpoints and performs path traversal checks.

The chat completions handler sends its command a payload with endpoint name, request body, agent metadata, and auth information. Non-stream responses must be JSON. Streaming is allowed only when the manifest configuration supports streaming. The chat completions endpoint is not privileged and must not implicitly invoke `admin` or `internal` tools.

```json
{
  "endpoint": "openai.chat.completions",
  "request": {},
  "metadata": {
    "agent": "demo",
    "authInfo": {}
  }
}
```

## What does the router own?

`cli/server/RoutingServer.js` is the public HTTP router. It listens on `PORT` or `8080`. It loads `.ploinky/routing.json`, reserves router-owned paths, extracts an agent route prefix from the first path segment, and forwards allowed agent paths to the route's host port.

The router owns `/health`, `/MCPBrowserClient.js`, `/auth/*`, `/api/agents/*`, aggregate `/mcp`, aggregate `/agent-card`, `/services/*`, `/public-services/*`, `/webtty/*`, `/webchat/*`, `/dashboard/*`, `/status/*`, `/upload`, `/blobs/*`, `/workspace-files/*`, and `/`. An agent named `mcp`, `auth`, `webchat`, or another router-owned mount must not capture those routes.

If `.ploinky/routing.json` contains route key `demo`, the router treats `/demo/...` as an agent-prefixed route unless the path is router-owned. The external path `/demo/mcp` routes to the agent's `/mcp`. The external path `/demo/task?taskId=...` routes to `/task?taskId=...`. The external path `/demo/agent-card` routes to `/agent-card`. The external path `/demo/v1/chat/completions` routes to `/v1/chat/completions`. Static and custom paths under `/demo/...` have the prefix stripped before they reach the agent.

## How does aggregate MCP work?

Aggregate `/mcp` is implemented by the router. `GET /mcp` returns `405` because event-stream mode is not supported. `DELETE /mcp` deletes the aggregate MCP session named by `mcp-session-id`. `POST /mcp` accepts JSON-RPC or a legacy command envelope.

For JSON-RPC, `initialize` starts a router MCP session and returns protocol version `2025-06-18`, capabilities, server info, and instructions. `notifications/initialized` refreshes session activity. `tools/list` lists tools from all routed agents and annotates each tool with router agent metadata. `resources/list` lists resources from all routed agents. `tools/call` calls one routed agent's tool, using `params.agent` or `_meta.router.agent` to disambiguate when needed. `resources/read` reads one routed agent's resource. `ping` pings a named agent.

For legacy envelopes, the router canonicalizes command names such as `tools/list`, `methods`, `list_tools`, `tools`, `resources/list`, `list_resources`, `resources`, `tools/call`, `tool`, `resources/read`, and `ping`. The command `status` is explicitly rejected on the aggregate endpoint. When more than one agent provides the same tool and no target agent is specified, the router returns `409` and lists the matching agents.

## How does per-agent MCP proxying work?

The per-agent `/<agent>/mcp` proxy creates a router-side MCP facade for one route and forwards calls to the agent's real `/mcp` endpoint. `GET` returns `405`, `DELETE` closes the proxy session, and `POST` accepts JSON-RPC. `initialize` advertises server name `ploinky-router-proxy:<agent>`. `tools/list` and `resources/list` delegate to the agent. `tools/call` canonicalizes arguments, mints a router-signed invocation JWT, and calls the underlying agent tool. `resources/read` mints an invocation JWT and reads the resource from the underlying agent.

Non-delegated browser or user calls must pass router authentication for the target route. Delegated agent calls use `X-Ploinky-Caller-JWT` and are accepted only for direct JSON-RPC `tools/call` requests.

## How do HTTP service routes work?

Agents can expose additional HTTP services through `httpServices` and `publicServices` in route config or manifest config. `httpServices` defaults to protected auth and external prefix `/services/<slug>/`. `publicServices` defaults to anonymous auth and external prefix `/public-services/<slug>/`. Auth values such as `none`, `public`, and `anonymous` mean anonymous. Auth values such as `guest` and `visitor` mean guest. Auth values such as `protected`, `authenticated`, `auth`, `local`, and `sso` mean protected.

The fields `externalPrefix`, `prefix`, and `path` can override the public path prefix. The fields `internalPrefix`, `targetPrefix`, and `upstreamPrefix` control the upstream path prefix on the agent and default to `/`. The setting `invocation: false` disables invocation-token issue for that route. The setting `includeAuthInfo: false` disables `x-ploinky-auth-info` injection.

Protected and guest service routes receive an `x-ploinky-auth-info` header unless disabled. When invocation is enabled, auth info includes an invocation token for the special tool `__http_service__`. Generic agent-prefixed HTTP passthrough strips router identity headers before proxying. HTTP service routes are the intentional path for injecting auth context.

## What operational details matter during edits?

The default agent runtime is MCP-first. If an agent manifest supplies only `start`, readiness often defaults to TCP because the runtime assumes the custom process owns readiness. If the manifest supplies `agent` or `commands.run`, Ploinky treats it as an explicit runtime command. If no runtime command is supplied, the bundled AgentServer starts and exposes `/mcp`.

The router waits briefly for agents to become ready before serving per-agent MCP calls. If an agent is still starting, JSON-RPC calls receive a JSON-RPC error and non-RPC calls receive a `503` JSON response.

Agent static-file serving performs containment checks before returning files. The configured root is resolved, and candidate files are checked with real paths. A configured static root that is itself a symlink can cause a candidate to resolve outside the textual root and be rejected even when the file is logically under the configured directory.

Per-agent proxy tool schemas are cached briefly for argument sanitization. The proxy strips unknown arguments based on the advertised schema before minting the invocation token. Aggregate `/mcp` closes per-agent MCP clients at the end of each command dispatch. Per-agent proxy calls create short-lived clients for invocation-bearing requests so the authorization header is scoped to one operation.
