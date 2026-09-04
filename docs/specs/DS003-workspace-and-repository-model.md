---
title: DS003-workspace-and-repository-model
summary: Defines workspace identity, the .ploinky and .data directory contracts, repository layout, agent discovery, and durable data boundaries.
---

# DS003 Workspace and Repository Model

## Introduction

A Ploinky workspace is the directory from which Ploinky manages one project and its agents. Every operation must resolve one canonical workspace before it reads or changes runtime state. The workspace keeps Ploinky-managed control state and installed agent source under `.ploinky/`, while persistent per-instance agent homes live under the separate `.data/` directory.

## Core Content

### Workspace boundary

The public Box identity must be derived from the canonical absolute workspace path and must include a readable slug plus a path-derived hash. When a command runs inside a descendant directory, Ploinky must walk upward to the nearest directory that contains `.ploinky/` and use that directory as `PLOINKY_WORKSPACE_ROOT`. An explicit valid `PLOINKY_WORKSPACE_ROOT` takes precedence. Missing, foreign, ambiguous, split-engine, or changed ownership evidence must fail closed.

The representative workspace structure is:

```text
<workspace>/
├── <project files and directories>/
├── .ploinky/
│   ├── repos/
│   │   └── <repository>/
│   │       └── <agent>/
│   │           └── manifest.json
│   ├── code/
│   ├── skills/
│   ├── logs/
│   ├── shared/
│   ├── running/
│   ├── data/
│   ├── deps/
│   ├── box/
│   ├── run/
│   ├── agents.json
│   ├── enabled_repos.json
│   ├── repo_sources.json
│   ├── routing.json
│   ├── servers.json
│   ├── profile
│   ├── .secrets
│   ├── master-key
│   └── ploinky_history
└── .data/
    ├── <agent>/
    └── <alias>/
```

Entries created only by an enabled feature or runtime may be absent. Their absence must not be interpreted as a different workspace identity.

### `.ploinky/` components

`.ploinky/` is owned by Ploinky. It contains installed repositories, lifecycle inputs, generated runtime state, security material, logs, and reusable caches. Agent code must not treat this directory as its unrestricted writable home.

| Component | Required role and boundary |
| --- | --- |
| `repos/<repository>/` | Contains Ploinky-managed Git checkouts. Each immediate child with a `manifest.json` is discoverable as an agent. A repository may contain multiple agent folders. |
| `code/<agent>` | Provides a generated symlink to the agent's `code/` directory, or to the agent root when `code/` is absent. A real file or directory at the intended symlink path must not be overwritten. |
| `skills/<agent>` | Provides a generated symlink to the agent's `skills/` directory when that directory exists. |
| `agents.json` | Records enabled runtime instances and the `_config` workspace settings used by lifecycle and routing operations. Installed agents are not enabled merely because they are present in `repos/`. |
| `enabled_repos.json` | Records the repositories preferred for normal agent lookup. If no repositories are recorded, lookup considers all installed repositories. |
| `repo_sources.json` | Records repository source URLs, selected branches, and repository kinds so an installed checkout can be updated or repaired without guessing its origin. |
| `routing.json` | Stores candidate Router input, including the static agent and route records. The file is not sufficient by itself to activate a route; coordinated generation and policy application remain mandatory. |
| `servers.json` | Stores workspace web-surface configuration such as managed server ports and tokens when those surfaces are configured. |
| `router-settings.json` | Stores Router authentication and related settings when configured. |
| `.secrets` | Stores workspace secret variables through the encrypted secret-file contract. Secrets must not be copied into documentation, logs, or repository manifests. |
| `master-key` | Stores the workspace master key used by managed Boxes for encrypted workspace material and derived agent secrets. It must remain confined to the workspace security boundary. |
| `profile` | Selects the active manifest profile, such as `default`, `dev`, `qa`, or `prod`. Every runnable manifest must provide the required `default` profile contract. |
| `cloud.json` | Stores configured cloud connection information when the cloud commands are used. |
| `ploinky_history` | Stores interactive Ploinky CLI history. It is initialized as an empty file for a new workspace. |
| `logs/` | Contains Router, Watchdog, policy, lifecycle, and per-runtime log surfaces. Log files remain workspace-owned operational records. |
| `shared/` | Provides the workspace-managed writable area mounted at `/shared` for agents that use the shared runtime surface, including shell-history files and shared blobs. It is not a replacement for an instance home. |
| `running/` | Contains transient run records, including bounded no-wait execution state. These records describe activity and are not durable agent-owned data. |
| `run/` | Contains private runtime coordination artifacts such as locks, Router health sockets, signed Router descriptors, and the current generated edge-topology view. |
| `data/` | Contains Ploinky-managed persistent service state and manifest-declared runtime resources. Examples include `router-security/`, `edge-routing/`, and provider-specific storage. This directory is distinct from the workspace-root `.data/`. |
| `deps/global/` | Caches prepared global dependencies by runtime key. |
| `deps/agents/` | Caches prepared dependencies by repository, agent, and runtime key. Agents receive prepared dependency content through controlled mounts. |
| `box/dependencies/` | Caches dependencies used to create or restart the outer Box. Ordinary Box destruction preserves this validated path. |
| `box/images/` | Caches reusable nested image content for the outer Box. `destroy --delete-cache` may delete only the validated Box cache paths after removing the Box. |
| Runtime-specific directories | `container-runtime/`, `bwrap-pids/`, `seatbelt-profiles/`, `seatbelt-runtime/`, and `llm-catalog-cache/` are created on demand by their respective runtime or catalog implementation. They must remain scoped to the current workspace. |
| `package.base.json` | May override the default base package template for dependency preparation. If absent, Ploinky uses its bundled template. |

The host supervisor must serialize workspace mutations with the appropriate workspace or subsystem lock and revalidate immutable identity immediately before mutation. Cleanup must resolve and validate every target beneath the owning workspace; no cleanup operation may expand into a broad workspace, home directory, container engine, image, volume, or network prune.

### `.data/` components and persistence

The workspace-root `.data/` directory contains one sanitized persistent home per enabled agent instance. The directory name is the alias when the instance has an alias and otherwise the agent name. Two aliases of the same source agent therefore receive separate homes.

```text
<workspace>/.data/
├── researcher/                 # Default instance of the researcher agent
├── researcher-review/          # Aliased instance with independent state
└── terminal/                   # Another agent instance
    ├── mcp-config.json         # Runtime-synchronized copy when provided
    └── <agent-owned files>/    # History, settings, outputs, and other state
```

| Enable mode | Project path visible to the agent | Use of `.data/<instance>/` |
| --- | --- | --- |
| `isolated` | The instance home is mounted as `/root` and is the runtime workspace. | Holds both the writable working directory and persistent home. |
| `global` | The canonical workspace is the project path. | Mounted separately as the persistent `/root` home. |
| `devel <repository>` | The selected checkout under `.ploinky/repos/<repository>` is the project path. | Mounted separately as the persistent `/root` home. |

Ploinky may synchronize `mcp-config.json` from the agent source into the instance home, but the remaining contents are agent-owned and have no required internal schema. Disabling an agent removes its enabled registry record and runtime but must not implicitly delete its persistent `.data/<instance>/` home. Runtime-managed persistent service storage declared through `runtime.resources.persistentStorage` belongs under `.ploinky/data/<key>/` by default, not under `.data/`.

### Repository and agent directory structure

Repository installation must place each managed checkout at `.ploinky/repos/<repository>/`. Ploinky discovers agents only from immediate child directories that contain a file named exactly `manifest.json` at the child root. The child directory name is the agent name, and the enclosing checkout directory name is the repository name.

```text
<workspace>/.ploinky/repos/<repository>/
├── .git/
├── agent-one/
│   ├── manifest.json           # Required: makes agent-one discoverable
│   ├── mcp-config.json         # Optional: default AgentServer MCP surface
│   ├── code/                   # Optional: mounted as the agent source tree
│   │   ├── package.json
│   │   └── <implementation>/
│   └── skills/                 # Optional: skills exposed for this agent
│       └── <skill>/
│           └── SKILL.md
├── agent-two/
│   ├── manifest.json           # Required: a second agent in the same repo
│   └── <agent source files>/   # Valid when no separate code/ directory is used
├── skills/                     # Optional repository-level skill catalog
└── <repository files>/
```

The minimum discoverable repository therefore has this shape:

```text
<repository>/
└── <agent-name>/
    └── manifest.json
```

`manifest.json` is mandatory for discovery. A directory without it is an ordinary repository directory and must not appear as an agent. The file's presence identifies an agent candidate; successful enablement additionally requires valid JSON and a manifest that satisfies the runtime, profile, dependency, and security contracts. The optional `code/` directory becomes the source target when present; otherwise the complete agent directory is used as its source. An optional `skills/` directory creates the generated `.ploinky/skills/<agent>` link. An optional `mcp-config.json` must sit beside `manifest.json` and defines the tools, resources, and prompts loaded by the default AgentServer.

Bare agent lookup must prefer enabled repositories. If no enabled repository contains the requested agent, Ploinky may search other installed repositories. When the same agent directory name exists in more than one repository, the short name is ambiguous and the operator must use `repository/agent` or `repository:agent`. An alias identifies a runtime instance and its `.data/` home; it does not create or rename the source directory in the repository.

### Repository acquisition and branch state

Repository installation must persist enough source, branch, and repository-kind metadata to update or repair the checkout without guessing. Repository names and derived paths must remain confined to `.ploinky/repos/`. Manifest-declared repository dependencies must be acquired before the complete agent graph is admitted.

Branch-aware startup must resolve an explicit per-repository branch before a start-wide branch, then manifest or persisted choices according to the implemented precedence. A missing candidate branch must follow the selected fallback policy. Dirty managed checkouts must refuse destructive branch changes unless the operator explicitly authorizes repository reset. Core logic must not hardcode optional repository or agent identities.

Update operations must refresh the Ploinky AchillesAgentLib checkout actually loaded at runtime, managed repositories, eligible copied default skills, and discovered project repositories according to their separate failure policies. Managed dependency failures are command failures; an unreachable remote for an independently discovered project repository may be reported and skipped without changing that repository.

### Declared external volumes

Manifest volumes are explicit operator grants. Relative host paths resolve from the canonical workspace, absolute host paths remain exact operator-selected paths, and runtime-managed persistent service storage should use `.ploinky/data/`. A declared mount does not change workspace ownership or make its source part of `.data/`. No cleanup path may escape the validated declared location.

### Workspace model rationale

| Decision | Reason |
| --- | --- |
| Identify a workspace by its canonical real path and derived identity, not only by its directory name | Two unrelated workspaces can share a readable basename. Canonical identity lets ownership and destructive operations fail closed instead of targeting the wrong workspace. |
| Separate `.ploinky/` control state from `.data/` agent homes | Control records and caches have different lifecycles from agent-owned history and configuration. Runtime replacement or cache cleanup must not erase an agent's durable home. |
| Treat a Git repository as the acquisition unit and an immediate child containing `manifest.json` as an agent | One repository can distribute several related agents, while the required manifest makes discovery explicit and prevents arbitrary directories from becoming executable agents. |
| Keep aliases in runtime state instead of copying or renaming source directories | Multiple instances can reuse one reviewed source tree while retaining distinct persistent homes, configuration, identity tuples, and lifecycle records. |
| Require explicit manifest volumes for additional host paths | The isolated workspace remains the default boundary, and every broader filesystem grant is visible, reviewable, and confined to an exact path. |
