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

## Coverage boundary

This suite targets uppercase portable `SKILL.md` catalogs. Typed AchillesAgentLib skills, OpenCode/Pi native behavior, native registration races after the final inventory check, and full deployed-system acceptance remain outside this harness's claims. Existing repository suites still need to run alongside it.
