# Manage Ploinky agents safely.

This directory is a portable skill for Codex and Claude Code CLI. It teaches a coding agent how to create, update, review, and secure Ploinky agents without breaking identity, routing, authentication, authorization, policy, service exposure, or filesystem invariants.

The skill is designed as an operating contract rather than a long encyclopedia. `SKILL.md` contains the compact behavior that a coding agent should load first. The `references` directory contains the deeper model, config details, security invariants, workflows, and code examples. The `scripts` directory contains a deterministic validator that can check an agent directory and an optional policy state file.

## Install this skill into a repository.

Run the installer from this directory and pass the repository root. The installer copies the skill into both `.agents/skills/manage-ploinky-agents` and `.claude/skills/manage-ploinky-agents`.

```bash
./install.sh /path/to/your/repository
```

After installation, Codex can discover the skill from the repository skill directory, and Claude Code can discover the skill from the Claude skill directory. You can also copy this directory manually to a user-level skill location when you want it available across repositories.

## Use the skill while editing an agent.

Ask the coding agent to use `manage-ploinky-agents` whenever a task touches `manifest.json`, `mcp-config.json`, router policy, HTTP services, public services, chat completions, JWT signing, request hashes, MCP tools, or agent-to-agent calls. The most important behavior is not merely to generate valid JSON. The important behavior is to preserve the Ploinky security model while making the requested change.

A Ploinky agent has a canonical agent id in the form `agent:<repo>/<agent>`. The public route key may be an alias, but the alias must not change the agent id. The router remains the public control point for agent application surfaces; a declared media or data plane (for example a LiveKit WebRTC SFU) may be reached directly but only with a router-issued, plane-verified credential. User Session JWTs terminate at the router. Agent Assertion JWTs go from agents to the router. Router Request JWTs go from the router to the target AgentServer. MCP policy is explicit and fail-closed.

## Validate an agent directory.

The included validator checks common structural and security invariants in `manifest.json`, `mcp-config.json`, and an optional router policy state file.

```bash
node scripts/validate-ploinky-agent.mjs --agent-dir examples/demo-agent --policy-state examples/policy-state.safe.json
```

The validator is intentionally conservative. A warning does not always mean the config is wrong, but it should trigger a review. An error means the edit violates an invariant that should not be merged without a deliberate compatibility decision.

## Read the references when the task requires them.

`references/ploinky-agent-reference.md` explains what a Ploinky agent is, how it is discovered, how runtime modes work, how the bundled AgentServer behaves, how aggregate `/mcp` and per-agent `/<agent>/mcp` work, and how service routes are exposed. `references/config-files.md` explains `manifest.json`, `mcp-config.json`, `policy-state.json`, service declarations, and safe example shapes. `references/security-invariants.md` explains the router boundary, JWT families, request hashes, MCP policy, HTTP whitelist behavior, and the exact separation between user-admin and internal-agent access. `references/workflows.md` explains how to create, update, and review agents. `references/code-examples.md` contains Node.js examples for tool handlers, canonical request hashing, Agent Assertion JWT signing, and safe HTTP handler patterns.

## Keep the specifications in sync.

This skill treats the DS specifications of the repository that owns an agent as the source of truth. Before changing behavior, read the relevant specifications; after changing a Ploinky agent or the Ploinky runtime, regenerate that repository's specifications and documentation with the `gamp-specs` skill so the specs describe the new behavior and the implementation can be checked against them. Run `gamp-specs` against the edited repository, not against this skill folder. A change is not finished while the specifications still describe the previous behavior.

## Keep the skill human-readable.

The Markdown files intentionally use prose, headings, and code examples instead of bullet-heavy checklists. This makes the skill easier for humans to audit while still giving coding agents direct operational instructions. The validator and examples provide the deterministic parts that prose should not try to enforce alone.
