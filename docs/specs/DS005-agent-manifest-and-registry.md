---
title: DS005-agent-manifest-and-registry
summary: Defines manifest discovery, profile composition, enabled-agent identity, dependency directives, runtime admission, and endpoint declarations.
---

# DS005 Agent Manifest and Registry

## Introduction

Ploinky discovers runnable agents from repository `manifest.json` files and records operator-selected instances in the workspace registry. The manifest describes an agent's inputs and dependencies; the registry identifies the exact enabled instance that lifecycle and routing operations may control.

## Core Content

An agent is discoverable only when its agent directory contains a readable, valid JSON object named `manifest.json`. The file itself is mandatory; individual attributes are optional unless the table marks them as conditionally required. Attribute paths containing `<name>`, `<profile>`, or `<index>` describe dynamic object keys or array entries rather than literal property names.

| Attribute | Purpose |
| --- | --- |
| `name` | String. Supplies the display and OpenAI-compatible agent name when runtime identity is not already available. The directory name remains the manifest discovery identity. |
| `version` | String. Publishes the agent or config-provider version as descriptive metadata. |
| `about` | String. Gives status, discovery, and agent-card consumers a short human-readable description. |
| `container` | OCI image reference. Selects the container image. A pinned image is recommended; when both aliases are absent, current runtime resolution falls back to `node:18-alpine`. |
| `image` | OCI image reference. Compatibility alias for `container`; `container` takes precedence. |
| `start` | Non-empty shell command. Starts the main process and takes precedence over the service command. An explicitly empty value is invalid. |
| `agent` | Shell command. Starts the long-running agent service when `start` is absent. |
| `commands.run` | Shell command. Structured equivalent of `agent`; used for the long-running service and as the last WebChat CLI fallback. |
| `cli` | Shell command. Declares the interactive command executed by `ploinky cli` and WebChat. |
| `commands.cli` | Shell command. Structured equivalent of `cli`. |
| `run` | Shell command. Legacy WebChat command fallback after `cli` and `commands.cli`; new manifests should use an explicit CLI field. |
| `entrypoint` | String. Replaces the OCI image entrypoint before the selected command is launched. |
| `workdir` | Container path. Sets the working directory for non-isolated execution; the default is `/code`. Isolated execution uses `/root`. |
| `startup` | `"automatic"` or `"manual"`. Controls ordinary workspace startup. Omission means `automatic`; explicit dependencies and the static agent still start even when set to `manual`. |
| `preinstall` | Shell command string. Runs on the host before runtime creation and may prepare Ploinky variables. |
| `hosthook_aftercreation` | Shell command string. Runs on the host immediately after runtime creation. |
| `install` | Shell command string. Installs or prepares the agent inside its selected container or sandbox environment. |
| `postinstall` | Shell command string. Runs inside the created runtime after installation, before the final restart. |
| `hosthook_postinstall` | Shell command string. Runs on the host after the container-side post-install step. |
| `lite-sandbox` | Boolean; only `true` requests it. Requests the host sandbox backend when available. Inside Ploinky Box, execution remains containerized. |
| `runtime` | Object only. Holds runtime-owned persistent resources. A string backend selector is rejected. |
| `runtime.resources` | Object. Groups persistent storage and generated runtime environment declarations. |
| `runtime.resources.persistentStorage` | Object. Requests one Ploinky-managed persistent storage location. |
| `runtime.resources.persistentStorage.key` | Non-empty string; needed together with `containerPath`. Selects the storage identity under `.ploinky/data/<key>`; an incomplete storage declaration is ignored. |
| `runtime.resources.persistentStorage.containerPath` | Non-empty container path; needed together with `key`. Chooses where the persistent storage is mounted in the runtime; an incomplete storage declaration is ignored. |
| `runtime.resources.persistentStorage.chmod` | Numeric file mode. Applies the requested mode when Ploinky prepares the storage path. |
| `runtime.resources.env.<NAME>` | String or template. Adds a runtime environment value. Supported substitutions are `{{PLOINKY_WORKSPACE_ROOT}}`, `{{STORAGE_CONTAINER_PATH}}`, `{{STORAGE_HOST_PATH}}`, `{{secret:NAME}}`, `{{generatedSecret:NAME}}`, and `{{var:NAME}}`. |
| `env` | Array or object map. Declares environment inputs. A profile value replaces or merges with the root declaration according to profile composition rules. |
| `env[]` | `"NAME"`, `"NAME=default"`, wildcard string, or object. Imports a value, supplies a default, expands a wildcard, or declares a structured environment input. `*` does not implicitly expose API-key variables. |
| `env[].name` | Environment name; required for an object array entry. Names the variable inside the runtime. |
| `env[].varName` | Environment name. Selects a differently named source variable. |
| `env[].value` / `env[].default` | Scalar value. Supplies the fallback value; `value` wins when both are present. |
| `env[].required` | Boolean. Makes startup fail when no source or default value can be resolved. |
| `env[].generatedSecret` | Boolean. Requests a persistent secret owned by this agent identity. |
| `env[].sharedGeneratedSecret` | Boolean. Requests a generated value shared according to the declared source name rather than owned only by this agent. |
| `env[].explicitOverride` | Boolean. Allows an explicit secret, process environment, or environment-file value to replace a generated value. |
| `env[].explicitOverrideRequires` | String or string array. Permits that explicit override only when every named prerequisite variable is also present. |
| `env[].runtime` | Boolean, default `true`. When `false`, exposes the value only to host hooks and config providers, not to the running agent. |
| `env.<NAME>` | Scalar or structured object. Object-map form of an environment declaration. In a structured map entry, `name` may act as the source alias when `varName` is absent; all other structured fields above are accepted. |
| `expose` | Array or object map. Maps resolved values to additional runtime environment names, subject to reserved-name filtering. |
| `expose[].name` | Environment name; required for array entries. Names the variable created inside the runtime. |
| `expose[].value` | Scalar. Assigns a literal value. |
| `expose[].ref` | Environment name. Copies a resolved source value. In map form, a value beginning with `$` is the reference shorthand. |
| `repos` | Object keyed by repository name. Declares Git repositories that must be available before the agent graph is activated. |
| `repos.<name>` | Git URL string or object. Uses a direct repository URL or the expanded source declaration below. |
| `repos.<name>.url` | Git URL; required for object form. Supplies the clone or fetch source. |
| `repos.<name>.branch` | Branch name. Selects a repository branch, subject to the workspace branch policy. |
| `repos.<name>.kind` | String. Stores optional source classification metadata. |
| `enable` | Array of strings or objects. Adds agent dependencies to the recursive startup graph. Strings may include mode, `no-wait`, and `as <alias>` tokens. |
| `enable[].agent` / `.ref` / `.spec` / `.name` | Agent reference; one is required for object form. Identifies the dependency; repository-qualified references avoid ambiguity. |
| `enable[].alias` / `.as` | String. Gives the dependency an independent registry and runtime identity. |
| `enable[].profile` | Profile name. Selects the dependency profile. |
| `enable[].noWait` / `.no-wait` | Boolean. Allows dependency activation to proceed asynchronously without blocking the parent operation. |
| `profiles` | Object keyed by profile name. Declares composable operating profiles. If present, it must contain `profiles.default`. |
| `profiles.default` | Object; required when `profiles` exists. Provides the base configuration merged into the selected profile. |
| `profiles.<profile>.env` | Same forms as root `env`. Overrides or merges environment declarations for that profile. |
| `profiles.<profile>.preinstall`, `.hosthook_aftercreation`, `.install`, `.postinstall`, `.hosthook_postinstall` | Shell command strings. Override lifecycle hooks for the selected profile. |
| `profiles.<profile>.secrets` | Array of environment names. Declares profile-required secrets. |
| `profiles.<profile>.mounts.code` | `"rw"` or `"ro"`. Selects source-code mount access. Defaults are mode-dependent. |
| `profiles.<profile>.mounts.skills` | `"rw"` or `"ro"`. Selects skills mount access. Defaults are mode-dependent. |
| `profiles.<profile>.openPorts` | String or array of publish specifications. Declares private Box-side-to-container port mappings using `[IP:]BOX_PORT[:CONTAINER_PORT][/tcp or /udp]`; ranges must have equal lengths. It never publishes a port outside the Box. |
| `profiles.<profile>.network` | Same object as root `network`. Replaces the root network contract as one atomic profile selection. |
| `profiles.<profile>.enable` | Same array as root `enable`. Adds dependencies selected by the active profile. |
| `profiles.<profile>.configProviders` | Same array as root `configProviders`. Replaces the default-profile provider list for the selected profile. |
| `profiles.<profile>.volumes` | Same map as root `volumes`. Adds or replaces volume mappings by host source. |
| `profiles.<profile>.volumeOptions` | Same map as root `volumeOptions`. Adds or replaces options by container destination. |
| `profiles.<profile>.llmRuntime` | Same object as root `llmRuntime`. Refines the LLM runtime request and policy. `containerSecurity` is deliberately root-only. |
| `defaultProfile` | Profile name. Marks the preferred profile in profile-listing output. Runtime selection still follows the explicit selection or workspace profile and then the required `default` block. |
| `volumes` | Object mapping host paths to container paths. Adds agent-specific bind mounts. Relative sources resolve below the workspace; Box admission rejects unmanaged external host sources. |
| `volumeOptions.<containerPath>.readOnly` | Boolean. Mounts the matching destination read-only. |
| `volumeOptions.<containerPath>.generated` | Boolean. Treats the source as generated storage and creates its parent or directory without creating placeholder content. |
| `volumeOptions.<containerPath>.required` | Boolean. With `generated: true`, rejects a missing or empty source. |
| `volumeOptions.<containerPath>.chmod` | Numeric file mode. Applies permissions while preparing the volume source. |
| `volumeOptions.<containerPath>.makeWorldWritableSubdirs` | String array. Creates named subdirectories beneath the source and applies the declared `chmod`. |
| `volumeOptions.<containerPath>.podmanChown` | Boolean. Explicitly enables or disables Podman's ownership-adjusting `U` mount option; managed `.ploinky/data` volumes enable it by default when writable. |
| `network.mode` | `"default"`, `"none"`, `"host"`, or `"bridge"`; required when `network` exists. Selects the network contract. Host mode needs admitted capability; `none` rejects routed/readiness features that require networking. |
| `network.attachments` | Non-empty array; bridge mode only. Selects one or more named private bridge networks. |
| `network.attachments[].name` | Unique lowercase DNS label, 1–63 characters. Names a bridge attachment. |
| `network.attachments[].primary` | Boolean; exactly one must be `true`. Chooses the primary bridge used for the agent route. |
| `readiness.protocol` | `"tcp"`, `"mcp"`, or `"none"`. Selects the activation readiness strategy. |
| `readiness.port` | Integer 1–65535. Supplies the private TCP target when it cannot be inferred. |
| `health.liveness` / `health.readiness` | Probe object. Declares recurring liveness or activation/recurring readiness scripts. |
| `health.<probe>.script` | Safe basename in the agent directory; required for an active probe. Selects the executable probe script. Paths and unsafe characters are rejected. |
| `health.<probe>.interval` | Positive seconds; default `1`. Sets time between probes. |
| `health.<probe>.timeout` | Positive seconds; default `5`. Limits one probe execution. |
| `health.<probe>.failureThreshold` | Positive integer; default `5`. Sets consecutive failures before the probe is considered failed. |
| `health.<probe>.successThreshold` | Positive integer; default `1`. Sets consecutive successes before the probe is considered healthy. |
| `health.<probe>.continuous` | Boolean; default `true`. For readiness, `false` makes the check activation-only and requires recurring liveness coverage. |
| `containerSecurity.privileged` | Boolean. Requests a privileged container through runtime capability admission. It is unavailable as a profile field and may be rejected by the Box boundary. |
| `containerSecurity.nestedPodman` | Boolean. Requests the bounded nested-Podman contract: `SYS_ADMIN`, `NET_ADMIN`, `/dev/fuse`, `/dev/net/tun`, SELinux label disablement, and Ploinky's fixed nested-Podman seccomp profile. It is root-only and cannot be combined with `privileged`. |
| `llmRuntime.enabled` | Boolean. Activates the container LLM runtime integration. |
| `llmRuntime.allowExperimental` | Boolean. Allows catalog/runtime features marked experimental. |
| `llmRuntime.runtimePolicy.platform` | `"linux/amd64"` or `"linux/arm64"`. Selects the OCI platform. |
| `llmRuntime.runtimePolicy.resources.memory` | Size such as `8g`. Sets the container memory limit. |
| `llmRuntime.runtimePolicy.resources.cpus` | Positive numeric string or number. Sets the CPU limit. |
| `llmRuntime.runtimePolicy.resources.pidsLimit` | Integer 1–1,048,576. Sets the process-count limit. |
| `llmRuntime.runtimePolicy.resources.shmSize` | Size such as `1g`. Sets shared-memory size. |
| `llmRuntime.runtimePolicy.resources.ulimits.memlock.soft` / `.hard` | Integer at least `-1`; both required when `memlock` exists. Sets the soft and hard locked-memory limits. |
| `llmRuntime.runtimePolicy.devices[]` | `{ "type": "cdi", "value": "..." }` or `{ "type": "hostDevice", "hostPath": "/dev/..." }`. Requests an admitted CDI device or an allowlisted `/dev/kfd`, `/dev/dri`, or `/dev/accel` device. |
| `llmRuntime.runtimePolicy.securityOpt[]` | Currently only `"label=disable"`. Adds an allowlisted OCI security option. |
| `llmRuntime.runtimePolicy.ipc` | `"default"` or `"host"`. Selects the IPC namespace policy. |
| `llmRuntime.runtimePolicy.gpus` | `"all"` or `"device=<list>"`. Requests Docker GPU selection; Podman must use CDI device entries instead. |
| `guest` | Boolean; `true` selects it. Makes guest authentication the manifest default. |
| `ploinky` | String or array of strings. Declares Ploinky directives separated by commas, semicolons, or newlines. The supported authentication directive is `sso enable`; it requires provider authentication for this application. |
| `ssoProvider` | Boolean; `true` marks it. Marks an agent as an SSO provider so dependency activation can depend on the selected auth mode. |
| `sso.providerAgent` | Agent reference. Selects the generic SSO provider used by an application declaring `sso enable`. Startup rejects missing or conflicting provider bindings. |
| `routerAccess.requiredCapability` | Capability name. The authenticated provider identity must possess it before protected application requests are forwarded. |
| `routerAccess.httpRoutes` | Array or object keyed by route path. Declares Router access policy for HTTP paths served by this agent. |
| `routerAccess.httpRoutes[].path` | Route path; required in array form. Identifies the protected HTTP path. |
| `routerAccess.httpRoutes[].access` | `"public"`, `"guest"`, or `"authenticated"`; default authenticated. Selects the route access class. |
| `routerAccess.httpRoutes[].guestScope` | Non-empty string. Requires a specific guest scope on a guest route. |
| `routerAccess.httpRoutes[].guestScopeParam` | Query-parameter name. Reads the guest-scope value from that parameter; requires `access: "guest"` and `guestScope`. |
| `routerAccess.httpRoutes[].enabled` | Boolean. Allows one declared route policy entry to be disabled. |
| `routerAccess.workspaceLogs` | Boolean. Requests the workspace-log consumer capability for this enabled identity. |
| `providesConfig.command` | Non-empty shell command; required when `providesConfig` exists. Runs the agent as a startup config provider and expects versioned JSON output. |
| `providesConfig.outputs` | Array of output declarations. Declares every environment value the provider is allowed to return. |
| `providesConfig.outputs[].name` | Valid non-reserved environment name; required. Names one provider output. |
| `providesConfig.outputs[].sensitive` | Boolean. Marks the value sensitive for validation and redacted handling. |
| `providesConfig.outputs[].required` | Boolean. Makes startup fail when the provider omits the value. |
| `configProviders` | Array of strings or objects. Selects provider agents whose declared outputs are resolved before this agent starts. |
| `configProviders[].agent` / `.ref` / `.spec` / `.name` | Agent reference; one required for object form. Identifies a provider. |
| `configProviders[].profile` | Profile name. Selects the provider profile. |
| `capabilities` | Object. Publishes agent capability metadata; unknown application-specific keys are preserved. |
| `capabilities.tags` | String or string array. Supplies normalized discovery/model tags. |
| `capabilities.summary`, `.description`, `.whenToUse`, `.whenNotToUse`, `.inputConventions`, `.outputConventions` | Strings. Describes how clients should select and call the agent. |
| `endpoints.chatCompletions` | Object. Configures the OpenAI-compatible chat-completions behavior. Without a command it uses the default LLM responder unless `model` opts out. |
| `endpoints.models` | Object. Configures the OpenAI-compatible model-list behavior; without a command it uses the fallback model list. |
| `endpoints.chatCompletions.command` / `endpoints.models.command` | Executable or command path. Selects a custom endpoint command. |
| `endpoints.<endpoint>.args` | String array. Supplies command arguments. |
| `endpoints.<endpoint>.cwd` | Path or `"workspace"`. Selects the command working directory. |
| `endpoints.<endpoint>.env` | Object. Adds command-specific environment values. |
| `endpoints.<endpoint>.timeoutMs` | Finite number. Limits custom endpoint command execution. |
| `endpoints.chatCompletions.model` | Model name or `none`/`off`. Selects the default responder model or makes the endpoint inert. |
| `endpoints.chatCompletions.supportsStream` / `.stream` | Boolean. Advertises custom-command streaming support. |
| `endpoints.agent-card` | Capability metadata object. Publishes endpoint-specific capability metadata through the agent-card route. |
| `webchat.auth` | `"static"` or `"self"`. Chooses whether WebChat authenticates against the workspace static agent or the selected target agent. |
| `webchat.forwardEnvelope` | Boolean-like `true` (`true`, `"true"`, `1`, or `"1"`). Sends the structured WebChat message envelope to the CLI instead of flattening the user message. |

The supported profile fields are intentionally narrower than arbitrary root fields. In particular, `containerSecurity` is root-only, `openPorts` is profile-only, and direct capability fields such as `devices`, `gpus`, `ipc`, raw runtime arguments, and host mounts are rejected outside `llmRuntime.runtimePolicy` or `volumes`. The historical `ports` and `httpServices` fields are rejected; HTTP exposure is represented by the agent's private service plus `routerAccess.httpRoutes`, never by an outer Box publication.

Authentication policies support `none`, `guest`, and `sso`. A manifest declaring `sso enable` is authoritative: saved settings and `--auth` must not weaken it, and combining it with `guest: true` is invalid. Local password authentication is removed. `--auth pwd`, `--auth local`, credential-seeding options `--user` and `--password`, manifest `pwd` declarations, and `routerAccess.localAuthRoles` are rejected. Ploinky does not maintain a browser password store or migrate old accounts. A saved local policy without an authoritative SSO manifest is invalid. The separately signed local CLI operator channel is not an application authentication mode.

Agent lookup must support repository-qualified references and may accept an unqualified name only when it resolves uniquely. Enabling an agent must persist its repository, manifest agent name, optional alias, runtime mode, authentication selection, instance identity, and enable generation. Aliases create independent runtime identities and persistent homes; they must not collapse into the base agent record.

`enable agent` is an activation operation: after validation it prepares the instance directories and source links, records the exact identity and generation, starts the selected runtime, waits for its readiness, and only then publishes the route. `disable agent` must first withdraw the route, then stop and remove only the captured runtime and registry record. It must preserve the instance's `.data/<agent-or-alias>` home so a later enablement can reuse persistent state. Enabling an auxiliary agent does not replace the workspace static agent selected by `start`.

The manifest startup policy is `automatic` unless it explicitly declares `startup: "manual"`. During an ordinary workspace start, a stopped manual agent outside the static dependency graph remains stopped and has no active route; a running manual agent remains running. The static agent and every explicit dependency must start regardless of the manual setting. `restart <agent-or-alias>` is the explicit activation path for a stopped manual instance and must complete runtime creation or start, readiness, and route restoration in that order.

The active profile may refine commands, environment, mounts, runtime mode, readiness, dependencies, and provider selection. Profile composition must follow explicit manifest semantics, validate accepted values, and strip Ploinky-reserved identity or credential names before authoritative runtime values are injected. A manifest or profile must not grant itself reusable credentials or alter Box-owned Router, topology, or edge-publication locators.

Runtime-owned environment includes the manifest name, workspace path, canonical workspace root, persistent home, MCP configuration location, prepared Node module path, and generated agent principal, instance, and enable-generation identifiers. Manifest and profile values may not override those names. Every enabled mode receives a persistent `.data/<agent-or-alias>` directory as its home at `/root`; isolated mode uses it as the workspace too, while global mode mounts the selected workspace and development mode mounts the selected repository as the working project. The agent source is mounted at `/code`, the Agent library at read-only `/Agent`, and shared workspace files at `/shared`; prepared dependencies are read-only where used.

Manifest dependency directives must resolve into one recursive graph before startup. Repository directives may acquire missing sources, and agent enable directives may add graph nodes. Cycles, malformed references, ambiguous agents, incompatible network requests, and invalid runtime policies must fail before launch. Authentication-dependent providers must be included only when the selected authentication mode requires them.

Endpoint declarations such as agent routes, profile `openPorts`, MCP tools, readiness probes, and Router surfaces describe private in-Box targets. They must never add an outer Box publication. Host networking is an exceptional runtime placement that requires an exact current-generation capability; `none` networking receives no Router endpoint. Managed default and bridge networking must use the approved private Router transport.

When no custom `start`, `agent`, or `commands.run` service is supplied, the default AgentServer loads `mcp-config.json` through the runtime-owned MCP configuration path and serves its tools, resources, and prompts through the private routed MCP surface. Configured tool commands receive structured JSON input on standard input and return text on standard output. Tool access tags map to the authenticated, admin, or internal policy classes; untagged tools default to authenticated, invalid tag combinations fail closed, and persisted Router policy remains authoritative.

Disabling or replacing an agent must target the captured registry record and exact runtime identity. The operation must not select a similarly named process or container, and removing a registry record must coordinate with watchdog behavior so a deliberately disabled runtime is not recreated.

Manifests define portable agent intent, while the registry binds that intent to one exact workspace instance and generation. Runtime and routing code must require both layers before acting.
