# How should a coding agent manage Ploinky agents?

This reference describes the practical workflow for creating, updating, and reviewing Ploinky agents. It is written for coding agents that edit real repositories and must preserve config and security invariants.

## How should a new agent be created?

Choose the repository name and agent directory name before defining policies. The canonical agent id will be `agent:<repo>/<agent>`, and policy entries will depend on that identity. Treat the agent id as durable. Decide whether the public route key is the short agent name or an alias, and remember that an alias is only a routing label.

Create `manifest.json` before writing tool code. Prefer the bundled AgentServer when the agent is MCP-first. Set `readiness.protocol` explicitly so startup behavior is obvious. Add `httpServices` only when the agent truly needs protected HTTP routes. Add `publicServices` only when anonymous exposure is intentional and safe. Keep raw secrets out of the manifest.

Create `mcp-config.json` one narrow tool at a time. Give each tool a stable name, clear title, clear description, explicit command, working directory, timeout, and strict input schema. Leave tags missing for ordinary authenticated-user tools. Use `internal` only for agent-to-agent tools. Use `admin` only for user-admin tools. Do not combine `internal` and `admin`.

Write tool handlers as standard-input JSON commands. The handler should parse the payload, verify the expected tool name, validate user input, perform one narrow operation, and write clear output to standard output. It should not read raw user session tokens, raw router request tokens, raw agent secrets, or the master key.

Add policy through the router's intended administrative mechanism. Do not let the new agent self-administer policy. Missing policy must mean deny, so a new tool is not ready until its default tag behavior and persisted policy path are understood.

Validate the agent with the bundled validator. Then run the repository tests that cover manifest parsing, route prefixing, MCP proxy behavior, authentication, authorization, policy, and any public service behavior. A new public route deserves skeptical review because it changes the exposed attack surface.

After the new agent exists, resynchronize the owning repository's specifications and documentation with `gamp-specs`. Add or update the DS specifications that describe the agent's identity, runtime mode, tools, policy expectations, and any service exposure, regenerate the HTML documentation and `docs/specs/matrix.md`, and run that repository's documentation link verification. Treat those specifications as the source of truth that the agent's configuration and code must continue to satisfy.

## How should an existing agent be updated?

Begin by reading the owning repository's DS specifications for the target agent together with its current manifest, MCP config, route state, and persisted policy. Identify the installed repository, agent directory, canonical agent id, route key, alias, tool names, resource names, service routes, public paths, chat endpoints, and policy entries before changing files. When the specifications and the implementation disagree, treat the specifications as the intended contract and reconcile the difference deliberately rather than silently following the code.

Preserve identity unless the user explicitly requested a migration. A rename can break agent ids, route URLs, policy state, aggregate MCP disambiguation, tests, and external callers. If a rename is required, migrate every dependent reference together and leave compatibility notes in the final response.

When adding a tool, check for name collisions inside the agent and check whether aggregate `/mcp` users may need explicit agent disambiguation. A same-named tool in two agents can be valid, but callers must be able to choose the target agent. When renaming a tool, treat the change as a compatibility break unless callers and policy entries are migrated together.

When changing tags, remember that tags are defaults and persisted policy wins. Editing `mcp-config.json` may not change an existing policy entry. Review policy state for the same `agent + tool` and make the intended policy explicit.

When changing an HTTP service, decide whether the route is protected, guest, anonymous, or public protected. Protected service routes can receive router auth info. Generic agent-prefixed passthrough should not receive client-supplied router identity headers. Public service routes should not be used as a shortcut for authenticated behavior.

When changing chat completions behavior, keep `/v1/chat/completions` non-privileged. The command should not implicitly call `admin` or `internal` tools. If privileged work is needed, expose a properly tagged MCP tool and let router policy decide.

When changing startup behavior, verify that the expected runtime surface still exists. A custom `start`, `agent`, or `commands.run` can replace bundled AgentServer behavior, so check whether `/mcp`, `/agent-card`, `/task`, `/getTaskStatus`, static serving, and chat completions still behave as expected.

When any change lands, update the affected DS specifications first if the intended behavior changed, then make the configuration or code match them, and finish by resynchronizing the repository's specifications and documentation with `gamp-specs`. Record interface, routing, policy, and security changes in the affected DS files, regenerate `docs/specs/matrix.md`, and run the repository's documentation link verification so the specifications stay authoritative.

## How should a security-sensitive diff be reviewed?

Treat JWT logic, request hashes, policy, whitelist entries, service exposure, guest mode, public services, auth headers, and agent-to-agent code as security-sensitive. Confirm that `PLOINKY_MASTER_KEY` is not injected into agents and that each agent receives only its own agent id and secret.

Confirm that User Session JWTs terminate at the router. The router may use the user identity to make a policy decision and to mint a Router Request JWT, but the raw user session token must not reach AgentServer.

Confirm that agent-to-agent calls go through the router. The source agent signs an Agent Assertion JWT with its own secret. The router verifies the assertion, recomputes the request hash, checks MCP policy, and mints a Router Request JWT for the target agent. The target AgentServer verifies the router token and the request hash before execution.

Confirm that request hashes are canonical and deterministic. Object keys should be sorted, array order should be preserved, and `undefined` should be rejected. Non-JSON bodies should be represented by a byte hash. A token with the wrong method, path, tool, audience, issuer, type, or request hash must be rejected.

Confirm that HTTP whitelist behavior is readonly and path-based. Query strings should not decide public access. Wildcards should appear only as a final `/*`. Internal routes should be blocked both when policy is written and when policy is matched.

Confirm that error messages do not leak private resource existence to guests. Internal logs may contain precise denial reasons, but public errors should remain generic.

## How should a coding agent decide that the change is done?

A finished change has valid JSON, stable agent ids, stable routing semantics, valid tool tags, deliberate service exposure, correct policy behavior, and no raw secrets in source files or logs. The agent is discoverable from `manifest.json`, the runtime can find `mcp-config.json`, every new or changed tool has a unique name and schema, and any public exposure is intentional. A finished change also leaves the owning repository's specifications and documentation resynchronized with `gamp-specs`, so the DS specifications, the HTML documentation, and `docs/specs/matrix.md` describe the new behavior rather than the old.

A finished change should be checked with the bundled validator when possible.

```bash
node scripts/validate-ploinky-agent.mjs --agent-dir <agent-dir> --policy-state <policy-state.json>
```

A finished change should also be understandable to a future maintainer. The manifest should explain runtime intent through structure rather than hidden assumptions. Tool descriptions should say what the tool does and who should call it. Policy should express access explicitly instead of relying on accidental defaults.
