# Local skill propagation acceptance

This suite exercises the four implementation candidates together. It checks that uncommitted and untracked local skills are discovered within Ploinky's launch scope and reach the next execution of an existing conversation. It also keeps regressions for rejected selections, disabled sources, and activation rollback visible.

The deterministic suite contains eleven tests. Run it against the exact four revisions selected for deployment, and retain its output with the deployment evidence.

## Run the deterministic suite

The suite uses Node's built-in test runner and needs Linux because the real RobotStore uses `/proc` process identities. It installs no packages, makes no model requests, and creates its workspace, registry, policies, and sessions under a temporary directory. Every source tree can be mounted read-only. The source paths identify the system under test; the harness itself can be copied elsewhere and run from any working directory.

On a Linux host, run:

```sh
SKILLS_TEST_ACHILLES=/absolute/path/to/AchillesCLI \
SKILLS_TEST_ALA=/absolute/path/to/ala \
SKILLS_TEST_PLOINKY=/absolute/path/to/ploinky \
SKILLS_TEST_EXPLORER=/absolute/path/to/AssistOSExplorer \
node /absolute/path/to/ploinky/tests/integration/local-skills/run.mjs
```

Use Node 22 or later and the four reconciled implementation trees. `SKILLS_TEST_EXPLORER` names the repository containing `explorer/package.json`; `SKILLS_TEST_ACHILLES` names the repository containing `roboTeamAgent/package.json`. The runner validates these manifests. A missing source tree or unsupported Linux capability is an error, not an automatic skip.

## Coverage

| Test | Observable contract | Expected result |
| --- | --- | --- |
| Existing conversation, queue, exporters, and Explorer controller | A nested launch excludes a sibling repository and dependency skills. A contained `.claude` alias remains intact. Both exporters preserve locally edited exports through update and removal. The real RuntimeManager queues a second desktop task without capturing early. A local edit while queued appears in the second execution, while steering the first uses its original capture. Adding an untracked descendant repository is discovered on the next execution. A controller toggle updates persisted session policy. Resuming an older terminal task obeys the latest explicit empty policy. New discovery does not override explicit empty. Deleting the final live skill sends an empty catalog. | Pass |
| Helper-only change | Changing helper bytes with the same file size and restored mtime changes the capture revision without changing `SKILL.md`. | Pass |
| Asset-only change | Changing only an asset with the same file size and restored mtime changes the capture revision. | Pass |
| Executable-mode-only change | Changing helper permission bits changes the revision while descriptor and helper bytes remain unchanged. | Pass |
| Pinning and returning to live | A previously executed capture remains readable after source deletion when pinned; live mode subsequently resolves to empty. | Pass |
| Same-name replacement | Enabling a second explicit winner either replaces the first atomically or rejects without changing persisted policy. Subsequent inventory and execution remain usable. | Pass: rejected mutation preserves policy and version. |
| Disabled source deleted | Enable an individual skill from explicit empty, disable it, then delete it. Inventory and execution must remain empty and usable. | Pass |
| Disabled source malformed | The same scenario, with invalid descriptor bytes instead of deletion. | Pass |
| Legacy explicit empty | Migrating an explicit empty selection preserves that choice after a new untracked skill appears. | Pass |
| Failed Box activation, same scope | Successfully admit the prior graph, then fail candidate activation. Restoration must preserve its nested launch scope. | Pass |
| Failed Box activation, different scope | Launch the replacement from a different directory. Restoration must use the successfully admitted previous graph's scope. | Pass |

The queue scenario runs several executions under one persisted conversation identity. Descriptor, helper, and asset answers are randomized and kept out of the request text. Assertions read the returned catalog and captured helper output rather than accepting a successful process exit as proof.

## What executes, and what is substituted

| Layer | Execution in the default suite |
| --- | --- |
| Files, discovery, selection, capture, and locks | Real temporary filesystem; real RobotStore, RobotSkillsets, policy persistence, resolver, capture lifecycle, and Linux process locks. |
| Ploinky scope and exports | Real scope translation and both implementations of managed export synchronization. |
| Explorer settings | Real controller supplied with an explicit conversation context; its tool calls go directly to the real `skillCatalogRequest`. DOM rendering is represented by a small fixture. No browser or production settings entrypoint is exercised. |
| Task queue and continuation | Real RuntimeManager start/queue/steering/resume behavior. Its robot-task process launcher is replaced with a bridge to the real ALA engine; the test asserts the `--resume-session` launch flag. Robot-task bootstrap and desktop/container startup are not executed. |
| ALA catalog consumption | The real ALA engine spawns `catalog-consumer.mjs`, a deterministic protocol subprocess. It uses the real ALA catalog/descriptor parsers, reads immutable files, executes the captured Node helpers, and retains fixture continuation metadata. This process is not a native coding backend or a model. |
| Box rollback | Real supervisor admission, scope persistence, and rollback control flow with disposable ownership/lock data and a fake container engine. Both cases first successfully admit a graph. The tests inspect the restored command's metadata for same and different attempted launch scopes. |

Passing this suite proves the tested source-to-execution and policy contracts at these boundaries. It does not prove production UI reachability, a fresh Explorer deployment, real Box startup, native skill registration, or a native backend's use of the skill. Conversation-context wiring has separate repository tests. Run the deployed browser gates to verify production reachability.

## Opt-in native acceptance

`node run.mjs --native` selects a separate test that uses the real ALA installation resolver, engine, and Codex backend. It never substitutes `catalog-consumer.mjs` and does not run implicitly with the deterministic suite.

It requires a Linux environment that already supports Bubblewrap with private `/proc`, a runnable native binary, the ALA candidate's existing runtime dependencies, network access to the configured provider, and a dedicated authenticated home. Set `CODEX_BIN` to the absolute executable and `SKILLS_TEST_NATIVE_HOME` to a directory containing `.codex/auth.json`. The test copies that authentication file into a private temporary home and removes the temporary home afterward; the donor file is only read. No donor configuration or skill directories are modified. Model execution uses the backend's configured default and may consume account usage.

After provisioning that environment, run:

```sh
SKILLS_TEST_ACHILLES=/absolute/path/to/AchillesCLI \
SKILLS_TEST_ALA=/absolute/path/to/ala \
SKILLS_TEST_PLOINKY=/absolute/path/to/ploinky \
SKILLS_TEST_EXPLORER=/absolute/path/to/AssistOSExplorer \
CODEX_BIN=/absolute/path/to/codex \
SKILLS_TEST_NATIVE_HOME=/absolute/path/to/dedicated-authenticated-home \
node /absolute/path/to/ploinky/tests/integration/local-skills/run.mjs --native
```

The native scenario executes six successive turns: initial skill use, changed descriptor/helper/asset bytes, a helper-only edit with size and mtime preserved, a newly added descendant-repository skill, explicit empty selection, and final deletion after returning to live workspace selection. Each populated turn must return hidden current source answers. The empty turns must recognize no selected skills and recall the original conversation token. Every turn must retain the native thread, ALA session, home, cwd, and backend; report exactly one verified registration; and expose the expected catalog membership. An unselected home skill must remain unchanged on disk.

The native test has a 20-minute outer timeout and a 150-second timeout per turn. Prerequisite failures are nonzero errors with capability diagnostics. There is no relaxed-sandbox fallback, automatic privilege change, backend substitution, or dependency installation.

A failed native prerequisite is a failed invocation, not a propagation result. Retain the capability diagnostic and run the native test in a supported environment.

## Deployed Conversation skills check

`deployed-settings.mjs` exercises the production Explorer folder action, WebChat Menu → Conversation skills link, and Settings modal on an explicitly requested fresh local deployment. It uses that deployed Explorer checkout's existing smoke helpers and Playwright installation. It submits no model prompt. This check is separate from the eleven deterministic tests, six native turns, and three official browser gates; none of those runners is changed or replaced.

Serialize the deployed browser workflow, awaiting each command's completed result. The baseline-only Copilot folder-launch gate (`05`) and composed live-skills gate (`06`) may run before Marketplace to preserve their unchanged Box freshness budget. Both use the baseline RoboTeam runtime and must leave optional agents disabled. Finish Marketplace optional-agent activation before the official OnlyOffice and WebMeet gates and this Conversation skills check. The Settings check may run before or after those later gates, but always after Marketplace has finished. Do not overlap Marketplace activation, browser gates, or workspace-changing setup. Cold activation and WebChat CLI startup share Ploinky's workspace lifecycle lock; overlapping them can exhaust the unchanged 60-second composer deadline. Optional agents are not a product prerequisite for ordinary Copilot use.

The preflight fails before Playwright loads, a browser launches, or the test creates any files when the prerequisite is missing, running, failed, skipped, retried, stale, or belongs to another Box. It reads the completed `run.json` and its authoritative `test-results/results.json`, checks the exact Marketplace test and command, and requires one passing Chromium result, one worker, and zero skips, failures, retries, or repeats. The current Box must still be running with the recorded ID and start time, mount the selected canonical workspace at `/workspace`, and publish its Router `8080/tcp` on the requested loopback origin. Both live and configured port bindings must match. A Box restart invalidates the proof. Publication here means the Router's network binding; ordinary subsequent agent activation changes are not treated as a Box restart.

| Required environment | Value |
| --- | --- |
| `SMOKE_EXPLORER_REPO` | Absolute fresh Explorer repository path. Its canonical `tests/smoke` directory must be the one that ran Marketplace. |
| `SMOKE_WORKSPACE_ROOT` | Absolute deployed workspace, matching the live Box bind mount. |
| `SMOKE_BASE_URL` | Exact credential-free `http://127.0.0.1:<port>` origin. |
| `SMOKE_PLOINKY_BOX_CONTAINER` | Exact live Box name or full ID, inspected through existing Podman. |
| `SMOKE_OPTIONAL_GATE_RECEIPT` | Absolute path to the completed optional gate's `run.json`. |
| `SMOKE_ARTIFACT_DIR` | Explicit existing output root outside source trees and the deployed workspace, including through symlinks. Each invocation creates its own unique subdirectory. |
| `SMOKE_USERNAME`, `SMOKE_PASSWORD` | Existing provisioned Explorer credentials, supplied through the environment. Do not put them in command arguments, receipts, or logs. |

With those variables already set by the deployment operator, run:

```sh
node /absolute/path/to/ploinky/tests/integration/local-skills/deployed-settings.mjs
```

The check opens a conversation for a uniquely owned folder, then adds an uncommitted skill inside that folder. It requires the live inventory to discover that skill, follows the production session action to Settings, verifies the persisted conversation scope despite Explorer opening at root, and toggles the actual skill button. The persisted policy must contain the exclusion and a newer version; refreshing must retain it. Ordinary Settings must keep its original default policy and version. The composer and idle deadlines remain 60 seconds. There is no assertion retry, timeout widening, browser transport substitution, or deployed source modification.

Successful runs save redacted evidence and screenshots before deleting the uniquely owned folder through Explorer's existing cleanup helper. Failed runs keep the folder for diagnosis and exit nonzero. Preflight failures exit without creating a run directory; the operator should retain their stderr in the deployment evidence. Follow the repository's fresh-deployment failure procedure instead of rerunning around a failed assertion.

### Receipt producer and reusable preflight

The operator wrapper imports `inspectDeploymentTarget` and `assertMarketplacePrerequisite` from `deployed-prerequisites.mjs`. Before starting Marketplace, call `await inspectDeploymentTarget({ env })` and spread its safe return fields into the optional receipt. Save `result: "running"` before spawning the command. After it exits, record `finishedAt`, `exitCode`, and the authoritative report's `stats`, and mark passed only after validating the report. Before each browser command that depends on optional-agent activation, and before the Conversation skills check, call `await assertMarketplacePrerequisite({ env })`. Baseline-only Copilot gates run before Marketplace without that receipt, retaining their own exact deployment and release checks. Both helpers use bounded read-only Podman inspection and return no raw container inspection or credentials. Do not fill missing fields into an earlier receipt after the fact.

| Receipt field | Required meaning |
| --- | --- |
| `gate`, `result`, `exitCode` | `"optional"`, `"passed"`, `0`. |
| `runId`, `directory`, `cwd` | Run directory basename, its absolute canonical directory, and the canonical fresh Explorer `tests/smoke` directory. `run.json` must belong to that run directory. |
| `command` | `["npm", "run", "test:optional-agents", "--", "--workers=1", "--retries=0"]`. |
| `boxId`, `boxStartedAt`, `workspaceRoot`, `baseURL`, `publication` | Unmodified safe fields returned by `inspectDeploymentTarget`; the start timestamp is canonical UTC. `publication` contains `containerPort`, `hostIp`, and `hostPort`. |
| `startedAt`, `finishedAt` | Valid timestamps enclosing the authoritative report and following the Box start. Completion must not be in the future. |
| `stats` | The exact authoritative report statistics, including `expected: 1`, `skipped: 0`, `unexpected: 0`, `flaky: 0`, start time, and finite duration. The report's actual test/results and retry configuration are also checked. |

The independent guard tests run on any supported Node host and make no browser, container, or network mutations:

```sh
node --test /absolute/path/to/ploinky/tests/integration/local-skills/deployed-prerequisites.test.mjs
```

## Coverage boundary

This suite targets uppercase portable `SKILL.md` catalogs. Typed AchillesAgentLib skills, OpenCode/Pi native behavior, native registration races after the final inventory check, and full deployed-system acceptance remain outside this harness's claims. Existing repository suites still need to run alongside it.
