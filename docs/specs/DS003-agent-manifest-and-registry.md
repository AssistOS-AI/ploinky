---
id: DS003
title: Agent Manifest and Registry
status: implemented
owner: ploinky-team
summary: Defines manifest and registry semantics, including slim HTTP service targets, inner-only open ports, exact host capability grants, and contract-v5 outer-boundary independence.
---

# DS003 Agent Manifest and Registry

## Introduction

Ploinky does not operate on anonymous directories. It discovers runnable units through `manifest.json` files and persists operator choices in a workspace registry. This document defines the manifest-driven and registry-driven contract.

## Core Content

An installed agent must be discoverable as a directory under `.ploinky/repos/<repo>/` that contains `manifest.json`. The agent descriptor exposed to the rest of the runtime is formed from the repository name, the short agent directory name, and the parsed manifest content.

When an operator enables an agent, Ploinky must persist a registry record in `.ploinky/agents.json` with enough information to restart that agent reproducibly. That record must retain the repository name, short agent name, run mode, project path, alias when present, and normalized auth policy when local or SSO auth is in use.

For the default `isolated` run mode, the registry `projectPath` must resolve to `.data/<agent-or-alias>/` under the workspace root. Aliased instances use the alias as the data directory name so multiple enabled instances do not share a home. Container runtimes mount `.data/<agent-or-alias>/` at `/root` and set `HOME=/root` for every enabled agent, regardless of run mode. Isolated agents also receive `WORKSPACE_PATH=/root`. `global` agents keep `projectPath` and `WORKSPACE_PATH` at the workspace root, and `devel` agents keep `projectPath` and `WORKSPACE_PATH` at the selected `.ploinky/repos/<repo>/` checkout.

Alias handling is part of the stable contract. Aliases must be unique inside the workspace, must follow the repository’s allowed character set, and must be treated as route keys and container-name differentiators. Commands that target a specific running alias must be able to use that alias instead of the canonical short agent name.

Bulk disable behavior is part of the registry contract. `disable agents-all` must iterate all enabled agent entries in `.ploinky/agents.json` and attempt to remove each one using the same safety checks as single-agent disable. The operation must remain non-destructive: entries with existing containers are reported and skipped rather than force-removed, and the command reports a final summary of removed, skipped, unchanged, and failed outcomes.

The manifest surface may define startup commands, CLI commands, readiness hints, dependencies, profiles, runtime resources, local password defaults, SSO-provider markers, repository bootstrap directives, enable directives, and startup config-provider contracts. It may also define endpoint metadata under `endpoints` (OpenAI chat completions handlers, OpenAI models-list handlers, and agent capability metadata) that AgentServer exposes at `/v1/chat/completions`, `/v1/models`, and `/agent-card`. `endpoints.models` is command-backed like `endpoints.chatCompletions`; it returns a standardized model descriptor list for the agent-as-provider contract. When `endpoints.models` is absent, AgentServer returns a single fallback `default` model so existing agents remain addressable. Capability metadata is intentionally open-ended JSON: common fields such as tags, summary, usage guidance, and input conventions are useful but not mandatory. RoutingServer exposes that metadata through `/agent-card/<agent>` and also aggregates all successful agent responses at `/agent-card` without validating the returned field shape. Manifest `enable` entries may pull in additional agents and may attach aliases. Manifest `repos` entries may install repositories before dependent agents are resolved. Startup must apply the static agent manifest's repository and enable directives, then recursively apply enabled child manifests' repository and enable directives with cycle protection before building the workspace dependency graph. This lets each manifest own the repositories required by the dependencies it introduces instead of forcing the root manifest to duplicate all transitive repository sources. A `repos` value may be a URL string or an object `{ "url": "...", "branch": "..." }`; the object form lets a manifest pin a dependency repo to a specific branch. When `ploinky start` supplies a branch policy, manifest branch values participate in the resolution order (after explicit `--repo-branch` but before the global `--branch` candidate).

The optional `providesConfig` manifest field declares a startup config provider. It must contain a host-side `command` and an `outputs` allowlist whose entries name environment variables and their sensitivity. The optional `configProviders` field on a static or consumer manifest opts a profile into one or more provider agents. Profile-level `configProviders` replace the default profile list. Startup first prepares the recursive manifest repository graph without starting processes and resolves a planning graph from those manifests. It captures an early inactive targetless generation before static preinstall and provider preflight, then reloads the registry after providers, re-evaluates retained predecessor hashes, and captures the final inactive targetless generation before any graph process starts. Provider output therefore participates in first-launch env resolution without allowing a provider process to race dependency startup or reuse a stale predecessor identity tuple. See DS015 for the output schema, persistence rules, and security boundaries.

The `ploinky cli <agent>` command path must remain generic: if the requested agent is not yet enabled, it resolves the manifest in workspace repositories and auto-enables the agent in global mode before starting/attaching to the runtime container. This allows direct operator intent to work without pre-enabling product-specific agents and keeps dependency resolution and branch policy aligned with standard manifest bootstrap semantics.

The managed public-entrypoint boundary is:

| Invocation | Documented effect |
| --- | --- |
| `ploinky` or `p-cli` | Reconcile/start outer runtime; open Ploinky REPL |
| `ploinky cli` | Reconcile/start outer runtime; open `/bin/bash` as `podman` in `/workspace` |
| `ploinky cli <agent>` | Reconcile/start outer runtime; attach to that agent's manifest CLI |
| `ploinky start ...` | Reconcile/start outer runtime; start the selected graph behind the fixed box boundary |
| `ploinky status` | Inspect outer contract/publishes/health and running core status without mutation |
| `ploinky stop` | Stop core services, then stop outer runtime; keep volumes |
| `ploinky destroy` | Confirm exact instance and directly remove its outer container; retain named volumes |
| REPL `status`/`stop`/`destroy` | Core workspace/router/agent scope; outer runtime remains |

The outer-runtime release channel is the mutable
`docker.io/assistos/ploinky-box:runtime` reference and its image must satisfy
the complete contract-5 metadata, including
`io.assistos.ploinky.runtime-contract=5`. Only creating a missing box may pull
and validate the selected reference, then run the validated image ID. Reusing a
running box or starting a stopped, exactly compatible box must not pull; an
existing box therefore stays pinned until an explicit destroy/recreate. Any
creation-configuration drift in a contract-5 box is also recreate-required and
fails before pull or mutation: the operator must explicitly destroy the box and
then recreate it. Every non-contract-5 box is a
hard cut, including contract 4, malformed, or identity-incompatible state. It
fails before pulling, volume creation, restart, upgrade, or replacement.
Ploinky does not read, migrate, relabel, adopt, copy, clean, or automatically
replace an older contract. The operator must run `ploinky destroy` explicitly
and then recreate the contract-5 box; all three current named volumes remain
retained.

The host supervisor derives the box identity only from the canonical current
directory: a readable sanitized basename plus a 12-character SHA-256 path
hash. There is no public name or engine override. It probes every installed
Podman and Docker engine, inventories the exact box and the three exact labelled
workspace, nested-storage, and dependency volumes, and selects the sole
resource owner. Unknown engine state, split resources, or an exact-named volume
with foreign identity/role labels must fail before mutation. Podman is preferred
only when no identity resource exists anywhere. Host destroy directly removes
the selected box with anonymous-volume cleanup and retains all three named
volumes; an absent box with retained volumes is an idempotent success. Full
data cleanup is an explicit engine-level operator action.

The three volume labels are exact:

| Label | Required value |
| --- | --- |
| `io.assistos.ploinky.identity-schema` | `1` |
| `io.assistos.ploinky.path-hash` | The derived 12-character path hash |
| `io.assistos.ploinky.volume-role` | `workspace`, `containers`, or `ploinky-deps`, matching the exact name |

No absolute workspace path is persisted in those labels.

The outer image owns nested Podman. Inside a marked box, every Ploinky-managed
agent, helper, and sidecar container path must use Podman even when the retained
workspace enabled a host sandbox; Docker, bwrap, and Seatbelt are not fallback
runtimes. Each created nested container must carry the exact label
`io.assistos.ploinky.managed=1`. Contract-v5 boot enumerates that exact label
and rejects any retained managed container without deleting, importing, or
translating it. Operators must make the old box quiescent and remove its
managed containers before the explicit destroy/recreate boundary. Unlabelled,
other-value, and near-name containers, nested images, and nested named volumes
remain untouched. Enumeration failure must fail the outer self-check. Ordinary
agent images intentionally contain neither Podman nor Docker and must not gain
sibling-container control merely because they are launched inside the outer
runtime.

Because ordinary destroy/recreate retains nested storage, the hard-cut
rejection can repeat until the operator resolves the retained state. The
recovery contract is to inspect and back up the exact `-containers` volume,
remove managed containers while the old box is still operable, then destroy and
recreate it. If that is impossible, the operator may remove only that named
volume after the box is absent and after explicitly accepting loss of cached
nested images, records, and nested volumes. V5 performs neither recovery path.
Manual/unlabelled nested containers are outside Ploinky lifecycle repair
guarantees.

The optional top-level manifest field `startup` controls whether an enabled agent outside the static agent's dependency graph joins a general workspace start. Its only valid values are `automatic` and `manual`; an absent field is equivalent to `automatic`, and any other value is a manifest error. `startup: manual` does not weaken explicit relationships: the saved static agent and every agent reached through a manifest `enable` dependency must still start. An explicit Marketplace enable or generic `ploinky cli` invocation also starts the requested agent independently of this policy. This field is separate from `start`, which remains the runtime command.

The optional `routerAccess.httpRoutes` manifest field lets an agent declare agent-relative HTTP paths that the router evaluates through the single HTTP route access policy after route expansion. The field may be an array of entries such as `{ "path": "/read/*", "access": "public" }`, `{ "path": "/workspace/*", "access": "guest" }`, `{ "path": "/account/*", "access": "authenticated" }`, and `{ "path": "/settings/*" }`, or an object whose keys are paths and whose values are entry objects or access strings. Each entry requires `path`; `mode` is not accepted. When `access` is omitted, the entry defaults to `authenticated`; when present, manifest access values are exactly `public`, `guest`, or `authenticated`. Public entries allow anonymous `GET`/`HEAD` only; guest entries mint or reuse a router guest session; authenticated entries require a user-authenticated router session before transparent proxying. Manifest paths are agent-relative and are expanded by the router to `/<routeKey><path>`, where `routeKey` is the alias when present and otherwise the short agent name. Paths use the same normalization, root/root-wildcard rejection, and internal-route rejection rules as the router HTTP route access policy, so raw or encoded `__agent` control-plane segments and router-root internal paths cannot be declared. Agent-relative `/auth/...`, `/admin/...`, and `/metrics` are ordinary agent paths after expansion, not router-root paths.

When a manifest `enable` entry references a prefixed agent (`repo/agent` or `repo:agent`), the runtime must ensure the referenced repo is installed before attempting to resolve the agent. If the repo is missing, the runtime uses the normal predefined, stored, or manifest-discovered source lookup to clone it, applying the active branch policy when present. This keeps dependency auto-install generic rather than hardcoding product-specific repos.

Manifest enablement is conditional for SSO providers. If a dependency manifest sets `ssoProvider: true`, it should only be auto-enabled for a dependent manifest when that dependent resolved to SSO mode. This keeps password-only or no-auth workspaces from booting unused SSO-provider dependencies.

The manifest `container` (or `image`) field may template `${VAR}` references against the agent's resolved environment. Resolution order is the agent's manifest env (decrypted Ploinky secrets and manifest-declared defaults, via the same env map the runtime injects into the container) and then `process.env`. An unresolved reference must fail at agent start with a clear error rather than running a malformed image string. Templating is the supported way to pin a container version (for example `registry.example.com/service:${SERVICE_IMAGE_VERSION}`) while keeping the version in a workspace var or operator-controlled deploy input rather than baking a tag into the manifest.

Profiles must distinguish safe defaults from explicit operator prerequisites. A
required manifest env entry may omit `default` or `value`; that declaration is
structurally valid but startup and profile readiness fail unless the exact value
resolves from encrypted Ploinky vars, a startup config provider, process env, or
`.env`. Ploinky never invents a URL, hostname, public IP, realm, port, or Origin
for such an entry. Safe portable values may still declare profile defaults, and
sensitive values or `generatedSecret: true` entries retain their existing
secret-owned resolution rules.

`ploinky start --profile <name>` is the explicit profile selector across the managed outer-runtime boundary. The host supervisor selects and forwards `default` when the flag is omitted; a core start entered inside the REPL with no explicit selector may continue using the profile persisted in `.ploinky/profile`. Profile selection affects only the in-box graph. It never changes the outer runtime's two publications. A `profile` explicitly attached to an `enable` edge is dependency-local and must exist on that child manifest; it must fail with the child reference and available profiles rather than falling back. Graph resolution continues to accept generic bare, slash-qualified, and colon-qualified workspace references.

Generated env entries ignore same-named operator values by default. A generated entry may opt into an explicit override by declaring `explicitOverride: true`; Ploinky then uses the explicit value when present and injects `PLOINKY_ENV_SOURCE_<ENV_NAME>=explicit`. If a generated entry declares `explicitOverrideRequires: ["OTHER_ENV_NAME"]`, Ploinky uses the explicit value only when the generated entry and every listed companion are present in the normal explicit env sources. Generated values are injected with `PLOINKY_ENV_SOURCE_<ENV_NAME>=generated` so shared runtime libraries can distinguish an embedded generated credential from an operator-supplied external credential without inspecting secret values. Cross-agent generated credentials must use `sharedGeneratedSecret: true` and share by source env name, not by custom repo/agent/name fields.

An object-form manifest env entry may declare `runtime: false`. The field must be a JSON boolean. Ploinky still resolves and validates that value for host lifecycle hooks, startup config providers, manifest image templating, and environment-hash reconciliation, but omits both the value and its `PLOINKY_ENV_SOURCE_<ENV_NAME>` marker from container OCI environment metadata and from bwrap or Seatbelt process environments. This exclusion also dominates a duplicate declaration of the same name in `expose`; `expose` cannot reintroduce a host-hook-only value at a runtime boundary. This is the supported boundary for credentials that a host preinstall hook materializes into a generated, read-only runtime input. The default is `runtime: true`; Ploinky does not infer host-only handling from an env name or from a particular agent.

The manifest `network` object selects exactly one of `default`, `bridge`,
`host`, or `none`. Omission means `default`, which creates a per-effective-agent
private managed bridge. `bridge` requires a nonempty `attachments` array of
portable logical names and exactly one `primary: true`; agents intentionally
sharing an attachment can reach one another by derived alias. The legacy
`network.name` and `network.aliases` fields are rejected. `host` runs with
`--network host`, creates no managed bridge or aliases, and emits no inner `-p`
publishes. Host mode additionally requires a box-granted capability bound to
the exact effective instance and current enable generation; a manifest request
alone is insufficient. `none` has no network and rejects AgentServer,
`openPorts`, HTTP-service targets, router env, and network-dependent readiness.

Inside the managed outer runtime, `default` and `bridge` are rootless-Podman
managed modes. Each container receives exactly `--hosts-file=none --add-host
host.containers.internal:host-gateway`; Ploinky injects the validated router
host, port, and URL using that hostname. Managed consumers also receive
`PLOINKY_INTERNAL_ROUTER_URL` and the read-only
`PLOINKY_EDGE_TOPOLOGY_FILE` snapshot before they start. `host` receives the
private Router endpoint on `127.0.0.1`; `none` receives no endpoint variables.
Managed bridge creation
requires Podman 5.4 or newer, Netavark, and operational `pasta`; there is no
`slirp4netns` fallback.

The `network` object may also be set inside a profile block (`manifest.profiles.<profile>.network`) and overrides the root manifest `network` when the active profile defines one. Profile variation cannot grant host mode or change the fixed outer publications. A capability-owning runtime such as the selected LiveKit instance must resolve to host mode in every supported profile; a bridge fallback would change media semantics and is rejected.

The profile-scoped `openPorts` array is an inner-runtime exposure contract only.
It can create a private mapping inside the box for a reviewed non-reserved
socket, but it can never add, remove, or alter a physical-host mapping. The
normal inner launcher rejects a bridged claim whose resolved box-side TCP
interval includes Router ports `8080` or `8081`, or whose UDP interval includes
the reserved LiveKit slot `7882`. A zero box-side port, unequal ranges,
unsupported protocols, and malformed declarations fail before agent mutation.

Outer runtime contract 5 is constructed without reading a workspace, graph,
profile, manifest, readiness result, environment value, label, or persisted
publication state. Every box has exactly these two engine publications:
`127.0.0.1:<selectedRouterHostPort>:8080/tcp` and
`0.0.0.0:7882:7882/udp`. The `--port` option selects only the physical-host side
of the first mapping. Outer `--publish`, `--expose`, and `--listen-lan` are
rejected. Port `8081` and all agent, health, database, storage, signaling,
Egress, editor, telemetry, and other support listeners remain un-published.

Browser and protocol services use `httpServices`. Each entry retains the
current `slug`, `externalPrefix`, `internalPrefix`, `access`, identity,
invocation, and delegation semantics and may add one optional integer `port`.
An omitted port preserves the owning agent's primary target. For every distinct
explicit TCP port the launcher creates or reuses one private mapping, records
the resolved target in the immutable route-and-policy authorization generation,
and shares that target across entries naming the same port. No secondary target
field or special proxy exists. Invalid or ambiguous slugs, prefixes, ports,
policies, or target state leave the affected selectors inactive.

This is deliberately a slim service declaration. `additionalServerPort` is
removed, and manifests must not add `edgePorts`, outer/physical publication,
UDP, Cloudflare, tunnel, DNS, topology, consumer-binding, or generic
server-inventory fields. `openPorts` remains private inner-runtime metadata and
`httpServices[].port` selects only a private TCP target. No manifest field can
alter either fixed outer mapping or make private Router `8081` an outer
publication.

Raw route, policy, manifest, and publication files are staging inputs, not
authorization state. A coordinated apply first inactivates affected selectors,
digests the exact candidate bytes, validates the complete route-and-policy
generation, and only then installs it atomically. A crash, corrupt digest, or
invalid candidate recovers inactive; it never restores a previous generation.
Every HTTP, SSE, WebSocket, and private-service connection holds a lease on one
validated immutable generation and revalidates it immediately before opening
the upstream connection.

Workspace graph startup uses an early/final two-stage enable transaction. After
recursive graph preparation and before hooks, Ploinky assigns exact tuples to
missing or changed nodes, strips every retained graph route of resolved targets,
and captures an early inactive generation. Static preinstall and startup config
providers run against that targetless topology. Ploinky then aborts the early
lease, reloads the registry, re-evaluates retained predecessor runtime hashes,
rotates any newly stale tuple, and captures the final inactive targetless
generation. Only the final lease may authorize launch targets. Runtime launch
must preserve those exact staged identities; an inner launcher may not replace
or regenerate them while starting a container. Assigned private TCP targets are
then recorded through coordinated applies as startup waves become ready. A
failed preparation leaves selectors inactive, and a failed launch cannot make a
partially staged identity authoritative.

Every durable runtime-replacement preparation is bound to the exact selected
inactive generation, selector activation id/digest, launch-affecting registry
projection (including profile, run mode, project path, and development repo),
and exact manifest bytes. A later inactivation, profile edit, or manifest edit
invalidates the lease; the old lease cannot reactivate a different launch.
Physical container labels or sandbox PID records independently bind the process
to the same instance/enable-generation tuple.

The optional manifest `entrypoint` field overrides the container image's `ENTRYPOINT` at run time. Setting it to `/bin/sh` lets agents that ship with a CLI-style entrypoint (for example `certbot/certbot` whose entrypoint is `["certbot"]`) run a manifest-supplied `start` script instead of being interpreted as a CLI subcommand. The runtime must emit `--entrypoint <value>` immediately before the image argument when this field is set; the `start` field then becomes the argument(s) passed to the new entrypoint.

The optional manifest `containerSecurity` object grants allowlisted outer-OCI
security policy to the whole agent container. The supported v1 field is
`privileged: true`, which emits `--privileged` for Docker or Podman. This is a
deployment-policy switch: unrecognized keys must not be converted into runtime
arguments. `containerSecurity` may also
appear inside a profile block and profile-level values override the root
manifest value. Agents should use this only when the container is itself a
sandbox host or similar runtime primitive that cannot function under the
default OCI confinement.

Manifest `volumes` declare additional host-to-container mounts beyond Ploinky's default `/Agent`, `/code`, dependency cache, `/shared`, and workspace/run-mode mounts. Root-level volumes and active profile volumes are merged for the runtime launch, with profile entries overriding matching host-path keys. Relative host paths are resolved against the workspace root, and absolute host paths are mounted as declared. The host side is not required to live under `.ploinky/`; manifest volumes are explicit operator-granted filesystem access for the agent. Runtime-resource persistent storage should still prefer `.ploinky/data/<agent-or-service>/...`; agent-owned home data and generated startup inputs should prefer `.data/<agent-or-alias>/...` when no external host path is required. Container destinations should use stable semantic paths such as `/data`, `/root`, or `/working-data/generated` according to the agent contract. Mounting into image-specific paths such as `/var/lib/postgresql/data`, `/opt/keycloak/data`, `/etc/letsencrypt`, or `/var/log/onlyoffice` is reserved for upstream images that require those locations.

The manifest `enable` directive may also appear inside a profile block (`manifest.profiles.<profile>.enable`). When the workspace dependency graph is built, profile-level `enable` entries are merged with the top-level `manifest.enable` list from the active profile when the agent declares it, otherwise from `profiles.default`. This lets an agent expose one default dependency contract that still applies under a semantic workspace profile such as `qa` or `prod`, while still allowing a profile-specific block to opt into a different dependency set. The leaf agent's manifest stays unaware of profile selection; the choice lives in the parent that knows when to chain it in.

The manifest `configProviders` directive may also appear inside a profile block. It is evaluated for the static node after dependency graph discovery, not during `enable agent`, so it can reference provider agents installed or enabled by the same manifest directive pass. A config-provider entry may select the provider agent's profile independently from the active workspace profile; this mirrors dependency-local profile overrides for `enable[]` while preserving the workspace profile as runtime context for the provider command.

An `enable` entry may be a string or an object. Object entries must name the target through `agent`, `ref`, `spec`, or `name`, and may include `alias` / `as`, `noWait`, and `profile`. A dependency-local `profile` selects that child agent's manifest profile without changing the workspace's active profile. The resolved graph node and enabled-agent registry record must preserve the profile override so restarts, no-wait workers, dependency env planning, and HTTP-service routing all see the same child profile. Parents can also enable dependencies with plain string entries when the child agent exposes one default deployment contract, as Explorer does for Soul Gateway.

A manifest `enable` string entry may also carry the `no-wait` modifier. The token is case-insensitive and can appear before, after, or interleaved with other modifiers such as `global`, `devel <repo>`, and `as <alias>` (for example `"backgroundWorker global no-wait"`, `"worker global no-wait as ai"`, or `"worker devel repo no-wait"`). Parsing must strip every occurrence of `no-wait` before resolving the agent reference, so the cleaned `spec` remains a valid input to existing alias/mode handling. The modifier is edge-local: it decorates the specific parent-to-child enable[] edge, and the same child agent may be no-wait for one parent and blocking for another. When two declarations of the same child disagree (for example a top-level `enable[]` entry and a profile `enable[]` entry, or two distinct parents in the merged graph), a blocking declaration wins over a no-wait declaration so dependents that need readiness still get it. See DS007 for the startup readiness consequences.

The optional manifest `llmRuntime` block opts an agent into hardware-aware LLM startup. When `llmRuntime.enabled` is `true`, Ploinky loads an external architecture catalog (default `local-llm-architectures/`, overridable through `PLOINKY_LLM_ARCHITECTURES_PATH` or `PLOINKY_LLM_ARCHITECTURES_REPO`/`_REF`), inspects host hardware and the container daemon's OCI platform, selects a compatible architecture, and substitutes the catalog-selected image for the manifest `container`/`image` field. The manifest's templated image (for example `${PLOINKY_BASE_LOCAL_IMAGE}`) is still resolved for diagnostics and explicit operation, but the registry record's `containerImage` must be the effective image actually used to start the container. For LLM runtime agents the registry may also store `manifestImage` and an `llmRuntime` metadata block with architecture id, catalog id/ref, platform, image digest, policy hash, and reuse hash.

Catalog selection writes `.data/<agent-or-alias>/runtime/selected-architecture.json` (mounted at `/runtime` inside the container) and creates `.data/<agent-or-alias>/models` (mounted at `/models`). LLM runtime manifests should start `bash /Agent/llm-runtime/runtime-agent/start-runtime-agent.sh`, which exposes the public agent port on `9000`, runs the shared AgentServer MCP sidecar on `9001`, and runs the loopback-only runtime control service on `9002`. Agent-owned `agent-models.json`, launcher scripts, and capability metadata stay inside the agent's own repository; Ploinky core never parses them. See DS012 for the catalog contract and DS004 for the runtime policy emission rules.

## Decisions & Questions

### Question #1: Why are SSO-provider dependencies conditionally enabled?

Response:
The implementation checks whether a dependent manifest resolves to SSO mode before auto-enabling a provider marked with `ssoProvider: true`. This avoids starting unnecessary SSO-provider agents in workspaces that use token-based or local-password access and keeps manifest dependency behavior aligned with the chosen auth path.

### Question #2: Why do aliases participate in both routing and execution identity?

Response:
The router needs a stable per-instance route key, and the runtime needs a stable per-instance container or process identity. Using the alias for both preserves a single operator-visible naming surface for multi-instance agents and avoids having route names diverge from runtime names.

### Question #3: Why is `network.mode: "host"` exposed instead of letting agents define ports more aggressively?

Response:
Some workloads, notably a WebRTC SFU that owns the fixed UDP slot, require the
box namespace so the advertised source address and actual reply path agree.
Host mode is therefore a visible manifest request plus a Ploinky-granted
capability for one exact effective instance and enable generation. Every other
request, a stale generation, and a per-profile bridge substitute fail before
launch. Network provenance never authorizes Router control operations.

### Question #4: Why is `${VAR}` expanded in the `container` field instead of forcing a hard-coded image tag?

Response:
The image tag is part of the deploy contract that operators tune through workspace vars and CI inputs (for example `SERVICE_IMAGE_VERSION`). Allowing `${VAR}` in `container` lets a single manifest serve `dev`, `qa`, and `prod` profiles with profile-specific or operator-overridden versions without forking the manifest. Failing closed on an unresolved reference forces the operator to set the var, which is preferable to silently running a stale or wrong image.

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

### Question #7: Why are manifest volumes allowed outside `.ploinky/`?

Response:
Manifest volumes are broad writable filesystem grants, but they are declared in the agent manifest and reviewed as part of the operator-enabled agent contract. Some agents need to bind existing workspace folders, external data directories, or host-managed paths that cannot be moved under `.ploinky/`. Ploinky therefore treats manifest volumes as explicit trusted grants: relative host paths resolve against the workspace root, absolute paths are honored, active profile volume declarations participate in startup, and `.ploinky/data` remains the recommended default for ordinary runtime state rather than a hard validation boundary.

### Question #8: Why may a required non-sensitive env entry omit a default?

Response:
Some security boundaries, including exact telemetry Origins and public media
addresses, have no safe inferred or repository-wide default. `required: true`
already expresses the fail-closed runtime contract: profile validation reports
the unresolved name and startup refuses to launch until an operator or provider
supplies it. Requiring a manifest default would force the agent either to encode
deployment topology or to add an unsafe demonstration fallback. Values with a
safe portable baseline should still declare it.

### Question #9: Why is `no-wait` a per-edge modifier instead of a per-agent flag?

Response:
The same dependency can be load-bearing for one parent and an optional adjunct for another. A primary service that requires its infrastructure stack to be ready cannot share a single "this agent is no-wait" flag with another parent that only opportunistically launches an experimental worker. Pinning the modifier to the enable[] edge that asked for it keeps each parent's startup contract local to its own manifest and avoids action-at-a-distance from leaf-agent metadata. The merge rule — blocking wins when two declarations of the same child disagree — keeps fail-closed behavior for any parent that still needs readiness, even when a sibling parent has opted into background launch.

### Question #10: Why is `routerAccess.httpRoutes` agent-relative?

Response:
The manifest belongs to an agent, but the router-visible path belongs to the enabled route key. Expanding declarations under the active alias or short agent name lets the same manifest work for aliased instances without letting the manifest claim router-root paths such as `/auth` or `/metrics`. After expansion, normal HTTP route access path validation still blocks root, root wildcard, and control-plane `__agent` paths.

### Question #11: Why are child manifest `repos` directives applied recursively?

Response:
The agent that declares a dependency is the right owner for that dependency's repository sources. If the root agent had to duplicate every transitive child repository, fresh deployments would become brittle whenever an intermediate agent added or reorganized its own dependencies. Recursively applying child manifests before dependency graph resolution keeps bootstrap generic, lets transitive manifests remain self-contained, and still fails closed through the normal missing-agent or strict branch-policy errors when no source exists.

### Question #12: Why was the generated-credential override bridge removed?

Response:
Decision 2026-06-24: the temporary explicit-override bridge for router-generated signed-subject credentials is removed. Manifest-generated secrets still support explicit overrides for ordinary generated values, but router-owned identity material is injected only through DS013's reserved `PLOINKY_AGENT_API_KEY` and `PLOINKY_AGENT_API_PUBLIC_KEY` contract.

### Question #13: Why are startup config providers profile-scoped instead of global workspace hooks?

Response:
Different deployment profiles can require different generic generated
configuration. Keeping `configProviders` in the manifest/profile surface makes
that choice reviewable beside `enable[]`, `repos`, env defaults, and runtime
policy. Edge publication and topology are box-core responsibilities and do not
use a provider agent.

### Question #14: Why does graph publication not participate in outer-runtime reconciliation?

Response:
Contract 5 fixes the physical boundary before a workspace exists. Reading graph
or manifest state would let an agent, profile, or malformed checkout change a
host exposure decision. Graph ports therefore remain private, while the outer
wrapper always emits only loopback Router TCP and the reserved LiveKit UDP
mapping. This also removes publication provenance and reconciliation from every
in-box command path.

### Question #15: Why is host-hook-only env an explicit manifest flag?

Response:
Whether a resolved value is needed by the long-lived runtime is an agent-owned contract, not something Ploinky can safely infer from credential-like names. `runtime: false` lets generic lifecycle code provide the value to trusted host hooks while every runtime backend omits it from the launched process environment and container metadata.

### Question #16: Why are graph identities activated before graph processes start?

Response:
Private caller ACLs and host-network capabilities are bound to the exact current
instance and enable generation. Starting a process before those identities are
captured would either grant capability from mutable registry state or require a
compatibility exception during bootstrap. The two-phase batch makes the same
validated immutable generation authoritative for every graph node before the
first launch, while later coordinated applies add only the private targets that
could not exist until a runtime was created.

### Question #17: Why is startup policy separate from `start` and `enable`?

Response:
`start` describes which command runs inside an agent runtime, while `enable` records an explicit dependency edge. The `startup` field answers a different question: whether an already enabled, otherwise unrelated agent should be included in a general workspace boot. Keeping these meanings separate lets optional workers remain installed and directly invokable without weakening dependency guarantees or overloading command configuration.

## Conclusion

The manifest and registry layers define what an agent is, how it is named, and how workspace state persists operator choices. Ploinky must continue to interpret manifest directives and registry entries consistently so that startup, routing, and auth flows remain reproducible.
