# Local skill propagation acceptance

This suite exercises the four implementation candidates together. It checks that skills in locally registered repositories, including uncommitted and untracked skill folders, are discovered within Ploinky's launch scope, linked by Ploinky's real link installer, and reach the next execution of an existing conversation. It also keeps regressions for rejected selections, disabled sources, and activation rollback visible.

The deterministic suite contains twelve tests. Run it against the exact four revisions selected for deployment, and retain its output with the deployment evidence.

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

Use Node 22 or later and the four reconciled implementation trees. `SKILLS_TEST_EXPLORER` names the repository containing `explorer/package.json`; the suite uses only its managed skill exporter, because Explorer Settings no longer has a skill-management surface. `SKILLS_TEST_ACHILLES` names the repository containing the RoboTeam agent manifest `roboTeamAgent/manifest.json` (AchillesCLI no longer ships `roboTeamAgent/package.json`). `SKILLS_TEST_ALA` names the ALA checkout; the suite uses its real argument parser, session transcript and `bin/ala.mjs`, and ALA no longer parses skill catalogs. RoboTeam must be at a revision that exports `ACHILLES_PRIVATE_DIRECTORY_NAME` from `privateDataRoot.mjs` and records conversations through ALA's transcript, as `bf8a8e73` with ALA `a93b8229` does; the harness reads the private directory name from RoboTeam instead of hard-coding it. The runner validates these manifests. A missing source tree or unsupported Linux capability is an error, not an automatic skip.

## Coverage

| Test | Observable contract | Expected result |
| --- | --- | --- |
| Existing conversation, queue, exporters, and conversation skill settings | A registered repository outside the launch scope, an unregistered authoring skill, a dependency tree, and an exported copy stay out of the inventory. The `.claude` alias remains intact. Ploinky's link export and Explorer's copy export both preserve author-changed output through update and removal. The declared `list_achilles_skills` and `set_achilles_skill_enabled` tools are called with explicit `robot` and `sessionId` inputs. The real RuntimeManager queues a second desktop task without preparing links early. A local edit while queued appears in the second execution, and the live link shows it to the active first execution as well. A skill added to the registered repository is discovered on the next execution. A settings toggle updates persisted session policy. Resuming an older terminal task obeys the latest deselection, while the backend still sees the unmanaged `authoring` and `distributed` folders. Deselect-all leaves the source selected, so a new skill in it is picked up (tracks escalation 4). Deleting the final live skill leaves only the required skill. | Pass |
| Helper-only change | Same-size helper bytes with a restored mtime are reported by the stand-in backend in the next execution through the live link; `SKILL.md` is unchanged and the execution revision stays the same. | Pass |
| Asset-only change | The same for an asset. | Pass |
| Executable-mode-only change | A helper permission-bit change is reported by the backend in the next execution while descriptor and helper output stay the same. | Pass |
| Deleted live source | Deleting a selected skill removes its link on the next execution; only the required human-report skill remains and the link set revision changes. | Pass |
| Same-name replacement | Enabling a second explicit winner either replaces the first atomically or rejects without changing persisted policy. Subsequent inventory and execution remain usable. | Pass: rejected mutation preserves policy and version. |
| Disabled source deleted | Enable an individual skill from explicit empty, disable it, then delete it. Inventory and execution must remain empty and usable. | Pass |
| Disabled source malformed | The same scenario, with invalid descriptor bytes instead of deletion. | Pass |
| Legacy explicit empty | Under the default robot, whose implicit selection is non-empty, migrating a conversation record that stored an explicit empty selection keeps it empty after a new untracked skill appears. | Pass |
| Explicit empty at creation | Under the default robot, a policy created with the task-start shape `{ skillSets: [], skills: [] }` links only the required skill and stays empty after a new untracked skill appears. | Pass |
| Failed Box activation, same scope | Successfully admit the prior graph, then fail candidate activation. Restoration must preserve its nested launch scope. | Pass |
| Failed Box activation, different scope | Launch the replacement from a different directory. Restoration must use the successfully admitted previous graph's scope. | Pass |

The queue scenario runs several executions under one persisted conversation identity. Descriptor, helper, and asset answers are randomized and kept out of the request text. Assertions read the skills the stand-in backend finds under `.agents/skills` and the output of their helpers rather than accepting a successful process exit as proof.

### Contracts that are no longer asserted

RoboTeam now resolves skills only from the bundled catalog and from repositories registered through Ploinky, and it publishes them as live links. These earlier assertions describe behavior that no longer exists in the pinned sources, so they were replaced rather than carried over.

| Earlier assertion | Replacement |
| --- | --- |
| Workspace folders such as `.agents/skills` and a descendant repository marked by `.git` are scanned for skills. | A skill reaches the selection only through a registered repository. Added skill folders inside a registered repository are discovered live; an unregistered repository is not. |
| An active execution keeps its original capture while a local edit happens. | A live link shows the edit to the active execution; only the second execution's links and prompt are new. |
| A content-keyed capture changes revision on same-size, same-mtime helper, asset, or mode edits. | The edit is visible through the link at once, and the revision, which identifies the link set, stays the same. |
| Pinning a conversation retains deleted source bytes; `live` returns to empty. | Pinning cannot be created any more. A deleted source is unlinked on the next execution. |
| The execution catalog is empty after the last skill is deleted. | The required human-report skill is always linked, so the smallest execution holds exactly that skill. |
| ALA parses and conveys the catalog to the model. | ALA no longer handles skills. The stand-in backend reads the links as a native backend does; the prompt carries the human-report instruction every turn and the skill-header instruction on the first turn. |
| A managed export that an author edits in place is preserved. | Ploinky exports a link, so a retargeted link is preserved. Explorer's compatibility export still publishes a copy, so an edited copy is preserved. |

## What executes, and what is substituted

| Layer | Execution in the default suite |
| --- | --- |
| Files, discovery, selection, links, and locks | Real temporary filesystem; real RobotStore, RobotSkillsets, policy persistence, resolver, live-link installation, and Linux process locks. The required human-report skill comes from a stand-in DocumentationSkills repository. |
| Ploinky scope, links, and exports | Real scope translation, Ploinky's real repository link installer (behind the repository client RoboTeam expects), and both implementations of managed export synchronization. Explorer's `syncManagedSkillExports` has no production caller at `87cccec3`; only its unit test imports it, so that assertion covers a retained compatibility export. |
| Conversation skill settings | The declared `list_achilles_skills` and `set_achilles_skill_enabled` tools are resolved from `mcp-config.json`, their inputs are checked against the declared schema, and they call the same `skillCatalogRequest` that `tools/copilot-catalog.mjs` calls, with explicit `robot` and `sessionId`. The tool process itself is not spawned because it reads robot data from the fixed `/data` volume. The WebChat Conversation skills action and RoboTeam's Conversation skills page are not part of this contract: RoboTeam's own tests cover the action's shape and the page, and `deployed-settings.mjs` (unexecuted until the deployment gate D1) covers the hop from the action to the page against a deployment. No browser or page is exercised here. |
| Task queue and continuation | Real RuntimeManager start/queue/steering/resume behavior. Its robot-task process launcher is replaced with a bridge to the real RoboTeam ALA engine; the test asserts the `--resume-session` launch flag. Robot-task bootstrap and desktop/container startup are not executed. |
| ALA command line and backend | The real engine spawns `native-skill-consumer.mjs`. It parses the command line with the real ALA argument parser, which rejects any skill option RoboTeam might still forward, records its conversation through ALA's real session transcript under `<cwd>/<private directory>/.ala`, reads the skills linked under `.agents/skills` through the `.claude` alias, and executes their helpers. This process is not a native coding backend or a model. |
| Box rollback | Real supervisor admission, scope persistence, and rollback control flow with disposable ownership/lock data and a fake container engine. Both cases first successfully admit a graph. The tests inspect the restored command's metadata for same and different attempted launch scopes. |

Passing this suite proves the tested source-to-link-to-execution and policy contracts at these boundaries. It does not prove production UI reachability (the deployed check that follows the WebChat Conversation skills action to RoboTeam's page is unexecuted until the deployment gate D1), a fresh Explorer deployment, real Box startup, Ploinky's marketplace endpoint, or a native backend's use of the skill. Conversation-context wiring has separate repository tests. Run the deployed browser gates to verify production reachability.

Two further earlier assertions are not removed behavior. The pinned documentation or tool surface still advertises them, so they are product inconsistencies that this suite does not assert:

| Earlier assertion | State at the pins |
| --- | --- |
| `use none` and `use workspace` set an explicit empty or whole-workspace selection. | The `/skills use`, `pin` and `live` completion text remains in `tools/copilot-catalog.mjs` but is never shown, because `SlashCommandHandler.mjs` defines no `/skills` command and the catalog has no `command` method. The error messages at `robot-skillsets.mjs:180` and `:190` still name the nonexistent `/skills live` and `/skills allow-name` commands. DS003 and DS006 still require an explicit empty selection. The suite covers explicit empty at creation and by legacy migration. Deselecting every skill is not an explicit empty selection: a new skill in a still-selected source is picked up. |
| `list_achilles_skills` reports `activeRevision` while an execution runs. | The tool description advertises it, but it is derived from capture leases that live links never create, so it stays null. `lastRevision` is asserted instead. |

Unmanaged folders such as an authoring skill under `.agents/skills` or an exported copy stay visible to the native backend after a deselection, because RoboTeam does not manage them; the suite asserts that visibility explicitly.

## Opt-in native acceptance

`node run.mjs --native` selects a separate test that uses the real ALA installation resolver, engine, and Codex backend. It never substitutes `native-skill-consumer.mjs` and does not run implicitly with the deterministic suite. This test was adapted to the live-link model without a native run; it is verified only as far as loading and reporting its prerequisites.

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

The native scenario executes six successive turns: initial skill use, changed descriptor/helper/asset bytes, a helper-only edit with size and mtime preserved, a newly added skill in the registered repository, deselection of every skill through the settings tool, and final deletion after selecting the skill again. Each populated turn must return hidden current source answers. The empty turns must see no skill other than the required human-report skill and recall the original conversation token. Every turn must retain the native thread, ALA session, home, cwd, and backend, and record the expected linked membership; revisions stay equal across byte-only edits and change when the link set changes. An unselected home skill must remain unchanged on disk.

The native test has a 20-minute outer timeout and a 150-second timeout per turn. Prerequisite failures are nonzero errors with capability diagnostics. There is no relaxed-sandbox fallback, automatic privilege change, backend substitution, or dependency installation.

A failed native prerequisite is a failed invocation, not a propagation result. Retain the capability diagnostic and run the native test in a supported environment.

## Deployed Conversation skills check

**Unexecuted until the deployment gate (D1).** Copilot-family flows are excluded from the 2026-10-02 post-merge acceptance, so this check has been written and statically guarded but not run against a deployment. `deployed-settings.test.mjs` runs on any host: it checks that no retired Explorer Settings selector remains, that the preflight precedes any browser dependency, that the admin check precedes every write, that cleanup and the API-traffic and probe assertions are present, and that the script refuses without its environment.

`deployed-settings.mjs` exercises the WebChat menu's Conversation skills link and the RoboTeam page it opens on an explicitly requested fresh local deployment. C3 creates a settings-only robot and opens WebChat with that robot and a unique folder. C1 separately proves Explorer's default folder action. The check uses the deployed Explorer checkout's existing smoke helpers, including `tests/smoke/lib/conversation-skills.mjs`, and its Playwright installation. It submits no model prompt. This check is separate from the twelve deterministic tests, six native turns, and three official browser gates; none of those runners is changed or replaced.

Serialize the deployed browser workflow, awaiting each command's completed result. The baseline-only Copilot folder-launch gate (`05`) and composed live-skills gate (`06`) may run before Marketplace to preserve their unchanged Box freshness budget. Both use the baseline RoboTeam runtime and must leave optional agents disabled. Finish Marketplace optional-agent activation before the official OnlyOffice and WebMeet gates. Do not overlap Marketplace activation, browser gates, or workspace-changing setup. Cold activation and WebChat CLI startup share Ploinky's workspace lifecycle lock; overlapping them can exhaust the unchanged 60-second composer deadline. Optional agents are not a product prerequisite for ordinary Copilot use.

The preflight fails before Playwright loads, a browser launches, or the test creates any files when the prerequisite is missing, running, failed, skipped, retried, stale, or belongs to another Box. It reads the completed `run.json` and its authoritative `test-results/results.json`, checks the exact Marketplace test and command, and requires one passing Chromium result, one worker, and zero skips, failures, retries, or repeats. The current Box must still be running with the recorded ID and start time, mount the selected canonical workspace at that same absolute path, and publish its Router `8080/tcp` as the sole live and configured binding on `127.0.0.1` at the requested origin's port. The requested origin's hostname may be `127.0.0.1` or `localhost`; the publication address is always `127.0.0.1`. Both live and configured port bindings must match. A Box restart invalidates the proof. Publication here means the Router's network binding; ordinary subsequent agent activation changes are not treated as a Box restart.

| Required environment | Value |
| --- | --- |
| `SMOKE_EXPLORER_REPO` | Absolute fresh Explorer repository path. Its canonical `tests/smoke` directory must be the one that ran Marketplace. |
| `SMOKE_WORKSPACE_ROOT` | Absolute deployed workspace, matching the live Box bind mount. |
| `SMOKE_BASE_URL` | Exact credential-free `http://127.0.0.1:<port>` or `http://localhost:<port>` origin with an explicit port and no path, query or fragment. Use `localhost` for a default deployment: its Router redirects sign-in to the canonical `localhost` origin, and the Explorer smoke sign-in refuses an origin change. |
| `SMOKE_PLOINKY_BOX_CONTAINER` | Exact live Box name or full ID, inspected through existing Podman. |
| `SMOKE_OPTIONAL_GATE_RECEIPT` | Absolute path to the completed optional gate's `run.json`. |
| `SMOKE_ARTIFACT_DIR` | Explicit existing output root outside source trees and the deployed workspace, including through symlinks. Each invocation creates its own unique subdirectory. |
| `SMOKE_USERNAME`, `SMOKE_PASSWORD` | Existing provisioned Explorer credentials of a RoboTeam administrator, supplied through the environment. The check creates a settings-only robot and registers its repository. It fails before any write when `GET api/robots` does not report `canAdmin`. Do not put credentials in command arguments, receipts, or logs. |

With those variables already set by the deployment operator, run:

```sh
node /absolute/path/to/ploinky/tests/integration/local-skills/deployed-settings.mjs
```

Before fixture creation, the check reads the existing default robot's configuration, policy and repository registrations through the supported API and MCP tool. The receipt contains only bounded identities and noncredential selection/configuration hashes. It requires a unique absent robot name, then a successful creation response naming a new ID. It opens a conversation for the new robot and uniquely owned folder, writes a skill into a `skills-repo` folder inside it, and registers that source only on the owned robot. The default configuration, policy and registrations must match after settings changes and after cleanup.

The check follows the WebChat menu's Conversation skills link to the RoboTeam page and verifies that the conversation, owned robot and policy version shown are the saved ones. The new skill must be listed as available and not selected. The check enables it and disables it through the page's toggle. The persisted policy read through the MCP tool must show the selection, then the exclusion, each with a newer version, and a reload must retain it. Requests are attributed to the page by its frame URL, so the first load that follows the WebChat link is recorded and must include a `GET`. Every conversation API request must name the owned robot and opened session. Each must be a `GET` or `PATCH` without a query string, each `PATCH` must carry exactly `enabled`, `identity` and `policyVersion` and the Router's mutation proof, and the page must make no MCP call. A stale update must return 409 and leave the version unchanged, an invalid link must show the invalid-link message and make no API request, and the owned robot defaults must be unchanged. The composer and idle deadlines remain 60 seconds. Assertions have no retry, browser transport substitution or deployed source modification.

Successful cleanup closes the owned settings and chat pages, then drains the WebChat disconnect grace read from the same Ploinky candidate's `cli/server/handlers/webchat/runtimeState.js`. At the current source, the grace is 120 seconds. A one-second allowance lets the disconnect handler and CLI termination settle. The cleanup deadline is the grace plus 61 seconds, and the overall operation deadline is the grace plus 600 seconds; both budgets and the runtime source hash are recorded. Use the same frozen Ploinky candidate for this script and the deployment. Elapsed time does not prove ownership or quiescence. The check revalidates the exact created robot and repository source, requires a stopped workstation with no queued or runtime task, unregisters the repository through `DELETE api/robots/<robotId>/skillsets?name=<repository>`, and makes one `robot-delete` API call. That API must reject a live CLI owner. Cleanup confirms repository and robot absence before deleting the folder through Explorer's existing helper.

A successful run prints `{"result":"passed","cleanup":"owned-repository-robot-and-folder-deleted"}` plus the artifact directory and exits 0; `evidence.json` carries the same values. A failed run retains every remaining fixture resource, sets `result` to `failed` and `cleanup` to `failed-fixture-retained-for-diagnosis`, records the target identity, attempted operations and folder ownership in `retained`, and exits 1. A failed or ambiguous creation, registration or deletion has no fallback or mutation retry. Preflight failures exit without creating a run directory; the operator should retain their stderr in the deployment evidence. Follow the repository's fresh-deployment failure procedure instead of rerunning around a failed assertion.

### Receipt producer and reusable preflight

The operator wrapper imports `inspectDeploymentTarget` and `assertMarketplacePrerequisite` from `deployed-prerequisites.mjs`. Before starting Marketplace, call `await inspectDeploymentTarget({ env })` and spread its safe return fields into the optional receipt. The receipt's `baseURL` is the exact origin this preflight computed. A receipt made at one hostname is not valid for the other; never rewrite or normalise it. Save `result: "running"` before spawning the command. After it exits, record `finishedAt`, `exitCode`, and the authoritative report's `stats`, and mark passed only after validating the report. Before each browser command that depends on optional-agent activation, call `await assertMarketplacePrerequisite({ env })`. Baseline-only Copilot gates run before Marketplace without that receipt, retaining their own exact deployment and release checks. Both helpers use bounded read-only Podman inspection and return no raw container inspection or credentials. Do not fill missing fields into an earlier receipt after the fact.

| Receipt field | Required meaning |
| --- | --- |
| `gate`, `result`, `exitCode` | `"optional"`, `"passed"`, `0`. |
| `runId`, `directory`, `cwd` | Run directory basename, its absolute canonical directory, and the canonical fresh Explorer `tests/smoke` directory. `run.json` must belong to that run directory. |
| `command` | `["npm", "run", "test:optional-agents", "--", "--workers=1", "--retries=0"]`. |
| `boxId`, `boxStartedAt`, `workspaceRoot`, `baseURL`, `publication` | Unmodified safe fields returned by `inspectDeploymentTarget`; the start timestamp is canonical UTC. `baseURL` is `http://127.0.0.1:<port>` or `http://localhost:<port>` exactly as computed; `publication.hostIp` is always `127.0.0.1`. `publication` contains `containerPort`, `hostIp`, and `hostPort`. |
| `startedAt`, `finishedAt` | Valid timestamps enclosing the authoritative report and following the Box start. Completion must not be in the future. |
| `stats` | The exact authoritative report statistics, including `expected: 1`, `skipped: 0`, `unexpected: 0`, `flaky: 0`, start time, and finite duration. The report's actual test/results and retry configuration are also checked. |

The independent guard tests run on any supported Node host and make no browser, container, or network mutations:

```sh
node --test /absolute/path/to/ploinky/tests/integration/local-skills/deployed-prerequisites.test.mjs
```

## Coverage boundary

This suite targets uppercase portable `SKILL.md` catalogs. Typed AchillesAgentLib skills, OpenCode/Pi native behavior, native registration races after the final inventory check, and full deployed-system acceptance remain outside this harness's claims. Existing repository suites still need to run alongside it.
