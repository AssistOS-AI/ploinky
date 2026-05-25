---
id: DS002
title: Workspace and Repository Model
status: implemented
owner: ploinky-team
summary: Defines how Ploinky discovers the workspace root, stores runtime state under .ploinky, and manages cloned and enabled repositories.
---

# DS002 Workspace and Repository Model

## Introduction

Ploinky’s runtime contract begins with workspace discovery and repository management. The implementation assumes a workspace root anchored by `.ploinky/`, and the rest of the runtime builds on that assumption.

## Core Content

The workspace root must be the nearest ancestor directory that contains `.ploinky/`. If no such directory is found, the current working directory becomes the effective root and `initEnvironment()` will create `.ploinky/` there. The runtime must not silently spread state across multiple unrelated roots inside one command invocation.

The repository must store workspace runtime state under `.ploinky/`, including at minimum:

- `agents.json` for enabled-agent records and workspace configuration.
- `enabled_repos.json` for enabled repository names.
- `repos/` for cloned repositories.
- `agents/`, `code/`, and `skills/` for working directories and symlink projections.
- `logs/`, `running/`, `deps/`, `keys/`, and `transcripts/` for live runtime state.
- `data/` for manifest-declared durable service data and runtime-resource persistent storage.
- `.secrets` and `profile` for workspace-local configuration.

Repository installation must clone into `.ploinky/repos/<name>/`. Predefined repositories are resolved through the built-in catalog in `cli/services/repos.js`, while custom repositories may provide their own URL and optional branch. Custom repository URLs and branch selections discovered from manifest `repos` directives or explicit install arguments must be retained as workspace metadata so later update operations can repair or refresh that installed repository without switching branches. Skills-only repositories are not valid targets for `enable repo`; they must instead be consumed through `default-skills`.

Branch selection is repository-management state. `ploinky start --branch <branch>` sets a candidate branch for all managed repos involved in startup, while `--repo-branch <repo=branch>` overrides the candidate for a single repo. Resolution order is: explicit `--repo-branch`, manifest `repos` object branch, start-level `--branch`, stored branch in `.ploinky/repo_sources.json`, then repository default. `--branch-fallback default` (the default) keeps repos on their configured branch when the candidate is absent; `--branch-fallback fail` aborts startup. `--reset-repos` permits hard reset and clean of dirty managed `.ploinky/repos/` checkouts; without it, dirty repos refuse branch switches. Branch-aware start must not hardcode product-specific repos or agent behavior.

The all-repository `update` flow must update repositories under `.ploinky/repos/` and then update project repositories discovered from a project search root. Installed repositories that are missing direct git metadata but have a known predefined, stored, or manifest-discovered source URL must be repaired by cloning a fresh copy to a temporary sibling path, preserving the recorded branch when present, and replacing the broken installed directory in place after the clone succeeds. The repair flow must not retain permanent repo backup directories. Project repositories discovered from the search root must be checked for an accessible remote before pull; if the remote is missing or unreachable, the command must log that repository as skipped and continue without treating it as a failed update. That skip rule applies only to discovered project repositories, not to managed `.ploinky/repos/` update failures. Default skills must still be refreshed in discovered project repositories, including repositories whose remote update was skipped. When the operator provides a folder path, discovery starts from that path. When no folder path is provided, discovery starts from the current working directory. Discovery must include the search root itself when it is a git repository, recurse through ordinary child directories, and skip runtime or generated directories such as `.ploinky/`, `.git/`, `node_modules/`, and `globalDeps/`.

Enabled repositories constrain discovery when `enabled_repos.json` is populated. If no repositories are explicitly enabled, installed repositories remain discoverable by default. This fallback is part of the user-facing repository model and must remain documented as such.

Agent source and skill trees must be projected into `.ploinky/code/<agent>/` and `.ploinky/skills/<agent>/` through symlinks when an agent is enabled. If a real directory blocks a symlink target, the runtime may warn and skip that symlink rather than destroying the existing path.

Manifest-declared extra host mounts must resolve under `.ploinky/`. Durable data belongs under `.ploinky/data/<agent-or-service>/...`; generated startup inputs belong under `.ploinky/agents/<agent>/...`. Agents must not create sibling top-level runtime directories such as `postgres/`, `webmeet/`, or `webmeetAgent/` in the user's workspace root.

## Decisions & Questions

### Question #1: Why is workspace discovery anchored by `.ploinky/` instead of a fixed repository root?

Response:
The CLI is intended to run from arbitrary directories inside a workspace. Anchoring discovery to `.ploinky/` allows commands such as `ploinky status`, `ploinky-shell`, and routed browser helpers to work from subdirectories without requiring the operator to return to one fixed source root.

### Question #2: Why do installed repositories remain discoverable when no explicit enabled list exists?

Response:
This preserves a workable default for freshly initialized workspaces and matches the current implementation in `getActiveRepos()`. The explicit enabled list narrows discovery only when the operator has chosen to manage that list, which keeps first-run behavior simpler without removing the ability to curate visible repositories later.

### Question #3: Why does `update` default project discovery to the current working directory?

Response:
The command is intended to act on the directory where the operator runs it, matching the normal shell expectation for commands that accept an optional root path. Operators can still provide a folder path to broaden, narrow, or redirect discovery, including pointing directly at a single repository root.

### Question #4: Why must extra manifest mounts live under `.ploinky/`?

Response:
Ploinky already owns `.ploinky/` as the workspace runtime boundary. Keeping extra service data, generated config, dependency state, logs, transcripts, and repository clones under that boundary makes `destroy`, cleanup, backup, smoke tests, and repository browsing predictable. It also avoids polluting the user's project tree with infrastructure folders that look like source files or user artifacts.

## Conclusion

The workspace and repository model centers on a single `.ploinky/` root, repository clones under that root, and a predictable state layout. The runtime and documentation must continue to describe and preserve that layout as the foundation for all higher-level behavior.
