---
id: DS002
title: Workspace and Repository Model
status: implemented
owner: ploinky-team
summary: Defines how Ploinky discovers the workspace root, stores runtime state under .ploinky, and manages installed repositories.
---

# DS002 Workspace and Repository Model

## Introduction

Ploinky’s runtime contract begins with workspace discovery and repository management. The implementation assumes a workspace root anchored by `.ploinky/`, and the rest of the runtime builds on that assumption.

## Core Content

The workspace root must be the nearest ancestor directory that contains `.ploinky/`, discovered by scanning upward from the command launch directory. If no such directory is found, the current working directory becomes the effective root and `initEnvironment()` will create `.ploinky/` there. This resolution path applies to all CLI entry points, including `ploinky cli`, and the runtime must not silently spread state across multiple unrelated roots inside one command invocation.

The repository must store workspace runtime state under `.ploinky/`, including at minimum:

- `agents.json` for enabled-agent records and workspace configuration.
- `repo_sources.json` for remembered repository URL, branch, and repository-kind metadata.
- `repos/` for cloned repositories.
- `agents/` for legacy/internal generated files when still referenced, and `code/` and `skills/` for symlink projections.
- `logs/`, `running/`, `deps/`, `keys/`, and `transcripts/` for live runtime state.
- `data/` for manifest-declared durable service data and runtime-resource persistent storage.
- `.secrets` and `profile` for workspace-local configuration.
The workspace root also owns `.data/<agent-or-alias>/` as the host-side persistent home for enabled-agent instances. Container runtimes mount this directory at `/root` in every run mode; isolated mode also uses it as the agent workspace.

Repository installation must clone into `.ploinky/repos/<name>/`. Predefined repositories are resolved through the built-in catalog in `cli/services/repos.js` and the bootstrap defaults include `basic`, `AchillesIDE`, `AchillesCLI`, and `copilot-agents`. This bootstrap set is installed when needed to initialize fresh workspaces so default product agents are available. Custom repositories are installed with a required URL, an optional repository name, and an optional branch. If the operator omits the name, Ploinky derives it from the URL's final path segment after removing a trailing `.git`. Custom repository URLs, branch selections, and repository kind (`agents`, `skills`, `mixed`, or `unknown`) discovered from manifest `repos` directives or explicit install arguments must be retained in `.ploinky/repo_sources.json` so later update operations can repair or refresh that installed repository without switching branches and so Marketplace can keep uninstalled custom repositories in the correct Agent Repos or Skills Repos list.

Branch selection is repository-management state. `ploinky start --branch <branch>` sets a candidate branch for all managed repos involved in startup, while `--repo-branch <repo=branch>` overrides the candidate for a single repo. Resolution order is: explicit `--repo-branch`, manifest `repos` object branch, start-level `--branch`, stored branch in `.ploinky/repo_sources.json`, then repository default. `--branch-fallback default` (the default) keeps repos on their configured branch when the candidate is absent; `--branch-fallback fail` aborts startup. `--reset-repos` permits hard reset and clean of dirty managed `.ploinky/repos/` checkouts; without it, dirty repos refuse branch switches. Branch-aware start must not hardcode product-specific repos or agent behavior.

The non-deferred all-repository `update` flow must refresh the Ploinky runtime Achilles checkout at `node_modules/achillesAgentLib/`, then update repositories under `.ploinky/repos/`, and then update project repositories discovered from a project search root. The managed-repository-only `update repos` flow must also refresh the Ploinky runtime Achilles checkout before completing. The runtime Achilles refresh must pull the installed git checkout when present, or restore a missing/non-git checkout by cloning the canonical Achilles source into `node_modules/achillesAgentLib/`; failure to refresh this checkout is a command failure. Installed repositories that are missing direct git metadata but have a known predefined, stored, or manifest-discovered source URL must be repaired by cloning a fresh copy to a temporary sibling path, preserving the recorded branch when present, and replacing the broken installed directory in place after the clone succeeds. The repair flow must not retain permanent repo backup directories. The `update`, `update all`, `update repos`, and `update repo <name>` flows must refresh `AchillesCopilotBasicSkills` into eligible installed `.ploinky/repos/` entries. Eligibility excludes the `AchillesCopilotBasicSkills` source repository and repositories classified as `skills`; repositories classified as `agents`, `mixed`, or `unknown` are eligible. Managed repository update and managed default-skill refresh failures are command failures. Project repositories discovered from the search root must be checked for an accessible remote before pull; if the remote is missing or unreachable, the command must log that repository as skipped and continue without treating it as a failed update. That skip rule applies only to discovered project repositories, not to managed `.ploinky/repos/` update failures. Default skills must still be refreshed in discovered project repositories, including repositories whose remote update was skipped. When the operator provides a folder path, discovery starts from that path. When no folder path is provided, discovery starts from the current working directory. Discovery must include the search root itself when it is a git repository, recurse through ordinary child directories, and skip runtime or generated directories such as `.ploinky/`, `.git/`, `node_modules/`, and `globalDeps/`.

Installed repositories are the active discovery set. Ploinky no longer maintains a separate enabled-repository list: `install repo` and its `add` alias clone or register source metadata, while `uninstall repo` and its `remove` alias remove the installed checkout. Before uninstall removes `.ploinky/repos/<name>/`, it must disable enabled agent records that originated from that repository by container key, stopping and removing their runtime containers through the normal agent disable helper while preserving each agent data directory. Uninstall must preserve the repository entry in `.ploinky/repo_sources.json` so custom repositories remain visible for reinstall and retain their repository kind.

Agent source and skill trees must be projected into `.ploinky/code/<agent>/` and `.ploinky/skills/<agent>/` through symlinks when an agent is enabled. If a real directory blocks a symlink target, the runtime may warn and skip that symlink rather than destroying the existing path.

Manifest-declared extra host mounts are explicit operator-granted filesystem access. Relative manifest volume paths resolve against the workspace root, and absolute paths are honored as declared; they are not required to live under `.ploinky/`. Runtime resources should prefer `.ploinky/data/<agent-or-service>/...`; agent-owned home data and generated startup inputs should prefer `.data/<agent-or-alias>/...` when no external host path is needed, but agents may mount workspace folders or host-managed directories when the manifest contract requires it.

## Decisions & Questions

### Question #1: Why is workspace discovery anchored by `.ploinky/` instead of a fixed repository root?

Response:
The CLI is intended to run from arbitrary directories inside a workspace. Anchoring discovery to `.ploinky/` allows commands such as `ploinky status`, `ploinky-shell`, and routed browser helpers to work from subdirectories without requiring the operator to return to one fixed source root.

### Question #2: Why are installed repositories the active discovery set instead of a separate enabled-repository list?

Response:
The previous enabled-repository list did not provide meaningful runtime isolation: agents were still controlled by explicit enabled-agent records and running containers. Treating installed repositories as active keeps discovery predictable, removes stale enable/disable state, and makes repository availability match the concrete checkout state under `.ploinky/repos/`.

### Question #3: Why does `update` default project discovery to the current working directory?

Response:
The command is intended to act on the directory where the operator runs it, matching the normal shell expectation for commands that accept an optional root path. Operators can still provide a folder path to broaden, narrow, or redirect discovery, including pointing directly at a single repository root.

### Question #4: Why does uninstall preserve `repo_sources.json` metadata?

Response:
Marketplace and CLI reinstall need to remember custom repository URLs, branches, and repository kind after the checkout is removed. Preserving source metadata lets an operator uninstall a repository to remove its files and stop its agents without losing the ability to install it again from the same source or without moving a skills repository into the agent repository list.

### Question #5: Why is agent home data outside `.ploinky/`?

Response:
Ploinky owns `.ploinky/` as the internal runtime boundary, but agents need a visible, per-instance home area that is not mixed with Ploinky's registry, routing, repo, cache, and secret state. Using `.data/<agent-or-alias>/` keeps agent-owned files easy to inspect or reset while preserving `.ploinky/` for runtime internals. Manifests may still declare explicit workspace or host mounts when their runtime contract requires external paths.

## Conclusion

The workspace and repository model centers on `.ploinky/` for runtime internals, `.data/` for persistent agent instance homes, repository clones under `.ploinky/repos/`, source metadata for reinstall, and a predictable state layout. The runtime and documentation must continue to describe and preserve that layout as the foundation for all higher-level behavior.
