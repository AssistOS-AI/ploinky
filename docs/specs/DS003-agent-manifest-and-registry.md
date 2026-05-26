---
id: DS003
title: Agent Manifest and Registry
status: implemented
owner: ploinky-team
summary: Defines how Ploinky discovers agent manifests, records enabled agents, and interprets manifest directives that affect workspace composition.
---

# DS003 Agent Manifest and Registry

## Introduction

Ploinky does not operate on anonymous directories. It discovers runnable units through `manifest.json` files and persists operator choices in a workspace registry. This document defines the manifest-driven and registry-driven contract.

## Core Content

An installed agent must be discoverable as a directory under `.ploinky/repos/<repo>/` that contains `manifest.json`. The agent descriptor exposed to the rest of the runtime is formed from the repository name, the short agent directory name, and the parsed manifest content.

When an operator enables an agent, Ploinky must persist a registry record in `.ploinky/agents.json` with enough information to restart that agent reproducibly. That record must retain the repository name, short agent name, run mode, project path, alias when present, and normalized auth policy when local or SSO auth is in use.

Alias handling is part of the stable contract. Aliases must be unique inside the workspace, must follow the repository’s allowed character set, and must be treated as route keys and container-name differentiators. Commands that target a specific running alias must be able to use that alias instead of the canonical short agent name.

Bulk disable behavior is part of the registry contract. `disable agents-all` must iterate all enabled agent entries in `.ploinky/agents.json` and attempt to remove each one using the same safety checks as single-agent disable. The operation must remain non-destructive: entries with existing containers are reported and skipped rather than force-removed, and the command reports a final summary of removed, skipped, unchanged, and failed outcomes.

The manifest surface may define startup commands, CLI commands, readiness hints, dependencies, profiles, runtime resources, local password defaults, SSO-provider markers, repository bootstrap directives, and enable directives. It may also define endpoint metadata under `endpoints` (OpenAI chat completions handlers and agent capability metadata) that AgentServer exposes at `/v1/chat/completions` and `/capabilities`. Capability metadata is intentionally open-ended JSON: common fields such as tags, summary, usage guidance, and input conventions are useful but not mandatory. RoutingServer exposes that metadata through `/capabilities/<agent>` and also aggregates all successful agent responses at `/capabilities` without validating the returned field shape. Manifest `enable` entries may pull in additional agents and may attach aliases. Manifest `repos` entries may clone and enable repositories before dependent agents are resolved. A `repos` value may be a URL string or an object `{ "url": "...", "branch": "..." }`; the object form lets a manifest pin a dependency repo to a specific branch. When `ploinky start` supplies a branch policy, manifest branch values participate in the resolution order (after explicit `--repo-branch` but before the global `--branch` candidate).

When a manifest `enable` entry references a prefixed agent (`repo/agent` or `repo:agent`), the runtime must ensure the referenced repo is installed and enabled before attempting to resolve the agent. If the repo is missing, the runtime uses the normal predefined, stored, or manifest-discovered source lookup to clone it, applying the active branch policy when present. This keeps dependency auto-install generic rather than hardcoding product-specific repos.

Manifest enablement is conditional for SSO providers. If a dependency manifest sets `ssoProvider: true`, it should only be auto-enabled for a dependent manifest when that dependent resolved to SSO mode. This keeps password-only or no-auth workspaces from booting unused SSO-provider dependencies.

The manifest `container` (or `image`) field may template `${VAR}` references against the agent's resolved environment. Resolution order is the agent's manifest env (decrypted Ploinky secrets and manifest-declared defaults, via the same env map the runtime injects into the container) and then `process.env`. An unresolved reference must fail at agent start with a clear error rather than running a malformed image string. Templating is the supported way to pin a container version (for example `livekit/livekit-server:${WEBMEET_LIVEKIT_VERSION}`) while keeping the version in a workspace var or operator-controlled deploy input rather than baking a tag into the manifest.

Profiles must be deploy-complete for non-sensitive configuration. A required manifest env entry that is ordinary topology/config data, such as a URL, hostname, port, public IP, or realm, must declare a profile default or explicit value so `ploinky profile <name>` followed by `ploinky start <agent>` can boot without manual variable setup. Sensitive values, including passwords, tokens, API keys, master keys, and `generatedSecret: true` entries, remain secret-owned and may be required without a default. Ploinky vars, process env, and `.env` values still override manifest defaults; defaults are the baseline, not a ban on operator overrides.

Generated env entries ignore same-named operator values by default. A generated entry may opt into an explicit override by declaring `explicitOverride: true`; Ploinky then uses the explicit value when present and injects `PLOINKY_ENV_SOURCE_<ENV_NAME>=explicit`. If a generated entry declares `explicitOverrideRequires: ["OTHER_ENV_NAME"]`, Ploinky uses the explicit value only when the generated entry and every listed companion are present in the normal explicit env sources. Generated values are injected with `PLOINKY_ENV_SOURCE_<ENV_NAME>=generated` so shared runtime libraries can distinguish an embedded generated credential from an operator-supplied external credential without inspecting secret values. Cross-agent generated credentials must use `sharedGeneratedSecret: true` and share by source env name, not by custom repo/agent/name fields.

The manifest `network` object selects the container's network namespace. The default is a workspace-defined bridge selected by `network.name` (with optional `network.aliases` for sibling DNS). When an agent declares `network.mode: "host"`, the runtime must run the container with `--network host`, must not create or attach a named bridge, must not emit `-p` port publishes, and must not register network aliases. Host-network agents still declare `ports` for documentation and readiness probing; the runtime treats those declarations as probe metadata only. Sibling agents on a bridge can reach a host-network agent through the runtime-provided host gateway entry (for example `host.containers.internal`) rather than through a bridge alias.

The `network` object may also be set inside a profile block (`manifest.profiles.<profile>.network`) and overrides the root manifest `network` when the active profile defines one. This mirrors how `ports`, `env`, and `enable` already specialize per profile and is the supported way to vary the network namespace across deployment targets — for example, a media SFU that needs `network.mode: "host"` in `prod` (where the platform supports it and the UDP/SRC-NAT workaround applies) while keeping a bridge-network configuration in `dev` and `default` (so a developer workstation that cannot expose host-network container ports — notably macOS where podman runs inside a VM — can still serve the readiness probe and reach sibling agents through bridge aliases).

The optional manifest `entrypoint` field overrides the container image's `ENTRYPOINT` at run time. Setting it to `/bin/sh` lets agents that ship with a CLI-style entrypoint (for example `certbot/certbot` whose entrypoint is `["certbot"]`) run a manifest-supplied `start` script instead of being interpreted as a CLI subcommand. The runtime must emit `--entrypoint <value>` immediately before the image argument when this field is set; the `start` field then becomes the argument(s) passed to the new entrypoint.

The optional manifest `containerSecurity` object grants allowlisted outer-OCI
security policy to the whole agent container. The supported v1 field is
`privileged: true`, which emits `--privileged` for Docker or Podman. This is a
deployment-policy switch, not a generic raw-flag escape hatch: unrecognized
keys must not be converted into runtime arguments. `containerSecurity` may also
appear inside a profile block and profile-level values override the root
manifest value. Agents should use this only when the container is itself a
sandbox host or similar runtime primitive that cannot function under the
default OCI confinement.

Manifest `volumes` declare additional host-to-container mounts beyond Ploinky's default `/Agent`, `/code`, dependency cache, `/shared`, and workspace/run-mode mounts. The host side of every manifest volume must resolve under the workspace `.ploinky/` directory. Relative host paths are resolved against the workspace root and are valid only when they point into `.ploinky/`, such as `.ploinky/data/postgres/data` or `.ploinky/agents/webmeetLivekitServer/livekit.yaml`. Container destinations should use stable semantic paths such as `/data` for agent-owned durable data and `/working-data/generated` for generated config when the agent controls the command line. Mounting into image-specific paths such as `/var/lib/postgresql/data`, `/opt/keycloak/data`, `/etc/letsencrypt`, or `/var/log/onlyoffice` is reserved for upstream images that require those locations.

The manifest `enable` directive may also appear inside a profile block (`manifest.profiles.<profile>.enable`). When the workspace dependency graph is built, profile-level `enable` entries are merged with the top-level `manifest.enable` list against the active profile only. This is the supported way to pin an optional dependency to specific profiles (for example "the production TLS terminator only ships in prod"). The leaf agent's manifest stays unaware of profile selection; the choice lives in the parent that knows when to chain it in.

An `enable` entry may be a string or an object. Object entries must name the target through `agent`, `ref`, `spec`, or `name`, and may include `alias` / `as`, `noWait`, and `profile`. A dependency-local `profile` selects that child agent's manifest profile without changing the workspace's active profile. The resolved graph node and enabled-agent registry record must preserve the profile override so restarts, no-wait workers, dependency env planning, and HTTP-service routing all see the same child profile. This lets a parent such as Explorer run under the normal workspace profile while auto-starting Soul Gateway with its `embedded` profile.

A manifest `enable` string entry may also carry the `no-wait` modifier. The token is case-insensitive and can appear before, after, or interleaved with other modifiers such as `global`, `devel <repo>`, and `as <alias>` (for example `"webmeetLivekitAiAgent global no-wait"`, `"worker global no-wait as ai"`, or `"worker devel repo no-wait"`). Parsing must strip every occurrence of `no-wait` before resolving the agent reference, so the cleaned `spec` remains a valid input to existing alias/mode handling. The modifier is edge-local: it decorates the specific parent-to-child enable[] edge, and the same child agent may be no-wait for one parent and blocking for another. When two declarations of the same child disagree (for example a top-level `enable[]` entry and a profile `enable[]` entry, or two distinct parents in the merged graph), a blocking declaration wins over a no-wait declaration so dependents that need readiness still get it. See DS007 for the startup readiness consequences.

## Decisions & Questions

### Question #1: Why are SSO-provider dependencies conditionally enabled?

Response:
The implementation checks whether a dependent manifest resolves to SSO mode before auto-enabling a provider marked with `ssoProvider: true`. This avoids starting unnecessary SSO-provider agents in workspaces that use token-based or local-password access and keeps manifest dependency behavior aligned with the chosen auth path.

### Question #2: Why do aliases participate in both routing and execution identity?

Response:
The router needs a stable per-instance route key, and the runtime needs a stable per-instance container or process identity. Using the alias for both preserves a single operator-visible naming surface for multi-instance agents and avoids having route names diverge from runtime names.

### Question #3: Why is `network.mode: "host"` exposed instead of letting agents define ports more aggressively?

Response:
Some workloads, notably WebRTC SFUs such as LiveKit, are broken by the source-address rewriting that podman's bridge UDP port-publishing performs. The SFU learns peers at bridge-internal addresses and sends server-initiated UDP back inside the bridge, so subscriber media never reaches the real client. Modeling host networking as an explicit manifest-level mode keeps the workspace decision visible, scoped to a single agent, and consistent with the rest of the manifest contract instead of relying on out-of-band container flags.

Per-profile `network` lets the same manifest keep that host-network mode where it is required (production) while falling back to a bridge configuration where it is broken or unsupported (notably macOS podman, where `--network host` joins the podman VM's network namespace rather than the macOS host's, so neither the workspace readiness probe nor a browser running on the developer's machine can reach the container's listening ports without explicit port publishing).

### Question #4: Why is `${VAR}` expanded in the `container` field instead of forcing a hard-coded image tag?

Response:
The image tag is part of the deploy contract that operators tune through workspace vars and CI inputs (for example `WEBMEET_LIVEKIT_VERSION`). Allowing `${VAR}` in `container` lets a single manifest serve `dev`, `qa`, and `prod` profiles with profile-specific or operator-overridden versions without forking the manifest. Failing closed on an unresolved reference forces the operator to set the var, which is preferable to silently running a stale or wrong image.

### Question #5: Why is `entrypoint` exposed at the manifest level instead of always relying on the image's default?

Response:
Some upstream images, including `certbot/certbot`, ship a CLI-style `ENTRYPOINT` that is incompatible with running a Ploinky-supplied `start` script directly (the script path would be passed as a CLI argument). Forcing every such workload into a wrapper image or a custom build would multiply the moving parts. Modeling `entrypoint` as a manifest field keeps the override visible in the same source of truth as the image tag and the start command, and it lets the runtime continue to derive everything else (env injection, mounts, networking) from the manifest contract.

### Question #6: Why expose `containerSecurity.privileged` instead of raw container flags?

Response:
Some catalog agents intentionally host a second isolation boundary inside their
own container, such as `basic/bwrap-runner`. Those agents may need outer OCI
privileges before the inner sandbox can create namespaces and mount `/proc`.
Ploinky models this as a small allowlisted manifest contract so the elevated
policy is visible in the agent source and profile selection. Raw runtime flags
would blur deployment policy with command construction and would make auditing
container privilege harder.

### Question #7: Why reject manifest volumes outside `.ploinky/`?

Response:
Manifest volumes are broad writable filesystem grants. If each agent chooses arbitrary sibling folders in the workspace root, a normal project checkout accumulates service data, generated configs, databases, and recording trees that are hard to distinguish from user files. Requiring the host side to live under `.ploinky/` keeps runtime state disposable and auditable while still allowing the container side to match the service's expected filesystem contract.

### Question #8: Why require profile defaults for non-sensitive required env?

Response:
Profiles are the reproducible deployment contract. If a production profile requires a non-secret URL or hostname but leaves it only in a workspace variable, a fresh deployment can pass profile selection and still fail at start because hidden operator state is missing. Keeping non-sensitive topology values in the profile preserves one-command startup, while the normal env resolution order still lets operators override those defaults through `ploinky var` or deployment environment variables.

### Question #9: Why is `no-wait` a per-edge modifier instead of a per-agent flag?

Response:
The same dependency can be load-bearing for one parent and an optional adjunct for another. A WebMeet base agent that requires its infra stack to be ready cannot share a single "this agent is no-wait" flag with the Explorer that only opportunistically launches an experimental worker. Pinning the modifier to the enable[] edge that asked for it keeps each parent's startup contract local to its own manifest and avoids action-at-a-distance from leaf-agent metadata. The merge rule — blocking wins when two declarations of the same child disagree — keeps fail-closed behavior for any parent that still needs readiness, even when a sibling parent has opted into background launch.

## Conclusion

The manifest and registry layers define what an agent is, how it is named, and how workspace state persists operator choices. Ploinky must continue to interpret manifest directives and registry entries consistently so that startup, routing, and auth flows remain reproducible.
